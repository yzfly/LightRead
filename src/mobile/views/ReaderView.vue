<script setup lang="ts">
import { engineDensity } from '../services/dianjingDensity.ts'
import AppSelect from '../../components/AppSelect.vue'
import AppModal from '../../components/AppModal.vue'
import BookCover from '../components/BookCover.vue'
import { pingUsage } from '../../services/usageStats.ts'
import { noteDjReading } from '../../services/usageCounters.ts'
import type { DjLevelIdx, DjState } from '../../services/usageStatsCore.ts'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getStorage, type AnnotationRec, type BookMeta } from '../../storage/index.ts'
import { useSettings } from '../../stores/settings.ts'
import { useLibrary } from '../../stores/library.ts'
import { isTextLike } from '../../services/format.ts'
import { convertToEpub, TEXT_EPUB_LAYOUT } from '../../services/textToEpub.ts'
import { tapZone } from '../../services/readerTapZone.ts'
import { getReaderCSS, resolveReaderColors, resolveReaderTheme, HIGHLIGHT_COLORS, listenMarkStyle, type ListenMarkStyle } from '../services/readerTheme.ts'
import { resolvedTheme } from '../services/appearance.ts'
import { setPageBarsDark, setSystemBarsHidden, setKeepScreenOn, setVolumeKeyHandler, setNativeSelectionMenu, type VolumeKey } from '../../services/systemBars.ts'
import { copyText } from '../../services/shareOut.ts'
import { injectFontIntoDoc, resolveFontFamily } from '../../services/fonts.ts'
import { isTauri } from '../../storage/types.ts'
import { listVoicesSorted, warmUpSpeech, resetEdgeFailure, systemSpeechAvailable } from '../services/tts.ts'
import { ListenPlayer, type ListenFeed } from '../../services/listenPlayer.ts'
import { SentenceCursor, loadListenBookmark, saveListenBookmark, agoBucket, type CursorPos, type ListenBookmark } from '../../services/readAloud.ts'
import { readingArea, followTarget, jumpLine, isOnScreen, followHeld, scrollMotion, prefersReducedMotion, type Area } from '../../services/readingFocus.ts'
import { EDGE_VOICES, edgeAvailable, playAudio } from '../../services/edgeTts.ts'
import CloudTtsConfig from '../../components/CloudTtsConfig.vue'
import { cloudSignature } from '../../services/cloudTts'
import { KOKORO_VOICES, DEFAULT_KOKORO_SID, kokoroVoiceLabel } from '../../services/kokoroVoices.ts'
import { localPack, localTtsSynthesize, refreshLocalPack, localTtsAvailable } from '../services/localTts.ts'
import LocalTtsPack from '../../components/LocalTtsPack.vue'
import TtsRateControl from '../components/TtsRateControl.vue'
import AmbientEntry from '../components/AmbientEntry.vue'
import { useReadingTimer } from '../../composables/useReadingTimer.ts'
import { usePortraitView } from '../../composables/usePortraitView.ts'
import { effectiveReaderLayout } from '../../services/portraitLayout.ts'
import { autoReadMotion, autoSpeedKey, stepAutoSpeed } from '../../services/autoReadSpeed.ts'
import { AutoScrollClock } from '../../services/autoScroll.ts'
import { rateText } from '../../services/ttsRate.ts'
import { toast } from '../../services/toast.ts'
import { t } from '../../i18n/index.ts'
import { siteUrlForRepoPath } from '../../services/siteLinks.ts'
import { matchesMQ, MQ } from '../../composables/useMediaQuery.ts'
import { searchBook, type SearchHit } from '../../services/bookSearch.ts'
import { chatStream, aiConfigured, readerSystemPrompt, explainPrompt, providerById, type AiMessage } from '../../services/ai.ts'
import TocList, { type TocItem } from '../../components/TocList.vue'
import ReadingModePanel from '../components/ReadingModePanel.vue'
import TypographyPanel, { type TypographySection } from '../components/TypographyPanel.vue'
import ReadingModeMini from '../../components/ReadingModeMini.vue'
import { useReadingModes } from '../composables/useReadingModes.ts'
import TranslateSheet from '../../components/TranslateSheet.vue'
import { isWholeParagraph, paragraphRange } from '../../services/selectParagraph.ts'
import { zhConvertController } from '../../services/zhConvert.ts'
import ListenCapsule from '../../components/ListenCapsule.vue'
import AmbientPanel from '../../components/AmbientPanel.vue'
import ReadingModeLayer from '../../components/ReadingModeLayer.vue'
import DianjingToggle from '../../components/DianjingToggle.vue'
import DianjingConsent from '../../components/DianjingConsent.vue'
import DianjingCard from '../../components/DianjingCard.vue'
import DianjingChapterCard from '../../components/DianjingChapterCard.vue'
import DianjingOutline from '../../components/DianjingOutline.vue'
import DianjingSkim from '../../components/DianjingSkim.vue'
import DianjingStatus from '../../components/DianjingStatus.vue'
import { useDianjing } from '../../composables/useDianjing.ts'
import { djThemeName } from '../../services/dianjing/theme.ts'
import { useAmbient } from '../../services/ambient/index.ts'
import type { ReadingModeProgress } from '../../services/readingModes/progress.ts'
import { buildSmartToc, findCurrentSmartItem, flattenToc } from '../../services/smartToc.ts'
import {
  sectionSizes, sectionPageCounts, fallbackBytesPerPage, pagePosition, pageToFraction, fractionToPage, parseJumpInput,
  type PageMeasure, type PagePosition,
} from '../../services/readerPages.ts'
import { countSpeechChars, recordPace, paceCps, humanizeDuration, finishClock, type SpeechPace } from '../../services/listenEta.ts'
import { sendSelectionToDevices } from '../../services/transfer/index.ts'
import { HIGHLIGHT_TEXT_MAX, hitsAnnotation } from '../../services/annotationContext.ts'
import { useNotesTools } from '../../composables/useNotesTools.ts'
import NotesExportDialog from '../../components/NotesExportDialog.vue'
import QuoteCardDialog from '../../components/QuoteCardDialog.vue'
import { pdfOpenView, setPdfViewChoice } from '../../services/pdfReflow/viewMode'
import { anchorForPage } from '../../services/pdfReflow/book'
import type { ReflowBook } from '../../services/pdfReflow/client'

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
/** 书本身无目录时由正文识别生成 (见 services/smartToc); 章节定位改按 CFI 判定 */
const tocAuto = ref(false)
let smartTocFlat: Array<{ label: string; href: string }> = []
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
  panel.value !== 'none' || settingsOpen.value || ttsPanel.value || modes.panelOpen.value || ambientPanel.value || !!activeAnnotation.value || jumpOpen.value || dj.overlayOpen.value

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

// ---- 面板开关: 同一时间只开一个浮层 (手机端它们都是底部抽屉, 叠在一起会互相遮挡) ----
type PanelName = 'toc' | 'annotations' | 'search' | 'ai'

function closeOverlays() {
  panel.value = 'none'
  settingsOpen.value = false
  ttsPanel.value = false
  ttsOptions.value = null
  listenToc.value = false
  modes.closePanel()
  dj.closeOverlays()
  ambientPanel.value = false
  activeAnnotation.value = null
  jumpOpen.value = false
  dismissSelection()
}

function togglePanel(name: PanelName) {
  const next = panel.value === name ? 'none' : name
  closeOverlays()
  panel.value = next
}

function toggleSettings() {
  const next = !settingsOpen.value
  closeOverlays()
  typoFocus.value = null
  settingsOpen.value = next
}

/** 从「模式」的场景详情跳到排版的对应分区 (docs/reader-panels.md §2) */
const typoFocus = ref<TypographySection | null>(null)
function openTypography(section?: TypographySection) {
  closeOverlays()
  typoFocus.value = section ?? null
  settingsOpen.value = true
}

/** 从排版提示条打开场景管理。 */
function openModes() {
  modes.openPanel()
}

/** 手机端抽屉打开时显示遮罩 (桌面端遮罩由 CSS 隐藏) */
const sheetOpen = computed(() => panel.value !== 'none' || settingsOpen.value || ttsPanel.value || modes.panelOpen.value || ambientPanel.value || dj.overlayOpen.value)

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
/** 书摘: 按章节分组、复制全部、导出、金句卡片 (composables/useNotesTools) */
const notes = reactive(useNotesTools({
  meta,
  annotations,
  getView: () => view,
  getSmartToc: () => (tocAuto.value ? smartTocFlat : []),
  lang: () => (settings.language === 'en' ? 'en' : 'zh'),
}))
const cardCover = ref<string>()
watch(() => notes.card, async c => {
  if (c && cardCover.value === undefined) cardCover.value = (meta.value?.hasCover && (await (await getStorage()).getCoverUrl(bookId))) || ''
})
watch(() => panel.value === 'annotations' && annoTab.value === 'highlight', open => { if (open) void notes.refresh() })

// 书签
const currentCfi = ref('')
const isBookmarked = computed(() => bookmarks.value.some(b => b.cfi === currentCfi.value))

// 听书
const ttsPanel = ref(false)
const ttsOptions = ref<'rate' | 'sleep' | 'voice' | null>(null)
const ttsFailure = ref(false)
const ttsEnded = ref(false)
const listenToc = ref(false)
const listenQuote = computed(() => currentListenKey.value ? listenTexts.get(currentListenKey.value) || '' : listenBookmark.value?.snippet || '')
const listenPosition = shallowRef<{ index: number; fraction: number } | null>(null)
const listenFraction = computed(() => ttsState.value !== 'stopped' && listenPosition.value ? listenPosition.value.fraction : fraction.value)
const listenPercent = computed(() => `${(listenFraction.value * 100).toFixed(1)}%`)
const listenChapter = computed(() => {
  void tocFractionsReady.value
  const pos = listenPosition.value
  return ttsState.value !== 'stopped' && pos ? chapterAtFraction(pos.fraction, pos.index) || chapterLabel.value : chapterLabel.value
})
const ttsStatus = computed(() => unavailableVoice.value || (ttsFailure.value ? t('tts.error') : ttsBuffering.value ? t('tts.buffering') : ttsState.value === 'playing' ? t('tts.reading') : ttsState.value === 'paused' ? t('tts.paused') : ttsEnded.value ? t('tts.bookFinished') : t('v2.listenReady')))
const unavailableVoice = computed(() => settings.ttsEngine === 'local' && !localTtsAvailable() ? t('tts.localUnsupported') : (settings.ttsEngine === 'system' || !edgeAvailable()) && !systemSpeechAvailable() ? t('tts.systemUnsupported') : '')
const voiceSummary = computed(() => {
  if (!edgeAvailable() || settings.ttsEngine === 'system') return settings.ttsVoice || t('tts.engineSystem')
  if (settings.ttsEngine === 'edge') return EDGE_VOICES.find(v => v.id === settings.edgeVoice)?.label.split(' · ')[0] || t('tts.engineEdge')
  if (settings.ttsEngine === 'cloud') return t('tts.engineCloud')
  const voice = KOKORO_VOICES.find(v => v.sid === settings.localVoiceId)
  return voice ? kokoroVoiceLabel(voice, settings.language === 'en' ? 'en' : 'zh').split(' · ')[0] : t('tts.engineLocal')
})
function openListenToc() { closeOverlays(); listenToc.value = true; panel.value = 'toc' }
function openListenLyrics() { ttsPanel.value = false; void modes.startLyric('tts') }

/** 背景音面板 (见 services/ambient); 背景音本身是全局单例, 只在阅读器里提供入口 */
const ambientPanel = ref(false)
const ambient = useAmbient()

function toggleAmbientPanel() {
  ambientPanel.value = !ambientPanel.value
}

async function showAmbientSources() {
  const { openDownload } = await import('../../services/updater.ts')
  openDownload(siteUrlForRepoPath('docs/ambient-sources.md'))
}
const ttsState = ref<'stopped' | 'playing' | 'paused'>('stopped')
const ttsVoices = ref<{ name: string; lang: string }[]>([])
let sectionLoadResolvers: Array<() => void> = []

// 翻页 / 位置变化 / 朗读推进时 ping: 正文在 iframe 里, 其中的操作不会冒泡到 window
const { ping: pingReading, pingAuto: pingReadingAuto } = useReadingTimer(bookId, {
  // 点睛阅读的使用统计 (按天汇总, 只记中文书): 这段时长按落库时的点睛状态计
  onCredit: seconds => {
    const st = djUsageState()
    if (st) noteDjReading(seconds, st.state, st.level)
  },
})

/** 当前的点睛状态 (使用统计): 关 / 词与词 / 重点词 / 智能; 非中文书返回 null */
function djUsageState(): { state: DjState; level: DjLevelIdx | null } | null {
  const m = lateModes.value
  const d = lateDj.value
  if (!m || !d || !m.keyWordsSupported.value) return null
  const kind = m.guideKind.value
  const density = settings.dianjing.density
  const lvl: DjLevelIdx = density === 'low' ? 0 : density === 'high' ? 2 : 1
  if (d.enabled.value) return { state: 3, level: kind === 'smart' ? lvl : null }
  if (kind === 'boundary') return { state: 1, level: null }
  if (kind === 'keywords') return { state: 2, level: lvl }
  return { state: 0, level: null }
}

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
  dismissSelection()
  panel.value = 'ai'
  showBars()
  sendAi(explainPrompt(text, settings.language))
}

/** 一键改用内置试用通道 (服务端中转, 免注册免密钥) */
function useTrialAi() {
  const trial = providerById('trial')
  settings.aiProvider = trial.id
  settings.aiBaseUrl = trial.baseUrl
  settings.aiModel = trial.defaultModel
}

async function openRegister() {
  const { openDownload } = await import('../../services/updater.ts')
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

// 自动阅读: 翻页模式每隔 N 秒翻一页; 滚动模式 (含竖屏单页滚动) 匀速平滑滚动, 约 N 秒滚过一屏。
// autoReading 表示开着 (含暂停中), autoPaused 为用户暂停 (轻点正文 / 迷你条)
const autoReading = ref(false)
const autoPaused = ref(false)
let autoTimer: ReturnType<typeof setInterval> | undefined

let view: any = null
let Overlayer: any = null
let saveTimer: ReturnType<typeof setTimeout> | undefined
/** 节流中待保存的最新进度 (cfi 字段是要写进 location 的位置: PDF 的电子书形态写原版页码) */
let pendingProgress: { cfi: string; frac: number } | null = null

// ---- PDF 的电子书形态 (重排, docs/plans/pdf-reflow.md) ----
const isPdf = computed(() => meta.value?.format === 'pdf')
/** 首次转换的进度 0-1; null 表示没在转换 */
const convertFraction = ref<number | null>(null)
let reflow: ReflowBook | null = null
let reflowAbort: AbortController | null = null
/** 当前读到的原版位置 (页码从 1 起, y 为页内比例) */
let pdfPos: { page: number; y: number } | null = null
const reflowLocKey = `lightread-pdf-reflow-loc:${bookId}`

/** 电子书里某处对应的原版页码与页内高度 (块上的 data-p / data-y) */
function pdfPosOfRange(range: Range | undefined): { page: number; y: number } | null {
  const node = range?.startContainer
  const el = (node && node.nodeType === 1 ? node : node?.parentElement) as Element | null | undefined
  let block = el?.closest?.('[data-p]') as HTMLElement | null | undefined
  if (!block && el) {
    // 落在块之间 (章节开头的空白): 取本章后面第一个块
    const all = el.ownerDocument?.querySelectorAll<HTMLElement>('[data-p]')
    block = all?.length ? Array.from(all).find(b => range!.comparePoint(b, 0) >= 0) ?? all[all.length - 1] : null
  }
  if (!block) return null
  const page = Number(block.dataset.p)
  if (!Number.isFinite(page)) return null
  return { page: page + 1, y: Number(block.dataset.y) || 0 }
}

function readReflowLoc(): { cfi: string; page: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(reflowLocKey) ?? 'null')
    return v && typeof v.cfi === 'string' && Number.isFinite(v.page) ? v : null
  } catch {
    return null
  }
}

/** 电子书形态的起点: 刚从原版切过来时对齐到那一段; 否则本机记的 CFI 与同步来的页码一致就用 CFI, 不一致按页码定位 */
function reflowStart(): { cfi?: string; href?: string } {
  const qPage = Number(route.query.pdfPage)
  const qY = Number(route.query.pdfY)
  const savedPage = parseInt(meta.value?.location ?? '', 10)
  if (!Number.isFinite(qPage)) {
    const local = readReflowLoc()
    if (local && (!Number.isFinite(savedPage) || local.page === savedPage)) return { cfi: local.cfi }
  }
  const page = Number.isFinite(qPage) ? qPage : Number.isFinite(savedPage) ? savedPage : 1
  const y = Number.isFinite(qY) ? qY : 0
  if (page <= 1 && y <= 0) return {}
  const href = reflow ? anchorForPage(reflow.pkg.anchors, page - 1, y) : undefined
  return href ? { href: `OEBPS/${href}` } : {}
}

/** 转换 / 读取重排包; 失败或没有文字时退回原版并记下, 返回 null */
async function openPdfEbook(blob: Blob): Promise<ReflowBook | null> {
  const { openReflowBook, ReflowEmptyError } = await import('../../services/pdfReflow/client')
  reflowAbort = new AbortController()
  try {
    reflow = await openReflowBook({
      bookId,
      file: blob,
      meta: { bookId, title: meta.value!.title, author: meta.value!.author, language: meta.value!.language },
      onProgress: p => { convertFraction.value = p.fraction },
      signal: reflowAbort.signal,
    })
    return reflow
  } catch (e: any) {
    if (e?.name === 'AbortError') return null
    console.warn('[pdf-reflow]', e)
    setPdfViewChoice(bookId, 'original')
    toast(e instanceof ReflowEmptyError ? t('reader.pdfNoText') : t('reader.pdfConvertFailed'))
    void router.replace(`/read-paper/${bookId}`)
    return null
  } finally {
    convertFraction.value = null
  }
}

/** 转换中: 先看原版 (记为原版, 下次也按原版打开) */
function viewOriginalNow() {
  reflowAbort?.abort()
  setPdfViewChoice(bookId, 'original')
  void router.replace(`/read-paper/${bookId}`)
}

/** 切换为原版 PDF: 落在当前段落所在的页与高度 */
async function switchToOriginal() {
  setPdfViewChoice(bookId, 'original')
  const pos = pdfPosOfRange(view?.lastLocation?.range) ?? pdfPos
  clearTimeout(saveTimer)
  saveTimer = undefined
  pendingProgress = null
  if (pos) await library.saveProgress(bookId, String(pos.page), fraction.value)
  void router.replace({ path: `/read-paper/${bookId}`, query: pos ? { pdfY: pos.y.toFixed(3) } : {} })
}

const appDark = computed(() => resolvedTheme.value === 'dark')
// 自动预设先与手动偏好合并; 页码、手势等统一读取生效版式。
const portraitView = usePortraitView()
// 阅读模式与点睛在下方声明, 二者初始化时会互相 / 回头读取这里的值;
// 先用响应式占位, 声明完再填入, 避免初始化顺序问题 (TDZ), 填入后依赖它们的 computed 自动重算
const lateModes = shallowRef<ReturnType<typeof useReadingModes>>()
const lateDj = shallowRef<ReturnType<typeof useDianjing>>()
// 生效版式的唯一出口: 用户保存的翻页 / 分栏 + 临时约束 (竖屏锁定、歌词要滚动、大字 / 歌词要单栏), 约束不回写设置
const readerLayout = computed(() => effectiveReaderLayout({
  flow: settings.readerPrefs.flow,
  maxColumnCount: settings.readerPrefs.maxColumnCount,
  portraitScroll: false, // 自动预设已逐项应用, 不再强制覆盖手动版式
  portrait: portraitView.value,
  forceSingleColumn: lateModes.value?.forceSingleColumn.value,
  forceScrolled: lateModes.value?.forceScrolled.value,
}))
const effectiveFlow = computed(() => readerLayout.value.flow)
// 墨水屏等阅读模式会改写正文配色 (纯黑白)
const themeColors = computed(() => resolveReaderColors(settings.readerPrefs.theme, appDark.value, lateModes.value?.readerStyle.value))
// 正文主题铺满全屏 (含状态栏下方), 安卓系统栏图标按正文深浅切换
watch(
  () => ttsPanel.value ? appDark.value : resolveReaderTheme(settings.readerPrefs.theme, appDark.value) === 'dark',
  dark => setPageBarsDark(dark),
  { immediate: true },
)

/**
 * 书页所在的 iframe 与宿主的 color-scheme 不一致时 (应用浅色 + 正文夜间, 或反过来), 浏览器会给 iframe
 * 垫一层不透明底 (深色为纯黑), 盖住正文主题的底色, 与上下安全区的颜色接不上。让 foliate-view 的
 * color-scheme 跟随正文主题 (该属性可继承, 能进到渲染器的 shadow DOM), iframe 才保持透明。
 */
function syncViewColorScheme() {
  if (view) view.style.colorScheme = resolveReaderTheme(settings.readerPrefs.theme, appDark.value) === 'dark' ? 'dark' : 'light'
}
watch(() => resolveReaderTheme(settings.readerPrefs.theme, appDark.value), syncViewColorScheme)

/** 当前选中的自定义字体 (settings.readerPrefs.fontFamily 为 custom:Name 时) */
function selectedCustomFont() {
  const m = settings.readerPrefs.fontFamily.match(/^custom:(.+)$/)
  return m ? settings.customFonts.find(f => f.name === m[1]) : undefined
}

/**
 * 排版几何。自动边距按窗口换算, 手动边距使用原值; 不回写保存设置。
 */
function layoutGeometry() {
  const prefs = settings.readerPrefs
  const portrait = portraitView.value
  const phone = matchesMQ(MQ.phone)
  // 上下边带: 翻页模式放页眉页脚 (章节名 / 进度), 手机屏幕矮收窄些; 滚动模式下正文铺满全高,
  // 它只决定「哪段算在屏上」(进度 / 朗读起点), 竖屏滚动收窄让判定贴近实际可见区
  const margin = portrait && readerLayout.value.flow === 'scrolled'
    ? (phone ? '12px' : '20px')
    : `${settings.screenPreset.pageMargin}px`
  return {
    gap: `${prefs.gap}%`,
    maxInline: `${settings.screenPreset.maxInlineSize}px`,
    margin,
  }
}
let appliedGeometry = ''
/** 竖排书 (vertical-rl 等) 暂不启用跨章连续滚动; 首个分节加载后才知道 */
let bookVertical = false
/** 渲染器处于跨章连续滚动 (多槽) 模式: 同时活着多个分节文档, getContents() 主章 (阅读线所在) 排第一 */
const isContinuous = () => !!view?.renderer?.continuous

/**
 * 渲染器的版式属性只在值变了时写: 自定义元素对同值 setAttribute 也会回调 render(),
 * 连续滚动时会同步重排所有已载入的章节 (改主题、调暗这类与版式无关的设置也会让正文抖一下)
 */
function setRendererAttr(r: any, name: string, value: string) {
  if (r.getAttribute(name) !== value) r.setAttribute(name, value)
}

function applyPrefs() {
  if (!view) return
  const prefs = settings.readerPrefs
  try {
    // 墨水屏: 去掉翻页动画 (残影)
    if (modes.einkActive.value) view.renderer.removeAttribute('animated')
    else view.renderer.setAttribute('animated', '')
    const layout = readerLayout.value
    // 跨章连续滚动 (docs/continuous-scroll.md §11): 滚动模式、非固定版式、非竖排时开启; 先于 flow 设置,
    // 切到滚动时渲染器直接进多槽模式。旧版 paginator 不认这个属性, 照常单章滚动
    const r = view.renderer
    const wantContinuous = layout.flow === 'scrolled' && prefs.continuousScroll && !view.isFixedLayout && !bookVertical
    if (r.hasAttribute('continuous') !== wantContinuous) r.toggleAttribute('continuous', wantContinuous)
    setRendererAttr(r, 'flow', layout.flow)
    const geo = layoutGeometry()
    appliedGeometry = JSON.stringify(geo)
    setRendererAttr(r, 'gap', geo.gap)
    setRendererAttr(r, 'max-inline-size', geo.maxInline)
    // 大字 / 歌词运行时、竖屏单页滚动时强制单栏 (已算进 readerLayout), 不改用户自己的分栏设置
    setRendererAttr(r, 'max-column-count', String(layout.maxColumnCount === 'auto' ? 2 : layout.maxColumnCount))
    setRendererAttr(r, 'column-count', String(layout.maxColumnCount))
    setRendererAttr(r, 'margin', geo.margin)
    // 歌词运行时的字号 / 行距只是生效值 (modes.typographyOverride), 不写回设置
    view.renderer.setStyles?.(getReaderCSS({ ...prefs, ...modes.typographyOverride.value, fontFamily: resolveFontFamily(prefs.fontFamily) }, appDark.value, modes.readerStyle.value))
    const custom = selectedCustomFont()
    if (custom) {
      for (const content of view.renderer.getContents?.() ?? []) {
        injectFontIntoDoc(content.doc, custom)
      }
    }
  } catch { /* 章节切换瞬间 iframe 文档可能已卸载, 下次 relocate 会重新应用 */ }
}

let prefsTimer: ReturnType<typeof setTimeout> | undefined
watch([() => settings.readerPrefs, appDark, readerLayout, portraitView], () => {
  clearTimeout(prefsTimer)
  prefsTimer = setTimeout(applyPrefs, 120)
}, { deep: true })
// 拖动窗口 / 分屏改变宽度: 竖屏留白按像素算, 跨过手机宽度时边带也变; 几何没变就不重排
let geometryTimer: ReturnType<typeof setTimeout> | undefined
function onWindowResize() {
  clearTimeout(geometryTimer)
  geometryTimer = setTimeout(() => {
    if (view && JSON.stringify(layoutGeometry()) !== appliedGeometry) applyPrefs()
  }, 200)
}
window.addEventListener('resize', onWindowResize)
onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowResize)
  clearTimeout(geometryTimer)
})

function onRelocate(e: CustomEvent) {
  // 翻页 / 滚动后工具条的位置已经不对: 划线菜单收起, 选区工具条跟着选区重新定位
  hlMenu.value = null
  if (selection.value) placeSelTools(selectionRange)
  modes.onRelocate(e.detail)
  dj.onRelocate(e.detail)
  // 朗读跟随翻页 / 打字机、歌词自动推进都不能无限续命计时
  if (ttsState.value === 'playing' || modes.progressActive.value) pingReadingAuto()
  else pingReading()
  const { cfi, fraction: frac, tocItem } = e.detail
  fraction.value = frac ?? 0
  chapterLabel.value = tocItem?.label?.trim() ?? ''
  currentTocHref.value = tocItem?.href
  currentCfi.value = cfi ?? ''
  if (tocAuto.value) syncSmartTocPosition()
  updatePages(e.detail)
  updateMarginals()
  // PDF 的电子书形态: location 存原版页码 (原版阅读页与其它设备都认), 精确的 CFI 记在本机
  let loc = cfi
  if (isPdf.value && cfi) {
    pdfPos = pdfPosOfRange(e.detail.range) ?? pdfPos
    loc = pdfPos ? String(pdfPos.page) : ''
    if (pdfPos) {
      try { localStorage.setItem(reflowLocKey, JSON.stringify({ cfi, page: pdfPos.page })) } catch { /* 忽略 */ }
    }
  }
  // 节流而非防抖: 连续 / 自动滚动时 relocate 每 250ms 一次, 防抖会一直等到停下才保存
  if (loc) pendingProgress = { cfi: loc, frac: frac ?? 0 }
  if (!saveTimer) {
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      const p = pendingProgress
      pendingProgress = null
      if (p) library.saveProgress(bookId, p.cfi, p.frac)
    }, 600)
  }
}

