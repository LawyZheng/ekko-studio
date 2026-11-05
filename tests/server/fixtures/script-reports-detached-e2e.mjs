#!/usr/bin/env node
// Real end-to-end proof of detached script report completion, with no model call at all.
//
// In disposable homes only: the built Studio server, the read-only Hermes checkout's own CLI and
// scheduler (`hermes cron run|tick`), a recording fake model endpoint that classifies every request
// (local metadata discovery is allowed; any inference request fails the campaign), and the synthetic fire-and-forget producer in fixtures/detached-report.
// The login token is short-lived: after it expires the external notice API refuses it, while the
// enrolled detached producer keeps delivering, across a Studio crash and restart.
//
//   npm run build && HERMES_AGENT_ROOT=<read-only hermes checkout> node tests/server/fixtures/script-reports-detached-e2e.mjs
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { io } from 'socket.io-client'

const repo = resolve(new URL('../../..', import.meta.url).pathname)
const agentRoot = process.env.HERMES_AGENT_ROOT
if (!agentRoot) throw new Error('HERMES_AGENT_ROOT is required')
const venv = existsSync(join(agentRoot, '.venv', 'bin', 'hermes')) ? '.venv' : 'venv'
const python = join(agentRoot, venv, 'bin', 'python')
const evidenceDir = process.env.E2E_EVIDENCE_DIR || ''
const JWT_SECONDS = Number(process.env.E2E_LOGIN_JWT_SECONDS || 40)
// E2E_BROWSER_ONLY=<root kept by E2E_KEEP_ROOT>: restart that Studio and repeat only the browser check.
const reuse = process.env.E2E_BROWSER_ONLY || ''
const root = reuse || mkdtempSync(join(process.env.E2E_TMP_ROOT || tmpdir(), 'esd-'))
const dirs = Object.fromEntries(['home', 'hermes', 'studio', 'tmp', 'pyc', 'logs', 'uploads', 'bin', 'browser'].map(name => [name, join(root, name)]))
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
if (!reuse) symlinkSync(join(agentRoot, venv, 'bin', 'hermes'), join(dirs.bin, 'hermes'))
const isolatedPath = [dirs.bin, dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':')

const results = []
const children = []
const record = (name, ok, detail = {}) => {
  phase = name
  results.push({ name, ok, ...detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${Object.keys(detail).length ? ' ' + JSON.stringify(detail).slice(0, 700) : ''}`)
}

// Every request to the configured model endpoint counts, including model listing.
const providerRequests = []
let phase = 'start'
const provider = createServer((req, res) => {
  providerRequests.push({ at: Date.now(), phase, method: req.method, url: req.url, agent: req.headers['user-agent'] || null })
  res.writeHead(503, { 'content-type': 'application/json' })
  res.end('{"error":"the detached report campaign must not call a model"}')
})

const baseEnv = (extra = {}) => ({ PATH: isolatedPath, HOME: dirs.home, TMPDIR: dirs.tmp, HERMES_HOME: dirs.hermes,
  HERMES_DISABLE_LAZY_INSTALLS: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONPYCACHEPREFIX: dirs.pyc, ...extra })
let port = 0
let bridgePort = 0
function startStudio(label) {
  const log = createWriteStream(join(dirs.logs, `${label}.log`))
  const child = spawn(process.execPath, ['--no-warnings', 'dist/server/index.js'], { cwd: repo, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: baseEnv({
    NODE_ENV: 'production', PORT: String(port), BIND_HOST: '127.0.0.1', HERMES_WEB_UI_HOME: dirs.studio, HERMES_WEBUI_STATE_DIR: dirs.studio,
    UPLOAD_DIR: dirs.uploads, HERMES_AGENT_ROOT: agentRoot, HERMES_BIN: join(dirs.bin, 'hermes'), HERMES_AGENT_BRIDGE_PYTHON: python,
    HERMES_AGENT_BRIDGE_ENDPOINT: `tcp://127.0.0.1:${bridgePort}`, HERMES_AGENT_BRIDGE_WORKER_TRANSPORT: 'tcp',
    HERMES_AGENT_BRIDGE_WORKER_PORT_BASE: String(30000 + Math.floor(Math.random() * 8000)), HERMES_AGENT_BRIDGE_STOP_ON_SHUTDOWN: '1',
    HERMES_WEB_UI_DISABLE_GATEWAY_AUTOSTART: '1', HERMES_WEB_UI_MANAGED_GATEWAY: '0', HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN: '0',
    HERMES_WEB_UI_DISABLE_MCP_AUTOINJECT: '1', HERMES_LAN_DISCOVERY_ENABLED: '0', HERMES_WEB_UI_DISABLE_UPDATE_CHECK: '1', HERMES_WEB_UI_AUTH_JWT_EXPIRES_IN: `${JWT_SECONDS}s`,
  }) })
  child.stdout.pipe(log)
  child.stderr.pipe(log)
  children.push(child)
  return child
}
async function stopStudio(child, signal) {
  try { process.kill(-child.pid, signal) } catch {}
  for (let i = 0; i < 100 && child.exitCode === null && !child.signalCode; i++) await delay(100)
  if (child.exitCode === null && !child.signalCode) { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
}
function hermes(...args) {
  const result = spawnSync(join(dirs.bin, 'hermes'), args, { cwd: dirs.home, env: baseEnv(), encoding: 'utf8', timeout: 180_000 })
  writeFileSync(join(dirs.logs, 'hermes-cli.log'), `$ hermes ${args.join(' ')}\n[exit ${result.status}]\n${result.stdout}\n${result.stderr}\n`, { flag: 'a' })
  return result
}
async function api(path, init = {}, token = '') {
  const request = () => fetch(`http://127.0.0.1:${port}${path}`, { ...init,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) } })
  // A keep-alive socket of a stopped server can fail once; the request never reached the server then.
  const res = await request().catch(() => delay(500).then(request))
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, json, text }
}
async function waitFor(predicate, timeoutMs, label) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await delay(500)) {
    const value = await predicate()
    if (value) return value
  }
  throw new Error(`timeout: ${label}`)
}
const rows = (file, sql, ...params) => {
  const db = new DatabaseSync(file, { readOnly: true })
  try { return db.prepare(sql).all(...params) } finally { db.close() }
}
const notices = () => rows(join(dirs.studio, 'hermes-web-ui.db'), "SELECT * FROM session_notifications WHERE kind='script_report' ORDER BY id")
  .map(row => ({ ...row, payload: JSON.parse(row.payload) }))
