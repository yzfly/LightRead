/**
 * 划词翻译 (提示词与校验见 translateCore.ts):
 *  - 下载了本机翻译模型 (桌面 / Android, services/localLlm.ts): 在本机翻译, 不联网、不计次数;
 *    本机实测太慢而又有在线通道时改用在线, 本机翻译出错时也回退到在线;
 *  - 在「设置 → AI 助手」配了自己的服务 (非内置试用通道): 直接用自己的 Key, 不限次数;
 *  - 否则走内置通道 /v1/translate: 需要登录轻阅账号, 每个账号每天有免费次数 (服务端计数);
 *  - Android App 另外列出本机能处理文字的应用 (谷歌翻译、有道等), 选中文字直接交给它们, 不需要 Key。
 */
import { accountState, clearLocalLogin, isLoggedIn } from './account'
import { aiConfigured, chatStream, readChatStream, TRIAL_BASE_URL, trialDeviceId } from './ai'
import { fetchRemote } from './net'
import { useSettings } from '../stores/settings'
import { logEvent } from './diagnostics'
import {
  LOCAL_TRANSLATE_MODEL,
  localTranslatePrompt,
  shouldTranslateLocally,
  splitForLocalTranslate,
  translateMaxTokens,
  translateMessages,
  type TranslateRequest,
} from './translateCore'
import { LOCAL_LLM_CRASHED, localGenerate, localModel, refreshLocalLlm } from './localLlm'

export type TranslateRoute = 'local' | 'own' | 'account' | 'login'
type OnlineRoute = Exclude<TranslateRoute, 'local'>

/** 在线翻译走哪条路: 自己的服务 / 账号额度 / 需要先登录 */
function onlineRoute(): OnlineRoute {
  const s = useSettings()
  if (s.aiProvider !== 'trial' && aiConfigured()) return 'own'
  return isLoggedIn() ? 'account' : 'login'
}

/** 这次翻译走哪条路: 本机模型 / 自己的服务 / 账号额度 / 需要先登录 */
export function translateRoute(): TranslateRoute {
  const online = onlineRoute()
  return shouldTranslateLocally(localModel(LOCAL_TRANSLATE_MODEL), useSettings().localTranslate, online !== 'login') ? 'local' : online
}

export type TranslateErrorCode = 'login' | 'quota' | 'budget' | 'rate' | 'failed'

export class TranslateError extends Error {
  readonly code: TranslateErrorCode
  constructor(code: TranslateErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/** 内置通道的错误归类 (readChatStream 抛出的 message 形如 `429 {"error":{"code":"quota"}}`) */
export function classifyTranslateError(message: string): TranslateErrorCode {
  const status = Number(/^(\d{3})\b/.exec(message)?.[1] ?? 0)
  const code = /"code"\s*:\s*"(\w+)"/.exec(message)?.[1] ?? ''
  if (status === 401) return 'login'
  if (code === 'quota' || code === 'budget' || code === 'rate') return code
  if (status === 429) return 'quota'
  return 'failed'
}

export interface TranslateOptions {
  signal?: AbortSignal
  /** 内置通道返回的今日剩余次数 */
  onRemaining?: (n: number) => void
  /** 实际走的路 (本机出错回退到在线时会再报一次) */
  onRoute?: (route: TranslateRoute) => void
}

/** 本机模型逐段翻译: 一个自然段一次请求, 译文按原来的分段接起来 */
async function* translateLocally(req: TranslateRequest, signal?: AbortSignal): AsyncGenerator<string> {
  for (const piece of splitForLocalTranslate(req.text, req.target)) {
    let first = true
    for await (const chunk of localGenerate(LOCAL_TRANSLATE_MODEL, localTranslatePrompt(piece.text, req.target), translateMaxTokens(piece.text), { signal })) {
      // 模型有时以空白开头
      const text = first ? chunk.replace(/^\s+/, '') : chunk
      if (!text) continue
      first = false
      yield text
    }
    if (piece.after) yield piece.after
  }
}

/** 流式翻译, 逐段 yield 译文 */
export async function* translateText(req: TranslateRequest, opts: TranslateOptions = {}): AsyncGenerator<string> {
  let route = translateRoute()
  opts.onRoute?.(route)
  if (route === 'local') {
    let produced = false
    try {
      for await (const chunk of translateLocally(req, opts.signal)) {
        produced = true
        yield chunk
      }
      // 记下这次测得的速度 (下次按它决定用不用本机)
      void refreshLocalLlm()
      return
    } catch (e: any) {
      if (e?.name === 'AbortError' || opts.signal?.aborted) throw e
      const message = String(e?.message ?? e)
      logEvent('warn', 'translate', `local failed crashed=${message.includes(LOCAL_LLM_CRASHED)}`, e)
      void refreshLocalLlm()
      route = onlineRoute()
      // 已经出了一部分译文就不再换通道重来 (界面上会接出两份); 没有在线通道也只能报错
      if (produced || route === 'login') throw new TranslateError('failed', message)
      opts.onRoute?.(route)
    }
  }
  if (route === 'login') throw new TranslateError('login', 'login required')
  if (route === 'own') {
    yield* chatStream(translateMessages(req), opts.signal, { temperature: 0.3, maxTokens: translateMaxTokens(req.text) })
    return
  }
  const token = accountState.token
  let res: Response
  try {
    res = await fetchRemote(`${TRIAL_BASE_URL}/translate`, undefined, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream, application/json',
        authorization: `Bearer ${token}`,
        'x-device-id': trialDeviceId(),
      },
      body: JSON.stringify(req),
      signal: opts.signal,
      raw: true,
    })
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e
    logEvent('warn', 'translate', 'network error', e)
    throw new TranslateError('failed', String(e?.message ?? e))
  }
  const remaining = Number(res.headers.get('x-translate-remaining'))
  if (res.ok && Number.isFinite(remaining)) opts.onRemaining?.(remaining)
  try {
    yield* readChatStream(res)
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e
    const code = classifyTranslateError(String(e?.message ?? ''))
    // 会话已失效: 清掉本地登录, 让用户重新登录
    if (code === 'login') clearLocalLogin(token)
    logEvent('warn', 'translate', `failed status=${res.status} code=${code}`)
    throw new TranslateError(code, String(e?.message ?? e))
  }
}

// ---- Android: 交给本机翻译应用 (src-tauri/android/MainActivity.kt 的 LightReadShare) ----

export interface TextApp {
  label: string
  pkg: string
  cls: string
}

interface TextAppBridge {
  textApps?(): string
  processText?(text: string, pkg: string, cls: string): string
}

function bridge(): TextAppBridge | null {
  return (globalThis as { LightReadShare?: TextAppBridge }).LightReadShare ?? null
}

/** 本机能处理选中文字的应用; 非 Android 或旧版 App 返回空 */
export function listTextApps(): TextApp[] {
  const b = bridge()
  if (!b?.textApps) return []
  try {
    const list = JSON.parse(b.textApps())
    if (!Array.isArray(list)) return []
    return list.filter((a): a is TextApp => !!a && typeof a.label === 'string' && typeof a.pkg === 'string' && typeof a.cls === 'string')
  } catch {
    return []
  }
}

export function openInTextApp(text: string, app: TextApp): boolean {
  return bridge()?.processText?.(text, app.pkg, app.cls) === 'ok'
}
