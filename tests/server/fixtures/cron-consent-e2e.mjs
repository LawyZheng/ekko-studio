#!/usr/bin/env node
// Real end-to-end proof of model-initiated cron result delivery through in-app consent.
//
// In disposable homes only: a recording fake model, the built Studio server, the read-only Hermes
// checkout's own CLI and native scheduler (a foreground `hermes gateway run` ticker plus `hermes cron
// tick`), the real `bin/ekko-studio-mcp.mjs` reading its ordinary runtime credential, and a real
// browser clicking the shipped consent card.
//
// Part 1 (script-only jobs) must make ZERO model requests from setup through the delivered notices:
// the chat is created by `/title`, the setup context is opened from the chat menu, the MCP request is
// made by the harness acting as an MCP client. Part 2 (agent jobs) uses a deterministic local model:
// the model creates the job with native `cronjob_manage` and asks for consent through its MCP tool.
//
//   npm run build && HERMES_AGENT_ROOT=<read-only hermes checkout> E2E_CHROMIUM=<chromium binary> \
//     [E2E_EXTRA_PYTHONPATH=<disposable dir with the `mcp` SDK if the checkout venv lacks it>] \
//     node tests/server/fixtures/cron-consent-e2e.mjs
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { io } from 'socket.io-client'
import { chromium } from '@playwright/test'

const repo = resolve(new URL('../../..', import.meta.url).pathname)
const agentRoot = process.env.HERMES_AGENT_ROOT
if (!agentRoot) throw new Error('HERMES_AGENT_ROOT is required')
const venv = existsSync(join(agentRoot, '.venv', 'bin', 'hermes')) ? '.venv' : 'venv'
const python = join(agentRoot, venv, 'bin', 'python')
const hermesBin = join(agentRoot, venv, 'bin', 'hermes')
const evidenceDir = process.env.E2E_EVIDENCE_DIR || ''
const root = mkdtempSync(join(process.env.E2E_TMP_ROOT || tmpdir(), 'ecc-'))
const dirs = Object.fromEntries(['home', 'hermes', 'studio', 'tmp', 'pyc', 'logs', 'uploads', 'bin', 'shots'].map(name => [name, join(root, name)]))
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
symlinkSync(hermesBin, join(dirs.bin, 'hermes'))
const isolatedPath = [dirs.bin, dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':')
const SECRET = 'ghp_SYNTHETICSECRET0123456789abcdefABCD'
const CRON_ANSWER = 'CRON_CONSENT_EXACT_ANSWER_7: agent brief delivered.'

const results = []
const children = []
const record = (name, ok, detail = {}) => {
  results.push({ name, ok, ...detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${Object.keys(detail).length ? ' ' + JSON.stringify(detail).slice(0, 700) : ''}`)
}

// --- recording fake model (started before anything else) ---------------------------------------
const modelRequests = []
const modelLog = createWriteStream(join(dirs.logs, 'model.jsonl'))
let toolCallSeq = 0
const textOf = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(part => (typeof part === 'string' ? part : part?.text || '')).join('\n') : ''
function decide(body) {
  const messages = body.messages || []
  const all = messages.map(m => textOf(m.content)).join('\n')
  const lastUser = [...messages].reverse().find(m => m.role === 'user')
  const userText = textOf(lastUser?.content)
  const offered = (body.tools || []).map(t => t.function?.name).filter(Boolean)
  const call = (name, args) => (offered.includes(name) || !offered.includes('tool_call')
    ? { tool: { id: `call_${++toolCallSeq}`, name, args } }
    : { tool: { id: `call_${++toolCallSeq}`, name: 'tool_call', args: { calls: [{ name, arguments: args }] } } })
  if (userText.includes('E2E_CRON_PROMPT')) return { text: CRON_ANSWER }
  if (!offered.length) return { text: 'OK' }
  if (!userText.includes('E2E_CONSENT_AGENT')) return { text: 'OK' }
  // The agent consent journey, following Hermes' real deferred-tool protocol: discover tools with
  // tool_search, then invoke the exact returned names through tool_call. Create the job (native
  // cronjob_manage when Hermes offers it in this context, else Studio's jobs API through the MCP
  // tool), try the direct binding (expected 403), request consent with the live turn context, reply.
  const turnStart = messages.lastIndexOf(lastUser)
  const toolResults = messages.slice(turnStart + 1).filter(m => m.role === 'tool').map(m => textOf(m.content))
  const contextId = [...all.matchAll(/Current turn context_id="([^"]+)"/g)].map(match => match[1]).pop()
  const session = /E2E_CONSENT_AGENT session=(\S+)/.exec(userText)?.[1]
  if (toolResults.length === 0) return call('tool_search', { queries: ['cronjob_manage', 'ekko_studio_api_request'] })
  let search = {}
  try { search = JSON.parse(toolResults[0]) } catch {}
  const found = (search.results || []).flatMap(group => group.matches || [])
  const apiTool = found.find(name => /^mcp__.*__ekko_studio_api_request$/.test(name))
  const cronTool = found.find(name => name === 'cronjob_manage')
  if (!apiTool) return { text: `E2E_NO_API_TOOL ${JSON.stringify(found)}` }
  const created = toolResults.slice(1).map(text => /\\?"(?:job_id|id)\\?"\s*:\s*\\?"([0-9a-f]{12})\\?"/.exec(text)?.[1]).find(Boolean)
  const step = toolResults.length
  if (step === 1) {
    return cronTool
      ? call(cronTool, { action: 'create', name: 'e2e-agent-new', prompt: 'E2E_CRON_PROMPT new job', schedule: 'every 1m' })
      : call(apiTool, { method: 'POST', path: '/api/hermes/jobs',
        body: { name: 'e2e-agent-new', schedule: 'every 1m', prompt: 'E2E_CRON_PROMPT new job', deliver: 'local' } })
  }
  if (step === 2 && !created) {
    // Native create refused in this context: fall back to the jobs API once.
    return call(apiTool, { method: 'POST', path: '/api/hermes/jobs',
      body: { name: 'e2e-agent-new', schedule: 'every 1m', prompt: 'E2E_CRON_PROMPT new job', deliver: 'local' } })
  }
  const bindResult = toolResults.findIndex(text => text.includes('login_token_required'))
  if (bindResult < 0) {
    return call(apiTool, { method: 'POST', path: '/api/hermes/cron/session-bindings',
      body: { profile: 'default', session_id: session, expected_session_generation: 'unknown', job_id: created } })
  }
  if (bindResult === toolResults.length - 1) {
    return call(apiTool, { method: 'POST', path: '/api/hermes/cron/consent-requests',
      body: { profile: 'default', context_id: contextId, kind: 'cron_session_binding', job_id: created } })
  }
  return { text: 'CONSENT_REQUESTED' }
}
function respond(res, body, decision) {
  const id = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const message = decision.tool
    ? { role: 'assistant', content: null, tool_calls: [{ id: decision.tool.id, type: 'function', function: { name: decision.tool.name, arguments: JSON.stringify(decision.tool.args) } }] }
    : { role: 'assistant', content: decision.text }
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id, object: 'chat.completion', created, model: body.model || 'fake-model',
      choices: [{ index: 0, message, finish_reason: decision.tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const base = { id, object: 'chat.completion.chunk', created, model: body.model || 'fake-model' }
  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`)
  if (decision.tool) {
    send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, ...message.tool_calls[0] }] }, finish_reason: null }] })
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
  } else {
    send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: decision.text }, finish_reason: null }] })
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
  }
  res.write('data: [DONE]\n\n')
  res.end()
}
const modelServer = createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model', context_length: 128000 }] }))
      return
    }
    let body = {}
    try { body = JSON.parse(raw || '{}') } catch {}
    const decision = decide(body)
    modelRequests.push({ at: Date.now(), messages: body.messages || [], decision })
    modelLog.write(`${JSON.stringify({ at: Date.now(), url: req.url, tools: (body.tools || []).map(t => t.function?.name).slice(0, 120), last: body.messages?.slice(-2), decision })}\n`)
    respond(res, body, decision)
  })
})

