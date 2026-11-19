/**
 * 读者反馈 (应用内「反馈问题或建议」): 匿名可用, 登录时附带账号.
 *  - POST /v1/feedback: { kind, text, contact?, version, platform, log? }, log 是诊断包 zip 的 base64 (用户勾选才有)
 *  - 管理 (ADMIN_TOKEN): GET /v1/admin/feedback 列表, GET /v1/admin/feedback/<id>/log 下载日志,
 *    POST /v1/admin/feedback/<id> 改状态 / 备注. 每三天由维护者拉一次新反馈 (scripts/feedback-digest.mjs)
 *  - D1 表 feedback (migrations/0003_feedback.sql), 日志存 R2 feedback/<id>.zip, 180 天后删日志、留文字
 */
import type { D1Database, Env, R2Bucket } from './index'
import { bump, fail, ipRateKey, isObj, json, readBody } from './index'

export const FEEDBACK_KINDS = ['bug', 'feature', 'other'] as const
export const FEEDBACK_STATUSES = ['new', 'seen', 'planned', 'done', 'wontfix'] as const
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number]
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number]

const MAX_TEXT = 4000
const MAX_CONTACT = 200
const MAX_NOTE = 2000
/** 诊断包 zip 上限 (解码后); 客户端超过时只带当前日志 */
export const MAX_FEEDBACK_LOG = 2.5 * 1024 * 1024
/** 请求体上限: base64 膨胀 4/3 再留余量给文字 */
const MAX_FEEDBACK_BODY = Math.ceil((MAX_FEEDBACK_LOG * 4) / 3) + 64 * 1024
/** 每个 IP 每天最多 10 条 */
const FEEDBACK_IP_DAILY = 10
const LOG_RETENTION_MS = 180 * 24 * 3600_000
const ADMIN_LIST_MAX = 200

const logKey = (id: string) => `feedback/${id}.zip`
const ID_RE = /^[0-9a-f-]{36}$/

export interface FeedbackInput {
  kind: FeedbackKind
  text: string
  contact: string
  version: string
  platform: string
  log: Uint8Array | null
}

const shortStr = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

