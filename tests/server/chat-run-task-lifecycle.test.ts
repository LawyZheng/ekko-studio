import './fixtures/isolated-studio-state'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { addMessage, createSession, getSessionGeneration } from '../../packages/server/src/modules/studio/repositories/session-store'
import { updateSessionTasks } from '../../packages/server/src/modules/studio/services/session-tasks'
import { applyTaskAction, getTaskLifecycle, markProducersUnreconciled, taskProducers } from '../../packages/server/src/modules/studio/services/task-lifecycle'
import { acceptSessionNotification } from '../../packages/server/src/modules/studio/repositories/session-notification-store'
import { studioInstanceId } from '../../packages/server/src/modules/studio/public/session-notifications'
import { getDb } from '../../packages/server/src/modules/studio/infrastructure/database'
import { terminalProducerOwner } from '../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run'
import { taskLifecycleAction } from '../../packages/server/src/modules/studio/controllers/task-lifecycle'
import { updateTaskLifecycle } from '../../packages/server/src/modules/studio/controllers/sessions'
import * as chatRuntime from '../../packages/server/src/modules/studio/public/chat-agent-runtime'
import * as chatRunPublic from '../../packages/server/src/modules/studio/public/chat-run'
import { ChatRunSocket } from '../../packages/server/src/modules/studio/sockets/chat-run'

function makeServer(inspect: (ref: any) => Promise<any> = async () => ({ present: true, exited: false })) {
  const emit = vi.fn()
  const nsp: any = { use: vi.fn(), on: vi.fn(), to: vi.fn(() => ({ emit, except: vi.fn(() => ({ emit })) })),
    adapter: { rooms: new Map() }, sockets: new Map() }
  vi.spyOn(chatRuntime, 'createPrimaryAgentBridge').mockReturnValue({} as any)
  vi.spyOn(chatRuntime.chatCodingAgentRunManager, 'hasSession').mockReturnValue(false)
  vi.spyOn(chatRuntime, 'hasChatEkkoBackgroundTasks').mockReturnValue(false)
  const server: any = new ChatRunSocket({ of: () => nsp } as any)
  const bridge = { processNotification: vi.fn(async (action: string) => (action === 'admit' ? { admitted: true } : { ok: true })),
    inspectProcess: vi.fn(inspect) }
  server.backgroundBridge = bridge
  server.bridge = bridge
  vi.spyOn(server, 'handleRun').mockResolvedValue(undefined)
  return { server, nsp, emit, bridge }
}

let counter = 0
function linkedTurn(server: any) {
  initAllHermesTables()
  const sid = `chat-lifecycle-${Date.now()}-${counter += 1}`
  createSession({ id: sid, profile: 'default', source: 'cli', agent: 'hermes' })
  addMessage({ session_id: sid, role: 'user', content: 'Crawl and summarize', run_marker: 'run-a' })
  const taskId = updateSessionTasks(sid, 'default', { revision: 0, changes: [{ title: 'Crawl', summary: 'Crawl the site.', status: 'open' }] }).tasks[0].id
  const state = { isWorking: true, activeRunMarker: 'run-a', queue: [], events: [], profile: 'default' }
  server.sessionMap.set(sid, state)
  const context = server.beginTaskPlanRun(sid, 'default', true, 1)
  server.updateTaskPlan(context, 'default', { context_id: context, task_id: taskId, plan: [{ id: 'a', step: 'Crawl', status: 'in_progress' }] })
  ;((globalThis as any).__lastTask ||= {})[sid] = taskId
  return { sid, taskId, context, state, generation: getSessionGeneration(sid)! }
}