// --- processes ---------------------------------------------------------------------------------
function baseEnv(extra = {}) {
  return {
    PATH: isolatedPath, HOME: dirs.home, TMPDIR: dirs.tmp, HERMES_HOME: dirs.hermes,
    HERMES_DISABLE_LAZY_INSTALLS: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONPYCACHEPREFIX: dirs.pyc,
    PYTHONPATH: [agentRoot, process.env.E2E_EXTRA_PYTHONPATH].filter(Boolean).join(':'),
    ...extra,
  }
}
function startChild(name, command, args, env) {
  const log = createWriteStream(join(dirs.logs, `${name}.log`))
  const child = spawn(command, args, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  child.stdout.pipe(log)
  child.stderr.pipe(log)
  children.push({ name, child })
  return child
}
async function stopChild({ child }) {
  if (child.exitCode !== null || child.signalCode) return
  try { process.kill(-child.pid, 'SIGTERM') } catch {}
  for (let i = 0; i < 50 && child.exitCode === null && !child.signalCode; i++) await delay(100)
  if (child.exitCode === null && !child.signalCode) { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
  for (let i = 0; i < 30 && child.exitCode === null && !child.signalCode; i++) await delay(100)
}
function hermes(...args) {
  const result = spawnSync(join(dirs.bin, 'hermes'), args, { cwd: dirs.home, env: baseEnv(), encoding: 'utf8', timeout: 180_000 })
  writeFileSync(join(dirs.logs, 'hermes-cli.log'), `$ hermes ${args.join(' ')}\n[exit ${result.status}]\n${result.stdout}\n${result.stderr}\n`, { flag: 'a' })
  return result
}
const createdJobId = result => /Created job: (\S+)/.exec(String(result.stdout).replace(/\u001b\[[0-9;]*m/g, ''))?.[1] || null

let port = 0
let token = ''
async function api(path, init = {}, auth = token) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init, headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(init.headers || {}) },
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, json, text }
}
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await delay(500)
  }
  throw new Error(`timeout: ${label}`)
}
function rows(file, sql, ...params) {
  if (!existsSync(file)) return []
  const db = new DatabaseSync(file, { readOnly: true })
  try { return db.prepare(sql).all(...params) } catch { return [] } finally { db.close() }
}
const studioRows = (sql, ...params) => rows(join(dirs.studio, 'hermes-web-ui.db'), sql, ...params)
const hermesRows = (sql, ...params) => rows(join(dirs.hermes, 'cron', 'executions.db'), sql, ...params)
const cronBindings = () => rows(join(dirs.studio, 'session-notifications', 'cron-bindings.db'), 'SELECT * FROM cron_session_bindings')
function jobs() {
  const file = join(dirs.hermes, 'cron', 'jobs.json')
  if (!existsSync(file)) return []
  const parsed = JSON.parse(readFileSync(file, 'utf-8'))
  return Array.isArray(parsed) ? parsed : parsed.jobs || []
}
function walk(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)])
}
const runtimeTokenFile = () => join(dirs.studio, 'profiles', 'default', '.model-run-token')
/** The verified purpose of the ordinary runtime credential; the token bytes are never logged. */
function runtimePurpose() {
  if (!existsSync(runtimeTokenFile())) return null
  try { return JSON.parse(Buffer.from(readFileSync(runtimeTokenFile(), 'utf8').trim().split('.')[1], 'base64url').toString()).purpose } catch { return 'unreadable' }
}

