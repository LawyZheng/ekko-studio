import { createHash, randomUUID } from 'node:crypto'
import { getSessionGeneration } from '../repositories/session-store'
import { saveTaskPlan } from '../repositories/task-plan-store'
import { listLinkedLifecycleRows, readLifecycleRow, readStoredPlan, writeLifecycle, type GoalCompletion, type LifecycleRow } from '../repositories/task-lifecycle-store'
import type { SessionTaskLifecycle, TaskProducerOwner } from '../contracts/session-task'
import type { TaskLifecyclePhase, TaskLifecycleProjection, TaskPlanSnapshot } from '../contracts/task-plan'

/**
 * Durable task lifecycle of a linked session goal (docs/task-lifecycle.md). The goal row is the only
 * outcome authority; its original task card is a projection. Producers (owned workers) can start, deliver,
 * fail and be reconciled; only a live Hermes turn or an authorized account verifies and accepts.
 */
export class TaskLifecycleError extends Error {
  constructor(message: string, public readonly status = 409, public readonly code = 'conflict') { super(message) }
}

export type TaskActor = { kind: 'hermes'; run_id: string } | { kind: 'pm'; account_id: number }
export type TaskLifecycleView = SessionTaskLifecycle & { task_id: string; revision: number; status: string }
type Listener = (sessionId: string, card: TaskPlanSnapshot | null) => void

const ORDINARY_SOURCES = new Set(['api_server', 'cli', 'desktop', 'builtin_agent', 'coding_agent', ''])
const ACTIVE: TaskLifecyclePhase[] = ['starting', 'running', 'unknown', 'waiting_user']
const MAX_EVENTS = 64
const listeners = new Set<Listener>()

export function onTaskLifecycleChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Same producer handle; when both sides know the incarnation (e.g. pid) it must match too. */
const sameOwner = (a: TaskProducerOwner | null | undefined, b: TaskProducerOwner) => !!a && a.kind === b.kind && a.id === b.id
  && (!a.incarnation || !b.incarnation || a.incarnation === b.incarnation)
const actorRef = (actor: TaskActor) => actor.kind === 'hermes' ? `hermes:${actor.run_id}` : `pm:${actor.account_id}`
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function text(value: unknown, field: string, max: number, required = true): string {
  const result = typeof value === 'string' ? value.trim() : ''
  if ((required && !result) || result.length > max) throw new TaskLifecycleError(`${field} must contain 1 to ${max} characters`, 400, 'invalid')
  return result
}

function view(row: LifecycleRow, lifecycle = row.lifecycle!, revision = row.revision): TaskLifecycleView {
  return { ...structuredClone(lifecycle), task_id: row.id, revision, status: row.status }
}

export function projectLifecycle(lifecycle: SessionTaskLifecycle, revision: number): TaskLifecycleProjection {
  return {
    phase: lifecycle.phase, attempt: lifecycle.attempt, revision, updated_at: lifecycle.updated_at,
    ...(lifecycle.owner ? { owner_kind: lifecycle.owner.kind } : {}),
    ...(lifecycle.delivery ? { delivery_id: lifecycle.delivery.id } : {}),
    ...(lifecycle.verification ? { verification_id: lifecycle.verification.id } : {}),
    ...(lifecycle.waiting ? { waiting_kind: lifecycle.waiting.kind } : {}),
    ...(lifecycle.reason ? { reason: lifecycle.reason } : {}),
  }
}

/** The original card with a new lifecycle projection; computed inside the lifecycle transaction. */
function projectedCard(row: LifecycleRow, lifecycle: SessionTaskLifecycle, revision: number, base?: TaskPlanSnapshot): TaskPlanSnapshot | null {
  const stored = readStoredPlan(row.session_id, lifecycle.plan_id)
  const card = base || stored
  if (!card) return null
  return { ...card, run_id: stored?.run_id ?? card.run_id, created_at: stored?.created_at ?? card.created_at, task_id: row.id,
    lifecycle: projectLifecycle(lifecycle, revision), revision: Math.max(card.revision, (stored?.revision || 0) + 1), updated_at: Date.now() }
}

