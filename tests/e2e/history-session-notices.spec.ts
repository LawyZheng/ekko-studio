import { expect, test, type Page } from '@playwright/test'
import { containPage } from './fixtures/contained-page'
import { fakeChatRunSockets } from './fixtures/session-state-socket'

// History paging with passive Studio notices, on the real app shell with contained network and local answers.
// Data and paging mirror the server: stored rows by id DESC with offset/limit; a notice belongs to the page
// whose interval (timestamp of the next older stored row, timestamp of the page's newest row] contains it.
const historySessions = [
  { id: 'hist-alpha', profile: 'default', source: 'cli', model: 'test-model', provider: 'test-provider', title: 'Alpha History Session',
    preview: 'Alpha preview', started_at: 1_790_000_000, ended_at: null, last_active: 1_790_000_100, message_count: 4, tool_call_count: 2,
    input_tokens: 10, output_tokens: 20 },
  { id: 'hist-beta', profile: 'default', source: 'cli', model: 'test-model', provider: 'test-provider', title: 'Beta History Session',
    preview: 'Beta preview', started_at: 1_790_000_000, ended_at: null, last_active: 1_790_000_200, message_count: 4, tool_call_count: 0,
    input_tokens: 10, output_tokens: 20 },
]
const noticeSession = { ...historySessions[1], id: 'hist-notice', title: 'Notice History Session', message_count: 200, started_at: 10, last_active: 2000 }
const noticeStored = Array.from({ length: 200 }, (_, index) => ({
  id: index + 1, session_id: 'hist-notice', role: index % 2 ? 'assistant' : 'user', content: `Stored row ${index + 1}`,
  tool_call_id: null, tool_calls: null, tool_name: null, run_marker: null, timestamp: (index + 1) * 10,
  token_count: null, finish_reason: null, reasoning: null,
}))
function historyNotice(id: number, timestamp: number, view: Record<string, unknown>, content = '') {
  return {
    id: `studio-notice-${id}`, session_id: 'hist-notice', role: 'system', display_role: 'system', content, timestamp,
    studio_notice: { kind: 'cron', notification_id: id, disposition: 'notified', job_id: `job-${id}`, job_name: `Job ${id}`,
      execution_id: `exec-${id}`, status: 'completed', success: true, reason: null, error: null, truncated: false, finished_at: null, ...view },
  }
}
// Notices: three in the newest page (a result, an empty-answer failure, a status-only run), one
// between the two pages (gap), one equal to the older page's newest row, and one in the oldest page.
const historyNotices = [
  historyNotice(1, 1995, {}, 'Newest page result'),
  historyNotice(5, 1985, { status: 'failed', success: false, error: 'Synthetic provider failure' }),
  historyNotice(6, 1975, { disposition: 'status_only', status: 'completed', success: null, reason: 'output_unavailable_for_runtime' }),
  historyNotice(2, 505, {}, 'Gap result'),
  historyNotice(3, 500, {}, 'Equal timestamp result'),
  historyNotice(4, 15, {}, 'Oldest page result'),
]
// Mirrors the server: stored rows by id DESC with offset/limit; a notice belongs to the page whose
// interval (timestamp of the next older stored row, timestamp of the page's newest row] contains it.
function noticePage(offset: number, limit: number) {
  const newestFirst = [...noticeStored].reverse()
  const stored = newestFirst.slice(offset, offset + limit)
  const upper = offset > 0 ? newestFirst[offset]?.timestamp ?? Infinity : Infinity
  const lower = newestFirst[offset + stored.length]?.timestamp ?? -Infinity
  const notices = historyNotices.filter(notice => notice.timestamp > lower && notice.timestamp <= upper)
  const messages = [...stored.reverse(), ...notices].sort((a, b) => a.timestamp - b.timestamp)
  return { session: noticeSession, messages, taskPlans: [], workspaceRunChanges: [], total: noticeStored.length, offset, limit,
    hasMore: offset + stored.length < noticeStored.length }
}

