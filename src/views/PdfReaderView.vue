<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getStorage, type BookMeta } from '../storage'
import { useLibrary } from '../stores/library'
import { useSettings } from '../stores/settings'
import { initPdfjs, pdfAssetOptions } from '../services/importer'
import { speakText, prefetchSpeech, stopSpeech, pauseSpeech, resumeSpeech, resetEdgeFailure, listVoicesSorted } from '../services/tts'
import { EDGE_VOICES, edgeAvailable, playAudio } from '../services/edgeTts'
import { localTtsAvailable, localTtsDownload, localTtsStatus, localTtsSynthesize } from '../services/localTts'
import { useReadingTimer } from '../composables/useReadingTimer'
import { toast } from '../services/toast'
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

// ---- 翻页模式状态 ----
const pagedBox = ref<HTMLElement>()
const spreadHost = ref<HTMLElement>()
/** 翻页模式缩放 (持久化, 默认适高) */
const pagedFit = computed(() => settings.pdf.fit)

// ---- 滚动模式状态 ----
const scroller = ref<HTMLElement>()
const scrollZoom = ref<number | 'fit'>('fit')

// ---- 自动翻页 ----
const autoReading = ref(false)
const autoPanel = ref(false)
let autoTimer: ReturnType<typeof setInterval> | undefined

// ---- 听书 ----
const ttsPanel = ref(false)
const ttsState = ref<'stopped' | 'playing' | 'paused'>('stopped')
const ttsVoices = ref<{ name: string; lang: string }[]>([])
let ttsSession = 0

useReadingTimer(bookId)

let pdf: any = null
let loadingTask: any = null
let saveTimer: ReturnType<typeof setTimeout> | undefined
let resizeObserver: ResizeObserver | null = null
let resizeTimer: ReturnType<typeof setTimeout> | undefined
let scrollScheduled = false
let wheelLock = 0
const renderedScale = new Map<number, number>()
const rendering = new Set<number>()
const KEEP_MAX = 5
const DPR = () => Math.min(window.devicePixelRatio || 1, 2)
const MAX_DIM = 4096

const mode = computed(() => settings.pdf.mode)
const spread = computed(() => settings.pdf.spread)

// ================= 公共 =================

function scheduleSave(page: number) {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    library.saveProgress(bookId, String(page), page / Math.max(pageCount.value, 1))
  }, 800)
}

async function renderToCanvas(num: number, scale: number): Promise<HTMLCanvasElement> {
  const page = await pdf.getPage(num)
  const base = page.getViewport({ scale: 1 })
  let renderScale = scale * DPR()
  if (base.width * renderScale > MAX_DIM || base.height * renderScale > MAX_DIM) {
    renderScale = Math.min(MAX_DIM / base.width, MAX_DIM / base.height)
  }
  const viewport = page.getViewport({ scale: renderScale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  canvas.style.width = `${base.width * scale}px`
  canvas.style.height = `${base.height * scale}px`
  await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport } as any).promise
  return canvas
}

// ================= 翻页模式 =================

/** 当前页所在的页组 (双页时 1-2, 3-4 … 配对) */
function spreadOf(p: number): number[] {
  if (!spread.value) return [p]
  const start = p % 2 === 1 ? p : p - 1
  return start + 1 <= pageCount.value ? [start, start + 1] : [start]
}

const spreadCache = new Map<string, HTMLCanvasElement>()

async function renderSpread() {
  if (!pdf || !pagedBox.value || !spreadHost.value) return
  const pages = spreadOf(currentPage.value)
  const box = pagedBox.value
  const availW = box.clientWidth - 32
  const availH = box.clientHeight - 24

  // 以页组内最大页尺寸计算统一缩放
  let maxW = 0
  let maxH = 0
  for (const n of pages) {
    const vp = (await pdf.getPage(n)).getViewport({ scale: 1 })
    maxW = Math.max(maxW, vp.width)
    maxH = Math.max(maxH, vp.height)
  }
  const totalW = maxW * pages.length + (pages.length - 1) * 8
  const scale = pagedFit.value === 'fitH'
    ? Math.min(availH / maxH, availW / totalW)
    : availW / totalW

  const key = (n: number) => `${n}@${scale.toFixed(4)}`
  const canvases: HTMLCanvasElement[] = []
  for (const n of pages) {
    let canvas = spreadCache.get(key(n))
    if (!canvas) {
      canvas = await renderToCanvas(n, scale)
      spreadCache.set(key(n), canvas)
    }
    canvases.push(canvas)
  }
  // 渲染期间翻页了则丢弃本次结果
  if (spreadOf(currentPage.value).join() !== pages.join()) return
  spreadHost.value.replaceChildren(...canvases)

  // 预渲染相邻页组, 限制缓存量
  const nextPages = spreadOf(Math.min(pages[pages.length - 1] + 1, pageCount.value))
  const prevPages = spreadOf(Math.max(pages[0] - 1, 1))
  for (const n of [...nextPages, ...prevPages]) {
    if (!spreadCache.has(key(n))) {
      renderToCanvas(n, scale).then(c => spreadCache.set(key(n), c)).catch(() => {})
    }
  }
  if (spreadCache.size > 8) {
    const keep = new Set([...pages, ...nextPages, ...prevPages].map(key))
    for (const k of spreadCache.keys()) if (!keep.has(k)) spreadCache.delete(k)
  }
}

