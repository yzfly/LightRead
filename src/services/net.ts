/**
 * 网络请求抽象:
 *  - 桌面端 (Tauri) 走 Rust 原生 HTTP, 无跨域限制, 支持 http/socks5 代理 (设置页配置)
 *  - Web 端走浏览器 fetch, 目标站不支持 CORS 时可配置 CORS 代理模板
 *  - 书源可配 HTTP Basic 鉴权 (calibre-web 等需登录的源)
 */
import { isTauri } from '../storage/types'
import { useSettings } from '../stores/settings'
import { accountApiBase } from './account'
import { webdavRelayUrl } from './webdavProviders'
import { t } from '../i18n'
import { BROWSER_USER_AGENT, remoteUserAgent } from './remoteUserAgent'

export interface RequestAuth {
  username?: string
  password?: string
}

export function authHeader(auth?: RequestAuth): Record<string, string> {
  if (!auth?.username) return {}
  const raw = `${auth.username}:${auth.password ?? ''}`
  // btoa 只接受 latin1, 先做 UTF-8 编码
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(raw)))
  return { authorization: `Basic ${encoded}` }
}

function applyCorsProxy(url: string): string {
  if (isTauri()) return url
  // 坚果云等不支持跨域的固定 WebDAV 服务商: 经轻阅同步服务中转 (见 webdavProviders.ts)
  const relayed = webdavRelayUrl(url, accountApiBase())
  if (relayed) return relayed
  const proxy = useSettings().corsProxy.trim()
  if (!proxy) return url
  return proxy.includes('{url}')
    ? proxy.replace('{url}', encodeURIComponent(url))
    : proxy + encodeURIComponent(url)
}

export const REMOTE_USER_AGENT = BROWSER_USER_AGENT

const STATUS_HINTS: Record<number, string> = {
  401: 'net.authRequired',
  403: 'net.forbidden',
  404: 'net.notFound',
  429: 'net.rateLimited',
}

export interface RemoteRequestInit {
  method?: string
  body?: BodyInit
  headers?: Record<string, string>
  signal?: AbortSignal
  /** true 时不因非 2xx 抛错, 由调用方处理状态码 (WebDAV 探测等) */
  raw?: boolean
}

/** 设置页「网络」里配置的代理 (桌面 / 安卓应用的原生请求使用); 未配置为空串 */
export function remoteProxy(): string {
  return useSettings().httpProxy.trim()
}

export async function fetchRemote(
  url: string,
  auth?: RequestAuth,
  init: RemoteRequestInit = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    accept: 'application/atom+xml, application/xml, text/xml, */*',
    // 部分站点 (如古登堡) 拦截非浏览器 UA, GitCode 附件反而拦浏览器 UA (见 remoteUserAgent.ts);
    // 浏览器环境此头会被忽略, 桌面端由 Rust 发送
    'user-agent': remoteUserAgent(url),
    ...authHeader(auth),
    ...(init.headers ?? {}),
  }

  let res: Response
  if (isTauri()) {
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')
    const proxyUrl = remoteProxy()
    res = await tauriFetch(url, {
      method: init.method ?? 'GET',
      body: init.body,
      headers,
      signal: init.signal,
      connectTimeout: 30_000,
      ...(proxyUrl ? { proxy: { all: proxyUrl } } : {}),
    } as any)
  } else {
    res = await fetch(applyCorsProxy(url), {
      method: init.method ?? 'GET',
      body: init.body,
      headers,
      signal: init.signal,
    })
  }

  if (!init.raw && !res.ok) {
    const hint = STATUS_HINTS[res.status]
    throw new Error(hint ? t(hint) : t('net.httpFailed', { status: `${res.status} ${res.statusText}`.trim() }))
  }
  return res
}

export async function fetchXml(url: string, auth?: RequestAuth, init?: RemoteRequestInit): Promise<Document> {
  const res = await fetchRemote(url, auth, init)
  const text = await res.text()
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.querySelector('parsererror')) throw new Error(t('net.invalidXml'))
  return doc
}

export async function fetchBlob(url: string, auth?: RequestAuth): Promise<{ blob: Blob; contentType: string }> {
  const res = await fetchRemote(url, auth)
  const blob = await res.blob()
  return { blob, contentType: res.headers.get('content-type') ?? '' }
}
