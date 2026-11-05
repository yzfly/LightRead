/**
 * Windows SAPI 5 语音: 用本机已注册的语音合成 (sapi_tts.rs), 只有 Windows 桌面版有.
 * 系统自带语音、第三方语音和 NaturalVoiceSAPIAdapter 注册的自然语音都在这里出现.
 */
export interface SapiVoice {
  id: string
  name: string
  language: string
}

export const sapiPlatform = () => typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)

export async function sapiListVoices(): Promise<SapiVoice[]> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<SapiVoice[]>('sapi_tts_voices')
}

export async function sapiSynthesize(text: string, voice: string, rate: number): Promise<Blob> {
  const { invoke } = await import('@tauri-apps/api/core')
  const bytes = await invoke<ArrayBuffer>('sapi_tts_synthesize', { text, voice, rate })
  return new Blob([bytes], { type: 'audio/wav' })
}
