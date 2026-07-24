<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getStorage, isTauri, type BookMeta, type AnnotationRec } from '../storage'
import {
  extractParagraphsFromItems,
  extractParagraphsLooseFromItems,
  restorePlaceholders,
  type PaperParagraph,
} from '../services/paperText'
import { translatePage, cachedTranslation } from '../services/paperTranslate'
import { aiConfigured, chatStream, explainPrompt, readerSystemPrompt, type AiMessage } from '../services/ai'
import {
  PdfiumDoc,
  hitBoundary,
  rangeRects,
  rangeText,
  wordRange,
  textRuns,
} from '../services/pdfium'
import { initMupdf } from '../services/mupdf'
import {
  TEN_QUESTIONS,
  SUMMARY_PROMPT,
  DOC_CHAR_BUDGET,
  buildDocSystem,
  cachedAi,
  saveAi,
  askDoc,
  type DocText,
} from '../services/paperAI'
import { FONT_FAMILIES, HIGHLIGHT_COLORS, READER_THEMES } from '../services/readerTheme'
import { injectFontIntoDoc, resolveFontFamily } from '../services/fonts'
import {
  INSTALL_CMD,
  stageLabel,
  babeldocCancel,
  babeldocReadOutput,
  babeldocStatus,
  babeldocSupported,
  babeldocTranslate,
  babeldocUsableProvider,
  bookFilePath,
  onBabeldocProgress,
  type BabeldocStatus,
} from '../services/babeldoc'
import { importFile } from '../services/importer'
import { useLibrary } from '../stores/library'
import { useSettings } from '../stores/settings'
import { useReadingTimer } from '../composables/useReadingTimer'
import { toast } from '../services/toast'
import { printPdf, revealStoredBook, savePdfAs } from '../services/pdfFileActions'
import {
  speakText,
  prefetchSpeech,
  stopSpeech,
  pauseSpeech,
  resumeSpeech,
  resetEdgeFailure,
  listVoicesSorted,
} from '../services/tts'
import { EDGE_VOICES, edgeAvailable, playAudio } from '../services/edgeTts'
import { localTtsAvailable, localTtsDownload, localTtsStatus, localTtsSynthesize } from '../services/localTts'
import TocList, { type TocItem } from '../components/TocList.vue'
import { t } from '../i18n'

const route = useRoute()
const router = useRouter()
const library = useLibrary()
const settings = useSettings()
const bookId = String(route.params.id)

const meta = ref<BookMeta>()
const loading = ref(true)
const error = ref('')
const pageCount = ref(0)
const currentPage = ref(1)
const pageInput = ref('1')
const scroller = ref<HTMLElement>()
const pagedBox = ref<HTMLElement>()
const rightPane = ref<HTMLElement>()
const thumbnailScroller = ref<HTMLElement>()

/** PDFium 交互引擎：几何选择、链接、目录、文本与段落提取。 */
let pdm: PdfiumDoc | null = null
/** MuPDF 只负责可见位图；交互能力继续由 PDFium 提供。 */
let renderBytes: Uint8Array | null = null
/** 原始文件供打印、另存为与属性信息复用，不受渲染引擎消费影响。 */
let sourcePdfBlob: Blob | null = null
const sourcePdfVersion = ref('')
let mupdfDocPromise: Promise<any> | null = null
let mupdfRenderFailed = false

function mupdfDoc(): Promise<any> {
  if (!mupdfDocPromise) {
    mupdfDocPromise = (async () => {
      if (!renderBytes) throw new Error('PDF render data unavailable')
      const mupdf = await initMupdf()
      const bytes = renderBytes
      renderBytes = null
      return mupdf.Document.openDocument(bytes, 'application/pdf')
    })()
  }
  return mupdfDocPromise
}
let saveTimer: ReturnType<typeof setTimeout> | undefined
let settleTimer: ReturnType<typeof setTimeout> | undefined
let resizeTimer: ReturnType<typeof setTimeout> | undefined
let resizeObserver: ResizeObserver | undefined
let scrollScheduled = false

useReadingTimer(bookId)

const aiReady = computed(() => aiConfigured())
/** 归属: 论文/藏书 (藏书 PDF 也走本阅读器, 返回目标随归属) */
// kind 缺省是历史藏书记录；只有显式标记为 paper 才进入论文功能集。
const isPaper = computed(() => meta.value?.kind === 'paper')
const backTarget = computed(() => (isPaper.value ? '/papers' : '/library'))
const backLabel = computed(() => (isPaper.value ? t('paper.backToPapers') : t('reader.backToLibrary')))
/** 所有 PDF 共用阅读模式；v7 起默认连续滚动。 */
const mode = computed<'paged' | 'scroll'>(() => settings.pdf.mode)
const pdfLayout = computed(() => settings.pdf.layout)
const bookPaged = computed(() => pdfLayout.value === 'original' && mode.value === 'paged')
const spreadMode = computed(() => settings.pdf.spreadMode)
const scrollSpread = computed(() =>
  pdfLayout.value === 'original' && mode.value === 'scroll' && spreadMode.value !== 'single')

/* ================= 连续滚动渲染 (虚拟化: 只渲染视口附近页) ================= */

const GAP = 16
const PAD = 16
const KEEP = 4
/** PDF 坐标是 72 pt/in，CSS 的基准分辨率是 96 px/in。 */
const CSS_PX_PER_PT = 96 / 72
/** 必须使用完整设备像素比；截到 2 会让高 DPI 屏把位图再次放大。 */
const DPR = () => Math.max(window.devicePixelRatio || 1, 1)
/** 仅作为浏览器画布安全阈值；可覆盖桌面端 200% + 3x DPR 的常见页面。 */
const MAX_DIM = 8192

/** 页面尺寸；保留 baseDims 供译文镜像等只处理当前标准页的旧路径使用。 */
const baseDims = ref({ w: 612, h: 792 })
const pageDims = ref<Array<{ w: number; h: number }>>([])
/** 当前实际渲染缩放 */
const curScale = ref(1)
/** Sumatra 风格虚拟缩放：适合页面、适合宽度或固定百分比。 */
type PdfZoom = number | 'fit-page' | 'fit-width'
const LEGACY_ZOOM_KEY = 'lightread-paper-zoom'
const ZOOM_KEY = `lightread-pdf-zoom:${bookId}`
const restoredZoom = restoreZoom()
const zoom = ref<PdfZoom>(restoredZoom ?? (settings.pdf.mode === 'scroll' ? 'fit-width' : 'fit-page'))

