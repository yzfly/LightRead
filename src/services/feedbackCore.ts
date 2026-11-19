/**
 * 读者反馈的纯函数 (无 DOM / 网络, 供 node --test): 校验、拼请求体、把服务端错误翻成界面文案键。
 * 接口: POST <账号服务>/v1/feedback, 见 docs/account-api.md「读者反馈」与 sync-server/src/feedback.ts
 */
export const FEEDBACK_KINDS = ['bug', 'feature', 'other'] as const
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number]

/** 与服务端一致 */
export const FEEDBACK_MAX_TEXT = 4000
export const FEEDBACK_MAX_CONTACT = 200
/** 诊断包超过这个大小就只带当前日志 (服务端上限 2.5 MB) */
export const FEEDBACK_MAX_LOG = 2.4 * 1024 * 1024

export interface FeedbackDraft {
  kind: FeedbackKind
  text: string
  contact: string
  includeLogs: boolean
}

export interface FeedbackPayload {
  kind: FeedbackKind
  text: string
  contact: string
  version: string
  platform: string
  log?: string
}

/** 能不能提交: 返回 null 表示可以, 否则是文案键 */
export function feedbackProblem(draft: Pick<FeedbackDraft, 'text' | 'contact'>): string | null {
  const text = draft.text.trim()
  if (!text) return 'feedback.errEmpty'
  if (text.length > FEEDBACK_MAX_TEXT) return 'feedback.errTooLong'
  if (draft.contact.trim().length > FEEDBACK_MAX_CONTACT) return 'feedback.errContact'
  return null
}

export function feedbackPayload(
  draft: FeedbackDraft,
  env: { version: string; platform: string },
  logBase64?: string,
): FeedbackPayload {
  const out: FeedbackPayload = {
    kind: draft.kind,
    text: draft.text.trim(),
    contact: draft.contact.trim(),
    version: env.version,
    platform: env.platform,
  }
  if (draft.includeLogs && logBase64) out.log = logBase64
  return out
}

/** HTTP 状态 / 网络错误 → 文案键 (status 0 表示没连上) */
export function feedbackErrorKey(status: number): string {
  if (status === 0) return 'feedback.errOffline'
  if (status === 429) return 'feedback.errRateLimited'
  if (status === 413) return 'feedback.errLogTooLarge'
  if (status === 400) return 'feedback.errInvalid'
  return 'feedback.errServer'
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(s)
}