function notify(sessionId: string, card: TaskPlanSnapshot | null) {
  for (const listener of listeners) listener(sessionId, card)
}

/** One compare-and-set transition. `change` returns null for "nothing to do". */
function transition(row: LifecycleRow, change: (current: SessionTaskLifecycle) => SessionTaskLifecycle | null, goal?: GoalCompletion): TaskLifecycleView | null {
  const current = row.lifecycle
  if (!current) throw new TaskLifecycleError('This goal is not linked to a task card; link it with ekko_studio_update_plan task_id first', 409, 'not_linked')
  if (!row.session_generation || row.session_generation !== current.session_generation) return null
  const next = change(structuredClone(current))
  if (!next) return null
  next.updated_at = Math.max(Date.now(), current.updated_at + 1)
  const written = writeLifecycle(row, next, goal, revision => projectedCard(row, next, revision))
  if (!written) throw new TaskLifecycleError('Task lifecycle changed concurrently; read it again', 409, 'revision_conflict')
  notify(row.session_id, written.card)
  return view(goal ? { ...row, status: goal.status } : row, next, written.revision)
}

/** Idempotency: the same event id with the same content is a duplicate; other content is a conflict. */
function seen(lifecycle: SessionTaskLifecycle, eventId: string, content: unknown): boolean {
  const known = lifecycle.events[eventId]
  const value = digest(content)
  if (known === value) return true
  if (known) throw new TaskLifecycleError(`Event ${eventId} was already recorded with different content (conflict)`, 409, 'event_conflict')
  return false
}
function remember(lifecycle: SessionTaskLifecycle, eventId: string, content: unknown) {
  lifecycle.events[eventId] = digest(content)
  const keys = Object.keys(lifecycle.events)
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_EVENTS))) delete lifecycle.events[key]
}

function goalRow(sessionId: string, taskId: string): LifecycleRow {
  const row = readLifecycleRow(sessionId, taskId)
  if (!row || sessionId.startsWith('person-') || !ORDINARY_SOURCES.has(row.source)) {
    throw new TaskLifecycleError('Unknown session goal for this turn', 404, 'not_found')
  }
  if (row.status === 'closed') throw new TaskLifecycleError('This goal was closed by the user', 409, 'closed')
  return row
}

export function getTaskLifecycle(sessionId: string, taskId: string): TaskLifecycleView | null {
  const row = readLifecycleRow(sessionId, taskId)
  return row?.lifecycle ? view(row) : null
}

/**
 * Resolve, without writing, which card a goal uses: its linked original card, or none yet (the caller's card
 * becomes the original, linked atomically with its first save by `commitTaskPlanSnapshot`).
 */
export function resolveTaskPlan(sessionId: string, taskId: string): { planId: string | null; stored: TaskPlanSnapshot | null } {
  const row = goalRow(sessionId, taskId)
  if (row.lifecycle) return { planId: row.lifecycle.plan_id, stored: readStoredPlan(sessionId, row.lifecycle.plan_id) }
  if (row.status !== 'open') throw new TaskLifecycleError('Only an open goal can be linked to a task card', 409, 'not_open')
  return { planId: null, stored: null }
}

function newLifecycle(planId: string, generation: string): SessionTaskLifecycle {
  return { v: 1, plan_id: planId, phase: 'open', attempt: 1, session_generation: generation, owner: null, delivery: null,
    verification: null, acceptance: null, waiting: null, reason: '', events: {}, updated_at: Date.now() }
}

/** Link an open goal to a card id without a card update (trusted launchers and tests). */
export function linkTaskPlan(sessionId: string, taskId: string, planId: string) {
  const row = goalRow(sessionId, taskId)
  if (row.lifecycle) return { planId: row.lifecycle.plan_id }
  const generation = getSessionGeneration(sessionId)
  if (row.status !== 'open' || !generation) throw new TaskLifecycleError('Only an open goal can be linked to a task card', 409, 'not_open')
  if (!writeLifecycle(row, newLifecycle(planId, generation))) throw new TaskLifecycleError('Session goal changed; retry', 409, 'revision_conflict')
  return { planId }
}

