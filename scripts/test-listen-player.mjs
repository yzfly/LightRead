// 听书管线契约: 分块 / 块内时刻 / 静音裁剪与响度 / 停顿排期 (纯函数),
// 预取的顺序 / 并发 / 退回 (假引擎), 以及 ListenPlayer 整体 (假 AudioContext + 加速时钟 + 假系统语音)
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import {
  speechWeight, nextChunkSize, planChunks, chunkText, makeChunk, sentenceOffsets, analyzeSpeech, trimAndFade,
  chunkGain, gapSeconds, nextStartTime, endsSentence, CHUNK_PROFILES, PAUSE_SECONDS, TARGET_RMS,
} from '../src/services/listenPlan.ts'
import { ChunkPrefetcher, SentenceSource, MarkTicker, FeedError } from '../src/services/audioQueue.ts'

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))
const S = (key, text, extra = {}) => ({ key, text, ...extra })
/** n 个汉字的句子 */
const zh = (n, end = '。') => '字'.repeat(n - 1) + end

// ================= 纯函数 =================

test('朗读量: 汉字 1, 西文字母 0.35, 标点记停顿', () => {
  assert.equal(speechWeight('你好'), 2)
  assert.equal(speechWeight('你好。'), 3)
  assert.equal(speechWeight('你，好'), 2.6)
  assert.ok(Math.abs(speechWeight('hello') - 1.75) < 1e-9)
  assert.equal(speechWeight('  '), 0)
})

test('句末判断: 允许后随右引号, 逗号软切的半句不算', () => {
  assert.ok(endsSentence('他说：“走吧。”'))
  assert.ok(endsSentence('Done.'))
  assert.ok(!endsSentence('然而，'))
  assert.ok(!endsSentence('第一章 风起'))
})

test('首块约一句, 尽快出声', () => {
  const p = CHUNK_PROFILES.edge // firstMax 60
  const pending = [S('a', zh(40)), S('b', zh(40)), S('c', zh(40))]
  assert.equal(nextChunkSize(pending, p, true, true), 1)
  // 两句短句合起来仍在首块上限内
  assert.equal(nextChunkSize([S('a', zh(20)), S('b', zh(20)), S('c', zh(40))], p, true, true), 2)
  // 单句超过上限也整句成块, 不在句内切
  assert.equal(nextChunkSize([S('a', zh(150)), S('b', zh(5))], p, true, true), 1)
})

test('章节末必断, 段末且够长时断, 短段与后文合并', () => {
  const p = CHUNK_PROFILES.edge
  assert.equal(nextChunkSize([S('a', zh(10), { sectionEnd: true }), S('b', zh(10))], p, false, true), 1)
  assert.equal(nextChunkSize([S('a', zh(40), { paragraphEnd: true }), S('b', zh(10))], p, false, true), 1)
  // 一句一段的短对话: 合并到 minParagraph 以上再断
  const dialog = [S('a', '“嗯。”', { paragraphEnd: true }), S('b', '“走吧。”', { paragraphEnd: true }), S('c', zh(20), { paragraphEnd: true })]
  assert.equal(nextChunkSize(dialog, p, false, true), 3)
  // 首块遇段末必断
  assert.equal(nextChunkSize(dialog, p, true, true), 1)
})

test('在线引擎以整段为块: 段末断; 超长段在句末断, 逗号软切的半句后面不断', () => {
  const p = CHUNK_PROFILES.edge // target 500, max 600
  const para = [S('a', zh(150)), S('b', zh(150)), S('c', zh(150), { paragraphEnd: true }), S('d', zh(30))]
  assert.equal(nextChunkSize(para, p, false, true), 3, '整段在上限内: 一直读到段末')
  const long = [S('a', zh(250)), S('b', zh(250)), S('c', zh(250)), S('d', zh(60), { paragraphEnd: true })]
  assert.equal(nextChunkSize(long, p, false, true), 2, '段末超出上限: 在达到目标的那句后断')
  const soft = [S('a', zh(260)), S('b', '字'.repeat(249) + '，'), S('c', zh(80)), S('d', zh(250))]
  assert.equal(nextChunkSize(soft, p, false, true), 3, '逗号软切的半句后面不断, 延到句末')
})

test('句子不够决定时要求读入更多, 读完时整批交付', () => {
  const p = CHUNK_PROFILES.edge
  assert.equal(nextChunkSize([S('a', zh(20)), S('b', zh(20))], p, false, false), 0)
  assert.equal(nextChunkSize([S('a', zh(20)), S('b', zh(20))], p, false, true), 2)
  assert.equal(nextChunkSize([S('a', zh(260)), S('b', zh(260))], p, false, false), 0, '达到目标后还要看段末在不在上限内')
  assert.equal(nextChunkSize([], p, false, true), 0)
})

