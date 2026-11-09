import './fixtures/isolated-studio-state'
// Session attribution for command-created sessions: migrated from the fork's case in the removed session-command-plan suite.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const addMessageMock = vi.fn()
const createSessionMock = vi.fn()
const getSessionMock = vi.fn()
const updateSessionStatsMock = vi.fn()
const readConfigYamlForProfileMock = vi.fn()

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  addMessage: addMessageMock,
  clearSessionMessages: vi.fn(),
  createSession: createSessionMock,
  getSession: getSessionMock,
  renameSession: vi.fn(),
  updateSessionStats: updateSessionStatsMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  readConfigYamlForProfile: readConfigYamlForProfileMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/compression', () => ({
  buildDbHistory: vi.fn(),
  estimateSnapshotAwareHistoryUsage: vi.fn(),
  forceCompressBridgeHistory: vi.fn(),
  getOrCreateSession: vi.fn((_map: Map<string, any>, sessionId: string) => _map.get(sessionId)),
  replaceState: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/usage', () => ({
  calcAndUpdateUsage: vi.fn(),
  contextTokensWithCachedOverhead: vi.fn(),
  updateMessageContextTokenUsage: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/abort', () => ({
  handleAbort: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/bridge-message', () => ({
  flushBridgePendingToDb: vi.fn(),
}))

function makeContext(state: any, commandResult: Record<string, unknown> = {
  handled: true,
  message: '[IMPORTANT: expanded plan skill prompt]',
}) {
  const namespaceEmit = vi.fn()
  const nsp = {
    to: vi.fn(() => ({ emit: namespaceEmit })),
    adapter: { rooms: new Map([['session:session-1', new Set(['socket-1'])]]) },
  }
  const socket = {
    id: 'socket-1',
    connected: true,
    join: vi.fn(),
    emit: vi.fn(),
  }
  const sessionMap = new Map([['session-1', state]])
  const runQueuedItem = vi.fn()
  const bridge = {
    command: vi.fn(async () => commandResult),
    mcpReload: vi.fn(async () => ({ ok: true, message: 'MCP servers reloaded' })),
    reloadSkills: vi.fn(async () => ({
      ok: true,
      action: 'reload-skills',
      added: [{ name: 'demo-external-skill', description: 'Demo skill' }],
      removed: [],
      unchanged: [],
      total: 1,
      commands: 1,
    })),
    status: vi.fn(async () => ({
      exists: true,
      running: false,
      current_run_id: null,
      message_count: 0,
    })),
  }
  return { bridge, namespaceEmit, nsp, runQueuedItem, sessionMap, socket }
}


describe('migrated fork case', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSessionMock.mockReturnValue({ id: 'session-1', profile: 'default', source: 'cli' })
    readConfigYamlForProfileMock.mockResolvedValue({
      moa: {
        default_preset: 'default',
        presets: {
          default: {
            reference_models: [
              { provider: 'xai-oauth', model: 'grok-4.3' },
              { provider: 'custom:fun-codex', model: 'gpt-5.5' },
            ],
            aggregator: { provider: 'glm', model: 'glm-5.2' },
          },
        },
      },
    })
  })



























  it('attributes a session it creates to the authenticated socket account; never claims an existing session', async () => {
    getSessionMock.mockReturnValueOnce(null)
    const state = { messages: [], isWorking: false, events: [], queue: [] }
    const { bridge, nsp, runQueuedItem, sessionMap, socket } = makeContext(state, { handled: true, type: 'title', message: 'Title set.' })
    ;(socket as any).data = { user: { id: 7, role: 'admin', profiles: ['default'] } }
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const run = () => handleSessionCommand('session-1', parseSessionCommand('/title Delivery target')!, {
      nsp: nsp as any, socket: socket as any, sessionMap, bridge: bridge as any, profile: 'default', runQueuedItem,
    })
    await run()
    expect(createSessionMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'session-1', source: 'cli', studio_user_id: 7 }))
    createSessionMock.mockClear()
    await run()
    expect(createSessionMock).not.toHaveBeenCalled()
  })
})
