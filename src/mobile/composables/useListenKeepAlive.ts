/**
 * 安卓后台听书: 阅读页听书期间由原生前台服务保住进程 (services/listenKeepAlive.ts)。
 * 状态 / 书名 / 章节变化时上报, 离开页面时上报停止。新增会在后台出声的页面调用这一个即可。
 */
import { onBeforeUnmount, watch, type Ref } from 'vue'
import { reportListenState, type ListenKeepAliveState } from '../services/listenKeepAlive.ts'

export function useListenKeepAlive(state: Ref<ListenKeepAliveState>, title: () => string, text: () => string = () => ''): void {
  watch(() => [state.value, title(), text()] as const, ([s, a, b]) => reportListenState(s, a, b), { immediate: true })
  onBeforeUnmount(() => reportListenState('stopped'))
}
