/**
 * API 语音 (用户自带 Key): MiniMax、火山豆包等云端大模型语音.
 * 请求在 Rust 侧发出 (cloud_tts.rs): 豆包不放行浏览器跨域的鉴权头, 网页版没有原生层所以不提供.
 * 这里只放音色目录、设置 → 请求的映射和错误分类, 都是纯函数, 契约见 scripts/test-cloud-tts.mjs.
 */

export type CloudProvider = 'minimax' | 'doubao'

export interface CloudVoice {
  id: string
  label: string
  gender: 'female' | 'male'
}

/** 目录只收适合长篇朗读的音色; 其余音色和复刻音色用「自定义音色 ID」填写 */
/** platform.minimax.cn/docs/faq/system-voice-id (2026-11-04 核对) */
export const MINIMAX_VOICES: CloudVoice[] = [
  { id: 'female-chengshu', label: '成熟女性', gender: 'female' },
  { id: 'Chinese (Mandarin)_Gentle_Senior', label: '温柔学姐', gender: 'female' },
  { id: 'Chinese (Mandarin)_Wise_Women', label: '阅历姐姐', gender: 'female' },
  { id: 'Chinese (Mandarin)_News_Anchor', label: '新闻女声', gender: 'female' },
  { id: 'Chinese (Mandarin)_Warm_Girl', label: '温暖少女', gender: 'female' },
  { id: 'Chinese (Mandarin)_Sweet_Lady', label: '甜美女声', gender: 'female' },
  { id: 'Chinese (Mandarin)_Gentleman', label: '温润男声', gender: 'male' },
  { id: 'Chinese (Mandarin)_Radio_Host', label: '电台男主播', gender: 'male' },
  { id: 'Chinese (Mandarin)_Male_Announcer', label: '播报男声', gender: 'male' },
  { id: 'Chinese (Mandarin)_Lyrical_Voice', label: '抒情男声', gender: 'male' },
  { id: 'Chinese (Mandarin)_Gentle_Youth', label: '温润青年', gender: 'male' },
  { id: 'Chinese (Mandarin)_Reliable_Executive', label: '沉稳高管', gender: 'male' },
]

/** docs.volcengine.com/docs/6561/1257544 (2026-11-04 核对); 湾湾小何来自 docs/tts-online-voices.md */
export const DOUBAO_VOICES: CloudVoice[] = [
  { id: 'zh_female_wenroushunv_uranus_bigtts', label: '温柔淑女 2.0', gender: 'female' },
  { id: 'zh_female_zhixingnv_uranus_bigtts', label: '知性女声 2.0', gender: 'female' },
  { id: 'zh_female_liuchangnv_uranus_bigtts', label: '流畅女声 2.0', gender: 'female' },
  { id: 'zh_female_wenrouxiaoya_uranus_bigtts', label: '温柔小雅 2.0', gender: 'female' },
  { id: 'zh_female_xiaohe_uranus_bigtts', label: '小何 2.0', gender: 'female' },
  { id: 'zh_female_vv_uranus_bigtts', label: 'Vivi 2.0', gender: 'female' },
  { id: 'zh_female_shaoergushi_uranus_bigtts', label: '少儿故事 2.0', gender: 'female' },
  { id: 'zh_female_wanwanxiaohe_moon_bigtts', label: '湾湾小何 · 台湾腔 1.0', gender: 'female' },
  { id: 'zh_male_ruyaqingnian_uranus_bigtts', label: '儒雅青年 2.0', gender: 'male' },
  { id: 'zh_male_ruyayichen_uranus_bigtts', label: '儒雅逸辰 2.0', gender: 'male' },
  { id: 'zh_male_yuanboxiaoshu_uranus_bigtts', label: '渊博小叔 2.0', gender: 'male' },
  { id: 'zh_male_shenyeboke_uranus_bigtts', label: '深夜播客 2.0', gender: 'male' },
  { id: 'zh_male_cixingjieshuonan_uranus_bigtts', label: '磁性解说 2.0', gender: 'male' },
  { id: 'zh_male_xuanyijieshuo_uranus_bigtts', label: '悬疑解说 2.0', gender: 'male' },
]

export const MINIMAX_MODELS = ['speech-2.8-turbo', 'speech-2.8-hd', 'speech-2.6-turbo', 'speech-2.6-hd'] as const
export const DEFAULT_MINIMAX_VOICE = 'female-chengshu'
export const DEFAULT_DOUBAO_VOICE = 'zh_female_wenroushunv_uranus_bigtts'
export const DEFAULT_MINIMAX_MODEL = 'speech-2.8-turbo'

