/**
 * LightRead AI 试用通道中转 (Cloudflare Worker)
 *
 * 应用 → 本 Worker → 智谱 (GLM Flash 免费系)。API Key 只存在 Worker 的环境变量里,
 * 客户端不含任何密钥。防线 (由外向内):
 *  1. 免费模型白名单 — 被刷也不产生费用
 *  2. 每 IP 每分钟限速 (isolate 内存滑动窗口)
 *  3. 匿名设备 + IP 双维度每日配额 (D1 计数, 跨节点一致)
 *  4. max_tokens 与上下文长度上限
 *
 * 部署: cd relay && npx wrangler deploy
 * 配置密钥: npx wrangler secret put UPSTREAM_KEY  (智谱 API Key)
 * 建表 (一次): npx wrangler d1 execute lightread-usage --remote --file schema.sql
 */

const UPSTREAM_BASE = 'https://open.bigmodel.cn/api/paas/v4'
const UPSTREAM = UPSTREAM_BASE + '/chat/completions'

/** 智谱免费 Flash 系模型白名单 */
const FREE_MODELS = new Set([
  'glm-4.7-flash',
  'glm-4.5-flash',
  'glm-4-flash',
])

const MAX_TOKENS = 1024
const MAX_CONTEXT_CHARS = 32_000
const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 10

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization, x-device-id',
  'access-control-allow-methods': 'POST, OPTIONS',
}

const json = (status, payload) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  })

const err = (status, message) => json(status, { error: { message } })

/** isolate 内存滑动窗口限流 (第一道闸, 拦掉高频轰击, 减少 D1 写入) */
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

/** 自增并返回当日计数 (原子, 跨节点一致) */
async function bumpUsage(db, day, kind, id) {
  const row = await db
    .prepare(
      'INSERT INTO usage(day, kind, id, count) VALUES(?1, ?2, ?3, 1) ' +
      'ON CONFLICT(day, kind, id) DO UPDATE SET count = count + 1 RETURNING count',
    )
    .bind(day, kind, id)
    .first()
  return Number(row?.count ?? 0)
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS })
    }
    const url = new URL(request.url)
    // 模型列表透传 (公开信息, 便于诊断与选型)
    if (request.method === 'GET' && url.pathname.endsWith('/models')) {
      if (!env.UPSTREAM_KEY) return err(503, 'not configured')
      const upstream = await fetch(UPSTREAM_BASE + '/models', {
        headers: { authorization: `Bearer ${env.UPSTREAM_KEY}` },
      })
      const headers = new Headers(CORS)
      headers.set('content-type', 'application/json')
      return new Response(upstream.body, { status: upstream.status, headers })
    }
    if (request.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
      return err(404, 'not found')
    }
    if (!env.UPSTREAM_KEY) {
      return err(503, '试用通道尚未配置, 请在设置中填入自己的 API Key')
    }

    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
    if (rateLimited(ip)) {
      return err(429, '试用通道限速 (每分钟 10 次)。稍后再试, 或在「设置 → AI 助手」填入自己的 Key 不限速。')
    }

    // 匿名设备标识: 应用首启生成的随机 id, 无任何个人信息
    const rawDevice = request.headers.get('x-device-id') ?? ''
    const device = /^[\w-]{8,64}$/.test(rawDevice) ? rawDevice : `noid:${ip}`

    // 双维度每日配额 (D1)
    try {
      const day = new Date().toISOString().slice(0, 10)
      const deviceQuota = Number(env.DEVICE_DAILY_QUOTA ?? 120)
      const ipQuota = Number(env.IP_DAILY_QUOTA ?? 300)
      const [deviceCount, ipCount] = await Promise.all([
        bumpUsage(env.DB, day, 'd', device),
        bumpUsage(env.DB, day, 'i', ip),
      ])
      if (deviceCount > deviceQuota || ipCount > ipQuota) {
        return err(429, '今日试用额度已用完。明天再来, 或在「设置 → AI 助手」填入自己的 Key (不限额)。')
      }
      // 偶发清理过期计数 (~1% 请求触发)
      if (Math.random() < 0.01) {
        await env.DB.prepare("DELETE FROM usage WHERE day < date('now', '-2 day')").run()
      }
    } catch (e) {
      // D1 故障不阻断服务: 退化为仅内存限速
      console.warn('quota check failed:', e?.message)
    }

    let body
    try {
      body = await request.json()
    } catch {
      return err(400, 'invalid JSON body')
    }
    if (!FREE_MODELS.has(String(body.model))) {
      return err(400, `试用通道仅支持免费模型: ${[...FREE_MODELS].join(', ')}`)
    }
    if (JSON.stringify(body.messages ?? []).length > MAX_CONTEXT_CHARS) {
      return err(400, '上下文过长, 请清空对话后重试')
    }
    body.max_tokens = Math.min(Number(body.max_tokens) || MAX_TOKENS, MAX_TOKENS)

    const upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.UPSTREAM_KEY}`,
      },
      body: JSON.stringify(body),
    })
    const headers = new Headers(CORS)
    headers.set('content-type', upstream.headers.get('content-type') ?? 'application/json')
    return new Response(upstream.body, { status: upstream.status, headers })
  },
}
