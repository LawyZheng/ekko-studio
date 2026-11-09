import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { NConfigProvider, NMessageProvider, NDialogProvider } from 'naive-ui'
import CronConsentCard from '../../../packages/client/src/components/hermes/chat/CronConsentCard.vue'
import { fetchThemeSettings } from '../../../packages/client/src/api/studio/theme'
import { useTheme } from '../../../packages/client/src/composables/useTheme'
import { i18nReady } from '../../../packages/client/src/i18n'
import '../../../packages/client/src/styles/global.scss'

// The real consent card in an existing chat, with the signed-in user's theme applied exactly as the login view
// does (theme and requests come from the spec's local /api answers).
const pinia = createPinia()
const app = createApp({ setup: () => () => h(NConfigProvider, {}, {
  default: () => h(NMessageProvider, {}, { default: () => h(NDialogProvider, {}, {
    default: () => h('main', { style: { maxWidth: '100vw', padding: '8px', boxSizing: 'border-box' } },
      [h(CronConsentCard, { sessionId: 'existing-hermes-chat', profile: 'research' })]),
  }) }),
}) })
app.use(pinia)
app.use(await i18nReady)
useTheme().activateUserTheme(1, await fetchThemeSettings())
app.mount('#app')
;(window as any).cronConsentFixture = true
