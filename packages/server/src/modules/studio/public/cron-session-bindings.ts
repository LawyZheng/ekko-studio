import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import { cronBindingsDbPath, studioInstanceId } from './session-notifications'
import { isExternalNoticeTarget } from '../services/session-notifications/external'
import { getSession, getSessionGeneration } from '../repositories/session-store'
import { setCronJobObservationState, setCronJobObserveCursor } from '../repositories/session-notification-store'
import { findUserById, userCanAccessProfile } from '../repositories/users-store'

export type DestinationVerdict = 'ok' | 'forbidden' | 'not_found' | 'unsupported' | 'generation_mismatch'

/**
 * The account may receive passive notices in this session as it exists now, and the caller froze
 * its current generation. Checked before any binding write; never refetches a generation.
 */
export function authorizeNoticeDestination(userId: number, profile: string, sessionId: string, expectedGeneration: string): DestinationVerdict {
  const user = findUserById(userId)
  if (!user || user.status !== 'active' || (user.role !== 'super_admin' && !userCanAccessProfile(user.id, profile))) return 'forbidden'
  const session = getSession(sessionId)
  if (!session || (session.profile || 'default') !== profile) return 'not_found'
  if (!isExternalNoticeTarget(session)) return 'unsupported'
  if (getSessionGeneration(sessionId) !== expectedGeneration) return 'generation_mismatch'
  return 'ok'
}

const CRON_BINDINGS_SCHEMA = `CREATE TABLE IF NOT EXISTS cron_session_bindings (
  instance_id TEXT NOT NULL,
  profile TEXT NOT NULL,
  job_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  bound_at REAL NOT NULL,
  requested_deliver TEXT,
  stored_deliver TEXT,
  requested_paused INTEGER NOT NULL DEFAULT 0,
  session_generation TEXT,
  PRIMARY KEY (instance_id, profile, job_id)
)`

/**
 * Explicitly bind an existing agent-backed native cron job to a session's frozen generation. This
 * replaces the former in-memory wrapper around Hermes' `cronjob_manage` tool; native job
 * configuration is not changed. The existing cron observer reads this binding.
 */
export function writeCronSessionBinding(input: { profile: string; jobId: string; sessionId: string; generation: string; storedDeliver: string }): void {
  const path = cronBindingsDbPath()
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA busy_timeout=5000')
    db.exec('PRAGMA journal_mode=WAL')
    db.exec(CRON_BINDINGS_SCHEMA)
    const columns = new Set((db.prepare('PRAGMA table_info(cron_session_bindings)').all() as Array<{ name: string }>).map(column => column.name))
    if (!columns.has('session_generation')) db.exec('ALTER TABLE cron_session_bindings ADD COLUMN session_generation TEXT')
    // `bound_at` is the binding revision the observer fences on, so a rebinding always moves it forward.
    const previous = db.prepare('SELECT bound_at FROM cron_session_bindings WHERE instance_id=? AND profile=? AND job_id=?')
      .get(studioInstanceId(), input.profile, input.jobId) as { bound_at: number } | undefined
    const boundAt = Math.max(Date.now() / 1000, previous ? Number(previous.bound_at) + 0.001 : 0)
    db.prepare(`INSERT OR REPLACE INTO cron_session_bindings (instance_id, profile, job_id, session_id, bound_at,
        requested_deliver, stored_deliver, requested_paused, session_generation) VALUES (?, ?, ?, ?, ?, NULL, ?, 0, ?)`)
      .run(studioInstanceId(), input.profile, input.jobId, input.sessionId, boundAt, input.storedDeliver, input.generation)
  } finally {
    db.close()
  }
  // A deliberate (re)binding resumes observation: a job stopped earlier (for example after an
  // out-of-band delivery change, since restored to local) is observed again from this binding on.
  setCronJobObservationState(studioInstanceId(), input.profile, input.jobId, 'observing')
  setCronJobObserveCursor(studioInstanceId(), input.profile, input.jobId, null)
}