// --- the real MCP server, driven as an MCP client over stdio -----------------------------------
function startMcp() {
  const child = spawn(process.execPath, [join(repo, 'bin', 'ekko-studio-mcp.mjs'), 'api'], {
    cwd: dirs.home, stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: isolatedPath, HOME: dirs.home, TMPDIR: dirs.tmp, HERMES_WEB_UI_URL: `http://127.0.0.1:${port}`, HERMES_WEB_UI_HOME: dirs.studio,
      HERMES_WEBUI_STATE_DIR: dirs.studio, HERMES_WEB_UI_PROFILE: 'default', HERMES_MCP_SERVER_NAME: 'ekko-studio-api', HERMES_MCP_TOOLSET: 'api' },
  })
  children.push({ name: 'mcp-client', child })
  child.stderr.pipe(createWriteStream(join(dirs.logs, 'mcp-client.log')))
  const pending = new Map()
  createInterface({ input: child.stdout }).on('line', line => {
    let message
    try { message = JSON.parse(line) } catch { return }
    pending.get(message.id)?.(message)
    pending.delete(message.id)
  })
  let id = 0
  const rpc = (method, params) => new Promise((done, fail) => {
    const current = ++id
    const timer = setTimeout(() => fail(new Error(`mcp timeout ${method}`)), 60_000)
    pending.set(current, message => { clearTimeout(timer); done(message) })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: current, method, params })}\n`)
  })
  return {
    async init() { await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } }) },
    /** `ekko_studio_api_request` → the HTTP envelope (status, body) the issuer received. */
    async request(method, path, body) {
      const reply = await rpc('tools/call', { name: 'ekko_studio_api_request', arguments: { method, path, ...(body ? { body } : {}) } })
      const text = reply.result?.content?.[0]?.text || ''
      try { return JSON.parse(text) } catch { return { status: 0, body: text } }
    },
  }
}

// --- browser: the user's actual clicks on the shipped card -------------------------------------
async function openBrowser() {
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM || undefined, headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  await page.goto(`http://127.0.0.1:${port}/`)
  await page.getByPlaceholder('Username').fill('admin')
  await page.getByPlaceholder('Password').fill('123456')
  await page.getByRole('button', { name: 'Login' }).click()
  await page.waitForURL(/#\/hermes\/chat/, { timeout: 60_000 })
  return { browser, page }
}
/** First-run dialogs (setup prompts, notices) are not part of the journey; close them. */
async function dismissOverlays(page) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const mask = page.locator('.n-modal-mask')
    if (!(await mask.count()) || !(await mask.first().isVisible().catch(() => false))) return
    if (attempt === 0) await page.screenshot({ path: join(dirs.shots, `overlay-${Date.now()}.png`) })
    const decline = page.locator('.n-modal-container button').filter({ hasText: /^(Not now|Later|Skip|Cancel|Close)$/ })
    const actions = page.locator('.n-modal-container .n-dialog__action button, .n-modal-container .n-card__action button, .n-modal-container .n-card__footer button, .n-modal-container .n-base-close')
    if (await decline.count()) await decline.last().click({ timeout: 5000 }).catch(() => {})
    else if (attempt < 3) await page.keyboard.press('Escape')
    else if (await actions.count()) await actions.last().click({ timeout: 5000 }).catch(() => {})
    await delay(700)
  }
}
async function openSession(page, sessionId) {
  const url = `http://127.0.0.1:${port}/#/hermes/session/${sessionId}?profile=default`
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.goto(url)
    await page.waitForURL(new RegExp(`/hermes/session/${sessionId}`), { timeout: 60_000 })
    await page.getByRole('button', { name: 'Session actions' }).waitFor({ timeout: 60_000 })
    await delay(500)
    await dismissOverlays(page)
    // A dialog's only action may navigate away (e.g. to settings); come back once it is acknowledged.
    if (page.url().includes(`/hermes/session/${sessionId}`) && !(await page.locator('.n-modal-mask').first().isVisible().catch(() => false))) return
  }
  throw new Error(`could not open session ${sessionId} without a blocking dialog`)
}
async function prepareInUi(page, sessionId) {
  await openSession(page, sessionId)
  await page.getByRole('button', { name: 'Session actions' }).click()
  const prepared = page.waitForResponse(response => response.url().includes('/api/hermes/cron/consent-contexts')
    && response.request().method() === 'POST', { timeout: 30_000 })
  await page.getByText('Allow MCP scheduled-result setup').click()
  const response = await prepared
  if (response.status() !== 201) throw new Error(`setup context refused: ${response.status()} ${await response.text()}`)
  const contextId = (await response.json()).context_id
  // The card shows exactly the context the server just issued.
  await page.getByTestId('cron-consent-context').filter({ hasText: contextId }).waitFor({ timeout: 30_000 })
  return contextId
}
async function decideInUi(page, sessionId, name, decision, shot) {
  await openSession(page, sessionId)
  const request = page.getByTestId('cron-consent-request').filter({ hasText: name })
  await request.waitFor({ timeout: 30_000 })
  if (shot) await page.screenshot({ path: join(dirs.shots, `${shot}.png`) })
  await request.getByTestId(decision === 'approve' ? 'cron-consent-approve' : 'cron-consent-deny').click()
  const outcome = page.getByTestId('cron-consent-outcome').filter({ hasText: name })
  await outcome.waitFor({ timeout: 120_000 })
  return (await outcome.textContent()).trim()
}

