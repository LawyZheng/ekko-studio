/** Narrow public port for runtime producer adapters (bootstrap wiring and supported launchers). */
export {
  applyTaskAction, getTaskLifecycle, markProducersUnreconciled, onTaskLifecycleChanged, taskProducers, TaskLifecycleError,
} from '../services/task-lifecycle'
export type { TaskActor, TaskLifecycleView } from '../services/task-lifecycle'
export type { TaskProducerOwner } from '../contracts/session-task'
