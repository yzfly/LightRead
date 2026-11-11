/**
 * 版本检查与更新下载:
 *  - 通过 GitHub Releases API 获取最新版本, 与当前版本比较
 *  - GitHub 不通或超时时自动改用 GitCode 国内镜像 (docs/gitcode-mirror.md); 镜像未开通时行为与以前一致
 *  - 桌面端经 Rust HTTP (支持代理), Web 端直接 fetch (GitHub / GitCode API 均允许 CORS)
 *  - 结果缓存 6 小时, 避免每次打开设置页都请求
 *  - 应用内下载安装: 桌面在内存里下载后写入「下载」文件夹; 安卓由 Rust 流式写入应用缓存
 *    (src-tauri/src/app_update.rs), 校验后经 MainActivity 的 window.LightReadUpdater 拉起系统安装器
 *  - 网页版下载安装包前快速探测 GitHub, 慢或不通就打开 GitCode 镜像
 */
import { isIosApp } from '../../services/iosShell.ts'
import { isTauri } from '../../storage/types'
import { fetchRemote, remoteProxy } from '../../services/net'
import { t } from '../../i18n'
import { toast } from './toast'

const REPO = 'yzfly/LightRead'
export const RELEASES_URL = `https://github.com/${REPO}/releases`
export const REPO_URL = `https://github.com/${REPO}`
export const ISSUES_URL = `https://github.com/${REPO}/issues`

/** GitCode 镜像: 由 .github/workflows/mirror-gitcode.yml 在 GitHub Release 公开后同步并逐个回下载校验 */
const MIRROR_REPO = 'langgpt/LightRead'
export const MIRROR_RELEASES_URL = `https://gitcode.com/${MIRROR_REPO}/releases`
const MIRROR_API = `https://api.gitcode.com/api/v5/repos/${MIRROR_REPO}`
const GITHUB_DOWNLOAD_BASE = `${RELEASES_URL}/download/`
const MIRROR_DOWNLOAD_BASE = `${MIRROR_RELEASES_URL}/download/`
/** 镜像流程最后上传 SHA256SUMS; 有它才说明该版本的安装包已全部上传并校验过 */
const CHECKSUM_FILE = 'SHA256SUMS'

/**
 * 下载源时限 (毫秒)。GitHub 先快速试一次, 不通就换镜像; 镜像也不可用 (例如尚未开通)
 * 时再给 GitHub 一次与以前相同的耐心时限, 不让慢速但能用的 GitHub 连接变得更差。
 * connect: 元数据请求的整体时限 / 下载等到响应头的时限; stall: 下载中多久收不到新数据算卡住;
 * minRate / rateWindow: 只用于第一次 GitHub 下载 — 国内常见「连得上但只有几十 KB/s」,
 * 开始 rateWindow 后平均速度低于 minRate (字节/秒) 就换 GitCode。0 表示不限。
 */
export const SOURCE_TIMEOUTS = {
  primary: { connect: 8_000, stall: 15_000, minRate: 256 * 1024, rateWindow: 10_000 },
  mirror: { connect: 15_000, stall: 30_000, minRate: 0, rateWindow: 0 },
  patient: { connect: 30_000, stall: 60_000, minRate: 0, rateWindow: 0 },
} as const

export const CURRENT_VERSION = __APP_VERSION__

export type ReleaseSource = 'github' | 'gitcode'

export interface ReleaseAsset {
  name: string
  url: string
  size: number
}

export interface UpdateInfo {
  /** 最新版本号 (不含 v 前缀) */
  version: string
  /** 是否比当前版本新 */
  hasUpdate: boolean
  /** 发布说明 (markdown 原文) */
  notes: string
  publishedAt: string
  pageUrl: string
  assets: ReleaseAsset[]
  /** 元数据来自哪个下载源 (旧缓存没有该字段, 视为 github) */
  source?: ReleaseSource
}

/** 语义化版本比较: a > b 返回 1, 相等 0, 小于 -1 */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^(?:app-)?v/, '').split('.').map(n => parseInt(n, 10) || 0)
  const pb = b.replace(/^(?:app-)?v/, '').split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d > 0 ? 1 : -1
  }
  return 0
}

