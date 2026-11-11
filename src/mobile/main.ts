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

// 模拟器验收的遥控通道: 正式构建里常量为空串, 这一行连同模块都被摇掉
if (typeof __E2E_DRIVER__ !== 'undefined' && __E2E_DRIVER__) void import('../services/e2eDriver').then(m => m.startE2eDriver(__E2E_DRIVER__))