/**
 * Card writes keep the original anchor, never go backwards, and carry the committed projection. The first
 * save of a goal's card links the goal in the same transaction.
 */
export function commitTaskPlanSnapshot(snapshot: TaskPlanSnapshot): TaskPlanSnapshot {
  const next: TaskPlanSnapshot = { ...snapshot }
  delete next.lifecycle
  const row = next.task_id ? readLifecycleRow(next.session_id, next.task_id) : null
  if (next.task_id && row && !row.lifecycle) {
    const generation = getSessionGeneration(next.session_id)
    if (row.status !== 'open' || !generation) throw new TaskLifecycleError('Only an open goal can be linked to a task card', 409, 'not_open')
    const lifecycle = newLifecycle(next.plan_id, generation)
    const written = writeLifecycle(row, lifecycle, undefined, revision => projectedCard(row, lifecycle, revision, next))
    if (!written?.card) throw new TaskLifecycleError('Session goal changed; retry', 409, 'revision_conflict')
    return written.card
  }
  if (next.task_id && row?.lifecycle?.plan_id !== next.plan_id) {
    if (row?.lifecycle) throw new TaskLifecycleError('This goal already has another original card', 409, 'card_conflict')
    delete next.task_id
  }
  const stored = readStoredPlan(next.session_id, next.plan_id)
  if (stored) {
    next.run_id = stored.run_id
    next.created_at = stored.created_at
    if (stored.revision >= next.revision) next.revision = stored.revision + 1
  }
  if (row?.lifecycle && next.task_id) next.lifecycle = projectLifecycle(row.lifecycle, row.revision)
  saveTaskPlan(next)
  return next
}

// --- Trusted producer port -------------------------------------------------------------------------

interface ProducerRef { sessionId: string; taskId?: string; attempt?: number; sessionGeneration?: string; owner: TaskProducerOwner; eventId: string }

/** Locate the goal whose CURRENT attempt is owned by this producer; stale owners resolve to nothing. */
function producerRow(input: ProducerRef): LifecycleRow | null {
  const rows = input.taskId ? [readLifecycleRow(input.sessionId, input.taskId)].filter((row): row is LifecycleRow => !!row?.lifecycle)
    : listLinkedLifecycleRows(input.sessionId)
  for (const row of rows) {
    const lifecycle = row.lifecycle!
    if (lifecycle.events[input.eventId]) return row
    if (sameOwner(lifecycle.owner, input.owner) && (input.attempt === undefined || input.attempt === lifecycle.attempt)) return row
  }
  return null
}

function producerEvent(input: ProducerRef, content: unknown, apply: (lifecycle: SessionTaskLifecycle) => boolean) {
  const row = producerRow(input)
  if (!row || row.session_generation !== row.lifecycle!.session_generation) return null
  if (seen(row.lifecycle!, input.eventId, content)) return { duplicate: true, lifecycle: view(row) }
  const result = transition(row, lifecycle => {
    if (!sameOwner(lifecycle.owner, input.owner) || (input.attempt !== undefined && input.attempt !== lifecycle.attempt)) return null
    if (!apply(lifecycle)) return null
    remember(lifecycle, input.eventId, content)
    return lifecycle
  })
  return result ? { duplicate: false, lifecycle: result } : null
}

