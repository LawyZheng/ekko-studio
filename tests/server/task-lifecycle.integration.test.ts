import './fixtures/isolated-studio-state'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { closeDb, getDb } from '../../packages/server/src/modules/studio/infrastructure/database'
import { addMessage, clearSessionMessages, createSession, getSessionGeneration } from '../../packages/server/src/modules/studio/repositories/session-store'
import { listTaskPlansForPage } from '../../packages/server/src/modules/studio/repositories/task-plan-store'
import { getSessionTasks, setSessionTaskStatus, updateSessionTasks } from '../../packages/server/src/modules/studio/services/session-tasks'
import { TaskPlanRuns } from '../../packages/server/src/modules/studio/services/task-plan-runs'
import {
  applyTaskAction, commitTaskPlanSnapshot, getTaskLifecycle, markProducersUnreconciled,
  onTaskLifecycleChanged, projectSessionTaskStates, taskProducers, TaskLifecycleError,
} from '../../packages/server/src/modules/studio/services/task-lifecycle'
import type { TaskPlanSnapshot } from '../../packages/server/src/modules/studio/contracts/task-plan'

let counter = 0
const published: TaskPlanSnapshot[] = []
const stop = onTaskLifecycleChanged((_sid, snapshot) => { if (snapshot) published.push(snapshot) })
afterEach(() => { published.length = 0 })
afterAll(() => stop())

/** One ordinary Hermes chat with a user request and an open goal. */
function chat(goals = ['Ship the report']) {
  initAllHermesTables()
  const sid = `lifecycle-${Date.now()}-${counter += 1}`
  createSession({ id: sid, profile: 'default', source: 'cli', agent: 'hermes' })
  addMessage({ session_id: sid, role: 'user', content: 'Please ship the report', run_marker: 'run-a' })
  const snapshot = updateSessionTasks(sid, 'default', { revision: 0, changes: goals.map(title => ({ title, summary: `${title}.`, status: 'open' })) })
  return { sid, taskIds: snapshot.tasks.map(task => task.id), generation: getSessionGeneration(sid)! }
}

/** A turn of the production plan capability, driven the way the MCP route drives it. */
function turns(sid: string) {
  const state = { isWorking: true, activeRunMarker: 'run-a' }
  const runs = new TaskPlanRuns(commitTaskPlanSnapshot, () => {})
  return {
    state,
    begin(run: string) { state.isWorking = true; state.activeRunMarker = run; return runs.begin(sid, 'default', () => state, undefined, true) },
    update: (context: string, input: Record<string, unknown>) => runs.update(context, 'default', input),
    end(context: string) { runs.finish(context, 'ended'); state.isWorking = false },
    linkedTask: (context: string) => runs.linkedTask(context),
  }
}

const steps = (status: 'pending' | 'in_progress' | 'completed') => [{ id: 'a', step: 'Write report', status }, { id: 'b', step: 'Publish', status: status === 'in_progress' ? 'pending' as const : status }]
const hermes = { kind: 'hermes' as const, run_id: 'run-x' }
const lifecycle = (sid: string, taskId: string) => getTaskLifecycle(sid, taskId)!
const storedCard = (sid: string, run = 'run-a') => listTaskPlansForPage(sid, [{ run_marker: run }])[0]

describe('original card linked to a durable session goal', () => {
  it('reuses the same original card on a later turn and keeps its original run anchor', () => {
    const { sid, taskIds: [taskId] } = chat()
    const t = turns(sid)
    const a = t.begin('run-a')
    const first = t.update(a, { task_id: taskId, plan: steps('in_progress') })
    t.end(a)
    const b = t.begin('run-b')
    const second = t.update(b, { task_id: taskId, plan: steps('completed') })
    expect(second.plan_id).toBe(first.plan_id)
    expect(second.run_id).toBe('run-a')
    expect(second.created_at).toBe(first.created_at)
    expect(second.revision).toBeGreaterThan(first.revision)
    expect(second.task_id).toBe(taskId)
    // History of the original turn returns the single, latest card.
    const cards = listTaskPlansForPage(sid, [{ run_marker: 'run-a' }])
    expect(cards).toHaveLength(1)
    expect(cards[0].revision).toBe(second.revision)
    expect(t.linkedTask(b)).toBe(taskId)
  })

  it('rejects a goal of another session and keeps run-only cards unlinked', () => {
    const one = chat()
    const two = chat()
    const t = turns(one.sid)
    const a = t.begin('run-a')
    expect(() => t.update(a, { task_id: two.taskIds[0], plan: steps('pending') })).toThrow(/goal/i)
    const legacy = t.update(a, { plan: steps('completed') })
    expect(legacy.task_id).toBeUndefined()
    expect(legacy.lifecycle).toBeUndefined()
  })
})

