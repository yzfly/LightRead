/**
 * PDF 页面位图的内存预算: 按一页位图的实际字节数决定保留 / 预载多少页。
 * 普通缩放下一页十几 MB, 窗口就是原来的 ±4 页; 放大到 300% 时一页上百 MB,
 * 固定 ±4 页会留住 1GB 以上的画布 (安卓 WebView 直接被系统回收)。
 */
export const PAGE_BITMAP_BUDGET = {
  /** 桌面: 约 9 页 A4 @200% DPR 2 */
  desktop: 384 * 1024 * 1024,
  /** 手机 / 平板 WebView */
  app: 160 * 1024 * 1024,
} as const

export interface PageWindow {
  /** 距当前页多少页以内的位图保留 */
  keep: number
  /** 向后 / 向前预载多少个页组 */
  ahead: number
  behind: number
}

/**
 * @param pageBytes 当前页按现在的缩放与 DPR 栅格化后的字节数 (宽 × 高 × 4)
 * @param pagesPerGroup 连续滚动里一组几页 (单页 1, 双页 2)
 */
export function pageWindow(pageBytes: number, budgetBytes: number, pagesPerGroup = 1): PageWindow {
  const ppg = Math.max(1, Math.round(pagesPerGroup))
  const perGroup = Math.max(1, pageBytes) * ppg
  // 预算里先留出当前页组, 剩下的前后平分; 再紧也保留相邻一组, 否则翻页必见白页。
  // 上限: 单页 ±4 组 (与改动前一致), 双页 ±2 组 (正好盖住预载范围)。
  const groups = Math.min(ppg > 1 ? 2 : 4, Math.max(1, Math.floor((budgetBytes / perGroup - 1) / 2)))
  return {
    // 双页时当前页可能是组里的任一页, 多留 ppg-1 页才不会把预载的那组又清掉
    keep: groups * ppg + (ppg - 1),
    ahead: Math.min(2, groups),
    behind: 1,
  }
}
