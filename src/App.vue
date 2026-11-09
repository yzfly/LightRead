<script setup lang="ts">
import { pingUsage } from './services/usageStats'
import { localPack, localTtsAvailable, refreshLocalPack } from './services/localTts'
import { useRoute, useRouter } from 'vue-router'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ToastHost from './components/ToastHost.vue'
import ConfirmHost from './components/ConfirmHost.vue'
import BabeldocTaskStatus from './components/BabeldocTaskStatus.vue'
import LibraryUploadStatus from './components/LibraryUploadStatus.vue'
import WindowTitleBar from './components/WindowTitleBar.vue'
import { initWindowChrome, windowChrome } from './services/windowChrome'
import { useSettings } from './stores/settings'
import { watchReadingViewport } from './services/readingViewport'
import { useAppearance } from './services/appearance'
import { t } from './i18n'
import { isTauri } from './storage'
import { startNativeDrop } from './services/nativeDrop'
import { startExternalOpen } from './services/externalOpen'
import { toast } from './services/toast'
import { requestAutoSync, startAutoSync } from './services/sync'
import { startTransferPolling, transferState } from './services/transfer'
import {
  canInAppInstall,
  downloadErrorMessage,
  downloadInstaller,
  installWithPrompt,
  openDownload,
  pickRecommendedDownload,
  watchPendingInstall,
  watchUpdateAvailability,
  type UpdateInfo,
} from './services/updater'

const settings = useSettings()
onBeforeUnmount(watchReadingViewport())
settings.persistOnChange()
useAppearance()
const route = useRoute()
const router = useRouter()
let stopNativeDrop: (() => void) | undefined
let stopExternalOpen: (() => void) | undefined
let stopSync: (() => void) | undefined
let stopTransfer: (() => void) | undefined
let stopTransferWatch: (() => void) | undefined
let stopUpdateChecks: (() => void) | undefined
let stopPendingInstall: (() => void) | undefined

const updateInfo = ref<UpdateInfo | null>(null)
const updateBusy = ref(false)
const updateProgress = ref<number | null>(null)
const downloadedInstaller = ref('')
const sidebarDownload = computed(() => {
  return updateInfo.value ? pickRecommendedDownload(updateInfo.value.assets) : null
})
const showSidebarUpdate = computed(() => Boolean(updateInfo.value?.hasUpdate))
const sidebarUpdateLabel = computed(() => {
  if (updateBusy.value) {
    return updateProgress.value == null
      ? t('update.downloadingShort')
      : `${Math.round(updateProgress.value * 100)}%`
  }
  return downloadedInstaller.value ? t('update.openShort') : t('update.action')
})
const sidebarUpdateTitle = computed(() => t(sidebarDownload.value ? 'update.sidebarTitle' : 'update.platformPendingTitle', {
  version: updateInfo.value?.version ?? '',
}))

async function handleSidebarUpdate() {
  if (updateBusy.value || !updateInfo.value) return

  const download = sidebarDownload.value
  if (!downloadedInstaller.value && (!download || !canInAppInstall())) {
    try {
      await openDownload(download?.url ?? updateInfo.value.pageUrl)
      toast(t(download ? 'update.browserDownloadStarted' : 'update.platformPending'), download ? 'success' : 'info', 6000)
    } catch {
      toast(t('update.cannotOpenLink'), 'error')
    }
    return
  }

  if (!downloadedInstaller.value && download) {
    updateBusy.value = true
    updateProgress.value = null
    try {
      const encodedName = download.url.split('?')[0].split('/').pop() ?? 'LightRead-installer'
      const fileName = decodeURIComponent(encodedName)
      downloadedInstaller.value = await downloadInstaller(download.url, fileName, progress => {
        updateProgress.value = progress.fraction
      })
    } catch (e) {
      toast(downloadErrorMessage(e), 'error', 10_000, { label: t('update.retry'), run: () => { void handleSidebarUpdate() } })
      return
    } finally {
      updateBusy.value = false
      updateProgress.value = null
    }
  }

  try {
    await installWithPrompt(downloadedInstaller.value)
  } catch (e: any) {
    // 安装包不见了等: 下次点击重新下载
    downloadedInstaller.value = ''
    toast(e?.message || t('update.openFailed'), 'error', 6000)
  }
}

