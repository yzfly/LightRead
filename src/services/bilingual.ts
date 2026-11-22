/**
 * 双语对照 (issue #23, 2026-11-19 用户确认: 逐段翻译, 只用本机翻译模型):
 * 从当前看到的第一段起, 用本机模型 (混元 Hy-MT2, services/localLlm.ts) 逐段往后翻,
 * 译文流式写进段落末尾的 <span data-lr-inert class="lr-bilingual">; 翻过的按「书 + 模型」存进
 * IndexedDB (lightread-bilingual), 再打开同一段直接显示, 不再调用模型。
 * 不联网, 也不走账号额度 / 自己的 Key —— 没下载本机模型时设置里只给下载入口。
 * 规则 (哪些段落要翻、预翻几段、缓存键) 在 bilingualCore.ts; 阅读页经分节加载 / 翻页钩子调用这里。
 */
import { useSettings } from '../stores/settings'
import { logEvent } from './diagnostics'
import { localLlm, localTranslateModel } from './localLlm'
import { translateLocal } from './translate'
import {
  BILINGUAL_CLASS,
  BILINGUAL_CSS,
  INERT_ATTR,
  bookCacheKey,
  cleanTranslation,
  entryKey,
  isInertNode,
  normalizeParagraph,
  paragraphTarget,
  planParagraphs,
} from './bilingualCore.ts'
import type { TranslateLang } from './translateCore.ts'

/** 本机翻译模型已下载、这台设备能用、没有因闪退停用 */
export function bilingualModelReady(): boolean {
  const m = localLlm.available ? localTranslateModel() : undefined
  return !!m && m.installed && m.supported && !m.crashed
}

// ---- 段落 ----

/** 当作「一段」的元素: 自身不再包含块级子元素 */
const LEAF_TAGS = new Set(['p', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'dd', 'dt', 'figcaption', 'div', 'caption'])
const BLOCK_SELECTOR = 'p,li,blockquote,h1,h2,h3,h4,h5,h6,dd,dt,figcaption,div,caption,table,ul,ol,dl,pre,section,article,figure,hr,math,svg'
const SKIP_ANCESTOR = 'pre,table,nav,svg,math,code,script,style'

/** 段落原文 (不含已插入的译文) */
function paragraphText(el: Element): string {
  const doc = el.ownerDocument
  const walker = doc.createTreeWalker(el, 0x1 | 0x4, {
    acceptNode: n => {
      if (n.nodeType === 1) {
        const name = (n as Element).localName
        if ((n as Element).hasAttribute(INERT_ATTR) || name === 'rt' || name === 'rp' || name === 'script' || name === 'style') return 2
        return 3 // SKIP
      }
      return 1
    },
  })
  let text = ''
  for (let n = walker.nextNode(); n; n = walker.nextNode()) text += (n as Text).data
  return normalizeParagraph(text)
}

const paraCache = new WeakMap<Document, Element[]>()
function paragraphsOf(doc: Document): Element[] {
  let list = paraCache.get(doc)
  if (list) return list
  list = []
  const body = doc.body
  if (body) {
    for (const el of Array.from(body.querySelectorAll(Array.from(LEAF_TAGS).join(',')))) {
      if (isInertNode(el) || el.closest(SKIP_ANCESTOR)) continue
      if (el.querySelector(BLOCK_SELECTOR)) continue
      if (!/\p{L}/u.test(el.textContent ?? '')) continue
      list.push(el)
    }
  }
  paraCache.set(doc, list)
  return list
}

function translationOf(el: Element): HTMLElement | null {
  const last = el.lastElementChild
  return last && last.hasAttribute(INERT_ATTR) && last.classList.contains(BILINGUAL_CLASS) ? (last as HTMLElement) : null
}

function ensureStyle(doc: Document) {
  if (doc.getElementById('lr-bilingual-style')) return
  const style = doc.createElement('style')
  style.id = 'lr-bilingual-style'
  style.setAttribute(INERT_ATTR, '')
  style.textContent = BILINGUAL_CSS
  ;(doc.head ?? doc.documentElement).appendChild(style)
}

