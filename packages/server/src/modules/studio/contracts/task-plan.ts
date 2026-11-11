export interface TaskPlanSnapshot {
  session_id: string
  run_id: string
  plan_id: string
  revision: number
  execution_state: 'running' | 'ended' | 'interrupted' | 'failed'
  explanation?: string
  plan: Array<{ id: string; step: string; status: 'pending' | 'in_progress' | 'completed' }>
  created_at: number
  updated_at: number
  /** Session goal this card belongs to; absent on run-only (legacy) cards. */
  task_id?: string
  /** Read-only projection of the goal's lifecycle. Never carries producer capabilities. */
  lifecycle?: TaskLifecycleProjection
}

export type TaskLifecyclePhase = 'open' | 'starting' | 'running' | 'waiting_user' | 'verifying' | 'failed' | 'lost' | 'unknown' | 'done'

export interface TaskLifecycleProjection {
  phase: TaskLifecyclePhase
  attempt: number
  revision: number
  updated_at: number
  owner_kind?: string
  delivery_id?: string
  verification_id?: string
  waiting_kind?: 'login' | 'consent' | 'decision'
  reason?: string
}
