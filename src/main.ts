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
