import { ref, reactive, onScopeDispose } from 'vue'
import { defineStore } from 'pinia'
import { connectSessionState } from '@/api/studio/session-state'
import { onAuthInvalidated } from '@/api/auth-invalidation'
import type { SessionListState, SessionStateSnapshot } from '../../../../shared/session-state'

const MARK_UNREAD_TIMEOUT_MS = 10_000

export const useSessionStateStore = defineStore('sessionState', () => {
  const sessions = ref(new Map<string, SessionListState>())
  let socket: ReturnType<typeof connectSessionState> | null = null
  let stopAuth: (() => void) | null = null
  const pendingReads = new Map<string, { messageId: number; attentionId: number; unreadRevision?: number }>()
  // The manual-unread revision the user saw when they last chose to open each conversation.
  // Passive views keep their older revision, so they cannot clear a newer manual mark.
  const opened = reactive(new Map<string, number | 'pending'>())

  function start() {
    if (socket) return
    const owner = connectSessionState()
    socket = owner
    owner.on('sessions.state.snapshot', (snapshot: SessionStateSnapshot) => {
      if (socket !== owner) return
      pendingReads.clear()
      sessions.value = new Map(snapshot.sessions.map(state => [state.sessionId, state]))
    })
    owner.on('sessions.state.updated', (state: SessionListState) => {
      if (socket !== owner) return
      sessions.value.set(state.sessionId, state)
      const pending = pendingReads.get(state.sessionId)
      if (pending && state.readMessageId >= pending.messageId && (state.readAttentionId || 0) >= pending.attentionId
        && (pending.unreadRevision == null || !state.manualUnread || state.unreadRevision !== pending.unreadRevision)) pendingReads.delete(state.sessionId)
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
    sessions.value.clear(); pendingReads.clear(); opened.clear()
  }

  /** An intentional open (e.g. selecting the conversation) may clear its current manual mark. */
  function acknowledge(sessionId: string) {
    const revision = sessions.value.get(sessionId)?.unreadRevision
    opened.set(sessionId, revision ?? 'pending')
  }

  function markRead(sessionId: string) {
    const state = sessions.value.get(sessionId)
    let openedRevision = opened.get(sessionId)
    if (openedRevision === 'pending' && state?.unreadRevision != null) opened.set(sessionId, openedRevision = state.unreadRevision)
    if (!socket?.connected || state?.working || !state?.unread) return
    const messageId = state.lastMessageId
    const attentionId = state.lastAttentionId || 0
    const clearsMark = !!state.manualUnread && openedRevision === state.unreadRevision
    if (!clearsMark && messageId <= state.readMessageId && attentionId <= (state.readAttentionId || 0)) return
    const unreadRevision = clearsMark ? state.unreadRevision : undefined
    const pending = pendingReads.get(sessionId)
    if (pending?.messageId === messageId && pending.attentionId === attentionId && pending.unreadRevision === unreadRevision) return
    const receipt = { messageId, attentionId, unreadRevision }
    pendingReads.set(sessionId, receipt)
    socket.emit('sessions.read', { sessionId, messageId, ...(state.lastAttentionId != null ? { attentionId } : {}),
      ...(unreadRevision != null ? { unreadRevision } : {}) }, (result: { ok: boolean }) => {
      if (!result?.ok && pendingReads.get(sessionId) === receipt) pendingReads.delete(sessionId)
    })
  }

  function canMarkUnread(sessionId: string) {
    const state = sessions.value.get(sessionId)
    return !!state && typeof state.unreadRevision === 'number' && !state.working && !state.unread
  }

  /** Resolves true only when the server applied the mark; stale or failed requests change nothing. */
  function markUnread(sessionId: string): Promise<boolean> {
    const owner = socket
    const state = sessions.value.get(sessionId)
    if (!owner?.connected || !state || !canMarkUnread(sessionId)) return Promise.resolve(false)
    return new Promise(resolve => owner.timeout(MARK_UNREAD_TIMEOUT_MS).emit('sessions.unread',
      { sessionId, unreadRevision: state.unreadRevision },
      (error: Error | null, result?: { ok: boolean; changed?: boolean }) => resolve(!error && socket === owner && !!result?.ok && !!result.changed)))
  }

  onScopeDispose(stop)
  return { sessions, start, stop, markRead, acknowledge, canMarkUnread, markUnread,
    isWorking: (id: string, initialActivity = false) => sessions.value.get(id)?.working ?? initialActivity,
    isUnread: (id: string, initialUnread = false) => {
      const state = sessions.value.get(id)
      return state ? !state.working && state.unread : initialUnread
    },
    backgroundCount: (id: string) => sessions.value.get(id)?.backgroundPending ?? 0 }
})
