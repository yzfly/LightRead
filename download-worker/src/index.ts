/**
 * 轻阅固定下载链接 (路由 code.jiangshu.ai/LightRead/download*):
 *
 *   /LightRead/download/                 按访问者系统跳到对应安装包; 识别不了回主页下载区
 *   /LightRead/download/windows          Windows x64 安装包 (.exe)       windows-arm64: ARM64 (.exe)
 *   /LightRead/download/mac              macOS Apple 芯片 (.dmg)        mac-intel: Intel (.dmg)
 *   /LightRead/download/linux            Linux AppImage                linux-deb / linux-rpm
 *   /LightRead/download/android          安卓 App (.apk, app-vX.Y.Z 线)
 *   /LightRead/download/ios              iOS: TestFlight 公开链接
 *   /LightRead/download/latest.json      各平台最新版本与直链 (给脚本和 AI)
 *   任一链接加 ?mirror=gitcode            走 GitCode 国内镜像 (镜像还没同步到最新版时用镜像上已校验的最新版)
 *
 * 版本挑选与应用「关于」页同一套规则 (src/services/aboutLinks.ts): 桌面只认 vX.Y.Z, App 取最新带 APK 的 Release,
 * 草稿 / 预发布不算, GitCode 只认带 SHA256SUMS 的版本。Release 列表在每个边缘节点缓存 5 分钟。
 */
import { IOS_TESTFLIGHT_URL, detectPlatform, iosDownload, parsePlatformReleases, type PackageKind, type PlatformDownload, type PlatformId, type ReleaseListSource } from '../../src/services/aboutLinks.ts'

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
  'windows-arm64': { platform: 'windows', kind: 'windowsArm64' },
  mac: { platform: 'mac', kind: 'appleSilicon' },
  'mac-arm64': { platform: 'mac', kind: 'appleSilicon' },
  'mac-intel': { platform: 'mac', kind: 'intel' },
  linux: { platform: 'linux', kind: 'appimage' },
  'linux-appimage': { platform: 'linux', kind: 'appimage' },
  'linux-deb': { platform: 'linux', kind: 'deb' },
  'linux-rpm': { platform: 'linux', kind: 'rpm' },
  android: { platform: 'android', kind: 'apk' },
  ios: { platform: 'ios', kind: 'testflight' },
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
  const base = 'https://github.com/yzfly/LightRead/releases/download/'
  const asset = (tag: string, name: string) => ({ name, browser_download_url: `${base}${tag}/${name}`, size: 0 })
  // 订阅里也有只推了 tag、Release 还是草稿的版本 (发版途中要等几十分钟): 安装包真的能下才采用,
  // 否则固定链接会指向 404 (2026-11-15 推 v2.10.4 tag 后即出现)。每条线最多看 3 个 tag。
  const published = async (tag: string, name: string) => {
    try {
      const r = await fetch(`${base}${tag}/${name}`, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(5000) })
      return r.status >= 200 && r.status < 400
    } catch {
      return false
    }
  }
  const pick = async (re: RegExp, file: (tag: string) => string) => {
    for (const tag of tags.filter(t => re.test(t)).slice(0, 3)) if (await published(tag, file(tag))) return tag
    return undefined
  }
  const [desktop, app] = await Promise.all([
    pick(/^v\d+\.\d+\.\d+$/, t => `LightRead_${t.slice(1)}_x64-setup.exe`),
    pick(/^app-v\d+\.\d+\.\d+$/, t => `LightRead_${t}_android_arm64.apk`),
  ])
  const out: unknown[] = []
  if (desktop) {
    const v = desktop.slice(1)
    const names = [`LightRead_${v}_x64-setup.exe`, `LightRead_${v}_aarch64.dmg`, `LightRead_${v}_x64.dmg`, `LightRead_${v}_amd64.AppImage`, `LightRead_${v}_amd64.deb`, `LightRead-${v}-1.x86_64.rpm`]
    const arm64 = `LightRead_${v}_arm64-installer.exe`
    if (await published(desktop, arm64)) names.push(arm64)
    out.push({ tag_name: desktop, assets: names.map(name => asset(desktop, name)) })
  }
  if (app) out.push({ tag_name: app, assets: [asset(app, `LightRead_${app}_android_arm64.apk`)] })
  return out
}

async function loadList(source: ReleaseListSource, ctx: ExecutionContext): Promise<PlatformDownload[]> {
  const cache = (caches as unknown as { default: Cache }).default
  const key = new Request(`https://lightread-download.cache/v2/${source}`)
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

/** 首选来源还缺目标安装包时，从另一来源获取。 */
async function loadAny<T>(prefer: ReleaseListSource, ctx: ExecutionContext, select: (items: PlatformDownload[]) => T | undefined) {
  for (const source of prefer === 'gitcode' ? ['gitcode', 'github'] as const : ['github', 'gitcode'] as const) {
    try {
      const items = await loadList(source, ctx)
      const value = items.length ? select(items) : undefined
      if (value !== undefined) return { source, value }
    } catch { /* 换下一个来源 */ }
  }
  return null
}

function redirect(url: string, status = 302) {
  return new Response(null, { status, headers: { location: url, 'cache-control': 'no-store', 'access-control-allow-origin': '*' } })
}

async function latestJson(prefer: ReleaseListSource, ctx: ExecutionContext) {
  const got = await loadAny(prefer, ctx, items => items)
  const fixed = Object.fromEntries(Object.keys(TARGETS).filter(k => !['mac-arm64', 'linux-appimage'].includes(k)).map(k => [k, `${SITE}download/${k}`]))
  const body = {
    name: 'LightRead 轻阅',
    homepage: SITE,
    source: got?.source ?? null,
    fixedLinks: fixed,
    note: 'fixedLinks always redirect (HTTP 302) to the newest build; append ?mirror=gitcode for the China mirror. Desktop uses tags vX.Y.Z, the Android app uses app-vX.Y.Z, iOS is distributed through TestFlight.',
    // iOS 不在 Release 里, 版本由 TestFlight 管: 不给 version, 标出渠道
    platforms: [...(got?.value ?? []), { platform: 'ios', channel: 'testflight', packages: iosDownload().packages }],
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
      const ua = request.headers.get('user-agent') ?? ''
      const platform = detectPlatform(ua)
      if (!platform) return redirect(`${SITE}#download`)
      name = DEFAULT_TARGET[platform]
      if (platform === 'windows') {
        const arch = request.headers.get('sec-ch-ua-arch')
        if (arch === '"arm"' || /\b(?:ARM64|AArch64)\b/i.test(ua)) name = 'windows-arm64'
        else if (arch !== '"x86"') return redirect(`${SITE}#download`)
      }
    }
    const target = TARGETS[name]
    if (!target) return redirect(`${SITE}#download`)

    if (target.platform === 'ios') return redirect(IOS_TESTFLIGHT_URL)
    const line = target.platform === 'android' ? 'app' : 'desktop'
    const got = await loadAny(prefer, ctx, items =>
      items.find(d => d.platform === target.platform)?.packages.find(p => p.kind === target.kind))
    return redirect(got?.value.url ?? RELEASE_PAGES[prefer][line])
  },
}
