<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getStorage, type BookMeta } from '../storage'
import { initPdfjs, pdfAssetOptions } from '../services/importer'
import {
  extractParagraphs,
  extractParagraphsLoose,
  restorePlaceholders,
  type PaperParagraph,
} from '../services/paperText'
import { translatePage, cachedTranslation } from '../services/paperTranslate'
import { aiConfigured } from '../services/ai'
import { useLibrary } from '../stores/library'
import { useReadingTimer } from '../composables/useReadingTimer'
import { toast } from '../services/toast'
import { t } from '../i18n'

const route = useRoute()
const router = useRouter()
const library = useLibrary()
const bookId = String(route.params.id)

const meta = ref<BookMeta>()
const loading = ref(true)
const error = ref('')
const page = ref(1)
const pageCount = ref(0)
const pageInput = ref('1')
const canvasHost = ref<HTMLElement>()
const textHost = ref<HTMLElement>()
const leftPane = ref<HTMLElement>()
const rightPane = ref<HTMLElement>()
const mirrorHost = ref<HTMLElement>()
const stageRef = ref<HTMLElement>()

const paragraphs = ref<PaperParagraph[]>([])
const translations = ref<string[]>([])
const translating = ref(false)
const extractError = ref(false)
const extractErrorMsg = ref('')
const expanded = ref<Set<number>>(new Set())
const showOrig = ref<Set<number>>(new Set())
let translateSession = 0

/** 右侧视图: 版式对照 (默认) / 段落列表 */
const VIEW_KEY = 'lightread-paper-view'
const viewMode = ref<'mirror' | 'cards'>(localStorage.getItem(VIEW_KEY) === 'cards' ? 'cards' : 'mirror')

let pdf: any = null
let pdfjsMod: any = null
let renderSession = 0
let mirrorSession = 0
let resizeObserver: ResizeObserver | undefined
let saveTimer: ReturnType<typeof setTimeout> | undefined

useReadingTimer(bookId)

const aiReady = computed(() => aiConfigured())
const hasGeometry = computed(() => paragraphs.value.some(p => p.bbox))
/** 无几何信息 (宽松兜底提取) 时自动退回列表模式 */
const effectiveMode = computed(() => (viewMode.value === 'mirror' && hasGeometry.value ? 'mirror' : 'cards'))

/** 占位符还原后的译文 (供两种视图共用) */
const displayTexts = computed(() =>
  translations.value.map((tr, i) => restorePlaceholders(tr, paragraphs.value[i]?.placeholders)),
)
const origText = (p: PaperParagraph) => restorePlaceholders(p.text, p.placeholders)

/** 版式对照: 已有译文的几何段落才铺遮罩 (未译前透出原文) */
const blocks = computed(() => paragraphs.value.filter(p => p.bbox && displayTexts.value[p.id]))

/** 版式画布度量: css 尺寸 / 缩放 / PDF 页高 */
const mir = ref({ w: 0, h: 0, scale: 1, pageH: 0 })

const DPR = () => Math.min(window.devicePixelRatio || 1, 2)
const MAX_DIM = 4096

async function renderToCanvas(pdfPage: any, cssWidth: number) {
  const base = pdfPage.getViewport({ scale: 1 })
  let scale = (cssWidth / base.width) * DPR()
  if (base.width * scale > MAX_DIM || base.height * scale > MAX_DIM) {
    scale = Math.min(MAX_DIM / base.width, MAX_DIM / base.height)
  }
  const viewport = pdfPage.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  const cssScale = scale / DPR()
  canvas.style.width = `${Math.floor(base.width * cssScale)}px`
  await pdfPage.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport } as any).promise
  return { canvas, cssScale, cssW: base.width * cssScale, cssH: base.height * cssScale, pageH: base.height }
}

async function renderPage() {
  if (!pdf || !canvasHost.value || !leftPane.value) return
  const session = ++renderSession
  const pdfPage = await pdf.getPage(page.value)
  const r = await renderToCanvas(pdfPage, leftPane.value.clientWidth - 24)
  if (session !== renderSession) return
  canvasHost.value.replaceChildren(r.canvas)
  leftPane.value.scrollTop = 0
  // 文本层: 原文划词选择
  if (textHost.value && pdfjsMod?.TextLayer) {
    textHost.value.replaceChildren()
    textHost.value.style.setProperty('--scale-factor', String(r.cssScale))
    try {
      const tl = new pdfjsMod.TextLayer({
        textContentSource: pdfPage.streamTextContent(),
        container: textHost.value,
        viewport: pdfPage.getViewport({ scale: r.cssScale }),
      })
      await tl.render()
    } catch (e) {
      console.warn('text layer failed:', e)
    }
  }
}

