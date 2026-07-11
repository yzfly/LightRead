<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getStorage, type AnnotationRec, type BookMeta } from '../storage'
import { useSettings } from '../stores/settings'
import { useLibrary } from '../stores/library'
import { isTextLike } from '../services/format'
import { convertToEpub } from '../services/textToEpub'
import { getReaderCSS, READER_THEMES, FONT_FAMILIES, HIGHLIGHT_COLORS } from '../services/readerTheme'
import { listVoicesSorted, speakText, ssmlToText, stopSpeech, pauseSpeech, resumeSpeech, resetEdgeFailure } from '../services/tts'
import { EDGE_VOICES, edgeAvailable, playAudio } from '../services/edgeTts'
import { localTtsAvailable, localTtsDownload, localTtsStatus, localTtsSynthesize } from '../services/localTts'
import { useReadingTimer } from '../composables/useReadingTimer'
import { toast } from '../services/toast'
import TocList, { type TocItem } from '../components/TocList.vue'

const route = useRoute()
const router = useRouter()
const settings = useSettings()
const library = useLibrary()
const bookId = String(route.params.id)

const container = ref<HTMLElement>()
const meta = ref<BookMeta>()
const loading = ref(true)
const error = ref('')
const toc = ref<TocItem[]>([])
const currentTocHref = ref<string>()
const fraction = ref(0)
const chapterLabel = ref('')
const panel = ref<'none' | 'toc' | 'annotations' | 'search'>('none')
const panelEl = ref<HTMLElement>()
const settingsOpen = ref(false)
const barsVisible = ref(true)

// 打开目录时把当前章节滚到可视区中间
watch(panel, async p => {
  if (p !== 'toc') return
  await nextTick()
  panelEl.value?.querySelector('.toc-item.active')?.scrollIntoView({ block: 'center' })
})

// 高亮选区
const selection = ref<{ cfi: string; text: string } | null>(null)
const annotations = ref<AnnotationRec[]>([])
const activeAnnotation = ref<AnnotationRec | null>(null)
const noteDraft = ref('')
const annoTab = ref<'highlight' | 'bookmark'>('highlight')
const highlights = computed(() => annotations.value.filter(a => a.kind !== 'bookmark'))
const bookmarks = computed(() => annotations.value.filter(a => a.kind === 'bookmark'))

// 书签
const currentCfi = ref('')
const isBookmarked = computed(() => bookmarks.value.some(b => b.cfi === currentCfi.value))

// 听书
const ttsPanel = ref(false)
const ttsState = ref<'stopped' | 'playing' | 'paused'>('stopped')
const ttsVoices = ref<{ name: string; lang: string }[]>([])
let ttsSession = 0
let sectionLoadResolvers: Array<() => void> = []

useReadingTimer(bookId)

// 书内搜索
const searchQuery = ref('')
const searchResults = ref<Array<{ cfi: string; excerpt: { pre: string; match: string; post: string } }>>([])
const searchProgress = ref(0)
const searching = ref(false)

// 自动阅读
const autoPanel = ref(false)
const autoReading = ref(false)
let autoTimer: ReturnType<typeof setInterval> | undefined

let view: any = null
let Overlayer: any = null
let saveTimer: ReturnType<typeof setTimeout> | undefined

const themeColors = computed(() => READER_THEMES[settings.reader.theme])

function applyPrefs() {
  if (!view) return
  const prefs = settings.reader
  try {
    view.renderer.setAttribute('animated', '')
    view.renderer.setAttribute('flow', prefs.flow)
    view.renderer.setAttribute('gap', `${prefs.gap}%`)
    view.renderer.setAttribute('max-column-count', String(prefs.maxColumnCount))
    view.renderer.setStyles?.(getReaderCSS(prefs))
  } catch { /* 章节切换瞬间 iframe 文档可能已卸载, 下次 relocate 会重新应用 */ }
}

let prefsTimer: ReturnType<typeof setTimeout> | undefined
watch(() => settings.reader, () => {
  clearTimeout(prefsTimer)
  prefsTimer = setTimeout(applyPrefs, 120)
}, { deep: true })

function onRelocate(e: CustomEvent) {
  const { cfi, fraction: frac, tocItem } = e.detail
  fraction.value = frac ?? 0
  chapterLabel.value = tocItem?.label?.trim() ?? ''
  currentTocHref.value = tocItem?.href
  currentCfi.value = cfi ?? ''
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    if (cfi) library.saveProgress(bookId, cfi, frac ?? 0)
  }, 600)
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') view?.goLeft()
  else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') view?.goRight()
  else if (e.key === 'Escape') {
    panel.value = 'none'
    settingsOpen.value = false
    autoPanel.value = false
    stopAutoRead()
  }
}