function restoreZoom(): PdfZoom | null {
  const raw = localStorage.getItem(ZOOM_KEY) ?? localStorage.getItem(LEGACY_ZOOM_KEY)
  if (raw === 'fit-page' || raw === 'fit-width') return raw
  if (raw === 'fit') return 'fit-width'
  const n = raw ? parseFloat(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

/** UI 百分比转为 PDF 点到 CSS 像素的比例，与 SumatraPDF 的 DPI 换算一致。 */
function fixedZoomScale(value: number): number {
  return value * CSS_PX_PER_PT
}

function dimensionsOf(pageNum: number) {
  return pageDims.value[pageNum - 1] ?? baseDims.value
}

/**
 * 页面外框必须落在整数 CSS 像素上。否则 MuPDF 的整数 Pixmap 会被浏览器
 * 再插值一次；70% / 80% 等缩小档位发糊正是由此造成。
 */
function displaySizeOf(pageNum: number, scale = curScale.value) {
  const dims = dimensionsOf(pageNum)
  const w = Math.max(1, Math.floor(dims.w * scale))
  const h = Math.max(1, Math.floor(dims.h * scale))
  return { w, h, sx: w / dims.w, sy: h / dims.h }
}

const holderH = computed(() => displaySizeOf(currentPage.value).h)
const holderStyleFor = (pageNum: number) => {
  const size = displaySizeOf(pageNum)
  return { width: `${size.w}px`, height: `${size.h}px` }
}

/** 连续阅读也支持单页、对页与封面错位书籍视图。 */
const scrollPageGroups = computed<number[][]>(() => {
  const total = pageCount.value
  if (!total) return []
  if (!scrollSpread.value) return Array.from({ length: total }, (_, index) => [index + 1])
  const groups: number[][] = []
  let page = 1
  if (spreadMode.value === 'book') {
    groups.push([1])
    page = 2
  }
  while (page <= total) {
    groups.push(page + 1 <= total ? [page, page + 1] : [page])
    page += 2
  }
  return groups
})

const scrollGroupLayout = computed(() => {
  let top = PAD
  return scrollPageGroups.value.map(pages => {
    const height = Math.max(...pages.map(page => displaySizeOf(page).h))
    const entry = { pages, top, height }
    top += height + GAP
    return entry
  })
})

const scrollPageLayout = computed(() => {
  const pages = Array.from({ length: pageCount.value }, () => ({ top: PAD, height: 0 }))
  for (const group of scrollGroupLayout.value) {
    for (const page of group.pages) pages[page - 1] = { top: group.top, height: group.height }
  }
  return pages
})

const renderedScale = new Map<number, string>()
const rendering = new Set<number>()

function renderKeyFor(pageNum: number, scale: number) {
  const display = displaySizeOf(pageNum, scale)
  return `${settings.pdf.renderer}:${scale.toFixed(6)}:${DPR().toFixed(4)}:${display.w}x${display.h}`
}

function holderOf(num: number) {
  return paperRoot.value?.querySelector<HTMLElement>(`[data-page="${num}"]`) ?? null
}

function fitScale(kind: 'fit-page' | 'fit-width'): number {
  const box = scroller.value
  // 与 Sumatra 一样让同一文档所有页面使用相同倍率；双页布局同时约束整组宽度。
  const width = Math.max((box?.clientWidth ?? 800) - 48, 240)
  const height = Math.max((box?.clientHeight ?? 700) - 32, 240)
  const dims = pageDims.value.length ? pageDims.value : [baseDims.value]
  let scale = Math.min(...dims.map(page => kind === 'fit-page'
    ? Math.min(width / page.w, height / page.h)
    : width / page.w))
  if (scrollSpread.value) {
    for (const group of scrollPageGroups.value) {
      const groupWidth = group.reduce((sum, page) => sum + dimensionsOf(page).w, 0)
      scale = Math.min(scale, Math.max(1, width - GAP * (group.length - 1)) / Math.max(1, groupWidth))
      if (kind === 'fit-page') {
        scale = Math.min(scale, ...group.map(page => height / Math.max(1, dimensionsOf(page).h)))
      }
    }
  }
  return Number.isFinite(scale) ? scale : 1
}

/** 当前页所在的页组；双页按 1-2、3-4 … 配对。 */
function spreadOf(page: number): number[] {
  const clamped = Math.min(Math.max(1, page || 1), Math.max(1, pageCount.value))
  if (!bookPaged.value || spreadMode.value === 'single') return [clamped]
  if (spreadMode.value === 'book' && clamped === 1) return [1]
  const start = spreadMode.value === 'book'
    ? (clamped % 2 === 0 ? clamped : clamped - 1)
    : (clamped % 2 === 1 ? clamped : clamped - 1)
  return start + 1 <= pageCount.value ? [start, start + 1] : [start]
}

const pagedPages = computed(() => spreadOf(currentPage.value))
const atFirstPage = computed(() => pdfLayout.value === 'reflow'
  ? currentPage.value <= (reflowPages.value[0]?.page ?? 1)
  : currentPage.value <= 1)
const atLastPage = computed(() => pdfLayout.value === 'reflow'
  ? currentPage.value >= (reflowPages.value.at(-1)?.page ?? pageCount.value)
  : bookPaged.value
    ? pagedPages.value.at(-1) === pageCount.value
    : scrollSpread.value
      ? currentPage.value >= (scrollPageGroups.value.at(-1)?.[0] ?? pageCount.value)
      : currentPage.value >= pageCount.value)

/** 翻页模式默认适高；双页时同时受可用宽度约束，避免页面被裁掉。 */
function pagedScale(): number {
  if (typeof zoom.value === 'number') return fixedZoomScale(zoom.value)
  const box = pagedBox.value
  const availW = Math.max((box?.clientWidth ?? 800) - 32, 240)
  const availH = Math.max((box?.clientHeight ?? 700) - 24, 240)
  const pages = pagedPages.value
  const dims = pages.map(dimensionsOf)
  const totalW = dims.reduce((sum, page) => sum + page.w, 0)
  const widthScale = Math.max(1, availW - GAP * (pages.length - 1)) / Math.max(1, totalW)
  if (zoom.value === 'fit-width') return widthScale
  const heightScale = Math.min(...dims.map(page => availH / Math.max(1, page.h)))
  return Math.min(widthScale, heightScale)
}

/**
 * 整页位图 canvas：MuPDF 负责页面栅格化，按 CSS 缩放与完整 DPR 输出设备像素。
 * PDFium 仍负责所有交互几何；MuPDF 失败时无感回退 PDFium。
 */
async function renderBitmapCanvas(pageNum: number, scale: number): Promise<HTMLCanvasElement> {
  const dims = dimensionsOf(pageNum)
  const display = displaySizeOf(pageNum, scale)
  const outputScale = Math.min(DPR(), MAX_DIM / display.w, MAX_DIM / display.h)
  const targetW = Math.max(1, Math.round(display.w * outputScale))
  const targetH = Math.max(1, Math.round(display.h * outputScale))
  const canvas = document.createElement('canvas')
  canvas.style.width = `${display.w}px`
  canvas.style.height = `${display.h}px`

  if (settings.pdf.renderer === 'mupdf' && !mupdfRenderFailed) {
    let page: any = null
    let pixmap: any = null
    try {
      const mupdf = await initMupdf()
      page = (await mupdfDoc()).loadPage(pageNum - 1)
      pixmap = page.toPixmap(
        // 用两个方向的精确目标比例，确保 Pixmap 与 CSS×DPR 一一对应。
        mupdf.Matrix.scale(targetW / dims.w, targetH / dims.h),
        mupdf.ColorSpace.DeviceRGB,
        false,
        true,
      )
      const sourceWidth = Math.max(1, pixmap.getWidth())
      const sourceHeight = Math.max(1, pixmap.getHeight())
      canvas.width = targetW
      canvas.height = targetH
      const context = canvas.getContext('2d', { alpha: false })!
      const source: Uint8ClampedArray = pixmap.getPixels()
      const sourceStride: number = pixmap.getStride()
      const rgba = new Uint8ClampedArray(canvas.width * canvas.height * 4)
      rgba.fill(255)
      // 非零页面原点会让 MuPDF 的整数 bbox 偶尔多出 1px；居中裁掉这圈
      // bbox 留白，始终保持目标位图尺寸，不让浏览器承担缩放。
      const copyWidth = Math.min(sourceWidth, canvas.width)
      const copyHeight = Math.min(sourceHeight, canvas.height)
      const sourceX = Math.max(0, Math.floor((sourceWidth - copyWidth) / 2))
      const sourceY = Math.max(0, Math.floor((sourceHeight - copyHeight) / 2))
      const targetX = Math.max(0, Math.floor((canvas.width - copyWidth) / 2))
      const targetY = Math.max(0, Math.floor((canvas.height - copyHeight) / 2))
      for (let y = 0; y < copyHeight; y++) {
        let src = (sourceY + y) * sourceStride + sourceX * 4
        let dst = (targetY + y) * canvas.width * 4 + targetX * 4
        const rowEnd = dst + copyWidth * 4
        while (dst < rowEnd) {
          rgba[dst++] = source[src++]
          rgba[dst++] = source[src++]
          rgba[dst++] = source[src++]
          rgba[dst++] = 255
        }
      }
      context.putImageData(new ImageData(rgba, canvas.width, canvas.height), 0, 0)
      canvas.dataset.renderer = 'mupdf'
      return canvas
    } catch (e) {
      mupdfRenderFailed = true
      console.warn('MuPDF render failed; falling back to PDFium', e)
    } finally {
      pixmap?.destroy?.()
      page?.destroy?.()
    }
  }

  const img = pdm!.renderToSize(pageNum - 1, targetW, targetH)
  canvas.width = img.width
  canvas.height = img.height
  canvas.getContext('2d')!.putImageData(img, 0, 0)
  canvas.dataset.renderer = 'pdfium'
  return canvas
}

async function renderScrollPage(num: number) {
  if (!pdm || num < 1 || num > pageCount.value || rendering.has(num)) return
  const holder = holderOf(num)
  if (!holder) return
  const scale = curScale.value
  const renderKey = renderKeyFor(num, scale)
  if (renderedScale.get(num) === renderKey) return
  rendering.add(num)
  try {
    const canvas = await renderBitmapCanvas(num, scale)
    if (scale !== curScale.value) return
    holder.querySelector('.p-canvas')?.replaceChildren(canvas)
    renderedScale.set(num, renderKey)
    renderPdmLinks(holder, num)
  } finally {
    rendering.delete(num)
  }
}

async function renderPaged() {
  if (!pdm || !pagedBox.value || !bookPaged.value) return
  const pages = pagedPages.value
  curScale.value = pagedScale()
  // 页组切换会创建新的 holder，不能沿用连续滚动视图的 DOM 渲染缓存。
  for (const page of pages) renderedScale.delete(page)
  await nextTick()
  await Promise.all(pages.map(async page => {
    // 模式切换时，旧滚动 holder 可能仍有同页渲染任务；等它收尾后再画入新 holder。
    while (rendering.has(page)) await new Promise(resolve => setTimeout(resolve, 0))
    await renderScrollPage(page)
  }))
  pagedBox.value.scrollTo({ top: 0, left: 0 })
}

async function pagedGoto(page: number) {
  const pages = spreadOf(page)
  const next = pages[0]
  pageInput.value = String(next)
  if (next === currentPage.value && pages.every(p => holderOf(p))) {
    await renderPaged()
    return
  }
  selection.value = null
  currentPage.value = next
  await nextTick()
  await renderPaged()
}

async function switchMode(next: 'paged' | 'scroll') {
  if (settings.pdf.mode === next) return
  stopAutoRead()
  settings.pdf.mode = next
  if (next === 'paged' && restoredZoom == null && zoom.value === 'fit-width') {
    zoom.value = settings.pdf.fit === 'fitH' ? 'fit-page' : 'fit-width'
  }
  renderedScale.clear()
  await nextTick()
  if (next === 'paged') {
    await pagedGoto(currentPage.value)
  } else {
    curScale.value = typeof zoom.value === 'number' ? fixedZoomScale(zoom.value) : fitScale(zoom.value)
    attachScrollListener()
    await nextTick()
    scrollGoto(currentPage.value)
    updateViewport()
  }
  observeActiveViewport()
}

async function setSpreadMode(next: 'single' | 'facing' | 'book') {
  settings.pdf.spreadMode = next
  renderedScale.clear()
  await nextTick()
  if (bookPaged.value) {
    currentPage.value = spreadOf(currentPage.value)[0]
    await renderPaged()
  } else {
    relayout(true)
  }
}

async function setPagedFit(fit: 'fitH' | 'fitW') {
  settings.pdf.fit = fit
  await applyZoom(fit === 'fitH' ? 'fit-page' : 'fit-width')
}

/** PDFium 链接层: 内链跳转 + 外链系统浏览器 */
function renderPdmLinks(holder: HTMLElement, num: number) {
  const host = holder.querySelector<HTMLElement>('.p-links')
  if (!host || !pdm) return
  host.replaceChildren()
  const display = displaySizeOf(num)
  for (const ln of pdm.links(num - 1)) {
    const el = document.createElement('a')
    el.className = 'p-link'
    el.style.left = `${ln.x * display.sx}px`
    el.style.top = `${ln.y * display.sy}px`
    el.style.width = `${ln.w * display.sx}px`
    el.style.height = `${ln.h * display.sy}px`
    if (ln.url) {
      el.title = ln.url
      el.addEventListener('click', e => {
        e.preventDefault()
        openExternal(ln.url!)
      })
    } else if (ln.destPage != null) {
      el.addEventListener('click', e => {
        e.preventDefault()
        pushBack()
        const targetScale = displaySizeOf(ln.destPage! + 1).sy
        gotoPage(ln.destPage! + 1, false, Math.max(0, (ln.destY ?? 0) * targetScale - 60))
      })
    }
    host.append(el)
  }
}

function evictFarPages(center: number) {
  for (const num of [...renderedScale.keys()]) {
    if (Math.abs(num - center) > KEEP) {
      const holder = holderOf(num)
      if (holder) {
        holder.querySelector('.p-canvas')?.replaceChildren()
        holder.querySelector('.p-links')?.replaceChildren()
      }
      renderedScale.delete(num)
    }
  }
}

function pageAtCenter(): number {
  const el = scroller.value
  const layout = scrollGroupLayout.value
  if (!el || !layout.length) return 1
  const center = el.scrollTop + el.clientHeight / 2
  let lo = 0
  let hi = layout.length - 1
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    const group = layout[mid]
    if (center > group.top + group.height + GAP / 2) lo = mid + 1
    else hi = mid
  }
  return layout[lo]?.pages[0] ?? 1
}

function updateViewport() {
  const cur = pageAtCenter()
  if (cur !== currentPage.value) currentPage.value = cur
  const activeGroup = scrollGroupLayout.value.findIndex(group => group.pages.includes(cur))
  const nearby = scrollGroupLayout.value.slice(
    Math.max(0, activeGroup - 1),
    Math.min(scrollGroupLayout.value.length, activeGroup + 3),
  )
  for (const group of nearby) for (const page of group.pages) renderScrollPage(page)
  evictFarPages(cur)
}

function onScroll() {
  if (scrollScheduled) return
  scrollScheduled = true
  requestAnimationFrame(() => {
    scrollScheduled = false
    updateViewport()
  })
}

let listenedScroller: HTMLElement | undefined
function attachScrollListener() {
  if (listenedScroller === scroller.value) return
  listenedScroller?.removeEventListener('scroll', onScroll)
  listenedScroller = scroller.value
  listenedScroller?.addEventListener('scroll', onScroll, { passive: true })
}

function observeActiveViewport() {
  if (!resizeObserver) return
  resizeObserver.disconnect()
  const viewport = pdfLayout.value === 'reflow'
    ? reflowScroller.value
    : bookPaged.value ? pagedBox.value : scroller.value
  if (viewport) resizeObserver.observe(viewport)
}

function pageTop(n: number): number {
  return scrollPageLayout.value[n - 1]?.top ?? PAD
}

function scrollGoto(n: number, smooth = false, yOffsetPx = 0) {
  const clamped = Math.min(Math.max(1, n || 1), pageCount.value)
  scroller.value?.scrollTo({ top: Math.max(0, pageTop(clamped) + yOffsetPx), behavior: smooth ? 'smooth' : 'auto' })
}

function gotoPage(n: number, smooth = false, yOffsetPx = 0) {
  if (pdfLayout.value === 'reflow') reflowGoto(n, smooth)
  else if (bookPaged.value) void pagedGoto(n)
  else scrollGoto(n, smooth, yOffsetPx)
}

async function applyZoom(next: PdfZoom) {
  zoom.value = next
  localStorage.setItem(ZOOM_KEY, String(next))
  if (bookPaged.value) {
    renderedScale.clear()
    await renderPaged()
  } else {
    relayout(true)
  }
}

function zoomStep(dir: 1 | -1) {
  const cur = typeof zoom.value === 'number' ? zoom.value : curScale.value / CSS_PX_PER_PT
  const fuzz = 0.0001
  const next = dir > 0
    ? SUMATRA_ZOOM_LEVELS.find(level => level > cur + fuzz) ?? SUMATRA_ZOOM_LEVELS.at(-1)!
    : [...SUMATRA_ZOOM_LEVELS].reverse().find(level => level < cur - fuzz) ?? SUMATRA_ZOOM_LEVELS[0]
  void applyZoom(next)
}

/** SumatraPDF 的离散缩放阶梯；当前整页 Canvas 的安全上限为 400%。 */
const SUMATRA_ZOOM_LEVELS = [0.0833, 0.125, 0.18, 0.25, 0.3333, 0.5, 0.6667, 0.75, 1, 1.25, 1.5, 2, 3, 4]
const ZOOM_PRESETS = [0.125, 0.25, 0.5, 0.6667, 0.75, 1, 1.25, 1.5, 2, 3, 4]
const zoomMenu = ref(false)

function pickZoom(z: PdfZoom) {
  zoomMenu.value = false
  void applyZoom(z)
}

function zoomPercentLabel(value: number) {
  const percent = value * 100
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2).replace(/0+$/, '')}%`
}

const isMacPlatform = typeof navigator !== 'undefined'
  && /Mac|iPhone|iPad|iPod/i.test(navigator.platform)
const primaryShortcutLabel = isMacPlatform ? '⌘' : 'Ctrl'
const shortcutsOpen = ref(false)
const shortcutRows = computed(() => [
  { shortcuts: [[primaryShortcutLabel, 'F']], label: t('reader.searchInBook') },
  { shortcuts: [[primaryShortcutLabel, 'P']], label: t('reader.print') },
  { shortcuts: [[primaryShortcutLabel, '⇧', 'S']], label: t('reader.saveAs') },
  { shortcuts: [[primaryShortcutLabel, '＋']], label: t('reader.shortcutZoomIn') },
  { shortcuts: [[primaryShortcutLabel, '−']], label: t('reader.shortcutZoomOut') },
  { shortcuts: [[primaryShortcutLabel, '0'], [primaryShortcutLabel, '1'], [primaryShortcutLabel, '2']], label: t('reader.shortcutZoomModes') },
  { shortcuts: [[primaryShortcutLabel, '6'], [primaryShortcutLabel, '7'], [primaryShortcutLabel, '8']], label: t('reader.shortcutPageLayouts') },
  { shortcuts: [['N'], ['P']], label: t('reader.shortcutPrevNextPage') },
  { shortcuts: [['J'], ['K'], ['H'], ['L']], label: t('reader.shortcutScroll') },
  { shortcuts: [['Page Up'], ['⇧', 'Space']], label: t('reader.shortcutPrevPage') },
  { shortcuts: [['Page Down'], ['Space']], label: t('reader.shortcutNextPage') },
  { shortcuts: [['Home'], ['End']], label: t('reader.shortcutFirstLast') },
  { shortcuts: [['F'], ['F11']], label: t('reader.shortcutFullscreen') },
  { shortcuts: [['?']], label: t('reader.shortcutHelp') },
  { shortcuts: [['Esc']], label: t('reader.shortcutClose') },
])

function changeReaderZoom(dir: 1 | -1) {
  zoomMenu.value = false
  if (pdfLayout.value === 'reflow') {
    settings.reader.fontSize = Math.min(36, Math.max(12, settings.reader.fontSize + dir * 2))
  } else {
    zoomStep(dir)
  }
}

function resetReaderZoom() {
  zoomMenu.value = false
  if (pdfLayout.value === 'reflow') settings.reader.fontSize = 18
  else void applyZoom('fit-page')
}

function toggleShortcutGuide() {
  shortcutsOpen.value = !shortcutsOpen.value
  zoomMenu.value = false
  typographyOpen.value = false
}

/* ---- 文件操作 / 属性 / 全屏 / 幻灯片 ---- */
const paperRoot = ref<HTMLElement>()
const moreMenu = ref(false)
const propertiesOpen = ref(false)
const isFullscreen = ref(false)
const presentationMode = ref(false)
let fullscreenWindowUnlisten: (() => void) | undefined
let presentationRestore: {
  mode: 'paged' | 'scroll'
  spreadMode: 'single' | 'facing' | 'book'
  zoom: PdfZoom
  wasFullscreen: boolean
} | null = null

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return t('reader.unknown')
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

function formatPdfDate(value: string): string {
  if (!value) return ''
  const match = value.match(/D:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/)
  if (!match) return value
  const [, year, month = '01', day = '01', hour = '00', minute = '00'] = match
  return `${year}-${month}-${day} ${hour}:${minute}`
}

const propertyRows = computed(() => {
  const first = dimensionsOf(1)
  const mmW = first.w / 72 * 25.4
  const mmH = first.h / 72 * 25.4
  const value = (tag: string) => pdm?.meta(tag) || ''
  return [
    { label: t('reader.fileName'), value: meta.value?.fileName || t('reader.unknown') },
    { label: t('reader.fileSize'), value: formatBytes(sourcePdfBlob?.size ?? 0) },
    { label: t('reader.pdfVersion'), value: sourcePdfVersion.value || t('reader.unknown') },
    { label: t('reader.pageCount'), value: String(pageCount.value) },
    { label: t('reader.pageSize'), value: `${mmW.toFixed(1)} × ${mmH.toFixed(1)} mm · ${Math.round(first.w)} × ${Math.round(first.h)} pt` },
    { label: t('reader.documentTitle'), value: value('Title') || meta.value?.title || t('reader.unknown') },
    { label: t('reader.documentAuthor'), value: value('Author') || meta.value?.author || t('reader.unknown') },
    { label: t('reader.subject'), value: value('Subject') },
    { label: t('reader.keywords'), value: value('Keywords') },
    { label: t('reader.creator'), value: value('Creator') },
    { label: t('reader.producer'), value: value('Producer') },
    { label: t('reader.createdAt'), value: formatPdfDate(value('CreationDate')) },
    { label: t('reader.modifiedAt'), value: formatPdfDate(value('ModDate')) },
  ].filter(row => row.value)
})

async function printDocument() {
  moreMenu.value = false
  if (!sourcePdfBlob) return
  try {
    await printPdf(sourcePdfBlob)
    toast(t('reader.printOpened'), 'success')
  } catch {
    toast(t('reader.printFailed'), 'error')
  }
}

async function saveDocumentAs() {
  moreMenu.value = false
  if (!sourcePdfBlob) return
  try {
    const saved = await savePdfAs(sourcePdfBlob, meta.value?.fileName || meta.value?.title || 'document.pdf')
    if (saved) toast(t('reader.savedAs'), 'success')
  } catch (error: any) {
    toast(t('reader.saveFailed', { msg: error?.message ?? error }), 'error', 5000)
  }
}

async function openDocumentFolder() {
  moreMenu.value = false
  if (!meta.value) return
  if (!isTauri()) {
    toast(t('reader.openFolderWebHint'), 'error', 5000)
    return
  }
  try {
    await revealStoredBook(meta.value)
  } catch {
    toast(t('reader.openFolderFailed'), 'error', 5000)
  }
}

function openProperties() {
  moreMenu.value = false
  propertiesOpen.value = true
}

async function setFullscreen(enabled: boolean) {
  const el = paperRoot.value as any
  try {
    if (enabled) {
      if (document.fullscreenElement) return
      if (el?.requestFullscreen) await el.requestFullscreen()
      else if (el?.webkitRequestFullscreen) await el.webkitRequestFullscreen()
      else throw new Error('no element fullscreen')
    } else if (document.fullscreenElement) {
      await document.exitFullscreen()
    } else {
      throw new Error('no document fullscreen')
    }
    isFullscreen.value = enabled
  } catch {
    // WKWebView 元素全屏不可用时退回无边框窗口全屏。
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      await getCurrentWindow().setFullscreen(enabled)
      isFullscreen.value = enabled
    } catch { /* Web 端且元素全屏失败: 忽略 */ }
  }
}

async function toggleFullscreen() {
  if (presentationMode.value) {
    await exitPresentation()
    return
  }
  await setFullscreen(!isFullscreen.value)
}

async function enterPresentation() {
  moreMenu.value = false
  if (presentationMode.value) return
  presentationRestore = {
    mode: mode.value,
    spreadMode: spreadMode.value,
    zoom: zoom.value,
    wasFullscreen: isFullscreen.value,
  }
  presentationMode.value = true
  if (pdfLayout.value === 'reflow') await switchPdfLayout('original')
  if (mode.value !== 'paged') await switchMode('paged')
  if (spreadMode.value !== 'single') await setSpreadMode('single')
  await applyZoom('fit-page')
  if (!isFullscreen.value) await setFullscreen(true)
}

async function exitPresentation(exitFullscreen = true) {
  if (!presentationMode.value) return
  const restore = presentationRestore
  presentationMode.value = false
  presentationRestore = null
  if (exitFullscreen && !restore?.wasFullscreen && isFullscreen.value) {
    await setFullscreen(false)
  }
  if (!restore) return
  if (mode.value !== restore.mode) await switchMode(restore.mode)
  if (spreadMode.value !== restore.spreadMode) await setSpreadMode(restore.spreadMode)
  await applyZoom(restore.zoom)
}

function onFullscreenChange() {
  const active = Boolean(document.fullscreenElement)
  const wasFullscreen = isFullscreen.value
  isFullscreen.value = active
  if (wasFullscreen && !active && presentationMode.value) void exitPresentation(false)
}

/** 重算缩放并保持当前页锚点 (页内比例) */
function relayout(force = false) {
  const el = scroller.value
  if (!el) return
  const next = typeof zoom.value === 'number' ? fixedZoomScale(zoom.value) : fitScale(zoom.value)
  if (!force && Math.abs(next - curScale.value) < 0.001) return
  const anchorPage = currentPage.value
  const anchorHeight = displaySizeOf(anchorPage).h
  const frac = anchorHeight ? (el.scrollTop - pageTop(anchorPage)) / (anchorHeight + GAP) : 0
  curScale.value = next
  renderedScale.clear()
  nextTick(() => {
    scrollGoto(anchorPage, false, frac * (displaySizeOf(anchorPage).h + GAP))
    updateViewport()
  })
}

/* ================= 页码 / 进度 ================= */

watch(currentPage, cur => {
  pageInput.value = String(cur)
  clearTimeout(settleTimer)
  settleTimer = setTimeout(onPageSettled, 600)
})

function onPageSettled() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    library.saveProgress(bookId, String(currentPage.value), pageCount.value ? currentPage.value / pageCount.value : 0)
  }, 400)
}

function jumpTo() {
  const n = parseInt(pageInput.value, 10)
  if (Number.isFinite(n)) {
    gotoPage(Math.min(Math.max(n, 1), pageCount.value))
  } else {
    pageInput.value = String(currentPage.value)
  }
}

function prevPage() {
  if (pdfLayout.value === 'reflow') reflowStep(-1)
  else if (bookPaged.value) void pagedGoto(pagedPages.value[0] - 1)
  else if (scrollSpread.value) {
    const index = scrollPageGroups.value.findIndex(group => group.includes(currentPage.value))
    const target = scrollPageGroups.value[Math.max(0, index - 1)]?.[0]
    if (target) scrollGoto(target, true)
  } else scrollGoto(currentPage.value - 1, true)
}
function nextPage() {
  if (pdfLayout.value === 'reflow') {
    reflowStep(1)
  } else if (bookPaged.value) {
    const next = (pagedPages.value.at(-1) ?? currentPage.value) + 1
    if (next <= pageCount.value) void pagedGoto(next)
  } else if (scrollSpread.value) {
    const index = scrollPageGroups.value.findIndex(group => group.includes(currentPage.value))
    const target = scrollPageGroups.value[Math.min(scrollPageGroups.value.length - 1, index + 1)]?.[0]
    if (target) scrollGoto(target, true)
  } else {
    scrollGoto(currentPage.value + 1, true)
  }
}

/* ================= 跳转返回 (引文 / 目录跳转后回到原位) ================= */

const backStack = ref<number[]>([])
const forwardStack = ref<number[]>([])

function pushBack() {
  const position = currentNavPosition()
  if (position == null) return
  backStack.value.push(position)
  if (backStack.value.length > 20) backStack.value.shift()
  forwardStack.value = []
}

function currentNavPosition(): number | null {
  if (bookPaged.value) return -currentPage.value
  if (pdfLayout.value === 'reflow') return reflowScroller.value?.scrollTop ?? null
  return scroller.value?.scrollTop ?? null
}

function restoreNavPosition(position: number) {
  if (position < 0) gotoPage(-position)
  else if (pdfLayout.value === 'reflow') reflowScroller.value?.scrollTo({ top: position })
  else scroller.value?.scrollTo({ top: position })
}

function goBack() {
  const position = backStack.value.pop()
  const current = currentNavPosition()
  if (position == null || current == null) return
  forwardStack.value.push(current)
  restoreNavPosition(position)
}

function goForward() {
  const position = forwardStack.value.pop()
  const current = currentNavPosition()
  if (position == null || current == null) return
  backStack.value.push(current)
  restoreNavPosition(position)
}

async function openExternal(url: string) {
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(url)
  } catch {
    window.open(url, '_blank', 'noopener')
  }
}

/* ================= 目录 (PDF 内嵌大纲) ================= */

const tocOpen = ref(false)
const thumbnailOpen = ref(false)
const annoOpen = ref(false)
const tocItems = ref<TocItem[]>([])
const drawerOpen = computed(() => tocOpen.value || thumbnailOpen.value || annoOpen.value)

type DrawerTab = 'toc' | 'thumbnails' | 'annotations'

function closeDrawer() {
  tocOpen.value = false
  thumbnailOpen.value = false
  annoOpen.value = false
}

function setDrawerTab(tab: DrawerTab) {
  tocOpen.value = tab === 'toc'
  thumbnailOpen.value = tab === 'thumbnails'
  annoOpen.value = tab === 'annotations'
}

function toggleDrawerTab(tab: DrawerTab) {
  const isOpen = tab === 'toc' ? tocOpen.value : tab === 'thumbnails' ? thumbnailOpen.value : annoOpen.value
  if (isOpen) closeDrawer()
  else setDrawerTab(tab)
}

/* ================= 页面缩略图 ================= */

const THUMB_MAX_WIDTH = 210
const THUMB_MAX_HEIGHT = 260
const THUMB_CACHE_LIMIT = 56
const thumbnailRendered = new Set<number>()
const thumbnailQueued = new Set<number>()
const thumbnailLastUsed = new Map<number, number>()
const thumbnailQueue: number[] = []
let thumbnailObserver: IntersectionObserver | null = null
let thumbnailWorkerActive = false

function thumbnailSizeOf(pageNum: number) {
  const dims = dimensionsOf(pageNum)
  const scale = Math.min(THUMB_MAX_WIDTH / dims.w, THUMB_MAX_HEIGHT / dims.h)
  return {
    w: Math.max(1, Math.round(dims.w * scale)),
    h: Math.max(1, Math.round(dims.h * scale)),
  }
}

function thumbnailFrameStyle(pageNum: number) {
  const size = thumbnailSizeOf(pageNum)
  return { width: `${size.w}px`, height: `${size.h}px` }
}

function thumbnailHolderOf(pageNum: number) {
  return thumbnailScroller.value?.querySelector<HTMLElement>(`[data-thumbnail-page="${pageNum}"]`) ?? null
}

function trimThumbnailCache() {
  if (thumbnailRendered.size <= THUMB_CACHE_LIMIT) return
  const protectedStart = Math.max(1, currentPage.value - 8)
  const protectedEnd = Math.min(pageCount.value, currentPage.value + 8)
  const candidates = [...thumbnailRendered]
    .filter(page => page < protectedStart || page > protectedEnd)
    .sort((a, b) => (thumbnailLastUsed.get(a) ?? 0) - (thumbnailLastUsed.get(b) ?? 0))

  while (thumbnailRendered.size > THUMB_CACHE_LIMIT && candidates.length) {
    const page = candidates.shift()!
    const holder = thumbnailHolderOf(page)
    holder?.querySelector('.thumbnail-canvas')?.replaceChildren()
    holder?.classList.remove('thumbnail-ready')
    thumbnailRendered.delete(page)
    thumbnailLastUsed.delete(page)
    if (holder && thumbnailOpen.value) thumbnailObserver?.observe(holder)
  }
}

async function drainThumbnailQueue() {
  if (thumbnailWorkerActive) return
  thumbnailWorkerActive = true
  try {
    while (thumbnailQueue.length && pdm) {
      const pageNum = thumbnailQueue.shift()!
      thumbnailQueued.delete(pageNum)
      if (thumbnailRendered.has(pageNum)) continue
      // 每页之间让出一帧，快速滚动缩略图时不会阻塞正文与工具栏交互。
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      if (!thumbnailOpen.value || !pdm) continue
      const holder = thumbnailHolderOf(pageNum)
      const slot = holder?.querySelector<HTMLElement>('.thumbnail-canvas')
      if (!holder || !slot) continue
      try {
        const size = thumbnailSizeOf(pageNum)
        // Retina 下保留清晰度，同时限制后台缩略图的长期内存占用。
        const outputScale = Math.min(DPR(), 1.5)
        const image = pdm.renderToSize(
          pageNum - 1,
          Math.max(1, Math.round(size.w * outputScale)),
          Math.max(1, Math.round(size.h * outputScale)),
        )
        const canvas = document.createElement('canvas')
        canvas.width = image.width
        canvas.height = image.height
        canvas.style.width = `${size.w}px`
        canvas.style.height = `${size.h}px`
        canvas.setAttribute('aria-hidden', 'true')
        canvas.getContext('2d', { alpha: false })!.putImageData(image, 0, 0)
        slot.replaceChildren(canvas)
        holder.classList.add('thumbnail-ready')
        thumbnailRendered.add(pageNum)
        thumbnailLastUsed.set(pageNum, performance.now())
        thumbnailObserver?.unobserve(holder)
        trimThumbnailCache()
      } catch (e) {
        holder.classList.add('thumbnail-failed')
        console.warn(`thumbnail render failed for page ${pageNum}:`, e)
      }
    }
  } finally {
    thumbnailWorkerActive = false
  }
}

function queueThumbnail(pageNum: number, priority = false) {
  if (
    !pdm
    || pageNum < 1
    || pageNum > pageCount.value
    || thumbnailRendered.has(pageNum)
    || thumbnailQueued.has(pageNum)
  ) return
  thumbnailQueued.add(pageNum)
  if (priority) thumbnailQueue.unshift(pageNum)
  else thumbnailQueue.push(pageNum)
  void drainThumbnailQueue()
}

function setupThumbnailObserver() {
  thumbnailObserver?.disconnect()
  const root = thumbnailScroller.value
  if (!root || !thumbnailOpen.value) return
  thumbnailObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const pageNum = Number((entry.target as HTMLElement).dataset.thumbnailPage)
      if (Number.isFinite(pageNum)) queueThumbnail(pageNum)
    }
  }, { root, rootMargin: '420px 0px', threshold: 0.01 })
  root.querySelectorAll<HTMLElement>('[data-thumbnail-page]').forEach(holder => {
    const pageNum = Number(holder.dataset.thumbnailPage)
    if (!thumbnailRendered.has(pageNum)) thumbnailObserver?.observe(holder)
  })
}

function scrollActiveThumbnailIntoView() {
  if (!thumbnailOpen.value) return
  setupThumbnailObserver()
  const holder = thumbnailHolderOf(currentPage.value)
  holder?.scrollIntoView({ block: 'nearest' })
  queueThumbnail(currentPage.value, true)
}

function thumbnailNavigate(pageNum: number) {
  thumbnailLastUsed.set(pageNum, performance.now())
  pushBack()
  gotoPage(pageNum)
}

watch(thumbnailOpen, open => {
  if (open) {
    void nextTick(scrollActiveThumbnailIntoView)
  } else {
    thumbnailObserver?.disconnect()
    thumbnailQueue.length = 0
    thumbnailQueued.clear()
  }
})

watch(currentPage, () => {
  if (thumbnailOpen.value) void nextTick(scrollActiveThumbnailIntoView)
})

/** href 格式: "页码|页内纵向偏移(pt, 左上原点)" */
function buildOutline() {
  if (!pdm) return
  const map = (nodes: import('../services/pdfium').PdmOutline[]): TocItem[] =>
    nodes.map(n => ({
      label: n.title,
      href: n.page != null ? `${n.page + 1}|${n.y != null ? n.y.toFixed(1) : ''}` : undefined,
      subitems: n.children.length ? map(n.children) : null,
    }))
  try {
    tocItems.value = map(pdm.outline())
  } catch (e) {
    console.warn('outline failed:', e)
  }
}

function tocNavigate(href: string) {
  const [p, y] = href.split('|')
  pushBack()
  const yOffset = y ? Math.max(0, parseFloat(y) * displaySizeOf(parseInt(p, 10)).sy - 60) : 0
  gotoPage(parseInt(p, 10), false, yOffset)
  closeDrawer()
}

/* ================= 划词: 高亮 / 想法 / 复制 / AI 翻译 ================= */

interface HlRect { x: number; y: number; w: number; h: number }
interface SelInfo {
  text: string
  page: number
  /** 页内坐标 (scale=1, 左上原点), 缩放无关 */
  rects: HlRect[]
  /** 工具条锚点 (视口坐标) */
  anchor: { x: number; y: number }
}

const selection = ref<SelInfo | null>(null)
const annotations = ref<AnnotationRec[]>([])
const activeAnnotation = ref<AnnotationRec | null>(null)
const noteDraft = ref('')
const popPos = ref({ x: 0, y: 0 })

const encodeLoc = (page: number, rects: HlRect[]) =>
  `p:${page}:${JSON.stringify(rects.map(r => [r.x, r.y, r.w, r.h].map(v => +v.toFixed(2))))}`

function decodeLoc(cfi: string): { page: number; rects: HlRect[] } | null {
  const m = /^p:(\d+):(.+)$/.exec(cfi)
  if (!m) return null
  try {
    const arr = JSON.parse(m[2]) as number[][]
    return { page: parseInt(m[1], 10), rects: arr.map(([x, y, w, h]) => ({ x, y, w, h })) }
  } catch {
    return null
  }
}

const highlights = computed(() => annotations.value.filter(a => a.kind !== 'bookmark'))

/** 按页索引的高亮矩形 (模板渲染用) */
const pageHls = computed(() => {
  const map = new Map<number, Array<{ a: AnnotationRec; r: HlRect; key: string }>>()
  for (const a of highlights.value) {
    const loc = decodeLoc(a.cfi)
    if (!loc) continue
    const list = map.get(loc.page) ?? []
    loc.rects.forEach((r, i) => list.push({ a, r, key: `${a.id}:${i}` }))
    map.set(loc.page, list)
  }
  return map
})

const hlStyle = (page: number, r: HlRect, color: string) => {
  const display = displaySizeOf(page)
  return {
    left: `${r.x * display.sx}px`,
    top: `${r.y * display.sy}px`,
    width: `${r.w * display.sx}px`,
    height: `${r.h * display.sy}px`,
    background: HIGHLIGHT_COLORS[color] ?? color,
  }
}

/* ---- PDF 全文搜索: PDFium 字符模型 → 命中区间 → 精确几何高亮 ---- */

interface PdfSearchHit {
  page: number
  a: number
  b: number
  rects: HlRect[]
}

const PDF_SEARCH_LIMIT = 2000
const pdfSearchInput = ref<HTMLInputElement>()
const pdfSearchOpen = ref(false)
const pdfSearchQuery = ref('')
const pdfSearchResults = ref<PdfSearchHit[]>([])
const pdfSearchActive = ref(-1)
const pdfSearchRunning = ref(false)
const pdfSearchProgress = ref(0)
const pdfSearchDoneQuery = ref('')
const pdfSearchMatchCase = ref(false)
const pdfSearchWholeWord = ref(false)
let pdfSearchSession = 0
let pdfSearchTimer: ReturnType<typeof setTimeout> | undefined

const pdfSearchStatus = computed(() => {
  if (pdfSearchRunning.value) return `${Math.round(pdfSearchProgress.value * 100)}%`
  if (!pdfSearchDoneQuery.value) return ''
  if (!pdfSearchResults.value.length) return '0 / 0'
  return `${pdfSearchActive.value + 1} / ${pdfSearchResults.value.length}${pdfSearchResults.value.length >= PDF_SEARCH_LIMIT ? '+' : ''}`
})

const pdfSearchRectsByPage = computed(() => {
  const byPage = new Map<number, Array<{ key: string; rect: HlRect; active: boolean }>>()
  if (!pdfSearchOpen.value) return byPage
  pdfSearchResults.value.forEach((hit, hitIndex) => {
    const list = byPage.get(hit.page) ?? []
    hit.rects.forEach((rect, rectIndex) => {
      list.push({ key: `${hitIndex}:${rectIndex}`, rect, active: hitIndex === pdfSearchActive.value })
    })
    byPage.set(hit.page, list)
  })
  return byPage
})

function appendSearchUnits(
  units: string[],
  indexes: number[] | null,
  value: string,
  sourceIndex: number,
) {
  const normalized = pdfSearchMatchCase.value
    ? value.normalize('NFKC')
    : value.normalize('NFKC').toLocaleLowerCase()
  for (const ch of normalized) {
    if (/\s/u.test(ch)) {
      if (units.length && units.at(-1) !== ' ') {
        units.push(' ')
        indexes?.push(sourceIndex)
      }
    } else {
      units.push(ch)
      indexes?.push(sourceIndex)
    }
  }
}

function querySearchUnits(value: string): string[] {
  const units: string[] = []
  appendSearchUnits(units, null, value.trim(), 0)
  if (units.at(-1) === ' ') units.pop()
  return units
}

function modelSearchUnits(model: ReturnType<PdfiumDoc['text']>) {
  const units: string[] = []
  const indexes: number[] = []
  for (let i = 0; i < model.count; i++) {
    const code = model.codes[i]
    if (!code || code === 13) continue
    appendSearchUnits(units, indexes, String.fromCodePoint(code), i)
  }
  return { units, indexes }
}

function pageSearchHits(page: number, needle: string[]): PdfSearchHit[] {
  if (!pdm || !needle.length) return []
  const model = pdm.text(page - 1)
  const { units, indexes } = modelSearchUnits(model)
  const hits: PdfSearchHit[] = []
  const lastStart = units.length - needle.length
  for (let start = 0; start <= lastStart; start++) {
    let matched = true
    for (let j = 0; j < needle.length; j++) {
      if (units[start + j] !== needle[j]) {
        matched = false
        break
      }
    }
    if (!matched) continue
    const a = indexes[start]
    const b = indexes[start + needle.length - 1] + 1
    if (pdfSearchWholeWord.value) {
      const before = a > 0 ? String.fromCodePoint(model.codes[a - 1] ?? 0) : ''
      const after = b < model.count ? String.fromCodePoint(model.codes[b] ?? 0) : ''
      if (isSearchWordChar(before) || isSearchWordChar(after)) continue
    }
    const rects = rangeRects(model, a, b)
    if (rects.length) hits.push({ page, a, b, rects })
    start += Math.max(0, needle.length - 1)
  }
  return hits
}

function isSearchWordChar(value: string) {
  return value ? /[\p{L}\p{N}_]/u.test(value) : false
}

function togglePdfSearchOption(option: 'case' | 'word') {
  if (option === 'case') pdfSearchMatchCase.value = !pdfSearchMatchCase.value
  else pdfSearchWholeWord.value = !pdfSearchWholeWord.value
  schedulePdfSearch()
}

async function activatePdfSearchHit(index: number) {
  const count = pdfSearchResults.value.length
  if (!count) {
    pdfSearchActive.value = -1
    return
  }
  const normalizedIndex = ((index % count) + count) % count
  pdfSearchActive.value = normalizedIndex
  const hit = pdfSearchResults.value[normalizedIndex]
  const firstRect = hit.rects[0]
  if (!firstRect) return

  selection.value = null
  if (pdfLayout.value === 'reflow') await switchPdfLayout('original')

  if (bookPaged.value) {
    await pagedGoto(hit.page)
    await nextTick()
    const box = pagedBox.value
    const holder = holderOf(hit.page)
    if (box && holder) {
      const boxRect = box.getBoundingClientRect()
      const holderRect = holder.getBoundingClientRect()
      const display = displaySizeOf(hit.page)
      box.scrollTo({
        left: Math.max(0, box.scrollLeft + holderRect.left - boxRect.left + (firstRect.x + firstRect.w / 2) * display.sx - box.clientWidth / 2),
        top: Math.max(0, box.scrollTop + holderRect.top - boxRect.top + firstRect.y * display.sy - box.clientHeight * 0.3),
      })
    }
  } else {
    currentPage.value = hit.page
    scrollGoto(
      hit.page,
      false,
      Math.max(0, firstRect.y * displaySizeOf(hit.page).sy - (scroller.value?.clientHeight ?? 0) * 0.3),
    )
    updateViewport()
  }
}

async function runPdfSearch() {
  clearTimeout(pdfSearchTimer)
  const query = pdfSearchQuery.value.trim()
  const needle = querySearchUnits(query)
  const session = ++pdfSearchSession
  pdfSearchResults.value = []
  pdfSearchActive.value = -1
  pdfSearchProgress.value = 0
  pdfSearchDoneQuery.value = ''
  if (!pdm || !needle.length) {
    pdfSearchRunning.value = false
    return
  }

  pdfSearchRunning.value = true
  const hits: PdfSearchHit[] = []
  try {
    for (let page = 1; page <= pageCount.value && hits.length < PDF_SEARCH_LIMIT; page++) {
      if (session !== pdfSearchSession) return
      try {
        const remaining = PDF_SEARCH_LIMIT - hits.length
        hits.push(...pageSearchHits(page, needle).slice(0, remaining))
      } catch (e) {
        console.warn(`PDF search skipped page ${page}`, e)
      }
      pdfSearchProgress.value = page / Math.max(1, pageCount.value)
      if (page % 8 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    if (session !== pdfSearchSession) return
    pdfSearchResults.value = hits
    pdfSearchDoneQuery.value = query
    if (hits.length) {
      const index = hits.findIndex(hit => hit.page >= currentPage.value)
      await activatePdfSearchHit(index >= 0 ? index : 0)
    }
  } finally {
    if (session === pdfSearchSession) pdfSearchRunning.value = false
  }
}

function schedulePdfSearch() {
  clearTimeout(pdfSearchTimer)
  pdfSearchSession++
  if (!pdfSearchQuery.value.trim()) {
    pdfSearchResults.value = []
    pdfSearchActive.value = -1
    pdfSearchDoneQuery.value = ''
    pdfSearchRunning.value = false
    return
  }
  pdfSearchTimer = setTimeout(() => void runPdfSearch(), 180)
}

async function onPdfSearchKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    closePdfSearch()
    return
  }
  if (e.key !== 'Enter') return
  e.preventDefault()
  const query = pdfSearchQuery.value.trim()
  if (pdfSearchDoneQuery.value !== query) {
    await runPdfSearch()
  } else {
    await activatePdfSearchHit(pdfSearchActive.value + (e.shiftKey ? -1 : 1))
  }
}

function openPdfSearch() {
  pdfSearchOpen.value = true
  closeDrawer()
  nextTick(() => {
    pdfSearchInput.value?.focus()
    pdfSearchInput.value?.select()
  })
}

function closePdfSearch() {
  clearTimeout(pdfSearchTimer)
  pdfSearchSession++
  pdfSearchOpen.value = false
  pdfSearchRunning.value = false
}

const pdfSearchRectStyle = (page: number, r: HlRect) => {
  const display = displaySizeOf(page)
  return {
    left: `${r.x * display.sx}px`,
    top: `${r.y * display.sy}px`,
    width: `${r.w * display.sx}px`,
    height: `${r.h * display.sy}px`,
  }
}

/* ---- PDFium 几何选择: 引擎字符坐标 → 自算命中/选区/绘制 (原生手感) ---- */

const liveSel = ref<{ page: number; a: number; b: number } | null>(null)
let dragSel: { page: number; anchor: number; moved: boolean } | null = null
let suppressClick = false
let panDrag: {
  viewport: HTMLElement
  x: number
  y: number
  left: number
  top: number
} | null = null
let wheelPageDelta = 0
let wheelPageReset: ReturnType<typeof setTimeout> | undefined
let wheelPageLockedUntil = 0
let touchGesture: {
  x: number
  y: number
  lastDistance: number
  pinching: boolean
} | null = null

const liveRects = computed(() => {
  if (!liveSel.value || !pdm) return null
  const { page, a, b } = liveSel.value
  return { page, rects: rangeRects(pdm.text(page - 1), a, b) }
})
watch(selection, v => {
  if (!v) liveSel.value = null
})

/** 视口坐标 → 某页边界索引; clampToPage 时拖出页面按页首/页尾处理 */
function boundaryAt(page: number, clientX: number, clientY: number, clampToPage = false): number {
  const holder = holderOf(page)
  if (!holder || !pdm) return -1
  const hb = holder.getBoundingClientRect()
  const display = displaySizeOf(page)
  const x = (clientX - hb.left) / display.sx
  const y = (clientY - hb.top) / display.sy
  const model = pdm.text(page - 1)
  if (clampToPage) {
    if (y < 0) return 0
    const dims = dimensionsOf(page)
    if (y > dims.h) return model.count
    const b = hitBoundary(model, Math.min(Math.max(x, 0), dims.w), y)
    return b >= 0 ? b : y < dims.h / 2 ? 0 : model.count
  }
  return hitBoundary(model, x, y)
}

function onScrollerPointerDown(e: PointerEvent) {
  if (!pdm) return
  if (e.button === 1 || e.button === 2) {
    const viewport = e.currentTarget as HTMLElement | null
    if (!viewport) return
    e.preventDefault()
    panDrag = {
      viewport,
      x: e.clientX,
      y: e.clientY,
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
    }
    viewport.classList.add('is-panning')
    window.addEventListener('pointermove', onPanMove)
    window.addEventListener('pointerup', onPanUp, { once: true })
    return
  }
  if (e.button !== 0) return
  if ((e.target as HTMLElement).closest?.('.p-link')) return
  const holder = (e.target as HTMLElement).closest?.('.p-holder') as HTMLElement | null
  liveSel.value = null
  selection.value = null
  if (!holder) return
  const page = Number(holder.dataset.page)
  const b = boundaryAt(page, e.clientX, e.clientY)
  if (b < 0) return
  dragSel = { page, anchor: b, moved: false }
  // 不用 pointer capture (会把 click/dblclick 兼容事件重定向到捕获元素,
  // 打断双击取词与点击高亮), 拖拽期间挂 window 监听
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', onDragUp, { once: true })
}

function onPanMove(e: PointerEvent) {
  if (!panDrag) return
  e.preventDefault()
  panDrag.viewport.scrollTo({
    left: panDrag.left - (e.clientX - panDrag.x),
    top: panDrag.top - (e.clientY - panDrag.y),
  })
}

function onPanUp() {
  window.removeEventListener('pointermove', onPanMove)
  panDrag?.viewport.classList.remove('is-panning')
  panDrag = null
}

function onPdfWheel(e: WheelEvent) {
  const viewport = e.currentTarget as HTMLElement | null
  if (!viewport) return
  if (e.ctrlKey || (isMacPlatform && e.metaKey)) {
    e.preventDefault()
    zoomStep(e.deltaY < 0 ? 1 : -1)
  } else if (e.shiftKey && Math.abs(e.deltaX) < Math.abs(e.deltaY)) {
    e.preventDefault()
    viewport.scrollLeft += e.deltaY
  } else if (e.altKey) {
    e.preventDefault()
    viewport.scrollTop += e.deltaY * 4
  } else if (bookPaged.value && zoom.value === 'fit-page' && Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
    // 整页/书籍视图中把触控板与滚轮的纵向意图转换为一次翻页，避免轻触连跳。
    e.preventDefault()
    clearTimeout(wheelPageReset)
    wheelPageDelta += e.deltaY
    wheelPageReset = setTimeout(() => { wheelPageDelta = 0 }, 180)
    if (performance.now() >= wheelPageLockedUntil && Math.abs(wheelPageDelta) >= 72) {
      wheelPageLockedUntil = performance.now() + 420
      if (wheelPageDelta > 0) nextPage()
      else prevPage()
      wheelPageDelta = 0
    }
  }
}

function touchDistance(touches: TouchList): number {
  if (touches.length < 2) return 0
  return Math.hypot(
    touches[0].clientX - touches[1].clientX,
    touches[0].clientY - touches[1].clientY,
  )
}

function onPdfTouchStart(e: TouchEvent) {
  if (e.touches.length >= 2) {
    touchGesture = {
      x: 0,
      y: 0,
      lastDistance: touchDistance(e.touches),
      pinching: true,
    }
    return
  }
  const touch = e.touches[0]
  if (!touch) return
  touchGesture = {
    x: touch.clientX,
    y: touch.clientY,
    lastDistance: 0,
    pinching: false,
  }
}

function onPdfTouchMove(e: TouchEvent) {
  if (!touchGesture || e.touches.length < 2) return
  e.preventDefault()
  const distance = touchDistance(e.touches)
  if (!touchGesture.lastDistance) {
    touchGesture.lastDistance = distance
    return
  }
  const ratio = distance / touchGesture.lastDistance
  if (ratio >= 1.12) {
    zoomStep(1)
    touchGesture.lastDistance = distance
  } else if (ratio <= 0.89) {
    zoomStep(-1)
    touchGesture.lastDistance = distance
  }
}

function onPdfTouchEnd(e: TouchEvent) {
  const gesture = touchGesture
  if (!gesture) return
  if (e.touches.length) {
    if (gesture.pinching && e.touches.length === 1) touchGesture = null
    return
  }
  touchGesture = null
  if (!bookPaged.value || gesture.pinching) return
  const touch = e.changedTouches[0]
  if (!touch) return
  const dx = touch.clientX - gesture.x
  const dy = touch.clientY - gesture.y
  if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.2) return
  liveSel.value = null
  selection.value = null
  dragSel = null
  suppressClick = true
  if (dx < 0) nextPage()
  else prevPage()
}

function onDragMove(e: PointerEvent) {
  if (!pdm || !dragSel) return
  const cur = boundaryAt(dragSel.page, e.clientX, e.clientY, true)
  if (cur < 0) return
  dragSel.moved = true
  const a = Math.min(dragSel.anchor, cur)
  const b = Math.max(dragSel.anchor, cur)
  liveSel.value = b > a ? { page: dragSel.page, a, b } : null
}

function onDragUp() {
  window.removeEventListener('pointermove', onDragMove)
  if (!pdm || !dragSel) return
  const drag = dragSel
  dragSel = null
  const sel = liveSel.value
  if (!drag.moved || !sel || sel.b <= sel.a) {
    liveSel.value = null
    return
  }
  suppressClick = true
  finishPdmSelection(sel.page, sel.a, sel.b)
}

/** 选区落定 → 复用既有划词工具条流程 (高亮/想法/复制/翻译) */
function finishPdmSelection(page: number, a: number, b: number) {
  if (!pdm) return
  const model = pdm.text(page - 1)
  const rects = rangeRects(model, a, b)
  const text = rangeText(model, a, b).replace(/\s+/g, ' ').trim()
  if (!rects.length || !text) {
    liveSel.value = null
    return
  }
  const holder = holderOf(page)
  const hb = holder?.getBoundingClientRect()
  const display = displaySizeOf(page)
  const last = rects[rects.length - 1]
  liveSel.value = { page, a, b }
  selection.value = {
    text,
    page,
    rects,
    anchor: hb
      ? {
          x: Math.min(hb.left + (last.x + last.w) * display.sx, window.innerWidth - 20),
          y: hb.top + (last.y + last.h) * display.sy,
        }
      : { x: window.innerWidth / 2, y: window.innerHeight / 2 },
  }
}

function onScrollerDblClick(e: MouseEvent) {
  if (!pdm) return
  const holder = (e.target as HTMLElement).closest?.('.p-holder') as HTMLElement | null
  if (!holder) return
  const page = Number(holder.dataset.page)
  const b = boundaryAt(page, e.clientX, e.clientY)
  if (b < 0) return
  const wr = wordRange(pdm.text(page - 1), b)
  if (wr) finishPdmSelection(page, wr[0], wr[1])
}

const selBarStyle = computed(() => {
  if (!selection.value) return {}
  const { x, y } = selection.value.anchor
  const toolbarWidth = Math.min(420, window.innerWidth - 24)
  const centerX = window.innerWidth <= toolbarWidth + 24
    ? window.innerWidth / 2
    : Math.min(Math.max(x, toolbarWidth / 2 + 12), window.innerWidth - toolbarWidth / 2 - 12)
  const toolbarHeight = 48
  const below = y + 12
  const top = below + toolbarHeight <= window.innerHeight - 12
    ? below
    : Math.max(12, y - toolbarHeight - 12)
  return {
    left: `${centerX}px`,
    top: `${top}px`,
  }
})

async function addHighlight(color: string, withNote = false) {
  const s = selection.value
  if (!s) return
  const storage = await getStorage()
  const rec: Omit<AnnotationRec, 'id'> = {
    bookId,
    kind: 'highlight',
    cfi: encodeLoc(s.page, s.rects),
    text: s.text.slice(0, 500),
    color,
    createdAt: Date.now(),
  }
  const id = await storage.addAnnotation(rec)
  const saved = { ...rec, id }
  annotations.value.push(saved)
  window.getSelection()?.removeAllRanges()
  const anchor = s.anchor
  selection.value = null
  if (withNote) {
    noteDraft.value = ''
    popPos.value = clampPop(anchor.x - 160, anchor.y + 10)
    activeAnnotation.value = saved
  } else {
    toast(t('reader.highlighted'), 'success')
  }
}

function clampPop(x: number, y: number) {
  return {
    x: Math.max(12, Math.min(x, window.innerWidth - 340)),
    y: Math.max(12, Math.min(y, window.innerHeight - 240)),
  }
}

async function saveNote() {
  if (!activeAnnotation.value) return
  const storage = await getStorage()
  const note = noteDraft.value.trim() || undefined
  await storage.updateAnnotation(activeAnnotation.value.id, { note })
  const item = annotations.value.find(a => a.id === activeAnnotation.value!.id)
  if (item) item.note = note
  activeAnnotation.value = null
  toast(t('reader.noteSaved'), 'success')
}

async function removeAnnotation(a: AnnotationRec) {
  const storage = await getStorage()
  await storage.deleteAnnotation(a.id)
  annotations.value = annotations.value.filter(x => x.id !== a.id)
  activeAnnotation.value = null
}

function gotoAnnotation(a: AnnotationRec) {
  const loc = decodeLoc(a.cfi)
  if (!loc) return
  closeDrawer()
  pushBack()
  gotoPage(loc.page, false, Math.max(0, (loc.rects[0]?.y ?? 0) * displaySizeOf(loc.page).sy - 100))
}

function liveRectStyle(page: number, r: HlRect) {
  const display = displaySizeOf(page)
  return {
    left: `${r.x * display.sx}px`,
    top: `${r.y * display.sy}px`,
    width: `${r.w * display.sx}px`,
    height: `${r.h * display.sy}px`,
  }
}

/** 点击命中已有高亮 → 打开想法编辑 (高亮矩形不拦截事件, 以免影响划词) */
function onHolderClick(e: MouseEvent, page: number) {
  if (suppressClick) {
    suppressClick = false
    return
  }
  if (window.getSelection()?.toString()) return
  if ((e.target as HTMLElement).closest('.p-link')) return
  const holder = holderOf(page)
  if (!holder) return
  const hb = holder.getBoundingClientRect()
  const display = displaySizeOf(page)
  const px = (e.clientX - hb.left) / display.sx
  const py = (e.clientY - hb.top) / display.sy
  const hit = pageHls.value.get(page)?.find(
    ({ r }) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h,
  )
  if (hit) {
    noteDraft.value = hit.a.note ?? ''
    popPos.value = clampPop(e.clientX - 160, e.clientY + 12)
    activeAnnotation.value = hit.a
    return
  }
  if (bookPaged.value) {
    const ratio = (e.clientX - hb.left) / Math.max(1, hb.width)
    const edge = presentationMode.value ? 0.5 : 0.14
    if (ratio <= edge) prevPage()
    else if (ratio >= 1 - edge) nextPage()
  }
}

async function copySelection() {
  const text = selection.value?.text
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    toast(t('paper.copied'), 'success')
  } catch {
    toast(t('common.copyFailed'), 'error')
  }
  selection.value = null
}

/* ---- 划词 AI 翻译 (点击才触发, 流式输出, 可关闭即取消) ---- */

const SEL_PROMPT =
  '你是专业的学术论文翻译。把用户给出的论文片段翻译成流畅准确的简体中文: ' +
  '术语首次出现保留英文原文于括号内, 公式、变量名、引用编号原样保留。只输出译文, 不要任何解释。'

const selTr = ref<{ src: string; out: string; busy: boolean } | null>(null)
const selTrPos = ref({ x: 0, y: 0 })
let selTrSession = 0

async function translateSelection() {
  const s = selection.value
  if (!s) return
  if (!aiReady.value) {
    toast(t('paper.setupHint'), 'error', 5000)
    router.push('/settings')
    return
  }
  selTrPos.value = clampPop(s.anchor.x - 180, s.anchor.y + 10)
  window.getSelection()?.removeAllRanges()
  selection.value = null
  selTr.value = { src: s.text, out: '', busy: true }
  const session = ++selTrSession
  try {
    // 论文划词 → 学术翻译; 藏书划词 → AI 解读 (中文书场景)
    const lang = settings.language === 'en' ? 'en' : 'zh'
    const messages: AiMessage[] = isPaper.value
      ? [
          { role: 'system', content: SEL_PROMPT },
          { role: 'user', content: s.text },
        ]
      : [
          {
            role: 'system',
            content: readerSystemPrompt({ title: meta.value?.title, author: meta.value?.author }, '', lang),
          },
          { role: 'user', content: explainPrompt(s.text, lang) },
        ]
    for await (const delta of chatStream(messages)) {
      if (session !== selTrSession) return
      selTr.value.out += delta
    }
  } catch (e: any) {
    if (session === selTrSession) toast(`${t('paper.translateFailed')}: ${e?.message ?? e}`, 'error', 6000)
  } finally {
    if (session === selTrSession && selTr.value) selTr.value.busy = false
  }
}

function closeSelTr() {
  selTrSession++
  selTr.value = null
}

async function copySelTr() {
  if (!selTr.value?.out) return
  try {
    await navigator.clipboard.writeText(selTr.value.out)
    toast(t('paper.copied'), 'success')
  } catch {
    toast(t('common.copyFailed'), 'error')
  }
}

/* ================= 整页翻译面板: 版式对照连续滚动 (独立于左栏) ================= */

interface MirPageData {
  paras: PaperParagraph[]
  trs: string[]
  err?: string
}

/** 右侧视图: 版式对照 (默认) / 段落列表 */
const VIEW_KEY = 'lightread-paper-view'
const viewMode = ref<'mirror' | 'cards'>(localStorage.getItem(VIEW_KEY) === 'cards' ? 'cards' : 'mirror')
const effectiveMode = computed(() => viewMode.value)

/** 每页的段落与译文 (提取/翻译均按需触发, 译文走 localStorage 缓存) */
const mirData = ref<Record<number, MirPageData>>({})
/** 对照视图当前页 (独立于左栏页码) */
const mirCur = ref(1)
/** 正在翻译的页码, 0 为空闲 */
const translatingPage = ref(0)
const expanded = ref<Set<number>>(new Set())
/** 已切回原文的块: "页:块id" */
const showOrig = ref<Set<string>>(new Set())
let translateSession = 0
let mirSettleTimer: ReturnType<typeof setTimeout> | undefined
let mirScrollScheduled = false

const mirScroller = ref<HTMLElement>()
const mirScale = ref(1)
const MIR_PAD = 12
const MIR_GAP = 12
const mirRendered = new Map<number, number>()
const mirRendering = new Set<number>()

const mirHolderW = computed(() => baseDims.value.w * mirScale.value)
const mirHolderH = computed(() => baseDims.value.h * mirScale.value)
const mirHolderStyle = computed(() => ({ width: `${mirHolderW.value}px`, height: `${mirHolderH.value}px` }))

const curMir = computed(() => mirData.value[mirCur.value])

const origText = (p: PaperParagraph) => restorePlaceholders(p.text, p.placeholders)
const trText = (d: MirPageData, id: number) => restorePlaceholders(d.trs[id] ?? '', d.paras[id]?.placeholders)

/**
 * 版式求解 (先算好每个块的最终几何再填充, 避免遮罩互相覆盖):
 * 按列分组 → 列内按纵向排序 → 与下一块重叠时裁掉本块底部。按 (段落数组, 缩放) 缓存。
 */
interface BlockRect {
  left: number
  top: number
  width: number
  height: number
  base: number
}
const layoutCache = new WeakMap<PaperParagraph[], { scale: number; map: Map<number, BlockRect> }>()

function solveLayout(paras: PaperParagraph[], s: number): Map<number, BlockRect> {
  const hit = layoutCache.get(paras)
  if (hit && Math.abs(hit.scale - s) < 1e-4) return hit.map
  const pageH = baseDims.value.h
  const pageW = baseDims.value.w * s
  const rects = paras
    .filter(p => p.bbox)
    .map(p => ({
      id: p.id,
      left: p.bbox!.x * s,
      top: (pageH - p.bbox!.y - p.bbox!.h) * s,
      width: p.bbox!.w * s,
      height: p.bbox!.h * s,
      base: Math.max(8, Math.min(26, (p.fontSize ?? 10) * s)),
    }))
  const groups: Record<string, typeof rects> = { L: [], R: [], full: [] }
  for (const r of rects) {
    const key = r.width > pageW * 0.6 ? 'full' : r.left + r.width / 2 < pageW / 2 ? 'L' : 'R'
    groups[key].push(r)
  }
  for (const key of ['L', 'R', 'full']) {
    const arr = groups[key].sort((a, b) => a.top - b.top)
    for (let i = 0; i < arr.length - 1; i++) {
      const cur = arr[i]
      const next = arr[i + 1]
      if (cur.top + cur.height > next.top - 2) cur.height = Math.max(10, next.top - 2 - cur.top)
    }
  }
  const map = new Map(rects.map(r => [r.id, r]))
  layoutCache.set(paras, { scale: s, map })
  return map
}

/** 按容量预计算字号: 中文按 1 字宽、拉丁按 0.52 估算, 使文本恰好放进框 */
function fitFont(text: string, w: number, h: number, base: number) {
  let eff = 0
  for (const ch of text) eff += ch.charCodeAt(0) > 0x2e00 ? 1 : 0.52
  eff = Math.max(eff, 1)
  let f = Math.min(base, Math.sqrt((w * h) / (1.36 * eff)))
  for (let i = 0; i < 10; i++) {
    const cap = Math.max(1, Math.floor(w / f)) * Math.max(1, Math.floor(h / (f * 1.34)))
    if (cap >= eff * 1.04) break
    f *= 0.95
  }
  return Math.max(7, f)
}

interface MirBlock {
  id: number
  text: string
  orig: boolean
  style: Record<string, string>
}

/** 某页已译几何段落 → 定位好的对照块 */
function blocksOf(n: number): MirBlock[] {
  const d = mirData.value[n]
  if (!d || !d.trs.some(Boolean)) return []
  const map = solveLayout(d.paras, mirScale.value)
  const out: MirBlock[] = []
  for (const p of d.paras) {
    if (!p.bbox) continue
    const tr = trText(d, p.id)
    if (!tr) continue
    const r = map.get(p.id)
    if (!r) continue
    const orig = showOrig.value.has(`${n}:${p.id}`)
    const text = orig ? origText(p) : tr
    out.push({
      id: p.id,
      text,
      orig,
      style: {
        left: `${r.left}px`,
        top: `${r.top}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
        fontSize: `${fitFont(text, r.width, r.height, r.base)}px`,
      },
    })
  }
  return out
}

