/**
 * 轻点正文的分区: 横屏 / 桌面按左·中·右三等分 (左上一页 · 中间工具栏 · 右下一页);
 * 竖屏 (手机竖着拿) 拇指在上下方向够得着、左右两侧很窄, 改按上·中·下三等分。
 * 自动阅读开着时 (含暂停中) 不设翻页区, 整屏轻点只用来暂停 / 继续, 免得误点翻走。
 *
 * 单手翻页 (App 默认, 设置 `oneHandTurn`): 点哪里都是下一页, 双击呼出工具栏, 往回翻靠右滑 / 下滑;
 * 拇指只用够到屏幕下半部分。双击由 createDoubleTap 认出, 单击因此要等一个双击间隔才生效。
 */
export type TapZone = 'prev' | 'menu' | 'next'

export interface TapZoneInput {
  /** 相对阅读区左上角的坐标 */
  x: number
  y: number
  width: number
  height: number
  portrait: boolean
  autoReading: boolean
  /** 单手翻页: 整屏都是下一页 */
  oneHand?: boolean
}

export function tapZone({ x, y, width, height, portrait, autoReading, oneHand }: TapZoneInput): TapZone {
  if (autoReading) return 'menu'
  if (oneHand) return 'next'
  const [pos, size] = portrait ? [y, height] : [x, width]
  if (!(size > 0)) return 'menu'
  if (pos < size / 3) return 'prev'
  if (pos > size * 2 / 3) return 'next'
  return 'menu'
}

/** 两次轻点相隔不超过这么久 (毫秒) 算双击; 也是单击翻页要多等的时间 */
export const DOUBLE_TAP_MS = 260
/** 两次轻点相距不超过这么远 (像素) 才算双击, 远了是两次单击 */
export const DOUBLE_TAP_SLOP = 48

export interface DoubleTapTimers {
  set: (fn: () => void, ms: number) => unknown
  clear: (id: unknown) => void
}

/**
 * 区分单击与双击: 单击等 DOUBLE_TAP_MS 没有第二下才执行; 第二下落在附近就只执行双击。
 * 第二下离得远时先把前一下的单击补上, 再按新的一下重新等。
 */
export function createDoubleTap(timers: DoubleTapTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: id => clearTimeout(id as number) }) {
  let pending: { x: number; y: number; at: number; id: unknown; single: () => void } | null = null
  const flush = () => {
    const p = pending
    pending = null
    if (p) {
      timers.clear(p.id)
      p.single()
    }
  }
  return {
    tap(x: number, y: number, now: number, single: () => void, double: () => void) {
      const p = pending
      if (p && now - p.at <= DOUBLE_TAP_MS && Math.hypot(x - p.x, y - p.y) <= DOUBLE_TAP_SLOP) {
        timers.clear(p.id)
        pending = null
        double()
        return
      }
      flush()
      const id = timers.set(() => {
        if (pending?.id === id) {
          pending = null
          single()
        }
      }, DOUBLE_TAP_MS)
      pending = { x, y, at: now, id, single }
    },
    /** 有等待中的单击 (翻页、离开页面前要么补上要么丢掉) */
    get pending() {
      return pending !== null
    },
    /** 丢掉等待中的单击 (滑动、选字、关闭阅读页时) */
    cancel() {
      if (pending) timers.clear(pending.id)
      pending = null
    },
  }
}
