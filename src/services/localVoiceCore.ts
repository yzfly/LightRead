/**
 * 本机语音 (Qwen3-TTS, 经 llama.cpp; 原生层 src-tauri/src/local_llm) 的纯函数与常量:
 * 朗读语言判定、内置参考音色、「这台机器用不用它」的规则。不依赖 Vue / 浏览器 API。
 */

/** 本机语音用的模型 (src-tauri/src/local_llm/mod.rs 的登记表) */
export const LOCAL_VOICE_MODEL = 'qwen3-tts-1.7b-q4'

/** 内置参考音色 (随应用分发的两段录音, 模型按它们的音色朗读) */
export const QWEN_VOICES = ['female', 'male'] as const
export type QwenVoice = (typeof QWEN_VOICES)[number]

/**
 * 合成速度 ÷ 播放速度 低于它算跟不上: 预取攒不住, 听一会儿就会停下来等。
 * 留 15% 余量给变速 (加快播放时每秒要合成的更多) 和其他程序。
 */
export const LOCAL_VOICE_MIN_SPEED = 1.15

/** Qwen3-TTS 支持的朗读语言里, 能从文字本身分辨出来的几种; 拉丁字母的语言一律按英语读 */
export type SpeechLang = 'zh' | 'en' | 'ja' | 'ko' | 'ru'

/** 一段文字用哪种语言读 (按文字种类占比) */
export function speechLang(text: string): SpeechLang {
  let han = 0, kana = 0, hangul = 0, cyrillic = 0, letters = 0
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue
    letters++
    if (/\p{Script=Han}/u.test(ch)) han++
    else if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch)) kana++
    else if (/\p{Script=Hangul}/u.test(ch)) hangul++
    else if (/\p{Script=Cyrillic}/u.test(ch)) cyrillic++
  }
  if (!letters) return 'zh'
  // 日文夹着大量汉字: 有假名就按日语
  if (kana / letters >= 0.1) return 'ja'
  if (hangul / letters >= 0.3) return 'ko'
  if (han / letters >= 0.3) return 'zh'
  if (cyrillic / letters >= 0.3) return 'ru'
  return 'en'
}

/** 本机模型状态里与朗读有关的几项 (services/localLlm.ts 的 LocalModel) */
export interface LocalVoiceModel {
  installed: boolean
  supported: boolean
  crashed: boolean
  /** 合成速度 ÷ 播放速度, 没测过为 null */
  speed: number | null
}

/** 实测跟不上朗读 */
export function voiceModelTooSlow(model: LocalVoiceModel | undefined): boolean {
  return !!model && model.speed !== null && model.speed < LOCAL_VOICE_MIN_SPEED
}

/** 这台机器能不能用本机语音朗读: 装好、带得动、没因闪退停用, 且实测跟得上 (没测过先用) */
export function voiceModelUsable(model: LocalVoiceModel | undefined): boolean {
  return !!model && model.installed && model.supported && !model.crashed && !voiceModelTooSlow(model)
}
