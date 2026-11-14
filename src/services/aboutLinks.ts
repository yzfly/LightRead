/**
 * 关于页的「全平台下载」与「读者群」: 纯函数, 不依赖网络与平台 (取数见 aboutLinksLoad.ts)。
 *
 * - 下载: 桌面与 App 分开发版 (桌面 vX.Y.Z, App app-vX.Y.Z; 旧的统一版 vX.Y.Z 也可能带 APK),
 *   各取最新一个带对应安装包的 Release。GitCode 镜像只认已上传 SHA256SUMS 的版本, 地址按固定模式拼接。
 * - 读者群: 微信群二维码 7 天过期, 不打包进应用, 由 lightread-assets 上的 community.json 指向
 *   带内容哈希的图片; 只接受该目录下的 https 图片, 过期即不显示。
 *   另给作者微信号 (加好友后拉群), 二维码过期或取不到时仍可入群; community.json 可覆盖。
 */

export type PlatformId = 'windows' | 'mac' | 'linux' | 'android' | 'ios'
/** 安装包种类, 界面用 about.pkg.<kind> 取文案 */
export type PackageKind = 'installer' | 'appleSilicon' | 'intel' | 'appimage' | 'deb' | 'rpm' | 'apk' | 'ipa'

export interface PlatformPackage {
  kind: PackageKind
  name: string
  url: string
  /** 字节; GitCode 未记录大小时为 0 */
  size: number
}

export interface PlatformDownload {
  platform: PlatformId
  version: string
  packages: PlatformPackage[]
}

export type ReleaseListSource = 'github' | 'gitcode'

const GITHUB_DOWNLOAD_BASE = 'https://github.com/yzfly/LightRead/releases/download/'
const GITCODE_DOWNLOAD_BASE = 'https://gitcode.com/langgpt/LightRead/releases/download/'
const DESKTOP_TAG = /^v(\d+\.\d+\.\d+)$/
const APP_TAG = /^(?:app-)?v(\d+\.\d+\.\d+)$/
const SAFE_NAME = /^[^/\\?#]+$/

const RULES: Array<{ platform: PlatformId; kind: PackageKind; match: RegExp }> = [
  { platform: 'windows', kind: 'installer', match: /_x64-setup\.exe$/ },
  { platform: 'mac', kind: 'appleSilicon', match: /_aarch64\.dmg$/ },
  { platform: 'mac', kind: 'intel', match: /_x64\.dmg$/ },
  { platform: 'linux', kind: 'appimage', match: /\.AppImage$/ },
  { platform: 'linux', kind: 'deb', match: /\.deb$/ },
  { platform: 'linux', kind: 'rpm', match: /\.rpm$/ },
  { platform: 'android', kind: 'apk', match: /_android_arm64\.apk$/ },
  // 未签名真机包 (scripts/build-ios.mjs --ipa), 使用者自己重签后安装
  { platform: 'ios', kind: 'ipa', match: /_ios_unsigned\.ipa$/ },
]
const PLATFORM_ORDER: PlatformId[] = ['windows', 'mac', 'linux', 'android', 'ios']
const APP_PLATFORMS: PlatformId[] = ['android', 'ios']

function versionKey(v: string): number[] {
  return v.split('.').map(n => parseInt(n, 10) || 0)
}
function newer(a: string, b: string): boolean {
  const pa = versionKey(a)
  const pb = versionKey(b)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i]
  return false
}

interface Candidate { tag: string; assets: Array<{ name: string; url: string; size: number }> }

