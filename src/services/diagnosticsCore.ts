/**
 * 诊断日志的纯函数: 脱敏 / 单行格式 / 环形缓冲 / 反馈链接。无平台依赖, 见 scripts/test-diagnostics.mjs。
 * 只记录错误与运行事件, 不记录书籍正文和划线。写入前脱敏一次, 导出时再脱敏一次
 * (原生层自己写的日志只经过后一次)。
 */
export type LogLevel = 'info' | 'warn' | 'error'

export interface LogLine {
  at: string
  level: LogLevel
  area: string
  message: string
}

const MAX_MESSAGE = 4000

const RULES: Array<[RegExp, string]> = [
  // 认证头与带名字的密钥。值可能带引号, 也可能是 JSON 里的 "key":"value"
  [/\b(authorization|proxy-authorization|x-api-key|x-api-access-key)(["']?\s*[:=]\s*["']?)(bearer\s+|basic\s+)?[^\s"',;]+/gi, '$1$2<redacted>'],
  [/\b((?:api[_-]?key|apikey|access[_-]?key|secret|token|refresh[_-]?token|password|passwd|pwd|verification[_-]?code|email[_-]?code)["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, '$1<redacted>'],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <redacted>'],
  // 常见密钥形态
  [/\bsk-[A-Za-z0-9_-]{8,}/g, '<redacted-key>'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '<redacted-jwt>'],
  // URL: 去掉查询串与内嵌账号, 留下站点和路径
  [/\b(https?|wss?|webdav):\/\/[^/\s:@]+:[^/\s@]+@/gi, '$1://<redacted>@'],
  [/\b((?:https?|wss?):\/\/[^\s?#"']+)\?[^\s"']*/gi, '$1?<redacted>'],
  // 邮箱
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '<email>'],
  // 系统用户名
  [/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s"']+/g, '$1<user>'],
  [/(\/(?:home|Users)\/)[^/\s"']+/g, '$1<user>'],
  // 应用书库里的文件名常常就是书名, 只留扩展名
  [/([\\/]books[\\/]+[^\\/\s"']+[\\/]+)[^\\/\r\n"']*?(\.[A-Za-z0-9]{1,6})(?=$|[\s"'])/gm, '$1<file>$2'],
]

export function redact(text: string): string {
  let out = text
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement)
  return out
}

/** 任意值 → 不含敏感信息的短文本; Error 保留类型与堆栈 */
export function describe(value: unknown): string {
  if (value instanceof Error) {
    const head = `${value.name}: ${value.message}`
    return value.stack?.includes(value.message) ? value.stack : `${head}\n${value.stack ?? ''}`.trim()
  }
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

export function makeLine(level: LogLevel, area: string, parts: unknown[], now = new Date()): LogLine {
  let message = redact(parts.map(describe).join(' '))
  if (message.length > MAX_MESSAGE) message = `${message.slice(0, MAX_MESSAGE)}…(+${message.length - MAX_MESSAGE})`
  return { at: now.toISOString(), level, area, message }
}

export function formatLine(line: LogLine): string {
  return `${line.at} ${line.level.toUpperCase().padEnd(5)} [${line.area}] ${line.message}`
}

/** 固定容量的内存缓冲; 网页版没有日志文件, 导出时就用它 */
export class RingBuffer<T> {
  private items: T[] = []
  private capacity: number
  constructor(capacity: number) {
    this.capacity = capacity
  }
  push(item: T) {
    this.items.push(item)
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity)
  }
  toArray(): T[] {
    return [...this.items]
  }
}

export interface DiagnosticsEnv {
  version: string
  platform: string
  userAgent: string
  webview?: string
  memory?: string
}

/** GitHub 新建 issue 链接: 预填环境, 日志文件由用户在页面上拖入 */
export function feedbackUrl(env: DiagnosticsEnv, repo = 'https://github.com/yzfly/LightRead'): string {
  const params = new URLSearchParams({
    template: 'bug-report.yml',
    version: `${env.version} · ${env.platform}${env.webview ? ` · WebView ${env.webview}` : ''}`,
  })
  return `${repo}/issues/new?${params}`
}

export function bundleName(version: string, now = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
  return `lightread-diagnostics-${version}-${stamp}.zip`
}
