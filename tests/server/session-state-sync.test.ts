import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import { io as connect, type Socket } from 'socket.io-client'
import type { SessionListState } from '../../packages/shared/session-state'

const state = vi.hoisted(() => ({ db: null as DatabaseSync | null }))
vi.mock('../../packages/server/src/modules/studio/infrastructure/database', () => ({ getDb: () => state.db }))
import { SessionStateSync } from '../../packages/server/src/modules/studio/services/session-state'
import { listSessionStateRecords, recordSessionAttention } from '../../packages/server/src/modules/studio/repositories/session-state-store'

let server: Server
let sync: SessionStateSync
let origin: string
const clients: Socket[] = []
const runtime = new Map<string, { working: boolean; backgroundPending: number }>()
const inactiveAccounts = new Set<number>()
const SCHEMA = `PRAGMA foreign_keys=ON;
    CREATE TABLE sessions(id TEXT PRIMARY KEY,profile TEXT DEFAULT 'default',source TEXT DEFAULT 'cli',studio_user_id TEXT,generation_id TEXT NOT NULL DEFAULT '');
    CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT,role TEXT,content TEXT);
    INSERT INTO sessions(id) VALUES ('chat');
    INSERT INTO sessions(id,profile) VALUES ('research','research');
    INSERT INTO sessions(id,studio_user_id) VALUES ('person-main-one','1'),('person-main-two','2');
    INSERT INTO sessions(id,source) VALUES ('group','group_chat'),('workflow','workflow'),('global','global_agent'),('person-task-hidden','builtin_agent');`
// Like production, only stored, active accounts pass the current-account check.
function createSync() {
  return new SessionStateSync(id => runtime.get(id) || { working: false, backgroundPending: 0 },
    (user, profile) => profile === 'default' || user.id === 1, user => [1, 2].includes(user.id) && !inactiveAccounts.has(user.id))
}
function once<T = any>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Missing ${event}`)), 3000)
    socket.once(event, value => { clearTimeout(timer); resolve(value) })
  })
}
async function device(user = 1) {
  const socket = connect(`${origin}/chat-run`, { autoConnect: false, transports: ['websocket'],
    query: { session_state: '1' }, auth: { user } })
  clients.push(socket)
  const snapshot = once<{ sessions: SessionListState[] }>(socket, 'sessions.state.snapshot')
  socket.connect()
  return { socket, snapshot: (await snapshot).sessions }
}
function assistant(sessionId: string, content = 'Result') {
  return Number(state.db!.prepare("INSERT INTO messages(session_id,role,content) VALUES (?,'assistant',?)").run(sessionId, content).lastInsertRowid)
}
function generationOf(sessionId: unknown) {
  return (state.db!.prepare('SELECT generation_id FROM sessions WHERE id=?').get(String(sessionId)) as { generation_id?: string } | undefined)?.generation_id
}
function read(socket: Socket, sessionId: string, messageId: number, attentionId?: number, unreadRevision?: unknown, generation = generationOf(sessionId)) {
  return new Promise<{ ok: boolean }>(resolve => socket.emit('sessions.read', { sessionId, messageId, attentionId, unreadRevision, generation }, resolve))
}
function markUnread(socket: Socket, sessionId: unknown, unreadRevision: unknown, generation = generationOf(sessionId)) {
  return new Promise<{ ok: boolean; changed?: boolean } | 'timeout'>(resolve => socket.timeout(1500)
    .emit('sessions.unread', { sessionId, unreadRevision, generation }, (err: Error | null, result: { ok: boolean; changed?: boolean }) => resolve(err ? 'timeout' : result)))
}
function stateOf(sessions: SessionListState[], sessionId: string) {
  return sessions.find(s => s.sessionId === sessionId)!
}

beforeEach(async () => {
  state.db = new DatabaseSync(':memory:')
  state.db.exec(SCHEMA)
  runtime.clear(); inactiveAccounts.clear()
  sync = createSync()
  const http = createServer()
  server = new Server(http)
  const namespace = server.of('/chat-run')
  namespace.use((socket, next) => {
    if (Number(socket.handshake.auth.user) > 0) socket.data.user = { id: Number(socket.handshake.auth.user), username: 'test', role: 'user' }
    next()
  })
  namespace.on('connection', socket => sync.attach(socket))
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(http.address() as any).port}`
})
afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect()
  sync.close()
  await new Promise<void>(resolve => server.close(() => resolve()))
  state.db?.close()
})

