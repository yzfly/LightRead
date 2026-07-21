import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { readFileSync } from 'node:fs'

import { cloudflare } from '@cloudflare/vite-plugin'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [vue(), viteStaticCopy({
    targets: [
      { src: 'node_modules/pdfjs-dist/wasm/*', dest: 'pdfjs/wasm' },
      { src: 'node_modules/pdfjs-dist/iccs/*', dest: 'pdfjs/iccs' },
      { src: 'node_modules/pdfjs-dist/cmaps/*', dest: 'pdfjs/cmaps' },
      { src: 'node_modules/pdfjs-dist/standard_fonts/*', dest: 'pdfjs/standard_fonts' },
    ],
  }), VitePWA({
    // 桌面/移动端 (Tauri) 资源都在本地, 不需要 PWA 离线缓存; Windows WebView2
    // 会把 Service Worker 缓存的旧版界面存进用户数据目录, 升级后仍加载旧代码。
    // 自毁型 SW 让已装机器上的旧 SW 在更新检查时自动注销并清缓存。
    selfDestroying: !!process.env.TAURI_ENV_PLATFORM,
    registerType: 'autoUpdate',
    workbox: {
      // PDFium wasm (~5MB) 需要进预缓存；pdf.js 字体/CMap 资源按需缓存。
      maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      runtimeCaching: [
        {
          urlPattern: /\/pdfjs\//,
          handler: 'CacheFirst',
          options: { cacheName: 'pdfjs-assets' },
        },
      ],
    },
    manifest: {
      name: 'Lights 阅读器',
      short_name: 'Lights',
      description: '开源本地阅读器 · 支持 EPUB / MOBI / AZW3 / FB2 / CBZ / PDF / TXT 等格式，藏书管理与 OPDS 书源',
      theme_color: '#1664FF',
      background_color: '#F7F8FA',
      display: 'standalone',
      icons: [
        { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    },
  }),
  // Cloudflare 插件仅用于网页版部署; Tauri 桌面构建不加载 (且其要求 Node ≥22.15)
  ...(process.env.TAURI_ENV_PLATFORM ? [] : [cloudflare()])],
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 2048,
  },
  // Tauri 开发时使用固定端口
  server: {
    port: 5173,
    strictPort: true,
  },
})