const CACHE_KEY = 'lightread-mobile-update-check'
const CACHE_TTL = 6 * 60 * 60 * 1000
const INCOMPLETE_CACHE_TTL = 60_000
const FOREGROUND_CHECK_INTERVAL = 60_000

export async function checkUpdate(force = false): Promise<UpdateInfo> {
  // iOS 不提示更新: GitHub Release 里的是 APK, 装不了; 版本由 TestFlight / App Store 推送
  if (isIosApp()) return { ...(await checkRelease(force)), hasUpdate: false }
  return checkRelease(force)
}

async function checkRelease(force: boolean): Promise<UpdateInfo> {
  if (!force) {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '')
      const ttl = cached.info && pickRecommendedDownload(cached.info.assets)
        ? CACHE_TTL : INCOMPLETE_CACHE_TTL
      if (cached.at > Date.now() - ttl && cached.info) {
        // hasUpdate 与当前版本相关, 不能沿用缓存时刻的结论 (升级后读旧缓存会失真)
        return { ...cached.info, hasUpdate: compareVersions(cached.info.version, CURRENT_VERSION) > 0 }
      }
    } catch { /* 无缓存或已损坏 */ }
  }

  const { primary, mirror, patient } = SOURCE_TIMEOUTS
  const info = await firstSuccess<UpdateInfo>([
    () => fetchGithubRelease(primary.connect),
    () => fetchMirrorRelease(mirror.connect),
    () => fetchGithubRelease(patient.connect),
  ])
  rememberSource(info.source ?? 'github')
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), info }))
  } catch { /* 缓存不可写不应隐藏已获取的新版本。 */ }
  return info
}

// ---- 下载源与镜像回退 ----

/** 校验失败等不应换源重试的错误 */
class IntegrityError extends Error {}

/** 依次尝试, 返回第一个成功结果; 全部失败时抛出第一个 (主源) 的错误, 完整性错误立即抛出 */
async function firstSuccess<T>(attempts: Array<() => Promise<T>>): Promise<T> {
  let failed = false
  let firstError: unknown
  for (const attempt of attempts) {
    try {
      return await attempt()
    } catch (e) {
      if (e instanceof IntegrityError) throw e
      if (!failed) { failed = true; firstError = e }
    }
  }
  throw firstError
}

/** 超时即拒绝并调用 onExpire (中止请求); 不依赖底层 fetch 是否响应 AbortSignal */
function deadline<T>(promise: Promise<T>, ms: number, onExpire?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(t('update.timeout')))
      onExpire?.()
    }, ms)
  })
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer))
}

async function fetchJson(url: string, accept: string, ms: number): Promise<any> {
  const controller = new AbortController()
  return deadline(
    fetchRemote(url, undefined, { headers: { accept }, signal: controller.signal }).then(res => res.json()),
    ms,
    () => controller.abort(),
  )
}

async function fetchGithubRelease(ms: number): Promise<UpdateInfo> {
  const list = await fetchJson(`https://api.github.com/repos/${REPO}/releases?per_page=100`, 'application/vnd.github+json', ms)
  const info = parseGithubReleases(list)
  if (!info) throw new Error(t('update.fetchFailed'))
  return info
}

/** Unified releases and legacy App releases both require a complete Android package. */
export function parseGithubReleases(list: unknown): UpdateInfo | null {
  if (!Array.isArray(list)) return null
  const data = list.filter(release => isAppRelease(release) && completeAppAssets(release.assets))
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0]
  if (!data) return null
  const version = String(data?.tag_name ?? '').replace(/^(?:app-)?v/, '')
  if (!version) throw new Error(t('update.fetchFailed'))
  return {
    version,
    hasUpdate: compareVersions(version, CURRENT_VERSION) > 0,
    notes: (data.body ?? '').trim(),
    publishedAt: (data.published_at ?? '').slice(0, 10),
    pageUrl: data.html_url ?? RELEASES_URL,
    assets: (data.assets ?? []).map((a: any) => ({
      name: a.name,
      url: a.browser_download_url,
      size: a.size,
    })),
    source: 'github',
  }
}

