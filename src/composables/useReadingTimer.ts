import { onBeforeUnmount, onMounted } from 'vue'
import { useLibrary } from '../stores/library'

/** 阅读时长统计: 页面可见时每 15s 累计一次, 每分钟落库, 离开时冲账 */
export function useReadingTimer(bookId: string) {
  const library = useLibrary()
  let acc = 0
  let timer: ReturnType<typeof setInterval> | undefined

  const flush = () => {
    if (acc > 0) {
      library.addReadingTime(bookId, acc)
      acc = 0
    }
  }

  onMounted(() => {
    timer = setInterval(() => {
      if (!document.hidden) acc += 15
      if (acc >= 60) flush()
    }, 15_000)
  })

  onBeforeUnmount(() => {
    clearInterval(timer)
    flush()
  })
}

/** 秒 → "X 小时 Y 分钟" */
export function formatReadingTime(seconds: number): string {
  const mins = Math.round(seconds / 60)
  if (mins < 1) return '不足 1 分钟'
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h > 0 ? `${h} 小时 ${m} 分钟` : `${m} 分钟`
}
