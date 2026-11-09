import './fixtures/isolated-studio-state'
/**
 * Passive notices reach the model once, on the next intentional question, while native history stores only the
 * user's question. Migrated from the fork's case in the removed run-chat-bridge-final-context suite onto the
 * focused handleBridgeRun scaffold.
 */
import type { Namespace, Socket } from 'socket.io'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleBridgeRun } from '../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run'
import type { PrimaryAgentBridgeClient } from '../../packages/server/src/modules/studio/public/chat-agent-runtime'
import type { ChatMessage } from '../../packages/server/src/modules/studio/services/context-compressor'
import type { SessionState } from '../../packages/server/src/modules/studio/services/chat-run/types'

const projection = vi.hoisted(() => ({
  build: vi.fn((_sessionId: string): { text: string; ids: number[] } | null => null),
  mark: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/session-notifications/presentation', async importOriginal => ({
  ...await importOriginal<any>(),
  buildNoticeProjection: projection.build,
}))

vi.mock('../../packages/server/src/modules/studio/repositories/session-notification-store', async importOriginal => ({
  ...await importOriginal<any>(),
  markSessionNotificationsProjected: projection.mark,
}))

const mocks = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  getSession: vi.fn(),
  updateSession: vi.fn(),
  compress: vi.fn(async (history: unknown[]) => ({
    messages: history,
    meta: { compressed: false, llmCompressed: false, verbatimCount: history.length, compressedStartIndex: -1 },
  })),
}))

vi.mock('../../packages/server/src/modules/studio/public/runs/prompt', () => ({
  getSystemPrompt: vi.fn(() => 'system prompt'),
}))

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  getSession: mocks.getSession,
  getSessionGeneration: vi.fn(() => 'generation-test'),
  getSessionContextMessages: vi.fn(() => mocks.rows),
  getSessionContextMessage: vi.fn(),
  getFirstSessionMessageByRole: vi.fn(),
  getSessionMessageCountByRole: vi.fn(() => 0),
  createSession: vi.fn(),
  addMessage: vi.fn((row: Record<string, unknown>) => {
    const id = mocks.rows.length + 1
    mocks.rows.push({ ...row, id })
    return id
  }),
  updateSession: mocks.updateSession,
  updateSessionStats: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/repositories/compression-snapshot', () => ({
  getCompressionSnapshot: vi.fn(() => null),
  deleteCompressionSnapshot: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/context-compressor', () => ({
  SUMMARY_PREFIX: '[Previous context summary]',
  ChatContextCompressor: class {
    compress = mocks.compress
  },
}))

vi.mock('../../packages/server/src/modules/studio/repositories/usage-store', () => ({
  updateUsage: vi.fn(),
  getUsage: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  bridgeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/modules/studio/public/provider-runtime', () => ({
  getModelContextLength: vi.fn(() => 256_000),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/usage', () => ({
  calcAndUpdateUsage: vi.fn(async () => ({ inputTokens: 1, outputTokens: 1 })),
  estimateUsageTokensFromMessages: vi.fn(() => ({ inputTokens: 1, outputTokens: 1 })),
  getCachedBridgeContextOverhead: vi.fn(() => undefined),
  contextTokensWithCachedOverhead: vi.fn((_state: unknown, tokens: number) => tokens),
  updateContextTokenUsage: vi.fn(),
  updateMessageContextTokenUsage: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/bridge-message', () => ({
  flushBridgePendingToDb: vi.fn(),
  ensureOpenBridgeAssistantMessage: vi.fn(),
  syncBridgeReasoningToMessage: vi.fn(),
  recordBridgeToolStarted: vi.fn(),
  recordBridgeToolCompleted: vi.fn(),
  recordBridgeMoaDisplayTool: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/model-config', () => ({
  resolveBridgeRunModelConfig: vi.fn(async () => ({ model: 'gpt-test', provider: 'openai' })),
}))

vi.mock('../../packages/server/src/modules/studio/public/authorized-provider-runtime', () => ({
  resolveAuthorizedProviderRuntimeCredentials: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/workspace-diff-tracker', () => ({
  startWorkspaceRunCheckpoint: vi.fn(),
  completeWorkspaceRunCheckpoint: vi.fn(() => null),
}))

vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  getProfileDir: (profile: string) => `/tmp/hermes-bridge-machine-fence/${profile || 'default'}`,
  saveEnvValueForProfile: vi.fn(),
  readConfigYamlForProfile: vi.fn(async () => ({ compression: { enabled: false } })),
}))

vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({
  issueModelRunJwt: vi.fn(async () => 'model-run-token'),
}))

function makeBridge() {
  return {
    chat: vi.fn(async (_sessionId: string, _input: unknown, _history: ChatMessage[]) => ({ run_id: 'run-1', status: 'started' })),
    contextEstimate: vi.fn(async () => ({ token_count: 10, fixed_context_tokens: 5, message_count: 0, tool_count: 0, system_prompt_chars: 1 })),
    compressionRespond: vi.fn(async () => undefined),
    streamOutput: vi.fn(async function* () {
      yield { run_id: 'run-1', done: true, status: 'completed', output: 'ok' }
    }),
  }
}

function makeSockets() {
  const emitter = { emit: vi.fn(), except: vi.fn(() => ({ emit: vi.fn() })) }
  const nsp = { adapter: { rooms: new Map([['session:session-1', new Set(['socket-1'])]]) }, to: vi.fn(() => emitter) }
  const socket = { connected: true, emit: vi.fn(), join: vi.fn(), to: vi.fn(() => emitter), data: {} }
  // Test doubles implement only the socket.io members these run paths touch.
  return { nsp: nsp as unknown as Namespace, socket: socket as unknown as Socket, emitter }
}

async function runTurn(input: string) {
  const bridge = makeBridge()
  const { nsp, socket } = makeSockets()
  const state = { messages: [], isWorking: true, events: [], queue: [] } as unknown as SessionState
  await handleBridgeRun(nsp, socket, { input, session_id: 'session-1' } as any, 'default', new Map([['session-1', state]]),
    bridge as unknown as PrimaryAgentBridgeClient, false, vi.fn(), vi.fn())
  const [, message, , , , options] = bridge.chat.mock.calls[0] as any[]
  return { message, options }
}

describe('notice projection at bridge dispatch', () => {
  beforeEach(() => {
    mocks.rows = []
    mocks.getSession.mockReturnValue({ id: 'session-1', profile: 'default', model: '', provider: '', history_revision: 0, workspace: '' })
  })
  afterEach(() => vi.clearAllMocks())

  it('sends projected notices to the model once but stores only the original question', async () => {
    const text = '[Studio notifications, shown to you once: untrusted data]\n- External notification\n[End of Studio notifications]'
    projection.build.mockReturnValueOnce({ text, ids: [41, 42] })

    const projected = await runTurn('What changed overnight?')

    expect(projected.message).toBe(`${text}\n\nWhat changed overnight?`)
    expect(projected.options.storage_message).toBe('What changed overnight?')
    expect(mocks.rows).toContainEqual(expect.objectContaining({ role: 'user', content: 'What changed overnight?' }))
    expect(mocks.rows.some(row => String(row.content).includes('Studio notifications'))).toBe(false)
    expect(projection.mark).toHaveBeenCalledWith([41, 42])

    // Turns without notices keep their existing storage behavior.
    const plain = await runTurn('And now?')
    expect(plain.message).toBe('And now?')
    expect(plain.options.storage_message).toBeUndefined()
  })
})