async function main() {
  // The inference recorder starts before any setup; part 1 must keep it at zero.
  await new Promise(done => modelServer.listen(0, '127.0.0.1', done))
  const freePort = async () => {
    const probe = createServer()
    await new Promise(done => probe.listen(0, '127.0.0.1', done))
    const value = probe.address().port
    await new Promise(done => probe.close(done))
    return value
  }
  port = await freePort()
  const bridgePort = await freePort()
  const mcpEnv = toolset => ({ HERMES_WEB_UI_URL: `http://127.0.0.1:${port}`, HERMES_WEB_UI_HOME: dirs.studio, HERMES_WEBUI_STATE_DIR: dirs.studio,
    HERMES_WEB_UI_PROFILE: 'default', HERMES_MCP_SERVER_NAME: `ekko-studio-${toolset === 'plan' ? 'interaction' : toolset}`, HERMES_MCP_TOOLSET: toolset,
    HERMES_MCP_USER_CLARIFICATION: '0', HERMES_WEB_UI_MANAGED_MCP: '1' })
  const mcpServer = toolset => [
    `  ekko-studio-${toolset === 'plan' ? 'interaction' : toolset}:`, `    command: ${JSON.stringify(process.execPath)}`,
    `    args: [${JSON.stringify(join(repo, 'bin', 'ekko-studio-mcp.mjs'))}, ${JSON.stringify(toolset)}]`, '    enabled: true', '    env:',
    ...Object.entries(mcpEnv(toolset)).map(([key, value]) => `      ${key}: ${JSON.stringify(value)}`),
  ]
  // Written explicitly by the harness (Studio's autoinjection is disabled for this run).
  writeFileSync(join(dirs.hermes, 'config.yaml'), ['model:', '  default: fake-model', '  provider: custom',
    `  base_url: http://127.0.0.1:${modelServer.address().port}/v1`, '  api_key: fake-local-key', '  context_length: 128000',
    'compression:', '  enabled: false', 'cron:', '  script_timeout_seconds: 30', 'mcp_servers:', ...mcpServer('api'), ...mcpServer('plan'), ''].join('\n'))
  const scripts = join(dirs.hermes, 'scripts', 'reports')
  mkdirSync(scripts, { recursive: true })
  writeFileSync(join(scripts, 'digest.py'), 'print("CONSENT_DIGEST ready")\n')
  writeFileSync(join(scripts, 'quiet.py'), 'print("checked")\nprint(\'{"wakeAgent": false}\')\n')
  writeFileSync(join(scripts, 'broken.sh'), `echo "token=${SECRET}" >&2\necho "partial"\nexit 4\n`)
  writeFileSync(join(scripts, 'legacy.py'), 'print("LEGACY_ADOPTED report")\n')
  writeFileSync(join(scripts, 'denied.py'), 'open("denied.ran", "w").write("ran")\n')
  writeFileSync(join(scripts, 'restart.sh'), 'hermes gateway restart\n')

  const sdk = spawnSync(python, ['-c', 'from tools.mcp_tool_common import _core; print(_core._ensure_mcp_sdk())'], { cwd: dirs.home, env: baseEnv(), encoding: 'utf8' })
  // Hermes registers MCP tools only when the optional `mcp` SDK imports; a checkout environment
  // without it can be completed with E2E_EXTRA_PYTHONPATH (a disposable directory, never the venv).
  record('isolated Hermes runtime provides the MCP SDK (MCP tools can register)', String(sdk.stdout).trim() === 'True',
    { python, sdk: String(sdk.stdout).trim(), stderr: String(sdk.stderr).slice(-300) })
  startChild('gateway', join(dirs.bin, 'hermes'), ['gateway', 'run'], baseEnv())
  if (!existsSync(join(repo, 'dist', 'server', 'index.js'))) throw new Error('run `npm run build` first')
  const studio = startChild('studio', process.execPath, ['--no-warnings', 'dist/server/index.js'], baseEnv({
    NODE_ENV: 'production', PORT: String(port), BIND_HOST: '127.0.0.1', HERMES_WEB_UI_HOME: dirs.studio, HERMES_WEBUI_STATE_DIR: dirs.studio,
    UPLOAD_DIR: dirs.uploads, HERMES_AGENT_ROOT: agentRoot, HERMES_BIN: join(dirs.bin, 'hermes'), HERMES_AGENT_BRIDGE_PYTHON: python,
    HERMES_AGENT_BRIDGE_ENDPOINT: `tcp://127.0.0.1:${bridgePort}`, HERMES_AGENT_BRIDGE_WORKER_TRANSPORT: 'tcp',
    HERMES_AGENT_BRIDGE_WORKER_PORT_BASE: String(30000 + Math.floor(Math.random() * 8000)),
    HERMES_WEB_UI_DISABLE_GATEWAY_AUTOSTART: '1', HERMES_WEB_UI_MANAGED_GATEWAY: '0', HERMES_WEB_UI_DISABLE_MCP_AUTOINJECT: '1',
  }))
  await waitFor(async () => {
    if (studio.exitCode !== null) throw new Error('Studio exited during startup')
    try { return (await fetch(`http://127.0.0.1:${port}/api/auth/status`)).ok } catch { return false }
  }, 240_000, 'studio start')
  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: '123456' }) })
  token = login.json?.token
  if (!token) throw new Error(`login failed: ${login.text.slice(0, 200)}`)
  mkdirSync(join(dirs.hermes, 'profiles', 'other'), { recursive: true })
  writeFileSync(join(dirs.hermes, 'profiles', 'other', 'config.yaml'), 'model:\n  default: fake-model\n')
  await api('/api/auth/users', { method: 'POST', body: JSON.stringify({ username: 'bob', password: 'bob-synthetic-pass', role: 'admin', profiles: ['other'], defaultProfile: 'other' }) })
  const bobToken = (await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'bob', password: 'bob-synthetic-pass' }) }, '')).json?.token
  if (!bobToken) throw new Error('second user setup failed')

  const { browser, page } = await openBrowser()
  try {
    await part1(page, bobToken)
    await part2(page, bobToken)
  } catch (error) {
    await page.screenshot({ path: join(dirs.shots, 'failure.png') }).catch(() => {})
    throw error
  } finally {
    await browser.close()
  }
}

