import { defineConfig, type Plugin } from 'vite'
import { mobileUi, nativeLicenses, uiTarget } from './vite.platform.ts'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { cloudflare } from '@cloudflare/vite-plugin'
import { BROWSER_TARGET, legacyCssFallbacks, legacyRegexRewrite } from './vite.legacy.ts'

const mobile = uiTarget(process.env) === 'mobile'
const mobileVersion = JSON.parse(readFileSync(new URL(`./src-tauri/tauri.${process.env.TAURI_ENV_PLATFORM === 'ios' ? 'ios' : 'android'}.conf.json`, import.meta.url), 'utf-8')).version

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

/**
 * 跨章连续滚动: foliate-js 的 view.js 用 `import('./paginator.js')` 加载渲染器,
 * 这里把它 (以及直接 import 的 foliate-js/paginator.js) 指向 src/vendor/foliate/paginator.js 的 fork。
 * 设计见 docs/continuous-scroll.md。
 */
function foliatePaginatorFork(): Plugin {
  const fork = fileURLToPath(new URL('./src/vendor/foliate/paginator.js', import.meta.url))
  return {
    name: 'lightread:foliate-paginator-fork',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === 'foliate-js/paginator.js') return fork
      if (source === './paginator.js' && importer
        && /[\\/]foliate-js[\\/]view\.js(?:\?|$)/.test(importer)) return fork
      return null
    },
  }
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(mobile ? mobileVersion : pkg.version),
    __APP_PLATFORM__: JSON.stringify(process.env.TAURI_ENV_PLATFORM || 'web'),
    // 模拟器验收的遥控通道 (src/services/e2eDriver.ts); 不设就是空串, 模块不进产物
    __E2E_DRIVER__: JSON.stringify(process.env.LIGHTREAD_E2E_DRIVER || ''),
  },
  plugins: [...(mobile ? [mobileUi()] : []), nativeLicenses(undefined, { desktopFonts: !mobile }), foliatePaginatorFork(), legacyRegexRewrite(), vue(), VitePWA({
    // 桌面/移动端 (Tauri) 资源都在本地, 不需要 PWA 离线缓存; Windows WebView2
    // 会把 Service Worker 缓存的旧版界面存进用户数据目录, 升级后仍加载旧代码。
    // 自毁型 SW 让已装机器上的旧 SW 在更新检查时自动注销并清缓存。
    selfDestroying: !!process.env.TAURI_ENV_PLATFORM,
    // Native App startup already unregisters historical workers in main.ts.
    // Do not register another worker against the Android asset protocol.
    injectRegister: mobile && !!process.env.TAURI_ENV_PLATFORM ? false : 'auto',
    registerType: 'autoUpdate',
    workbox: {
      // MuPDF wasm 约 10MB，网页版需要完整预缓存以支持离线阅读。
      maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
      // 与插件默认一致的 js / css / html / wasm, 另加打字机打字声 (约 95KB): 网页版离线也能用真实录音
      globPatterns: ['**/*.{js,css,html,wasm}', ...(mobile ? ['**/*.woff2'] : ['**/lxgw-wenkai-ui-*.woff2', '**/inter-ui-*.woff2']), 'sounds/typewriter/**/*.{ogg,m4a,json}'],
      // 仿生阅读的中文词表 (约 230KB gzip) 不预缓存: 第一次在中文书里开启时才下载, 之后离线也能用。
      // 文件名带内容哈希, CacheFirst 不会拿到旧版; 只留最近两版
      runtimeCaching: [{
        urlPattern: /\/assets\/zh-lexicon-[\w-]+\.txt$/,
        handler: 'CacheFirst',
        options: { cacheName: 'lightread-zh-lexicon', expiration: { maxEntries: 2 } },
      }, {
        urlPattern: /\/assets\/concepts-[\w-]+\.json$/,
        handler: 'CacheFirst',
        options: { cacheName: 'lightread-concepts', expiration: { maxEntries: 2 } },
      }],
    },
    manifest: {
      name: 'LightRead 轻阅',
      short_name: '轻阅',
      description: '开源电子书与 PDF 阅读器 · PDF 对照翻译、点睛阅读、本地书库、书单、阅读记录与听书',
      theme_color: '#1664FF',
      background_color: '#F7F8FA',
      display: 'standalone',
      icons: [
        { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        // 安卓桌面自适应图标: 字形在安全区内, 满版底色可被任意形状裁切
        { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
  }),
  // Cloudflare 插件仅用于网页版部署; Tauri 桌面构建不加载 (且其要求 Node ≥22.15)
  ...(process.env.TAURI_ENV_PLATFORM ? [] : [cloudflare()])],
  css: {
    postcss: { plugins: [legacyCssFallbacks()] },
  },
  build: {
    // 旧 WebView 兼容目标 (依据见 vite.legacy.ts); CSS 目标默认跟随, lightningcss 据此补前缀
    target: BROWSER_TARGET,
    chunkSizeWarningLimit: 2048,
    rolldownOptions: {
      output: {
        codeSplitting: {
          // polyfill 单独成块: 入口 chunk 的第一条 import, 先于 vue/设置等共享块求值
          groups: [{ name: 'polyfills', test: /[\\/]src[\\/]polyfills\.ts$/, priority: 100 }],
        },
      },
    },
  },
  worker: {
    // 目前没有模块 Worker (DjVu.js 的 Worker 由函数源码拼成 Blob, 走主包降级结果);
    // 显式写明, 以后新增 `new Worker(new URL(..., import.meta.url))` 时沿用同一目标的 ES 模块产物
    format: 'es',
  },
  // 开发模式不预构建 foliate-js: 预构建产物里 view.js 的 ./paginator.js 不经过上面的 fork 重定向
  optimizeDeps: {
    exclude: ['foliate-js'],
  },
  // Tauri 开发时使用固定端口
  server: {
    port: 5173,
    strictPort: true,
    // Native build outputs can contain hundreds of thousands of files. They
    // never participate in frontend HMR and exhaust Linux inotify otherwise.
    watch: { ignored: ['**/src-tauri/target/**', '**/src-tauri/gen/**'] },
  },
})
