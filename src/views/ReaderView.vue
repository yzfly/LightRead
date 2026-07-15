<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getStorage, type AnnotationRec, type BookMeta } from '../storage'
import { useSettings } from '../stores/settings'
import { useLibrary } from '../stores/library'
import { isTextLike } from '../services/format'
import { convertToEpub } from '../services/textToEpub'
import { getReaderCSS, READER_THEMES, FONT_FAMILIES, HIGHLIGHT_COLORS } from '../services/readerTheme'
import { listSystemFonts, importFontFile, injectFontIntoDoc, resolveFontFamily } from '../services/fonts'
import { isTauri } from '../storage/types'
import { listVoicesSorted, speakText, ssmlToText, stopSpeech, pauseSpeech, resumeSpeech, resetEdgeFailure } from '../services/tts'
import { EDGE_VOICES, edgeAvailable, playAudio } from '../services/edgeTts'
import { localTtsAvailable, localTtsDownload, localTtsStatus, localTtsSynthesize } from '../services/localTts'
import { useReadingTimer } from '../composables/useReadingTimer'
import { toast } from '../services/toast'
import { t } from '../i18n'
import { searchBook, type SearchHit } from '../services/bookSearch'
import { chatStream, aiConfigured, readerSystemPrompt, explainPrompt, type AiMessage } from '../services/ai'
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
const panel = ref<'none' | 'toc' | 'annotations' | 'search' | 'ai'>('none')
const panelEl = ref<HTMLElement>()
const settingsOpen = ref(false)

// ---- 沉浸式阅读: 工具栏悬浮, 自动隐藏, 正文占满全窗 ----
const barsVisible = ref(true)
let barsTimer: ReturnType<typeof setTimeout> | undefined

const anyOverlayOpen = () =>
  panel.value !== 'none' || settingsOpen.value || ttsPanel.value || autoPanel.value || !!activeAnnotation.value

/** 显示工具栏; autoHide 时若几秒内无交互且无面板打开则自动隐去 */
function showBars(autoHide = false) {
  barsVisible.value = true
  clearTimeout(barsTimer)
  if (autoHide) {
    barsTimer = setTimeout(() => {
      if (!anyOverlayOpen()) barsVisible.value = false
    }, 3000)
  }
}

function hideBars() {
  clearTimeout(barsTimer)
  if (!anyOverlayOpen()) barsVisible.value = false
}

const cancelBarsTimer = () => clearTimeout(barsTimer)

// ---- 一键全屏沉浸 ----
const isFullscreen = ref(false)

async function toggleFullscreen() {
  try {
    if (isTauri()) {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      const win = getCurrentWindow()
      const next = !(await win.isFullscreen())
      await win.setFullscreen(next)
      isFullscreen.value = next
    } else if (document.fullscreenElement) {
      await document.exitFullscreen()
      isFullscreen.value = false
    } else {
      await document.documentElement.requestFullscreen()
      isFullscreen.value = true
    }
    // 进入全屏后稍候隐去工具栏, 直接进入纯文字状态
    if (isFullscreen.value) setTimeout(hideBars, 400)
  } catch { /* 平台拒绝全屏时忽略 */ }
}

/** Web 端用户可能按 Esc 或系统手势退出全屏, 同步状态 */
const syncFullscreenState = () => {
  if (!isTauri()) isFullscreen.value = !!document.fullscreenElement
}

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

// 书内搜索 (VSCode 风格: 多关键词 / 正则 / 大小写 / 全词)
const searchQuery = ref('')
const searchResults = ref<SearchHit[]>([])
const searchProgress = ref(0)
const searching = ref(false)
const searchTruncated = ref(false)
const searchOpts = reactive({ caseSensitive: false, wholeWord: false, regex: false })
let searchSession = 0

// ---- AI 阅读助手 ----
const aiMessages = ref<Array<{ role: 'user' | 'assistant'; content: string }>>([])
const aiInput = ref('')
const aiStreaming = ref(false)
const aiListEl = ref<HTMLElement>()
let aiSession = 0

const aiReady = () => aiConfigured()

function aiScrollToEnd() {
  nextTick(() => {
    if (aiListEl.value) aiListEl.value.scrollTop = aiListEl.value.scrollHeight
  })
}

async function sendAi(text?: string) {
  const content = (text ?? aiInput.value).trim()
  if (!content || aiStreaming.value) return
  if (!text) aiInput.value = ''
  const session = ++aiSession
  aiMessages.value.push({ role: 'user', content })
  aiMessages.value.push({ role: 'assistant', content: '' })
  const reply = aiMessages.value[aiMessages.value.length - 1]
  aiStreaming.value = true
  aiScrollToEnd()
  try {
    const history: AiMessage[] = [
      { role: 'system', content: readerSystemPrompt(
        { title: meta.value?.title, author: meta.value?.author },
        chapterLabel.value,
        settings.language,
      ) },
      // 只带最近 8 轮, 控制上下文长度
      ...aiMessages.value.slice(0, -1).slice(-16).map(m => ({ role: m.role, content: m.content })),
    ]
    for await (const delta of chatStream(history)) {
      if (session !== aiSession) return
      reply.content += delta
      aiScrollToEnd()
    }
    if (!reply.content) reply.content = t('ai.emptyReply')
  } catch (e: any) {
    if (session === aiSession) {
      reply.content = `⚠️ ${t('ai.requestFailed')}: ${e?.message ?? e}`
    }
  } finally {
    if (session === aiSession) aiStreaming.value = false
  }
}

/** 划词 → AI 解读 */
function aiExplainSelection() {
  if (!selection.value) return
  const text = selection.value.text.slice(0, 1500)
  selection.value = null
  panel.value = 'ai'
  showBars()
  sendAi(explainPrompt(text, settings.language))
}

