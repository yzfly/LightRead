/**
 * 划词翻译的纯函数: 目标语言判定、提示词、请求校验。
 * 客户端 (自己的 API Key 直连) 与内置通道中转 relay/src/index.js (/v1/translate) 共用这一份,
 * 内置通道只接受这里的固定 schema, 提示词在服务端拼, 不能被当成通用代理。
 * 不依赖 Vue / 浏览器 API (relay 由 wrangler 直接打包)。
 */

/** 一次最多翻译的字数: 够一大段, 防止整章塞进来 */
export const TRANSLATE_MAX_CHARS = 4000
/** 登录账号每天经内置通道的免费翻译次数 (服务端可用 ACCOUNT_TRANSLATE_DAILY 覆盖) */
export const ACCOUNT_TRANSLATE_DAILY = 100

export const TRANSLATE_TARGETS = ['auto', 'zh-Hans', 'zh-Hant', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru'] as const
export type TranslateTarget = (typeof TRANSLATE_TARGETS)[number]
export type TranslateLang = Exclude<TranslateTarget, 'auto'>

const LANG_NAMES: Record<TranslateLang, string> = {
  'zh-Hans': '简体中文',
  'zh-Hant': '繁體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  ru: 'Русский',
}

export function langName(lang: TranslateLang): string {
  return LANG_NAMES[lang]
}

/** 文字是否以中文为主 (汉字占字母类字符的 30% 以上; 日文假名不算) */
export function mostlyChinese(text: string): boolean {
  let han = 0
  let letters = 0
  for (const ch of text) {
    if (/\p{Script=Han}/u.test(ch)) han++
    if (/\p{L}/u.test(ch)) letters++
  }
  const kana = (text.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) ?? []).length
  return letters > 0 && kana === 0 && han / letters >= 0.3
}

/**
 * 实际目标语言: 自动时中文译成英文, 其他语言译成界面语言 (中文界面为简体中文);
 * 目标是简体中文而原文就是中文时改译英文, 免得原样返回。
 */
export function resolveTarget(text: string, target: TranslateTarget, uiLang: 'zh' | 'en'): TranslateLang {
  const zh = mostlyChinese(text)
  if (target === 'auto') return zh ? 'en' : uiLang === 'en' ? 'en' : 'zh-Hans'
  // 中文译成简体中文没有意义 (繁简互转可用正文的「简繁转换」, 繁体目标保留)
  if (zh && target === 'zh-Hans') return 'en'
  return target
}

export interface TranslateRequest {
  text: string
  target: TranslateLang
  /** 书名, 帮助模型判断专名与语境 (可选) */
  book?: string
}

export function validateTranslate(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return 'invalid body'
  const r = raw as Record<string, unknown>
  if (typeof r.text !== 'string' || !r.text.trim()) return 'empty text'
  if (r.text.length > TRANSLATE_MAX_CHARS) return `text too long (max ${TRANSLATE_MAX_CHARS})`
  if (typeof r.target !== 'string' || !(r.target in LANG_NAMES)) return 'invalid target'
  if (r.book !== undefined && typeof r.book !== 'string') return 'invalid book'
  return null
}

export function sanitizeTranslate(raw: TranslateRequest): TranslateRequest {
  return {
    text: raw.text.trim().slice(0, TRANSLATE_MAX_CHARS),
    target: raw.target,
    ...(raw.book ? { book: raw.book.trim().slice(0, 120) } : {}),
  }
}

/** 输出 token 上限: 译文长度与原文相近, 留一倍余量 */
export function translateMaxTokens(text: string): number {
  return Math.min(4096, Math.max(256, Math.ceil(text.length * 2)))
}

export function translateMessages(req: TranslateRequest): { role: 'system' | 'user'; content: string }[] {
  const lang = langName(req.target)
  const system = [
    `You are a professional literary translator. Translate the user's text into ${lang} (${req.target}).`,
    'Output only the translation: no explanations, no notes, no quotation marks around it, no romanization.',
    'Keep paragraph breaks, numbers, names and punctuation style natural for the target language.',
    req.target === 'zh-Hant' ? 'Use Traditional Chinese characters (Taiwan usage).' : '',
    req.target === 'zh-Hans' ? 'Use Simplified Chinese characters.' : '',
    req.book ? `The text comes from the book "${req.book}"; keep its terminology consistent.` : '',
  ].filter(Boolean).join('\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: req.text },
  ]
}

// ---- 本机翻译模型 (混元 Hy-MT2, 经 llama.cpp; services/localLlm.ts) ----

/** 本机翻译用的模型 (src-tauri/src/local_llm/mod.rs 的登记表) */
export const LOCAL_TRANSLATE_MODEL = 'hy-mt2-1.8b-q4'
/** 低于这个速度 (token/秒) 算慢: 一段话要等十几秒, 有在线通道时改用在线 */
export const LOCAL_TRANSLATE_SLOW_TPS = 6
/** 一次送给本机模型的原文上限: 小模型逐段翻更稳, 也保证装得进 4096 的上下文 */
export const LOCAL_TRANSLATE_PIECE_CHARS = 600

