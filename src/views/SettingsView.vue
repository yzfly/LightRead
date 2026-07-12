<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { getStorage, isTauri } from '../storage'
import { useSettings } from '../stores/settings'
import { useLibrary } from '../stores/library'
import { exportBackup, importBackup } from '../services/backup'
import { backupToWebdav, restoreFromWebdav, testWebdav, webdavBackupInfo } from '../services/webdav'
import { fetchRemote } from '../services/net'
import { toast } from '../services/toast'
import {
  CURRENT_VERSION, RELEASES_URL, REPO_URL, ISSUES_URL,
  checkUpdate, pickDownloads, openDownload, canInAppInstall,
  downloadInstaller, openInstaller, copyLink,
  type UpdateInfo, type DownloadOption,
} from '../services/updater'
import { t } from '../i18n'
import { AI_PROVIDERS, providerById, chatStream } from '../services/ai'

const settings = useSettings()
const library = useLibrary()

const storageKind = ref('')
const busy = ref('')
const backupInput = ref<HTMLInputElement>()

// ---- WebDAV ----
const davInfo = ref('')

async function davTest() {
  busy.value = t('settings.testing')
  try {
    await testWebdav()
    const info = await webdavBackupInfo()
    davInfo.value = info
      ? t('settings.davOk', { size: (info.size / 1024 / 1024).toFixed(1), date: info.modified.slice(0, 22) })
      : t('settings.davOkEmpty')
  } catch (e: any) {
    davInfo.value = `❌ ${e?.message}`
  } finally {
    busy.value = ''
  }
}

async function davBackup() {
  busy.value = t('settings.preparingBackup')
  try {
    await backupToWebdav(msg => (busy.value = msg))
    toast(t('settings.backedUp'), 'success')
    davInfo.value = ''
  } catch (e: any) {
    toast(t('settings.cloudBackupFailed', { msg: e?.message }), 'error', 6000)
  } finally {
    busy.value = ''
  }
}

async function davRestore() {
  if (!confirm(t('settings.restoreConfirm'))) return
  busy.value = t('settings.connectingCloud')
  try {
    const result = await restoreFromWebdav(msg => (busy.value = msg))
    await library.refresh()
    toast(t('settings.restoreDone', { books: result.books, annotations: result.annotations }), 'success', 5000)
  } catch (e: any) {
    toast(t('settings.restoreFailed', { msg: e?.message }), 'error', 6000)
  } finally {
    busy.value = ''
  }
}

// ---- 代理配置 (桌面端) ----
const PROXY_SCHEMES: Array<{ label?: string; labelKey?: string; value: string }> = [
  { labelKey: 'settings.proxyNone', value: '' },
  { label: 'HTTP', value: 'http' },
  { label: 'HTTPS', value: 'https' },
  { label: 'SOCKS5', value: 'socks5' },
  { labelKey: 'settings.proxySocks5h', value: 'socks5h' },
  { label: 'SOCKS4', value: 'socks4' },
]

const proxy = reactive({ scheme: '', host: '127.0.0.1', port: '7890', username: '', password: '' })

function parseProxyUrl(raw: string) {
  const m = raw.trim().match(
    /^(https?|socks5h?|socks4a?):\/\/(?:([^:@/]+)(?::([^@/]*))?@)?([^:/@]+)(?::(\d+))?$/i)
  if (!m) return
  proxy.scheme = m[1].toLowerCase()
  proxy.username = m[2] ? decodeURIComponent(m[2]) : ''
  proxy.password = m[3] ? decodeURIComponent(m[3]) : ''
  proxy.host = m[4]
  proxy.port = m[5] ?? ''
}

function composeProxyUrl(): string {
  if (!proxy.scheme || !proxy.host.trim()) return ''
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}${proxy.password ? ':' + encodeURIComponent(proxy.password) : ''}@`
    : ''
  const port = proxy.port.trim() ? `:${proxy.port.trim()}` : ''
  return `${proxy.scheme}://${auth}${proxy.host.trim()}${port}`
}