onMounted(async () => {
  void initWindowChrome()
  stopUpdateChecks = watchUpdateAvailability(info => {
    if (updateBusy.value) return
    if (info.version !== updateInfo.value?.version) downloadedInstaller.value = ''
    updateInfo.value = info
  })
  // 安卓: 去开「安装未知应用」回来后接着安装
  stopPendingInstall = watchPendingInstall()
  if (isTauri()) {
    stopNativeDrop = startNativeDrop(router, error => toast(t('library.dropFailed', { msg: String(error) }), 'error', 6000))
    stopExternalOpen = await startExternalOpen(router)
  }
  // 多端同步: 启动一次、切到后台、每 5 分钟 (未开启自动同步时引擎自己跳过)
  stopSync = startAutoSync()
  // 互传: 启动、获得焦点、可见期间定时收取 (未登录且未配置 WebDAV 时什么也不做); 设置里关闭互传时不收取
  stopTransferWatch = watch(() => settings.features.transfer, on => {
    stopTransfer?.()
    stopTransfer = on ? startTransferPolling(() => router.push('/transfer')) : undefined
  }, { immediate: true })
  // 匿名使用统计: 每天一次, 后台进行
  void pingUsage()
  void recoverFromLocalTtsCrash()
})

/** 上次加载离线语音时闪退: 本次启动自动改用在线朗读 (Rust 侧也会拒绝再加载), 并告诉用户 */
async function recoverFromLocalTtsCrash() {
  if (!localTtsAvailable()) return
  await refreshLocalPack()
  if (!localPack.crashed) return
  if (settings.ttsEngine === 'local') settings.ttsEngine = 'edge'
  toast(t('tts.localCrashedRecovered'), 'error', 12000)
}
onBeforeUnmount(() => {
  stopNativeDrop?.()
  stopExternalOpen?.()
  stopSync?.()
  stopTransferWatch?.()
  stopTransfer?.()
  stopUpdateChecks?.()
  stopPendingInstall?.()
})
// 阅读页全屏沉浸, 隐藏侧栏
const immersive = computed(() => String(route.path).startsWith('/read'))
// 退出阅读器 (/read /read-paper /read-djvu) 时同步进度与笔记
watch(immersive, (now, before) => {
  if (before && !now) requestAutoSync('reader-exit')
})

const allNavs = [
  { path: '/library', labelKey: 'nav.library', icon: 'M4 3v18M9 3v18M14 4l6 16M3 21h18' },
  { path: '/papers', labelKey: 'nav.papers', icon: 'M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7' },
  { path: '/catalogs', labelKey: 'nav.catalogs', icon: 'M4 5h16v15H4zM8 2v6M16 2v6M4 10h16M8 14h8' },
  { path: '/stats', labelKey: 'nav.stats', icon: 'M4 21V11M10 21V4M16 21V8M22 21H2' },
  // 互传: 手机底部标签栏已有 5 个, 不再挤第 6 个 (手机入口在藏书页「导入」菜单与设置页), 见 docs/device-transfer.md
  { path: '/transfer', labelKey: 'nav.transfer', desktopOnly: true, icon: 'M4 7h16m-5-4 5 4-5 4M20 17H4m5-4-5 4 5 4' },
]
// 互传关闭时隐藏入口 (连同未读角标)
const navs = computed(() => allNavs.filter(n => n.path !== '/transfer' || settings.features.transfer))

// 设置固定在侧栏左下角, 保持主导航干净
const settingsNav = { path: '/settings', labelKey: 'nav.settings', icon: 'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1zM16 12a4 4 0 1 0-8 0 4 4 0 0 0 8 0' }
</script>

