// The scheduled-result setup action in the active-session menu: migrated from the fork's case in the removed
// session-action-menu suite.
import type { DropdownOption } from 'naive-ui'
import type { VNode } from 'vue'
import { describe, expect, it } from 'vitest'
import {
  buildActiveSessionMenuOptions,
  buildSessionContextMenuOptions,
  renderSessionMenuIcon,
} from '@/components/hermes/chat/session-menu-options'

function describeOptions(options: DropdownOption[]) {
  return options.map((option) => {
    const item = option as DropdownOption & {
      icon?: () => VNode
      label?: string
      type?: string
    }
    const icon = item.icon?.()
    return {
      key: item.key,
      label: item.label,
      icon: icon?.props?.['data-session-menu-icon'],
      hasChildren: Array.isArray(item.children),
    }
  })
}


describe('Cron consent setup menu action', () => {
  it('offers the scheduled-result setup action only for sessions that can receive it', () => {
    const labels = { outline: 'Outline', rename: 'Rename', open: 'Open', copyId: 'Copy', cronConsentSetup: 'Allow MCP setup' }
    expect(buildActiveSessionMenuOptions(labels, { canRename: true, canOpen: true }).map(option => option.key))
      .not.toContain('cron-consent-setup')
    const options = buildActiveSessionMenuOptions(labels, { canRename: true, canOpen: true, canCronConsentSetup: true })
    expect(describeOptions(options).at(-1)).toEqual({ key: 'cron-consent-setup', label: 'Allow MCP setup', icon: 'link', hasChildren: false })
  })
})
