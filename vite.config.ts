import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
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
  ],
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