<template>
  <div class="frame">
    <WindowTitleBar v-if="windowChrome.custom" :overlay="!immersive" />
    <div class="shell" :class="{ immersive }">
      <aside v-if="!immersive" class="sidebar">
        <div class="logo" aria-hidden="true">
          <svg viewBox="0 0 48 48" width="30" height="30">
            <defs>
              <linearGradient id="logo-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3B82FF" /><stop offset="1" stop-color="#0F4FE3" /></linearGradient>
            </defs>
            <rect width="48" height="48" rx="11" fill="url(#logo-bg)" />
            <g transform="translate(24 25.6) scale(1.5) translate(-12 -12.4)">
              <path d="M11.25 6.2C9.3 4.9 6.6 4.4 3 4.6v13.9c3.5-.2 6.2.3 8.25 1.6z" fill="#fff" />
              <path d="M12.75 6.2c1.95-1.3 4.65-1.8 8.25-1.6v13.9c-3.5-.2-6.2.3-8.25 1.6z" fill="#fff" fill-opacity=".78" />
            </g>
            <path d="M37 7.2c0 2.6.9 3.5 3.5 3.5-2.6 0-3.5.9-3.5 3.5 0-2.6-.9-3.5-3.5-3.5 2.6 0 3.5-.9 3.5-3.5z" fill="#FFC53D" />
          </svg>
          <span class="logo-text">{{ t('app.name') }}</span>
        </div>
        <nav class="nav" :aria-label="t('nav.mainAria')">
          <router-link
            v-for="n in navs"
            :key="n.path"
            :to="n.path"
            class="nav-item"
            :class="{ 'nav-desktop-only': 'desktopOnly' in n && n.desktopOnly }"
            :title="t(n.labelKey)"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path :d="n.icon" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <span class="nav-label">{{ t(n.labelKey) }}</span>
            <span
              v-if="n.path === '/transfer' && transferState.unread"
              class="nav-badge"
              :aria-label="t('transfer.unread', { n: transferState.unread })"
            >{{ transferState.unread > 99 ? '99+' : transferState.unread }}</span>
          </router-link>
        </nav>
        <div class="sidebar-bottom">
          <router-link :to="settingsNav.path" class="nav-item sidebar-settings" :title="t(settingsNav.labelKey)">
            <span class="sidebar-settings-icon">
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path :d="settingsNav.icon" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <!-- 手机底部标签栏没有更新按钮: 在「设置」图标上挂一个小圆点提示 -->
              <span v-if="showSidebarUpdate" class="sidebar-settings-badge" aria-hidden="true" />
            </span>
            <span class="nav-label">{{ t(settingsNav.labelKey) }}</span>
          </router-link>
          <button
            v-if="showSidebarUpdate"
            class="sidebar-update"
            :class="{
              downloading: updateBusy,
              determinate: updateBusy && updateProgress != null,
              ready: !updateBusy && !!downloadedInstaller,
            }"
            type="button"
            :title="sidebarUpdateTitle"
            :aria-label="sidebarUpdateTitle"
            :aria-busy="updateBusy"
            @click="handleSidebarUpdate"
          >
            <span class="sidebar-update-icon" aria-hidden="true">
              <svg class="sidebar-update-ring" viewBox="0 0 24 24" width="24" height="24">
                <circle class="ring-track" cx="12" cy="12" r="10.5" pathLength="100" />
                <circle
                  class="ring-bar"
                  cx="12"
                  cy="12"
                  r="10.5"
                  pathLength="100"
                  :stroke-dashoffset="updateProgress == null ? 72 : 100 - Math.round(updateProgress * 100)"
                />
              </svg>
              <svg class="sidebar-update-glyph" viewBox="0 0 24 24" width="15" height="15">
                <path d="M12 4.5v10m0 0 4-4m-4 4-4-4M5.5 19.5h13" />
              </svg>
              <span class="sidebar-update-dot" />
            </span>
            <span class="sidebar-update-label" aria-hidden="true">
              {{ sidebarUpdateLabel }}<span v-if="!updateBusy && !downloadedInstaller && updateInfo?.version" class="sidebar-update-version">v{{ updateInfo.version }}</span>
            </span>
          </button>
        </div>
      </aside>
      <main class="main">
        <router-view :key="route.fullPath" />
      </main>
      <BabeldocTaskStatus />
      <LibraryUploadStatus />
      <ToastHost />
      <ConfirmHost />
    </div>
  </div>
