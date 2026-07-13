<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getStorage, type BookMeta } from '../storage'
import { initPdfjs, pdfAssetOptions } from '../services/importer'
import { extractParagraphs, type PaperParagraph } from '../services/paperText'
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
const leftPane = ref<HTMLElement>()
const rightPane = ref<HTMLElement>()

const paragraphs = ref<PaperParagraph[]>([])
const translations = ref<string[]>([])
const translating = ref(false)
const extractError = ref(false)
const expanded = ref<Set<number>>(new Set())
let translateSession = 0

let pdf: any = null
let renderSession = 0
let resizeObserver: ResizeObserver | undefined
let saveTimer: ReturnType<typeof setTimeout> | undefined

useReadingTimer(bookId)

const aiReady = computed(() => aiConfigured())

const DPR = () => Math.min(window.devicePixelRatio || 1, 2)
const MAX_DIM = 4096

async function renderPage() {
  if (!pdf || !canvasHost.value || !leftPane.value) return
  const session = ++renderSession
  const pdfPage = await pdf.getPage(page.value)
  const base = pdfPage.getViewport({ scale: 1 })
  const paneWidth = leftPane.value.clientWidth - 24
  let scale = (paneWidth / base.width) * DPR()
  if (base.width * scale > MAX_DIM || base.height * scale > MAX_DIM) {
    scale = Math.min(MAX_DIM / base.width, MAX_DIM / base.height)
  }
  const viewport = pdfPage.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  canvas.style.width = `${Math.floor(viewport.width / DPR())}px`
  await pdfPage.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport } as any).promise
  if (session !== renderSession) return
  canvasHost.value.replaceChildren(canvas)
  leftPane.value.scrollTop = 0
}

async function loadParagraphs() {
  if (!pdf) return
  extractError.value = false
  try {
    const pdfPage = await pdf.getPage(page.value)
    paragraphs.value = await extractParagraphs(pdfPage)
  } catch {
    paragraphs.value = []
    extractError.value = true
  }
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
  rightPane.value?.scrollTo({ top: 0 })
  await Promise.all([renderPage(), loadParagraphs()])
  runTranslate()
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
    const pdfjs = await initPdfjs()
    pdf = await pdfjs.getDocument({ data: await blob.arrayBuffer(), ...pdfAssetOptions }).promise
    pageCount.value = pdf.numPages
    const saved = parseInt(meta.value.location ?? '1', 10)
    loading.value = false
    await showPage(Number.isFinite(saved) ? saved : 1)
    resizeObserver = new ResizeObserver(() => renderPage())
    if (leftPane.value) resizeObserver.observe(leftPane.value)
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
      <!-- 左: 原文 PDF -->
      <div ref="leftPane" class="pane pane-left">
        <div ref="canvasHost" class="canvas-host" />
      </div>

      <!-- 右: AI 中文翻译 (段落对照) -->
      <div ref="rightPane" class="pane pane-right">
        <div v-if="!aiReady" class="pt-setup">
          <p>{{ t('paper.setupHint') }}</p>
          <button class="btn btn-sm btn-primary" @click="router.push('/settings')">{{ t('ai.goSettings') }}</button>
        </div>
        <template v-else>
          <div class="pt-head">
            <span>{{ t('paper.translationTitle') }}</span>
            <span v-if="translating" class="pt-busy">{{ t('paper.translating') }}</span>
          </div>
          <p v-if="extractError || (!paragraphs.length && !loading)" class="pt-empty">{{ t('paper.noText') }}</p>
          <div v-for="p in paragraphs" :key="p.id" class="pt-card">
            <div class="pt-zh">
              <template v-if="translations[p.id]">{{ translations[p.id] }}</template>
              <span v-else-if="translating" class="pt-pending">{{ t('paper.translating') }}</span>
              <span v-else class="pt-pending">{{ p.text.slice(0, 120) }}</span>
            </div>
            <button class="pt-toggle" @click="toggleOriginal(p.id)">
              {{ expanded.has(p.id) ? t('paper.hideOriginal') : t('paper.showOriginal') }}
            </button>
            <p v-if="expanded.has(p.id)" class="pt-en">{{ p.text }}</p>
          </div>
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
.canvas-host :deep(canvas),
.canvas-host canvas {
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
  border-radius: 2px;
  height: auto;
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
  justify-content: space-between;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
  margin-bottom: 10px;
}
.pt-busy {
  font-size: 12px;
  font-weight: 400;
  color: var(--brand);
}
.pt-empty {
  font-size: 13px;
  color: var(--text-3);
  padding: 16px 0;
  text-align: center;
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