test('planChunks 不丢句不重复, 每块不超上限 (单句除外), 章节末一定是块尾', () => {
  const sentences = []
  for (let i = 0; i < 200; i++) {
    sentences.push(S(`k${i}`, zh(5 + (i * 37) % 80), { paragraphEnd: i % 4 === 3, sectionEnd: i % 50 === 49 }))
  }
  for (const profile of Object.values(CHUNK_PROFILES)) {
    const chunks = planChunks(sentences, profile)
    assert.deepEqual(chunks.flatMap(c => c.keys), sentences.map(s => s.key))
    chunks.forEach((c, i) => {
      const w = c.weights.reduce((a, b) => a + b, 0)
      if (c.keys.length > 1) assert.ok(w <= (i === 0 ? profile.firstMax : profile.max), `chunk ${i} too long: ${w}`)
      c.sentences.slice(0, -1).forEach(s => assert.ok(!s.sectionEnd, 'sectionEnd 只能在块尾'))
    })
    assert.ok(chunks[0].weights.reduce((a, b) => a + b, 0) <= profile.firstMax)
  }
})

test('合成文本: 中文不加空格, 西文加空格, 无标点标题补句号', () => {
  assert.equal(chunkText([S('a', '第一章 风起', { paragraphEnd: true }), S('b', '夜色很深。')]), '第一章 风起。夜色很深。')
  assert.equal(chunkText([S('a', 'Chapter One', { paragraphEnd: true }), S('b', 'It was dark.')]), 'Chapter One. It was dark.')
  assert.equal(chunkText([S('a', '他说：“走。”'), S('b', '我没动。')]), '他说：“走。”我没动。')
  const c = makeChunk([S('a', zh(5)), S('b', zh(5), { paragraphEnd: true })])
  assert.equal(c.pause, 'paragraph')
  assert.equal(makeChunk([S('a', '然而，')]).pause, 'clause')
  assert.equal(makeChunk([S('a', zh(3), { sectionEnd: true, paragraphEnd: true })]).pause, 'section')
})

test('块内逐句时刻: 第一句在 0, 按朗读量占比分配', () => {
  assert.deepEqual(sentenceOffsets([10, 30, 60], 10), [0, 1, 4])
  assert.deepEqual(sentenceOffsets([5], 3), [0])
  assert.deepEqual(sentenceOffsets([0, 0], 4), [0, 2])
})

test('静音裁剪: 去掉两端静音, 留少量余量; 全静音原样保留', () => {
  const sr = 1000
  const samples = new Float32Array(3000) // 0–1s 静音, 1–2s 有声, 2–3s 静音
  for (let i = 1000; i < 2000; i++) samples[i] = (i % 2 ? 0.3 : -0.3)
  samples[100] = 0.0005 // 底噪不算有声
  const st = analyzeSpeech(samples, sr, { leadMs: 20, tailMs: 60 })
  assert.equal(st.start, 980)
  assert.equal(st.end, 2060)
  assert.ok(Math.abs(st.peak - 0.3) < 1e-6)
  assert.ok(Math.abs(st.activeRms - 0.3) < 1e-6)
  const silent = analyzeSpeech(new Float32Array(500), sr)
  assert.deepEqual([silent.start, silent.end, silent.activeRms], [0, 500, 0])
})

test('句间停顿不拉低响度估计', () => {
  const sr = 1000
  const samples = new Float32Array(3000)
  for (let i = 0; i < 1000; i++) samples[i] = 0.2 * (i % 2 ? 1 : -1)
  for (let i = 2000; i < 3000; i++) samples[i] = 0.2 * (i % 2 ? 1 : -1)
  const st = analyzeSpeech(samples, sr)
  assert.ok(Math.abs(st.activeRms - 0.2) < 1e-6)
})

test('截取并淡入淡出: 两端为 0, 中段不变', () => {
  const samples = new Float32Array(100).fill(1)
  const out = trimAndFade(samples, 10, 90, 10)
  assert.equal(out.length, 80)
  assert.equal(out[0], 0)
  assert.equal(out[79], 0)
  assert.ok(Math.abs(out[5] - 0.5) < 1e-6)
  assert.equal(out[40], 1)
  // 原数组不被改动
  assert.equal(samples[10], 1)
  // 极短的块: 淡入淡出不超过一半
  assert.deepEqual(Array.from(trimAndFade(new Float32Array(4).fill(1), 0, 4, 10)), [0, 0.5, 0.5, 0])
})

test('响度: 拉到目标值, 限幅, 与上一块折中, 不削波', () => {
  assert.ok(Math.abs(chunkGain({ activeRms: TARGET_RMS / 2, peak: 0.2 }, null) - 2) < 1e-9)
  assert.equal(chunkGain({ activeRms: 0.001, peak: 0.01 }, null), 2.5)
  assert.equal(chunkGain({ activeRms: 0, peak: 0 }, null), 1)
  assert.ok(Math.abs(chunkGain({ activeRms: TARGET_RMS, peak: 0.3 }, 2) - 1.5) < 1e-9)
  assert.ok(Math.abs(chunkGain({ activeRms: 0.02, peak: 0.9 }, null) - 0.98 / 0.9) < 1e-9)
})