export const taskProducers = {
  /** Reserve the current attempt before a producer exists. */
  reserve(input: { sessionId: string; taskId: string }): { attempt: number } {
    const row = goalRow(input.sessionId, input.taskId)
    const phase = row.lifecycle?.phase
    if (phase === 'starting') return { attempt: row.lifecycle!.attempt }
    if (phase !== 'open') throw new TaskLifecycleError(`Attempt is busy (${phase || 'not linked'})`, 409, 'attempt_busy')
    const result = transition(row, lifecycle => ({ ...lifecycle, phase: 'starting', reason: '' }))
    return { attempt: result?.attempt ?? row.lifecycle!.attempt }
  },

  /** Bind the actual owned producer handle to the current attempt. */
  start(input: ProducerRef & { taskId: string }) {
    const row = goalRow(input.sessionId, input.taskId)
    const lifecycle = row.lifecycle
    if (!lifecycle) throw new TaskLifecycleError('Goal is not linked to a task card', 409, 'not_linked')
    const content = { type: 'start', owner: input.owner }
    if (seen(lifecycle, input.eventId, content)) return { duplicate: true, lifecycle: view(row) }
    if (input.attempt !== undefined && input.attempt !== lifecycle.attempt) throw new TaskLifecycleError('Stale attempt', 409, 'stale_attempt')
    if (input.sessionGeneration !== undefined && input.sessionGeneration !== lifecycle.session_generation) throw new TaskLifecycleError('Stale session incarnation', 409, 'session_reset')
    if (lifecycle.owner || !['open', 'starting'].includes(lifecycle.phase)) throw new TaskLifecycleError(`Attempt ${lifecycle.attempt} is busy`, 409, 'attempt_busy')
    const result = transition(row, next => {
      remember(next, input.eventId, content)
      return { ...next, phase: 'running', owner: { ...input.owner }, reason: '' }
    })
    return result ? { duplicate: false, lifecycle: result } : null
  },

  /** The current owner delivered an immutable result reference. Delivery is never acceptance. */
  deliver(input: ProducerRef & { result: { ref: string; digest?: string; summary: string } }) {
    const result = { ref: text(input.result.ref, 'result.ref', 2000), summary: text(input.result.summary, 'result.summary', 1000),
      ...(input.result.digest ? { digest: text(input.result.digest, 'result.digest', 200) } : {}) }
    return producerEvent(input, { type: 'deliver', owner: input.owner, result }, lifecycle => {
      if (!ACTIVE.includes(lifecycle.phase)) return false
      Object.assign(lifecycle, { phase: 'verifying', waiting: null, reason: '', verification: null,
        delivery: { id: randomUUID(), by: `${input.owner.kind}:${input.owner.id}`, at: Date.now(), ...result } })
      return true
    })
  },

  fail(input: ProducerRef & { reason: string }) {
    const reason = text(input.reason, 'reason', 500)
    return producerEvent(input, { type: 'fail', owner: input.owner, reason }, lifecycle => {
      if (!ACTIVE.includes(lifecycle.phase)) return false
      Object.assign(lifecycle, { phase: 'failed', waiting: null, reason })
      return true
    })
  },

  /** Exact-producer observation: absent ownership is lost, an unreachable producer is unknown. */
  reconcile(input: Omit<ProducerRef, 'eventId'> & { taskId: string; observation: 'present' | 'absent' | 'unavailable' | 'exited' }) {
    const row = producerRow({ ...input, eventId: '' })
    if (!row) return null
    return transition(row, lifecycle => {
      if (!sameOwner(lifecycle.owner, input.owner)) return null
      const phase: TaskLifecyclePhase = input.observation === 'present' ? 'running' : input.observation === 'absent' ? 'lost' : 'unknown'
      const reason = phase === 'lost' ? 'producer_absent' : input.observation === 'exited' ? 'producer_exited_unreported' : phase === 'unknown' ? 'producer_unavailable' : ''
      // Waiting for the user stays visible; the observation decides what `resume` restores.
      if (lifecycle.phase === 'waiting_user' && lifecycle.waiting && ['starting', 'running', 'unknown'].includes(lifecycle.waiting.resume)) {
        if (lifecycle.waiting.resume === phase) return null
        return { ...lifecycle, waiting: { ...lifecycle.waiting, resume: phase }, reason }
      }
      if (!['starting', 'running', 'unknown'].includes(lifecycle.phase) || phase === lifecycle.phase) return null
      return { ...lifecycle, phase, reason }
    })
  },
}

