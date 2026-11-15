/**
 * 阅读模式的节奏计算 (纯函数, 可用 node --test 测试; 设计见 docs/reading-modes.md §3.1 §5.3)。
 *
 * 内部统一按「字当量」计时: 一个汉字 (假名、谚文音节) 算 1, 一个西文词算 1, 词内字母平分这 1 份;
 * 超过 8 个字母的长词每多一个字母 +0.1。速度单位因此对中文是「字/分」, 对西文是「词/分」。
 *
 * 时间表 Schedule 的语义: 第 i 个出字点在 times[i] 毫秒时出现, 出现后正文显示到偏移 ends[i];
 * 时间 0 之前已显示到 start。第一个出字点在 0 毫秒出现 (开始即出字), 停顿加在出字点之后。
 */
import { splitSentences } from '../readAloud.ts'

export type Script = 'cjk' | 'latin' | 'rtl' | 'other'
export type TokenKind = 'cjk' | 'word' | 'space' | 'punct' | 'atom'
export type RevealUnit = 'char' | 'sentence' | 'line'

export interface Token {
  /** [start, end) 为窗口文本内的 UTF-16 偏移 */
  start: number
  end: number
  /** 字当量; 0 表示不占时间, 跟随相邻出字点一起出现 (空白、标点、注音) */
  weight: number
  kind: TokenKind
  /** 西文词的第一个字素 (打字声按词响) */
  wordStart?: boolean
  /** 之后的停顿, 单位为单字时长 (逗号类 1.5, 句末 3) */
  pause?: number
  /** 开引号 / 开括号: 与后一个字一起出现 */
  open?: boolean
}

export interface Schedule {
  /** 窗口起点: 时间 0 之前已显示到这里 */
  start: number
  ends: Uint32Array
  times: Float64Array
  /** 1 = 该出字点响一声打字声 (汉字、西文词首、整句/整行) */
  ticks: Uint8Array
  /** 整个窗口的时长 (含最后一个出字点自身时长和其后停顿) */
  total: number
}

export interface ScheduleOptions {
  /** 标点与段末停顿, 默认开 */
  punctuationPause?: boolean
  /** 整块出现的单位 (句子或行), 窗口内偏移 [start, end); 不传为逐字 */
  units?: ReadonlyArray<readonly [number, number]>
  /** 段落结束处的窗口内偏移 (升序), 段末停顿 +4 */
  breaks?: readonly number[]
  /** 图片等原子块的停留时长, 默认 1200ms */
  atomMs?: number
  /** 窗口在整节文本里的起点, 加到 start / ends 上 */
  origin?: number
}

/** 停顿倍数 (乘以单字时长) */
export const PAUSE_COMMA = 1.5
export const PAUSE_SENTENCE = 3
export const PAUSE_PARAGRAPH = 4
export const ATOM_MS = 1200

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}々〆ー]/u
const RTL_RE = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u
const WESTERN_RE = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]/u
const LETTER_RE = /[\p{L}\p{N}]/u
const SPACE_RE = /^\s+$/u
const PICTO_RE = /\p{Extended_Pictographic}/u
const OPEN_RE = /^[\p{Ps}\p{Pi}]$/u
const SENTENCE_END_RE = /[。．.！!？?…‥]/u
const COMMA_RE = /[，,、；;：:—–]/u

function pauseOf(ch: string): number {
  if (SENTENCE_END_RE.test(ch)) return PAUSE_SENTENCE
  if (COMMA_RE.test(ch)) return PAUSE_COMMA
  return 0
}

/** 书 / 段落的主文字: 决定速度单位 (字/分 或 词/分) 与默认粒度 */
export function dominantScript(text: string): Script {
  let cjk = 0
  let rtl = 0
  let western = 0
  let other = 0
  const sample = text.length > 4000 ? text.slice(0, 4000) : text
  for (const ch of sample) {
    if (CJK_RE.test(ch)) cjk++
    else if (RTL_RE.test(ch)) rtl++
    else if (WESTERN_RE.test(ch)) western++
    else if (/\p{L}/u.test(ch)) other++
  }
  // 一个汉字约等于一个西文词 (≈5 个字母), 按「读的单位」比较
  const scores: Array<[Script, number]> = [['cjk', cjk * 3], ['rtl', rtl], ['latin', western], ['other', other]]
  scores.sort((a, b) => b[1] - a[1])
  return scores[0][1] > 0 ? scores[0][0] : 'other'
}

function makeSegmenter(lang: string, granularity: 'grapheme' | 'word'): Intl.Segmenter | null {
  try {
    return new Intl.Segmenter(lang || 'zh', { granularity })
  } catch {
    try { return new Intl.Segmenter('en', { granularity }) } catch { return null }
  }
}