test('块间停顿: 句 < 段 < 章, 倍速越快越短; 时间线空时立即开始', () => {
  assert.ok(gapSeconds('clause', 1) < gapSeconds('sentence', 1))
  assert.ok(gapSeconds('sentence', 1) < gapSeconds('paragraph', 1))
  assert.ok(gapSeconds('paragraph', 1) < gapSeconds('section', 1))
  assert.equal(gapSeconds('paragraph', 2), PAUSE_SECONDS.paragraph / 2)
  assert.equal(gapSeconds('paragraph', 0.5), PAUSE_SECONDS.paragraph / 0.75)
  assert.equal(gapSeconds(null, 1), 0)
  assert.equal(nextStartTime(10, 12, 0.4), 12.4)
  assert.equal(nextStartTime(10, 5, 0.4), 10.05)
})

// ================= 预取 =================

function makeFeed(sentences, delay = 0) {
  let i = 0
  let calls = 0
  let concurrent = 0
  const feed = {
    maxConcurrent: 0,
    get calls() { return calls },
    async next() {
      calls++
      concurrent++
      feed.maxConcurrent = Math.max(feed.maxConcurrent, concurrent)
      if (delay) await tick(delay)
      concurrent--
      return i < sentences.length ? sentences[i++] : null
    },
  }
  return feed
}

function book(n, opts = {}) {
  const out = []
  for (let i = 0; i < n; i++) {
    out.push(S(`s${i}`, zh(opts.len ? opts.len(i) : 8 + (i * 13) % 30), {
      paragraphEnd: i % 3 === 2, sectionEnd: opts.section ? i % opts.section === opts.section - 1 : false,
    }))
  }
  return out
}

function controlled() {
  const calls = []
  let inFlight = 0
  const ctl = {
    calls, maxInFlight: 0,
    synth: chunk => new Promise((resolve, reject) => {
      inFlight++
      ctl.maxInFlight = Math.max(ctl.maxInFlight, inFlight)
      calls.push({ chunk, resolve: () => { inFlight--; resolve({ seconds: 5, chunk }) }, reject: e => { inFlight--; reject(e) } })
    }),
  }
  return ctl
}

test('预取: 按序交付, 并发受限, 缓冲够了就停', async () => {
  const sentences = book(60)
  const ctl = controlled()
  const pf = new ChunkPrefetcher({
    source: new SentenceSource(makeFeed(sentences, 1)), profile: CHUNK_PROFILES.edge,
    concurrency: 2, lookaheadSeconds: 12, maxChunks: 8, rate: 1,
    synth: ctl.synth, seconds: r => r.seconds,
  })
  pf.start()
  await tick(60)
  assert.equal(ctl.calls.length, 2, '并发 2')
  // 后一块先完成: 仍按顺序交付
  ctl.calls[1].resolve()
  const first = pf.take()
  await tick(5)
  ctl.calls[0].resolve()
  const a = await first
  const b = await pf.take()
  assert.equal(a.chunk, ctl.calls[0].chunk)
  assert.equal(b.chunk, ctl.calls[1].chunk)
  assert.ok(ctl.maxInFlight <= 2)
  // 缓冲 (估算 + 实际) 达到 12 秒后不再开新块
  await tick(60)
  for (const c of ctl.calls.slice(2)) c.resolve()
  await tick(60)
  assert.ok(pf.bufferedSeconds() >= 12)
  const started = pf.started
  await tick(60)
  assert.equal(pf.started, started)
  // 全部取完, 句子不丢不重
  const got = [...a.chunk.keys, ...b.chunk.keys]
  const pump = setInterval(() => ctl.calls.forEach(c => c.resolve()), 2)
  for (let item = await pf.take(); item; item = await pf.take()) got.push(...item.chunk.keys)
  clearInterval(pump)
  assert.deepEqual(got, sentences.map(s => s.key))
})

test('预取: drain 收回未交付的句子并按序退回, 迟到的结果被丢弃', async () => {
  const sentences = book(40)
  const source = new SentenceSource(makeFeed(sentences, 1))
  const ctl = controlled()
  const pf = new ChunkPrefetcher({
    source, profile: CHUNK_PROFILES.local, concurrency: 1, lookaheadSeconds: 30, maxChunks: 4, rate: 1,
    synth: ctl.synth, seconds: r => r.seconds,
  })
  pf.start()
  await tick(40)
  ctl.calls[0].resolve()
  const first = await pf.take()
  await tick(20)
  const back = pf.drain()
  ctl.calls.forEach(c => c.resolve())
  assert.equal(await pf.take(), null)
  source.unshift(back)
  // 新的读者从第一块之后接着读, 顺序完整
  const rest = []
  for (let s = await source.next(() => false); s; s = await source.next(() => false)) rest.push(s.key)
  assert.deepEqual([...first.chunk.keys, ...rest], sentences.map(s => s.key))
})

