import type { SessionListState } from '../../../shared/session-state'
import type { TaskPlanSnapshot } from './task-plan'

export type SessionTaskIndicatorKind = 'processing' | 'waiting' | 'attention' | 'open' | 'done'

/** Avatar indicator from the server's persisted session projection; never derived from local timers. */
export function sessionTaskIndicator(task: SessionListState['task']): { kind: SessionTaskIndicatorKind; label: string } | null {
  if (!task) return null
  const kind: SessionTaskIndicatorKind = task.state === 'running' || task.state === 'verifying' ? 'processing'
    : task.state === 'waiting_user' ? 'waiting'
      : task.state === 'open' ? 'open' : task.state === 'done' ? 'done' : 'attention'
  return { kind, label: `sessionTask.${task.state}` }
}

/** Card state label: a linked card follows its lifecycle; run-only cards keep the legacy label. */
export function taskPlanStateKey(plan: TaskPlanSnapshot, allStepsCompleted: boolean): string {
  const lifecycle = plan.lifecycle
  if (!lifecycle) return allStepsCompleted ? 'taskPlan.completed' : `taskPlan.${plan.execution_state}`
  if (lifecycle.phase === 'running' || lifecycle.phase === 'starting') {
    return plan.execution_state === 'running' ? 'taskPlan.lifecycle.running' : 'taskPlan.lifecycle.in_background'
  }
  if (lifecycle.phase === 'waiting_user') return `taskPlan.lifecycle.waiting_${lifecycle.waiting_kind || 'decision'}`
  return `taskPlan.lifecycle.${lifecycle.phase}`
}

type Indicator = NonNullable<ReturnType<typeof sessionTaskIndicator>>

/**
 * Effective avatar display. Waiting for the user outranks everything; a foreground run shows the activity ring
 * and hides older badges. Background-only `working` (historical counts, e.g. a restored delegation) never hides
 * the persisted task state, so an unreconciled producer still shows attention.
 */
export function sessionAvatarDisplay(working: boolean, task: Indicator | null | undefined, foreground = working): { ring: boolean; badge: Indicator | null; state?: string } {
  if (task?.kind === 'waiting') return { ring: false, badge: task, state: 'waiting' }
  if (foreground) return { ring: true, badge: null, state: task?.kind === 'processing' ? 'processing' : 'working' }
  if (task) return { ring: false, badge: task, state: task.kind }
  return { ring: working, badge: null, state: working ? 'working' : undefined }
}
