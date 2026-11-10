// @vitest-environment jsdom
// Live session notices in the chat store: migrated from the fork's case in the removed chat-store-session-command suite.
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Vite defines this at build time; the chat store's app-store import reads it on load.
vi.hoisted(() => { (globalThis as any).__APP_VERSION__ = 'test' })
import { createPinia, setActivePinia } from 'pinia'

const chatApi = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  socketEmit: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: chatApi.socketEmit })),
  resumeSession: vi.fn((sessionId: string, onResumed: (data: any) => void) => {
    onResumed({ session_id: sessionId, messages: [], isWorking: false, events: [], queueLength: 0 })
    return {} as any
  }),
  sessionCommandHandlers: [] as Array<(event: any) => void>,
  peerUserMessageHandlers: [] as Array<(event: any) => void>,
  sessionTitleUpdatedHandlers: [] as Array<(event: any) => void>,
  sessionWorkspaceUpdatedHandlers: [] as Array<(event: any) => void>,
  sessionNoticeHandlers: [] as Array<(event: any) => void>,
}))

vi.mock('@/api/studio/chat', () => ({
  onUnobservedRunStarted: vi.fn(() => vi.fn()),
  startRunViaSocket: chatApi.startRunViaSocket,
  resumeSession: chatApi.resumeSession,
  registerSessionHandlers: chatApi.registerSessionHandlers,
  unregisterSessionHandlers: chatApi.unregisterSessionHandlers,
  getChatRunSocket: chatApi.getChatRunSocket,
  respondToolApproval: vi.fn(),
  respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn((handler: (event: any) => void) => {
    chatApi.peerUserMessageHandlers.push(handler)
    return vi.fn()
  }),
  onSessionCommand: vi.fn((handler: (event: any) => void) => {
    chatApi.sessionCommandHandlers.push(handler)
    return vi.fn()
  }),
  onSessionTitleUpdated: vi.fn((handler: (event: any) => void) => {
    chatApi.sessionTitleUpdatedHandlers.push(handler)
    return vi.fn()
  }),
  onRunUsageUpdated: vi.fn(() => vi.fn()),
  onTaskPlanUpdated: vi.fn(() => vi.fn()),
  onSessionNotice: vi.fn((handler: (event: any) => void) => {
    chatApi.sessionNoticeHandlers.push(handler)
    return vi.fn()
  }),
  onSessionWorkspaceUpdated: vi.fn((handler: (event: any) => void) => {
    chatApi.sessionWorkspaceUpdatedHandlers.push(handler)
    return vi.fn()
  }),
  onSessionSettingsUpdated: vi.fn(() => vi.fn()),
}))

vi.mock('@/api/client', () => ({
  getActiveProfileName: () => 'default',
  hasApiKey: () => false,
}))

vi.mock('@/api/studio/sessions', () => ({
  deleteSessionMessages: vi.fn(),
  fetchSessionMessagesPage: vi.fn(async () => undefined),
  archiveSession: vi.fn(),
  deleteSession: vi.fn(),
  fetchSession: vi.fn(),
  fetchSessions: vi.fn(),
  fetchWorkspaceRunChangesForSession: vi.fn(async () => []),
  fetchWorkspaceRunChangeFile: vi.fn(async () => null),
  setSessionModel: vi.fn(),
}))

vi.mock('@/api/studio/download', () => ({
  getDownloadUrl: (_path: string, name: string) => `/download/${name}`,
}))

vi.mock('@/utils/completion-sound', () => ({
  primeCompletionSound: vi.fn(),
  playCompletionSound: vi.fn(),
}))

import { useChatStore, type Session } from '@/stores/hermes/chat'
import { fetchSessions, fetchSessionMessagesPage, deleteSessionMessages } from '@/api/studio/sessions'

function makeSession(): Session {
  return {
    id: 'session-1',
    title: 'session',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}


describe('migrated fork case', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    chatApi.sessionCommandHandlers = []
    chatApi.peerUserMessageHandlers = []
    chatApi.sessionTitleUpdatedHandlers = []
    chatApi.sessionNoticeHandlers = []
    chatApi.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
    setActivePinia(createPinia())
  })
























  it('inserts a live notice into a loaded empty timeline and leaves unloaded sessions to their next load', () => {
    const store = useChatStore()
    store.sessions = [{ ...makeSession(), messagesLoaded: true }, { ...makeSession(), id: 'session-2', messagesLoaded: false }]
    const notice = (sid: string) => ({ event: 'session.notice', session_id: sid, attention: false, message: {
      id: `studio-notice-${sid}`, session_id: sid, role: 'system', display_role: 'system', content: 'Review passed', timestamp: 100,
      studio_notice: { kind: 'external', notification_id: 1, source: 'validator-review', event_id: 'e1', title: 'Validation complete', url: null },
    } })
    for (const handler of chatApi.sessionNoticeHandlers) {
      handler(notice('session-1'))
      handler(notice('session-2'))
    }
    expect(store.sessions[0].messages.map(message => message.content)).toEqual(['Review passed'])
    expect(store.sessions[0].messages[0].studioNotice).toMatchObject({ kind: 'external', title: 'Validation complete' })
    expect(store.sessions[1].messages).toEqual([])
  })
})
