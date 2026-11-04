// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', () => ({
  NButton: { template: '<button><slot /></button>' },
  NDrawer: { template: '<div><slot /></div>' },
  NDrawerContent: { template: '<div><slot /></div>' },
  NSpin: { template: '<div />' },
  useMessage: () => ({
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
}))

import MessageItem from '@/components/hermes/chat/MessageItem.vue'
import type { Message } from '@/stores/hermes/chat'

const REPORT = [
  '**Review Cron: actions completed**',
  '',
  '- reviewed: 2',
  '',
  '**PRs**',
  '',
  '| Action | PR | Title | Blocker |',
  '| --- | --- | --- | --- |',
  '| approved | [#101](https://example.invalid/pr/101) | Fix parser | none |',
  '| changes requested | [#102](https://example.invalid/pr/102) | Add cache | missing tests |',
  '',
  '```text',
  'raw log line',
  '```',
].join('\n')

function scriptReport(content: string): Message {
  return {
    id: 'studio-notice-7',
    role: 'system',
    content,
    timestamp: Date.now(),
    studioNotice: {
      kind: 'script_report', notification_id: 7, disposition: 'notified', identity_kind: 'wrapper_invocation',
      job_id: 'job-7', job_name: 'Review digest', invocation_id: '00000000-0000-4000-8000-000000000007',
      outcome: 'output', exit_code: 0, signal: null, reason: null, truncated: false,
    },
  }
}

describe('MessageItem studio notices', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        addEventListener: vi.fn(), removeEventListener: vi.fn(), getVoices: vi.fn(() => []),
        speak: vi.fn(), cancel: vi.fn(), pause: vi.fn(), resume: vi.fn(),
      },
    })
  })

  it('renders a script report as Markdown with a table, links and code', () => {
    const wrapper = mount(MessageItem, { props: { message: scriptReport(REPORT) } })

    expect(wrapper.find('.studio-notice-title').text()).toBe('chat.sessionNotice.scriptReportTitle')
    expect(wrapper.find('.studio-notice-text').exists()).toBe(false)
    const bodies = wrapper.findAll('.markdown-body')
    expect(bodies).toHaveLength(1)
    const body = bodies[0]
    expect(body.findAll('table th').map(th => th.text())).toEqual(['Action', 'PR', 'Title', 'Blocker'])
    expect(body.findAll('table tbody tr')).toHaveLength(2)
    const links = body.findAll('table a')
    expect(links.map(link => link.attributes('href'))).toEqual([
      'https://example.invalid/pr/101',
      'https://example.invalid/pr/102',
    ])
    expect(body.find('strong').text()).toBe('Review Cron: actions completed')
    expect(body.find('li').text()).toBe('reviewed: 2')
    expect(body.find('pre code').text()).toContain('raw log line')
    expect(body.text()).not.toContain('| --- |')
  })

  it('keeps raw HTML, scripts and unsafe URLs inert in a script report', () => {
    const content = [
      '<img src="x" onerror="alert(1)"> <svg onload="alert(2)"></svg> <script>alert(3)</script>',
      '',
      '[js](javascript:alert(4)) [data](data:text/html;base64,PHNjcmlwdD4=) [vb](vbscript:msgbox(5))',
      '',
      '![pixel](https://external.example/pixel.png)',
    ].join('\n')
    const wrapper = mount(MessageItem, { props: { message: scriptReport(content) } })
    const body = wrapper.find('.markdown-body')

    expect(body.exists()).toBe(true)
    expect(body.findAll('img, svg, script, iframe, object, embed')).toHaveLength(0)
    const attributes = [...body.element.querySelectorAll('*')].flatMap(element => element.getAttributeNames())
    expect(attributes.filter(name => name.startsWith('on'))).toEqual([])
    for (const link of body.findAll('a')) {
      expect(link.attributes('href') || '').not.toMatch(/^(javascript|data|vbscript):/i)
    }
    expect(body.text()).toContain('<img src="x" onerror="alert(1)">')
  })

  it('keeps plain multiline script output on separate lines', () => {
    const wrapper = mount(MessageItem, { props: { message: scriptReport('checked 3 feeds\nnew: 1\ndone') } })
    const paragraph = wrapper.find('.markdown-body p')

    expect(paragraph.findAll('br')).toHaveLength(2)
    expect(paragraph.text().split('\n').map(line => line.trim())).toEqual(['checked 3 feeds', 'new: 1', 'done'])
  })

  it('copies the raw script report text', async () => {
    const wrapper = mount(MessageItem, { props: { message: scriptReport(REPORT) } })

    await wrapper.find('.copy-bubble-btn').trigger('click')
    await flushPromises()

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(REPORT)
  })

  it('keeps an external notice as plain text', () => {
    const content = '**not bold** | a | b |\n| --- | --- |'
    const wrapper = mount(MessageItem, {
      props: {
        message: {
          id: 'studio-notice-8', role: 'system', content, timestamp: Date.now(),
          studioNotice: { kind: 'external', notification_id: 8, source: 'validator', event_id: 'event-8', title: 'Done', url: null },
        },
      },
    })

    expect(wrapper.find('.studio-notice-text').text()).toBe(content)
    expect(wrapper.find('.markdown-body').exists()).toBe(false)
  })
})
