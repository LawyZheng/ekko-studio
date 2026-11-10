import './fixtures/isolated-studio-state'
import { expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

// Same database stand-in as the manual-unread suite: only getDb, and no session goal table at all.
const state = vi.hoisted(() => ({ db: null as DatabaseSync | null }))
vi.mock('../../packages/server/src/modules/studio/infrastructure/database', () => ({ getDb: () => state.db }))
import { SessionStateSync } from '../../packages/server/src/modules/studio/services/session-state'

it('keeps read and working state when the task lifecycle summary cannot be read', () => {
  state.db = new DatabaseSync(':memory:')
  state.db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,profile TEXT DEFAULT 'default',source TEXT DEFAULT 'cli',studio_user_id TEXT,generation_id TEXT NOT NULL DEFAULT '');
    CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT,role TEXT,content TEXT);
    INSERT INTO sessions(id) VALUES ('chat'); INSERT INTO messages(session_id,role,content) VALUES ('chat','assistant','Result');`)
  const sync = new SessionStateSync(() => ({ working: false, backgroundPending: 0 }), () => true, () => true)
  const [chat] = (sync as any).states({ id: 1, username: 'u', role: 'super_admin' })
  expect(chat).toMatchObject({ sessionId: 'chat', working: false, unread: true, lastMessageId: 1 })
  expect(chat.task).toBeUndefined()
})
