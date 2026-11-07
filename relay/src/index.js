/**
 * LightRead AI 内置通道中转 (Cloudflare Worker)
 *
 * 路由:
 *  - POST /v1/chat/completions  阅读 AI 助手的试用通道 (OpenAI 兼容, SSE 透传)
 *  - POST /v1/dianjing          点睛阅读专用接口 (提示词在服务端拼装, NDJSON 流)
 *  - POST /v1/translate         划词翻译 (需轻阅账号登录, 每账号每日次数; 提示词在服务端拼装, SSE 透传)
 *  - GET  /v1/models            可用模型 (静态)
 *
 * 上游: SiliconFlow `deepseek-ai/DeepSeek-V4-Flash`, 强制 enable_thinking:false。
 *  - 试用通道: 旧客户端传来的 glm-4.x-flash 一律映射到 V4-Flash; SiliconFlow 出错且配置了
 *    UPSTREAM_KEY (智谱) 时退回智谱免费的 glm-4.7-flash。
 *  - 点睛: V4-Flash 不可用时退回 DJ_FALLBACK_MODEL, 实际模型写在响应头 x-dj-model (进入客户端缓存键)。
 *
 * 防线 (由外向内):
 *  1. 每 IP / 每设备每分钟限速 (isolate 内存滑动窗口)
 *  2. 试用通道: 设备 + IP 每日次数 (D1); 点睛: 设备 + IP 每日字数 (D1)
 *  3. 全站每日预算 (D1, 按 token 估算成本, 万分之一元为单位), 超出返回 429 code=budget
 *  4. 点睛只接受固定 schema (服务端拼提示词), 不能当通用代理; max_tokens 与长度上限
 *  D1 故障时不阻断服务, 退化为仅内存限速。
 *
 * 翻译: Bearer 是轻阅账号的会话 token, 经服务绑定 ACCOUNT (lightread-sync) 的 GET /v1/me 校验,
 *  结果在 isolate 内缓存 10 分钟; 计数按账号 id (kind 'tr'), 提示词来自 src/services/translateCore.ts。
 *
 * 提示词与额度换算来自 src/services/dianjing/prompt.ts (wrangler/esbuild 直接打包, 与客户端单一来源)。
 *
 * 部署: cd relay && npx wrangler deploy
 * 密钥: npx wrangler secret put SILICONFLOW_KEY   (可选 UPSTREAM_KEY: 智谱, 作试用通道备用)
 * 建表 (一次): npx wrangler d1 execute lightread-usage --remote --file schema.sql
 */
import {
  buildChatBody,
  CNY_TO_UNITS,
  chargeChars,
  costUnits,
  DAILY_BUDGET_CNY,
  DEVICE_DAILY_CHARS,
  DJ_FALLBACK_MODEL,
  DJ_MODEL,
  estimateTokens,
  IP_DAILY_CHARS,
  sanitizeRequest,
  validateRequest,
} from '../../src/services/dianjing/prompt.ts'
import {
  ACCOUNT_TRANSLATE_DAILY,
  sanitizeTranslate,
  translateMaxTokens,
  translateMessages,
  validateTranslate,
} from '../../src/services/translateCore.ts'
import { CHAT_MODEL, LEGACY_MODELS, quotaDay, rateLimited, sseToNdjson, verifyAccount } from './lib.js'

const SF_BASE = 'https://api.siliconflow.cn/v1'
const ZHIPU_BASE = 'https://open.bigmodel.cn/api/paas/v4'

const ZHIPU_FALLBACK_MODEL = 'glm-4.7-flash'

const MAX_TOKENS = 1024
const MAX_CONTEXT_CHARS = 32_000
const CHAT_PER_IP_PER_MIN = 10
const DJ_PER_DEVICE_PER_MIN = 20
const DJ_PER_IP_PER_MIN = 60
const TR_PER_ACCOUNT_PER_MIN = 20
const ACCOUNT_API = 'https://sync.jiangshu.ai'

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization, x-device-id',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-expose-headers': 'x-dj-model, x-dj-remaining, x-translate-remaining',
}

const json = (status, payload, extra = {}) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...CORS, ...extra },
  })

const err = (status, message, code) => json(status, { error: { message, ...(code ? { code } : {}) } })

/** 自增 n 并返回当日计数 (原子, 跨节点一致) */
async function bumpUsage(db, day, kind, id, n = 1) {
  const row = await db
    .prepare(
      'INSERT INTO usage(day, kind, id, count) VALUES(?1, ?2, ?3, ?4) ' +
      'ON CONFLICT(day, kind, id) DO UPDATE SET count = count + ?4 RETURNING count',
    )
    .bind(day, kind, id, n)
    .first()
  return Number(row?.count ?? 0)
}

