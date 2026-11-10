// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'


vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => params ? `${key}:${JSON.stringify(params)}` : key }) }))

import TaskPlanCard from '@/components/hermes/chat/TaskPlanCard.vue'
import { mergeTaskPlanMessages, parseTaskPlan, type TaskPlanSnapshot } from '@/utils/task-plan'
import { sessionTaskIndicator } from '@/utils/task-lifecycle'

const done = [{ id: 'a', step: 'Write', status: 'completed' as const }, { id: 'b', step: 'Publish', status: 'completed' as const }]
function card(lifecycle?: Partial<NonNullable<TaskPlanSnapshot['lifecycle']>>, execution: TaskPlanSnapshot['execution_state'] = 'ended'): TaskPlanSnapshot {
  return {
    session_id: 's1', run_id: 'run-a', plan_id: 'mcp:1', revision: 3, execution_state: execution, plan: done,
    created_at: 1, updated_at: 2,
    ...(lifecycle ? { task_id: 'goal-1', lifecycle: { phase: 'running', attempt: 1, revision: 1, updated_at: 2, ...lifecycle } } : {}),
  }
}

describe('task plan card lifecycle', () => {
  it('never shows a linked card as completed until the delivery was accepted', () => {
    for (const phase of ['running', 'verifying', 'failed', 'lost', 'unknown', 'open'] as const) {
      const wrapper = mount(TaskPlanCard, { props: { plan: card({ phase }) } })
      expect(wrapper.find('.plan-state').text()).not.toBe('taskPlan.completed')
      expect(wrapper.find('[data-testid="task-plan-card"]').classes()).not.toContain('task-plan-card--done')
    }
    const background = mount(TaskPlanCard, { props: { plan: card({ phase: 'running' }, 'ended') } })
    expect(background.find('.plan-state').text()).toBe('taskPlan.lifecycle.in_background')
    const live = mount(TaskPlanCard, { props: { plan: card({ phase: 'running' }, 'running') } })
    expect(live.find('.plan-state').text()).toBe('taskPlan.lifecycle.running')
    const verifying = mount(TaskPlanCard, { props: { plan: card({ phase: 'verifying' }) } })
    expect(verifying.find('.plan-state').text()).toBe('taskPlan.lifecycle.verifying')
    const waiting = mount(TaskPlanCard, { props: { plan: card({ phase: 'waiting_user', waiting_kind: 'login' }) } })
    expect(waiting.find('.plan-state').text()).toBe('taskPlan.lifecycle.waiting_login')
    const accepted = mount(TaskPlanCard, { props: { plan: card({ phase: 'done' }) } })
    expect(accepted.find('.plan-state').text()).toBe('taskPlan.lifecycle.done')
    expect(accepted.find('[data-testid="task-plan-card"]').classes()).toContain('task-plan-card--done')
  })

  it('keeps legacy run-only cards unchanged', () => {
    expect(mount(TaskPlanCard, { props: { plan: card() } }).find('.plan-state').text()).toBe('taskPlan.completed')
    expect(parseTaskPlan(card())).not.toBeNull()
  })

  it('updates the original card in place from a later lifecycle revision', () => {
    const first = mergeTaskPlanMessages([{ id: 'm1', role: 'assistant', content: 'x', timestamp: 1, runMarker: 'run-a' } as any], [card({ phase: 'running' })])
    const next = { ...card({ phase: 'verifying' }), revision: 4 }
    const merged = mergeTaskPlanMessages(first, [next])
    const cards = merged.filter(message => message.taskPlan)
    expect(cards).toHaveLength(1)
    expect(cards[0].taskPlan?.lifecycle?.phase).toBe('verifying')
    expect(parseTaskPlan({ ...next, lifecycle: { ...next.lifecycle, phase: 'bogus' } })).toBeNull()
  })
})

describe('session avatar task indicator', () => {
  it('maps the server projection without inventing state', () => {
    expect(sessionTaskIndicator(undefined)).toBeNull()
    expect(sessionTaskIndicator({ state: 'running', count: 1 })).toMatchObject({ kind: 'processing', label: 'sessionTask.running' })
    expect(sessionTaskIndicator({ state: 'verifying', count: 2 })).toMatchObject({ kind: 'processing', label: 'sessionTask.verifying' })
    expect(sessionTaskIndicator({ state: 'waiting_user', count: 1 })).toMatchObject({ kind: 'waiting' })
    for (const state of ['failed', 'lost', 'unknown'] as const) expect(sessionTaskIndicator({ state, count: 1 })?.kind).toBe('attention')
    expect(sessionTaskIndicator({ state: 'open', count: 1 })?.kind).toBe('open')
    expect(sessionTaskIndicator({ state: 'done', count: 1 })?.kind).toBe('done')
  })
})

describe('lifecycle label of a collapsed card (review finding 7)', () => {
  it('keeps the lifecycle label visible in the header when an all-completed linked card is collapsed', async () => {
    const wrapper = mount(TaskPlanCard, { props: { plan: card({ phase: 'verifying' }) } })
    await wrapper.find('.plan-header').trigger('click')
    expect(wrapper.find('.plan-body').exists()).toBe(false)
    expect(wrapper.find('.plan-header .plan-state').text()).toBe('taskPlan.lifecycle.verifying')
    const legacy = mount(TaskPlanCard, { props: { plan: card() } })
    expect(legacy.find('.plan-header .plan-state').exists()).toBe(false)
    expect(legacy.find('.plan-body .plan-state').text()).toBe('taskPlan.completed')
  })

})