watch(proxy, () => {
  settings.httpProxy = composeProxyUrl()
})

// ---- 代理连通性测试 ----
const testing = ref(false)
const testResult = ref('')

async function testProxy() {
  testing.value = true
  testResult.value = ''
  const start = performance.now()
  try {
    await fetchRemote('https://www.google.com/generate_204')
    testResult.value = t('settings.proxyOk', { ms: Math.round(performance.now() - start) })
  } catch (e: any) {
    testResult.value = `❌ ${e?.message ?? t('settings.connectionFailed')}`
  } finally {
    testing.value = false
  }
}

onMounted(async () => {
  parseProxyUrl(settings.httpProxy)
  doCheckUpdate(false)
  const storage = await getStorage()
  storageKind.value = storage.kind
})

// ---- AI 助手 ----
const aiTesting = ref(false)
const aiTestResult = ref('')

function onAiProviderChange() {
  const preset = providerById(settings.aiProvider)
  if (preset.id !== 'custom') {
    settings.aiBaseUrl = preset.baseUrl
    settings.aiModel = preset.defaultModel
  }
  aiTestResult.value = ''
}

const aiDocsUrl = computed(() => providerById(settings.aiProvider).docsUrl ?? '')

async function testAi() {
  if (aiTesting.value) return
  aiTesting.value = true
  aiTestResult.value = ''
  const started = performance.now()
  try {
    let got = ''
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout 20s')), 20000))
    await Promise.race([
      (async () => {
        for await (const delta of chatStream([{ role: 'user', content: '请回复: OK' }])) {
          got += delta
          if (got.length >= 2) break
        }
      })(),
      timeout,
    ])
    aiTestResult.value = `✅ ${t('settings.aiTestOk', { ms: Math.round(performance.now() - started), reply: got.slice(0, 20) })}`
  } catch (e: any) {
    aiTestResult.value = `❌ ${e?.message ?? e}`
  } finally {
    aiTesting.value = false
  }
}

// ---- 版本与更新 ----
const updateInfo = ref<UpdateInfo | null>(null)
const checking = ref(false)
const checkError = ref('')
/** 手动检查过才显示"已是最新", 静默检查只在有新版时提示 */
const checkedManually = ref(false)
const downloads = computed(() => updateInfo.value ? pickDownloads(updateInfo.value.assets) : [])

async function doCheckUpdate(manual = true) {
  if (checking.value) return
  checking.value = true
  checkError.value = ''
  if (manual) checkedManually.value = true
  try {
    updateInfo.value = await checkUpdate(manual)
  } catch (e: any) {
    if (manual) checkError.value = e?.message ?? t('update.checkFailed')
  } finally {
    checking.value = false
  }
}

const fmtSize = (bytes: number) => `${(bytes / 1048576).toFixed(0)} MB`

async function download(url: string) {
  try {
    await openDownload(url)
  } catch {
    toast(t('update.cannotOpenLink'), 'error')
  }
}

// ---- 应用内下载安装 (桌面端, 走已配置的网络代理) ----
const installing = ref('')
const installedPath = ref('')

async function downloadOption(d: DownloadOption) {
  if (!canInAppInstall()) {
    await download(d.url)
    toast(t('update.browserDownloadStarted'), 'success')
    return
  }
  if (installing.value) return
  installing.value = t('common.connecting')
  installedPath.value = ''
  try {
    const fileName = decodeURIComponent(d.url.split('/').pop() ?? 'LightRead-installer')
    const path = await downloadInstaller(d.url, fileName, p => {
      installing.value = p.fraction != null
        ? t('update.downloadingPct', { pct: (p.fraction * 100).toFixed(0), received: p.receivedMB, total: p.totalMB })
        : t('update.downloadingMB', { received: p.receivedMB })
    })
    installing.value = ''
    installedPath.value = path
    toast(t('update.downloadDoneOpening'), 'success')
    await openInstaller(path)
  } catch (e: any) {
    installing.value = ''
    toast(t('update.downloadFailed', { msg: e?.message ?? e }), 'error', 6000)
  }
}