async function fetchMirrorRelease(ms: number): Promise<UpdateInfo> {
  const list = await fetchJson(`${MIRROR_API}/releases?per_page=20&direction=desc`, 'application/json', ms)
  const info = parseMirrorReleases(list)
  if (!info) throw new Error(t('update.fetchFailed'))
  return info
}

// Keep legacy App tags readable while new releases use the shared vX.Y.Z channel.
const RELEASE_TAG = /^(?:app-)?v\d+\.\d+\.\d+$/
function isAppRelease(release: any): boolean {
  return RELEASE_TAG.test(String(release?.tag_name ?? '')) && release.draft !== true
    && release.prerelease !== true && release.release_status !== 'pre'
}
function completeAppAssets(assets: unknown): boolean {
  if (!Array.isArray(assets)) return false
  const names = assets.filter(a => a?.type !== 'source' && typeof a?.name === 'string').map(a => a.name)
  return names.includes(CHECKSUM_FILE) && names.some(name => /^LightRead_.*_android_arm64\.apk$/.test(name))
}
const SAFE_NAME = /^[^/\\?#]+$/

/** GitCode 下载地址: 与 GitHub 相同的 tag 与文件名 */
export function mirrorDownloadUrl(tag: string, name: string): string {
  return `${MIRROR_DOWNLOAD_BASE}${encodeURIComponent(tag)}/${encodeURIComponent(name)}`
}

/** 识别 GitHub / GitCode 的 Release 附件地址 */
export function parseReleaseDownloadUrl(url: string): { source: ReleaseSource; tag: string; name: string } | null {
  for (const [source, base] of [['github', GITHUB_DOWNLOAD_BASE], ['gitcode', MIRROR_DOWNLOAD_BASE]] as const) {
    if (!url.startsWith(base)) continue
    const parts = url.slice(base.length).split(/[?#]/)[0].split('/')
    if (parts.length !== 2) return null
    try {
      const [tag, name] = parts.map(decodeURIComponent)
      if (tag && SAFE_NAME.test(tag) && SAFE_NAME.test(name)) return { source, tag, name }
    } catch { /* 非法转义 */ }
    return null
  }
  return null
}

/**
 * 同一安装包的下载尝试顺序: GitHub 快速 → GitCode → GitHub 耐心;
 * 元数据已来自 GitCode, 或最近一次检查更新时 GitHub 不通, 就先走镜像。其他地址只按原样下载。
 */
export interface DownloadStep {
  url: string
  source: ReleaseSource | null
  connect: number
  stall: number
  minRate: number
  rateWindow: number
}

export function downloadPlan(url: string): DownloadStep[] {
  const { primary, mirror, patient } = SOURCE_TIMEOUTS
  const parsed = parseReleaseDownloadUrl(url)
  if (!parsed) return [{ url, source: null, ...patient }]
  const github = `${GITHUB_DOWNLOAD_BASE}${encodeURIComponent(parsed.tag)}/${encodeURIComponent(parsed.name)}`
  const gitcode = mirrorDownloadUrl(parsed.tag, parsed.name)
  return parsed.source === 'github' && !githubUnreachable()
    ? [
        { url, source: 'github', ...primary },
        { url: gitcode, source: 'gitcode', ...mirror },
        { url, source: 'github', ...patient },
      ]
    : [
        { url: gitcode, source: 'gitcode', ...mirror },
        { url: github, source: 'github', ...patient },
      ]
}

/** GitHub 不通时, 把本项目的 Release 页面/附件链接换成 GitCode 对应地址; 其他链接返回 null */
export function mirrorLinkFor(url: string): string | null {
  const download = parseReleaseDownloadUrl(url)
  if (download) return download.source === 'github' ? mirrorDownloadUrl(download.tag, download.name) : null
  const path = url.startsWith(RELEASES_URL) ? url.slice(RELEASES_URL.length).split(/[?#]/)[0] : null
  if (path === null) return null
  return /^(\/|\/latest\/?|\/tag\/[^/]+\/?)?$/.test(path) ? MIRROR_RELEASES_URL : null
}

/** 解析 `sha256sum` 输出 (支持二进制模式的 `*` 前缀) */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([a-fA-F0-9]{64}) [ *](.+)$/)
    if (m) sums.set(m[2].trim(), m[1].toLowerCase())
  }
  return sums
}

/**
 * GitCode「获取仓库的所有 Releases」的结果 → UpdateInfo。只认 App 正式版本和用于迁移的 v1 版本,
 * 且必须已带 SHA256SUMS (镜像完成); 附件地址按固定模式自行拼接, 不信任返回的任意 URL。
 * GitCode 不返回附件大小, 镜像流程把大小写在说明末尾的 HTML 注释里。
 */
export function parseMirrorReleases(list: unknown): UpdateInfo | null {
  if (!Array.isArray(list)) return null
  let best: any = null
  for (const release of list) {
    const tag = String(release?.tag_name ?? '')
    if (!isAppRelease(release) || !completeAppAssets(release.assets)) continue
    const names = (Array.isArray(release.assets) ? release.assets : [])
      .filter((a: any) => a?.type !== 'source' && typeof a?.name === 'string' && SAFE_NAME.test(a.name))
      .map((a: any) => a.name as string)
    if (!names.includes(CHECKSUM_FILE)) continue
    if (!best || compareVersions(tag, best.tag) > 0) best = { tag, names, release }
  }
  if (!best) return null
  const body = String(best.release.body ?? '')
  let sizes: Record<string, unknown> = {}
  try {
    sizes = JSON.parse(body.match(/<!--\s*lightread-mirror-sizes\s+(\{[\s\S]*?\})\s*-->/)?.[1] ?? '{}')
  } catch { /* 大小只用于展示 */ }
  const version = best.tag.replace(/^(?:app-)?v/, '')
  return {
    version,
    hasUpdate: compareVersions(version, CURRENT_VERSION) > 0,
    notes: body.replace(/<!--[\s\S]*?-->/g, '').trim(),
    publishedAt: String(best.release.created_at ?? '').slice(0, 10),
    pageUrl: MIRROR_RELEASES_URL,
    assets: best.names.map((name: string) => ({
      name,
      url: mirrorDownloadUrl(best.tag, name),
      size: Number(sizes[name]) || 0,
    })),
    source: 'gitcode',
  }
}

const SOURCE_KEY = 'lightread-update-source'

function rememberSource(source: ReleaseSource) {
  try {
    localStorage.setItem(SOURCE_KEY, JSON.stringify({ source, at: Date.now() }))
  } catch { /* 仅影响发布页链接的回退 */ }
}

/** 最近一次检查更新只能经镜像完成 (GitHub 不通) */
export function githubUnreachable(): boolean {
  try {
    const record = JSON.parse(localStorage.getItem(SOURCE_KEY) ?? '')
    return record.source === 'gitcode' && record.at > Date.now() - CACHE_TTL
  } catch {
    return false
  }
}

/** 冷启动使用缓存；恢复前台/联网后刷新，并合并同一次恢复触发的多个事件。 */
export function watchUpdateAvailability(onUpdate: (info: UpdateInfo) => void): () => void {
  let stopped = false
  let checking = false
  let lastAttempt = -Infinity
  async function refresh(force: boolean) {
    if (stopped || checking || document.visibilityState === 'hidden'
      || Date.now() - lastAttempt < FOREGROUND_CHECK_INTERVAL) return
    checking = true
    lastAttempt = Date.now()
    try {
      const info = await checkUpdate(force)
      if (!stopped) onUpdate(info)
    } catch { /* 自动检查失败时保留现有提示，不打断阅读。 */ }
    finally { checking = false }
  }
  const onForeground = () => { void refresh(true) }
  document.addEventListener('visibilitychange', onForeground)
  window.addEventListener('focus', onForeground)
  window.addEventListener('online', onForeground)
  void refresh(false)
  return () => {
    stopped = true
    document.removeEventListener('visibilitychange', onForeground)
    window.removeEventListener('focus', onForeground)
    window.removeEventListener('online', onForeground)
  }
}

export interface DownloadOption {
  label: string
  url: string
  size: number
  /** 当前设备最可能需要的包 */
  recommended: boolean
}

/** 按运行平台挑出对应的安装包, 推荐项排在前面 */
export function pickDownloads(assets: ReleaseAsset[], ua = navigator.userAgent): DownloadOption[] {
  const platform: 'mac' | 'windows' | 'linux' | 'android' =
    /Android/i.test(ua) ? 'android'
    : /Mac/i.test(ua) ? 'mac'
    : /Win/i.test(ua) ? 'windows'
    : 'linux'

  const rules: Array<{ match: RegExp; label: string; on: string }> = [
    { match: /aarch64\.dmg$/, label: 'macOS (Apple Silicon)', on: 'mac' },
    { match: /x64\.dmg$/, label: 'macOS (Intel)', on: 'mac' },
    { match: /setup\.exe$/, label: t('update.windowsInstaller'), on: 'windows' },
    { match: /\.msi$/, label: 'Windows (MSI)', on: 'windows' },
    { match: /\.AppImage$/, label: 'Linux (AppImage)', on: 'linux' },
    { match: /\.deb$/, label: 'Linux (deb)', on: 'linux' },
    { match: /\.rpm$/, label: 'Linux (rpm)', on: 'linux' },
    { match: /\.apk$/, label: 'Android (arm64)', on: 'android' },
  ]

  const options: DownloadOption[] = []
  for (const rule of rules) {
    const asset = assets.find(a => rule.match.test(a.name))
    if (asset) options.push({ label: rule.label, url: asset.url, size: asset.size, recommended: rule.on === platform })
  }
  return [...options.filter(o => o.recommended), ...options.filter(o => !o.recommended)]
}

/** 当前平台没有产物时交给发布页；绝不推荐其他系统的安装包。 */
export function pickRecommendedDownload(assets: ReleaseAsset[], ua = navigator.userAgent): DownloadOption | null {
  return pickDownloads(assets, ua).find(item => item.recommended) ?? null
}

/** 网页版: 安装包下载前探测 GitHub 的时限; 超过就改开 GitCode 镜像 */
export const WEB_PROBE_MS = 3_500

/** 桌面 / 安卓应用交给系统浏览器打开, Web 端新开标签页 */
export async function openDownload(link: string) {
  // GitHub 不通时, 发布页与安装包链接改开 GitCode 镜像
  const known = (githubUnreachable() && mirrorLinkFor(link)) || link
  if (isTauri()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(known)
    return
  }
  const mirror = mirrorLinkFor(link)
  if (known !== link || !mirror || !parseReleaseDownloadUrl(link)) {
    window.open(known, '_blank', 'noopener')
    return
  }
  // 网页版安装包: 先在点击当下打开空白页 (之后再开会被拦截), 再用几秒探测 GitHub,
  // 连得上就用 GitHub, 慢或不通就用 GitCode, 方便国内手机下载。
  const win = window.open('', '_blank')
  const url = await probeReachable(link, WEB_PROBE_MS) ? link : mirror
  if (!win) {
    window.open(url, '_blank', 'noopener')
    return
  }
  try {
    win.opener = null
    win.location.href = url
  } catch { /* 页面已被关闭 */ }
}

/** 跨域 no-cors 请求在收到响应头时即算连通, 随后立即中止, 不下载正文 */
async function probeReachable(url: string, ms: number): Promise<boolean> {
  const controller = new AbortController()
  try {
    await deadline(
      fetch(url, { mode: 'no-cors', cache: 'no-store', redirect: 'follow', signal: controller.signal }),
      ms,
      () => controller.abort(),
    )
    return true
  } catch {
    return false
  } finally {
    controller.abort()
  }
}

interface AndroidUpdaterBridge {
  canInstall(): boolean
  openInstallPermission(): void
  /** ok / permission / missing / error */
  install(name: string): string
}

const isAndroid = () => /Android/i.test(navigator.userAgent)

/** 安卓应用里 MainActivity 注入的安装桥; 其他平台 (含手机浏览器) 为 null */
function androidUpdater(): AndroidUpdaterBridge | null {
  if (!isTauri() || !isAndroid()) return null
  return (globalThis as { LightReadUpdater?: AndroidUpdaterBridge }).LightReadUpdater ?? null
}

/** 支持应用内下载安装: 桌面端, 以及带安装桥的安卓应用。iOS 只能由 TestFlight / App Store 更新 */
export const canInAppInstall = () => isTauri() && !isIosApp() && (!isAndroid() || androidUpdater() !== null)

export interface DownloadProgress {
  /** 0-1, 无 content-length 时为 null */
  fraction: number | null
  receivedMB: string
  totalMB: string
}

function toProgress(received: number, total: number): DownloadProgress {
  return {
    fraction: total ? received / total : null,
    receivedMB: (received / 1048576).toFixed(1),
    totalMB: total ? (total / 1048576).toFixed(0) : '?',
  }
}

/**
 * 应用内下载安装包: GitHub 连不上或卡住时换 GitCode 镜像, 下载后按 SHA256SUMS 校验。
 * 桌面端经 Rust 原生 HTTP 下载到系统下载文件夹 (自动使用设置页配置的网络代理);
 * 安卓由 Rust 流式写入应用缓存, 返回的路径交给 openInstaller。
 */
export async function downloadInstaller(
  url: string,
  fileName: string,
  onProgress: (p: DownloadProgress) => void,
): Promise<string> {
  if (androidUpdater()) return downloadApk(url, fileName, onProgress)
  const data = await downloadVerified(url, onProgress)
  const { downloadDir, join } = await import('@tauri-apps/api/path')
  const { writeFile } = await import('@tauri-apps/plugin-fs')
  const path = await join(await downloadDir(), fileName)
  await writeFile(path, data)
  return path
}

/** 正在进行的安卓下载: 侧栏与设置页同时点「更新」时共用一次下载 (Rust 端只有一个缓存文件) */
let apkInFlight: { url: string; listeners: Set<(p: DownloadProgress) => void>; done: Promise<string> } | null = null

/** 安卓: 按 downloadPlan 逐个源下载到缓存 (.part), 校验通过才改名成 .apk */
function downloadApk(url: string, fileName: string, onProgress: (p: DownloadProgress) => void): Promise<string> {
  if (apkInFlight?.url === url) {
    apkInFlight.listeners.add(onProgress)
    return apkInFlight.done
  }
  const listeners = new Set([onProgress])
  const done = downloadApkOnce(url, fileName, p => listeners.forEach(fn => fn(p)))
  const entry = { url, listeners, done }
  apkInFlight = entry
  const release = () => { if (apkInFlight === entry) apkInFlight = null }
  done.then(release, release)
  return done
}

async function downloadApkOnce(url: string, fileName: string, onProgress: (p: DownloadProgress) => void): Promise<string> {
  const { invoke, Channel } = await import('@tauri-apps/api/core')
  const proxy = remoteProxy() || null
  const result = await firstSuccess(downloadPlan(url).map(step => async () => {
    const channel = new Channel<{ received: number; total: number }>()
    channel.onmessage = p => onProgress(toProgress(p.received, p.total))
    const done = await invoke<{ sha256: string; size: number }>('update_download', {
      url: step.url, fileName, connectMs: step.connect, stallMs: step.stall,
      minRate: step.minRate || null, rateWindowMs: step.rateWindow || null, proxy, onProgress: channel,
    })
    return { url: step.url, sha256: done.sha256 }
  }))
  try {
    await verifyDownload(result.url, async () => result.sha256)
  } catch (e) {
    await invoke('update_finish', { fileName, accept: false }).catch(() => {})
    throw e
  }
  const path = await invoke<string | null>('update_finish', { fileName, accept: true })
  if (!path) throw new Error(t('update.downloadFailed'))
  return path
}

/** 按 downloadPlan 依次下载, 再用 SHA256SUMS 校验; 镜像下载必须校验通过 */
export async function downloadVerified(url: string, onProgress: (p: DownloadProgress) => void): Promise<Uint8Array> {
  const result = await firstSuccess(downloadPlan(url).map(step => async () => ({
    url: step.url,
    data: await downloadOnce(step, onProgress),
  })))
  await verifyDownload(result.url, () => sha256Hex(result.data))
  return result.data
}

/** 与 SHA256SUMS 比对; 不一致或镜像包取不到校验值时抛 IntegrityError (不再换源) */
async function verifyDownload(url: string, digest: () => Promise<string>): Promise<void> {
  const asset = parseReleaseDownloadUrl(url)
  if (!asset) return
  const expected = (await loadChecksums(asset.tag))?.get(asset.name)
  if (!expected) {
    // 旧行为: GitHub 直连不强制校验; 第三方镜像没有校验值则拒绝
    if (asset.source === 'gitcode') throw new IntegrityError(t('update.checksumUnavailable'))
    return
  }
  if (await digest() !== expected) throw new IntegrityError(t('update.checksumMismatch'))
}

async function downloadOnce(step: DownloadStep, onProgress: (p: DownloadProgress) => void): Promise<Uint8Array> {
  const { url, connect: connectMs, stall: stallMs, minRate, rateWindow } = step
  const controller = new AbortController()
  const res = await deadline(
    fetchRemote(url, undefined, { headers: { accept: 'application/octet-stream' }, signal: controller.signal }),
    connectMs,
    () => controller.abort(),
  )
  const total = Number(res.headers.get('content-length') ?? 0)
  const chunks: Uint8Array[] = []
  let received = 0
  const report = () => onProgress(toProgress(received, total))
  report()
  const reader = res.body?.getReader?.()
  if (reader) {
    const started = Date.now()
    let rateChecked = !minRate
    for (;;) {
      const { done, value } = await deadline(reader.read(), stallMs, () => {
        controller.abort()
        void reader.cancel().catch(() => {})
      })
      if (done) break
      chunks.push(value)
      received += value.length
      report()
      const elapsed = Date.now() - started
      if (!rateChecked && elapsed >= rateWindow) {
        rateChecked = true
        if (!(total && received >= total) && received < minRate * elapsed / 1000) {
          controller.abort()
          void reader.cancel().catch(() => {})
          throw new Error(t('update.timeout'))
        }
      }
    }
  } else {
    const buf = new Uint8Array(await deadline(res.arrayBuffer(), stallMs * 10, () => controller.abort()))
    chunks.push(buf)
    received = buf.length
    report()
  }
  // 截断的响应换源重试, 不交给安装器
  if (total && received !== total) throw new Error(t('update.fetchFailed'))
  const data = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.length
  }
  return data
}

/** 优先取 GitHub 上的校验清单 (信任锚), 不通再取镜像上的; 最近 GitHub 不通时先取镜像, 免得多等 */
async function loadChecksums(tag: string): Promise<Map<string, string> | null> {
  const { primary, mirror } = SOURCE_TIMEOUTS
  const fetchSums = async (url: string, ms: number) => {
    const controller = new AbortController()
    const text = await deadline(
      fetchRemote(url, undefined, { headers: { accept: 'text/plain, */*' }, signal: controller.signal }).then(res => res.text()),
      ms,
      () => controller.abort(),
    )
    const sums = parseSha256Sums(text)
    if (!sums.size) throw new Error(t('update.fetchFailed'))
    return sums
  }
  try {
    const github = () => fetchSums(`${GITHUB_DOWNLOAD_BASE}${encodeURIComponent(tag)}/${CHECKSUM_FILE}`, primary.connect)
    const gitcode = () => fetchSums(mirrorDownloadUrl(tag, CHECKSUM_FILE), mirror.connect)
    return await firstSuccess(githubUnreachable() ? [gitcode, github] : [github, gitcode])
  } catch {
    return null
  }
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>))
  return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('')
}