/** Script-only jobs: zero inference from setup through delivered notices. */
async function part1(page, bobToken) {
  // A chat created by the `/title` command: no model turn.
  const N = `ecc-n-${randomUUID().slice(0, 8)}`
  const socket = io(`http://127.0.0.1:${port}/chat-run`, { auth: { token }, query: { profile: 'default' }, transports: ['websocket'], reconnection: false })
  const events = []
  socket.onAny((event, payload) => events.push({ event, payload }))
  await waitFor(() => socket.connected, 20_000, 'socket')
  socket.emit('run', { session_id: N, input: '/title Script reports', profile: 'default' })
  await waitFor(async () => (await api(`/api/studio/sessions/${N}?profile=default`)).json?.session?.session_generation, 30_000, 'model-free session')
  socket.emit('resume', { session_id: N, profile: 'default' })
  record('setup: chat created without any model request', modelRequests.length === 0, { model_requests: modelRequests.length })
  const legacyId = createdJobId(hermes('cron', 'create', '--name', 'e2e-legacy', '--deliver', 'local', '--no-agent', '--script', 'reports/legacy.py', 'every 1m'))
  // An existing job whose script is edited into a gateway lifecycle command after creation (native
  // edits never re-run Hermes' create-time guard): adoption must be refused by that guard.
  const scripts = join(dirs.hermes, 'scripts', 'reports')
  writeFileSync(join(scripts, 'unsafe.sh'), 'echo ok\n')
  const unsafeId = createdJobId(hermes('cron', 'create', '--name', 'e2e-unsafe', '--deliver', 'local', '--no-agent', '--script', 'reports/unsafe.sh', 'every 1h'))
  writeFileSync(join(scripts, 'unsafe.sh'), 'hermes gateway restart\n')
  // Configuration only: the existing native jobs keep running (and updating run bookkeeping) meanwhile.
  const jobConfig = () => JSON.stringify(jobs().map(job => ({ id: job.id, name: job.name, script: job.script, enabled: job.enabled, schedule: job.schedule_display })))
  const jobsBefore = jobConfig()
  const existingIds = new Set(jobs().map(job => job.id))

  const mcp = startMcp()
  await mcp.init()
  const enrollments = {}
  const prepareAndRequest = async (label, operation) => {
    const contextId = await prepareInUi(page, N)
    const response = await mcp.request('POST', '/api/hermes/cron/consent-requests', { profile: 'default', context_id: contextId, ...operation })
    enrollments[label] = { contextId, response }
    return response
  }
  // Direct endpoints refuse the ordinary runtime credential the MCP process presents.
  await prepareInUi(page, N)
  const purpose = runtimePurpose()
  const direct = await mcp.request('POST', '/api/hermes/script-reports/enrollments', { profile: 'default', session_id: N,
    expected_session_generation: 'x', name: 'direct', schedule: 'every 1m', script: 'reports/digest.py' })
  record('MCP runtime credential: purpose model_run; direct enrollment 403 login_token_required', purpose === 'model_run'
    && direct.status === 403 && direct.body?.error === 'login_token_required',
    { endpoint: 'POST /api/hermes/script-reports/enrollments', status: direct.status, error: direct.body?.error, purpose })
  for (const [label, auth] of [['no credential', ''], ['bogus bearer', 'not-a-token']]) {
    const asked = await api('/api/hermes/cron/consent-requests', { method: 'POST', body: JSON.stringify({ profile: 'default', context_id: randomUUID(), kind: 'cron_session_binding', job_id: 'x' }) }, auth)
    const listed = await api(`/api/hermes/cron/consent-requests?profile=default&session_id=${N}`, {}, auth)
    record(`consent endpoints refuse ${label}`, asked.status === 401 && listed.status === 401, { request: asked.status, list: listed.status })
  }
  const invented = await mcp.request('POST', '/api/hermes/cron/consent-requests', { profile: 'default', context_id: randomUUID(), kind: 'script_report_enrollment', name: 'x', schedule: 'every 1m', script: 'reports/digest.py' })
  record('invented context refused', invented.status === 409 && invented.body?.error === 'context_unavailable', { status: invented.status, error: invented.body?.error })

  const digest = await prepareAndRequest('digest', { kind: 'script_report_enrollment', mode: 'new', name: 'e2e-digest', schedule: 'every 1m', script: 'reports/digest.py' })
  const override = await mcp.request('POST', '/api/hermes/cron/consent-requests', { profile: 'default', context_id: await prepareInUi(page, N), session_id: 'other', kind: 'script_report_enrollment', name: 'x', schedule: 'every 1m', script: 'reports/digest.py' })
  record('destination override refused', override.status === 400 && override.body?.error === 'destination_override_refused', { status: override.status })
  const quiet = await prepareAndRequest('quiet', { kind: 'script_report_enrollment', mode: 'new', name: 'e2e-quiet', schedule: 'every 1m', script: 'reports/quiet.py' })
  const broken = await prepareAndRequest('broken', { kind: 'script_report_enrollment', mode: 'new', name: 'e2e-broken', schedule: 'every 1m', script: 'reports/broken.sh' })
  const legacy = await prepareAndRequest('legacy', { kind: 'script_report_enrollment', mode: 'existing', job_id: legacyId })
  const denied = await prepareAndRequest('denied', { kind: 'script_report_enrollment', mode: 'new', name: 'e2e-denied', schedule: 'every 1m', script: 'reports/denied.py' })
  const overCapacity = await prepareAndRequest('capacity', { kind: 'script_report_enrollment', mode: 'new', name: 'e2e-sixth', schedule: 'every 1m', script: 'reports/digest.py' })
  record('MCP consent requests accepted as pending (202) for new and existing script jobs',
    [digest, quiet, broken, legacy, denied].every(item => item.status === 202 && item.body?.status === 'pending_user_consent' && item.body?.session_id === N),
    { statuses: [digest, quiet, broken, legacy, denied].map(item => `${item.status}:${item.body?.error || item.body?.status}`) })
  record('a sixth pending request in one session is refused (capacity)', overCapacity.status === 429 && overCapacity.body?.error === 'consent_capacity')
  record('before consent: no job, binding, wrapper or run', jobConfig() === jobsBefore
    && studioRows('SELECT * FROM script_report_bindings').length === 0 && !existsSync(join(dirs.hermes, 'scripts', 'ekko-script-reports'))
    && hermesRows('SELECT job_id FROM executions').every(row => existingIds.has(row.job_id)))
  // Another account cannot see or decide them.
  const bobList = await api(`/api/hermes/cron/consent-requests?profile=default&session_id=${N}`, {}, bobToken)
  const bobApprove = await api(`/api/hermes/cron/consent-requests/${digest.body.request_id}/approve`, { method: 'POST', body: JSON.stringify({ profile: 'default' }) }, bobToken)
  // A disjoint-profile account is refused by the profile gate (403) or sees nothing (same-profile case: unit tests).
  record('other account cannot list or approve', (bobList.status === 403 || bobList.json?.requests?.length === 0) && [403, 404].includes(bobApprove.status),
    { list: bobList.status, approve: bobApprove.status })
  const runtimeApprove = await mcp.request('POST', `/api/hermes/cron/consent-requests/${digest.body.request_id}/approve`, { profile: 'default' })
  record('runtime credential cannot approve its own request', runtimeApprove.status === 403 && runtimeApprove.body?.error === 'login_token_required',
    { status: runtimeApprove.status })

  // The user's clicks.
  const outcomes = {}
  outcomes.digest = await decideInUi(page, N, 'e2e-digest', 'approve', 'script-card')
  // A decision frees capacity: the lifecycle-guard case is requested now.
  const restart = await prepareAndRequest('restart', { kind: 'script_report_enrollment', mode: 'new', name: 'e2e-restart', schedule: 'every 1m', script: 'reports/restart.sh' })
  record('request accepted again after a decision freed capacity', restart.status === 202, { status: restart.status })
  outcomes.quiet = await decideInUi(page, N, 'e2e-quiet', 'approve')
  const unsafe = await prepareAndRequest('unsafe', { kind: 'script_report_enrollment', mode: 'existing', job_id: unsafeId })
  outcomes.unsafe = await decideInUi(page, N, 'e2e-unsafe', 'approve')
  const unsafeJob = jobs().find(job => job.id === unsafeId)
  record('existing job: the real native lifecycle guard refuses adoption; the job is untouched', unsafe.status === 202
    && /native_guard_rejected/.test(outcomes.unsafe) && unsafeJob?.script === 'reports/unsafe.sh' && unsafeJob?.enabled === true
    && !studioRows("SELECT 1 FROM script_report_bindings WHERE job_id=?", unsafeId).length, { outcome: outcomes.unsafe })
  outcomes.broken = await decideInUi(page, N, 'e2e-broken', 'approve')
  // Native runs of the job before adoption are history: never reported (no backfill).
  const legacyBefore = new Set(hermesRows('SELECT id FROM executions WHERE job_id=?', legacyId).map(row => row.id))
  outcomes.legacy = await decideInUi(page, N, 'e2e-legacy', 'approve')
  outcomes.denied = await decideInUi(page, N, 'e2e-denied', 'deny')
  outcomes.restart = await decideInUi(page, N, 'e2e-restart', 'approve')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: join(dirs.shots, 'script-card-narrow.png') })
  await page.setViewportSize({ width: 1280, height: 900 })
  record('browser approvals applied; denial created nothing', /Approved/.test(outcomes.digest) && /Approved/.test(outcomes.quiet)
    && /Approved/.test(outcomes.broken) && /Approved/.test(outcomes.legacy) && /Denied/.test(outcomes.denied)
    && !jobs().some(job => job.name === 'e2e-denied'), { outcomes })
  record('native lifecycle guard refuses the gateway-restart script on approval', /native_create_rejected/.test(outcomes.restart)
    && !jobs().some(job => job.name === 'e2e-restart'), { outcome: outcomes.restart })
  const bindingsNow = studioRows('SELECT binding_id, job_id, job_name, state, session_id, account_id FROM script_report_bindings')
  const jobOf = name => bindingsNow.find(row => row.job_name === name)?.job_id
  const legacyJob = jobs().find(job => job.id === legacyId)
  record('existing job adopted in place: same id, wrapped, paused state kept (was scheduled → resumed), no duplicate',
    jobOf('e2e-legacy') === legacyId && /^ekko-script-reports\//.test(legacyJob?.script) && legacyJob?.enabled === true
      && jobs().filter(job => job.name === 'e2e-legacy').length === 1, { legacy: { script: legacyJob?.script, enabled: legacyJob?.enabled } })

  // Native scheduler: natural scheduled fires (gateway ticker / cron tick), then two manual runs of digest.
  const due = Math.max(...['e2e-digest', 'e2e-quiet', 'e2e-broken', 'e2e-legacy'].map(name => Date.parse(jobs().find(job => job.id === jobOf(name))?.next_run_at || '') || Date.now() + 60_000))
  await delay(Math.max(0, due - Date.now()) + 3000)
  hermes('cron', 'tick')
  hermes('cron', 'run', jobOf('e2e-digest'))
  hermes('cron', 'run', legacyId)
  hermes('cron', 'tick')
  hermes('cron', 'run', jobOf('e2e-digest'))
  hermes('cron', 'tick')
  const notices = () => studioRows("SELECT * FROM session_notifications WHERE kind='script_report' ORDER BY id").map(row => ({ ...row, payload: JSON.parse(row.payload) }))
  // The adopted job also fires naturally on its own schedule (gateway ticker / cron tick), not only manually.
  await waitFor(() => hermesRows("SELECT id FROM executions WHERE job_id=? AND source='builtin' AND status IN ('completed','failed')", legacyId)
    .some(row => !legacyBefore.has(row.id)), 150_000, 'adopted job natural fire')
  await waitFor(() => notices().filter(row => row.payload.job_id === jobOf('e2e-digest')).length >= 3
    && notices().filter(row => row.payload.job_id === legacyId).length
      >= hermesRows("SELECT id FROM executions WHERE job_id=? AND status IN ('completed','failed')", legacyId).filter(row => !legacyBefore.has(row.id)).length,
  180_000, 'imported reports')
  await delay(17_000) // one more import pass: replays must not duplicate
  const all = notices()
  const executions = hermesRows('SELECT id, job_id, status, error, source FROM executions')
  const runs = id => executions.filter(row => row.job_id === id)
  const of = id => all.filter(row => row.payload.job_id === id)
  const digestRows = of(jobOf('e2e-digest'))
  record('success: every native invocation (scheduled + concurrent manual) reports once to the same session',
    digestRows.length === runs(jobOf('e2e-digest')).length && runs(jobOf('e2e-digest')).some(row => row.source === 'builtin')
      && runs(jobOf('e2e-digest')).filter(row => row.source === 'direct').length >= 2
      && digestRows.every(row => row.session_id === N && row.disposition === 'notified' && row.payload.content === 'CONSENT_DIGEST ready')
      && new Set(digestRows.map(row => row.payload.invocation_id)).size === digestRows.length,
    { notices: digestRows.length, runs: runs(jobOf('e2e-digest')).map(row => row.source) })
  record('silence recorded, not shown', of(jobOf('e2e-quiet')).length > 0 && of(jobOf('e2e-quiet')).every(row => row.disposition === 'silent' && row.attention_pending === 0))
  const brokenRows = of(jobOf('e2e-broken'))
  record('failure delivered with exit code; secret redacted everywhere in Studio', brokenRows.length > 0
    && brokenRows.every(row => row.payload.outcome === 'failed' && row.payload.exit_code === 4 && String(row.payload.content).includes('[REDACTED'))
    && ![...walk(join(dirs.studio, 'script-reports')).map(file => readFileSync(file, 'utf8')), JSON.stringify(all)].join('\n').includes(SECRET))
  const adoptedRuns = runs(legacyId).filter(row => !legacyBefore.has(row.id))
  record('adopted existing job reports every future invocation, including a natural scheduled fire; no historical backfill',
    of(legacyId).length === adoptedRuns.length && adoptedRuns.some(row => row.source === 'builtin') && adoptedRuns.some(row => row.source === 'direct')
      && of(legacyId).every(row => row.session_id === N && row.payload.content === 'LEGACY_ADOPTED report'),
    { legacy_notices: of(legacyId).length, adopted_runs: adoptedRuns.map(row => row.source), pre_adoption_runs: legacyBefore.size })
  record('replay: no duplicate notice after another import pass', new Set(all.map(row => row.producer_key)).size === all.length)
  const page1 = await api(`/api/studio/sessions/conversations/${N}/messages/paginated?offset=0&limit=100`)
  record('notices visible in the same chat timeline', (page1.json?.messages || []).filter(m => m.studio_notice?.kind === 'script_report').length
    === digestRows.length + brokenRows.length + of(legacyId).length)
  await page.reload()
  await page.getByText('CONSENT_DIGEST ready').first().waitFor({ timeout: 60_000 })
  await page.screenshot({ path: join(dirs.shots, 'script-notices.png') })
  record('browser shows the delivered script report in the chat', true)

  // Revocation stops reporting; the native job is paused.
  const digestBinding = bindingsNow.find(row => row.job_name === 'e2e-digest')
  const revoked = await api(`/api/hermes/script-reports/enrollments/${digestBinding.binding_id}/revoke`, { method: 'POST', body: '{}' })
  const before = of(jobOf('e2e-digest')).length
  hermes('cron', 'run', jobOf('e2e-digest'))
  hermes('cron', 'tick')
  await delay(17_000)
  record('revocation pauses the job and later invocations are not reported', revoked.json?.native_job_paused === true
    && jobs().find(job => job.id === jobOf('e2e-digest'))?.enabled === false && notices().filter(row => row.payload.job_id === jobOf('e2e-digest')).length === before)
  record('ZERO model requests from setup through delivered script notices', modelRequests.length === 0, { model_requests: modelRequests.length })
  record('no run started in the script chat', !events.some(e => e.payload?.session_id === N && (e.event === 'run.started' || e.event === 'run.queued')))
  socket.disconnect()
}