/** 兜底微调: 预计算字号后仍溢出的个别块 (换行低效) 再小步递减 */
let fitQueued = false
function queueFit() {
  if (fitQueued) return
  fitQueued = true
  nextTick(() =>
    requestAnimationFrame(() => {
      fitQueued = false
      const host = mirScroller.value
      if (!host) return
      for (const el of Array.from(host.querySelectorAll<HTMLElement>('.pm-block'))) {
        let size = parseFloat(el.style.fontSize || '12')
        let guard = 6
        while (guard-- > 0 && size > 7 && el.scrollHeight > el.clientHeight + 2) {
          size *= 0.95
          el.style.fontSize = `${size}px`
        }
      }
    }),
  )
}
watch([mirData, showOrig], queueFit)

function setMode(mode: 'mirror' | 'cards') {
  viewMode.value = mode
  localStorage.setItem(VIEW_KEY, mode)
  if (mode === 'mirror') nextTick(() => mirLayoutNow())
}

function toggleBlock(n: number, id: number) {
  // 划词选择时不触发切换
  if (window.getSelection()?.toString()) return
  const key = `${n}:${id}`
  const next = new Set(showOrig.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  showOrig.value = next
}

/** 段落提取 (按页缓存), 顺带装入已缓存的译文 */
async function ensureParas(page: number): Promise<MirPageData> {
  const cur = mirData.value[page]
  if (cur) return cur
  const d: MirPageData = { paras: [], trs: [] }
  try {
    // 段落几何提取: PDFium 字符流合成 runs → 既有聚类管线
    const dims = dimensionsOf(page)
    const items = pdm ? textRuns(pdm.text(page - 1), dims.h) : []
    d.paras = extractParagraphsFromItems(items, dims.w)
    // 严格算法无结果时宽松兜底: 只要页面有文字就切得出块
    if (!d.paras.length) d.paras = extractParagraphsLooseFromItems(items)
  } catch (e: any) {
    console.error('paragraph extraction failed:', e)
    d.err = String(e?.message ?? e).slice(0, 160)
  }
  d.trs = new Array(d.paras.length).fill('')
  const cached = cachedTranslation(bookId, page, d.paras.length)
  if (cached) d.trs = cached
  mirData.value = { ...mirData.value, [page]: d }
  return d
}

/* ================= PDF 流式阅读：文本层重排为单栏正文 ================= */

interface ReflowParagraph {
  id: number
  text: string
  fontSize: number
}

interface ReflowPage {
  page: number
  paras: ReflowParagraph[]
}

const reflowScroller = ref<HTMLElement>()
const reflowPages = ref<ReflowPage[]>([])
const reflowBuilding = ref(false)
const reflowBuilt = ref(false)
const reflowProcessed = ref(0)
const reflowError = ref('')
const reflowBodyFont = ref(10)
const typographyOpen = ref(false)
let reflowBuildPromise: Promise<void> | null = null
let reflowSession = 0
let reflowScrollScheduled = false

const reflowStyle = computed<Record<string, string>>(() => {
  const colors = READER_THEMES[settings.reader.theme]
  return {
    '--reflow-bg': colors.bg,
    '--reflow-fg': colors.fg,
    '--reflow-link': colors.link,
    '--reflow-font-size': `${settings.reader.fontSize}px`,
    '--reflow-line-height': String(settings.reader.lineHeight),
    '--reflow-font-family': resolveFontFamily(settings.reader.fontFamily) || 'inherit',
    '--reflow-align': settings.reader.justify ? 'justify' : 'start',
    '--reflow-side-pad': `${Math.max(2, settings.reader.gap)}%`,
  }
})

function isReflowHeading(p: ReflowParagraph): boolean {
  return p.text.length <= 180 && p.fontSize >= reflowBodyFont.value * 1.28
}

async function ensureReflowFont() {
  const m = settings.reader.fontFamily.match(/^custom:(.+)$/)
  const font = m ? settings.customFonts.find(f => f.name === m[1]) : undefined
  if (font) await injectFontIntoDoc(document, font)
}

watch(
  () => [pdfLayout.value, settings.reader.fontFamily] as const,
  ([layout]) => {
    if (layout === 'reflow') void ensureReflowFont()
  },
)

async function buildReflow() {
  const session = ++reflowSession
  reflowBuilding.value = true
  reflowError.value = ''
  reflowProcessed.value = 0
  const pages: ReflowPage[] = []
  const sizes: number[] = []
  try {
    for (let page = 1; page <= pageCount.value; page++) {
      const data = await ensureParas(page)
      if (session !== reflowSession) return
      const paras = data.paras
        .map(p => ({
          id: p.id,
          text: origText(p),
          fontSize: p.fontSize ?? 10,
        }))
        .filter(p => p.text.trim())
      if (paras.length) {
        pages.push({ page, paras })
        sizes.push(...paras.map(p => p.fontSize).filter(Boolean))
      }
      reflowProcessed.value = page
      if (page % 4 === 0) {
        reflowPages.value = [...pages]
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
    }
    sizes.sort((a, b) => a - b)
    reflowBodyFont.value = sizes[Math.floor(sizes.length / 2)] || 10
    reflowPages.value = pages
    reflowBuilt.value = true
    await ensureReflowFont()
  } catch (e: any) {
    console.error('reflow extraction failed:', e)
    reflowError.value = String(e?.message ?? e).slice(0, 200)
  } finally {
    if (session === reflowSession) reflowBuilding.value = false
  }
}

function ensureReflow(): Promise<void> {
  if (reflowBuilt.value) return Promise.resolve()
  if (!reflowBuildPromise) {
    reflowBuildPromise = buildReflow().finally(() => {
      reflowBuildPromise = null
    })
  }
  return reflowBuildPromise
}

function reflowPageAtCenter(): number {
  const el = reflowScroller.value
  if (!el) return currentPage.value
  const anchor = el.scrollTop + el.clientHeight * 0.32
  let page = reflowPages.value[0]?.page ?? currentPage.value
  for (const section of Array.from(el.querySelectorAll<HTMLElement>('[data-reflow-page]'))) {
    if (section.offsetTop > anchor) break
    page = Number(section.dataset.reflowPage) || page
  }
  return page
}

function onReflowScroll() {
  if (reflowScrollScheduled) return
  reflowScrollScheduled = true
  requestAnimationFrame(() => {
    reflowScrollScheduled = false
    const page = reflowPageAtCenter()
    if (page !== currentPage.value) currentPage.value = page
  })
}

function reflowGoto(n: number, smooth = false) {
  const el = reflowScroller.value
  if (!el || !reflowPages.value.length) return
  const clamped = Math.min(Math.max(1, n || 1), pageCount.value)
  const target = reflowPages.value.find(p => p.page >= clamped) ?? reflowPages.value.at(-1)
  if (!target) return
  const section = el.querySelector<HTMLElement>(`[data-reflow-page="${target.page}"]`)
  if (!section) return
  el.scrollTo({ top: Math.max(0, section.offsetTop - 24), behavior: smooth ? 'smooth' : 'auto' })
  currentPage.value = target.page
}

function reflowStep(direction: -1 | 1) {
  const pages = reflowPages.value
  if (!pages.length) return
  let index = pages.findIndex(p => p.page >= currentPage.value)
  if (index < 0) index = pages.length - 1
  const target = pages[Math.min(Math.max(0, index + direction), pages.length - 1)]
  reflowGoto(target.page, true)
}

async function switchPdfLayout(next: 'original' | 'reflow') {
  if (pdfLayout.value === next) return
  const targetPage = currentPage.value
  stopAutoRead()
  selection.value = null
  closeSelTr()
  zoomMenu.value = false
  shortcutsOpen.value = false
  typographyOpen.value = false
  backStack.value = []
  forwardStack.value = []
  settings.pdf.layout = next
  renderedScale.clear()
  await nextTick()
  if (next === 'reflow') {
    void ensureReflow().then(() => {
      if (pdfLayout.value === 'reflow') nextTick(() => reflowGoto(targetPage))
    })
    reflowGoto(targetPage)
  } else if (bookPaged.value) {
    await pagedGoto(targetPage)
  } else {
    attachScrollListener()
    scrollGoto(targetPage)
    updateViewport()
  }
  observeActiveViewport()
}

async function openOriginalPage(page: number) {
  currentPage.value = page
  await switchPdfLayout('original')
}

/* ---- 对照视图: 连续滚动 (虚拟化渲染 + 停稳翻译) ---- */

function mirHolderOf(n: number) {
  return mirScroller.value?.querySelector<HTMLElement>(`[data-mp="${n}"]`) ?? null
}

async function renderMirPage(n: number) {
  if (!pdm || n < 1 || n > pageCount.value || mirRendering.has(n)) return
  const holder = mirHolderOf(n)
  if (!holder) return
  const s = mirScale.value
  if (mirRendered.get(n) === s) return
  mirRendering.add(n)
  try {
    const canvas = await renderBitmapCanvas(n, s)
    if (s !== mirScale.value) return
    holder.querySelector('.mp-canvas')?.replaceChildren(canvas)
    mirRendered.set(n, s)
  } finally {
    mirRendering.delete(n)
  }
}

function mirEvict(center: number) {
  for (const n of [...mirRendered.keys()]) {
    if (Math.abs(n - center) > KEEP) {
      mirHolderOf(n)?.querySelector('.mp-canvas')?.replaceChildren()
      mirRendered.delete(n)
    }
  }
}

function mirPageAtCenter(): number {
  const el = mirScroller.value
  if (!el || !mirHolderH.value) return 1
  const center = el.scrollTop + el.clientHeight / 2 - MIR_PAD
  const idx = Math.floor(center / (mirHolderH.value + MIR_GAP))
  return Math.min(Math.max(idx + 1, 1), pageCount.value)
}

function updateMirViewport() {
  const cur = mirPageAtCenter()
  if (cur !== mirCur.value) mirCur.value = cur
  for (let i = cur - 1; i <= cur + 2; i++) renderMirPage(i)
  mirEvict(cur)
}

function onMirScroll() {
  if (mirScrollScheduled) return
  mirScrollScheduled = true
  requestAnimationFrame(() => {
    mirScrollScheduled = false
    updateMirViewport()
  })
}

watch(mirCur, () => {
  expanded.value = new Set()
  clearTimeout(mirSettleTimer)
  mirSettleTimer = setTimeout(mirSettled, 600)
})

/** 对照视图滚动停稳: 提取当前页段落并翻译 (缓存优先; 面板打开即视为翻译授权) */
async function mirSettled() {
  if (!translateOpen.value) return
  const p = mirCur.value
  await ensureParas(p)
  queueFit()
  if (aiReady.value) runTranslateFor(p)
}

function mirGoto(n: number) {
  const clamped = Math.min(Math.max(1, n || 1), pageCount.value)
  mirScroller.value?.scrollTo({ top: Math.max(0, MIR_PAD + (clamped - 1) * (mirHolderH.value + MIR_GAP)) })
}

/** 重算对照缩放 (适宽), 保持当前页锚点 */
function mirLayoutNow() {
  const el = mirScroller.value
  if (!el) return
  const next = Math.min(Math.max((el.clientWidth - 40) / baseDims.value.w, 0.2), 2.5)
  const anchor = mirCur.value
  if (Math.abs(next - mirScale.value) > 1e-4) {
    mirScale.value = next
    mirRendered.clear()
  }
  nextTick(() => {
    mirGoto(anchor)
    updateMirViewport()
    queueFit()
  })
}

/** 右栏: 翻译 / AI 辅读 / 问答, 点击才展开, 打开论文默认纯 PDF 阅读 */
const rightTab = ref<'translate' | 'ai' | 'chat' | null>(null)
const translateOpen = computed(() => rightTab.value === 'translate')

/* ---- 分栏拖拽: 右栏宽度可调, 持久化 ---- */
const RIGHTW_KEY = 'lightread-paper-rightw'
const rightW = ref(parseFloat(localStorage.getItem(RIGHTW_KEY) ?? '') || 0)
const rightPaneStyle = computed(() =>
  rightW.value > 0 ? { flex: `0 0 ${rightW.value}px` } : { flex: '0 0 42%' },
)

function startSplit(e: PointerEvent) {
  const split = e.currentTarget as HTMLElement
  const container = split.parentElement!
  split.setPointerCapture(e.pointerId)
  const move = (ev: PointerEvent) => {
    const rect = container.getBoundingClientRect()
    rightW.value = Math.min(Math.max(rect.right - ev.clientX, 300), rect.width * 0.75)
  }
  const up = () => {
    split.removeEventListener('pointermove', move)
    split.removeEventListener('pointerup', up)
    localStorage.setItem(RIGHTW_KEY, String(Math.round(rightW.value)))
  }
  split.addEventListener('pointermove', move)
  split.addEventListener('pointerup', up)
}

async function openRight(tab: 'translate' | 'ai' | 'chat') {
  if (rightTab.value === tab) return closeRight()
  const wasOpen = rightTab.value !== null
  cancelTranslate()
  rightTab.value = tab
  await nextTick()
  if (!wasOpen) {
    // 面板挂载后左栏变窄, 重排原文页
    relayout(true)
    if (rightPane.value) resizeObserver?.observe(rightPane.value)
  }
  if (tab === 'translate') {
    // 对照视图: 独立连续滚动, 打开时跳到左栏当前页
    mirScroller.value?.addEventListener('scroll', onMirScroll, { passive: true })
    if (mirScroller.value) resizeObserver?.observe(mirScroller.value)
    mirCur.value = currentPage.value
    mirLayoutNow()
    nextTick(() => {
      mirGoto(currentPage.value)
      updateMirViewport()
      mirSettled()
    })
  } else if (tab === 'ai') {
    initAiPanel()
  }
}

function closeRight() {
  cancelTranslate()
  cancelAi()
  rightTab.value = null
  nextTick(() => relayout(true))
}

function cancelTranslate() {
  translateSession++
  translatingPage.value = 0
}

/** 翻译某页 (缓存/已译则跳过; force 重译) */
async function runTranslateFor(page: number, force = false) {
  const d = await ensureParas(page)
  if (!d.paras.length) return
  if (!force && d.trs.some(Boolean)) return
  if (!aiReady.value) return
  const session = ++translateSession
  translatingPage.value = page
  try {
    await translatePage(
      bookId,
      page,
      d.paras.map(p => p.text),
      snapshot => {
        if (session === translateSession) {
          mirData.value = { ...mirData.value, [page]: { ...d, trs: snapshot } }
        }
      },
      () => session !== translateSession,
    )
  } catch (e: any) {
    if (session === translateSession) {
      toast(`${t('paper.translateFailed')}: ${e?.message ?? e}`, 'error', 6000)
    }
  } finally {
    if (session === translateSession) translatingPage.value = 0
  }
}

function toggleOriginal(id: number) {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

/* ================= AI 辅读: 总结 / 论文十问 / 问答 =================
 * 点击才生成 (不自动消耗用量), 流式输出, 可取消; 总结与十问按论文缓存。 */

const doc = ref<DocText | null>(null)
const docParsing = ref(false)
const aiSummary = ref('')
const summaryBusy = ref(false)
const tenQs = TEN_QUESTIONS()
const tenA = ref<string[]>(Array(10).fill(''))
/** 正在生成的题号, -1 表示无 */
const tenBusy = ref(-1)
const openQ = ref<Set<number>>(new Set())
const chatMsgs = ref<AiMessage[]>([])
const chatInput = ref('')
const chatBusy = ref(false)
/** 独立取消会话: 总结/十问/问答互不干扰, 新动作不打断进行中的其他生成 */
const aiSes = { sum: 0, ten: 0, chat: 0 }

const answeredCount = computed(() => tenA.value.filter(Boolean).length)

function initAiPanel() {
  aiSummary.value = cachedAi(bookId, 's') ?? ''
  tenA.value = Array.from({ length: 10 }, (_, i) => cachedAi(bookId, `q${i}`) ?? '')
}

function cancelAi() {
  aiSes.sum++
  aiSes.ten++
  aiSes.chat++
  summaryBusy.value = false
  tenBusy.value = -1
  chatBusy.value = false
}

/** 首次使用时解析全文文本 (PDFium, 超预算截断), 后续复用 */
async function ensureDoc(): Promise<DocText | null> {
  if (doc.value) return doc.value
  docParsing.value = true
  try {
    let text = ''
    let truncated = false
    for (let n = 1; n <= pageCount.value; n++) {
      const pageText = await pageTextFor(n)
      if (pageText) text += (text ? '\n\n' : '') + `[Page ${n}] ` + pageText
      if (text.length >= DOC_CHAR_BUDGET) {
        text = text.slice(0, DOC_CHAR_BUDGET)
        truncated = n < pageCount.value
        break
      }
    }
    doc.value = { text, truncated }
    if (truncated) toast(t('paper.aiTruncated'))
    return doc.value
  } catch (e: any) {
    toast(String(e?.message ?? e).slice(0, 200), 'error')
    return null
  } finally {
    docParsing.value = false
  }
}

async function runSummary(force = false) {
  if (!force && aiSummary.value) return
  const d = await ensureDoc()
  if (!d || !meta.value) return
  const session = ++aiSes.sum
  summaryBusy.value = true
  aiSummary.value = ''
  try {
    const text = await askDoc(
      buildDocSystem(meta.value.title, d),
      [],
      SUMMARY_PROMPT,
      full => {
        if (session === aiSes.sum) aiSummary.value = full
      },
      () => session !== aiSes.sum,
    )
    if (session === aiSes.sum && text) saveAi(bookId, 's', text)
  } catch (e: any) {
    if (session === aiSes.sum) toast(`${t('paper.aiFailed')}: ${e?.message ?? e}`, 'error', 6000)
  } finally {
    if (session === aiSes.sum) summaryBusy.value = false
  }
}

function toggleQ(i: number) {
  const next = new Set(openQ.value)
  if (next.has(i)) next.delete(i)
  else next.add(i)
  openQ.value = next
}

async function runQuestion(i: number) {
  const d = await ensureDoc()
  if (!d || !meta.value) return
  const session = ++aiSes.ten
  tenBusy.value = i
  tenA.value[i] = ''
  openQ.value = new Set(openQ.value).add(i)
  try {
    const text = await askDoc(
      buildDocSystem(meta.value.title, d),
      [],
      `请回答关于这篇论文的问题: ${tenQs[i]}`,
      full => {
        if (session === aiSes.ten) tenA.value[i] = full
      },
      () => session !== aiSes.ten,
    )
    if (session === aiSes.ten && text) saveAi(bookId, `q${i}`, text)
  } catch (e: any) {
    if (session === aiSes.ten) toast(`${t('paper.aiFailed')}: ${e?.message ?? e}`, 'error', 6000)
  } finally {
    if (session === aiSes.ten) tenBusy.value = -1
  }
}

/** 问答 agent: 在论文语境上允许结合领域知识展开, 但要求区分论文内外 */
function chatSystem(d: DocText): string {
  return (
    buildDocSystem(meta.value?.title ?? '', d) +
    '\n\n作为论文问答助手, 你可以结合领域常识补充背景与延伸, 但必须区分哪些来自论文原文、哪些是你的补充。'
  )
}

function clearChat() {
  aiSes.chat++
  chatBusy.value = false
  chatMsgs.value = []
}

/** 消息区自动滚到最新 (流式输出期间持续跟随) */
const chatScroll = ref<HTMLElement>()
watch(
  chatMsgs,
  () => nextTick(() => {
    const el = chatScroll.value
    if (el) el.scrollTop = el.scrollHeight
  }),
  { deep: true },
)

function quickAsk(q: string) {
  chatInput.value = q
  sendChat()
}

async function sendChat() {
  const q = chatInput.value.trim()
  if (!q || chatBusy.value) return
  const d = await ensureDoc()
  if (!d || !meta.value) return
  chatInput.value = ''
  // 既往轮次做上下文 (排除流式中的空占位), 控制长度
  const history = chatMsgs.value.filter(m => m.content).slice(-12)
  chatMsgs.value.push({ role: 'user', content: q }, { role: 'assistant', content: '' })
  const idx = chatMsgs.value.length - 1
  const session = ++aiSes.chat
  chatBusy.value = true
  try {
    await askDoc(
      chatSystem(d),
      history,
      q,
      full => {
        if (session === aiSes.chat) chatMsgs.value[idx].content = full
      },
      () => session !== aiSes.chat,
    )
  } catch (e: any) {
    if (session === aiSes.chat && !chatMsgs.value[idx].content) {
      chatMsgs.value[idx].content = `⚠ ${String(e?.message ?? e).slice(0, 200)}`
    }
  } finally {
    if (session === aiSes.chat) chatBusy.value = false
  }
}

/* ---- BabelDOC 整本重排版翻译 ---- */
type BdPhase = 'checking' | 'notfound' | 'ready' | 'running' | 'done' | 'error'
const bdSupported = babeldocSupported()
const bd = ref<{
  open: boolean
  phase: BdPhase
  status?: BabeldocStatus
  pages: string
  percent: number | null
  line: string
  stage?: string
  current?: number
  total?: number
  error: string
  results: Array<{ id: string; label: string }>
}>({ open: false, phase: 'checking', pages: '', percent: null, line: '', error: '', results: [] })
const bdProviderOk = computed(() => babeldocUsableProvider())
let bdUnlisten: (() => void) | undefined

/** 长任务反馈: 已用时长计时 + 引擎启动占位文案 */
const bdElapsed = ref(0)
let bdTimer: ReturnType<typeof setInterval> | undefined
const bdElapsedText = computed(() => {
  const m = Math.floor(bdElapsed.value / 60)
  const s = bdElapsed.value % 60
  return `${m}:${String(s).padStart(2, '0')}`
})
const bdLineText = computed(() => {
  if (bd.value.line === 'engine starting' || !bd.value.line) return t('paper.bdStarting')
  if (bd.value.stage) {
    const counts =
      bd.value.total && bd.value.total > 1 ? ` ${bd.value.current ?? 0}/${bd.value.total}` : ''
    return stageLabel(bd.value.stage) + counts
  }
  return bd.value.line
})

async function openBabeldoc() {
  bd.value = { open: true, phase: 'checking', pages: '', percent: null, line: '', error: '', results: [] }
  const st = await babeldocStatus().catch(() => ({ found: false, path: '', version: '' }))
  bd.value.status = st
  bd.value.phase = st.found ? 'ready' : 'notfound'
}

async function startBabeldoc() {
  if (!meta.value) return
  bd.value.phase = 'running'
  bd.value.percent = null
  bd.value.line = ''
  bd.value.error = ''
  bdElapsed.value = 0
  const startAt = Date.now()
  clearInterval(bdTimer)
  bdTimer = setInterval(() => {
    bdElapsed.value = Math.floor((Date.now() - startAt) / 1000)
  }, 1000)
  bdUnlisten = await onBabeldocProgress(p => {
    if (p.percent != null) bd.value.percent = p.percent
    bd.value.line = p.line
    bd.value.stage = p.stage ?? undefined
    bd.value.current = p.current ?? undefined
    bd.value.total = p.total ?? undefined
  })
  try {
    const path = await bookFilePath(bookId, meta.value.fileName)
    const outputs = await babeldocTranslate(path, bd.value.pages)
    const results: Array<{ id: string; label: string }> = []
    for (const out of outputs) {
      const label = out.includes('.dual.') ? t('paper.bdDual') : t('paper.bdMono')
      const blob = await babeldocReadOutput(out)
      const title = `${meta.value.title} · ${label}`
      const file = new File([blob], `${title}.pdf`, { type: 'application/pdf' })
      // 译本归属跟随原文档 (藏书 PDF 的译本进藏书)
      const r = await importFile(file, 'BabelDOC', { kind: isPaper.value ? 'paper' : 'book', title })
      if (r.ok && r.bookId) results.push({ id: r.bookId, label })
    }
    await library.refresh()
    bd.value.results = results
    bd.value.phase = 'done'
  } catch (e: any) {
    bd.value.error = String(e?.message ?? e).slice(0, 300)
    bd.value.phase = bd.value.error === '已取消' ? 'ready' : 'error'
  } finally {
    clearInterval(bdTimer)
    bdTimer = undefined
    bdUnlisten?.()
    bdUnlisten = undefined
  }
}

function cancelBabeldoc() {
  babeldocCancel().catch(() => {})
}

function openResult(id: string) {
  // 同路由参数变化不触发重挂载, 直接整页刷新到目标论文
  window.location.hash = `#/read-paper/${id}`
  window.location.reload()
}

function copyInstall() {
  navigator.clipboard?.writeText(INSTALL_CMD).then(() => toast(t('paper.bdCopied')))
}

/* ================= 读书功能集 (藏书 PDF): 听书 / 自动翻页 ================= */

/** 页文本 (听书 / AI 上下文) */
async function pageTextFor(n: number): Promise<string> {
  return pdm ? pdm.pageText(n - 1).replace(/\s+/g, ' ').trim() : ''
}

/* ---- 自动阅读：翻页模式按页前进，滚动模式连续下移 ---- */
const autoReading = ref(false)
const autoPanel = ref(false)
let autoPageTimer: ReturnType<typeof setInterval> | undefined
let autoScrollFrame: number | undefined
let autoScrollAt = 0
let autoPanelTimer: ReturnType<typeof setTimeout> | undefined

function cancelAutoPanelCollapse() {
  clearTimeout(autoPanelTimer)
  autoPanelTimer = undefined
}

/** 自动阅读运行时，控制条短暂展示反馈后收起到顶部状态按钮。 */
function scheduleAutoPanelCollapse(delay = 1800) {
  cancelAutoPanelCollapse()
  if (!autoReading.value || !autoPanel.value) return
  autoPanelTimer = setTimeout(() => {
    autoPanel.value = false
    autoPanelTimer = undefined
  }, delay)
}

function collapseAutoPanel() {
  cancelAutoPanelCollapse()
  autoPanel.value = false
}

function toggleAutoPanel() {
  if (autoPanel.value) {
    collapseAutoPanel()
    return
  }
  autoPanel.value = true
  ttsPanel.value = false
  if (autoReading.value) scheduleAutoPanelCollapse(4000)
}

function stepAutoScroll(now: number) {
  if (!autoReading.value || bookPaged.value) return
  const el = pdfLayout.value === 'reflow' ? reflowScroller.value : scroller.value
  if (!el) {
    stopAutoRead()
    return
  }

  const maxTop = Math.max(0, el.scrollHeight - el.clientHeight)
  if (el.scrollTop >= maxTop - 1) {
    el.scrollTop = maxTop
    stopAutoRead()
    return
  }

  // “秒/页”在连续模式中换算为每秒滚动一个页面高度的速度。
  const elapsed = Math.min(Math.max(0, now - autoScrollAt), 100)
  const stepHeight = pdfLayout.value === 'reflow' ? el.clientHeight : holderH.value + GAP
  const pixelsPerMs = stepHeight / (settings.autoReadSeconds * 1000)
  autoScrollAt = now
  el.scrollTop = Math.min(maxTop, el.scrollTop + elapsed * pixelsPerMs)
  autoScrollFrame = requestAnimationFrame(stepAutoScroll)
}

function startAutoRead() {
  stopAutoRead()
  autoReading.value = true
  if (bookPaged.value) {
    autoPageTimer = setInterval(() => {
      if (atLastPage.value) {
        stopAutoRead()
        return
      }
      nextPage()
    }, settings.autoReadSeconds * 1000)
  } else {
    autoScrollAt = performance.now()
    autoScrollFrame = requestAnimationFrame(stepAutoScroll)
  }
  scheduleAutoPanelCollapse()
}

function stopAutoRead() {
  autoReading.value = false
  clearInterval(autoPageTimer)
  autoPageTimer = undefined
  if (autoScrollFrame != null) cancelAnimationFrame(autoScrollFrame)
  autoScrollFrame = undefined
  autoScrollAt = 0
  cancelAutoPanelCollapse()
}

watch(() => settings.autoReadSeconds, () => {
  if (autoReading.value) startAutoRead()
})

/* ---- 听书 (Edge 在线 / 本地离线 / 系统语音) ---- */
const ttsPanel = ref(false)
const ttsState = ref<'stopped' | 'playing' | 'paused'>('stopped')
const ttsVoices = ref<{ name: string; lang: string }[]>([])
let ttsSession = 0

/** 长文本按标点切块, 避免超长 utterance 在部分引擎上卡死 */
function splitChunks(text: string, max = 400): string[] {
  const chunks: string[] = []
  let rest = text
  while (rest.length > max) {
    let cut = -1
    for (const re of [/[。！？.!?][^。！？.!?]*$/, /[；;，,][^；;，,]*$/, /\s\S*$/]) {
      const m = rest.slice(0, max).match(re)
      if (m && m.index != null && m.index > max * 0.3) {
        cut = m.index + 1
        break
      }
    }
    if (cut <= 0) cut = max
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest.trim()) chunks.push(rest)
  return chunks
}

const waitWhilePaused = async () => {
  while (ttsState.value === 'paused') await new Promise(r => setTimeout(r, 200))
}
/** await 期间状态可能被外部修改, 用函数取值绕开 TS 控制流收窄 */
const ttsStopped = () => ttsState.value === 'stopped'

const localInstalled = ref(false)
const localDownloading = ref(false)
const localProgress = ref('')

async function refreshLocalStatus() {
  if (!localTtsAvailable()) return
  try {
    localInstalled.value = (await localTtsStatus()).installed
  } catch {
    localInstalled.value = false
  }
}

async function downloadLocal() {
  localDownloading.value = true
  localProgress.value = t('common.connecting')
  try {
    await localTtsDownload(p => {
      localProgress.value = p.phase === 'extracting'
        ? t('reader.extracting')
        : `${(p.downloaded / 1048576).toFixed(0)}MB${p.total ? ' / ' + (p.total / 1048576).toFixed(0) + 'MB' : ''}`
    })
    localInstalled.value = true
    toast(t('tts.localReady'), 'success')
  } catch (e: any) {
    toast(t('tts.localDownloadFailed', { msg: e?.message ?? e }), 'error', 6000)
  } finally {
    localDownloading.value = false
  }
}

async function auditionLocal() {
  try {
    await playAudio(await localTtsSynthesize(t('tts.sampleText'), settings.localVoiceId, settings.ttsRate))
  } catch (e: any) {
    toast(e?.message ?? t('tts.auditionFailed'), 'error')
  }
}

async function openTTSPanel() {
  ttsPanel.value = !ttsPanel.value
  if (ttsPanel.value) {
    autoPanel.value = false
    refreshLocalStatus()
    if (!ttsVoices.value.length) {
      ttsVoices.value = (await listVoicesSorted()).map(v => ({ name: v.name, lang: v.lang }))
    }
  }
}

async function startTTS() {
  const session = ++ttsSession
  stopSpeech()
  resetEdgeFailure()
  stopAutoRead()
  ttsState.value = 'playing'
  try {
    let pageNum = currentPage.value
    let spokeAnything = false
    while (session === ttsSession && !ttsStopped() && pageNum <= pageCount.value) {
      const text = await pageTextFor(pageNum)
      if (text) {
        spokeAnything = true
        const chunks = splitChunks(text)
        for (let ci = 0; ci < chunks.length; ci++) {
          await waitWhilePaused()
          if (session !== ttsSession || ttsStopped()) return
          if (chunks[ci + 1]) prefetchSpeech(chunks[ci + 1])
          await speakText(chunks[ci])
        }
      }
      if (session !== ttsSession || ttsStopped()) return
      pageNum++
      if (pageNum > pageCount.value) break
      gotoPage(pageNum)
      await new Promise(r => setTimeout(r, 300))
    }
    if (!spokeAnything && session === ttsSession) {
      toast(t('tts.pdfNoText'), 'error', 4000)
    }
  } catch (e) {
    console.error(e)
    toast(t('tts.error'), 'error')
  }
  if (session === ttsSession) ttsState.value = 'stopped'
}

function pauseTTS() {
  ttsState.value = 'paused'
  pauseSpeech()
}

function resumeTTS() {
  ttsState.value = 'playing'
  resumeSpeech()
}

function stopTTS() {
  ttsSession++
  ttsState.value = 'stopped'
  stopSpeech()
}

/* ================= 生命周期 ================= */

function originalViewport(): HTMLElement | undefined {
  return bookPaged.value ? pagedBox.value : scroller.value
}

function scrollViewportBy(dx: number, dy: number): boolean {
  const viewport = pdfLayout.value === 'reflow' ? reflowScroller.value : originalViewport()
  if (!viewport) return false
  const left = viewport.scrollLeft
  const top = viewport.scrollTop
  viewport.scrollBy({ left: dx, top: dy })
  return Math.abs(viewport.scrollLeft - left) > 0.5 || Math.abs(viewport.scrollTop - top) > 0.5
}

function scrollByScreen(dir: 1 | -1) {
  const viewport = pdfLayout.value === 'reflow' ? reflowScroller.value : originalViewport()
  if (!viewport) return
  const moved = scrollViewportBy(0, dir * Math.max(80, viewport.clientHeight * 0.88))
  if (bookPaged.value && !moved) {
    if (dir > 0) nextPage()
    else prevPage()
  }
}

function cycleFitMode() {
  void applyZoom(zoom.value === 'fit-page' ? 'fit-width' : 'fit-page')
}

function handleKeydown(e: KeyboardEvent) {
  const primaryPressed = e.metaKey || e.ctrlKey
  if (e.key === 'Escape' && (presentationMode.value || isFullscreen.value)) {
    e.preventDefault()
    if (presentationMode.value) void exitPresentation()
    else void setFullscreen(false)
    return
  }
  if (primaryPressed && !e.altKey && e.key.toLowerCase() === 'p') {
    e.preventDefault()
    void printDocument()
    return
  }
  if (primaryPressed && e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
    e.preventDefault()
    void saveDocumentAs()
    return
  }
  if (primaryPressed && !e.altKey && e.key.toLowerCase() === 'f') {
    e.preventDefault()
    openPdfSearch()
    return
  }
  if (e.key === 'F3') {
    e.preventDefault()
    if (!pdfSearchOpen.value) openPdfSearch()
    if (pdfSearchResults.value.length) {
      void activatePdfSearchHit(pdfSearchActive.value + (e.shiftKey ? -1 : 1))
    }
    return
  }
  if (e.altKey && !primaryPressed && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault()
    if (e.key === 'ArrowLeft') goBack()
    else goForward()
    return
  }
  const zoomInKey = e.key === '+' || e.key === '=' || e.code === 'Equal' || e.code === 'NumpadAdd'
  const zoomOutKey = e.key === '-' || e.key === '_' || e.code === 'Minus' || e.code === 'NumpadSubtract'
  if (primaryPressed && !e.altKey && (zoomInKey || zoomOutKey)) {
    e.preventDefault()
    if (zoomInKey) changeReaderZoom(1)
    else changeReaderZoom(-1)
    return
  }
  if (primaryPressed && !e.altKey && ['0', '1', '2'].includes(e.key)) {
    e.preventDefault()
    if (pdfLayout.value === 'reflow') {
      if (e.key === '0') resetReaderZoom()
    } else if (e.key === '0') {
      void applyZoom('fit-page')
    } else if (e.key === '1') {
      void applyZoom(1)
    } else {
      void applyZoom('fit-width')
    }
    return
  }
  if (primaryPressed && !e.altKey && ['6', '7', '8'].includes(e.key) && !isPaper.value) {
    e.preventDefault()
    const next = e.key === '6' ? 'single' : e.key === '7' ? 'facing' : 'book'
    void (async () => {
      if (pdfLayout.value === 'reflow') await switchPdfLayout('original')
      if (mode.value !== 'paged') await switchMode('paged')
      await setSpreadMode(next)
    })()
    return
  }
  if (primaryPressed && !e.altKey && e.key.toLowerCase() === 'g') {
    e.preventDefault()
    const input = paperRoot.value?.querySelector<HTMLInputElement>('.page-input')
    input?.focus()
    input?.select()
    return
  }
  if (primaryPressed && !e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault()
    scrollByScreen(e.key === 'ArrowDown' ? 1 : -1)
    return
  }

  if (pdfSearchOpen.value && e.key === 'Escape') {
    e.preventDefault()
    closePdfSearch()
    return
  }
  const target = e.target instanceof HTMLElement ? e.target : null
  if (target?.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')) return
  if (e.metaKey || e.ctrlKey || e.altKey) return
  if (e.key === 'Escape') {
    selection.value = null
    liveSel.value = null
    dragSel = null
    activeAnnotation.value = null
    closeSelTr()
    closeDrawer()
    zoomMenu.value = false
    typographyOpen.value = false
    shortcutsOpen.value = false
    stopAutoRead()
    autoPanel.value = false
    return
  }
  if (e.key === '?' || (e.shiftKey && (e.key === '/' || e.code === 'Slash'))) {
    e.preventDefault()
    toggleShortcutGuide()
  } else if (e.key === '/') {
    e.preventDefault()
    openPdfSearch()
  } else if (e.key.toLowerCase() === 'f' || e.key === 'F11') {
    e.preventDefault()
    void toggleFullscreen()
  } else if (e.key === 'F5') {
    e.preventDefault()
    void enterPresentation()
  } else if (e.key === 'F12') {
    e.preventDefault()
    toggleDrawerTab('toc')
  } else if (zoomInKey || zoomOutKey) {
    e.preventDefault()
    changeReaderZoom(zoomInKey ? 1 : -1)
  } else if (e.key.toLowerCase() === 'z' && pdfLayout.value === 'original') {
    e.preventDefault()
    cycleFitMode()
  } else if (e.key.toLowerCase() === 'c' && !isPaper.value && pdfLayout.value === 'original') {
    e.preventDefault()
    void switchMode(mode.value === 'paged' ? 'scroll' : 'paged')
  } else if (e.key.toLowerCase() === 'g') {
    e.preventDefault()
    const input = paperRoot.value?.querySelector<HTMLInputElement>('.page-input')
    input?.focus()
    input?.select()
  } else if (e.key === 'Home') {
    e.preventDefault()
    gotoPage(1)
  } else if (e.key === 'End') {
    e.preventDefault()
    gotoPage(pageCount.value)
  } else if (e.key.toLowerCase() === 'n') {
    e.preventDefault()
    nextPage()
  } else if (e.key.toLowerCase() === 'p') {
    e.preventDefault()
    prevPage()
  } else if (e.key === 'PageUp' || (e.key === ' ' && e.shiftKey)) {
    e.preventDefault()
    scrollByScreen(-1)
  } else if (e.key === 'PageDown' || e.key === ' ') {
    e.preventDefault()
    scrollByScreen(1)
  } else if (e.key === 'ArrowUp' || e.key.toLowerCase() === 'k') {
    e.preventDefault()
    const moved = scrollViewportBy(0, -48)
    if (bookPaged.value && !moved) prevPage()
  } else if (e.key === 'ArrowDown' || e.key.toLowerCase() === 'j') {
    e.preventDefault()
    const moved = scrollViewportBy(0, 48)
    if (bookPaged.value && !moved) nextPage()
  } else if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'h') {
    e.preventDefault()
    const moved = scrollViewportBy(-64, 0)
    if (bookPaged.value && !moved) prevPage()
  } else if (e.key === 'ArrowRight' || e.key.toLowerCase() === 'l') {
    e.preventDefault()
    const moved = scrollViewportBy(64, 0)
    if (bookPaged.value && !moved) nextPage()
  } else if (e.key === 'Backspace') {
    e.preventDefault()
    if (e.shiftKey) goForward()
    else goBack()
  }
}

onMounted(async () => {
  window.addEventListener('keydown', handleKeydown)
  document.addEventListener('fullscreenchange', onFullscreenChange)
  document.addEventListener('webkitfullscreenchange', onFullscreenChange as EventListener)
  if (isTauri()) {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      const currentWindow = getCurrentWindow()
      isFullscreen.value = await currentWindow.isFullscreen()
      fullscreenWindowUnlisten = await currentWindow.onResized(async () => {
        const active = await currentWindow.isFullscreen()
        const wasFullscreen = isFullscreen.value
        isFullscreen.value = active
        if (wasFullscreen && !active && presentationMode.value) void exitPresentation(false)
      })
    } catch { /* 浏览器环境或窗口权限不支持时忽略 */ }
  }
  try {
    const storage = await getStorage()
    meta.value = await storage.getBook(bookId)
    if (!meta.value) {
      error.value = t('reader.bookNotFound')
      return
    }
    storage.listAnnotations(bookId).then(list => {
      annotations.value = list.filter(a => decodeLoc(a.cfi))
    })
    const blob = await storage.getBookFile(bookId)
    sourcePdfBlob = blob.slice(0, blob.size, 'application/pdf')
    const fileData = await blob.arrayBuffer()
    sourcePdfVersion.value = new TextDecoder('latin1')
      .decode(fileData.slice(0, 16))
      .match(/%PDF-(\d\.\d)/)?.[1] ?? ''
    // 流式阅读已下线；读取旧设置时也必须回到原版 PDF。
    settings.pdf.layout = 'original'
    pdm = await PdfiumDoc.open(fileData)
    renderBytes = settings.pdf.renderer === 'mupdf' ? new Uint8Array(fileData.slice(0)) : null
    pageCount.value = pdm.pages.length
    pageDims.value = pdm.pages.map(page => ({ w: page.w, h: page.h }))
    baseDims.value = pageDims.value[0] ?? { w: 612, h: 792 }
    // 连续阅读默认适宽；论文沿用同一阅读模型。
    if (restoredZoom == null && isPaper.value) zoom.value = 'fit-width'
    const saved = parseInt(meta.value.location ?? '1', 10)
    currentPage.value = Number.isFinite(saved)
      ? Math.min(Math.max(saved, 1), pageCount.value)
      : 1
    loading.value = false
    await nextTick()
    if (pdfLayout.value === 'reflow') {
      const targetPage = currentPage.value
      void ensureReflow().then(() => {
        if (pdfLayout.value === 'reflow') nextTick(() => reflowGoto(targetPage))
      })
    } else if (bookPaged.value) {
      currentPage.value = spreadOf(currentPage.value)[0]
      await nextTick()
      await renderPaged()
    } else {
      curScale.value = typeof zoom.value === 'number' ? fixedZoomScale(zoom.value) : fitScale(zoom.value)
      attachScrollListener()
      await nextTick()
      if (currentPage.value > 1) scrollGoto(currentPage.value)
      updateViewport()
    }
    buildOutline()
    resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (pdfLayout.value === 'original') {
          if (bookPaged.value) void renderPaged()
          else if (typeof zoom.value !== 'number') relayout()
          else if (renderedScale.get(currentPage.value) !== renderKeyFor(currentPage.value, curScale.value)) {
            renderedScale.clear()
            updateViewport()
          }
        }
        if (translateOpen.value) mirLayoutNow()
      }, 200)
    })
    observeActiveViewport()
  } catch (e: any) {
    console.error(e)
    error.value = e?.message ?? t('reader.cantOpenPdf')
  } finally {
    loading.value = false
  }
})