test('句子源: 读取串行; 作废的读者读到的句子留给下一个读者', async () => {
  const sentences = book(5)
  const feed = makeFeed(sentences, 5)
  const source = new SentenceSource(feed)
  let stale = false
  const old = source.next(() => stale)
  const fresh = source.next(() => false)
  stale = true
  assert.equal(await old, undefined)
  assert.equal((await fresh).key, 's0')
  assert.equal(feed.maxConcurrent, 1)
  source.unshift([S('x', 'x')])
  assert.equal((await source.next(() => false)).key, 'x')
  assert.equal((await source.next(() => false)).key, 's1')
})

test('预取: feed 出错时先交付之前的块, 再抛 FeedError', async () => {
  let i = 0
  const feed = { async next() { if (i < 3) return S(`s${i++}`, zh(10), { paragraphEnd: true }); throw new Error('chapter broken') } }
  const pf = new ChunkPrefetcher({
    source: new SentenceSource(feed), profile: CHUNK_PROFILES.edge, concurrency: 2, lookaheadSeconds: 60, maxChunks: 8, rate: 1,
    synth: async chunk => ({ seconds: 1, chunk }), seconds: r => r.seconds,
  })
  const keys = []
  await assert.rejects(async () => {
    for (let item = await pf.take(); item; item = await pf.take()) keys.push(...item.chunk.keys)
  }, e => e instanceof FeedError && e.cause.message === 'chapter broken')
  assert.deepEqual(keys, ['s0', 's1', 's2'])
})

test('MarkTicker: 按时钟依次触发, 时钟停住不触发, 撤销某块', async () => {
  let now = 0
  const fired = []
  const ticker = new MarkTicker(k => fired.push(k))
  const clock = () => now
  ticker.add([{ at: 0, key: 'a', clip: 1 }, { at: 0.05, key: 'b', clip: 1 }, { at: 0.1, key: 'c', clip: 2 }], clock)
  assert.deepEqual(fired, ['a'])
  await tick(30)
  assert.deepEqual(fired, ['a'])
  now = 0.06
  await tick(60)
  assert.deepEqual(fired, ['a', 'b'])
  ticker.dropClip(2)
  now = 1
  await tick(30)
  assert.deepEqual(fired, ['a', 'b'])
  ticker.clear()
})

// ================= ListenPlayer (假环境) =================

const SPEED = 50 // 时钟加速: 1 秒音频 = 20ms
const SR = 1000

const env = {
  settings: { ttsEngine: 'edge', ttsRate: 1, edgeVoice: '', localVoiceId: 0, ttsVoice: '', qwenVoice: 'female' },
  voiceModel: undefined,
  voiceCalls: [],
  voiceCancels: [],
  voiceSeq: 0,
  synth: async text => new Blob([text]),
  notices: [],
  synthCalls: [],
  inFlight: 0,
  maxInFlight: 0,
  decodeFails: false,
  sources: [],
  spoken: [],
  speechQueue: [],
  maxSpeechQueue: 0,
  elementsPlayed: 0,
}
globalThis.__listenEnv = env

class FakeBuffer {
  constructor(channels, length, sampleRate) {
    this.numberOfChannels = channels
    this.length = length
    this.sampleRate = sampleRate
    this.duration = length / sampleRate
    this.data = Array.from({ length: channels }, () => new Float32Array(length))
  }
  getChannelData(c) { return this.data[c] }
}

class FakeAudioContext {
  constructor() {
    this.state = 'running'
    this.base = 0
    this.since = performance.now()
    this.destination = {}
    this.sources = []
    this.timer = setInterval(() => this.poll(), 3)
    this.timer.unref?.()
    env.ctx = this
  }
  get currentTime() {
    return this.base + (this.state === 'running' ? (performance.now() - this.since) / 1000 * SPEED : 0)
  }
  async suspend() { if (this.state === 'running') { this.base = this.currentTime; this.state = 'suspended' } }
  async resume() { if (this.state !== 'running') { this.since = performance.now(); this.state = 'running' } }
  createBuffer(ch, len, sr) { return new FakeBuffer(ch, len, sr) }
  createGain() {
    // 记录自动化: 定时关闭的淡出在总音量上做线性渐弱
    const param = {
      value: 1, ramps: [],
      cancelScheduledValues() { this.ramps.length = 0 },
      setValueAtTime(v) { this.value = v },
      linearRampToValueAtTime(v, at) { this.ramps.push([v, at]) },
    }
    const g = { gain: param, to: null, connect: n => { g.to = n; return n }, disconnect() {} }
    ;(this.gains ??= []).push(g)
    return g
  }
  createBufferSource() {
    const src = {
      buffer: null, onended: null, stopped: false, at: null,
      connect: n => n, disconnect() {},
      start: at => { src.at = at; env.sources.push(src); this.sources.push(src) },
      stop() { src.stopped = true },
    }
    return src
  }
  poll() {
    for (const s of this.sources) {
      if (s.ended || s.stopped || s.at === null) continue
      if (this.currentTime >= s.at + s.buffer.duration) { s.ended = true; s.onended?.() }
    }
  }
  /** 合成的「音频」: 两端各 0.3 秒静音, 中间有声时长 = 朗读量 / 4.5 */
  decodeAudioData(data) {
    const text = new TextDecoder().decode(data)
    if (env.decodeFails) return Promise.reject(new Error('cannot decode'))
    const voiced = Math.round(speechWeight(text) / 4.5 * SR)
    const pad = Math.round(0.3 * SR)
    const buf = new FakeBuffer(1, voiced + 2 * pad, SR)
    const ch = buf.getChannelData(0)
    for (let i = pad; i < pad + voiced; i++) ch[i] = i % 2 ? 0.2 : -0.2
    return Promise.resolve(buf)
  }
}
globalThis.AudioContext = FakeAudioContext