function startAutoRead() {
  stopAutoRead()
  autoReading.value = true
  autoTimer = setInterval(() => {
    if (fraction.value >= 0.999) {
      stopAutoRead()
      return
    }
    view?.goRight()
  }, settings.autoReadSeconds * 1000)
}

function stopAutoRead() {
  autoReading.value = false
  clearInterval(autoTimer)
}

watch(() => settings.autoReadSeconds, () => {
  if (autoReading.value) startAutoRead()
})

// ---- 听书 ----

const waitSectionLoad = () => new Promise<void>(resolve => {
  sectionLoadResolvers.push(resolve)
  setTimeout(resolve, 3000)
})

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
  localProgress.value = '连接中…'
  try {
    await localTtsDownload(p => {
      localProgress.value = p.phase === 'extracting'
        ? '解压中…'
        : `${(p.downloaded / 1048576).toFixed(0)}MB${p.total ? ' / ' + (p.total / 1048576).toFixed(0) + 'MB' : ''}`
    })
    localInstalled.value = true
    toast('离线语音包已就绪', 'success')
  } catch (e: any) {
    toast(`语音包下载失败: ${e?.message ?? e}`, 'error', 6000)
  } finally {
    localDownloading.value = false
  }
}

async function auditionLocal() {
  try {
    await playAudio(await localTtsSynthesize('夜色像一块浸了水的墨布，慢慢压下来。', settings.localVoiceId, settings.ttsRate))
  } catch (e: any) {
    toast(e?.message ?? '试听失败', 'error')
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
  ttsState.value = 'playing'
  try {
    await view.initTTS('sentence')
    let ssml: string | undefined = view.tts.start()
    while (session === ttsSession && !ttsStopped()) {
      await waitWhilePaused()
      if (session !== ttsSession) break
      if (!ssml) {
        // 本节读完, 进入下一节; 到书末则停止
        const loaded = waitSectionLoad()
        const prevDoc = view.tts?.doc
        await view.renderer.nextSection?.()
        await loaded
        await view.initTTS('sentence')
        if (view.tts?.doc === prevDoc) break
        ssml = view.tts.start()
        if (!ssml) break
        continue
      }
      const text = ssmlToText(ssml)
      if (text) await speakText(text)
      if (session !== ttsSession || ttsStopped()) break
      await waitWhilePaused()
      if (session !== ttsSession) break
      // 传 true 让视图滚动跟随当前朗读段落
      ssml = view.tts.next(true)
    }
  } catch (e) {
    console.error(e)
    toast('听书出错', 'error')
  }
  if (session === ttsSession) {
    ttsState.value = 'stopped'
  }
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

function onSectionLoad(e: CustomEvent) {
  const { doc, index } = e.detail
  for (const resolve of sectionLoadResolvers.splice(0)) resolve()
  doc.addEventListener('keydown', handleKeydown)
  const updateSelection = () => {
    const sel = doc.getSelection()
    if (!sel || sel.isCollapsed) {
      selection.value = null
      return
    }
    const text = sel.toString().trim()
    if (!text) {
      selection.value = null
      return
    }
    try {
      const cfi = view.getCFI(index, sel.getRangeAt(0))
      selection.value = cfi ? { cfi, text } : null
    } catch {
      selection.value = null
    }
  }
  doc.addEventListener('mouseup', () => setTimeout(updateSelection, 0))
  doc.addEventListener('touchend', () => setTimeout(updateSelection, 0))
  // 点击正文时收起目录等侧栏和浮层; 若这一下是为了收面板, 不再触发翻页
  doc.addEventListener('mousedown', () => {
    overlayDismissed = panel.value !== 'none' || settingsOpen.value || !!activeAnnotation.value
    panel.value = 'none'
    settingsOpen.value = false
    activeAnnotation.value = null
  })
  doc.addEventListener('click', (e: MouseEvent) => onContentClick(e, doc))
}

// 点正文左/右侧翻页
let overlayDismissed = false

function onContentClick(e: MouseEvent, doc: Document) {
  if (overlayDismissed) {
    overlayDismissed = false
    return
  }
  if (settings.reader.flow !== 'paginated') return
  // 正在选字或点了链接时不翻页
  if (selection.value) return
  const sel = doc.getSelection()
  if (sel && !sel.isCollapsed) return
  if ((e.target as Element)?.closest?.('a[href]')) return
  // iframe 内坐标换算到窗口坐标 (分页模式下 iframe 比可视区宽且随翻页平移)
  const frameRect = doc.defaultView?.frameElement?.getBoundingClientRect()
  const contentRect = container.value?.getBoundingClientRect()
  if (!frameRect || !contentRect) return
  const x = frameRect.left + e.clientX - contentRect.left
  if (x < contentRect.width / 3) view?.goLeft()
  else if (x > contentRect.width * 2 / 3) view?.goRight()
}

function drawStoredAnnotations() {
  for (const a of highlights.value) {
    try {
      view.addAnnotation({ value: a.cfi, color: a.color })
    } catch { /* 不属于当前分节的标注忽略 */ }
  }
}

async function addHighlight(color: string, withNote = false) {
  if (!selection.value) return
  const storage = await getStorage()
  const rec: Omit<AnnotationRec, 'id'> = {
    bookId,
    kind: 'highlight',
    cfi: selection.value.cfi,
    text: selection.value.text.slice(0, 300),
    color,
    createdAt: Date.now(),
  }
  const id = await storage.addAnnotation(rec)
  const saved = { ...rec, id }
  annotations.value.push(saved)
  try {
    view.addAnnotation({ value: rec.cfi, color })
  } catch { /* 绘制失败不影响保存 */ }
  selection.value = null
  if (withNote) {
    noteDraft.value = ''
    activeAnnotation.value = saved
  } else {
    toast('已高亮', 'success')
  }
}

async function saveNote() {
  if (!activeAnnotation.value) return
  const storage = await getStorage()
  const note = noteDraft.value.trim() || undefined
  await storage.updateAnnotation(activeAnnotation.value.id, { note })
  activeAnnotation.value.note = note
  const item = annotations.value.find(a => a.id === activeAnnotation.value!.id)
  if (item) item.note = note
  activeAnnotation.value = null
  toast('想法已保存', 'success')
}

async function toggleBookmark() {
  if (!currentCfi.value) return
  const existing = bookmarks.value.find(b => b.cfi === currentCfi.value)
  const storage = await getStorage()
  if (existing) {
    await storage.deleteAnnotation(existing.id)
    annotations.value = annotations.value.filter(a => a.id !== existing.id)
    toast('已移除书签')
    return
  }
  const rec: Omit<AnnotationRec, 'id'> = {
    bookId,
    kind: 'bookmark',
    cfi: currentCfi.value,
    text: `${chapterLabel.value || meta.value?.title || '位置'} · ${(fraction.value * 100).toFixed(1)}%`,
    color: 'bookmark',
    createdAt: Date.now(),
  }
  const id = await storage.addAnnotation(rec)
  annotations.value.push({ ...rec, id })
  toast('已添加书签', 'success')
}

async function removeAnnotation(a: AnnotationRec) {
  const storage = await getStorage()
  await storage.deleteAnnotation(a.id)
  annotations.value = annotations.value.filter(x => x.id !== a.id)
  try {
    view.deleteAnnotation({ value: a.cfi })
  } catch { /* 当前分节未绘制时忽略 */ }
  activeAnnotation.value = null
}

async function gotoAnnotation(a: AnnotationRec) {
  panel.value = 'none'
  await untilLoaded()
  view?.goTo(a.cfi).catch(() => toast('无法跳转到该标注', 'error'))
}

async function runSearch() {
  const query = searchQuery.value.trim()
  if (!query || !view || searching.value) return
  searching.value = true
  searchResults.value = []
  searchProgress.value = 0
  try {
    for await (const result of view.search({ query, matchCase: false, matchDiacritics: false, matchWholeWords: false })) {
      if (result === 'done') break
      if (result.progress != null) searchProgress.value = result.progress
      if (result.subitems) searchResults.value.push(...result.subitems)
    }
  } catch (e) {
    console.error(e)
    toast('搜索失败', 'error')
  } finally {
    searching.value = false
  }
}

function closeSearch() {
  panel.value = 'none'
  searchResults.value = []
  view?.clearSearch?.()
}

/** 打开书的瞬间 view.init 尚未归位, 此时跳转会被 init 落点覆盖 — 等它完成 */
async function untilLoaded() {
  for (let i = 0; i < 50 && loading.value; i++) {
    await new Promise(r => setTimeout(r, 100))
  }
}

async function navigateToc(href: string) {
  panel.value = 'none'
  await untilLoaded()
  view?.goTo(href).catch(() => toast('无法跳转', 'error'))
}

function onSlide(e: Event) {
  const value = parseFloat((e.target as HTMLInputElement).value)
  view?.goToFraction(value)
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
    if (meta.value.format === 'pdf') {
      router.replace(`/read-pdf/${bookId}`)
      return
    }
    if (meta.value.format === 'djvu') {
      router.replace(`/read-djvu/${bookId}`)
      return
    }
    annotations.value = await storage.listAnnotations(bookId)

    const blob = await storage.getBookFile(bookId)
    let file: File
    if (isTextLike(meta.value.format)) {
      const { epub } = await convertToEpub(blob, meta.value.fileName, meta.value.format as 'txt' | 'md' | 'html')
      file = new File([epub], `${meta.value.title}.epub`, { type: 'application/epub+zip' })
    } else if (meta.value.format === 'cbr') {
      const { cbrToCbz } = await import('../services/comic')
      file = new File([await cbrToCbz(blob)], `${meta.value.title}.cbz`)
    } else {
      file = new File([blob], meta.value.fileName)
    }

    await import('foliate-js/view.js')
    Overlayer = (await import('foliate-js/overlayer.js')).Overlayer

    view = document.createElement('foliate-view')
    view.style.width = '100%'
    view.style.height = '100%'
    container.value!.append(view)

    view.addEventListener('relocate', onRelocate)
    view.addEventListener('load', onSectionLoad)
    view.addEventListener('create-overlay', () => drawStoredAnnotations())
    view.addEventListener('draw-annotation', (e: CustomEvent) => {
      const { draw, annotation } = e.detail
      draw(Overlayer.highlight, { color: HIGHLIGHT_COLORS[annotation.color] ?? annotation.color })
    })
    view.addEventListener('show-annotation', (e: CustomEvent) => {
      const found = annotations.value.find(a => a.cfi === e.detail.value)
      if (found) {
        noteDraft.value = found.note ?? ''
        activeAnnotation.value = found
      }
    })

    await view.open(file)
    toc.value = view.book?.toc ?? []
    applyPrefs()
    await view.init({ lastLocation: meta.value.location })
    loading.value = false
  } catch (e: any) {
    console.error(e)
    error.value = e?.message ?? '无法打开此书'
  } finally {
    loading.value = false
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
  clearTimeout(saveTimer)
  stopAutoRead()
  stopTTS()
  view?.close?.()
  view?.remove()
})
</script>

<template>
  <div class="reader" :style="{ background: themeColors.bg, color: themeColors.fg }">
    <!-- 顶栏 -->
    <header class="bar top" :class="{ hidden: !barsVisible }">
      <button class="icon-btn" title="返回藏书" @click="router.push('/library')">
        <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M14.7 5.3a1 1 0 0 1 0 1.4L9.42 12l5.3 5.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0z"/></svg>
      </button>
      <div class="book-title">
        <strong>{{ meta?.title }}</strong>
        <span v-if="chapterLabel" class="chapter">{{ chapterLabel }}</span>
      </div>
      <div class="bar-actions">
        <button class="icon-btn" title="目录" @click="panel = panel === 'toc' ? 'none' : 'toc'">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M4 6a1 1 0 0 1 1-1h1a1 1 0 0 1 0 2H5a1 1 0 0 1-1-1zm5 0a1 1 0 0 1 1-1h9a1 1 0 1 1 0 2h-9a1 1 0 0 1-1-1zM4 12a1 1 0 0 1 1-1h1a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1zm5 0a1 1 0 0 1 1-1h9a1 1 0 1 1 0 2h-9a1 1 0 0 1-1-1zM4 18a1 1 0 0 1 1-1h1a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1zm5 0a1 1 0 0 1 1-1h9a1 1 0 1 1 0 2h-9a1 1 0 0 1-1-1z"/></svg>
        </button>
        <button class="icon-btn" title="标注与书签" @click="panel = panel === 'annotations' ? 'none' : 'annotations'">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19a1 1 0 0 1 1 1v15a2 2 0 0 1-2 2H6.5A2.5 2.5 0 0 1 4 18.5v-13zM6.5 5a.5.5 0 0 0-.5.5v11.34c.16-.05.33-.08.5-.08H18V5H6.5z"/></svg>
        </button>
        <button
          class="icon-btn"
          :class="{ 'auto-on': isBookmarked }"
          :title="isBookmarked ? '移除书签' : '添加书签'"
          @click="toggleBookmark"
        >
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path v-if="isBookmarked" fill="currentColor" d="M6 3h12a1 1 0 0 1 1 1v16.2a.8.8 0 0 1-1.24.67L12 17.6l-5.76 3.27A.8.8 0 0 1 5 20.2V4a1 1 0 0 1 1-1z"/>
            <path v-else fill="currentColor" d="M6 3h12a1 1 0 0 1 1 1v16.2a.8.8 0 0 1-1.24.67L12 17.6l-5.76 3.27A.8.8 0 0 1 5 20.2V4a1 1 0 0 1 1-1zm1 2v13.48l4.5-2.55a1 1 0 0 1 .99 0l4.51 2.55V5H7z"/>
          </svg>
        </button>
        <button class="icon-btn" :class="{ 'auto-on': ttsState !== 'stopped' }" title="听书" @click="openTTSPanel">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 3a7 7 0 0 0-7 7v1.1A3.5 3.5 0 0 0 3 14.5v2A3.5 3.5 0 0 0 6.5 20H8a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1h-.9A5 5 0 0 1 12 5a5 5 0 0 1 4.9 6H16a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h1.5a3.5 3.5 0 0 0 3.5-3.5v-2a3.5 3.5 0 0 0-2-3.16V10a7 7 0 0 0-7-7z"/></svg>
        </button>
        <button class="icon-btn" title="书内搜索" @click="panel = panel === 'search' ? 'none' : 'search'">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M10.5 3a7.5 7.5 0 1 0 4.55 13.46l3.75 3.75a1 1 0 0 0 1.4-1.42l-3.74-3.74A7.5 7.5 0 0 0 10.5 3zM5 10.5a5.5 5.5 0 1 1 11 0 5.5 5.5 0 0 1-11 0z"/></svg>
        </button>
        <button
          class="icon-btn"
          :class="{ 'auto-on': autoReading }"
          title="自动阅读"
          @click="autoPanel = !autoPanel; if (autoPanel) ttsPanel = false"
        >
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm-1.8 4.4 5.4 3.1a.6.6 0 0 1 0 1l-5.4 3.1a.6.6 0 0 1-.9-.5V8.9a.6.6 0 0 1 .9-.5z"/></svg>
        </button>
        <button class="icon-btn" title="排版设置" @click="settingsOpen = !settingsOpen">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M11.1 4.55a1 1 0 0 1 1.8 0l5.6 12.02a1 1 0 1 1-1.81.86L15.3 14.5H8.7l-1.39 2.93a1 1 0 1 1-1.8-.86L11.1 4.55zM9.64 12.5h4.72L12 7.36 9.64 12.5z"/></svg>
        </button>
      </div>
    </header>

    <!-- 正文 -->
    <div ref="container" class="content" @click="barsVisible = true" />

    <div v-if="loading" class="state">正在打开…</div>
    <div v-if="error" class="state">
      <p>{{ error }}</p>
      <button class="btn" @click="router.push('/library')">返回藏书</button>
    </div>

    <!-- 翻页按钮 -->
    <button v-if="!loading && !error" class="nav prev" title="上一页" @click="view?.goLeft()">
      <svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M14.7 5.3a1 1 0 0 1 0 1.4L9.42 12l5.3 5.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0z"/></svg>
    </button>
    <button v-if="!loading && !error" class="nav next" title="下一页" @click="view?.goRight()">
      <svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M9.3 5.3a1 1 0 0 1 1.4 0l6 6a1 1 0 0 1 0 1.4l-6 6a1 1 0 0 1-1.4-1.4l5.29-5.3-5.3-5.3a1 1 0 0 1 0-1.4z"/></svg>
    </button>

    <!-- 底栏: 进度 -->
    <footer class="bar bottom" :class="{ hidden: !barsVisible }">
      <input
        class="slider"
        type="range"
        min="0"
        max="1"
        step="0.0005"
        :value="fraction"
        @change="onSlide"
      />
      <span class="percent">{{ (fraction * 100).toFixed(1) }}%</span>
    </footer>

    <!-- 自动阅读控制条 -->
    <div v-if="autoPanel" class="auto-panel card">
      <button class="btn btn-sm" @click="autoReading ? stopAutoRead() : startAutoRead()">
        {{ autoReading ? '⏸ 暂停' : '▶ 开始' }}
      </button>
      <label>速度</label>
      <input v-model.number="settings.autoReadSeconds" type="range" min="3" max="60" step="1" />
      <span class="auto-speed">{{ settings.autoReadSeconds }} 秒/页</span>
      <button class="icon-btn" title="关闭" @click="autoPanel = false; stopAutoRead()">✕</button>
    </div>

    <!-- 高亮选区浮条 -->
    <div v-if="selection" class="highlight-bar card">
      <span class="hl-hint">高亮</span>
      <button
        v-for="(hex, name) in HIGHLIGHT_COLORS"
        :key="name"
        class="hl-color"
        :style="{ background: hex }"
        @click="addHighlight(name as string)"
      />
      <button class="btn btn-sm" @click="addHighlight('yellow', true)">💬 写想法</button>
      <button class="icon-btn" title="取消" @click="selection = null">✕</button>
    </div>

    <!-- 标注详情 / 想法编辑浮层 -->
    <div v-if="activeAnnotation" class="annotation-pop card">
      <p class="quote">{{ activeAnnotation.text }}</p>
      <textarea
        v-model="noteDraft"
        class="note-input"
        rows="3"
        placeholder="写下这一刻的想法…"
      />
      <div class="pop-actions">
        <button class="btn btn-sm btn-danger" @click="removeAnnotation(activeAnnotation)">删除高亮</button>
        <span style="flex: 1" />
        <button class="btn btn-sm" @click="activeAnnotation = null">取消</button>
        <button class="btn btn-sm btn-primary" @click="saveNote">保存想法</button>
      </div>
    </div>

    <!-- 听书控制条 -->
    <div v-if="ttsPanel" class="tts-panel card">
      <div class="tts-row">
        <button
          class="btn btn-sm btn-primary"
          @click="ttsState === 'playing' ? pauseTTS() : ttsState === 'paused' ? resumeTTS() : startTTS()"
        >
          {{ ttsState === 'playing' ? '⏸ 暂停' : ttsState === 'paused' ? '▶ 继续' : '▶ 开始听书' }}
        </button>
        <button class="btn btn-sm" :disabled="ttsState === 'stopped'" @click="stopTTS">⏹ 停止</button>
        <button class="icon-btn" title="关闭" @click="ttsPanel = false; stopTTS()">✕</button>
      </div>
      <div class="tts-row">
        <label>语速</label>
        <input v-model.number="settings.ttsRate" type="range" min="0.5" max="2" step="0.1" />
        <span class="tts-value">{{ settings.ttsRate.toFixed(1) }}x</span>
      </div>
      <div v-if="edgeAvailable()" class="tts-row">
        <label>引擎</label>
        <div class="seg" style="flex: 1">
          <button :class="{ active: settings.ttsEngine === 'edge' }" @click="settings.ttsEngine = 'edge'; resetEdgeFailure()">在线神经</button>
          <button :class="{ active: settings.ttsEngine === 'local' }" @click="settings.ttsEngine = 'local'; resetEdgeFailure(); refreshLocalStatus()">本地神经</button>
          <button :class="{ active: settings.ttsEngine === 'system' }" @click="settings.ttsEngine = 'system'">系统</button>
        </div>
      </div>
      <div v-if="edgeAvailable() && settings.ttsEngine === 'edge'" class="tts-row">
        <label>音色</label>
        <select v-model="settings.edgeVoice" class="input">
          <option v-for="v in EDGE_VOICES" :key="v.id" :value="v.id">{{ v.label }}</option>
        </select>
      </div>
      <div v-if="edgeAvailable() && settings.ttsEngine === 'local'" class="tts-row">
        <label>音色</label>
        <template v-if="localInstalled">
          <select v-model.number="settings.localVoiceId" class="input">
            <option v-for="n in 103" :key="n" :value="n - 1">音色 {{ n - 1 }}{{ n - 1 === 50 ? ' (默认·中文女声)' : '' }}</option>
          </select>
          <button class="btn btn-sm" :disabled="ttsState !== 'stopped'" @click="auditionLocal">试听</button>
        </template>
        <button v-else class="btn btn-sm btn-primary" :disabled="localDownloading" @click="downloadLocal">
          {{ localDownloading ? localProgress : '下载离线语音包 (~310MB)' }}
        </button>
      </div>

      <div v-else class="tts-row">
        <label>音色</label>
        <select v-model="settings.ttsVoice" class="input">
          <option value="">自动 (中文优先)</option>
          <option v-for="v in ttsVoices" :key="v.name" :value="v.name">{{ v.name }} ({{ v.lang }})</option>
        </select>
      </div>
      <p class="tts-hint">
        {{ edgeAvailable() && settings.ttsEngine === 'edge'
          ? '在线神经音色 (微软 Edge 大声朗读服务), 音质自然, 需要联网; 不可用时自动回退系统语音。'
          : '系统语音离线可用。macOS 可在「系统设置 → 辅助功能 → 朗读内容」下载更高质量中文音色。' }}
        语速与音色对下一段生效。
      </p>
    </div>

    <!-- 侧栏面板 -->
    <aside v-if="panel !== 'none'" ref="panelEl" class="panel card">
      <template v-if="panel === 'toc'">
        <h3>目录</h3>
        <div class="panel-body">
          <TocList :items="toc" :current-href="currentTocHref" @navigate="navigateToc" />
          <p v-if="!toc.length" class="panel-empty">此书没有目录</p>
        </div>
      </template>

      <template v-else-if="panel === 'annotations'">
        <div class="anno-tabs">
          <button :class="{ active: annoTab === 'highlight' }" @click="annoTab = 'highlight'">
            划线想法 ({{ highlights.length }})
          </button>
          <button :class="{ active: annoTab === 'bookmark' }" @click="annoTab = 'bookmark'">
            书签 ({{ bookmarks.length }})
          </button>
        </div>
        <div class="panel-body">
          <template v-if="annoTab === 'highlight'">
            <div v-for="a in highlights" :key="a.id" class="anno-item" @click="gotoAnnotation(a)">
              <span class="anno-dot" :style="{ background: HIGHLIGHT_COLORS[a.color] ?? a.color }" />
              <span class="anno-body">
                <span class="anno-text">{{ a.text }}</span>
                <span v-if="a.note" class="anno-note">💬 {{ a.note }}</span>
              </span>
            </div>
            <p v-if="!highlights.length" class="panel-empty">选中正文文字即可划线、写想法</p>
          </template>
          <template v-else>
            <div v-for="a in bookmarks" :key="a.id" class="anno-item" @click="gotoAnnotation(a)">
              <svg viewBox="0 0 24 24" width="14" height="14" style="flex-shrink: 0; margin-top: 3px"><path fill="var(--brand)" d="M6 3h12a1 1 0 0 1 1 1v16.2a.8.8 0 0 1-1.24.67L12 17.6l-5.76 3.27A.8.8 0 0 1 5 20.2V4a1 1 0 0 1 1-1z"/></svg>
              <span class="anno-body">
                <span class="anno-text">{{ a.text }}</span>
              </span>
              <button class="icon-btn anno-del" title="删除" @click.stop="removeAnnotation(a)">✕</button>
            </div>
            <p v-if="!bookmarks.length" class="panel-empty">点击顶栏书签图标, 收藏当前位置</p>
          </template>
        </div>
      </template>

      <template v-else>
        <h3>书内搜索</h3>
        <form class="search-form" @submit.prevent="runSearch">
          <input v-model="searchQuery" class="input" type="search" placeholder="输入关键词, 回车搜索" />
        </form>
        <div v-if="searching" class="panel-tip">搜索中… {{ Math.round(searchProgress * 100) }}%</div>
        <div class="panel-body">
          <div
            v-for="(r, i) in searchResults"
            :key="i"
            class="search-item"
            @click="view?.goTo(r.cfi); panel = 'none'"
          >
            {{ r.excerpt.pre }}<mark>{{ r.excerpt.match }}</mark>{{ r.excerpt.post }}
          </div>
          <p v-if="!searching && searchQuery && !searchResults.length" class="panel-empty">没有找到结果</p>
        </div>
        <button class="btn btn-sm" style="margin-top: 8px" @click="closeSearch">清除并关闭</button>
      </template>
    </aside>

    <!-- 排版设置浮层 -->
    <div v-if="settingsOpen" class="settings-pop card">
      <div class="set-row">
        <label>字号</label>
        <input v-model.number="settings.reader.fontSize" type="range" min="12" max="32" step="1" />
        <span>{{ settings.reader.fontSize }}px</span>
      </div>
      <div class="set-row">
        <label>行距</label>
        <input v-model.number="settings.reader.lineHeight" type="range" min="1.2" max="2.6" step="0.1" />
        <span>{{ settings.reader.lineHeight.toFixed(1) }}</span>
      </div>
      <div class="set-row">
        <label>边距</label>
        <input v-model.number="settings.reader.gap" type="range" min="2" max="16" step="1" />
        <span>{{ settings.reader.gap }}%</span>
      </div>
      <div class="set-row">
        <label>字体</label>
        <select v-model="settings.reader.fontFamily" class="input">
          <option v-for="f in FONT_FAMILIES" :key="f.label" :value="f.value">{{ f.label }}</option>
        </select>
      </div>
      <div class="set-row">
        <label>主题</label>
        <div class="theme-btns">
          <button
            v-for="(colors, name) in READER_THEMES"
            :key="name"
            class="theme-btn"
            :class="{ active: settings.reader.theme === name }"
            :style="{ background: colors.bg, color: colors.fg }"
            @click="settings.reader.theme = name as any"
          >文</button>
        </div>
      </div>
      <div class="set-row">
        <label>模式</label>
        <div class="seg">
          <button :class="{ active: settings.reader.flow === 'paginated' }" @click="settings.reader.flow = 'paginated'">翻页</button>
          <button :class="{ active: settings.reader.flow === 'scrolled' }" @click="settings.reader.flow = 'scrolled'">滚动</button>
        </div>
      </div>
      <div class="set-row">
        <label>分栏</label>
        <div class="seg">
          <button :class="{ active: settings.reader.maxColumnCount === 1 }" @click="settings.reader.maxColumnCount = 1">单栏</button>
          <button :class="{ active: settings.reader.maxColumnCount === 2 }" @click="settings.reader.maxColumnCount = 2">自动双栏</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.reader {
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.bar {
  position: absolute;
  left: 0;
  right: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  background: var(--card);
  border-bottom: 1px solid var(--border);
  transition: transform 0.25s, opacity 0.25s;
  color: var(--text);
}
.bar.top {
  top: 0;
}
.bar.bottom {
  bottom: 0;
  top: auto;
  border-bottom: none;
  border-top: 1px solid var(--border);
}
.book-title {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 10px;
  overflow: hidden;
}
.book-title strong {
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chapter {
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bar-actions {
  display: flex;
  gap: 4px;
}
.icon-btn {
  width: 32px;
  height: 32px;
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
.content {
  flex: 1;
  height: 100%;
  padding: 48px 0 44px;
}
.state {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
}
.nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 5;
  width: 40px;
  height: 72px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: transparent;
  transition: all 0.2s;
}
.reader:hover .nav {
  color: var(--text-3);
}
.nav:hover {
  background: rgba(29, 33, 41, 0.08);
  color: var(--text) !important;
}
.nav.prev {
  left: 6px;
}
.nav.next {
  right: 6px;
}
.slider {
  flex: 1;
  accent-color: var(--brand);
}
.percent {
  font-size: 12px;
  color: var(--text-3);
  width: 48px;
  text-align: right;
}
.icon-btn.auto-on {
  color: var(--brand);
}
.auto-panel {
  position: absolute;
  bottom: 56px;
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
.highlight-bar {
  position: absolute;
  top: 56px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
}
.hl-hint {
  font-size: 13px;
  color: var(--text-2);
}
.hl-color {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid #fff;
  box-shadow: 0 0 0 1px var(--border);
}
.annotation-pop {
  position: absolute;
  bottom: 60px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  width: min(420px, calc(100% - 40px));
  padding: 14px 16px;
}
.quote {
  font-size: 13px;
  color: var(--text-2);
  max-height: 80px;
  overflow: auto;
  border-left: 3px solid var(--brand);
  padding-left: 10px;
  margin-bottom: 10px;
}
.pop-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.panel {
  position: absolute;
  top: 52px;
  right: 12px;
  bottom: 50px;
  z-index: 15;
  width: min(320px, calc(100% - 24px));
  padding: 16px;
  display: flex;
  flex-direction: column;
}
.panel h3 {
  font-size: 14px;
  margin-bottom: 10px;
}
.panel-body {
  flex: 1;
  overflow: auto;
}
.panel-empty {
  color: var(--text-3);
  font-size: 13px;
  padding: 20px 0;
  text-align: center;
}
.panel-tip {
  font-size: 12px;
  color: var(--text-3);
  margin-bottom: 8px;
}
.anno-item {
  display: flex;
  gap: 8px;
  padding: 8px;
  border-radius: 6px;
  cursor: pointer;
  align-items: flex-start;
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
.anno-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.anno-text {
  font-size: 13px;
  color: var(--text-2);
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
  padding: 6px 8px;
}
.anno-del {
  width: 24px;
  height: 24px;
  font-size: 12px;
  flex-shrink: 0;
}
.anno-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 10px;
}
.anno-tabs button {
  flex: 1;
  height: 30px;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--text-2);
  font-size: 13px;
}
.anno-tabs button.active {
  background: var(--brand-light);
  color: var(--brand);
  font-weight: 500;
}
.note-input {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 8px 10px;
  font-size: 13px;
  resize: vertical;
  outline: none;
  margin-bottom: 10px;
  font-family: inherit;
}
.note-input:focus {
  border-color: var(--brand);
}
.tts-panel {
  position: absolute;
  bottom: 56px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
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
.tts-hint {
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.6;
}
.search-form {
  margin-bottom: 10px;
}
.search-form .input {
  width: 100%;
}
.search-item {
  font-size: 13px;
  color: var(--text-2);
  padding: 8px;
  border-radius: 6px;
  cursor: pointer;
  line-height: 1.6;
}
.search-item:hover {
  background: var(--bg);
}
.search-item mark {
  background: #ffe58f;
  border-radius: 2px;
}
.settings-pop {
  position: absolute;
  top: 52px;
  right: 12px;
  z-index: 25;
  width: 300px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.set-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}
.set-row label {
  width: 32px;
  color: var(--text-2);
  flex-shrink: 0;
}
.set-row input[type='range'] {
  flex: 1;
  accent-color: var(--brand);
}
.set-row span {
  width: 42px;
  text-align: right;
  color: var(--text-3);
  font-size: 12px;
}
.set-row .input {
  flex: 1;
  height: 30px;
}
.theme-btns {
  display: flex;
  gap: 8px;
}
.theme-btn {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 2px solid var(--border);
  font-size: 14px;
}
.theme-btn.active {
  border-color: var(--brand);
}
.seg {
  display: flex;
  flex: 1;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}
.seg button {
  flex: 1;
  height: 30px;
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
.bar.hidden {
  opacity: 0;
  pointer-events: none;
}

@media (max-width: 600px) {
  .chapter {
    display: none;
  }
  .bar {
    gap: 4px;
    padding: 6px 8px;
  }
  .icon-btn {
    width: 30px;
    height: 30px;
  }
  .book-title strong {
    font-size: 13px;
  }
  .panel {
    right: 8px;
    left: 8px;
    width: auto;
  }
  .settings-pop {
    right: 8px;
    left: 8px;
    width: auto;
  }
  .nav {
    display: none;
  }
}
</style>