function completion(sid: string, generation: string, processId: string, overrides: Record<string, unknown> = {}) {
  const key = `hermes-process:default:${processId}:${counter += 1}`
  return { kind: 'process_completion', producer_key: key, claim_id: `claim-${key}`, session_id: sid, profile: 'default',
    process_id: processId, owner_generation: generation, exit_code: 0, status: 'succeeded', message: 'Background process completed', ...overrides }
}
/** The ticket the turn's own update_plan(task_id) result pins in the bridge stream (see bridge-drain test). */
const ticketOf = (sid: string, _context?: string) => {
  const taskId = (globalThis as any).__lastTask?.[sid]
  return { taskId, attempt: getTaskLifecycle(sid, taskId)!.attempt }
}
const flush = async () => { for (let i = 0; i < 10; i += 1) await new Promise(resolve => setImmediate(resolve)) }
function ctx(input: { params?: any; body?: any; user?: any; headers?: Record<string, string>; profile?: string; credentialKind?: string }) {
  return { params: input.params || {}, query: {}, method: 'POST', request: { body: input.body || {} }, status: 200, body: undefined as any,
    state: { user: input.user, profile: { name: input.profile || 'default' }, credentialKind: input.credentialKind }, get: (name: string) => input.headers?.[name] || '' }
}

afterEach(() => vi.restoreAllMocks())

describe('owned Hermes terminal producer', () => {
  it('reads the spawned process identity from the native terminal result', () => {
    expect(terminalProducerOwner('terminal', JSON.stringify({ output: 'started', session_id: 'proc_9', pid: 42, notify_on_complete: true })))
      .toEqual({ kind: 'hermes_process', id: 'proc_9', incarnation: '42' })
    expect(terminalProducerOwner('terminal', JSON.stringify({ session_id: 'proc_9', notify_on_complete: false }))).toBeNull()
    expect(terminalProducerOwner('read_file', JSON.stringify({ session_id: 'proc_9', notify_on_complete: true }))).toBeNull()
  })

  it('binds at spawn, survives turn end, verifies on completion and never completes on exit', async () => {
    const { server } = makeServer()
    const { sid, taskId, context, generation, state } = linkedTurn(server)
    server.observeProducerSpawn(sid, ticketOf(sid, context), { kind: 'hermes_process', id: 'proc_bg' })
    server.finishTaskPlanRun(sid, 'run.completed', {}, context)
    state.isWorking = false
    expect(getTaskLifecycle(sid, taskId)?.phase).toBe('running')
    const sessionState = server.sessionStateSync.states({ id: 1, role: 'super_admin', username: 'u' }, sid)[0]
    expect(sessionState.task).toEqual({ state: 'running', count: 1 })
    expect(sessionState.working).toBe(false)

    const event = completion(sid, generation, 'proc_bg')
    await server.scheduleProcessNotification(event)
    await flush()
    expect(getTaskLifecycle(sid, taskId)).toMatchObject({ phase: 'verifying', delivery: { ref: event.producer_key } })
    const revision = getTaskLifecycle(sid, taskId)!.revision
    await server.scheduleProcessNotification(event)
    await flush()
    expect(getTaskLifecycle(sid, taskId)!.revision).toBe(revision)
  })

  it('records a failed exit as failure, not running or done', async () => {
    const { server } = makeServer()
    const { sid, taskId, context, generation } = linkedTurn(server)
    server.observeProducerSpawn(sid, ticketOf(sid, context), { kind: 'hermes_process', id: 'proc_fail' })
    await server.scheduleProcessNotification(completion(sid, generation, 'proc_fail', { exit_code: 2, status: 'failed' }))
    await flush()
    expect(getTaskLifecycle(sid, taskId)).toMatchObject({ phase: 'failed', reason: expect.stringContaining('2') })
  })

  it('reconciles exact producers after restart: present, absent and unavailable', async () => {
    const seen: string[] = []
    const { server } = makeServer(async ref => {
      seen.push(ref.process_id)
      if (ref.process_id === 'proc_alive') return { present: true, exited: false }
      if (ref.process_id === 'proc_gone') return { present: false }
      throw new Error('bridge unavailable')
    })
    const tasks: Record<string, string> = {}
    for (const id of ['proc_alive', 'proc_gone', 'proc_unreachable']) {
      const turn = linkedTurn(server)
      server.observeProducerSpawn(turn.sid, ticketOf(turn.sid, turn.context), { kind: 'hermes_process', id })
      server.finishTaskPlanRun(turn.sid, 'run.completed', {}, turn.context)
      tasks[id] = `${turn.sid}|${turn.taskId}`
    }
    const pending = markProducersUnreconciled()
    expect(pending.length).toBeGreaterThanOrEqual(3)
    await server.reconcileTaskProducers(pending)
    const phase = (id: string) => { const [sid, taskId] = tasks[id].split('|'); return getTaskLifecycle(sid, taskId)?.phase }
    expect(seen).toEqual(expect.arrayContaining(['proc_alive', 'proc_gone', 'proc_unreachable']))
    expect(phase('proc_alive')).toBe('running')
    expect(phase('proc_gone')).toBe('lost')
    expect(phase('proc_unreachable')).toBe('unknown')
  })
})