function pagedGoto(p: number) {
  const clamped = Math.max(1, Math.min(p || 1, pageCount.value))
  currentPage.value = spreadOf(clamped)[0]
  scheduleSave(currentPage.value)
  renderSpread()
  pagedBox.value?.scrollTo({ top: 0 })
}

function pagedNext() {
  const pages = spreadOf(currentPage.value)
  const next = pages[pages.length - 1] + 1
  if (next > pageCount.value) {
    stopAutoRead()
    return
  }
  pagedGoto(next)
}

function pagedPrev() {
  pagedGoto(spreadOf(currentPage.value)[0] - 1)
}

let touchX = 0
let touchY = 0
function onTouchStart(e: TouchEvent) {
  touchX = e.touches[0].clientX
  touchY = e.touches[0].clientY
}
function onTouchEnd(e: TouchEvent) {
  const dx = e.changedTouches[0].clientX - touchX
  const dy = e.changedTouches[0].clientY - touchY
  if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.4) {
    if (dx < 0) pagedNext()
    else pagedPrev()
  }
}

function onPagedWheel(e: WheelEvent) {
  // 适宽时页面内可垂直滚动, 滚到边缘才翻页
  const box = pagedBox.value!
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 2
  const atTop = box.scrollTop <= 2
  const now = Date.now()
  if (e.deltaY > 0 && atBottom) {
    if (now - wheelLock > 350) {
      wheelLock = now
      pagedNext()
    }
    e.preventDefault()
  } else if (e.deltaY < 0 && atTop) {
    if (now - wheelLock > 350) {
      wheelLock = now
      pagedPrev()
    }
    e.preventDefault()
  }
}

// ================= 滚动模式 =================

function fitScale(page: any): number {
  const width = Math.max((scroller.value?.clientWidth ?? 800) - 32, 320)
  const viewport = page.getViewport({ scale: 1 })
  return Math.min(width / viewport.width, 2.5)
}

function holderOf(num: number) {
  return scroller.value?.querySelector<HTMLElement>(`[data-page="${num}"]`) ?? null
}

async function renderScrollPage(num: number) {
  if (!pdf || num < 1 || num > pageCount.value || rendering.has(num)) return
  const holder = holderOf(num)
  if (!holder) return
  const page = await pdf.getPage(num)
  const scale = scrollZoom.value === 'fit' ? fitScale(page) : scrollZoom.value
  if (renderedScale.get(num) === scale) return
  rendering.add(num)
  try {
    const canvas = await renderToCanvas(num, scale)
    holder.replaceChildren(canvas)
    holder.style.width = canvas.style.width
    holder.style.height = canvas.style.height
    renderedScale.set(num, scale)
  } finally {
    rendering.delete(num)
  }
}

function evictFarPages(center: number) {
  for (const num of [...renderedScale.keys()]) {
    if (Math.abs(num - center) > KEEP_MAX) {
      const holder = holderOf(num)
      if (holder) {
        const span = document.createElement('span')
        span.className = 'page-num'
        span.textContent = String(num)
        holder.replaceChildren(span)
      }
      renderedScale.delete(num)
    }
  }
}

function pageAtViewportCenter(): number {
  const el = scroller.value
  if (!el) return 1
  const center = el.scrollTop + el.clientHeight / 2
  for (const holder of el.querySelectorAll<HTMLElement>('.page-holder')) {
    if (holder.offsetTop + holder.offsetHeight >= center) return Number(holder.dataset.page)
  }
  return pageCount.value
}