describe('background producer lifecycle', () => {
  it('keeps background execution after the turn ends, verifies after delivery and completes only by acceptance', () => {
    const { sid, taskIds: [taskId] } = chat()
    const t = turns(sid)
    const a = t.begin('run-a')
    t.update(a, { task_id: taskId, plan: steps('in_progress') })
    const owner = { kind: 'hermes_process', id: 'proc_1' }
    taskProducers.start({ sessionId: sid, taskId, owner, eventId: 'spawn:proc_1' })
    t.end(a)
    let card = storedCard(sid)
    expect(card.execution_state).toBe('ended')
    expect(card.lifecycle?.phase).toBe('running')

    taskProducers.deliver({ sessionId: sid, owner, eventId: 'exit:proc_1', result: { ref: 'hermes-process:default:proc_1:1', summary: 'exit 0' } })
    card = published.at(-1)!
    expect(card.lifecycle?.phase).toBe('verifying')

    // Exit, completed plan steps and ordinary goal completion writes are all insufficient.
    const b = t.begin('run-b')
    t.update(b, { task_id: taskId, plan: steps('completed') })
    expect(storedCard(sid).lifecycle?.phase).toBe('verifying')
    const ledger = getSessionTasks(sid)
    expect(() => updateSessionTasks(sid, 'default', { revision: ledger.revision,
      changes: [{ id: taskId, title: 'Ship the report', summary: 'Done.', status: 'completed', completion_evidence: 'I checked it' }] })).toThrow(/accept/i)
    const row = getSessionTasks(sid).tasks[0]
    expect(() => setSessionTaskStatus(sid, 'default', taskId, { status: 'completed', expected_updated_at: row.updated_at })).toThrow(/accept/i)

    const delivery = lifecycle(sid, taskId).delivery!
    expect(() => applyTaskAction({ sessionId: sid, taskId, actor: hermes, action: 'accept',
      body: { delivery_id: delivery.id, verification_id: 'none', expected_revision: lifecycle(sid, taskId).revision, evidence: 'ok' } })).toThrow(TaskLifecycleError)
    applyTaskAction({ sessionId: sid, taskId, actor: hermes, action: 'verify', body: { delivery_id: delivery.id, evidence: 'report.md sha256 abc matches' } })
    const view = lifecycle(sid, taskId)
    expect(view.phase).toBe('verifying')
    expect(() => applyTaskAction({ sessionId: sid, taskId, actor: hermes, action: 'accept',
      body: { delivery_id: delivery.id, verification_id: view.verification!.id, expected_revision: view.revision - 1, evidence: 'accepted' } })).toThrow(/revision/i)
    expect(() => applyTaskAction({ sessionId: sid, taskId, actor: hermes, action: 'accept',
      body: { delivery_id: delivery.id, verification_id: view.verification!.id, expected_revision: view.revision, evidence: '  ' } })).toThrow(/evidence/i)
    const accepted = applyTaskAction({ sessionId: sid, taskId, actor: { kind: 'pm', account_id: 7 }, action: 'accept',
      body: { delivery_id: delivery.id, verification_id: view.verification!.id, expected_revision: view.revision, evidence: 'Accepted after reading the report.' } })
    expect(accepted).toMatchObject({ phase: 'done', status: 'completed' })
    expect(lifecycle(sid, taskId).phase).toBe('done')
    expect(getSessionTasks(sid).tasks[0]).toMatchObject({ status: 'completed', completion_evidence: expect.stringContaining('Accepted') })
    expect(published.at(-1)!.lifecycle?.phase).toBe('done')
    expect(storedCard(sid)).toMatchObject({ run_id: 'run-a', lifecycle: { phase: 'done' } })
    // Rework of the accepted goal reports and persists the reopened status.
    const reworked = applyTaskAction({ sessionId: sid, taskId, actor: hermes, action: 'rework', body: { expected_revision: accepted.revision, reason: 'More rows' } })
    expect(reworked).toMatchObject({ phase: 'open', attempt: 2, status: 'open' })
    expect(getSessionTasks(sid).tasks[0].status).toBe('open')
    // An accepted goal can still be closed by the user from the task list, but never reopened through `open`.
    const again = lifecycle(sid, taskId)
    applyTaskAction({ sessionId: sid, taskId, actor: hermes, action: 'deliver', body: { summary: 'Redone' } })
    applyTaskAction({ sessionId: sid, taskId, actor: hermes, action: 'verify', body: { delivery_id: lifecycle(sid, taskId).delivery!.id, evidence: 'Checked' } })
    const v2 = lifecycle(sid, taskId)
    applyTaskAction({ sessionId: sid, taskId, actor: hermes, action: 'accept', body: { delivery_id: v2.delivery!.id, verification_id: v2.verification!.id, expected_revision: v2.revision, evidence: 'OK' } })
    expect(again.attempt).toBe(2)
    const done = getSessionTasks(sid).tasks[0]
    expect(() => setSessionTaskStatus(sid, 'default', taskId, { status: 'open', expected_updated_at: done.updated_at })).toThrow(/accept/i)
    expect(setSessionTaskStatus(sid, 'default', taskId, { status: 'closed', expected_updated_at: done.updated_at }).tasks[0].status).toBe('closed')
  })

  it('fences old attempts after rework and treats redelivery idempotently', () => {
    const { sid, taskIds: [taskId] } = chat()
    const t = turns(sid)
    const a = t.begin('run-a')
    t.update(a, { task_id: taskId, plan: steps('in_progress') })
    const old = { kind: 'hermes_process', id: 'proc_old' }
    taskProducers.start({ sessionId: sid, taskId, owner: old, eventId: 'spawn:old' })
    const first = taskProducers.deliver({ sessionId: sid, owner: old, eventId: 'exit:old', result: { ref: 'r-old', summary: 'exit 0' } })
    expect(first?.duplicate).toBe(false)
    expect(taskProducers.deliver({ sessionId: sid, owner: old, eventId: 'exit:old', result: { ref: 'r-old', summary: 'exit 0' } })?.duplicate).toBe(true)
    expect(() => taskProducers.deliver({ sessionId: sid, owner: old, eventId: 'exit:old', result: { ref: 'r-other', summary: 'changed' } })).toThrow(/conflict/i)

    applyTaskAction({ sessionId: sid, taskId, actor: hermes, action: 'rework', body: { expected_revision: lifecycle(sid, taskId).revision, reason: 'Wrong totals' } })
    expect(lifecycle(sid, taskId)).toMatchObject({ phase: 'open', attempt: 2, delivery: null, verification: null })
    const fresh = { kind: 'hermes_process', id: 'proc_new' }
    taskProducers.start({ sessionId: sid, taskId, owner: fresh, eventId: 'spawn:new' })
    // Late callbacks of the superseded attempt cannot touch attempt 2.
    expect(taskProducers.deliver({ sessionId: sid, owner: old, eventId: 'exit:old-late', result: { ref: 'r-late', summary: 'late' } })).toBeNull()
    expect(taskProducers.fail({ sessionId: sid, owner: old, eventId: 'fail:old', reason: 'late failure' })).toBeNull()
    expect(() => taskProducers.start({ sessionId: sid, taskId, attempt: 1, owner: old, eventId: 'spawn:again' })).toThrow(/attempt/i)
    expect(lifecycle(sid, taskId)).toMatchObject({ phase: 'running', attempt: 2, owner: { kind: 'hermes_process', id: 'proc_new' } })
    taskProducers.fail({ sessionId: sid, owner: fresh, eventId: 'exit:new', reason: 'exit code 3' })
    expect(lifecycle(sid, taskId)).toMatchObject({ phase: 'failed', reason: 'exit code 3' })
  })

  it('supports an explicitly delivered foreground task without a worker, and waiting for the user', () => {
    const { sid, taskIds: [taskId] } = chat()
    const t = turns(sid)
    const a = t.begin('run-a')
    t.update(a, { task_id: taskId, plan: steps('in_progress') })
    applyTaskAction({ sessionId: sid, taskId, actor: hermes, action: 'wait_user', body: { kind: 'login', reason: 'Sign in to the portal' } })
    expect(lifecycle(sid, taskId)).toMatchObject({ phase: 'waiting_user', waiting: { kind: 'login' } })
    expect(projectSessionTaskStates([sid]).get(sid)?.state).toBe('waiting_user')
    applyTaskAction({ sessionId: sid, taskId, actor: hermes, action: 'resume', body: {} })
    expect(lifecycle(sid, taskId).phase).toBe('open')
    applyTaskAction({ sessionId: sid, taskId, actor: hermes, action: 'deliver', body: { summary: 'Report attached', evidence: 'report.md' } })
    const delivered = lifecycle(sid, taskId)
    expect(delivered.phase).toBe('verifying')
    expect(delivered.owner).toBeNull()
    applyTaskAction({ sessionId: sid, taskId, actor: hermes, action: 'verify', body: { delivery_id: delivered.delivery!.id, evidence: 'Opened report.md' } })
    const verified = lifecycle(sid, taskId)
    applyTaskAction({ sessionId: sid, taskId, actor: hermes, action: 'accept', body: { delivery_id: verified.delivery!.id,
      verification_id: verified.verification!.id, expected_revision: verified.revision, evidence: 'Whole task verified.' } })
    expect(lifecycle(sid, taskId).phase).toBe('done')
  })
})

