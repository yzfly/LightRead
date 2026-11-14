/**
 * 点睛阅读与 ReaderView 的对接层 (docs/dianjing-reading.md)。逻辑在 services/dianjing/*, 这里只做 Vue 状态与接线。
 *
 * ## 接线清单 (ReaderView.vue, 由主会话完成)
 *
 * ```ts
 * import { useDianjing } from '../composables/useDianjing'
 * const dj = useDianjing({
 *   getView: () => view,
 *   bookId,
 *   getMeta: () => meta.value && { title: meta.value.title, author: meta.value.author, language: meta.value.language,
 *     tags: meta.value.tags, subjects: view?.book?.metadata?.subject?.map((s: any) => typeof s === 'string' ? s : s?.name ?? '') },
 *   getThemeName: () => djThemeName(resolveReaderTheme(settings.reader.theme, appDark.value), !!modes.readerStyle?.value?.eink),
 *   isEink: () => !!modes.readerStyle?.value?.eink,            // 墨水屏: 标记攒到翻页时一起画
 *   getChapterTitle: i => sectionTitle(i),                     // 可选, 缺省从 view.book.toc 推断
 *   adoptHighlight: async ({ index, range, text, withNote }) => {
 *     // 「我也觉得」: 转成用户自己的划线 (与 addHighlight 相同的存储, 颜色用最近一次的颜色)
 *     const cfi = view.getCFI(index, range); …storage.addAnnotation({ bookId, kind: 'highlight', cfi, text, color, createdAt })
 *     … view.addAnnotation(...); if (withNote) 打开想法编辑
 *   },
 *   openAi: prompt => { panel.value = 'ai'; void sendAi(prompt) },   // 概念卡「展开」
 *   basic: { isOn, set, supported },                           // 基础版 (按词着色) 的开关, 见下文「两个版本」
 *   beforeOverlay: closeOverlays,                              // 弹卡 / 面板前收起其他浮层
 * })
 * ```
 * 1. onSectionLoad(e): 加 `dj.onSectionLoad(e.detail)` (在 modes.onSectionLoad 之后)。
 * 2. onRelocate(e): 加 `dj.onRelocate(e.detail)`。
 * 3. onContentClick(clientX, doc, target) 需要 clientY: 两处调用 (click / touchend) 补传 e.clientY / t0.clientY;
 *    在选区判断之后、modes.onContentTap 之前加 `if (dj.onContentTap(doc, clientX, clientY)) return`
 *    (命中概念 / 注时弹出 DianjingCard, 不翻页)。
 * 4. 选区工具条: 选区变化时 (updateSelection 里拿到 range 后) 调 `dj.onSelection(index, range)`;
 *    返回 true 表示选区落在要句上, 工具条里显示一组按钮 (`dj.selectionKey.value` 非空时):
 *    「为什么标」→ `dj.openKeyCard()`; 其余动作在卡片里 (翻译 / 我也觉得 / 不是重点 / 写想法)。
 * 5. handleKeydown: 在 modes.handleKey 之后加 `if (dj.handleKey(e)) return` (D 开关, [ ] 上一个 / 下一个要句)。
 * 6. 模板:
 *    - 阅读模式面板顶部 (ReadingModePanel 由阅读模式 agent 维护, 主会话放置):
 *      `<DianjingToggle :dj="dj" @open-outline="dj.openOutline()" @open-skim="dj.openSkim()" />`
 *    - `<DianjingConsent v-if="dj.consentOpen.value" :dj="dj" />`
 *    - `<DianjingCard v-if="dj.card.value" :dj="dj" />`
 *    - `<DianjingChapterCard v-if="dj.chapterCard.value" :dj="dj" />` (阅读区顶部, iframe 之外, 不重排正文)
 *    - `<DianjingOutline v-if="dj.outlineOpen.value" :dj="dj" />` (侧栏「脉络」, 可放进现有侧栏面板)
 *    - `<DianjingSkim v-if="dj.skimOpen.value" :dj="dj" />` (全屏速读视图)
 *    - 状态点: `<DianjingStatus :dj="dj" />` (阅读区角落; 沉浸模式下隐藏)
 * 7. closeOverlays(): 加 `dj.closeOverlays()`; sheetOpen / pauseWhen 可加 `dj.overlayOpen.value`。
 * 8. onBeforeUnmount: `dj.dispose()` (也随组件作用域自动调用)。
 * 9. 其他模式联动 (可选, 见 docs §5):
 *    - 打字机: 光标移动时 `dj.setTypewriterLimit(doc, node, offset)` (光标之后不画点睛标记), 退出时 `dj.setTypewriterLimit(null)`;
 *      减速 `dj.isKeySentence(range)` → 速度 × 0.7; 速读视图下跳过非要句: `dj.keySentenceRanges()`。
 *    - 听书: 读每句前 `dj.isKeyPosition(sectionIndex, cursor.pos.block, cursor.pos.sentence)` → 停顿 300ms、语速 -8%;
 *      章首先读要义: `dj.chapterGist(sectionIndex)` (文本或 null)。编号与 SentenceCursor 一致。
 *    - 歌词: 聚焦行停在要句上时停留 × 1.3: `dj.isKeySentence(lineRange)`。
 *    - 两个版本 (services/dianjing/level.ts): 基础版 = 按词着色 (绘制在 useReadingModes, 只在选了基础版时画);
 *      智能版 = 本文件的 AI 引擎 (`enabled` / `active` 只在选了智能版时为 true)。所有入口 (面板开关、D 键)
 *      都走 `toggle()` / `setLevel()` / `switchToBasic()`, 按读者上次选的版本开关。
 *    - 注意: readingModes/revealLayer.clearReadingModeMarks() 会删除所有 `lr-` 开头的 Highlight (含 lr-dj-*);
 *      点睛在每次 relocate / 绘制时会自动重新登记, 但建议把该函数的前缀收窄为 `lr-tw-`。
 */
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { useSettings } from '../stores/settings'
import { t } from '../i18n'
import { toast } from '../services/toast'
import { aiConfigured, providerById, TRIAL_BASE_URL } from '../services/ai'
import { LOCAL_AI_PROVIDER } from '../services/localChatCore'
import { DianjingEngine, type CardTarget, type DjPosition, type DjStatus } from '../services/dianjing/engine'
import { streamDianjing, type DjChannel } from '../services/dianjing/client'
import { djColors } from '../services/dianjing/theme'
import { selectKeys, selectTerms, type Density, type KeyItem, type TermItem } from '../services/dianjing/protocol'
import type { ChunkRecord } from '../services/dianjing/cache'
import { getDjCache } from '../services/dianjing/cache'
import { applyDjAction, normalizeLevel, smartOnFor, type DjAction, type DjLevel, type DjSwitchState } from '../services/dianjing/level'