/**
 * Startup: no historical record proves a producer is still running. Every active producer becomes
 * `unknown` until its exact handle is observed again; delivered/verifying state is kept as is.
 */
export function markProducersUnreconciled(): Array<{ sessionId: string; taskId: string; owner: TaskProducerOwner }> {
  const pending: Array<{ sessionId: string; taskId: string; owner: TaskProducerOwner }> = []
  for (const row of listLinkedLifecycleRows()) {
    const lifecycle = row.lifecycle!
    const waitingOnProducer = lifecycle.phase === 'waiting_user' && !!lifecycle.owner && ['starting', 'running'].includes(lifecycle.waiting?.resume || '')
    if (!['starting', 'running'].includes(lifecycle.phase) && !waitingOnProducer) continue
    try {
      transition(row, next => waitingOnProducer
        ? { ...next, waiting: { ...next.waiting!, resume: 'unknown' }, reason: 'studio_restarted' }
        : { ...next, phase: 'unknown', reason: 'studio_restarted' })
      if (lifecycle.owner) pending.push({ sessionId: row.session_id, taskId: row.id, owner: lifecycle.owner })
    } catch { /* a concurrent change wins */ }
  }
  return pending
}

/** Producers whose current attempt is still owned (running or unreconciled), for exact reconciliation. */
export function listActiveProducers(): Array<{ sessionId: string; taskId: string; owner: TaskProducerOwner }> {
  return listLinkedLifecycleRows().filter(row => row.lifecycle!.owner && ['starting', 'running', 'unknown', 'waiting_user'].includes(row.lifecycle!.phase))
    .map(row => ({ sessionId: row.session_id, taskId: row.id, owner: row.lifecycle!.owner! }))
}

// --- Parent (live Hermes turn) and PM actions --------------------------------------------------------

