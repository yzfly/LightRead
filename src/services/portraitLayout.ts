/**
 * 竖屏单页滚动 (2026-10-06): 手机、iPad / 安卓平板、Surface 等竖着拿 (视口高于宽) 时,
 * 双栏或左右翻页太挤, 默认改为单栏连续滚动; 横过来恢复用户自己的翻页 / 分栏 (默认横屏双栏)。
 * 只算「生效值」, 从不改写保存的设置; 用户可在阅读设置「竖屏」里关掉。
 */

/** 竖屏: 视口高于宽 (旋转设备、把桌面窗口拉成竖长条都会实时切换) */
export const PORTRAIT_QUERY = '(orientation: portrait)'

export interface PortraitProbe {
  /** 已知键盘状态时, 无键盘始终按应用窗口判定 (支持桌面和分屏)。 */
  keyboardOpen?: boolean
  /** 视口 (CSS px) */
  width: number
  height: number
  /** screen.width / height (CSS px); iOS 上不随旋转交换, 只用来判断窗口是否占满屏宽 */
  screenWidth?: number
  screenHeight?: number
  /** screen.orientation.type, 如 'portrait-primary'; 不支持时缺省 */
  orientationType?: string
  /** 旧 WebView 的 window.orientation (0/180 竖, ±90 横) */
  legacyOrientation?: number
}

/**
 * 是否按竖屏排版。窗口占满屏宽时 (手机、平板、最大化 / 全屏的 Surface) 按屏幕方向判断:
 * 软键盘弹出、点墨这类屏幕键盘停靠在底部都会把视口压矮, 只看视口宽高比会误判成横屏,
 * 正文随之从单栏滚动切成双栏翻页、位置乱跳。桌面上随意拉伸的窗口仍按视口宽高比
 * (把窗口拉成竖长条照样切到竖屏排版)。
 */
export function isPortraitView(p: PortraitProbe): boolean {
  const viewport = p.height >= p.width
  if (p.keyboardOpen === false) return viewport
  const sw = p.screenWidth ?? 0
  const sh = p.screenHeight ?? 0
  if (!(sw > 0 && sh > 0)) return viewport
  const screenPortrait = p.orientationType
    ? p.orientationType.startsWith('portrait')
    : typeof p.legacyOrientation === 'number'
      ? Math.abs(p.legacyOrientation) !== 90
      : sh >= sw
  // iOS 的 screen 尺寸恒为竖放时的值, 按方向取当前的屏宽
  const screenInline = screenPortrait ? Math.min(sw, sh) : Math.max(sw, sh)
  return p.width >= screenInline * 0.9 ? screenPortrait : viewport
}

export type ReaderFlow = 'paginated' | 'scrolled'

export interface ReaderLayoutInput {
  flow: ReaderFlow
  maxColumnCount: 'auto' | 1 | 2
  /** 设置项「竖屏时单页滚动」 */
  portraitScroll: boolean
  /** 当前是否竖屏 (PORTRAIT_QUERY 命中) */
  portrait: boolean
  /** 大字 / 歌词等阅读模式要求单栏 */
  forceSingleColumn?: boolean
  /** 带读要求滚动 (歌词运行中): 只改生效值, 不写用户保存的版式 */
  forceScrolled?: boolean
}

export interface ReaderLayout {
  flow: ReaderFlow
  maxColumnCount: 'auto' | 1 | 2
  /** 竖屏锁定生效中 (界面可据此提示「横屏后恢复」) */
  portraitLocked: boolean
  /** 带读临时改成了滚动 (界面提示「结束后恢复」); 竖屏锁定本来就是滚动时为 false */
  modeLocked: boolean
}

/**
 * 重排书 (EPUB / TXT …) 的生效排版。版式只有这一个出口: 用户保存的值 (排版面板) + 临时约束
 * (竖屏锁定、带读要求的滚动、场景要求的单栏), 约束一律不回写设置, 解除后自然回到用户的选择。
 */
export function effectiveReaderLayout(input: ReaderLayoutInput): ReaderLayout {
  const locked = input.portraitScroll && input.portrait
  const modeLocked = !!input.forceScrolled && !locked && input.flow !== 'scrolled'
  const flow: ReaderFlow = locked || input.forceScrolled ? 'scrolled' : input.flow
  return {
    flow,
    // 竖屏 / 歌词的滚动都是单栏; 翻页时大字等场景也要单栏
    maxColumnCount: flow === 'scrolled' || input.forceSingleColumn ? 1 : input.maxColumnCount,
    portraitLocked: locked,
    modeLocked,
  }
}

export interface PdfLayoutInput {
  mode: 'paged' | 'scroll'
  spreadMode: 'single' | 'facing' | 'book'
  portraitScroll: boolean
  portrait: boolean
  /** 幻灯片放映自己决定整页翻页, 不受竖屏锁定影响 */
  presentation?: boolean
}

/** PDF 的生效阅读方式与页布局 */
export function effectivePdfLayout(input: PdfLayoutInput) {
  const locked = input.portraitScroll && input.portrait && !input.presentation
  return {
    mode: locked ? 'scroll' as const : input.mode,
    spreadMode: locked ? 'single' as const : input.spreadMode,
    portraitLocked: locked,
  }
}

/** 默认页边距设置 (settings.reader.gap 的默认值, 百分比) */
const DEFAULT_GAP = 6
/** 竖屏行宽上限: 只在特别宽的竖屏 (竖放的大显示器) 上才起作用 */
export const PORTRAIT_MAX_INLINE = 1200

/**
 * 竖屏时的左右留白。foliate 按百分比留边 (外侧半个 gap + iframe 内边距),
 * 再用 max-inline-size (默认 720px) 卡行宽: 820–912px 宽的竖屏平板上剩下的宽度全成了两侧空白。
 * 竖屏改为按绝对像素留边 (手机每侧约 18px, 平板约 36px), 用户调大 / 调小页边距时按比例缩放,
 * 并放宽行宽上限让正文铺满。横屏不受影响, 仍用用户的百分比设置。
 *
 * @param width 阅读区宽度 (CSS px)
 * @param userGap 用户的页边距设置 (百分比, 默认 6)
 * @returns foliate 的 gap 百分比与 max-inline-size (px)
 */
export function portraitSpacing(width: number, userGap: number) {
  const w = Math.max(1, width)
  const sidePx = (w < 600 ? 18 : 36) * Math.max(0.3, userGap / DEFAULT_GAP)
  // 实测每侧留白 ≈ 1 个 gap (外侧半个 + iframe 内边距); 不超过用户在横屏下的百分比 (窄窗口不会反而更宽)
  const gapPercent = Math.min(userGap, sidePx / w * 100)
  return {
    gapPercent: Math.round(gapPercent * 100) / 100,
    maxInlineSize: PORTRAIT_MAX_INLINE,
  }
}

/** 横排滚动页把两侧留白算在居中的阅读区域内，宽屏上的行宽上限才不会盖过页边距设置。 */
export function scrolledPageGeometry(viewportWidth: number, maxInlineSize: number, gapFraction: number) {
  const pageWidth = Math.min(viewportWidth, maxInlineSize)
  const gap = pageWidth * gapFraction
  return { gap, columnWidth: pageWidth - 2 * gap }
}