/** 本机模型的状态里与路由有关的几项 (services/localLlm.ts 的 LocalModel) */
export interface LocalTranslateModel {
  installed: boolean
  supported: boolean
  crashed: boolean
  tokensPerSecond: number | null
}

/**
 * 这次用不用本机模型: 装好、设备带得动、没因闪退停用、设置里开着才用;
 * 实测太慢时, 有在线通道就让给在线, 没有 (未登录也没填 Key) 仍用本机 —— 慢也比不能翻好。
 */
export function shouldTranslateLocally(model: LocalTranslateModel | undefined, enabled: boolean, onlineAvailable: boolean): boolean {
  if (!model || !enabled || !model.installed || model.crashed || !model.supported) return false
  const slow = model.tokensPerSecond !== null && model.tokensPerSecond < LOCAL_TRANSLATE_SLOW_TPS
  return !(slow && onlineAvailable)
}

const LOCAL_LANG_ZH: Record<TranslateLang, string> = {
  'zh-Hans': '中文',
  'zh-Hant': '繁体中文',
  en: '英语',
  ja: '日语',
  ko: '韩语',
  fr: '法语',
  de: '德语',
  es: '西班牙语',
  ru: '俄语',
}

const LOCAL_LANG_EN: Record<TranslateLang, string> = {
  'zh-Hans': 'Chinese',
  'zh-Hant': 'Traditional Chinese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  ru: 'Russian',
}

/**
 * 混元翻译模型的提示词 (模型卡片规定的两种写法, 不带系统提示):
 * 原文或译文有一方是中文时用中文提示, 其他语言之间用英文提示。
 */
export function localTranslatePrompt(text: string, target: TranslateLang): string {
  const zhSide = target === 'zh-Hans' || target === 'zh-Hant' || mostlyChinese(text)
  return zhSide
    ? `把下面的文本翻译成${LOCAL_LANG_ZH[target]}，不要额外解释。\n\n${text}`
    : `Translate the following segment into ${LOCAL_LANG_EN[target]}, without additional explanation.\n\n${text}`
}

export interface TranslatePiece {
  text: string
  /** 这一段译完后接在译文后面的分隔 (段落之间换行; 同一段拆开的句子之间按译文语言决定是否空格) */
  after: string
}

/**
 * 把原文拆成逐段翻译的小块: 一个自然段一块; 超过 max 的段落在句末再拆。
 * 空行保留为段落间的换行数。
 */
export function splitForLocalTranslate(text: string, target: TranslateLang, max = LOCAL_TRANSLATE_PIECE_CHARS): TranslatePiece[] {
  const joiner = target === 'zh-Hans' || target === 'zh-Hant' || target === 'ja' ? '' : ' '
  const out: TranslatePiece[] = []
  const paragraphs = text.split(/(\n+)/)
  for (let i = 0; i < paragraphs.length; i += 2) {
    const para = paragraphs[i].trim()
    const breaks = paragraphs[i + 1] ?? ''
    if (!para) {
      if (out.length && breaks) out[out.length - 1].after += breaks
      continue
    }
    const parts = para.length <= max ? [para] : splitSentences(para, max)
    parts.forEach((part, k) => out.push({ text: part, after: k === parts.length - 1 ? breaks : joiner }))
  }
  if (out.length) out[out.length - 1].after = ''
  return out
}

/** 在句末标点处把长段落切成不超过 max 的几块; 没有句末标点的超长文字按 max 硬切 */
function splitSentences(para: string, max: number): string[] {
  // 句末: 中文句读, 或后面跟着空白的西文句点 (3.14、e.g.x 里的点不算); 紧随的引号括号归上一句
  const sentences: string[] = []
  let start = 0
  for (let i = 0; i < para.length; i++) {
    const ch = para[i]
    const end = '。！？!?；;'.includes(ch) || (ch === '.' && (i + 1 === para.length || /\s/.test(para[i + 1])))
    if (!end) continue
    let j = i + 1
    while (j < para.length && '"\'”’）)]。！？!?'.includes(para[j])) j++
    while (j < para.length && /\s/.test(para[j])) j++
    sentences.push(para.slice(start, j))
    start = j
    i = j - 1
  }
  if (start < para.length) sentences.push(para.slice(start))
  const out: string[] = []
  let cur = ''
  const push = () => {
    if (cur.trim()) out.push(cur.trim())
    cur = ''
  }
  for (const s of sentences) {
    if (cur.length + s.length > max) push()
    if (s.length > max) {
      for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max).trim())
      continue
    }
    cur += s
  }
  push()
  return out.filter(Boolean)
}