async function readUsage(db, day, kind, id) {
  const row = await db.prepare('SELECT count FROM usage WHERE day = ?1 AND kind = ?2 AND id = ?3').bind(day, kind, id).first()
  return Number(row?.count ?? 0)
}

const budgetUnits = env => Number(env.DAILY_BUDGET_CNY ?? DAILY_BUDGET_CNY) * CNY_TO_UNITS

function clientIds(request) {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  // 匿名设备标识: 应用首启生成的随机 id, 无任何个人信息
  const rawDevice = request.headers.get('x-device-id') ?? ''
  const device = /^[\w-]{8,64}$/.test(rawDevice) ? rawDevice : `noid:${ip}`
  return { ip, device }
}

function maybeCleanup(env) {
  // 偶发清理过期计数 (~1% 请求触发)
  if (Math.random() < 0.01) return env.DB.prepare("DELETE FROM usage WHERE day < date('now', '-3 day')").run()
  return null
}

async function siliconflow(env, body, signal) {
  return fetch(SF_BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.SILICONFLOW_KEY}` },
    body: JSON.stringify(body),
    signal,
  })
}

// ---- 试用通道: /v1/chat/completions ----

async function handleChat(request, env, ctx) {
  if (!env.SILICONFLOW_KEY && !env.UPSTREAM_KEY) {
    return err(503, '试用通道尚未配置, 请在设置中填入自己的 API Key')
  }
  const { ip, device } = clientIds(request)
  if (rateLimited(`c:${ip}`, CHAT_PER_IP_PER_MIN)) {
    return err(429, '试用通道限速 (每分钟 10 次)。稍后再试, 或在「设置 → AI 助手」填入自己的 Key 不限速。', 'rate')
  }

  let body
  try {
    body = await request.json()
  } catch {
    return err(400, 'invalid JSON body')
  }
  const model = String(body?.model ?? '')
  if (model !== CHAT_MODEL && !LEGACY_MODELS.has(model)) {
    return err(400, `试用通道仅支持: ${CHAT_MODEL}`)
  }
  const messages = Array.isArray(body.messages) ? body.messages : []
  const context = JSON.stringify(messages)
  if (!messages.length) return err(400, 'empty messages')
  if (context.length > MAX_CONTEXT_CHARS) return err(400, '上下文过长, 请清空对话后重试')
  const maxTokens = Math.min(Number(body.max_tokens) || MAX_TOKENS, MAX_TOKENS)
  // 按上限预估成本 (输入 + max_tokens), 保守计入全站预算
  const cost = costUnits(estimateTokens(context), maxTokens)

  try {
    const day = quotaDay()
    const deviceQuota = Number(env.DEVICE_DAILY_QUOTA ?? 120)
    const ipQuota = Number(env.IP_DAILY_QUOTA ?? 300)
    const spent = await readUsage(env.DB, day, 'cost', 'all')
    if (spent >= budgetUnits(env)) {
      return err(429, '今日内置通道总额度已用完。明天再来, 或在「设置 → AI 助手」填入自己的 Key (不限额)。', 'budget')
    }
    const [deviceCount, ipCount] = await Promise.all([
      bumpUsage(env.DB, day, 'd', device),
      bumpUsage(env.DB, day, 'i', ip),
    ])
    if (deviceCount > deviceQuota || ipCount > ipQuota) {
      return err(429, '今日试用额度已用完。明天再来, 或在「设置 → AI 助手」填入自己的 Key (不限额)。', 'quota')
    }
    ctx.waitUntil(bumpUsage(env.DB, day, 'cost', 'all', cost).catch(() => {}))
    const cleanup = maybeCleanup(env)
    if (cleanup) ctx.waitUntil(cleanup.catch(() => {}))
  } catch (e) {
    console.warn('quota check failed:', e?.message)
  }

  const clean = {
    model: CHAT_MODEL,
    messages,
    stream: body.stream !== false,
    max_tokens: maxTokens,
    enable_thinking: false,
    ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === 'number' ? { top_p: body.top_p } : {}),
  }

  let upstream = null
  if (env.SILICONFLOW_KEY) {
    try {
      upstream = await siliconflow(env, clean)
    } catch (e) {
      console.warn('siliconflow failed:', e?.message)
    }
  }
  if ((!upstream || !upstream.ok) && env.UPSTREAM_KEY) {
    // 备用: 智谱免费 Flash
    const { enable_thinking: _drop, ...zhipu } = clean
    try {
      const alt = await fetch(ZHIPU_BASE + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.UPSTREAM_KEY}` },
        body: JSON.stringify({ ...zhipu, model: ZHIPU_FALLBACK_MODEL }),
      })
      if (alt.ok || !upstream) upstream = alt
    } catch (e) {
      console.warn('zhipu fallback failed:', e?.message)
    }
  }
  if (!upstream) return err(502, '上游服务暂时不可用, 请稍后再试')
  const headers = new Headers(CORS)
  headers.set('content-type', upstream.headers.get('content-type') ?? 'application/json')
  return new Response(upstream.body, { status: upstream.status, headers })
}