function graphemes(seg: Intl.Segmenter | null, str: string): Array<{ index: number; segment: string }> {
  if (seg) return Array.from(seg.segment(str), s => ({ index: s.index, segment: s.segment }))
  const out: Array<{ index: number; segment: string }> = []
  let i = 0
  for (const ch of str) { out.push({ index: i, segment: ch }); i += ch.length }
  return out
}

/** 无 Intl.Segmenter 时的退路: 连续字母数字为词, 其余逐字 */
function fallbackWords(text: string): Array<{ index: number; segment: string; isWordLike: boolean }> {
  const out: Array<{ index: number; segment: string; isWordLike: boolean }> = []
  const re = /[\p{L}\p{N}\p{M}]+(?:['’.\-][\p{L}\p{N}\p{M}]+)*|\s+|[^]/gu
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ index: m.index, segment: m[0], isWordLike: LETTER_RE.test(m[0]) })
  }
  return out
}

/**
 * 切成出字单位。CJK 每字一个 token; 西文按词计时、词内按字素平分 (wholeWords 或 RTL 词则整词一个 token);
 * 空白与标点不占时间。字素由 Intl.Segmenter 切分, 不会切开 emoji、组合附加符和代理对。
 */
export function tokenize(text: string, lang = 'zh', opts: { wholeWords?: boolean } = {}): Token[] {
  const out: Token[] = []
  const wordSeg = makeSegmenter(lang, 'word')
  const graphSeg = makeSegmenter(lang, 'grapheme')
  const segments = wordSeg
    ? Array.from(wordSeg.segment(text), s => ({ index: s.index, segment: s.segment, isWordLike: !!s.isWordLike }))
    : fallbackWords(text)

  const pushWord = (start: number, str: string) => {
    const gs = graphemes(graphSeg, str)
    const letters = gs.filter(g => LETTER_RE.test(g.segment)).length
    const weight = 1 + Math.max(0, letters - 8) * 0.1
    if (opts.wholeWords || RTL_RE.test(str) || gs.length <= 1) {
      out.push({ start, end: start + str.length, weight, kind: 'word', wordStart: true })
      return
    }
    const share = weight / gs.length
    gs.forEach((g, i) => {
      out.push({ start: start + g.index, end: start + g.index + g.segment.length, weight: share, kind: 'word', wordStart: i === 0 })
    })
  }

  for (const seg of segments) {
    const base = seg.index
    const str = seg.segment
    if (seg.isWordLike && !CJK_RE.test(str)) {
      pushWord(base, str)
      continue
    }
    // CJK 词 (分词结果不可靠, 逐字计) 与非词片段 (空白、标点、emoji) 逐字素处理
    let run = '' // CJK 词里夹的西文 / 数字 (如「5G网络」), 合成一个词
    let runStart = 0
    const flush = () => {
      if (run) pushWord(runStart, run)
      run = ''
    }
    for (const g of graphemes(graphSeg, str)) {
      const pos = base + g.index
      const ch = g.segment
      if (CJK_RE.test(ch)) {
        flush()
        out.push({ start: pos, end: pos + ch.length, weight: 1, kind: 'cjk' })
      } else if (SPACE_RE.test(ch)) {
        flush()
        out.push({ start: pos, end: pos + ch.length, weight: 0, kind: 'space' })
      } else if (PICTO_RE.test(ch) && !/^[\d#*]/.test(ch)) {
        flush()
        out.push({ start: pos, end: pos + ch.length, weight: 1, kind: 'word', wordStart: true })
      } else if (LETTER_RE.test(ch)) {
        if (!run) runStart = pos
        run += ch
      } else {
        flush()
        const tok: Token = { start: pos, end: pos + ch.length, weight: 0, kind: 'punct' }
        const pause = pauseOf(ch)
        if (pause) tok.pause = pause
        if (OPEN_RE.test(ch)) tok.open = true
        out.push(tok)
      }
    }
    flush()
  }
  return out
}

const ABBREV_RE = /(?:^|[\s(“"‘'])(?:Mr|Mrs|Ms|Mx|Dr|Prof|Sr|Jr|St|Mt|Gen|Col|Capt|Lt|Sgt|Rev|Hon|Fr|Gov|Pres|Rep|Sen|vs|No|Vol|Ch|Fig|Inc|Ltd|Co|[A-Z])\.$/
const CAPITAL_START_RE = /^[\s“"‘'(]*[\p{Lu}\d]/u

/**
 * 句子区间: Intl.Segmenter 断句 + 听书同款修正 (换行硬断、句末开引号归下一句, 见 readAloud.splitSentences),
 * 再把「Mr. Smith」「J. K. Rowling」这类缩写处的误断合并回去。
 */
export function sentenceSpans(text: string, lang = 'zh'): Array<[number, number]> {
  const spans = splitSentences(text, lang).map(s => [s.start, s.end] as [number, number])
  const out: Array<[number, number]> = []
  for (const span of spans) {
    const prev = out[out.length - 1]
    if (prev) {
      const gap = text.slice(prev[1], span[0])
      const prevText = text.slice(prev[0], prev[1])
      if (!gap.includes('\n') && /^\s*$/.test(gap) && ABBREV_RE.test(prevText) && CAPITAL_START_RE.test(text.slice(span[0], span[1]))) {
        prev[1] = span[1]
        continue
      }
    }
    out.push([span[0], span[1]])
  }
  return out
}

/**
 * 时间表。unitsPerMinute 为字当量/分。
 * - 有权重的 token 各成一个出字点; 空白和收尾标点并入前一个出字点 (「字，」一起出现), 开引号随后一个字出现;
 * - 停顿 (标点、段末) 加在出字点之后, 多个停顿取最大而不是累加;
 * - 原子块 (图片) 是一个零宽出字点, 之后固定停留 atomMs;
 * - 传 units 时, 落在同一单位里的出字点合并: 单位整体在其第一个字的时刻出现, 停留到下一个单位。
 */
export function buildSchedule(tokens: readonly Token[], unitsPerMinute: number, opts: ScheduleOptions = {}): Schedule {
  const unitMs = 60000 / Math.max(1, unitsPerMinute)
  const pp = opts.punctuationPause !== false
  const atomMs = opts.atomMs ?? ATOM_MS
  const origin = opts.origin ?? 0
  const breaks = opts.breaks ?? []

  const starts: number[] = []
  const ends: number[] = []
  const times: number[] = []
  const ticks: number[] = []
  let t = 0
  let pending = 0
  let bi = 0

  for (const tok of tokens) {
    // 段末停顿: 段落边界在这个 token 之前 (或正好在它开头)
    while (bi < breaks.length && breaks[bi] <= tok.start) {
      if (pp && ends.length) pending = Math.max(pending, PAUSE_PARAGRAPH)
      bi++
    }
    if (tok.kind === 'atom') {
      t += pending * unitMs
      pending = 0
      starts.push(tok.start)
      ends.push(tok.end)
      times.push(t)
      ticks.push(0)
      t += atomMs
    } else if (tok.weight > 0) {
      t += pending * unitMs
      pending = 0
      starts.push(tok.start)
      ends.push(tok.end)
      times.push(t)
      ticks.push(tok.kind === 'cjk' || tok.wordStart ? 1 : 0)
      t += tok.weight * unitMs
    } else {
      if (!tok.open && ends.length && tok.end > ends[ends.length - 1]) ends[ends.length - 1] = tok.end
      if (pp && tok.pause) pending = Math.max(pending, tok.pause)
    }
  }
  while (bi < breaks.length) {
    if (pp && ends.length) pending = Math.max(pending, PAUSE_PARAGRAPH)
    bi++
  }
  const total = t + pending * unitMs

  let outEnds = ends
  let outTimes = times
  let outTicks = ticks
  const units = opts.units
  if (units?.length) {
    outEnds = []
    outTimes = []
    outTicks = []
    let u = 0
    let lastUnit = -1
    for (let i = 0; i < ends.length; i++) {
      const s = starts[i]
      while (u < units.length && units[u][1] <= s) u++
      const inUnit = u < units.length && units[u][0] <= s && s < units[u][1]
      if (inUnit && u === lastUnit) {
        const k = outEnds.length - 1
        if (ends[i] > outEnds[k]) outEnds[k] = ends[i]
        continue
      }
      outEnds.push(inUnit ? Math.max(ends[i], units[u][1]) : ends[i])
      outTimes.push(times[i])
      outTicks.push(inUnit ? 1 : ticks[i])
      lastUnit = inUnit ? u : -1
    }
    // 单位末尾并入的标点可能超出下一出字点之前: 保持 ends 单调
    for (let i = 1; i < outEnds.length; i++) if (outEnds[i] < outEnds[i - 1]) outEnds[i] = outEnds[i - 1]
  }

  return {
    start: origin,
    ends: Uint32Array.from(outEnds, e => e + origin),
    times: Float64Array.from(outTimes),
    ticks: Uint8Array.from(outTicks),
    total,
  }
}

/** 已经出现的最后一个出字点下标; 一个都没出现返回 -1 (二分查找) */
export function indexAt(s: Schedule, elapsedMs: number): number {
  let lo = 0
  let hi = s.times.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (s.times[mid] <= elapsedMs) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}

/** 经过 elapsedMs 后正文显示到的偏移 (单调不减) */
export function offsetAt(s: Schedule, elapsedMs: number): number {
  const i = indexAt(s, elapsedMs)
  return i < 0 ? s.start : s.ends[i]
}

/** 显示到 offset 需要的时间: offsetAt 的近似反函数 (跳转、重打、调速时换算) */
export function timeAt(s: Schedule, offset: number): number {
  if (offset <= s.start) return 0
  let lo = 0
  let hi = s.ends.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (s.ends[mid] >= offset) {
      ans = mid
      hi = mid - 1
    } else lo = mid + 1
  }
  return ans < 0 ? s.total : s.times[ans]
}

/**
 * 「墨迹未干」的起点: 逐字模式为最近 2 个出字点, 逐句 / 逐行为刚出现的整个单位。
 * 返回值 ≤ 当前显示到的偏移; 相等表示没有可着色的部分。
 */
export function freshStart(s: Schedule, index: number, unit: RevealUnit, count = 2): number {
  if (index < 0) return s.start
  const back = unit === 'char' ? count : 1
  return index - back >= 0 ? s.ends[index - back] : s.start
}

/**
 * 按每个字的 rect.top 分行, 返回下标区间 [start, end)。
 * 与当前行首的 top 相差超过半个行高才算换行, 兼容 ruby、上标、混排字号造成的抖动;
 * 多栏排版时下一栏的 top 回到顶部, 同样算换行。没有 rect 的字 (NaN) 跟随当前行。
 */
export function groupLines(tops: readonly number[], lineHeight: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const n = tops.length
  if (!n) return out
  const tol = Math.max(1, lineHeight) * 0.5
  let start = 0
  let ref = NaN
  for (let i = 0; i < n; i++) {
    const top = tops[i]
    if (!Number.isFinite(top)) continue
    if (!Number.isFinite(ref)) {
      ref = top
      continue
    }
    if (Math.abs(top - ref) > tol) {
      out.push([start, i])
      start = i
      ref = top
    }
  }
  out.push([start, n])
  return out
}

/** 节点长度 → 前缀和 (prefix[i] 为第 i 个节点的起点, prefix[n] 为总长) */
export function prefixSums(lengths: readonly number[]): number[] {
  const out = new Array<number>(lengths.length + 1)
  out[0] = 0
  for (let i = 0; i < lengths.length; i++) out[i + 1] = out[i] + lengths[i]
  return out
}

/**
 * 拼接文本里的偏移 → 第几个节点的第几个字符 (二分查找)。语义与 readAloud.locateOffset 一致:
 * 偏移落在两节点交界时归后一个节点开头; preferEnd 时归前一个节点末尾 (用于区间终点); 越界停在最后一个节点末尾。
 */
export function locateIn(prefix: readonly number[], offset: number, preferEnd = false): { node: number; offset: number } {
  const n = prefix.length - 1
  if (n <= 0) return { node: 0, offset: 0 }
  let lo = 0
  let hi = n - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const end = prefix[mid + 1]
    if (end > offset || (preferEnd && end === offset)) {
      ans = mid
      hi = mid - 1
    } else lo = mid + 1
  }
  if (ans < 0) return { node: n - 1, offset: prefix[n] - prefix[n - 1] }
  return { node: ans, offset: Math.max(0, offset - prefix[ans]) }
}

export function locate(lengths: readonly number[], offset: number, preferEnd = false): { node: number; offset: number } {
  return locateIn(prefixSums(lengths), offset, preferEnd)
}

/** 速度范围: 中文 60–1200 字/分, 西文 40–800 词/分 */
export function speedRange(script: Script): [number, number] {
  return script === 'cjk' ? [60, 1200] : [40, 800]
}

export function clampSpeed(n: number, script: Script): number {
  const [min, max] = speedRange(script)
  if (!Number.isFinite(n)) return script === 'cjk' ? 300 : 200
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** ±10%, 取整到 10, 至少变化 10 (调用方再 clampSpeed) */
export function adjustSpeed(n: number, dir: 1 | -1): number {
  // 加速 ×1.1、减速 ÷1.1 (而不是 ×0.9): 加一下再减一下回到原值 (K30 实测 420 → 460 → 410 回不去)
  const next = Math.round((dir > 0 ? n * 1.1 : n / 1.1) / 10) * 10
  if (dir > 0) return Math.max(next, Math.round(n / 10) * 10 + 10)
  return Math.min(next, Math.round(n / 10) * 10 - 10)
}

/** 快捷档: 慢 / 中 / 快 */
export function speedPresets(script: Script): [number, number, number] {
  return script === 'cjk' ? [200, 300, 450] : [150, 200, 300]
}

/** 打字声频率: 超过 600 字/分时每 3 个字响一次 */
export function soundEvery(unitsPerMinute: number): number {
  return unitsPerMinute > 600 ? 3 : 1
}