export interface DjMeta {
  title?: string
  author?: string
  language?: string
  subjects?: string[]
  tags?: string[]
}

export interface UseDianjingOptions {
  /** Optional fine density supplied by a host; legacy hosts retain presets. */
  densityAmount?: () => number | undefined
  getView: () => any
  bookId: string
  getMeta: () => DjMeta | null | undefined
  /** djThemeName(正文主题, 墨水屏) */
  getThemeName: () => string
  isEink?: () => boolean
  getChapterTitle?: (section: number) => string
  /** 「我也觉得」/「写想法」: 转成用户自己的划线 */
  adoptHighlight?: (a: { index: number; range: Range; text: string; withNote: boolean }) => void | Promise<void>
  /** 概念卡「展开」: 打开 AI 侧栏并发送 prompt */
  openAi?: (prompt: string) => void
  /** 弹卡 / 打开面板前收起其他浮层 */
  beforeOverlay?: () => void
  /** 跳到一句 (CFI): 宿主按阅读焦点放置 (滚动模式落在屏幕 38% 处); 不给则用 view.goTo */
  goToText?: (cfi: string) => Promise<unknown>
  /** 基础版 (按词着色, 不联网): 开关与是否可用; 由阅读模式实现绘制 */
  basic?: {
    isOn: () => boolean
    set: (on: boolean) => void
    /** 当前系统能画按词着色 (旧 WebView 不能) */
    supported: () => boolean
    /** 这本书能用「重点词」(中文书); 不给视为能 */
    keyWordsSupported?: () => boolean
  }
  /** AI 重点词变了 (某节有块完成、从缓存补齐, 或全书词表变了): 阅读器让「重点词」层重新取词 */
  onKeyWords?: (section: number | null) => void
}

