export const BABELDOC_TARGET_LANGUAGES = [
  { code: 'zh', englishName: 'Simplified Chinese', labelKey: 'paper.bdLanguageZh' },
  { code: 'zh-TW', englishName: 'Traditional Chinese', labelKey: 'paper.bdLanguageZhTw' },
  { code: 'ja', englishName: 'Japanese', labelKey: 'paper.bdLanguageJa' },
  { code: 'ko', englishName: 'Korean', labelKey: 'paper.bdLanguageKo' },
  { code: 'fr', englishName: 'French', labelKey: 'paper.bdLanguageFr' },
  { code: 'de', englishName: 'German', labelKey: 'paper.bdLanguageDe' },
  { code: 'es', englishName: 'Spanish', labelKey: 'paper.bdLanguageEs' },
  { code: 'pt', englishName: 'Portuguese', labelKey: 'paper.bdLanguagePt' },
  { code: 'it', englishName: 'Italian', labelKey: 'paper.bdLanguageIt' },
  { code: 'ru', englishName: 'Russian', labelKey: 'paper.bdLanguageRu' },
] as const

export type BabeldocTargetLanguageCode = typeof BABELDOC_TARGET_LANGUAGES[number]['code']
export type BabeldocTargetLanguage = typeof BABELDOC_TARGET_LANGUAGES[number]

export const DEFAULT_BABELDOC_TARGET_LANGUAGE = BABELDOC_TARGET_LANGUAGES[0]
const TARGET_LANGUAGE_STORAGE_KEY = 'lightread-babeldoc-target-language'

export function resolveBabeldocTargetLanguage(value: unknown): BabeldocTargetLanguage {
  return BABELDOC_TARGET_LANGUAGES.find(language => language.code === value)
    ?? DEFAULT_BABELDOC_TARGET_LANGUAGE
}

export function loadBabeldocTargetLanguage(): BabeldocTargetLanguageCode {
  try {
    return resolveBabeldocTargetLanguage(localStorage.getItem(TARGET_LANGUAGE_STORAGE_KEY)).code
  } catch {
    return DEFAULT_BABELDOC_TARGET_LANGUAGE.code
  }
}

export function saveBabeldocTargetLanguage(value: unknown): BabeldocTargetLanguageCode {
  const code = resolveBabeldocTargetLanguage(value).code
  try {
    localStorage.setItem(TARGET_LANGUAGE_STORAGE_KEY, code)
  } catch { /* 仅保存偏好，失败不影响本次任务 */ }
  return code
}