async function doCopyLink(url: string) {
  const ok = await copyLink(url)
  toast(ok ? t('update.linkCopied') : t('common.copyFailed'), ok ? 'success' : 'error')
}

// ---- 存储位置 (桌面端) ----
const migrating = ref('')

async function changeLibraryRoot() {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const picked = await open({ directory: true, title: t('settings.pickLibraryFolder') })
  if (typeof picked !== 'string') return
  const { hasLibraryAt, migrateLibraryTo } = await import('../storage/tauri')

  try {
    if (await hasLibraryAt(picked)) {
      if (!confirm(t('settings.useExistingLibrary', { path: picked }))) return
    } else {
      if (!confirm(t('settings.migrateConfirm', { path: picked }))) return
      migrating.value = t('settings.preparingMigration')
      await migrateLibraryTo(picked, msg => (migrating.value = msg))
    }
    settings.libraryRoot = picked
    // 设置持久化有 300ms 防抖, 直接落盘后重载
    localStorage.setItem('lightread-settings', JSON.stringify(settings.$state))
    toast(t('settings.locationSwitched'), 'success')
    setTimeout(() => location.reload(), 800)
  } catch (e: any) {
    migrating.value = ''
    toast(t('settings.switchFailed', { msg: e?.message ?? t('common.unknownError') }), 'error', 6000)
  }
}

function resetLibraryRoot() {
  if (!confirm(t('settings.resetLocationConfirm'))) return
  settings.libraryRoot = ''
  localStorage.setItem('lightread-settings', JSON.stringify(settings.$state))
  setTimeout(() => location.reload(), 300)
}

async function doExport() {
  busy.value = t('settings.preparingExport')
  try {
    const blob = await exportBackup(msg => (busy.value = msg))
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `lightread-backup-${new Date().toISOString().slice(0, 10)}.zip`
    a.click()
    URL.revokeObjectURL(a.href)
    toast(t('settings.backupExported'), 'success')
  } catch (e: any) {
    toast(t('settings.exportFailed', { msg: e?.message }), 'error', 5000)
  } finally {
    busy.value = ''
  }
}

