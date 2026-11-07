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
