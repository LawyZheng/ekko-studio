import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { containPage } from './fixtures/contained-page'

const TEST_ACCESS_KEY = 'playwright-consent-access-key'
const PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2V9sAAAAASUVORK5CYII=', 'base64')
// API paths the card and theme are expected to call; anything else is reported as unexpected.
const EXPECTED_API = [/^GET \/api\/theme$/, /^GET \/api\/theme\/background$/, /^GET \/api\/hermes\/cron\/consent-requests$/,
  /^POST \/api\/hermes\/cron\/consent-requests\/[^/]+\/approve$/]

// Mounts the real consent card in an existing chat with the user's theme; all network is contained.
async function openConsentCard(page: Page, theme: { brightness?: string; background?: { name: string; mime: string; updatedAt: number } } = {}) {
  await page.addInitScript(key => {
    localStorage.setItem('hermes_locale', 'en'); localStorage.setItem('hermes_api_key', key); (window as any).__APP_VERSION__ = 'test'
  }, TEST_ACCESS_KEY)
  const settings = { fontSize: 14, textColor: null, accentColor: null, background: null, updatedAt: 1, ...theme }
  const guard = await containPage(page, path => {
    if (path === '/api/theme') return settings
    if (path === '/api/theme/background' && settings.background) return { raw: PIXEL_PNG, contentType: settings.background.mime }
    return {}
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/cron-consent-card.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__cron_consent__', route => route.fulfill({ contentType: 'text/html',
    body: `<!doctype html><html><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  return {
    open: async () => { await page.goto('/__cron_consent__'); await page.waitForFunction(() => !!(window as any).cronConsentFixture) },
    get unexpectedRequests() { return guard.apiPaths.filter(entry => !EXPECTED_API.some(pattern => pattern.test(entry))) },
  }
}

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
      const api = await openConsentCard(page, { brightness })
      let requests = [pending]
      const decisions: Array<{ path: string; body: string | null; authorization?: string }> = []
      await page.route('**/api/hermes/cron/consent-requests?*', route => route.fulfill({ json: { requests } }))
      await page.route('**/api/hermes/cron/consent-requests/*/approve', async route => {
        decisions.push({ path: new URL(route.request().url()).pathname, body: route.request().postData(), authorization: route.request().headers().authorization })
        requests = []
        await route.fulfill({ json: { status: 'approved', request_id: 'req-1' } })
      })
      await api.open()
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
  const api = await openConsentCard(page)
  const cross = { ...pending, target: { session_id: 'weekly-target-chat', profile: 'research', title: 'Weekly <b>notes</b>' } }
  await page.route('**/api/hermes/cron/consent-requests?*', route => route.fulfill({ json: { requests: [cross] } }))
  await api.open()
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
    const api = await openConsentCard(page, { brightness, background: { name: 'wall.png', mime: 'image/png', updatedAt: 1 } })
    await page.route('**/api/hermes/cron/consent-requests?*', route => route.fulfill({ json: { requests: [pending] } }))
    await api.open()
    const card = page.getByTestId('cron-consent-card')
    await expect(card.getByTestId('cron-consent-request')).toContainText('reports/digest.py')
    await expect(card).toHaveCSS('background-color', brightness === 'dark' ? 'rgba(42, 42, 42, 0.72)' : 'rgba(255, 255, 255, 0.72)')
    expect(api.unexpectedRequests).toEqual([])
  })
}