// ---- 点睛阅读: /v1/dianjing ----

async function handleDianjing(request, env, ctx) {
  if (!env.SILICONFLOW_KEY) return err(503, '点睛阅读内置通道尚未配置, 请在设置中填入自己的 API Key', 'config')
  const { ip, device } = clientIds(request)
  if (rateLimited(`dd:${device}`, DJ_PER_DEVICE_PER_MIN) || rateLimited(`di:${ip}`, DJ_PER_IP_PER_MIN)) {
    return err(429, '请求过于频繁, 请稍后再试', 'rate')
  }
  let raw
  try {
    raw = await request.json()
  } catch {
    return err(400, 'invalid JSON body')
  }
  const invalid = validateRequest(raw)
  if (invalid) return err(400, invalid)
  const req = sanitizeRequest(raw)
  const chars = chargeChars(req.text)
  const deviceQuota = Number(env.DJ_DEVICE_DAILY_CHARS ?? DEVICE_DAILY_CHARS)
  const ipQuota = Number(env.DJ_IP_DAILY_CHARS ?? IP_DAILY_CHARS)
  const day = quotaDay()
  let remaining = deviceQuota
  try {
    const spent = await readUsage(env.DB, day, 'cost', 'all')
    if (spent >= budgetUnits(env)) {
      return err(429, '今日内置通道总额度已用完。明天再来, 或在「设置 → AI 助手」填入自己的 Key (不限额)。', 'budget')
    }
    const [deviceChars, ipChars] = await Promise.all([
      bumpUsage(env.DB, day, 'djd', device, chars),
      bumpUsage(env.DB, day, 'dji', ip, chars),
    ])
    // 本次之前未超额就放行 (最后一块不被截断)
    if (deviceChars - chars >= deviceQuota || ipChars - chars >= ipQuota) {
      return json(429, { error: { message: '今日点睛内置额度已用完 · 填入自己的密钥不限额', code: 'quota' } }, { 'x-dj-remaining': '0' })
    }
    remaining = Math.max(0, deviceQuota - deviceChars)
    const cleanup = maybeCleanup(env)
    if (cleanup) ctx.waitUntil(cleanup.catch(() => {}))
  } catch (e) {
    console.warn('quota check failed:', e?.message)
  }

  const abort = new AbortController()
  let model = DJ_MODEL
  let upstream
  try {
    upstream = await siliconflow(env, buildChatBody(req, DJ_MODEL), abort.signal)
    if (!upstream.ok && upstream.status !== 400) {
      console.warn('dianjing primary failed:', upstream.status)
      model = DJ_FALLBACK_MODEL
      upstream = await siliconflow(env, buildChatBody(req, DJ_FALLBACK_MODEL), abort.signal)
    }
  } catch (e) {
    return err(502, `上游服务暂时不可用: ${e?.message ?? e}`)
  }
  if (!upstream.ok || !upstream.body) {
    const text = (await upstream.text().catch(() => '')).slice(0, 200)
    return err(502, `上游错误 ${upstream.status} ${text}`)
  }

  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()
  const inputTokens = estimateTokens(buildChatBody(req, model).messages.map(m => m.content).join('\n'))
  const done = (async () => {
    let output = ''
    try {
      output = await sseToNdjson(upstream.body, s => { writer.write(encoder.encode(s)).catch(() => abort.abort()) })
    } catch (e) {
      console.warn('dianjing stream failed:', e?.message)
    } finally {
      try { await writer.close() } catch { /* 客户端已断开 */ }
      try {
        await bumpUsage(env.DB, day, 'cost', 'all', costUnits(inputTokens, estimateTokens(output)))
      } catch { /* D1 故障 */ }
    }
  })()
  ctx.waitUntil(done)
  const headers = new Headers(CORS)
  headers.set('content-type', 'application/x-ndjson; charset=utf-8')
  headers.set('cache-control', 'no-store')
  headers.set('x-dj-model', model)
  headers.set('x-dj-remaining', String(remaining))
  return new Response(readable, { status: 200, headers })
}