async function renderMirror() {
  if (!pdf || !rightPane.value || effectiveMode.value !== 'mirror' || !mirrorHost.value) return
  const session = ++mirrorSession
  const pdfPage = await pdf.getPage(page.value)
  const r = await renderToCanvas(pdfPage, Math.min(rightPane.value.clientWidth - 28, 980))
  if (session !== mirrorSession) return
  mirrorHost.value.replaceChildren(r.canvas)
  mir.value = { w: r.cssW, h: r.cssH, scale: r.cssScale, pageH: r.pageH }
  queueFit()
}

/**
 * 版式求解 (先算好每个块的最终几何再填充, 避免遮罩互相覆盖):
 * 按列分组 → 列内按纵向排序 → 与下一块重叠时裁掉本块底部。
 */
interface BlockRect {
  left: number
  top: number
  width: number
  height: number
  base: number
}
const layout = computed<Map<number, BlockRect>>(() => {
  const s = mir.value.scale
  const pageH = mir.value.pageH
  const pageW = mir.value.w
  const rects = paragraphs.value
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
  return new Map(rects.map(r => [r.id, r]))
})

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

function blockStyle(p: PaperParagraph) {
  const r = layout.value.get(p.id)
  if (!r) return {}
  const text = showOrig.value.has(p.id) ? origText(p) : displayTexts.value[p.id] ?? ''
  return {
    left: `${r.left}px`,
    top: `${r.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
    fontSize: `${fitFont(text, r.width, r.height, r.base)}px`,
  }
}

/** 兜底微调: 预计算字号后仍溢出的个别块 (换行低效) 再小步递减 */
let fitQueued = false
function queueFit() {
  if (fitQueued) return
  fitQueued = true
  nextTick(() =>
    requestAnimationFrame(() => {
      fitQueued = false
      const host = stageRef.value
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
watch([displayTexts, showOrig], queueFit)

function setMode(mode: 'mirror' | 'cards') {
  viewMode.value = mode
  localStorage.setItem(VIEW_KEY, mode)
}
watch(effectiveMode, mode => {
  if (mode === 'mirror') nextTick(renderMirror)
})

function toggleBlock(id: number) {
  // 划词选择时不触发切换
  if (window.getSelection()?.toString()) return
  const next = new Set(showOrig.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  showOrig.value = next
}

async function loadParagraphs() {
  if (!pdf) return
  extractError.value = false
  extractErrorMsg.value = ''
  let pdfPage: any = null
  try {
    pdfPage = await pdf.getPage(page.value)
    paragraphs.value = await extractParagraphs(pdfPage)
  } catch (e: any) {
    console.error('paragraph extraction failed:', e)
    paragraphs.value = []
    extractErrorMsg.value = String(e?.message ?? e).slice(0, 160)
  }
  // 严格算法无结果时宽松兜底: 只要有文字就切得出块
  if (!paragraphs.value.length && pdfPage) {
    try {
      paragraphs.value = await extractParagraphsLoose(pdfPage)
    } catch (e: any) {
      console.error('loose extraction failed:', e)
      if (!extractErrorMsg.value) extractErrorMsg.value = String(e?.message ?? e).slice(0, 160)
    }
  }
  extractError.value = !paragraphs.value.length
}

async function runTranslate(force = false) {
  const session = ++translateSession
  const paras = paragraphs.value.map(p => p.text)
  translations.value = new Array(paras.length).fill('')
  if (!paras.length || !aiReady.value) return
  if (!force) {
    const cached = cachedTranslation(bookId, page.value, paras.length)
    if (cached) {
      translations.value = cached
      return
    }
  }
  translating.value = true
  try {
    await translatePage(
      bookId,
      page.value,
      paras,
      snapshot => {
        if (session === translateSession) translations.value = snapshot
      },
      () => session !== translateSession,
    )
  } catch (e: any) {
    if (session === translateSession) {
      toast(`${t('paper.translateFailed')}: ${e?.message ?? e}`, 'error', 6000)
    }
  } finally {
    if (session === translateSession) translating.value = false
  }
}

async function showPage(n: number) {
  if (!pdf) return
  page.value = Math.min(Math.max(1, n), pageCount.value)
  pageInput.value = String(page.value)
  expanded.value = new Set()
  showOrig.value = new Set()
  rightPane.value?.scrollTo({ top: 0 })
  await Promise.all([renderPage(), loadParagraphs()])
  runTranslate()
  await nextTick()
  renderMirror()
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    library.saveProgress(bookId, String(page.value), pageCount.value ? page.value / pageCount.value : 0)
  }, 600)
}

const prevPage = () => showPage(page.value - 1)
const nextPage = () => showPage(page.value + 1)

function jumpTo() {
  const n = parseInt(pageInput.value, 10)
  if (Number.isFinite(n)) showPage(n)
}

function toggleOriginal(id: number) {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

function handleKeydown(e: KeyboardEvent) {
  const target = e.target as HTMLElement
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
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
    const blob = await storage.getBookFile(bookId)
    pdfjsMod = await initPdfjs()
    pdf = await pdfjsMod.getDocument({ data: await blob.arrayBuffer(), ...pdfAssetOptions }).promise
    pageCount.value = pdf.numPages
    const saved = parseInt(meta.value.location ?? '1', 10)
    loading.value = false
    await showPage(Number.isFinite(saved) ? saved : 1)
    resizeObserver = new ResizeObserver(() => {
      renderPage()
      renderMirror()
    })
    if (leftPane.value) resizeObserver.observe(leftPane.value)
    if (rightPane.value) resizeObserver.observe(rightPane.value)
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
  renderSession++
  mirrorSession++
  resizeObserver?.disconnect()
  clearTimeout(saveTimer)
  pdf?.destroy?.()
})
</script>

<template>
  <div class="paper">
    <header class="paper-bar">
      <button class="icon-btn" :title="t('paper.backToPapers')" @click="router.push('/papers')">
        <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M14.7 5.3a1 1 0 0 1 0 1.4L9.42 12l5.3 5.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0z"/></svg>
      </button>
      <div class="paper-title"><strong>{{ meta?.title }}</strong></div>
      <div class="paper-actions">
        <button class="icon-btn" :title="t('reader.prevPage')" :disabled="page <= 1" @click="prevPage">
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M14.7 5.3a1 1 0 0 1 0 1.4L9.42 12l5.3 5.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0z"/></svg>
        </button>
        <span class="paper-pagenum">
          <input v-model="pageInput" class="input page-input" @keyup.enter="jumpTo" @blur="jumpTo" />
          / {{ pageCount }}
        </span>
        <button class="icon-btn" :title="t('reader.nextPage')" :disabled="page >= pageCount" @click="nextPage">
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M9.3 5.3a1 1 0 0 1 1.4 0l6 6a1 1 0 0 1 0 1.4l-6 6a1 1 0 0 1-1.4-1.4l5.29-5.3-5.3-5.3a1 1 0 0 1 0-1.4z"/></svg>
        </button>
        <button class="btn btn-sm" :disabled="translating || !paragraphs.length || !aiReady" @click="runTranslate(true)">
          {{ translating ? t('paper.translating') : t('paper.retranslate') }}
        </button>
      </div>
    </header>

    <div v-if="loading" class="paper-state">{{ t('reader.opening') }}</div>
    <div v-else-if="error" class="paper-state">
      <p>{{ error }}</p>
      <button class="btn" @click="router.push('/papers')">{{ t('paper.backToPapers') }}</button>
    </div>

    <div v-else class="paper-split">
      <!-- 左: 原文 PDF (带划词文本层) -->
      <div ref="leftPane" class="pane pane-left">
        <div class="canvas-wrap">
          <div ref="canvasHost" class="canvas-host" />
          <div ref="textHost" class="text-layer" />
        </div>
      </div>

      <!-- 右: AI 中文翻译 (版式对照 / 段落列表) -->
      <div ref="rightPane" class="pane pane-right">
        <div v-if="!aiReady" class="pt-setup">
          <p>{{ t('paper.setupHint') }}</p>
          <button class="btn btn-sm btn-primary" @click="router.push('/settings')">{{ t('ai.goSettings') }}</button>
        </div>
        <template v-else>
          <div class="pt-head">
            <span>{{ t('paper.translationTitle') }}</span>
            <span class="pm-switch">
              <button :class="{ active: viewMode === 'mirror' }" @click="setMode('mirror')">{{ t('paper.viewMirror') }}</button>
              <button :class="{ active: viewMode === 'cards' }" @click="setMode('cards')">{{ t('paper.viewCards') }}</button>
            </span>
            <span v-if="translating" class="pt-busy">{{ t('paper.translating') }}</span>
          </div>
          <p v-if="extractError || (!paragraphs.length && !loading)" class="pt-empty">
            {{ t('paper.noText') }}
            <span v-if="extractErrorMsg" class="pt-errdetail">{{ extractErrorMsg }}</span>
          </p>

          <!-- 版式对照: 原页做底, 译文按原位铺回, 图表公式原样保留 -->
          <div
            v-if="effectiveMode === 'mirror'"
            ref="stageRef"
            class="pm-stage"
            :style="{ width: `${mir.w}px`, height: `${mir.h}px` }"
            :title="t('paper.blockHint')"
          >
            <div ref="mirrorHost" class="pm-canvas" />
            <div
              v-for="p in blocks"
              :key="p.id"
              class="pm-block"
              :class="{ 'pm-original': showOrig.has(p.id) }"
              :style="blockStyle(p)"
              @click="toggleBlock(p.id)"
            >{{ showOrig.has(p.id) ? origText(p) : displayTexts[p.id] }}</div>
          </div>

          <!-- 段落列表 -->
          <template v-else>
            <div v-for="p in paragraphs" :key="p.id" class="pt-card">
              <div class="pt-zh">
                <template v-if="displayTexts[p.id]">{{ displayTexts[p.id] }}</template>
                <span v-else-if="translating" class="pt-pending">{{ t('paper.translating') }}</span>
                <span v-else class="pt-pending">{{ origText(p).slice(0, 120) }}</span>
              </div>
              <button class="pt-toggle" @click="toggleOriginal(p.id)">
                {{ expanded.has(p.id) ? t('paper.hideOriginal') : t('paper.showOriginal') }}
              </button>
              <p v-if="expanded.has(p.id)" class="pt-en">{{ origText(p) }}</p>
            </div>
          </template>
        </template>
      </div>
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
  gap: 10px;
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
}
.icon-btn:hover {
  background: var(--bg);
  color: var(--brand);
}
.icon-btn:disabled {
  opacity: 0.35;
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
}
.pane {
  overflow: auto;
  height: 100%;
}
.pane-left {
  flex: 1.1;
  min-width: 0;
  padding: 12px;
  display: flex;
  justify-content: center;
  background: #525659;
}
.canvas-wrap {
  position: relative;
  height: max-content;
}
.canvas-host {
  font-size: 0;
}
.canvas-host :deep(canvas),
.canvas-host canvas {
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
  border-radius: 2px;
  height: auto;
}
/* 文本层: 划词选择 (pdf.js TextLayer 输出绝对定位 span) */
.text-layer {
  position: absolute;
  inset: 0;
  overflow: hidden;
  line-height: 1;
  user-select: text;
  -webkit-user-select: text;
}
.text-layer :deep(span) {
  color: transparent;
  position: absolute;
  white-space: pre;
  cursor: text;
  transform-origin: 0 0;
}
.text-layer :deep(span)::selection {
  background: rgba(64, 128, 255, 0.35);
}
.pane-right {
  flex: 1;
  min-width: 0;
  border-left: 1px solid var(--border);
  background: var(--card);
  padding: 14px 16px;
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
/* 版式对照 */
.pm-stage {
  position: relative;
  margin: 0 auto;
}
.pm-canvas {
  font-size: 0;
}
.pm-canvas :deep(canvas) {
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.12);
  border-radius: 2px;
  height: auto;
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
@media (max-width: 860px) {
  .paper-split {
    flex-direction: column;
  }
  .pane-right {
    border-left: none;
    border-top: 1px solid var(--border);
  }
}
</style>