onBeforeUnmount(() => {
  reflowSession++
  window.removeEventListener('keydown', handleKeydown)
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  document.removeEventListener('webkitfullscreenchange', onFullscreenChange as EventListener)
  fullscreenWindowUnlisten?.()
  fullscreenWindowUnlisten = undefined
  translateSession++
  selTrSession++
  cancelAi()
  stopTTS()
  stopAutoRead()
  clearTimeout(mirSettleTimer)
  resizeObserver?.disconnect()
  listenedScroller?.removeEventListener('scroll', onScroll)
  listenedScroller = undefined
  clearTimeout(saveTimer)
  clearTimeout(settleTimer)
  clearTimeout(resizeTimer)
  clearTimeout(wheelPageReset)
  clearTimeout(pdfSearchTimer)
  pdfSearchSession++
  thumbnailObserver?.disconnect()
  thumbnailObserver = null
  thumbnailQueue.length = 0
  thumbnailQueued.clear()
  thumbnailRendered.clear()
  thumbnailLastUsed.clear()
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointermove', onPanMove)
  panDrag?.viewport.classList.remove('is-panning')
  panDrag = null
  pdm?.close()
  pdm = null
  mupdfDocPromise?.then(doc => doc?.destroy?.()).catch(() => {})
  mupdfDocPromise = null
  renderBytes = null
  sourcePdfBlob = null
  bdUnlisten?.()
  if (bd.value.phase === 'running') babeldocCancel().catch(() => {})
})
</script>

