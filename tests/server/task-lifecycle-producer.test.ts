import './fixtures/isolated-studio-state'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { addMessage, createSession } from '../../packages/server/src/modules/studio/repositories/session-store'
import { updateSessionTasks } from '../../packages/server/src/modules/studio/services/session-tasks'
import { applyTaskAction, getTaskLifecycle, taskProducers } from '../../packages/server/src/modules/studio/public/task-lifecycle'
import { linkTaskPlan } from '../../packages/server/src/modules/studio/services/task-lifecycle'

const worker = resolve('tests/server/fixtures/task-lifecycle-worker.mjs')

/**
 * A trusted launcher that owns the real child handle: it reserves the attempt, binds the actual pid, and
 * reports only what the handle and its stdout pipe show. Reconciliation asks the same handle.
 */
async function launch(sessionId: string, taskId: string, code: number, delayMs = 150) {
  const { attempt } = taskProducers.reserve({ sessionId, taskId })
  const out = join(mkdtempSync(join(tmpdir(), 'lifecycle-worker-')), 'report.md')
  const child: ChildProcess = spawn(process.execPath, [worker, out, String(code), String(delayMs)], { stdio: ['ignore', 'pipe', 'inherit'] })
  const owner = { kind: 'test_subprocess', id: `pid:${child.pid}`, incarnation: String(child.pid) }
  taskProducers.start({ sessionId, taskId, attempt, owner, eventId: `spawn:${child.pid}` })
  const observe = () => taskProducers.reconcile({ sessionId, taskId, owner, observation: child.exitCode === null && child.signalCode === null ? 'present' : 'absent' })
  let stdout = ''
  child.stdout!.on('data', chunk => { stdout += chunk })
  const exit = new Promise<number>(done => child.on('exit', status => done(status ?? -1)))
  return { child, owner, attempt, out, observe, finished: exit.then(status => {
    if (status !== 0) return taskProducers.fail({ sessionId, taskId, attempt, owner, eventId: `exit:${child.pid}`, reason: `exit code ${status}` })
    const report = JSON.parse(stdout.trim())
    return taskProducers.deliver({ sessionId, taskId, attempt, owner, eventId: `exit:${child.pid}`,
      result: { ref: report.artifact, digest: report.sha256, summary: 'Report written' } })
  }) }
}

function goal() {
  initAllHermesTables()
  const sid = `producer-${Date.now()}-${Math.random().toString(16).slice(2)}`
  createSession({ id: sid, profile: 'default', source: 'cli', agent: 'hermes' })
  addMessage({ session_id: sid, role: 'user', content: 'Write the report', run_marker: 'run-a' })
  const taskId = updateSessionTasks(sid, 'default', { revision: 0, changes: [{ title: 'Report', summary: 'Write it.', status: 'open' }] }).tasks[0].id
  // The parent turn links the goal to its card (ekko_studio_update_plan task_id) before any producer.
  linkTaskPlan(sid, taskId, `mcp:card-${sid}`)
  return { sid, taskId }
}

describe('trusted producer port with a real subprocess', () => {
  it('runs, delivers an immutable artifact reference, and is verified and accepted by the parent only', async () => {
    const { sid, taskId } = goal()
    const run = await launch(sid, taskId, 0)
    run.observe()
    expect(getTaskLifecycle(sid, taskId)?.phase).toBe('running')
    await run.finished
    const delivered = getTaskLifecycle(sid, taskId)!
    expect(delivered).toMatchObject({ phase: 'verifying', delivery: { ref: run.out } })
    // A real deterministic verification check: the artifact still has the delivered digest.
    const digest = createHash('sha256').update(readFileSync(run.out)).digest('hex')
    expect(digest).toBe(delivered.delivery!.digest)
    applyTaskAction({ sessionId: sid, taskId, actor: { kind: 'pm', account_id: 1 }, action: 'verify',
      body: { delivery_id: delivered.delivery!.id, evidence: `sha256 ${digest} of ${run.out}` } })
    const verified = getTaskLifecycle(sid, taskId)!
    applyTaskAction({ sessionId: sid, taskId, actor: { kind: 'pm', account_id: 1 }, action: 'accept',
      body: { delivery_id: verified.delivery!.id, verification_id: verified.verification!.id, expected_revision: verified.revision, evidence: 'Report accepted.' } })
    expect(getTaskLifecycle(sid, taskId)?.phase).toBe('done')
    // The handle is gone now; a late reconciliation of the finished attempt cannot reopen it.
    expect(run.observe()).toBeNull()
    expect(getTaskLifecycle(sid, taskId)?.phase).toBe('done')
  })

  it('reports a failing child as failed and its absent handle cannot become running again', async () => {
    const { sid, taskId } = goal()
    const run = await launch(sid, taskId, 3)
    await run.finished
    expect(getTaskLifecycle(sid, taskId)).toMatchObject({ phase: 'failed', reason: 'exit code 3' })
    run.observe()
    expect(getTaskLifecycle(sid, taskId)?.phase).toBe('failed')
  })

  it('fences the first child after rework while the second attempt runs', async () => {
    const { sid, taskId } = goal()
    const first = await launch(sid, taskId, 0)
    applyTaskAction({ sessionId: sid, taskId, actor: { kind: 'pm', account_id: 1 }, action: 'rework',
      body: { expected_revision: getTaskLifecycle(sid, taskId)!.revision, reason: 'Change scope' } })
    const second = await launch(sid, taskId, 0, 1500)
    expect(second.attempt).toBe(first.attempt + 1)
    await first.finished
    expect(getTaskLifecycle(sid, taskId)).toMatchObject({ attempt: second.attempt, phase: 'running' })
    await second.finished
    expect(getTaskLifecycle(sid, taskId)).toMatchObject({ attempt: second.attempt, phase: 'verifying', delivery: { ref: second.out } })
  })
})
