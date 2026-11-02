import { ref, reactive, onScopeDispose } from 'vue'
import { defineStore } from 'pinia'
import { START_LOCATION, type RouteLocationNormalized, type Router } from 'vue-router'
import { connectSessionState } from '@/api/studio/session-state'
import { onAuthInvalidated } from '@/api/auth-invalidation'
import type { SessionListState, SessionStateSnapshot } from '../../../../shared/session-state'

const MARK_UNREAD_TIMEOUT_MS = 10_000
/** Identifies one manual mark: its revision within one session incarnation. */
const markToken = (state: SessionListState) => state.unreadRevision == null ? null : `${state.generation ?? ''}#${state.unreadRevision}`

export const useSessionStateStore = defineStore('sessionState', () => {
  const sessions = ref(new Map<string, SessionListState>())
  let socket: ReturnType<typeof connectSessionState> | null = null
  let stopAuth: (() => void) | null = null
  const pendingReads = new Map<string, { messageId: number; attentionId: number; token?: string }>()
  // The mark token the user saw when they last chose to open each conversation. Passive views
  // keep their older token, so they cannot clear a newer mark or one on a recreated session.
  const opened = reactive(new Map<string, string | 'pending'>())
  // An explicit selection claims the navigation it starts; finishing that navigation after a
  // slow load must not adopt a mark that arrived in the meantime.
  let claimedOpen: string | null = null
  // An open made before any state arrived refers to the first state, never to a later mark.
  const bindOpened = (state: SessionListState) => {
    const token = markToken(state)
    if (opened.get(state.sessionId) === 'pending' && token) opened.set(state.sessionId, token)
  }

  function start() {
    if (socket) return
    const owner = connectSessionState()
    socket = owner
    owner.on('sessions.state.snapshot', (snapshot: SessionStateSnapshot) => {
      if (socket !== owner) return
      pendingReads.clear()
      snapshot.sessions.forEach(bindOpened)
      sessions.value = new Map(snapshot.sessions.map(state => [state.sessionId, state]))
    })
    owner.on('sessions.state.updated', (state: SessionListState) => {
      if (socket !== owner) return
      bindOpened(state)
      sessions.value.set(state.sessionId, state)
      const pending = pendingReads.get(state.sessionId)
      if (pending && state.readMessageId >= pending.messageId && (state.readAttentionId || 0) >= pending.attentionId
        && (pending.token == null || !state.manualUnread || markToken(state) !== pending.token)) pendingReads.delete(state.sessionId)
    })
    // Do not replay buffered read receipts after a reconnect; use its fresh snapshot.
    owner.on('disconnect', () => pendingReads.clear())
    stopAuth = onAuthInvalidated(stop)
  }

  function stop() {
    const previous = socket
    socket = null
    previous?.removeAllListeners(); previous?.disconnect()
    stopAuth?.(); stopAuth = null
    sessions.value.clear(); pendingReads.clear(); opened.clear(); claimedOpen = null
  }

  function capture(sessionId: string) {
    const state = sessions.value.get(sessionId)
    opened.set(sessionId, (state && markToken(state)) ?? 'pending')
  }

  /** An intentional open (e.g. selecting the conversation) may clear its current manual mark. */
  function acknowledge(sessionId: string) {
    capture(sessionId)
    claimedOpen = sessionId
  }

  /** Router callback; `opens` is false for the initial route and automatic replacements. */
  function navigated(sessionId: string | null, opens: boolean) {
    const claimed = claimedOpen
    claimedOpen = null
    if (opens && sessionId && sessionId !== claimed) capture(sessionId)
  }

  function markRead(sessionId: string) {
    const state = sessions.value.get(sessionId)
    if (!socket?.connected || state?.working || !state?.unread) return
    const messageId = state.lastMessageId
    const attentionId = state.lastAttentionId || 0
    const token = markToken(state)
    const clearsMark = !!state.manualUnread && !!token && opened.get(sessionId) === token
    if (!clearsMark && messageId <= state.readMessageId && attentionId <= (state.readAttentionId || 0)) return
    const receipt = { messageId, attentionId, token: clearsMark ? token! : undefined }
    const pending = pendingReads.get(sessionId)
    if (pending?.messageId === messageId && pending.attentionId === attentionId && pending.token === receipt.token) return
    pendingReads.set(sessionId, receipt)
    socket.emit('sessions.read', { sessionId, messageId, ...(state.lastAttentionId != null ? { attentionId } : {}),
      ...(clearsMark ? { unreadRevision: state.unreadRevision, generation: state.generation } : {}) }, (result: { ok: boolean }) => {
      if (!result?.ok && pendingReads.get(sessionId) === receipt) pendingReads.delete(sessionId)
    })
  }

  function canMarkUnread(sessionId: string) {
    const state = sessions.value.get(sessionId)
    return !!state && typeof state.unreadRevision === 'number' && typeof state.generation === 'string' && !state.working && !state.unread
  }

  /** Resolves true only when the server applied the mark; stale or failed requests change nothing. */
  function markUnread(sessionId: string): Promise<boolean> {
    const owner = socket
    const state = sessions.value.get(sessionId)
    if (!owner?.connected || !state || !canMarkUnread(sessionId)) return Promise.resolve(false)
    return new Promise(resolve => owner.timeout(MARK_UNREAD_TIMEOUT_MS).emit('sessions.unread',
      { sessionId, unreadRevision: state.unreadRevision, generation: state.generation },
      (error: Error | null, result?: { ok: boolean; changed?: boolean }) => resolve(!error && socket === owner && !!result?.ok && !!result.changed)))
  }

  onScopeDispose(stop)
  return { sessions, start, stop, markRead, acknowledge, navigated, canMarkUnread, markUnread,
    isWorking: (id: string, initialActivity = false) => sessions.value.get(id)?.working ?? initialActivity,
    isUnread: (id: string, initialUnread = false) => {
      const state = sessions.value.get(id)
      return state ? !state.working && state.unread : initialUnread
    },
    backgroundCount: (id: string) => sessions.value.get(id)?.backgroundPending ?? 0 }
})

function routedSessionId(route: RouteLocationNormalized): string | null {
  if (route.name === 'hermes.session') return typeof route.params.sessionId === 'string' ? route.params.sessionId : null
  if (route.name === 'hermes.person') return typeof route.query.session === 'string' ? route.query.session : null
  return null
}

/**
 * In-app navigation to another conversation (sidebar, search, pending actions, links, Back/Forward)
 * opens it intentionally. The page's initial route and automatic `replace` selections stay
 * passive, so a refresh or a fallback selection cannot clear a manual unread mark.
 */
export function trackSessionOpens(router: Router) {
  let traversal = false
  // Only history traversal (Back/Forward, hash links) reaches history listeners. Its entry may
  // have been created by a replacement, so its `replaced` flag says nothing about this navigation.
  router.options.history.listen(() => { traversal = true })
  router.afterEach((to, from, failure) => {
    const historyMove = traversal
    traversal = false
    const sessionId = failure ? null : routedSessionId(to)
    const opens = from !== START_LOCATION && (historyMove || !window.history.state?.replaced)
      && sessionId !== routedSessionId(from)
    useSessionStateStore().navigated(sessionId, opens)
  })
}
