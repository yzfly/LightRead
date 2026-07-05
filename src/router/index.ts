import { createRouter, createWebHashHistory } from 'vue-router'

// Tauri 生产环境走 file 协议, 统一使用 hash 路由
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/library' },
    { path: '/library', component: () => import('../views/LibraryView.vue') },
    { path: '/read/:id', component: () => import('../views/ReaderView.vue') },
    { path: '/read-pdf/:id', component: () => import('../views/PdfReaderView.vue') },
    { path: '/read-djvu/:id', component: () => import('../views/DjvuReaderView.vue') },
    { path: '/catalogs', component: () => import('../views/CatalogView.vue') },
    { path: '/settings', component: () => import('../views/SettingsView.vue') },
  ],
})