class FakeUtterance {
  constructor(text) { this.text = text; this.rate = 1 }
}
globalThis.SpeechSynthesisUtterance = FakeUtterance
globalThis.speechSynthesis = {
  getVoices: () => [{ name: 'sys', lang: 'zh-CN' }],
  addEventListener() {},
  speak(u) {
    env.speechQueue.push(u)
    env.maxSpeechQueue = Math.max(env.maxSpeechQueue, env.speechQueue.length)
    if (env.speechQueue.length === 1) this.run()
  },
  run() {
    const u = env.speechQueue[0]
    if (!u) return
    setTimeout(() => {
      if (env.speechQueue[0] !== u) return
      u.onstart?.()
      setTimeout(() => {
        if (env.speechQueue[0] !== u) return
        env.speechQueue.shift()
        env.spoken.push(u.text)
        u.onend?.()
        this.run()
      }, 8)
    }, 1)
  },
  cancel() {
    const q = env.speechQueue.splice(0)
    for (const u of q) u.onerror?.({ error: 'canceled' })
  },
  pause() {}, resume() {},
}

class FakeAudio {
  constructor(url) { this.url = url; this.currentTime = 0; this.duration = NaN; this.error = null }
  play() {
    env.elementsPlayed++
    setTimeout(() => { this.onloadedmetadata?.(); this.onplaying?.() }, 1)
    setTimeout(() => { this.currentTime = 1e9; this.onended?.() }, 15)
    return Promise.resolve()
  }
  pause() {}
}
globalThis.Audio = FakeAudio

