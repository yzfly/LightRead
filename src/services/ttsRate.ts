/** 听书语速: 两端留足余地 (0.5× – 3×), 刻度沿用读者熟悉的「倍速」说法, 1× 叫「正常」 */
export const TTS_RATE_MIN = 0.5
export const TTS_RATE_MAX = 3
export const TTS_RATE_STOPS = [0.5, 0.75, 1, 1.5, 2, 3] as const
/** 线性刻度上 0.75× 离 0.5× / 1× 太近, 只画刻度不写字 */
export const TTS_RATE_MINOR_STOPS: readonly number[] = [0.75]

/** 1.5 → 「1.5×」, 1.25 → 「1.25×」 */
export function rateText(rate: number): string {
  const r = Math.round(rate * 100) / 100
  return `${Number.isInteger(r * 10) ? r.toFixed(1) : r.toFixed(2)}×`
}
