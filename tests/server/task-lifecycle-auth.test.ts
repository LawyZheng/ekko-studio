import './fixtures/isolated-studio-state'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import Koa from 'koa'
import { describe, expect, it } from 'vitest'
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { addMessage, createSession } from '../../packages/server/src/modules/studio/repositories/session-store'
import { createDefaultSuperAdmin } from '../../packages/server/src/modules/studio/repositories/users-store'
import { issueAppJwt, issueModelRunJwt, issueUserJwt, requireUserJwt, signUserJwt } from '../../packages/server/src/modules/studio/middleware/auth'
import { runMcpCredentials } from '../../packages/server/src/modules/studio/services/auth/run-mcp-credentials'
import { updateTaskLifecycle } from '../../packages/server/src/modules/studio/controllers/sessions'
import { sessionShareHttpOperation } from '../../packages/server/src/modules/studio/services/session-shares/http-access'
import { updateSessionTasks } from '../../packages/server/src/modules/studio/services/session-tasks'
import { getTaskLifecycle, linkTaskPlan } from '../../packages/server/src/modules/studio/services/task-lifecycle'

const SECRET = 'lifecycle-auth-test-secret'
process.env.AUTH_JWT_SECRET = SECRET
const app = new Koa()
/** A real Koa context through the production authentication middleware, then the PM controller. */
async function call(path: string, headers: Record<string, string>, body: Record<string, unknown>, params: Record<string, string>) {
  const req = new IncomingMessage(new Socket())
  Object.assign(req, { method: 'POST', url: path, headers: { 'content-type': 'application/json', ...headers } })
  const ctx: any = app.createContext(req, new ServerResponse(req))
  ctx.request.body = body
  await requireUserJwt(ctx, async () => { ctx.params = params; updateTaskLifecycle(ctx) })
  return { status: ctx.status, body: ctx.body }
}

describe('PM lifecycle endpoint authority', () => {
  it('accepts only an interactive login credential; model-run, pre-purpose, App, run and share credentials are refused', async () => {
    initAllHermesTables()
    const admin = createDefaultSuperAdmin() || { id: 1, username: 'admin', role: 'super_admin' as const }
    const sid = `auth-${Date.now()}`
    createSession({ id: sid, profile: 'default', source: 'cli', agent: 'hermes' })
    addMessage({ session_id: sid, role: 'user', content: 'Ship it', run_marker: 'run-a' })
    const taskId = updateSessionTasks(sid, 'default', { revision: 0, changes: [{ title: 'Ship', summary: 'Ship it.', status: 'open' }] }).tasks[0].id
    linkTaskPlan(sid, taskId, `mcp:auth-${sid}`)
    const path = `/api/studio/sessions/${sid}/tasks/${taskId}/lifecycle`
    const params = { id: sid, taskId }
    const body = { action: 'deliver', summary: 'Delivered in chat' }
    const user = { id: admin.id, username: admin.username, role: admin.role }
    const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

    const refused: Record<string, number | undefined> = {}
    refused.model_run = (await call(path, bearer(await issueModelRunJwt(user)), body, params)).status
    refused.pre_purpose = (await call(path, bearer(signUserJwt(user, SECRET)), body, params)).status
    refused.app = (await call(path, bearer(await issueAppJwt(user, 'device-1', 'local' as any)), body, params)).status
    const contextId = `ctx-${sid}`
    // A run-scoped credential (memory-only issuer; no credential file is read).
    const run = runMcpCredentials.issueCronAdmission({ sessionId: sid, contextId, profile: 'default', agentId: 'hermes', isActive: () => true,
      cron: { accountId: admin.id, generation: 'g', epoch: 'e', singleUse: false } as any })
    refused.run = (await call(path, { ...bearer(run), 'x-studio-run-context': contextId }, body, params)).status
    refused.anonymous = (await call(path, {}, body, params)).status
    expect(refused.model_run).toBe(403)
    expect([401, 403]).toContain(refused.app)
    // Credential classes that do pass authentication still never reach a PM decision.
    for (const credentialKind of ['app', 'model_api_key', 'server', 'legacy_access', 'run', 'model_run']) {
      const ctx: any = { params, query: {}, request: { body }, get: () => '', state: { user, credentialKind, profile: { name: 'default' } } }
      updateTaskLifecycle(ctx)
      expect([credentialKind, ctx.status]).toEqual([credentialKind, 403])
    }
    expect(refused.run).toBe(403)
    expect(refused.pre_purpose).toBe(403)
    expect(refused.anonymous).toBe(401)
    expect(() => sessionShareHttpOperation('POST', path, {}, body)).toThrow()
    expect(getTaskLifecycle(sid, taskId)?.phase).toBe('open')

    const login = await call(path, bearer(await issueUserJwt(user)), body, params)
    expect(login.status).toBe(200)
    expect(getTaskLifecycle(sid, taskId)).toMatchObject({ phase: 'verifying', delivery: { by: `pm:${admin.id}` } })
  })
})