const executions = jobId => rows(join(dirs.hermes, 'cron', 'executions.db'), 'SELECT status, source FROM executions WHERE job_id=? ORDER BY claimed_at', jobId)
const login = async () => (await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: '123456' }) })).json?.token
const json = file => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
async function ready(child) {
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error('Studio exited during startup')
    try { return (await fetch(`http://127.0.0.1:${port}/api/auth/status`)).ok } catch { return false }
  }, 240_000, 'studio start')
}

async function browserOnly() {
  port = 30000 + Math.floor(Math.random() * 8000)
  bridgePort = port + 1
  const studio = startStudio('studio-browser-only')
  await ready(studio)
  const [{ session_id: session }] = notices()
  const evidence = await browserCheck(session, await login())
  record('browser: table cells and Markdown links render and are clickable', evidence.ok, evidence)
}

async function main() {
  if (reuse) return browserOnly()
  await new Promise(done => provider.listen(0, '127.0.0.1', done))
  writeFileSync(join(dirs.hermes, 'config.yaml'), ['model:', '  default: fake-model', '  provider: custom',
    `  base_url: http://127.0.0.1:${provider.address().port}/v1`, '  api_key: fake-local-key', '  context_length: 128000',
    'compression:', '  enabled: false', 'cron:', '  script_timeout_seconds: 60', ''].join('\n'))
  // Two copies of the producer: one enrolled with detached completion, one with the default (control).
  const fixture = join(repo, 'tests', 'server', 'fixtures', 'detached-report')
  for (const lane of ['detached', 'control']) {
    mkdirSync(join(dirs.hermes, 'scripts', 'synthetic', lane, 'state'), { recursive: true })
    for (const file of ['launcher.sh', 'worker.py']) copyFileSync(join(fixture, file), join(dirs.hermes, 'scripts', 'synthetic', lane, file))
    writeFileSync(join(dirs.hermes, 'scripts', 'synthetic', lane, 'state', 'day'), '2026-11-04\n')
    writeFileSync(join(dirs.hermes, 'scripts', 'synthetic', lane, 'state', 'wait'), '45\n')
  }
  const state = lane => join(dirs.hermes, 'scripts', 'synthetic', lane, 'state')
  const freePort = async () => {
    const probe = createServer()
    await new Promise(done => probe.listen(0, '127.0.0.1', done))
    const value = probe.address().port
    await new Promise(done => probe.close(done))
    return value
  }
  port = await freePort()
  bridgePort = await freePort()
  if (!existsSync(join(repo, 'dist', 'server', 'index.js'))) throw new Error('run `npm run build` first')
  let studio = startStudio('studio-1')
  await ready(studio)
  const setupToken = await login()
  const issuedAt = Date.now()
  if (!setupToken) throw new Error('login failed')

  // Model-free setup: a slash command creates an ordinary Hermes chat; nothing runs a turn.
  const session = `esd-${randomUUID().slice(0, 8)}`
  const socket = io(`http://127.0.0.1:${port}/chat-run`, { auth: { token: setupToken }, query: { profile: 'default' }, transports: ['websocket'], reconnection: false })
  await waitFor(() => socket.connected, 20_000, 'socket')
  socket.emit('run', { session_id: session, input: '/title Detached reports', profile: 'default' })
  const generation = await waitFor(async () => (await api(`/api/studio/sessions/${session}?profile=default`, {}, setupToken)).json?.session?.session_generation, 30_000, 'session')
  socket.disconnect()
  record('setup: ordinary Hermes chat created by a slash command, no model turn', Boolean(generation), { providerRequests: providerRequests.length })
  const enroll = (name, lane, completion) => api('/api/hermes/script-reports/enrollments', { method: 'POST', body: JSON.stringify({
    profile: 'default', session_id: session, expected_session_generation: generation, name, schedule: 'every 1m',
    script: `synthetic/${lane}/launcher.sh`, ...(completion ? { completion } : {}) }) }, setupToken)
  const detached = (await enroll('detached-report', 'detached', 'detached')).json?.binding
  const control = (await enroll('control-report', 'control')).json?.binding
  record('enrollment: detached and default bindings active', detached?.state === 'active' && detached.completion === 'detached'
    && control?.state === 'active' && control.completion === 'sync', { detached: detached?.completion, control: control?.completion })
  const external = body => api(`/api/studio/sessions/${session}/notifications`, { method: 'POST', body: JSON.stringify({
    profile: 'default', expected_session_generation: generation, source: 'e2e-adapter', event_id: body, title: 'External', content: `external ${body}` }) }, setupToken)
  const before = await external('before-expiry')
  record('control: the external notice API accepts the login token before it expires', before.status === 201, { status: before.status })

  // Simulated expiry (short configured lifetime, real clock): the setup credential is now dead.
  await delay(Math.max(0, issuedAt + JWT_SECONDS * 1000 + 2000 - Date.now()))
  const expired = await external('after-expiry')
  const expiredList = await api('/api/hermes/script-reports/enrollments?profile=default', {}, setupToken)
  record('RED baseline: an expired login token can no longer post external notices or manage enrollments', [401, 403].includes(expired.status)
    && [401, 403].includes(expiredList.status), { post: expired.status, list: expiredList.status })

  // Day 1, natural schedule: the native scheduler fires both jobs through their wrappers.
  const jobsFile = () => { const value = json(join(dirs.hermes, 'cron', 'jobs.json')); return Array.isArray(value) ? value : value.jobs }
  const due = Math.max(...jobsFile().map(job => Date.parse(job.next_run_at || '') || Date.now() + 60_000))
  await delay(Math.max(0, due - Date.now()) + 3000)
  const tick1 = hermes('cron', 'tick')
  record('original Hermes scheduler tick ran both no_agent jobs', tick1.status === 0 && executions(detached.job_id).length === 1
    && executions(control.job_id).length === 1, { detached: executions(detached.job_id), control: executions(control.job_id) })
  const day1 = await waitFor(() => json(join(state('detached'), 'delivered.json'))?.['synthetic-daily-report:v1:2026-11-04'], 90_000, 'day 1 receipt')
  const shown1 = notices().filter(row => row.payload.event_id === 'synthetic-daily-report:v1:2026-11-04' && row.disposition === 'notified')
  record('detached: the worker committed only on Studio\'s exact receipt for the delivered notice', shown1.length === 1
    && day1.notification_id === shown1[0].id && day1.exact === true && day1.state === 'accepted' && day1.session_generation === generation
    && !existsSync(join(state('detached'), 'pending.md')), { receipt: day1 })
  const controlRows = notices().filter(row => row.payload.binding_id === control.binding_id)
  record('RED control: the default wrapper reports the silent launcher and the worker\'s report is lost (stays pending)', controlRows.length === 1
    && controlRows[0].disposition === 'silent' && existsSync(join(state('control'), 'pending.md'))
    && readdirSync(join(state('control'), 'runs')).some(run => readFileSync(join(state('control'), 'runs', run, 'worker.log'), 'utf8').includes('no Ekko completion context')),
    { control: controlRows.map(row => row.disposition) })

  // Day 2: Studio crashes; the worker finishes while it is down and keeps its draft pending.
  writeFileSync(join(state('detached'), 'day'), '2026-11-05\n')
  await stopStudio(studio, 'SIGKILL')
  // A cold crash: the private Agent Bridge (its own session) dies too, so the restart reuses nothing in memory.
  spawnSync('pkill', ['-KILL', '-f', `hermes_bridge.py --endpoint tcp://127.0.0.1:${bridgePort}`])
  hermes('cron', 'run', detached.job_id)
  hermes('cron', 'tick')
  await waitFor(() => !existsSync(join(state('detached'), 'lock')), 60_000, 'day 2 worker exit')
  const spool = join(dirs.studio, 'script-reports', 'spool', detached.binding_id)
  const queued = readdirSync(spool).filter(name => !name.startsWith('.') && existsSync(join(spool, name, 'final.json')))
  record('Studio down: the final report waits in the spool and the business draft stays pending', queued.length === 1
    && existsSync(join(state('detached'), 'pending.md')), { queued })

  studio = startStudio('studio-2')
  await ready(studio)
  const afterRestart = await api(`/api/studio/sessions/${session}/notifications`, { method: 'POST', body: JSON.stringify({
    profile: 'default', expected_session_generation: generation, source: 'e2e-adapter', event_id: 'after-restart', title: 'External', content: 'x' }) }, setupToken)
  record('after restart the expired setup token is still refused', [401, 403].includes(afterRestart.status), { status: afterRestart.status })
  // Next run retries the identical draft under the original invocation; the vehicle is silent.
  await waitFor(() => notices().some(row => row.payload.event_id === 'synthetic-daily-report:v1:2026-11-05'), 60_000, 'day 2 import after restart')
  hermes('cron', 'run', detached.job_id)
  hermes('cron', 'tick')
  const day2 = await waitFor(() => json(join(state('detached'), 'delivered.json'))?.['synthetic-daily-report:v1:2026-11-05'], 90_000, 'day 2 receipt')
  // The retry's own invocation is imported on a following pass.
  await waitFor(() => notices().some(row => row.payload.retry_of === day2.invocation_id), 60_000, 'retry vehicle import').catch(() => null)
  const day2Rows = notices().filter(row => row.payload.event_id === 'synthetic-daily-report:v1:2026-11-05')
  record('restart: one delivery of day 2 under its original invocation; the retry is a silent event_retry', day2Rows.length === 2
    && day2Rows.filter(row => row.disposition === 'notified').length === 1 && day2.invocation_id === queued[0]
    && day2Rows.some(row => row.disposition === 'silent' && row.payload.retry_of === queued[0]), { day2: day2Rows.map(row => [row.disposition, row.payload.reason]) })
  record('the producer composed each day exactly once', readFileSync(join(state('detached'), 'compositions'), 'utf8') === '2026-11-04\n2026-11-05\n')
  record('native ledger: every detached launcher run completed', executions(detached.job_id).every(row => row.status === 'completed'),
    { runs: executions(detached.job_id) })

  // Browser: the passive Markdown renders a selectable table with clickable links; nothing leaves 127.0.0.1.
  const browserEvidence = await browserCheck(session, await login())
  record('browser: table cells and Markdown links render and are clickable', browserEvidence.ok, browserEvidence)
  // Hermes discovers a local endpoint's server type with GETs (seen after a cold Studio and Bridge restart,
  // with or without script reports). Generation requests are never allowed.
  const discovery = new Set(['/api/v1/models', '/api/tags', '/v1/props', '/props', '/version', '/v1/models', '/models'])
  const metadata = providerRequests.filter(item => item.method === 'GET' && discovery.has(item.url.split('?')[0]))
  const inference = providerRequests.filter(item => !metadata.includes(item))
  record('model endpoint: no inference request in the whole campaign (local metadata discovery counted separately)', inference.length === 0,
    { total: providerRequests.length, metadataDiscovery: metadata.length, inference: inference.length, browserNonlocalAborted: browserEvidence.blocked, providerRequests })
}

