// 本机语音 (Qwen3-TTS) 的纯函数: 朗读语言判定 / 用不用本机的规则 / 分块上限与模型上下文的关系
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LOCAL_VOICE_MIN_SPEED, QWEN_VOICES, speechLang, voiceModelTooSlow, voiceModelUsable } from '../src/services/localVoiceCore.ts'
import { CHUNK_PROFILES } from '../src/services/listenPlan.ts'

test('朗读语言: 按文字种类, 日文有假名就算日语, 拉丁字母按英语', () => {
  assert.equal(speechLang('满纸荒唐言，一把辛酸泪。'), 'zh')
  assert.equal(speechLang('“Polis” 一词指城邦'), 'zh')
  assert.equal(speechLang('I went down yesterday to the Piraeus.'), 'en')
  assert.equal(speechLang('吾輩は猫である。名前はまだ無い。'), 'ja')
  assert.equal(speechLang('나는 고양이로소이다.'), 'ko')
  assert.equal(speechLang('Все счастливые семьи похожи друг на друга.'), 'ru')
  assert.equal(speechLang('La justice est la première vertu.'), 'en')
  assert.equal(speechLang('1984 ……'), 'zh', '没有字母时用默认')
})

test('用不用本机语音: 装好、带得动、没停用, 且实测跟得上朗读 (没测过先用)', () => {
  const ok = { installed: true, supported: true, crashed: false, speed: 1.9 }
  assert.equal(voiceModelUsable(ok), true)
  assert.equal(voiceModelUsable({ ...ok, speed: null }), true)
  assert.equal(voiceModelUsable(undefined), false)
  assert.equal(voiceModelUsable({ ...ok, installed: false }), false)
  assert.equal(voiceModelUsable({ ...ok, supported: false }), false)
  assert.equal(voiceModelUsable({ ...ok, crashed: true }), false)
  // 与播放速度持平不够: 预取攒不住
  assert.equal(voiceModelUsable({ ...ok, speed: 1.0 }), false)
  assert.equal(voiceModelTooSlow({ ...ok, speed: 1.0 }), true)
  assert.equal(voiceModelTooSlow({ ...ok, speed: LOCAL_VOICE_MIN_SPEED }), false)
  assert.equal(voiceModelTooSlow({ ...ok, speed: null }), false)
  assert.equal(voiceModelTooSlow(undefined), false)
})

test('分块: 一块装得进语音模型的上下文, 首块更短', () => {
  const p = CHUNK_PROFILES.qwen
  assert.ok(p.firstMax < p.target && p.target < p.max)
  // 原生层: 上下文 2048, 每秒 12 帧, 文本与参考音色留 600; 中文约 4 字/秒
  const seconds = p.max / 4
  assert.ok(seconds * 12 < 2048 - 600, `${seconds}s per chunk`)
  assert.deepEqual([...QWEN_VOICES], ['female', 'male'], '与 src-tauri/voices/*.wav 一一对应')
})
