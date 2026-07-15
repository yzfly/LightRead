<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getStorage, type BookMeta, type AnnotationRec } from '../storage'
import { initPdfjs, pdfAssetOptions } from '../services/importer'
import {
  extractParagraphs,
  extractParagraphsLoose,
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
} from '../services/pdfium'
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
import { HIGHLIGHT_COLORS } from '../services/readerTheme'
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
const bookId = String(route.params.id)

const meta = ref<BookMeta>()
const loading = ref(true)
const error = ref('')
const pageCount = ref(0)
const currentPage = ref(1)
const pageInput = ref('1')
const scroller = ref<HTMLElement>()
const rightPane = ref<HTMLElement>()

/** 阅读引擎: PDFium (唯一) — 渲染 / 几何选择 / 链接 / 目录 / 页文本 */
let pdm: PdfiumDoc | null = null
/** 原始文件字节: 供翻译面板懒加载 pdf.js 做段落几何提取 (阅读路径不加载 pdf.js) */
let fileData: ArrayBuffer | null = null
let pdfjsDocPromise: Promise<any> | null = null

async function pdfjsDoc(): Promise<any> {
  if (!pdfjsDocPromise) {
    pdfjsDocPromise = (async () => {
      if (!fileData) throw new Error('document not loaded')
      const pdfjs = await initPdfjs()
      return pdfjs.getDocument({ data: fileData, ...pdfAssetOptions }).promise
    })()
  }
  return pdfjsDocPromise
}
let saveTimer: ReturnType<typeof setTimeout> | undefined
let settleTimer: ReturnType<typeof setTimeout> | undefined
let resizeTimer: ReturnType<typeof setTimeout> | undefined
let resizeObserver: ResizeObserver | undefined
let scrollScheduled = false

useReadingTimer(bookId)

const aiReady = computed(() => aiConfigured())
/** 归属: 论文/藏书 (藏书 PDF 也走本阅读器, 返回目标随归属) */
const isPaper = computed(() => (meta.value?.kind ?? 'paper') === 'paper')
const backTarget = computed(() => (isPaper.value ? '/papers' : '/library'))
const backLabel = computed(() => (isPaper.value ? t('paper.backToPapers') : t('reader.backToLibrary')))

/* ================= 连续滚动渲染 (虚拟化: 只渲染视口附近页) ================= */

const GAP = 16
const PAD = 16
const KEEP = 4
const DPR = () => Math.min(window.devicePixelRatio || 1, 2)
const MAX_DIM = 4096