async function openRegister() {
  const { openDownload } = await import('../services/updater')
  openDownload('https://cloud.siliconflow.cn/i/TxUlXG3u')
}

function clearAi() {
  aiSession++
  aiStreaming.value = false
  aiMessages.value = []
}

function stopAi() {
  aiSession++
  aiStreaming.value = false
}

// 自动阅读
const autoPanel = ref(false)
const autoReading = ref(false)
let autoTimer: ReturnType<typeof setInterval> | undefined

let view: any = null
let Overlayer: any = null
let saveTimer: ReturnType<typeof setTimeout> | undefined

const themeColors = computed(() => READER_THEMES[settings.reader.theme])

/** 当前选中的自定义字体 (settings.reader.fontFamily 为 custom:Name 时) */
function selectedCustomFont() {
  const m = settings.reader.fontFamily.match(/^custom:(.+)$/)
  return m ? settings.customFonts.find(f => f.name === m[1]) : undefined
}

function applyPrefs() {
  if (!view) return
  const prefs = settings.reader
  try {
    view.renderer.setAttribute('animated', '')
    view.renderer.setAttribute('flow', prefs.flow)
    view.renderer.setAttribute('gap', `${prefs.gap}%`)
    view.renderer.setAttribute('max-column-count', String(prefs.maxColumnCount))
    view.renderer.setStyles?.(getReaderCSS({ ...prefs, fontFamily: resolveFontFamily(prefs.fontFamily) }))
    const custom = selectedCustomFont()
    if (custom) {
      for (const content of view.renderer.getContents?.() ?? []) {
        injectFontIntoDoc(content.doc, custom)
      }
    }
  } catch { /* 章节切换瞬间 iframe 文档可能已卸载, 下次 relocate 会重新应用 */ }
}

/** 精准输入字号, 越界收敛到 8-64 */
function setFontSize(raw: string) {
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n)) return
  settings.reader.fontSize = Math.min(64, Math.max(8, n))
}

// ---- 字体选择 ----
const systemFonts = ref<string[]>([])

watch(settingsOpen, async open => {
  if (open && isTauri() && !systemFonts.value.length) {
    try {
      systemFonts.value = await listSystemFonts()
    } catch { /* 枚举失败不影响预设字体 */ }
  }
})