/**
 * 翻页模式的页眉页脚: 淡色显示章节名与阅读进度, 工具栏收起时也知道读到哪。
 * foliate 每次重排都会重建这些节点, 所以随 relocate 一起刷新。
 */
function updateMarginals() {
  const r = view?.renderer
  if (!r?.heads?.length || !r?.feet?.length) return
  // 沉浸等模式可要求页眉 / 页脚留白
  const policy = modes.marginalsPolicy.value
  r.heads.forEach((el: HTMLElement, i: number) => {
    el.textContent = i === 0 && policy.head ? (chapterLabel.value || meta.value?.title || '') : ''
  })
  // 左下: 本章剩余; 右下: 页码 / 百分比。双栏时分居左右两栏, 单栏时同一行两端对齐
  const feet: HTMLElement[] = r.feet
  // 打字机 / 歌词运行时, 页脚留白给阅读模式的状态条用
  const guiding = modes.progressActive.value
  const left = policy.footLeft && !guiding ? chapterLeftText.value : ''
  const right = policy.footRight && !guiding ? progressText.value : ''
  feet.forEach(el => {
    el.replaceChildren()
    el.style.display = 'flex'
    el.style.gap = '1em'
  })
  const put = (el: HTMLElement, text: string, end: boolean) => {
    const span = document.createElement('span')
    span.textContent = text
    span.style.cssText = end ? 'margin-inline-start:auto;flex-shrink:0' : 'min-width:0;overflow:hidden;text-overflow:ellipsis'
    el.append(span)
  }
  if (left) put(feet[0], left, false)
  if (right) put(feet[feet.length - 1], right, true)
}

// ---- 页码 ----
// 重排书的页数随排版变化: 读到的章记实测页数, 其余按密度推算 (见 services/readerPages)。
// 同一排版下的实测按书存本地, 下次打开总页数直接稳定。
const pageInfo = ref<PagePosition | null>(null)
/** 固定版式 (漫画 / 版式 EPUB): 页数固定, 不需要「随排版变化」的提示 */
const fixedLayout = ref(false)
/** EPUB 自带纸书页码 (page-list) 时的当前页标签 */
const printPage = ref('')
/** 本章 (按目录) 剩余页; null 为未知 */
const chapterLeft = ref<number | null>(null)
let secSizes: number[] = []
let secCounts: number[] = []
let pagesPerScreen = 1
let pageMeasure: PageMeasure = { key: '', pages: {} }
let pageSaveTimer: ReturnType<typeof setTimeout> | undefined
const PAGE_MEASURE_KEY = `lightread-pages:${bookId}`
/** 目录项落点, 用于算「本章剩几页」(TXT 等一个分节会装多章, 不能按分节算) */
let tocAnchors: Array<{ index: number; label: string; anchor?: (doc: Document) => Element | Range | null }> = []
let tocFractions: Array<{ fraction: number; label: string }> = []
/** tocFractions 是普通数组, 用它通知依赖方重算 */
const tocFractionsReady = ref(0)
let tocFractionTimer: ReturnType<typeof setTimeout> | undefined

const showPage = computed(() => !!pageInfo.value && settings.readerPrefs.progressDisplay !== 'percent')
const showPercent = computed(() => !pageInfo.value || settings.readerPrefs.progressDisplay !== 'page')
const percentText = computed(() => `${(fraction.value * 100).toFixed(1)}%`)
const pageRangeText = computed(() => {
  const p = pageInfo.value
  if (!p) return ''
  return p.last > p.current ? `${p.current}–${p.last}` : String(p.current)
})
/** 页脚右侧 / 底栏的进度文案 */
const progressText = computed(() => {
  const parts: string[] = []
  if (showPage.value) parts.push(`${pageRangeText.value} / ${pageInfo.value!.total}`)
  if (showPercent.value) parts.push(percentText.value)
  return parts.join(' · ')
})
const chapterLeftText = computed(() => {
  if (!showPage.value || chapterLeft.value == null) return ''
  return chapterLeft.value > 0 ? t('reader.chapterPagesLeft', { n: chapterLeft.value }) : t('reader.chapterLastPage')
})
watch(() => settings.readerPrefs.progressDisplay, () => updateMarginals())

function loadPageMeasure() {
  try {
    const saved = JSON.parse(localStorage.getItem(PAGE_MEASURE_KEY) || 'null')
    if (saved && typeof saved.key === 'string' && saved.pages && typeof saved.pages === 'object') pageMeasure = saved
  } catch { /* 存储不可用: 本次现测 */ }
}

function savePageMeasure() {
  clearTimeout(pageSaveTimer)
  pageSaveTimer = setTimeout(() => {
    try { localStorage.setItem(PAGE_MEASURE_KEY, JSON.stringify(pageMeasure)) } catch { /* 忽略 */ }
  }, 1500)
}

/** 排版指纹: 影响分页的设置与版面尺寸; 取整到 8px, 避免亚像素抖动让测量反复作废 */
function layoutSignature(per: number, scrolled: boolean) {
  const p = settings.readerPrefs
  const rect = container.value?.getBoundingClientRect()
  const q = (n = 0) => Math.round(n / 8)
  return [p.fontSize, p.lineHeight, p.gap, p.fontFamily, p.justify ? 1 : 0, scrolled ? 's' : 'p', per, q(rect?.width), q(rect?.height)].join('|')
}

async function buildTocAnchors() {
  const v = view
  const items = tocAuto.value ? smartTocFlat : flattenToc(toc.value)
  const out: typeof tocAnchors = []
  for (const item of items) {
    if (!item.href) continue
    try {
      const resolved = await v.resolveNavigation(item.href)
      if (typeof resolved?.index === 'number') {
        out.push({
          index: resolved.index,
          label: item.label?.trim() ?? '',
          anchor: typeof resolved.anchor === 'function' ? resolved.anchor : undefined,
        })
      }
    } catch { /* 解析不了的目录项跳过 */ }
  }
  if (v !== view) return
  // 按分节排序 (稳定排序保留同一分节内的目录顺序)
  tocAnchors = out.sort((a, b) => a.index - b.index)
  tocFractions = []
  tocFractionsReady.value = 0
  clearTimeout(tocFractionTimer)
  tocFractionTimer = setTimeout(() => void buildTocFractions(v), 1200)
}

/**
 * 每个目录项在全书中的进度位置, 供拖动进度条时显示「将跳到哪一章」。
 * TXT 等一个分节装多章, 不能按分节取章名, 需要在分节文档里按字数定位标题。
 * 打开书后空闲时算一次; 算不出 (格式不支持单独解析分节) 时退回按分节取章名。
 */
async function buildTocFractions(v: any) {
  const sizeTotal = secSizes.reduce((a, b) => a + b, 0)
  if (!sizeTotal || !tocAnchors.length) return
  const docs = new Map<number, { doc: Document; length: number } | null>()
  const out: typeof tocFractions = []
  for (const a of tocAnchors) {
    if (v !== view) return
    if (!secSizes[a.index]) continue
    let ratio = 0
    if (a.anchor) {
      if (!docs.has(a.index)) {
        try {
          const doc: Document = await v.book.sections[a.index].createDocument()
          docs.set(a.index, { doc, length: doc.body?.textContent?.length ?? 0 })
        } catch { docs.set(a.index, null) }
      }
      const entry = docs.get(a.index)
      if (entry?.length) {
        try {
          const target = a.anchor(entry.doc)
          if (target) {
            const r = entry.doc.createRange()
            r.setStart(entry.doc.body, 0)
            if (isRange(target)) r.setEnd(target.startContainer, target.startOffset)
            else r.setEndBefore(target)
            ratio = Math.min(1, r.toString().length / entry.length)
          }
        } catch { /* 定位失败按分节开头算 */ }
      }
    }
    const before = secSizes.slice(0, a.index).reduce((x, y) => x + y, 0)
    out.push({ fraction: (before + ratio * secSizes[a.index]) / sizeTotal, label: a.label })
  }
  if (v === view) {
    tocFractions = out.sort((x, y) => x.fraction - y.fraction)
    tocFractionsReady.value++
  }
}

/** 全书进度所在章名 */
function chapterAtFraction(value: number, index: number): string {
  if (tocFractions.length) {
    let label = ''
    for (const item of tocFractions) {
      if (item.fraction <= value + 1e-6) label = item.label
      else break
    }
    return label
  }
  try { return view?.getProgressOf?.(index)?.tocItem?.label?.trim() ?? '' } catch { return '' }
}

function updatePages(detail: any) {
  const r = view?.renderer
  const index: number | undefined = detail?.section?.current
  printPage.value = detail?.pageItem?.label?.trim?.() ?? ''
  if (!r || typeof index !== 'number') return
  // 固定版式 (漫画 / 版式 EPUB): 一个分节就是一页
  fixedLayout.value = !!view.isFixedLayout
  if (view.isFixedLayout) {
    const total = view.book?.sections?.length || 1
    pageInfo.value = { current: index + 1, last: index + 1, total, sectionLeft: total - index - 1 }
    chapterLeft.value = null
    return
  }
  if (!secSizes.length) return
  const scrolled = !!r.scrolled
  const per = scrolled ? 1 : Math.max(1, Number(r.columnCount) || 1)
  const size = Number(r.size) || 0
  let screens = 0
  let screen = 1
  if (scrolled) {
    screens = size > 0 ? Math.max(1, Math.ceil(r.viewSize / size - 0.01)) : 0
    screen = size > 0 ? Math.min(screens, Math.max(1, Math.ceil((r.start + size) / size - 0.01))) : 1
  } else {
    screens = Math.max(0, Number(r.pages) - 2)
    screen = Math.min(screens, Math.max(1, Number(r.page) || 1))
  }
  if (!screens) return
  const key = layoutSignature(per, scrolled)
  if (pageMeasure.key !== key) pageMeasure = { key, pages: {} }
  if (secSizes[index] && pageMeasure.pages[index] !== screens * per) {
    pageMeasure.pages[index] = screens * per
    savePageMeasure()
  }
  const rect = container.value?.getBoundingClientRect()
  const fallback = fallbackBytesPerPage({
    width: (rect?.width ?? 360) / per * 0.85,
    height: (rect?.height ?? 640) - 96,
    fontSize: settings.readerPrefs.fontSize,
    lineHeight: settings.readerPrefs.lineHeight,
    cjk: !!view.language?.isCJK,
  })
  secCounts = sectionPageCounts(secSizes, pageMeasure.pages, fallback)
  pagesPerScreen = per
  const pos = pagePosition(secCounts, index, (screen - 1) * per + 1, per)
  pageInfo.value = pos
  calibrateCharsPerPage(index)
  chapterLeft.value = computeChapterLeft(index, pos, detail?.range, per, scrolled, size)
}

/**
 * 本章还剩几页: 当前分节里位于可见区之后的下一个目录项决定本章终点;
 * 本分节没有后续目录项时, 本章延续到下一个有目录项的分节之前。
 */
function computeChapterLeft(index: number, pos: PagePosition, range: Range | undefined, per: number, scrolled: boolean, size: number): number | null {
  if (!tocAnchors.length || !secCounts[index]) return null
  const before = secCounts.slice(0, index).reduce((a, b) => a + b, 0)
  const localLast = pos.last - before
  const r = view.renderer
  const doc: Document | undefined = r.getContents?.()?.find((c: any) => c.index === index)?.doc
  // 横排从左到右才能由坐标直接换算页; 竖排 / 从右到左只按分节估算
  const plain = scrolled || (r.getAttribute?.('dir') !== 'rtl' && !doc?.defaultView?.getComputedStyle(doc.body).writingMode?.startsWith('vertical'))
  if (doc && range && plain && size > 0) {
    const start = range.cloneRange()
    start.collapse(true)
    const colSize = scrolled ? size : size / per
    const lineBox = settings.readerPrefs.fontSize * settings.readerPrefs.lineHeight * 1.5
    for (const a of tocAnchors) {
      if (a.index !== index || !a.anchor) continue
      let target: Element | Range | null = null
      try { target = a.anchor(doc) } catch { continue }
      if (!target) continue
      const node = isRange(target) ? target.startContainer : target
      const offset = isRange(target) ? target.startOffset : 0
      try { if (start.comparePoint(node, offset) <= 0) continue } catch { continue }
      const box = target.getBoundingClientRect()
      const at = scrolled ? box.top : box.left
      let page = Math.floor(at / colSize) + 1
      // 章标题正好在页首: 本章到上一页结束
      const topInPage = scrolled ? box.top - (page - 1) * colSize : box.top
      if (topInPage < lineBox && page > 1) page--
      return Math.max(0, page - localLast)
    }
  }
  let left = pos.sectionLeft
  const next = tocAnchors.find(a => a.index > index)
  const end = next ? next.index : secCounts.length
  for (let i = index + 1; i < end; i++) left += secCounts[i]
  return left
}

/** 智能目录不经 foliate 的 TOC 进度, 按当前 CFI 自行判定所在章节 */
function syncSmartTocPosition() {
  const item = findCurrentSmartItem(smartTocFlat, currentCfi.value)
  chapterLabel.value = item?.label ?? ''
  currentTocHref.value = item?.href
}

/** 书没有目录 (或只有一项) 时, 扫描正文识别章节; 失败静默, 不影响阅读 */
async function applySmartToc() {
  const v = view
  try {
    const { items, flat } = await buildSmartToc(v)
    if (v !== view || !items.length) return
    smartTocFlat = flat
    toc.value = items
    tocAuto.value = true
    syncSmartTocPosition()
    void buildTocAnchors()
  } catch (e) {
    console.warn('smart toc failed', e)
  }
}

/**
 * 手动翻页 / 跳转与听书的协调: 朗读不中断 (连续播放的体验最重要), 只是不再把视图拉回朗读位置;
 * 胶囊和面板上给出「回到朗读位置」「从这页开始听」两个去处。
 */
function interruptTTSForReposition() {
  if (ttsState.value === 'stopped') return
  listenDetached.value = true
}

function turnPage(dir: 'left' | 'right') {
  interruptTTSForReposition()
  hideBars()
  dir === 'left' ? view?.goLeft() : view?.goRight()
}

/** 音量键翻页: 上 = 上一页, 下 = 下一页 (按阅读顺序, 不随从右往左排版颠倒) */
function turnPageByVolume(key: VolumeKey) {
  interruptTTSForReposition()
  hideBars()
  void (key === 'prev' ? view?.prev() : view?.next())
}

function handleKeydown(e: KeyboardEvent) {
  // 在输入框里打字 (跳页 / 搜索 / AI) 时, 方向键和空格属于输入框
  const el = e.target as HTMLElement | null
  if (e.key !== 'Escape' && el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return
  // Open panels own keyboard input; arrows/space must not turn the book behind a dialog.
  if (anyOverlayOpen()) {
    if (e.key === 'Escape') { e.preventDefault(); closeOverlays() }
    return
  }
  if (e.key === ' ' && el?.closest('button, [role="button"], [role="tab"], [role="switch"]')) return
  // 阅读模式快捷键 (M 面板 / Shift+T 打字机; 打字机运行中空格暂停等)
  if (modes.handleKey(e)) return
  if (dj.handleKey(e)) return
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') turnPage('left')
  else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') turnPage('right')
  else if (e.key === 'Escape') {
    if (isFullscreen.value && isTauri()) toggleFullscreen()
    panel.value = 'none'
    settingsOpen.value = false
    jumpOpen.value = false
    stopAutoRead()
  }
}

/** 自动阅读怎么推进: 翻页 / 匀速滚动 / 墨水屏整屏推进 (面板说明同一个判断) */
const autoMotion = computed(() => autoReadMotion(effectiveFlow.value, { eink: !!lateModes.value?.einkActive.value, fixedLayout: fixedLayout.value }))

function startAutoRead() {
  modes.stopForExternal('auto')
  // 带读同一时间只运行一个: 自动翻页开始时暂停听书 (听书会自己跟着翻页, 两者抢位置)
  if (ttsState.value === 'playing') {
    pauseTTS()
    toast(t('readingMode.ttsPaused'))
  }
  stopAutoRead()
  autoReading.value = true
  autoPaused.value = false
  runAutoEngine()
  // 开始后收起工具栏, 把屏幕留给正文 (轻点正文暂停时再呼出)
  hideBars()
}

/** 按当前生效的翻页 / 滚动方式开动 (暂停后继续、切换方式时也走这里) */
function runAutoEngine() {
  clearInterval(autoTimer)
  cancelAnimationFrame(autoRaf)
  view?.renderer?.driftEnd?.()
  autoPos = -1
  autoCarry = 0
  if (!autoReading.value || autoPaused.value) return
  if (autoMotion.value === 'scroll') {
    autoClock.reset()
    autoRaf = requestAnimationFrame(autoScrollFrame)
    return
  }
  autoTimer = setInterval(() => {
    if (autoHeld()) return
    if (fraction.value >= 0.999) {
      stopAutoRead()
      return
    }
    turnPage('right')
  }, settings.autoReadSeconds * 1000)
}

function stopAutoRead() {
  autoReading.value = false
  autoPaused.value = false
  clearInterval(autoTimer)
  cancelAnimationFrame(autoRaf)
  view?.renderer?.driftEnd?.()
}

function pauseAutoRead() {
  if (!autoReading.value) return
  autoPaused.value = true
  runAutoEngine()
}

function resumeAutoRead() {
  if (!autoReading.value) return
  autoPaused.value = false
  runAutoEngine()
}

/** 快一档 (dir = 1) / 慢一档 (dir = -1): 很慢 … 很快 五档, 见 services/autoReadSpeed */
function adjustAutoSpeed(dir: 1 | -1) {
  settings.autoReadSeconds = stepAutoSpeed(settings.autoReadSeconds, dir)
}

// ---- 滚动模式的匀速滚动 ----
let autoRaf = 0
const autoClock = new AutoScrollClock()
/** 浮点滚动位置 (scrollTop 会被取整, 慢速时每帧不足 1px, 需自己累计) */
let autoPos = -1
/** 手指按住 / 滚轮拨动正文后暂缓到这个时间, 松手后接着滚 */
let autoHoldUntil = 0
/** 上次让 foliate 报告位置 (relocate) 的时间: 连续滚动时它的 scroll 防抖永远等不到停顿 */
let autoReportTs = 0
let autoCrossing = false

/** 面板 / 抽屉打开、手指按住正文时暂缓 (不算暂停, 收起后自动继续) */
function autoHeld() {
  return document.hidden || Date.now() < autoHoldUntil || panel.value !== 'none' || settingsOpen.value || ttsPanel.value
    || jumpOpen.value || ambientPanel.value || !!activeAnnotation.value || !!selection.value
}

function holdAutoScroll(ms: number) {
  autoHoldUntil = Math.max(autoHoldUntil, Date.now() + ms)
  autoPos = -1
  autoCarry = 0
}

/** 跨章连续滚动时尚未推进的零头像素 (scrollBy 按整像素走, 慢速时每帧不足 1px) */
let autoCarry = 0

function autoScrollFrame(ts: number) {
  if (!autoReading.value || autoPaused.value) return
  autoRaf = requestAnimationFrame(autoScrollFrame)
  const r = view?.renderer
  if (!r || loading.value || autoCrossing || !r.scrolled || autoHeld()) {
    autoClock.reset()
    if (autoHeld()) {
      autoPos = -1
      autoCarry = 0
      r?.driftEnd?.()
    }
    return
  }
  const size = Number(r.size) || 0
  const viewSize = Number(r.viewSize) || 0
  if (!size) return
  const px = autoClock.step(ts, size / Math.max(3, settings.autoReadSeconds))
  if (!px) return
  // 跨章连续滚动: 在连续容器上按帧匀速推进, 章与章之间不停顿; 进度由渲染器滚动中节流派发的 relocate 更新
  if (r.continuous) {
    if (r.atEnd) {
      stopAutoRead()
      return
    }
    // driftBy 按亚像素推进 (scrollTop 只认整像素, 慢速时逐帧 1/0/1 地走, 文字一顿一顿地跳)
    if (!r.driftBy?.(px)) {
      autoCarry += px
      const step = Math.floor(autoCarry)
      if (step >= 1) {
        autoCarry -= step
        r.scrollBy(0, step)
      }
    }
    pingReadingAuto()
    return
  }
  // 本节滚到底: 进入下一节 (foliate 的 next 在节尾切到下一节顶部); 全书读完则停
  if (viewSize - (r.start + size) <= 2) {
    if (fraction.value >= 0.999 || r.atEnd) {
      stopAutoRead()
      return
    }
    autoCrossing = true
    autoPos = -1
    r.driftEnd?.()
    Promise.resolve(r.next()).finally(() => {
      autoCrossing = false
      autoClock.reset()
    })
    return
  }
  // 单章滚动: 同样亚像素推进, 渲染器滚动中节流报告位置; 旧渲染器走下面的整像素路径
  if (r.driftBy?.(px)) {
    pingReadingAuto()
    return
  }
  const cur = Number(r.containerPosition) || 0
  // 用户手动滚过 (位置与自己累计的差太多) 就从当前位置接着走
  if (autoPos < 0 || Math.abs(autoPos - cur) > 4) autoPos = cur
  autoPos += px
  const delta = autoPos - cur
  // delta 必须为正: foliate 的 next(0) 会当成「翻一整屏」
  if (ts - autoReportTs > 1000 && delta >= 1) {
    // 每秒让 foliate 正常走一次「滚动到 + 报告位置」(关掉动画即刻完成), 进度、页码、自动保存照常更新
    autoReportTs = ts
    const animated = r.hasAttribute('animated')
    if (animated) r.removeAttribute('animated')
    void r.next(delta)
    if (animated) r.setAttribute('animated', '')
  } else {
    r.containerPosition = autoPos
  }
  pingReadingAuto()
}

watch(() => settings.autoReadSeconds, () => {
  if (autoReading.value && !autoPaused.value && autoMotion.value !== 'scroll') runAutoEngine()
})
// 旋转屏幕、歌词临时滚动、开关墨水屏等导致推进方式改变: 换对应的引擎
watch(autoMotion, () => {
  if (autoReading.value) runAutoEngine()
})

// ---- 听书 ----

// ---- 听书胶囊: 默认停在页眉留白处 (不挡正文), 可拖到任意位置并记住 ----
const MINI_POS_KEY = 'lightread-tts-mini-pos'
/** 胶囊中心点占阅读区宽高的比例; null 为默认停靠位置 */
const miniPos = ref<{ x: number; y: number } | null>(null)
try {
  const saved = JSON.parse(localStorage.getItem(MINI_POS_KEY) || 'null')
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) miniPos.value = saved
} catch { /* 用默认位置 */ }
const miniEl = ref<InstanceType<typeof ListenCapsule>>()
const miniRoot = () => miniEl.value?.el
let miniDrag: { id: number; sx: number; sy: number; moved: boolean; dx: number; dy: number } | null = null
const miniStyle = computed(() => miniPos.value
  ? { left: `${miniPos.value.x * 100}%`, top: `${miniPos.value.y * 100}%` }
  : undefined)

/** 浮动胶囊: 沉浸阅读时停在页眉留白; 用户拖过则一直停在那里 */
const ttsMiniFloating = computed(() => !ttsPanel.value && ttsState.value !== 'stopped' && (!barsVisible.value || !!miniPos.value))
/** 工具栏显示且胶囊未被拖走时, 改为嵌在顶栏中间 */
const ttsChipInBar = computed(() => ttsState.value !== 'stopped' && barsVisible.value && !miniPos.value)

function onMiniDown(e: PointerEvent) {
  const root = miniRoot()
  if (e.button !== 0 || !root) return
  const r = root.getBoundingClientRect()
  miniDrag = {
    id: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false,
    dx: e.clientX - (r.left + r.width / 2), dy: e.clientY - (r.top + r.height / 2),
  }
  root.setPointerCapture?.(e.pointerId)
}

function onMiniMove(e: PointerEvent) {
  const d = miniDrag
  const el = miniRoot()
  const host = el?.offsetParent as HTMLElement | null
  if (!d || !el || !host || e.pointerId !== d.id) return
  if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 6) return
  d.moved = true
  const h = host.getBoundingClientRect()
  const halfW = el.offsetWidth / 2 + 6
  const halfH = el.offsetHeight / 2 + 6
  const cx = Math.min(h.width - halfW, Math.max(halfW, e.clientX - d.dx - h.left))
  const cy = Math.min(h.height - halfH, Math.max(halfH, e.clientY - d.dy - h.top))
  miniPos.value = { x: cx / h.width, y: cy / h.height }
}

function onMiniUp(e: PointerEvent) {
  const d = miniDrag
  if (!d || e.pointerId !== d.id) return
  miniDrag = null
  if (!d.moved) {
    ttsPanel.value = true
    return
  }
  try { localStorage.setItem(MINI_POS_KEY, JSON.stringify(miniPos.value)) } catch { /* 忽略 */ }
}

/** 双击胶囊回到默认停靠位置 */
function resetMiniPos() {
  miniPos.value = null
  try { localStorage.removeItem(MINI_POS_KEY) } catch { /* 忽略 */ }
}

// ---- 听书进度与剩余时间 (见 services/listenEta) ----
/** 每页字数 (只数文字), 由当前分节正文字数 / 页数得出; 0 为未知 */
const charsPerPage = ref(0)
const sectionChars = new Map<number, number>()
const bookCjk = ref(true)
/** 按引擎分别记语速: 在线 / 离线 / 系统语音快慢差别很大 */
const paceKey = () => `lightread-tts-pace:${settings.ttsEngine}`
const pace = ref<SpeechPace>({ cps: 0, samples: 0 })
let pausedAt = 0
let pausedTotal = 0
/** 每分钟刷新一次「几点听完」 */
const nowTick = ref(Date.now())
let nowTimer: ReturnType<typeof setInterval> | undefined

function loadPace() {
  try {
    const saved = JSON.parse(localStorage.getItem(paceKey()) || 'null')
    pace.value = saved && saved.cps > 0 ? { cps: saved.cps, samples: Math.min(saved.samples, 5) } : { cps: 0, samples: 0 }
  } catch { pace.value = { cps: 0, samples: 0 } }
}
loadPace()
watch(() => settings.ttsEngine, loadPace)

function notePace(text: string, seconds: number) {
  const next = recordPace(pace.value, countSpeechChars(text), seconds, settings.ttsRate)
  if (next === pace.value) return
  pace.value = next
  try { localStorage.setItem(paceKey(), JSON.stringify(next)) } catch { /* 忽略 */ }
}

