import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { containPage } from './fixtures/contained-page'

// Mounts the real message component with i18n and global styles. Every request outside Vite's own modules is
// blocked before navigation (see fixtures/contained-page.ts); /api is answered locally and never proxied.
async function openNotices(page: Page) {
  await page.addInitScript(() => { localStorage.setItem('hermes_locale', 'en'); (window as any).__APP_VERSION__ = 'test' })
  const guard = await containPage(page)
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/session-notice.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__session_notice__', route => route.fulfill({ contentType: 'text/html',
    body: `<!doctype html><html><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  await page.goto('/__session_notice__')
  await page.waitForFunction(() => !!(window as any).sessionNoticeFixture)
  return guard
}

for (const viewport of [{ name: 'desktop', width: 1280, height: 800 }, { name: 'narrow', width: 390, height: 844 }]) {
  test(`renders a passive scheduled-task notice in its own session (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await openNotices(page)
    await page.evaluate(() => {
      const sid = (window as any).sessionNoticeFixture.sid
      // Raw server event, delivered through the real socket listener.
      const add = (message: any) => (window as any).sessionNoticeFixture.deliver({ event: 'session.notice', session_id: sid, attention: true, message })
      add({
          id: 'studio-notice-1', session_id: sid, role: 'system', display_role: 'system',
          content: 'Synthetic brief result', timestamp: Math.floor(Date.now() / 1000) + 1,
          studio_notice: {
            kind: 'cron', notification_id: 1, disposition: 'notified', job_id: 'job-1', job_name: 'Daily brief',
            execution_id: 'exec-1', status: 'completed', success: true, reason: null, error: null,
            truncated: false, finished_at: null,
          },
        })
      // A known failure with an empty answer is shown with its error, not hidden.
      add({
          id: 'studio-notice-2', session_id: sid, role: 'system', display_role: 'system',
          content: '', timestamp: Math.floor(Date.now() / 1000) + 2,
          studio_notice: {
            kind: 'cron', notification_id: 2, disposition: 'notified', job_id: 'job-2', job_name: 'Nightly sync',
            execution_id: 'exec-2', status: 'failed', success: false, reason: null, error: 'Synthetic provider failure',
            truncated: false, finished_at: null,
          },
        })
    })
    const header = page.locator('.studio-notice-header').filter({ hasText: 'Daily brief' })
    await expect(header).toContainText('Scheduled task “Daily brief” finished')
    await expect(page.locator('.markdown-body').filter({ hasText: 'Synthetic brief result' })).toBeVisible()
    const failed = page.locator('.studio-notice-header').filter({ hasText: 'Nightly sync' })
    await expect(failed.locator('.studio-notice-detail')).toHaveText('Synthetic provider failure')
    const box = await header.first().boundingBox()
    expect(box && box.x + box.width).toBeLessThanOrEqual(viewport.width)
  })
}

test('renders an external notice as inert plain text with a click-only link', async ({ page }) => {
  const remote: string[] = []
  page.on('request', request => { if (request.url().includes('external.example')) remote.push(request.url()) })
  await openNotices(page)
  const content = '**not bold** ![pixel](https://external.example/pixel.png) <img src="https://external.example/img.png"> [file](/etc/hosts)'
  await page.evaluate(content => {
    const sid = (window as any).sessionNoticeFixture.sid
    // Raw server event, delivered through the real socket listener.
      const add = (message: any) => (window as any).sessionNoticeFixture.deliver({ event: 'session.notice', session_id: sid, attention: true, message })
    add({
        id: 'studio-notice-3', session_id: sid, role: 'system', display_role: 'system', content,
        timestamp: Math.floor(Date.now() / 1000) + 1,
        studio_notice: { kind: 'external', notification_id: 3, source: 'validator-review', event_id: 'review-3',
          title: '<b>Validation</b> complete', url: 'https://external.example/reviews/3' },
      })
  }, content)
  const header = page.locator('.studio-notice-header').filter({ hasText: 'Validation' })
  await expect(header.locator('.studio-notice-title')).toHaveText('<b>Validation</b> complete')
  await expect(header.locator('.studio-notice-detail')).toContainText('validator-review')
  await expect(page.locator('.studio-notice-text')).toHaveText(content)
  await expect(page.locator('img[src*="external.example"], .markdown-body strong')).toHaveCount(0)
  const link = page.getByRole('link', { name: 'https://external.example/reviews/3' })
  await expect(link).toHaveAttribute('rel', /noopener/)
  await expect(link).toHaveAttribute('target', '_blank')
  expect(remote).toEqual([])
})

