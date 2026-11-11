import type { Context } from 'koa'
import { getChatRunServer } from '../public/chat-run'
import { TaskPlanError } from '../services/task-plan-runs'
import { SessionTasksError } from '../services/session-tasks'
import { TaskLifecycleError } from '../services/task-lifecycle'

/** MCP ekko_studio_task_lifecycle: the live turn context is the authority; the session comes from it. */
export function taskLifecycleAction(ctx: Context) {
  const body = (ctx.request.body || {}) as Record<string, unknown>
  const server = getChatRunServer()
  if (!server) {
    ctx.status = 503
    ctx.body = { ok: false, error: 'Chat run service is unavailable' }
    return
  }
  try {
    if (typeof body.context_id !== 'string' || !body.context_id.trim()) throw new TaskLifecycleError('context_id is required', 400)
    const profile = String(ctx.state.profile?.name || 'default').trim() || 'default'
    ctx.body = { ok: true, ...server.taskLifecycleAction(body.context_id, profile, body) }
  } catch (error) {
    if (!(error instanceof TaskLifecycleError) && !(error instanceof TaskPlanError) && !(error instanceof SessionTasksError)) throw error
    ctx.status = error.status
    ctx.body = { ok: false, error: error.message }
  }
}
