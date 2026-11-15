/**
 * 关于页取数: 全平台安装包 (GitHub 不通改读 GitCode 镜像) 与读者群二维码。
 * 成功结果缓存在 localStorage; 网络失败时沿用上次结果 (读者群仍按到期时间过滤)。
 */
import { fetchRemote } from './net'
import {
  COMMUNITY_URL,
  AUTHOR_WECHAT,
  parseCommunity,
  parsePlatformReleases,
  parseWechatContact,
  type PlatformDownload,
  type ReleaseListSource,
  type WechatGroup,
} from './aboutLinks'

const GITHUB_LIST = 'https://api.github.com/repos/yzfly/LightRead/releases?per_page=30'
const GITCODE_LIST = 'https://api.gitcode.com/api/v5/repos/langgpt/LightRead/releases?per_page=30&direction=desc'
const DOWNLOADS_KEY = 'lightread-about-downloads'
const COMMUNITY_KEY = 'lightread-about-community'
const DOWNLOADS_TTL = 6 * 60 * 60 * 1000
const COMMUNITY_TTL = 60 * 60 * 1000

async function getJson(url: string, accept: string, ms: number): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    const res = await Promise.race([
      fetchRemote(url, undefined, { headers: { accept }, signal: controller.signal }),
      new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('timeout')))),
    ])
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

function readCache<T>(key: string): { at: number; value: T } | null {
  try {
    const cached = JSON.parse(localStorage.getItem(key) ?? '')
    return cached && typeof cached.at === 'number' ? cached : null
  } catch {
    return null
  }
}
function writeCache(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), value }))
  } catch { /* 缓存不可写只影响下次加载速度 */ }
}

export interface PlatformDownloadsResult {
  items: PlatformDownload[]
  source: ReleaseListSource
}

export async function loadPlatformDownloads(force = false): Promise<PlatformDownloadsResult> {
  const raw = readCache<PlatformDownloadsResult>(DOWNLOADS_KEY)
  // 缓存是本地存的 JSON, 可能被改坏: 只留对象项, 免得在发网络请求前就抛错。
  // 旧版缓存里的 iOS 项 (已下线的未签名 IPA) 丢掉, iOS 由关于页自己补 TestFlight 链接
  const cachedItems = Array.isArray(raw?.value?.items)
    ? raw.value.items.filter((i): i is PlatformDownload => !!i && typeof i === 'object' && i.platform !== 'ios')
    : []
  const cached = raw && cachedItems.length ? { at: raw.at, value: { ...raw.value, items: cachedItems } } : null
  if (!force && cached && cached.at > Date.now() - DOWNLOADS_TTL) return cached.value
  const attempts: Array<[ReleaseListSource, string, string, number]> = [
    ['github', GITHUB_LIST, 'application/vnd.github+json', 8_000],
    ['gitcode', GITCODE_LIST, 'application/json', 15_000],
  ]
  for (const [source, url, accept, ms] of attempts) {
    try {
      const items = parsePlatformReleases(await getJson(url, accept, ms), source)
      if (!items.length) continue
      const result = { items, source }
      writeCache(DOWNLOADS_KEY, result)
      return result
    } catch { /* 换下一个来源 */ }
  }
  if (cached) return cached.value
  throw new Error('downloads unavailable')
}

export interface CommunityInfo {
  /** 微信群二维码; 已过期或取不到为 null */
  group: WechatGroup | null
  /** 作者微信号 (加好友拉群), 总有值 */
  wechatId: string
}

function toCommunity(data: unknown): CommunityInfo {
  return { group: parseCommunity(data), wechatId: parseWechatContact(data) }
}

export async function loadCommunity(): Promise<CommunityInfo> {
  const cached = readCache<unknown>(COMMUNITY_KEY)
  if (cached && cached.at > Date.now() - COMMUNITY_TTL) return toCommunity(cached.value)
  try {
    const data = await getJson(`${COMMUNITY_URL}?t=${Math.floor(Date.now() / COMMUNITY_TTL)}`, 'application/json', 8_000)
    writeCache(COMMUNITY_KEY, data)
    return toCommunity(data)
  } catch {
    return cached ? toCommunity(cached.value) : { group: null, wechatId: AUTHOR_WECHAT }
  }
}
