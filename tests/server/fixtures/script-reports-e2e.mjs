#!/usr/bin/env node
// Real end-to-end proof of opt-in script invocation reports.
//
// In disposable homes only: a recording fake model, the built Studio server, and the read-only
// Hermes checkout's own CLI (`hermes cron create|resume|run|pause`) and scheduler (`hermes cron
// tick`, the original `cron.scheduler.tick`). Enrolls synthetic scripts through Studio's API, lets
// the native scheduler run them as no_agent jobs, then checks the passive notices, silence,
// failure, privacy, revocation and that no model request follows the setup turn.
//
//   npm run build && HERMES_AGENT_ROOT=<read-only hermes checkout> node tests/server/fixtures/script-reports-e2e.mjs
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
const hermesBin = join(agentRoot, venv, 'bin', 'hermes')
const evidenceDir = process.env.E2E_EVIDENCE_DIR || ''
const root = mkdtempSync(join(process.env.E2E_TMP_ROOT || tmpdir(), 'esr-'))
const dirs = Object.fromEntries(['home', 'hermes', 'studio', 'tmp', 'pyc', 'logs', 'uploads', 'bin'].map(name => [name, join(root, name)]))
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
// The only `hermes` on PATH is the pinned checkout's own entry point.
symlinkSync(hermesBin, join(dirs.bin, 'hermes'))
const isolatedPath = [dirs.bin, dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':')
const SECRET = 'ghp_SYNTHETICSECRET0123456789abcdefABCD'

const results = []
const children = []
const record = (name, ok, detail = {}) => {
  results.push({ name, ok, ...detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${Object.keys(detail).length ? ' ' + JSON.stringify(detail).slice(0, 700) : ''}`)
}

// --- recording fake model: any request after setup is a model turn ---------------------------
const modelRequests = []
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
    modelRequests.push({ at: Date.now(), url: req.url })
    const base = { id: `chatcmpl-${randomUUID()}`, created: Math.floor(Date.now() / 1000), model: body.model || 'fake-model' }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`)
      res.end('data: [DONE]\n\n')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  })
})

function baseEnv(extra = {}) {
  return {
    PATH: isolatedPath, HOME: dirs.home, TMPDIR: dirs.tmp, HERMES_HOME: dirs.hermes,
    HERMES_DISABLE_LAZY_INSTALLS: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONPYCACHEPREFIX: dirs.pyc,
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
}
/** The checkout's own CLI against the disposable HERMES_HOME. */
function hermes(...args) {
  const result = spawnSync(join(dirs.bin, 'hermes'), args, { cwd: dirs.home, env: baseEnv(), encoding: 'utf8', timeout: 180_000 })
  writeFileSync(join(dirs.logs, 'hermes-cli.log'), `$ hermes ${args.join(' ')}\n[exit ${result.status}]\n${result.stdout}\n${result.stderr}\n`, { flag: 'a' })
  return result
}

let port = 0
let token = ''
async function api(path, init = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) },
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
function studioRows(sql, ...params) {
  const db = new DatabaseSync(join(dirs.studio, 'hermes-web-ui.db'), { readOnly: true })
  try { return db.prepare(sql).all(...params) } finally { db.close() }
}
function hermesRows(sql, ...params) {
  const db = new DatabaseSync(join(dirs.hermes, 'cron', 'executions.db'), { readOnly: true })
  try { return db.prepare(sql).all(...params) } finally { db.close() }
}
function walk(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)])
}