<template>
  <div
    ref="paperRoot"
    class="paper"
    :class="{ 'is-fullscreen': isFullscreen, 'is-presentation': presentationMode }"
  >
    <header class="paper-header">
      <div class="paper-bar">
        <div class="paper-document">
          <button class="icon-btn document-back" :title="backLabel" @click="router.push(backTarget)">
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M14.7 5.3a1 1 0 0 1 0 1.4L9.42 12l5.3 5.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0z"/></svg>
          </button>
          <div class="paper-title">
            <strong>{{ meta?.title }}</strong>
            <span>{{ t('reader.documentMeta', { total: pageCount, current: currentPage }) }}</span>
          </div>
        </div>

        <div class="paper-context-actions">
          <template v-if="isPaper">
            <button
              class="btn btn-sm context-action"
              :class="translateOpen ? 'btn-active' : 'btn-primary'"
              :disabled="!pageCount"
              @click="openRight('translate')"
            >
              {{ t('paper.openTranslate') }}
            </button>
            <button class="btn btn-sm context-action" :class="{ 'btn-active': rightTab === 'ai' }" :disabled="!pageCount" @click="openRight('ai')">
              {{ t('paper.aiTab') }}
            </button>
            <button class="btn btn-sm context-action" :class="{ 'btn-active': rightTab === 'chat' }" :disabled="!pageCount" @click="openRight('chat')">
              {{ t('paper.chatTab') }}
            </button>
            <button v-if="bdSupported" class="btn btn-sm context-action" :title="t('paper.bdTooltip')" @click="openBabeldoc">
              {{ t('paper.bdButton') }}
            </button>
          </template>
          <button
            v-else
            class="btn btn-sm context-action ai-entry"
            :class="{ 'btn-active': rightTab === 'ai' }"
            :disabled="!pageCount"
            @click="openRight('ai')"
          >
            ✦ {{ t('reader.aiRead') }}
          </button>
          <button class="btn btn-sm change-document" @click="router.push(backTarget)">
            {{ t('reader.changeDocument') }}
          </button>
        </div>
      </div>

      <div class="pdf-toolbar paper-actions">
        <div class="toolbar-group">
          <button
            class="icon-btn"
            :class="{ 'icon-active': tocOpen }"
            :title="t('reader.toc')"
            :aria-pressed="tocOpen"
            @click="toggleDrawerTab('toc')"
          >
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M4 6a1 1 0 0 1 1-1h14a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1zm0 6a1 1 0 0 1 1-1h14a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1zm1 5a1 1 0 1 0 0 2h9a1 1 0 1 0 0-2H5z"/></svg>
          </button>
          <button
            class="icon-btn"
            :class="{ 'icon-active': thumbnailOpen }"
            :title="t('reader.thumbnails')"
            :aria-pressed="thumbnailOpen"
            @click="toggleDrawerTab('thumbnails')"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path fill="currentColor" d="M4.75 3.5h5.5c.69 0 1.25.56 1.25 1.25v6.5c0 .69-.56 1.25-1.25 1.25h-5.5c-.69 0-1.25-.56-1.25-1.25v-6.5c0-.69.56-1.25 1.25-1.25zm0 10h5.5c.69 0 1.25.56 1.25 1.25v4.5c0 .69-.56 1.25-1.25 1.25h-5.5c-.69 0-1.25-.56-1.25-1.25v-4.5c0-.69.56-1.25 1.25-1.25zm9-10h5.5c.69 0 1.25.56 1.25 1.25v4.5c0 .69-.56 1.25-1.25 1.25h-5.5c-.69 0-1.25-.56-1.25-1.25v-4.5c0-.69.56-1.25 1.25-1.25zm0 8h5.5c.69 0 1.25.56 1.25 1.25v6.5c0 .69-.56 1.25-1.25 1.25h-5.5c-.69 0-1.25-.56-1.25-1.25v-6.5c0-.69.56-1.25 1.25-1.25z"/>
            </svg>
          </button>
          <button
            class="icon-btn"
            :class="{ 'icon-active': annoOpen }"
            :title="t('reader.highlightsTab')"
            :aria-pressed="annoOpen"
            @click="toggleDrawerTab('annotations')"
          >
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M15.6 3.6a2 2 0 0 1 2.8 0l2 2a2 2 0 0 1 0 2.8l-9.2 9.2a2 2 0 0 1-.9.5l-4 1a1 1 0 0 1-1.2-1.2l1-4a2 2 0 0 1 .5-.9l9-9.4zM14 7.4 7 14.6l-.5 2 2-.5 7-7.2L14 7.4zm2.4-2.4-1 1L17 7.6l1-1-1.6-1.6z"/></svg>
          </button>
        </div>
        <span class="toolbar-sep" />

        <div class="toolbar-group toolbar-page">
          <button class="icon-btn" :title="t('reader.prevPage')" :disabled="atFirstPage" @click="prevPage">
            <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M14.7 5.3a1 1 0 0 1 0 1.4L9.42 12l5.3 5.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0z"/></svg>
          </button>
          <span class="paper-pagenum">
            <input v-model="pageInput" class="input page-input" :aria-label="t('common.current')" @keyup.enter="jumpTo" @blur="jumpTo" />
            <span>/ {{ pageCount }}</span>
          </span>
          <button class="icon-btn" :title="t('reader.nextPage')" :disabled="atLastPage" @click="nextPage">
            <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M9.3 5.3a1 1 0 0 1 1.4 0l6 6a1 1 0 0 1 0 1.4l-6 6a1 1 0 0 1-1.4-1.4l5.29-5.3-5.3-5.3a1 1 0 0 1 0-1.4z"/></svg>
          </button>
        </div>
        <span class="toolbar-sep" />

        <div class="toolbar-group toolbar-zoom">
          <template v-if="pdfLayout === 'original'">
            <button class="icon-btn" :title="`${t('reader.zoomOut')} (${primaryShortcutLabel} −)`" @click="zoomStep(-1)">−</button>
            <button class="dock-zoom" @click="zoomMenu = !zoomMenu">
              {{ zoom === 'fit-page' ? t('reader.fitPage') : zoom === 'fit-width' ? t('reader.fitWidth') : zoomPercentLabel(zoom as number) }}
              <span class="dock-caret">⌄</span>
            </button>
            <button class="icon-btn" :title="`${t('reader.zoomIn')} (${primaryShortcutLabel} +)`" @click="zoomStep(1)">＋</button>
          </template>
          <button v-else class="dock-zoom" @click="typographyOpen = !typographyOpen">
            Aa · {{ settings.reader.fontSize }}
            <span class="dock-caret">⌄</span>
          </button>
        </div>
        <span class="toolbar-sep" />

        <div class="toolbar-group toolbar-layout">
          <div class="reader-segment" role="group" :aria-label="t('reader.mode')">
            <button
              type="button"
              :class="{ active: mode === 'scroll' }"
              :aria-pressed="mode === 'scroll'"
              @click="switchMode('scroll')"
            >{{ t('reader.scrolled') }}</button>
            <button
              type="button"
              :class="{ active: mode === 'paged' }"
              :aria-pressed="mode === 'paged'"
              @click="switchMode('paged')"
            >{{ t('reader.paginated') }}</button>
          </div>
          <div class="reader-segment fit-segment" role="group" :aria-label="t('reader.fitHeight') + ' / ' + t('reader.fitWidth')">
            <button
              type="button"
              :class="{ active: zoom === 'fit-page' }"
              :aria-pressed="zoom === 'fit-page'"
              @click="setPagedFit('fitH')"
            >{{ t('reader.fitHeight') }}</button>
            <button
              type="button"
              :class="{ active: zoom === 'fit-width' }"
              :aria-pressed="zoom === 'fit-width'"
              @click="setPagedFit('fitW')"
            >{{ t('reader.fitWidth') }}</button>
          </div>
          <div class="reader-segment page-view-segment" role="group" :aria-label="t('reader.pageView')">
            <button
              type="button"
              :class="{ active: spreadMode === 'single' }"
              :aria-label="t('reader.singlePage')"
              :title="t('reader.singlePage')"
              :aria-pressed="spreadMode === 'single'"
              @click="setSpreadMode('single')"
            >
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.25 3.5h9.5v13h-9.5z" /></svg>
            </button>
            <button
              type="button"
              :class="{ active: spreadMode === 'facing' }"
              :aria-label="t('reader.facingPages')"
              :title="t('reader.facingPages')"
              :aria-pressed="spreadMode === 'facing'"
              @click="setSpreadMode('facing')"
            >
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.75 4h6v12h-6zM11.25 4h6v12h-6z" /></svg>
            </button>
            <button
              type="button"
              :class="{ active: spreadMode === 'book' }"
              :aria-label="t('reader.bookView')"
              :title="t('reader.bookView')"
              :aria-pressed="spreadMode === 'book'"
              @click="setSpreadMode('book')"
            >
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 4.5c2.8-.5 5.1.1 7.5 1.8v10c-2.4-1.7-4.7-2.3-7.5-1.8zM17.5 4.5c-2.8-.5-5.1.1-7.5 1.8v10c2.4-1.7 4.7-2.3 7.5-1.8z" /></svg>
            </button>
          </div>
          <button
            type="button"
            class="reader-tool"
            :class="{ active: autoReading || autoPanel }"
            :aria-pressed="autoReading || autoPanel"
            :title="autoReading && !autoPanel ? t('reader.expandAutoControls') : t('reader.autoRead')"
            @click="toggleAutoPanel"
          >
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 5.25 7 4.75-7 4.75z" /></svg>
            <span>{{ autoReading ? t('reader.autoReading') : t('reader.autoRead') }}</span>
          </button>
          <button
            type="button"
            class="reader-tool"
            :class="{ active: ttsState !== 'stopped' || ttsPanel }"
            :aria-pressed="ttsState !== 'stopped' || ttsPanel"
            @click="openTTSPanel"
          >
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 8h3l3-3v10l-3-3H4zM13 7.2a4 4 0 0 1 0 5.6M14.9 5.4a6.5 6.5 0 0 1 0 9.2" /></svg>
            <span>{{ ttsState !== 'stopped' ? t('tts.readingNow') : t('tts.title') }}</span>
          </button>
        </div>

        <span class="toolbar-spacer" />
        <div class="toolbar-group toolbar-end">
          <button
            class="icon-btn"
            :class="{ 'icon-active': pdfSearchOpen }"
            :title="`${t('reader.searchInBook')} (${primaryShortcutLabel} F)`"
            :aria-pressed="pdfSearchOpen"
            @click="pdfSearchOpen ? closePdfSearch() : openPdfSearch()"
          >
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M10.5 3a7.5 7.5 0 1 0 4.55 13.46l3.75 3.75a1 1 0 0 0 1.4-1.42l-3.74-3.74A7.5 7.5 0 0 0 10.5 3zM5 10.5a5.5 5.5 0 1 1 11 0 5.5 5.5 0 0 1-11 0z"/></svg>
          </button>
          <button class="icon-btn" :title="`${t('reader.print')} (${primaryShortcutLabel} P)`" @click="printDocument">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M7 8V3h10v5M7 17H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M7 14h10v7H7z"/></svg>
          </button>
          <button class="icon-btn" :title="`${t('reader.slideshow')} (F5)`" @click="enterPresentation">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M4 4h16v12H4zM9 20h6M12 16v4m-2.5-9V8l4 3-4 3z"/></svg>
          </button>
          <button class="icon-btn" :title="`${t('reader.fullscreen')} (F)`" @click="toggleFullscreen">
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/></svg>
          </button>
          <div class="reader-more-wrap">
            <button
              class="icon-btn"
              :class="{ 'icon-active': moreMenu }"
              :title="t('reader.moreActions')"
              :aria-expanded="moreMenu"
              @click="moreMenu = !moreMenu"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M6 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm6 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm6 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4z"/></svg>
            </button>
            <div v-if="moreMenu" class="reader-more-backdrop" @click="moreMenu = false" />
            <div v-if="moreMenu" class="reader-more-menu card" role="menu">
              <button role="menuitem" @click="saveDocumentAs">{{ t('reader.saveAs') }}</button>
              <button role="menuitem" @click="openDocumentFolder">{{ t('reader.openFolder') }}</button>
              <button role="menuitem" @click="openProperties">{{ t('reader.properties') }}</button>
              <button role="menuitem" @click="toggleDrawerTab('annotations'); moreMenu = false">{{ t('reader.comments') }}</button>
            </div>
          </div>
          <button
            class="icon-btn shortcut-trigger"
            :class="{ 'icon-active': shortcutsOpen }"
            :title="`${t('reader.keyboardShortcuts')} (?)`"
            :aria-label="t('reader.keyboardShortcuts')"
            :aria-pressed="shortcutsOpen"
            @click="toggleShortcutGuide"
          >?</button>
        </div>
      </div>
    </header>

    <button
      v-if="isFullscreen"
      class="fullscreen-exit"
      :title="presentationMode ? t('reader.exitSlideshow') : t('reader.exitFullscreen')"
      :aria-label="presentationMode ? t('reader.exitSlideshow') : t('reader.exitFullscreen')"
      @click="presentationMode ? exitPresentation() : setFullscreen(false)"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /></svg>
      <span>{{ presentationMode ? t('reader.exitSlideshow') : t('reader.exitFullscreen') }}</span>
    </button>

    <div v-if="presentationMode" class="presentation-controls" aria-live="polite">
      <button :disabled="atFirstPage" :aria-label="t('reader.prevPage')" @click="prevPage">‹</button>
      <span>{{ currentPage }} / {{ pageCount }}</span>
      <button :disabled="atLastPage" :aria-label="t('reader.nextPage')" @click="nextPage">›</button>
    </div>

    <div v-if="propertiesOpen" class="document-dialog-mask" @click.self="propertiesOpen = false">
      <section class="document-dialog card" role="dialog" aria-modal="true" :aria-label="t('reader.propertiesTitle')">
        <header>
          <div>
            <small>PDF</small>
            <h2>{{ t('reader.propertiesTitle') }}</h2>
          </div>
          <button class="icon-btn" :aria-label="t('common.close')" @click="propertiesOpen = false">×</button>
        </header>
        <dl>
          <template v-for="row in propertyRows" :key="row.label">
            <dt>{{ row.label }}</dt>
            <dd>{{ row.value }}</dd>
          </template>
        </dl>
        <footer>
          <button class="btn btn-sm" @click="propertiesOpen = false">{{ t('common.done') }}</button>
        </footer>
      </section>
    </div>

    <!-- BabelDOC 整本重排版翻译面板 -->
    <div v-if="bd.open" class="bd-mask" @click.self="bd.phase !== 'running' && (bd.open = false)">
      <div class="bd-panel">
        <h3>{{ t('paper.bdTitle') }}</h3>
        <p class="bd-sub">{{ t('paper.bdDesc') }}</p>

        <p v-if="bd.phase === 'checking'" class="bd-line">{{ t('paper.bdChecking') }}</p>

        <template v-else-if="bd.phase === 'notfound'">
          <p class="bd-line">{{ t('paper.bdNotFound') }}</p>
          <div class="bd-cmd">
            <code>{{ INSTALL_CMD }}</code>
            <button class="btn btn-sm" @click="copyInstall">{{ t('paper.bdCopy') }}</button>
          </div>
          <p class="bd-hint">{{ t('paper.bdInstallHint') }}</p>
          <div class="bd-actions">
            <button class="btn btn-sm" @click="openBabeldoc">{{ t('paper.bdRecheck') }}</button>
          </div>
        </template>

        <template v-else-if="bd.phase === 'ready'">
          <p class="bd-ok">✓ {{ bd.status?.version || 'babeldoc' }}</p>
          <p v-if="!bdProviderOk" class="bd-warn">{{ t('paper.bdTrialUnsupported') }}</p>
          <label class="bd-field">
            {{ t('paper.bdPages') }}
            <input v-model="bd.pages" class="input" :placeholder="t('paper.bdPagesPh')" />
          </label>
          <p class="bd-hint">{{ t('paper.bdTimeHint') }}</p>
          <div class="bd-actions">
            <button class="btn btn-sm btn-primary" :disabled="!bdProviderOk || !aiReady" @click="startBabeldoc">
              {{ t('paper.bdStart') }}
            </button>
          </div>
        </template>

        <template v-else-if="bd.phase === 'running'">
          <div class="bd-bar" :class="{ 'bd-indeterminate': bd.percent == null }">
            <div class="bd-bar-fill" :style="bd.percent != null ? { width: `${bd.percent}%` } : {}" />
          </div>
          <p class="bd-line">{{ bd.percent != null ? `${bd.percent.toFixed(0)}% · ` : '' }}{{ bdLineText }}</p>
          <p class="bd-hint">{{ t('paper.bdElapsed') }} {{ bdElapsedText }} · {{ t('paper.bdStayHint') }}</p>
          <div class="bd-actions">
            <button class="btn btn-sm" @click="cancelBabeldoc">{{ t('paper.bdCancel') }}</button>
          </div>
        </template>

        <template v-else-if="bd.phase === 'done'">
          <p class="bd-ok">{{ t('paper.bdDone') }}</p>
          <div class="bd-actions">
            <button v-for="r in bd.results" :key="r.id" class="btn btn-sm btn-primary" @click="openResult(r.id)">
              {{ t('paper.bdOpen') }}{{ r.label }}
            </button>
            <button class="btn btn-sm" @click="bd.open = false">{{ t('paper.bdClose') }}</button>
          </div>
        </template>

        <template v-else-if="bd.phase === 'error'">
          <p class="bd-warn">{{ bd.error }}</p>
          <div class="bd-actions">
            <button class="btn btn-sm" @click="bd.phase = 'ready'">{{ t('paper.bdBack') }}</button>
          </div>
        </template>
      </div>
    </div>

    <div v-if="loading" class="paper-state">{{ t('reader.opening') }}</div>
    <div v-else-if="error" class="paper-state">
      <p>{{ error }}</p>
      <button class="btn" @click="router.push(backTarget)">{{ backLabel }}</button>
    </div>

    <div v-else class="paper-split">
      <!-- 目录 / 缩略图 / 标注复用稳定侧栏，切换内容时正文宽度不反复跳动。 -->
      <aside v-show="drawerOpen" class="side-drawer">
        <div class="drawer-head">
          <div class="drawer-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              :class="{ active: tocOpen }"
              :aria-selected="tocOpen"
              @click="setDrawerTab('toc')"
            >{{ t('reader.toc') }}</button>
            <button
              type="button"
              role="tab"
              :class="{ active: thumbnailOpen }"
              :aria-selected="thumbnailOpen"
              @click="setDrawerTab('thumbnails')"
            >{{ t('reader.thumbnails') }}</button>
            <button
              type="button"
              role="tab"
              :class="{ active: annoOpen }"
              :aria-selected="annoOpen"
              @click="setDrawerTab('annotations')"
            >{{ t('reader.highlightsTab') }}</button>
          </div>
          <button class="icon-btn" :title="t('common.close')" @click="closeDrawer">✕</button>
        </div>
        <div v-show="tocOpen" class="drawer-body">
          <TocList v-if="tocItems.length" :items="tocItems" @navigate="tocNavigate" />
          <p v-else class="drawer-empty">{{ t('paper.noOutline') }}</p>
        </div>
        <div
          v-show="thumbnailOpen"
          ref="thumbnailScroller"
          class="drawer-body thumbnail-drawer"
          role="tabpanel"
        >
          <button
            v-for="pageNum in pageCount"
            :key="pageNum"
            type="button"
            class="thumbnail-item"
            :class="{ active: currentPage === pageNum }"
            :data-thumbnail-page="pageNum"
            :aria-current="currentPage === pageNum ? 'page' : undefined"
            :aria-label="t('reader.thumbnailPage', { page: pageNum })"
            @click="thumbnailNavigate(pageNum)"
          >
            <span class="thumbnail-sheet" :style="thumbnailFrameStyle(pageNum)">
              <span class="thumbnail-skeleton" aria-hidden="true" />
              <span class="thumbnail-canvas" />
            </span>
            <span class="thumbnail-number">{{ pageNum }}</span>
          </button>
        </div>
        <div v-show="annoOpen" class="drawer-body">
          <p class="drawer-count">{{ t('reader.highlightsTab') }} · {{ highlights.length }}</p>
          <div v-for="a in highlights" :key="a.id" class="anno-item" @click="gotoAnnotation(a)">
            <span class="anno-dot" :style="{ background: HIGHLIGHT_COLORS[a.color] ?? a.color }" />
            <div class="anno-main">
              <p class="anno-text">{{ a.text }}</p>
              <p v-if="a.note" class="anno-note">{{ a.note }}</p>
              <span class="anno-page">P{{ decodeLoc(a.cfi)?.page }}</span>
            </div>
            <button class="icon-btn anno-del" :title="t('reader.deleteHighlight')" @click.stop="removeAnnotation(a)">✕</button>
          </div>
          <p v-if="!highlights.length" class="drawer-empty">{{ t('reader.highlightEmptyHint') }}</p>
        </div>
      </aside>

      <!-- 左: 原文 PDF 连续滚动 (划词 / 高亮 / 链接跳转) + 底部悬浮工具条 -->
      <div class="pane-left-wrap">
        <section v-if="pdfSearchOpen" class="pdf-search card" role="search">
          <svg class="pdf-search-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M10.5 3a7.5 7.5 0 1 0 4.55 13.46l3.75 3.75a1 1 0 0 0 1.4-1.42l-3.74-3.74A7.5 7.5 0 0 0 10.5 3zM5 10.5a5.5 5.5 0 1 1 11 0 5.5 5.5 0 0 1-11 0z"/></svg>
          <input
            ref="pdfSearchInput"
            v-model="pdfSearchQuery"
            class="pdf-search-input"
            type="search"
            :placeholder="t('reader.searchPdfPlaceholder')"
            @input="schedulePdfSearch"
            @keydown="onPdfSearchKeydown"
          />
          <button
            type="button"
            class="pdf-search-option"
            :class="{ active: pdfSearchMatchCase }"
            :title="t('reader.matchCase')"
            :aria-pressed="pdfSearchMatchCase"
            @click="togglePdfSearchOption('case')"
          >Aa</button>
          <button
            type="button"
            class="pdf-search-option pdf-search-whole"
            :class="{ active: pdfSearchWholeWord }"
            :title="t('reader.wholeWord')"
            :aria-pressed="pdfSearchWholeWord"
            @click="togglePdfSearchOption('word')"
          >ab</button>
          <span class="pdf-search-status">{{ pdfSearchStatus }}</span>
          <button
            type="button"
            :title="t('reader.previousResult')"
            :disabled="!pdfSearchResults.length"
            @click="activatePdfSearchHit(pdfSearchActive - 1)"
          >↑</button>
          <button
            type="button"
            :title="t('reader.nextResult')"
            :disabled="!pdfSearchResults.length"
            @click="activatePdfSearchHit(pdfSearchActive + 1)"
          >↓</button>
          <button type="button" :title="t('reader.closeSearch')" @click="closePdfSearch">×</button>
        </section>

        <!-- 流式阅读：复用 PDF 文本层与阅读偏好，按原页保留跳转锚点。 -->
        <div
          v-if="pdfLayout === 'reflow'"
          ref="reflowScroller"
          class="reflow-scroll"
          :style="reflowStyle"
          @scroll.passive="onReflowScroll"
        >
          <div v-if="reflowBuilding" class="reflow-progress">
            {{ t('reader.reflowBuilding', { current: reflowProcessed, total: pageCount }) }}
          </div>
          <article v-if="reflowPages.length" class="reflow-article">
            <section
              v-for="page in reflowPages"
              :key="page.page"
              class="reflow-page"
              :data-reflow-page="page.page"
            >
              <button class="reflow-page-link" @click="openOriginalPage(page.page)">
                {{ t('reader.originalPage', { page: page.page }) }}
              </button>
              <template v-for="p in page.paras" :key="p.id">
                <h2 v-if="isReflowHeading(p)" class="reflow-heading">{{ p.text }}</h2>
                <p v-else>{{ p.text }}</p>
              </template>
            </section>
          </article>
          <div v-else-if="reflowBuilt || reflowError" class="reflow-empty">
            <strong>{{ t('reader.reflowNoText') }}</strong>
            <span>{{ t('reader.reflowNoTextHint') }}</span>
            <small v-if="reflowError">{{ reflowError }}</small>
            <button class="btn btn-sm" @click="switchPdfLayout('original')">{{ t('reader.originalPdf') }}</button>
          </div>
        </div>

        <!-- 藏书默认翻页适高；双页时显示当前 1-2 / 3-4 页组。 -->
        <div
          v-else-if="bookPaged"
          ref="pagedBox"
          class="paged-box"
          @pointerdown="onScrollerPointerDown"
          @dblclick="onScrollerDblClick"
          @wheel="onPdfWheel"
          @touchstart="onPdfTouchStart"
          @touchmove="onPdfTouchMove"
          @touchend="onPdfTouchEnd"
          @contextmenu.prevent
        >
          <div class="spread-host">
            <div
              v-for="n in pagedPages"
              :key="n"
              class="p-holder"
              :data-page="n"
              :style="holderStyleFor(n)"
              @click="onHolderClick($event, n)"
            >
              <span class="p-num">{{ n }}</span>
              <div class="p-canvas" />
              <div class="p-search">
                <div
                  v-for="match in pdfSearchRectsByPage.get(n) ?? []"
                  :key="match.key"
                  class="p-search-rect"
                  :class="{ active: match.active }"
                  :style="pdfSearchRectStyle(n, match.rect)"
                />
              </div>
              <div class="p-hl">
                <div v-for="h in pageHls.get(n) ?? []" :key="h.key" class="p-hl-rect" :style="hlStyle(n, h.r, h.a.color)" />
              </div>
              <div v-if="liveRects && liveRects.page === n" class="p-sel">
                <div
                  v-for="(r, i) in liveRects.rects"
                  :key="i"
                  class="p-sel-rect"
                  :style="liveRectStyle(n, r)"
                />
              </div>
              <div class="p-links" />
            </div>
          </div>
        </div>

        <div
          v-else
          ref="scroller"
          class="pane pane-left"
          @pointerdown="onScrollerPointerDown"
          @dblclick="onScrollerDblClick"
          @wheel="onPdfWheel"
          @touchstart="onPdfTouchStart"
          @touchmove="onPdfTouchMove"
          @touchend="onPdfTouchEnd"
          @contextmenu.prevent
        >
          <div v-for="group in scrollPageGroups" :key="group.join('-')" class="scroll-spread-host">
            <div
              v-for="n in group"
              :key="n"
              class="p-holder"
              :data-page="n"
              :style="holderStyleFor(n)"
              @click="onHolderClick($event, n)"
            >
              <span class="p-num">{{ n }}</span>
              <div class="p-canvas" />
              <div class="p-search">
                <div
                  v-for="match in pdfSearchRectsByPage.get(n) ?? []"
                  :key="match.key"
                  class="p-search-rect"
                  :class="{ active: match.active }"
                  :style="pdfSearchRectStyle(n, match.rect)"
                />
              </div>
              <div class="p-hl">
                <div v-for="h in pageHls.get(n) ?? []" :key="h.key" class="p-hl-rect" :style="hlStyle(n, h.r, h.a.color)" />
              </div>
              <!-- PDFium 几何选区 -->
              <div v-if="liveRects && liveRects.page === n" class="p-sel">
                <div
                  v-for="(r, i) in liveRects.rects"
                  :key="i"
                  class="p-sel-rect"
                  :style="liveRectStyle(n, r)"
                />
              </div>
              <div class="p-links" />
            </div>
          </div>
        </div>

        <!-- 缩放档位菜单 -->
        <div v-if="zoomMenu && pdfLayout === 'original'" class="zoom-backdrop" @click="zoomMenu = false" />
        <div v-if="zoomMenu && pdfLayout === 'original'" class="zoom-menu card">
          <button
            v-for="p in ZOOM_PRESETS"
            :key="p"
            class="zoom-item"
            :class="{ active: typeof zoom === 'number' && Math.abs((zoom as number) - p) < 0.001 }"
            @click="pickZoom(p)"
          >{{ zoomPercentLabel(p) }}</button>
          <button class="zoom-item" :class="{ active: zoom === 'fit-page' }" @click="pickZoom('fit-page')">
            {{ t('reader.fitPage') }}
          </button>
          <button class="zoom-item" :class="{ active: zoom === 'fit-width' }" @click="pickZoom('fit-width')">
            {{ t('reader.fitWidth') }}
          </button>
        </div>

        <div v-if="shortcutsOpen" class="zoom-backdrop" @click="shortcutsOpen = false" />
        <section v-if="shortcutsOpen" class="shortcut-menu card" role="dialog" :aria-label="t('reader.keyboardShortcuts')">
          <header class="shortcut-head">
            <strong>{{ t('reader.keyboardShortcuts') }}</strong>
            <button class="icon-btn" :aria-label="t('common.close')" @click="shortcutsOpen = false">×</button>
          </header>
          <div v-for="row in shortcutRows" :key="row.label" class="shortcut-row">
            <span class="shortcut-keys">
              <template v-for="(combo, comboIndex) in row.shortcuts" :key="combo.join('-')">
                <span v-if="comboIndex" class="shortcut-or">/</span>
                <span class="shortcut-combo">
                  <template v-for="(key, keyIndex) in combo" :key="key">
                    <span v-if="keyIndex" class="shortcut-plus">+</span>
                    <kbd>{{ key }}</kbd>
                  </template>
                </span>
              </template>
            </span>
            <span>{{ row.label }}</span>
          </div>
        </section>

        <div v-if="typographyOpen && pdfLayout === 'reflow'" class="zoom-backdrop" @click="typographyOpen = false" />
        <div v-if="typographyOpen && pdfLayout === 'reflow'" class="reflow-settings card">
          <label>
            <span>{{ t('reader.fontSize') }}</span>
            <input v-model.number="settings.reader.fontSize" type="range" min="12" max="36" step="1" />
            <strong>{{ settings.reader.fontSize }}</strong>
          </label>
          <label>
            <span>{{ t('reader.lineHeight') }}</span>
            <input v-model.number="settings.reader.lineHeight" type="range" min="1.2" max="2.6" step="0.1" />
            <strong>{{ settings.reader.lineHeight.toFixed(1) }}</strong>
          </label>
          <label>
            <span>{{ t('reader.font') }}</span>
            <select v-model="settings.reader.fontFamily" class="input">
              <option v-for="font in FONT_FAMILIES" :key="font.value" :value="font.value">{{ t(font.labelKey) }}</option>
              <option v-for="font in settings.customFonts" :key="font.file" :value="`custom:${font.name}`">{{ font.name }}</option>
            </select>
          </label>
          <div class="reflow-theme-row">
            <span>{{ t('reader.theme') }}</span>
            <button
              v-for="(colors, name) in READER_THEMES"
              :key="name"
              :class="{ active: settings.reader.theme === name }"
              :style="{ background: colors.bg, color: colors.fg }"
              :title="String(name)"
              @click="settings.reader.theme = name as any"
            >Aa</button>
          </div>
        </div>
      </div>

      <!-- 分栏拖拽把手 -->
      <div v-if="rightTab" class="splitter" @pointerdown.prevent="startSplit" />

      <!-- 右: 翻译 (版式对照 / 段落列表) / AI 辅读 (总结 / 十问) / 问答
           标签切换在顶栏 (再点当前项即关闭), 面板内不再重复一排标签 -->
      <div v-if="rightTab" ref="rightPane" class="pane-right" :style="rightPaneStyle">
        <div v-if="!aiReady" class="rt-body">
          <div class="chat-head ai-top">
            <strong>{{ rightTab === 'ai' ? t('paper.aiTab') : rightTab === 'chat' ? t('paper.chatTab') : t('paper.translationTitle') }}</strong>
            <span style="flex: 1" />
            <button class="icon-btn" :title="t('common.close')" @click="closeRight">✕</button>
          </div>
          <div class="pt-setup">
            <p>{{ t('paper.setupHint') }}</p>
            <button class="btn btn-sm btn-primary" @click="router.push('/settings')">{{ t('ai.goSettings') }}</button>
          </div>
        </div>

        <!-- AI 辅读 -->
        <template v-else-if="rightTab === 'ai'">
          <div class="rt-body">
          <div class="chat-head ai-top">
            <strong>{{ t('paper.aiTab') }}</strong>
            <span style="flex: 1" />
            <button class="icon-btn" :title="t('common.close')" @click="closeRight">✕</button>
          </div>
          <p v-if="docParsing" class="ai-parsing">{{ t('paper.aiParsing') }}</p>

          <section class="ai-sec">
            <div class="ai-sec-head">
              <strong>{{ t('paper.aiSummary') }}</strong>
              <span style="flex: 1" />
              <button v-if="summaryBusy" class="pt-act" @click="cancelAi">{{ t('common.cancel') }}</button>
              <button v-else-if="aiSummary" class="pt-act" @click="runSummary(true)">{{ t('paper.aiRegen') }}</button>
            </div>
            <div v-if="aiSummary" class="ai-text">{{ aiSummary }}</div>
            <div v-else-if="summaryBusy" class="ai-text ai-pending">{{ t('paper.translating') }}</div>
            <div v-else class="pt-start">
              <span>{{ t('paper.aiSummaryHint') }}</span>
              <button class="btn btn-sm btn-primary" @click="runSummary()">{{ t('paper.aiSummaryGen') }}</button>
            </div>
          </section>

          <section class="ai-sec">
            <div class="ai-sec-head">
              <strong>{{ t('paper.aiTen') }}</strong>
              <span style="flex: 1" />
              <span class="ai-progress">{{ t('paper.aiAnswered', { n: answeredCount }) }}</span>
            </div>
            <p class="ai-hint">{{ t('paper.aiTenHint') }}</p>
            <div v-for="(q, i) in tenQs" :key="i" class="ai-q">
              <button class="ai-q-head" @click="toggleQ(i)">
                <span class="ai-q-num" :class="{ done: !!tenA[i] }">Q{{ i + 1 }}</span>
                <span class="ai-q-text">{{ q }}</span>
                <span class="ai-q-arrow">{{ openQ.has(i) ? '▴' : '▾' }}</span>
              </button>
              <div v-if="openQ.has(i)" class="ai-q-body">
                <div v-if="tenA[i]" class="ai-text">{{ tenA[i] }}</div>
                <div v-else-if="tenBusy === i" class="ai-text ai-pending">{{ t('paper.translating') }}</div>
                <div class="ai-q-actions">
                  <button v-if="tenBusy === i" class="pt-act" @click="cancelAi">{{ t('common.cancel') }}</button>
                  <button
                    v-else-if="!tenA[i]"
                    class="btn btn-sm btn-primary"
                    :disabled="tenBusy >= 0"
                    @click="runQuestion(i)"
                  >✦ {{ t('paper.aiAnswer') }}</button>
                  <button v-else class="pt-act" :disabled="tenBusy >= 0" @click="runQuestion(i)">
                    {{ t('paper.aiRegen') }}
                  </button>
                </div>
              </div>
            </div>
          </section>
          </div>
        </template>

        <!-- 问答 agent: 独立标签, 独立会话, 消息区自动跟随 -->
        <template v-else-if="rightTab === 'chat'">
          <div class="rt-chat">
            <div class="chat-head">
              <strong>{{ t('paper.aiChat') }}</strong>
              <span style="flex: 1" />
              <button v-if="chatMsgs.length" class="pt-act" @click="clearChat">{{ t('paper.chatClear') }}</button>
              <button class="icon-btn" :title="t('common.close')" @click="closeRight">✕</button>
            </div>
            <div ref="chatScroll" class="ai-msgs">
              <div v-if="!chatMsgs.length" class="chat-empty">
                <p class="ai-hint">{{ t('paper.chatEmpty') }}</p>
                <button class="chat-chip" @click="quickAsk(t('paper.chatChip1'))">{{ t('paper.chatChip1') }}</button>
                <button class="chat-chip" @click="quickAsk(t('paper.chatChip2'))">{{ t('paper.chatChip2') }}</button>
                <button class="chat-chip" @click="quickAsk(t('paper.chatChip3'))">{{ t('paper.chatChip3') }}</button>
              </div>
              <div v-for="(m, i) in chatMsgs" :key="i" class="ai-msg" :class="m.role">{{ m.content || '…' }}</div>
            </div>
            <form class="ai-input" @submit.prevent="sendChat">
              <input v-model="chatInput" class="input" :placeholder="t('paper.aiChatPh')" />
              <button class="btn btn-sm btn-primary" type="submit" :disabled="chatBusy || !chatInput.trim()">
                {{ t('paper.aiSend') }}
              </button>
            </form>
          </div>
        </template>

        <!-- 翻译: 版式对照连续滚动 (独立于左栏) / 段落列表 -->
        <template v-else>
          <div class="rt-body rt-translate">
            <div class="pt-head">
              <span class="pt-page">P{{ mirCur }} / {{ pageCount }}</span>
              <span style="flex: 1" />
              <span class="pm-switch">
                <button :class="{ active: viewMode === 'mirror' }" @click="setMode('mirror')">{{ t('paper.viewMirror') }}</button>
                <button :class="{ active: viewMode === 'cards' }" @click="setMode('cards')">{{ t('paper.viewCards') }}</button>
              </span>
              <button v-if="translatingPage" class="pt-act" @click="cancelTranslate">{{ t('paper.cancelTranslate') }}</button>
              <button v-else class="pt-act" @click="runTranslateFor(mirCur, true)">{{ t('paper.retranslate') }}</button>
              <span v-if="translatingPage" class="pt-busy">{{ t('paper.translating') }} P{{ translatingPage }}</span>
              <button class="icon-btn" :title="t('common.close')" @click="closeRight">✕</button>
            </div>
            <p v-if="curMir && !curMir.paras.length" class="pt-empty">
              {{ t('paper.noText') }}
              <span v-if="curMir.err" class="pt-errdetail">{{ curMir.err }}</span>
            </p>

            <!-- 版式对照: 原页做底, 译文按原位铺回; 滚到哪页停稳即翻译哪页 -->
            <div v-show="effectiveMode === 'mirror'" ref="mirScroller" class="mp-scroll" :title="t('paper.blockHint')">
              <div v-for="n in pageCount" :key="n" class="mp-holder" :data-mp="n" :style="mirHolderStyle">
                <span class="p-num">{{ n }}</span>
                <div class="mp-canvas" />
                <div
                  v-for="blk in blocksOf(n)"
                  :key="blk.id"
                  class="pm-block"
                  :class="{ 'pm-original': blk.orig }"
                  :style="blk.style"
                  @click="toggleBlock(n, blk.id)"
                >{{ blk.text }}</div>
              </div>
            </div>

            <!-- 段落列表 (对照视图当前页) -->
            <div v-show="effectiveMode === 'cards'" class="cards-scroll">
              <div v-for="p in curMir?.paras ?? []" :key="p.id" class="pt-card">
                <div class="pt-zh">
                  <template v-if="curMir && trText(curMir, p.id)">{{ trText(curMir, p.id) }}</template>
                  <span v-else-if="translatingPage === mirCur" class="pt-pending">{{ t('paper.translating') }}</span>
                  <span v-else class="pt-pending">{{ origText(p).slice(0, 120) }}</span>
                </div>
                <button class="pt-toggle" @click="toggleOriginal(p.id)">
                  {{ expanded.has(p.id) ? t('paper.hideOriginal') : t('paper.showOriginal') }}
                </button>
                <p v-if="expanded.has(p.id)" class="pt-en">{{ origText(p) }}</p>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- 划词浮条: 高亮 / 想法 / 复制 / AI 翻译 -->
    <div
      v-if="selection"
      class="sel-bar"
      :style="selBarStyle"
      role="toolbar"
      :aria-label="t('reader.selectionActions')"
      @mousedown.prevent
    >
      <div class="sel-colors" role="group" :aria-label="t('reader.highlight')">
        <button
          v-for="(hex, name) in HIGHLIGHT_COLORS"
          :key="name"
          type="button"
          class="sel-color"
          :title="`${t('reader.highlight')} · ${t(`reader.highlightColor.${name}`)}`"
          :aria-label="`${t('reader.highlight')} · ${t(`reader.highlightColor.${name}`)}`"
          @click="addHighlight(name as string)"
        >
          <span class="sel-color-dot" :style="{ background: hex }" />
        </button>
      </div>
      <span class="sel-sep" />
      <button type="button" class="sel-act" @click="addHighlight('yellow', true)">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.25 3.75h11.5v9H9l-3.25 2.7v-2.7h-1.5z" /><path d="M10 6.25v4M8 8.25h4" /></svg>
        <span>{{ t('reader.writeNote') }}</span>
      </button>
      <button type="button" class="sel-act sel-act-ai" @click="translateSelection">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10.2 2.75c.45 3.2 1.85 4.6 5.05 5.05-3.2.45-4.6 1.85-5.05 5.05-.45-3.2-1.85-4.6-5.05-5.05 3.2-.45 4.6-1.85 5.05-5.05Z" /><path d="M15.15 12.65c.2 1.45.85 2.1 2.3 2.3-1.45.2-2.1.85-2.3 2.3-.2-1.45-.85-2.1-2.3-2.3 1.45-.2 2.1-.85 2.3-2.3Z" /></svg>
        <span>{{ isPaper ? t('paper.selTranslateBtn') : t('ai.explain') }}</span>
      </button>
      <button type="button" class="sel-act" @click="copySelection">
        <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6.25" y="6.25" width="9.5" height="9.5" rx="1.75" /><path d="M13.75 6.25v-1.5a1.5 1.5 0 0 0-1.5-1.5h-7.5a1.5 1.5 0 0 0-1.5 1.5v7.5a1.5 1.5 0 0 0 1.5 1.5h1.5" /></svg>
        <span>{{ t('paper.copy') }}</span>
      </button>
      <span class="sel-sep sel-sep-end" />
      <button type="button" class="sel-close" :aria-label="t('common.close')" :title="t('common.close')" @click="selection = null">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5.75 5.75 8.5 8.5M14.25 5.75l-8.5 8.5" /></svg>
      </button>
    </div>

    <!-- 划词翻译浮卡 (流式) -->
    <div v-if="selTr" class="sel-tr card" :style="{ left: `${selTrPos.x}px`, top: `${selTrPos.y}px` }">
      <div class="sel-tr-head">
        <strong>{{ isPaper ? t('paper.selTranslate') : t('ai.explain') }}</strong>
        <span v-if="selTr.busy" class="pt-busy">{{ t('paper.translating') }}</span>
        <span style="flex: 1" />
        <button class="icon-btn" :title="t('paper.copy')" :disabled="!selTr.out" @click="copySelTr">⧉</button>
        <button class="icon-btn" @click="closeSelTr">✕</button>
      </div>
      <p class="sel-tr-src">{{ selTr.src }}</p>
      <p class="sel-tr-out">{{ selTr.out || '…' }}</p>
    </div>

    <!-- 高亮想法编辑浮层 -->
    <div v-if="activeAnnotation" class="anno-pop card" :style="{ left: `${popPos.x}px`, top: `${popPos.y}px` }">
      <p class="quote">{{ activeAnnotation.text }}</p>
      <textarea
        v-model="noteDraft"
        class="note-input input"
        rows="3"
        :placeholder="t('reader.notePlaceholder')"
      />
      <div class="pop-actions">
        <button class="btn btn-sm btn-danger" @click="removeAnnotation(activeAnnotation)">{{ t('reader.deleteHighlight') }}</button>
        <span style="flex: 1" />
        <button class="btn btn-sm" @click="activeAnnotation = null">{{ t('common.cancel') }}</button>
        <button class="btn btn-sm btn-primary" @click="saveNote">{{ t('reader.saveNote') }}</button>
      </div>
    </div>

    <!-- 引文/目录跳转后返回原位 -->
    <button v-if="backStack.length" class="back-pill card" @click="goBack">
      ↩ {{ t('paper.jumpBack') }}
    </button>

    <!-- 听书控制条 (藏书 PDF) -->
    <div v-if="ttsPanel" class="tts-panel card">
      <div class="tts-row">
        <button
          class="btn btn-sm btn-primary"
          @click="ttsState === 'playing' ? pauseTTS() : ttsState === 'paused' ? resumeTTS() : startTTS()"
        >
          {{ ttsState === 'playing' ? '⏸ ' + t('common.pause') : ttsState === 'paused' ? '▶ ' + t('common.resume') : '▶ ' + t('tts.startReading') }}
        </button>
        <button class="btn btn-sm" :disabled="ttsState === 'stopped'" @click="stopTTS">⏹ {{ t('common.stop') }}</button>
        <button class="icon-btn" :title="t('common.close')" @click="ttsPanel = false; stopTTS()">✕</button>
      </div>
      <div class="tts-row">
        <label>{{ t('tts.rate') }}</label>
        <input v-model.number="settings.ttsRate" type="range" min="0.5" max="2" step="0.1" />
        <span class="tts-value">{{ settings.ttsRate.toFixed(1) }}x</span>
      </div>
      <div v-if="edgeAvailable()" class="tts-row">
        <label>{{ t('tts.engine') }}</label>
        <div class="seg" style="flex: 1">
          <button :class="{ active: settings.ttsEngine === 'edge' }" @click="settings.ttsEngine = 'edge'; resetEdgeFailure()">{{ t('tts.engineEdge') }}</button>
          <button :class="{ active: settings.ttsEngine === 'local' }" @click="settings.ttsEngine = 'local'; resetEdgeFailure(); refreshLocalStatus()">{{ t('tts.engineLocal') }}</button>
          <button :class="{ active: settings.ttsEngine === 'system' }" @click="settings.ttsEngine = 'system'">{{ t('tts.engineSystem') }}</button>
        </div>
      </div>
      <div v-if="edgeAvailable() && settings.ttsEngine === 'edge'" class="tts-row">
        <label>{{ t('tts.voice') }}</label>
        <select v-model="settings.edgeVoice" class="input">
          <option v-for="v in EDGE_VOICES" :key="v.id" :value="v.id">{{ v.label }}</option>
        </select>
      </div>
      <div v-else-if="edgeAvailable() && settings.ttsEngine === 'local'" class="tts-row">
        <label>{{ t('tts.voice') }}</label>
        <template v-if="localInstalled">
          <select v-model.number="settings.localVoiceId" class="input">
            <option v-for="n in 103" :key="n" :value="n - 1">{{ t('tts.voiceN', { n: n - 1 }) }}{{ n - 1 === 50 ? t('tts.voiceDefault') : '' }}</option>
          </select>
          <button class="btn btn-sm" :disabled="ttsState !== 'stopped'" @click="auditionLocal">{{ t('tts.audition') }}</button>
        </template>
        <button v-else class="btn btn-sm btn-primary" :disabled="localDownloading" @click="downloadLocal">
          {{ localDownloading ? localProgress : t('tts.downloadLocal') }}
        </button>
      </div>
      <div v-else class="tts-row">
        <label>{{ t('tts.voice') }}</label>
        <select v-model="settings.ttsVoice" class="input">
          <option value="">{{ t('tts.autoVoice') }}</option>
          <option v-for="v in ttsVoices" :key="v.name" :value="v.name">{{ v.name }} ({{ v.lang }})</option>
        </select>
      </div>
    </div>

    <!-- 自动翻页控制条：运行后自动收起到顶部状态按钮，避免遮挡正文。 -->
    <Transition name="auto-float">
      <section
        v-if="autoPanel"
        class="auto-panel card"
        :aria-label="t('reader.autoRead')"
        @pointerenter="cancelAutoPanelCollapse"
        @pointerleave="scheduleAutoPanelCollapse(1800)"
        @focusin="cancelAutoPanelCollapse"
        @focusout="scheduleAutoPanelCollapse(1800)"
      >
        <button class="btn btn-sm auto-toggle" :class="{ 'btn-active': autoReading }" @click="autoReading ? stopAutoRead() : startAutoRead()">
          {{ autoReading ? '⏸ ' + t('common.pause') : '▶ ' + t('common.start') }}
        </button>
        <label>{{ t('reader.speed') }}</label>
        <input v-model.number="settings.autoReadSeconds" type="range" min="3" max="60" step="1" />
        <span class="auto-speed">{{ t('reader.secPerPage', { n: settings.autoReadSeconds }) }}</span>
        <button class="icon-btn auto-collapse" :title="t('reader.collapseControls')" @click="collapseAutoPanel">
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="m5.5 7.5 4.5 4.5 4.5-4.5" /></svg>
        </button>
        <button class="icon-btn" :title="t('common.stop')" @click="autoPanel = false; stopAutoRead()">✕</button>
      </section>
    </Transition>
  </div>
