/**
 * 应用内反馈: 文字 + 可选联系方式, 用户勾选时附上诊断包 (与「导出诊断日志」同一份, 已脱敏)。
 * 发到轻阅账号服务 POST /v1/feedback; 登录时带上 token, 维护者能看到账号邮箱。
 * 维护者每三天看一次 (scripts/feedback-digest.mjs), 确认后再动手。
 */
import { t } from '../i18n'
import { accountApiBase, accountState, isLoggedIn } from './account'
import { buildDiagnosticsBundle, diagnosticsEnv, logEvent } from './diagnostics'
import {
  FEEDBACK_MAX_LOG, bytesToBase64, feedbackErrorKey, feedbackPayload, feedbackProblem, type FeedbackDraft,
} from './feedbackCore'

export class FeedbackError extends Error {}

/** 打诊断包; 太大就只带当前日志; 失败返回 undefined (文字照样提交) */
async function logAttachment(): Promise<string | undefined> {
  try {
    let { blob } = await buildDiagnosticsBundle()
    if (blob.size > FEEDBACK_MAX_LOG) ({ blob } = await buildDiagnosticsBundle({ latestOnly: true }))
    if (blob.size > FEEDBACK_MAX_LOG) return undefined
    return bytesToBase64(new Uint8Array(await blob.arrayBuffer()))
  } catch (e) {
    logEvent('warn', 'feedback', 'build log bundle failed', e)
    return undefined
  }
}

/** 默认联系方式: 已登录就用账号邮箱 */
export function defaultFeedbackContact(): string {
  return isLoggedIn() ? accountState.account?.email ?? '' : ''
}

export async function sendFeedback(draft: FeedbackDraft): Promise<void> {
  const problem = feedbackProblem(draft)
  if (problem) throw new FeedbackError(t(problem))
  const env = await diagnosticsEnv()
  const log = draft.includeLogs ? await logAttachment() : undefined
  const body = JSON.stringify(feedbackPayload(draft, { version: env.version, platform: env.platform }, log))
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (isLoggedIn()) headers.authorization = `Bearer ${accountState.token}`
  let res: Response
  try {
    res = await fetch(`${accountApiBase()}/v1/feedback`, { method: 'POST', headers, body })
  } catch (e) {
    logEvent('warn', 'feedback', 'send failed', e)
    throw new FeedbackError(t(feedbackErrorKey(0)))
  }
  if (!res.ok) {
    logEvent('warn', 'feedback', 'send rejected', res.status)
    throw new FeedbackError(t(feedbackErrorKey(res.status)))
  }
  logEvent('info', 'feedback', 'sent', draft.kind, log ? `log ${log.length}` : 'no log')
}
