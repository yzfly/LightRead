/**
 * 本机模型 (llama.cpp, 原生层 src-tauri/src/local_llm): 模型下载 / 状态 / 流式生成。
 * 只在桌面与 Android App 里有; 网页版和 iOS 的 `localLlm.available` 恒为 false。
 * 模型由用户自己下载 (GB 级, 不随安装包), 下载在原生层后台进行, 离开页面不中断。
 */
import { reactive } from 'vue'
import { isTauri } from '../storage/types'
import { useSettings } from '../stores/settings'
import { logEvent } from './diagnostics'

export interface LocalModel {
  id: string
  kind: 'translate' | 'tts'
  size: number
  installed: boolean
  /** 已下载的字节 (含可续传的半截文件) */
  downloaded: number
  running: boolean
  /** 这台设备能否使用; 不能时 reasons 是给用户看的原因 */
  supported: boolean
  reasons: string[]
  /** 上次使用时应用意外退出, 已停用, 需用户确认再试 */
  crashed: boolean
  /** 实测生成速度 (token/秒), 没用过为 null */
  tokensPerSecond: number | null
  gpu: boolean | null
}

export const localLlm = reactive({
  /** 这个版本带不带本机模型引擎 */
  available: false,
  /** 已经向原生层问过一次状态 */
  loaded: false,
  models: [] as LocalModel[],
  /** 正在下载的阶段 (connecting / downloading / done) */
  phase: 'idle' as 'idle' | 'connecting' | 'downloading' | 'done',
})

/** Rust 侧拒绝加载 (上次闪退) 时返回的错误 */
export const LOCAL_LLM_CRASHED = 'LOCAL_LLM_CRASHED'
/** 原文装不进模型的上下文 */
export const LOCAL_LLM_TOO_LONG = 'LOCAL_LLM_TOO_LONG'

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

export function localModel(id: string): LocalModel | undefined {
  return localLlm.models.find(m => m.id === id)
}

let refreshing: Promise<void> | null = null

/** 读取各模型的安装 / 下载 / 设备评估状态; 后台正在下载时接上它的进度 */
export function refreshLocalLlm(): Promise<void> {
  if (!isTauri()) {
    localLlm.loaded = true
    return Promise.resolve()
  }
  refreshing ??= (async () => {
    try {
      const status = await invoke<{ available: boolean; models: LocalModel[] }>('local_llm_status', {
        lang: useSettings().language === 'en' ? 'en' : 'zh',
      })
      localLlm.available = status.available
      localLlm.models = status.models
      const running = status.models.find(m => m.running)
      if (running && !downloads.has(running.id)) void downloadLocalModel(running.id)
    } catch (e) {
      // 旧版原生层没有这些命令: 当作不支持
      localLlm.available = false
      localLlm.models = []
      logEvent('warn', 'local-llm', 'status failed', e)
    } finally {
      localLlm.loaded = true
      refreshing = null
    }
  })()
  return refreshing
}

let progressListener: Promise<unknown> | null = null
const downloads = new Map<string, Promise<void>>()

function listenProgress() {
  progressListener ??= import('@tauri-apps/api/event').then(({ listen }) =>
    listen<{ model: string; downloaded: number; total: number; phase: string }>('local-llm-progress', e => {
      const m = localModel(e.payload.model)
      if (!m) return
      m.downloaded = e.payload.downloaded
      localLlm.phase = e.payload.phase as typeof localLlm.phase
    }),
  )
  return progressListener
}

/**
 * 下载模型 (断点续传, 走设置里的代理; 中文界面先国内来源)。同一个模型只有一个任务, 重复调用接到它上面。
 * 失败时 reject, 已下载的部分保留。
 */
export function downloadLocalModel(id: string): Promise<void> {
  let job = downloads.get(id)
  if (job) return job
  job = (async () => {
    await listenProgress()
    const m = localModel(id)
    if (m) m.running = true
    localLlm.phase = 'connecting'
    try {
      const s = useSettings()
      await invoke('local_llm_download', { model: id, proxy: s.httpProxy.trim() || null, preferCn: s.language !== 'en' })
    } catch (e) {
      logEvent('warn', 'local-llm', `download failed model=${id}`, e)
      throw e
    } finally {
      downloads.delete(id)
      localLlm.phase = 'idle'
      await refreshLocalLlm()
    }
  })()
  downloads.set(id, job)
  return job
}

export async function removeLocalModel(id: string): Promise<void> {
  await invoke('local_llm_remove', { model: id })
  await refreshLocalLlm()
}

/** 用户确认「再试一次」: 清除闪退标记 */
export async function clearLocalLlmCrash(id: string): Promise<void> {
  await invoke('local_llm_clear_crash', { model: id })
  await refreshLocalLlm()
}

export interface LocalGenStats {
  tokens: number
  promptTokens: number
  loadMs: number
  promptMs: number
  genMs: number
  gpu: boolean
  cancelled: boolean
}

type GenEvent = { type: 'piece'; text: string } | ({ type: 'done' } & LocalGenStats)

/** 请求编号: 单调递增 (取消按「不大于某编号」生效), 页面重载后也不能回退, 所以带上时间 */
let lastRequestId = 0
function nextRequestId(): number {
  lastRequestId = Math.max(lastRequestId + 1, Date.now() * 100)
  return lastRequestId
}

/**
 * 用本机模型生成一段回复, 逐段 yield。`prompt` 是完整的用户消息。
 * signal 中止时通知原生层停下 (不再吐字), 生成器以 AbortError 结束。
 */
export async function* localGenerate(
  model: string,
  prompt: string,
  maxTokens: number,
  opts: { signal?: AbortSignal; onStats?: (s: LocalGenStats) => void } = {},
): AsyncGenerator<string> {
  const { invoke, Channel } = await import('@tauri-apps/api/core')
  const requestId = nextRequestId()
  const queue: string[] = []
  let wake: (() => void) | null = null
  let finished = false
  let failure: unknown = null
  const channel = new Channel<GenEvent>()
  channel.onmessage = event => {
    if (event.type === 'piece') queue.push(event.text)
    else {
      opts.onStats?.(event)
      finished = true
    }
    wake?.()
  }
  const cancel = () => void invoke('local_llm_cancel', { requestId }).catch(() => {})
  opts.signal?.addEventListener('abort', cancel)
  // 命令返回只说明原生层结束了; 正常结束以通道里的 done 为准 (它排在所有文本之后), 出错则没有 done
  invoke('local_llm_generate', { model, prompt, maxTokens, requestId, onEvent: channel }).catch(e => {
    failure = e ?? new Error('local model failed')
    finished = true
    wake?.()
  })
  try {
    for (;;) {
      if (queue.length) {
        yield queue.shift()!
        continue
      }
      if (finished) break
      await new Promise<void>(resolve => { wake = resolve })
      wake = null
    }
    if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    if (failure) throw failure instanceof Error ? failure : new Error(String(failure))
  } finally {
    opts.signal?.removeEventListener('abort', cancel)
    // 调用方提前退出循环 (不再要后面的文字) 时也让原生层停下
    if (!finished) cancel()
  }
}

/** 应用退到后台等时机: 立刻释放内存里的模型 */
export function unloadLocalLlm(): void {
  if (localLlm.available) void invoke('local_llm_unload').catch(() => {})
}