/** Agent jobs: deterministic local model; the model requests consent through its MCP tool. */
async function part2(page, bobToken) {
  const A = `ecc-a-${randomUUID().slice(0, 8)}`
  const B = `ecc-b-${randomUUID().slice(0, 8)}`
  const socket = io(`http://127.0.0.1:${port}/chat-run`, { auth: { token }, query: { profile: 'default' }, transports: ['websocket'], reconnection: false })
  const events = []
  socket.onAny((event, payload) => events.push({ event, payload, at: Date.now() }))
  await waitFor(() => socket.connected, 20_000, 'socket')
  const runTurn = async (sessionId, input) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const start = events.length
      socket.emit('run', { session_id: sessionId, input, profile: 'default' })
      const done = await waitFor(() => events.slice(start).find(e => e.payload?.session_id === sessionId && (e.event === 'run.completed' || e.event === 'run.failed')), 240_000, `turn ${input}`)
      writeFileSync(join(dirs.logs, 'turns.jsonl'), `${JSON.stringify({ input, events: events.slice(start).map(e => ({ event: e.event, tool: e.payload?.tool || e.payload?.name, output: typeof e.payload?.output === 'string' ? e.payload.output.slice(0, 400) : undefined })) })}\n`, { flag: 'a' })
      if (done.event === 'run.completed') return done
      await delay(10_000)
    }
    throw new Error(`turn failed: ${input}`)
  }
  await runTurn(B, 'hello from B')
  // An existing agent job, created earlier by the user with the CLI.
  const existingId = createdJobId(hermes('cron', 'create', '--name', 'e2e-agent-existing', '--deliver', 'local', 'every 1m', 'E2E_CRON_PROMPT existing job'))
  const beforeTurn = modelRequests.length
  await runTurn(A, `E2E_CONSENT_AGENT session=${A}`)
  const turnRequests = modelRequests.slice(beforeTurn)
  const toolTexts = turnRequests.flatMap(r => r.messages.filter(m => m.role === 'tool').map(m => textOf(m.content)))
  const newJob = jobs().find(job => job.name === 'e2e-agent-new')
  const search = toolTexts.find(text => text.includes('"matches"')) || ''
  const nativeCreate = toolTexts.find(text => text.includes('cronjob_manage')) || ''
  record('model discovered the deferred MCP tool by tool_search (exact Hermes name)', /mcp__ekko_studio_api__ekko_studio_api_request/.test(search),
    { search: search.slice(0, 400), native_cronjob_manage: nativeCreate.slice(0, 300) || 'not offered by tool_search' })
  record('model created the agent job through its MCP tool (Studio jobs API accepts model_run; deliver=local, unbound)', newJob?.deliver === 'local' && newJob?.no_agent !== true
    && !cronBindings().some(row => row.job_id === newJob?.id), { job: newJob?.id })
  const directBind = toolTexts.find(text => text.includes('session-bindings') || (text.includes('login_token_required') && !text.includes('pending_user_consent')))
  record('MCP direct agent binding with the model runtime credential: 403 login_token_required', /403/.test(directBind || '') && /login_token_required/.test(directBind || ''),
    { endpoint: 'POST /api/hermes/cron/session-bindings', purpose: runtimePurpose(), result: String(directBind || '').slice(0, 300) })
  const consentText = toolTexts.find(text => text.includes('pending_user_consent'))
  record('model requested consent through its MCP tool with the live turn context (202 pending)', Boolean(consentText) && /202/.test(consentText),
    { result: String(consentText || toolTexts.at(-1) || '').slice(0, 300) })
  record('before consent: agent job not bound', !cronBindings().some(row => row.job_id === newJob?.id))

  // Existing agent job: the user opens a setup context in A, the MCP client proposes the binding.
  const mcp = startMcp()
  await mcp.init()
  const existing = await mcp.request('POST', '/api/hermes/cron/consent-requests', { profile: 'default', context_id: await prepareInUi(page, A), kind: 'cron_session_binding', job_id: existingId })
  record('existing agent job: consent requested (202)', existing.status === 202, { status: existing.status, error: existing.body?.error })
  const bobDecide = await api(`/api/hermes/cron/consent-requests/${existing.body?.request_id}/approve`, { method: 'POST', body: JSON.stringify({ profile: 'default' }) }, bobToken)
  record('other account cannot approve the agent binding', [403, 404].includes(bobDecide.status), { status: bobDecide.status })
  const outNew = await decideInUi(page, A, 'e2e-agent-new', 'approve', 'agent-card')
  const outExisting = await decideInUi(page, A, 'e2e-agent-existing', 'approve')
  const bound = cronBindings()
  record('browser approvals bind both agent jobs to A with the approving account', /Approved/.test(outNew) && /Approved/.test(outExisting)
    && [newJob?.id, existingId].every(id => bound.some(row => row.job_id === id && row.session_id === A && Number(row.account_id) === 1)),
    { outcomes: [outNew, outExisting], bound: bound.map(row => ({ job: row.job_id, session: row.session_id, account: row.account_id })) })

  // Boundary: everything after the approvals is the scheduled phase.
  const approvedAt = Date.now()
  const eventsAtApproval = events.length
  const messagesInA = () => Number(studioRows('SELECT COUNT(*) AS n FROM messages WHERE session_id=?', A)[0]?.n || 0)
  const messagesAtApproval = messagesInA()
  // The user focuses B while the native scheduler fires both jobs (deterministic local model).
  await openSession(page, B)
  const focus = io(`http://127.0.0.1:${port}/chat-run`, { auth: { token }, query: { profile: 'default' }, transports: ['websocket'], reconnection: false })
  const focusEvents = []
  focus.onAny((event, payload) => focusEvents.push({ event, payload }))
  await waitFor(() => focus.connected, 20_000, 'focus socket')
  focus.emit('resume', { session_id: B, profile: 'default' })
  const noticeFor = name => focusEvents.find(e => e.event === 'session.notice' && e.payload?.session_id === A && e.payload?.message?.studio_notice?.job_name === name)
  const nNew = await waitFor(() => noticeFor('e2e-agent-new'), 330_000, 'agent notice (new)')
  const nExisting = await waitFor(() => noticeFor('e2e-agent-existing'), 330_000, 'agent notice (existing)')
  record('scheduled fires deliver the exact native agent result to A while B is focused (new + existing)',
    [nNew, nExisting].every(n => n.payload.message?.content === CRON_ANSWER && n.payload.message?.studio_notice?.execution_id),
    { executions: [nNew, nExisting].map(n => n.payload.message?.studio_notice?.execution_id) })
  record('no notice addressed to B', !focusEvents.some(e => e.event === 'session.notice' && e.payload?.session_id === B))
  await delay(20_000) // another observation pass: a notice must not start anything afterwards
  const startedInA = list => list.some(e => (e.event === 'run.started' || e.event === 'run.queued') && e.payload?.session_id === A)
  const scheduledPhase = events.slice(eventsAtApproval)
  // Negative control: the detector must trip on an injected forbidden run start.
  const controlTrips = startedInA([...scheduledPhase, { event: 'run.started', payload: { session_id: A } }])
  record('negative control: an injected run.started in A after approval is detected', controlTrips === true)
  record('no Studio run started or queued in A after approval; no message rows added to A', !startedInA(scheduledPhase) && !startedInA(focusEvents)
    && messagesInA() === messagesAtApproval, { scheduled_phase_events: scheduledPhase.length, messages: [messagesAtApproval, messagesInA()] })
  const setupRequests = modelRequests.filter(r => r.at < approvedAt)
  const scheduledRequests = modelRequests.filter(r => r.at >= approvedAt)
  const isCronRun = r => r.messages.some(m => m.role === 'user' && textOf(m.content).includes('E2E_CRON_PROMPT'))
  record('scheduled phase inference = only the native cron runs of the two approved jobs (deterministic local model)',
    scheduledRequests.length >= 2 && scheduledRequests.every(isCronRun)
      && scheduledRequests.some(r => JSON.stringify(r.messages).includes('new job')) && scheduledRequests.some(r => JSON.stringify(r.messages).includes('existing job')),
    { setup_requests: setupRequests.length, scheduled_requests: scheduledRequests.length })
  await openSession(page, A)
  await page.getByText(CRON_ANSWER).first().waitFor({ timeout: 60_000 })
  await page.screenshot({ path: join(dirs.shots, 'agent-notice.png') })
  record('browser shows the delivered agent result in A', true)
  focus.disconnect()
  socket.disconnect()
}

let failure = null
try {
  await main()
} catch (error) {
  failure = error
  record('harness completed', false, { error: String(error?.stack || error).slice(0, 1500) })
} finally {
  for (const entry of children) await stopChild(entry)
  await new Promise(done => modelServer.close(done))
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true })
    writeFileSync(join(evidenceDir, 'cron-consent-e2e-results.json'), JSON.stringify({ root, model_requests: modelRequests.length, results }, null, 2))
    for (const file of [...walk(dirs.logs), ...walk(dirs.shots)]) writeFileSync(join(evidenceDir, `cron-consent-e2e-${file.split('/').pop()}`), readFileSync(file))
  }
  if (!process.env.E2E_KEEP_ROOT) rmSync(root, { recursive: true, force: true })
}
const failed = results.filter(item => !item.ok)
console.log(`${results.length - failed.length}/${results.length} checks passed`)
process.exit(failure || failed.length ? 1 : 0)