function updateScrollViewport() {
  const current = pageAtViewportCenter()
  if (current !== currentPage.value) {
    currentPage.value = current
    scheduleSave(current)
  }
  for (let i = current - 1; i <= current + 3; i++) renderScrollPage(i)
  evictFarPages(current)
}

function onScroll() {
  if (scrollScheduled) return
  scrollScheduled = true
  requestAnimationFrame(() => {
    scrollScheduled = false
    updateScrollViewport()
  })
}

async function layoutPlaceholders() {
  const first = await pdf.getPage(1)
  const scale = scrollZoom.value === 'fit' ? fitScale(first) : scrollZoom.value
  const vp = first.getViewport({ scale })
  for (const holder of scroller.value?.querySelectorAll<HTMLElement>('.page-holder') ?? []) {
    holder.style.width = `${vp.width}px`
    holder.style.height = `${vp.height}px`
  }
}

function scrollGoto(num: number, smooth = false) {
  const clamped = Math.max(1, Math.min(num || 1, pageCount.value))
  holderOf(clamped)?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto' })
}

async function applyScrollZoom(next: number | 'fit') {
  scrollZoom.value = next
  renderedScale.clear()
  const anchor = currentPage.value
  await layoutPlaceholders()
  scrollGoto(anchor)
  updateScrollViewport()
}

function scrollZoomStep(dir: 1 | -1) {
  const current = scrollZoom.value === 'fit' ? 1 : scrollZoom.value
  applyScrollZoom(Math.max(0.4, Math.min(3, +(current + dir * 0.2).toFixed(2))))
}

// ================= 自动翻页 =================

function startAutoRead() {
  stopAutoRead()
  autoReading.value = true
  autoTimer = setInterval(() => {
    if (mode.value === 'paged') pagedNext()
    else {
      if (currentPage.value >= pageCount.value) {
        stopAutoRead()
        return
      }
      scrollGoto(currentPage.value + 1, true)
    }
  }, settings.autoReadSeconds * 1000)
}

function stopAutoRead() {
  autoReading.value = false
  clearInterval(autoTimer)
}

watch(() => settings.autoReadSeconds, () => {
  if (autoReading.value) startAutoRead()
})

// ================= 听书 =================

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


// ---- 本地离线语音包 ----
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
  if (ttsPanel.value) autoPanel.value = false
  if (ttsPanel.value) refreshLocalStatus()
  if (ttsPanel.value && !ttsVoices.value.length) {
    ttsVoices.value = (await listVoicesSorted()).map(v => ({ name: v.name, lang: v.lang }))
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
      const page = await pdf.getPage(pageNum)
      const content = await page.getTextContent()
      const text = content.items.map((item: any) => item.str).join(' ').replace(/\s+/g, ' ').trim()
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

// ================= 模式切换 =================

async function switchMode(next: 'paged' | 'scroll') {
  if (settings.pdf.mode === next) return
  stopAutoRead()
  settings.pdf.mode = next
  await nextTick()
  if (next === 'paged') {
    renderSpread()
  } else {
    renderedScale.clear()
    await layoutPlaceholders()
    scroller.value?.addEventListener('scroll', onScroll, { passive: true })
    scrollGoto(currentPage.value)
    updateScrollViewport()
  }
}

async function toggleSpread() {
  settings.pdf.spread = !settings.pdf.spread
  spreadCache.clear()
  renderSpread()
}

async function setPagedFit(fit: 'fitH' | 'fitW') {
  settings.pdf.fit = fit
  spreadCache.clear()
  renderSpread()
}

function gotoPage(p: number) {
  if (mode.value === 'paged') pagedGoto(p)
  else scrollGoto(p)
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    stopAutoRead()
    autoPanel.value = false
    return
  }
  const prev = e.key === 'ArrowLeft' || e.key === 'PageUp'
  const next = e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' '
  if (!prev && !next) return
  e.preventDefault()
  if (mode.value === 'paged') (next ? pagedNext : pagedPrev)()
  else scrollGoto(currentPage.value + (next ? 1 : -1), true)
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
    const pdfjs = await initPdfjs()
    loadingTask = pdfjs.getDocument({ data: await blob.arrayBuffer(), ...pdfAssetOptions })
    pdf = await loadingTask.promise
    pageCount.value = pdf.numPages
    currentPage.value = Math.min(parseInt(meta.value.location ?? '1', 10) || 1, pdf.numPages)
    loading.value = false
    await nextTick()

    resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(async () => {
        if (!pdf) return
        if (mode.value === 'paged') {
          spreadCache.clear()
          renderSpread()
        } else if (scrollZoom.value === 'fit') {
          const anchor = currentPage.value
          renderedScale.clear()
          await layoutPlaceholders()
          scrollGoto(anchor)
          updateScrollViewport()
        }
      }, 200)
    })

    if (mode.value === 'paged') {
      currentPage.value = spreadOf(currentPage.value)[0]
      await renderSpread()
      resizeObserver.observe(pagedBox.value!)
    } else {
      await layoutPlaceholders()
      scroller.value?.addEventListener('scroll', onScroll, { passive: true })
      if (currentPage.value > 1) scrollGoto(currentPage.value)
      updateScrollViewport()
      resizeObserver.observe(scroller.value!)
    }
  } catch (e: any) {
    console.error(e)
    error.value = e?.message ?? t('reader.cantOpenPdf')
    loading.value = false
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
  stopAutoRead()
  stopTTS()
  clearTimeout(saveTimer)
  clearTimeout(resizeTimer)
  resizeObserver?.disconnect()
  scroller.value?.removeEventListener('scroll', onScroll)
  spreadCache.clear()
  loadingTask?.destroy()
})
</script>

