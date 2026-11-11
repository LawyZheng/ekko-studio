import './fixtures/isolated-studio-state'
/**
 * Review finding M1: bridge tool events are buffered and drained later. A producer must bind to the goal
 * attempt pinned by the turn's own earlier lifecycle results in that stream, never to whatever attempt is
 * current when Studio drains it. Real handleBridgeRun drain, real ChatRunSocket and SQLite.
 */
import type { Namespace, Socket } from 'socket.io'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../packages/server/src/modules/studio/public/runs/prompt', () => ({ getSystemPrompt: vi.fn(() => 'system prompt') }))
vi.mock('../../packages/server/src/modules/studio/services/context-compressor', () => ({
  SUMMARY_PREFIX: '[Previous context summary]',
  ChatContextCompressor: class { compress = async (history: unknown[]) => ({ messages: history, meta: { compressed: false, llmCompressed: false, verbatimCount: history.length, compressedStartIndex: -1 } }) },
}))
vi.mock('../../packages/server/src/modules/studio/public/provider-runtime', () => ({ getModelContextLength: vi.fn(() => 256_000) }))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/usage', () => ({
  calcAndUpdateUsage: vi.fn(async () => ({ inputTokens: 1, outputTokens: 1 })),
  estimateUsageTokensFromMessages: vi.fn(() => ({ inputTokens: 1, outputTokens: 1 })),
  getCachedBridgeContextOverhead: vi.fn(() => undefined),
  contextTokensWithCachedOverhead: vi.fn((_state: unknown, tokens: number) => tokens),
  updateContextTokenUsage: vi.fn(),
  updateMessageContextTokenUsage: vi.fn(),
}))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/bridge-message', () => ({
  flushBridgePendingToDb: vi.fn(), ensureOpenBridgeAssistantMessage: vi.fn(), syncBridgeReasoningToMessage: vi.fn(), recordBridgeMoaDisplayTool: vi.fn(),
  recordBridgeToolStarted: vi.fn((_s: unknown, _sid: string, _run: string, _name: string, args: unknown, id: string) => ({ id, arguments: JSON.stringify(args ?? {}) })),
  recordBridgeToolCompleted: vi.fn((_s: unknown, _sid: string, _run: string, _name: string, ev: any) => ({ id: ev.tool_call_id, output: ev.result })),
}))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/model-config', () => ({ resolveBridgeRunModelConfig: vi.fn(async () => ({ model: 'gpt-test', provider: 'openai' })) }))
vi.mock('../../packages/server/src/modules/studio/public/authorized-provider-runtime', () => ({ resolveAuthorizedProviderRuntimeCredentials: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/workspace-diff-tracker', () => ({ startWorkspaceRunCheckpoint: vi.fn(), completeWorkspaceRunCheckpoint: vi.fn(() => null) }))
vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  getProfileDir: (profile: string) => `/tmp/lifecycle-bridge-drain/${profile || 'default'}`, saveEnvValueForProfile: vi.fn(),
  readConfigYamlForProfile: vi.fn(async () => ({ compression: { enabled: false } })),
}))
vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({ issueModelRunJwt: vi.fn(async () => 'model-run-token') }))

import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { addMessage, createSession } from '../../packages/server/src/modules/studio/repositories/session-store'
import { updateSessionTasks } from '../../packages/server/src/modules/studio/services/session-tasks'
import { applyTaskAction, getTaskLifecycle } from '../../packages/server/src/modules/studio/services/task-lifecycle'
import { handleBridgeRun } from '../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run'
import * as chatRuntime from '../../packages/server/src/modules/studio/public/chat-agent-runtime'
import { ChatRunSocket } from '../../packages/server/src/modules/studio/sockets/chat-run'

let counter = 0
const pm = { kind: 'pm' as const, account_id: 1 }
const mcp = (name: string) => `mcp__ekko_studio_interaction__${name}`
/** Exactly how the bridge reports an MCP tool result: `{"result": "<Studio envelope JSON>"}`. */
const mcpResult = (envelope: Record<string, unknown>) => JSON.stringify({ result: JSON.stringify(envelope, null, 2) })

function setup() {
  initAllHermesTables()
  const nsp: any = { use: vi.fn(), on: vi.fn(), to: vi.fn(() => ({ emit: vi.fn(), except: vi.fn(() => ({ emit: vi.fn() })) })), adapter: { rooms: new Map() }, sockets: new Map() }
  vi.spyOn(chatRuntime, 'createPrimaryAgentBridge').mockReturnValue({} as any)
  const server: any = new ChatRunSocket({ of: () => nsp } as any)
  const sid = `drain-${Date.now()}-${counter += 1}`
  createSession({ id: sid, profile: 'default', source: 'cli', agent: 'hermes' })
  addMessage({ session_id: sid, role: 'user', content: 'Crawl', run_marker: 'run-a' })
  const taskId = updateSessionTasks(sid, 'default', { revision: 0, changes: [{ title: 'Crawl', summary: 'Crawl it.', status: 'open' }] }).tasks[0].id
  const state: any = { messages: [], isWorking: true, events: [], queue: [], activeRunMarker: 'run-a' }
  server.sessionMap.set(sid, state)
  // The turn's own MCP update_plan(task_id) links the goal (attempt 1) while the tools execute.
  const context = server.beginTaskPlanRun(sid, 'default', true, 1)
  const card = server.updateTaskPlan(context, 'default', { context_id: context, task_id: taskId, plan: [{ id: 'a', step: 'Crawl', status: 'in_progress' }] })
  return { server, nsp, sid, taskId, state, card }
}