test('renders a script invocation report as Markdown with its wrapper provenance', async ({ page }) => {
  const remote: string[] = []
  page.on('request', request => { if (request.url().includes('external.example')) remote.push(request.url()) })
  await openNotices(page)
  const content = [
    '**3 new items** <b>raw</b>',
    '',
    '| Item | Link |',
    '| --- | --- |',
    '| First | [#1](https://example.invalid/items/1) |',
    '',
    '![pixel](https://external.example/pixel.png)',
  ].join('\n')
  await page.evaluate(content => {
    const sid = (window as any).sessionNoticeFixture.sid
    // Raw server event, delivered through the real socket listener.
      const add = (message: any) => (window as any).sessionNoticeFixture.deliver({ event: 'session.notice', session_id: sid, attention: true, message })
    add({
        id: 'studio-notice-4', session_id: sid, role: 'system', display_role: 'system', content,
        timestamp: Math.floor(Date.now() / 1000) + 1,
        studio_notice: { kind: 'script_report', notification_id: 4, disposition: 'notified', identity_kind: 'wrapper_invocation',
          job_id: 'job1', job_name: 'Daily digest', invocation_id: '00000000-0000-4000-8000-000000000004', outcome: 'output',
          exit_code: 0, signal: null, reason: null, truncated: false },
      })
  }, content)
  const header = page.locator('.studio-notice-header').filter({ hasText: 'Daily digest' })
  await expect(header.locator('.studio-notice-title')).toHaveText('Script “Daily digest” reported')
  await expect(header.locator('.studio-notice-detail')).toContainText('not a native Hermes execution receipt')
  const body = page.locator('.markdown-body').filter({ hasText: '3 new items' })
  await expect(body.locator('strong')).toHaveText('3 new items')
  await expect(body).toContainText('<b>raw</b>')
  await expect(body.locator('table th')).toHaveText(['Item', 'Link'])
  await expect(body.getByRole('link', { name: '#1' })).toHaveAttribute('href', 'https://example.invalid/items/1')
  await expect(page.locator('.studio-notice-text, .markdown-body b, img[src*="external.example"]')).toHaveCount(0)
  expect(remote).toEqual([])
})

test('never renders Mermaid or data links from a script report', async ({ page }) => {
  // Every request to the test host is recorded and aborted, so nothing leaves the browser.
  const attempted: string[] = []
  page.on('request', request => { if (new URL(request.url()).hostname === 'external.example') attempted.push(request.url()) })
  await page.route(url => url.hostname === 'external.example', route => route.abort())
  await openNotices(page)
  const report = [
    '### Summary',
    '',
    '```mermaid',
    'flowchart LR',
    '  P@{ img: "https://external.example/pixel.png", label: "pixel", h: 32 }',
    '```',
    '',
    '[png](data:image/png;base64,AAAA) [web](https://example.invalid/ok)',
  ].join('\n')
  // An agent-backed result with a plain diagram marks when Mermaid rendering has finished.
  const control = ['```mermaid', 'flowchart LR', '  A --> B', '```'].join('\n')
  await page.evaluate(({ report, control }) => {
    const sid = (window as any).sessionNoticeFixture.sid
    // Raw server event, delivered through the real socket listener.
      const add = (message: any) => (window as any).sessionNoticeFixture.deliver({ event: 'session.notice', session_id: sid, attention: true, message })
    const now = Math.floor(Date.now() / 1000)
    add({
        id: 'studio-notice-5', session_id: sid, role: 'system', display_role: 'system', content: report, timestamp: now + 1,
        studio_notice: { kind: 'script_report', notification_id: 5, disposition: 'notified', identity_kind: 'wrapper_invocation',
          job_id: 'job5', job_name: 'Diagram digest', invocation_id: '00000000-0000-4000-8000-000000000005', outcome: 'output',
          exit_code: 0, signal: null, reason: null, truncated: false },
      })
    add({
        id: 'studio-notice-6', session_id: sid, role: 'system', display_role: 'system', content: control, timestamp: now + 2,
        studio_notice: { kind: 'cron', notification_id: 6, disposition: 'notified', job_id: 'job-6', job_name: 'Agent diagram',
          execution_id: 'exec-6', status: 'completed', success: true, reason: null, error: null, truncated: false, finished_at: null },
      })
  }, { report, control })
  const agent = page.locator('.message-bubble').filter({ hasText: 'Agent diagram' })
  await expect(agent.locator('.mermaid-diagram svg')).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(1000)
  expect(attempted).toEqual([])
  const body = page.locator('.markdown-body').filter({ hasText: 'Summary' })
  await expect(body.locator('h3')).toHaveText('Summary')
  await expect(body.locator('pre code')).toContainText('img: "https://external.example/pixel.png"')
  await expect(body.locator('.mermaid-diagram, img, svg')).toHaveCount(0)
  await expect(body.locator('a')).toHaveCount(1)
  await expect(body.getByRole('link', { name: 'web' })).toHaveAttribute('href', 'https://example.invalid/ok')
  expect(attempted).toEqual([])
})
