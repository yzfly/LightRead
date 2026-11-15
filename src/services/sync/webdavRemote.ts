/**
 * WebDAV 同步后端. 布局见 docs/sync.md:
 *   <url>/LightRead/sync/v1/devices/<deviceId>.json
 *   <url>/LightRead/sync/v1/files/<hash>[.cover]
 * HTTP 函数可注入 (node 测试用内存假服务器); 默认走 services/net.ts 的 fetchRemote,
 * 按需加载, 使本模块不在顶层依赖 pinia. 桌面 / 安卓上的 PUT (书籍文件、封面、同步文档)
 * 改走原生上传命令 (services/nativeUpload.ts), 不经 plugin-http 的 JSON 序列化.
 * 每个请求都有整体超时, 超时报 sync.err.timeout.
 */
import { SYNC_FORMAT, unreachableError } from './types.ts'
import type { SyncDoc, SyncRemote } from './types'
import { isLocalFileRef, isTauri, type LocalFileRef } from '../../storage/types.ts'

export interface HttpRequest {
  method: string
  headers?: Record<string, string>
  /** LocalFileRef 只会交给默认 HTTP 函数 (注入的函数收到的是读出来的 Blob) */
  body?: Blob | string | LocalFileRef
  /** 整体超时时中止请求 */
  signal?: AbortSignal
}

/** fetch 的 Response 的子集 */
export interface HttpResponse {
  status: number
  text(): Promise<string>
  blob(): Promise<Blob>
}

export type HttpFn = (url: string, req: HttpRequest) => Promise<HttpResponse>

export type TranslateFn = (key: string, params?: Record<string, string | number>) => string

export interface WebdavConfig {
  url: string
  user: string
  pass: string
}

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>'

/** 普通请求 (PROPFIND / 读写同步文档等) 的整体超时 */
export const REQUEST_TIMEOUT_MS = 60_000
/** 下载书籍文件: 大小未知, 给足 */
export const DOWNLOAD_TIMEOUT_MS = 15 * 60_000
/** 上传: 60s + 每 MB 10s, 上限 30 分钟 (与原生命令一致); 大小未知 (本地文件引用) 时取上限 */
export function uploadTimeoutMs(size?: number): number {
  const cap = 30 * 60_000
  if (size === undefined) return cap
  return Math.min(cap, 60_000 + Math.ceil(size / (1024 * 1024)) * 10_000)
}
/** JS 侧计时比原生侧多留的余量, 让原生超时先触发、报出更准确的错误 */
const TIMEOUT_SLACK_MS = 15_000

/** 默认 HTTP 函数 (互传的 WebDAV 通道复用, 见 services/transfer/webdavChannel.ts) */
export function defaultHttp(cfg: WebdavConfig): HttpFn {
  return async (url, req) => {
    const [{ fetchRemote, authHeader, REMOTE_USER_AGENT }, { isTauri }] = await Promise.all([
      import('../net.ts'), import('../../storage/types.ts'),
    ])
    const auth = { username: cfg.user, password: cfg.pass }
    // PUT (书籍文件、封面、同步文档) 走原生命令; 其余请求要读完整响应, 仍走 plugin-http
    if (isTauri() && req.method === 'PUT' && req.body !== undefined) {
      const { nativeUpload } = await import('../nativeUpload.ts')
      const res = await nativeUpload(url, {
        method: req.method,
        headers: { 'user-agent': REMOTE_USER_AGENT, ...authHeader(auth), ...(req.headers ?? {}) },
        body: req.body,
      })
      return {
        status: res.status,
        text: async () => res.body,
        blob: async () => new Blob([res.body]),
      }
    }
    const body = isLocalFileRef(req.body) ? await req.body.blob() : req.body
    return fetchRemote(url, auth, {
      method: req.method,
      headers: req.headers,
      body,
      signal: req.signal,
      raw: true,
    })
  }
}

const timedOutError = (err: unknown) => (err as { code?: unknown })?.code === 'timeout'

/**
 * 连接建立后被对方断开 (TCP 重置 / 响应前关闭): 多是服务器或中间网络偶发, 立即重试一次通常就好
 * (2026-11-15 Windows 诊断日志: InfiniCLOUD 每隔几轮报「远程主机强迫关闭了一个现有的连接」)。
 * 连不上 (DNS / 拒绝连接 / 证书) 不在此列, 重试也没用。WebDAV 的 PUT / GET / PROPFIND 等重发是安全的。
 */
