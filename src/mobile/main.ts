import '../polyfills'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from '../router'
import './styles/main.css'
import { isTauri } from '../storage/types'
import { installAndroidSafeArea } from '../services/systemBars'
import { clearLegacyUiCaches } from './services/nativeCacheCleanup'
import { installDiagnostics } from '../services/diagnostics'

installDiagnostics()

;(window as unknown as { __lightreadBoot?: boolean }).__lightreadBoot = true

if (isTauri()) {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations()
      .then(regs => Promise.all(regs.map(r => r.unregister())))
      .catch(() => {})
  }
  // Cache Storage also contains downloaded ambient audio; never clear it wholesale.
  if (window.caches) void clearLegacyUiCaches(window.caches).catch(() => {})
}

installAndroidSafeArea()
createApp(App).use(createPinia()).use(router).mount('#app')
