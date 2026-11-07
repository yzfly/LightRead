/**
 * relay 的纯函数 (可在 node 下测试): 限流、计数日、SSE → NDJSON 转换。
 * Worker 入口 (index.js) 只能有 default 导出 (具名导出会被当成 handler), 辅助函数放这里。
 */

/** 试用通道对外的模型名; 旧客户端的智谱 Flash 名字映射到它 */
export const CHAT_MODEL = 'deepseek-ai/DeepSeek-V4-Flash'
export const LEGACY_MODELS = new Set(['glm-4.7-flash', 'glm-4.5-flash', 'glm-4-flash'])

const WINDOW_MS = 60_000

/** isolate 内存滑动窗口限流 (第一道闸, 拦掉高频轰击, 减少 D1 写入) */
const buckets = new Map()
export function rateLimited(key, max, now = Date.now()) {
  const recent = (buckets.get(key) ?? []).filter(t => now - t < WINDOW_MS)
  if (recent.length >= max) {
    buckets.set(key, recent)
    return true
  }
  recent.push(now)
  buckets.set(key, recent)
  if (buckets.size > 5000) buckets.clear()
  return false
}

/** 计数日: 北京时间 (UTC+8) 零点重置 */
export function quotaDay(now = Date.now()) {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10)
}

/**
 * 上游 SSE → NDJSON: 抽出 delta.content, 按行切分, 只转发像 JSON 对象的行 (去掉代码块围栏等)。
 * 返回累计输出文本 (成本估算用)。
 */
export async function sseToNdjson(readable, write) {
  const reader = readable.getReader()
  const decoder = new TextDecoder()
  let sse = ''
  let line = ''
  let output = ''
  const emit = text => {
    output += text
    line += text
    const parts = line.split('\n')
    line = parts.pop() ?? ''
    for (const p of parts) {
      const t = p.trim()
      if (t.startsWith('{') && t.endsWith('}')) write(t + '\n')
    }
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    sse += decoder.decode(value, { stream: true })
    const events = sse.split('\n')
    sse = events.pop() ?? ''
    for (const ev of events) {
      const t = ev.trim()
      if (!t.startsWith('data:')) continue
      const payload = t.slice(5).trim()
      if (payload === '[DONE]') continue
      try {
        const c = JSON.parse(payload)?.choices?.[0]?.delta?.content
        if (typeof c === 'string' && c) emit(c)
      } catch { /* 心跳 */ }
    }
  }
  const t = line.trim()
  if (t.startsWith('{') && t.endsWith('}')) write(t + '\n')
  return output
}

const ACCOUNT_TTL_MS = 10 * 60_000
const accountCache = new Map()

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 校验轻阅账号会话 token: 返回账号 id; token 无效返回 null; 账号服务出错返回 'unavailable'。
 * 有效结果按 token 的 SHA-256 在 isolate 内缓存 10 分钟 (登出后最多 10 分钟内仍可用, 只影响翻译额度);
 * lookup(token) 发起 GET /v1/me 请求。
 */
export async function verifyAccount(token, lookup, now = Date.now()) {
  const key = await sha256Hex(token)
  const hit = accountCache.get(key)
  if (hit && now - hit.at < ACCOUNT_TTL_MS) return hit.id
  let res
  try {
    res = await lookup(token)
  } catch {
    return 'unavailable'
  }
  if (res.status === 401) {
    accountCache.delete(key)
    return null
  }
  if (!res.ok) return 'unavailable'
  const id = (await res.json().catch(() => null))?.account?.id
  if (typeof id !== 'string' || !id) return 'unavailable'
  if (accountCache.size > 5000) accountCache.clear()
  accountCache.set(key, { id, at: now })
  return id
}