// ---- 划词翻译: /v1/translate ----

/** 向账号后端查会话: 有服务绑定走绑定, 否则走公网地址 */
function accountFetch(env, token) {
  const init = { headers: { authorization: `Bearer ${token}` } }
  if (env.ACCOUNT?.fetch) return env.ACCOUNT.fetch(new Request(`${ACCOUNT_API}/v1/me`, init))
  return fetch(`${ACCOUNT_API}/v1/me`, init)
}

async function handleTranslate(request, env, ctx) {
  if (!env.SILICONFLOW_KEY) return err(503, '翻译内置通道尚未配置, 请在设置中填入自己的 API Key', 'config')
  const m = /^Bearer\s+([A-Za-z0-9_-]{16,128})$/.exec(request.headers.get('authorization') ?? '')
  if (!m) return err(401, '请先登录轻阅账号, 或在「设置 → AI 助手」填入自己的 Key', 'login')
  const account = await verifyAccount(m[1], token => accountFetch(env, token))
  if (account === 'unavailable') return err(503, '账号服务暂时不可用, 请稍后再试', 'account')
  if (!account) return err(401, '登录已失效, 请重新登录', 'login')
  const { ip } = clientIds(request)
  if (rateLimited(`ta:${account}`, TR_PER_ACCOUNT_PER_MIN) || rateLimited(`c:${ip}`, CHAT_PER_IP_PER_MIN * 3)) {
    return err(429, '翻译太频繁, 请稍后再试', 'rate')
  }
  let raw
  try {
    raw = await request.json()
  } catch {
    return err(400, 'invalid JSON body')
  }
  const invalid = validateTranslate(raw)
  if (invalid) return err(400, invalid)
  const req = sanitizeTranslate(raw)
  const messages = translateMessages(req)
  const maxTokens = translateMaxTokens(req.text)
  const quota = Number(env.ACCOUNT_TRANSLATE_DAILY ?? ACCOUNT_TRANSLATE_DAILY)
  const day = quotaDay()
  let remaining = quota
  try {
    const spent = await readUsage(env.DB, day, 'cost', 'all')
    if (spent >= budgetUnits(env)) {
      return err(429, '今日内置通道总额度已用完。明天再来, 或在「设置 → AI 助手」填入自己的 Key (不限额)。', 'budget')
    }
    const used = await bumpUsage(env.DB, day, 'tr', account)
    if (used > quota) {
      return json(429, { error: { message: `今日 ${quota} 次免费翻译已用完。明天再来, 或在「设置 → AI 助手」填入自己的 Key (不限额)。`, code: 'quota' } }, { 'x-translate-remaining': '0' })
    }
    remaining = Math.max(0, quota - used)
    const cost = costUnits(estimateTokens(messages.map(x => x.content).join('\n')), maxTokens)
    ctx.waitUntil(bumpUsage(env.DB, day, 'cost', 'all', cost).catch(() => {}))
    const cleanup = maybeCleanup(env)
    if (cleanup) ctx.waitUntil(cleanup.catch(() => {}))
  } catch (e) {
    console.warn('quota check failed:', e?.message)
  }
  let upstream
  try {
    upstream = await siliconflow(env, {
      model: CHAT_MODEL,
      messages,
      stream: true,
      max_tokens: maxTokens,
      temperature: 0.3,
      enable_thinking: false,
    })
  } catch (e) {
    return err(502, `上游服务暂时不可用: ${e?.message ?? e}`)
  }
  const headers = new Headers(CORS)
  headers.set('content-type', upstream.headers.get('content-type') ?? 'application/json')
  headers.set('cache-control', 'no-store')
  headers.set('x-translate-remaining', String(remaining))
  return new Response(upstream.body, { status: upstream.status, headers })
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS })
    }
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname.endsWith('/models')) {
      return json(200, { object: 'list', data: [{ id: CHAT_MODEL, object: 'model', owned_by: 'lightread' }] })
    }
    if (request.method === 'POST' && url.pathname.endsWith('/dianjing')) {
      return handleDianjing(request, env, ctx)
    }
    if (request.method === 'POST' && url.pathname.endsWith('/translate')) {
      return handleTranslate(request, env, ctx)
    }
    if (request.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      return handleChat(request, env, ctx)
    }
    return err(404, 'not found')
  },
}
