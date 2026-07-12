<script setup lang="ts">
import { useRoute } from 'vue-router'
import { computed } from 'vue'
import ToastHost from './components/ToastHost.vue'
import { useSettings } from './stores/settings'
import { t } from './i18n'

useSettings().persistOnChange()
const route = useRoute()
// 阅读页全屏沉浸, 隐藏侧栏
const immersive = computed(() => String(route.path).startsWith('/read'))

const navs = [
  { path: '/library', labelKey: 'nav.library', icon: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5a2.5 2.5 0 0 1-2.5 2.5H6.5A2.5 2.5 0 0 1 4 18.5v-13zM6.5 5A.5.5 0 0 0 6 5.5V16.05c.16-.03.32-.05.5-.05H18V5H6.5zM6 18.5a.5.5 0 0 0 .5.5H18v-1H6.5a.5.5 0 0 0-.5.5z' },
  { path: '/catalogs', labelKey: 'nav.catalogs', icon: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM4.06 13h3.97c.1 1.9.5 3.63 1.1 5.02A8.02 8.02 0 0 1 4.06 13zm0-2a8.02 8.02 0 0 1 5.07-7.02c-.6 1.4-1 3.12-1.1 5.02H4.06zM12 4.04c.83.9 1.72 2.87 1.94 6.96h-3.88c.22-4.09 1.1-6.05 1.94-6.96zM10.06 13h3.88c-.22 4.09-1.11 6.05-1.94 6.96-.83-.9-1.72-2.87-1.94-6.96zm5.9 0h3.98a8.02 8.02 0 0 1-5.07 5.02c.6-1.4 1-3.12 1.1-5.02zm0-2c-.1-1.9-.5-3.63-1.1-5.02A8.02 8.02 0 0 1 19.95 11h-3.98z' },
]

// 设置固定在侧栏左下角, 保持主导航干净
const settingsNav = { path: '/settings', labelKey: 'nav.settings', icon: 'M10.83 3.28a1.5 1.5 0 0 1 2.34 0l.94 1.16c.24.3.62.45 1 .4l1.47-.2a1.5 1.5 0 0 1 1.69 1.61l-.12 1.49c-.03.38.14.75.46.97l1.23.85a1.5 1.5 0 0 1 .4 2.3l-.86 1.22c-.22.31-.26.72-.1 1.07l.6 1.36a1.5 1.5 0 0 1-1.17 2.03l-1.47.24c-.38.06-.7.32-.83.68l-.52 1.4a1.5 1.5 0 0 1-2.2.8l-1.28-.77a1.13 1.13 0 0 0-1.08 0l-1.28.76a1.5 1.5 0 0 1-2.2-.79l-.52-1.4a1.13 1.13 0 0 0-.83-.68l-1.47-.24a1.5 1.5 0 0 1-1.17-2.03l.6-1.36c.16-.35.12-.76-.1-1.07l-.87-1.22a1.5 1.5 0 0 1 .41-2.3l1.23-.85c.32-.22.49-.59.46-.97l-.12-1.5a1.5 1.5 0 0 1 1.69-1.6l1.48.2c.37.05.75-.1.99-.4l.94-1.16zM12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z' }
</script>

<template>
  <div class="shell" :class="{ immersive }">
    <aside v-if="!immersive" class="sidebar">
      <div class="logo">
        <svg viewBox="0 0 48 48" width="30" height="30">
          <rect width="48" height="48" rx="10" fill="#1664FF" />
          <path d="M14 12h9c2.2 0 4 1.8 4 4v20c0-1.7-1.3-3-3-3H14V12z" fill="#fff" opacity=".95" />
          <path d="M34 12h-7c-2.2 0-4 1.8-4 4v20c0-1.7 1.3-3 3-3h8V12z" fill="#fff" opacity=".7" />
        </svg>
        <span class="logo-text">{{ t('app.name') }}</span>
      </div>
      <nav>
        <router-link v-for="n in navs" :key="n.path" :to="n.path" class="nav-item">
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path :d="n.icon" fill="currentColor" />
          </svg>
          {{ t(n.labelKey) }}
        </router-link>
      </nav>
      <div class="sidebar-bottom">
        <router-link :to="settingsNav.path" class="nav-item">
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path :d="settingsNav.icon" fill="currentColor" />
          </svg>
          {{ t(settingsNav.labelKey) }}
        </router-link>
      </div>
    </aside>
    <main class="main">
      <router-view />
    </main>
    <ToastHost />
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  height: 100%;
}
.sidebar {
  width: 200px;
  flex-shrink: 0;
  background: var(--card);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  padding: 20px 12px;
}
.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 10px 20px;
}
.logo-text {
  font-size: 18px;
  font-weight: 600;
}
nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius);
  color: var(--text-2);
  font-size: 14px;
  transition: all 0.15s;
}
.nav-item:hover {
  background: var(--bg);
  color: var(--text);
}
.nav-item.router-link-active {
  background: var(--brand-light);
  color: var(--brand);
  font-weight: 500;
}
.sidebar-bottom {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.main {
  flex: 1;
  min-width: 0;
  overflow: auto;
}
.immersive .main {
  overflow: hidden;
}

@media (max-width: 720px) {
  .shell:not(.immersive) {
    flex-direction: column-reverse;
  }
  .sidebar {
    width: 100%;
    flex-direction: row;
    align-items: center;
    padding: 6px 12px;
    border-right: none;
    border-top: 1px solid var(--border);
  }
  .logo {
    display: none;
  }
  nav {
    flex-direction: row;
    justify-content: space-around;
  }
  /* 移动端底栏: 设置回到同一行 */
  .sidebar-bottom {
    flex-direction: row;
    flex: 1;
    justify-content: space-around;
  }
}
</style>
