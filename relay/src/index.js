/**
 * LightRead AI 试用通道中转 (Cloudflare Worker)
 *
 * 应用 → 本 Worker → 硅基流动。API Key 只存在 Worker 的环境变量里,
 * 客户端不含任何密钥。防线:
 *  - 仅放行免费模型白名单
 *  - 每 IP 每分钟限次 (isolate 内存滑动窗口, 拦截随手滥用)
 *  - max_tokens 与上下文长度上限
 * 即使被恶意刷, 调用的也只是免费模型, 不产生费用。
 *
 * 部署: cd relay && npx wrangler deploy
 * 配置密钥: npx wrangler secret put SILICONFLOW_KEY
 */

const UPSTREAM = 'https://api.siliconflow.cn/v1/chat/completions'

/** 硅基流动免费模型白名单 */
const FREE_MODELS = new Set([
  'Qwen/Qwen2.5-7B-Instruct',
  'Qwen/Qwen2-7B-Instruct',
  'THUDM/glm-4-9b-chat',
  'internlm/internlm2_5-7b-chat',
])

const MAX_TOKENS = 1024
const MAX_CONTEXT_CHARS = 32_000
const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 10

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-allow-methods': 'POST, OPTIONS',
}

const json = (status, payload) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  })

/** isolate 内存滑动窗口限流; Worker 重启即清零, 足以拦截随手滥用 */
const buckets = new Map()
function rateLimited(ip) {
  const now = Date.now()
  const recent = (buckets.get(ip) ?? []).filter(t => now - t < WINDOW_MS)
  if (recent.length >= MAX_PER_WINDOW) {
    buckets.set(ip, recent)
    return true
  }
  recent.push(now)
  buckets.set(ip, recent)
  if (buckets.size > 5000) buckets.clear()
  return false
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS })
    }
    const url = new URL(request.url)
    if (request.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
      return json(404, { error: { message: 'not found' } })
    }
    if (!env.SILICONFLOW_KEY) {
      return json(503, { error: { message: '试用通道尚未配置, 请在设置中填入自己的 API Key' } })
    }

    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
    if (rateLimited(ip)) {
      return json(429, { error: { message: '试用通道限速 (每分钟 10 次)。稍后再试, 或在「设置 → AI 助手」填入自己的免费 Key 不限速。' } })
    }

    let body
    try {
      body = await request.json()
    } catch {
      return json(400, { error: { message: 'invalid JSON body' } })
    }
    if (!FREE_MODELS.has(String(body.model))) {
      return json(400, { error: { message: `试用通道仅支持免费模型: ${[...FREE_MODELS].join(', ')}` } })
    }
    if (JSON.stringify(body.messages ?? []).length > MAX_CONTEXT_CHARS) {
      return json(400, { error: { message: '上下文过长, 请清空对话后重试' } })
    }
    body.max_tokens = Math.min(Number(body.max_tokens) || MAX_TOKENS, MAX_TOKENS)

    const upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.SILICONFLOW_KEY}`,
      },
      body: JSON.stringify(body),
    })
    const headers = new Headers(CORS)
    headers.set('content-type', upstream.headers.get('content-type') ?? 'application/json')
    return new Response(upstream.body, { status: upstream.status, headers })
  },
}