async function importFont() {
  try {
    const font = await importFontFile()
    if (!font) return
    if (!settings.customFonts.some(f => f.file === font.file)) {
      settings.customFonts.push(font)
    }
    settings.reader.fontFamily = `custom:${font.name}`
    toast(t('reader.fontImported', { name: font.name }), 'success')
  } catch (e: any) {
    toast(t('reader.fontImportFailed', { msg: e?.message ?? e }), 'error', 5000)
  }
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

/**
 * 手动翻页/跳转与听书的协调: 听书播放时视图会跟随朗读句滚动,
 * 若不打断, 用户翻过去的页面会在下一句读完时被拉回朗读位置。
 * 策略: 立即终止当前朗读循环, 定位动作落定后从新位置重新开始读。
 */
let ttsResyncTimer: ReturnType<typeof setTimeout> | undefined
let ttsInterrupted = false

function interruptTTSForReposition() {
  if (ttsState.value === 'stopped') return
  ttsSession++          // 旧循环在下一个检查点退出, 不再调用 next(true) 拉回视图
  stopSpeech()
  ttsInterrupted = true
  clearTimeout(ttsResyncTimer)
  ttsResyncTimer = setTimeout(() => {
    // 连续翻页时防抖, 落定后从当前页重新开始; 暂停中不自动恢复, 等用户点继续
    if (ttsState.value === 'playing') {
      ttsInterrupted = false
      startTTS()
    }
  }, 800)
}

function turnPage(dir: 'left' | 'right') {
  interruptTTSForReposition()
  hideBars()
  dir === 'left' ? view?.goLeft() : view?.goRight()
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') turnPage('left')
  else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') turnPage('right')
  else if (e.key === 'Escape') {
    if (isFullscreen.value && isTauri()) toggleFullscreen()
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
    turnPage('right')
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

/**
 * 取当前可视位置的第一段朗读 SSML。
 * foliate 的 tts.from() 在找不到起始朗读块时会抛错 (内部 list.find 无空值
 * 保护, 如段落跨页的章节末页), 逐级回退: 完整可视范围 → 页首点 → 章首。
 */
function ttsFirstSsml(): string | undefined {
  const range = view.lastLocation?.range
  if (range) {
    try {
      return view.tts.from(range)
    } catch { /* 回退下一级 */ }
    try {
      const collapsed = range.cloneRange()
      collapsed.collapse(true)
      return view.tts.from(collapsed)
    } catch { /* 回退章首 */ }
  }
  return view.tts.start()
}


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
  ttsInterrupted = false
  stopSpeech()
  resetEdgeFailure()
  ttsState.value = 'playing'
  try {
    await view.initTTS('sentence')
    // 从当前可视位置开始朗读, 而不是本章开头; 无定位信息时回退到章首
    let ssml: string | undefined = ttsFirstSsml()
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
    toast(t('tts.error'), 'error')
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
  // 暂停期间翻过页: 原朗读循环已终止, 从当前页面重新开始
  if (ttsInterrupted) {
    ttsInterrupted = false
    startTTS()
    return
  }
  resumeSpeech()
}

function stopTTS() {
  ttsSession++
  ttsState.value = 'stopped'
  clearTimeout(ttsResyncTimer)
  ttsInterrupted = false
  stopSpeech()
}

function onSectionLoad(e: CustomEvent) {
  const { doc, index } = e.detail
  for (const resolve of sectionLoadResolvers.splice(0)) resolve()
  const custom = selectedCustomFont()
  if (custom) injectFontIntoDoc(doc, custom)
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
  doc.addEventListener('click', (e: MouseEvent) => {
    // 触屏轻点已在 touchend 处理过, 吞掉其后的合成 click
    if (Date.now() < suppressClickUntil) return
    onContentClick(e.clientX, doc, e.target as Element)
  })

  // 触屏轻点: 触摸设备上合成 click 与 foliate 的 touch 吸附赛跑, 时有丢失/弹回
  // (Windows 触屏的"点击翻不动/翻了又弹回")。轻点在 touchend 直接判定并翻页,
  // 与滑动走同一条触摸管线; 之后的合成 click 一律吞掉。
  let touchStart: { x: number; y: number; t: number } | null = null
  doc.addEventListener('touchstart', (e: TouchEvent) => {
    const t0 = e.changedTouches[0]
    touchStart = t0 ? { x: t0.clientX, y: t0.clientY, t: Date.now() } : null
    pointerTs = Date.now()
  }, { passive: true })
  // 捕获阶段先于 foliate 的 touchend 监听: 轻点时阻断其"吸附回当前页"动画,
  // 否则吸附动画与我们的翻页动画并发抢写滚动位置, 随机弹回 (Windows 触屏的病根)
  doc.addEventListener('touchend', (e: TouchEvent) => {
    const t0 = e.changedTouches[0]
    const st = touchStart
    touchStart = null
    if (!st || !t0) return
    // 有位移是滑动, 长按是选字, 都交给原有流程
    if (Math.abs(t0.clientX - st.x) > 10 || Math.abs(t0.clientY - st.y) > 10) return
    if (Date.now() - st.t > 350) return
    e.stopImmediatePropagation()
    if (panel.value !== 'none' || settingsOpen.value || activeAnnotation.value) {
      panel.value = 'none'
      settingsOpen.value = false
      activeAnnotation.value = null
    } else {
      onContentClick(t0.clientX, doc, e.target as Element)
    }
    // 吞掉这次轻点随后的合成 click (必须在处理之后设置)
    suppressClickUntil = Date.now() + 700
  }, { passive: true, capture: true })

  // 指针/触摸引发的 focusin 会让 foliate 回滚到旧锚点 (表现为翻页弹回), 拦掉;
  // 键盘 Tab 导航的 focusin 不受影响
  doc.addEventListener('pointerdown', () => { pointerTs = Date.now() }, true)
  doc.addEventListener('focusin', (e: FocusEvent) => {
    if (Date.now() - pointerTs < 1000) e.stopImmediatePropagation()
  }, true)
}

let pointerTs = 0
let suppressClickUntil = 0

// 点正文左/右侧翻页
let overlayDismissed = false

function onContentClick(clientX: number, doc: Document, target?: Element | null) {
  if (overlayDismissed) {
    overlayDismissed = false
    return
  }
  // 开书未就绪时点击会被 view.init 的落点覆盖, 表现为翻过去又弹回
  if (loading.value) return
  // 滚动模式点击不翻页, 只切换工具栏
  if (settings.reader.flow !== 'paginated') {
    barsVisible.value ? hideBars() : showBars()
    return
  }
  // 正在选字或点了链接时不翻页
  if (selection.value) return
  const sel = doc.getSelection()
  if (sel && !sel.isCollapsed) return
  if (target?.closest?.('a[href]')) return
  // iframe 内坐标换算到窗口坐标 (分页模式下 iframe 比可视区宽且随翻页平移)
  const frameRect = doc.defaultView?.frameElement?.getBoundingClientRect()
  const contentRect = container.value?.getBoundingClientRect()
  if (!frameRect || !contentRect) return
  const x = frameRect.left + clientX - contentRect.left
  if (x < contentRect.width / 3) turnPage('left')
  else if (x > contentRect.width * 2 / 3) turnPage('right')
  // 中间 1/3: 呼出 / 隐藏工具栏 (沉浸式)
  else barsVisible.value ? hideBars() : showBars()
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
    toast(t('reader.highlighted'), 'success')
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
  toast(t('reader.noteSaved'), 'success')
}

async function toggleBookmark() {
  if (!currentCfi.value) return
  const existing = bookmarks.value.find(b => b.cfi === currentCfi.value)
  const storage = await getStorage()
  if (existing) {
    await storage.deleteAnnotation(existing.id)
    annotations.value = annotations.value.filter(a => a.id !== existing.id)
    toast(t('reader.bookmarkRemoved'))
    return
  }
  const rec: Omit<AnnotationRec, 'id'> = {
    bookId,
    kind: 'bookmark',
    cfi: currentCfi.value,
    text: `${chapterLabel.value || meta.value?.title || t('reader.position')} · ${(fraction.value * 100).toFixed(1)}%`,
    color: 'bookmark',
    createdAt: Date.now(),
  }
  const id = await storage.addAnnotation(rec)
  annotations.value.push({ ...rec, id })
  toast(t('reader.bookmarkAdded'), 'success')
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
  interruptTTSForReposition()
  await untilLoaded()
  view?.goTo(a.cfi).catch(() => toast(t('reader.cantGotoAnnotation'), 'error'))
}

async function runSearch() {
  const query = searchQuery.value.trim()
  if (!query || !view) return
  const session = ++searchSession
  searching.value = true
  searchResults.value = []
  searchTruncated.value = false
  searchProgress.value = 0
  try {
    for await (const ev of searchBook(view, query, searchOpts)) {
      if (session !== searchSession) return
      searchProgress.value = ev.progress
      if (ev.hits.length) searchResults.value.push(...ev.hits)
      if (ev.truncated) searchTruncated.value = true
    }
  } catch (e) {
    console.error(e)
    toast(searchOpts.regex ? t('reader.invalidRegex') : t('reader.searchFailed'), 'error')
  } finally {
    if (session === searchSession) searching.value = false
  }
}

/** 切换搜索选项后, 若已有关键词则立即重搜 */
function toggleSearchOpt(key: 'caseSensitive' | 'wholeWord' | 'regex') {
  searchOpts[key] = !searchOpts[key]
  if (searchQuery.value.trim()) runSearch()
}

function gotoSearchHit(hit: SearchHit) {
  panel.value = 'none'
  interruptTTSForReposition()
  view?.goTo(hit.cfi).catch(() => toast(t('reader.cantGoto'), 'error'))
}

function closeSearch() {
  searchSession++
  searching.value = false
  panel.value = 'none'
  searchResults.value = []
}

/** 打开书的瞬间 view.init 尚未归位, 此时跳转会被 init 落点覆盖 — 等它完成 */
async function untilLoaded() {
  for (let i = 0; i < 50 && loading.value; i++) {
    await new Promise(r => setTimeout(r, 100))
  }
}

async function navigateToc(href: string) {
  panel.value = 'none'
  interruptTTSForReposition()
  await untilLoaded()
  view?.goTo(href).catch(() => toast(t('reader.cantGoto'), 'error'))
}

function onSlide(e: Event) {
  const value = parseFloat((e.target as HTMLInputElement).value)
  interruptTTSForReposition()
  view?.goToFraction(value)
}

onMounted(async () => {
  window.addEventListener('keydown', handleKeydown)
  document.addEventListener('fullscreenchange', syncFullscreenState)
  showBars(true)
  try {
    const storage = await getStorage()
    meta.value = await storage.getBook(bookId)
    if (!meta.value) {
      error.value = t('reader.bookNotFound')
      return
    }
    if (meta.value.format === 'pdf') {
      router.replace(`/read-paper/${bookId}`)
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
    error.value = e?.message ?? t('reader.cantOpenBook')
  } finally {
    loading.value = false
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
  document.removeEventListener('fullscreenchange', syncFullscreenState)
  // 回藏书页时恢复窗口状态
  if (isFullscreen.value) toggleFullscreen()
  clearTimeout(saveTimer)
  stopAutoRead()
  stopTTS()
  view?.close?.()
  view?.remove()
})
</script>

<template>
  <div class="reader" :style="{ background: themeColors.bg, color: themeColors.fg }">
    <!-- 工具栏隐藏时: 鼠标移到上下边缘呼出 -->
    <div v-if="!barsVisible" class="bar-peek top" @mouseenter="showBars()" />
    <div v-if="!barsVisible" class="bar-peek bottom" @mouseenter="showBars()" />

    <!-- 全屏时右上角悬浮退出按钮 -->
    <button
      v-if="isFullscreen && !barsVisible"
      class="fs-exit"
      :title="t('reader.exitFullscreen')"
      @click="toggleFullscreen"
    >
      <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M8 3a1 1 0 0 1 1 1v3a2 2 0 0 1-2 2H4a1 1 0 0 1 0-2h3V4a1 1 0 0 1 1-1zm8 0a1 1 0 0 1 1 1v3h3a1 1 0 1 1 0 2h-3a2 2 0 0 1-2-2V4a1 1 0 0 1 1-1zM4 15h3a2 2 0 0 1 2 2v3a1 1 0 1 1-2 0v-3H4a1 1 0 0 1 0-2zm13 0h3a1 1 0 1 1 0 2h-3v3a1 1 0 1 1-2 0v-3a2 2 0 0 1 2-2z"/></svg>
    </button>

    <!-- 顶栏 -->
    <header class="bar top" :class="{ hidden: !barsVisible }" @mouseenter="cancelBarsTimer">
      <button class="icon-btn" :title="t('reader.backToLibrary')" @click="router.push('/library')">
        <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M14.7 5.3a1 1 0 0 1 0 1.4L9.42 12l5.3 5.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0z"/></svg>
      </button>
      <div class="book-title">
        <strong>{{ meta?.title }}</strong>
        <span v-if="chapterLabel" class="chapter">{{ chapterLabel }}</span>
      </div>
      <div class="bar-actions">
        <button class="icon-btn" :title="t('reader.toc')" @click="panel = panel === 'toc' ? 'none' : 'toc'">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M4 6a1 1 0 0 1 1-1h1a1 1 0 0 1 0 2H5a1 1 0 0 1-1-1zm5 0a1 1 0 0 1 1-1h9a1 1 0 1 1 0 2h-9a1 1 0 0 1-1-1zM4 12a1 1 0 0 1 1-1h1a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1zm5 0a1 1 0 0 1 1-1h9a1 1 0 1 1 0 2h-9a1 1 0 0 1-1-1zM4 18a1 1 0 0 1 1-1h1a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1zm5 0a1 1 0 0 1 1-1h9a1 1 0 1 1 0 2h-9a1 1 0 0 1-1-1z"/></svg>
        </button>
        <button class="icon-btn" :title="t('reader.annotationsBookmarks')" @click="panel = panel === 'annotations' ? 'none' : 'annotations'">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19a1 1 0 0 1 1 1v15a2 2 0 0 1-2 2H6.5A2.5 2.5 0 0 1 4 18.5v-13zM6.5 5a.5.5 0 0 0-.5.5v11.34c.16-.05.33-.08.5-.08H18V5H6.5z"/></svg>
        </button>
        <button
          class="icon-btn"
          :class="{ 'auto-on': isBookmarked }"
          :title="isBookmarked ? t('reader.removeBookmark') : t('reader.addBookmark')"
          @click="toggleBookmark"
        >
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path v-if="isBookmarked" fill="currentColor" d="M6 3h12a1 1 0 0 1 1 1v16.2a.8.8 0 0 1-1.24.67L12 17.6l-5.76 3.27A.8.8 0 0 1 5 20.2V4a1 1 0 0 1 1-1z"/>
            <path v-else fill="currentColor" d="M6 3h12a1 1 0 0 1 1 1v16.2a.8.8 0 0 1-1.24.67L12 17.6l-5.76 3.27A.8.8 0 0 1 5 20.2V4a1 1 0 0 1 1-1zm1 2v13.48l4.5-2.55a1 1 0 0 1 .99 0l4.51 2.55V5H7z"/>
          </svg>
        </button>
        <button class="icon-btn" :class="{ 'auto-on': ttsState !== 'stopped' }" :title="t('tts.title')" @click="openTTSPanel">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 3a7 7 0 0 0-7 7v1.1A3.5 3.5 0 0 0 3 14.5v2A3.5 3.5 0 0 0 6.5 20H8a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1h-.9A5 5 0 0 1 12 5a5 5 0 0 1 4.9 6H16a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h1.5a3.5 3.5 0 0 0 3.5-3.5v-2a3.5 3.5 0 0 0-2-3.16V10a7 7 0 0 0-7-7z"/></svg>
        </button>
        <button class="icon-btn" :class="{ 'auto-on': panel === 'ai' }" :title="t('ai.title')" @click="panel = panel === 'ai' ? 'none' : 'ai'">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 2.5a1 1 0 0 1 .95.69l1.4 4.3a3 3 0 0 0 1.92 1.92l4.3 1.4a1 1 0 0 1 0 1.9l-4.3 1.4a3 3 0 0 0-1.92 1.92l-1.4 4.3a1 1 0 0 1-1.9 0l-1.4-4.3a3 3 0 0 0-1.92-1.92l-4.3-1.4a1 1 0 0 1 0-1.9l4.3-1.4a3 3 0 0 0 1.92-1.92l1.4-4.3A1 1 0 0 1 12 2.5zm7.5 12.7a.8.8 0 0 1 .76.55l.42 1.28a1.6 1.6 0 0 0 1.02 1.02l1.28.42a.8.8 0 0 1 0 1.52l-1.28.42a1.6 1.6 0 0 0-1.02 1.02l-.42 1.28a.8.8 0 0 1-1.52 0l-.42-1.28a1.6 1.6 0 0 0-1.02-1.02l-1.28-.42a.8.8 0 0 1 0-1.52l1.28-.42a1.6 1.6 0 0 0 1.02-1.02l.42-1.28a.8.8 0 0 1 .76-.55z"/></svg>
        </button>
        <button class="icon-btn" :title="t('reader.searchInBook')" @click="panel = panel === 'search' ? 'none' : 'search'">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M10.5 3a7.5 7.5 0 1 0 4.55 13.46l3.75 3.75a1 1 0 0 0 1.4-1.42l-3.74-3.74A7.5 7.5 0 0 0 10.5 3zM5 10.5a5.5 5.5 0 1 1 11 0 5.5 5.5 0 0 1-11 0z"/></svg>
        </button>
        <button
          class="icon-btn"
          :class="{ 'auto-on': autoReading }"
          :title="t('reader.autoRead')"
          @click="autoPanel = !autoPanel; if (autoPanel) ttsPanel = false"
        >
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm-1.8 4.4 5.4 3.1a.6.6 0 0 1 0 1l-5.4 3.1a.6.6 0 0 1-.9-.5V8.9a.6.6 0 0 1 .9-.5z"/></svg>
        </button>
        <button class="icon-btn" :title="t('reader.typography')" @click="settingsOpen = !settingsOpen">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M11.1 4.55a1 1 0 0 1 1.8 0l5.6 12.02a1 1 0 1 1-1.81.86L15.3 14.5H8.7l-1.39 2.93a1 1 0 1 1-1.8-.86L11.1 4.55zM9.64 12.5h4.72L12 7.36 9.64 12.5z"/></svg>
        </button>
        <button class="icon-btn" :class="{ 'auto-on': isFullscreen }" :title="isFullscreen ? t('reader.exitFullscreen') : t('reader.fullscreen')" @click="toggleFullscreen">
          <svg v-if="!isFullscreen" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M4 9a1 1 0 0 1-1-1V5a2 2 0 0 1 2-2h3a1 1 0 0 1 0 2H5v3a1 1 0 0 1-1 1zm16 0a1 1 0 0 1-1-1V5h-3a1 1 0 1 1 0-2h3a2 2 0 0 1 2 2v3a1 1 0 0 1-1 1zM4 15a1 1 0 0 1 1 1v3h3a1 1 0 1 1 0 2H5a2 2 0 0 1-2-2v-3a1 1 0 0 1 1-1zm16 0a1 1 0 0 1 1 1v3a2 2 0 0 1-2 2h-3a1 1 0 1 1 0-2h3v-3a1 1 0 0 1 1-1z"/></svg>
          <svg v-else viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M8 3a1 1 0 0 1 1 1v3a2 2 0 0 1-2 2H4a1 1 0 0 1 0-2h3V4a1 1 0 0 1 1-1zm8 0a1 1 0 0 1 1 1v3h3a1 1 0 1 1 0 2h-3a2 2 0 0 1-2-2V4a1 1 0 0 1 1-1zM4 15h3a2 2 0 0 1 2 2v3a1 1 0 1 1-2 0v-3H4a1 1 0 0 1 0-2zm13 0h3a1 1 0 1 1 0 2h-3v3a1 1 0 1 1-2 0v-3a2 2 0 0 1 2-2z"/></svg>
        </button>
      </div>
    </header>

    <!-- 正文 -->
    <div ref="container" class="content" />

    <div v-if="loading" class="state">{{ t('reader.opening') }}</div>
    <div v-if="error" class="state">
      <p>{{ error }}</p>
      <button class="btn" @click="router.push('/library')">{{ t('reader.backToLibrary') }}</button>
    </div>

    <!-- 翻页按钮 -->
    <button v-if="!loading && !error" class="nav prev" :title="t('reader.prevPage')" @click="turnPage('left')">
      <svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M14.7 5.3a1 1 0 0 1 0 1.4L9.42 12l5.3 5.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0z"/></svg>
    </button>
    <button v-if="!loading && !error" class="nav next" :title="t('reader.nextPage')" @click="turnPage('right')">
      <svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M9.3 5.3a1 1 0 0 1 1.4 0l6 6a1 1 0 0 1 0 1.4l-6 6a1 1 0 0 1-1.4-1.4l5.29-5.3-5.3-5.3a1 1 0 0 1 0-1.4z"/></svg>
    </button>

    <!-- 底栏: 进度 -->
    <footer class="bar bottom" :class="{ hidden: !barsVisible }" @mouseenter="cancelBarsTimer">
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
        {{ autoReading ? '⏸ ' + t('common.pause') : '▶ ' + t('common.start') }}
      </button>
      <label>{{ t('reader.speed') }}</label>
      <input v-model.number="settings.autoReadSeconds" type="range" min="3" max="60" step="1" />
      <span class="auto-speed">{{ t('reader.secPerPage', { n: settings.autoReadSeconds }) }}</span>
      <button class="icon-btn" :title="t('common.close')" @click="autoPanel = false; stopAutoRead()">✕</button>
    </div>

    <!-- 高亮选区浮条 -->
    <div v-if="selection" class="highlight-bar card">
      <span class="hl-hint">{{ t('reader.highlight') }}</span>
      <button
        v-for="(hex, name) in HIGHLIGHT_COLORS"
        :key="name"
        class="hl-color"
        :style="{ background: hex }"
        @click="addHighlight(name as string)"
      />
      <button class="btn btn-sm" @click="addHighlight('yellow', true)">💬 {{ t('reader.writeNote') }}</button>
      <button class="btn btn-sm" @click="aiExplainSelection">✨ {{ t('ai.explain') }}</button>
      <button class="icon-btn" :title="t('common.cancel')" @click="selection = null">✕</button>
    </div>

    <!-- 标注详情 / 想法编辑浮层 -->
    <div v-if="activeAnnotation" class="annotation-pop card">
      <p class="quote">{{ activeAnnotation.text }}</p>
      <textarea
        v-model="noteDraft"
        class="note-input"
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

    <!-- 听书迷你胶囊: 面板收起但会话未停止时显示 -->
    <div
      v-if="!ttsPanel && ttsState !== 'stopped'"
      class="tts-mini card"
      :title="t('tts.expandPanel')"
      @click="ttsPanel = true"
    >
      <span class="tts-mini-dot" :class="{ paused: ttsState === 'paused' }" />
      <span class="tts-mini-label">{{ ttsState === 'playing' ? t('tts.reading') : t('tts.paused') }}</span>
      <button
        class="tts-mini-btn"
        :title="ttsState === 'playing' ? t('common.pause') : t('common.resume')"
        @click.stop="ttsState === 'playing' ? pauseTTS() : resumeTTS()"
      >{{ ttsState === 'playing' ? '⏸' : '▶' }}</button>
      <button class="tts-mini-btn" :title="t('common.stop')" @click.stop="stopTTS()">⏹</button>
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
        <span style="flex: 1" />
        <button class="btn btn-sm" :title="t('tts.collapseHint')" @click="ttsPanel = false">{{ t('tts.collapse') }}</button>
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
        <label>音色</label>
        <select v-model="settings.edgeVoice" class="input">
          <option v-for="v in EDGE_VOICES" :key="v.id" :value="v.id">{{ v.label }}</option>
        </select>
      </div>
      <div v-if="edgeAvailable() && settings.ttsEngine === 'local'" class="tts-row">
        <label>音色</label>
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
        <label>音色</label>
        <select v-model="settings.ttsVoice" class="input">
          <option value="">{{ t('tts.autoVoice') }}</option>
          <option v-for="v in ttsVoices" :key="v.name" :value="v.name">{{ v.name }} ({{ v.lang }})</option>
        </select>
      </div>
      <p class="tts-hint">
        {{ edgeAvailable() && settings.ttsEngine === 'edge' ? t('tts.hintEdge') : t('tts.hintSystem') }}
        {{ t('tts.hintApply') }}
      </p>
    </div>

    <!-- 侧栏面板 -->
    <aside v-if="panel !== 'none'" ref="panelEl" class="panel card">
      <template v-if="panel === 'toc'">
        <h3>{{ t('reader.toc') }}</h3>
        <div class="panel-body">
          <TocList :items="toc" :current-href="currentTocHref" @navigate="navigateToc" />
          <p v-if="!toc.length" class="panel-empty">{{ t('reader.noToc') }}</p>
        </div>
      </template>

      <template v-else-if="panel === 'annotations'">
        <div class="anno-tabs">
          <button :class="{ active: annoTab === 'highlight' }" @click="annoTab = 'highlight'">
            {{ t('reader.highlightsTab') }} ({{ highlights.length }})
          </button>
          <button :class="{ active: annoTab === 'bookmark' }" @click="annoTab = 'bookmark'">
            {{ t('reader.bookmarksTab') }} ({{ bookmarks.length }})
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
            <p v-if="!highlights.length" class="panel-empty">{{ t('reader.highlightEmptyHint') }}</p>
          </template>
          <template v-else>
            <div v-for="a in bookmarks" :key="a.id" class="anno-item" @click="gotoAnnotation(a)">
              <svg viewBox="0 0 24 24" width="14" height="14" style="flex-shrink: 0; margin-top: 3px"><path fill="var(--brand)" d="M6 3h12a1 1 0 0 1 1 1v16.2a.8.8 0 0 1-1.24.67L12 17.6l-5.76 3.27A.8.8 0 0 1 5 20.2V4a1 1 0 0 1 1-1z"/></svg>
              <span class="anno-body">
                <span class="anno-text">{{ a.text }}</span>
              </span>
              <button class="icon-btn anno-del" :title="t('common.delete')" @click.stop="removeAnnotation(a)">✕</button>
            </div>
            <p v-if="!bookmarks.length" class="panel-empty">{{ t('reader.bookmarkEmptyHint') }}</p>
          </template>
        </div>
      </template>

      <template v-else-if="panel === 'ai'">
        <h3>✨ {{ t('ai.title') }}</h3>
        <div v-if="!aiReady()" class="ai-setup">
          <p>{{ t('ai.setupHint') }}</p>
          <ol class="ai-steps">
            <li>{{ t('ai.step1') }}</li>
            <li>{{ t('ai.step2') }}</li>
            <li>{{ t('ai.step3') }}</li>
          </ol>
          <div class="ai-setup-actions">
            <button class="btn btn-sm btn-primary" @click="openRegister">{{ t('ai.register') }}</button>
            <button class="btn btn-sm" @click="router.push('/settings')">{{ t('ai.goSettings') }}</button>
          </div>
          <p class="ai-setup-alt">{{ t('ai.setupAlt') }}</p>
        </div>
        <template v-else>
          <div ref="aiListEl" class="panel-body ai-list">
            <p v-if="!aiMessages.length" class="panel-empty">{{ t('ai.intro') }}</p>
            <div v-for="(m, i) in aiMessages" :key="i" class="ai-msg" :class="m.role">
              <div class="ai-bubble">{{ m.content }}<span v-if="m.role === 'assistant' && aiStreaming && i === aiMessages.length - 1" class="ai-cursor">▍</span></div>
            </div>
          </div>
          <div class="ai-input-row">
            <input
              v-model="aiInput"
              class="input"
              :placeholder="t('ai.placeholder')"
              :disabled="aiStreaming"
              @keyup.enter="sendAi()"
            />
            <button v-if="aiStreaming" class="btn btn-sm" @click="stopAi">{{ t('common.stop') }}</button>
            <button v-else class="btn btn-sm btn-primary" :disabled="!aiInput.trim()" @click="sendAi()">{{ t('ai.send') }}</button>
          </div>
          <button v-if="aiMessages.length" class="btn btn-sm ai-clear" @click="clearAi">{{ t('ai.clear') }}</button>
        </template>
      </template>

      <template v-else>
        <h3>{{ t('reader.searchInBook') }}</h3>
        <form class="search-form" @submit.prevent="runSearch">
          <input v-model="searchQuery" class="input" type="search" :placeholder="t('reader.searchPlaceholder')" />
        </form>
        <div class="search-opts">
          <button type="button" class="search-opt" :class="{ active: searchOpts.caseSensitive }" :title="t('reader.matchCase')" @click="toggleSearchOpt('caseSensitive')">Aa</button>
          <button type="button" class="search-opt" :class="{ active: searchOpts.wholeWord }" :title="t('reader.wholeWord')" @click="toggleSearchOpt('wholeWord')">\b</button>
          <button type="button" class="search-opt" :class="{ active: searchOpts.regex }" :title="t('reader.useRegex')" @click="toggleSearchOpt('regex')">.*</button>
          <span v-if="searching" class="search-count">{{ Math.round(searchProgress * 100) }}%</span>
          <span v-else-if="searchQuery && searchResults.length" class="search-count">
            {{ t('reader.resultCount', { n: searchResults.length }) }}{{ searchTruncated ? '+' : '' }}
          </span>
        </div>
        <div class="panel-body">
          <template v-for="(r, i) in searchResults" :key="i">
            <div
              v-if="i === 0 || r.chapter !== searchResults[i - 1].chapter"
              class="search-chapter"
            >{{ r.chapter || '·' }}</div>
            <div class="search-item" @click="gotoSearchHit(r)"><template v-for="(seg, j) in r.segments" :key="j"><mark v-if="seg.hit">{{ seg.text }}</mark><template v-else>{{ seg.text }}</template></template></div>
          </template>
          <p v-if="!searching && searchQuery && !searchResults.length" class="panel-empty">{{ t('reader.noResults') }}</p>
        </div>
        <button class="btn btn-sm" style="margin-top: 8px" @click="closeSearch">{{ t('reader.clearAndClose') }}</button>
      </template>
    </aside>

    <!-- 排版设置浮层 -->
    <div v-if="settingsOpen" class="settings-pop card">
      <div class="set-row">
        <label>{{ t('reader.fontSize') }}</label>
        <input v-model.number="settings.reader.fontSize" type="range" min="12" max="64" step="1" />
        <input
          class="input set-num"
          type="number"
          min="8"
          max="64"
          step="1"
          :value="settings.reader.fontSize"
          @change="setFontSize(($event.target as HTMLInputElement).value)"
        />
      </div>
      <div class="set-row">
        <label>{{ t('reader.lineHeight') }}</label>
        <input v-model.number="settings.reader.lineHeight" type="range" min="1.2" max="2.6" step="0.1" />
        <span>{{ settings.reader.lineHeight.toFixed(1) }}</span>
      </div>
      <div class="set-row">
        <label>{{ t('reader.margin') }}</label>
        <input v-model.number="settings.reader.gap" type="range" min="2" max="16" step="1" />
        <span>{{ settings.reader.gap }}%</span>
      </div>
      <div class="set-row">
        <label>{{ t('reader.font') }}</label>
        <select v-model="settings.reader.fontFamily" class="input">
          <option v-for="f in FONT_FAMILIES" :key="f.labelKey" :value="f.value">{{ t(f.labelKey) }}</option>
          <optgroup v-if="settings.customFonts.length" :label="t('reader.customFonts')">
            <option v-for="f in settings.customFonts" :key="f.file" :value="`custom:${f.name}`">{{ f.name }}</option>
          </optgroup>
          <optgroup v-if="systemFonts.length" :label="t('reader.systemFonts')">
            <option v-for="name in systemFonts" :key="name" :value="`&quot;${name}&quot;`">{{ name }}</option>
          </optgroup>
        </select>
      </div>
      <div v-if="isTauri()" class="set-row">
        <label></label>
        <button class="btn btn-sm" @click="importFont">{{ t('reader.importFont') }}</button>
        <span class="font-hint">ttf / otf / woff2</span>
      </div>
      <div class="set-row">
        <label>{{ t('reader.theme') }}</label>
        <div class="theme-btns">
          <button
            v-for="(colors, name) in READER_THEMES"
            :key="name"
            class="theme-btn"
            :class="{ active: settings.reader.theme === name }"
            :style="{ background: colors.bg, color: colors.fg }"
            @click="settings.reader.theme = name as any"
          >{{ t('reader.themeSample') }}</button>
        </div>
      </div>
      <div class="set-row">
        <label>{{ t('reader.mode') }}</label>
        <div class="seg">
          <button :class="{ active: settings.reader.flow === 'paginated' }" @click="settings.reader.flow = 'paginated'">{{ t('reader.paginated') }}</button>
          <button :class="{ active: settings.reader.flow === 'scrolled' }" @click="settings.reader.flow = 'scrolled'">{{ t('reader.scrolled') }}</button>
        </div>
      </div>
      <div class="set-row">
        <label>{{ t('reader.columns') }}</label>
        <div class="seg">
          <button :class="{ active: settings.reader.maxColumnCount === 1 }" @click="settings.reader.maxColumnCount = 1">{{ t('reader.singleColumn') }}</button>
          <button :class="{ active: settings.reader.maxColumnCount === 2 }" @click="settings.reader.maxColumnCount = 2">{{ t('reader.autoTwoColumns') }}</button>
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
  background: color-mix(in srgb, var(--card) 86%, transparent);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border);
  transition: transform 0.25s, opacity 0.25s;
  color: var(--text);
}
/* 全屏时的悬浮退出按钮: 平时低调, 悬停清晰 */
.fs-exit {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 12;
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 50%;
  background: color-mix(in srgb, var(--card) 70%, transparent);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  color: var(--text-3);
  opacity: 0.45;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.2s;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
}
.fs-exit:hover {
  opacity: 1;
  color: var(--text);
}
/* 工具栏隐藏时的边缘呼出热区 */
.bar-peek {
  position: absolute;
  left: 0;
  right: 0;
  height: 14px;
  z-index: 9;
}
.bar-peek.top {
  top: 0;
}
.bar-peek.bottom {
  bottom: 0;
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
.tts-mini {
  position: absolute;
  bottom: 56px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px 6px 14px;
  border-radius: 999px;
  cursor: pointer;
  user-select: none;
}
.tts-mini-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--brand);
  animation: tts-pulse 1.6s ease-in-out infinite;
}
.tts-mini-dot.paused {
  background: var(--text-3);
  animation: none;
}
@keyframes tts-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.75); }
}
.tts-mini-label {
  font-size: 13px;
  color: var(--text-2);
}
.tts-mini-btn {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 50%;
  background: var(--bg);
  color: var(--text-2);
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.tts-mini-btn:hover {
  background: var(--brand-light);
  color: var(--brand);
}
.tts-panel {
  position: absolute;
  top: 52px;
  right: 12px;
  z-index: 25;
  width: min(400px, calc(100% - 24px));
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
.ai-setup {
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.8;
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-start;
}
.ai-steps {
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--text-2);
}
.ai-setup-actions {
  display: flex;
  gap: 8px;
}
.ai-setup-alt {
  font-size: 12px;
  color: var(--text-3);
}
.ai-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-right: 2px;
}
.ai-msg {
  display: flex;
}
.ai-msg.user {
  justify-content: flex-end;
}
.ai-bubble {
  max-width: 92%;
  padding: 8px 10px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}