function calibrateCharsPerPage(index: number) {
  if (!sectionChars.has(index)) {
    const doc: Document | undefined = view?.renderer?.getContents?.()?.find((c: any) => c.index === index)?.doc
    if (!doc?.body) return
    sectionChars.set(index, countSpeechChars(doc.body.textContent))
  }
  const chars = sectionChars.get(index) ?? 0
  // 只有插图的分节 (封面等) 字数太少, 用它算每页字数会严重偏低
  if (chars >= 200 && secCounts[index]) charsPerPage.value = chars / secCounts[index]
}

/** 本章 / 全书还要听多少秒 */
const listenEta = computed(() => {
  const p = pageInfo.value
  if (!p || fixedLayout.value || !charsPerPage.value) return null
  const cps = paceCps(pace.value, settings.ttsRate, bookCjk.value)
  if (ttsState.value !== 'stopped' && listenPosition.value) {
    void tocFractionsReady.value
    const f = listenFraction.value
    const end = tocFractions.find(item => item.fraction > f + 1e-6)?.fraction ?? 1
    return {
      chapter: Math.max(0, end - f) * p.total * charsPerPage.value / cps,
      book: Math.max(0, 1 - f) * p.total * charsPerPage.value / cps,
    }
  }
  // 当前这一屏按读了一半算
  const chapterPages = (chapterLeft.value ?? p.sectionLeft) + (p.last - p.current + 1) / 2
  const bookPages = p.total - p.last + (p.last - p.current + 1) / 2
  return {
    chapter: chapterPages * charsPerPage.value / cps,
    book: bookPages * charsPerPage.value / cps,
  }
})

function humanTime(seconds: number) {
  const d = humanizeDuration(seconds)
  if (d.kind === 'lessThanMinute') return t('tts.lessThanMinute')
  if (d.kind === 'minutes') return t('tts.aboutMinutes', { n: d.m })
  if (d.kind === 'hours') return t('tts.aboutHours', { n: d.h })
  return t('tts.aboutHoursMinutes', { h: d.h, m: d.m })
}

function clockText(seconds: number, kind: 'listen' | 'read' = 'listen') {
  const c = finishClock(seconds, new Date(nowTick.value))
  if (!c) return ''
  const clock = `${c.hh}:${c.mm}`
  if (kind === 'read') return c.dayOffset > 0 ? t('readingMode.finishTomorrow', { clock }) : t('readingMode.finishAt', { clock })
  return c.dayOffset > 0 ? t('tts.finishTomorrow', { clock }) : t('tts.finishAt', { clock })
}

const chapterEtaText = computed(() => listenEta.value ? t('tts.chapterLeft', { time: humanTime(listenEta.value.chapter) }) : '')
/** 顶栏胶囊与浮动胶囊共用的显示内容 (见 components/ListenCapsule) */
const capsuleProps = computed(() => ({
  playing: ttsState.value === 'playing',
  label: ttsBuffering.value ? t('tts.buffering') : listenEta.value ? humanTime(listenEta.value.chapter) : (ttsState.value === 'playing' ? t('tts.reading') : t('tts.paused')),
  detail: chapterEtaText.value,
  rate: settings.ttsRate !== 1 ? rateText(settings.ttsRate) : '',
  sleep: sleepShort.value,
  sleepTitle: sleepShort.value ? t('tts.sleepChangeHint', { text: sleepText.value }) : '',
  sleepFading: sleepFading.value,
  detached: listenDetached.value,
}))
const chapterFinishText = computed(() => listenEta.value ? clockText(listenEta.value.chapter) : '')
const bookFinishText = computed(() => listenEta.value ? clockText(listenEta.value.book) : '')

/** 本章进度 (0–1): 按目录项在全书的位置; 目录位置还没算出时为 null */
const chapterProgress = computed(() => {
  const f = fraction.value
  if (!tocFractionsReady.value || !tocFractions.length) return null
  let start = 0
  let end = 1
  for (const item of tocFractions) {
    if (item.fraction <= f + 1e-6) start = item.fraction
    else { end = item.fraction; break }
  }
  return end > start ? Math.min(1, Math.max(0, (f - start) / (end - start))) : null
})

const listenChapterProgress = computed(() => {
  void tocFractionsReady.value
  const f = listenFraction.value
  let start = 0, end = 1
  for (const item of tocFractions) {
    if (item.fraction <= f + 1e-6) start = item.fraction
    else { end = item.fraction; break }
  }
  return end > start ? Math.min(1, Math.max(0, (f - start) / (end - start))) : 0
})

watch(() => ttsState.value !== 'stopped' || ttsPanel.value, on => {
  clearInterval(nowTimer)
  if (on) {
    nowTick.value = Date.now()
    nowTimer = setInterval(() => { nowTick.value = Date.now() }, 30000)
  }
})

// ---- 本地离线语音包 ----
/** 语音包已装好且可用 (未因闪退暂停); 下载 / 恢复由 LocalTtsPack 处理 */
const localInstalled = computed(() => localPack.installed && !localPack.crashed)
const refreshLocalStatus = () => refreshLocalPack()

async function auditionLocal() {
  try {
    await playAudio(await localTtsSynthesize(t('tts.sampleText'), settings.localVoiceId, settings.ttsRate))
  } catch (e: any) {
    toast(e?.message ?? t('tts.auditionFailed'), 'error')
  }
}

async function openTTSPanel() {
  const next = !ttsPanel.value
  closeOverlays()
  ttsPanel.value = next
  if (ttsPanel.value) {
    refreshLocalStatus()
    // 离线模型首次加载需 10–20s, 打开面板时就在后台加载
    warmUpSpeech()
    void refreshBookmarkOnPage()
  }
  if (ttsPanel.value && !ttsVoices.value.length) {
    ttsVoices.value = (await listVoicesSorted()).map(v => ({ name: v.name, lang: v.lang }))
  }
}

// ---- 听书主流程: 句子游标定位 + 连续播放器出声 (见 services/readAloud, services/listenPlayer) ----
// 句子键 "分节:段:句"; 播放器在某句开始出声时回调, 这里负责高亮、跟随翻页、记断点。
const ttsBuffering = ref(false)
/** 用户在朗读中翻页 / 跳转: 继续朗读但不再拉回视图, 提供「回到朗读位置 / 从这页听」 */
const listenDetached = ref(false)
const currentListenKey = ref('')
/** 每个已渲染分节文档一个句子游标 (跨章连续滚动时同时有多个文档) */
const slotCursors = new WeakMap<Document, SentenceCursor>()
const offscreenDocs = new Map<number, Document>()
const listenTexts = reactive(new Map<string, string>())
const listenPositions = new Map<string, { index: number; fraction: number }>()
// Text-node offsets are indexed once per document. Progress must follow the
// spoken sentence even while the reader browses a different page or chapter.
const listenOffsets = new WeakMap<Document, { offsets: WeakMap<Node, number>; length: number }>()
function rememberListenPosition(key: string, index: number, range: Range | null) {
  const doc = range?.startContainer.ownerDocument
  if (!range || !doc?.body) return
  let entry = listenOffsets.get(doc)
  if (!entry) {
    entry = { offsets: new WeakMap(), length: 0 }
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      entry.offsets.set(node, entry.length)
      entry.length += node.textContent?.length ?? 0
    }
    listenOffsets.set(doc, entry)
  }
  const offset = entry.offsets.get(range.startContainer)
  const total = secSizes.reduce((a, b) => a + b, 0)
  if (offset == null || !entry.length || !total) return
  const ratio = Math.min(1, (offset + range.startOffset) / entry.length)
  const before = secSizes.slice(0, index).reduce((a, b) => a + b, 0)
  listenPositions.set(key, { index, fraction: (before + ratio * secSizes[index]!) / total })
  if (listenPositions.size > 400) listenPositions.delete(listenPositions.keys().next().value!)
}
/** 本次会话离线合成跟不上的次数; 达到 2 次在面板上给出「改用在线模型」 */
let localStutters = 0
const localTooSlow = ref(false)

function switchToOnline() {
  localTooSlow.value = false
  localStutters = 0
  resetEdgeFailure()
  settings.ttsEngine = 'edge'
}
let listenChain: Promise<void> = Promise.resolve()
let lastSentenceStart: { key: string; at: number; pausedBefore: number } | null = null

const listenPlayer = new ListenPlayer({
  canUseSystemSpeech: systemSpeechAvailable,
  onSentenceStart: key => {
    listenPosition.value = listenPositions.get(key) ?? null
    // 定时到了句子边界 (听完本章 / 系统语音读完这句): 下一句一开口就停, 不读半句
    if (sleepStopsBefore(key)) sleepPause()
    // 定时器在后台 / 熄屏时可能被节流: 每句开头也对一下表
    else if (sleepAt.value && !sleepFading.value && Date.now() >= sleepAt.value - SLEEP_FADE_SECONDS * 1000) void sleepNow()
    listenChain = listenChain.then(() => onListenSentence(key)).catch(() => {})
  },
  onEnd: reason => {
    ttsBuffering.value = false
    ttsFailure.value = reason === 'error'
    ttsEnded.value = reason === 'finished'
    if (reason === 'error' && !ttsPanel.value) toast(t('tts.error'), 'error')
    if (reason === 'finished') toast(t('tts.bookFinished'), 'success')
    if (reason !== 'stopped') finishListenSession()
  },
  onBuffering: waiting => {
    ttsBuffering.value = waiting
    // 已经出声后又缓冲 = 合成跟不上播放; 离线模型连续两次即提示改用在线模型
    if (waiting && currentListenKey.value && settings.ttsEngine === 'local') {
      localStutters++
      if (localStutters === 2) {
        localTooSlow.value = true
        toast(t('tts.localSlow'), 'info', 5000)
      }
    }
  },
})

/**
 * 正在显示的分节 (阅读线所在的主章)。跨章连续滚动时 getContents() 返回所有已载分节,
 * 按最近一次 relocate 的分节号挑; 单章渲染时只有一个
 */
function displayedContent(): { doc: Document; index: number } | null {
  const list: any[] = view?.renderer?.getContents?.() ?? []
  const current = view?.lastLocation?.section?.current
  const c = (typeof current === 'number' ? list.find(x => x.index === current && x.doc) : null) ?? list[0]
  return c?.doc ? { doc: c.doc, index: c.index } : null
}

/** 已渲染在屏上 (含连续滚动预载在上下方) 的某一分节 */
function loadedContent(index: number): { doc: Document; index: number } | null {
  const c = (view?.renderer?.getContents?.() ?? []).find((x: any) => x.index === index && x.doc)
  return c ? { doc: c.doc, index: c.index } : null
}

function cursorForDoc(doc: Document): SentenceCursor {
  let c = slotCursors.get(doc)
  if (!c) {
    c = new SentenceCursor(doc)
    slotCursors.set(doc, c)
  }
  return c
}

function cursorForDisplayed(): { cursor: SentenceCursor; index: number } | null {
  const shown = displayedContent()
  if (!shown) return null
  return { cursor: cursorForDoc(shown.doc), index: shown.index }
}

/** 预读后续分节用离屏文档, 与显示文档同源同结构, 句子编号一致 */
async function docForSection(index: number): Promise<Document | null> {
  const shown = loadedContent(index)
  if (shown) return shown.doc
  const cached = offscreenDocs.get(index)
  if (cached) return cached
  try {
    const doc: Document = await view.book.sections[index].createDocument()
    if (offscreenDocs.size >= 3) offscreenDocs.delete(offscreenDocs.keys().next().value!)
    offscreenDocs.set(index, doc)
    return doc
  } catch { return null }
}

function rememberText(key: string, text: string) {
  listenTexts.set(key, text)
  if (listenTexts.size > 400) listenTexts.delete(listenTexts.keys().next().value!)
}

/** 从 (分节, 位置) 起依次产出句子; 本节读完自动续下一节, 书末返回 null */
function makeFeed(startIndex: number, startPos: CursorPos | null): ListenFeed {
  let index = startIndex
  let cur: SentenceCursor | null = null
  let fresh = false
  const total = view.book?.sections?.length ?? 0
  return {
    async next() {
      for (let guard = 0; guard < 100000; guard++) {
        if (!cur) {
          if (index >= total) return null
          if (!secSizes[index]) { index++; continue }
          const doc = await docForSection(index)
          if (!doc) { index++; continue }
          cur = new SentenceCursor(doc)
          if (startPos && index === startIndex) {
            cur.pos = startPos
            fresh = !!cur.current() || cur.first()
          } else fresh = cur.first()
          startPos = null
          if (!fresh) { cur = null; index++; continue }
        } else if (!fresh && !cur.next()) {
          cur = null
          index++
          continue
        }
        fresh = false
        const { block, sentence } = cur.pos
        const text = cur.text()
        const paragraphEnd = sentence === cur.sentencesOf(block).length - 1
        const sectionEnd = paragraphEnd && cur.peek(1).length === 0
        const key = `${index}:${block}:${sentence}`
        rememberText(key, text)
        rememberListenPosition(key, index, cur.current())
        return { key, text, paragraphEnd, sectionEnd }
      }
      return null
    },
  }
}

const parseKey = (key: string) => {
  const [index, block, sentence] = key.split(':').map(Number)
  return { index, pos: { block, sentence } as CursorPos }
}

/** iframe 里的 Range 来自另一个全局, instanceof Range 不成立, 按特征判断 */
const isRange = (x: unknown): x is Range => !!x && typeof (x as Range).startContainer === 'object' && typeof (x as Range).collapse === 'function'

/** 当前朗读句的 Range (仅当它所在的分节已渲染; 跨章连续滚动时可以是主章上下方预载好的分节) */
function listenRange(key = currentListenKey.value): Range | null {
  if (!key) return null
  const { index, pos } = parseKey(key)
  const shown = loadedContent(index)
  if (!shown) return null
  const cursor = cursorForDoc(shown.doc)
  cursor.pos = pos
  return cursor.current()
}

/**
 * 朗读句高亮画在 foliate 的标注叠层上, 不借用文档选区: 否则每读一句都会冲掉用户正在划的词,
 * 听书时没法划线、写想法、「从这里听」。
 */
const TTS_MARK = 'lr-tts-sentence'
/** 朗读句标记随正文主题取色 (墨水屏为下划线), 句内文字对比度 ≥ 4.5:1, 见 readerTheme.LISTEN_MARKS */
const listenMark = computed(() => listenMarkStyle(settings.readerPrefs.theme, appDark.value, lateModes.value?.readerStyle.value))
const SVG_NS = 'http://www.w3.org/2000/svg'
/** overlayer 绘制函数: 色块 (按主题透明度) 或下划线; rects 是 foliate 给出的行框 */
function drawListenMark(rects: Array<{ left: number; top: number; width: number; height: number }>, opts: { mark: ListenMarkStyle; padding?: number }) {
  const { mark, padding = 0 } = opts
  const g = document.createElementNS(SVG_NS, 'g')
  g.setAttribute('fill', mark.color)
  g.style.opacity = String(mark.opacity)
  for (const r of rects) {
    const el = document.createElementNS(SVG_NS, 'rect')
    if (mark.underline) {
      const thick = Math.max(2, Math.round(r.height * 0.09))
      el.setAttribute('x', String(r.left))
      el.setAttribute('y', String(r.top + r.height - thick / 2))
      el.setAttribute('width', String(r.width))
      el.setAttribute('height', String(thick))
    } else {
      el.setAttribute('x', String(r.left - padding))
      el.setAttribute('y', String(r.top - padding))
      el.setAttribute('width', String(r.width + padding * 2))
      el.setAttribute('height', String(r.height + padding * 2))
    }
    g.append(el)
  }
  return g
}
/**
 * 画朗读高亮并让视图跟上。scroll: true = 跟随 (在舒适区就不动, 读者刚滑过就先不抢);
 * 'force' = 读者主动要看这句 (跳句 / 回到朗读位置): 不管刚才滑没滑过, 不在舒适区就挪过来
 */
function highlightListen(range: Range, scroll: boolean | 'force' = true) {
  clearListenHighlight()
  const doc = range.startContainer.ownerDocument
  const target = view.renderer.getContents?.()?.find((c: any) => c.doc === doc)
  try { target?.overlayer?.add(TTS_MARK, range, drawListenMark, { mark: listenMark.value, padding: 1 }) } catch { /* 叠层未就绪 */ }
  if (scroll) followText(range, scroll === 'force')
}

// ---- 阅读焦点 (services/readingFocus.ts): 程序把视图移到一段文字时, 落在可读区 38% 的焦点线,
// 不贴顶边、不钻到顶栏下面; 跟随时在 25%–65% 舒适区里就不动。只管滚动模式, 翻页模式照旧翻到目标所在页 ----
/** 滚动模式且渲染器支持阅读焦点 (fork 的 rangeBox / scrollToRange) */
function focusFlow(): boolean {
  const r = view?.renderer
  return !!r && effectiveFlow.value === 'scrolled' && !!r.scrolled && !view.isFixedLayout && typeof r.scrollToRange === 'function'
}
/**
 * 可读区: 渲染器视口减去此刻盖在正文上的东西 — 显示中的顶栏 / 底栏, 手机上的听书抽屉。
 * 工具栏有 0.25s 的位移过渡, 用 offsetTop/offsetHeight (不受 transform 影响) 量它们停稳后的位置
 */
function focusArea(): Area {
  const r = view.renderer
  const host: DOMRect = r.getBoundingClientRect()
  const viewport = Number(r.size) || host.height
  const shell = container.value?.closest('.reader') as HTMLElement | null
  let insetTop = 0
  let insetBottom = 0
  if (shell && barsVisible.value) {
    const top0 = shell.getBoundingClientRect().top
    const bar = (sel: string) => shell.querySelector<HTMLElement>(`:scope > ${sel}`)
    const head = bar('.bar.top')
    const foot = bar('.bar.bottom')
    if (head) insetTop = top0 + head.offsetTop + head.offsetHeight - host.top
    if (foot) insetBottom = host.top + viewport - (top0 + foot.offsetTop)
  }
  const sheet = ttsPanel.value ? shell?.querySelector<HTMLElement>(':scope > .tts-panel') : null
  if (sheet) {
    // 只有铺满宽度、贴着底边的抽屉才算遮挡 (桌面上的听书面板是右上角的小卡片)
    const rect = sheet.getBoundingClientRect()
    if (rect.width >= host.width * 0.9 && rect.bottom >= host.bottom - 2) insetBottom = Math.max(insetBottom, host.bottom - rect.top)
  }
  return readingArea(viewport, insetTop, insetBottom)
}
/** 一次性跳转的落点 (相对视口顶边 px) */
const focusJumpOptions = () => ({ at: jumpLine(focusArea()), behavior: prefersReducedMotion() ? 'auto' : 'smooth' })

/** 跟随一段文字 (听书当前句): 在舒适区就不动, 否则平稳挪到焦点线; 读者 4 秒内滑过则不抢 (force 除外) */
function followText(range: Range, force = false) {
  const r = view?.renderer
  if (!r) return
  if (!focusFlow()) {
    // 翻页模式: 翻到这句所在的页 (原行为)
    r.scrollToAnchor?.(range)
    return
  }
  if (!force && followHeld(listenSteerAt, performance.now())) return
  const box = r.rangeBox(range)
  if (!box) {
    r.scrollToAnchor?.(range)
    return
  }
  const at = followTarget(box, focusArea())
  if (at == null) return
  const motion = scrollMotion(box.top - at, box.viewport, prefersReducedMotion())
  void r.scrollToRange(range, { at, ...motion })
}

/**
 * 跳到书里的一段文字 (搜索结果、划线、点睛要句、听书断点): 滚动模式下目标首行落在焦点线, 近处平滑滚过去。
 * 书签 / 续读 / 「回到第 N 页」记的是当时屏幕顶上那一行, 照旧顶端对齐还原屏幕 — 若也挪到焦点线,
 * 每打开一次记下的位置就往前退一截。章节 / 目录跳转也照旧, 章首在顶上。
 */
async function goToText(target: string) {
  if (!view) return
  if (!focusFlow()) return view.goTo(target)
  const resolved = view.resolveNavigation(target)
  if (!resolved) return view.goTo(target)
  await view.renderer.goTo({ ...resolved, focus: focusJumpOptions() })
  try { view.history?.pushState?.(target) } catch { /* 历史记录只用于前进后退 */ }
}

/**
 * 听书时读者自己滑动 / 拖滚动条: 4 秒内不自动跟随; 停手后若朗读句已滑出屏幕, 转为「回到朗读位置」;
 * 滑回来、朗读句又出现在屏上, 就接着跟。只在滚动模式下 (翻页模式的手动翻页本来就会转为「回到朗读位置」)
 */
let listenSteerAt = -Infinity
let steerCheckTimer: ReturnType<typeof setTimeout> | undefined
function noteReaderSteer() {
  if (ttsState.value === 'stopped' || !focusFlow()) return
  listenSteerAt = performance.now()
  clearTimeout(steerCheckTimer)
  steerCheckTimer = setTimeout(checkListenOnScreen, 450)
}
function checkListenOnScreen() {
  if (ttsState.value === 'stopped' || !focusFlow() || !currentListenKey.value) return
  const range = listenRange()
  const box = range ? view.renderer.rangeBox(range) : null
  const onScreen = !!box && isOnScreen(box, box.viewport)
  if (!onScreen) listenDetached.value = true
  else if (listenDetached.value) listenDetached.value = false
}

// 换正文主题 / 开关墨水屏: 朗读句标记跟着换色, 不挪视图
watch(listenMark, () => {
  if (ttsState.value === 'stopped' || listenDetached.value) return
  const range = listenRange()
  if (range) highlightListen(range, false)
})

function clearListenHighlight() {
  for (const c of view?.renderer?.getContents?.() ?? []) {
    try { c.overlayer?.remove(TTS_MARK) } catch { /* 忽略 */ }
  }
}

async function onListenSentence(key: string) {
  measurePace(key)
  pingReadingAuto()
  currentListenKey.value = key
  const { index } = parseKey(key)
  if (!listenDetached.value) {
    // 朗读进入下一分节: 翻过去 (跨章连续滚动时它多半已预载在下方, 直接滚过去, 不重新加载);
    // 滚动模式下直接把这句放到焦点线, 不先停在章首再挪一次。读者刚滑过 (4 秒内) 就不去拽
    if (!loadedContent(index) && !(focusFlow() && followHeld(listenSteerAt, performance.now()))) {
      await goToListenSection(index, parseKey(key).pos)
    }
    const range = listenRange(key)
    if (range) {
      // 歌词跟读: 由歌词把当前行固定在 40% 处, 朗读这里只画高亮不滚动 (否则两者抢位置)
      if (modes.lyricFollowing.value) {
        modes.followRange(range)
        highlightListen(range, false)
      } else highlightListen(range)
    }
  }
  saveBookmarkFor(key)
  updateMediaSession()
}

/** 两句起点的时间差 ÷ 上一句字数 = 实际语速 (扣除暂停) */
function measurePace(key: string) {
  const now = performance.now()
  const prev = lastSentenceStart
  lastSentenceStart = { key, at: now, pausedBefore: pausedTotal }
  if (!prev || ttsBuffering.value) return
  const text = listenTexts.get(prev.key)
  if (text) notePace(text, (now - prev.at - (pausedTotal - prev.pausedBefore)) / 1000)
}

// ---- 断点续读: 每句开始时记下位置 (CFI), 下次从这句接着听 ----
const listenBookmark = ref<ListenBookmark | null>(loadListenBookmark(bookId))
let bookmarkTimer: ReturnType<typeof setTimeout> | undefined

function saveBookmarkFor(key: string) {
  clearTimeout(bookmarkTimer)
  bookmarkTimer = setTimeout(async () => {
    const { index, pos } = parseKey(key)
    const doc = await docForSection(index)
    if (!doc) return
    const c = new SentenceCursor(doc)
    c.pos = pos
    const range = c.current()
    if (!range) return
    let cfi = ''
    try { cfi = view.getCFI(index, range) } catch { return }
    // 用该句对应的章名保存断点，独立浏览不会改写听书书签的章节。
    const position = listenPositions.get(key)
    const chapter = position ? chapterAtFraction(position.fraction, position.index) : listenChapter.value
    const mark: ListenBookmark = { cfi, chapter, snippet: c.text(range).slice(0, 28), at: Date.now() }
    listenBookmark.value = mark
    saveListenBookmark(bookId, mark)
  }, 400)
}

/** 断点所在句的位置; 断点在显示中的分节时同时给出 Range */
async function resolveBookmark(mark: ListenBookmark): Promise<{ index: number; pos: CursorPos; range: Range | null } | null> {
  try {
    const { index, anchor } = await view.resolveNavigation(mark.cfi)
    const doc = await docForSection(index)
    if (!doc || typeof anchor !== 'function') return null
    const target: Range | Element | null = anchor(doc)
    if (!target) return null
    const c = new SentenceCursor(doc)
    const node = isRange(target) ? target.startContainer : target
    const offset = isRange(target) ? target.startOffset : 0
    if (!c.seek(node, offset)) return null
    return { index, pos: c.pos, range: loadedContent(index) ? c.current() : null }
  } catch { return null }
}

/** 断点就在当前页上: 「开始」直接从断点那句接着读 */
const bookmarkOnPage = ref(false)
async function refreshBookmarkOnPage() {
  const mark = listenBookmark.value
  const visible: Range | undefined = view?.lastLocation?.range
  if (!mark || !visible) { bookmarkOnPage.value = false; return }
  const hit = await resolveBookmark(mark)
  // 跨章连续滚动时断点可能在另一个分节文档里, 跨文档 comparePoint 会抛 WrongDocumentError
  const range = hit?.range
  try {
    bookmarkOnPage.value = !!range && range.startContainer.ownerDocument === visible.startContainer.ownerDocument
      && visible.comparePoint(range.startContainer, range.startOffset) === 0
  } catch { bookmarkOnPage.value = false }
}

const bookmarkAgo = computed(() => {
  const mark = listenBookmark.value
  if (!mark) return ''
  const b = agoBucket(mark.at, nowTick.value)
  if (b.kind === 'justNow') return t('tts.agoJustNow')
  if (b.kind === 'minutes') return t('tts.agoMinutes', { n: b.n })
  if (b.kind === 'hours') return t('tts.agoHours', { n: b.n })
  if (b.kind === 'yesterday') return t('tts.agoYesterday')
  return t('tts.agoDays', { n: b.n })
})

type ListenFrom = 'auto' | 'page' | 'bookmark' | { range: Range }