/**
 * A fresh Studio profile stacks first-run dialogs over the timeline: "No model provider configured"
 * ("Not now"), a release notice ("Got it") and the default-credentials reminder ("Remind me later").
 * They open at different moments: dismiss whichever is on top, let the page settle, re-check, and
 * fail unless no modal mask stays visible; the link is then clicked for real.
 */
async function dismissOnboarding(page) {
  const masks = page.locator('.n-modal-mask:visible')
  const dialogs = () => page.locator('.n-modal-container').evaluateAll(nodes => nodes.map(node => node.innerText.slice(0, 300)))
  const dismissed = []
  for (let round = 0; round < 12; round++) {
    await page.waitForTimeout(1500) // settle: another dialog may still be opening
    if (await masks.count() === 0) return dismissed
    const buttons = await page.getByRole('button', { name: /^(Not now|Got it|Remind me later)$/ }).filter({ visible: true }).all()
    // The dialog on top is the one whose button actually receives the pointer (trial click, no action).
    let top = null
    for (const button of buttons) {
      if (await button.click({ trial: true, timeout: 1000 }).then(() => true, () => false)) { top = button; break }
    }
    if (!top) continue // still animating in
    dismissed.push((await top.innerText()).trim())
    await top.click({ timeout: 5000 })
  }
  throw new Error(`onboarding dialogs still open after [${dismissed.join(', ')}]: ${JSON.stringify(await dialogs())}`)
}

