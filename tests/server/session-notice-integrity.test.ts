import './fixtures/isolated-studio-state'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

// Notice integrity on real storage: destination-bound duplicates, silent records never published live,
// and exactly-one-page History placement for non-monotonic stored timestamps.
const ROOT = '../../packages/server/src/modules/studio'

let db: DatabaseSync
let m: any

beforeEach(async () => {
  vi.resetModules()
  db = new DatabaseSync(':memory:')
  vi.doMock(`${ROOT}/infrastructure/database/index`, () => ({ getDb: () => db, isSqliteAvailable: () => true, getStoragePath: () => ':memory:' }))
  const { initAllHermesTables } = await import(`${ROOT}/infrastructure/database/schemas`)
  initAllHermesTables()
  m = {
    store: await import(`${ROOT}/repositories/session-store`),
    inbox: await import(`${ROOT}/repositories/session-notification-store`),
    presentation: await import(`${ROOT}/services/session-notifications/presentation`),
  }
  m.store.createSession({ id: 'chat-1', profile: 'default', source: 'cli' })
})

afterEach(() => {
  db.close()
  vi.doUnmock(`${ROOT}/infrastructure/database/index`)
})

function accept(overrides: Record<string, unknown> = {}) {
  return m.inbox.acceptFencedSessionNotification({
    namespace: 'inst-1', profile: 'default', producerKey: 'external:k1', sessionId: 'chat-1',
    expectedGeneration: m.store.getSessionGeneration('chat-1'), kind: 'external',
    payload: { source: 'svc', event_id: 'e1', title: 'Done', content: 'hello', url: null }, ...overrides,
  })
}

describe('session notice integrity', () => {
  it('binds a key to its destination: the same content for another session or generation is a conflict', () => {
    m.store.createSession({ id: 'chat-2', profile: 'default', source: 'cli' })
    expect(accept().status).toBe('accepted')
    expect(accept({ sessionId: 'chat-2', expectedGeneration: m.store.getSessionGeneration('chat-2') }).status).toBe('conflict')
    m.store.clearSessionMessages('chat-1')
    expect(accept({ expectedGeneration: m.store.getSessionGeneration('chat-1') }).status).toBe('conflict')
    expect(db.prepare('SELECT COUNT(*) AS n FROM session_notifications').get()).toEqual({ n: 1 })
  })

  it('never publishes a silent record live', async () => {
    const { ChatRunSocket } = await import(`${ROOT}/sockets/chat-run`)
    const sent: string[] = []
    const fake = Object.create(ChatRunSocket.prototype)
    Object.assign(fake, { nsp: { sockets: new Map([['s1', { id: 's1', data: {}, emit: (event: string) => sent.push(event) }]]),
      adapter: { rooms: new Map([['session:chat-1', new Set(['s1'])]]) } }, sessionStateSync: { publish: vi.fn() } })
    const { record } = accept({ producerKey: 'external:silent', disposition: 'silent' })
    fake.publishSessionNotice(record)
    expect(sent).toEqual([])
    expect(fake.sessionStateSync.publish).not.toHaveBeenCalled()
  })

  it('keeps exactly-one-page placement and stored order when stored timestamps are not monotonic', () => {
    for (const ts of [10, 80, 20, 100]) m.store.addMessage({ session_id: 'chat-1', role: 'user', content: `t${ts}`, timestamp: ts })
    accept({ producerKey: 'external:mid', now: 50 * 1000 })
    const page = (offset: number) => {
      const stored = db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY id DESC LIMIT 1 OFFSET ?').all('chat-1', offset) as any[]
      return m.presentation.withSessionNotices('chat-1', stored.reverse(), { offset, storedCount: stored.length })
    }
    expect([0, 1, 2, 3].map(page).map(rows => rows.filter((row: any) => row.studio_notice).length)).toEqual([0, 0, 1, 0])
    const all = db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY id').all('chat-1') as any[]
    const merged = m.presentation.withSessionNotices('chat-1', all, { offset: 0, storedCount: all.length })
    expect(merged.filter((row: any) => !row.studio_notice).map((row: any) => row.content)).toEqual(['t10', 't80', 't20', 't100'])
  })
})