async function main() {
  await new Promise(done => modelServer.listen(0, '127.0.0.1', done))
  writeFileSync(join(dirs.hermes, 'config.yaml'), ['model:', '  default: fake-model', '  provider: custom',
    `  base_url: http://127.0.0.1:${modelServer.address().port}/v1`, '  api_key: fake-local-key', '  context_length: 128000',
    'compression:', '  enabled: false', 'cron:', '  script_timeout_seconds: 30', ''].join('\n'))
  const scripts = join(dirs.hermes, 'scripts', 'synthetic')
  mkdirSync(scripts, { recursive: true })
  writeFileSync(join(scripts, 'digest.py'), 'import os\nprint("SYNTHETIC_DIGEST cwd=" + os.path.basename(os.getcwd()))\n')
  writeFileSync(join(scripts, 'quiet.py'), 'print("checked 3 feeds")\nprint(\'{"wakeAgent": false}\')\n')
  writeFileSync(join(scripts, 'broken.sh'), `echo "token=${SECRET}" >&2\necho "partial"\nexit 4\n`)
  // Refused by Hermes' own create-time lifecycle guard.
  writeFileSync(join(scripts, 'restart.sh'), 'hermes gateway restart\n')
  // Outlives the native script timeout with a descendant that must not survive it.
  const grandchildPid = join(dirs.tmp, 'grandchild.pid')
  writeFileSync(join(scripts, 'tree.py'), `import subprocess, time\nchild = subprocess.Popen(["sleep", "300"])\nopen(${JSON.stringify(grandchildPid)}, "w").write(str(child.pid))\ntime.sleep(300)\n`)
  writeFileSync(join(scripts, 'editme.py'), 'open("editme.ran", "w").write("ran")\nprint("EDITME")\n')
  // Unwrapped control: a plain native no_agent job in the same ticks (not enrolled, never reported).
  writeFileSync(join(scripts, 'control.py'), 'print("NATIVE_CONTROL")\n')
  const freePort = async () => {
    const probe = createServer()
    await new Promise(done => probe.listen(0, '127.0.0.1', done))
    const value = probe.address().port
    await new Promise(done => probe.close(done))
    return value
  }
  port = await freePort()
  const bridgePort = await freePort()
  if (!existsSync(join(repo, 'dist', 'server', 'index.js'))) throw new Error('run `npm run build` first')
  const studio = startChild('studio', process.execPath, ['--no-warnings', 'dist/server/index.js'], baseEnv({
    NODE_ENV: 'production', PORT: String(port), BIND_HOST: '127.0.0.1', HERMES_WEB_UI_HOME: dirs.studio, HERMES_WEBUI_STATE_DIR: dirs.studio,
    UPLOAD_DIR: dirs.uploads, HERMES_AGENT_ROOT: agentRoot, HERMES_BIN: join(dirs.bin, 'hermes'), HERMES_AGENT_BRIDGE_PYTHON: python,
    HERMES_AGENT_BRIDGE_ENDPOINT: `tcp://127.0.0.1:${bridgePort}`, HERMES_AGENT_BRIDGE_WORKER_TRANSPORT: 'tcp',
    HERMES_AGENT_BRIDGE_WORKER_PORT_BASE: String(30000 + Math.floor(Math.random() * 8000)),
    HERMES_WEB_UI_DISABLE_GATEWAY_AUTOSTART: '1', HERMES_WEB_UI_MANAGED_GATEWAY: '0',
  }))
  await waitFor(async () => {
    if (studio.exitCode !== null) throw new Error('Studio exited during startup')
    try { return (await fetch(`http://127.0.0.1:${port}/api/auth/status`)).ok } catch { return false }
  }, 240_000, 'studio start')
  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: '123456' }) })
  token = login.json?.token
  if (!token) throw new Error(`login failed: ${login.text.slice(0, 200)}`)

  // One setup turn creates an ordinary Hermes chat session. Every later model request is a failure.
  const session = `esr-${randomUUID().slice(0, 8)}`
  const socket = io(`http://127.0.0.1:${port}/chat-run`, { auth: { token }, query: { profile: 'default' }, transports: ['websocket'], reconnection: false })
  const events = []
  socket.onAny((event, payload) => events.push({ event, payload }))
  await waitFor(() => socket.connected, 20_000, 'socket')
  // The Agent Bridge may still be starting on a loaded machine: retry the setup turn, recording failures.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const start = events.length
    socket.emit('run', { session_id: session, input: 'setup turn', profile: 'default' })
    const done = await waitFor(() => events.slice(start).find(e => e.payload?.session_id === session && (e.event === 'run.completed' || e.event === 'run.failed')), 240_000, 'setup turn')
    if (done.event === 'run.completed') break
    console.log(`setup turn attempt ${attempt} failed: ${JSON.stringify(done.payload).slice(0, 300)}`)
    await delay(10_000)
  }
  socket.emit('resume', { session_id: session, profile: 'default' })
  const detail = await api(`/api/studio/sessions/${session}?profile=default`)
  const generation = detail.json?.session?.session_generation
  record('setup: ordinary Hermes session with a frozen generation', Boolean(generation), { status: detail.status })
  const setupRequests = modelRequests.length
  const setupEvents = events.length

  const enroll = (name, script) => api('/api/hermes/script-reports/enrollments', { method: 'POST', body: JSON.stringify({
    profile: 'default', session_id: session, expected_session_generation: generation, name, schedule: 'every 1m', script }) })
  const modelRun = await api('/api/hermes/script-reports/enrollments', { method: 'POST', headers: { authorization: 'Bearer not-a-login-token' },
    body: JSON.stringify({ profile: 'default', session_id: session, expected_session_generation: generation, name: 'x', schedule: 'every 1m', script: 'synthetic/digest.py' }) })
  record('enrollment refuses a non-login credential', modelRun.status === 401 || modelRun.status === 403, { status: modelRun.status })
  const digest = await enroll('synthetic-digest', 'synthetic/digest.py')
  const quiet = await enroll('synthetic-quiet', 'synthetic/quiet.py')
  const broken = await enroll('synthetic-broken', 'synthetic/broken.sh')
  const tree = await enroll('synthetic-tree', 'synthetic/tree.py')
  const editme = await enroll('synthetic-editme', 'synthetic/editme.py')
  const restart = await enroll('synthetic-restart', 'synthetic/restart.sh')
  const control = /Created job: (\S+)/.exec(hermes('cron', 'create', '--name', 'native-control', '--deliver', 'local', '--no-agent',
    '--script', 'synthetic/control.py', 'every 1m').stdout.replace(/\u001b\[[0-9;]*m/g, ''))?.[1]
  const afterRestart = JSON.parse(readFileSync(join(dirs.hermes, 'cron', 'jobs.json'), 'utf8'))
  record('the original target is validated by Hermes: a gateway-restart script is refused and no job exists', restart.status === 422
    && restart.json?.error === 'native_create_rejected' && !(Array.isArray(afterRestart) ? afterRestart : afterRestart.jobs).some(job => job.name === 'synthetic-restart'),
    { status: restart.status, body: restart.text.slice(0, 300) })
  // Edited after enrollment: the wrapper must refuse to run it.
  writeFileSync(join(scripts, 'editme.py'), 'open("editme.ran", "w").write("edited")\nprint("EDITED")\n')
  for (const [label, res] of [['digest', digest], ['quiet', quiet], ['broken', broken], ['tree', tree], ['editme', editme]]) {
    record(`enroll ${label}: native job created paused, verified by id, resumed`, res.status === 201 && res.json?.binding?.state === 'active'
      && res.json?.job?.no_agent === true && res.json?.job?.enabled === true && res.json?.job?.deliver === 'local', { status: res.status, body: res.text.slice(0, 300) })
  }
  const jobsFile = JSON.parse(readFileSync(join(dirs.hermes, 'cron', 'jobs.json'), 'utf8'))
  const nativeJobs = Array.isArray(jobsFile) ? jobsFile : jobsFile.jobs
  record('native job stores the generated wrapper under the profile scripts directory', nativeJobs.filter(job => job.id !== control)
    .every(job => /^ekko-script-reports\/[0-9a-f-]{36}\.py$/.test(job.script)),
    { scripts: nativeJobs.map(job => job.script) })

  // Native scheduler: one natural scheduled fire of every job (due after 1 minute), then a manual run of one job.
  const lastDue = Math.max(...nativeJobs.map(job => Date.parse(job.next_run_at || '') || Date.now() + 60_000))
  await delay(Math.max(0, lastDue - Date.now()) + 3000)
  const tick1 = hermes('cron', 'tick')
  record('original Hermes scheduler tick ran the due no_agent jobs', tick1.status === 0, { stdout: tick1.stdout.slice(-600), stderr: tick1.stderr.slice(-600) })
  hermes('cron', 'run', digest.json.binding.job_id)
  const tick2 = hermes('cron', 'tick')
  record('manual run fired through the same scheduler', tick2.status === 0)

  const notices = () => studioRows("SELECT * FROM session_notifications WHERE kind='script_report' ORDER BY id")
  await waitFor(() => notices().length >= 4, 90_000, 'imported reports')
  await delay(16_000) // one more import pass: nothing else may arrive
  const rows = notices()
  const payloads = rows.map(row => ({ ...row, payload: JSON.parse(row.payload) }))
  const byJob = id => payloads.filter(row => row.payload.job_id === id)
  const executions = hermesRows('SELECT job_id, status, error, source FROM executions ORDER BY claimed_at')
  const runs = id => executions.filter(row => row.job_id === id)
  const digestRows = byJob(digest.json.binding.job_id)
  record('success stdout delivered as a passive notice for every invocation (scheduled + manual)', digestRows.length === runs(digest.json.binding.job_id).length
    && runs(digest.json.binding.job_id).some(row => row.source === 'builtin') && runs(digest.json.binding.job_id).some(row => row.source === 'direct')
    && digestRows.every(row => row.disposition === 'notified' && row.payload.content === 'SYNTHETIC_DIGEST cwd=synthetic'),
    { contents: digestRows.map(row => row.payload.content) })
  record('distinct wrapper invocation ids, native_execution_id null, no scheduled-only claim',
    new Set(digestRows.map(row => row.payload.invocation_id)).size === digestRows.length && payloads.every(row => row.payload.native_execution_id === null
      && row.payload.identity_kind === 'wrapper_invocation' && !('scheduled_instant' in row.payload) && !('execution_id' in row.payload)))
  const quietRows = byJob(quiet.json.binding.job_id)
  record('wakeAgent=false recorded as silence: not shown, no attention', quietRows.length === runs(quiet.json.binding.job_id).length
    && quietRows.length > 0 && quietRows.every(row => row.disposition === 'silent' && row.attention_pending === 0), { quiet: quietRows.map(row => row.disposition) })
  const brokenRows = byJob(broken.json.binding.job_id)
  record('nonzero exit delivered as a failure with the native exit code', brokenRows.length === runs(broken.json.binding.job_id).length
    && brokenRows.length > 0 && brokenRows.every(row => row.disposition === 'notified' && row.payload.outcome === 'failed' && row.payload.exit_code === 4),
    { payload: brokenRows[0]?.payload })
  const spoolAndInbox = [...walk(join(dirs.studio, 'script-reports')).map(file => readFileSync(file, 'utf8')), JSON.stringify(rows)].join('\n')
  record('synthetic secret never stored in the Studio spool or inbox', !spoolAndInbox.includes(SECRET)
    && brokenRows.every(row => row.payload.content.includes('[REDACTED')))

  record('unwrapped native control job ran in the same ticks and produced no report', runs(control).length > 0
    && runs(control).every(row => row.status === 'completed') && byJob(control).length === 0, { control: runs(control) })
  const edited = executions.find(row => row.job_id === editme.json.binding.job_id)
  record('an edited target is refused before launch; the native run fails visibly and nothing is reported', edited?.status === 'failed'
    && String(edited.error).includes('target script changed since enrollment') && !existsSync(join(scripts, 'editme.ran'))
    && byJob(editme.json.binding.job_id).length === 0, { edited })
  const timedOut = executions.find(row => row.job_id === tree.json.binding.job_id)
  const grandchild = Number(readFileSync(grandchildPid, 'utf8'))
  const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
  record('native script timeout kills the wrapper, target and descendant; no notice, never inferred', timedOut?.status === 'failed'
    && /timed out/i.test(String(timedOut.error)) && !alive(grandchild) && byJob(tree.json.binding.job_id).length === 0,
    { timedOut, grandchild_alive: alive(grandchild) })
  record('native ledger keeps its own semantics (failure stays failed with its native error)', executions.some(row => row.job_id === broken.json.binding.job_id
    && row.status === 'failed' && String(row.error).includes('Script exited with code 4')) && executions.filter(row => row.job_id === digest.json.binding.job_id).every(row => row.status === 'completed'),
    { executions: executions.map(row => ({ job: row.job_id, status: row.status, source: row.source })) })
  const outputDocs = walk(join(dirs.hermes, 'cron', 'output', digest.json.binding.job_id)).map(file => readFileSync(file, 'utf8'))
  record('native output documents still receive the relayed stdout', outputDocs.length >= 1 && outputDocs.every(doc => doc.includes('SYNTHETIC_DIGEST cwd=synthetic')))

  const page = await api(`/api/studio/sessions/conversations/${session}/messages/paginated?offset=0&limit=50`)
  const visible = (page.json?.messages || []).filter(message => message.studio_notice?.kind === 'script_report')
  record('timeline shows output and failure notices, not silence', visible.length === digestRows.length + brokenRows.length && visible.every(message => message.studio_notice.identity_kind === 'wrapper_invocation'),
    { visible: visible.map(message => message.studio_notice.outcome) })
  const liveNotices = events.filter(e => e.event === 'session.notice' && e.payload?.message?.studio_notice?.kind === 'script_report')
  record('live session.notice events reached the viewer', liveNotices.length >= 1, { live: liveNotices.length })
  record('no model request after setup (no model turn from any report)', modelRequests.length === setupRequests,
    { setup: setupRequests, total: modelRequests.length })
  record('no run started by a report', !events.slice(setupEvents).some(e => e.event === 'run.started' || e.event === 'run.queued'))

  // Revocation: wrapper becomes a passthrough; the native job is paused.
  const revoked = await api(`/api/hermes/script-reports/enrollments/${digest.json.binding.binding_id}/revoke`, { method: 'POST', body: '{}' })
  const pausedJob = JSON.parse(readFileSync(join(dirs.hermes, 'cron', 'jobs.json'), 'utf8'))
  const job = (Array.isArray(pausedJob) ? pausedJob : pausedJob.jobs).find(item => item.id === digest.json.binding.job_id)
  record('revocation pauses the native job', revoked.json?.binding?.state === 'revoked' && revoked.json?.native_job_paused === true && job.enabled === false)
  const health = await api('/api/hermes/script-reports/enrollments?profile=default')
  const bindings = health.json?.bindings || []
  record('health lists every binding (the refused one as failed); only the timed-out invocation is incomplete', bindings.length === 6
    && bindings.find(binding => binding.job_name === 'synthetic-restart')?.state === 'failed'
    && bindings.find(binding => binding.job_name === 'synthetic-restart')?.job_id === null
    && bindings.every(binding => binding.incomplete.length === (binding.binding_id === tree.json.binding.binding_id ? runs(tree.json.binding.job_id).length : 0)),
    { bindings: bindings.map(b => ({ name: b.job_name, state: b.state, imported: b.imported, incomplete: b.incomplete.length })) })
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
    writeFileSync(join(evidenceDir, 'script-reports-e2e-results.json'), JSON.stringify({ root, results }, null, 2))
    for (const file of walk(dirs.logs)) writeFileSync(join(evidenceDir, `script-reports-e2e-${file.split('/').pop()}`), readFileSync(file))
  }
  if (!process.env.E2E_KEEP_ROOT) rmSync(root, { recursive: true, force: true })
}
const failed = results.filter(item => !item.ok)
console.log(`${results.length - failed.length}/${results.length} checks passed`)
process.exit(failure || failed.length ? 1 : 0)