async function browserCheck(session, token) {
  const { chromium } = await import('@playwright/test')
  // PLAYWRIGHT_CHANNEL=chrome uses a local browser, as in playwright.config.ts; the profile is private.
  const context = await chromium.launchPersistentContext(dirs.browser, { headless: true, env: baseEnv(),
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) })
  const blocked = []
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.hostname === '127.0.0.1' && url.port === String(port)) return route.continue()
    blocked.push(route.request().url())
    return route.abort()
  })
  try {
    const page = await context.newPage()
    await page.addInitScript(([value, server]) => { localStorage.setItem('hermes_api_key', value); localStorage.setItem('hermes_server_url', server) },
      [token, `http://127.0.0.1:${port}`])
    await page.goto(`http://127.0.0.1:${port}/#/hermes/session/${session}`)
    const table = page.locator('table').filter({ hasText: 'SYN-1' }).first()
    await table.waitFor({ timeout: 60_000 })
    const dismissed = await dismissOnboarding(page)
    await table.scrollIntoViewIfNeeded()
    const link = table.locator('a', { hasText: 'SYN-2 [flaky]' })
    const cell = table.locator('td', { hasText: 'In progress' }).first()
    const selectable = await cell.evaluate(node => getComputedStyle(node).userSelect !== 'none')
    const href = await link.getAttribute('href')
    if (evidenceDir) await page.screenshot({ path: join(evidenceDir, 'detached-report-browser.png'), fullPage: true })
    const popup = context.waitForEvent('page', { timeout: 5000 }).catch(() => null)
    await link.click()
    const opened = await popup
    await delay(1000)
    const clicked = blocked.some(url => url.startsWith('https://example.com/issues/SYN-2')) || Boolean(opened)
    const rowsShown = await page.locator('table').filter({ hasText: 'SYN-1' }).count()
    return { ok: href === 'https://example.com/issues/SYN-2' && selectable && clicked && rowsShown === 2, href, selectable, clicked, rowsShown, dismissed,
      blocked: [...new Set(blocked)] }
  } finally {
    await context.close()
  }
}

let failure = null
try {
  await main()
} catch (error) {
  failure = error
  record('harness completed', false, { error: String(error?.stack || error).slice(0, 1500) })
} finally {
  for (const child of children) await stopStudio(child, 'SIGTERM')
  await new Promise(done => provider.close(done))
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true })
    writeFileSync(join(evidenceDir, 'script-reports-detached-e2e-results.json'), JSON.stringify({ root, providerRequests, results }, null, 2))
    for (const name of readdirSync(dirs.logs)) writeFileSync(join(evidenceDir, `detached-e2e-${name}`), readFileSync(join(dirs.logs, name)))
  }
  if (!process.env.E2E_KEEP_ROOT && !reuse) rmSync(root, { recursive: true, force: true })
}
const failed = results.filter(item => !item.ok)
console.log(`${results.length - failed.length}/${results.length} checks passed`)
process.exit(failure || failed.length ? 1 : 0)