function attach(el: Element, text: string, lang: TranslateLang, pending = false): HTMLElement {
  let span = translationOf(el)
  if (!span) {
    const doc = el.ownerDocument
    ensureStyle(doc)
    span = doc.createElement('span')
    span.className = BILINGUAL_CLASS
    span.setAttribute(INERT_ATTR, '')
    el.appendChild(span)
  }
  span.lang = lang
  span.textContent = text
  if (pending) span.setAttribute('data-pending', '')
  else span.removeAttribute('data-pending')
  return span
}

function removeAll(doc: Document) {
  for (const span of Array.from(doc.querySelectorAll(`.${BILINGUAL_CLASS}[${INERT_ATTR}]`))) span.remove()
}

// ---- 缓存 (IndexedDB, 一本书一条记录) ----

const DB_NAME = 'lightread-bilingual'
const STORE = 'books'
let dbPromise: Promise<IDBDatabase | null> | null = null
function openDb(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise(resolve => {
      try {
        const req = indexedDB.open(DB_NAME, 1)
        req.onupgradeneeded = () => req.result.createObjectStore(STORE)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
  }
  return dbPromise
}

async function loadEntries(key: string): Promise<Map<string, string>> {
  const db = await openDb()
  if (!db) return new Map()
  return new Promise(resolve => {
    try {
      const req = db.transaction(STORE).objectStore(STORE).get(key)
      req.onsuccess = () => {
        const v = req.result as Record<string, string> | undefined
        resolve(new Map(v && typeof v === 'object' ? Object.entries(v) : []))
      }
      req.onerror = () => resolve(new Map())
    } catch {
      resolve(new Map())
    }
  })
}

async function saveEntries(key: string, entries: Map<string, string>) {
  const db = await openDb()
  if (!db) return
  try {
    db.transaction(STORE, 'readwrite').objectStore(STORE).put(Object.fromEntries(entries), key)
  } catch (e) {
    logEvent('warn', 'bilingual', 'cache save failed', e)
  }
}

// ---- 阅读页控制器 ----

interface Job {
  el: Element
  text: string
  target: TranslateLang
}

export interface BilingualOptions {
  /** 当前已加载的分节文档 */
  docs: () => Document[]
  bookId: () => string | undefined
  /** 本机模型出错 (闪退停用 / 加载失败): 这一轮停下, 由界面提示 */
  onError: (e: unknown) => void
}

export function bilingualController(opts: BilingualOptions) {
  let enabled = false
  let cacheKey = ''
  let entries: Map<string, string> | null = null
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let queue: Job[] = []
  let running = false
  let halted = false
  let abort: AbortController | null = null
  let lastRange: Range | null = null
  let seq = 0

  const settings = useSettings()
  const uiLang = () => (settings.language === 'en' ? 'en' : 'zh') as 'zh' | 'en'
  const targetOf = (text: string) => paragraphTarget(text, settings.translateTarget, uiLang())

  function applyCached(doc: Document) {
    if (!entries?.size) return
    for (const el of paragraphsOf(doc)) {
      if (translationOf(el)) continue
      const text = paragraphText(el)
      const target = targetOf(text)
      if (!target) continue
      const hit = entries.get(entryKey(text, target))
      if (hit) attach(el, hit, target)
    }
  }

  /** 最多 1.5 秒落盘一次 (不是防抖: 连续翻译时防抖会一直推迟, 应用被杀就丢了) */
  function scheduleSave() {
    if (saveTimer !== undefined) return
    saveTimer = setTimeout(flushSave, 1500)
  }
  function flushSave() {
    clearTimeout(saveTimer)
    saveTimer = undefined
    if (cacheKey && entries) void saveEntries(cacheKey, entries)
  }
  // 切到后台 / 关页面前立即落盘 (手机上切走后进程随时可能被系统结束)
  const onHide = () => { if (document.visibilityState === 'hidden' && saveTimer !== undefined) flushSave() }
  document.addEventListener('visibilitychange', onHide)

  /** 当前看到的第一段 (含) 起往后排队 */
  function plan(range: Range | null) {
    if (!enabled || halted || !entries || !range) return
    const node = range.startContainer
    const doc = node.nodeType === 9 ? (node as Document) : node.ownerDocument
    if (!doc) return
    const paras = paragraphsOf(doc)
    let start = paras.findIndex(el => el.contains(node) || !!(node.compareDocumentPosition(el) & 4 /* FOLLOWING */))
    if (start < 0) return
    const texts = new Map<number, string>()
    const textAt = (i: number) => {
      let s = texts.get(i)
      if (s === undefined) texts.set(i, (s = paragraphText(paras[i])))
      return s
    }
    const picked = planParagraphs(paras.length, start, i => !translationOf(paras[i]) && !!targetOf(textAt(i)))
    queue = picked.map(i => ({ el: paras[i], text: textAt(i), target: targetOf(textAt(i))! }))
    void run()
  }

  async function run() {
    if (running) return
    running = true
    const my = seq
    try {
      while (enabled && !halted && my === seq && queue.length) {
        const job = queue.shift()!
        if (!job.el.isConnected || translationOf(job.el)) continue
        const key = entryKey(job.text, job.target)
        const hit = entries?.get(key)
        if (hit) {
          attach(job.el, hit, job.target)
          continue
        }
        const span = attach(job.el, '…', job.target, true)
        abort = new AbortController()
        let out = ''
        try {
          for await (const chunk of translateLocal({ text: job.text, target: job.target }, abort.signal)) {
            out += chunk
            if (span.isConnected) span.textContent = out
          }
          const clean = cleanTranslation(out)
          if (!clean) {
            span.remove()
            continue
          }
          if (span.isConnected) attach(job.el, clean, job.target)
          entries?.set(key, clean)
          scheduleSave()
        } catch (e: any) {
          span.remove()
          if (e?.name === 'AbortError') break
          halted = true
          logEvent('warn', 'bilingual', 'local translate failed', e)
          opts.onError(e)
        } finally {
          abort = null
        }
      }
    } finally {
      running = false
    }
    // 翻的过程中又翻页了: 按最新位置再排一次
    if (enabled && !halted && my !== seq) plan(lastRange)
  }

  async function prepare(): Promise<boolean> {
    const model = localTranslateModel()?.id
    const bookId = opts.bookId()
    if (!model || !bilingualModelReady()) return false
    const key = bookId ? bookCacheKey(bookId, model) : `-|${model}`
    if (key !== cacheKey || !entries) {
      if (saveTimer !== undefined) flushSave()
      cacheKey = key
      entries = bookId ? await loadEntries(key) : new Map()
    }
    return true
  }

  function stop() {
    seq++
    queue = []
    abort?.abort()
  }

  return {
    /** 打开 / 关闭对照 (含打开书时按设置初始化, 以及模型刚下载好时) */
    async setEnabled(on: boolean) {
      stop()
      enabled = on
      halted = false
      if (!on) {
        for (const doc of opts.docs()) {
          try { removeAll(doc) } catch { /* 已卸载的分节 */ }
        }
        return
      }
      const my = seq
      if (!(await prepare()) || my !== seq || !enabled) return
      for (const doc of opts.docs()) {
        try { applyCached(doc) } catch { /* 已卸载的分节 */ }
      }
      plan(lastRange)
    },
    /** 分节加载: 同步贴上已缓存的译文 (在 foliate 定位之前, 不会造成跳动) */
    onSectionLoad(doc: Document) {
      if (!enabled || !entries) return
      try { applyCached(doc) } catch { /* 忽略 */ }
    },
    onRelocate(detail: { range?: Range | null }) {
      lastRange = detail.range ?? null
      if (!enabled || halted) return
      if (running) {
        // 正在翻的那段让它翻完, 之后按新位置排
        seq++
        queue = []
        return
      }
      plan(lastRange)
    },
    /**
     * 页首落在译文里时, 把要保存的阅读位置改到该段原文末尾 (译文的节点不属于原书,
     * 关掉对照后那个 CFI 就找不到了)。要在阅读页读取 detail.cfi 之前调用。
     */
    fixRelocate(detail: { range?: Range | null; index?: number; cfi?: string }, getCFI: (index: number, range: Range) => string) {
      const range = detail.range
      if (!range || detail.index === undefined || !isInertNode(range.startContainer)) return
      let span: Node | null = range.startContainer
      while (span && !(span.nodeType === 1 && (span as Element).hasAttribute(INERT_ATTR))) span = span.parentNode
      if (!span) return
      try {
        const r = (span as Element).ownerDocument.createRange()
        r.setStartBefore(span)
        r.collapse(true)
        detail.cfi = getCFI(detail.index, r)
      } catch { /* 保留原值 */ }
    },
    destroy() {
      stop()
      enabled = false
      document.removeEventListener('visibilitychange', onHide)
      flushSave()
    },
  }
}
