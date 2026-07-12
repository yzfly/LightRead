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
  checkUpdate, pickDownloads, openDownload, type UpdateInfo,
} from '../services/updater'

const settings = useSettings()
const library = useLibrary()

const storageKind = ref('')
const busy = ref('')
const backupInput = ref<HTMLInputElement>()

// ---- WebDAV ----
const davInfo = ref('')

async function davTest() {
  busy.value = '测试连接…'
  try {
    await testWebdav()
    const info = await webdavBackupInfo()
    davInfo.value = info
      ? `✅ 连接正常, 云端备份: ${(info.size / 1024 / 1024).toFixed(1)}MB (${info.modified.slice(0, 22)})`
      : '✅ 连接正常, 云端暂无备份'
  } catch (e: any) {
    davInfo.value = `❌ ${e?.message}`
  } finally {
    busy.value = ''
  }
}

async function davBackup() {
  busy.value = '准备备份…'
  try {
    await backupToWebdav(msg => (busy.value = msg))
    toast('已备份到云端', 'success')
    davInfo.value = ''
  } catch (e: any) {
    toast(`云备份失败: ${e?.message}`, 'error', 6000)
  } finally {
    busy.value = ''
  }
}

async function davRestore() {
  if (!confirm('从云端备份恢复？已有书籍会保留, 仅补充缺失的。')) return
  busy.value = '连接云端…'
  try {
    const result = await restoreFromWebdav(msg => (busy.value = msg))
    await library.refresh()
    toast(`恢复完成: ${result.books} 本书, ${result.annotations} 条标注`, 'success', 5000)
  } catch (e: any) {
    toast(`恢复失败: ${e?.message}`, 'error', 6000)
  } finally {
    busy.value = ''
  }
}

// ---- 代理配置 (桌面端) ----
const PROXY_SCHEMES = [
  { label: '不使用代理', value: '' },
  { label: 'HTTP', value: 'http' },
  { label: 'HTTPS', value: 'https' },
  { label: 'SOCKS5', value: 'socks5' },
  { label: 'SOCKS5 (代理端解析域名)', value: 'socks5h' },
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
    testResult.value = `✅ 连接正常 (${Math.round(performance.now() - start)} ms, 经 google.com 探测)`
  } catch (e: any) {
    testResult.value = `❌ ${e?.message ?? '连接失败'}`
  } finally {
    testing.value = false
  }
}

onMounted(async () => {
  parseProxyUrl(settings.httpProxy)
  doCheckUpdate(false)
  const storage = await getStorage()
  storageKind.value = storage.kind === 'filesystem'
    ? '文件系统 + SQLite (桌面)'
    : '浏览器 IndexedDB'
})

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
    if (manual) checkError.value = e?.message ?? '检查失败, 请稍后再试'
  } finally {
    checking.value = false
  }
}

const fmtSize = (bytes: number) => `${(bytes / 1048576).toFixed(0)} MB`

async function download(url: string) {
  try {
    await openDownload(url)
    toast('已在浏览器中开始下载', 'success')
  } catch {
    toast('无法打开下载链接', 'error')
  }
}

// ---- 存储位置 (桌面端) ----
const migrating = ref('')

async function changeLibraryRoot() {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const picked = await open({ directory: true, title: '选择书库存储文件夹' })
  if (typeof picked !== 'string') return
  const { hasLibraryAt, migrateLibraryTo } = await import('../storage/tauri')

  try {
    if (await hasLibraryAt(picked)) {
      if (!confirm(`该文件夹已有一个轻阅书库，直接使用它？\n\n${picked}`)) return
    } else {
      if (!confirm(`将当前书库复制到该文件夹并切换？\n\n${picked}\n\n原位置的数据会保留不动。`)) return
      migrating.value = '准备迁移…'
      await migrateLibraryTo(picked, msg => (migrating.value = msg))
    }
    settings.libraryRoot = picked
    // 设置持久化有 300ms 防抖, 直接落盘后重载
    localStorage.setItem('lightread-settings', JSON.stringify(settings.$state))
    toast('存储位置已切换, 即将重新加载', 'success')
    setTimeout(() => location.reload(), 800)
  } catch (e: any) {
    migrating.value = ''
    toast(`切换失败: ${e?.message ?? '未知错误'}`, 'error', 6000)
  }
}

function resetLibraryRoot() {
  if (!confirm('恢复到默认存储位置（应用数据目录）？\n\n当前位置的数据会保留不动。')) return
  settings.libraryRoot = ''
  localStorage.setItem('lightread-settings', JSON.stringify(settings.$state))
  setTimeout(() => location.reload(), 300)
}