/** Drive the real drain: the bridge buffers these events and Studio reads them only after `beforeDrain`. */
async function drain(ctx: ReturnType<typeof setup>, events: Record<string, unknown>[], beforeDrain: () => void) {
  const bridge = {
    chat: vi.fn(async () => ({ run_id: 'bridge-run-1', status: 'started' })),
    contextEstimate: vi.fn(async () => ({ token_count: 10, fixed_context_tokens: 5, message_count: 0, tool_count: 0, system_prompt_chars: 1 })),
    compressionRespond: vi.fn(async () => undefined),
    streamOutput: vi.fn(async function* () {
      beforeDrain()
      yield { run_id: 'bridge-run-1', events }
      yield { run_id: 'bridge-run-1', done: true, status: 'completed', output: 'ok' }
    }),
  }
  const emitter = { emit: vi.fn(), except: vi.fn(() => ({ emit: vi.fn() })) }
  const nsp = { adapter: { rooms: new Map() }, to: vi.fn(() => emitter) } as unknown as Namespace
  const socket = { connected: false, emit: vi.fn(), join: vi.fn(), to: vi.fn(() => emitter), data: {} } as unknown as Socket
  await handleBridgeRun(nsp, socket, {
    session_id: ctx.sid, input: 'Crawl', run_marker: 'run-a', onEvent: vi.fn(),
    on_producer_spawn: (owner: any, ticket: any) => ctx.server.observeProducerSpawn(ctx.sid, ticket, owner),
  } as any, 'default', ctx.server.sessionMap, bridge as any, false, vi.fn(), vi.fn())
}

const planUpdated = (ctx: ReturnType<typeof setup>) => [
  { event: 'tool.started', tool_call_id: 'c1', tool_name: mcp('ekko_studio_update_plan'), args: {} },
  { event: 'tool.completed', tool_call_id: 'c1', tool_name: mcp('ekko_studio_update_plan'), result: mcpResult({ ok: true, ...ctx.card }) },
]
const terminal = (id: string, proc: string) => [
  { event: 'tool.started', tool_call_id: id, tool_name: 'terminal', args: { background: true, notify_on_complete: true } },
  { event: 'tool.completed', tool_call_id: id, tool_name: 'terminal', result: JSON.stringify({ output: 'Background process started', session_id: proc, pid: 7, notify_on_complete: true }) },
]

afterEach(() => vi.restoreAllMocks())

describe('producer binding across a delayed bridge drain', () => {
  it('positive control: without a rework the spawn binds to the attempt pinned in the stream', async () => {
    const ctx = setup()
    await drain(ctx, [...planUpdated(ctx), ...terminal('c2', 'proc_ok')], () => {})
    expect(getTaskLifecycle(ctx.sid, ctx.taskId)).toMatchObject({ attempt: 1, phase: 'running', owner: { id: 'proc_ok' } })
  })

  it('a PM rework that lands before Studio drains the buffered events never receives the old spawn', async () => {
    const ctx = setup()
    await drain(ctx, [...planUpdated(ctx), ...terminal('c2', 'proc_old')], () => {
      applyTaskAction({ sessionId: ctx.sid, taskId: ctx.taskId, actor: pm, action: 'rework', body: { expected_revision: getTaskLifecycle(ctx.sid, ctx.taskId)!.revision, reason: 'scope' } })
    })
    expect(getTaskLifecycle(ctx.sid, ctx.taskId)).toMatchObject({ attempt: 2, phase: 'open', owner: null })
  })

  it("the turn's own rework re-pins only the tools after it in the stream", async () => {
    let reworked: any
    const events = () => [...planUpdated(ctx2), ...terminal('c2', 'proc_before'),
      { event: 'tool.started', tool_call_id: 'c3', tool_name: mcp('ekko_studio_task_lifecycle'), args: {} },
      { event: 'tool.completed', tool_call_id: 'c3', tool_name: mcp('ekko_studio_task_lifecycle'), result: mcpResult({ ok: true, ...reworked }) },
      ...terminal('c4', 'proc_after')]
    const ctx2 = setup()
    // The own rework executed (and committed) before the drain; its result sits in the stream after proc_before.
    reworked = applyTaskAction({ sessionId: ctx2.sid, taskId: ctx2.taskId, actor: { kind: 'hermes', run_id: 'run-a' }, action: 'rework',
      body: { expected_revision: getTaskLifecycle(ctx2.sid, ctx2.taskId)!.revision, reason: 'redo' } })
    await drain(ctx2, events(), () => {})
    expect(getTaskLifecycle(ctx2.sid, ctx2.taskId)).toMatchObject({ attempt: 2, phase: 'running', owner: { id: 'proc_after' } })
  })

  it('binds nothing when the stream carries no lifecycle correlation', async () => {
    const ctx = setup()
    await drain(ctx, terminal('c2', 'proc_uncorrelated'), () => {})
    expect(getTaskLifecycle(ctx.sid, ctx.taskId)).toMatchObject({ attempt: 1, phase: 'open', owner: null })
  })
})