export function applyTaskAction(input: { sessionId: string; taskId: string; actor: TaskActor; action: string; body: Record<string, unknown> }): TaskLifecycleView {
  const row = goalRow(input.sessionId, input.taskId)
  const body = input.body || {}
  const by = actorRef(input.actor)
  const expectRevision = () => {
    if (body.expected_revision !== row.revision) throw new TaskLifecycleError('expected_revision does not match the current lifecycle revision', 409, 'revision_conflict')
  }
  let goal: GoalCompletion | undefined
  let change: (lifecycle: SessionTaskLifecycle) => SessionTaskLifecycle
  const require = (ok: boolean, message: string) => { if (!ok) throw new TaskLifecycleError(message, 409, 'invalid_state') }
  switch (input.action) {
    case 'wait_user': {
      const kind = body.kind
      if (kind !== 'login' && kind !== 'consent' && kind !== 'decision') throw new TaskLifecycleError('kind must be login, consent or decision', 400, 'invalid')
      const reason = text(body.reason, 'reason', 500)
      change = lifecycle => {
        require(['open', 'starting', 'running', 'unknown', 'verifying'].includes(lifecycle.phase), `Cannot wait for the user while ${lifecycle.phase}`)
        return { ...lifecycle, phase: 'waiting_user', waiting: { kind, reason, resume: lifecycle.phase } }
      }
      break
    }
    case 'resume':
      change = lifecycle => {
        require(lifecycle.phase === 'waiting_user' && !!lifecycle.waiting, 'The task is not waiting for the user')
        // An owned producer is shown running again only after it is observed (the caller reconciles it).
        const unobserved = !!lifecycle.owner && ['starting', 'running'].includes(lifecycle.waiting!.resume)
        return { ...lifecycle, phase: unobserved ? 'unknown' : lifecycle.waiting!.resume, waiting: null,
          reason: unobserved ? 'awaiting_reconciliation' : lifecycle.reason }
      }
      break
    case 'deliver': {
      // Foreground work without a producer: the parent delivers explicitly; verification still follows.
      const summary = text(body.summary, 'summary', 1000)
      const evidence = text(body.evidence, 'evidence', 2000, false)
      change = lifecycle => {
        require(!lifecycle.owner && ['open', 'starting'].includes(lifecycle.phase), 'Only a task without an owned producer can be delivered by its parent')
        return { ...lifecycle, phase: 'verifying', reason: '', verification: null,
          delivery: { id: randomUUID(), by, at: Date.now(), ref: evidence || by, summary } }
      }
      break
    }
    case 'verify': {
      const evidence = text(body.evidence, 'evidence', 2000)
      change = lifecycle => {
        require(lifecycle.phase === 'verifying' && lifecycle.delivery?.id === body.delivery_id, 'delivery_id is not the current delivery')
        return { ...lifecycle, verification: { id: randomUUID(), by, at: Date.now(), evidence } }
      }
      break
    }
    case 'accept': {
      const evidence = text(body.evidence, 'evidence', 1000)
      expectRevision()
      change = lifecycle => {
        require(lifecycle.phase === 'verifying' && lifecycle.delivery?.id === body.delivery_id, 'delivery_id is not the current delivery')
        require(!!lifecycle.verification && lifecycle.verification.id === body.verification_id, 'verification_id is not the recorded verification of this delivery')
        return { ...lifecycle, phase: 'done', reason: '', acceptance: { evidence, by, at: Date.now() } }
      }
      goal = { status: 'completed', evidence }
      break
    }
    case 'rework': {
      const reason = text(body.reason, 'reason', 500)
      expectRevision()
      change = lifecycle => ({ ...lifecycle, phase: 'open', attempt: lifecycle.attempt + 1, owner: null, delivery: null,
        verification: null, acceptance: null, waiting: null, reason })
      if (row.status === 'completed') goal = { status: 'open', evidence: '' }
      break
    }
    default:
      throw new TaskLifecycleError('action must be wait_user, resume, deliver, verify, accept or rework', 400, 'invalid')
  }
  const result = transition(row, change, goal)
  if (!result) throw new TaskLifecycleError('The session was reset; this goal is no longer current', 409, 'session_reset')
  return result
}

// --- Session projection (card and avatar share it) -----------------------------------------------

export type SessionTaskState = 'waiting_user' | 'running' | 'verifying' | 'failed' | 'lost' | 'unknown' | 'open' | 'done'
const RANK: Record<TaskLifecyclePhase, [number, SessionTaskState]> = {
  waiting_user: [5, 'waiting_user'], starting: [4, 'running'], running: [4, 'running'], verifying: [4, 'verifying'],
  failed: [3, 'failed'], lost: [3, 'lost'], unknown: [3, 'unknown'], open: [2, 'open'], done: [1, 'done'],
}
const ORDER: SessionTaskState[] = ['waiting_user', 'running', 'verifying', 'failed', 'lost', 'unknown', 'open', 'done']

/** Per-session summary over all linked, not closed goals of the session's live incarnation. */
export function projectSessionTaskStates(sessionIds: string[]): Map<string, { state: SessionTaskState; count: number }> {
  const wanted = new Set(sessionIds)
  const groups = new Map<string, Array<[number, SessionTaskState]>>()
  for (const row of listLinkedLifecycleRows()) {
    if (!wanted.has(row.session_id) || row.session_generation !== row.lifecycle!.session_generation) continue
    groups.set(row.session_id, [...(groups.get(row.session_id) || []), RANK[row.lifecycle!.phase] || RANK.unknown])
  }
  const result = new Map<string, { state: SessionTaskState; count: number }>()
  for (const [sessionId, entries] of groups) {
    const rank = Math.max(...entries.map(([value]) => value))
    const top = entries.filter(([value]) => value === rank).map(([, state]) => state)
    result.set(sessionId, { state: ORDER.find(state => top.includes(state))!, count: top.length })
  }
  return result
}
