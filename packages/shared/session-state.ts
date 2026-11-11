/** Account-specific read cursor and live execution state, independent of open tabs. */
export interface SessionListState {
  sessionId: string
  profile?: string
  working: boolean
  /** A foreground run (or queued turn) is active; `working` additionally counts background work. */
  foreground?: boolean
  backgroundPending: number
  lastMessageId: number
  readMessageId: number
  lastAttentionId?: number
  readAttentionId?: number
  /** This account marked the conversation unread by hand. */
  manualUnread?: boolean
  /** Revision of the latest manual mark; a read must name it to clear the mark. */
  unreadRevision?: number
  /** Session incarnation; manual unread requests must name the one they observed. */
  generation?: string
  /** Completed content or a manual mark awaiting a read receipt; false while working. */
  unread: boolean
  /**
   * Durable task lifecycle summary over all linked goals of the session (same persisted projection as the
   * task cards). Separate from `working`, which only describes the foreground run.
   */
  task?: { state: SessionTaskActivity; count: number }
}

export type SessionTaskActivity = 'waiting_user' | 'running' | 'verifying' | 'failed' | 'lost' | 'unknown' | 'open' | 'done'

export interface SessionStateSnapshot { sessions: SessionListState[] }
