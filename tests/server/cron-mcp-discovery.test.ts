import './fixtures/isolated-studio-state'
// Cron consent and trusted admission over the Studio MCP server: migrated from the fork's cases in the removed
// hermes-web-ui-mcp suite.
import { createServer } from 'http'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import pkg from '../../package.json'

function writeRpc(child: ChildProcessWithoutNullStreams, id: number, method: string, params?: unknown) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
}

function waitForRpc(responses: Map<number, any>, id: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (responses.has(id)) {
        clearInterval(timer)
        resolve(responses.get(id))
        return
      }
      if (Date.now() - started > 5000) {
        clearInterval(timer)
        reject(new Error(`Timed out waiting for MCP response ${id}`))
      }
    }, 10)
  })
}

function expectProviderSafeToolNames(serverName: string, tools: Array<{ name: string }>) {
  const safeServerName = serverName.replace(/[^A-Za-z0-9_]/g, '_')
  const overlongNames = tools
    .map(tool => `mcp__${safeServerName}__${tool.name}`)
    .filter(name => name.length > 64)
  expect(overlongNames).toEqual([])
}


describe('migrated fork case', () => {
  let child: ChildProcessWithoutNullStreams | null = null
  const homes: string[] = []

  afterEach(() => {
    child?.kill()
    child = null
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })













  it('compact discovery of the generated catalog lists the cron consent request fields, including target_session_id', async () => {
    const openapi = readFileSync(join(process.cwd(), 'docs', 'openapi.json'), 'utf8')
    const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(openapi) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('expected TCP server address')
    const responses = new Map<number, any>()
    child = spawn(process.execPath, ['bin/ekko-studio-mcp.mjs', 'api'], {
      cwd: process.cwd(), env: { ...process.env, HERMES_WEB_UI_URL: `http://127.0.0.1:${address.port}`, AUTH_TOKEN: 'test-token', HERMES_MCP_TOOLSET: '' },
    })
    child.stdout.on('data', chunk => {
      for (const line of String(chunk).trim().split('\n')) if (line) { const message = JSON.parse(line); responses.set(message.id, message) }
    })
    writeRpc(child, 1, 'initialize', {})
    writeRpc(child, 2, 'tools/call', { name: 'ekko_studio_api_openapi_get', arguments: { tag: 'Cron Consent' } })
    const catalog = JSON.parse((await waitForRpc(responses, 2)).result.content[0].text)
    server.close()
    const operation = catalog.operations.find((item: any) => item.method === 'POST' && item.path === '/api/hermes/cron/consent-requests')
    const fields = Object.fromEntries(operation.requestBody.fields.map((field: any) => [field.name, field]))
    expect(fields.target_session_id).toMatchObject({ type: 'string', required: false })
    expect(['profile', 'context_id', 'kind'].every(name => fields[name]?.required)).toBe(true)
    expect(fields).not.toHaveProperty('session_id')
  })
})
describe('migrated fork case', () => {
  let child: ChildProcessWithoutNullStreams | null = null
  const homes: string[] = []

  afterEach(() => {
    child?.kill()
    child = null
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })













  it('compact discovery of the generated catalog lists the trusted current-session operation fields', async () => {
    const openapi = readFileSync(join(process.cwd(), 'docs', 'openapi.json'), 'utf8')
    const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(openapi) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('expected TCP server address')
    const responses = new Map<number, any>()
    child = spawn(process.execPath, ['bin/ekko-studio-mcp.mjs', 'api'], {
      cwd: process.cwd(), env: { ...process.env, HERMES_WEB_UI_URL: `http://127.0.0.1:${address.port}`, AUTH_TOKEN: 'test-token', HERMES_MCP_TOOLSET: '' },
    })
    child.stdout.on('data', chunk => {
      for (const line of String(chunk).trim().split('\n')) if (line) { const message = JSON.parse(line); responses.set(message.id, message) }
    })
    writeRpc(child, 1, 'initialize', {})
    writeRpc(child, 2, 'tools/call', { name: 'ekko_studio_api_openapi_get', arguments: { path: '/api/hermes/cron/current-session', method: 'POST' } })
    const catalog = JSON.parse((await waitForRpc(responses, 2)).result.content[0].text)
    server.close()
    const fields = Object.fromEntries(catalog.operations[0].requestBody.fields.map((field: any) => [field.name, field.required]))
    expect(fields).toMatchObject({ profile: true, kind: true, name: false, schedule: false, prompt: false, script: false, mode: false, job_id: false })
    expect(fields).not.toHaveProperty('session_id')
  })
})
describe('migrated fork case', () => {
  let child: ChildProcessWithoutNullStreams | null = null
  const homes: string[] = []

  afterEach(() => {
    child?.kill()
    child = null
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })













  it('authorizes trusted current-session Cron admission only with the per-call Studio metadata, never a profile token', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-web-ui-mcp-'))
    homes.push(home)
    mkdirSync(join(home, 'profiles', 'research'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'research', '.model-run-token'), 'profile-token\n')
    const seen: Array<{ url?: string; authorization?: string }> = []
    const server = createServer((req, res) => {
      seen.push({ url: req.url, authorization: req.headers.authorization })
      res.setHeader('content-type', 'application/json')
      res.end(req.url === '/api/openapi.json' ? '{"paths":{"/api/hermes/jobs":{"post":{"tags":["Jobs"]}}}}' : '{"status":"admitted"}')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('expected TCP server address')
    const responses = new Map<number, any>()
    child = spawn(process.execPath, ['bin/ekko-studio-mcp.mjs', 'api'], {
      cwd: process.cwd(), env: { ...process.env, HERMES_WEB_UI_URL: `http://127.0.0.1:${address.port}`, HERMES_WEB_UI_HOME: home,
        HERMES_WEB_UI_PROFILE: 'research', AUTH_TOKEN: '', HERMES_WEB_UI_TOKEN: '', HERMES_MCP_TOOLSET: '' },
    })
    child.stdout.on('data', chunk => {
      for (const line of String(chunk).trim().split('\n')) if (line) { const message = JSON.parse(line); responses.set(message.id, message) }
    })
    const admission = { method: 'POST', path: '/api/hermes/cron/current-session', body: { profile: 'research', kind: 'cron_job' } }
    const meta = { 'ekko.studio/cron-capability': 'studio_run_capability' }
    writeRpc(child, 1, 'initialize', {})
    writeRpc(child, 2, 'tools/call', { name: 'ekko_studio_api_request', arguments: admission, _meta: meta })
    const admitted = JSON.parse((await waitForRpc(responses, 2)).result.content[0].text)
    writeRpc(child, 3, 'tools/call', { name: 'ekko_studio_api_request', arguments: admission })
    const missing = JSON.parse((await waitForRpc(responses, 3)).result.content[0].text)
    writeRpc(child, 4, 'tools/call', { name: 'ekko_studio_api_request', arguments: { method: 'POST', path: '/api/hermes/jobs', body: {} }, _meta: meta })
    await waitForRpc(responses, 4)
    server.close()
    expect(admitted.status).toBe(200)
    expect(missing).toMatchObject({ status: 403, body: { error: 'trusted_capability_unavailable' } })
    const admissionCalls = seen.filter(item => item.url === '/api/hermes/cron/current-session')
    expect(admissionCalls).toEqual([{ url: '/api/hermes/cron/current-session', authorization: 'Bearer studio_run_capability' }])
    // The capability never leaves the admission path: other requests keep the ordinary profile credential.
    expect(seen.find(item => item.url === '/api/hermes/jobs')?.authorization).toBe('Bearer profile-token')
  })
})
describe('migrated fork case', () => {
  let child: ChildProcessWithoutNullStreams | null = null
  const homes: string[] = []

  afterEach(() => {
    child?.kill()
    child = null
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })













  it('default discovery routes a normal agent to trusted admission (with a cross-session target) and explains kinds; consent is the policy-off path', async () => {
    const openapi = readFileSync(join(process.cwd(), 'docs', 'openapi.json'), 'utf8')
    const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(openapi) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('expected TCP server address')
    const responses = new Map<number, any>()
    child = spawn(process.execPath, ['bin/ekko-studio-mcp.mjs', 'api'], {
      cwd: process.cwd(), env: { ...process.env, HERMES_WEB_UI_URL: `http://127.0.0.1:${address.port}`, AUTH_TOKEN: 'test-token', HERMES_MCP_TOOLSET: '' },
    })
    child.stdout.on('data', chunk => {
      for (const line of String(chunk).trim().split('\n')) if (line) { const message = JSON.parse(line); responses.set(message.id, message) }
    })
    writeRpc(child, 1, 'initialize', {})
    writeRpc(child, 2, 'tools/list', {})
    writeRpc(child, 3, 'tools/call', { name: 'ekko_studio_api_openapi_get', arguments: {} })
    writeRpc(child, 4, 'tools/call', { name: 'ekko_studio_api_openapi_get', arguments: { tag: 'Cron Consent' } })
    const tools = (await waitForRpc(responses, 2)).result.tools
    const index = JSON.parse((await waitForRpc(responses, 3)).result.content[0].text)
    const cron = JSON.parse((await waitForRpc(responses, 4)).result.content[0].text)
    server.close()
    // The request tool itself names the trusted route, the cross-session field and the policy-off fallback.
    const request = tools.find((tool: any) => tool.name === 'ekko_studio_api_request').description
    for (const text of ['/api/hermes/cron/current-session', 'target_session_id', '/api/hermes/cron/consent-requests']) expect(request).toContain(text)
    // The default module index (no filters) already carries the routing rule.
    const module = index.modules.find((item: any) => item.tag === 'Cron Consent')
    for (const text of ['current-session', 'target_session_id', 'consent-requests']) expect(module.purpose).toContain(text)
    const operation = (method: string, path: string) => cron.operations.find((item: any) => item.method === method && item.path === path)
    const fields = (op: any) => Object.fromEntries(op.requestBody.fields.map((field: any) => [field.name, field]))
    const trusted = operation('POST', '/api/hermes/cron/current-session')
    expect(trusted.usage).toContain('target_session_id')
    expect(trusted.usage).toContain('consent-requests')
    expect(fields(trusted).kind).toMatchObject({ enum: ['cron_job', 'cron_session_binding', 'script_report_enrollment'], description: expect.stringContaining('job_id') })
    expect(fields(trusted).mode).toMatchObject({ enum: ['new', 'existing'], description: expect.stringContaining('script') })
    expect(fields(trusted).target_session_id).toMatchObject({ required: false, description: expect.stringContaining('same account') })
    expect(fields(operation('POST', '/api/hermes/cron/current-session/dispatch')).target_session_id.description).toContain('same account')
    const consent = operation('POST', '/api/hermes/cron/consent-requests')
    expect(consent.usage).toContain('current-session')
    expect(fields(consent).kind.enum).toEqual(['cron_session_binding', 'script_report_enrollment'])
    // Other operations keep the compact shape: no forwarded descriptions.
    expect(operation('GET', '/api/hermes/cron/consent-requests')).not.toHaveProperty('usage')
    expect(operation('GET', '/api/hermes/cron/consent-requests')).not.toHaveProperty('description')
  })
})
