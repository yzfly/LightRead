/**
 * 网络请求抽象:
 *  - 桌面端 (Tauri) 走 Rust 原生 HTTP, 无跨域限制, 支持 http/socks5 代理 (设置页配置)
 *  - Web 端走浏览器 fetch, 目标站不支持 CORS 时可配置 CORS 代理模板
 *  - 书源可配 HTTP Basic 鉴权 (calibre-web 等需登录的源)
 */
import { isTauri } from '../storage/types'
import { useSettings } from '../stores/settings'

export interface RequestAuth {
  username?: string
  password?: string
}

function authHeader(auth?: RequestAuth): Record<string, string> {
  if (!auth?.username) return {}
  const raw = `${auth.username}:${auth.password ?? ''}`
  // btoa 只接受 latin1, 先做 UTF-8 编码
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(raw)))
  return { authorization: `Basic ${encoded}` }
}

function applyCorsProxy(url: string): string {
  if (isTauri()) return url
  const proxy = useSettings().corsProxy.trim()
  if (!proxy) return url
  return proxy.includes('{url}')
    ? proxy.replace('{url}', encodeURIComponent(url))
    : proxy + encodeURIComponent(url)
}

const STATUS_HINTS: Record<number, string> = {
  401: '需要账号授权 (401)。请在书源设置中填写用户名和密码。',
  403: '访问被拒绝 (403)',
  404: '地址不存在 (404)',
  429: '请求过于频繁 (429), 请稍后再试',
}

export interface RemoteRequestInit {
  method?: string
  body?: BodyInit
  headers?: Record<string, string>
  /** true 时不因非 2xx 抛错, 由调用方处理状态码 (WebDAV 探测等) */
  raw?: boolean
}

export async function fetchRemote(
  url: string,
  auth?: RequestAuth,
  init: RemoteRequestInit = {},
): Promise<Response> {
  const headers = {
    accept: 'application/atom+xml, application/xml, text/xml, */*',
    ...authHeader(auth),
    ...(init.headers ?? {}),
  }

  let res: Response
  if (isTauri()) {
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')
    const proxyUrl = useSettings().httpProxy.trim()
    res = await tauriFetch(url, {
      method: init.method ?? 'GET',
      body: init.body,
      headers,
      connectTimeout: 30_000,
      ...(proxyUrl ? { proxy: { all: proxyUrl } } : {}),
    } as any)
  } else {
    res = await fetch(applyCorsProxy(url), {
      method: init.method ?? 'GET',
      body: init.body,
      headers,
    })
  }

  if (!init.raw && !res.ok) {
    throw new Error(STATUS_HINTS[res.status] ?? `请求失败: ${res.status} ${res.statusText}`)
  }
  return res
}

export async function fetchXml(url: string, auth?: RequestAuth): Promise<Document> {
  const res = await fetchRemote(url, auth)
  const text = await res.text()
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.querySelector('parsererror')) throw new Error('响应不是有效的 XML / OPDS 目录')
  return doc
}

export async function fetchBlob(url: string, auth?: RequestAuth): Promise<{ blob: Blob; contentType: string }> {
  const res = await fetchRemote(url, auth)
  const blob = await res.blob()
  return { blob, contentType: res.headers.get('content-type') ?? '' }
}