/** 页面基准尺寸 (scale=1, 以第 1 页为准; 论文各页尺寸一致) */
const baseDims = ref({ w: 612, h: 792 })
/** 当前实际渲染缩放 */
const curScale = ref(1)
/** 缩放档: 适宽 / 固定倍率 (持久化) */
const ZOOM_KEY = 'lightread-paper-zoom'
const zoom = ref<number | 'fit'>(restoreZoom())
function restoreZoom(): number | 'fit' {
  const raw = localStorage.getItem(ZOOM_KEY)
  const n = raw ? parseFloat(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : 'fit'
}

const holderW = computed(() => baseDims.value.w * curScale.value)
const holderH = computed(() => baseDims.value.h * curScale.value)
const holderStyle = computed(() => ({ width: `${holderW.value}px`, height: `${holderH.value}px` }))

const renderedScale = new Map<number, number>()
const rendering = new Set<number>()

function holderOf(num: number) {
  return scroller.value?.querySelector<HTMLElement>(`[data-page="${num}"]`) ?? null
}

function fitScale(): number {
  // 适宽仍保留呼吸边距, 页面不顶到面板边缘
  const width = Math.max((scroller.value?.clientWidth ?? 800) - 48, 320)
  return Math.min(width / baseDims.value.w, 2.5)
}

/** 整页位图 canvas (PDFium) */
async function renderBitmapCanvas(pageNum: number, scale: number): Promise<HTMLCanvasElement> {
  const px = Math.min(scale * DPR(), MAX_DIM / baseDims.value.w, MAX_DIM / baseDims.value.h)
  const img = pdm!.render(pageNum - 1, px)
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  canvas.getContext('2d')!.putImageData(img, 0, 0)
  canvas.style.width = `${baseDims.value.w * scale}px`
  canvas.style.height = `${baseDims.value.h * scale}px`
  return canvas
}

async function renderScrollPage(num: number) {
  if (!pdm || num < 1 || num > pageCount.value || rendering.has(num)) return
  const holder = holderOf(num)
  if (!holder) return
  const scale = curScale.value
  if (renderedScale.get(num) === scale) return
  rendering.add(num)
  try {
    const canvas = await renderBitmapCanvas(num, scale)
    if (scale !== curScale.value) return
    holder.querySelector('.p-canvas')?.replaceChildren(canvas)
    renderedScale.set(num, scale)
    renderPdmLinks(holder, num, scale)
  } finally {
    rendering.delete(num)
  }
}

/** PDFium 链接层: 内链跳转 + 外链系统浏览器 */
function renderPdmLinks(holder: HTMLElement, num: number, scale: number) {
  const host = holder.querySelector<HTMLElement>('.p-links')
  if (!host || !pdm) return
  host.replaceChildren()
  for (const ln of pdm.links(num - 1)) {
    const el = document.createElement('a')
    el.className = 'p-link'
    el.style.left = `${ln.x * scale}px`
    el.style.top = `${ln.y * scale}px`
    el.style.width = `${ln.w * scale}px`
    el.style.height = `${ln.h * scale}px`
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
        scrollGoto(ln.destPage! + 1, false, Math.max(0, (ln.destY ?? 0) * curScale.value - 60))
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
  if (!el || !holderH.value) return 1
  const center = el.scrollTop + el.clientHeight / 2 - PAD
  const idx = Math.floor(center / (holderH.value + GAP))
  return Math.min(Math.max(idx + 1, 1), pageCount.value)
}

function updateViewport() {
  const cur = pageAtCenter()
  if (cur !== currentPage.value) currentPage.value = cur
  for (let i = cur - 1; i <= cur + 2; i++) renderScrollPage(i)
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

function pageTop(n: number): number {
  return PAD + (n - 1) * (holderH.value + GAP)
}

function scrollGoto(n: number, smooth = false, yOffsetPx = 0) {
  const clamped = Math.min(Math.max(1, n || 1), pageCount.value)
  scroller.value?.scrollTo({ top: Math.max(0, pageTop(clamped) + yOffsetPx), behavior: smooth ? 'smooth' : 'auto' })
}

async function applyZoom(next: number | 'fit') {
  zoom.value = next
  if (next === 'fit') localStorage.removeItem(ZOOM_KEY)
  else localStorage.setItem(ZOOM_KEY, String(next))
  relayout(true)
}

function zoomStep(dir: 1 | -1) {
  const cur = zoom.value === 'fit' ? curScale.value : zoom.value
  applyZoom(Math.max(0.4, Math.min(4, +(cur + dir * 0.2).toFixed(2))))
}

/** 缩放档位菜单 (ReadPaper 式: 固定档 + 自适应) */
const ZOOM_PRESETS = [0.5, 0.7, 1, 1.5, 2, 4]
const zoomMenu = ref(false)

function pickZoom(z: number | 'fit') {
  zoomMenu.value = false
  applyZoom(z)
}

/* ---- 全屏 ---- */
const paperRoot = ref<HTMLElement>()

async function toggleFullscreen() {
  const el = paperRoot.value as any
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen()
    } else if (el?.requestFullscreen) {
      await el.requestFullscreen()
    } else if (el?.webkitRequestFullscreen) {
      el.webkitRequestFullscreen()
    } else {
      throw new Error('no element fullscreen')
    }
  } catch {
    // WKWebView 元素全屏不可用时退回窗口全屏
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      const w = getCurrentWindow()
      await w.setFullscreen(!(await w.isFullscreen()))
    } catch { /* Web 端且元素全屏失败: 忽略 */ }
  }
}