export interface DjCardState {
  target: CardTarget
  /** 宿主页面视口坐标 (卡片定位) */
  rect: { left: number; top: number; right: number; bottom: number }
  translation?: string
  translating?: boolean
  translateError?: boolean
}

export interface OutlinePoint { text: string; pos: DjPosition; why?: string; r?: number }
export interface OutlineSection {
  section: number
  title: string
  summary?: string
  points: OutlinePoint[]
  gists: OutlinePoint[]
  keys: OutlinePoint[]
  current: boolean
}
export interface OutlineData {
  sections: OutlineSection[]
  glossary: Array<{ q: string; def: string; pos: DjPosition }>
  /** 叙述类: 只列到读者当前位置 */
  spoilerSafe: boolean
}

const isMobile = () => {
  try {
    return /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) || !!window.matchMedia?.('(pointer: coarse)').matches
  } catch { return false }
}

export function useDianjing(opts: UseDianjingOptions) {
  const settings = useSettings()
  const prefs = computed(() => settings.dianjing)

  /** 引擎状态变化的版本号 (引擎是普通对象, 用它驱动计算属性) */
  const tick = ref(0)
  const bump = () => { tick.value++ }

  const consentOpen = ref(false)
  const card = shallowRef<DjCardState | null>(null)
  const outlineOpen = ref(false)
  const skimOpen = ref(false)
  const outline = shallowRef<OutlineData | null>(null)
  const outlineLoading = ref(false)
  const chapterCardCollapsed = ref<Record<number, boolean>>({})
  const selectionKey = shallowRef<CardTarget | null>(null)
  const supported = ref(true)
  let pendingFlash: DjPosition | null = null

  let reducedMotion = false
  try { reducedMotion = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches } catch { /* 无 matchMedia */ }

  const channel = (): DjChannel | null => {
    const mode = prefs.value.channel
    const provider = providerById(settings.aiProvider)
    const own = provider.id !== 'trial' && provider.id !== LOCAL_AI_PROVIDER && aiConfigured() && !settings.aiBaseUrl.startsWith(TRIAL_BASE_URL)
    const ownChannel: DjChannel = { kind: 'own', baseUrl: settings.aiBaseUrl, apiKey: settings.aiApiKey, model: settings.aiModel }
    if (mode === 'own') return own ? ownChannel : null
    if (mode === 'auto' && own) return ownChannel
    return { kind: 'builtin', baseUrl: TRIAL_BASE_URL }
  }

  const view = () => opts.getView()

  const sectionTitle = (i: number): string => {
    try {
      const custom = opts.getChapterTitle?.(i)
      if (custom) return custom
      const v = view()
      let found = ''
      const walk = (items: any[]) => {
        for (const it of items ?? []) {
          if (found) return
          try { if (v.book.resolveHref?.(it.href)?.index === i) { found = String(it.label ?? '').trim(); return } } catch { /* 无法解析 */ }
          walk(it.subitems)
        }
      }
      walk(v?.book?.toc ?? [])
      return found
    } catch { return '' }
  }

  const engine = new DianjingEngine({
    bookId: opts.bookId,
    book: () => opts.getMeta() ?? {},
    uiLang: () => (settings.language === 'en' ? 'en' : 'zh'),
    chapterTitle: sectionTitle,
    sectionCount: () => view()?.book?.sections?.length ?? 0,
    sectionLinear: i => view()?.book?.sections?.[i]?.linear !== 'no',
    sectionDoc: async i => {
      const s = view()?.book?.sections?.[i]
      return s?.createDocument ? await s.createDocument() : null
    },
    channel,
    density: () => prefs.value.density as Density,
    densityAmount: opts.densityAmount,
    kinds: () => prefs.value.kinds,
    fictionOverride: () => prefs.value.fiction[opts.bookId] ?? null,
    colors: () => djColors(opts.getThemeName()),
    getOverlayer: i => view()?.renderer?.getContents?.()?.find((c: any) => c.index === i)?.overlayer ?? null,
    concurrency: () => (isMobile() ? 2 : 3),
    batchPaint: () => !!opts.isEink?.() || reducedMotion,
    onChange: bump,
    onKeyWords: section => opts.onKeyWords?.(section),
  })

  /** 选的版本: 基础 (按词着色) / 智能 (AI) */
  const level = computed<DjLevel>(() => normalizeLevel(prefs.value.level))
  /** 智能版在本书开着 (只在选了智能版时为 true; AI 引擎随它启停) */
  const enabled = computed(() => level.value === 'smart' && smartOnFor(prefs.value, opts.bookId))
  const basicOn = computed(() => level.value === 'basic' && !!opts.basic?.isOn())
  /** 点睛阅读开着 (按所选版本) */
  const on = computed(() => basicOn.value || enabled.value)
  const basicSupported = computed(() => opts.basic?.supported() ?? true)
  /** 这本书能用「重点词」(中文书) */
  const keyWordsSupported = computed(() => opts.basic?.keyWordsSupported?.() ?? true)

  const status = computed<DjStatus>(() => {
    void tick.value
    if (!supported.value) return 'unsupported'
    if (consentOpen.value) return 'consent'
    if (!enabled.value) return 'idle'
    return engine.status
  })
  const errorCode = computed(() => { void tick.value; return engine.error?.code ?? null })
  const progress = computed(() => { void tick.value; return engine.progress() })
  const remaining = computed(() => { void tick.value; return engine.remaining })
  const fiction = computed(() => { void tick.value; return engine.fiction })
  const fictionSource = computed(() => { void tick.value; return engine.fictionSource })
  const active = computed(() => enabled.value && supported.value)

  const density = computed<Density>({
    get: () => prefs.value.density as Density,
    set: v => { settings.dianjing.density = v },
  })

  // ---- 开关 ----

  function refreshSupport() {
    const v = view()
    supported.value = !v || !v.isFixedLayout
  }

  function syncEngine() {
    refreshSupport()
    if (active.value) engine.start()
    else if (engine.active) engine.stop()
    bump()
  }

  /** 走一步开关状态机 (services/dianjing/level.ts), 把变化写回设置; 返回 false 表示先弹了同意说明 */
  function apply(action: DjAction): boolean {
    const p = prefs.value
    const before: DjSwitchState = {
      level: level.value,
      basicOn: !!opts.basic?.isOn(),
      perBook: p.perBook,
      consentAll: p.consentAll,
      enabled: p.enabled,
    }
    const { state, needConsent } = applyDjAction(before, opts.bookId, action)
    if (needConsent) {
      opts.beforeOverlay?.()
      consentOpen.value = true
      return false
    }
    if (state.basicOn !== before.basicOn) opts.basic?.set(state.basicOn)
    if (state.consentAll !== p.consentAll) settings.dianjing.consentAll = state.consentAll
    if (state.enabled !== p.enabled) settings.dianjing.enabled = state.enabled
    if (state.perBook[opts.bookId] !== p.perBook[opts.bookId]) settings.dianjing.perBook = state.perBook
    if (state.level !== p.level) settings.dianjing.level = state.level
    return true
  }

  /** 总开关 (面板开关、D 键): 按上次选的版本开 / 关; 智能版未同意时弹同意说明 */
  function toggle() {
    refreshSupport()
    if (!supported.value) {
      toast(t('dianjing.unsupported'), 'error')
      return
    }
    apply({ kind: 'toggle' })
  }

  /** 选版本 (面板里的「基础 / 智能」): 开着时把「开」带到新版本 (智能版未同意时先弹同意说明, 期间基础版照常开着) */
  function setLevel(next: DjLevel) {
    apply({ kind: 'setLevel', level: next })
  }

  /** 「先用基础版」: 智能版用不了 (额度 / 配置 / 离线) 或不想联网时, 一步换成基础版并开着 */
  function switchToBasic() {
    consentOpen.value = false
    apply({ kind: 'switchToBasic' })
  }

  /** 同意 (智能版): 仅本书 / 所有书 */
  function consent(scope: 'book' | 'all') {
    consentOpen.value = false
    apply({ kind: 'consent', scope })
  }

  function cancelConsent() { consentOpen.value = false }

  watch(active, syncEngine)
  watch(() => [prefs.value.density, opts.densityAmount?.(), prefs.value.kinds.key, prefs.value.kinds.term, prefs.value.kinds.note], () => engine.repaint())
  watch(() => opts.getThemeName(), () => engine.repaint())
  watch(() => prefs.value.fiction[opts.bookId], () => engine.refreshFiction())
  watch(() => [settings.aiProvider, settings.aiBaseUrl, settings.aiApiKey, settings.aiModel, prefs.value.channel], () => engine.resetErrors())
  watch(card, c => { if (!c) selectionKey.value = null })

  // ---- ReaderView 事件 ----

  function onSectionLoad(detail: { doc: Document; index: number } | null | undefined) {
    if (!detail?.doc) return
    refreshSupport()
    // 跨章连续滚动时 getContents() 含所有已载分节 (预载的邻章也会 load)
    const live = new Set<number>((view()?.renderer?.getContents?.() ?? []).map((c: any) => c.index))
    live.add(detail.index)
    engine.attach(detail.index, detail.doc, live)
    // 不再显示的分节: 释放绘制层
    for (const k of engine.sections.keys()) if (!live.has(k)) engine.detach(k)
    if (active.value && !engine.active) engine.start()
  }

  /** 跨章连续滚动: 渲染器卸载远处的分节 (文档随后销毁), 释放它的绘制层 */
  function onSectionUnload(detail: { doc?: Document | null; index?: number } | null | undefined) {
    const index = detail?.index
    if (typeof index !== 'number' || !detail?.doc) return
    // 同一节可能刚以新文档重新载入 (重建槽位), 只释放属于被卸载文档的那一层
    if (engine.sections.get(index)?.model.doc === detail.doc) engine.detach(index)
  }

  function onRelocate(detail: { range?: Range | null; index?: number; section?: { current?: number } } | null | undefined) {
    if (!detail) return
    // view 转发的 relocate 没有 index, 分节号在 section.current
    const index = typeof detail.section?.current === 'number' ? detail.section.current
      : typeof detail.index === 'number' ? detail.index : view()?.renderer?.getContents?.()?.[0]?.index
    if (typeof index !== 'number') return
    engine.relocate(index, detail.range ?? null)
    if (pendingFlash && pendingFlash.section === index) {
      const p = pendingFlash
      pendingFlash = null
      setTimeout(() => engine.flash(p), 60)
    }
  }

  /** 视口坐标: iframe 内的 rect → 宿主页面坐标 */
  function hostRect(range: Range) {
    const r = range.getBoundingClientRect()
    let dx = 0
    let dy = 0
    try {
      const fr = (range.startContainer.ownerDocument?.defaultView as any)?.frameElement?.getBoundingClientRect?.()
      if (fr) { dx = fr.left; dy = fr.top }
    } catch { /* 跨域 */ }
    return { left: r.left + dx, top: r.top + dy, right: r.right + dx, bottom: r.bottom + dy }
  }

  function openCard(target: CardTarget) {
    opts.beforeOverlay?.()
    card.value = { target, rect: hostRect(target.range), translation: target.translation }
  }

  /** 轻点正文: 命中概念 / 注时弹卡并返回 true (调用方不再翻页) */
  function onContentTap(doc: Document, x: number, y: number): boolean {
    if (!engine.active) return false
    if (card.value) { card.value = null; return true }
    const index = engine.sectionOfDoc(doc)
    if (index == null) return false
    const hit = engine.hit(index, doc, x, y)
    if (!hit) return false
    openCard(hit)
    return true
  }

  /** 选区变化: 落在可见要句上时记下 (选区工具条显示点睛分组) */
  function onSelection(index: number, range: Range | null): boolean {
    selectionKey.value = range && engine.active ? engine.keyAt(index, range) : null
    return !!selectionKey.value
  }

  function openKeyCard(target = selectionKey.value) {
    if (target) openCard(target)
  }

  function closeCard() { card.value = null }

  // ---- 卡片动作 ----

  async function translate() {
    const c = card.value
    if (!c || c.translating) return
    if (c.translation) return
    const ch = channel()
    if (!ch) return
    const s = engine.sections.get(c.target.section)
    const pos = c.target.item
    const sentence = s?.model.sentenceTexts(pos.block)[pos.sentence] ?? c.target.text
    card.value = { ...c, translating: true, translateError: false }
    let text = ''
    try {
      const meta = opts.getMeta() ?? {}
      const lang = settings.language === 'en' ? 'en' : 'zh'
      // 中文书在中文界面下「翻译」= 译成英文; 其他情况译成界面语言
      const bookLang = s?.model.lang || meta.language || ''
      const target: 'zh' | 'en' = lang === 'zh' && /^zh/i.test(bookLang) ? 'en' : lang
      await streamDianjing({ mode: 'translate', lang: target, bookLang, book: { title: meta.title, author: meta.author }, text: `[1.1] ${sentence}` }, ch, raw => {
        if (raw.t === 'tr' && typeof raw.text === 'string') text += (text ? ' ' : '') + raw.text
      })
    } catch { /* 下面统一处理 */ }
    if (card.value?.target !== c.target) return
    card.value = { ...card.value, translating: false, translation: text || undefined, translateError: !text }
  }

  async function adopt(withNote = false) {
    const c = card.value
    if (!c) return
    const range = c.target.range
    const text = range.toString().replace(/\s+/g, ' ').trim()
    try {
      await opts.adoptHighlight?.({ index: c.target.section, range, text, withNote })
      await engine.feedback(c.target.item.id, 'adopt')
      if (!withNote) toast(t('dianjing.adopted'), 'success')
    } catch {
      toast(t('dianjing.adoptFailed'), 'error')
    }
    card.value = null
  }

  async function dismiss() {
    const c = card.value
    if (!c) return
    await engine.feedback(c.target.item.id, 'dismiss')
    card.value = null
    toast(t('dianjing.dismissed'))
  }

  /** 概念卡「展开」: 原段落 + 已有释义交给 AI 侧栏 */
  function expand() {
    const c = card.value
    if (!c || !opts.openAi) return
    const s = engine.sections.get(c.target.section)
    const para = s?.model.sentenceTexts(c.target.item.block).join('') ?? ''
    const item = c.target.item as TermItem
    const en = settings.language === 'en'
    const prompt = en
      ? `In this book, what does "${c.target.text}" mean? Explain with the context below, without revealing later plot.\n\nContext: "${para.slice(0, 600)}"${item.def ? `\nBrief note so far: ${item.def}` : ''}`
      : `本书中的「${c.target.text}」是什么意思？请结合下面的上下文展开解释（不要透露后文情节）。\n\n上下文：「${para.slice(0, 600)}」${item.def ? `\n已有简释：${item.def}` : ''}`
    card.value = null
    opts.openAi(prompt)
  }

  // ---- 跳转 ----

  async function goTo(pos: DjPosition) {
    const v = view()
    if (!v) return
    const range = await engine.rangeFor(pos)
    let target: string | number = pos.section
    try { if (range) target = v.getCFI(pos.section, range) } catch { /* 退回分节 */ }
    pendingFlash = pos
    try {
      if (typeof target === 'string' && opts.goToText) await opts.goToText(target)
      else await v.goTo(target)
    } catch { pendingFlash = null }
  }

  /** 当前节内上一个 / 下一个要句 */
  function jumpKey(dir: 1 | -1): boolean {
    const p = engine.position
    if (!p || !engine.active) return false
    const keys = engine.visible(p.section).keys
      .map(k => ({ block: k.block, sentence: k.sentence }))
      .sort((a, b) => a.block - b.block || a.sentence - b.sentence)
    const cmp = (a: { block: number; sentence: number }) => a.block - p.block || a.sentence - p.sentence
    const next = dir > 0 ? keys.find(k => cmp(k) > 0) : [...keys].reverse().find(k => cmp(k) < 0)
    if (!next) return false
    void goTo({ section: p.section, ...next })
    return true
  }

  // ---- 章首要义 ----

  const chapterCard = computed(() => {
    void tick.value
    if (!engine.active || !prefs.value.chapterCard) return null
    const p = engine.position
    if (!p) return null
    const data = engine.chapterCard(p.section)
    if (!data || chapterCardCollapsed.value[p.section]) return null
    // 只在本节开头 (第一块之内) 显示
    const s = engine.sections.get(p.section)
    const first = s?.chunks[0]?.chunk.blocks
    const firstLast = first?.length ? first[first.length - 1].block : 0
    if (p.block > firstLast) return null
    return { ...data, title: sectionTitle(data.section) }
  })

  function collapseChapterCard() {
    const p = engine.position
    if (p) chapterCardCollapsed.value = { ...chapterCardCollapsed.value, [p.section]: true }
  }

  /** 听书: 章首先读要义 (叙述类为上一章回顾); 没有返回 null */
  function chapterGist(section: number): string | null {
    const c = engine.chapterCard(section)
    return c ? c.summary.text : null
  }

  // ---- 脉络 / 速读 ----

  async function loadOutline() {
    outlineLoading.value = true
    try {
      const { chunks, sections } = await engine.bookRecords()
      // 同一块可能有两个模型的结果: 按 (节, 块序号) 取最新
      const latest = new Map<string, ChunkRecord>()
      for (const c of chunks) {
        const k = `${c.section}:${c.chunkIndex}`
        const prev = latest.get(k)
        if (!prev || prev.at < c.at) latest.set(k, c)
      }
      // 已加载分节的块边界以内存为准 (排除旧版式留下的过期块)
      for (const s of engine.sections.values()) {
        const hashes = new Set(s.chunks.map(c => c.chunk.hash))
        for (const [k, rec] of latest) if (rec.section === s.index && !hashes.has(rec.chunkHash)) latest.delete(k)
      }
      const pos = engine.position
      const spoilerSafe = engine.fiction
      const before = (p: DjPosition) => !spoilerSafe || !pos || p.section < pos.section || (p.section === pos.section && (p.block < pos.block || (p.block === pos.block && p.sentence <= pos.sentence)))
      const bySection = new Map<number, OutlineSection>()
      const glossary = new Map<string, { q: string; def: string; pos: DjPosition }>()
      const dens = prefs.value.density as Density
      const recs = [...latest.values()].sort((a, b) => a.section - b.section || a.chunkIndex - b.chunkIndex)
      for (const rec of recs) {
        let sec = bySection.get(rec.section)
        if (!sec) {
          sec = { section: rec.section, title: sectionTitle(rec.section), points: [], gists: [], keys: [], current: pos?.section === rec.section }
          bySection.set(rec.section, sec)
        }
        const keys = rec.items.filter((i): i is KeyItem => i.t === 'key' && !engine.dismissed.has(i.id))
        const chosen = selectKeys(keys, k => rec.lengths[`${k.block}.${k.sentence}`] ?? 40, rec.chars, dens, opts.densityAmount?.())
        for (const k of keys) {
          const p = { section: rec.section, block: k.block, sentence: k.sentence }
          if (chosen.has(k.id) && before(p)) sec.keys.push({ text: rec.texts[k.id] ?? '', why: k.why, r: k.r, pos: p })
        }
        for (const it of rec.items) {
          if (it.t === 'gist') {
            const p = { section: rec.section, block: it.block, sentence: 0 }
            if (before(p)) sec.gists.push({ text: it.text, pos: p })
          }
        }
        for (const term of selectTerms(rec.items.filter((i): i is TermItem => i.t === 'term'), 'high')) {
          const p = { section: rec.section, block: term.block, sentence: term.sentence }
          if (!glossary.has(term.q) && before(p)) glossary.set(term.q, { q: term.q, def: term.def, pos: p })
        }
      }
      for (const sum of sections) {
        const sec = bySection.get(sum.section)
        if (!sec) continue
        // 叙述类: 只显示读者已读完的章节要义
        if (spoilerSafe && pos && sum.section >= pos.section) continue
        sec.summary = sum.text
        sec.points = sum.points.map(pt => ({ text: pt.text, pos: { section: sum.section, block: pt.block, sentence: pt.sentence } }))
      }
      outline.value = {
        sections: [...bySection.values()].filter(s => s.keys.length || s.gists.length || s.summary).sort((a, b) => a.section - b.section),
        glossary: [...glossary.values()],
        spoilerSafe,
      }
    } finally {
      outlineLoading.value = false
    }
  }

  function openOutline() {
    opts.beforeOverlay?.()
    outlineOpen.value = true
    void loadOutline()
  }

  function openSkim() {
    opts.beforeOverlay?.()
    skimOpen.value = true
    engine.setBand(true)
    void loadOutline()
  }

  function closeSkim() {
    skimOpen.value = false
    engine.setBand(false)
  }

  function closeOverlays() {
    card.value = null
    outlineOpen.value = false
    if (skimOpen.value) closeSkim()
    consentOpen.value = false
  }

  const overlayOpen = computed(() => !!card.value || outlineOpen.value || skimOpen.value || consentOpen.value)

  // ---- 其他模式联动 ----

  function isKeySentence(range: Range | null | undefined): boolean {
    return !!range && engine.active && engine.isKeyRange(range)
  }

  function keySentenceRanges(section?: number): Range[] {
    const i = section ?? engine.position?.section
    return engine.active && typeof i === 'number' ? engine.keyRanges(i) : []
  }

  function isKeyPosition(section: number, block: number, sentence: number): boolean {
    return engine.active && engine.isKey(section, block, sentence)
  }

  function setTypewriterLimit(doc: Document | null, node?: Node | null, offset = 0) {
    if (!doc) {
      for (const k of engine.sections.keys()) engine.setLimit(k, null)
      return
    }
    const i = engine.sectionOfDoc(doc)
    if (i != null) engine.setLimit(i, node ?? null, offset)
  }

  // ---- 键盘 ----

  function handleKey(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return false
    const el = e.target as HTMLElement | null
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName ?? ''))) return false
    if ((e.key === 'd' || e.key === 'D') && !e.shiftKey) {
      const was = on.value
      toggle()
      // 键盘开关没有可见的按钮反馈: 说一声开的是哪个版本 (弹出同意说明时不提示)
      if (on.value !== was) {
        toast(on.value ? t('dianjing.turnedOn', { level: t(level.value === 'smart' ? 'dianjing.levelSmartName' : 'dianjing.levelBasicName') }) : t('dianjing.turnedOff'))
      }
      e.preventDefault()
      return true
    }
    if ((e.key === ']' || e.key === '[') && engine.active) {
      if (jumpKey(e.key === ']' ? 1 : -1)) { e.preventDefault(); return true }
      return false
    }
    if (e.key === 'Escape' && overlayOpen.value) {
      closeOverlays()
      return true
    }
    return false
  }

  // ---- 缓存 ----

  async function clearBookCache() {
    await engine.clearBookCache()
    toast(t('dianjing.cacheCleared'), 'success')
  }

  function redoSection() {
    const p = engine.position
    if (p) engine.redoSection(p.section)
  }

  async function cacheSize(): Promise<number> {
    return getDjCache().size()
  }

  function setFiction(v: 'fiction' | 'nonfiction' | null) {
    const next = { ...prefs.value.fiction }
    if (v) next[opts.bookId] = v
    else delete next[opts.bookId]
    settings.dianjing.fiction = next
  }

  function dispose() {
    engine.dispose()
  }
  onScopeDispose(dispose)

  // 初始: 已开启的书立即开始 (分节加载后绘制)
  if (active.value) engine.start()

  return {
    engine,
    // 状态
    level,
    on,
    basicOn,
    basicSupported,
    keyWordsSupported,
    enabled,
    active,
    supported,
    status,
    errorCode,
    progress,
    remaining,
    fiction,
    fictionSource,
    density,
    prefs,
    consentOpen,
    card,
    selectionKey,
    chapterCard,
    outline,
    outlineLoading,
    outlineOpen,
    skimOpen,
    overlayOpen,
    // 开关
    toggle,
    setLevel,
    switchToBasic,
    consent,
    cancelConsent,
    setFiction,
    // 事件
    onSectionLoad,
    onSectionUnload,
    onRelocate,
    onContentTap,
    onSelection,
    handleKey,
    // 卡片
    openKeyCard,
    closeCard,
    translate,
    adopt,
    dismiss,
    expand,
    // 跳转 / 视图
    goTo,
    jumpKey,
    collapseChapterCard,
    openOutline,
    openSkim,
    closeSkim,
    closeOverlays,
    loadOutline,
    // 联动
    isKeySentence,
    keySentenceRanges,
    isKeyPosition,
    chapterGist,
    setTypewriterLimit,
    // 缓存
    clearBookCache,
    redoSection,
    cacheSize,
    dispose,
  }
}

export type Dianjing = ReturnType<typeof useDianjing>