.ai-msg.user .ai-bubble {
  background: var(--brand-light);
  color: var(--text);
}
.ai-msg.assistant .ai-bubble {
  background: var(--bg);
  color: var(--text-2);
}
.ai-cursor {
  color: var(--brand);
  animation: tts-pulse 1s ease-in-out infinite;
}
.ai-input-row {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.ai-input-row .input {
  flex: 1;
  min-width: 0;
}
.ai-clear {
  margin-top: 6px;
}
.search-form {
  margin-bottom: 8px;
}
.search-opts {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
.search-opt {
  height: 24px;
  min-width: 30px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--card);
  color: var(--text-3);
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.search-opt.active {
  background: var(--brand-light);
  border-color: var(--brand);
  color: var(--brand);
}
.search-count {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-3);
}
.search-chapter {
  position: sticky;
  top: 0;
  background: var(--card);
  font-size: 12px;
  font-weight: 500;
  color: var(--text-2);
  padding: 6px 8px 4px;
  border-bottom: 1px solid var(--border);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
.set-num {
  width: 58px !important;
  flex: none !important;
  height: 26px;
  font-size: 12px;
  text-align: center;
  padding: 0 4px;
}
.set-row .input {
  flex: 1;
  height: 30px;
}
.font-hint {
  font-size: 12px;
  color: var(--text-3);
  width: auto !important;
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
  .tts-panel {
    right: 8px;
    left: 8px;
    width: auto;
  }
  .nav {
    display: none;
  }
}
</style>