async function doImport(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  busy.value = t('settings.readingBackup')
  try {
    const result = await importBackup(file, msg => (busy.value = msg))
    await library.refresh()
    toast(t('settings.importDone', { books: result.books, annotations: result.annotations, sources: result.sources }), 'success', 5000)
  } catch (e: any) {
    toast(t('settings.restoreFailed', { msg: e?.message }), 'error', 5000)
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <div class="settings">
    <h1>{{ t('settings.title') }}</h1>

    <section class="card section">
      <h2>{{ t('settings.general') }}</h2>
      <div class="row">
        <div>
          <div class="row-title">{{ t('settings.language') }}</div>
        </div>
        <div class="seg">
          <button :class="{ active: settings.language === 'zh' }" @click="settings.language = 'zh'">中文</button>
          <button :class="{ active: settings.language === 'en' }" @click="settings.language = 'en'">English</button>
        </div>
      </div>
    </section>

    <section class="card section">
      <h2>{{ t('settings.data') }}</h2>
      <div class="row">
        <div>
          <div class="row-title">{{ t('settings.storageBackend') }}</div>
          <div class="row-desc">{{ storageKind === 'filesystem' ? t('settings.storageDesktop') : t('settings.storageWeb') }}</div>
        </div>
      </div>
      <div v-if="isTauri()" class="row">
        <div style="min-width: 0">
          <div class="row-title">{{ t('settings.storageLocation') }}</div>
          <div class="row-desc">
            {{ t('settings.storageLocationDesc') }}<br />
            {{ t('common.current') }}: <code>{{ settings.libraryRoot || t('settings.defaultAppData') }}</code>
          </div>
        </div>
        <div class="row-actions">
          <button class="btn" :disabled="!!migrating" @click="changeLibraryRoot">{{ t('settings.changeLocation') }}</button>
          <button v-if="settings.libraryRoot" class="btn" :disabled="!!migrating" @click="resetLibraryRoot">{{ t('settings.restoreDefault') }}</button>
        </div>
      </div>
      <div v-if="migrating" class="busy">{{ migrating }}</div>
      <div class="row">
        <div>
          <div class="row-title">{{ t('settings.backupRestore') }}</div>
          <div class="row-desc">{{ t('settings.backupDesc') }}</div>
        </div>
        <div class="row-actions">
          <button class="btn" :disabled="!!busy" @click="doExport">{{ t('settings.exportBackup') }}</button>
          <button class="btn" :disabled="!!busy" @click="backupInput?.click()">{{ t('settings.importBackup') }}</button>
          <input ref="backupInput" type="file" accept=".zip" hidden @change="doImport" />
        </div>
      </div>
      <div class="row">
        <div style="min-width: 0">
          <div class="row-title">{{ t('settings.webdavTitle') }}</div>
          <div class="row-desc">
            {{ t('settings.webdavDesc') }}<br />
            {{ t('settings.webdavExample') }}: <code>https://dav.jianguoyun.com/dav/</code> {{ t('settings.webdavPassHint') }}
          </div>
        </div>
      </div>
      <div class="webdav-grid">
        <input v-model="settings.webdavUrl" class="input" placeholder="https://dav.jianguoyun.com/dav/" />
        <input v-model="settings.webdavUser" class="input" :placeholder="t('settings.account')" autocomplete="off" />
        <input v-model="settings.webdavPass" class="input" type="password" :placeholder="t('settings.password')" autocomplete="new-password" />
      </div>
      <div class="webdav-actions">
        <button class="btn btn-sm" :disabled="!!busy || !settings.webdavUrl" @click="davTest">{{ t('settings.testConnection') }}</button>
        <button class="btn btn-sm btn-primary" :disabled="!!busy || !settings.webdavUrl" @click="davBackup">{{ t('settings.backupToCloud') }}</button>
        <button class="btn btn-sm" :disabled="!!busy || !settings.webdavUrl" @click="davRestore">{{ t('settings.restoreFromCloud') }}</button>
        <span v-if="davInfo" class="dav-info">{{ davInfo }}</span>
      </div>
      <div v-if="busy" class="busy">{{ busy }}</div>
    </section>

    <section class="card section">
      <h2>{{ t('settings.network') }}</h2>
      <template v-if="isTauri()">
        <div class="row">
          <div>
            <div class="row-title">{{ t('settings.proxyTitle') }}</div>
            <div class="row-desc">
              {{ t('settings.proxyDesc') }}
              ({{ t('settings.proxyDescPort') }} <code>7890</code>)
            </div>
          </div>
        </div>
        <div class="proxy-grid">
          <select v-model="proxy.scheme" class="input">
            <option v-for="s in PROXY_SCHEMES" :key="s.value" :value="s.value">{{ s.labelKey ? t(s.labelKey) : s.label }}</option>
          </select>
          <input v-model="proxy.host" class="input" :placeholder="t('settings.proxyHostPlaceholder')" :disabled="!proxy.scheme" />
          <input v-model="proxy.port" class="input port" :placeholder="t('settings.proxyPort')" :disabled="!proxy.scheme" />
        </div>
        <div v-if="proxy.scheme" class="proxy-grid">
          <input v-model="proxy.username" class="input" :placeholder="t('common.usernameOptional')" autocomplete="off" />
          <input v-model="proxy.password" class="input" type="password" :placeholder="t('common.passwordOptional')" autocomplete="new-password" />
          <button class="btn port" :disabled="testing" @click="testProxy">
            {{ testing ? t('settings.testingProxy') : t('settings.testConnection') }}
          </button>
        </div>
        <div v-if="settings.httpProxy" class="proxy-current">{{ t('common.current') }}: <code>{{ settings.httpProxy }}</code></div>
        <div v-if="testResult" class="proxy-result">{{ testResult }}</div>
      </template>
      <template v-else>
        <div class="row">
          <div>
            <div class="row-title">{{ t('settings.corsTitle') }}</div>
            <div class="row-desc">
              {{ t('settings.corsDesc1') }}<br />
              {{ t('settings.corsDesc2pre') }} <code>{url}</code> {{ t('settings.corsDesc2post') }}
            </div>
          </div>
        </div>
        <input
          v-model="settings.corsProxy"
          class="input proxy-input"
          placeholder="https://your-proxy.example.com/?url={url}"
        />
      </template>
    </section>

    <section class="card section">
      <h2>{{ t('settings.aiTitle') }}</h2>
      <div class="row">
        <div style="min-width: 0">
          <div class="row-title">{{ t('settings.aiProvider') }}</div>
          <div class="row-desc">{{ t('settings.aiDesc') }}</div>
        </div>
      </div>
      <div class="ai-grid">
        <select v-model="settings.aiProvider" class="input" @change="onAiProviderChange">
          <option v-for="p in AI_PROVIDERS" :key="p.id" :value="p.id">
            {{ p.label }}{{ p.id === 'siliconflow' || p.id === 'zhipu' ? t('settings.aiFreeTag') : '' }}
          </option>
        </select>
        <input v-model="settings.aiModel" class="input" :placeholder="t('settings.aiModelPh')" />
      </div>
      <div class="ai-grid">
        <input v-model="settings.aiBaseUrl" class="input" placeholder="https://api.siliconflow.cn/v1" />
        <input v-model="settings.aiApiKey" class="input" type="password" :placeholder="t('settings.aiKeyPh')" autocomplete="new-password" />
      </div>
      <div class="webdav-actions">
        <button class="btn btn-sm btn-primary" :disabled="aiTesting || !settings.aiBaseUrl || !settings.aiModel" @click="testAi">
          {{ aiTesting ? t('settings.testing') : t('settings.aiTest') }}
        </button>
        <a v-if="aiDocsUrl" href="javascript:void 0" class="ai-key-link" @click="download(aiDocsUrl)">{{ t('settings.aiGetKey') }}</a>
        <span v-if="aiTestResult" class="dav-info">{{ aiTestResult }}</span>
      </div>
    </section>

    <section class="card section">
      <h2>{{ t('settings.reading') }}</h2>
      <div class="row">
        <div>
          <div class="row-title">{{ t('settings.resetTypography') }}</div>
          <div class="row-desc">{{ t('settings.resetTypographyDesc') }}</div>
        </div>
        <button class="btn" @click="settings.resetReader(); toast(t('settings.resetDone'), 'success')">{{ t('settings.restoreDefault') }}</button>
      </div>
    </section>

    <section class="card section">
      <h2>{{ t('settings.about') }}</h2>

      <div class="app-identity">
        <img class="app-icon" src="/icon-192.png" alt="LightRead" />
        <div class="app-meta">
          <div class="app-name">
            LightRead 轻阅
            <span class="version-chip">v{{ CURRENT_VERSION }}</span>
            <span class="env-chip">{{ isTauri() ? t('settings.desktopVersion') : t('settings.webVersion') }}</span>
          </div>
          <div class="app-tagline">{{ t('settings.tagline') }}</div>
        </div>
        <button class="btn" :disabled="checking" @click="doCheckUpdate()">
          {{ checking ? t('update.checking') : t('update.check') }}
        </button>
      </div>

      <!-- 检查结果 -->
      <div v-if="checkError" class="update-state error">❌ {{ checkError }}</div>
      <div v-else-if="checkedManually && !checking && updateInfo && !updateInfo.hasUpdate" class="update-state ok">
        ✅ {{ t('update.latest') }}
      </div>

      <!-- 新版本卡片 -->
      <div v-if="updateInfo?.hasUpdate" class="update-card">
        <div class="update-head">
          <span class="update-badge">{{ t('update.newVersion') }}</span>
          <strong>v{{ updateInfo.version }}</strong>
          <span class="update-date">{{ updateInfo.publishedAt }}</span>
        </div>
        <pre v-if="updateInfo.notes" class="update-notes">{{ updateInfo.notes }}</pre>
        <div class="update-actions">
          <template v-for="(d, i) in downloads.filter(x => x.recommended)" :key="d.url">
            <button
              class="btn btn-sm"
              :class="{ 'btn-primary': i === 0 }"
              :disabled="!!installing"
              @click="downloadOption(d)"
            >
              ⬇ {{ d.label }} · {{ fmtSize(d.size) }}
            </button>
            <button class="copy-link-btn" :title="t('update.copyLinkTitle')" @click="doCopyLink(d.url)">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M8 5a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-2v-2h2a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1h-8a1 1 0 0 0-1 1v2H8V5zM2 11a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3v-8zm3-1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1H5z"/></svg>
            </button>
          </template>
          <a class="all-downloads" href="javascript:void 0" @click="download(updateInfo.pageUrl)">
            {{ t('update.allPlatforms') }}
          </a>
        </div>
        <div v-if="installing" class="install-progress">
          {{ installing }}
          <span v-if="settings.httpProxy" class="install-hint">{{ t('update.viaProxy', { proxy: settings.httpProxy }) }}</span>
        </div>
        <div v-else-if="installedPath" class="install-done">
          ✅ {{ t('update.downloadedTo') }} <code>{{ installedPath }}</code>
          <button class="btn btn-sm" @click="openInstaller(installedPath)">{{ t('update.openInstaller') }}</button>
        </div>
        <p v-else-if="canInAppInstall()" class="install-tip">
          {{ t('update.installTipMain') }}{{ settings.httpProxy ? t('update.installTipProxied') : t('update.installTipNoProxy') }}{{ t('update.installTipEnd') }}
        </p>
      </div>

      <div class="about">
        <p>
          {{ t('settings.aboutFormats') }}
        </p>
        <p class="about-links">
          <a href="javascript:void 0" @click="download(REPO_URL)">{{ t('settings.repoLink') }}</a>
          <a href="javascript:void 0" @click="download(ISSUES_URL)">{{ t('settings.issuesLink') }}</a>
          <a href="javascript:void 0" @click="download(RELEASES_URL)">{{ t('settings.releasesLink') }}</a>
        </p>
        <p class="muted">
          {{ t('settings.author') }}: 云中江树 ({{ t('settings.wechat') }}: 云中江树) · {{ t('settings.license') }}: CC BY-NC 4.0
        </p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings {
  padding: 24px 28px 40px;
  max-width: 760px;
}
h1 {
  font-size: 20px;
  margin-bottom: 18px;
}
.section {
  padding: 18px 20px;
  margin-bottom: 14px;
}
h2 {
  font-size: 14px;
  color: var(--text-2);
  margin-bottom: 12px;
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 8px 0;
}
.row-title {
  font-size: 14px;
  font-weight: 500;
}
.row-desc {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 4px;
  line-height: 1.7;
}
.row-desc code {
  background: var(--bg);
  padding: 1px 5px;
  border-radius: 4px;
}
.row-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
/* 语言切换按钮组 (与阅读器工具栏 seg 同款) */
.seg {
  display: flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  flex-shrink: 0;
}
.seg button {
  height: 30px;
  padding: 0 14px;
  border: none;
  background: var(--card);
  color: var(--text-2);
  font-size: 13px;
}
.seg button.active {
  background: var(--brand-light);
  color: var(--brand);
  font-weight: 500;
}
.busy {
  font-size: 12px;
  color: var(--brand);
  padding-top: 6px;
}
.ai-grid {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.ai-grid .input {
  flex: 1;
  min-width: 0;
}
.ai-key-link {
  font-size: 12px;
  color: var(--brand);
}
.webdav-grid {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.webdav-grid .input:first-child {
  flex: 2;
}
.webdav-grid .input {
  flex: 1;
  min-width: 0;
}
.webdav-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 8px;
  flex-wrap: wrap;
}
.dav-info {
  font-size: 12px;
  color: var(--text-3);
}
.proxy-input {
  width: 100%;
  margin-top: 8px;
}
.proxy-grid {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.proxy-grid .input:first-child,
.proxy-grid select {
  width: 200px;
  flex-shrink: 0;
}
.proxy-grid .input {
  flex: 1;
  min-width: 0;
}
.proxy-grid .port {
  width: 110px;
  flex: none;
}
.proxy-current {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-3);
}
.proxy-current code {
  background: var(--bg);
  padding: 1px 5px;
  border-radius: 4px;
}
.proxy-result {
  margin-top: 6px;
  font-size: 13px;
}
.app-identity {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 6px 0 14px;
}
.app-icon {
  width: 56px;
  height: 56px;
  border-radius: 14px;
  flex-shrink: 0;
}
.app-meta {
  flex: 1;
  min-width: 0;
}
.app-name {
  font-size: 16px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.version-chip {
  font-size: 12px;
  font-weight: 500;
  color: var(--brand);
  background: var(--brand-light);
  border-radius: 999px;
  padding: 1px 10px;
}
.env-chip {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-3);
  background: var(--bg);
  border-radius: 999px;
  padding: 1px 10px;
}
.app-tagline {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 4px;
}
.update-state {
  font-size: 13px;
  padding: 8px 0;
}
.update-state.error {
  color: #d54941;
}
.update-card {
  border: 1px solid var(--brand-light);
  background: linear-gradient(135deg, var(--brand-light), transparent 70%);
  border-radius: var(--radius);
  padding: 14px 16px;
  margin-bottom: 12px;
}
.update-head {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 15px;
}
.update-badge {
  font-size: 12px;
  color: #fff;
  background: var(--brand);
  border-radius: 999px;
  padding: 1px 10px;
}
.update-date {
  font-size: 12px;
  color: var(--text-3);
}
.update-notes {
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.8;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  max-height: 160px;
  overflow: auto;
  margin: 10px 0 0;
}
.update-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.all-downloads {
  font-size: 12px;
  color: var(--text-3);
}
.all-downloads:hover {
  color: var(--brand);
}
.copy-link-btn {
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--text-3);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: -4px;
}
.copy-link-btn:hover {
  background: var(--bg);
  color: var(--brand);
}
.install-progress {
  font-size: 13px;
  color: var(--brand);
  margin-top: 10px;
}
.install-hint {
  font-size: 12px;
  color: var(--text-3);
  margin-left: 8px;
}
.install-done {
  font-size: 12px;
  color: var(--text-2);
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.install-done code {
  background: var(--bg);
  padding: 1px 6px;
  border-radius: 4px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.install-tip {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 10px;
  line-height: 1.7;
}
.about {
  border-top: 1px solid var(--border);
  padding-top: 12px;
}
.about p {
  font-size: 13px;
  line-height: 1.9;
  color: var(--text-2);
  margin-bottom: 8px;
}
.about-links {
  display: flex;
  gap: 16px;
}
.about-links a {
  color: var(--brand);
}
.muted {
  color: var(--text-3);
  font-size: 12px;
}
</style>
