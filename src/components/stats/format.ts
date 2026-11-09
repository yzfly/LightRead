/**
 * 阅读记录页的展示工具: 日期本地化、时长拆分、热度分级、占位封面色相.
 * 日期键一律是 YYYY-MM-DD (本地日期), 与 readingStats / readingLog 一致.
 */
import { useSettings } from '../../stores/settings'
import { t } from '../../i18n'
import { formatReadingTime } from '../../composables/useReadingTimer'

export function parseDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function locale(): string {
  return useSettings().language === 'en' ? 'en-US' : 'zh-CN'
}

export function fmtDay(day: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale(), opts).format(parseDay(day))
}

/** 10月3日 周五 / Fri, Oct 3 (跨年时带年份) */
export function fmtDayLong(day: string, today?: string): string {
  const withYear = !!today && day.slice(0, 4) !== today.slice(0, 4)
  return fmtDay(day, {
    year: withYear ? 'numeric' : undefined,
    month: 'short',
    day: 'numeric',
    weekday: 'short',
  })
}

/** 「1 小时 12 分钟」; 0 秒显示「未阅读」 */
export function fmtDuration(seconds: number): string {
  return seconds > 0 ? formatReadingTime(seconds) : t('stats.noReading')
}

/** 大号数字排版: [{n:'1',u:'小时'},{n:'12',u:'分钟'}] */
export function durationParts(seconds: number): Array<{ n: string; u: string }> {
  // 与 fmtDuration (formatReadingTime) 同样四舍五入, 同一时长各处显示一致
  const mins = Math.round(Math.max(0, seconds) / 60)
  if (mins < 60) return [{ n: String(mins), u: t('stats.unitMinutes') }]
  const h = Math.floor(mins / 60)
  const m = mins % 60
  const parts = [{ n: String(h), u: t('stats.unitHours') }]
  if (m) parts.push({ n: String(m), u: t('stats.unitMinutes') })
  return parts
}

/** 坐标轴等紧凑场景: 30分 / 1时 / 1.5时 */
export function fmtAxis(seconds: number): string {
  const mins = Math.round(seconds / 60)
  if (mins < 60) return t('stats.axisMinutes', { m: mins })
  const h = Math.round((mins / 60) * 10) / 10
  return t('stats.axisHours', { h })
}

/** 热度 0–4 档 (按分钟数, 与图例一致) */
export function heatLevel(seconds: number): number {
  if (seconds <= 0) return 0
  const mins = seconds / 60
  if (mins < 15) return 1
  if (mins < 30) return 2
  if (mins < 60) return 3
  return 4
}

/** 无封面时的稳定色相, 与 BookCard 同一算法 */
export function titleHue(title: string): number {
  let hash = 0
  for (const ch of title) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return Math.abs(hash) % 360
}

/** 百分比 (0–100 整数) */
export function pct(ratio: number): number {
  return Math.max(0, Math.min(100, Math.round(ratio * 100)))
}

/** 触屏 (无悬停) 设备: 柱子第一次点按只显示数值 */
export function isCoarse(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(hover: none)').matches
}
