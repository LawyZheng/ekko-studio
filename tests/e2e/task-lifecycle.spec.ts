import { expect, test } from '@playwright/test'
import { containPage } from './fixtures/contained-page'
import { fakeChatRunSockets } from './fixtures/session-state-socket'

const sid = 'lifecycle-chat'
const sessions = [{ id: sid, title: 'Crawler run', profile: 'default', source: 'cli', agent: 'hermes',
  model: 'test-model', provider: 'test-provider', started_at: 2, last_active: 2, message_count: 2 }]
const messages = [
  { id: 1, session_id: sid, role: 'user', content: 'Crawl the site and write a report', timestamp: 1, run_marker: 'run-a' },
  { id: 2, session_id: sid, role: 'assistant', content: 'The crawler is running in the background.', timestamp: 2, run_marker: 'run-a' },
]
const steps = [{ id: 'crawl', step: 'Crawl the site', status: 'completed' }, { id: 'report', step: 'Write the report', status: 'completed' }]
function card(revision: number, phase: string, execution = 'ended', extra: Record<string, unknown> = {}) {
  return { session_id: sid, run_id: 'run-a', plan_id: 'mcp:original', revision, execution_state: execution, plan: steps,
    created_at: 1500, updated_at: 1500 + revision, task_id: 'goal-1',
    lifecycle: { phase, attempt: 1, revision, updated_at: 1500 + revision, ...extra } }
}
const quiet = { working: false, backgroundPending: 0, lastMessageId: 2, readMessageId: 2, unread: false, manualUnread: false, unreadRevision: 0, generation: 'g1' }

// The real app shell, contained: /api answered locally, chat-run sockets served over the real WebSocket transport.
async function openChat(page: import('@playwright/test').Page, resumedPlans: () => unknown[]) {
  await page.addInitScript(() => {
    localStorage.setItem('hermes_locale', 'en'); localStorage.setItem('hermes_api_key', 'journey-key'); (window as any).__APP_VERSION__ = 'test'
  })
  const guard = await containPage(page, path => {
    if (path === '/api/auth/me') return { user: { id: 1, username: 'playwright', role: 'super_admin', status: 'active' } }
    if (path === '/api/hermes/profiles') return { profiles: [{ name: 'default', active: true, model: 'test-model', gateway: 'test', alias: 'Default' }] }
    if (path === '/api/studio/sessions') return { sessions }
    if (path === '/api/hermes/available-models') return { default: 'test-model', default_provider: 'test-provider',
      groups: [{ provider: 'test-provider', label: 'Test Provider', base_url: 'https://example.invalid/v1', models: ['test-model'], available_models: ['test-model'] }] }
    if (path === '/api/studio/session-categories') return { categories: [] }
    if (path.startsWith(`/api/studio/sessions/${sid}`)) return { session: sessions[0], messages, total: messages.length, taskPlans: resumedPlans() }
    return {}
  })
  const sockets = await fakeChatRunSockets(page, { resumed: () => ({ messages, taskPlans: resumedPlans() }) })
  await page.goto(`/#/hermes/session/${sid}`)
  return { sockets, guard }
}