</template>

<style scoped>
.paper {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}
.paper:fullscreen,
.paper.is-fullscreen {
  width: 100vw;
  height: 100vh;
  height: 100dvh;
}
.paper.is-fullscreen .paper-header,
.paper.is-fullscreen .side-drawer,
.paper.is-fullscreen .splitter,
.paper.is-fullscreen .pane-right {
  display: none;
}
.paper.is-fullscreen .paper-split {
  background: #17191d;
}
.paper.is-fullscreen .pane-left,
.paper.is-fullscreen .paged-box {
  padding: 20px;
  background: #17191d;
}
.fullscreen-exit {
  position: fixed;
  top: max(18px, env(safe-area-inset-top));
  right: max(18px, env(safe-area-inset-right));
  z-index: 92;
  min-width: 42px;
  height: 42px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 0 12px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 11px;
  background: rgba(18, 20, 24, 0.72);
  color: rgba(255, 255, 255, 0.9);
  font-size: 12px;
  font-weight: 560;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.24);
  backdrop-filter: blur(14px) saturate(130%);
  opacity: 0.78;
  transition: opacity 160ms ease, background-color 160ms ease, transform 120ms ease;
}
.fullscreen-exit:hover,
.fullscreen-exit:focus-visible {
  opacity: 1;
  background: rgba(18, 20, 24, 0.9);
}
.fullscreen-exit:active {
  transform: scale(0.97);
}
.fullscreen-exit svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.presentation-controls {
  position: fixed;
  bottom: max(18px, env(safe-area-inset-bottom));
  left: 50%;
  z-index: 91;
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 38px;
  padding: 4px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 11px;
  background: rgba(18, 20, 24, 0.68);
  color: rgba(255, 255, 255, 0.86);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.22);
  backdrop-filter: blur(14px);
  transform: translateX(-50%);
  opacity: 0.45;
  transition: opacity 160ms ease;
}
.presentation-controls:hover,
.presentation-controls:focus-within {
  opacity: 1;
}
.presentation-controls button {
  width: 34px;
  height: 30px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font-size: 24px;
  line-height: 1;
}
.presentation-controls button:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.12);
}
.presentation-controls button:disabled {
  opacity: 0.28;
}
.presentation-controls span {
  min-width: 68px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.document-dialog-mask {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(20, 24, 32, 0.34);
  backdrop-filter: blur(4px);
}
.document-dialog {
  width: min(560px, 100%);
  max-height: min(720px, calc(100dvh - 48px));
  overflow: auto;
  border-radius: 16px;
  box-shadow: 0 22px 70px rgba(29, 33, 41, 0.22);
}
.document-dialog > header {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 20px 14px;
  background: var(--card);
  border-bottom: 1px solid var(--border);
}
.document-dialog h2 {
  margin: 2px 0 0;
  color: var(--text);
  font-size: 18px;
  letter-spacing: -0.02em;
}
.document-dialog small {
  color: var(--brand);
  font: 650 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 0.12em;
}
.document-dialog dl {
  display: grid;
  grid-template-columns: minmax(112px, 0.34fr) 1fr;
  margin: 0;
  padding: 8px 20px;
}
.document-dialog dt,
.document-dialog dd {
  min-width: 0;
  margin: 0;
  padding: 10px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
  font-size: 13px;
  line-height: 1.55;
}
.document-dialog dt {
  color: var(--text-3);
}
.document-dialog dd {
  color: var(--text);
  overflow-wrap: anywhere;
}
.document-dialog footer {
  display: flex;
  justify-content: flex-end;
  padding: 12px 20px 18px;
}
.paper-header {
  position: relative;
  z-index: 50;
  flex: 0 0 auto;
  background: var(--card);
}
.paper-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  min-height: 64px;
  padding: 8px 16px 8px 12px;
  background: var(--card);
}
.paper-document {
  flex: 1 1 320px;
  min-width: 180px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.document-back {
  width: 36px;
  height: 36px;
}
.paper-title {
  flex: 1;
  min-width: 0;
}
.paper-title strong {
  display: block;
  color: var(--text);
  font-size: 14.5px;
  font-weight: 650;
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.paper-title span {
  display: block;
  margin-top: 2px;
  color: var(--text-3);
  font-size: 11.5px;
  line-height: 1.25;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.paper-context-actions {
  flex: 0 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  overflow-x: auto;
  scrollbar-width: none;
}
.paper-context-actions::-webkit-scrollbar {
  display: none;
}
.paper-context-actions .context-action {
  flex: 0 0 auto;
  height: 34px;
  padding: 0 12px;
  border-color: transparent;
  background: transparent;
  color: var(--text-2);
  box-shadow: none;
}
.paper-context-actions .context-action:hover,
.paper-context-actions .context-action.btn-active,
.paper-context-actions .context-action.btn-primary {
  border-color: color-mix(in srgb, var(--brand) 16%, transparent);
  background: color-mix(in srgb, var(--brand) 8%, var(--card));
  color: var(--brand);
}
.change-document {
  flex: 0 0 auto;
  height: 36px;
  margin-left: 6px;
  padding: 0 16px;
  border-color: var(--border);
  background: var(--card);
  color: var(--text-2);
  font-weight: 550;
}
.pdf-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 52px;
  padding: 7px 12px;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
  background: var(--card);
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
}
.pdf-toolbar::-webkit-scrollbar {
  display: none;
}
.toolbar-group {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.toolbar-layout {
  gap: 6px;
}
.toolbar-page {
  gap: 4px;
}
.toolbar-zoom {
  min-width: 132px;
  justify-content: center;
}
.toolbar-end {
  position: sticky;
  right: 0;
  padding-left: 6px;
  background: var(--card);
  box-shadow: -10px 0 12px var(--card);
}
.toolbar-spacer {
  flex: 1 1 24px;
  min-width: 12px;
}
.toolbar-sep {
  flex: 0 0 auto;
  width: 1px;
  height: 24px;
  margin: 0 3px;
  background: var(--border);
}

/* 藏书 PDF 阅读控制：统一尺寸与选中语言，避免工具条像一排表单按钮。 */
.reader-segment {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  gap: 2px;
  height: 36px;
  padding: 3px;
  border-radius: 9px;
  background: #f2f4f7;
  box-shadow: inset 0 0 0 1px rgba(29, 33, 41, 0.045);
}
.reader-segment button {
  min-width: 46px;
  height: 30px;
  padding: 0 9px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text-2);
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  transition: color 0.18s ease, background-color 0.18s ease, box-shadow 0.18s ease, transform 0.12s ease;
}
.reader-segment button:hover:not(.active) {
  color: var(--text);
  background: rgba(255, 255, 255, 0.62);
}
.reader-segment button.active {
  color: var(--brand);
  background: var(--card);
  box-shadow: 0 1px 3px rgba(22, 100, 255, 0.12), 0 0 0 1px rgba(22, 100, 255, 0.08);
}
.reader-tool {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 36px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--text-2);
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  box-shadow: none;
  transition: color 0.18s ease, border-color 0.18s ease, background-color 0.18s ease, box-shadow 0.18s ease, transform 0.12s ease;
}
.reader-tool svg {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.reader-tool:hover {
  color: var(--brand);
  border-color: rgba(22, 100, 255, 0.25);
  background: #f8faff;
}
.reader-tool.active {
  color: var(--brand);
  border-color: rgba(22, 100, 255, 0.18);
  background: var(--brand-light, #e8f0ff);
  box-shadow: inset 0 0 0 1px rgba(22, 100, 255, 0.04);
}
.reader-segment button:active,
.reader-tool:active {
  transform: translateY(1px);
}
.reader-segment button:focus-visible,
.reader-tool:focus-visible {
  outline: 2px solid rgba(22, 100, 255, 0.55);
  outline-offset: 2px;
}
.page-view-segment button {
  min-width: 36px;
  width: 36px;
  padding: 0;
}
.page-view-segment svg {
  width: 17px;
  height: 17px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.45;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.reader-more-wrap {
  position: relative;
}
.reader-more-backdrop {
  position: fixed;
  inset: 0;
  z-index: 72;
}
.reader-more-menu {
  position: absolute;
  top: calc(100% + 7px);
  right: 0;
  z-index: 73;
  width: 196px;
  padding: 6px;
  border-radius: 11px;
  box-shadow: 0 14px 38px rgba(29, 33, 41, 0.16);
}
.reader-more-menu button {
  width: 100%;
  min-height: 36px;
  padding: 0 10px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text-2);
  font-size: 13px;
  text-align: left;
  transition: background-color 140ms ease, color 140ms ease;
}
.reader-more-menu button:hover,
.reader-more-menu button:focus-visible {
  background: var(--bg);
  color: var(--brand);
}
.paper-pagenum {
  font-size: 12.5px;
  color: var(--text-3);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
.page-input {
  width: 54px;
  height: 34px;
  text-align: center;
  font-size: 13px;
  padding: 0 2px;
  font-variant-numeric: tabular-nums;
}
.icon-btn {
  width: 36px;
  height: 36px;
  border: none;
  background: none;
  border-radius: 8px;
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.icon-btn:hover {
  background: var(--bg);
  color: var(--brand);
}
.icon-btn:disabled {
  opacity: 0.35;
}
.icon-active {
  background: var(--brand-light, #e8f0ff);
  color: var(--brand);
}
.btn-active {
  border-color: var(--brand);
  color: var(--brand);
}
.paper-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
}
.paper-split {
  flex: 1;
  min-height: 0;
  display: flex;
  position: relative;
}
.pane {
  overflow: auto;
  height: 100%;
}
.pane-left-wrap {
  flex: 1.1;
  min-width: 0;
  position: relative;
  display: flex;
}
/* 块级 + margin:auto 布局: 页面居中且放大溢出时可横向滚动 (flex 居中会裁切左侧) */
.pane-left {
  flex: 1;
  min-width: 0;
  padding: 28px 20px;
  background: #eef1f5;
  touch-action: pan-x pan-y;
}
.reflow-scroll {
  flex: 1;
  min-width: 0;
  height: 100%;
  overflow: auto;
  background: var(--reflow-bg);
  color: var(--reflow-fg);
}
.reflow-progress {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 7px 16px;
  color: var(--text-3);
  background: color-mix(in srgb, var(--reflow-bg) 92%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--reflow-fg) 10%, transparent);
  font-size: 12px;
  text-align: center;
  backdrop-filter: blur(8px);
}
.reflow-article {
  box-sizing: border-box;
  width: min(100%, 820px);
  min-height: 100%;
  margin: 0 auto;
  padding: 52px max(28px, var(--reflow-side-pad)) 112px;
  color: var(--reflow-fg);
  font-family: var(--reflow-font-family);
  font-size: var(--reflow-font-size);
}
.reflow-page {
  scroll-margin-top: 28px;
}
.reflow-page + .reflow-page {
  margin-top: 2.8em;
  padding-top: 1.2em;
  border-top: 1px solid color-mix(in srgb, var(--reflow-fg) 10%, transparent);
}
.reflow-page-link {
  display: block;
  margin: 0 auto 1.35em;
  padding: 3px 10px;
  border: 0;
  border-radius: 999px;
  background: color-mix(in srgb, var(--reflow-fg) 7%, transparent);
  color: color-mix(in srgb, var(--reflow-fg) 58%, transparent);
  font: 500 11px/1.7 system-ui, sans-serif;
}
.reflow-page-link:hover {
  background: color-mix(in srgb, var(--reflow-link) 12%, transparent);
  color: var(--reflow-link);
}
.reflow-page p {
  margin: 0 0 1em;
  color: inherit;
  font-size: 1em;
  line-height: var(--reflow-line-height);
  text-align: var(--reflow-align);
  text-indent: 2em;
  overflow-wrap: anywhere;
  hyphens: auto;
}
.reflow-heading {
  margin: 1.8em 0 0.9em;
  color: inherit;
  font-size: 1.34em;
  line-height: 1.45;
  text-align: start;
  text-wrap: balance;
}
.reflow-page-link + .reflow-heading {
  margin-top: 0;
}
.reflow-empty {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 32px;
  color: var(--reflow-fg);
  text-align: center;
}
.reflow-empty span,
.reflow-empty small {
  max-width: 480px;
  color: color-mix(in srgb, var(--reflow-fg) 60%, transparent);
  line-height: 1.7;
}
.paged-box {
  flex: 1;
  min-width: 0;
  height: 100%;
  overflow: auto;
  display: flex;
  padding: 28px 20px;
  background: #eef1f5;
  touch-action: pan-x pan-y;
}
.paged-box.is-panning,
.pane-left.is-panning {
  cursor: grabbing;
  user-select: none;
}
.paged-box.is-panning .p-holder,
.pane-left.is-panning .p-holder {
  cursor: grabbing;
}
.spread-host {
  display: flex;
  align-items: flex-start;
  justify-content: center;
  gap: 16px;
  margin: auto;
}
.scroll-spread-host {
  display: flex;
  align-items: flex-start;
  justify-content: center;
  gap: 16px;
  min-width: min-content;
  margin: 0 auto 16px;
}
.scroll-spread-host:last-child {
  margin-bottom: 0;
}
.scroll-spread-host .p-holder {
  flex: 0 0 auto;
  margin: 0;
}
.spread-host .p-holder {
  margin: 0;
}

/* ---- 顶部阅读控制：缩放档位 / 快捷键 ---- */
.dock-zoom {
  min-width: 72px;
  height: 36px;
  padding: 0 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  font-size: 12.5px;
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  white-space: nowrap;
}
.dock-zoom:hover {
  background: var(--bg);
  color: var(--brand);
}
.dock-caret {
  margin-top: -2px;
  font-size: 12px;
  color: var(--text-3);
}
.zoom-backdrop {
  position: fixed;
  inset: 0;
  z-index: 70;
}
.zoom-menu {
  position: absolute;
  top: 10px;
  left: 50%;
  transform: translateX(calc(-50% - 40px));
  z-index: 71;
  display: flex;
  flex-direction: column;
  padding: 6px;
  border-radius: 10px;
  min-width: 96px;
}
.shortcut-trigger {
  font-size: 14px;
  font-weight: 700;
}
.shortcut-menu {
  position: absolute;
  top: 10px;
  left: 50%;
  z-index: 71;
  width: min(430px, calc(100% - 32px));
  padding: 10px 14px 12px;
  border-radius: 14px;
  transform: translateX(-50%);
}
.shortcut-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 36px;
  margin-bottom: 4px;
}
.shortcut-row {
  display: grid;
  grid-template-columns: minmax(178px, auto) 1fr;
  align-items: center;
  gap: 16px;
  min-height: 39px;
  border-top: 1px solid var(--border);
  color: var(--text-2);
  font-size: 13px;
}
.shortcut-keys {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
}
.shortcut-combo {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.shortcut-or {
  color: var(--text-3);
  font-size: 11px;
}
.shortcut-plus {
  color: var(--text-3);
  font-size: 10px;
}
.shortcut-keys kbd {
  min-width: 26px;
  padding: 3px 7px;
  border: 1px solid var(--border);
  border-bottom-width: 2px;
  border-radius: 6px;
  background: var(--bg);
  color: var(--text-1);
  font: 600 11px/1.35 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  text-align: center;
  white-space: nowrap;
}
.zoom-item {
  border: none;
  background: none;
  text-align: left;
  font-size: 13px;
  color: var(--text-2);
  padding: 7px 12px;
  border-radius: 6px;
}
.zoom-item:hover {
  background: var(--bg);
}
.zoom-item.active {
  color: var(--brand);
  font-weight: 600;
}
.reflow-settings {
  position: absolute;
  top: 10px;
  left: 50%;
  z-index: 71;
  width: min(340px, calc(100% - 32px));
  padding: 14px 16px;
  border-radius: 12px;
  transform: translateX(-50%);
}
.reflow-settings label {
  display: grid;
  grid-template-columns: 64px 1fr 34px;
  align-items: center;
  gap: 10px;
  min-height: 38px;
  color: var(--text-2);
  font-size: 12px;
}
.reflow-settings label strong {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.reflow-settings select {
  grid-column: 2 / 4;
  min-width: 0;
}
.reflow-theme-row {
  display: grid;
  grid-template-columns: 64px repeat(4, 34px);
  align-items: center;
  gap: 10px;
  min-height: 42px;
  color: var(--text-2);
  font-size: 12px;
}
.reflow-theme-row button {
  width: 32px;
  height: 30px;
  border: 1px solid var(--border);
  border-radius: 7px;
  font: 600 13px/1 serif;
}
.reflow-theme-row button.active {
  outline: 2px solid var(--brand);
  outline-offset: 1px;
}

/* ---- 连续滚动页 ---- */
.p-holder {
  position: relative;
  margin: 0 auto 16px;
  background: #fff;
  border: 0;
  box-shadow:
    0 0 0 1px rgba(29, 33, 41, 0.055),
    0 8px 28px rgba(29, 33, 41, 0.11);
  border-radius: 4px;
}
.p-holder:last-child {
  margin-bottom: 0;
}
.p-num {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
  font-size: 12px;
}
.p-canvas {
  position: absolute;
  inset: 0;
  font-size: 0;
}
.p-canvas :deep(canvas) {
  display: block;
  border-radius: 2px;
}
/* PDF 搜索命中层 */
.p-search {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.p-search-rect {
  position: absolute;
  border-radius: 1px;
  background: rgba(255, 214, 0, 0.38);
  box-shadow: inset 0 0 0 1px rgba(190, 145, 0, 0.26);
  mix-blend-mode: multiply;
}
.p-search-rect.active {
  background: rgba(255, 137, 31, 0.62);
  box-shadow: inset 0 0 0 1px rgba(185, 72, 0, 0.58);
}
/* 高亮层: 荧光笔效果, 不拦截事件 (点击命中由 holder 统一处理) */
.p-hl {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.p-hl-rect {
  position: absolute;
  opacity: 0.42;
  mix-blend-mode: multiply;
  border-radius: 1px;
}
/* PDFium 几何选区层 */
.p-sel {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.p-sel-rect {
  position: absolute;
  background: rgba(64, 128, 255, 0.3);
  border-radius: 1px;
  mix-blend-mode: multiply;
}
.p-holder {
  cursor: text;
}

/* 链接层: 引文/外链热区 */
.p-links {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.p-links :deep(.p-link) {
  position: absolute;
  pointer-events: auto;
  cursor: pointer;
  border-radius: 2px;
}
.p-links :deep(.p-link:hover) {
  background: rgba(64, 128, 255, 0.16);
  outline: 1px solid rgba(64, 128, 255, 0.45);
}

/* ---- PDF 页内搜索 ---- */
.pdf-search {
  position: absolute;
  top: 10px;
  right: 12px;
  z-index: 46;
  display: flex;
  align-items: center;
  gap: 4px;
  width: min(500px, calc(100% - 24px));
  min-height: 42px;
  padding: 5px 6px 5px 10px;
  border: 1px solid color-mix(in srgb, var(--border) 78%, transparent);
  border-radius: 11px;
  box-shadow: 0 10px 28px rgba(29, 33, 41, 0.16);
}
.pdf-search-icon {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  color: var(--text-3);
}
.pdf-search-input {
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0 4px;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text);
  font: 13px/1.4 system-ui, sans-serif;
}
.pdf-search-input::-webkit-search-cancel-button {
  display: none;
}
.pdf-search-status {
  min-width: 48px;
  color: var(--text-3);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}
.pdf-search button {
  width: 29px;
  height: 29px;
  flex: 0 0 auto;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text-2);
  font-size: 16px;
  line-height: 1;
}
.pdf-search button:hover:not(:disabled) {
  background: var(--bg);
  color: var(--brand);
}
.pdf-search button:disabled {
  opacity: 0.3;
}
.pdf-search .pdf-search-option {
  width: 31px;
  color: var(--text-3);
  font-size: 11px;
  font-weight: 650;
}
.pdf-search .pdf-search-whole {
  text-decoration: underline;
}
.pdf-search .pdf-search-option.active {
  background: color-mix(in srgb, var(--brand) 12%, transparent);
  color: var(--brand);
}

/* ---- 稳定侧栏 (目录 / 缩略图 / 标注) ---- */
.side-drawer {
  position: relative;
  z-index: 20;
  flex: 0 0 292px;
  width: 292px;
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--card);
  border-right: 1px solid var(--border);
}
.drawer-head {
  flex: 0 0 49px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 0 14px;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}
.drawer-tabs {
  align-self: stretch;
  display: flex;
  align-items: stretch;
  gap: 14px;
}
.drawer-tabs button {
  position: relative;
  min-width: 44px;
  padding: 0 2px;
  border: 0;
  background: transparent;
  color: var(--text-3);
  font-size: 13px;
}
.drawer-tabs button::after {
  content: '';
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 2px;
  border-radius: 2px 2px 0 0;
  background: transparent;
}
.drawer-tabs button:hover,
.drawer-tabs button.active {
  color: var(--brand);
}
.drawer-tabs button.active::after {
  background: var(--brand);
}
.drawer-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px 8px 14px;
}
.drawer-count {
  margin: 2px 7px 8px;
  color: var(--text-3);
  font-size: 11.5px;
}
.drawer-empty {
  font-size: 12.5px;
  color: var(--text-3);
  text-align: center;
  padding: 24px 10px;
  line-height: 1.7;
}
.thumbnail-drawer {
  padding: 14px 12px 28px;
  scroll-behavior: smooth;
  overscroll-behavior: contain;
}
.thumbnail-item {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 10px 8px 9px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease, color 140ms ease;
}
.thumbnail-item + .thumbnail-item {
  margin-top: 4px;
}
.thumbnail-item:hover {
  background: color-mix(in srgb, var(--brand) 6%, var(--bg));
  color: var(--text-2);
}
.thumbnail-item.active {
  border-color: color-mix(in srgb, var(--brand) 24%, transparent);
  background: color-mix(in srgb, var(--brand) 10%, var(--card));
  color: var(--brand);
}
.thumbnail-item:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--brand) 62%, white);
  outline-offset: -2px;
}
.thumbnail-sheet {
  position: relative;
  display: block;
  max-width: 100%;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--border) 84%, #9aa6b5);
  border-radius: 2px;
  background: #fff;
  box-shadow: 0 2px 7px rgba(34, 45, 61, 0.12);
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
.thumbnail-item.active .thumbnail-sheet {
  border-color: color-mix(in srgb, var(--brand) 82%, white);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--brand) 16%, transparent), 0 3px 10px rgba(34, 45, 61, 0.14);
}
.thumbnail-skeleton,
.thumbnail-canvas {
  position: absolute;
  inset: 0;
  display: block;
}
.thumbnail-skeleton {
  background:
    linear-gradient(90deg, transparent 25%, rgba(255, 255, 255, 0.72) 50%, transparent 75%),
    #eef1f5;
  background-size: 220% 100%, 100% 100%;
  animation: thumbnail-shimmer 1.35s ease-in-out infinite;
}
.thumbnail-ready .thumbnail-skeleton {
  display: none;
}
.thumbnail-canvas canvas {
  display: block;
  width: 100%;
  height: 100%;
}
.thumbnail-failed .thumbnail-skeleton {
  animation: none;
  background: repeating-linear-gradient(135deg, #f3f4f6, #f3f4f6 8px, #e9edf1 8px, #e9edf1 16px);
}
.thumbnail-number {
  min-width: 28px;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  line-height: 1.5;
  text-align: center;
}
.thumbnail-item.active .thumbnail-number {
  background: color-mix(in srgb, var(--brand) 12%, transparent);
  font-weight: 600;
}
@keyframes thumbnail-shimmer {
  from { background-position: 130% 0, 0 0; }
  to { background-position: -130% 0, 0 0; }
}
.anno-item {
  display: flex;
  gap: 8px;
  padding: 8px;
  border-radius: 8px;
  cursor: pointer;
}
.anno-item:hover {
  background: var(--bg);
}
.anno-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-top: 4px;
  flex-shrink: 0;
}
.anno-main {
  min-width: 0;
  flex: 1;
}
.anno-text {
  font-size: 12.5px;
  color: var(--text-2);
  line-height: 1.55;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.anno-note {
  font-size: 12px;
  color: var(--text);
  background: var(--bg);
  border-radius: 6px;
  padding: 5px 8px;
  margin-top: 5px;
  line-height: 1.55;
}
.anno-page {
  font-size: 11px;
  color: var(--text-3);
}
.anno-del {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  opacity: 0;
  align-self: flex-start;
}
.anno-item:hover .anno-del {
  opacity: 1;
}

/* ---- 划词浮条 ---- */
.sel-bar {
  position: fixed;
  z-index: 70;
  display: flex;
  align-items: center;
  gap: 3px;
  max-width: calc(100vw - 24px);
  min-height: 46px;
  padding: 6px;
  overflow-x: auto;
  border: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
  border-radius: 15px;
  background: color-mix(in srgb, var(--card) 92%, transparent);
  box-shadow:
    0 18px 48px rgba(31, 42, 68, 0.15),
    0 3px 10px rgba(31, 42, 68, 0.08),
    inset 0 1px 0 rgba(255, 255, 255, 0.86);
  backdrop-filter: blur(18px) saturate(145%);
  -webkit-backdrop-filter: blur(18px) saturate(145%);
  transform: translateX(-50%);
  animation: sel-bar-in 180ms cubic-bezier(0.22, 1, 0.36, 1);
  scrollbar-width: none;
}
.sel-bar::-webkit-scrollbar {
  display: none;
}
@keyframes sel-bar-in {
  from {
    opacity: 0;
    transform: translate(-50%, 5px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: translate(-50%, 0) scale(1);
  }
}
.sel-colors {
  display: flex;
  align-items: center;
  gap: 1px;
  flex-shrink: 0;
}
.sel-color {
  width: 31px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  padding: 0;
  border: none;
  border-radius: 9px;
  background: transparent;
  transition: background 150ms ease, transform 150ms ease;
}
.sel-color:hover {
  background: color-mix(in srgb, var(--text) 6%, transparent);
  transform: translateY(-1px);
}
.sel-color:active {
  transform: translateY(0) scale(0.95);
}
.sel-color-dot {
  width: 18px;
  height: 18px;
  border: 2px solid rgba(255, 255, 255, 0.96);
  border-radius: 50%;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--text-3) 34%, transparent);
  transition: transform 150ms ease, box-shadow 150ms ease;
}
.sel-color:hover .sel-color-dot {
  transform: scale(1.08);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--text-3) 28%, transparent);
}
.sel-sep {
  width: 1px;
  height: 20px;
  margin: 0 3px;
  flex-shrink: 0;
  background: color-mix(in srgb, var(--border) 82%, transparent);
}
.sel-act {
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex-shrink: 0;
  padding: 0 9px;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: var(--text-2);
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  transition: background 150ms ease, color 150ms ease, transform 150ms ease;
}
.sel-act svg,
.sel-close svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.65;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.sel-act:hover {
  background: color-mix(in srgb, var(--text) 6%, transparent);
  color: var(--text);
}
.sel-act:active,
.sel-close:active {
  transform: scale(0.96);
}
.sel-act-ai {
  background: color-mix(in srgb, var(--brand) 8%, transparent);
  color: var(--brand);
}
.sel-act-ai:hover {
  background: color-mix(in srgb, var(--brand) 14%, transparent);
  color: var(--brand-hover);
}
.sel-close {
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  padding: 0;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: var(--text-3);
  transition: background 150ms ease, color 150ms ease, transform 150ms ease;
}
.sel-close:hover {
  background: color-mix(in srgb, var(--text) 6%, transparent);
  color: var(--text);
}
.sel-color:focus-visible,
.sel-act:focus-visible,
.sel-close:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--brand) 72%, white);
  outline-offset: 1px;
}
@media (prefers-reduced-motion: reduce) {
  .sel-bar {
    animation: none;
  }
}