<template>
  <div class="pdf-reader">
    <header class="bar">
      <button class="icon-btn" :title="t('reader.backToLibrary')" @click="router.push('/library')">
        <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M14.7 5.3a1 1 0 0 1 0 1.4L9.42 12l5.3 5.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0z"/></svg>
      </button>
      <strong class="title">{{ meta?.title }}</strong>
      <div class="controls">
        <!-- 模式切换 -->
        <div class="seg">
          <button :class="{ active: mode === 'paged' }" @click="switchMode('paged')">{{ t('reader.paginated') }}</button>
          <button :class="{ active: mode === 'scroll' }" @click="switchMode('scroll')">{{ t('reader.scrolled') }}</button>
        </div>

        <!-- 翻页模式工具 -->
        <template v-if="mode === 'paged'">
          <div class="seg">
            <button :class="{ active: pagedFit === 'fitH' }" @click="setPagedFit('fitH')">{{ t('reader.fitHeight') }}</button>
            <button :class="{ active: pagedFit === 'fitW' }" @click="setPagedFit('fitW')">{{ t('reader.fitWidth') }}</button>
          </div>
          <button class="btn btn-sm" :class="{ active: spread }" @click="toggleSpread">
            {{ spread ? t('reader.twoPage') + ' ✓' : t('reader.twoPage') }}
          </button>
        </template>

        <!-- 滚动模式工具 -->
        <template v-else>
          <button class="icon-btn" :title="t('reader.zoomOut')" @click="scrollZoomStep(-1)">−</button>
          <button class="btn btn-sm" :class="{ active: scrollZoom === 'fit' }" @click="applyScrollZoom('fit')">{{ t('reader.fitWidth') }}</button>
          <button class="icon-btn" :title="t('reader.zoomIn')" @click="scrollZoomStep(1)">＋</button>
        </template>

        <!-- 自动翻页 -->
        <button class="btn btn-sm" :class="{ active: autoReading }" @click="autoPanel = !autoPanel; if (autoPanel) ttsPanel = false">
          {{ autoReading ? t('reader.autoReading') : t('reader.autoRead') }}
        </button>

        <!-- 听书 -->
        <button class="btn btn-sm" :class="{ active: ttsState !== 'stopped' }" @click="openTTSPanel">
          {{ ttsState !== 'stopped' ? t('tts.readingNow') : t('tts.title') }}
        </button>

        <span class="page-indicator">
          <input
            class="input page-input"
            :value="currentPage"
            @change="gotoPage(parseInt(($event.target as HTMLInputElement).value, 10) || 1)"
          />
          / {{ pageCount }}
        </span>
      </div>
    </header>

    <div v-if="loading" class="state">{{ t('reader.opening') }}</div>
    <div v-if="error" class="state">
      <p>{{ error }}</p>
      <button class="btn" @click="router.push('/library')">{{ t('reader.backToLibrary') }}</button>
    </div>

    <!-- 翻页模式 -->
    <div
      v-if="mode === 'paged'"
      ref="pagedBox"
      class="paged-box"
      @wheel="onPagedWheel"
      @touchstart.passive="onTouchStart"
      @touchend.passive="onTouchEnd"
    >
      <div ref="spreadHost" class="spread-host" />
      <button class="nav prev" :title="t('reader.prevPage')" @click="pagedPrev">
        <svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M14.7 5.3a1 1 0 0 1 0 1.4L9.42 12l5.3 5.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0z"/></svg>
      </button>
      <button class="nav next" :title="t('reader.nextPage')" @click="pagedNext">
        <svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M9.3 5.3a1 1 0 0 1 1.4 0l6 6a1 1 0 0 1 0 1.4l-6 6a1 1 0 0 1-1.4-1.4l5.29-5.3-5.3-5.3a1 1 0 0 1 0-1.4z"/></svg>
      </button>
    </div>

    <!-- 滚动模式 -->
    <div v-else ref="scroller" class="scroller">
      <div v-for="n in pageCount" :key="n" class="page-holder" :data-page="n">
        <span class="page-num">{{ n }}</span>
      </div>
    </div>

    <!-- 听书控制条 -->
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
      <div v-if="edgeAvailable() && settings.ttsEngine === 'local'" class="tts-row">
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

    <!-- 自动阅读控制条 -->
    <div v-if="autoPanel" class="auto-panel card">
      <button class="btn btn-sm" :class="{ active: autoReading }" @click="autoReading ? stopAutoRead() : startAutoRead()">
        {{ autoReading ? '⏸ ' + t('common.pause') : '▶ ' + t('common.start') }}
      </button>
      <label>{{ t('reader.speed') }}</label>
      <input
        v-model.number="settings.autoReadSeconds"
        type="range"
        min="3"
        max="60"
        step="1"
      />
      <span class="auto-speed">{{ t('reader.secPerPage', { n: settings.autoReadSeconds }) }}</span>
      <button class="icon-btn" :title="t('common.close')" @click="autoPanel = false; stopAutoRead()">✕</button>
    </div>
  </div>
