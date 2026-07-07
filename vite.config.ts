import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'
import { viteStaticCopy } from 'vite-plugin-static-copy'

export default defineConfig({
  plugins: [
    vue(),
    // pdf.js 运行时资源: wasm 解码器 (JPEG 2000/JBIG2/ICC)、CJK cmaps、标准字体
    viteStaticCopy({
      targets: [
        { src: 'node_modules/pdfjs-dist/wasm/*', dest: 'pdfjs/wasm', rename: { stripBase: true } },
        { src: 'node_modules/pdfjs-dist/iccs/*', dest: 'pdfjs/iccs', rename: { stripBase: true } },
        { src: 'node_modules/pdfjs-dist/cmaps/*', dest: 'pdfjs/cmaps', rename: { stripBase: true } },
        { src: 'node_modules/pdfjs-dist/standard_fonts/*', dest: 'pdfjs/standard_fonts', rename: { stripBase: true } },
      ],
    }),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        // pdfjs 资源按需加载 (cmaps 上千个小文件不适合预缓存), 首次用到后缓存供离线使用
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
