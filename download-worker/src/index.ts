/**
 * 轻阅固定下载链接 (路由 code.jiangshu.ai/LightRead/download*):
 *
 *   /LightRead/download/                 按访问者系统跳到对应安装包; 识别不了回主页下载区
 *   /LightRead/download/windows          Windows x64 安装包 (.exe)
 *   /LightRead/download/mac              macOS Apple 芯片 (.dmg)        mac-intel: Intel (.dmg)
 *   /LightRead/download/linux            Linux AppImage                linux-deb / linux-rpm
 *   /LightRead/download/android          安卓 App (.apk, app-vX.Y.Z 线)
 *   /LightRead/download/ios              iOS 未签名包 (.ipa, 需自行重签; 还没有带 IPA 的 Release 时跳到 Release 页)
 *   /LightRead/download/latest.json      各平台最新版本与直链 (给脚本和 AI)
 *   任一链接加 ?mirror=gitcode            走 GitCode 国内镜像 (镜像还没同步到最新版时用镜像上已校验的最新版)
 *
 * 版本挑选与应用「关于」页同一套规则 (src/services/aboutLinks.ts): 桌面只认 vX.Y.Z, App 取最新带 APK 的 Release,
 * 草稿 / 预发布不算, GitCode 只认带 SHA256SUMS 的版本。Release 列表在每个边缘节点缓存 5 分钟。
 */
import { detectPlatform, parsePlatformReleases, type PackageKind, type PlatformDownload, type PlatformId, type ReleaseListSource } from '../../src/services/aboutLinks'

const SITE = 'https://code.jiangshu.ai/LightRead/'
const LISTS: Record<ReleaseListSource, string> = {
  github: 'https://api.github.com/repos/yzfly/LightRead/releases?per_page=30',
  gitcode: 'https://api.gitcode.com/api/v5/repos/langgpt/LightRead/releases?per_page=30&direction=desc',
}
const RELEASE_PAGES: Record<ReleaseListSource, Record<'desktop' | 'app', string>> = {
  github: {
    desktop: 'https://github.com/yzfly/LightRead/releases/latest',
    app: 'https://github.com/yzfly/LightRead/releases?q=app-v&expanded=true',
  },
  gitcode: {
    desktop: 'https://gitcode.com/langgpt/LightRead/releases',
    app: 'https://gitcode.com/langgpt/LightRead/releases',
  },
}
const LIST_TTL = 300

/** 固定链接名 → 平台 + 安装包种类 */
const TARGETS: Record<string, { platform: PlatformId; kind: PackageKind }> = {
  windows: { platform: 'windows', kind: 'installer' },
  mac: { platform: 'mac', kind: 'appleSilicon' },
  'mac-arm64': { platform: 'mac', kind: 'appleSilicon' },
  'mac-intel': { platform: 'mac', kind: 'intel' },
  linux: { platform: 'linux', kind: 'appimage' },
  'linux-appimage': { platform: 'linux', kind: 'appimage' },
  'linux-deb': { platform: 'linux', kind: 'deb' },
  'linux-rpm': { platform: 'linux', kind: 'rpm' },
  android: { platform: 'android', kind: 'apk' },
  ios: { platform: 'ios', kind: 'ipa' },
}
const DEFAULT_TARGET: Record<PlatformId, string> = { windows: 'windows', mac: 'mac', linux: 'linux', android: 'android', ios: 'ios' }

/**
 * GitHub API 对 Cloudflare 出口 IP 常被限流 (未认证 60 次/时), 限流时改读不限流的 releases.atom:
 * 只给已公开的 Release, 按发布时间倒序; 取最新的桌面 tag 与 App tag, 安装包名按发版脚本的固定格式拼出
 * (src-tauri bundle 与 scripts/build-android.mjs), 拼成与 API 同形的列表交给同一套挑选规则。
 */