</template>

<style scoped>
/* .frame: 自绘标题栏 (Windows) 在上, .shell 占满其余高度; 其他平台没有标题栏, .shell 即整窗 */
.frame {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
}
.shell {
  display: flex;
  flex: 1;
  min-height: 0;
}
/* 安卓 edge-to-edge / iOS 刘海屏: 网页铺到系统栏下, 普通页面让出状态栏与横屏两侧;
   阅读页 (immersive) 自行处理, 背景色可延伸到状态栏下 */
.shell:not(.immersive) {
  padding-top: var(--lr-safe-top);
  padding-left: var(--lr-safe-left);
  padding-right: var(--lr-safe-right);
}
.sidebar {
  width: 208px;
  flex-shrink: 0;
  position: relative;
  z-index: 2;
  background: var(--card);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  padding: 18px 12px calc(16px + var(--lr-safe-bottom));
  transition: width var(--dur) var(--ease);
}
.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 40px;
  padding: 0 8px;
  margin-bottom: 14px;
}
.logo svg {
  flex-shrink: 0;
}
.logo-text {
  font-size: 20px;
  font-weight: 400;
  white-space: nowrap;
}
.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
}
.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 40px;
  padding: 0 10px;
  border-radius: var(--radius);
  color: var(--text-2);
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.nav-item:hover {
  background: var(--surface-2);
  color: var(--text);
  text-decoration: none;
}
.nav-item:active {
  background: var(--surface-3);
}
.nav-item:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.nav-item.router-link-active {
  background: var(--brand-light);
  color: var(--brand);
  font-weight: 600;
}
.nav-item.router-link-active::before {
  content: '';
  position: absolute;
  left: -12px;
  top: 10px;
  bottom: 10px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--brand);
}
.nav-item svg {
  flex-shrink: 0;
}
.nav-label {
  overflow: hidden;
  text-overflow: ellipsis;
}
.nav-badge {
  margin-left: auto;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: var(--radius-pill);
  background: var(--brand);
  color: var(--on-brand);
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.sidebar-bottom {
  position: relative;
  height: 40px;
  flex: none;
}
.sidebar-settings {
  box-sizing: border-box;
  width: 100%;
  height: 40px;
  padding-right: 48px;
  overflow: hidden;
}
.sidebar-settings-icon {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
}
/* 更新胶囊向左展开时会盖住「设置」文字的一半: 先把文字淡出 (不支持 :has 的旧内核只是被盖住) */
.sidebar-settings .nav-label {
  transition: opacity var(--dur) var(--ease);
}
.sidebar-bottom:has(.sidebar-update:hover, .sidebar-update:focus-visible, .sidebar-update.downloading) .sidebar-settings .nav-label {
  opacity: 0;
}
.sidebar-settings-badge {
  display: none;
  position: absolute;
  top: -2px;
  right: -3px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--brand);
  box-shadow: 0 0 0 2px var(--card);
}

/* ---- 侧栏更新按钮: 平时是一枚 32px 的淡品牌色圆钮 (在 40px 的设置行里上下居中) (带呼吸小圆点), 悬停向左展开成胶囊;
   下载中保持展开, 图标外圈显示进度环 ---- */