async function openHistory(page: Page) {
  await page.addInitScript(() => { localStorage.setItem('hermes_locale', 'en'); localStorage.setItem('hermes_api_key', 'journey-key'); (window as any).__APP_VERSION__ = 'test' })
  const sessions = [...historySessions, noticeSession]
  await containPage(page, path => {
    if (path === '/api/auth/me') return { user: { id: 1, username: 'playwright', role: 'super_admin', status: 'active' } }
    if (path === '/api/hermes/profiles') return { profiles: [{ name: 'default', active: true, model: 'test-model', gateway: 'test' }] }
    if (path === '/api/hermes/available-models') return { default: 'test-model', default_provider: 'test-provider',
      groups: [{ provider: 'test-provider', label: 'Test Provider', models: ['test-model'], available_models: ['test-model'] }] }
    if (path === '/api/studio/sessions/hermes/groups') return { groups: [{ source: 'cli', sessions, hasMore: false }], included: [noticeSession] }
    const detail = path.match(/^\/api\/studio\/sessions\/hermes\/([^/]+)$/)
    if (detail) return { session: sessions.find(session => session.id === decodeURIComponent(detail[1])) }
    return {}
  })
  await fakeChatRunSockets(page)
}

for (const { name, width, height } of [{ name: 'desktop', width: 1280, height: 800 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`history pages every stored row and passive notice once, with notice metadata (${name})`, async ({ page }) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width, height })
    await openHistory(page)
    const offsets: number[] = []
    await page.route('**/api/studio/sessions/conversations/hist-notice/messages/paginated*', route => {
      const url = new URL(route.request().url())
      const offset = Number(url.searchParams.get('offset') || 0)
      offsets.push(offset)
      return route.fulfill({ json: noticePage(offset, Number(url.searchParams.get('limit') || 150)) })
    })
    await page.goto('/#/hermes/history/session/hist-notice')
    await expect(page.locator('#message-200')).toBeAttached()

    // Attribution, the known error of an empty-answer failure, and the status-only explanation.
    await expect(page.locator('#message-studio-notice-1 .studio-notice-header')).toContainText('Scheduled task “Job 1” finished')
    const failed = page.locator('#message-studio-notice-5 .studio-notice-header')
    await expect(failed).toContainText('Scheduled task “Job 5” failed')
    await expect(failed.locator('.studio-notice-detail')).toHaveText('Synthetic provider failure')
    const statusOnly = page.locator('#message-studio-notice-6 .studio-notice-header')
    await expect(statusOnly).toContainText('Scheduled task “Job 6” finished')
    await expect(statusOnly.locator('.studio-notice-detail')).toHaveText('Result unavailable for this runtime (script-only job); status only.')
    const box = await failed.boundingBox()
    expect(box && box.x + box.width).toBeLessThanOrEqual(width)

    // Load the older page as a user would, by scrolling to the top.
    const list = page.locator('.history-panel .virtual-message-list')
    await list.hover()
    await expect.poll(async () => { await page.mouse.wheel(0, -4000); return offsets.length }, { timeout: 30_000 }).toBeGreaterThan(1)
    // The older page starts after the 150 stored rows, never after stored rows plus notices.
    expect(offsets).toEqual([0, 150])

    // Every stored row and notice is in the list exactly once, in timestamp order: the list index of
    // each rendered row equals its position among all 200 rows and 6 notices (notice after an
    // equal-timestamp row). A skipped or duplicated item shifts every later index.
    const all = [...noticeStored, ...historyNotices].sort((a, b) => a.timestamp - b.timestamp || (a.studio_notice ? 1 : 0) - (b.studio_notice ? 1 : 0))
    const expectedIndex = (id: string) => all.findIndex(item => String(item.id) === id)
    const indexOf = (id: string) => page.locator(`.virtual-row:has(> * #message-${id}), .virtual-row:has(#message-${id})`).first().getAttribute('data-virtual-index')
    const reveal = async (id: string, deltaY: number) => {
      const row = page.locator(`#message-${id}`)
      await expect.poll(async () => {
        if (await row.count() === 0) await page.mouse.wheel(0, deltaY)
        return row.count()
      }, { timeout: 30_000 }).toBe(1)
      expect(Number(await indexOf(id))).toBe(expectedIndex(id))
    }
    await reveal('1', -4000)
    await reveal('studio-notice-4', -4000)
    await reveal('200', 4000)
    await reveal('studio-notice-1', 4000)
    expect(all).toHaveLength(206)
    expect(offsets).toEqual([0, 150])
  })
}