/** 开始朗读: auto = 断点在本页则接着断点, 否则从本页第一句 */
async function startTTS(from: ListenFrom = 'auto') {
  if (!view) return
  if (unavailableVoice.value) { ttsOptions.value = 'voice'; ttsPanel.value = true; return }
  ttsFailure.value = false
  ttsEnded.value = false
  modes.stopForExternal('tts')
  if (autoReading.value) toast(t('readingMode.autoStopped'))
  stopAutoRead()
  if (view.isFixedLayout) {
    toast(t('tts.fixedLayoutUnsupported'), 'error')
    return
  }
  resetEdgeFailure()
  let index: number
  let pos: CursorPos | null = null
  if (from === 'bookmark' || (from === 'auto' && bookmarkOnPage.value && listenBookmark.value)) {
    const hit = listenBookmark.value ? await resolveBookmark(listenBookmark.value) : null
    if (hit) {
      index = hit.index
      pos = hit.pos
      if (displayedContent()?.index !== index) await goToText(listenBookmark.value!.cfi).catch(() => {})
    } else return startTTS('page')
  } else {
    const visible: Range | undefined = typeof from === 'object' ? undefined : view.lastLocation?.range
    // 跨章连续滚动时屏上有多个分节文档: 以选区 / 可见范围所在的文档为准
    const ownerDoc = typeof from === 'object' ? from.range.startContainer.ownerDocument : visible?.startContainer.ownerDocument
    const owner = ownerDoc ? (view.renderer.getContents?.() ?? []).find((x: any) => x.doc === ownerDoc) : null
    const shown = owner ? { cursor: cursorForDoc(owner.doc), index: owner.index as number } : cursorForDisplayed()
    if (!shown) return
    index = shown.index
    const c = shown.cursor
    if (typeof from === 'object') {
      if (!c.seek(from.range.startContainer, from.range.startOffset)) return
    } else {
      if (!visible || !c.seek(visible.startContainer, visible.startOffset)) c.first()
      // 本页第一句若始于上一页, 从本页完整的第一句开始, 免得视图被拉回上一页
      const cur = c.current()
      if (cur && visible && cur.startContainer.ownerDocument === visible.startContainer.ownerDocument
        && cur.compareBoundaryPoints(Range.START_TO_START, visible) < 0 && c.pos.sentence > 0) c.next()
    }
    pos = c.pos
  }
  listenDetached.value = false
  lastSentenceStart = null
  localStutters = 0
  localTooSlow.value = false
  restartOnResume = false
  reanchorSleep()
  ttsState.value = 'playing'
  listenPlayer.play(makeFeed(index!, pos))
  setupMediaSession()
}

function pauseTTS() {
  if (ttsState.value !== 'playing') return
  ttsState.value = 'paused'
  pausedAt = performance.now()
  listenPlayer.pause()
  modes.setFollowPaused(true)
  updateMediaSession()
}

function resumeTTS() {
  if (ttsState.value !== 'paused') return
  ttsState.value = 'playing'
  if (pausedAt) pausedTotal += performance.now() - pausedAt
  pausedAt = 0
  // 定时淡出停下的 / 暂停时改了语速音色: 从这一句开头重读, 不接着半句
  if (restartOnResume && currentListenKey.value) {
    restartOnResume = false
    restartCurrentSentence()
  } else listenPlayer.resume()
  modes.setFollowPaused(false)
  updateMediaSession()
}

function stopTTS() {
  if (pausedAt) pausedTotal += performance.now() - pausedAt
  pausedAt = 0
  listenPlayer.stop()
  finishListenSession()
}

/** 从当前朗读句的开头重新合成、播放 (换了语速 / 音色, 或定时停止后继续) */
function restartCurrentSentence() {
  const key = currentListenKey.value
  if (!key || ttsState.value === 'stopped') return
  const { index, pos } = parseKey(key)
  lastSentenceStart = null
  listenPlayer.play(makeFeed(index, pos))
}
/** 下次「继续」时从当前句开头读 */
let restartOnResume = false

function finishListenSession() {
  clearTimeout(skipTimer)
  skipTarget = null
  listenPosition.value = null
  restartOnResume = false
  ttsState.value = 'stopped'
  ttsBuffering.value = false
  listenDetached.value = false
  currentListenKey.value = ''
  clearListenHighlight()
  setSleep(0)
  clearMediaSession()
  void refreshBookmarkOnPage()
}

// ---- 跳句 / 跳段: 立即移到目标句并高亮, 连按时合并为一次重新合成 ----
let skipTimer: ReturnType<typeof setTimeout> | undefined
let skipTarget: { index: number; pos: CursorPos } | null = null

async function skipListen(kind: 'sentence' | 'paragraph', dir: 1 | -1) {
  const key = skipTarget ? `${skipTarget.index}:${skipTarget.pos.block}:${skipTarget.pos.sentence}` : currentListenKey.value
  if (ttsState.value === 'stopped' || !key) return
  let { index, pos } = parseKey(key)
  let doc = await docForSection(index)
  if (!doc) return
  let c = new SentenceCursor(doc)
  c.pos = pos
  let moved = kind === 'sentence' ? (dir > 0 ? c.next() : c.prev()) : (dir > 0 ? c.nextBlock() : c.prevBlock())
  // 跨分节
  for (let i = index + dir; !moved && i >= 0 && i < (view.book?.sections?.length ?? 0); i += dir) {
    if (!secSizes[i]) continue
    doc = await docForSection(i)
    if (!doc) continue
    c = new SentenceCursor(doc)
    moved = dir > 0 ? c.first() : (kind === 'paragraph' ? c.last() && c.prevBlock() || c.last() : c.last())
    if (moved) index = i
  }
  if (!moved) return
  skipTarget = { index, pos: c.pos }
  listenDetached.value = false
  restartOnResume = false
  reanchorSleep()
  const nextKey = `${index}:${c.pos.block}:${c.pos.sentence}`
  rememberText(nextKey, c.text())
  rememberListenPosition(nextKey, index, c.current())
  listenPosition.value = listenPositions.get(nextKey) ?? null
  currentListenKey.value = nextKey
  listenSteerAt = -Infinity
  if (!loadedContent(index)) await goToListenSection(index, c.pos)
  const range = listenRange(nextKey)
  if (range) highlightListen(range, 'force')
  clearTimeout(skipTimer)
  skipTimer = setTimeout(() => {
    const target = skipTarget
    skipTarget = null
    if (!target || ttsState.value === 'stopped') return
    // Seeking while paused only moves the cursor. Resume must synthesize the
    // newly selected sentence instead of continuing the old buffered audio.
    if (ttsState.value === 'paused') {
      restartOnResume = true
      updateMediaSession()
      return
    }
    ttsState.value = 'playing'
    lastSentenceStart = null
    listenPlayer.play(makeFeed(target.index, target.pos))
  }, 350)
}

/** 回到正在朗读的那一句 (翻页走开后) */
async function returnToListening() {
  listenDetached.value = false
  const key = currentListenKey.value
  if (!key) return
  const { index, pos } = parseKey(key)
  listenSteerAt = -Infinity
  if (!loadedContent(index)) await goToListenSection(index, pos)
  const range = listenRange(key)
  if (range) highlightListen(range, 'force')
}

/** 朗读句所在分节没在屏上: 打开它; 滚动模式下顺带把这句放到焦点线 (翻页模式照旧打开章首, 随后翻到句子所在页) */
async function goToListenSection(index: number, pos: CursorPos) {
  const target: Record<string, unknown> = { index }
  if (focusFlow()) {
    target.anchor = (doc: Document) => {
      const c = cursorForDoc(doc)
      c.pos = pos
      return c.current() ?? 0
    }
    target.focus = focusJumpOptions()
  }
  try { await view.renderer.goTo(target) } catch { /* 留在原处, 继续读 */ }
}

/** 从朗读中翻到 / 跳到的这一页重新开始读 */
function listenFromHere() {
  void startTTS('page')
}

/** 划词时记下的选区 (点浮条按钮时 iframe 选区可能已变) */
let selectionRange: Range | null = null
/** 每个分节文档的选区刷新函数 (「选中本段」改了选区后立即刷新工具条) */
const selectionUpdaters = new WeakMap<Document, () => void>()
/** 选区不是整段时显示「选中本段」 */
const canSelectParagraph = ref(false)

/** 「选中本段」: 把选区扩到所在整段 (跨段时到末段结尾), 工具条随之刷新 */
function selectParagraph() {
  const range = selectionRange
  const doc = range?.startContainer.ownerDocument
  const next = range && paragraphRange(range)
  if (!doc || !next) return
  const sel = doc.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(next)
  selectionUpdaters.get(doc)?.()
}

/** 划词翻译 (components/TranslateSheet) */
const translating = ref<string | null>(null)
function translateSelection() {
  const text = selection.value?.text
  dismissSelection()
  if (text) translating.value = text
}

// ---- 正文简繁转换 (services/zhConvert): 本地词表, 只改文字不改结构, 划线与进度不受影响 ----
const zh = zhConvertController(
  () => (view?.renderer?.getContents?.() ?? []).map((c: { doc?: Document }) => c.doc).filter((d: Document | undefined): d is Document => !!d),
  () => toast(t('reader.zhConvertFailed'), 'error'),
)
watch(() => settings.zhConvert, mode => { void zh.setMode(mode) }, { immediate: true })

/** 点已有划线时弹出的同一个工具条 (改颜色 / 想法 / 复制 / 卡片 / 删除) */
const hlMenu = shallowRef<{ anno: AnnotationRec } | null>(null)
/** 工具条位置: 贴着选区, 上方放不下就放到下方 */
const selTools = reactive({ top: 0, below: false })
const SEL_TOOLS_H = 132

function placeSelTools(range: Range | null | undefined) {
  const vh = window.innerHeight
  const safeTop = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--lr-safe-top')) || 0
  const minTop = safeTop + 12
  let top = Math.max(minTop, vh / 2 - SEL_TOOLS_H / 2)
  let below = false
  try {
    if (range) {
      const r = range.getBoundingClientRect()
      const frame = range.startContainer.ownerDocument?.defaultView?.frameElement as HTMLElement | null
      const f = frame?.getBoundingClientRect() ?? { top: 0 }
      const start = f.top + r.top
      const end = f.top + r.bottom
      if (start - SEL_TOOLS_H - 14 >= minTop) top = start - SEL_TOOLS_H - 14
      else { top = Math.min(end + 14, vh - SEL_TOOLS_H - 12); below = true }
    }
  } catch { /* 取不到位置时居中 */ }
  selTools.top = Math.round(top)
  selTools.below = below
}

/** 清掉正文里的选区: 只收起工具条而不清选区, 之后的 selectionchange 会把它又带出来 */
function clearDocSelection() {
  selectionRange = null
  for (const c of view?.renderer?.getContents?.() ?? []) {
    try { c.doc?.getSelection()?.removeAllRanges() } catch { /* 已卸载的分节 */ }
  }
}

function dismissSelection() {
  selection.value = null
  hlMenu.value = null
  clearDocSelection()
}

async function copySelectionText() {
  const text = selection.value?.text
  dismissSelection()
  if (!text) return
  try {
    await copyText(text)
    toast(t('notes.copied'), 'success')
  } catch {
    toast(t('notes.copyFailed'), 'error')
  }
}

async function recolorHighlight(color: string) {
  const a = hlMenu.value?.anno
  if (!a || a.color === color) { dismissSelection(); return }
  const storage = await getStorage()
  await storage.updateAnnotation(a.id, { color })
  a.color = color
  const item = annotations.value.find(x => x.id === a.id)
  if (item) item.color = color
  try {
    await view.deleteAnnotation({ value: a.cfi })
    await view.addAnnotation({ value: a.cfi, color })
  } catch { /* 当前分节未绘制时忽略 */ }
  dismissSelection()
}

function editHighlightNote() {
  const a = hlMenu.value?.anno
  dismissSelection()
  if (!a) return
  noteDraft.value = a.note ?? ''
  activeAnnotation.value = a
}

/** 选中文字 → 从这里开始听 */
function listenFromSelection() {
  const range = selectionRange
  dismissSelection()
  if (range) void startTTS({ range })
}

// 听书出声时压低背景音
watch(ttsState, s => ambient.duck(s === 'playing'), { immediate: true })

// 换音色 / 倍速 / 引擎: 从正在读的这一句开头按新设置重读 (拖语速滑条时停手 0.4 秒再重读一次);
// 暂停中改的, 继续时从这句开头读
let settingsRestartTimer: ReturnType<typeof setTimeout> | undefined
watch(() => [settings.ttsEngine, settings.ttsRate, settings.edgeVoice, settings.localVoiceId, settings.ttsVoice, cloudSignature(settings), settings.minimaxApiKey, settings.doubaoApiKey, settings.doubaoAppId], () => {
  if (ttsState.value === 'stopped') return
  clearTimeout(settingsRestartTimer)
  if (ttsState.value === 'paused') {
    restartOnResume = true
    return
  }
  // 先作废预合成, 免得等待期间读到旧设置的下一块
  listenPlayer.invalidate()
  settingsRestartTimer = setTimeout(() => {
    if (ttsState.value === 'playing') restartCurrentSentence()
  }, 400)
})

/** 语速显示: 1.0× / 1.25× / 0.75× (用乘号, 不用字母 x) */
/** 语速档位: 1.0× 标「正常」; 其余两档之间可以拖 (步长 0.05) */

// ---- 定时关闭: 15 / 30 分钟、1 小时, 或听完本章 ----
// 到点前 3 秒开始淡出, 到点停在暂停 (不是停止, 进度和断点都在), Toast 可一键「再听 15 分钟」。
// 系统语音调不了音量: 读完这句再停。只在本次听书内有效, 不记住 (默认「不定时」)
type SleepMode = 0 | 15 | 30 | 60 | 'chapter'
const SLEEP_CHOICES: Array<{ mode: SleepMode; key: string }> = [
  { mode: 0, key: 'tts.sleepOff' },
  { mode: 15, key: 'tts.sleep15' },
  { mode: 30, key: 'tts.sleep30' },
  { mode: 60, key: 'tts.sleep60' },
  { mode: 'chapter', key: 'tts.sleepChapter' },
]
const SLEEP_FADE_SECONDS = 3
/** 系统语音等句末最多等这么久 (一句再长也该读完了), 到了直接停 */
const SLEEP_SENTENCE_WAIT_MS = 20000
const sleepMode = ref<SleepMode>(0)
const sleepAt = ref(0)
/** 正在淡出 (最后 3 秒) */
const sleepFading = ref(false)
let sleepTimer: ReturnType<typeof setTimeout> | undefined
let sleepChapter: string | undefined
/** 「听完本章」开始时朗读所在分节; 读进不是新章开头的续篇分节 (被拆开的长章) 时跟着更新 */
let sleepSection: number | undefined
/** 读完这一句就停 (系统语音的定时到点) */
let sleepAtSentenceEnd = false

function setSleep(mode: SleepMode) {
  clearTimeout(sleepTimer)
  sleepMode.value = mode
  sleepAt.value = 0
  sleepChapter = undefined
  sleepSection = undefined
  sleepAtSentenceEnd = false
  if (typeof mode === 'number' && mode > 0) {
    sleepAt.value = Date.now() + mode * 60000
    sleepTimer = setTimeout(() => void sleepNow(), mode * 60000 - SLEEP_FADE_SECONDS * 1000)
  } else if (mode === 'chapter' && currentListenKey.value && ttsState.value !== 'stopped') {
    sleepChapter = listenChapter.value
    sleepSection = parseKey(currentListenKey.value).index
  }
  // 还没开始听: 从听到的第一句所在的章算起 (sleepStopsBefore 里补上)
}

/** 读者换了朗读位置 (开始 / 从这里听 / 跳句): 「听完本章」改为听完新位置所在的这一章 */
function reanchorSleep() {
  sleepSection = undefined
  sleepChapter = undefined
}

/** 点定时徽标: 取消定时 */
function cancelSleep() {
  if (!sleepMode.value) return
  setSleep(0)
  toast(t('tts.sleepCancelled'))
}

/** 时长定时到点: 淡出后暂停; 系统语音则等这句读完 */
async function sleepNow() {
  setSleep(0)
  // 听书定时到点, 背景音跟着慢慢淡出
  if (ambient.state.playing) ambient.fadeOutAndStop(30)
  if (ttsState.value !== 'playing') return
  sleepFading.value = true
  const result = await listenPlayer.fadeOut(SLEEP_FADE_SECONDS)
  sleepFading.value = false
  if (result === 'done') sleepPause()
  else if (result === 'unsupported' && ttsState.value === 'playing') {
    sleepAtSentenceEnd = true
    sleepTimer = setTimeout(() => {
      if (sleepAtSentenceEnd && ttsState.value === 'playing') sleepPause()
      sleepAtSentenceEnd = false
    }, SLEEP_SENTENCE_WAIT_MS)
  }
}

/** 分节 → 是否是目录里某一章的开头 (算一次; 目录为空时每个分节都算新章) */
let chapterStartCache: Set<number> | null = null
function isChapterStart(index: number): boolean {
  if (!chapterStartCache) {
    const set = new Set<number>()
    const walk = (items: any[] | undefined) => {
      for (const item of items ?? []) {
        try {
          const r = item?.href ? view?.book?.resolveHref?.(item.href) : null
          if (typeof r?.index === 'number') set.add(r.index)
        } catch { /* 无法解析的目录项 */ }
        walk(item?.subitems)
      }
    }
    walk(view?.book?.toc)
    chapterStartCache = set
  }
  return !chapterStartCache.size || chapterStartCache.has(index)
}

/** 某句开始出声时: 是否该在它开口前停下 (听完本章 / 系统语音的句末) */
function sleepStopsBefore(key: string): boolean {
  if (ttsState.value !== 'playing') return false
  if (sleepAtSentenceEnd) return true
  if (sleepMode.value !== 'chapter') return false
  const { index } = parseKey(key)
  if (sleepSection == null) {
    sleepSection = index
    sleepChapter = listenChapter.value
    return false
  }
  // TXT/HTML can contain several chapters in one spine section. Compare the
  // spoken chapter as well, including when following the text is detached.
  if (sleepChapter && listenChapter.value && listenChapter.value !== sleepChapter) return true
  if (index === sleepSection) return false
  if (isChapterStart(index)) return true
  sleepSection = index
  return false
}

/** 定时停下: 暂停 (不是停止), 下次继续从这一句开头读; 提示可以再听 15 分钟 */
function sleepPause() {
  const byChapter = sleepMode.value === 'chapter'
  setSleep(0)
  // 时长定时在 sleepNow 里已让背景音淡出; 听完本章在这里
  if (byChapter && ambient.state.playing) ambient.fadeOutAndStop(30)
  if (ttsState.value !== 'playing') return
  pauseTTS()
  restartOnResume = true
  toast(t('tts.sleepDone'), 'info', 8000, {
    label: t('tts.sleepMore'),
    run: () => {
      resumeTTS()
      setSleep(15)
    },
  })
}

// Chapter sleep is checked against spoken positions in sleepStopsBefore;
// browsing another chapter must neither stop playback nor move the timer.

