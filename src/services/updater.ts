/**
 * 版本检查与更新下载:
 *  - 通过 GitHub Releases API 获取最新版本, 与当前版本比较
 *  - 桌面端经 Rust HTTP (支持代理), Web 端直接 fetch (GitHub API 允许 CORS)
 *  - 结果缓存 6 小时, 避免每次打开设置页都请求
 */
import { isTauri } from '../storage/types'
import { fetchRemote } from './net'

const REPO = 'yzfly/LightRead'
export const RELEASES_URL = `https://github.com/${REPO}/releases`
export const REPO_URL = `https://github.com/${REPO}`
export const ISSUES_URL = `https://github.com/${REPO}/issues`

export const CURRENT_VERSION = __APP_VERSION__

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
}

/** 语义化版本比较: a > b 返回 1, 相等 0, 小于 -1 */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0)
  const pb = b.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d > 0 ? 1 : -1
  }
  return 0
}

const CACHE_KEY = 'lightread-update-check'
const CACHE_TTL = 6 * 60 * 60 * 1000

export async function checkUpdate(force = false): Promise<UpdateInfo> {
  if (!force) {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '')
      if (cached.at > Date.now() - CACHE_TTL && cached.info) return cached.info
    } catch { /* 无缓存或已损坏 */ }
  }

  const res = await fetchRemote(`https://api.github.com/repos/${REPO}/releases/latest`, undefined, {
    headers: { accept: 'application/vnd.github+json' },
  })
  const data = await res.json()
  const version = String(data.tag_name ?? '').replace(/^v/, '')
  if (!version) throw new Error('未能获取最新版本信息')

  const info: UpdateInfo = {
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
  }
  localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), info }))
  return info
}

export interface DownloadOption {
  label: string
  url: string
  size: number
  /** 当前设备最可能需要的包 */
  recommended: boolean
}

/** 按运行平台挑出对应的安装包, 推荐项排在前面 */
export function pickDownloads(assets: ReleaseAsset[]): DownloadOption[] {
  const ua = navigator.userAgent
  const platform: 'mac' | 'windows' | 'linux' | 'android' =
    /Android/i.test(ua) ? 'android'
    : /Mac/i.test(ua) ? 'mac'
    : /Win/i.test(ua) ? 'windows'
    : 'linux'

  const rules: Array<{ match: RegExp; label: string; on: string }> = [
    { match: /aarch64\.dmg$/, label: 'macOS (Apple Silicon)', on: 'mac' },
    { match: /x64\.dmg$/, label: 'macOS (Intel)', on: 'mac' },
    { match: /setup\.exe$/, label: 'Windows 安装包', on: 'windows' },
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

/** 桌面端交给系统浏览器下载, Web 端新开标签页 */
export async function openDownload(url: string) {
  if (isTauri()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(url)
  } else {
    window.open(url, '_blank', 'noopener')
  }
}