export function connectionResetError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err)
  return /connection closed before message completed|connection reset|forcibly closed|os error (10054|104)\b|强迫关闭/i.test(msg)
}

async function defaultTranslate(key: string, params?: Record<string, string | number>) {
  const { t } = await import('../../i18n/index.ts')
  return t(key, params)
}

const decodeEntities = (s: string) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&')

/**
 * 从 PROPFIND multistatus 里取出直接子项的文件名 (任意命名空间前缀的 <href>).
 * 跳过集合本身 (末段等于目录名) 与子目录 (以 / 结尾).
 */
export function parsePropfindNames(xml: string, dirName: string): string[] {
  const names: string[] = []
  const re = /<(?:[A-Za-z_][\w.-]*:)?href(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?href\s*>/gi
  for (const m of xml.matchAll(re)) {
    let href = decodeEntities(m[1].trim())
    try { href = decodeURIComponent(href) } catch { /* 非法转义, 按原样用 */ }
    if (href.endsWith('/')) continue
    const name = href.split('?')[0].split('/').pop() ?? ''
    if (!name || name === dirName) continue
    names.push(name)
  }
  return [...new Set(names)]
}

function isSyncDoc(v: unknown): v is SyncDoc {
  if (!v || typeof v !== 'object') return false
  const d = v as Record<string, unknown>
  const isObj = (x: unknown) => !!x && typeof x === 'object' && !Array.isArray(x)
  return d.format === SYNC_FORMAT && typeof d.deviceId === 'string' && !!d.deviceId
    && isObj(d.books) && isObj(d.annotations) && isObj(d.booklists)
    && isObj(d.booklistItems) && isObj(d.sources)
}

/** 有限并发的 map */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export function createWebdavRemote(
  cfg: WebdavConfig,
  httpFn?: HttpFn,
  translate?: TranslateFn,
): SyncRemote {
  const http = httpFn ?? defaultHttp(cfg)
  /** 只有默认 HTTP 函数认识本地文件引用 */
  const acceptsFileRefs = !httpFn
  /** 桌面 / 安卓: 书籍文件由原生层直接下载进书库, 内容不进 JS (几十 MB 的书会撑爆 WebView) */
  const nativeFiles = acceptsFileRefs && isTauri()
  const base = cfg.url.trim().replace(/\/+$/, '')
  const root = `${base}/LightRead/sync/v1`
  const devicesDir = `${root}/devices/`
  const filesDir = `${root}/files/`
  const tr = async (key: string, params?: Record<string, string | number>) =>
    translate ? translate(key, params) : defaultTranslate(key, params)

  const fail = async (status: number): Promise<never> => {
    throw new Error(status === 401
      ? await tr('sync.err.auth')
      : await tr('sync.err.http', { status }))
  }
  /**
   * 网络层失败 (断网 / DNS / 证书 / 连接被拒): 底层报错带完整请求地址, 只记控制台,
   * 对外换成本地化文案. 超时仍交给 request 统一处理.
   */
  const unreachable = async (err: unknown): Promise<never> => {
    if (timedOutError(err)) throw err
    console.warn('[sync] webdav request failed', err)
    throw unreachableError(await tr('webdav.err.network'))
  }
  interface Res { status: number; text: string; blob: Blob | null }
  interface RequestOpts {
    /** ≥400 时不抛错的状态码 */
    allow?: number[]
    /** 在超时内读出正文 */
    read?: 'text' | 'blob'
    timeoutMs?: number
  }
  /**
   * 发请求并 (按需) 读正文, 整体限时: 超时则中止并报 sync.err.timeout.
   * 用 Promise.race 兜底, 即使底层 HTTP 不理会 signal 也不会让同步一直挂着.
   * ≥400 且不在 allow 中时抛错.
   */
  const request = async (url: string, req: HttpRequest, opts: RequestOpts = {}): Promise<Res> => {
    const { allow = [], read, timeoutMs = REQUEST_TIMEOUT_MS } = opts
    const ctrl = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        ctrl.abort()
        reject(new Error('timeout'))
      }, timeoutMs)
    })
    const work = (async (): Promise<Res> => {
      const send = () => http(url, { ...req, signal: ctrl.signal })
      const res = await send()
        .catch(err => (connectionResetError(err) && !ctrl.signal.aborted ? send() : Promise.reject(err)))
        .catch(unreachable)
      if (res.status >= 400 && !allow.includes(res.status)) await fail(res.status)
      const ok = res.status < 400
      return {
        status: res.status,
        text: read === 'text' && ok ? await res.text().catch(unreachable) : '',
        blob: read === 'blob' && ok ? await res.blob().catch(unreachable) : null,
      }
    })()
    try {
      return await Promise.race([work, deadline])
    } catch (err) {
      if (timedOut || timedOutError(err)) {
        throw new Error(await tr('sync.err.timeout'))
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }
  /** 目录不存在: 一般是 404; 坚果云在上级目录也不存在时回 409 */
  const missing = (status: number) => status === 404 || status === 409
  const propfind = (url: string, depth: '0' | '1') => request(url, {
    method: 'PROPFIND',
    headers: { depth, 'content-type': 'application/xml; charset=utf-8' },
    body: PROPFIND_BODY,
  }, { allow: [404, 409], read: depth === '1' ? 'text' : undefined })
  const list = async (dir: string, dirName: string) => {
    const res = await propfind(dir, '1')
    if (missing(res.status)) return []
    return parsePropfindNames(res.text, dirName)
  }

  return {
    kind: 'webdav',
    id: `webdav:${base}#${cfg.user}`,
    supportsFiles: true,

    async prepare() {
      const [devices, files] = await Promise.all([propfind(devicesDir, '0'), propfind(filesDir, '0')])
      if (!missing(devices.status) && !missing(files.status)) return
      for (const dir of [
        `${base}/LightRead/`, `${base}/LightRead/sync/`, `${root}/`, devicesDir, filesDir,
      ]) {
        // 405: 已存在
        await request(dir, { method: 'MKCOL' }, { allow: [405] })
      }
    },

    async listDocs() {
      const names = (await list(devicesDir, 'devices')).filter(n => n.endsWith('.json'))
      const docs = await mapLimit(names, 4, async name => {
        const res = await request(devicesDir + encodeURIComponent(name), { method: 'GET' }, {
          allow: [404], read: 'text',
        })
        if (res.status === 404) return null
        try {
          const doc: unknown = JSON.parse(res.text)
          return isSyncDoc(doc) ? doc : null
        } catch {
          return null // 损坏的文件跳过
        }
      })
      return docs.filter((d): d is SyncDoc => d !== null)
    },

    async putDoc(doc) {
      const body = JSON.stringify(doc)
      await request(devicesDir + encodeURIComponent(`${doc.deviceId}.json`), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body,
      }, { timeoutMs: uploadTimeoutMs(body.length) + TIMEOUT_SLACK_MS })
    },

    async listFiles() {
      return new Set(await list(filesDir, 'files'))
    },

    async putFile(name, data) {
      const body = isLocalFileRef(data) && !acceptsFileRefs ? await data.blob() : data
      const size = body instanceof Blob ? body.size : undefined
      await request(filesDir + encodeURIComponent(name), {
        method: 'PUT',
        headers: { 'content-type': name.endsWith('.cover') ? 'image/jpeg' : 'application/octet-stream' },
        body,
      }, { timeoutMs: uploadTimeoutMs(size) + TIMEOUT_SLACK_MS })
    },

    async getFile(name) {
      const res = await request(filesDir + encodeURIComponent(name), { method: 'GET' }, {
        allow: [404], read: 'blob', timeoutMs: DOWNLOAD_TIMEOUT_MS,
      })
      return res.status === 404 ? null : res.blob
    },

    ...(nativeFiles ? {
      async downloadFileTo(name: string, dest: LocalFileRef) {
        const [{ authHeader, REMOTE_USER_AGENT }, { nativeDownload }] = await Promise.all([
          import('../net.ts'), import('../nativeUpload.ts'),
        ])
        let res
        try {
          res = await nativeDownload(filesDir + encodeURIComponent(name), {
            'user-agent': REMOTE_USER_AGENT, ...authHeader({ username: cfg.user, password: cfg.pass }),
          }, dest)
        } catch (err) {
          if (timedOutError(err)) throw new Error(await tr('sync.err.timeout'))
          return unreachable(err)
        }
        if (res.status === 404) return null
        if (res.status >= 400) await fail(res.status)
        return { sha256: res.sha256, size: res.size }
      },
    } : {}),
  }
}