.sidebar-update {
  position: absolute;
  top: 4px;
  right: 4px;
  width: auto;
  max-width: 32px;
  height: 32px;
  padding: 0;
  display: flex;
  align-items: center;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--brand) 22%, transparent);
  border-radius: var(--radius-pill);
  background: linear-gradient(135deg, var(--brand-light), color-mix(in srgb, var(--brand) 14%, var(--card)));
  color: var(--brand);
  box-shadow: 0 1px 2px color-mix(in srgb, var(--brand) 12%, transparent);
  cursor: pointer;
  font: inherit;
  white-space: nowrap;
  transition:
    max-width var(--dur-slow) var(--ease),
    background-color var(--dur) var(--ease),
    border-color var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);
}
.sidebar-update:hover,
.sidebar-update:focus-visible,
.sidebar-update.downloading {
  max-width: 148px;
  border-color: color-mix(in srgb, var(--brand) 36%, transparent);
  box-shadow: 0 4px 14px color-mix(in srgb, var(--brand) 22%, transparent);
}
.sidebar-update:active {
  background: color-mix(in srgb, var(--brand) 20%, var(--card));
}
.sidebar-update:focus-visible {
  outline: none;
  box-shadow: var(--ring), 0 4px 14px color-mix(in srgb, var(--brand) 22%, transparent);
}
.sidebar-update-icon {
  position: relative;
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  display: grid;
  place-items: center;
}
.sidebar-update-icon > svg {
  grid-area: 1 / 1;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.sidebar-update-glyph {
  stroke-width: 2;
  transition: transform var(--dur) var(--ease);
}
.sidebar-update:hover .sidebar-update-glyph {
  animation: sidebar-update-nudge 900ms var(--ease) 1;
}
/* 进度环: 平时隐藏, 下载中出现; 不确定进度时一段弧线转圈 */
.sidebar-update-ring {
  opacity: 0;
  transform: rotate(-90deg);
  stroke-width: 2.2;
  transition: opacity var(--dur) var(--ease);
}
.ring-track {
  stroke: color-mix(in srgb, var(--brand) 20%, transparent);
}
.ring-bar {
  stroke-dasharray: 100 100;
  transition: stroke-dashoffset var(--dur) linear;
}
.sidebar-update.downloading .sidebar-update-ring {
  opacity: 1;
}
.sidebar-update.downloading .sidebar-update-glyph {
  transform: scale(0.78);
}
.sidebar-update.downloading:not(.determinate) .sidebar-update-ring {
  animation: sidebar-update-spin 900ms linear infinite;
}
/* 「有新版」呼吸小圆点 */
.sidebar-update-dot {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--brand);
  box-shadow: 0 0 0 2px var(--brand-light);
}
.sidebar-update-dot::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: var(--brand);
  animation: sidebar-update-pulse 2.4s var(--ease) infinite;
}
.sidebar-update.downloading .sidebar-update-dot,
.sidebar-update.ready .sidebar-update-dot {
  display: none;
}
.sidebar-update-label {
  /* 悬停展开后总宽 ≥ 114px (e2e 要求 ≥108px) */
  min-width: 72px;
  padding: 0 12px 0 1px;
  text-align: left;
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: 0.01em;
  line-height: 30px;
  font-variant-numeric: tabular-nums;
  opacity: 0;
  transition: opacity var(--dur) var(--ease);
}
.sidebar-update-version {
  margin-left: 5px;
  font-size: 11px;
  font-weight: 500;
  opacity: 0.72;
}
.sidebar-update:hover .sidebar-update-label,
.sidebar-update:focus-visible .sidebar-update-label,
.sidebar-update.downloading .sidebar-update-label {
  opacity: 1;
}
.sidebar-update.downloading {
  cursor: progress;
}
:root[data-theme='dark'] .sidebar-update {
  border-color: color-mix(in srgb, var(--brand) 32%, transparent);
  background: linear-gradient(135deg, var(--brand-light), color-mix(in srgb, var(--brand) 22%, var(--card)));
  box-shadow: none;
}
:root[data-theme='dark'] .sidebar-update:hover,
:root[data-theme='dark'] .sidebar-update.downloading {
  border-color: color-mix(in srgb, var(--brand) 50%, transparent);
  box-shadow: 0 6px 20px color-mix(in srgb, var(--brand) 18%, transparent);
}
@keyframes sidebar-update-pulse {
  0% { transform: scale(1); opacity: 0.55; }
  70%, 100% { transform: scale(2.6); opacity: 0; }
}
@keyframes sidebar-update-spin {
  to { transform: rotate(270deg); }
}
@keyframes sidebar-update-nudge {
  0%, 100% { transform: translateY(0); }
  35% { transform: translateY(2px); }
  65% { transform: translateY(-1px); }
}
.main {
  flex: 1;
  min-width: 0;
  overflow: auto;
  overscroll-behavior: contain;
}