describe('restart reconciliation and session projection', () => {
  it('never asserts historical running state and only records lost on absent ownership evidence', () => {
    const { sid, taskIds: [running, delivered] } = chat(['Run crawler', 'Write summary'])
    const t = turns(sid)
    const a = t.begin('run-a')
    t.update(a, { task_id: running, plan: steps('in_progress') })
    t.end(a)
    const b = t.begin('run-b')
    t.update(b, { task_id: delivered, plan: steps('in_progress') })
    t.end(b)
    taskProducers.start({ sessionId: sid, taskId: running, owner: { kind: 'hermes_process', id: 'proc_r' }, eventId: 's1' })
    taskProducers.start({ sessionId: sid, taskId: delivered, owner: { kind: 'hermes_process', id: 'proc_d' }, eventId: 's2' })
    taskProducers.deliver({ sessionId: sid, owner: { kind: 'hermes_process', id: 'proc_d' }, eventId: 'e2', result: { ref: 'r', summary: 'exit 0' } })
    expect(projectSessionTaskStates([sid]).get(sid)).toEqual({ state: 'running', count: 2 })

    const pending = markProducersUnreconciled()
    expect(pending).toEqual([{ sessionId: sid, taskId: running, owner: { kind: 'hermes_process', id: 'proc_r' } }])
    expect(lifecycle(sid, running).phase).toBe('unknown')
    expect(lifecycle(sid, delivered).phase).toBe('verifying')
    expect(projectSessionTaskStates([sid]).get(sid)?.state).toBe('verifying')
    taskProducers.reconcile({ sessionId: sid, taskId: running, owner: { kind: 'hermes_process', id: 'proc_r' }, observation: 'unavailable' })
    expect(lifecycle(sid, running).phase).toBe('unknown')
    taskProducers.reconcile({ sessionId: sid, taskId: running, owner: { kind: 'hermes_process', id: 'proc_r' }, observation: 'present' })
    expect(lifecycle(sid, running).phase).toBe('running')
    taskProducers.reconcile({ sessionId: sid, taskId: running, owner: { kind: 'hermes_process', id: 'proc_r' }, observation: 'absent' })
    expect(lifecycle(sid, running)).toMatchObject({ phase: 'lost' })
    expect(projectSessionTaskStates([sid]).get(sid)?.state).toBe('verifying')
  })

  it('applies session precedence per session and ignores unlinked legacy goals', () => {
    const quiet = chat()
    const legacy = getSessionTasks(quiet.sid)
    updateSessionTasks(quiet.sid, 'default', { revision: legacy.revision,
      changes: [{ id: quiet.taskIds[0], title: 'Ship the report', summary: 'Done.', status: 'completed', completion_evidence: 'Legacy completion still works' }] })
    expect(getSessionTasks(quiet.sid).tasks[0].status).toBe('completed')
    const busy = chat(['One', 'Two'])
    const t = turns(busy.sid)
    const a = t.begin('run-a')
    t.update(a, { task_id: busy.taskIds[0], plan: steps('pending') })
    t.end(a)
    const b = t.begin('run-b')
    t.update(b, { task_id: busy.taskIds[1], plan: steps('pending') })
    t.end(b)
    expect(projectSessionTaskStates([busy.sid]).get(busy.sid)).toEqual({ state: 'open', count: 2 })
    taskProducers.start({ sessionId: busy.sid, taskId: busy.taskIds[1], owner: { kind: 'hermes_process', id: 'p2' }, eventId: 's' })
    taskProducers.fail({ sessionId: busy.sid, owner: { kind: 'hermes_process', id: 'p2' }, eventId: 'f', reason: 'exit 1' })
    expect(projectSessionTaskStates([busy.sid]).get(busy.sid)?.state).toBe('failed')
    applyTaskAction({ sessionId: busy.sid, taskId: busy.taskIds[0], actor: hermes, action: 'wait_user', body: { kind: 'decision', reason: 'Pick a format' } })
    const states = projectSessionTaskStates([busy.sid, quiet.sid])
    expect(states.get(busy.sid)?.state).toBe('waiting_user')
    expect(states.get(quiet.sid)).toBeUndefined()
  })

  it('fences everything once the session incarnation is reset', () => {
    const { sid, taskIds: [taskId] } = chat()
    const t = turns(sid)
    const a = t.begin('run-a')
    t.update(a, { task_id: taskId, plan: steps('pending') })
    taskProducers.start({ sessionId: sid, taskId, owner: { kind: 'hermes_process', id: 'proc_z' }, eventId: 's' })
    clearSessionMessages(sid)
    expect(taskProducers.deliver({ sessionId: sid, owner: { kind: 'hermes_process', id: 'proc_z' }, eventId: 'e', result: { ref: 'r', summary: 'x' } })).toBeNull()
    expect(projectSessionTaskStates([sid]).get(sid)).toBeUndefined()
  })
})