async function doExport() {
  busy.value = '准备导出…'
  try {
    const blob = await exportBackup(msg => (busy.value = msg))
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `lightread-backup-${new Date().toISOString().slice(0, 10)}.zip`
    a.click()
    URL.revokeObjectURL(a.href)
    toast('备份已导出', 'success')
  } catch (e: any) {
    toast(`导出失败: ${e?.message}`, 'error', 5000)
  } finally {
    busy.value = ''
  }
}

async function doImport(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  busy.value = '读取备份…'
  try {
    const result = await importBackup(file, msg => (busy.value = msg))
    await library.refresh()
    toast(`恢复完成: ${result.books} 本书, ${result.annotations} 条标注, ${result.sources} 个书源`, 'success', 5000)
  } catch (e: any) {
    toast(`恢复失败: ${e?.message}`, 'error', 5000)
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <div class="settings">
    <h1>设置</h1>

    <section class="card section">
      <h2>数据</h2>
      <div class="row">
        <div>
          <div class="row-title">存储后端</div>
          <div class="row-desc">{{ storageKind }}</div>
        </div>
      </div>
      <div v-if="isTauri()" class="row">
        <div style="min-width: 0">
          <div class="row-title">存储位置</div>
          <div class="row-desc">
            书籍文件、封面与索引数据库的存放位置。放到 iCloud / 网盘同步文件夹即可多设备共享。<br />
            当前: <code>{{ settings.libraryRoot || '默认 (应用数据目录)' }}</code>
          </div>
        </div>
        <div class="row-actions">
          <button class="btn" :disabled="!!migrating" @click="changeLibraryRoot">更改位置</button>
          <button v-if="settings.libraryRoot" class="btn" :disabled="!!migrating" @click="resetLibraryRoot">恢复默认</button>
        </div>
      </div>
      <div v-if="migrating" class="busy">{{ migrating }}</div>
      <div class="row">
        <div>
          <div class="row-title">备份与恢复</div>
          <div class="row-desc">将全部藏书、阅读进度、标注和书源打包为 zip, 可在任意端恢复</div>
        </div>
        <div class="row-actions">
          <button class="btn" :disabled="!!busy" @click="doExport">导出备份</button>
          <button class="btn" :disabled="!!busy" @click="backupInput?.click()">恢复备份</button>
          <input ref="backupInput" type="file" accept=".zip" hidden @change="doImport" />
        </div>
      </div>
      <div class="row">
        <div style="min-width: 0">
          <div class="row-title">WebDAV 云备份</div>
          <div class="row-desc">
            备份到坚果云 / Nextcloud / Alist 等任意 WebDAV 服务, 换设备一键恢复。<br />
            坚果云地址: <code>https://dav.jianguoyun.com/dav/</code> (密码用应用密码)
          </div>
        </div>
      </div>
      <div class="webdav-grid">
        <input v-model="settings.webdavUrl" class="input" placeholder="https://dav.jianguoyun.com/dav/" />
        <input v-model="settings.webdavUser" class="input" placeholder="账号" autocomplete="off" />
        <input v-model="settings.webdavPass" class="input" type="password" placeholder="密码" autocomplete="new-password" />
      </div>
      <div class="webdav-actions">
        <button class="btn btn-sm" :disabled="!!busy || !settings.webdavUrl" @click="davTest">测试连接</button>
        <button class="btn btn-sm btn-primary" :disabled="!!busy || !settings.webdavUrl" @click="davBackup">备份到云端</button>
        <button class="btn btn-sm" :disabled="!!busy || !settings.webdavUrl" @click="davRestore">从云端恢复</button>
        <span v-if="davInfo" class="dav-info">{{ davInfo }}</span>
      </div>
      <div v-if="busy" class="busy">{{ busy }}</div>
    </section>

    <section class="card section">
      <h2>网络</h2>
      <template v-if="isTauri()">
        <div class="row">
          <div>
            <div class="row-title">代理服务器</div>
            <div class="row-desc">
              书源浏览与下载请求经此代理访问, 适合直连不畅的网络环境。
              支持 HTTP / HTTPS / SOCKS5 / SOCKS4, 与 Clash 等工具的本地端口直接配合
              (如 Clash 默认混合端口 <code>7890</code>)。
            </div>
          </div>
        </div>
        <div class="proxy-grid">
          <select v-model="proxy.scheme" class="input">
            <option v-for="s in PROXY_SCHEMES" :key="s.value" :value="s.value">{{ s.label }}</option>
          </select>
          <input v-model="proxy.host" class="input" placeholder="服务器, 如 127.0.0.1" :disabled="!proxy.scheme" />
          <input v-model="proxy.port" class="input port" placeholder="端口" :disabled="!proxy.scheme" />
        </div>
        <div v-if="proxy.scheme" class="proxy-grid">
          <input v-model="proxy.username" class="input" placeholder="用户名 (可选)" autocomplete="off" />
          <input v-model="proxy.password" class="input" type="password" placeholder="密码 (可选)" autocomplete="new-password" />
          <button class="btn port" :disabled="testing" @click="testProxy">
            {{ testing ? '测试中…' : '测试连接' }}
          </button>
        </div>
        <div v-if="settings.httpProxy" class="proxy-current">当前: <code>{{ settings.httpProxy }}</code></div>
        <div v-if="testResult" class="proxy-result">{{ testResult }}</div>
      </template>
      <template v-else>
        <div class="row">
          <div>
            <div class="row-title">跨域代理 (仅网页版需要)</div>
            <div class="row-desc">
              浏览器受同源策略限制, 部分 OPDS 书源无法直接访问。桌面版无此问题。<br />
              如需在网页版使用书源, 可自建代理并填入模板, 用 <code>{url}</code> 表示目标地址。
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
      <h2>阅读偏好</h2>
      <div class="row">
        <div>
          <div class="row-title">恢复默认排版</div>
          <div class="row-desc">字号、行距、主题等阅读设置在阅读页右上角调整, 全局生效</div>
        </div>
        <button class="btn" @click="settings.resetReader(); toast('已恢复默认', 'success')">恢复默认</button>
      </div>
    </section>

    <section class="card section">
      <h2>关于</h2>

      <div class="app-identity">
        <img class="app-icon" src="/icon-192.png" alt="LightRead" />
        <div class="app-meta">
          <div class="app-name">
            LightRead 轻阅
            <span class="version-chip">v{{ CURRENT_VERSION }}</span>
            <span class="env-chip">{{ isTauri() ? '桌面版' : '网页版' }}</span>
          </div>
          <div class="app-tagline">开源本地阅读器, 给爱读书的人。所有数据保存在你自己的设备上。</div>
        </div>
        <button class="btn" :disabled="checking" @click="doCheckUpdate()">
          {{ checking ? '检查中…' : '检查更新' }}
        </button>
      </div>

      <!-- 检查结果 -->
      <div v-if="checkError" class="update-state error">❌ {{ checkError }}</div>
      <div v-else-if="checkedManually && !checking && updateInfo && !updateInfo.hasUpdate" class="update-state ok">
        ✅ 当前已是最新版本
      </div>

      <!-- 新版本卡片 -->
      <div v-if="updateInfo?.hasUpdate" class="update-card">
        <div class="update-head">
          <span class="update-badge">发现新版本</span>
          <strong>v{{ updateInfo.version }}</strong>
          <span class="update-date">{{ updateInfo.publishedAt }}</span>
        </div>
        <pre v-if="updateInfo.notes" class="update-notes">{{ updateInfo.notes }}</pre>
        <div class="update-actions">
          <button
            v-for="(d, i) in downloads.filter(x => x.recommended)"
            :key="d.url"
            class="btn btn-sm"
            :class="{ 'btn-primary': i === 0 }"
            @click="download(d.url)"
          >
            ⬇ {{ d.label }} · {{ fmtSize(d.size) }}
          </button>
          <a class="all-downloads" href="javascript:void 0" @click="download(updateInfo.pageUrl)">
            全部平台安装包 →
          </a>
        </div>
      </div>

      <div class="about">
        <p>
          支持 EPUB / MOBI / AZW / AZW3 / FB2 / CBZ / CBR / DjVu / PDF / TXT / HTML / Markdown,
          藏书管理、OPDS 开放书源与 WebDAV 云备份。
        </p>
        <p class="about-links">
          <a href="javascript:void 0" @click="download(REPO_URL)">GitHub 仓库</a>
          <a href="javascript:void 0" @click="download(ISSUES_URL)">问题反馈</a>
          <a href="javascript:void 0" @click="download(RELEASES_URL)">版本历史</a>
        </p>
        <p class="muted">
          作者: 云中江树 (微信公众号: 云中江树) · 开源协议: CC BY-NC 4.0 ·
          阅读引擎: <a href="https://github.com/johnfactotum/foliate-js" target="_blank" rel="noopener">foliate-js</a>
          / <a href="https://mozilla.github.io/pdf.js/" target="_blank" rel="noopener">pdf.js</a>
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
.busy {
  font-size: 12px;
  color: var(--brand);
  padding-top: 6px;
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