/* ---- 划词翻译浮卡 ---- */
.sel-tr {
  position: fixed;
  z-index: 71;
  width: min(400px, calc(100vw - 32px));
  border-radius: 10px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 46vh;
}
.sel-tr-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.sel-tr-src {
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.5;
  max-height: 60px;
  overflow: auto;
  background: var(--bg);
  border-radius: 6px;
  padding: 6px 8px;
  flex-shrink: 0;
}
.sel-tr-out {
  font-size: 13.5px;
  line-height: 1.8;
  color: var(--text);
  overflow: auto;
  white-space: pre-wrap;
}

/* ---- 想法编辑浮层 ---- */
.anno-pop {
  position: fixed;
  z-index: 72;
  width: min(360px, calc(100vw - 32px));
  border-radius: 10px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.anno-pop .quote {
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.5;
  max-height: 54px;
  overflow: auto;
  border-left: 3px solid var(--border);
  padding-left: 8px;
}
.note-input {
  width: 100%;
  resize: vertical;
  font-size: 13px;
  line-height: 1.6;
  padding: 8px;
  height: auto;
}
.pop-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

/* ---- 听书 / 自动翻页控制条 (悬浮于底部工具条上方) ---- */
.tts-panel {
  position: fixed;
  bottom: 72px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 45;
  width: min(400px, calc(100% - 40px));
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  border-radius: 12px;
}
.tts-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.tts-row label {
  font-size: 13px;
  color: var(--text-2);
  width: 32px;
  flex-shrink: 0;
}
.tts-row input[type='range'] {
  flex: 1;
  accent-color: var(--brand);
}
.tts-row .input {
  flex: 1;
  height: 30px;
}
.tts-value {
  font-size: 12px;
  color: var(--text-3);
  width: 36px;
  text-align: right;
}
.seg {
  display: flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}
.seg button {
  flex: 1;
  height: 28px;
  border: none;
  background: var(--card);
  color: var(--text-2);
  font-size: 12.5px;
}
.seg button.active {
  background: var(--brand-light, #e8f0ff);
  color: var(--brand);
  font-weight: 500;
}
.auto-panel {
  position: fixed;
  bottom: 72px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 45;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: 12px;
  border: 1px solid rgba(29, 33, 41, 0.08);
  box-shadow: 0 8px 26px rgba(22, 100, 255, 0.12), 0 2px 8px rgba(29, 33, 41, 0.08);
  backdrop-filter: blur(14px);
}
.auto-panel label {
  font-size: 13px;
  color: var(--text-2);
}
.auto-panel input[type='range'] {
  width: 160px;
  accent-color: var(--brand);
}
.auto-speed {
  font-size: 12px;
  color: var(--text-3);
  width: 64px;
  font-variant-numeric: tabular-nums;
}
.auto-collapse {
  background: var(--bg);
}
.auto-collapse:hover {
  background: var(--brand-light, #e8f0ff);
}
.auto-float-enter-active,
.auto-float-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.auto-float-enter-from,
.auto-float-leave-to {
  opacity: 0;
  transform: translate(-50%, 8px);
}

/* ---- 返回原位 ---- */
.back-pill {
  position: fixed;
  left: 20px;
  bottom: 20px;
  z-index: 40;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 7px 14px;
  font-size: 12.5px;
  color: var(--text-2);
}
.back-pill:hover {
  color: var(--brand);
  border-color: var(--brand);
}

/* ---- 分栏拖拽把手 ---- */
.splitter {
  width: 6px;
  margin: 0 -3px 0 0;
  cursor: col-resize;
  flex-shrink: 0;
  position: relative;
  z-index: 12;
  touch-action: none;
}
.splitter:hover,
.splitter:active {
  background: var(--brand-light, #e8f0ff);
}

.pane-right {
  min-width: 0;
  height: 100%;
  border-left: 1px solid var(--border);
  background: var(--card);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.rt-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px 16px;
}
/* 问答: 消息区占满, 输入固定底部 */
.rt-chat {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.chat-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-2);
  padding: 10px 16px 6px;
}
.rt-chat .ai-msgs {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 6px 16px 10px;
  margin: 0;
}
.rt-chat .ai-input {
  position: static;
  padding: 10px 16px 12px;
  border-top: 1px solid var(--border);
}
.chat-empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding-top: 14px;
}
.chat-chip {
  border: 1px solid var(--border);
  background: var(--bg);
  border-radius: 999px;
  padding: 6px 12px;
  font-size: 12.5px;
  color: var(--text-2);
}
.chat-chip:hover {
  color: var(--brand);
  border-color: var(--brand);
}
/* ---- AI 辅读 ---- */
.ai-top {
  padding: 0 0 4px;
}
.ai-parsing {
  font-size: 12px;
  color: var(--brand);
  margin: 0 0 8px;
}
.ai-sec {
  margin-bottom: 20px;
}
.ai-sec-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-2);
  margin-bottom: 8px;
}
.ai-progress {
  font-size: 12px;
  color: var(--text-3);
}
.ai-hint {
  font-size: 12px;
  color: var(--text-3);
  margin: 0 0 6px;
}
.ai-text {
  font-size: 13px;
  line-height: 1.85;
  color: var(--text);
  white-space: pre-wrap;
  background: var(--bg);
  border-radius: 8px;
  padding: 10px 12px;
}
.ai-pending {
  color: var(--text-3);
}
.ai-q {
  border-bottom: 1px solid var(--border);
}
.ai-q-head {
  width: 100%;
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 9px 2px;
  border: none;
  background: none;
  text-align: left;
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.5;
}
.ai-q-head:hover {
  color: var(--text);
}
.ai-q-num {
  color: var(--text-3);
  font-weight: 600;
  flex-shrink: 0;
}
.ai-q-num.done {
  color: var(--success, #23a55a);
}
.ai-q-text {
  flex: 1;
}
.ai-q-arrow {
  color: var(--text-3);
}
.ai-q-body {
  padding: 0 2px 10px;
}
.ai-q-actions {
  margin-top: 6px;
  display: flex;
  justify-content: flex-end;
}
.ai-msgs {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 10px;
}
.ai-msg {
  font-size: 13px;
  line-height: 1.8;
  white-space: pre-wrap;
  border-radius: 10px;
  padding: 8px 11px;
  max-width: 92%;
}
.ai-msg.user {
  align-self: flex-end;
  background: var(--brand);
  color: #fff;
}
.ai-msg.assistant {
  align-self: flex-start;
  background: var(--bg);
  color: var(--text);
}
.ai-input {
  position: sticky;
  bottom: 0;
  background: var(--card);
  padding: 8px 0;
  display: flex;
  gap: 8px;
}
.ai-input .input {
  flex: 1;
  height: 32px;
}

.pt-setup {
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.8;
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-start;
  padding-top: 20px;
}
.pt-head {
  display: flex;
  align-items: center;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
  margin-bottom: 10px;
  gap: 10px;
}
.pt-head > span:first-child {
  flex: 1;
}
.pm-switch {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}
.pm-switch button {
  border: none;
  background: none;
  font-size: 12px;
  font-weight: 400;
  padding: 3px 10px;
  color: var(--text-3);
}
.pm-switch button.active {
  background: var(--brand);
  color: #fff;
}
.pt-busy {
  font-size: 12px;
  font-weight: 400;
  color: var(--brand);
}
.pt-act {
  border: none;
  background: none;
  color: var(--brand);
  font-size: 12px;
  font-weight: 400;
  padding: 2px 4px;
}
.pt-act:disabled {
  opacity: 0.4;
}
.pt-errdetail {
  display: block;
  margin-top: 6px;
  font-size: 11px;
  color: var(--danger, #d54941);
  word-break: break-all;
}
.pt-empty {
  font-size: 13px;
  color: var(--text-3);
  padding: 16px 0;
  text-align: center;
}
.pt-start {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 12.5px;
  color: var(--text-3);
  background: var(--bg);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
}
/* 版式对照: 连续滚动 */
.rt-translate {
  padding: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.rt-translate .pt-head {
  padding: 10px 16px 8px;
  margin: 0;
  flex-shrink: 0;
}
.rt-translate .pt-empty {
  flex-shrink: 0;
}
.pt-page {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-3);
  white-space: nowrap;
}
.mp-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: #f2f3f5;
  padding: 12px;
  border-top: 1px solid var(--border);
}
.mp-holder {
  position: relative;
  margin: 0 auto 12px;
  background: #fff;
  border: 1px solid rgba(29, 33, 41, 0.08);
  box-shadow: 0 2px 10px rgba(29, 33, 41, 0.06);
  border-radius: 3px;
}
.mp-holder:last-child {
  margin-bottom: 0;
}
.mp-canvas {
  position: absolute;
  inset: 0;
  font-size: 0;
}
.cards-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 16px 12px;
}
.pm-block {
  position: absolute;
  background: #fff;
  color: #16181c;
  overflow: hidden;
  line-height: 1.34;
  cursor: pointer;
  user-select: text;
  -webkit-user-select: text;
  text-align: justify;
  word-break: break-word;
}
.pm-block:hover {
  outline: 1px dashed rgba(64, 128, 255, 0.55);
}
.pm-block.pm-original {
  background: #eef4ff;
  color: #333;
}
.pt-card {
  border-bottom: 1px solid var(--border);
  padding: 10px 2px;
}
.pt-zh {
  font-size: 14px;
  line-height: 1.9;
  color: var(--text);
  white-space: pre-wrap;
}
.pt-pending {
  color: var(--text-3);
  font-size: 12px;
}
.pt-toggle {
  border: none;
  background: none;
  color: var(--brand);
  font-size: 12px;
  padding: 4px 0 0;
}
.pt-en {
  margin-top: 6px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-3);
  background: var(--bg);
  border-radius: 6px;
  padding: 8px 10px;
}
/* BabelDOC 面板 */
.bd-mask {
  position: fixed;
  inset: 0;
  background: rgba(20, 24, 32, 0.4);
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
}
.bd-panel {
  width: 420px;
  max-width: calc(100vw - 48px);
  background: var(--card);
  border-radius: 12px;
  padding: 20px 22px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.18);
}
.bd-panel h3 {
  margin: 0 0 4px;
  font-size: 15px;
}
.bd-sub {
  font-size: 12px;
  color: var(--text-3);
  margin: 0 0 14px;
  line-height: 1.6;
}
.bd-line {
  font-size: 13px;
  color: var(--text-2);
  word-break: break-all;
}
.bd-ok {
  font-size: 13px;
  color: var(--success, #23a55a);
}
.bd-warn {
  font-size: 12.5px;
  color: var(--danger, #d54941);
  line-height: 1.6;
  word-break: break-all;
}
.bd-hint {
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.6;
}
.bd-cmd {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--bg);
  border-radius: 8px;
  padding: 8px 10px;
  margin: 10px 0;
}
.bd-cmd code {
  flex: 1;
  font-size: 12.5px;
}
.bd-field {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-2);
  margin: 12px 0 6px;
}
.bd-field .input {
  flex: 1;
  height: 30px;
}
.bd-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 14px;
  flex-wrap: wrap;
}
.bd-bar {
  height: 6px;
  border-radius: 3px;
  background: var(--bg);
  overflow: hidden;
  margin: 14px 0 10px;
}
.bd-bar-fill {
  height: 100%;
  background: var(--brand);
  border-radius: 3px;
  transition: width 0.4s;
}
/* 无百分比时的不确定态: 流动条, 表明任务仍在进行 */
.bd-indeterminate .bd-bar-fill {
  width: 32%;
  animation: bd-slide 1.2s ease-in-out infinite;
}
@keyframes bd-slide {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(320%);
  }
}

