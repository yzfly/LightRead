/**
 * 后台听书 (安卓): 把听书状态告诉原生层的前台服务 (src-tauri/android/MainActivity.kt 的 LightReadListen)。
 *
 * 没有前台服务时, 熄屏或切到后台几分钟后系统会冻结应用, 听书中断 (红米 / 小米最明显)。
 * 页面隐藏后 WebView 还会把 JS 定时器压到很低的频率, 原生层每 500ms 调一次 __lightreadListenPump,
 * 播放器靠它继续排下一段音频 (services/audioQueue.ts 的 pumpListenTimers)。
 * 旧版原生壳、iOS、网页都没有这个桥: 全部空操作。
 */
import { pumpListenTimers } from '../../services/audioQueue.ts'

export type ListenKeepAliveState = 'playing' | 'paused' | 'stopped'

interface ListenBridge {
  setState(state: string, title: string, text: string): void
}

type Host = { LightReadListen?: ListenBridge; __lightreadListenPump?: () => void }

let last = ''

/** 状态、书名或章节变了才通知原生层; 桥不存在或调用失败都不影响听书 */
export function reportListenState(state: ListenKeepAliveState, title = '', text = ''): void {
  const host = globalThis as unknown as Host
  const bridge = host.LightReadListen
  if (!bridge) return
  const key = state === 'stopped' ? state : `${state}\n${title}\n${text}`
  if (key === last) return
  last = key
  host.__lightreadListenPump = pumpListenTimers
  try { bridge.setState(state, title, text) } catch { /* 旧版原生壳 */ }
}

/** 只给测试用 */
export function resetListenKeepAliveForTest(): void { last = '' }