describe('lifecycle authority over HTTP', () => {
  it('lets the live turn act only on goals of its own session', () => {
    const { server } = makeServer()
    vi.spyOn(chatRunPublic, 'getChatRunServer').mockReturnValue(server)
    const mine = linkedTurn(server)
    const other = linkedTurn(server)
    const denied = ctx({ body: { context_id: mine.context, task_id: other.taskId, action: 'wait_user', kind: 'consent', reason: 'Approve' } })
    taskLifecycleAction(denied as any)
    expect(denied.status).toBe(404)
    // The other session's context is gone (a new turn began there), so use mine for my own goal.
    const ok = ctx({ body: { context_id: mine.context, task_id: mine.taskId, action: 'wait_user', kind: 'consent', reason: 'Approve the upload' } })
    taskLifecycleAction(ok as any)
    expect(ok.status).toBe(200)
    expect(getTaskLifecycle(mine.sid, mine.taskId)?.phase).toBe('waiting_user')
    // The live turn reads the lifecycle receipts it needs for verify/accept, never producer capabilities.
    const listed = server.listSessionTasks(mine.context, 'default').tasks[0]
    expect(listed.lifecycle).toMatchObject({ phase: 'waiting_user', waiting_kind: 'consent', revision: expect.any(Number) })
    expect(JSON.stringify(listed)).not.toContain('events')
    const stale = ctx({ body: { context_id: 'invented', task_id: mine.taskId, action: 'resume' } })
    taskLifecycleAction(stale as any)
    expect(stale.status).toBe(409)
  })

  it('accepts PM decisions only from an account with access, never from a run credential', () => {
    const { server } = makeServer()
    const turn = linkedTurn(server)
    const body = { action: 'deliver', summary: 'Delivered in chat', evidence: 'summary.md' }
    const run = ctx({ params: { id: turn.sid, taskId: turn.taskId }, body, user: { id: 1, role: 'super_admin' }, headers: { 'x-studio-run-context': turn.context } })
    updateTaskLifecycle(run as any)
    expect(run.status).toBe(403)
    const foreign = ctx({ params: { id: turn.sid, taskId: turn.taskId }, body, user: { id: 99, role: 'user' }, credentialKind: 'login' })
    updateTaskLifecycle(foreign as any)
    expect(foreign.status).toBe(403)
    const pm = ctx({ params: { id: turn.sid, taskId: turn.taskId }, body, user: { id: 1, role: 'super_admin' }, credentialKind: 'login' })
    updateTaskLifecycle(pm as any)
    expect(pm.status).toBe(200)
    expect(getTaskLifecycle(turn.sid, turn.taskId)?.phase).toBe('verifying')
  })
})

