<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getStorage, type BookMeta } from '../storage'
import { useLibrary } from '../stores/library'
import { useReadingTimer } from '../composables/useReadingTimer'
import { openDjvu, type DjvuDoc } from '../services/djvu'

const route = useRoute()
const router = useRouter()
const library = useLibrary()
const bookId = String(route.params.id)

const meta = ref<BookMeta>()
const loading = ref(true)
const error = ref('')
const box = ref<HTMLElement>()
const host = ref<HTMLElement>()
const pageCount = ref(0)
const currentPage = ref(1)
const fit = ref<'fitH' | 'fitW'>('fitH')

useReadingTimer(bookId)

let doc: DjvuDoc | null = null
let saveTimer: ReturnType<typeof setTimeout> | undefined
let resizeObserver: ResizeObserver | null = null
let resizeTimer: ReturnType<typeof setTimeout> | undefined
let renderSession = 0
let wheelLock = 0
const pageCache = new Map<number, HTMLCanvasElement>()

function scheduleSave(page: number) {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    library.saveProgress(bookId, String(page), page / Math.max(pageCount.value, 1))
  }, 800)
}

async function pageCanvas(num: number): Promise<HTMLCanvasElement> {
  const cached = pageCache.get(num)
  if (cached) return cached
  const { imageData } = await doc!.renderPage(num)
  const canvas = document.createElement('canvas')
  canvas.width = imageData.width
  canvas.height = imageData.height
  canvas.getContext('2d')!.putImageData(imageData, 0, 0)
  pageCache.set(num, canvas)
  if (pageCache.size > 6) {
    for (const key of pageCache.keys()) {
      if (Math.abs(key - num) > 2) pageCache.delete(key)
    }
  }
  return canvas
}

async function render() {
  if (!doc || !box.value || !host.value) return
  const session = ++renderSession
  const num = currentPage.value
  const canvas = await pageCanvas(num)
  if (session !== renderSession) return
  const availW = box.value.clientWidth - 32
  const availH = box.value.clientHeight - 24
  const scale = fit.value === 'fitH'
    ? Math.min(availH / canvas.height, availW / canvas.width)
    : availW / canvas.width
  canvas.style.width = `${canvas.width * scale}px`
  canvas.style.height = `${canvas.height * scale}px`
  host.value.replaceChildren(canvas)
  box.value.scrollTo({ top: 0 })
  // 预解码相邻页
  if (num + 1 <= pageCount.value) pageCanvas(num + 1).catch(() => {})
}

function goto(num: number) {
  const clamped = Math.max(1, Math.min(num || 1, pageCount.value))
  if (clamped === currentPage.value && host.value?.children.length) return
  currentPage.value = clamped
  scheduleSave(clamped)
  render()
}

const next = () => goto(currentPage.value + 1)
const prev = () => goto(currentPage.value - 1)

function onWheel(e: WheelEvent) {
  const el = box.value!
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2
  const atTop = el.scrollTop <= 2
  const now = Date.now()
  if (e.deltaY > 0 && atBottom && now - wheelLock > 350) {
    wheelLock = now
    next()
    e.preventDefault()
  } else if (e.deltaY < 0 && atTop && now - wheelLock > 350) {
    wheelLock = now
    prev()
    e.preventDefault()
  }
}

let touchX = 0
let touchY = 0
const onTouchStart = (e: TouchEvent) => {
  touchX = e.touches[0].clientX
  touchY = e.touches[0].clientY
}
const onTouchEnd = (e: TouchEvent) => {
  const dx = e.changedTouches[0].clientX - touchX
  const dy = e.changedTouches[0].clientY - touchY
  if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.4) (dx < 0 ? next : prev)()
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') prev()
  else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
    e.preventDefault()
    next()
  }
}

onMounted(async () => {
  window.addEventListener('keydown', handleKeydown)
  try {
    const storage = await getStorage()
    meta.value = await storage.getBook(bookId)
    if (!meta.value) {
      error.value = '书籍不存在'
      return
    }
    const blob = await storage.getBookFile(bookId)
    doc = await openDjvu(blob)
    pageCount.value = doc.pageCount
    currentPage.value = Math.min(parseInt(meta.value.location ?? '1', 10) || 1, doc.pageCount)
    loading.value = false
    await render()

    resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(render, 200)
    })
    resizeObserver.observe(box.value!)
  } catch (e: any) {
    console.error(e)
    error.value = e?.message ?? '无法打开 DjVu 文件'
    loading.value = false
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
  clearTimeout(saveTimer)
  clearTimeout(resizeTimer)
  resizeObserver?.disconnect()
  pageCache.clear()
})
</script>

<template>
  <div class="djvu-reader">
    <header class="bar">
      <button class="icon-btn" title="返回藏书" @click="router.push('/library')">
        <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M14.7 5.3a1 1 0 0 1 0 1.4L9.42 12l5.3 5.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0z"/></svg>
      </button>
      <strong class="title">{{ meta?.title }}</strong>
      <div class="controls">
        <div class="seg">
          <button :class="{ active: fit === 'fitH' }" @click="fit = 'fitH'; render()">适高</button>
          <button :class="{ active: fit === 'fitW' }" @click="fit = 'fitW'; render()">适宽</button>
        </div>
        <span class="page-indicator">
          <input
            class="input page-input"
            :value="currentPage"
            @change="goto(parseInt(($event.target as HTMLInputElement).value, 10) || 1)"
          />
          / {{ pageCount }}
        </span>
      </div>
    </header>

    <div v-if="loading" class="state">正在解码…</div>
    <div v-if="error" class="state">
      <p>{{ error }}</p>
      <button class="btn" @click="router.push('/library')">返回藏书</button>
    </div>

    <div
      ref="box"
      class="page-box"
      @wheel="onWheel"
      @touchstart.passive="onTouchStart"
      @touchend.passive="onTouchEnd"
    >
      <div ref="host" class="page-host" />
      <button class="nav prev" title="上一页" @click="prev">
        <svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M14.7 5.3a1 1 0 0 1 0 1.4L9.42 12l5.3 5.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0z"/></svg>
      </button>
      <button class="nav next" title="下一页" @click="next">
        <svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M9.3 5.3a1 1 0 0 1 1.4 0l6 6a1 1 0 0 1 0 1.4l-6 6a1 1 0 0 1-1.4-1.4l5.29-5.3-5.3-5.3a1 1 0 0 1 0-1.4z"/></svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.djvu-reader {
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
}
.title {
  flex: 1;
  font-size: 14px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.controls {
  display: flex;
  align-items: center;
  gap: 8px;
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
}
.icon-btn:hover {
  background: var(--bg);
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
.page-box {
  flex: 1;
  overflow: auto;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 12px 16px;
}
.page-host {
  margin: auto;
}
.page-host :deep(canvas) {
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
.djvu-reader:hover .nav {
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
  .title {
    display: none;
  }
  .nav {
    display: none;
  }
}
</style>