@media (max-width: 1180px) {
  .paper-bar {
    gap: 10px;
  }
  .paper-context-actions .context-action {
    padding: 0 9px;
  }
  .reader-segment button {
    min-width: 42px;
    padding-inline: 7px;
  }
  .reader-tool {
    padding-inline: 8px;
  }
}

@media (max-width: 860px) {
  .paper-bar {
    min-height: 58px;
    padding-right: 10px;
  }
  .paper-document {
    flex-basis: 210px;
  }
  .paper-context-actions {
    max-width: 58%;
  }
  .paper-context-actions .context-action {
    height: 32px;
    padding-inline: 8px;
  }
  .change-document {
    height: 34px;
    margin-left: 2px;
    padding-inline: 12px;
  }
  .pdf-toolbar {
    min-height: 50px;
    padding: 6px 8px;
  }
  .paper-split {
    flex-direction: row;
  }
  .pane-right {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 35;
    width: min(440px, 84vw) !important;
    height: auto;
    border-left: 1px solid var(--border);
    border-top: 0;
    box-shadow: -10px 0 28px rgba(29, 33, 41, 0.12);
  }
  .side-drawer {
    position: absolute;
    inset: 0 auto 0 0;
    z-index: 36;
    flex-basis: auto;
    width: min(292px, calc(100vw - 48px));
    height: auto;
    box-shadow: 10px 0 28px rgba(29, 33, 41, 0.12);
  }
  .shortcut-row {
    grid-template-columns: 1fr;
    gap: 4px;
    padding: 8px 0;
  }
}

@media (max-width: 620px) {
  .fullscreen-exit {
    width: 42px;
    min-width: 42px;
    padding: 0;
  }
  .fullscreen-exit span {
    display: none;
  }
  .document-dialog dl {
    grid-template-columns: 96px 1fr;
    padding-inline: 16px;
  }
  .paper-title span {
    display: none;
  }
  .paper-context-actions {
    max-width: 64%;
  }
  .context-action {
    font-size: 12px;
  }
  .toolbar-end {
    position: static;
    padding-left: 0;
    box-shadow: none;
  }
}
</style>