function decodeBase64(s: string): Uint8Array | null {
  try {
    const bin = atob(s)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

/** 校验请求体; 不合法返回错误码 */
export function parseFeedback(body: unknown): FeedbackInput | string {
  if (!isObj(body)) return 'invalid_feedback'
  const kind = body.kind
  if (typeof kind !== 'string' || !(FEEDBACK_KINDS as readonly string[]).includes(kind)) return 'invalid_kind'
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text || text.length > MAX_TEXT) return 'invalid_text'
  let log: Uint8Array | null = null
  if (body.log !== undefined && body.log !== null) {
    if (typeof body.log !== 'string') return 'invalid_log'
    log = decodeBase64(body.log)
    // zip 以 PK\x03\x04 开头
    if (!log || log.length < 4 || log.length > MAX_FEEDBACK_LOG || log[0] !== 0x50 || log[1] !== 0x4b) return 'invalid_log'
  }
  return {
    kind: kind as FeedbackKind,
    text,
    contact: shortStr(body.contact, MAX_CONTACT),
    version: shortStr(body.version, 32),
    platform: shortStr(body.platform, 32),
    log,
  }
}

export async function submitFeedback(
  request: Request,
  env: Env,
  account: { id: string; email: string } | null,
  beijingDay: string,
  retryAfter: number,
): Promise<Response> {
  const raw = await readBody(request, MAX_FEEDBACK_BODY)
  if (!raw) return fail(413, 'too_large')
  let body: unknown
  try {
    body = JSON.parse(new TextDecoder().decode(raw))
  } catch {
    return fail(400, 'invalid_feedback')
  }
  const input = parseFeedback(body)
  if (typeof input === 'string') return fail(400, input)
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  if ((await bump(env.DB, await ipRateKey(env, 'feedback', ip, beijingDay), beijingDay)) > FEEDBACK_IP_DAILY) {
    return fail(429, 'rate_limited', retryAfter)
  }
  const id = crypto.randomUUID()
  const now = Date.now()
  if (input.log) {
    await env.DOCS.put(logKey(id), input.log, { httpMetadata: { contentType: 'application/zip' } })
  }
  await env.DB.prepare(
    'INSERT INTO feedback(id, created_at, kind, text, contact, version, platform, account_id, account_email, log_size, status, note) ' +
      "VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'new', '')",
  )
    .bind(id, now, input.kind, input.text, input.contact, input.version, input.platform,
      account?.id ?? null, account?.email ?? null, input.log?.length ?? 0)
    .run()
  return json(201, { id })
}

interface FeedbackRow {
  id: string
  created_at: number
  kind: string
  text: string
  contact: string
  version: string
  platform: string
  account_email: string | null
  log_size: number
  status: string
  note: string
}

const toItem = (r: FeedbackRow) => ({
  id: r.id,
  createdAt: Number(r.created_at),
  kind: r.kind,
  text: r.text,
  contact: r.contact,
  version: r.version,
  platform: r.platform,
  accountEmail: r.account_email,
  logSize: Number(r.log_size),
  status: r.status,
  note: r.note,
})

const NO_STORE = { 'cache-control': 'no-store' }

/** GET /v1/admin/feedback?status=new|seen|…|all&since=<ms>&limit=<n> (新的在前) */
export async function listFeedback(db: D1Database, search: string): Promise<Response> {
  const q = new URLSearchParams(search)
  const status = q.get('status') ?? 'all'
  if (status !== 'all' && !(FEEDBACK_STATUSES as readonly string[]).includes(status)) {
    return json(400, { error: 'invalid_status' }, NO_STORE)
  }
  const since = Number(q.get('since') ?? 0)
  const limit = Math.min(ADMIN_LIST_MAX, Math.max(1, Number(q.get('limit') ?? 100) || 100))
  if (!Number.isFinite(since) || since < 0) return json(400, { error: 'invalid_since' }, NO_STORE)
  const where = ['created_at >= ?1']
  const args: unknown[] = [since]
  if (status !== 'all') {
    where.push('status = ?2')
    args.push(status)
  }
  const rows = await db
    .prepare(`SELECT * FROM feedback WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${limit}`)
    .bind(...args)
    .all<FeedbackRow>()
  const counts = await db
    .prepare('SELECT status, COUNT(*) AS n FROM feedback GROUP BY status')
    .all<{ status: string; n: number }>()
  return json(200, {
    items: rows.results.map(toItem),
    counts: Object.fromEntries(counts.results.map(c => [c.status, Number(c.n)])),
  }, NO_STORE)
}

/** GET /v1/admin/feedback/<id>/log */
export async function feedbackLog(bucket: R2Bucket, id: string): Promise<Response> {
  if (!ID_RE.test(id)) return json(400, { error: 'invalid_id' }, NO_STORE)
  const obj = await bucket.get(logKey(id))
  if (!obj) return json(404, { error: 'not_found' }, NO_STORE)
  return new Response(obj.body, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="feedback-${id.slice(0, 8)}.zip"`,
      ...NO_STORE,
    },
  })
}

/** POST /v1/admin/feedback/<id> { status?, note? } */
export async function updateFeedback(request: Request, db: D1Database, id: string): Promise<Response> {
  if (!ID_RE.test(id)) return json(400, { error: 'invalid_id' }, NO_STORE)
  const raw = await readBody(request, 8 * 1024)
  let body: unknown
  try {
    body = raw ? JSON.parse(new TextDecoder().decode(raw)) : undefined
  } catch { /* 下面按非法处理 */ }
  if (!isObj(body)) return json(400, { error: 'invalid_body' }, NO_STORE)
  const sets: string[] = []
  const args: unknown[] = []
  if (body.status !== undefined) {
    if (typeof body.status !== 'string' || !(FEEDBACK_STATUSES as readonly string[]).includes(body.status)) {
      return json(400, { error: 'invalid_status' }, NO_STORE)
    }
    args.push(body.status)
    sets.push(`status = ?${args.length}`)
  }
  if (body.note !== undefined) {
    if (typeof body.note !== 'string' || body.note.length > MAX_NOTE) return json(400, { error: 'invalid_note' }, NO_STORE)
    args.push(body.note)
    sets.push(`note = ?${args.length}`)
  }
  if (!sets.length) return json(400, { error: 'invalid_body' }, NO_STORE)
  args.push(id)
  const row = await db
    .prepare(`UPDATE feedback SET ${sets.join(', ')} WHERE id = ?${args.length} RETURNING *`)
    .bind(...args)
    .first<FeedbackRow>()
  if (!row) return json(404, { error: 'not_found' }, NO_STORE)
  return json(200, toItem(row), NO_STORE)
}

/** 定时清理: 180 天前的反馈删日志 (文字保留) */
export async function cleanupFeedbackLogs(env: Env, now: number): Promise<void> {
  const old = await env.DB
    .prepare('SELECT id FROM feedback WHERE log_size > 0 AND created_at < ?1 LIMIT 200')
    .bind(now - LOG_RETENTION_MS)
    .all<{ id: string }>()
  if (!old.results.length) return
  await env.DOCS.delete(old.results.map(r => logKey(r.id)))
  await env.DB.batch(old.results.map(r => env.DB.prepare('UPDATE feedback SET log_size = 0 WHERE id = ?1').bind(r.id)))
}