export const voicesOf = (provider: CloudProvider): CloudVoice[] =>
  provider === 'doubao' ? DOUBAO_VOICES : MINIMAX_VOICES

/** 服务商接受的最高语速; 超过的按此合成 */
export const CLOUD_RATE_MAX = 2

/** 听书设置里与 API 语音有关的字段 */
export interface CloudTtsSettings {
  cloudTtsProvider: CloudProvider
  minimaxRegion: 'cn' | 'global'
  minimaxModel: string
  minimaxVoice: string
  minimaxApiKey: string
  doubaoVoice: string
  doubaoApiKey: string
  doubaoAppId: string
  httpProxy?: string
}

/** 传给 cloud_tts_synthesize 的请求, 字段与 Rust 的 CloudTtsRequest 一一对应 */
export interface CloudTtsRequest {
  provider: CloudProvider
  apiKey: string
  voice: string
  text: string
  rate: number
  model?: string
  region?: 'cn' | 'global'
  appId?: string
  resourceId?: string
  proxy?: string
}

/**
 * 豆包的 X-Api-Resource-Id 决定模型与计费项, 必须和音色一致:
 * uranus 是 2.0 音色, S_ 开头是复刻音色, 其余 (moon / mars) 是 1.0 音色.
 */
export function doubaoResourceId(voice: string): string {
  if (voice.startsWith('S_')) return 'seed-icl-2.0'
  return voice.includes('uranus') ? 'seed-tts-2.0' : 'seed-tts-1.0'
}

export type CloudErrorCode =
  | 'missing_key' | 'auth' | 'quota' | 'rate' | 'voice' | 'text' | 'network' | 'server' | 'bad_response'

const CODES: readonly string[] = ['missing_key', 'auth', 'quota', 'rate', 'voice', 'text', 'network', 'server', 'bad_response']

export class CloudTtsError extends Error {
  readonly code: CloudErrorCode
  constructor(code: CloudErrorCode, detail = '') {
    super(`cloud_tts:${code}:${detail}`)
    this.code = code
  }
}

/** 从 Rust 返回的 `cloud_tts:<code>:<detail>` 取错误类别; 其他错误返回 null */
export function cloudErrorCode(error: unknown): CloudErrorCode | null {
  const message = String((error as { message?: unknown })?.message ?? error)
  const m = /^cloud_tts:([a-z_]+):/.exec(message)
  return m && CODES.includes(m[1]) ? (m[1] as CloudErrorCode) : null
}

/** 网络抖动、限流、服务端错误值得重试一次; Key、余额、音色的问题重试只会再失败 */
export function isTransientCloudError(error: unknown): boolean {
  const code = cloudErrorCode(error)
  return code === 'network' || code === 'server' || code === 'rate'
}

export function buildCloudRequest(s: CloudTtsSettings, text: string, rate: number): CloudTtsRequest {
  const proxy = s.httpProxy?.trim() || undefined
  const clamped = Math.min(CLOUD_RATE_MAX, Math.max(0.5, rate))
  if (s.cloudTtsProvider === 'doubao') {
    const apiKey = s.doubaoApiKey.trim()
    if (!apiKey) throw new CloudTtsError('missing_key')
    const voice = s.doubaoVoice.trim() || DEFAULT_DOUBAO_VOICE
    return {
      provider: 'doubao', apiKey, voice, text, rate: clamped, proxy,
      resourceId: doubaoResourceId(voice),
      appId: s.doubaoAppId.trim() || undefined,
    }
  }
  const apiKey = s.minimaxApiKey.trim()
  if (!apiKey) throw new CloudTtsError('missing_key')
  return {
    provider: 'minimax', apiKey, text, rate: clamped, proxy,
    voice: s.minimaxVoice.trim() || DEFAULT_MINIMAX_VOICE,
    model: s.minimaxModel || DEFAULT_MINIMAX_MODEL,
    region: s.minimaxRegion,
  }
}

/** 影响合成结果的配置 (不含 Key): 用作缓存键, 变化时重读当前句 */
export function cloudSignature(s: CloudTtsSettings): string {
  return s.cloudTtsProvider === 'doubao'
    ? `doubao|${s.doubaoVoice}`
    : `minimax|${s.minimaxRegion}|${s.minimaxModel}|${s.minimaxVoice}`
}

export async function cloudSynthesize(s: CloudTtsSettings, text: string, rate: number): Promise<Blob> {
  const request = buildCloudRequest(s, text, rate)
  const { invoke } = await import('@tauri-apps/api/core')
  const bytes = await invoke<ArrayBuffer>('cloud_tts_synthesize', { request })
  return new Blob([bytes], { type: 'audio/mpeg' })
}
