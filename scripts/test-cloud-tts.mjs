// API 语音 (MiniMax / 豆包): 音色目录、设置 → 请求映射、错误分类
// 运行: npm run test:cloud-tts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CloudTtsError, DEFAULT_DOUBAO_VOICE, DEFAULT_MINIMAX_VOICE, DOUBAO_VOICES, MINIMAX_MODELS, MINIMAX_VOICES,
  buildCloudRequest, cloudErrorCode, cloudSignature, doubaoResourceId, isTransientCloudError,
} from '../src/services/cloudTts.ts'

const base = {
  cloudTtsProvider: 'minimax', minimaxRegion: 'cn', minimaxModel: 'speech-2.8-hd', minimaxVoice: 'female-chengshu',
  minimaxApiKey: ' mm-key ', doubaoVoice: DEFAULT_DOUBAO_VOICE, doubaoApiKey: ' db-key ', doubaoAppId: '', httpProxy: '',
}

test('目录: id 唯一, 默认音色在目录里, 男女声都有', () => {
  for (const [voices, fallback] of [[MINIMAX_VOICES, DEFAULT_MINIMAX_VOICE], [DOUBAO_VOICES, DEFAULT_DOUBAO_VOICE]]) {
    assert.equal(new Set(voices.map(v => v.id)).size, voices.length)
    assert.ok(voices.some(v => v.id === fallback))
    assert.ok(voices.some(v => v.gender === 'male') && voices.some(v => v.gender === 'female'))
  }
  assert.ok(MINIMAX_MODELS.includes('speech-2.8-turbo'))
})

test('豆包 Resource Id 跟随音色版本', () => {
  assert.equal(doubaoResourceId('zh_female_wenroushunv_uranus_bigtts'), 'seed-tts-2.0')
  assert.equal(doubaoResourceId('ICL_uranus_zh_male_fengfashaonian_tob'), 'seed-tts-2.0')
  assert.equal(doubaoResourceId('zh_female_wanwanxiaohe_moon_bigtts'), 'seed-tts-1.0')
  assert.equal(doubaoResourceId('S_abc123'), 'seed-icl-2.0')
  for (const v of DOUBAO_VOICES) assert.match(doubaoResourceId(v.id), /^seed-tts-/)
})

test('MiniMax 请求: Key 去空白, 语速限制在 0.5–2, 带模型与站点', () => {
  const req = buildCloudRequest({ ...base, minimaxRegion: 'global' }, '正文', 3)
  assert.deepEqual(req, {
    provider: 'minimax', apiKey: 'mm-key', text: '正文', rate: 2, proxy: undefined,
    voice: 'female-chengshu', model: 'speech-2.8-hd', region: 'global',
  })
  assert.equal(buildCloudRequest(base, '正文', 0.1).rate, 0.5)
})

test('豆包请求: 只取豆包的 Key, 空音色回退默认, 旧版控制台带 App ID', () => {
  const doubao = { ...base, cloudTtsProvider: 'doubao', doubaoVoice: ' ' }
  const req = buildCloudRequest(doubao, '正文', 1)
  assert.equal(req.apiKey, 'db-key')
  assert.equal(req.voice, DEFAULT_DOUBAO_VOICE)
  assert.equal(req.resourceId, 'seed-tts-2.0')
  assert.equal(req.appId, undefined)
  assert.equal(buildCloudRequest({ ...doubao, doubaoAppId: ' 123 ' }, '正文', 1).appId, '123')
})

test('没填 Key: 不发请求, 抛 missing_key', () => {
  assert.throws(() => buildCloudRequest({ ...base, minimaxApiKey: '  ' }, '正文', 1), e => e instanceof CloudTtsError && e.code === 'missing_key')
  assert.throws(() => buildCloudRequest({ ...base, cloudTtsProvider: 'doubao', doubaoApiKey: '' }, '正文', 1), e => e.code === 'missing_key')
})

test('错误分类: 只认 cloud_tts 前缀; 只有临时错误才重试', () => {
  assert.equal(cloudErrorCode('cloud_tts:auth:invalid'), 'auth')
  assert.equal(cloudErrorCode(new Error('cloud_tts:quota:')), 'quota')
  assert.equal(cloudErrorCode('cloud_tts:unknown:x'), null)
  assert.equal(cloudErrorCode('连接语音服务失败'), null)
  for (const code of ['network', 'server', 'rate']) assert.ok(isTransientCloudError(`cloud_tts:${code}:x`), code)
  for (const code of ['auth', 'quota', 'voice', 'text', 'missing_key', 'bad_response']) assert.ok(!isTransientCloudError(`cloud_tts:${code}:x`), code)
})

test('配置签名: 换音色或模型会变, 换 Key 不进缓存键', () => {
  const sig = cloudSignature(base)
  assert.notEqual(cloudSignature({ ...base, minimaxVoice: 'x' }), sig)
  assert.notEqual(cloudSignature({ ...base, minimaxModel: 'x' }), sig)
  assert.equal(cloudSignature({ ...base, minimaxApiKey: 'other' }), sig)
  assert.ok(!sig.includes('mm-key'))
})
