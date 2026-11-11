import type { TaskLifecyclePhase } from './task-plan'

export type SessionTaskStatus = 'open' | 'completed' | 'closed'

export interface TaskProducerOwner { kind: string; id: string; incarnation?: string }
interface Receipt { id: string; by: string; at: number }

/** Stored in session_tasks.lifecycle_json; the goal row stays the only outcome authority. */
export interface SessionTaskLifecycle {
  v: 1
  /** Original card, linked once; its run, creation time and anchor never move. */
  plan_id: string
  phase: TaskLifecyclePhase
  attempt: number
  /** Session incarnation that linked the goal; a reset session fences every later event. */
  session_generation: string
  owner: TaskProducerOwner | null
  delivery: (Receipt & { ref: string; digest?: string; summary: string }) | null
  verification: (Receipt & { evidence: string }) | null
  acceptance: { evidence: string; by: string; at: number } | null
  waiting: { kind: 'login' | 'consent' | 'decision'; reason: string; resume: TaskLifecyclePhase } | null
  reason: string
  /** Bounded event-id → content digest map for idempotent redelivery and conflict detection. */
  events: Record<string, string>
  updated_at: number
}

/** User goals persist across turns; they are independent of run task plans. */
export interface SessionTask {
  id: string
  title: string
  summary: string
  status: SessionTaskStatus
  source_message_id: number
  evidence_message_id: number | null
  completion_evidence: string
  created_at: number
  updated_at: number
  completed_at: number | null
}

export interface SessionTasksSnapshot {
  session_id: string
  revision: number
  updated_at: number
  tasks: SessionTask[]
}

export interface SessionTaskChange {
  id?: string
  title: string
  summary: string
  status: 'open' | 'completed'
  completion_evidence?: string
}

export interface SessionTasksUpdate {
  revision: number
  changes: SessionTaskChange[]
}

export interface SessionTaskListItem extends SessionTask {
  session_id: string
  session_title: string | null
  profile: string
  source: string
  agent: string
  /** Visible user message starting the associated request/completion turn. */
  message_id: number | null
}

export interface SessionTaskListQuery {
  profiles: string[]
  excludeSessionIds?: string[]
  search?: string
  status?: SessionTaskStatus
  order: 'newest' | 'oldest'
  offset: number
  limit: number
}

export interface SessionTaskListPage {
  tasks: SessionTaskListItem[]
  total: number
  has_more: boolean
}
