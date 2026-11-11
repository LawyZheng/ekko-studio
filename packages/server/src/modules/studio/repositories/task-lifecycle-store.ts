import { getDb, isSqliteAvailable } from '../infrastructure/database'
import { MESSAGES_TABLE, SESSIONS_TABLE, SESSION_TASKS_TABLE, TASK_PLANS_TABLE } from '../infrastructure/database/schemas'
import type { SessionTaskLifecycle } from '../contracts/session-task'
import type { TaskPlanSnapshot } from '../contracts/task-plan'
import { saveTaskPlan } from './task-plan-store'

export interface LifecycleRow {
  id: string
  session_id: string
  status: string
  revision: number
  lifecycle: SessionTaskLifecycle | null
  /** Current incarnation of the owning session, or null when the session no longer exists. */
  session_generation: string | null
  profile: string
  source: string
}

type RawRow = Omit<LifecycleRow, 'lifecycle'> & { lifecycle_json: string | null }
const SELECT = `SELECT t.id, t.session_id, t.status, t.revision, t.lifecycle_json, s.generation_id AS session_generation,
  COALESCE(s.profile, 'default') AS profile, COALESCE(s.source, '') AS source
  FROM ${SESSION_TASKS_TABLE} t JOIN ${SESSIONS_TABLE} s ON s.id = t.session_id`

function parse(row: RawRow | undefined): LifecycleRow | null {
  if (!row) return null
  const { lifecycle_json, ...rest } = row
  let lifecycle: SessionTaskLifecycle | null = null
  try { lifecycle = lifecycle_json ? JSON.parse(lifecycle_json) : null } catch { lifecycle = null }
  return { ...rest, session_generation: rest.session_generation || null, lifecycle }
}

export function readLifecycleRow(sessionId: string, taskId: string): LifecycleRow | null {
  if (!isSqliteAvailable()) return null
  return parse(getDb()!.prepare(`${SELECT} WHERE t.session_id = ? AND t.id = ?`).get(sessionId, taskId) as RawRow | undefined)
}

/** Linked, not closed goals; optionally limited to one session. */
export function listLinkedLifecycleRows(sessionId?: string): LifecycleRow[] {
  if (!isSqliteAvailable()) return []
  const rows = getDb()!.prepare(`${SELECT} WHERE t.lifecycle_json IS NOT NULL AND t.status <> 'closed'${sessionId ? ' AND t.session_id = ?' : ''}`)
    .all(...(sessionId ? [sessionId] : [])) as RawRow[]
  return rows.map(row => parse(row)!)
}

export interface GoalCompletion { status: 'completed' | 'open'; evidence: string }

/**
 * Compare-and-set one goal's lifecycle. Session incarnation and goal revision are checked inside the
 * transaction; the goal status (on acceptance or rework) and the original card projection, built by `card`
 * from the new revision, are written in the same commit, so no reader ever sees them disagree.
 */
export function writeLifecycle(row: LifecycleRow, lifecycle: SessionTaskLifecycle, goal?: GoalCompletion,
  card?: (revision: number) => TaskPlanSnapshot | null): { revision: number; card: TaskPlanSnapshot | null } | null {
  const db = getDb()
  if (!db) return null
  db.exec('BEGIN IMMEDIATE')
  try {
    const now = Math.max(Date.now(), lifecycle.updated_at)
    const current = db.prepare(`SELECT generation_id FROM ${SESSIONS_TABLE} WHERE id = ?`).get(row.session_id) as { generation_id?: string } | undefined
    const claimed = current?.generation_id && current.generation_id === lifecycle.session_generation
      ? db.prepare(`UPDATE ${SESSION_TASKS_TABLE} SET lifecycle_json = ?, revision = revision + 1, updated_at = ?
          WHERE session_id = ? AND id = ? AND revision = ? AND status <> 'closed'`)
        .run(JSON.stringify(lifecycle), now, row.session_id, row.id, row.revision)
      : { changes: 0 }
    if (!claimed.changes) { db.exec('ROLLBACK'); return null }
    if (goal) {
      const anchor = db.prepare(`SELECT MAX(id) AS id FROM ${MESSAGES_TABLE} WHERE session_id = ?`).get(row.session_id) as { id: number | null }
      const completed = goal.status === 'completed'
      db.prepare(`UPDATE ${SESSION_TASKS_TABLE} SET status = ?, completion_evidence = ?, evidence_message_id = ?,
        completed_at = ? WHERE session_id = ? AND id = ?`)
        .run(goal.status, completed ? goal.evidence : '', completed ? anchor.id : null, completed ? now : null, row.session_id, row.id)
    }
    db.prepare(`UPDATE ${SESSIONS_TABLE} SET task_summary_revision = task_summary_revision + 1, task_summary_updated_at = ? WHERE id = ?`)
      .run(now, row.session_id)
    const projected = card?.(row.revision + 1) || null
    if (projected) saveTaskPlan(projected)
    db.exec('COMMIT')
    return { revision: row.revision + 1, card: projected }
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

export function readStoredPlan(sessionId: string, planId: string): TaskPlanSnapshot | null {
  if (!isSqliteAvailable()) return null
  const row = getDb()!.prepare(`SELECT snapshot FROM ${TASK_PLANS_TABLE} WHERE session_id = ? AND plan_id = ?`).get(sessionId, planId) as { snapshot: string } | undefined
  return row ? JSON.parse(row.snapshot) : null
}