async function githubFeedList(): Promise<unknown[]> {
  const res = await fetch('https://github.com/yzfly/LightRead/releases.atom', {
    headers: { 'user-agent': 'lightread-download-worker' },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`github feed ${res.status}`)
  const xml = await res.text()
  const tags = [...xml.matchAll(/\/releases\/tag\/([^"<\s]+)/g)].map(m => decodeURIComponent(m[1]))
  const desktop = tags.find(t => /^v\d+\.\d+\.\d+$/.test(t))
  const app = tags.find(t => /^app-v\d+\.\d+\.\d+$/.test(t))
  const base = 'https://github.com/yzfly/LightRead/releases/download/'
  const asset = (tag: string, name: string) => ({ name, browser_download_url: `${base}${tag}/${name}`, size: 0 })
  const out: unknown[] = []
  if (desktop) {
    const v = desktop.slice(1)
    out.push({
      tag_name: desktop,
      assets: [`LightRead_${v}_x64-setup.exe`, `LightRead_${v}_aarch64.dmg`, `LightRead_${v}_x64.dmg`, `LightRead_${v}_amd64.AppImage`, `LightRead_${v}_amd64.deb`, `LightRead-${v}-1.x86_64.rpm`]
        .map(n => asset(desktop, n)),
    })
  }
  if (app) out.push({ tag_name: app, assets: [asset(app, `LightRead_${app}_android_arm64.apk`)] })
  return out
}

async function loadList(source: ReleaseListSource, ctx: ExecutionContext): Promise<PlatformDownload[]> {
  const cache = (caches as unknown as { default: Cache }).default
  const key = new Request(`https://lightread-download.cache/${source}`)
  const hit = await cache.match(key)
  if (hit) return parsePlatformReleases(await hit.json(), source)
  const res = await fetch(LISTS[source], {
    headers: { accept: source === 'github' ? 'application/vnd.github+json' : 'application/json', 'user-agent': 'lightread-download-worker' },
    signal: AbortSignal.timeout(8000),
  })
  let body: string
  if (res.ok) body = await res.text()
  else if (source === 'github') body = JSON.stringify(await githubFeedList())
  else throw new Error(`${source} ${res.status}`)
  const items = parsePlatformReleases(JSON.parse(body), source)
  if (items.length) {
    ctx.waitUntil(cache.put(key, new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${LIST_TTL}` } })))
  }
  return items
}

/** 先取请求的来源, 失败再换另一个; 两边都失败返回 null */
async function loadAny(prefer: ReleaseListSource, ctx: ExecutionContext): Promise<{ source: ReleaseListSource; items: PlatformDownload[] } | null> {
  for (const source of prefer === 'gitcode' ? ['gitcode', 'github'] as const : ['github', 'gitcode'] as const) {
    try {
      const items = await loadList(source, ctx)
      if (items.length) return { source, items }
    } catch { /* 换下一个来源 */ }
  }
  return null
}

function redirect(url: string, status = 302) {
  return new Response(null, { status, headers: { location: url, 'cache-control': 'no-store', 'access-control-allow-origin': '*' } })
}

async function latestJson(prefer: ReleaseListSource, ctx: ExecutionContext) {
  const got = await loadAny(prefer, ctx)
  const fixed = Object.fromEntries(Object.keys(TARGETS).filter(k => !['mac-arm64', 'linux-appimage'].includes(k)).map(k => [k, `${SITE}download/${k}`]))
  const body = {
    name: 'LightRead 轻阅',
    homepage: SITE,
    source: got?.source ?? null,
    fixedLinks: fixed,
    note: 'fixedLinks always redirect (HTTP 302) to the newest build; append ?mirror=gitcode for the China mirror. Desktop uses tags vX.Y.Z, the Android app uses app-vX.Y.Z.',
    platforms: got?.items ?? [],
  }
  return new Response(JSON.stringify(body, null, 2), {
    status: got ? 200 : 503,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' },
  })
}

export default {
  async fetch(request: Request, _env: unknown, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const prefer: ReleaseListSource = /^(gitcode|cn)$/i.test(url.searchParams.get('mirror') ?? '') ? 'gitcode' : 'github'
    const rest = url.pathname.replace(/^\/LightRead\/download/, '').replace(/^\/+|\/+$/g, '').toLowerCase()
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405 })

    if (rest === 'latest.json') return latestJson(prefer, ctx)

    let name = rest
    if (!name) {
      const platform = detectPlatform(request.headers.get('user-agent') ?? '')
      if (!platform) return redirect(`${SITE}#download`)
      name = DEFAULT_TARGET[platform]
    }
    const target = TARGETS[name]
    if (!target) return redirect(`${SITE}#download`)

    const line = target.platform === 'android' || target.platform === 'ios' ? 'app' : 'desktop'
    const got = await loadAny(prefer, ctx)
    const pkg = got?.items.find(d => d.platform === target.platform)?.packages.find(p => p.kind === target.kind)
    if (!got || !pkg) return redirect(RELEASE_PAGES[prefer][line])
    return redirect(pkg.url)
  },
}