/** 重算缩放并保持当前页锚点 (页内比例) */
function relayout(force = false) {
  const el = scroller.value
  if (!el) return
  const next = zoom.value === 'fit' ? fitScale() : zoom.value
  if (!force && Math.abs(next - curScale.value) < 0.001) return
  const anchorPage = currentPage.value
  const frac = holderH.value ? (el.scrollTop - pageTop(anchorPage)) / (holderH.value + GAP) : 0
  curScale.value = next
  renderedScale.clear()
  nextTick(() => {
    scrollGoto(anchorPage, false, frac * (holderH.value + GAP))
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
  if (Number.isFinite(n)) scrollGoto(n)
}

const prevPage = () => scrollGoto(currentPage.value - 1, true)
const nextPage = () => scrollGoto(currentPage.value + 1, true)

/* ================= 跳转返回 (引文 / 目录跳转后回到原位) ================= */

const backStack = ref<number[]>([])

function pushBack() {
  const top = scroller.value?.scrollTop
  if (top == null) return
  backStack.value.push(top)
  if (backStack.value.length > 20) backStack.value.shift()
}

function goBack() {
  const top = backStack.value.pop()
  if (top != null) scroller.value?.scrollTo({ top })
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
const tocItems = ref<TocItem[]>([])

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
  const yOffset = y ? Math.max(0, parseFloat(y) * curScale.value - 60) : 0
  scrollGoto(parseInt(p, 10), false, yOffset)
  tocOpen.value = false
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
const annoOpen = ref(false)
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

const hlStyle = (r: HlRect, color: string) => ({
  left: `${r.x * curScale.value}px`,
  top: `${r.y * curScale.value}px`,
  width: `${r.w * curScale.value}px`,
  height: `${r.h * curScale.value}px`,
  background: HIGHLIGHT_COLORS[color] ?? color,
})

/* ---- PDFium 几何选择: 引擎字符坐标 → 自算命中/选区/绘制 (原生手感) ---- */

const liveSel = ref<{ page: number; a: number; b: number } | null>(null)
let dragSel: { page: number; anchor: number; moved: boolean } | null = null
let suppressClick = false

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
  const s = curScale.value
  const x = (clientX - hb.left) / s
  const y = (clientY - hb.top) / s
  const model = pdm.text(page - 1)
  if (clampToPage) {
    if (y < 0) return 0
    if (y > baseDims.value.h) return model.count
    const b = hitBoundary(model, Math.min(Math.max(x, 0), baseDims.value.w), y)
    return b >= 0 ? b : y < baseDims.value.h / 2 ? 0 : model.count
  }
  return hitBoundary(model, x, y)
}

function onScrollerPointerDown(e: PointerEvent) {
  if (!pdm || e.button !== 0) return
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
  const s = curScale.value
  const last = rects[rects.length - 1]
  liveSel.value = { page, a, b }
  selection.value = {
    text,
    page,
    rects,
    anchor: hb
      ? {
          x: Math.min(hb.left + (last.x + last.w) * s, window.innerWidth - 20),
          y: hb.top + (last.y + last.h) * s,
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
  return {
    left: `${Math.max(12, Math.min(x - 140, window.innerWidth - 320))}px`,
    top: `${Math.min(y + 10, window.innerHeight - 56)}px`,
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
  annoOpen.value = false
  pushBack()
  scrollGoto(loc.page, false, Math.max(0, (loc.rects[0]?.y ?? 0) * curScale.value - 100))
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
  const s = curScale.value
  const px = (e.clientX - hb.left) / s
  const py = (e.clientY - hb.top) / s
  const hit = pageHls.value.get(page)?.find(
    ({ r }) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h,
  )
  if (hit) {
    noteDraft.value = hit.a.note ?? ''
    popPos.value = clampPop(e.clientX - 160, e.clientY + 12)
    activeAnnotation.value = hit.a
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
  let pdfPage: any = null
  try {
    // 段落几何提取仍基于 pdf.js 文本项 (首次打开翻译面板时懒加载)
    pdfPage = await (await pdfjsDoc()).getPage(page)
    d.paras = await extractParagraphs(pdfPage)
  } catch (e: any) {
    console.error('paragraph extraction failed:', e)
    d.err = String(e?.message ?? e).slice(0, 160)
  }
  // 严格算法无结果时宽松兜底: 只要有文字就切得出块
  if (!d.paras.length && pdfPage) {
    try {
      d.paras = await extractParagraphsLoose(pdfPage)
    } catch (e: any) {
      console.error('loose extraction failed:', e)
      if (!d.err) d.err = String(e?.message ?? e).slice(0, 160)
    }
  }
  d.trs = new Array(d.paras.length).fill('')
  const cached = cachedTranslation(bookId, page, d.paras.length)
  if (cached) d.trs = cached
  mirData.value = { ...mirData.value, [page]: d }
  return d
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

const settings = useSettings()

/** 页文本 (听书 / AI 上下文) */
async function pageTextFor(n: number): Promise<string> {
  return pdm ? pdm.pageText(n - 1).replace(/\s+/g, ' ').trim() : ''
}

/* ---- 自动翻页 ---- */
const autoReading = ref(false)
const autoPanel = ref(false)
let autoTimer: ReturnType<typeof setInterval> | undefined

function startAutoRead() {
  stopAutoRead()
  autoReading.value = true
  autoTimer = setInterval(() => {
    if (currentPage.value >= pageCount.value) {
      stopAutoRead()
      return
    }
    scrollGoto(currentPage.value + 1, true)
  }, settings.autoReadSeconds * 1000)
}

function stopAutoRead() {
  autoReading.value = false
  clearInterval(autoTimer)
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
      scrollGoto(pageNum)
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

function handleKeydown(e: KeyboardEvent) {
  const target = e.target as HTMLElement
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
  if (e.key === 'Escape') {
    selection.value = null
    liveSel.value = null
    dragSel = null
    activeAnnotation.value = null
    closeSelTr()
    tocOpen.value = false
    annoOpen.value = false
    zoomMenu.value = false
    stopAutoRead()
    autoPanel.value = false
    return
  }
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') prevPage()
  else if (e.key === 'ArrowRight' || e.key === 'PageDown') nextPage()
}

onMounted(async () => {
  window.addEventListener('keydown', handleKeydown)
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
    // PDFium 把字节拷入 wasm 堆, fileData 原样留给翻译面板的 pdf.js 懒加载
    fileData = await blob.arrayBuffer()
    pdm = await PdfiumDoc.open(fileData)
    pageCount.value = pdm.pages.length
    baseDims.value = { w: pdm.pages[0]?.w ?? 612, h: pdm.pages[0]?.h ?? 792 }
    loading.value = false
    await nextTick()
    curScale.value = zoom.value === 'fit' ? fitScale() : zoom.value
    scroller.value?.addEventListener('scroll', onScroll, { passive: true })
    const saved = parseInt(meta.value.location ?? '1', 10)
    await nextTick()
    if (Number.isFinite(saved) && saved > 1) scrollGoto(saved)
    updateViewport()
    buildOutline()
    resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (zoom.value === 'fit') relayout()
        if (translateOpen.value) mirLayoutNow()
      }, 200)
    })
    if (scroller.value) resizeObserver.observe(scroller.value)
  } catch (e: any) {
    console.error(e)
    error.value = e?.message ?? t('reader.cantOpenPdf')
  } finally {
    loading.value = false
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
  translateSession++
  selTrSession++
  cancelAi()
  stopTTS()
  stopAutoRead()
  clearTimeout(mirSettleTimer)
  resizeObserver?.disconnect()
  scroller.value?.removeEventListener('scroll', onScroll)
  clearTimeout(saveTimer)
  clearTimeout(settleTimer)
  clearTimeout(resizeTimer)
  pdfjsDocPromise?.then(d => d?.destroy?.()).catch(() => {})
  pdfjsDocPromise = null
  window.removeEventListener('pointermove', onDragMove)
  pdm?.close()
  pdm = null
  bdUnlisten?.()
  if (bd.value.phase === 'running') babeldocCancel().catch(() => {})
})
</script>

<template>
  <div ref="paperRoot" class="paper">
    <header class="paper-bar">
      <button class="icon-btn" :title="backLabel" @click="router.push(backTarget)">
        <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M14.7 5.3a1 1 0 0 1 0 1.4L9.42 12l5.3 5.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0z"/></svg>
      </button>
      <button
        class="icon-btn"
        :class="{ 'icon-active': tocOpen }"
        :title="t('reader.toc')"
        @click="tocOpen = !tocOpen; annoOpen = false"
      >
        <svg viewBox="0 0 24 24" width="17" height="17"><path fill="currentColor" d="M4 6a1 1 0 0 1 1-1h14a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1zm0 6a1 1 0 0 1 1-1h14a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1zm1 5a1 1 0 1 0 0 2h9a1 1 0 1 0 0-2H5z"/></svg>
      </button>
      <button
        class="icon-btn"
        :class="{ 'icon-active': annoOpen }"
        :title="t('reader.highlightsTab')"
        @click="annoOpen = !annoOpen; tocOpen = false"
      >
        <svg viewBox="0 0 24 24" width="17" height="17"><path fill="currentColor" d="M15.6 3.6a2 2 0 0 1 2.8 0l2 2a2 2 0 0 1 0 2.8l-9.2 9.2a2 2 0 0 1-.9.5l-4 1a1 1 0 0 1-1.2-1.2l1-4a2 2 0 0 1 .5-.9l9-9.4zM14 7.4 7 14.6l-.5 2 2-.5 7-7.2L14 7.4zm2.4-2.4-1 1L17 7.6l1-1-1.6-1.6z"/></svg>
      </button>
      <div class="paper-title"><strong>{{ meta?.title }}</strong></div>
      <div class="paper-actions">
        <!-- 论文: 英文精读功能集 -->
        <template v-if="isPaper">
          <button
            class="btn btn-sm"
            :class="translateOpen ? 'btn-active' : 'btn-primary'"
            :disabled="!pageCount"
            @click="openRight('translate')"
          >
            {{ t('paper.openTranslate') }}
          </button>
          <button class="btn btn-sm" :class="{ 'btn-active': rightTab === 'ai' }" :disabled="!pageCount" @click="openRight('ai')">
            {{ t('paper.aiTab') }}
          </button>
          <button class="btn btn-sm" :class="{ 'btn-active': rightTab === 'chat' }" :disabled="!pageCount" @click="openRight('chat')">
            {{ t('paper.chatTab') }}
          </button>
          <button v-if="bdSupported" class="btn btn-sm" :title="t('paper.bdTooltip')" @click="openBabeldoc">
            {{ t('paper.bdButton') }}
          </button>
        </template>
        <!-- 藏书 PDF: 读书功能集 (与 epub 一致) -->
        <template v-else>
          <button class="btn btn-sm" :class="{ 'btn-active': autoReading }" @click="autoPanel = !autoPanel; if (autoPanel) ttsPanel = false">
            {{ autoReading ? t('reader.autoReading') : t('reader.autoRead') }}
          </button>
          <button class="btn btn-sm" :class="{ 'btn-active': ttsState !== 'stopped' }" @click="openTTSPanel">
            {{ ttsState !== 'stopped' ? t('tts.readingNow') : t('tts.title') }}
          </button>
        </template>
      </div>
    </header>

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
      <!-- 目录抽屉 -->
      <aside v-if="tocOpen" class="side-drawer card">
        <div class="drawer-head">
          <strong>{{ t('reader.toc') }}</strong>
          <button class="icon-btn" @click="tocOpen = false">✕</button>
        </div>
        <div class="drawer-body">
          <TocList v-if="tocItems.length" :items="tocItems" @navigate="tocNavigate" />
          <p v-else class="drawer-empty">{{ t('paper.noOutline') }}</p>
        </div>
      </aside>

      <!-- 标注列表抽屉 -->
      <aside v-if="annoOpen" class="side-drawer card">
        <div class="drawer-head">
          <strong>{{ t('reader.highlightsTab') }} ({{ highlights.length }})</strong>
          <button class="icon-btn" @click="annoOpen = false">✕</button>
        </div>
        <div class="drawer-body">
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
        <div
          ref="scroller"
          class="pane pane-left"
          @pointerdown="onScrollerPointerDown"
          @dblclick="onScrollerDblClick"
        >
          <div
            v-for="n in pageCount"
            :key="n"
            class="p-holder"
            :data-page="n"
            :style="holderStyle"
            @click="onHolderClick($event, n)"
          >
            <span class="p-num">{{ n }}</span>
            <div class="p-canvas" />
            <div class="p-hl">
              <div v-for="h in pageHls.get(n) ?? []" :key="h.key" class="p-hl-rect" :style="hlStyle(h.r, h.a.color)" />
            </div>
            <!-- PDFium 几何选区 -->
            <div v-if="liveRects && liveRects.page === n" class="p-sel">
              <div
                v-for="(r, i) in liveRects.rects"
                :key="i"
                class="p-sel-rect"
                :style="{
                  left: `${r.x * curScale}px`,
                  top: `${r.y * curScale}px`,
                  width: `${r.w * curScale}px`,
                  height: `${r.h * curScale}px`,
                }"
              />
            </div>
            <div class="p-links" />
          </div>
        </div>

        <!-- 底部悬浮工具条: 页码 / 全屏 / 缩放档位 -->
        <div class="dock card">
          <button class="icon-btn" :title="t('reader.prevPage')" :disabled="currentPage <= 1" @click="prevPage">
            <svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M14.7 5.3a1 1 0 0 1 0 1.4L9.42 12l5.3 5.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0z"/></svg>
          </button>
          <span class="paper-pagenum">
            <input v-model="pageInput" class="input page-input" @keyup.enter="jumpTo" @blur="jumpTo" />
            / {{ pageCount }}
          </span>
          <button class="icon-btn" :title="t('reader.nextPage')" :disabled="currentPage >= pageCount" @click="nextPage">
            <svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M9.3 5.3a1 1 0 0 1 1.4 0l6 6a1 1 0 0 1 0 1.4l-6 6a1 1 0 0 1-1.4-1.4l5.29-5.3-5.3-5.3a1 1 0 0 1 0-1.4z"/></svg>
          </button>
          <span class="dock-sep" />
          <button class="icon-btn" :title="t('paper.fullscreen')" @click="toggleFullscreen">
            <svg viewBox="0 0 24 24" width="15" height="15"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/></svg>
          </button>
          <span class="dock-sep" />
          <button class="icon-btn" :title="t('reader.zoomOut')" @click="zoomStep(-1)">−</button>
          <button class="dock-zoom" @click="zoomMenu = !zoomMenu">
            {{ zoom === 'fit' ? t('reader.fitWidth') : `${Math.round(curScale * 100)}%` }}
            <span class="dock-caret">▾</span>
          </button>
          <button class="icon-btn" :title="t('reader.zoomIn')" @click="zoomStep(1)">＋</button>
        </div>

        <!-- 缩放档位菜单 -->
        <div v-if="zoomMenu" class="zoom-backdrop" @click="zoomMenu = false" />
        <div v-if="zoomMenu" class="zoom-menu card">
          <button
            v-for="p in ZOOM_PRESETS"
            :key="p"
            class="zoom-item"
            :class="{ active: zoom !== 'fit' && Math.abs((zoom as number) - p) < 0.01 }"
            @click="pickZoom(p)"
          >{{ Math.round(p * 100) }}%</button>
          <button class="zoom-item" :class="{ active: zoom === 'fit' }" @click="pickZoom('fit')">
            {{ t('reader.fitWidth') }}
          </button>
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
    <div v-if="selection" class="sel-bar card" :style="selBarStyle" @mousedown.prevent>
      <button
        v-for="(hex, name) in HIGHLIGHT_COLORS"
        :key="name"
        class="sel-color"
        :style="{ background: hex }"
        :title="t('reader.highlight')"
        @click="addHighlight(name as string)"
      />
      <span class="sel-sep" />
      <button class="sel-act" @click="addHighlight('yellow', true)">💬 {{ t('reader.writeNote') }}</button>
      <button class="sel-act" @click="translateSelection">✦ {{ isPaper ? t('paper.selTranslateBtn') : t('ai.explain') }}</button>
      <button class="sel-act" @click="copySelection">{{ t('paper.copy') }}</button>
      <button class="icon-btn sel-close" @click="selection = null">✕</button>
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

    <!-- 自动翻页控制条 (藏书 PDF) -->
    <div v-if="autoPanel" class="auto-panel card">
      <button class="btn btn-sm" :class="{ 'btn-active': autoReading }" @click="autoReading ? stopAutoRead() : startAutoRead()">
        {{ autoReading ? '⏸ ' + t('common.pause') : '▶ ' + t('common.start') }}
      </button>
      <label>{{ t('reader.speed') }}</label>
      <input v-model.number="settings.autoReadSeconds" type="range" min="3" max="60" step="1" />
      <span class="auto-speed">{{ t('reader.secPerPage', { n: settings.autoReadSeconds }) }}</span>
      <button class="icon-btn" :title="t('common.close')" @click="autoPanel = false; stopAutoRead()">✕</button>
    </div>
  </div>
</template>

<style scoped>
.paper {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}
.paper-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  background: var(--card);
  border-bottom: 1px solid var(--border);
}
.paper-title {
  flex: 1;
  min-width: 0;
}
.paper-title strong {
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: block;
}
.paper-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.paper-pagenum {
  font-size: 12px;
  color: var(--text-3);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
.page-input {
  width: 44px;
  height: 26px;
  text-align: center;
  font-size: 12px;
  padding: 0 2px;
}
.icon-btn {
  width: 30px;
  height: 30px;
  border: none;
  background: none;
  border-radius: 6px;
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
  padding: 16px;
  background: #f2f3f5;
}

/* ---- 底部悬浮工具条 ---- */
.dock {
  position: absolute;
  bottom: 14px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 26;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  border-radius: 12px;
  opacity: 0.94;
}
.dock:hover {
  opacity: 1;
}
.dock-sep {
  width: 1px;
  height: 16px;
  background: var(--border);
  margin: 0 3px;
}
.dock-zoom {
  border: none;
  background: none;
  font-size: 12.5px;
  color: var(--text-2);
  padding: 4px 6px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  white-space: nowrap;
}
.dock-zoom:hover {
  background: var(--bg);
  color: var(--brand);
}
.dock-caret {
  font-size: 10px;
  color: var(--text-3);
}
.zoom-backdrop {
  position: fixed;
  inset: 0;
  z-index: 27;
}
.zoom-menu {
  position: absolute;
  bottom: 62px;
  left: 50%;
  transform: translateX(calc(-50% + 60px));
  z-index: 28;
  display: flex;
  flex-direction: column;
  padding: 6px;
  border-radius: 10px;
  min-width: 96px;
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

/* ---- 连续滚动页 ---- */
.p-holder {
  position: relative;
  margin: 0 auto 16px;
  background: #fff;
  border: 1px solid rgba(29, 33, 41, 0.08);
  box-shadow: 0 2px 10px rgba(29, 33, 41, 0.06);
  border-radius: 3px;
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
  border-radius: 2px;
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

/* ---- 侧抽屉 (目录 / 标注) ---- */
.side-drawer {
  position: absolute;
  left: 10px;
  top: 10px;
  bottom: 10px;
  width: 280px;
  z-index: 30;
  display: flex;
  flex-direction: column;
  border-radius: 10px;
  overflow: hidden;
}
.drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px 6px;
  font-size: 13px;
}
.drawer-body {
  flex: 1;
  overflow: auto;
  padding: 4px 8px 10px;
}
.drawer-empty {
  font-size: 12.5px;
  color: var(--text-3);
  text-align: center;
  padding: 24px 10px;
  line-height: 1.7;
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
  gap: 7px;
  padding: 7px 10px;
  border-radius: 10px;
}
.sel-color {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid #fff;
  box-shadow: 0 0 0 1px var(--border);
  padding: 0;
}
.sel-color:hover {
  transform: scale(1.15);
}
.sel-sep {
  width: 1px;
  height: 16px;
  background: var(--border);
}
.sel-act {
  border: none;
  background: none;
  font-size: 12.5px;
  color: var(--text-2);
  padding: 3px 6px;
  border-radius: 6px;
  white-space: nowrap;
}
.sel-act:hover {
  background: var(--bg);
  color: var(--brand);
}
.sel-close {
  width: 24px;
  height: 24px;
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

@media (max-width: 860px) {
  .paper-split {
    flex-direction: column;
  }
  .pane-right {
    border-left: none;
    border-top: 1px solid var(--border);
  }
  .side-drawer {
    width: min(280px, calc(100vw - 40px));
  }
}
</style>
