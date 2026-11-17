/**
 * 原生请求 (桌面 / App 经 Rust) 用的 User-Agent。
 * 默认冒充桌面 Chrome: 部分书源 (如古登堡) 拦截非浏览器 UA。
 * GitCode 的 Release 附件地址 (gitcode.com/…/releases/download/…) 自 2026-11 起对不带 Cookie 的浏览器 UA
 * 返回 418 (人机验证), 应用内更新读不到 SHA256SUMS、镜像包无法校验; 那里改用应用自己的 UA (实测放行)。
 */
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 LightRead'
export const APP_USER_AGENT = 'LightRead'

export function remoteUserAgent(url: string): string {
  let host = ''
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return BROWSER_USER_AGENT
  }
  return host === 'gitcode.com' || host.endsWith('.gitcode.com') ? APP_USER_AGENT : BROWSER_USER_AGENT
}