/** 定时徽标: 「23:40 停止」/「听完本章停止」 */
const sleepText = computed(() => {
  if (sleepMode.value === 'chapter') return t('tts.sleepAfterChapter')
  if (!sleepAt.value) return ''
  const d = new Date(sleepAt.value)
  return t('tts.sleepAtClock', { clock: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` })
})
/** 胶囊上的短写: 「23:40」/「本章完」 */
const sleepShort = computed(() => {
  if (sleepMode.value === 'chapter') return t('tts.sleepChapterShort')
  if (!sleepAt.value) return ''
  const d = new Date(sleepAt.value)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
})

// ---- 系统媒体控制: 锁屏 / 耳机键 / 键盘媒体键 ----
function setupMediaSession() {
  const ms = (navigator as any).mediaSession
  if (!ms) return
  const on = (action: string, fn: () => void) => { try { ms.setActionHandler(action, fn) } catch { /* 不支持的动作 */ } }
  on('play', () => (ttsState.value === 'paused' ? resumeTTS() : void startTTS()))
  on('pause', pauseTTS)
  on('stop', stopTTS)
  on('previoustrack', () => void skipListen('paragraph', -1))
  on('nexttrack', () => void skipListen('paragraph', 1))
  on('seekbackward', () => void skipListen('sentence', -1))
  on('seekforward', () => void skipListen('sentence', 1))
  updateMediaSession()
}

function updateMediaSession() {
  const ms = (navigator as any).mediaSession
  if (!ms) return
  try {
    const MM = (window as any).MediaMetadata
    if (MM) ms.metadata = new MM({ title: chapterLabel.value || meta.value?.title || '', artist: meta.value?.author ?? '', album: meta.value?.title ?? '' })
    ms.playbackState = ttsState.value === 'playing' ? 'playing' : ttsState.value === 'paused' ? 'paused' : 'none'
  } catch { /* 忽略 */ }
}

function clearMediaSession() {
  const ms = (navigator as any).mediaSession
  if (!ms) return
  try {
    ms.playbackState = 'none'
    ms.metadata = null
    for (const a of ['play', 'pause', 'stop', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward']) ms.setActionHandler(a, null)
  } catch { /* 忽略 */ }
}

/** 跨章连续滚动: 主章 (阅读线所在的分节) 切换 */
function onRendererSectionChange(e: Event) {
  modes.onSectionChange((e as CustomEvent).detail)
}

/** 跨章连续滚动: 远处的分节被卸载 (文档随后销毁), 释放挂在上面的图层 */
function onRendererUnload(e: Event) {
  const detail = (e as CustomEvent).detail
  modes.onSectionUnload(detail)
  dj.onSectionUnload(detail)
}

function onSectionLoad(e: CustomEvent) {
  // 简繁转换最先做: 打字机 / 点睛读到的已是转换后的文字 (等长替换, 偏移不变)
  try { zh.onSectionLoad(e.detail.doc) } catch { /* 忽略 */ }
  // 打字机: 在新章节首次绘制前隐藏未打出的文字
  modes.onSectionLoad(e.detail)
  dj.onSectionLoad(e.detail)
  const { doc, index } = e.detail
  for (const resolve of sectionLoadResolvers.splice(0)) resolve()
  // 竖排书不启用跨章连续滚动 (docs/continuous-scroll.md §9): 第一次见到竖排分节时撤掉 continuous
  if (!bookVertical) {
    try {
      if (doc.defaultView?.getComputedStyle(doc.body).writingMode?.startsWith('vertical')) {
        bookVertical = true
        if (view?.renderer?.hasAttribute?.('continuous')) setTimeout(applyPrefs, 0)
      }
    } catch { /* 忽略 */ }
  }
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
      const range = sel.getRangeAt(0).cloneRange()
      selectionRange = range
      canSelectParagraph.value = !fixedLayout.value && !isWholeParagraph(range)
      hlMenu.value = null
      placeSelTools(selectionRange)
      selection.value = cfi ? { cfi, text } : null
      dj.onSelection(index, selectionRange)
    } catch {
      selection.value = null
    }
  }
  selectionUpdaters.set(doc, updateSelection)
  doc.addEventListener('mouseup', () => setTimeout(updateSelection, 0))
  doc.addEventListener('touchend', () => setTimeout(updateSelection, 0))
  // 安卓浏览器 (vivo 自带浏览器、华为平板等) 长按选字会取消这次触摸 (touchcancel, 没有 touchend),
  // 拖选区两端的把手也不发触摸事件: 只等 touchend 就永远看不到选区, 划线工具条不出来, 只剩浏览器
  // 自己的复制菜单. 选区稳定一会儿后也读一次; 这里只负责「出现」, 收起仍交给 touchend / mouseup
  // (点工具条按钮时浏览器可能先把正文选区清掉, 不能因此收起工具条)
  let selectionTimer: ReturnType<typeof setTimeout> | undefined
  doc.addEventListener('selectionchange', () => {
    clearTimeout(selectionTimer)
    selectionTimer = setTimeout(() => {
      const sel = doc.getSelection()
      if (sel && !sel.isCollapsed && sel.toString().trim()) updateSelection()
    }, 300)
  })
  // 点击正文时收起目录等侧栏和浮层; 若这一下是为了收面板, 不再触发翻页
  doc.addEventListener('mousedown', () => {
    overlayDismissed = panel.value !== 'none' || settingsOpen.value || !!activeAnnotation.value || !!hlMenu.value
    panel.value = 'none'
    settingsOpen.value = false
    activeAnnotation.value = null
    hlMenu.value = null
  })
  doc.addEventListener('click', (e: MouseEvent) => {
    // 触屏轻点已在 touchend 处理过, 吞掉其后的合成 click
    if (Date.now() < suppressClickUntil) return
    onContentClick(e.clientX, doc, e.target as Element, e.clientY)
  })

  // 触屏轻点: 触摸设备上合成 click 与 foliate 的 touch 吸附赛跑, 时有丢失/弹回
  // (Windows 触屏的"点击翻不动/翻了又弹回")。轻点在 touchend 直接判定并翻页,
  // 与滑动走同一条触摸管线; 之后的合成 click 一律吞掉。
  let touchStart: TouchTrack | null = null
  doc.addEventListener('touchstart', (e: TouchEvent) => {
    // 自动滚动中手指按住正文: 先停住, 让人能自己拖着看 (松手后接着滚)
    if (autoReading.value) holdAutoScroll(60_000)
    touchStart = beginTouch(e)
    pointerTs = Date.now()
  }, { passive: true })
  doc.addEventListener('touchmove', (e: TouchEvent) => {
    const st = touchStart
    const t0 = e.changedTouches[0]
    if (!st || !t0) return
    const { dx, dy } = trackTouch(st, t0)
    crossSectionBySwipe(st, dx, dy, doc)
  }, { passive: true })
  // 捕获阶段先于 foliate 的 touchend 监听: 轻点时阻断其"吸附回当前页"动画,
  // 否则吸附动画与我们的翻页动画并发抢写滚动位置, 随机弹回 (Windows 触屏的病根)
  doc.addEventListener('touchend', (e: TouchEvent) => {
    if (autoReading.value) {
      autoHoldUntil = Date.now() + 1200
      autoPos = -1
    }
    const t0 = e.changedTouches[0]
    const st = touchStart
    touchStart = null
    if (!st || !t0) return
    const { dx, dy } = trackTouch(st, t0)
    // 翻页模式下明显的上下滑动也翻页 (上滑下一页 / 下滑上一页), 单手竖向阅读更顺手;
    // 正在选字 (长按后拖动) 不算。foliate 对竖向滑动本无动作, 但其 touchend 会做
    // 吸附动画, 与翻页动画抢滚动位置, 先拦掉
    if (effectiveFlow.value === 'paginated' && Math.abs(dy) >= 60 && Math.abs(dy) >= Math.abs(dx) * 1.5) {
      const sel = doc.getSelection()
      if (sel && !sel.isCollapsed) return
      e.stopImmediatePropagation()
      suppressClickUntil = Date.now() + 700
      turnPage(dy < 0 ? 'right' : 'left')
      return
    }
    if (st.crossed) return
    // 滚动模式也能「翻页」: 明显的左右横滑按一屏滚动 (左滑下一屏 / 右滑上一屏)
    if (effectiveFlow.value === 'scrolled' && Math.abs(dx) >= 60 && Math.abs(dx) >= Math.abs(dy) * 1.5) {
      const sel = doc.getSelection()
      if (sel && !sel.isCollapsed) return
      suppressClickUntil = Date.now() + 700
      turnPage(dx < 0 ? 'right' : 'left')
      return
    }
    // 有位移是滑动 (途中移动过也算, 哪怕松手时回到原处), 长按是选字, 都交给原有流程
    if (st.moved > 10) return
    if (Date.now() - st.t > 350) return
    e.stopImmediatePropagation()
    if (panel.value !== 'none' || settingsOpen.value || activeAnnotation.value) {
      panel.value = 'none'
      settingsOpen.value = false
      activeAnnotation.value = null
    } else {
      onContentClick(t0.clientX, doc, e.target as Element, t0.clientY)
    }
    // 吞掉这次轻点随后的合成 click (必须在处理之后设置)
    suppressClickUntil = Date.now() + 700
  }, { passive: true, capture: true })

  // OS gestures / interrupted touches may deliver cancel without end. Do not
  // leave the 60-second finger-down hold active after the reader has let go.
  doc.addEventListener('touchcancel', () => {
    touchStart = null
    if (autoReading.value) {
      autoHoldUntil = Date.now() + 1200
      autoPos = -1
      autoCarry = 0
    }
  }, { passive: true })

  // 自动滚动中拨滚轮 / 触控板: 暂缓一会儿再接着滚, 不和用户抢
  doc.addEventListener('wheel', () => { if (autoReading.value) holdAutoScroll(1500) }, { passive: true })
  // 听书时读者自己滑动正文: 暂不跟随朗读句 (见 noteReaderSteer)
  doc.addEventListener('wheel', noteReaderSteer, { passive: true })
  doc.addEventListener('touchmove', noteReaderSteer, { passive: true })
  doc.addEventListener('keydown', (e: KeyboardEvent) => {
    if (/^(ArrowUp|ArrowDown|PageUp|PageDown|Home|End| )$/.test(e.key)) noteReaderSteer()
  })

  // 指针/触摸引发的 focusin 会让 foliate 回滚到旧锚点 (表现为翻页弹回), 拦掉;
  // 键盘 Tab 导航的 focusin 不受影响
  doc.addEventListener('pointerdown', () => { pointerTs = Date.now() }, true)
  doc.addEventListener('focusin', (e: FocusEvent) => {
    if (Date.now() - pointerTs < 1000) e.stopImmediatePropagation()
  }, true)
}

let pointerTs = 0
let suppressClickUntil = 0

// ---- 触摸手势 ----
// 位移一律按屏幕坐标算。iframe 里的 clientX/Y 以正文文档为参照: 正文跟着手指滚动
// (滚动模式上下、分页模式左右) 时两者同步移动, clientY 几乎不变, 一次快速上滑会被
// 当成轻点, 落在左 / 右三分之一就整屏往回 / 往前翻, 与惯性滚动抢位置 (Surface 竖屏
// "滑着滑着往回跳")。screenX/Y 不受正文滚动影响。
interface TouchTrack {
  sx: number
  sy: number
  t: number
  /** 起手时已停在本节顶 / 底 (滚动模式) */
  atTop: boolean
  atBottom: boolean
  /** 途中离起点的最大距离 */
  moved: number
  crossed?: boolean
}

function beginTouch(e: TouchEvent): TouchTrack | null {
  const t0 = e.changedTouches[0]
  if (!t0) return null
  // 滚动模式下记下起手时是否已停在本节顶 / 底: 只有停稳后再滑才跨章, 避免惯性一滑到底就跳走
  const r = view?.renderer
  const scrolled = effectiveFlow.value === 'scrolled' && r
  return {
    sx: t0.screenX,
    sy: t0.screenY,
    t: Date.now(),
    atTop: !!scrolled && r.start <= 1,
    atBottom: !!scrolled && r.viewSize - r.end <= 2,
    moved: 0,
  }
}

function trackTouch(st: TouchTrack, t0: Touch): { dx: number; dy: number } {
  const dx = t0.screenX - st.sx
  const dy = t0.screenY - st.sy
  st.moved = Math.max(st.moved, Math.abs(dx), Math.abs(dy))
  return { dx, dy }
}

// 滚动模式: foliate 只在一节内滚动, 滑到头就停住。停在节尾继续上滑 (手指不用抬起)
// 即进入下一节, 停在节首继续下滑回到上一节末尾; renderer.next / prev 在边界处切换分节
function crossSectionBySwipe(st: TouchTrack, dx: number, dy: number, doc: Document | null) {
  // 跨章连续滚动时章与章首尾相接, 原生滚动就能滑过去
  if (st.crossed || effectiveFlow.value !== 'scrolled' || isContinuous()) return
  if (Math.abs(dy) < 48 || Math.abs(dy) < Math.abs(dx) * 1.5) return
  const sel = doc?.getSelection()
  if (sel && !sel.isCollapsed) return
  if (dy < 0 && st.atBottom) {
    st.crossed = true
    interruptTTSForReposition()
    view?.renderer?.next()
  } else if (dy > 0 && st.atTop) {
    st.crossed = true
    interruptTTSForReposition()
    view?.renderer?.prev()
  }
}

// 短章节 (只有标题的分部页等) 撑不满一屏, 下方空白在 iframe 之外, 触摸落在 foliate-view 上;
// 这里同样要能滑进下一节, 否则手指按在空白处怎么滑都过不去
let marginTouch: TouchTrack | null = null
function onMarginTouchStart(e: TouchEvent) {
  marginTouch = e.target === view ? beginTouch(e) : null
}
function onMarginTouchMove(e: TouchEvent) {
  const t0 = e.changedTouches[0]
  if (!marginTouch || !t0) return
  const { dx, dy } = trackTouch(marginTouch, t0)
  crossSectionBySwipe(marginTouch, dx, dy, null)
}

// 点正文翻页 (横屏左/右, 竖屏上/下)
let overlayDismissed = false

function onContentClick(clientX: number, doc: Document, target?: Element | null, clientY = 0) {
  if (overlayDismissed) {
    overlayDismissed = false
    return
  }
  // 开书未就绪时点击会被 view.init 的落点覆盖, 表现为翻过去又弹回
  if (loading.value) return
  // 正在选字或点了链接时不翻页 (滚动模式下翻页区同样生效: 按一屏平滑滚动)
  if (selection.value) return
  const sel = doc.getSelection()
  if (sel && !sel.isCollapsed) return
  if (target?.closest?.('a[href]')) return
  // 点到划线: 只弹划线工具条 (foliate 随后的 click 派发 show-annotation), 不翻页也不切换工具栏
  if (hitsAnnotation(view, doc, clientX, clientY)) return
  // 点睛: 点到概念 / 注释时弹出解释卡, 不翻页
  if (dj.onContentTap(doc, clientX, clientY)) return
  // 打字机 / 歌词运行时轻点只切换暂停或移动当前行, 不翻页
  const tap = modes.onContentTap({ y: clientY, doc })
  if (tap) {
    if (tap === 'paused') showBars()
    else if (tap === 'menu') barsVisible.value ? hideBars() : showBars()
    else hideBars()
    return
  }
  // iframe 内坐标换算到窗口坐标 (分页模式下 iframe 比可视区宽且随翻页平移)
  const frameRect = doc.defaultView?.frameElement?.getBoundingClientRect()
  const contentRect = container.value?.getBoundingClientRect()
  if (!frameRect || !contentRect) return
  handleTapZone(frameRect.left + clientX - contentRect.left, frameRect.top + clientY - contentRect.top, contentRect)
}

/**
 * 轻点分区 (见 services/readerTapZone): 横屏左·中·右, 竖屏上·中·下;
 * 自动翻页 / 滚动开着时不设翻页区, 整屏轻点只暂停 (并呼出工具栏) / 继续
 */
function handleTapZone(x: number, y: number, rect: DOMRect) {
  const zone = tapZone({ x, y, width: rect.width, height: rect.height, portrait: portraitView.value, autoReading: autoReading.value })
  if (autoReading.value) {
    if (autoPaused.value) {
      resumeAutoRead()
      hideBars()
    } else {
      pauseAutoRead()
      showBars()
    }
    return
  }
  if (zone === 'prev') turnPage('left')
  else if (zone === 'next') turnPage('right')
  // 中间: 呼出 / 隐藏工具栏 (沉浸式)
  else barsVisible.value ? hideBars() : showBars()
}

/**
 * 页眉页脚 (章节名 / 进度那条带) 在正文 iframe 之外, 点这里的事件落在 foliate-view 上,
 * 原本什么也不发生; 手机上拇指常点到页面最下沿, 按与正文相同的分区处理
 */
function onMarginClick(e: MouseEvent) {
  if (e.target !== view || loading.value) return
  if (panel.value !== 'none' || settingsOpen.value || activeAnnotation.value) {
    panel.value = 'none'
    settingsOpen.value = false
    activeAnnotation.value = null
    return
  }
  const rect = container.value?.getBoundingClientRect()
  if (!rect) return
  handleTapZone(e.clientX - rect.left, e.clientY - rect.top, rect)
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
    text: selection.value.text.slice(0, HIGHLIGHT_TEXT_MAX),
    color,
    createdAt: Date.now(),
  }
  const id = await storage.addAnnotation(rec)
  const saved = { ...rec, id }
  annotations.value.push(saved)
  try {
    view.addAnnotation({ value: rec.cfi, color })
  } catch { /* 绘制失败不影响保存 */ }
  dismissSelection()
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
  // Persist an empty string when clearing a saved note; undefined means no update.
  const note = noteDraft.value.trim()
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
  // 划线 / 想法: 落在焦点线; 书签记的是当时的屏幕顶, 照旧顶端对齐还原那一屏
  const go = a.kind === 'bookmark' ? view?.goTo(a.cfi) : goToText(a.cfi)
  go?.catch(() => toast(t('reader.cantGotoAnnotation'), 'error'))
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
  goToText(hit.cfi).then(() => flashText(hit.cfi), () => toast(t('reader.cantGoto'), 'error'))
}

/**
 * 跳到搜索结果后把命中的字短暂标出来 (约 2 秒淡出), 眼睛不用满屏找。
 * 与朗读句同一套主题色 (墨水屏为下划线); 减少动态效果时不渐隐, 到时直接撤下
 */
const FLASH_MARK = 'lr-search-flash'
let flashTimer: ReturnType<typeof setTimeout> | undefined
function flashText(cfi: string) {
  try {
    const resolved = view?.resolveNavigation?.(cfi)
    const shown = resolved ? loadedContent(resolved.index) : null
    const range = shown && typeof resolved.anchor === 'function' ? resolved.anchor(shown.doc) : null
    if (!shown || !isRange(range)) return
    const overlayer = (view.renderer.getContents?.() ?? []).find((c: any) => c.doc === shown.doc)?.overlayer
    if (!overlayer) return
    clearTimeout(flashTimer)
    const still = prefersReducedMotion()
    overlayer.add(FLASH_MARK, range, (rects: any[], opts: any) => {
      const g = drawListenMark(rects, opts)
      // 停留 0.8 秒后 1.2 秒渐隐 (redraw 时重新开始, 不影响撤下的时间)
      if (!still) try { g.animate([{ opacity: g.style.opacity }, { opacity: g.style.opacity, offset: 0.4 }, { opacity: 0 }], { duration: 2000, fill: 'forwards' }) } catch { /* 无 Web Animations: 到时直接撤下 */ }
      return g
    }, { mark: listenMark.value, padding: 1 })
    flashTimer = setTimeout(() => { try { overlayer.remove(FLASH_MARK) } catch { /* 分节已卸载 */ } }, still ? 1500 : 2000)
  } catch { /* 定位失败: 不标也能看 */ }
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
  const forListening = listenToc.value
  listenToc.value = false
  panel.value = 'none'
  if (forListening) stopTTS()
  else interruptTTSForReposition()
  await untilLoaded()
  try {
    await view?.goTo(href)
    if (forListening) { ttsPanel.value = true; await startTTS('page') }
  } catch { toast(t('reader.cantGoto'), 'error') }
}

/** 上一章 / 下一章: 按目录条目跳转; 书无目录时退回按分节跳 */
function gotoChapter(dir: -1 | 1) {
  interruptTTSForReposition()
  const flat = flattenToc(toc.value).filter(item => item.href)
  const i = flat.findIndex(item => item.href === currentTocHref.value)
  if (flat.length && i >= 0) {
    const target = flat[i + dir]
    if (target) view?.goTo(target.href).catch(() => toast(t('reader.cantGoto'), 'error'))
    return
  }
  // 当前位置在首个目录项之前 (如扉页): 下一章即第一项
  if (flat.length && dir > 0 && !currentTocHref.value) {
    view?.goTo(flat[0].href).catch(() => toast(t('reader.cantGoto'), 'error'))
    return
  }
  if (dir < 0) view?.renderer?.prevSection?.()
  else view?.renderer?.nextSection?.()
}

function onSlide(e: Event) {
  const value = parseFloat((e.target as HTMLInputElement).value)
  slidePreview.value = null
  void jumpTo({ fraction: value })
}

// ---- 拖动进度条预览: 松手前就知道会跳到哪一章、第几页 ----
const slidePreview = ref<{ fraction: number; label: string; text: string } | null>(null)

function onSlideInput(e: Event) {
  const value = parseFloat((e.target as HTMLInputElement).value)
  let label = ''
  let page = 0
  let total = 0
  if (view?.isFixedLayout) {
    total = pageInfo.value?.total ?? 0
    page = total ? Math.min(total, Math.floor(value * total) + 1) : 0
  } else {
    const hit = fractionToPage(secSizes, secCounts, value)
    if (hit) {
      page = hit.page
      total = pageInfo.value?.total ?? 0
      label = chapterAtFraction(value, hit.index)
    }
  }
  const parts: string[] = []
  if (page && total && settings.readerPrefs.progressDisplay !== 'percent') parts.push(`${page} / ${total}`)
  if (!parts.length || settings.readerPrefs.progressDisplay !== 'page') parts.push(`${(value * 100).toFixed(1)}%`)
  slidePreview.value = { fraction: value, label, text: parts.join(' · ') }
}

// ---- 跳页: 点底栏页码输入页码或百分比; 跳转后可一键回到原来的位置 ----
const jumpOpen = ref(false)
const jumpText = ref('')
const jumpError = ref('')
const jumpInputEl = ref<HTMLInputElement>()
const jumpMode = ref<'page' | 'percent'>('page')
function setJumpMode(mode: 'page' | 'percent') {
  jumpMode.value = mode
  jumpText.value = String(mode === 'page' ? pageInfo.value?.current ?? 1 : Number((fraction.value * 100).toFixed(1)))
  jumpError.value = ''
}
/** 跳转前的位置; 有值时底栏上方出现「回到第 N 页」 */
const jumpBack = ref<{ cfi: string; label: string } | null>(null)
let jumpBackTimer: ReturnType<typeof setTimeout> | undefined

const jumpMeta = computed(() => {
  const p = pageInfo.value
  const parts: string[] = []
  if (p) parts.push(t('reader.pageOfTotal', { page: pageRangeText.value, total: p.total }))
  if (printPage.value) parts.push(t('reader.printPage', { n: printPage.value }))
  return parts.join(' · ')
})

function toggleJump() {
  const next = !jumpOpen.value
  closeOverlays()
  jumpOpen.value = next
  if (!next) return
  setJumpMode('page')
  showBars()
  void nextTick(() => jumpInputEl.value?.focus())
}

async function jumpTo(target: { fraction: number } | number) {
  if (!view) return
  const from = currentCfi.value
  const label = pageInfo.value && settings.readerPrefs.progressDisplay !== 'percent'
    ? t('reader.jumpBack', { page: pageInfo.value.current })
    : `${t('common.back')} ${percentText.value}`
  interruptTTSForReposition()
  try {
    await view.goTo(target)
  } catch {
    toast(t('reader.cantGoto'), 'error')
    return
  }
  if (!from || from === currentCfi.value) return
  jumpBack.value = { cfi: from, label }
  clearTimeout(jumpBackTimer)
  jumpBackTimer = setTimeout(() => { jumpBack.value = null }, 12000)
  showBars(true)
}

async function confirmJump() {
  const total = pageInfo.value?.total ?? 0
  const parsed = parseJumpInput(jumpMode.value === 'percent' && !jumpText.value.includes('%') ? jumpText.value + '%' : jumpText.value, total)
  if (!parsed) {
    jumpError.value = t('reader.jumpInvalid', { total: total || 1 })
    return
  }
  let target: { fraction: number } | number | null
  if ('fraction' in parsed) target = { fraction: parsed.fraction }
  else if (view?.isFixedLayout) target = parsed.page - 1
  else {
    const f = pageToFraction(secSizes, secCounts, parsed.page, {
      perScreen: pagesPerScreen,
      scrolled: effectiveFlow.value === 'scrolled',
    })
    target = f == null ? null : { fraction: f }
  }
  if (target == null) return
  jumpError.value = ''
  await jumpTo(target)
}

function goJumpBack() {
  const back = jumpBack.value
  jumpBack.value = null
  clearTimeout(jumpBackTimer)
  if (!back) return
  interruptTTSForReposition()
  view?.goTo(back.cfi).catch(() => toast(t('reader.cantGoto'), 'error'))
}

// ---- 阅读模式 (打字机等, 见 docs/reading-modes.md); 选项都是闭包, 用到时才取值 ----
const modes = useReadingModes({
  getView: () => view,
  getColors: () => themeColors.value,
  pingReadingAuto,
  appDark: () => appDark.value,
  onExclusiveStart: () => {
    stopAutoRead()
    if (ttsState.value === 'playing') pauseTTS()
  },
  stopAutoRead,
  pauseTTS: () => { if (ttsState.value === 'playing') pauseTTS() },
  isAutoReading: () => autoReading.value,
  isTTSActive: () => ttsState.value === 'playing',
  pauseWhen: () => panel.value !== 'none' || settingsOpen.value || ttsPanel.value || jumpOpen.value || ambientPanel.value
    || !!activeAnnotation.value || !!lateDj.value?.overlayOpen.value,
  beforePanelOpen: closeOverlays,
  // 沉浸: 安卓隐藏系统栏 + 常亮 (网页 / 桌面用 Wake Lock), 并收起工具栏
  onImmersiveChange: on => {
    setSystemBarsHidden(on)
    void setKeepScreenOn(on)
    if (on) hideBars()
  },
  refreshMarginals: () => updateMarginals(),
  onReminder: () => stopAutoRead(),
  // 跟听书的歌词: 点了另一行 → 听书从那一句读
  onLyricSeek: range => { void startTTS({ range }) },
})
lateModes.value = modes

// 安卓音量键翻页: 只在正文打开、没有面板、听书没在播时接管音量键, 其余时候照常调音量
const volumeKeysActive = computed(() => settings.volumeKeyTurn && !loading.value && !error.value
  && ttsState.value !== 'playing' && !anyOverlayOpen())
watch(volumeKeysActive, on => setVolumeKeyHandler(on ? turnPageByVolume : null), { immediate: true })

// ---- 点睛阅读 (docs/dianjing-reading.md) ----
const dj = useDianjing({
  densityAmount: () => engineDensity(settings.dianjing),
  getView: () => view,
  goToText: cfi => goToText(cfi),
  bookId,
  getMeta: () => meta.value && {
    title: meta.value.title,
    author: meta.value.author,
    language: (meta.value as any).language,
    tags: (meta.value as any).tags,
    // EPUB 只有一个 dc:subject 时 foliate 给的是单个值而不是数组
    subjects: ([] as any[]).concat(view?.book?.metadata?.subject ?? []).map((x: any) => (typeof x === 'string' ? x : x?.name ?? '')),
  },
  getThemeName: () => djThemeName(resolveReaderTheme(settings.readerPrefs.theme, appDark.value), !!lateModes.value?.einkActive.value),
  isEink: () => !!lateModes.value?.einkActive.value,
  // 「我也觉得」: 收为自己的划线 (与划词划线同一份存储, 会随同步)
  adoptHighlight: async ({ index, range, text, withNote }) => {
    let cfi = ''
    try { cfi = view.getCFI(index, range) } catch { return }
    const storage = await getStorage()
    const rec: Omit<AnnotationRec, 'id'> = { bookId, kind: 'highlight', cfi, text: text.slice(0, HIGHLIGHT_TEXT_MAX), color: 'yellow', createdAt: Date.now() }
    const id = await storage.addAnnotation(rec)
    const saved = { ...rec, id }
    annotations.value.push(saved)
    try { view.addAnnotation({ value: cfi, color: 'yellow' }) } catch { /* 绘制失败不影响保存 */ }
    if (withNote) {
      noteDraft.value = ''
      activeAnnotation.value = saved
    } else toast(t('reader.highlighted'), 'success')
  },
  openAi: prompt => {
    closeOverlays()
    panel.value = 'ai'
    void sendAi(prompt)
  },
  beforeOverlay: closeOverlays,
  // 点睛阅读基础版 = 按词着色 (绘制在阅读模式里)
  basic: {
    isOn: () => settings.readingMode.wordGuide.enabled,
    set: on => modes.setWordGuide(on),
    supported: () => modes.supported.value && modes.wordGuideSupported.value,
    keyWordsSupported: () => modes.keyWordsSupported.value,
  },
  // 智能版的 AI 重点词到了: 「重点词」层重新取词 (逐块替换离线结果)
  onKeyWords: () => modes.refreshKeyWords(),
})
lateDj.value = dj

// 「重点词」(点睛阅读): 书的分节 (后台全书统计)、体裁 (小说不剧透)、智能版的 AI 词
modes.setKeyWordSource({
  bookId,
  metadata: () => ({
    title: meta.value?.title,
    tags: [...(meta.value?.tags ?? [])],
    subjects: ([] as any[]).concat(view?.book?.metadata?.subject ?? []).map((x: any) => typeof x === 'string' ? x : x?.name ?? ''),
  }),
  fiction: () => dj.fiction.value,
  smart: (doc, section) => dj.engine.keyWordInput(section, doc),
  sectionCount: () => view?.book?.sections?.length ?? 0,
  sectionLinear: i => view?.book?.sections?.[i]?.linear !== 'no',
  sectionDoc: async i => {
    const sec = view?.book?.sections?.[i]
    return sec?.createDocument ? await sec.createDocument() : null
  },
})

// 排版相关的阅读模式 (大字 / 墨水屏 / 歌词等) 切换后重排正文; 放在 modes 声明之后 (watch 立即求值)
watch(() => modes.renderKey.value, () => {
  clearTimeout(prefsTimer)
  prefsTimer = setTimeout(applyPrefs, 60)
})
const readingModeActive = computed(() => modes.panelOpen.value || autoReading.value || modes.progressActive.value)

/**
 * 打字机的进度与剩余时间: 与听书同一套页码模型 (每页字数 × 剩余页数), 速度取设定值;
 * 西文按词/分换算为字母/分 (约 5 个字母一个词), 开了标点停顿再放宽一成。
 */
const typewriterProgress = computed<ReadingModeProgress | null>(() => {
  if (!modes.progressActive.value) return null
  const p = pageInfo.value
  let eta: { chapter: number; book: number } | null = null
  if (p && charsPerPage.value && !fixedLayout.value) {
    const perMinute = modes.speedUnit.value === 'cpm' ? modes.speed.value : modes.speed.value * 5
    const factor = settings.readingMode.typewriter.punctuationPause ? 1.1 : 1
    const secondsPerPage = charsPerPage.value / (perMinute / 60) * factor
    const halfScreen = (p.last - p.current + 1) / 2
    eta = {
      chapter: ((chapterLeft.value ?? p.sectionLeft) + halfScreen) * secondsPerPage,
      book: (p.total - p.last + halfScreen) * secondsPerPage,
    }
  }
  return {
    chapter: chapterLabel.value || meta.value?.title || '',
    chapterProgress: chapterProgress.value ?? fraction.value,
    chapterLeft: eta ? t('tts.chapterLeft', { time: humanTime(eta.chapter) }) : '',
    chapterLeftShort: eta ? humanTime(eta.chapter) : '',
    finish: eta ? clockText(eta.chapter, 'read') : '',
    book: eta ? t('tts.bookSummary', { pct: percentText.value, time: humanTime(eta.book) }) : t('readingMode.bookPercent', { pct: percentText.value }),
    percent: percentText.value,
  }
})

// 「几点读完」随时间刷新
let twClockTimer: ReturnType<typeof setInterval> | undefined
// 打字机 / 歌词开始: 收起工具栏, 页脚让给状态条; 结束后恢复页脚
watch(() => modes.progressActive.value, on => {
  if (on) hideBars()
  updateMarginals()
})

watch(() => modes.progressActive.value, on => {
  clearInterval(twClockTimer)
  if (on) {
    nowTick.value = Date.now()
    twClockTimer = setInterval(() => { nowTick.value = Date.now() }, 30000)
  }
})

function resetAutoScrollClock() { autoClock.reset() }

watch(() => [panel.value, settingsOpen.value, ttsPanel.value, modes.panelOpen.value, ambientPanel.value, dj.consentOpen.value, dj.card.value, dj.outlineOpen.value, dj.skimOpen.value], async (_state, _old, cleanup) => {
  if (!sheetOpen.value) return
  let disposed = false
  const previous = document.activeElement as HTMLElement | null
  const held: Array<[HTMLElement, boolean]> = []
  let dialog: HTMLElement | null = null
  const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [href], [tabindex="0"], summary') ?? []).filter(el => el.getClientRects().length && !el.closest('[inert]'))
  const trap = (event: KeyboardEvent) => {
    if (event.key !== 'Tab' || document.querySelector('[data-app-modal]')) return
    const items = focusable(), first = items[0], last = items.at(-1)
    if (!first) { event.preventDefault(); dialog?.focus(); return }
    if (event.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) { event.preventDefault(); first.focus() }
  }
  cleanup(() => {
    disposed = true
    document.removeEventListener('keydown', trap, true)
    held.forEach(([el, inert]) => { el.inert = inert })
    if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true })
  })
  await nextTick()
  if (disposed) return
  const root = document.querySelector('.reader')
  dialog = root?.querySelector<HTMLElement>('.dj-consent, .dj-card, .dj-outline, .dj-skim, .settings-pop, .rm-panel, .tts-panel, .panel, .ambient-panel') ?? null
  if (!dialog) return
  dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.tabIndex = -1
  root?.querySelectorAll<HTMLElement>(':scope > .content, :scope > .bar, :scope > .listen-entry').forEach(el => { held.push([el, el.inert]); el.inert = true })
  document.addEventListener('keydown', trap, true)
  ;(focusable()[0] ?? dialog).focus({ preventScroll: true })
})

watch(sheetOpen, (open, _previous, cleanup) => {
  if (!open) return
  let disposed = false
  let unregister: (() => void) | undefined
  const closeTopPanel = () => {
    if (document.querySelector('[data-app-modal]')) return
    closeOverlays()
  }
  if (isTauri() && /Android/i.test(navigator.userAgent)) {
    void import('@tauri-apps/api/app').then(async ({ onBackButtonPress }) => {
      if (disposed) return
      const listener = await onBackButtonPress(closeTopPanel)
      if (disposed) await listener.unregister()
      else unregister = () => { void listener.unregister() }
    }).catch(() => {})
  }
  const Watcher = (window as unknown as { CloseWatcher?: new () => EventTarget & { destroy(): void } }).CloseWatcher
  const watcher = Watcher ? new Watcher() : null
  watcher?.addEventListener('close', closeTopPanel)
  cleanup(() => { disposed = true; unregister?.(); watcher?.destroy() })
})

/** 阅读页: 系统选字菜单让位给划线工具条; 输入框获得焦点时还给系统 (粘贴等) */
const onFocusIn = (e: FocusEvent) => { if ((e.target as Element)?.matches?.('input, textarea, [contenteditable]')) setNativeSelectionMenu(true) }
const onFocusOut = (e: FocusEvent) => { if ((e.target as Element)?.matches?.('input, textarea, [contenteditable]')) setNativeSelectionMenu(false) }
onMounted(() => {
  setNativeSelectionMenu(false)
  document.addEventListener('focusin', onFocusIn)
  document.addEventListener('focusout', onFocusOut)
})
onBeforeUnmount(() => {
  setNativeSelectionMenu(true)
  document.removeEventListener('focusin', onFocusIn)
  document.removeEventListener('focusout', onFocusOut)
})

onMounted(async () => {
  document.addEventListener('visibilitychange', resetAutoScrollClock)
  // 匿名使用统计: 今天打开过书 (每天一次, 设置 → 隐私 可关闭)
  void pingUsage(true)
  // 手机切后台时背景音暂停, 但听书在播时跟随听书的后台策略
  ambient.setPauseWhenHidden(() => ttsState.value !== 'playing')
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
    // PDF: 原版走 PDF 阅读器; 电子书形态在这里打开重排包
    if (meta.value.format === 'pdf' && pdfOpenView(meta.value, settings.pdfReflowDefault) === 'original') {
      router.replace(`/read-paper/${bookId}`)
      return
    }
    if (meta.value.format === 'djvu') {
      router.replace(`/read-djvu/${bookId}`)
      return
    }
    // PDF 的原版批注 (页内坐标) 与电子书划线 (CFI) 各自显示
    const stored = await storage.listAnnotations(bookId)
    annotations.value = meta.value.format === 'pdf' ? stored.filter(a => a.cfi.startsWith('epubcfi(')) : stored

    const blob = await storage.getBookFile(bookId)
    let file: File | null = null
    let pdfBook: ReflowBook | null = null
    if (meta.value.format === 'pdf') {
      pdfBook = await openPdfEbook(blob)
      if (!pdfBook) return
    } else if (isTextLike(meta.value.format)) {
      const { epub } = await convertToEpub(blob, meta.value.fileName, meta.value.format as 'txt' | 'md' | 'html')
      file = new File([epub], `${meta.value.title}.epub`, { type: 'application/epub+zip' })
    } else if (meta.value.format === 'cbr') {
      const { cbrToCbz } = await import('../../services/comic.ts')
      file = new File([await cbrToCbz(blob)], `${meta.value.title}.cbz`)
    } else {
      file = new File([blob], meta.value.fileName)
    }

    await import('foliate-js/view.js')
    Overlayer = (await import('foliate-js/overlayer.js')).Overlayer

    view = document.createElement('foliate-view')
    view.style.width = '100%'
    view.style.height = '100%'
    syncViewColorScheme()
    container.value!.append(view)

    view.addEventListener('relocate', onRelocate)
    view.addEventListener('click', onMarginClick)
    view.addEventListener('touchstart', onMarginTouchStart, { passive: true })
    view.addEventListener('touchmove', onMarginTouchMove, { passive: true })
    // 正文两侧留白处滚轮 / 滑动、鼠标拖滚动条 (滚动容器在渲染器的 shadow DOM 里, 事件落在 foliate-view 上)
    view.addEventListener('wheel', noteReaderSteer, { passive: true })
    view.addEventListener('touchmove', noteReaderSteer, { passive: true })
    view.addEventListener('pointerdown', (e: PointerEvent) => { if (e.pointerType === 'mouse') noteReaderSteer() })
    view.addEventListener('load', onSectionLoad)
    view.addEventListener('create-overlay', () => drawStoredAnnotations())
    view.addEventListener('draw-annotation', (e: CustomEvent) => {
      const { draw, annotation } = e.detail
      draw(Overlayer.highlight, { color: HIGHLIGHT_COLORS[annotation.color] ?? annotation.color })
    })
    view.addEventListener('show-annotation', (e: CustomEvent) => {
      const found = annotations.value.find(a => a.cfi === e.detail.value)
      if (found) {
        selection.value = null
        placeSelTools(e.detail.range)
        hlMenu.value = { anno: found }
      }
    })

    if (pdfBook) {
      await view.open(pdfBook.book)
    } else {
      const { makeFoliateBook } = await import('../../services/foliateBook.ts')
      await view.open(await makeFoliateBook(file!))
    }
    // 跨章连续滚动的渲染器事件 (view 不转发): 主章切换、远处分节卸载。旧版渲染器不会派发
    view.renderer?.addEventListener?.('section-change', onRendererSectionChange)
    view.renderer?.addEventListener?.('unload', onRendererUnload)
    toc.value = view.book?.toc ?? []
    secSizes = sectionSizes(view.book?.sections ?? [])
    bookCjk.value = view.language?.isCJK ?? true
    loadPageMeasure()
    void buildTocAnchors()
    applyPrefs()
    // 文本类书籍的内存 EPUB 版式变过 (v2: 多章合为一个分节), 旧版式下存的 CFI 指向别处;
    // 这类书首次用新版式打开时按阅读进度比例定位, 之后照常用 CFI
    const layoutKey = `lightread-text-layout:${bookId}`
    let staleTextLocation = false
    if (isTextLike(meta.value.format) && meta.value.location) {
      try { staleTextLocation = localStorage.getItem(layoutKey) !== TEXT_EPUB_LAYOUT } catch { /* 存储不可用时按新版式处理 */ }
    }
    if (pdfBook) {
      const start = reflowStart()
      await view.init(start.cfi ? { lastLocation: start.cfi } : {})
      if (start.href) await view.goTo(start.href)
    // 只有进度比例、没有位置的书 (如由 MOBI 等转换来的 EPUB): 按比例定位
    } else if (staleTextLocation || (!meta.value.location && meta.value.progress)) {
      await view.init({})
      if (meta.value.progress) await view.goToFraction(meta.value.progress)
    } else {
      await view.init({ lastLocation: meta.value.location })
    }
    if (isTextLike(meta.value.format)) {
      try { localStorage.setItem(layoutKey, TEXT_EPUB_LAYOUT) } catch { /* 忽略 */ }
    }
    loading.value = false
    if (flattenToc(toc.value).length <= 1) void applySmartToc()
  } catch (e: any) {
    console.error(e)
    error.value = e?.message ?? t('reader.cantOpenBook')
  } finally {
    loading.value = false
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', resetAutoScrollClock)
  setPageBarsDark(null)
  setVolumeKeyHandler(null)
  window.removeEventListener('keydown', handleKeydown)
  document.removeEventListener('fullscreenchange', syncFullscreenState)
  // 回藏书页时恢复窗口状态
  if (isFullscreen.value) toggleFullscreen()
  clearTimeout(saveTimer)
  // 离开前把节流中的最新进度写下
  if (pendingProgress) library.saveProgress(bookId, pendingProgress.cfi, pendingProgress.frac)
  pendingProgress = null
  clearTimeout(pageSaveTimer)
  clearTimeout(jumpBackTimer)
  clearTimeout(tocFractionTimer)
  clearInterval(nowTimer)
  clearInterval(twClockTimer)
  if (pageMeasure.key) {
    try { localStorage.setItem(PAGE_MEASURE_KEY, JSON.stringify(pageMeasure)) } catch { /* 忽略 */ }
  }
  stopAutoRead()
  stopTTS()
  modes.dispose()
  dj.dispose()
  // 背景音属于阅读场景, 离开阅读器即淡出停止
  ambient.stop()
  ambient.setPauseWhenHidden(null)
  view?.close?.()
  view?.remove()
  reflowAbort?.abort()
  reflow?.dispose()
  reflow = null
})
</script>

<template>
  <div class="reader" :class="[{ 'bars-on': barsVisible, 'no-side-nav': portraitView || autoReading }, modes.shellClass.value]" :style="{ background: themeColors.bg, color: themeColors.fg }">
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
      <!-- 听书中且工具栏显示时, 胶囊收进顶栏中间 -->
      <ListenCapsule
        v-if="ttsChipInBar"
        variant="bar"
        v-bind="capsuleProps"
        @open="openTTSPanel"
        @toggle="ttsState === 'playing' ? pauseTTS() : resumeTTS()"
        @back="returnToListening"
        @stop="stopTTS()"
      />
      <div class="bar-actions">
        <button v-if="isPdf" class="pdf-switch" :title="t('reader.pdfToOriginalTitle')" :aria-label="t('reader.pdfToOriginal')" @click="switchToOriginal">
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5"/></svg>
          <span class="pdf-switch-long">{{ t('reader.pdfToOriginal') }}</span>
          <span class="pdf-switch-short">{{ t('reader.pdfToOriginalShort') }}</span>
        </button>
        <button class="icon-btn desk-only" :title="t('reader.toc')" @click="togglePanel('toc')">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M4 6a1 1 0 0 1 1-1h1a1 1 0 0 1 0 2H5a1 1 0 0 1-1-1zm5 0a1 1 0 0 1 1-1h9a1 1 0 1 1 0 2h-9a1 1 0 0 1-1-1zM4 12a1 1 0 0 1 1-1h1a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1zm5 0a1 1 0 0 1 1-1h9a1 1 0 1 1 0 2h-9a1 1 0 0 1-1-1zM4 18a1 1 0 0 1 1-1h1a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1zm5 0a1 1 0 0 1 1-1h9a1 1 0 1 1 0 2h-9a1 1 0 0 1-1-1z"/></svg>
        </button>
        <button class="icon-btn desk-only" :title="t('reader.annotationsBookmarks')" @click="togglePanel('annotations')">
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
        <button class="icon-btn desk-only" :class="{ 'auto-on': ttsState !== 'stopped' }" :title="t('tts.title')" @click="openTTSPanel">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 3a7 7 0 0 0-7 7v1.1A3.5 3.5 0 0 0 3 14.5v2A3.5 3.5 0 0 0 6.5 20H8a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1h-.9A5 5 0 0 1 12 5a5 5 0 0 1 4.9 6H16a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h1.5a3.5 3.5 0 0 0 3.5-3.5v-2a3.5 3.5 0 0 0-2-3.16V10a7 7 0 0 0-7-7z"/></svg>
        </button>
        <button class="icon-btn" :class="{ 'auto-on': panel === 'ai' }" :title="t('ai.title')" @click="togglePanel('ai')">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 2.5a1 1 0 0 1 .95.69l1.4 4.3a3 3 0 0 0 1.92 1.92l4.3 1.4a1 1 0 0 1 0 1.9l-4.3 1.4a3 3 0 0 0-1.92 1.92l-1.4 4.3a1 1 0 0 1-1.9 0l-1.4-4.3a3 3 0 0 0-1.92-1.92l-4.3-1.4a1 1 0 0 1 0-1.9l4.3-1.4a3 3 0 0 0 1.92-1.92l1.4-4.3A1 1 0 0 1 12 2.5zm7.5 12.7a.8.8 0 0 1 .76.55l.42 1.28a1.6 1.6 0 0 0 1.02 1.02l1.28.42a.8.8 0 0 1 0 1.52l-1.28.42a1.6 1.6 0 0 0-1.02 1.02l-.42 1.28a.8.8 0 0 1-1.52 0l-.42-1.28a1.6 1.6 0 0 0-1.02-1.02l-1.28-.42a.8.8 0 0 1 0-1.52l1.28-.42a1.6 1.6 0 0 0 1.02-1.02l.42-1.28a.8.8 0 0 1 .76-.55z"/></svg>
        </button>
        <button
          class="icon-btn ambient-btn"
          :class="{ 'auto-on': ambientPanel || ambient.state.playing }"
          :title="t('ambient.title')"
          :aria-label="t('ambient.title')"
          @click="toggleAmbientPanel"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 3a1 1 0 0 1 1 1v16a1 1 0 1 1-2 0V4a1 1 0 0 1 1-1zM8 7a1 1 0 0 1 1 1v8a1 1 0 1 1-2 0V8a1 1 0 0 1 1-1zm8 0a1 1 0 0 1 1 1v8a1 1 0 1 1-2 0V8a1 1 0 0 1 1-1zM4 10a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 1-1zm16 0a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 1-1z"/></svg>
          <span v-if="ambient.state.playing" class="ambient-dot" aria-hidden="true" />
        </button>
        <button class="icon-btn" :title="t('reader.searchInBook')" @click="togglePanel('search')">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M10.5 3a7.5 7.5 0 1 0 4.55 13.46l3.75 3.75a1 1 0 0 0 1.4-1.42l-3.74-3.74A7.5 7.5 0 0 0 10.5 3zM5 10.5a5.5 5.5 0 1 1 11 0 5.5 5.5 0 0 1-11 0z"/></svg>
        </button>
        <button
          class="icon-btn desk-only"
          :class="{ 'auto-on': readingModeActive }"
          :title="t('readingMode.title')"
          :aria-label="t('readingMode.title')"
          @click="modes.togglePanel()"
        >
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm-1.8 4.4 5.4 3.1a.6.6 0 0 1 0 1l-5.4 3.1a.6.6 0 0 1-.9-.5V8.9a.6.6 0 0 1 .9-.5z"/></svg>
        </button>
        <button class="icon-btn desk-only" :title="t('reader.typography')" @click="toggleSettings">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M11.1 4.55a1 1 0 0 1 1.8 0l5.6 12.02a1 1 0 1 1-1.81.86L15.3 14.5H8.7l-1.39 2.93a1 1 0 1 1-1.8-.86L11.1 4.55zM9.64 12.5h4.72L12 7.36 9.64 12.5z"/></svg>
        </button>
        <button class="icon-btn desk-only" :class="{ 'auto-on': isFullscreen }" :title="isFullscreen ? t('reader.exitFullscreen') : t('reader.fullscreen')" @click="toggleFullscreen">
          <svg v-if="!isFullscreen" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M4 9a1 1 0 0 1-1-1V5a2 2 0 0 1 2-2h3a1 1 0 0 1 0 2H5v3a1 1 0 0 1-1 1zm16 0a1 1 0 0 1-1-1V5h-3a1 1 0 1 1 0-2h3a2 2 0 0 1 2 2v3a1 1 0 0 1-1 1zM4 15a1 1 0 0 1 1 1v3h3a1 1 0 1 1 0 2H5a2 2 0 0 1-2-2v-3a1 1 0 0 1 1-1zm16 0a1 1 0 0 1 1 1v3a2 2 0 0 1-2 2h-3a1 1 0 1 1 0-2h3v-3a1 1 0 0 1 1-1z"/></svg>
          <svg v-else viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M8 3a1 1 0 0 1 1 1v3a2 2 0 0 1-2 2H4a1 1 0 0 1 0-2h3V4a1 1 0 0 1 1-1zm8 0a1 1 0 0 1 1 1v3h3a1 1 0 1 1 0 2h-3a2 2 0 0 1-2-2V4a1 1 0 0 1 1-1zM4 15h3a2 2 0 0 1 2 2v3a1 1 0 1 1-2 0v-3H4a1 1 0 0 1 0-2zm13 0h3a1 1 0 1 1 0 2h-3v3a1 1 0 1 1-2 0v-3a2 2 0 0 1 2-2z"/></svg>
        </button>
      </div>
    </header>

    <!-- 正文 -->
    <div ref="container" class="content" />

    <div v-if="loading" class="state">
      <template v-if="convertFraction !== null">
        <p class="convert-text">{{ t('reader.pdfConverting', { pct: Math.round(convertFraction * 100) }) }}</p>
        <div class="convert-bar" role="progressbar" :aria-valuenow="Math.round(convertFraction * 100)" aria-valuemin="0" aria-valuemax="100">
          <span :style="{ width: `${Math.round(convertFraction * 100)}%` }" />
        </div>
        <p class="convert-hint">{{ t('reader.pdfConvertHint') }}</p>
        <button class="btn" @click="viewOriginalNow">{{ t('reader.pdfViewOriginalNow') }}</button>
      </template>
      <template v-else>{{ t('reader.opening') }}</template>
    </div>
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

    <!-- 底栏: 章节跳转 + 进度; 手机端下方再加一排常用入口 (目录 / 笔记 / 听书 / 自动 / 排版) -->
    <footer class="bar bottom" :class="{ hidden: !barsVisible }" @mouseenter="cancelBarsTimer">
      <div class="progress-meta"><span class="progress-chapter">{{ chapterLabel || meta?.title }}</span>        <button
          class="percent progress-label"
          :class="{ active: jumpOpen }"
          :title="t('reader.jumpTo')"
          :aria-label="`${t('reader.jumpTo')} · ${progressText}`"
          :aria-expanded="jumpOpen"
          @click="toggleJump"
        >
          <span v-if="showPage" class="page-number">
            <b>{{ pageRangeText }}</b><span class="of">/{{ pageInfo!.total }}</span>
          </span>
          <span v-if="showPage && showPercent" class="sep" aria-hidden="true">·</span>
          <span v-if="showPercent" class="pct">{{ percentText }}</span>
        </button></div>
      <div class="progress-row">
        <button class="icon-btn chapter-btn" :title="t('reader.prevChapter')" :aria-label="t('reader.prevChapter')" @click="gotoChapter(-1)">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M18.7 5.3a1 1 0 0 1 0 1.4L13.42 12l5.3 5.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0zM7 5a1 1 0 0 1 1 1v12a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1z"/></svg>
        </button>
        <div class="slider-wrap">
          <input
            class="slider"
            type="range"
            min="0"
            max="1"
            step="0.0005"
            :value="slidePreview ? slidePreview.fraction : fraction"
            :aria-label="t('reader.progress')"
            :aria-valuetext="progressText"
            @input="onSlideInput"
            @change="onSlide"
            @blur="slidePreview = null"
          />
          <div
            v-if="slidePreview"
            class="slide-bubble"
            :style="{ left: `clamp(64px, ${slidePreview.fraction * 100}%, calc(100% - 64px))` }"
            aria-hidden="true"
          >
            <strong v-if="slidePreview.label">{{ slidePreview.label }}</strong>
            <span>{{ slidePreview.text }}</span>
          </div>
        </div>
        <button class="icon-btn chapter-btn" :title="t('reader.nextChapter')" :aria-label="t('reader.nextChapter')" @click="gotoChapter(1)">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M5.3 5.3a1 1 0 0 1 1.4 0l6 6a1 1 0 0 1 0 1.4l-6 6a1 1 0 0 1-1.4-1.4l5.29-5.3-5.3-5.3a1 1 0 0 1 0-1.4zM17 5a1 1 0 0 1 1 1v12a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1z"/></svg>
        </button>

      </div>
      <nav class="dock" :aria-label="t('reader.readerTools')">
        <button :class="{ active: panel === 'toc' }" @click="togglePanel('toc')">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M4 6a1 1 0 0 1 1-1h1a1 1 0 0 1 0 2H5a1 1 0 0 1-1-1zm5 0a1 1 0 0 1 1-1h9a1 1 0 1 1 0 2h-9a1 1 0 0 1-1-1zM4 12a1 1 0 0 1 1-1h1a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1zm5 0a1 1 0 0 1 1-1h9a1 1 0 1 1 0 2h-9a1 1 0 0 1-1-1zM4 18a1 1 0 0 1 1-1h1a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1zm5 0a1 1 0 0 1 1-1h9a1 1 0 1 1 0 2h-9a1 1 0 0 1-1-1z"/></svg>
          <span>{{ t('reader.toc') }}</span>
        </button>
        <button :class="{ active: panel === 'annotations' }" @click="togglePanel('annotations')">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19a1 1 0 0 1 1 1v15a2 2 0 0 1-2 2H6.5A2.5 2.5 0 0 1 4 18.5v-13zM6.5 5a.5.5 0 0 0-.5.5v11.34c.16-.05.33-.08.5-.08H18V5H6.5z"/></svg>
          <span>{{ t('reader.dockNotes') }}</span>
        </button>
        <button :class="{ active: jumpOpen }" @click="toggleJump">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2" fill="var(--card)"/><circle cx="16" cy="12" r="2" fill="var(--card)"/><circle cx="7" cy="18" r="2" fill="var(--card)"/></svg>
          <span>{{ t('reader.progress') }}</span>
        </button>
        <button :class="{ active: readingModeActive }" :aria-label="t('readingMode.title')" @click="modes.togglePanel()">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M6 3h9.59L20 7.41V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm1 2v14h11V8.24L14.76 5H7zm2 4h6a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2zm0 4h3a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2zm6 0h.5a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 .5-1z"/></svg>
          <span>{{ t('readingMode.dock') }}</span>
        </button>
        <button :class="{ active: settingsOpen }" @click="toggleSettings">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M11.1 4.55a1 1 0 0 1 1.8 0l5.6 12.02a1 1 0 1 1-1.81.86L15.3 14.5H8.7l-1.39 2.93a1 1 0 1 1-1.8-.86L11.1 4.55zM9.64 12.5h4.72L12 7.36 9.64 12.5z"/></svg>
          <span>{{ t('reader.dockTypography') }}</span>
        </button>
      </nav>
    </footer>

    <button v-if="barsVisible && !sheetOpen && !loading && !error && ttsState === 'stopped'" class="listen-entry" :aria-label="t('tts.title')" @click="openTTSPanel">
      <svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M4 14v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="12" width="4" height="8" rx="2"/><rect x="17" y="12" width="4" height="8" rx="2"/></svg>
      <span>{{ t('tts.title') }}</span>
    </button>

    <!-- 手机端面板为底部抽屉, 点遮罩收起 -->
    <div v-if="sheetOpen" class="sheet-scrim" aria-hidden="true" @click="closeOverlays" />

    <AppModal v-if="jumpOpen" :title="t('reader.progress')" @close="jumpOpen = false">
      <section class="jump-pop progress-settings">
        <div class="jump-overview"><div><small>{{ t('v2.allBookProgress') }}</small><strong>{{ percentText }}</strong></div><span>{{ jumpMeta }}</span></div>
        <p class="jump-chapter">{{ chapterLabel || meta?.title }}</p>
        <input class="jump-slider" type="range" min="0" max="1" step="0.0005" :value="slidePreview ? slidePreview.fraction : fraction" :aria-label="t('reader.progress')" :aria-valuetext="progressText" @input="onSlideInput" @change="onSlide" @blur="slidePreview = null" />
        <p v-if="slidePreview" class="jump-hint" aria-live="polite">{{ slidePreview.text }}</p>
        <div class="segmented jump-tabs"><button type="button" :class="{ active: jumpMode === 'page' }" :aria-pressed="jumpMode === 'page'" @click="setJumpMode('page')">{{ t('v2.progressPage') }}</button><button type="button" :class="{ active: jumpMode === 'percent' }" :aria-pressed="jumpMode === 'percent'" @click="setJumpMode('percent')">{{ t('v2.progressPercent') }}</button></div>
        <label class="jump-field-label" for="reader-jump-input">{{ t(jumpMode === 'page' ? 'v2.jumpPageLabel' : 'v2.jumpPercentLabel') }}</label>
        <form class="jump-form" @submit.prevent="confirmJump">
          <input id="reader-jump-input" ref="jumpInputEl" v-model="jumpText" class="input jump-input" inputmode="decimal" enterkeyhint="go" autocomplete="off" :aria-invalid="!!jumpError" aria-describedby="reader-jump-hint" @input="jumpError = ''" />
          <span class="jump-total">{{ jumpMode === 'page' ? '/ ' + (pageInfo?.total ?? 1) : '%' }}</span><button class="btn btn-primary" type="submit">{{ t('reader.jumpGo') }}</button>
        </form>
        <p v-if="jumpError" class="jump-meta error" role="alert">{{ jumpError }}</p>
        <p id="reader-jump-hint" class="jump-hint">{{ jumpMode === 'page' ? t('v2.jumpPageHint', { total: pageInfo?.total ?? 1 }) : t('v2.jumpPercentHint') }}</p>
        <p v-if="pageInfo && !fixedLayout" class="jump-hint">{{ t('reader.pageHint') }}</p>
        <button v-if="jumpBack" class="btn jump-undo" type="button" @click="goJumpBack">↶ {{ jumpBack.label }}</button>
      </section>
    </AppModal>

    <!-- 跳转后一键回到原处 -->
    <button v-if="jumpBack && barsVisible && !slidePreview && !jumpOpen" class="jump-back" @click="goJumpBack">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M9.7 5.3a1 1 0 0 1 0 1.4L7.42 9H14a6 6 0 1 1 0 12h-3a1 1 0 1 1 0-2h3a4 4 0 0 0 0-8H7.41l2.3 2.3a1 1 0 0 1-1.42 1.4l-4-4a1 1 0 0 1 0-1.4l4-4a1 1 0 0 1 1.42 0z"/></svg>
      {{ jumpBack.label }}
    </button>

    <!-- 阅读模式: 自动翻页 / 打字机 -->
    <ReadingModePanel
      v-if="modes.panelOpen.value"
      :modes="modes"
      :progress="typewriterProgress"
      :auto-reading="autoReading"
      :auto-paused="autoPaused"
      :auto-motion="autoMotion"
      :effective-flow="effectiveFlow"
      :fixed-layout="fixedLayout"
      :tts-active="ttsState === 'playing'"
      v-model:auto-read-seconds="settings.autoReadSeconds"
      @start-auto="startAutoRead"
      @stop-auto="stopAutoRead"
      @toggle-auto="autoPaused ? resumeAutoRead() : pauseAutoRead()"
      @open-tts="openTTSPanel"
      @open-typography="openTypography"
      @close="modes.closePanel()"
    >
      <template #top>
        <DianjingToggle :dj="dj" @open-settings="router.push('/settings')" @open-outline="dj.openOutline()" @open-skim="dj.openSkim()" />
      </template>
      <template #ambient><AmbientEntry @open="toggleAmbientPanel" /></template>
    </ReadingModePanel>
    <ReadingModeMini
      :modes="modes"
      :bars-visible="barsVisible"
      :progress="typewriterProgress"
      :solid="effectiveFlow === 'scrolled'"
      :auto-state="autoReading ? (autoPaused ? 'paused' : 'running') : null"
      :auto-speed-text="t(autoSpeedKey(settings.autoReadSeconds))"
      @auto-toggle="autoPaused ? resumeAutoRead() : pauseAutoRead()"
      @auto-speed="adjustAutoSpeed"
      @auto-stop="stopAutoRead"
    />
    <ReadingModeLayer :modes="modes" :bars-visible="barsVisible" :suggest-eink="modes.einkSuggested.value" />

    <!-- 点睛阅读: 首次同意 / 解释卡 / 章首要义 / 脉络 / 速读 / 状态 -->
    <DianjingConsent v-if="dj.consentOpen.value" :dj="dj" />
    <DianjingCard v-if="dj.card.value" :dj="dj" />
    <DianjingChapterCard v-if="dj.chapterCard.value" :dj="dj" />
    <DianjingOutline v-if="dj.outlineOpen.value" :dj="dj" />
    <DianjingSkim v-if="dj.skimOpen.value" :dj="dj" />
    <DianjingStatus :dj="dj" @open-settings="router.push('/settings')" />

    <!-- 划线工具条: 选中文字或点已有划线时贴着选区出现, 所有书摘操作集中在这里 -->
    <div
      v-if="selection || hlMenu"
      class="highlight-bar card"
      :class="{ below: selTools.below }"
      :style="{ top: `${selTools.top}px` }"
      role="toolbar"
      :aria-label="t('reader.highlight')"
    >
      <div class="sel-colors">
        <span class="hl-hint">{{ t('reader.highlight') }}</span>
        <button
          v-for="(hex, name) in HIGHLIGHT_COLORS"
          :key="name"
          class="hl-color"
          :class="{ current: hlMenu?.anno.color === name }"
          :aria-label="t(`reader.highlightColor.${name}`)"
          :aria-pressed="hlMenu ? hlMenu.anno.color === name : undefined"
          :title="t(`reader.highlightColor.${name}`)"
          :style="{ '--highlight-color': hex }"
          @click="hlMenu ? recolorHighlight(name as string) : addHighlight(name as string)"
        />
        <button class="icon-btn sel-close" :title="t('common.cancel')" :aria-label="t('common.cancel')" @click="dismissSelection"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M6.3 6.3a1 1 0 0 1 1.4 0L12 10.58l4.3-4.3a1 1 0 1 1 1.4 1.42L13.42 12l4.3 4.3a1 1 0 0 1-1.42 1.4L12 13.42l-4.3 4.3a1 1 0 0 1-1.4-1.42L10.58 12l-4.3-4.3a1 1 0 0 1 0-1.4z"/></svg></button>
      </div>
      <div class="sel-actions">
        <template v-if="hlMenu">
          <button class="sel-act" @click="editHighlightNote"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H10l-4.3 3.4A1 1 0 0 1 4 19.6V6a2 2 0 0 1 1-2zm1 2v11.5L9.3 15H19V6H6zm2 2.5h8a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2zm0 3h5a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2z"/></svg><span>{{ hlMenu.anno.note ? t('reader.editNote') : t('reader.writeNote') }}</span></button>
          <button class="sel-act" @click="notes.copyOne(hlMenu.anno); dismissSelection()"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M8 3h9a2 2 0 0 1 2 2v11h-2V5H8V3zM5 7h9a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zm0 2v11h9V9H5z"/></svg><span>{{ t('notes.copyOne') }}</span></button>
          <button class="sel-act" @click="notes.cardFromAnnotation(hlMenu.anno); dismissSelection()"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M6 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm0 2v14h12V5H6zm2.6 3.2c.5-.6 1.3-1 2.1-1.1l.3 1.3c-.5.1-.9.4-1.1.8.9.2 1.5 1 1.5 1.9a2 2 0 0 1-2.1 2c-1.2 0-2-1-2-2.3 0-1 .4-1.9 1.3-2.6zm5 0c.5-.6 1.3-1 2.1-1.1l.3 1.3c-.5.1-.9.4-1.1.8.9.2 1.5 1 1.5 1.9a2 2 0 0 1-2.1 2c-1.2 0-2-1-2-2.3 0-1 .4-1.9 1.3-2.6zM8 15h8v2H8v-2z"/></svg><span>{{ t('notes.makeCard') }}</span></button>
          <button class="sel-act danger" @click="removeAnnotation(hlMenu.anno); dismissSelection()"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M9 3h6a1 1 0 0 1 1 1v1h4a1 1 0 1 1 0 2h-1l-1 13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 7H4a1 1 0 1 1 0-2h4V4a1 1 0 0 1 1-1zm-2 4 1 13h8l1-13H7zm3 3a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1zm4 0a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1z"/></svg><span>{{ t('common.delete') }}</span></button>
        </template>
        <template v-else-if="selection">
          <button class="sel-act" @click="addHighlight('yellow', true)"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H10l-4.3 3.4A1 1 0 0 1 4 19.6V6a2 2 0 0 1 1-2zm1 2v11.5L9.3 15H19V6H6zm2 2.5h8a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2zm0 3h5a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2z"/></svg><span>{{ t('reader.writeNote') }}</span></button>
          <button class="sel-act" @click="copySelectionText"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M8 3h9a2 2 0 0 1 2 2v11h-2V5H8V3zM5 7h9a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zm0 2v11h9V9H5z"/></svg><span>{{ t('notes.copyOne') }}</span></button>
          <button v-if="canSelectParagraph" class="sel-act" @click="selectParagraph"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 10h16M4 14h16M4 18h10"/><path d="M2 4v16M22 4v16" stroke-dasharray="2 2"/></svg><span>{{ t('reader.selectParagraph') }}</span></button>
          <button class="sel-act" @click="translateSelection"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h9M8.5 3v2M6 5c.6 3 2.6 5.6 5.5 7M11 5c-.8 3.3-3.2 6.2-6.5 7.5M13 21l4-9 4 9M14.4 18h5.2"/></svg><span>{{ t('translate.title') }}</span></button>
          <button class="sel-act" @click="notes.cardFromSelection(selection.text, chapterLabel); dismissSelection()"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M6 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm0 2v14h12V5H6zm2.6 3.2c.5-.6 1.3-1 2.1-1.1l.3 1.3c-.5.1-.9.4-1.1.8.9.2 1.5 1 1.5 1.9a2 2 0 0 1-2.1 2c-1.2 0-2-1-2-2.3 0-1 .4-1.9 1.3-2.6zm5 0c.5-.6 1.3-1 2.1-1.1l.3 1.3c-.5.1-.9.4-1.1.8.9.2 1.5 1 1.5 1.9a2 2 0 0 1-2.1 2c-1.2 0-2-1-2-2.3 0-1 .4-1.9 1.3-2.6zM8 15h8v2H8v-2z"/></svg><span>{{ t('notes.makeCard') }}</span></button>
          <button class="sel-act" @click="aiExplainSelection"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M10 3a1 1 0 0 1 .95.68l1.3 3.9a3 3 0 0 0 1.9 1.9l3.9 1.3a1 1 0 0 1 0 1.9l-3.9 1.3a3 3 0 0 0-1.9 1.9l-1.3 3.9a1 1 0 0 1-1.9 0l-1.3-3.9a3 3 0 0 0-1.9-1.9l-3.9-1.3a1 1 0 0 1 0-1.9l3.9-1.3a3 3 0 0 0 1.9-1.9l1.3-3.9A1 1 0 0 1 10 3zm8-1a1 1 0 0 1 .95.68l.4 1.2.97.32a1 1 0 0 1 0 1.9l-.97.32-.4 1.2a1 1 0 0 1-1.9 0l-.4-1.2-.97-.32a1 1 0 0 1 0-1.9l.97-.32.4-1.2A1 1 0 0 1 18 2z"/></svg><span>{{ t('ai.explain') }}</span></button>
          <button v-if="dj.selectionKey.value" class="sel-act" @click="dj.openKeyCard(); dismissSelection()"><span class="sel-act-text">{{ t('dianjing.why') }}</span></button>
          <button v-if="!fixedLayout" class="sel-act" @click="listenFromSelection"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 3a7 7 0 0 0-7 7v1.1A3.5 3.5 0 0 0 3 14.5v2A3.5 3.5 0 0 0 6.5 20H8a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1h-.9A5 5 0 0 1 12 5a5 5 0 0 1 4.9 6H16a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h1.5a3.5 3.5 0 0 0 3.5-3.5v-2a3.5 3.5 0 0 0-2-3.16V10a7 7 0 0 0-7-7z"/></svg><span>{{ t('tts.listenFromSelection') }}</span></button>
          <button v-if="settings.features.transfer" class="sel-act" @click="sendSelectionToDevices(selection.text, meta?.title); dismissSelection()"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 3 10 14M21 3l-7 18-4-7-7-4z"/></svg><span>{{ t('transfer.sendToDevices') }}</span></button>
        </template>
      </div>
    </div>

    <TranslateSheet v-if="translating" :text="translating" :book="meta?.title" @close="translating = null" />

    <!-- 标注详情 / 想法编辑浮层 -->
    <AppModal v-if="activeAnnotation" :title="t('reader.writeNote')" @close="activeAnnotation = null">
      <div class="annotation-pop">
        <p class="quote">{{ activeAnnotation.text }}</p>
        <textarea
          v-model="noteDraft"
          class="note-input"
          rows="3"
          :placeholder="t('reader.notePlaceholder')"
          :aria-label="t('reader.notePlaceholder')"
        />
        <div class="pop-actions">
          <button class="btn btn-sm btn-danger" @click="removeAnnotation(activeAnnotation)">{{ t('reader.deleteHighlight') }}</button>
          <span style="flex: 1" />
          <button class="btn btn-sm" @click="activeAnnotation = null">{{ t('common.cancel') }}</button>
          <button class="btn btn-sm btn-primary" @click="saveNote">{{ t('reader.saveNote') }}</button>
        </div>
      </div>
    </AppModal>

    <NotesExportDialog
      v-if="notes.exportOpen && meta"
      :book="notes.book"
      :items="notes.noteItems"
      :lang="settings.language === 'en' ? 'en' : 'zh'"
      :busy="notes.resolving"
      @close="notes.exportOpen = false"
    />
    <QuoteCardDialog v-if="notes.card && cardCover !== undefined" :data="notes.card" :cover-url="cardCover || undefined" @close="notes.card = null" />

    <!-- 听书迷你胶囊: 面板收起但会话未停止时显示 -->
    <ListenCapsule
      v-if="ttsMiniFloating"
      ref="miniEl"
      variant="float"
      class="tts-mini"
      :class="{ placed: !!miniPos }"
      :style="miniStyle"
      v-bind="capsuleProps"
      @pointerdown="onMiniDown"
      @pointermove="onMiniMove"
      @pointerup="onMiniUp"
      @pointercancel="miniDrag = null"
      @dblclick="resetMiniPos"
      @open="ttsPanel = true"
      @toggle="ttsState === 'playing' ? pauseTTS() : resumeTTS()"
      @back="returnToListening"
      @stop="stopTTS()"
    />

    <!-- 背景音 -->
    <AmbientPanel
      v-if="ambientPanel"
      :tts-active="ttsState === 'playing'"
      @close="ambientPanel = false"
      @show-sources="showAmbientSources"
    />

    <!-- 听书面板 -->
    <div v-if="ttsPanel" class="tts-panel card" role="dialog" :aria-label="t('tts.title')">
      <div class="tts-head">
        <strong>{{ t('tts.title') }}</strong>
        <span v-if="ttsBuffering" class="tts-buffering">{{ t('tts.buffering') }}</span>
        <!-- 定时开着: 「23:40 停止」, 点一下取消 -->
        <button
          v-if="sleepText"
          type="button"
          class="tts-sleep-badge"
          :class="{ fading: sleepFading }"
          :title="t('tts.sleepCancel')"
          :aria-label="`${sleepText}，${t('tts.sleepCancel')}`"
          @click="cancelSleep"
        ><svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0-16zm0 2a6 6 0 1 0 0 12 6 6 0 0 0 0-12zm0 1.5a1 1 0 0 1 1 1v3.09l2.2 1.27a1 1 0 0 1-1 1.73l-2.7-1.56A1 1 0 0 1 11 12V8.5a1 1 0 0 1 1-1z"/></svg>{{ sleepText }}<svg class="tts-sleep-x" viewBox="0 0 24 24" width="10" height="10" aria-hidden="true"><path fill="currentColor" d="M6.7 5.3 12 10.6l5.3-5.3a1 1 0 1 1 1.4 1.4L13.4 12l5.3 5.3a1 1 0 0 1-1.4 1.4L12 13.4l-5.3 5.3a1 1 0 0 1-1.4-1.4l5.3-5.3-5.3-5.3a1 1 0 0 1 1.4-1.4z"/></svg></button>
        <span style="flex: 1" />
        <button v-if="ttsState !== 'stopped'" class="btn btn-sm" @click="stopTTS"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor"/></svg>{{ t('common.stop') }}</button>
        <button class="icon-btn" :title="t('tts.collapseHint')" :aria-label="t('tts.collapse')" @click="ttsPanel = false"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M5.3 8.3a1 1 0 0 1 1.4 0L12 13.6l5.3-5.3a1 1 0 1 1 1.4 1.4l-6 6a1 1 0 0 1-1.4 0l-6-6a1 1 0 0 1 0-1.4z"/></svg></button>
      </div>
      <div class="tts-message-slot" data-message-slot />
      <div class="listen-hero">
        <div class="listen-cover"><BookCover :title="meta?.title || ''" :author="meta?.author" :src="library.coverUrls[bookId]" /></div>
        <h2>{{ meta?.title }}</h2>
        <p>{{ listenChapter || meta?.author }}</p>
      </div>
      <div class="listen-options">
        <button @click="ttsOptions = 'sleep'"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/></svg><small>{{ t('tts.sleep') }}</small><strong>{{ sleepShort || t('v2.notEnabled') }}</strong></button>
        <button @click="ttsOptions = 'voice'"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4m-4 0h8"/></svg><small>{{ t('tts.voice') }}</small><strong :title="voiceSummary">{{ voiceSummary }}</strong></button>
        <button @click="ttsOptions = 'rate'"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 19a9 9 0 1 1 16 0M12 13l5-6"/></svg><small>{{ t('tts.rate') }}</small><strong>{{ rateText(settings.ttsRate) }}</strong></button>
      </div>
      <p class="listen-state" :class="{ error: ttsFailure }" role="status">{{ ttsStatus }}</p>
      <div v-if="unavailableVoice && edgeAvailable()" class="tts-notice">
        <button class="btn btn-sm btn-primary" @click="switchToOnline">{{ t('tts.useOnline') }}</button>
      </div>
      <!-- 听到哪了、还要多久 -->
      <div v-if="listenEta" class="tts-progress">
        <div class="tts-progress-head">
          <span class="tts-progress-chapter">{{ listenChapter || meta?.title }}</span>
          <span class="tts-progress-eta">{{ chapterEtaText }}</span>
        </div>
        <div
          class="tts-progress-track"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="Math.round(listenChapterProgress * 100)"
          :aria-label="chapterProgress != null ? t('tts.chapterProgress') : t('reader.progress')"
        >
          <span :style="{ transform: `scaleX(${listenChapterProgress})` }" />
        </div>
        <div class="tts-progress-sub">
          <span>{{ chapterFinishText }}</span>
          <span :title="bookFinishText">{{ t('tts.bookSummary', { pct: listenPercent, time: listenEta ? humanTime(listenEta.book) : '' }) }}</span>
        </div>
        <p v-if="!pace.samples" class="tts-progress-hint">{{ t('tts.etaLearning') }}</p>
      </div>

      <!-- 离线合成跟不上: 推荐在线语音 -->
      <div v-if="localTooSlow && settings.ttsEngine === 'local'" class="tts-notice">
        <span class="tts-notice-text">{{ t('tts.localSlow') }}</span>
        <button class="btn btn-sm btn-primary" @click="switchToOnline">{{ t('tts.switchToOnline') }}</button>
      </div>
      <!-- 朗读中翻到了别处 -->
      <div v-if="listenDetached && ttsState !== 'stopped'" class="tts-notice">
        <span class="tts-notice-text">{{ t('tts.detached') }}</span>
        <button class="btn btn-sm" @click="returnToListening"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 2a1 1 0 0 1 1 1v1.06A8 8 0 0 1 19.94 11H21a1 1 0 1 1 0 2h-1.06A8 8 0 0 1 13 19.94V21a1 1 0 1 1-2 0v-1.06A8 8 0 0 1 4.06 13H3a1 1 0 1 1 0-2h1.06A8 8 0 0 1 11 4.06V3a1 1 0 0 1 1-1zm0 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12zm0 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"/></svg>{{ t('tts.backToListening') }}</button>
        <button class="btn btn-sm btn-primary" @click="listenFromHere">{{ t('tts.listenFromHere') }}</button>
      </div>
      <!-- 断点续读 -->
      <div v-else-if="ttsState === 'stopped' && listenBookmark && !bookmarkOnPage" class="tts-notice">
        <span class="tts-notice-text">
          <strong>{{ t('tts.lastListened') }}</strong> {{ listenBookmark.chapter }} · {{ bookmarkAgo }}
          <span class="tts-snippet">「{{ listenBookmark.snippet }}…」</span>
        </span>
        <button class="btn btn-sm btn-primary" @click="startTTS('bookmark')">{{ t('tts.resumeListening') }}</button>
      </div>

      <!-- 走带: 上一段 / 上一句 / 播放 / 下一句 / 下一段 -->
      <div class="tts-transport">
        <button class="tts-skip" :disabled="ttsState === 'stopped'" :title="t('tts.prevParagraph')" @click="skipListen('paragraph', -1)"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M6 5a1 1 0 0 1 1 1v12a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1zm12.4.62v12.76a.8.8 0 0 1-1.22.68l-8.3-5.13a1.08 1.08 0 0 1 0-1.86l8.3-5.13a.8.8 0 0 1 1.22.68z"/></svg><span>{{ t('tts.prevParagraph') }}</span></button>
        <button class="tts-skip" :disabled="ttsState === 'stopped'" :title="t('tts.prevSentence')" @click="skipListen('sentence', -1)"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M11 6.6v10.8a.8.8 0 0 1-1.28.64l-6.9-5.4a.8.8 0 0 1 0-1.28l6.9-5.4A.8.8 0 0 1 11 6.6zm9.5 0v10.8a.8.8 0 0 1-1.28.64l-6.9-5.4a.8.8 0 0 1 0-1.28l6.9-5.4a.8.8 0 0 1 1.28.64z"/></svg><span>{{ t('tts.prevSentence') }}</span></button>
        <button
          class="tts-play"
          :title="ttsState === 'playing' ? t('common.pause') : ttsState === 'paused' ? t('common.resume') : t('tts.startReading')"
          :aria-label="ttsState === 'playing' ? t('common.pause') : ttsState === 'paused' ? t('common.resume') : t('tts.startReading')"
          @click="ttsState === 'playing' ? pauseTTS() : ttsState === 'paused' ? resumeTTS() : startTTS()"
        >
          <template v-if="ttsState === 'playing'"><svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="currentColor" d="M8 5a1.5 1.5 0 0 1 1.5 1.5v11a1.5 1.5 0 0 1-3 0v-11A1.5 1.5 0 0 1 8 5zm8 0a1.5 1.5 0 0 1 1.5 1.5v11a1.5 1.5 0 0 1-3 0v-11A1.5 1.5 0 0 1 16 5z"/></svg></template>
          <template v-else><svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="currentColor" d="M8.5 5.2a1 1 0 0 1 1.02.03l9 5.95a1 1 0 0 1 0 1.66l-9 5.95A1 1 0 0 1 8 17.95V6.05a1 1 0 0 1 .5-.85z"/></svg></template>
        </button>
        <button class="tts-skip" :disabled="ttsState === 'stopped'" :title="t('tts.nextSentence')" @click="skipListen('sentence', 1)"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M13 6.6v10.8a.8.8 0 0 0 1.28.64l6.9-5.4a.8.8 0 0 0 0-1.28l-6.9-5.4A.8.8 0 0 0 13 6.6zm-9.5 0v10.8a.8.8 0 0 0 1.28.64l6.9-5.4a.8.8 0 0 0 0-1.28l-6.9-5.4A.8.8 0 0 0 3.5 6.6z"/></svg><span>{{ t('tts.nextSentence') }}</span></button>
        <button class="tts-skip" :disabled="ttsState === 'stopped'" :title="t('tts.nextParagraph')" @click="skipListen('paragraph', 1)"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M18 5a1 1 0 0 1 1 1v12a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1zM5.6 5.62v12.76a.8.8 0 0 0 1.22.68l8.3-5.13a1.08 1.08 0 0 0 0-1.86l-8.3-5.13a.8.8 0 0 0-1.22.68z"/></svg><span>{{ t('tts.nextParagraph') }}</span></button>
      </div>
      <p v-if="ttsState === 'stopped'" class="tts-start-hint">
        {{ bookmarkOnPage ? t('tts.startFromBookmark') : t('tts.startFromPage') }} · {{ t('tts.selectHint') }}
      </p>

      <nav class="listen-links" :aria-label="t('v2.listenTools')">
        <button @click="ttsPanel = false">{{ t('v2.originalText') }}</button>
        <button :aria-pressed="modes.lyricFollowing.value" @click="openListenLyrics">{{ t('readingMode.tabLyric') }}</button>
        <button @click="openListenToc">{{ t('reader.toc') }}</button>
      </nav>
      <AmbientEntry @open="toggleAmbientPanel" />
      <blockquote v-if="listenQuote" class="listen-quote">{{ listenQuote }}</blockquote>
      <AppModal v-if="ttsOptions" :title="t(ttsOptions === 'rate' ? 'tts.rate' : ttsOptions === 'sleep' ? 'tts.sleep' : 'tts.voice')" @close="ttsOptions = null">
        <div class="listen-setting-body">
      <TtsRateControl v-if="ttsOptions === 'rate'" v-model="settings.ttsRate" />
      <div v-show="ttsOptions === 'sleep'" class="tts-row tts-row-stacked">
        <label>{{ t('tts.sleep') }}</label>
        <div class="seg">
          <button v-for="c in SLEEP_CHOICES" :key="c.mode" :class="{ active: sleepMode === c.mode }" @click="setSleep(c.mode)">{{ t(c.key) }}</button>
        </div>
      </div>
      <div v-show="ttsOptions === 'voice'" v-if="edgeAvailable()" class="tts-row">
        <label>{{ t('tts.engine') }}</label>
        <div class="seg" style="flex: 1">
          <button :class="{ active: settings.ttsEngine === 'edge' }" @click="settings.ttsEngine = 'edge'; resetEdgeFailure()">{{ t('tts.engineEdge') }}</button>
          <button :class="{ active: settings.ttsEngine === 'local' }" :disabled="!localTtsAvailable()" :title="localTtsAvailable() ? t('tts.engineLocalTitle') : t('tts.localUnsupported')" @click="settings.ttsEngine = 'local'; resetEdgeFailure(); refreshLocalStatus()">{{ t('tts.engineLocal') }}</button>
          <button :disabled="!systemSpeechAvailable()" :class="{ active: settings.ttsEngine === 'system' }" @click="settings.ttsEngine = 'system'">{{ t('tts.engineSystem') }}</button>
          <button :class="{ active: settings.ttsEngine === 'cloud' }" :title="t('tts.engineCloudTitle')" @click="settings.ttsEngine = 'cloud'; resetEdgeFailure()">{{ t('tts.engineCloud') }}</button>
        </div>
      </div>
      <div v-show="ttsOptions === 'voice'" v-if="edgeAvailable() && settings.ttsEngine === 'edge'" class="tts-row">
        <label>{{ t('tts.voice') }}</label>
        <AppSelect v-model="settings.edgeVoice" class="input" :aria-label="t('tts.voice')">
          <option v-for="v in EDGE_VOICES" :key="v.id" :value="v.id">{{ v.label }}</option>
        </AppSelect>
      </div>
      <div v-show="ttsOptions === 'voice'" v-else-if="edgeAvailable() && settings.ttsEngine === 'cloud'" class="tts-row">
        <CloudTtsConfig :busy="ttsState !== 'stopped'" />
      </div>
      <div v-show="ttsOptions === 'voice'" v-else-if="edgeAvailable() && settings.ttsEngine === 'local'" class="tts-row">
        <label>{{ t('tts.voice') }}</label>
        <template v-if="localInstalled">
          <AppSelect v-model="settings.localVoiceId" class="input" :aria-label="t('tts.voice')">
            <option v-for="v in KOKORO_VOICES" :key="v.sid" :value="v.sid">{{ kokoroVoiceLabel(v, settings.language === 'en' ? 'en' : 'zh') }}{{ v.sid === DEFAULT_KOKORO_SID ? t('tts.voiceDefault') : '' }}</option>
          </AppSelect>
          <button class="btn btn-sm" :disabled="ttsState !== 'stopped'" @click="auditionLocal">{{ t('tts.audition') }}</button>
        </template>
        <LocalTtsPack v-else-if="localTtsAvailable()" />
        <p v-else class="tts-hint">{{ t('tts.localUnsupported') }}</p>
      </div>
      <div v-show="ttsOptions === 'voice'" v-else class="tts-row">
        <label>{{ t('tts.voice') }}</label>
        <AppSelect v-model="settings.ttsVoice" class="input" :aria-label="t('tts.voice')">
          <option value="">{{ t('tts.autoVoice') }}</option>
          <option v-for="v in ttsVoices" :key="v.name" :value="v.name">{{ v.name }} ({{ v.lang }})</option>
        </AppSelect>
      </div>
      <p v-show="ttsOptions === 'voice' && (settings.ttsEngine !== 'cloud' || !edgeAvailable())" class="tts-hint">
        {{ !edgeAvailable() ? t('tts.hintSystem') : settings.ttsEngine === 'edge' ? t(systemSpeechAvailable() ? 'tts.hintEdge' : 'tts.hintEdgeNoSystem') : settings.ttsEngine === 'local' ? t('tts.hintLocal') : t('tts.hintSystem') }}
      </p>
        </div>
      </AppModal>
    </div>

    <!-- 侧栏面板 -->
    <aside v-if="panel !== 'none'" ref="panelEl" class="panel card">
      <button class="reader-panel-close icon-btn" :aria-label="t('common.close')" @click="panel = 'none'; listenToc = false"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
      <template v-if="panel === 'toc'">
        <h3>{{ t('reader.toc') }}</h3>
        <div class="panel-body">
          <p v-if="tocAuto" class="panel-tip">{{ t('reader.tocAuto') }}</p>
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
            <template v-for="g in notes.highlightGroups" :key="g.items[0].id">
              <div v-if="g.chapter" class="anno-chapter">{{ g.chapter }}</div>
              <div v-for="a in g.items" :key="a.id" class="anno-item" @click="gotoAnnotation(a)">
                <span class="anno-dot" :style="{ background: HIGHLIGHT_COLORS[a.color] ?? a.color }" />
                <span class="anno-body">
                  <span class="anno-text">{{ a.text }}</span>
                  <span v-if="a.note" class="anno-note"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H10l-4.3 3.4A1 1 0 0 1 4 19.6V6a2 2 0 0 1 1-2zm1 2v11.5L9.3 15H19V6H6zm2 2.5h8a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2zm0 3h5a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2z"/></svg>{{ a.note }}</span>
                </span>
                <span class="anno-acts">
                  <button class="icon-btn anno-act" :title="t('notes.copyOne')" :aria-label="t('notes.copyOne')" @click.stop="notes.copyOne(a)"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M8 3h9a2 2 0 0 1 2 2v11h-2V5H8V3zM5 7h9a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zm0 2v11h9V9H5z"/></svg></button>
                  <button class="icon-btn anno-act" :title="t('notes.makeCard')" :aria-label="t('notes.makeCard')" @click.stop="notes.cardFromAnnotation(a)"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M6 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm0 2v14h12V5H6zm2.6 3.2c.5-.6 1.3-1 2.1-1.1l.3 1.3c-.5.1-.9.4-1.1.8.9.2 1.5 1 1.5 1.9a2 2 0 0 1-2.1 2c-1.2 0-2-1-2-2.3 0-1 .4-1.9 1.3-2.6zm5 0c.5-.6 1.3-1 2.1-1.1l.3 1.3c-.5.1-.9.4-1.1.8.9.2 1.5 1 1.5 1.9a2 2 0 0 1-2.1 2c-1.2 0-2-1-2-2.3 0-1 .4-1.9 1.3-2.6zM8 15h8v2H8v-2z"/></svg></button>
                </span>
              </div>
            </template>
            <p v-if="!highlights.length" class="panel-empty">{{ t('reader.highlightEmptyHint') }}</p>
          </template>
          <template v-else>
            <div v-for="a in bookmarks" :key="a.id" class="anno-item" @click="gotoAnnotation(a)">
              <svg viewBox="0 0 24 24" width="14" height="14" style="flex-shrink: 0; margin-top: 3px"><path fill="var(--brand)" d="M6 3h12a1 1 0 0 1 1 1v16.2a.8.8 0 0 1-1.24.67L12 17.6l-5.76 3.27A.8.8 0 0 1 5 20.2V4a1 1 0 0 1 1-1z"/></svg>
              <span class="anno-body">
                <span class="anno-text">{{ a.text }}</span>
              </span>
              <button class="icon-btn anno-del" :title="t('common.delete')" :aria-label="t('common.delete')" @click.stop="removeAnnotation(a)"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6.3 6.3a1 1 0 0 1 1.4 0L12 10.58l4.3-4.3a1 1 0 1 1 1.4 1.42L13.42 12l4.3 4.3a1 1 0 0 1-1.42 1.4L12 13.42l-4.3 4.3a1 1 0 0 1-1.4-1.42L10.58 12l-4.3-4.3a1 1 0 0 1 0-1.4z"/></svg></button>
            </div>
            <p v-if="!bookmarks.length" class="panel-empty">{{ t('reader.bookmarkEmptyHint') }}</p>
          </template>
        </div>
        <div v-if="annoTab === 'highlight' && highlights.length" class="anno-foot">
          <button class="btn btn-sm btn-primary anno-copy-all" @click="notes.copyAll()">{{ t('notes.copyAll', { n: highlights.length }) }}</button>
          <button class="btn btn-sm" @click="notes.openExport()">{{ t('notes.export') }}</button>
        </div>
      </template>

      <template v-else-if="panel === 'ai'">
        <h3 class="ai-title"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M10 3a1 1 0 0 1 .95.68l1.3 3.9a3 3 0 0 0 1.9 1.9l3.9 1.3a1 1 0 0 1 0 1.9l-3.9 1.3a3 3 0 0 0-1.9 1.9l-1.3 3.9a1 1 0 0 1-1.9 0l-1.3-3.9a3 3 0 0 0-1.9-1.9l-3.9-1.3a1 1 0 0 1 0-1.9l3.9-1.3a3 3 0 0 0 1.9-1.9l1.3-3.9A1 1 0 0 1 10 3zm8-1a1 1 0 0 1 .95.68l.4 1.2.97.32a1 1 0 0 1 0 1.9l-.97.32-.4 1.2a1 1 0 0 1-1.9 0l-.4-1.2-.97-.32a1 1 0 0 1 0-1.9l.97-.32.4-1.2A1 1 0 0 1 18 2z"/></svg>{{ t('ai.title') }}</h3>
        <div v-if="!aiReady()" class="ai-setup">
          <p>{{ t('ai.setupHint') }}</p>
          <ol class="ai-steps">
            <li>{{ t('ai.step1') }}</li>
            <li>{{ t('ai.step2') }}</li>
            <li>{{ t('ai.step3') }}</li>
          </ol>
          <div class="ai-setup-actions">
            <button class="btn btn-sm btn-primary" @click="useTrialAi">{{ t('ai.useTrial') }}</button>
            <button class="btn btn-sm" @click="openRegister">{{ t('ai.register') }}</button>
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

    <!-- 排版面板: 静态的外观与版式值只在这里调 (docs/reader-panels.md) -->
    <TypographyPanel
      v-if="settingsOpen"
      :modes="modes"
      :effective-flow="effectiveFlow"
      :fixed-layout="fixedLayout"
      :portrait-locked="readerLayout.portraitLocked"
      :mode-locked="readerLayout.modeLocked"
      :focus="typoFocus"
      @close="settingsOpen = false"
      @open-modes="openModes"
    />
  </div>
</template>

<style scoped>
.reader {
  /* 底栏高度: 浮层 (自动阅读 / 听书胶囊) 在工具栏显示时让到它上方 */
  --footer-h: 50px;
  --safe-top: var(--lr-safe-top);
  --safe-bottom: var(--lr-safe-bottom);
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
  padding: 8px max(14px, var(--lr-safe-right)) 8px max(14px, var(--lr-safe-left));
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
  padding-top: calc(8px + var(--safe-top));
}
.bar.bottom {
  bottom: 0;
  top: auto;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  padding-top: 6px;
  padding-bottom: calc(6px + var(--safe-bottom));
  border-bottom: none;
  border-top: 1px solid var(--border);
}
.progress-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
/* 手机端底部入口, 桌面端这些都在顶栏 */
.dock {
  display: none;
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
.pdf-switch {
  flex: 0 0 auto;
  align-self: center;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  margin-right: 4px;
  padding: 0 11px;
  border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
  border-radius: 999px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
  white-space: nowrap;
  cursor: pointer;
}
.pdf-switch:hover {
  background: color-mix(in srgb, currentColor 8%, transparent);
}
.pdf-switch-short {
  display: none;
}
.convert-text {
  margin: 0;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.convert-bar {
  width: min(260px, 70vw);
  height: 4px;
  border-radius: 2px;
  background: color-mix(in srgb, currentColor 14%, transparent);
  overflow: hidden;
}
.convert-bar span {
  display: block;
  height: 100%;
  background: var(--brand);
  transition: width 0.2s ease;
}
.convert-hint {
  margin: 0;
  max-width: 300px;
  font-size: 12.5px;
  text-align: center;
}
.icon-btn {
  width: var(--icon-btn);
  height: var(--icon-btn);
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
/* 正文让出状态栏 / 手势条 / 横屏刘海; 阅读背景仍铺满整屏 */
.content {
  flex: 1;
  height: 100%;
  padding: var(--safe-top) var(--lr-safe-right) var(--safe-bottom) var(--lr-safe-left);
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
/* 竖屏: 左右留白很窄, 侧边翻页钮会压住正文边缘、抢走点按, 翻页改点上 / 下区; 自动阅读时也不设翻页区, 收起 */
.reader.no-side-nav .nav {
  display: none;
}
.slider {
  flex: 1;
  accent-color: var(--brand);
}
/* 底栏进度: 页码为主、百分比为辅; 整块可点开跳页 */
.progress-label {
  flex-shrink: 0;
  display: inline-flex;
  align-items: baseline;
  justify-content: flex-end;
  gap: 3px;
  min-width: 48px;
  height: 30px;
  padding: 0 8px;
  border: none;
  border-radius: var(--radius-pill);
  background: none;
  color: var(--text-3);
  font-size: 12px;
  line-height: 30px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.progress-label b {
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
}
.progress-label .sep {
  margin: 0 2px;
}
.progress-label:hover,
.progress-label.active {
  background: var(--brand-soft);
  color: var(--brand);
}
.progress-label:hover b,
.progress-label.active b {
  color: var(--brand);
}
.progress-label:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 1px;
}
.slider-wrap {
  flex: 1;
  min-width: 0;
  position: relative;
  display: flex;
  align-items: center;
}
.slider-wrap .slider {
  width: 100%;
}
/* 拖动进度条时的落点预览 */
.slide-bubble {
  position: absolute;
  bottom: calc(100% + 10px);
  transform: translateX(-50%);
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  max-width: 220px;
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card);
  box-shadow: var(--shadow-md);
  color: var(--text-2);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  pointer-events: none;
}
.slide-bubble strong {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
}
.jump-pop {
  position: absolute;
  right: max(14px, var(--lr-safe-right));
  bottom: calc(var(--footer-h) + 8px + var(--safe-bottom));
  z-index: 20;
  width: 300px;
  padding: 12px;
  box-shadow: var(--shadow-lg);
}
.jump-form {
  display: flex;
  align-items: center;
  gap: 8px;
}
.jump-input {
  flex: 1;
  min-width: 0;
  font-variant-numeric: tabular-nums;
}
.jump-total {
  flex-shrink: 0;
  color: var(--text-3);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.jump-meta {
  margin: 8px 0 0;
  color: var(--text-2);
  font-size: 12px;
}
.jump-meta.error {
  color: var(--danger);
}
.jump-hint {
  margin: 2px 0 0;
  color: var(--text-3);
  font-size: 11px;
}
.jump-back {
  position: absolute;
  left: max(14px, var(--lr-safe-left));
  bottom: calc(var(--footer-h) + 12px + var(--safe-bottom));
  z-index: 19;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 14px 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--card);
  box-shadow: var(--shadow-md);
  color: var(--brand);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.jump-back:hover {
  background: var(--brand-light);
}
.icon-btn.auto-on {
  color: var(--brand);
}
.highlight-bar {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  z-index: 40;
  width: min(440px, calc(100vw - 24px));
  display: grid;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-1) 2px;
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-3);
}
.sel-colors {
  display: flex;
  align-items: center;
  gap: 2px;
  padding-bottom: var(--space-1);
  border-bottom: 1px solid var(--border);
}
.hl-hint {
  margin: 0 var(--space-2) 0 var(--space-3);
  font-size: var(--fs-caption);
  color: var(--text-3);
}
.sel-close {
  margin-left: auto;
  width: 44px;
  height: 44px;
  color: var(--text-3);
}
.sel-actions {
  display: flex;
  overflow-x: auto;
  scrollbar-width: none;
  overscroll-behavior-x: contain;
}
.sel-actions::-webkit-scrollbar {
  display: none;
}
.sel-act {
  flex: 1 0 64px;
  min-height: 60px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  padding: var(--space-1) 2px;
  border: 0;
  border-radius: var(--radius);
  background: none;
  color: var(--text);
  font-size: var(--fs-caption);
  white-space: nowrap;
  cursor: pointer;
}
.sel-act:active {
  background: var(--surface-2);
}
.sel-act.danger {
  color: var(--danger);
}
.sel-act-text {
  font-size: var(--fs-small);
}
.hl-color.current::before {
  outline: 2px solid var(--text);
}
.hl-color {
  display: grid;
  place-items: center;
  flex: 0 0 44px;
  width: 44px;
  height: 44px;
  padding: 0;
  border: none;
  border-radius: var(--radius);
  background: transparent;
}
.hl-color::before {
  content: '';
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--highlight-color);
  border: 2px solid var(--card);
  box-shadow: 0 0 0 1px var(--border);
}
.hl-color:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: -2px;
}
.annotation-pop {
  padding: 20px;
}
.annotation-pop .btn { min-height: 44px; }
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
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
}
.panel {
  position: absolute;
  top: calc(52px + var(--safe-top));
  right: 12px;
  bottom: calc(50px + var(--safe-bottom));
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
.anno-chapter {
  margin: var(--space-3) var(--space-2) var(--space-1);
  font-size: var(--fs-caption);
  font-weight: 500;
  color: var(--text-3);
}
.anno-chapter:first-child {
  margin-top: 0;
}
.anno-acts {
  display: flex;
  flex-shrink: 0;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.12s;
}
.anno-item:hover .anno-acts,
.anno-item:focus-within .anno-acts {
  opacity: 1;
}
@media (hover: none) {
  .anno-acts { opacity: 1; }
}
.anno-act {
  width: 36px;
  height: 36px;
  color: var(--text-3);
}
.anno-act:hover {
  color: var(--brand);
}
.anno-foot {
  display: flex;
  gap: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border);
}
.anno-copy-all {
  flex: 1;
}
.anno-foot .btn {
  min-height: 44px;
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
/* 听书胶囊: 默认停在页眉留白 (章节名那一条), 不压正文; 工具栏出现时让到其下方; 拖动后停在用户放的位置 */
.tts-mini {
  --head-band: 48px;
  position: absolute;
  top: calc(var(--safe-top) + (var(--head-band) - 32px) / 2);
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  max-width: calc(100% - 24px);
  transition: top 0.25s;
}
.tts-mini.placed {
  transform: translate(-50%, -50%);
  transition: none;
}
.ambient-btn {
  position: relative;
}
.ambient-dot {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--brand);
}
.tts-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tts-head strong {
  font-size: 15px;
}
.tts-buffering,
.tts-sleep-badge {
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  background: var(--surface-2);
  color: var(--text-3);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.tts-sleep-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: var(--brand-soft);
  color: var(--brand);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.tts-sleep-badge:hover {
  background: var(--brand-light);
}
.tts-sleep-badge:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.tts-sleep-x {
  opacity: 0.7;
}
/* 最后 3 秒淡出时徽标跟着变淡 */
.tts-sleep-badge.fading {
  opacity: 0.55;
  transition: opacity 3s linear;
}
.tts-notice {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--radius);
  background: var(--surface-2);
  font-size: 12px;
  color: var(--text-2);
}
.tts-notice-text {
  flex: 1 1 160px;
  min-width: 0;
}
.tts-notice-text strong {
  color: var(--text);
}
.tts-snippet {
  display: block;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-3);
}
/* 走带: 中间大播放键, 两侧跳句 / 跳段, 下方小字说明 */
.tts-transport {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}
.tts-skip {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  width: 58px;
  padding: 6px 0;
  border: none;
  border-radius: var(--radius);
  background: none;
  color: var(--text-2);
  font-size: 10px;
}
.tts-skip:hover:not(:disabled) {
  background: var(--surface-2);
  color: var(--brand);
}
.tts-skip:disabled {
  opacity: 0.35;
}
.tts-play {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  margin: 0 6px;
  border: none;
  border-radius: 50%;
  background: var(--brand);
  color: var(--on-brand);
  box-shadow: var(--shadow-md);
  transition: transform 0.12s;
}
.tts-play:hover {
  background: var(--brand-hover);
}
.tts-play:active {
  transform: scale(0.95);
}
.tts-start-hint {
  margin: -4px 0 0;
  text-align: center;
  color: var(--text-3);
  font-size: 11px;
}
.tts-progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
}
.tts-progress-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.tts-progress-chapter {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
  font-size: 12px;
}
.tts-progress-eta {
  flex-shrink: 0;
  color: var(--text);
  font-size: 15px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.tts-progress-track {
  height: 4px;
  border-radius: var(--radius-pill);
  background: var(--surface-3);
  overflow: hidden;
}
.tts-progress-track span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--brand);
  transform-origin: left center;
  transition: transform 0.4s ease;
}
.tts-progress-sub {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  color: var(--text-3);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.tts-progress-sub span {
  white-space: nowrap;
}
.tts-progress-sub span:last-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: right;
}
.tts-progress-hint {
  margin: 0;
  color: var(--text-3);
  font-size: 11px;
}
.tts-panel {
  position: absolute;
  top: calc(52px + var(--safe-top));
  right: 12px;
  z-index: 25;
  width: min(400px, calc(100% - 24px));
  padding: 14px 16px;
  max-height: calc(100% - 72px - var(--safe-top) - var(--safe-bottom));
  overflow-y: auto;
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
  width: 40px;
  flex-shrink: 0;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
/* 语速: 档位名在滑条下方, 标签和数值对齐滑条那一行 */
.tts-rate-row {
  align-items: flex-start;
}
.tts-rate-row label,
.tts-rate-row .tts-value {
  line-height: 22px;
}
.tts-rate-row :deep(.level-slider) {
  padding: 0 10px;
}
/* 定时关闭: 选项带单位, 标签放上面, 选项占满一行 */
.tts-row-stacked {
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
}
.tts-row-stacked label {
  width: auto;
}
.tts-row-stacked .seg {
  flex: none;
}
/* 触屏上 LevelSlider 的滑条更高 (32px) */
@media (hover: none) {
  .tts-rate-row label,
  .tts-rate-row .tts-value {
    line-height: 32px;
  }
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
@keyframes tts-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.75); }
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
.bar.top.hidden {
  transform: translateY(-100%);
}
.bar.bottom.hidden {
  transform: translateY(100%);
}
.chapter-btn {
  flex-shrink: 0;
}
.sheet-scrim {
  display: none;
}

@media (max-width: 720px) {
  .pdf-switch {
    padding: 0 9px;
  }
  .pdf-switch-long {
    display: none;
  }
  .pdf-switch-short {
    display: inline;
  }
  /* 手机页眉留白较窄 (见 applyPrefs 的 margin) */
  .tts-mini {
    --head-band: 36px;
    /* 剩余时间很长时省略, 定时和按钮始终在 */
    max-width: calc(100% - 16px);
  }
  .reader {
    --footer-h: 112px;
  }
  .chapter,
  .desk-only {
    display: none;
  }
  .bar {
    gap: 4px;
    padding-inline: max(8px, var(--lr-safe-left)) max(8px, var(--lr-safe-right));
    /* 小屏上工具栏压在正文上, 半透明会让正文 (尤其粗体标题) 透出来和栏内书名叠在一起 */
    background: var(--card);
  }
  .bar.top {
    padding-top: calc(6px + var(--safe-top));
    padding-bottom: 6px;
  }
  .icon-btn {
    width: 40px;
    height: 40px;
    border-radius: 10px;
  }
  .icon-btn:hover {
    background: none;
    color: var(--text-2);
  }
  .icon-btn:active {
    background: var(--surface-2);
  }
  .icon-btn.auto-on,
  .icon-btn.auto-on:hover {
    color: var(--brand);
  }
  .book-title strong {
    font-size: 15px;
    font-weight: 600;
  }
  .bar.bottom {
    padding-top: 4px;
    padding-bottom: calc(2px + var(--safe-bottom));
  }
  .progress-label {
    padding: 0 4px;
    min-height: var(--icon-btn);
  }
  .jump-pop {
    left: 12px;
    right: 12px;
    width: auto;
  }
  /* 16px 以下 iOS 会在聚焦时放大页面 */
  .jump-input {
    font-size: 16px;
  }
  .jump-back {
    left: 12px;
  }
  .dock {
    display: flex;
  }
  .dock button {
    flex: 1;
    min-width: 0;
    height: 54px;
    border: none;
    border-radius: 10px;
    background: none;
    color: var(--text-2);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    font-size: 11px;
  }
  .dock button:active {
    background: var(--surface-2);
  }
  .dock button.active {
    color: var(--brand);
  }

  /* 面板改为底部抽屉 */
  .sheet-scrim {
    display: block;
    position: absolute;
    inset: 0;
    z-index: 14;
    background: var(--overlay);
    animation: scrim-in var(--dur) var(--ease);
  }
  .panel,
  .tts-panel {
    top: auto;
    left: 0;
    right: 0;
    bottom: 0;
    width: auto;
    max-height: 78%;
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    border-bottom: none;
    padding: 18px max(16px, var(--lr-safe-right)) calc(16px + var(--safe-bottom)) max(16px, var(--lr-safe-left));
    box-shadow: var(--shadow-lg);
    animation: sheet-up var(--dur-slow) var(--ease);
  }
  .panel {
    height: 72%;
  }
  .tts-panel {
    overflow-y: auto;
    gap: 16px;
  }
  /* 抽屉顶部的拖拽指示条 */
  .panel::before,
  .tts-panel::before {
    content: '';
    position: absolute;
    top: 7px;
    left: 50%;
    width: 36px;
    height: 4px;
    margin-left: -18px;
    border-radius: 2px;
    background: var(--border-strong);
  }
  .seg button {
    height: 36px;
  }
  .anno-item,
  .search-item {
    padding: 10px 8px;
  }
  .anno-tabs button {
    height: 36px;
  }
  .hl-color {
    width: 44px;
    height: 44px;
  }
  .nav {
    display: none;
  }
}
@keyframes sheet-up {
  from {
    transform: translateY(40px);
    opacity: 0;
  }
  to {
    transform: none;
    opacity: 1;
  }
}
@keyframes scrim-in {
  from {
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .bar,
  .sheet-scrim,
  .panel,
  .tts-panel {
    transition: none;
    animation: none;
  }
}


.reader-panel-close { position: absolute; top: 10px; right: 12px; z-index: 1; }
.panel > h3, .panel .anno-tabs { padding-right: 38px; min-height: 40px; }
.listen-entry { position: absolute; z-index: 10; bottom: calc(var(--footer-h) + var(--safe-bottom) + 20px); right: max(20px, var(--lr-safe-right)); border: 1px solid var(--border); background: var(--card); color: var(--text-2); border-radius: var(--radius-pill); padding: 12px; display: flex; gap: 8px; align-items: center; min-height: 48px; box-shadow: var(--shadow-sm); }
.tts-panel { width: min(460px, calc(100% - 24px)); background: var(--bg); color: var(--text); gap: 18px; border: 0; }
.tts-head { min-height: 44px; flex-shrink: 0; }
.tts-head strong { font-size: 17px; }
.listen-hero { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px; }
.listen-cover { width: 150px; height: 210px; margin: 10px auto 8px; flex-shrink: 0; }
.listen-hero h2 { font-size: 20px; line-height: 1.4; overflow-wrap: anywhere; max-width: 100%; }
.listen-hero p { font-size: 13px; color: var(--text-3); }
.listen-options, .listen-links { display: flex; justify-content: space-around; gap: 8px; }
.listen-options button { display: flex; flex-direction: column; align-items: center; gap: 10px; border: 0; background: none; color: var(--text-2); font-size: 12px; min-height: 56px; flex: 1; min-width: 0; padding: 8px 0; }
.listen-options svg { width: 23px; height: 23px; }
.listen-options span { white-space: nowrap; }
.listen-state { text-align: center; color: var(--text-3); font-size: 12px; line-height: 1.6; }
.listen-state.error { color: var(--danger); }
.tts-transport { justify-content: space-between; gap: 4px; }
.tts-play { width: 66px; height: 66px; flex: 0 0 66px; border-radius: 50%; }
.tts-skip { min-width: 44px; min-height: 48px; padding: 6px 0; }
.listen-links button { min-height: 44px; border: 0; color: var(--text-2); background: none; flex: 1; border-radius: var(--radius); }
.listen-links button:hover, .listen-options button:hover { color: var(--brand); background: var(--brand-soft); }
.listen-quote { margin: 0; background: var(--card); color: var(--text-2); padding: 18px; border-radius: var(--radius-lg); font-size: 16px; line-height: 1.9; }
.listen-setting-body { padding: 20px; display: flex; flex-direction: column; gap: 20px; }
.listen-setting-body .tts-row .input { min-height: 44px; height: auto; }
.listen-setting-body .seg { flex-wrap: wrap; gap: 8px; }
.listen-setting-body .seg button { min-height: 44px; flex: 1 0 60px; border-radius: var(--radius-pill); }
@media (max-width: 720px) {
  .bar.top { background: var(--card); }
  .bar-actions { gap: 0; }
  .bar-actions .ambient-btn { display: inline-flex; }
  .icon-btn { width: 44px; height: 44px; }
  .tts-panel { inset: 0; width: 100%; height: 100%; max-height: none; border-radius: 0; padding: calc(var(--safe-top) + 8px) max(24px, var(--lr-safe-right)) calc(var(--safe-bottom) + 24px) max(24px, var(--lr-safe-left)); gap: 20px; box-shadow: none; }
  .tts-panel::before { display: none; }
  .tts-head { position: sticky; top: calc(-8px - var(--safe-top)); background: var(--bg); z-index: 1; padding-block: 4px; }
  .listen-cover { width: clamp(120px, 19vh, 172px); height: clamp(168px, 26.6vh, 241px); }
  .panel { background: var(--bg); border: 0; }
  .listen-entry span { display: none; }
}


.listen-ambient { align-self: center; color: var(--text-3); border: 0; background: transparent; min-height: 44px; padding: 8px 16px; }


.listen-cover :deep(.art-title) { font-size: 32px; }
.tts-panel { gap: 16px; }
.tts-message-slot { display: contents; }
.tts-head { position: relative; top: auto; display: grid; grid-template-columns: minmax(44px, 1fr) auto minmax(44px, 1fr); gap: 8px; }
.tts-head > span[style] { display: none; }
.tts-head > .icon-btn { grid-area: 1 / 1; justify-self: start; }
.tts-head > strong { grid-area: 1 / 2; justify-self: center; }
.tts-head > .btn { grid-area: 1 / 3; justify-self: end; }
.tts-head > .tts-sleep-badge, .tts-head > .tts-buffering { grid-column: 1 / -1; justify-self: center; }


.reader { --footer-h: 144px; }
.progress-meta { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; min-height: 32px; width: 100%; }.progress-chapter { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-3); font-size: 11px; }.progress-meta .progress-label { flex: 0 0 auto; min-width: 0; max-width: none; width: auto; white-space: nowrap; font-variant-numeric: tabular-nums; font-size: 12px; padding: 4px 0 4px 8px; height: 32px; }.page-number { white-space: nowrap; }.progress-row { display: grid; grid-template-columns: 44px minmax(0,1fr) 44px; gap: 4px; width: 100%; }.slider-wrap { width: 100%; min-width: 0; }.slider { width: 100%; height: 44px; }.bar.bottom { gap: 0; }
.jump-pop.progress-settings { position: static; inset: auto; width: auto; max-width: none; padding: 20px; box-shadow: none; border: 0; border-radius: 0; display: grid; gap: 14px; }.jump-overview { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-variant-numeric: tabular-nums; }.jump-overview > div { display: grid; gap: 6px; }.jump-overview small { font-size: 12px; color: var(--text-3); }.jump-overview strong { font-size: 32px; font-weight: 600; }.jump-overview > span { font-size: 12px; color: var(--text-2); text-align: end; }.jump-chapter { margin: 0; font-size: 13px; color: var(--text-2); line-height: 1.6; overflow-wrap: anywhere; }.jump-slider { width: 100%; height: 44px; margin: 0; accent-color: var(--brand); }.jump-tabs { display: flex; }.jump-tabs button { flex: 1; min-height: 44px; }.jump-field-label { font-size: 13px; }.jump-form { min-width: 0; }.jump-input { min-height: 44px; min-width: 0; }.jump-total { white-space: nowrap; }.jump-form .btn,.jump-undo { min-height: 44px; }.jump-meta,.jump-hint { margin: 0; line-height: 1.7; }
.listen-cover { width: 132px; height: 185px; margin: 4px auto; }.listen-hero h2 { font-size: 18px; }.listen-options { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 8px; }.listen-options button { border: 1px solid var(--border); border-radius: 12px; background: var(--card); gap: 5px; padding: 12px 4px; min-height: 82px; }.listen-options svg { width: 18px; height: 18px; }.listen-options small { font-size: 11px; color: var(--text-3); }.listen-options strong { font-size: 13px; font-weight: 600; color: var(--text); max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }.tts-progress-head,.tts-progress-sub { flex-wrap: wrap; gap: 4px 12px; }.tts-progress-eta { margin-left: auto; }.tts-progress-sub > span { white-space: normal; }.listen-setting-body .tts-row { min-width: 0; }.tts-panel { padding-inline: max(20px,var(--lr-safe-left)); }
@media(max-width:359px) { .progress-meta { gap: 6px; }.progress-meta .progress-label { font-size: 11px; }.tts-panel { padding-inline: 16px; }.listen-options strong { font-size: 12px; } }

</style>