/** 统一两种来源的 Release 列表; 草稿、预发布与不可信地址丢弃 */
function normalize(list: unknown, source: ReleaseListSource): Candidate[] {
  if (!Array.isArray(list)) return []
  const out: Candidate[] = []
  for (const release of list) {
    const tag = String(release?.tag_name ?? '')
    if (!APP_TAG.test(tag) || release.draft === true || release.prerelease === true || release.release_status === 'pre') continue
    const raw: any[] = Array.isArray(release.assets) ? release.assets : []
    if (source === 'gitcode') {
      const names = raw.filter(a => a?.type !== 'source' && typeof a?.name === 'string' && SAFE_NAME.test(a.name)).map(a => a.name as string)
      if (!names.includes('SHA256SUMS')) continue
      let sizes: Record<string, unknown> = {}
      try {
        sizes = JSON.parse(String(release.body ?? '').match(/<!--\s*lightread-mirror-sizes\s+(\{[\s\S]*?\})\s*-->/)?.[1] ?? '{}')
      } catch { /* 大小只用于展示 */ }
      out.push({
        tag,
        assets: names.map(name => ({
          name,
          url: `${GITCODE_DOWNLOAD_BASE}${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
          size: Number(sizes[name]) || 0,
        })),
      })
    } else {
      out.push({
        tag,
        assets: raw
          .filter(a => typeof a?.name === 'string' && typeof a?.browser_download_url === 'string'
            && a.browser_download_url.startsWith(GITHUB_DOWNLOAD_BASE))
          .map(a => ({ name: a.name, url: a.browser_download_url, size: Number(a.size) || 0 })),
      })
    }
  }
  return out
}

/** 每个系统取最新一个带它安装包的 Release: Windows / macOS / Linux 只看桌面 tag, Android / iOS 两种 tag 都看 */
export function parsePlatformReleases(list: unknown, source: ReleaseListSource): PlatformDownload[] {
  const best = new Map<PlatformId, PlatformDownload>()
  for (const { tag, assets } of normalize(list, source)) {
    const version = (tag.match(APP_TAG) as RegExpMatchArray)[1]
    for (const platform of PLATFORM_ORDER) {
      if (!APP_PLATFORMS.includes(platform) && !DESKTOP_TAG.test(tag)) continue
      const packages: PlatformPackage[] = []
      for (const rule of RULES) {
        if (rule.platform !== platform) continue
        const asset = assets.find(a => rule.match.test(a.name))
        if (asset) packages.push({ kind: rule.kind, ...asset })
      }
      if (!packages.length) continue
      const current = best.get(platform)
      if (!current || newer(version, current.version)) best.set(platform, { platform, version, packages })
    }
  }
  return PLATFORM_ORDER.flatMap(p => best.get(p) ?? [])
}

/** 当前设备所属系统 (用来标「本机」); 识别不了返回 null。iOS 应用内由界面用 isIosApp() 判断 (iPad 的 WKWebView 自称 Macintosh) */
export function detectPlatform(ua: string): PlatformId | null {
  if (/Android/i.test(ua)) return 'android'
  if (/iPhone|iPad|iPod/i.test(ua)) return null
  if (/Mac/i.test(ua)) return 'mac'
  if (/Win/i.test(ua)) return 'windows'
  if (/Linux|X11/i.test(ua)) return 'linux'
  return null
}

// ---- 读者群 ----

export const COMMUNITY_BASE = 'https://lightread-assets.jiangshu.ai/community/v1/'
export const COMMUNITY_URL = `${COMMUNITY_BASE}community.json`

export interface WechatGroup {
  name: string
  image: string
  /** ISO 时间, 到期后不再显示 */
  expiresAt: string
}

/** 校验 community.json; 图片必须在 COMMUNITY_BASE 下, 已过期或格式不对返回 null */
export function parseCommunity(data: unknown, now = Date.now()): WechatGroup | null {
  const group = (data as any)?.wechatGroup
  if (!group || typeof group !== 'object') return null
  const image = String(group.image ?? '')
  const name = String(group.name ?? '').trim()
  const expiresAt = String(group.expiresAt ?? '')
  const expires = Date.parse(expiresAt)
  if (!image.startsWith(COMMUNITY_BASE) || !SAFE_NAME.test(image.slice(COMMUNITY_BASE.length))) return null
  if (!name || !Number.isFinite(expires) || expires <= now) return null
  return { name, image, expiresAt }
}

/** 作者 (云中江树) 的微信号, 加好友后拉进读者群 (2026-10-27 用户提供) */
export const AUTHOR_WECHAT = '1796060717'
const WECHAT_ID = /^[A-Za-z0-9_-]{5,30}$/

/** community.json 里的 wechatContact.id; 缺失或格式不对时用内置的作者微信号 */
export function parseWechatContact(data: unknown): string {
  const id = String((data as any)?.wechatContact?.id ?? '').trim()
  return WECHAT_ID.test(id) ? id : AUTHOR_WECHAT
}
