/**
 * 正文简繁转换 (本地完成, 不联网、不需要 Key): OpenCC 词表 (opencc-js, MIT / Apache-2.0),
 * 繁→简约 110KB、简→繁约 1.1MB, 只在打开时按需加载。
 *
 * 只改正文文本节点的内容, 不动 DOM 结构; 每个文本节点要求转换前后 UTF-16 长度一致,
 * 这样划线 / 书签 / 阅读进度的 CFI (节点序号 + 字符偏移) 在转换前后都指向同一处。
 * 词组转换改变了长度时, 该节点退回逐字转换 (同样只采用等长的字)。
 * EPUB、TXT 以及 App 里 PDF 重排后的正文都经阅读页的分节加载钩子调用这里。
 */
export type ZhConvertMode = 'off' | 't2s' | 's2t'

export type Convert = (text: string) => string

const loaded = new Map<Exclude<ZhConvertMode, 'off'>, Promise<Convert>>()

/** 按需加载转换器 (每种只加载一次) */
export function loadZhConverter(mode: Exclude<ZhConvertMode, 'off'>): Promise<Convert> {
  let p = loaded.get(mode)
  if (!p) {
    p = (mode === 's2t'
      ? import('opencc-js/cn2t').then(m => m.Converter({ from: 'cn', to: 'tw' }))
      : import('opencc-js/t2cn').then(m => m.Converter({ from: 'tw', to: 'cn' }))) as Promise<Convert>
    p.catch(() => loaded.delete(mode))
    loaded.set(mode, p)
  }
  return p
}

const HAN = /[㐀-鿿豈-﫿]|[\ud840-\ud87f][\udc00-\udfff]/

/** 转换一段文字, 保证结果与原文 UTF-16 长度相同 */
export function convertPreservingLength(text: string, convert: Convert): string {
  if (!HAN.test(text)) return text
  const whole = convert(text)
  if (whole.length === text.length) return whole
  let out = ''
  for (const ch of text) {
    const c = HAN.test(ch) ? convert(ch) : ch
    out += c.length === ch.length ? c : ch
  }
  return out
}

/** 转换前的原文, 关闭或切换方向时还原 */
const originals = new WeakMap<Text, string>()
/** 每个文档当前已应用的方向 */
const applied = new WeakMap<Document, ZhConvertMode>()

const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'svg'])

function textNodes(doc: Document): Text[] {
  const root = doc.body ?? doc.documentElement
  if (!root) return []
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */, {
    acceptNode: n => (SKIP.has(n.parentElement?.tagName ?? '') ? 2 /* REJECT */ : 1 /* ACCEPT */),
  })
  const out: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text)
  return out
}

/** 还原文档里被转换过的文字 */
export function restoreZh(doc: Document) {
  for (const node of textNodes(doc)) {
    const orig = originals.get(node)
    if (orig !== undefined && node.data !== orig) node.data = orig
  }
  applied.set(doc, 'off')
}

/**
 * 对一个分节文档应用转换方向 (同步; convert 须是该方向已加载的转换器, 关闭时可省略);
 * 已是该方向时不重复处理。每次都从原文转换 (切换方向不叠加)。返回是否改动了文字。
 */
export function convertDocument(doc: Document, mode: ZhConvertMode, convert?: Convert): boolean {
  const current = applied.get(doc) ?? 'off'
  if (current === mode) return false
  if (mode === 'off') {
    restoreZh(doc)
    return true
  }
  if (!convert) return false
  let changed = false
  for (const node of textNodes(doc)) {
    const orig = originals.get(node) ?? node.data
    const next = convertPreservingLength(orig, convert)
    if (next === node.data) continue
    if (!originals.has(node)) originals.set(node, orig)
    node.data = next
    changed = true
  }
  applied.set(doc, mode)
  return changed
}

/**
 * 阅读页用的控制器: 记住当前方向和已加载的转换器。
 * 分节加载时 (onSectionLoad 最先调用) 转换器已就绪就同步转换, 首次打开才异步加载后补上全部分节。
 */
export function zhConvertController(docs: () => Document[], onError: (e: unknown) => void) {
  let mode: ZhConvertMode = 'off'
  let convert: Convert | undefined
  let seq = 0
  function applyAll() {
    for (const doc of docs()) {
      try { convertDocument(doc, mode, convert) } catch { /* 已卸载的分节 */ }
    }
  }
  return {
    /** 切换方向 (含首次打开书); 需要时加载词表 */
    async setMode(next: ZhConvertMode) {
      const my = ++seq
      mode = next
      convert = undefined
      if (next !== 'off') {
        try {
          const c = await loadZhConverter(next)
          if (my !== seq) return
          convert = c
        } catch (e) {
          if (my === seq) onError(e)
          return
        }
      }
      applyAll()
    },
    onSectionLoad(doc: Document) {
      if (mode === 'off' || convert) convertDocument(doc, mode, convert)
    },
  }
}