test('keeps the original card and the avatar on one durable lifecycle through background, verifying and acceptance', async ({ page }, testInfo) => {
  let persisted: unknown[] = [card(3, 'running')]
  const { sockets, guard } = await openChat(page, () => persisted)
  const avatar = page.locator('.session-item').filter({ hasText: 'Crawler run' }).first().getByTestId('session-agent-avatar')
  const plan = page.getByTestId('task-plan-card')
  await expect.poll(sockets.connected, { timeout: 30_000 }).toBe(true)

  // Foreground run is over; the owned worker still runs: background card, processing avatar, no streaming ring.
  sockets.publish({ sessionId: sid, ...quiet, task: { state: 'running', count: 1 } })
  await expect(plan).toHaveCount(1)
  await expect(plan.locator('.plan-state')).toHaveText('Background execution in progress')
  await expect(plan.locator('.plan-count')).toHaveText('2/2 completed')
  await expect(avatar).toHaveAttribute('data-task-state', 'processing')
  await expect(avatar).not.toHaveClass(/streaming/)
  await page.screenshot({ path: testInfo.outputPath('1-background.png') })

  // The worker delivered: exit is not acceptance. Same card updated in place.
  sockets.emit('plan.updated', { event: 'plan.updated', ...card(4, 'verifying', 'ended', { delivery_id: 'd1' }) })
  sockets.publish({ sessionId: sid, ...quiet, task: { state: 'verifying', count: 1 } })
  await expect(plan.locator('.plan-state')).toHaveText('Delivered; verifying')
  await expect(plan).toHaveCount(1)
  await expect(plan).not.toHaveClass(/task-plan-card--done/)
  await expect(avatar).toHaveAttribute('data-task-state', 'processing')
  await page.screenshot({ path: testInfo.outputPath('2-verifying.png') })

  // A second goal needs the user: session precedence shows waiting, not processing.
  sockets.publish({ sessionId: sid, ...quiet, task: { state: 'waiting_user', count: 1 } })
  await expect(avatar).toHaveAttribute('data-task-state', 'waiting')
  await expect(avatar).toHaveAttribute('title', 'Waiting for you')

  // Explicit acceptance: green card, done avatar. A stale lower revision cannot roll it back.
  sockets.emit('plan.updated', { event: 'plan.updated', ...card(6, 'done', 'ended', { delivery_id: 'd1', verification_id: 'v1' }) })
  sockets.emit('plan.updated', { event: 'plan.updated', ...card(5, 'verifying', 'ended', { delivery_id: 'd1' }) })
  sockets.publish({ sessionId: sid, ...quiet, task: { state: 'done', count: 1 } })
  await expect(plan.locator('.plan-state')).toHaveText('Done — verified and accepted')
  await expect(plan).toHaveClass(/task-plan-card--done/)
  await expect(avatar).toHaveAttribute('data-task-state', 'done')
  await page.screenshot({ path: testInfo.outputPath('3-done.png') })

  // Reload: the persisted original card comes back from the server payload, not from client memory.
  persisted = [card(6, 'done', 'ended', { delivery_id: 'd1', verification_id: 'v1' })]
  await page.reload()
  await expect.poll(sockets.connected, { timeout: 30_000 }).toBe(true)
  sockets.publish({ sessionId: sid, ...quiet, task: { state: 'done', count: 1 } })
  await expect(page.getByTestId('task-plan-card')).toHaveCount(1)
  await expect(page.getByTestId('task-plan-card').locator('.plan-state')).toHaveText('Done — verified and accepted')
  await expect(page.getByTestId('task-plan-card')).toContainText('Write the report')
  // Contained: nothing even tried to leave loopback.
  expect(guard.attempted.filter(url => !/^(https?|wss?):\/\/127\.0\.0\.1[:/]/.test(url) && !url.startsWith('data:') && !url.startsWith('blob:'))).toEqual([])
})

test('shows abnormal producer states as attention without a running avatar', async ({ page }) => {
  const { sockets } = await openChat(page, () => [card(2, 'lost', 'ended', { reason: 'producer_absent' })])
  const avatar = page.locator('.session-item').filter({ hasText: 'Crawler run' }).first().getByTestId('session-agent-avatar')
  await expect.poll(sockets.connected, { timeout: 30_000 }).toBe(true)
  sockets.publish({ sessionId: sid, ...quiet, task: { state: 'lost', count: 1 } })
  await expect(page.getByTestId('task-plan-card').locator('.plan-state')).toHaveText('Worker ownership lost')
  await expect(avatar).toHaveAttribute('data-task-state', 'attention')
  await expect(avatar).not.toHaveClass(/task-processing/)
})
