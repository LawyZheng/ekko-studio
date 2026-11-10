// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.hoisted(() => { (globalThis as any).__APP_VERSION__ = 'test' })
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('naive-ui', () => ({ NPopconfirm: { template: '<div><slot name="trigger" /></div>' }, NCheckbox: { template: '<span />' },
  NTooltip: { template: '<span><slot name="trigger" /><slot /></span>' } }))

import SessionListItem from '@/components/hermes/chat/SessionListItem.vue'
import { sessionTaskIndicator } from '@/utils/task-lifecycle'

describe('session avatar effective state (review finding 6)', () => {
  it('shows waiting over background working, and no stale done badge while working', () => {
    setActivePinia(createPinia())
    const session = { id: 's1', title: 'Crawler', profile: 'default', source: 'cli', agent: 'hermes', createdAt: 1, messages: [] }
    const avatar = (streaming: boolean, state: 'waiting_user' | 'done' | 'running') => mount(SessionListItem, {
      props: { session: session as any, active: false, pinned: false, canDelete: false, streaming, taskIndicator: sessionTaskIndicator({ state, count: 1 }) },
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' }, ProfileAvatar: true, PinIcon: true } },
    }).find('[data-testid="session-agent-avatar"]')
    const waiting = avatar(true, 'waiting_user')
    expect(waiting.classes()).not.toContain('streaming')
    expect(waiting.attributes('data-task-state')).toBe('waiting')
    expect(waiting.find('.session-item-task-badge').exists()).toBe(true)
    const busyDone = avatar(true, 'done')
    expect(busyDone.classes()).toContain('streaming')
    expect(busyDone.attributes('data-task-state')).toBe('working')
    expect(busyDone.attributes('title')).toBeUndefined()
    expect(busyDone.find('.session-item-task-badge').exists()).toBe(false)
    const idleDone = avatar(false, 'done')
    expect(idleDone.attributes('data-task-state')).toBe('done')
    expect(idleDone.find('.session-item-task-badge').exists()).toBe(true)
  })

  it('keeps attention for an unreconciled producer when only historical background work makes the row working', () => {
    setActivePinia(createPinia())
    const session = { id: 's2', title: 'Restored', profile: 'default', source: 'cli', agent: 'hermes', createdAt: 1, messages: [] }
    const mountAvatar = (foreground: boolean) => mount(SessionListItem, {
      props: { session: session as any, active: false, pinned: false, canDelete: false, streaming: true, backgroundOnly: !foreground,
        taskIndicator: sessionTaskIndicator({ state: 'unknown', count: 1 }) },
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' }, ProfileAvatar: true, PinIcon: true } },
    }).find('[data-testid="session-agent-avatar"]')
    const background = mountAvatar(false)
    expect(background.classes()).not.toContain('streaming')
    expect(background.attributes('data-task-state')).toBe('attention')
    expect(background.find('.session-item-task-badge').exists()).toBe(true)
    // A real foreground run still shows activity first.
    expect(mountAvatar(true).classes()).toContain('streaming')
  })
})