.immersive .main {
  overflow: hidden;
}

/* 平板 / 窄窗口: 收成图标栏, 悬停显示 title */
@media (min-width: 721px) and (max-width: 1023px) {
  .sidebar {
    width: 68px;
    padding-inline: 10px;
    align-items: stretch;
  }
  .logo {
    justify-content: center;
    padding: 0;
  }
  .logo-text,
  .nav-label {
    display: none;
  }
  .nav-badge {
    position: absolute;
    top: 4px;
    right: 6px;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    font-size: 10px;
    line-height: 16px;
  }
  .nav-item {
    justify-content: center;
    padding: 0;
    height: 44px;
  }
  .nav-item.router-link-active::before {
    left: -10px;
  }
  .sidebar-settings {
    padding-right: 0;
  }
  .sidebar-bottom {
    height: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  /* 图标栏: 更新按钮放在设置图标下方, 居中的方圆钮, 不展开 */
  .sidebar-update {
    position: relative;
    top: 0;
    right: 0;
    align-self: center;
    max-width: 32px;
    width: 32px;
    justify-content: center;
    border-radius: var(--radius-lg);
  }
  .sidebar-update:hover,
  .sidebar-update:focus-visible,
  .sidebar-update.downloading {
    max-width: 32px;
  }
  .sidebar-update-label {
    display: none;
  }
}

/* 手机: 底部标签栏, 图标在上文字在下, 预留手势区安全边距 */
@media (max-width: 720px) {
  .shell:not(.immersive) {
    flex-direction: column-reverse;
  }
  .sidebar {
    width: 100%;
    flex-direction: row;
    align-items: stretch;
    padding: 4px 6px calc(4px + var(--lr-safe-bottom));
    border-right: none;
    border-top: 1px solid var(--border);
    box-shadow: 0 -1px 0 color-mix(in srgb, var(--border) 50%, transparent);
  }
  .logo {
    display: none;
  }
  .nav-desktop-only {
    display: none;
  }
  .nav {
    flex-direction: row;
    flex: 4;
    gap: 2px;
  }
  .nav-item {
    flex: 1;
    flex-direction: column;
    justify-content: center;
    gap: 3px;
    height: 52px;
    min-width: 0;
    padding: 0 4px;
    font-size: 11px;
    font-weight: 500;
    border-radius: var(--radius);
  }
  .nav-item svg {
    width: 22px;
    height: 22px;
  }
  .nav-item.router-link-active {
    background: transparent;
  }
  .nav-item.router-link-active::before {
    left: 50%;
    top: -4px;
    bottom: auto;
    width: 24px;
    height: 3px;
    transform: translateX(-50%);
    border-radius: 0 0 3px 3px;
  }
  .sidebar-bottom {
    flex: 1;
    height: auto;
    display: flex;
  }
  .sidebar-settings {
    width: 100%;
    height: 52px;
    padding-right: 4px;
    overflow: visible;
  }
  .sidebar-update {
    display: none;
  }
  .sidebar-settings-badge {
    display: block;
  }
}

@media (prefers-reduced-motion: reduce) {
  .sidebar,
  .sidebar-settings .nav-label,
  .sidebar-update,
  .sidebar-update-label,
  .sidebar-update-glyph,
  .ring-bar {
    transition: none;
  }
  .sidebar-update-dot::after,
  .sidebar-update:hover .sidebar-update-glyph {
    animation: none;
  }
  .sidebar-update-dot::after {
    display: none;
  }
  /* 不确定进度时不转圈, 停成一段静止弧线 */
  .sidebar-update.downloading:not(.determinate) .sidebar-update-ring {
    animation: none;
  }
}
</style>
