import './fixtures/isolated-studio-state'
// Trusted Cron capability issuance: migrated from the fork's case in the removed handle-bridge-run-drive-root suite.
import type { Namespace, Socket } from 'socket.io'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleBridgeRun } from '../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run'
import type { PrimaryAgentBridgeClient } from '../../packages/server/src/modules/studio/public/chat-agent-runtime'
import type { ChatMessage } from '../../packages/server/src/modules/studio/services/context-compressor'
import type { SessionState } from '../../packages/server/src/modules/studio/services/chat-run/types'

const mocks = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  getSession: vi.fn(),
  createSession: vi.fn(),
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
  createSession: mocks.createSession,
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
  getProfileDir: (profile: string) => `/tmp/hermes-bridge-drive-root/${profile || 'default'}`,
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

describe('migrated fork case', () => {
  afterEach(() => vi.clearAllMocks())

  it('is issued for a fresh chat only after the session is persisted, right before Bridge dispatch, never for an autonomous turn', async () => {
    let persisted = false
    const row = { id: 'fresh-1', profile: 'default', model: '', provider: '', history_revision: 0, workspace: '' }
    mocks.getSession.mockImplementation(() => (persisted ? row : undefined))
    mocks.createSession.mockImplementation(() => { persisted = true })
    const issue = vi.fn(() => (persisted ? 'studio_run_turn' : undefined))
    const run = async (extra: Record<string, unknown>) => {
      const bridge = makeBridge()
      const { nsp, socket } = makeSockets()
      await handleBridgeRun(nsp, socket, { session_id: 'fresh-1', input: 'remind me daily', studio_cron_issue: issue, ...extra }, 'default',
        new Map([['fresh-1', { messages: [], isWorking: false, events: [], queue: [] } as SessionState]]),
        bridge as unknown as PrimaryAgentBridgeClient, false, vi.fn(), vi.fn())
      return bridge.chat.mock.calls[0]?.[5] as Record<string, unknown> | undefined
    }
    expect((await run({}))?.studio_cron_capability).toBe('studio_run_turn')
    expect(issue).toHaveBeenCalledTimes(1)
    expect(issue.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.createSession.mock.invocationCallOrder[0])
    expect((await run({ autonomous: true }))?.studio_cron_capability).toBeUndefined()
    expect(issue).toHaveBeenCalledTimes(1)
  })
})