</template>

<style scoped>
.pdf-reader {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #e2e5ea;
  position: relative;
}
.bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  background: var(--card);
  border-bottom: 1px solid var(--border);
  z-index: 5;
  flex-wrap: wrap;
}
.title {
  flex: 1;
  font-size: 14px;
  min-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.seg {
  display: flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}
.seg button {
  height: 30px;
  padding: 0 12px;
  border: none;
  background: var(--card);
  color: var(--text-2);
  font-size: 13px;
}
.seg button.active {
  background: var(--brand-light);
  color: var(--brand);
  font-weight: 500;
}
.icon-btn {
  width: 30px;
  height: 30px;
  border: none;
  background: none;
  border-radius: 6px;
  color: var(--text-2);
  font-size: 16px;
}
.icon-btn:hover {
  background: var(--bg);
  color: var(--brand);
}
.btn.active {
  border-color: var(--brand);
  color: var(--brand);
}
.page-indicator {
  font-size: 13px;
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.page-input {
  width: 52px;
  height: 28px;
  text-align: center;
}

/* 翻页模式 */
.paged-box {
  flex: 1;
  overflow: auto;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 12px 16px;
  position: relative;
}
.spread-host {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  margin: auto;
}
.spread-host :deep(canvas) {
  background: #fff;
  box-shadow: 0 2px 10px rgba(29, 33, 41, 0.22);
  border-radius: 2px;
}
.nav {
  position: fixed;
  top: 50%;
  transform: translateY(-50%);
  z-index: 6;
  width: 40px;
  height: 80px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: transparent;
  transition: all 0.2s;
}
.pdf-reader:hover .nav {
  color: var(--text-3);
}
.nav:hover {
  background: rgba(29, 33, 41, 0.1);
  color: var(--text) !important;
}
.nav.prev {
  left: 8px;
}
.nav.next {
  right: 8px;
}

/* 滚动模式 */
.scroller {
  flex: 1;
  overflow: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 16px;
}
.page-holder {
  background: #fff;
  box-shadow: 0 1px 4px rgba(29, 33, 41, 0.18);
  border-radius: 2px;
  min-height: 200px;
  min-width: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  flex-shrink: 0;
}
.page-num {
  color: var(--text-3);
  font-size: 12px;
}
.state {
  position: absolute;
  inset: 48px 0 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
  z-index: 3;
}

@media (max-width: 600px) {
  .bar {
    gap: 6px;
    padding: 6px 8px;
  }
  .title {
    display: none;
  }
  .nav {
    display: none;
  }
  .page-input {
    width: 44px;
  }
}

/* 听书控制条 */
.tts-panel {
  position: absolute;
  bottom: 18px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 21;
  width: min(400px, calc(100% - 40px));
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
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

/* 自动阅读控制条 */
.auto-panel {
  position: absolute;
  bottom: 18px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
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
</style>