describe('review repairs (exact-head findings 2-5)', () => {
  const pm = { kind: 'pm' as const, account_id: 1 }
  it('a stale attempt ticket never binds, and another incarnation of the same id is not the owner', () => {
    const { server } = makeServer()
    const { sid, taskId } = linkedTurn(server)
    const stale = ticketOf(sid)
    applyTaskAction({ sessionId: sid, taskId, actor: pm, action: 'rework', body: { expected_revision: getTaskLifecycle(sid, taskId)!.revision, reason: 'New scope' } })
    server.observeProducerSpawn(sid, stale, { kind: 'hermes_process', id: 'proc_delayed', incarnation: '41' })
    expect(getTaskLifecycle(sid, taskId)).toMatchObject({ attempt: 2, phase: 'open', owner: null })
    server.observeProducerSpawn(sid, ticketOf(sid), { kind: 'hermes_process', id: 'proc_now', incarnation: '42' })
    expect(taskProducers.reconcile({ sessionId: sid, taskId, owner: { kind: 'hermes_process', id: 'proc_now', incarnation: '99' }, observation: 'absent' })).toBeNull()
    expect(getTaskLifecycle(sid, taskId)).toMatchObject({ attempt: 2, phase: 'running', owner: { id: 'proc_now', incarnation: '42' } })
  })

  it('shows producers unknown while the bridge is unreachable and reconciles them exactly after recovery', async () => {
    let poll: () => Promise<any> = async () => { throw new Error('bridge down') }
    const { server, bridge } = makeServer(async () => ({ present: true, exited: false }))
    ;(bridge as any).backgroundPoll = vi.fn(() => poll())
    const { sid, taskId, context, state } = linkedTurn(server)
    server.observeProducerSpawn(sid, ticketOf(sid, context), { kind: 'hermes_process', id: 'proc_net' })
    server.finishTaskPlanRun(sid, 'run.completed', {}, context)
    state.isWorking = false
    await server.pollBackgroundWork()
    expect(getTaskLifecycle(sid, taskId)).toMatchObject({ phase: 'unknown', reason: 'producer_unavailable' })
    poll = async () => ({ broker_id: 'broker-1', sessions: [], notifications: [], process_notifications: [], notify_pending: [] })
    server.backgroundPollRetryAt = 0
    await server.pollBackgroundWork()
    await flush()
    expect(bridge.inspectProcess).toHaveBeenCalledWith(expect.objectContaining({ process_id: 'proc_net', session_id: sid }))
    expect(getTaskLifecycle(sid, taskId)?.phase).toBe('running')
  })

  it('never restores running from waiting_user without observing the owned producer', async () => {
    const { server, bridge } = makeServer(async () => ({ present: false }))
    const { sid, taskId, context } = linkedTurn(server)
    server.observeProducerSpawn(sid, ticketOf(sid, context), { kind: 'hermes_process', id: 'proc_wait' })
    applyTaskAction({ sessionId: sid, taskId, actor: pm, action: 'wait_user', body: { kind: 'login', reason: 'Sign in' } })
    markProducersUnreconciled()
    expect(getTaskLifecycle(sid, taskId)).toMatchObject({ phase: 'waiting_user', waiting: { resume: 'unknown' } })
    const resumed = applyTaskAction({ sessionId: sid, taskId, actor: pm, action: 'resume', body: {} })
    expect(resumed.phase).toBe('unknown')
    await server.reconcileTaskProducers()
    expect(bridge.inspectProcess).toHaveBeenCalled()
    expect(getTaskLifecycle(sid, taskId)).toMatchObject({ phase: 'lost', reason: 'producer_absent' })
  })

  it('ignores a context-less terminal event of an older turn instead of closing the current turn', () => {
    const { server, nsp } = makeServer()
    const { sid, context, state } = linkedTurn(server)
    server.finishTaskPlanRun(sid, 'run.completed', {}, context)
    state.activeRunMarker = 'run-b'
    const current = server.beginTaskPlanRun(sid, 'default', true, 1)
    const plan = [{ id: 'b', step: 'Second turn', status: 'in_progress' }]
    server.updateTaskPlan(current, 'default', { context_id: current, plan })
    state.isWorking = true
    const waiter = vi.fn()
    server.runWaiters.set(sid, new Set([waiter]))
    const observe = vi.spyOn(server.sessionStateSync, 'observe')
    const activity = vi.spyOn(server, 'emitPendingInteraction')
    nsp.to.mockClear()
    for (const event of ['run.completed', 'run.failed', 'abort.completed']) server.emitExternalEvent(sid, event, { event, run_id: 'run-a' })
    // No downstream effect of the replaced run: working summary, activity/App, room, waiters, capability/card.
    expect(observe).not.toHaveBeenCalled()
    expect(activity).not.toHaveBeenCalled()
    expect(waiter).not.toHaveBeenCalled()
    expect(nsp.to).not.toHaveBeenCalled()
    expect(state.isWorking).toBe(true)
    expect(server.updateTaskPlan(current, 'default', { context_id: current, plan }).execution_state).toBe('running')
    // The current run's own terminal event still has every effect.
    server.emitExternalEvent(sid, 'run.completed', { event: 'run.completed', run_id: 'run-b' })
    expect(() => server.updateTaskPlan(current, 'default', { context_id: current, plan })).toThrow(/context/i)
    expect(waiter).toHaveBeenCalledWith('run.completed', expect.objectContaining({ run_id: 'run-b' }))
    expect(activity).toHaveBeenCalled()
  })

  it('retries a rolled-back producer delivery from its receipt without a second continuation', async () => {
    const { server } = makeServer()
    const { sid, taskId, context, generation, state } = linkedTurn(server)
    server.observeProducerSpawn(sid, ticketOf(sid, context), { kind: 'hermes_process', id: 'proc_fault' })
    const event = completion(sid, generation, 'proc_fault')
    getDb()!.exec("CREATE TEMP TRIGGER producer_card_fault BEFORE UPDATE ON task_plans BEGIN SELECT RAISE(ABORT, 'injected'); END")
    try { await server.scheduleProcessNotification(event) } finally { getDb()!.exec('DROP TRIGGER producer_card_fault') }
    await flush()
    expect(getTaskLifecycle(sid, taskId)?.phase).toBe('running')
    expect(state.queue).toHaveLength(1)
    await server.scheduleProcessNotification(event)
    await flush()
    expect(getTaskLifecycle(sid, taskId)?.phase).toBe('verifying')
    expect(state.queue).toHaveLength(1)
  })

  it('applies a committed completion receipt during reconciliation instead of declaring the producer lost', async () => {
    const { server } = makeServer(async () => ({ present: false }))
    const { sid, taskId, context, generation } = linkedTurn(server)
    server.observeProducerSpawn(sid, ticketOf(sid, context), { kind: 'hermes_process', id: 'proc_crash' })
    // A crash after the receipt commit and before the lifecycle write.
    acceptSessionNotification({ namespace: studioInstanceId(), profile: 'default', producerKey: `hermes-process:default:proc_crash:1`, sessionId: sid,
      sessionGeneration: generation, kind: 'process_completion', disposition: 'admitting', payload: { process_id: 'proc_crash', exit_code: 0, status: 'succeeded' }, attention: false })
    await server.reconcileTaskProducers(markProducersUnreconciled())
    expect(getTaskLifecycle(sid, taskId)).toMatchObject({ phase: 'verifying', delivery: { ref: 'hermes-process:default:proc_crash:1' } })
  })

  it('applies the exact native exit of a completion that wait/log consumed before Studio drained it', async () => {
    for (const [code, phase] of [[0, 'verifying'], [3, 'failed']] as const) {
      const { server, bridge } = makeServer(async () => ({ present: true, exited: true, exit_code: code }))
      const { sid, taskId, context } = linkedTurn(server)
      server.observeProducerSpawn(sid, ticketOf(sid, context), { kind: 'hermes_process', id: `proc_consumed_${code}` })
      await server.reconcileTaskProducers()
      expect(bridge.inspectProcess).toHaveBeenCalled()
      expect(getTaskLifecycle(sid, taskId)?.phase).toBe(phase)
    }
  })

  it('shows an exited process without a reported outcome as not running', async () => {
    const { server } = makeServer(async () => ({ present: true, exited: true, exit_code: null }))
    const { sid, taskId, context } = linkedTurn(server)
    server.observeProducerSpawn(sid, ticketOf(sid, context), { kind: 'hermes_process', id: 'proc_unreported' })
    await server.reconcileTaskProducers()
    expect(getTaskLifecycle(sid, taskId)).toMatchObject({ phase: 'unknown', reason: 'producer_exited_unreported' })
  })
})