export type InstallResult = 'opened' | 'needs-permission'

/**
 * 打开已下载的安装包: macOS 挂载 dmg, Windows 运行安装器;
 * 安卓拉起系统安装器, 没开「安装未知应用」时返回 needs-permission (回到前台后自动接着装)。
 */
export async function openInstaller(path: string): Promise<InstallResult> {
  const bridge = androidUpdater()
  if (bridge) return installApk(bridge, path)
  const { openPath } = await import('@tauri-apps/plugin-opener')
  await openPath(path)
  return 'opened'
}

const PENDING_KEY = 'lightread-update-pending-install'
/** 去设置页开权限后多久内回来仍自动接着安装 */
const PENDING_TTL = 30 * 60_000

function installApk(bridge: AndroidUpdaterBridge, path: string): InstallResult {
  const name = path.split(/[\\/]/).pop() ?? ''
  const status = bridge.install(name)
  if (status === 'permission') {
    try { localStorage.setItem(PENDING_KEY, JSON.stringify({ path, at: Date.now() })) } catch { /* 只影响自动接着装 */ }
    return 'needs-permission'
  }
  clearPendingInstall()
  if (status === 'ok') return 'opened'
  throw new Error(t(status === 'missing' ? 'update.installerMissing' : 'update.openFailed'))
}