const fakeSynth = `(text) => {
  const env = globalThis.__listenEnv
  env.synthCalls.push(text)
  env.inFlight++
  env.maxInFlight = Math.max(env.maxInFlight, env.inFlight)
  return Promise.resolve().then(() => env.synth(text)).finally(() => { env.inFlight-- })
}`
const mocks = {
  '../stores/settings': 'export const useSettings = () => globalThis.__listenEnv.settings',
  './toast': 'export const toast = (...args) => { globalThis.__listenEnv.notices.push(args); return () => {} }',
  '../i18n': 'export const t = key => key',
  './edgeTts': `export const edgeAvailable = () => true;
    export const edgePause = () => {}; export const edgeResume = () => {}; export const edgeStop = () => {};
    export const edgeSynthesize = ${fakeSynth};
    export const playAudio = async () => 'end'`,
  // 本机语音模型 (Qwen3-TTS): 状态与合成都走替身, 记录每次请求的参数与取消
  './localLlm.ts': `export const localModel = () => globalThis.__listenEnv.voiceModel;
    export const localSpeak = (text, opts) => {
      const env = globalThis.__listenEnv
      const id = ++env.voiceSeq
      opts.onRequest?.(id)
      env.voiceCalls.push({ id, text, model: opts.model, lang: opts.lang, voice: opts.voice, rate: opts.rate })
      return (${fakeSynth})(text)
    };
    export const cancelLocalSpeech = id => { globalThis.__listenEnv.voiceCancels.push(id) };
    export const refreshLocalLlm = () => Promise.resolve();
    export const isLocalLlmCrash = () => false`,
  './localTts': `export const localTtsAvailable = () => true;
    export const localTtsWarmup = () => Promise.resolve();
    export const localTtsSynthesize = ${fakeSynth};
    export const localPack = { crashed: false };
    export const isLocalCrashError = () => false`,
}
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (mocks[specifier] && context.parentURL?.includes('/src/services/')) {
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}` }
    }
    return nextResolve(specifier, context)
  },
})
const { ListenPlayer } = await import('../src/services/listenPlayer.ts')
const { resetEdgeFailure } = await import('../src/services/tts.ts')
hook.deregister()

function resetEnv(engine = 'edge') {
  resetEdgeFailure()
  Object.assign(env.settings, { ttsEngine: engine, ttsRate: 1 })
  env.synth = async text => new Blob([text])
  env.voiceModel = undefined
  env.voiceCalls.length = 0
  env.voiceCancels.length = 0
  env.notices.length = 0
  env.synthCalls.length = 0
  env.inFlight = 0
  env.maxInFlight = 0
  env.decodeFails = false
  env.sources.length = 0
  env.spoken.length = 0
  env.speechQueue.length = 0
  env.maxSpeechQueue = 0
  env.elementsPlayed = 0
}

function makePlayer(options = {}) {
  const log = { keys: [], ends: [], buffering: [] }
  let resolveEnd
  log.done = new Promise(resolve => { resolveEnd = resolve })
  const player = new ListenPlayer({
    ...options,
    onSentenceStart: k => log.keys.push(k),
    onEnd: (reason, error) => { log.ends.push(reason); resolveEnd({ reason, error }) },
    onBuffering: w => log.buffering.push(w),
  })
  return { player, log }
}

const until = async (cond, ms = 5000) => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition')
    await tick(5)
  }
}

/** 实际排上时间线的块 (未被撤下) */
const played = () => env.sources.filter(s => !s.stopped)

test('播放器: 全部句子按序出声, 块首尾相接 + 停顿, 读完触发 finished', async () => {
  resetEnv('edge')
  const sentences = book(40, { section: 20 })
  const { player, log } = makePlayer()
  player.play(makeFeed(sentences, 1))
  assert.equal(player.state, 'buffering')
  const end = await log.done
  assert.equal(end.reason, 'finished')
  assert.deepEqual(log.keys, sentences.map(s => s.key))
  assert.equal(player.state, 'idle')
  assert.ok(env.maxInFlight <= 2, `edge 并发 ${env.maxInFlight}`)
  // 合成很快, 不应出现中途缓冲: 只有开头的一次
  assert.deepEqual(log.buffering, [true, false])
  // 每块紧接上一块 + 对应停顿, 块内已裁掉 0.3s 的首尾静音
  const srcs = played()
  for (let i = 1; i < srcs.length; i++) {
    const gap = srcs[i].at - (srcs[i - 1].at + srcs[i - 1].buffer.duration)
    assert.ok(gap > 0.07 && gap < 0.8, `gap ${i}: ${gap}`)
  }
  for (const s of srcs) assert.ok(s.buffer.getChannelData(0)[0] === 0, '淡入从 0 开始')
  // 合成文本覆盖全部句子, 每句恰好一次
  assert.equal(env.synthCalls.join(''), sentences.map(s => s.text).join(''))
})

test('播放器: 合成跟不上时缓冲, 不丢句', async () => {
  resetEnv('edge')
  const sentences = book(20)
  let n = 0
  env.synth = async text => {
    if (++n === 3) await tick(800) // 第 3 块很慢 (≈ 40 秒音频时间)
    return new Blob([text])
  }
  const { player, log } = makePlayer()
  player.play(makeFeed(sentences))
  const end = await log.done
  assert.equal(end.reason, 'finished')
  assert.deepEqual(log.keys, sentences.map(s => s.key))
  assert.ok(log.buffering.length >= 4, `buffering ${log.buffering}`)
  assert.deepEqual(log.buffering.slice(0, 4), [true, false, true, false])
})

test('播放器: 离线引擎串行合成', async () => {
  resetEnv('local')
  const sentences = book(30)
  env.synth = async text => { await tick(3); return new Blob([text]) }
  const { player, log } = makePlayer()
  player.play(makeFeed(sentences))
  await log.done
  assert.deepEqual(log.keys, sentences.map(s => s.key))
  assert.equal(env.maxInFlight, 1)
  assert.ok(env.synthCalls[0].length <= CHUNK_PROFILES.local.firstMax)
})

test('播放器: 本机语音模型逐块串行合成, 带上语言 / 音色 / 语速; 读完后收尾取消不影响已完成的块', async () => {
  resetEnv('qwen')
  env.voiceModel = { installed: true, supported: true, crashed: false, speed: 1.9 }
  Object.assign(env.settings, { qwenVoice: 'male', ttsRate: 1.25 })
  const sentences = book(20)
  env.synth = async text => { await tick(3); return new Blob([text]) }
  const { player, log } = makePlayer()
  player.play(makeFeed(sentences))
  await log.done
  assert.deepEqual(log.keys, sentences.map(s => s.key))
  assert.equal(env.maxInFlight, 1)
  assert.ok(env.voiceCalls.length >= 2)
  assert.ok(env.voiceCalls[0].text.length <= CHUNK_PROFILES.qwen.firstMax)
  for (const call of env.voiceCalls) {
    assert.deepEqual({ model: call.model, lang: call.lang, voice: call.voice, rate: call.rate }, { model: 'qwen3-tts-1.7b-q4', lang: 'zh', voice: 'male', rate: 1.25 })
  }
  // 这次朗读结束时只取消到它自己发出的最后一个请求
  assert.deepEqual(env.voiceCancels, [env.voiceCalls.at(-1).id])
})

test('播放器: 本机语音模型不能用 (没下载 / 实测太慢 / 停用) 时自动走在线语音', async () => {
  for (const model of [undefined, { installed: false, supported: true, crashed: false, speed: null }, { installed: true, supported: true, crashed: false, speed: 0.8 }, { installed: true, supported: true, crashed: true, speed: 2 }]) {
    resetEnv('qwen')
    env.voiceModel = model
    const sentences = book(6)
    const { player, log } = makePlayer()
    player.play(makeFeed(sentences))
    await log.done
    assert.deepEqual(log.keys, sentences.map(s => s.key))
    assert.equal(env.voiceCalls.length, 0, 'on-device voice not used')
    assert.ok(env.synthCalls.length >= 1, 'online voice used instead')
    assert.equal(env.notices.length, 0, 'the fallback is silent')
  }
})

test('播放器: 暂停冻结时间线, 继续后接着读', async () => {
  resetEnv('edge')
  const sentences = book(12)
  const { player, log } = makePlayer()
  player.play(makeFeed(sentences))
  await until(() => log.keys.length >= 2)
  player.pause()
  assert.equal(player.state, 'paused')
  await tick(20)
  assert.equal(env.ctx.state, 'suspended')
  const count = log.keys.length
  await tick(300)
  assert.equal(log.keys.length, count, '暂停期间不再出声')
  player.resume()
  assert.equal(player.state, 'playing')
  await log.done
  assert.deepEqual(log.keys, sentences.map(s => s.key))
})

test('播放器: stop 触发 stopped, 迟到的合成不再排期', async () => {
  resetEnv('edge')
  const gates = []
  env.synth = text => new Promise(resolve => gates.push(() => resolve(new Blob([text]))))
  const sentences = book(20)
  const { player, log } = makePlayer()
  player.play(makeFeed(sentences))
  await until(() => gates.length >= 1)
  gates.shift()()
  await until(() => env.sources.length === 1)
  player.stop()
  assert.deepEqual(log.ends, ['stopped'])
  assert.equal(player.state, 'idle')
  gates.forEach(g => g())
  await tick(100)
  assert.equal(env.sources.length, 1)
  assert.ok(env.sources[0].stopped)
  player.stop()
  assert.deepEqual(log.ends, ['stopped'], '空闲时 stop 不重复触发')
})

test('播放器: play 重新开始时旧会话静默作废', async () => {
  resetEnv('edge')
  const { player, log } = makePlayer()
  player.play(makeFeed(book(10)))
  await until(() => log.keys.length >= 1)
  const second = book(6).map(s => ({ ...s, key: `n-${s.key}` }))
  player.play(makeFeed(second))
  await log.done
  assert.deepEqual(log.ends, ['finished'])
  const tail = log.keys.slice(log.keys.indexOf('n-s0'))
  assert.deepEqual(tail, second.map(s => s.key))
})

test('播放器: invalidate 后当前块读完, 余下按新设置重新合成, 不丢不重', async () => {
  resetEnv('edge')
  const sentences = book(40)
  const { player, log } = makePlayer()
  player.play(makeFeed(sentences, 1))
  await until(() => log.keys.length >= 2)
  const callsBefore = env.synthCalls.length
  env.settings.ttsRate = 1.5
  player.invalidate()
  await log.done
  assert.deepEqual(log.keys, sentences.map(s => s.key))
  assert.ok(env.synthCalls.length > callsBefore)
  // 重新合成的第一块紧接正在播放的块, 之后的合成覆盖到书末
  const resynth = env.synthCalls.slice(callsBefore).join('')
  const all = sentences.map(s => s.text).join('')
  assert.ok(all.endsWith(resynth), '重新合成的内容是书的后半部分, 顺序连续')
  assert.ok(env.sources.some(s => s.stopped), '已排期未开始的块被撤下')
})

test('播放器: 神经引擎失败 → 已排上的播完, 余下改用系统语音, 只提示一次', async () => {
  resetEnv('edge')
  const sentences = book(15)
  let n = 0
  env.synth = async text => {
    if (++n >= 2) throw new Error('network down')
    return new Blob([text])
  }
  const { player, log } = makePlayer()
  player.play(makeFeed(sentences))
  const end = await log.done
  assert.equal(end.reason, 'finished')
  assert.deepEqual(log.keys, sentences.map(s => s.key))
  assert.equal(env.notices.filter(n => n[0] === 'tts.neuralUnavailable').length, 1)
  const first = env.synthCalls[0]
  assert.equal(first + env.spoken.join(''), sentences.map(s => s.text).join(''))
  assert.ok(env.maxSpeechQueue <= 3)
})

test('播放器: host without system speech preserves the service error and finishes scheduled audio', async () => {
  resetEnv('edge')
  const originalSpeech = globalThis.speechSynthesis
  const originalUtterance = globalThis.SpeechSynthesisUtterance
  const failure = new Error('online service unavailable')
  let calls = 0
  env.synth = async text => {
    if (++calls >= 2) throw failure
    return new Blob([text])
  }
  const { player, log } = makePlayer({ canUseSystemSpeech: () => false })
  try {
    delete globalThis.speechSynthesis
    delete globalThis.SpeechSynthesisUtterance
    player.play(makeFeed(book(15)))
    const end = await log.done
    assert.equal(end.reason, 'error')
    assert.equal(end.error, failure)
    assert.ok(log.keys.length > 0, 'already scheduled audio finishes')
    assert.equal(env.spoken.length, 0)
    assert.equal(player.state, 'idle')
    assert.doesNotThrow(() => player.stop())
  } finally {
    player.stop()
    globalThis.speechSynthesis = originalSpeech
    globalThis.SpeechSynthesisUtterance = originalUtterance
  }
})

test('播放器: host can reject an unsupported system engine before constructing an utterance', async () => {
  resetEnv('system')
  const { player, log } = makePlayer({ canUseSystemSpeech: () => false })
  player.play(makeFeed(book(3)))
  const end = await log.done
  assert.equal(end.reason, 'error')
  assert.match(end.error.message, /System speech is unavailable/)
  assert.equal(env.spoken.length, 0)
  assert.equal(player.state, 'idle')
})

test('播放器: 解码失败退回 <audio> 逐块播放', async () => {
  resetEnv('edge')
  env.decodeFails = true
  const sentences = book(12)
  const { player, log } = makePlayer()
  player.play(makeFeed(sentences))
  const end = await log.done
  assert.equal(end.reason, 'finished')
  assert.deepEqual(log.keys, sentences.map(s => s.key))
  assert.ok(env.elementsPlayed >= 2)
  assert.equal(env.sources.length, 0)
})

test('播放器: 系统语音逐句排队, invalidate 时当前句读完再换', async () => {
  resetEnv('system')
  const sentences = book(16, { section: 8 })
  const { player, log } = makePlayer()
  player.play(makeFeed(sentences, 1))
  await until(() => log.keys.length >= 3)
  env.settings.ttsRate = 2
  player.invalidate()
  const end = await log.done
  assert.equal(end.reason, 'finished')
  assert.deepEqual(log.keys, sentences.map(s => s.key))
  assert.deepEqual(env.spoken, sentences.map(s => s.text))
  assert.ok(env.maxSpeechQueue <= 3)
})

test('播放器: feed 出错 → onEnd(error), 之前的句子照常读完', async () => {
  resetEnv('edge')
  let i = 0
  const feed = { async next() { if (i < 4) return S(`s${i++}`, zh(12)); throw new Error('bad chapter') } }
  const { player, log } = makePlayer()
  player.play(feed)
  const end = await log.done
  assert.equal(end.reason, 'error')
  assert.equal(end.error.message, 'bad chapter')
  assert.deepEqual(log.keys, ['s0', 's1', 's2', 's3'])
})

test('播放器: 定时关闭淡出 → 总音量线性渐弱到 0 后暂停, 继续时音量复原并读完', async () => {
  resetEnv('edge')
  const sentences = book(12)
  const { player, log } = makePlayer()
  player.play(makeFeed(sentences))
  await until(() => log.keys.length >= 2)
  const ctx = env.ctx
  const master = ctx.gains.find(g => g.to === ctx.destination)
  assert.ok(master, '有一个接到输出的总音量节点')
  assert.ok(ctx.gains.filter(g => g !== master).every(g => g.to === master), '各块经过总音量')
  const fading = player.fadeOut(0.06)
  assert.equal(master.gain.ramps.length, 1)
  assert.equal(master.gain.ramps[0][0], 0, '渐弱到 0')
  assert.equal(await fading, 'done')
  assert.equal(player.state, 'paused')
  player.resume()
  assert.equal(master.gain.value, 1)
  assert.equal(master.gain.ramps.length, 0, '复原后没有残留的渐弱')
  await log.done
  assert.deepEqual(log.keys, sentences.map(s => s.key))
})

test('播放器: 淡出途中读者自己暂停 → 不再自动暂停, 音量复原', async () => {
  resetEnv('edge')
  const { player, log } = makePlayer()
  player.play(makeFeed(book(12)))
  await until(() => log.keys.length >= 1)
  const fading = player.fadeOut(0.08)
  player.pause()
  assert.equal(await fading, 'cancelled')
  const master = env.ctx.gains.find(g => g.to === env.ctx.destination)
  assert.equal(master.gain.value, 1)
  player.stop()
})

test('播放器: 系统语音没法调音量 → fadeOut 返回 unsupported, 继续读', async () => {
  resetEnv('system')
  const sentences = book(8)
  const { player, log } = makePlayer()
  player.play(makeFeed(sentences))
  await until(() => log.keys.length >= 1)
  assert.equal(await player.fadeOut(0.05), 'unsupported')
  assert.notEqual(player.state, 'paused')
  await log.done
  assert.deepEqual(log.keys, sentences.map(s => s.key))
})