describe('account session state over Socket.IO', () => {
  it('migrates existing message receipts without losing their read position', async () => {
    const messageId = assistant('chat')
    state.db!.exec(`CREATE TABLE session_read_state(user_id INTEGER,session_id TEXT,message_id INTEGER,PRIMARY KEY(user_id,session_id))`)
    state.db!.prepare('INSERT INTO session_read_state VALUES (1,?,?)').run('chat', messageId)
    const a = await device()
    expect(a.snapshot.find(s => s.sessionId === 'chat')).toMatchObject({
      unread: false, readMessageId: messageId, lastAttentionId: 0, readAttentionId: 0,
    })
  })

  it('persists distinct collaboration notices and never clears a newer handoff with a stale receipt', async () => {
    recordSessionAttention('person-main-one', 'stage:first')
    let a = await device()
    const first = a.snapshot.find(s => s.sessionId === 'person-main-one')!
    expect(first).toMatchObject({ unread: true, lastMessageId: 0 })
    await read(a.socket, first.sessionId, 0, first.lastAttentionId)
    recordSessionAttention('person-main-one', 'stage:first')
    a = await device()
    expect(a.snapshot.find(s => s.sessionId === first.sessionId)).toMatchObject({ unread: false, lastAttentionId: first.lastAttentionId })
    recordSessionAttention(first.sessionId, 'stage:second')
    await read(a.socket, first.sessionId, 0, first.lastAttentionId)
    await read(a.socket, first.sessionId, 0) // An older client cannot acknowledge unseen notices.
    a = await device()
    expect(a.snapshot.find(s => s.sessionId === first.sessionId)?.unread).toBe(true)
    await read(a.socket, first.sessionId, 0, Number.MAX_SAFE_INTEGER)
    const beforeNew = listSessionStateRecords(1, first.sessionId)[0]
    expect(beforeNew.readAttentionId).toBe(beforeNew.lastAttentionId)
    recordSessionAttention(first.sessionId, 'stage:third')
    a = await device()
    expect(a.snapshot.find(s => s.sessionId === first.sessionId)?.unread).toBe(true)
  })

  it('ignores legacy internal handoff notices while retaining completion notices', async () => {
    recordSessionAttention('person-main-one', 'person-stage:legacy:0')
    const a = await device()
    expect(a.snapshot.find(s => s.sessionId === 'person-main-one')).toMatchObject({ unread: false, lastAttentionId: 0 })
    recordSessionAttention('person-main-one', 'person-flow-completed:relay:0')
    const updated = once<SessionListState>(a.socket, 'sessions.state.updated')
    sync.publish('person-main-one')
    const completed = await updated
    expect(completed).toMatchObject({ unread: true, lastMessageId: 0 })
    expect(await read(a.socket, completed.sessionId, 0, completed.lastAttentionId)).toEqual({ ok: true })
  })

  it('synchronizes ordinary chats in login-disabled installations without exposing private Person sessions', async () => {
    const messageId = assistant('chat')
    const a = await device(0), b = await device(0)
    expect(a.snapshot.map(s => s.sessionId)).toEqual(['chat'])
    const changed = once<SessionListState>(b.socket, 'sessions.state.updated')
    expect(await read(a.socket, 'chat', messageId)).toEqual({ ok: true })
    expect(await changed).toMatchObject({ unread: false, readMessageId: messageId })
  })
  it.each(['chat', 'person-main-one'])('keeps %s breathing across devices until background work settles', async sessionId => {
    const a = await device(), b = await device()
    let first = once<SessionListState>(a.socket, 'sessions.state.updated')
    let second = once<SessionListState>(b.socket, 'sessions.state.updated')
    sync.observe('run.started', { session_id: sessionId })
    expect(await first).toMatchObject({ sessionId, working: true })
    expect(await second).toMatchObject({ sessionId, working: true })
    const messageId = assistant(sessionId)
    first = once(a.socket, 'sessions.state.updated'); second = once(b.socket, 'sessions.state.updated')
    sync.observe('run.completed', { session_id: sessionId, background_pending: 2 })
    expect(await first).toMatchObject({ working: true, backgroundPending: 2, unread: false, lastMessageId: messageId })
    expect(await second).toMatchObject({ working: true, backgroundPending: 2, unread: false })
    const reconnect = await device()
    expect(reconnect.snapshot.find(s => s.sessionId === sessionId)).toMatchObject({ working: true, backgroundPending: 2, unread: false })
    expect(await read(a.socket, sessionId, messageId)).toEqual({ ok: false })
    second = once(b.socket, 'sessions.state.updated')
    sync.observe('delegation.updated', { session_id: sessionId, background_pending: 0 })
    expect(await second).toMatchObject({ working: false, backgroundPending: 0, unread: true })
    second = once(b.socket, 'sessions.state.updated')
    expect(await read(a.socket, sessionId, messageId)).toEqual({ ok: true })
    expect(await second).toMatchObject({ working: false, backgroundPending: 0, unread: false })
  })

  it.each(['run.completed', 'run.failed', 'abort.completed'])('defers partial-message unread until %s', async event => {
    const a = await device()
    const started = once<SessionListState>(a.socket, 'sessions.state.updated')
    sync.observe('run.started', { session_id: 'chat' })
    await started
    const messageId = assistant('chat', 'Partial response')
    const interim = once<SessionListState>(a.socket, 'sessions.state.updated')
    sync.observe('message.interim', { session_id: 'chat' })
    expect(await interim).toMatchObject({ working: true, unread: false, lastMessageId: messageId, readMessageId: 0 })
    expect(await read(a.socket, 'chat', messageId)).toEqual({ ok: false })
    const terminal = once<SessionListState>(a.socket, 'sessions.state.updated')
    sync.observe(event, { session_id: 'chat' })
    expect(await terminal).toMatchObject({ working: false, unread: true, lastMessageId: messageId, readMessageId: 0 })
  })

  it('persists read cursors and does not acknowledge newer messages from a delayed device', async () => {
    const a = await device()
    const old = assistant('chat')
    const latest = assistant('chat')
    expect(await read(a.socket, 'chat', old)).toEqual({ ok: true })
    let b = await device()
    expect(b.snapshot.find(s => s.sessionId === 'chat')).toMatchObject({ unread: true, lastMessageId: latest, readMessageId: old })
    await read(b.socket, 'chat', latest)
    await read(a.socket, 'chat', old)
    // A new service instance, like a process restart, reads the same persisted cursor.
    sync.close()
    sync = new SessionStateSync(() => ({ working: false, backgroundPending: 0 }), () => true)
    b = await device()
    expect(b.snapshot.find(s => s.sessionId === 'chat')).toMatchObject({ unread: false, readMessageId: latest })
    await read(b.socket, 'chat', Number.MAX_SAFE_INTEGER)
    const newer = assistant('chat')
    b = await device()
    expect(b.snapshot.find(s => s.sessionId === 'chat')).toMatchObject({ unread: true, lastMessageId: newer, readMessageId: latest })
  })

  it('isolates accounts, private Person sessions and Profile access', async () => {
    const one = assistant('person-main-one')
    assistant('person-main-two')
    const a = await device(), b = await device(2)
    expect(a.snapshot.map(s => s.sessionId)).toEqual(['chat', 'research', 'person-main-one'])
    expect(a.snapshot.find(s => s.sessionId === 'research')?.profile).toBe('research')
    expect(a.snapshot.find(s => s.sessionId === 'chat')?.profile).toBe('default')
    expect(b.snapshot.map(s => s.sessionId)).toEqual(['chat', 'person-main-two'])
    expect(await read(b.socket, 'person-main-one', one)).toEqual({ ok: false })
    expect(await read(b.socket, 'research', 0)).toEqual({ ok: false })
    for (const cursor of [-1, NaN, 1.5]) expect(await read(a.socket, 'chat', cursor)).toEqual({ ok: false })
    const normal = assistant('chat')
    await read(a.socket, 'chat', normal)
    const other = await device(2)
    expect(other.snapshot.find(s => s.sessionId === 'chat')?.unread).toBe(true)
    state.db!.prepare("DELETE FROM sessions WHERE id='chat'").run()
    expect(listSessionStateRecords(1).some(s => s.id === 'chat')).toBe(false)
    expect(state.db!.prepare("SELECT * FROM session_read_state WHERE session_id='chat'").all()).toEqual([])
  })

  it('snapshots background activity without requiring any device to open its transcript', async () => {
    runtime.set('chat', { working: false, backgroundPending: 3 })
    runtime.set('person-main-one', { working: false, backgroundPending: 2 })
    const a = await device()
    expect(a.snapshot.find(s => s.sessionId === 'chat')).toMatchObject({ working: true, backgroundPending: 3 })
    expect(a.snapshot.find(s => s.sessionId === 'person-main-one')).toMatchObject({ working: true, backgroundPending: 2 })
    runtime.set('person-main-one', { working: false, backgroundPending: 0 })
    const changed = once<{ sessions: SessionListState[] }>(a.socket, 'sessions.state.snapshot')
    sync.refreshPerson(1)
    expect((await changed).sessions.find(s => s.sessionId === 'person-main-one')).toMatchObject({ working: false, backgroundPending: 0 })
  })

  it.each(['run.failed', 'abort.completed'])('clears foreground activity on %s while retaining queued background work', async event => {
    const a = await device()
    let changed = once<SessionListState>(a.socket, 'sessions.state.updated')
    sync.observe('run.started', { session_id: 'chat' })
    expect(await changed).toMatchObject({ working: true })
    changed = once(a.socket, 'sessions.state.updated')
    sync.observe(event, { session_id: 'chat', background_pending: 1 })
    expect(await changed).toMatchObject({ working: true, backgroundPending: 1 })
    changed = once(a.socket, 'sessions.state.updated')
    sync.observe('delegation.updated', { session_id: 'chat', background_pending: 0 })
    expect(await changed).toMatchObject({ working: false })
  })

  it('clears a queued continuation when its last queued message is cancelled', async () => {
    const a = await device()
    let changed = once<SessionListState>(a.socket, 'sessions.state.updated')
    sync.observe('run.completed', { session_id: 'chat', queue_remaining: 1 })
    expect(await changed).toMatchObject({ working: true })
    changed = once(a.socket, 'sessions.state.updated')
    sync.observe('run.queued', { session_id: 'chat', queue_length: 0 })
    expect(await changed).toMatchObject({ working: false })
  })
})

