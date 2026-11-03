import { expect, test } from '@playwright/test'
import { authenticate, mockExistingHermesChat, TEST_ACCESS_KEY } from './fixtures'

const pending = {
  id: 'req-1', kind: 'script_report_enrollment', mode: 'new', action: 'create_job', profile: 'research',
  session_id: 'existing-hermes-chat', session_title: 'Existing Hermes conversation', context_kind: 'prepared',
  requested_via: 'model_run', created_at: Date.now(), expires_at: Date.now() + 600_000,
  name: 'Digest <img src=x onerror=alert(1)>', schedule: 'every 1h', script: 'reports/digest.py', script_kind: 'python',
  script_sha256: 'a'.repeat(64), workdir: null, interpreter: null, resume: true,
}

for (const brightness of ['light', 'dark'] as const) {
  for (const mobile of [false, true]) {
    test(`cron consent card shows the frozen request as text and approves it (${brightness}, ${mobile ? 'narrow' : 'wide'})`, async ({ page }) => {
      if (mobile) await page.setViewportSize({ width: 390, height: 844 })
      await authenticate(page, TEST_ACCESS_KEY, 'research')
      const api = await mockExistingHermesChat(page, { theme: { brightness } })
      let requests = [pending]
      const decisions: Array<{ path: string; body: string | null; authorization?: string }> = []
      await page.route('**/api/hermes/cron/consent-requests?*', route => route.fulfill({ json: { requests } }))
      await page.route('**/api/hermes/cron/consent-requests/*/approve', async route => {
        decisions.push({ path: new URL(route.request().url()).pathname, body: route.request().postData(), authorization: route.request().headers().authorization })
        requests = []
        await route.fulfill({ json: { status: 'approved', request_id: 'req-1' } })
      })
      await page.goto('/#/hermes/chat')
      const card = page.getByTestId('cron-consent-card')
      await expect(card).toBeVisible()
      await expect(card).toHaveAttribute('data-theme-surface', 'card')
      const request = card.getByTestId('cron-consent-request')
      await expect(request).toContainText('Create a scheduled script job that reports to this chat')
      await expect(request).toContainText('Existing Hermes conversation · research')
      await expect(request).toContainText('reports/digest.py')
      await expect(request).toContainText('every 1h')
      await expect(request).toContainText('Digest <img src=x onerror=alert(1)>')
      await expect(request.locator('img')).toHaveCount(0)
      const box = await card.boundingBox()
      expect(box && box.width).toBeLessThanOrEqual(mobile ? 390 : 1280)
      await request.getByTestId('cron-consent-approve').click()
      await expect(card.getByTestId('cron-consent-outcome')).toContainText('Approved')
      expect(decisions).toEqual([{ path: '/api/hermes/cron/consent-requests/req-1/approve', body: JSON.stringify({ profile: 'research' }),
        authorization: `Bearer ${TEST_ACCESS_KEY}` }])
      await expect(card.getByTestId('cron-consent-request')).toHaveCount(0)
      expect(api.unexpectedRequests).toEqual([])
    })
  }
}

test('cron consent card in the origin chat names a different target chat by title, stable id and profile', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockExistingHermesChat(page)
  const cross = { ...pending, target: { session_id: 'weekly-target-chat', profile: 'research', title: 'Weekly <b>notes</b>' } }
  await page.route('**/api/hermes/cron/consent-requests?*', route => route.fulfill({ json: { requests: [cross] } }))
  await page.goto('/#/hermes/chat')
  const request = page.getByTestId('cron-consent-card').getByTestId('cron-consent-request')
  await expect(request).toContainText('Create a scheduled script job that reports to the chat named below')
  const target = request.getByTestId('cron-consent-target')
  await expect(target).toContainText('Weekly <b>notes</b> · weekly-target-chat · research')
  await expect(target).toContainText('Results go to this other chat, not the one showing this request.')
  await expect(target.locator('b')).toHaveCount(0)
  await expect(request).not.toContainText('Existing Hermes conversation · research')
  expect(api.unexpectedRequests).toEqual([])
})

for (const brightness of ['light', 'dark'] as const) {
  test(`cron consent card paints the registered translucent card surface over a wallpaper (${brightness})`, async ({ page }) => {
    await authenticate(page, TEST_ACCESS_KEY, 'research')
    const api = await mockExistingHermesChat(page, { theme: { brightness, background: { name: 'wall.png', mime: 'image/png', updatedAt: 1 } } })
    await page.route('**/api/hermes/cron/consent-requests?*', route => route.fulfill({ json: { requests: [pending] } }))
    await page.goto('/#/hermes/chat')
    const card = page.getByTestId('cron-consent-card')
    await expect(card.getByTestId('cron-consent-request')).toContainText('reports/digest.py')
    await expect(card).toHaveCSS('background-color', brightness === 'dark' ? 'rgba(42, 42, 42, 0.72)' : 'rgba(255, 255, 255, 0.72)')
    expect(api.unexpectedRequests).toEqual([])
  })
}