describe('one transaction for lifecycle, goal and original card', () => {
  it('rolls back the acceptance when the card projection cannot be written, then commits all three together', () => {
    const { sid, taskIds: [taskId] } = chat()
    const t = turns(sid)
    const a = t.begin('run-a')
    t.update(a, { task_id: taskId, plan: steps('completed') })
    t.end(a)
    applyTaskAction({ sessionId: sid, taskId, actor: hermes, action: 'deliver', body: { summary: 'Report attached' } })
    const delivered = lifecycle(sid, taskId)
    applyTaskAction({ sessionId: sid, taskId, actor: hermes, action: 'verify', body: { delivery_id: delivered.delivery!.id, evidence: 'Checked' } })
    const verified = lifecycle(sid, taskId)
    const accept = () => applyTaskAction({ sessionId: sid, taskId, actor: { kind: 'pm', account_id: 1 }, action: 'accept',
      body: { delivery_id: verified.delivery!.id, verification_id: verified.verification!.id, expected_revision: verified.revision, evidence: 'Accepted.' } })
    const before = storedCard(sid)
    getDb()!.exec("CREATE TEMP TRIGGER lifecycle_card_fault BEFORE UPDATE ON task_plans BEGIN SELECT RAISE(ABORT, 'injected card write failure'); END")
    try {
      expect(accept).toThrow(/injected card write failure/)
    } finally {
      getDb()!.exec('DROP TRIGGER lifecycle_card_fault')
    }
    expect(lifecycle(sid, taskId)).toMatchObject({ phase: 'verifying', revision: verified.revision })
    expect(getSessionTasks(sid).tasks[0].status).toBe('open')
    expect(storedCard(sid)).toEqual(before)

    accept()
    // Reopen the database file: everything was committed together, with the original anchor.
    closeDb()
    expect(storedCard(sid)).toMatchObject({ plan_id: before.plan_id, run_id: 'run-a', created_at: before.created_at,
      lifecycle: { phase: 'done', revision: verified.revision + 1 } })
    expect(lifecycle(sid, taskId)).toMatchObject({ phase: 'done', revision: verified.revision + 1 })
    expect(getSessionTasks(sid).tasks[0]).toMatchObject({ status: 'completed', completion_evidence: 'Accepted.' })
  })

  it('links a goal only together with its first card', () => {
    const { sid, taskIds: [taskId] } = chat()
    const t = turns(sid)
    const a = t.begin('run-a')
    getDb()!.exec("CREATE TEMP TRIGGER lifecycle_link_fault BEFORE INSERT ON task_plans BEGIN SELECT RAISE(ABORT, 'injected card insert failure'); END")
    try {
      expect(() => t.update(a, { task_id: taskId, plan: steps('pending') })).toThrow(/injected card insert failure/)
    } finally {
      getDb()!.exec('DROP TRIGGER lifecycle_link_fault')
    }
    expect(getTaskLifecycle(sid, taskId)).toBeNull()
    expect(listTaskPlansForPage(sid, [{ run_marker: 'run-a' }])).toEqual([])
    const card = t.update(a, { task_id: taskId, plan: steps('pending') })
    expect(lifecycle(sid, taskId).plan_id).toBe(card.plan_id)
    expect(card.lifecycle?.phase).toBe('open')
  })
})