function clearPendingInstall() {
  try { localStorage.removeItem(PENDING_KEY) } catch { /* ignore */ }
}

/** 是否已允许本应用安装应用 (非安卓恒为 true) */
export function installPermissionGranted(): boolean {
  const bridge = androidUpdater()
  return !bridge || bridge.canInstall()
}

/** 打开本应用的「安装未知应用」设置页 (安卓) */
export function openInstallPermission() {
  androidUpdater()?.openInstallPermission()
}

/** 有待安装的包且已允许安装时打开安装器; 返回是否已打开 */
export function resumePendingInstall(): boolean {
  const bridge = androidUpdater()
  if (!bridge) return false
  let pending: { path?: string; at?: number } | null = null
  try { pending = JSON.parse(localStorage.getItem(PENDING_KEY) ?? 'null') } catch { /* 损坏 */ }
  if (!pending?.path || !(Number(pending.at) > Date.now() - PENDING_TTL)) {
    if (pending) clearPendingInstall()
    return false
  }
  if (!bridge.canInstall()) return false
  try {
    return installApk(bridge, pending.path) === 'opened'
  } catch {
    return false
  }
}

/** 安卓: 用户从设置页开完权限回到轻阅 (或被系统重启) 后, 自动接着打开安装 */
export function watchPendingInstall(): () => void {
  if (!androidUpdater()) return () => {}
  const check = () => {
    if (document.visibilityState !== 'hidden' && resumePendingInstall()) {
      toast(t('update.downloadDoneOpening'), 'success')
    }
  }
  document.addEventListener('visibilitychange', check)
  window.addEventListener('focus', check)
  check()
  return () => {
    document.removeEventListener('visibilitychange', check)
    window.removeEventListener('focus', check)
  }
}

/** 打开安装并提示; 安卓没开安装权限时给一句话 + 「去开启」 */
export async function installWithPrompt(path: string): Promise<void> {
  if (await openInstaller(path) === 'opened') {
    toast(t('update.downloadDoneOpening'), 'success')
  } else {
    toast(t('update.needInstallPermission'), 'info', 20_000, { label: t('update.allowInstall'), run: openInstallPermission })
  }
}

/** 下载失败的提示语: 校验不过说明安装包已删除, 其余统一建议换网络重试 (原始错误只进控制台) */
export function downloadErrorMessage(e: unknown): string {
  if (e instanceof IntegrityError) return e.message
  console.warn('[updater] download failed:', e)
  return t('update.downloadFailed')
}

/** 复制下载链接, 便于换到浏览器或其他工具下载 */
export async function copyLink(url: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(url)
    return true
  } catch {
    // WebView 剪贴板 API 不可用时回退到隐藏输入框
    try {
      const input = document.createElement('textarea')
      input.value = url
      input.style.position = 'fixed'
      input.style.opacity = '0'
      document.body.appendChild(input)
      input.select()
      const ok = document.execCommand('copy')
      input.remove()
      return ok
    } catch {
      return false
    }
  }
}
