import './polyfills'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import './styles/main.css'
import { isTauri } from './storage/types'
import { installAndroidSafeArea } from './services/systemBars'
import { installDiagnostics } from './services/diagnostics'

installDiagnostics()

// index.html 的旧 WebView 检查: 模块图能执行到这里就说明环境够新
;(window as unknown as { __lightreadBoot?: boolean }).__lightreadBoot = true

// 桌面端不需要 PWA 离线缓存, 且历史版本注册过的 Service Worker 会在升级后
// 继续供给旧版界面代码 (Windows WebView2 数据目录保留缓存) — 启动时主动清理
if (isTauri() && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations()
    .then(regs => regs.forEach(r => r.unregister()))
    .catch(() => {})
  window.caches?.keys()
    .then(keys => keys.forEach(k => caches.delete(k)))
    .catch(() => {})
}

installAndroidSafeArea()

createApp(App).use(createPinia()).use(router).mount('#app')

// 验收用的遥控通道: 只有设了 LIGHTREAD_E2E_DRIVER 的构建才带 (发版检查拒绝这个环境变量), 见 services/e2eDriver.ts
if (typeof __E2E_DRIVER__ !== 'undefined' && __E2E_DRIVER__) void import('./services/e2eDriver').then(m => m.startE2eDriver(__E2E_DRIVER__))
