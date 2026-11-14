/**
 * 本地离线神经语音 (sherpa-onnx + Kokoro v1.1-zh): Android App 里有 (引擎随 APK, 语音包由用户下载),
 * iOS 还没有 (原生层是空壳)。
 */
import { isTauri } from '../../storage/types.ts'
import { isIosApp } from '../../services/iosShell.ts'
import { reactive } from 'vue'
import { useSettings } from '../../stores/settings.ts'
import { toast } from '../../services/toast.ts'
import { t } from '../../i18n/index.ts'

export const localTtsAvailable = () => isTauri() && !isIosApp()

export interface LocalTtsStatus {
  installed: boolean
  path: string
  /** 上次加载 / 合成离线语音时应用意外退出 (闪退), 已暂停使用, 需用户确认再试 */
  crashed?: boolean
}

export interface DownloadProgress {
  downloaded: number
  total: number
  phase: 'connecting' | 'downloading' | 'extracting' | 'done'
}

/** Rust 侧拒绝加载 (上次闪退) 时返回的错误 */
export const LOCAL_TTS_CRASHED = 'LOCAL_TTS_CRASHED'
export const isLocalCrashError = (e: unknown) => String((e as any)?.message ?? e).includes(LOCAL_TTS_CRASHED)

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

export function localTtsStatus(): Promise<LocalTtsStatus> {
  return invoke('local_tts_status')
}

/**
 * 语音包状态, 全局共享: 下载在后台 (Rust) 独立进行, 离开阅读器不会中断;
 * 回到页面时由 refreshLocalPack 接上进度, 重复点击也只会接到同一个下载任务上。
 */
export const localPack = reactive({
  installed: false,
  crashed: false,
  /** 后台正在下载 / 解压 */
  running: false,
  downloaded: 0,
  total: 0,
  phase: 'idle' as DownloadProgress['phase'] | 'idle',
})

let progressListener: Promise<unknown> | null = null
let downloadPromise: Promise<void> | null = null

function listenProgress() {
  progressListener ??= import('@tauri-apps/api/event').then(({ listen }) =>
    listen<DownloadProgress>('local-tts-progress', e => {
      // 后台只有一个下载任务, 进度就是它的 (含续传前已下载的部分)
      const p = e.payload
      localPack.downloaded = p.downloaded
      localPack.total = p.total
      localPack.phase = p.phase
    }),
  )
  return progressListener
}

/** 读取安装状态与后台下载进度; 后台正在下载时接上它 (完成后照常提示) */
export async function refreshLocalPack(): Promise<void> {
  if (!localTtsAvailable()) return
  try {
    const status = await localTtsStatus()
    localPack.installed = status.installed
    localPack.crashed = !!status.crashed
    if (status.installed) return
    const state = await invoke<{ running: boolean; downloaded: number; total: number; phase: string }>('local_tts_download_state')
    localPack.total = state.total
    if (state.running) {
      localPack.running = true
      localPack.downloaded = state.downloaded
      localPack.phase = state.phase as DownloadProgress['phase']
      void startLocalDownload()
    } else if (!downloadPromise) {
      localPack.downloaded = state.downloaded
      localPack.phase = 'idle'
    }
  } catch {
    localPack.installed = false
  }
}

/** 下载语音包 (~350MB), 支持断点续传; 走设置中的网络代理。同一时间只有一个任务 */
export function startLocalDownload(): Promise<void> {
  downloadPromise ??= (async () => {
    await listenProgress()
    localPack.running = true
    if (localPack.phase === 'idle') localPack.phase = 'connecting'
    try {
      const proxy = useSettings().httpProxy.trim()
      await invoke('local_tts_download', { proxy: proxy || null })
      localPack.installed = true
      localPack.phase = 'done'
      toast(t('tts.localReady'), 'success')
    } catch (e: any) {
      toast(t('tts.localDownloadFailed', { msg: e?.message ?? e }), 'error', 8000)
      // 失败后显示保留下来的进度 (可续传)
      try {
        const state = await invoke<{ downloaded: number; total: number }>('local_tts_download_state')
        localPack.downloaded = state.downloaded
        localPack.total = state.total
      } catch { /* 保持原样 */ }
      localPack.phase = 'idle'
    } finally {
      localPack.running = false
      downloadPromise = null
    }
  })()
  return downloadPromise
}

export interface DeviceCheck {
  /** false: 不推荐在本机使用离线语音, 不提供下载 */
  ok: boolean
  /** 不满足的原因 (已是用户可读的中文/英文短句) */
  reasons: string[]
}

/** 下载前评估本机能否跑离线语音 (内存 / CPU 指令集 / 磁盘空间); 评估本身失败时不拦 */
export async function localTtsDeviceCheck(): Promise<DeviceCheck> {
  try {
    const r = await invoke<{ ok: boolean; reasons: string[] }>('local_tts_device_check', { lang: useSettings().language === 'en' ? 'en' : 'zh' })
    return { ok: r.ok, reasons: r.reasons ?? [] }
  } catch {
    return { ok: true, reasons: [] }
  }
}

/** 用户确认「再试一次」: 清除闪退标记, 下次合成重新加载模型 */
export async function localTtsClearCrash(): Promise<void> {
  await invoke('local_tts_clear_crash')
  localPack.crashed = false
}

export function localTtsRemove(): Promise<void> {
  return invoke('local_tts_remove')
}

/**
 * 预加载模型 (首次约 10–20s, 在后台线程执行); 未安装语音包时 reject。
 * 中文与英文音色使用不同的文本规范化规则 (数字 / 日期读法), 按将要使用的音色预热, 免得首句再重载一次。
 */
export function localTtsWarmup(sid = useSettings().localVoiceId): Promise<void> {
  return invoke('local_tts_warmup', { sid })
}

/** Rust 侧返回 tauri::ipc::Response 原始二进制 (ArrayBuffer), 不经 JSON 数组序列化 */
export async function localTtsSynthesize(text: string, sid: number, speed: number): Promise<Blob> {
  const bytes = await invoke<ArrayBuffer>('local_tts_synthesize', { text, sid, speed })
  return new Blob([bytes], { type: 'audio/wav' })
}