describe('manual unread', () => {
  it.each(['chat', 'person-main-one'])('marks read %s unread for every device of the same account only', async sessionId => {
    const messageId = assistant(sessionId)
    const a = await device(), b = await device(), other = await device(2)
    expect(await read(a.socket, sessionId, messageId)).toEqual({ ok: true })
    const before = stateOf((await device()).snapshot, sessionId)
    expect(before).toMatchObject({ unread: false, manualUnread: false, unreadRevision: 0 })
    const seenByB = once<SessionListState>(b.socket, 'sessions.state.updated')
    let otherUpdated = false
    other.socket.on('sessions.state.updated', () => { otherUpdated = true })
    expect(await markUnread(a.socket, sessionId, before.unreadRevision)).toEqual({ ok: true, changed: true })
    const marked = await seenByB
    expect(marked).toMatchObject({ sessionId, unread: true, manualUnread: true, readMessageId: messageId, lastMessageId: messageId })
    expect(marked.unreadRevision).toBeGreaterThan(0)
    expect(otherUpdated).toBe(false)
    if (sessionId === 'chat') expect(stateOf((await device(2)).snapshot, 'chat')).toMatchObject({ manualUnread: false })
    // Reconnect and a new service instance (process restart) keep the mark.
    sync.close(); sync = createSync()
    expect(stateOf((await device()).snapshot, sessionId)).toMatchObject({ unread: true, manualUnread: true, unreadRevision: marked.unreadRevision })
  })

  it('keeps the mark across a database reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'manual-unread-'))
    try {
      state.db!.close()
      state.db = new DatabaseSync(join(dir, 'studio.db'))
      state.db.exec(SCHEMA)
      const messageId = assistant('chat')
      const a = await device()
      await read(a.socket, 'chat', messageId)
      expect(await markUnread(a.socket, 'chat', 0)).toEqual({ ok: true, changed: true })
      for (const client of clients.splice(0)) client.disconnect()
      sync.close(); state.db.close()
      state.db = new DatabaseSync(join(dir, 'studio.db'))
      sync = createSync()
      expect(stateOf((await device()).snapshot, 'chat')).toMatchObject({ unread: true, manualUnread: true, readMessageId: messageId })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fences stale and passive receipts and only clears the mark for the revision that was opened', async () => {
    const messageId = assistant('chat')
    const a = await device(), b = await device()
    await read(a.socket, 'chat', messageId)
    expect(await markUnread(a.socket, 'chat', 0)).toEqual({ ok: true, changed: true })
    const revision = stateOf((await device()).snapshot, 'chat').unreadRevision!
    // A delayed receipt from before the mark, a passive receipt without a revision and an older revision.
    for (const stale of [undefined, 0, revision - 1]) {
      expect(await read(b.socket, 'chat', messageId, 0, stale)).toEqual({ ok: true })
      expect(stateOf((await device()).snapshot, 'chat')).toMatchObject({ unread: true, manualUnread: true })
    }
    for (const invalid of [-1, 1.5, 'x']) expect(await read(b.socket, 'chat', messageId, 0, invalid)).toEqual({ ok: false })
    const cleared = once<SessionListState>(a.socket, 'sessions.state.updated')
    expect(await read(b.socket, 'chat', messageId, 0, revision)).toEqual({ ok: true })
    expect(await cleared).toMatchObject({ unread: false, manualUnread: false, unreadRevision: revision })
    // A retried copy of the original request cannot re-arm the mark after the intentional read.
    expect(await markUnread(a.socket, 'chat', 0)).toEqual({ ok: true, changed: false })
    expect(stateOf((await device()).snapshot, 'chat')).toMatchObject({ unread: false, manualUnread: false })
    // A new mark from the current revision works again, and a duplicate of it is a no-op.
    expect(await markUnread(a.socket, 'chat', revision)).toEqual({ ok: true, changed: true })
    const again = stateOf((await device()).snapshot, 'chat')
    expect(again.unreadRevision).toBeGreaterThan(revision)
    expect(await markUnread(b.socket, 'chat', revision)).toEqual({ ok: true, changed: false })
    expect(stateOf((await device()).snapshot, 'chat').unreadRevision).toBe(again.unreadRevision)
  })

  it('keeps cursors monotonic: new replies stay unread and a stale receipt cannot clear a newer reply', async () => {
    const first = assistant('chat')
    const a = await device()
    await read(a.socket, 'chat', first)
    await markUnread(a.socket, 'chat', 0)
    const revision = stateOf((await device()).snapshot, 'chat').unreadRevision!
    const second = assistant('chat')
    expect(await read(a.socket, 'chat', second, 0, revision)).toEqual({ ok: true })
    expect(stateOf((await device()).snapshot, 'chat')).toMatchObject({ unread: false, manualUnread: false, readMessageId: second })
    expect(listSessionStateRecords(1, 'chat')[0]).toMatchObject({ readMessageId: second, readAttentionId: 0 })
  })

  it('allows empty conversations and rejects already unread, working, unknown or excluded sessions', async () => {
    const a = await device()
    expect(stateOf(a.snapshot, 'chat')).toMatchObject({ unread: false, lastMessageId: 0 })
    expect(await markUnread(a.socket, 'chat', 0)).toEqual({ ok: true, changed: true })
    expect(stateOf((await device()).snapshot, 'chat')).toMatchObject({ unread: true, manualUnread: true, lastMessageId: 0, readMessageId: 0 })
    assistant('person-main-one')
    expect(await markUnread(a.socket, 'person-main-one', 0)).toEqual({ ok: true, changed: false })
    expect(stateOf((await device()).snapshot, 'person-main-one')).toMatchObject({ manualUnread: false })
    runtime.set('research', { working: true, backgroundPending: 0 })
    expect(await markUnread(a.socket, 'research', 0)).toEqual({ ok: false })
    runtime.set('research', { working: false, backgroundPending: 1 })
    expect(await markUnread(a.socket, 'research', 0)).toEqual({ ok: false })
    for (const id of ['missing', 'group', 'workflow', 'global', 'person-task-hidden', 42]) {
      expect(await markUnread(a.socket, id, 0)).toEqual({ ok: false })
    }
    for (const revision of [-1, 1.5, '0', null]) expect(await markUnread(a.socket, 'research', revision)).toEqual({ ok: false })
    expect(state.db!.prepare("SELECT COUNT(*) AS n FROM session_read_state WHERE manual_unread=1").get()).toEqual({ n: 1 })
  })

  it('verifies Person ownership, Profile membership and the current account before marking', async () => {
    const b = await device(2)
    expect(await markUnread(b.socket, 'person-main-one', 0)).toEqual({ ok: false })
    expect(await markUnread(b.socket, 'research', 0)).toEqual({ ok: false })
    expect(await markUnread(b.socket, 'person-main-two', 0)).toEqual({ ok: true, changed: true })
    inactiveAccounts.add(2)
    expect(await markUnread(b.socket, 'chat', 0)).toEqual({ ok: false })
    expect(state.db!.prepare('SELECT user_id, session_id FROM session_read_state WHERE manual_unread=1').all())
      .toEqual([{ user_id: 2, session_id: 'person-main-two' }])
    expect(stateOf((await device()).snapshot, 'person-main-one')).toMatchObject({ manualUnread: false })
  })

  it('fences requests for a deleted session from a recreated session with the same id', async () => {
    const a = await device()
    const old = stateOf(a.snapshot, 'chat')
    expect(old.generation).toEqual(expect.any(String))
    await markUnread(a.socket, 'chat', 0, old.generation)
    const oldRevision = stateOf((await device()).snapshot, 'chat').unreadRevision!
    state.db!.prepare("DELETE FROM sessions WHERE id='chat'").run()
    state.db!.prepare("INSERT INTO sessions(id) VALUES ('chat')").run()
    const recreated = stateOf((await device()).snapshot, 'chat')
    expect(recreated).toMatchObject({ manualUnread: false, unreadRevision: 0 })
    expect(recreated.generation).not.toBe(old.generation)
    // A delayed first mark for the old session does not apply to the new one.
    expect(await markUnread(a.socket, 'chat', 0, old.generation)).toEqual({ ok: true, changed: false })
    expect(stateOf((await device()).snapshot, 'chat').manualUnread).toBe(false)
    expect(await markUnread(a.socket, 'chat', 0, recreated.generation)).toEqual({ ok: true, changed: true })
    expect(stateOf((await device()).snapshot, 'chat').unreadRevision).toBe(oldRevision)
    // Even with an equal revision, a receipt for the old session cannot clear the new mark.
    expect(await read(a.socket, 'chat', 0, 0, oldRevision, old.generation)).toEqual({ ok: true })
    expect(stateOf((await device()).snapshot, 'chat')).toMatchObject({ unread: true, manualUnread: true })
    for (const generation of [null, 42]) expect(await markUnread(a.socket, 'chat', oldRevision, generation as any)).toEqual({ ok: false })
  })

  it('treats the login-disabled local scope as its own account', async () => {
    const local = await device(0), other = await device()
    expect(await markUnread(local.socket, 'chat', 0)).toEqual({ ok: true, changed: true })
    const revision = stateOf((await device(0)).snapshot, 'chat').unreadRevision!
    expect(stateOf((await device()).snapshot, 'chat').manualUnread).toBe(false)
    expect(await read(local.socket, 'chat', 0, 0, revision)).toEqual({ ok: true })
    expect(stateOf((await device(0)).snapshot, 'chat').manualUnread).toBe(false)
    void other
  })

  it('requires the current account to clear a mark', async () => {
    const messageId = assistant('chat')
    const a = await device()
    await read(a.socket, 'chat', messageId)
    await markUnread(a.socket, 'chat', 0)
    const revision = stateOf((await device()).snapshot, 'chat').unreadRevision!
    inactiveAccounts.add(1)
    await read(a.socket, 'chat', messageId, 0, revision)
    expect(listSessionStateRecords(1, 'chat')[0]).toMatchObject({ manualUnread: 1 })
    inactiveAccounts.delete(1)
    await read(a.socket, 'chat', messageId, 0, revision)
    expect(listSessionStateRecords(1, 'chat')[0]).toMatchObject({ manualUnread: 0 })
  })

  it('combines with notification attention without changing notices or messages', async () => {
    const a = await device()
    await markUnread(a.socket, 'person-main-one', 0)
    const revision = stateOf((await device()).snapshot, 'person-main-one').unreadRevision!
    recordSessionAttention('person-main-one', 'script-report:one')
    const marked = stateOf((await device()).snapshot, 'person-main-one')
    expect(marked).toMatchObject({ unread: true, manualUnread: true })
    // A passive receipt acknowledges the notice but leaves the manual reminder.
    await read(a.socket, 'person-main-one', 0, marked.lastAttentionId)
    expect(stateOf((await device()).snapshot, 'person-main-one')).toMatchObject({ unread: true, manualUnread: true, readAttentionId: marked.lastAttentionId })
    recordSessionAttention('person-main-one', 'script-report:one')
    await read(a.socket, 'person-main-one', 0, marked.lastAttentionId, revision)
    expect(stateOf((await device()).snapshot, 'person-main-one')).toMatchObject({ unread: false, manualUnread: false })
    expect(state.db!.prepare("SELECT COUNT(*) AS n FROM session_attention_events WHERE session_id='person-main-one'").get()).toEqual({ n: 1 })
    expect(state.db!.prepare("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 })
  })

  it('migrates read state rows created before manual unread', async () => {
    const messageId = assistant('chat')
    state.db!.exec(`CREATE TABLE session_read_state(user_id INTEGER NOT NULL,session_id TEXT NOT NULL,message_id INTEGER NOT NULL DEFAULT 0,
      attention_id INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(user_id,session_id))`)
    state.db!.prepare('INSERT INTO session_read_state VALUES (1,?,?,0)').run('chat', messageId)
    const a = await device()
    expect(stateOf(a.snapshot, 'chat')).toMatchObject({ unread: false, readMessageId: messageId, manualUnread: false, unreadRevision: 0 })
    expect(await markUnread(a.socket, 'chat', 0)).toEqual({ ok: true, changed: true })
    expect(listSessionStateRecords(1, 'chat')[0]).toMatchObject({ readMessageId: messageId, manualUnread: 1 })
  })
})
