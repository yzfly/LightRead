import { createRouter, createWebHashHistory } from 'vue-router'

// Tauri 生产环境走 file 协议, 统一使用 hash 路由
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/library' },
    { path: '/library', component: () => import('../views/LibraryView.vue') },
    { path: '/papers', component: () => import('../views/LibraryView.vue'), meta: { kind: 'paper' } },
    { path: '/read-paper/:id', component: () => import('../views/PaperReaderView.vue') },
    { path: '/read/:id', component: () => import('../views/ReaderView.vue') },
    // 旧版 /read-pdf 已并入论文阅读器 (PDF 统一引擎)
    { path: '/read-pdf/:id', redirect: to => `/read-paper/${to.params.id}` },
    { path: '/read-djvu/:id', component: () => import('../views/DjvuReaderView.vue') },
    { path: '/catalogs', component: () => import('../views/CatalogView.vue') },
    { path: '/settings', component: () => import('../views/SettingsView.vue') },
  ],
})
