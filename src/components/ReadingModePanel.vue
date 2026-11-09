<script setup lang="ts">
import { AUTO_SPEED_STEPS, speedPosition, secondsAtPosition, type AutoReadMotion } from '../services/autoReadSpeed'
import { normalizeFocusLines, lyricHeight, anchorAtHeight } from '../services/readingModes/lyric'
import LevelSlider from './LevelSlider.vue'
/**
 * 「阅读模式」面板 (docs/reader-panels.md §3.2): 场景与带读。桌面为顶栏下的浮层卡片, 手机为底部抽屉
 * (遮罩由 ReaderView 的 sheet-scrim 提供)。自上而下:
 *   运行条 → #top 插槽 (点睛阅读: 总开关 + 基础 / 智能, 见 DianjingToggle) → 场景 (夜读 / 护眼 / 墨水屏 / 大字 / 沉浸)
 *   → 带读 [自动翻页 | 打字机 | 歌词 | 听书] (同一时间只运行一个)。
 * 场景是开关卡片: 一键套用一组「排版」里的值 (记快照, 关闭写回), 自己不保存也不提供这些值的控件;
 * 点卡片角上的 ⓘ 展开「会调整什么」、场景自己的选项 (定时、休息提醒、大 / 特大…) 和「在排版里微调」。
 * 自动翻页沿用 ReaderView 的实现 (props/emits), 容器保留 .auto-panel 类名供 e2e 使用。
 */
import { computed, ref } from 'vue'
import { t } from '../i18n'
import { matchesMQ, MQ } from '../composables/useMediaQuery'
import { useSettings } from '../stores/settings'
import type { ReadingModes, ReadingModeTab } from '../composables/useReadingModes'
import { TYPING_SOUND_PRESETS } from '../services/readingModes/soundPresets'
import { previewTypingSound } from '../services/readingModes/sound'
import type { ReadingModeProgress } from '../services/readingModes/progress'
import { largeTextValues } from '../services/readingModes/presets'
import type { TypographySection } from './TypographyPanel.vue'
import { bossKeyLabel } from '../services/stealth'

const props = defineProps<{
  modes: ReadingModes
  /** 自动翻页是否在运行 (ReaderView 的 autoReading) */
  autoReading: boolean
  autoPaused?: boolean
  /** 自动翻页速度, 秒/页 (v-model:auto-read-seconds); 滚动模式下为秒/屏 */
  autoReadSeconds: number
  /** 自动阅读的推进方式 (翻页 / 匀速滚动 / 墨水屏整屏推进), 见 services/autoReadSpeed autoReadMotion */
  autoMotion?: AutoReadMotion
  /** 生效的版式 (竖屏锁定、歌词临时滚动都已算进去), 见 services/portraitLayout effectiveReaderLayout */
  effectiveFlow?: 'paginated' | 'scrolled'
  /** 固定版式 (漫画 / 版式 EPUB): 没有翻页 / 滚动之分 */
  fixedLayout?: boolean
  /** 打字机 / 歌词运行时的进度与剩余时间 (阅读器计算); 未运行为 null */
  progress?: ReadingModeProgress | null
  /** 听书正在播放 */
  ttsActive?: boolean
  /** 桌面安装版: 显示摸鱼模式 (窗口级场景, 进入后面板关闭) */
  stealthAvailable?: boolean
}>()

const emit = defineEmits<{
  'start-auto': []
  'stop-auto': []
  'toggle-auto': []
  'update:autoReadSeconds': [value: number]
  /** 「听书」行的主按钮: 打开现有听书面板 */
  'open-tts': []
  /** 场景微调 / 带读版式入口: 打开排版面板并滚到对应分区 */
  'open-typography': [section: TypographySection]
  /** 摸鱼模式: 打开开关即进入 */
  'enter-stealth': []
  close: []
}>()

const settings = useSettings()
const tw = computed(() => settings.readingMode.typewriter)
const ly = computed(() => settings.readingMode.lyric)
const eye = computed(() => settings.readingMode.eyeCare)

const expanded = ref<ReadingModeTab | null>(props.modes.panelTab.value === 'tts' ? null : props.modes.panelTab.value)
function toggleSettings(guide: ReadingModeTab) {
  expanded.value = expanded.value === guide ? null : guide
  if (expanded.value) props.modes.panelTab.value = guide
}
const twState = computed(() => props.modes.typewriterState.value)
const twActive = computed(() => twState.value !== 'idle')
const lyActive = computed(() => props.modes.lyricActive.value)
const lyState = computed(() => props.modes.lyricState.value)
const lyricDriver = computed(() => lyActive.value ? props.modes.lyricDriver.value : ly.value.driver)
const supported = computed(() => props.modes.supported.value)

const lyricPosition = computed(() => lyricHeight(ly.value.anchor))
function onLyricLines(event: Event) {
  const input = event.target as HTMLInputElement
  if (input.value.trim()) settings.readingMode.lyric.lines = normalizeFocusLines(Number(input.value))
  input.value = String(ly.value.lines)
}
function onLyricPosition(event: Event) {
  const input = event.target as HTMLInputElement
  if (input.value.trim() && Number.isFinite(Number(input.value))) settings.readingMode.lyric.anchor = anchorAtHeight(Number(input.value))
  input.value = String(lyricPosition.value)
}

function onLyricSlider(event: Event) {
  const value = Math.round(Number((event.target as HTMLInputElement).value) * 10) / 10
  settings.readingMode.lyric.anchor = anchorAtHeight(value)
}
function onLyricSliderKey(event: KeyboardEvent) {
  const direction = ['ArrowUp', 'ArrowRight'].includes(event.key) ? 1 : ['ArrowDown', 'ArrowLeft'].includes(event.key) ? -1 : 0
  if (!direction && !['Home', 'End'].includes(event.key)) return
  event.preventDefault()
  event.stopPropagation()
  const value = event.key === 'Home' ? 0 : event.key === 'End' ? 1
    : (direction > 0 ? Math.floor(lyricPosition.value * 10 + 0.00001) + 1 : Math.ceil(lyricPosition.value * 10 - 0.00001) - 1) / 10
  settings.readingMode.lyric.anchor = anchorAtHeight(value)
}

// ---- 场景卡片 ----
type SceneId = 'night' | 'eyeCare' | 'eink' | 'largeText' | 'immersive'
const detail = ref<SceneId | null>(null)

interface SceneCard {
  id: SceneId
  key: string
  on: boolean
  toggle: () => void
  /** 「在排版里微调」跳到的分区; 不改排版值的场景没有 */
  tune?: TypographySection
}

const sceneCards = computed<SceneCard[]>(() => [
  { id: 'night', key: 'readingMode.modeNight', on: props.modes.nightOn.value, toggle: props.modes.toggleNight, tune: 'color' },
  { id: 'eyeCare', key: 'readingMode.modeEyeCare', on: props.modes.eyeCareOn.value, toggle: props.modes.toggleEyeCare, tune: 'color' },
  { id: 'eink', key: 'readingMode.modeEink', on: props.modes.einkActive.value, toggle: props.modes.toggleEink },
  { id: 'largeText', key: 'readingMode.modeLargeText', on: props.modes.largeTextOn.value, toggle: props.modes.toggleLargeText, tune: 'text' },
  { id: 'immersive', key: 'readingMode.modeImmersive', on: props.modes.immersive.value, toggle: props.modes.toggleImmersive },
])
const detailCard = computed(() => sceneCards.value.find(c => c.id === detail.value) ?? null)

function toggleCard(c: SceneCard) {
  c.toggle()
  // 刚打开的卡片顺带展开它的详情; 关掉时收起
  detail.value = c.on ? (detail.value === c.id ? null : detail.value) : c.id
}
function toggleDetail(id: SceneId) {
  detail.value = detail.value === id ? null : id
}

/** 场景会调整的东西 (只读说明; 数值在排版里调) */
const sceneChanges = computed<string[]>(() => {
  switch (detail.value) {
    case 'night':
      return [t('readingMode.chgTheme', { name: t('reader.themeDark') })]
    case 'eyeCare':
      return [t('readingMode.chgTheme', { name: t(eye.value.theme === 'green' ? 'reader.themeGreen' : 'reader.themeSepia') })]
    case 'eink':
      return ['chgEinkColors', 'chgBold', 'chgNoAnimation', 'chgTypewriterSentence', 'chgLyricJump'].map(k => t(`readingMode.${k}`))
    case 'largeText': {
      const lt = settings.readingMode.largeText
      const v = largeTextValues(lt.size, lt.custom)
      return [
        t('readingMode.chgFontSize', { n: Number(v['reader.fontSize']) }),
        t('readingMode.chgLineHeight'),
        t('readingMode.chgLetterSpacing'),
        t('readingMode.chgMargin', { n: Number(v['reader.gap']) }),
        t('readingMode.chgHeiti'),
        t('readingMode.chgNoJustify'),
        t('readingMode.chgSingleColumn'),
        t('readingMode.chgLargeUi'),
      ]
    }
    case 'immersive':
      return ['chgHideHeader', 'chgAutoHideBars', 'chgSystemBars'].map(k => t(`readingMode.${k}`))
    default:
      return []
  }
})

function tune(section: TypographySection) {
  emit('open-typography', section)
}

// ---- 摸鱼: 面板最上面一行开关 ----
const stealthKey = computed(() => (settings.stealth.bossKey ? bossKeyLabel(settings.stealth.bossKey) : ''))

const reminderIntervals = [20, 30, 45] as const

function onClock(which: 'from' | 'to', e: Event) {
  const v = (e.target as HTMLInputElement).value
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) settings.readingMode.night[which] = v
  else (e.target as HTMLInputElement).value = settings.readingMode.night[which]
}

// ---- 带读 ----
const autoScrolled = computed(() => !!props.autoMotion && props.autoMotion !== 'page')
const guides = computed(() => [
  // 滚动方式下自动翻页是匀速滚动, 列表行随之改名
  { value: 'auto' as const, key: autoScrolled.value ? 'readingMode.tabAutoScroll' : 'readingMode.tabAuto' },
  { value: 'typewriter' as const, key: 'readingMode.tabTypewriter' },
  { value: 'lyric' as const, key: 'readingMode.tabLyric' },
  { value: 'tts' as const, key: 'readingMode.tabTts' },
])

/** 说明与跳转都按当前生效版式; 歌词退出后恢复保存的选择。 */
function guideLayoutNote(guide: ReadingModeTab) {
  if ((guide === 'typewriter' || guide === 'lyric') && !supported.value) return t('readingMode.modeUnsupported')
  const scrolled = props.effectiveFlow === 'scrolled'
  switch (guide) {
    case 'auto': return t(props.autoMotion === 'screen' ? 'readingMode.autoScreenNote' : scrolled && !props.fixedLayout ? 'readingMode.autoScrollNote' : 'readingMode.autoPageNote')
    case 'typewriter': return t(scrolled ? 'readingMode.typewriterScrollNote' : 'readingMode.typewriterPageNote')
    case 'lyric': return t(scrolled ? 'readingMode.lyricRowNote' : 'readingMode.lyricLayoutNote')
    case 'tts': return t('readingMode.ttsHint')
  }
}
const runningTab = computed<ReadingModeTab | null>(() => {
  if (props.autoReading) return 'auto'
  if (twActive.value) return 'typewriter'
  if (lyActive.value) return 'lyric'
  return null
})
const runningName = computed(() => t(guides.value.find(g => g.value === runningTab.value)?.key ?? 'readingMode.title'))
const paused = computed(() => runningTab.value === 'auto' ? props.autoPaused : runningTab.value === 'typewriter' ? twState.value === 'paused' : lyState.value === 'paused')
const canPause = computed(() => runningTab.value !== 'lyric' || props.modes.lyricDriver.value === 'pace')
function toggleRunning() {
  if (runningTab.value === 'auto') emit('toggle-auto')
  else props.modes.togglePause()
}
function stopRunning() {
  if (runningTab.value === 'auto') emit('stop-auto')
  else props.modes.stop()
}
function actionLabel(guide: ReadingModeTab) {
  if (guide === 'tts') return t('readingMode.openGuideTts')
  if (guide !== runningTab.value) return t('common.start')
  if (guide === 'lyric' && !canPause.value) return t('readingMode.exitGuide')
  return t(paused.value ? 'common.resume' : 'common.pause')
}
function act(guide: ReadingModeTab) {
  if (guide === 'tts') return openTts()
  if (guide === runningTab.value) {
    if (guide === 'lyric' && !canPause.value) stopRunning()
    else toggleRunning()
    return
  }
  if (guide === 'auto') toggleAuto()
  else if (guide === 'typewriter') props.modes.start()
  else void props.modes.startLyric()
}

const units = [
  { value: 'char', key: 'readingMode.unitChar' },
  { value: 'sentence', key: 'readingMode.unitSentence' },
  { value: 'line', key: 'readingMode.unitLine' },
] as const

const drivers = [
  { value: 'pace', key: 'readingMode.driverPace' },
  { value: 'tts', key: 'readingMode.driverTts' },
  { value: 'manual', key: 'readingMode.driverManual' },
] as const

const scales = [
  { value: 1, label: () => t('readingMode.scaleOriginal') },
  { value: 1.2, label: () => t('readingMode.scaleFactor', { n: 1.2 }) },
  { value: 1.4, label: () => t('readingMode.scaleFactor', { n: 1.4 }) },
] as const

const speedLabels = ['readingMode.speedSlow', 'readingMode.speedMedium', 'readingMode.speedFast']
const autoStops = computed(() => [1, 50, 100].map((value, i) => ({ value, label: t(speedLabels[i]) })))
// 常用速度集中在总范围的低端；把三个预设分散到滑轨上，避免窄屏刻度重叠。
// 两端仍能到达完整速度范围，存储和直接输入继续使用字/分或词/分。
const speedPositions = [0, 15, 50, 85, 100]
const speedStops = computed(() => speedPositions.slice(1, -1).map((value, i) => ({ value, label: t(speedLabels[i]) })))
const speedValues = computed(() => [props.modes.speedLimits.value[0], ...props.modes.presets.value, props.modes.speedLimits.value[1]])
function interpolate(value: number, from: number[], to: number[]) {
  const n = Math.max(from[0], Math.min(from[from.length - 1], value))
  const i = Math.max(0, from.findIndex((end, index) => index > 0 && n <= end) - 1)
  return to[i] + (n - from[i]) / (from[i + 1] - from[i]) * (to[i + 1] - to[i])
}
const guidedSpeedPosition = computed(() => interpolate(props.modes.speed.value, speedValues.value, speedPositions))
function setGuidedSpeed(position: number) {
  props.modes.speed.value = Math.round(interpolate(position, speedPositions, speedValues.value) / 10) * 10
}
function close() {
  props.modes.closePanel()
  emit('close')
}


function toggleAuto() {
  // 手机上面板是盖住正文的底部抽屉: 开始后收起 (同打字机 / 歌词), 暂停、调速用底部迷你条或轻点正文
  if (matchesMQ(MQ.phone)) close()
  emit('start-auto')
}

function openTts() {
  props.modes.closePanel()
  emit('open-tts')
}

/** 输入框给出具体值: 失焦或回车生效, 越界 / 非数字时收敛并把实际生效的值写回输入框 */
function onSpeedExact(e: Event) {
  const el = e.target as HTMLInputElement
  const n = Number(el.value)
  if (el.value.trim() && Number.isFinite(n)) props.modes.speed.value = n
  el.value = String(props.modes.speed.value)
}

function onAutoSpeedExact(e: Event) {
  const el = e.target as HTMLInputElement
  const n = Number(el.value)
  const value = el.value.trim() && Number.isFinite(n) ? Math.round(Math.min(300, Math.max(3, n)) * 10) / 10 : props.autoReadSeconds
  emit('update:autoReadSeconds', value)
  el.value = String(value)
}
</script>

<template>
  <section class="rm-panel card" role="dialog" :aria-label="t('readingMode.title')">
    <header class="rm-head">
      <strong>{{ t('readingMode.title') }}</strong>
      <button class="rm-close" type="button" :title="t('common.close')" :aria-label="t('common.close')" @click="close">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6.3 6.3a1 1 0 0 1 1.4 0L12 10.58l4.3-4.3a1 1 0 1 1 1.4 1.42L13.42 12l4.3 4.3a1 1 0 0 1-1.42 1.4L12 13.42l-4.3 4.3a1 1 0 0 1-1.4-1.42L10.58 12l-4.3-4.3a1 1 0 0 1 0-1.4z"/></svg>
      </button>
    </header>

    <div v-if="runningTab" class="rm-running">
      <div class="rm-running-head">
        <span class="rm-running-dot" aria-hidden="true" />
        <strong>{{ runningName }}</strong>
        <button v-if="canPause" type="button" class="btn" @click="toggleRunning">{{ t(paused ? 'common.resume' : 'common.pause') }}</button>
        <button type="button" class="btn" @click="stopRunning">{{ t('readingMode.exitGuide') }}</button>
      </div>
      <div v-if="progress" class="rm-progress">
        <div class="rm-progress-head">
          <span class="rm-progress-chapter">{{ progress.chapter }}</span>
          <span class="rm-progress-eta">{{ progress.chapterLeft || progress.percent }}</span>
        </div>
        <div
          class="rm-progress-track"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="Math.round(progress.chapterProgress * 100)"
          :aria-label="t('tts.chapterProgress')"
        >
          <span :style="{ transform: `scaleX(${progress.chapterProgress})` }" />
        </div>
        <div class="rm-progress-sub">
          <span>{{ progress.finish }}</span>
          <span>{{ progress.book }}</span>
        </div>
      </div>

    </div>
    <!-- 摸鱼: 和点睛同样一行开关; 打开即进入 (面板随之关闭), 浓淡在窗口顶边细条里调, 其余在设置页 -->
    <label v-if="stealthAvailable" class="rm-stealth">
      <span class="rm-stealth-text">
        <span class="rm-stealth-title">{{ t('stealth.title') }}</span>
        <span class="rm-stealth-sub">{{ stealthKey ? t('stealth.cardHint', { key: stealthKey }) : t('stealth.cardHintNoKey') }}</span>
      </span>
      <span class="rm-switch">
        <input type="checkbox" role="switch" :checked="false" aria-checked="false" :aria-label="t('stealth.enter')" @change="emit('enter-stealth')" />
        <span class="rm-switch-track" aria-hidden="true"></span>
      </span>
    </label>
    <slot name="top" />

    <!-- 场景: 一键套用一组排版值, 关闭恢复; 数值本身在「排版」里调 -->
    <section class="rm-group" :aria-label="t('readingMode.groupScenes')">
      <h3 class="rm-group-title">{{ t('readingMode.groupScenes') }}</h3>
      <div class="rm-cards">
        <div v-for="c in sceneCards" :key="c.id" class="rm-card" :class="{ on: c.on, open: detail === c.id }">
          <button
            type="button"
            class="rm-card-main"
            role="switch"
            :aria-checked="c.on"
            @click="toggleCard(c)"
          >
            <svg v-if="c.id === 'night'" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M11.2 3.05a1 1 0 0 1 .3 1.06A7 7 0 0 0 19.9 12.5a1 1 0 0 1 1.36 1.06A9.5 9.5 0 1 1 10.15 2.73a1 1 0 0 1 1.05.32zM8.96 5.3a7.5 7.5 0 1 0 9.74 9.74A9 9 0 0 1 8.96 5.3z"/></svg>
            <svg v-else-if="c.id === 'eyeCare'" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm0-7a1 1 0 0 1 1 1v1.5a1 1 0 1 1-2 0V3a1 1 0 0 1 1-1zm0 17.5a1 1 0 0 1 1 1V21a1 1 0 1 1-2 0v-.5a1 1 0 0 1 1-1zM3 11h1.5a1 1 0 1 1 0 2H3a1 1 0 1 1 0-2zm16.5 0H21a1 1 0 1 1 0 2h-1.5a1 1 0 1 1 0-2z"/></svg>
            <svg v-else-if="c.id === 'eink'" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M7 2h10a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3zm0 2a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H7zm2 3h6a1 1 0 1 1 0 2H9a1 1 0 0 1 0-2zm0 4h6a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2zm0 4h3a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2z"/></svg>
            <svg v-else-if="c.id === 'largeText'" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M8.9 4.4a1 1 0 0 1 1.86 0l5.5 14.2a1 1 0 1 1-1.87.72L12.9 15.5H6.76l-1.5 3.82a1 1 0 0 1-1.86-.72L8.9 4.4zM7.54 13.5h4.58L9.83 7.6l-2.3 5.9zM18.5 10a1 1 0 0 1 1 1v1.5H21a1 1 0 1 1 0 2h-1.5V16a1 1 0 1 1-2 0v-1.5H16a1 1 0 1 1 0-2h1.5V11a1 1 0 0 1 1-1z"/></svg>
            <svg v-else viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M4 3h4a1 1 0 0 1 0 2H6.41l3.3 3.3a1 1 0 0 1-1.42 1.4L5 6.42V8a1 1 0 0 1-2 0V4a1 1 0 0 1 1-1zm12 0h4a1 1 0 0 1 1 1v4a1 1 0 1 1-2 0V6.41l-3.3 3.3a1 1 0 1 1-1.4-1.42L17.58 5H16a1 1 0 1 1 0-2zM9.7 14.3a1 1 0 0 1 0 1.4L6.42 19H8a1 1 0 1 1 0 2H4a1 1 0 0 1-1-1v-4a1 1 0 1 1 2 0v1.59l3.3-3.3a1 1 0 0 1 1.4 0zm4.6 0a1 1 0 0 1 1.4 0l3.3 3.29V16a1 1 0 1 1 2 0v4a1 1 0 0 1-1 1h-4a1 1 0 1 1 0-2h1.59l-3.3-3.3a1 1 0 0 1 0-1.4z"/></svg>
            <span class="rm-card-name">{{ t(c.key) }}</span>
            <span class="rm-card-state">{{ c.on ? t('readingMode.stateOn') : t('readingMode.stateOff') }}</span>
          </button>
          <button
            type="button"
            class="rm-card-info"
            :aria-expanded="detail === c.id"
            :aria-label="t('readingMode.details', { name: t(c.key) })"
            :title="t('readingMode.details', { name: t(c.key) })"
            @click="toggleDetail(c.id)"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm0 6a1 1 0 0 1 1 1v5a1 1 0 1 1-2 0v-5a1 1 0 0 1 1-1zm0-4a1.25 1.25 0 1 1 0 2.5A1.25 1.25 0 0 1 12 6z"/></svg>
          </button>
        </div>
      </div>
      <p v-if="!detailCard" class="rm-hint">{{ t('readingMode.scenesHint') }}</p>

      <div v-else class="rm-detail">
        <!-- 会调整什么 (只读) -->
        <div class="rm-changes">
          <span class="rm-changes-label">{{ t('readingMode.sceneChanges') }}</span>
          <span v-for="chg in sceneChanges" :key="chg" class="rm-change">{{ chg }}</span>
        </div>
        <p v-if="detail === 'night'" class="rm-hint">{{ t('readingMode.nightDesc') }}</p>
        <p v-else-if="detail === 'eyeCare'" class="rm-hint">{{ t('readingMode.eyeCareDesc') }}</p>
        <p v-else-if="detail === 'eink'" class="rm-hint">{{ t('readingMode.einkDesc') }}</p>
        <p v-else-if="detail === 'largeText'" class="rm-hint">{{ t('readingMode.largeTextDesc') }}</p>
        <p v-else class="rm-hint">{{ t('readingMode.immersiveDesc') }}</p>

        <!-- 夜读: 定时开启 -->
        <template v-if="detail === 'night'">
          <label class="rm-toggle">
            <span>{{ t('readingMode.nightSchedule') }}</span>
            <span class="rm-switch">
              <input v-model="settings.readingMode.night.schedule" type="checkbox" role="switch" :aria-checked="settings.readingMode.night.schedule" />
              <span class="rm-switch-track" aria-hidden="true"></span>
            </span>
          </label>
          <div v-if="settings.readingMode.night.schedule" class="rm-row rm-clock">
            <span class="rm-label">{{ t('readingMode.nightFrom') }}</span>
            <input class="rm-time" type="text" inputmode="text" maxlength="5" placeholder="HH:MM" :value="settings.readingMode.night.from" :aria-label="t('readingMode.nightFrom')" @change="onClock('from', $event)" />
            <span>{{ t('readingMode.nightTo') }}</span>
            <input class="rm-time" type="text" inputmode="text" maxlength="5" placeholder="HH:MM" :value="settings.readingMode.night.to" :aria-label="t('readingMode.nightTo')" @change="onClock('to', $event)" />
          </div>
          <p v-if="settings.readingMode.night.schedule" class="rm-hint">{{ t('readingMode.nightScheduleHint') }}</p>
        </template>

        <!-- 护眼: 休息提醒 -->
        <template v-else-if="detail === 'eyeCare'">
          <label class="rm-toggle">
            <span>{{ t('readingMode.reminder') }}</span>
            <span class="rm-switch">
              <input v-model="settings.readingMode.eyeCare.reminder" type="checkbox" role="switch" :aria-checked="eye.reminder" />
              <span class="rm-switch-track" aria-hidden="true"></span>
            </span>
          </label>
          <div v-if="eye.reminder" class="segmented rm-self-start">
            <button
              v-for="n in reminderIntervals"
              :key="n"
              type="button"
              :class="{ active: eye.intervalMin === n }"
              :aria-pressed="eye.intervalMin === n"
              @click="settings.readingMode.eyeCare.intervalMin = n"
            >
              {{ t('readingMode.minutes', { n }) }}
            </button>
          </div>
        </template>

        <!-- 大字: 大 / 特大 (选哪一套, 不是字号本身) -->
        <div v-else-if="detail === 'largeText'" class="segmented rm-self-start">
          <button
            type="button"
            :class="{ active: settings.readingMode.largeText.size === 'large' }"
            :aria-pressed="settings.readingMode.largeText.size === 'large'"
            @click="modes.setLargeTextSize('large')"
          >
            {{ t('readingMode.sizeLarge') }} 24
          </button>
          <button
            type="button"
            :class="{ active: settings.readingMode.largeText.size === 'xlarge' }"
            :aria-pressed="settings.readingMode.largeText.size === 'xlarge'"
            @click="modes.setLargeTextSize('xlarge')"
          >
            {{ t('readingMode.sizeXLarge') }} 30
          </button>
        </div>

        <!-- 沉浸: 连页码也隐藏 -->
        <label v-else-if="detail === 'immersive'" class="rm-toggle">
          <span>{{ t('readingMode.hideFooter') }}</span>
          <span class="rm-switch">
            <input v-model="settings.readingMode.immersive.hideFooter" type="checkbox" role="switch" :aria-checked="settings.readingMode.immersive.hideFooter" />
            <span class="rm-switch-track" aria-hidden="true"></span>
          </span>
        </label>

        <button v-if="detailCard.tune" type="button" class="rm-tune" @click="tune(detailCard.tune)">
          {{ t('readingMode.tuneInTypography') }}
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9.3 6.3a1 1 0 0 1 1.4 0l5 5a1 1 0 0 1 0 1.4l-5 5a1 1 0 1 1-1.4-1.4L13.58 12 9.3 7.7a1 1 0 0 1 0-1.4z"/></svg>
        </button>
      </div>
    </section>

    <section class="rm-group" :aria-label="t('readingMode.groupGuide')">
      <h3 class="rm-group-title rm-guide-title">{{ t('readingMode.groupGuide') }}<small>{{ t('readingMode.oneGuide') }}</small></h3>
      <div class="rm-guides">
        <div v-for="g in guides" :key="g.value" class="rm-guide" :data-guide="g.value" :class="{ 'is-running': runningTab === g.value || (g.value === 'tts' && ttsActive) }">
          <div class="rm-guide-main">
            <div class="rm-guide-text">
              <div class="rm-guide-name">{{ t(g.key) }}</div>
              <div class="rm-hint">
                <button v-if="g.value === 'tts' && ttsActive && !lyActive && supported" type="button" class="rm-layout-link" @click="modes.startLyric('tts')">{{ t('readingMode.lyricWithTts') }}</button>
                <template v-else>{{ guideLayoutNote(g.value) }}</template>
                <button v-if="g.value !== 'tts' && !fixedLayout" type="button" class="rm-layout-link" @click="emit('open-typography', 'page')">
                  {{ t(effectiveFlow === 'scrolled' ? 'readingMode.changeScroll' : 'readingMode.changePages') }}
                  <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" /></svg>
                </button>
              </div>
            </div>
            <button v-if="g.value !== 'tts'" type="button" class="rm-gear" :aria-expanded="expanded === g.value" :aria-controls="`guide-settings-${g.value}`" :aria-label="t('readingMode.guideSettings', { name: t(g.key) })" @click="toggleSettings(g.value)">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m10 3-.5 2-2 .9-1.9-.6-2 3.4L5 10v2l-1.4 1.3 2 3.4 1.9-.6 2 .9.5 2h4l.5-2 2-.9 1.9.6 2-3.4L19 12v-2l1.4-1.3-2-3.4-1.9.6-2-.9-.5-2Z"/><circle cx="12" cy="11" r="3"/></svg>
            </button>
            <button type="button" class="btn rm-guide-action" :class="{ 'btn-primary': g.value !== 'tts' && runningTab !== g.value }" :disabled="(g.value === 'typewriter' || g.value === 'lyric') && !supported" :title="g.value === 'typewriter' ? t('readingMode.keysHint') : g.value === 'lyric' ? t('readingMode.lyricKeysHint') : undefined" @click="act(g.value)">
              <svg v-if="g.value === 'tts'" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
              <svg v-else-if="runningTab !== g.value || paused" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M7 4v16l13-8Z" /></svg>
              <svg v-else-if="g.value !== 'lyric' || canPause" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M6 4h4v16H6zm8 0h4v16h-4z" /></svg>
              {{ actionLabel(g.value) }}
            </button>
          </div>
          <div v-if="expanded === g.value && g.value !== 'tts'" :id="`guide-settings-${g.value}`" class="rm-guide-settings" :class="{ 'auto-panel': g.value === 'auto', 'tw-panel': g.value === 'typewriter', 'ly-panel': g.value === 'lyric' }">
            <div v-if="g.value === 'auto'" class="rm-row rm-speed-row">
              <span class="rm-label">{{ t('reader.speed') }}</span>
              <LevelSlider :model-value="speedPosition(autoReadSeconds)" :min="1" :max="AUTO_SPEED_STEPS" :step="1" :stops="autoStops" :label="t('reader.speed')" @update:model-value="emit('update:autoReadSeconds', secondsAtPosition($event))" />
              <label class="rm-speed-field">
                <input class="rm-speed-input" type="number" inputmode="decimal" min="3" max="300" step="0.1" :value="autoReadSeconds" :aria-label="t('readingMode.speedExact', { min: 3, max: 300 })" @blur="onAutoSpeedExact" @keydown.enter="($event.target as HTMLInputElement).blur()" />
                <span>{{ t(autoScrolled ? 'readingMode.secondsScreen' : 'readingMode.secondsPage') }}</span>
              </label>
            </div>
            <fieldset v-else class="rm-fields" :disabled="!supported">
              <!-- 打字机: 粒度 -->
              <div v-if="g.value === 'typewriter'" class="rm-row">
                <span class="rm-label">{{ t('readingMode.granularity') }}</span>
                <div class="segmented">
                  <button
                    v-for="u in units"
                    :key="u.value"
                    type="button"
                    :class="{ active: tw.unit === u.value }"
                    :aria-pressed="tw.unit === u.value"
                    @click="settings.readingMode.typewriter.unit = u.value"
                  >
                    {{ t(u.key) }}
                  </button>
                </div>
              </div>

              <!-- 歌词: 推进 / 聚焦 / 其余行 / 位置 / 字号 -->
              <template v-if="g.value === 'lyric'">
                <div class="rm-row">
                  <span class="rm-label">{{ t('readingMode.lyricDriver') }}</span>
                  <div class="segmented">
                    <button
                      v-for="d in drivers"
                      :key="d.value"
                      type="button"
                      :class="{ active: lyricDriver === d.value }"
                      :aria-pressed="lyricDriver === d.value"
                      @click="modes.setLyricDriver(d.value)"
                    >
                      {{ t(d.key) }}
                    </button>
                  </div>
                </div>
                <p v-if="lyricDriver === 'tts'" class="rm-hint rm-indent">{{ t('readingMode.driverTtsHint') }}</p>
                <p v-else-if="lyricDriver === 'manual'" class="rm-hint rm-indent">{{ t('readingMode.driverManualHint') }}</p>
              </template>
              <div v-if="g.value === 'typewriter' || lyricDriver === 'pace'" class="rm-row rm-speed-row">
                <span class="rm-label">{{ t('readingMode.speed') }}</span>
                <LevelSlider :model-value="guidedSpeedPosition" :min="0" :max="100" :step="1" :stops="speedStops" :label="t('readingMode.speed')" @update:model-value="setGuidedSpeed" />
                <label class="rm-speed-field">
                  <input class="rm-speed-input" type="number" inputmode="numeric" :min="modes.speedLimits.value[0]" :max="modes.speedLimits.value[1]" step="10" :value="modes.speed.value" :aria-label="t('readingMode.speedExact', { min: modes.speedLimits.value[0], max: modes.speedLimits.value[1] })" @blur="onSpeedExact" @keydown.enter="($event.target as HTMLInputElement).blur()" />
                  <span>{{ t(modes.speedUnit.value === 'cpm' ? 'readingMode.unitCpm' : 'readingMode.unitWpm') }}</span>
                </label>
              </div>
              <details class="rm-more">
                <summary>{{ t('reader.more') }}</summary>
                <div class="rm-more-body">
                  <template v-if="g.value === 'lyric'">
                <div class="rm-row">
                  <span class="rm-label">{{ t('readingMode.lyricLines') }}</span>
                  <div class="segmented">
                    <button type="button" :class="{ active: ly.lines === 1 }" :aria-pressed="ly.lines === 1" @click="settings.readingMode.lyric.lines = 1">
                      {{ t('readingMode.lines1') }}
                    </button>
                    <button type="button" :class="{ active: ly.lines === 3 }" :aria-pressed="ly.lines === 3" @click="settings.readingMode.lyric.lines = 3">
                      {{ t('readingMode.lines3') }}
                    </button>
                  </div>
                  <input class="rm-number-input rm-lines-input" type="number" inputmode="numeric" min="1" max="99" step="1" :value="ly.lines" :aria-label="t('readingMode.customLines')" @blur="onLyricLines" @keydown.enter="($event.target as HTMLInputElement).blur()" />
                </div>
                <div class="rm-row">
                  <span class="rm-label">{{ t('readingMode.lyricOthers') }}</span>
                  <div class="segmented">
                    <button type="button" :class="{ active: ly.others === 'dim' }" :aria-pressed="ly.others === 'dim'" @click="settings.readingMode.lyric.others = 'dim'">
                      {{ t('readingMode.upcomingGhost') }}
                    </button>
                    <button type="button" :class="{ active: ly.others === 'hide' }" :aria-pressed="ly.others === 'hide'" @click="settings.readingMode.lyric.others = 'hide'">
                      {{ t('readingMode.upcomingHidden') }}
                    </button>
                  </div>
                </div>
                <div class="rm-row">
                  <span class="rm-label">{{ t('readingMode.lyricAnchor') }}</span>
                  <div class="segmented">
                    <button type="button" :class="{ active: ly.anchor === 0.382 }" :aria-pressed="ly.anchor === 0.382" @click="settings.readingMode.lyric.anchor = 0.382">
                      {{ t('readingMode.anchorUpper') }}
                    </button>
                    <button type="button" :class="{ active: ly.anchor === 0.5 }" :aria-pressed="ly.anchor === 0.5" @click="settings.readingMode.lyric.anchor = 0.5">
                      {{ t('readingMode.anchorCenter') }}
                    </button>
                  </div>
                </div>
                <div class="rm-position-row">
                  <label class="rm-position-slider">
                    <span class="sr-only">{{ t('readingMode.positionHeight') }}</span>
                    <input type="range" min="0" max="1" step="any" :value="lyricPosition" :aria-valuetext="String(lyricPosition)" @input="onLyricSlider" @keydown="onLyricSliderKey" />
                    <span class="rm-position-ends"><span>{{ t('readingMode.positionBottom') }}</span><span>{{ t('readingMode.positionTop') }}</span></span>
                  </label>
                  <input class="rm-number-input rm-position-input" type="number" inputmode="decimal" min="0" max="1" step="0.001" :value="lyricPosition" :aria-label="t('readingMode.positionExact')" @blur="onLyricPosition" @keydown.enter="($event.target as HTMLInputElement).blur()" />
                </div>
                <div class="rm-row">
                  <span class="rm-label">{{ t('readingMode.lyricScale') }}</span>
                  <div class="segmented">
                    <button
                      v-for="s in scales"
                      :key="s.value"
                      type="button"
                      :class="{ active: Math.abs(ly.scale - s.value) < 0.01 }"
                      :aria-pressed="Math.abs(ly.scale - s.value) < 0.01"
                      @click="settings.readingMode.lyric.scale = s.value"
                    >
                      {{ s.label() }}
                    </button>
                  </div>
                </div>
                  </template>
              <!-- 打字机: 后文 / 开关 -->
              <template v-if="g.value === 'typewriter'">
                <div class="rm-row">
                  <span class="rm-label">{{ t('readingMode.upcoming') }}</span>
                  <div class="segmented">
                    <button
                      type="button"
                      :class="{ active: tw.upcoming === 'hidden' }"
                      :aria-pressed="tw.upcoming === 'hidden'"
                      @click="settings.readingMode.typewriter.upcoming = 'hidden'"
                    >
                      {{ t('readingMode.upcomingHidden') }}
                    </button>
                    <button
                      type="button"
                      :class="{ active: tw.upcoming === 'ghost' }"
                      :aria-pressed="tw.upcoming === 'ghost'"
                      @click="settings.readingMode.typewriter.upcoming = 'ghost'"
                    >
                      {{ t('readingMode.upcomingGhost') }}
                    </button>
                  </div>
                </div>
              </template>

              <div class="rm-toggles">
                <label class="rm-toggle">
                  <span>{{ t('readingMode.punctuationPause') }}</span>
                  <span class="rm-switch">
                    <input v-model="settings.readingMode.typewriter.punctuationPause" type="checkbox" role="switch" :aria-checked="tw.punctuationPause" />
                    <span class="rm-switch-track" aria-hidden="true"></span>
                  </span>
                </label>
                <template v-if="g.value === 'typewriter'">
                  <label class="rm-toggle">
                    <span>{{ t('readingMode.freshInk') }}</span>
                    <span class="rm-switch">
                      <input v-model="settings.readingMode.typewriter.freshInk" type="checkbox" role="switch" :aria-checked="tw.freshInk" />
                      <span class="rm-switch-track" aria-hidden="true"></span>
                    </span>
                  </label>
                  <label class="rm-toggle">
                    <span>{{ t('readingMode.sound') }}</span>
                    <span class="rm-switch">
                      <input v-model="settings.readingMode.typewriter.sound" type="checkbox" role="switch" :aria-checked="tw.sound" />
                      <span class="rm-switch-track" aria-hidden="true"></span>
                    </span>
                  </label>
                  <!-- 打字声音色 (CC0 录音, 见 docs/ambient-sources.md) + 音量 + 试听 -->
                  <div v-if="tw.sound" class="rm-sound">
                    <div class="rm-sound-presets" role="radiogroup" :aria-label="t('readingMode.soundPreset')">
                      <button
                        v-for="p in TYPING_SOUND_PRESETS"
                        :key="p.id"
                        type="button"
                        role="radio"
                        class="rm-chip"
                        :class="{ on: tw.soundPreset === p.id }"
                        :aria-checked="tw.soundPreset === p.id"
                        @click="settings.readingMode.typewriter.soundPreset = p.id; void previewTypingSound(p.id, tw.soundVolume)"
                      >{{ t(p.nameKey) }}</button>
                    </div>
                    <div class="rm-row">
                      <span class="rm-label">{{ t('readingMode.soundVolume') }}</span>
                      <input
                        v-model.number="settings.readingMode.typewriter.soundVolume"
                        class="rm-sound-volume"
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        :aria-label="t('readingMode.soundVolume')"
                      />
                      <span class="rm-value">{{ Math.round(tw.soundVolume * 100) }}%</span>
                      <button type="button" class="btn btn-sm" @click="void previewTypingSound(tw.soundPreset, tw.soundVolume)">{{ t('readingMode.soundPreview') }}</button>
                    </div>
                  </div>
                </template>
              </div>

              <p class="rm-hint">{{ g.value === 'typewriter' ? t('readingMode.typewriterHint') : t('readingMode.lyricHint') }}</p>
              <p v-if="modes.reducedMotion.value && g.value === 'typewriter'" class="rm-hint">{{ t('readingMode.reducedMotionHint') }}</p>
                </div>
              </details>
            </fieldset>
          </div>
        </div>
      </div>
    </section>

  </section>
</template>

<style scoped>
.rm-position-row { display: flex; align-items: flex-start; gap: 12px; }
.rm-position-slider { flex: 1; min-width: 0; }
.rm-position-slider input { width: 100%; min-height: 44px; }
.rm-position-ends { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-3); }
.rm-position-input { width: 84px; flex: 0 0 84px; }
.rm-lines-input { width: 64px; flex: 0 0 64px; }

.rm-sound {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px 0 6px;
}
.rm-sound-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.rm-sound-volume {
  flex: 1;
  min-width: 0;
  accent-color: var(--brand);
}
.rm-panel {
  position: absolute;
  top: calc(52px + var(--safe-top, 0px));
  right: 12px;
  z-index: 25;
  width: min(400px, calc(100% - 24px));
  max-height: calc(100% - 72px - var(--safe-top, 0px) - var(--safe-bottom, 0px));
  overflow-y: auto;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  color: var(--text);
}
.rm-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.rm-head strong {
  font-size: 15px;
}
.rm-close {
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--radius);
  background: transparent;
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.rm-close:hover {
  background: var(--surface-2);
  color: var(--text);
}
.rm-close:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.rm-progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rm-progress-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.rm-progress-chapter {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
  font-size: 12px;
}
.rm-progress-eta {
  flex-shrink: 0;
  color: var(--text);
  font-size: 15px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.rm-progress-track {
  height: 4px;
  border-radius: var(--radius-pill);
  background: var(--surface-3);
  overflow: hidden;
}
.rm-progress-track span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--brand);
  transform-origin: left center;
  transition: transform 0.4s ease;
}
.rm-progress-sub {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  color: var(--text-3);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.rm-progress-sub span:last-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rm-fields {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0;
  padding: 0;
  border: none;
  min-width: 0;
}
.rm-fields:disabled {
  opacity: 0.5;
}
.rm-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.rm-label {
  flex-shrink: 0;
  width: 64px;
  font-size: 13px;
  color: var(--text-2);
}
.rm-speed-field {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
}
:is(.rm-speed-input, .rm-number-input, .rm-time) {
  box-sizing: border-box;
  width: 72px;
  min-width: 0;
  height: 38px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-2);
  color: var(--text);
  font: inherit;
  font-size: 14px;
  font-weight: 500;
  text-align: center;
  font-variant-numeric: tabular-nums;
  -moz-appearance: textfield;
  transition: border-color var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease);
}
:is(.rm-speed-input, .rm-number-input)::-webkit-outer-spin-button,
:is(.rm-speed-input, .rm-number-input)::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
:is(.rm-speed-input, .rm-number-input, .rm-time):focus {
  outline: none;
  border-color: var(--brand);
  box-shadow: var(--ring);
}
.rm-value {
  flex-shrink: 0;
  min-width: 72px;
  font-size: 12px;
  color: var(--text-3);
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.rm-chip:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.rm-chip {
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.rm-chip:hover {
  color: var(--text);
}
.rm-chip.on {
  border-color: var(--brand);
  background: var(--brand-light);
  color: var(--brand);
}
.rm-toggles {
  display: flex;
  flex-direction: column;
}
.rm-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 40px;
  font-size: 13px;
  color: var(--text);
  cursor: pointer;
}
.rm-toggle + .rm-toggle {
  border-top: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
}
.rm-switch {
  position: relative;
  width: 38px;
  height: 22px;
  flex-shrink: 0;
}
.rm-switch input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
  z-index: 1;
}
.rm-switch-track {
  position: absolute;
  inset: 0;
  border-radius: var(--radius-pill);
  background: var(--border-strong);
  transition: background var(--dur) var(--ease);
}
.rm-switch-track::after {
  content: '';
  position: absolute;
  top: 3px;
  left: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--on-brand);
  box-shadow: var(--shadow-sm);
  transition: transform var(--dur) var(--ease);
}
.rm-switch input:checked + .rm-switch-track {
  background: var(--brand);
}
.rm-switch input:checked + .rm-switch-track::after {
  transform: translateX(16px);
}
.rm-switch input:focus-visible + .rm-switch-track {
  box-shadow: var(--ring);
}
.rm-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-3);
}
@media (max-width: 720px) {
  /* 16px 以下 iOS 聚焦时会放大页面 */
  :is(.rm-speed-input, .rm-number-input, .rm-time) {
    font-size: 16px;
  }
  .rm-panel {
    top: auto;
    left: 0;
    right: 0;
    bottom: 0;
    width: auto;
    max-height: 78%;
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    border-bottom: none;
    padding: 18px max(16px, var(--lr-safe-right, 0px)) calc(16px + var(--safe-bottom, 0px)) max(16px, var(--lr-safe-left, 0px));
    box-shadow: var(--shadow-lg);
    gap: 14px;
    animation: rm-sheet-up var(--dur-slow) var(--ease);
  }
  .rm-panel::before {
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
  .rm-label {
    width: 52px;
  }
  .rm-value {
    min-width: 64px;
  }
  .rm-close {
    width: 44px;
    height: 44px;
  }
  .rm-chip {
    height: 32px;
  }
}
@keyframes rm-sheet-up {
  from {
    transform: translateY(40px);
    opacity: 0;
  }
  to {
    transform: none;
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .rm-panel,
  .rm-switch-track,
  .rm-switch-track::after {
    animation: none;
    transition: none;
  }
}

/* 点睛开关 (插槽) 自带下边线, 与下方分组的上边线重复: 只留一条 */
.rm-panel :slotted(.dj-toggle) {
  border-bottom: none;
}

/* ---- 分组与开关卡片 ---- */
.rm-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.rm-group-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text-3);
}
.rm-cards {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 6px;
}
.rm-card {
  position: relative;
  min-width: 0;
}
.rm-card-main {
  width: 100%;
  min-height: 72px;
  /* 顶部留出角上 ⓘ 的位置 */
  padding: 14px 2px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--card);
  color: var(--text-2);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.rm-card-main:hover {
  border-color: var(--border-strong);
  color: var(--text);
}
.rm-card-main:focus-visible,
.rm-card-info:focus-visible,
.rm-time:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.rm-card.on .rm-card-main {
  border-color: var(--brand);
  background: var(--brand-light);
  color: var(--brand);
}
.rm-card.open .rm-card-main {
  box-shadow: 0 0 0 1px var(--brand) inset;
}
.rm-card-name {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
  color: inherit;
}
.rm-card-state {
  font-size: 11px;
  color: var(--text-3);
}
.rm-card.on .rm-card-state {
  color: var(--brand);
}
.rm-card-info {
  position: absolute;
  top: 1px;
  right: 1px;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-3);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.rm-card-info:hover,
.rm-card.open .rm-card-info {
  color: var(--brand);
}
.rm-detail {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-lg);
  background: var(--surface-2);
}
.rm-detail .rm-toggle + .rm-toggle {
  border-top: none;
}
.rm-changes {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.rm-changes-label {
  margin-right: 2px;
  font-size: 12px;
  color: var(--text-3);
}
.rm-change {
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  background: var(--card);
  border: 1px solid var(--border);
  color: var(--text-2);
  font-size: 12px;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
}
.rm-self-start {
  align-self: flex-start;
}
.rm-tune {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  min-height: 28px;
  padding: 0 2px;
  border: none;
  background: none;
  color: var(--brand);
  font-size: 13px;
  font-weight: 500;
  border-radius: var(--radius-sm);
}
.rm-tune:hover {
  text-decoration: underline;
}
.rm-tune:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.rm-clock {
  flex-wrap: wrap;
  font-size: 13px;
  color: var(--text-2);
}
.rm-time {
  width: 88px;
  flex: 0 0 88px;
  letter-spacing: 0.04em;
}

.rm-indent {
  padding-left: 74px;
}
@media (pointer: coarse) {
  .rm-card-info {
    width: 30px;
    height: 30px;
    top: 0;
    right: 0;
  }
  /* 触屏: 可点区域往卡片外扩 (卡片中部仍归开关) */
  .rm-card-info::before {
    content: '';
    position: absolute;
    inset: -6px -6px 0 0;
  }
  .rm-tune {
    min-height: 44px;
  }
  .rm-panel .segmented button {
    min-height: 40px;
  }
  .rm-chip {
    height: 40px;
  }
  .rm-close {
    width: 44px;
    height: 44px;
  }
  :is(.rm-speed-input, .rm-number-input),
  .rm-time {
    height: 44px;
    font-size: 16px;
  }
  .rm-toggle {
    min-height: 44px;
  }
}
@media (max-width: 720px) {
  .rm-indent {
    padding-left: 62px;
  }
  .rm-card-main {
    min-height: 76px;
  }
}
@media (max-width: 380px) {
  .rm-cards {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (prefers-reduced-motion: reduce) {
  .rm-card-main {
    transition: none;
  }
}

.rm-running {
  padding: 10px 12px;
  border-radius: var(--radius-lg);
  background: var(--brand-light);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rm-running-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rm-running-head strong {
  flex: 1;
  min-width: 0;
  font-size: 13px;
}
.rm-running-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--brand);
  flex-shrink: 0;
}
.rm-guide-title {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.rm-guide-title small {
  font-weight: 400;
  font-size: inherit;
}
.rm-guides {
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow: hidden;
}
.rm-guide + .rm-guide {
  border-top: 1px solid var(--border);
}
.rm-guide-main {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
}
.rm-guide.is-running .rm-guide-main {
  background: var(--brand-light);
}
.rm-guide-text {
  flex: 1;
  min-width: 0;
}
.rm-guide-name {
  font-size: 14px;
  font-weight: 600;
}
.rm-layout-link {
  display: inline-flex;
  align-items: center;
  margin-inline-start: 4px;
  padding: 0;
  border: none;
  background: none;
  color: var(--brand);
  font: inherit;
  text-align: start;
  border-radius: var(--radius-sm);
}
.rm-gear {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border: none;
  border-radius: var(--radius);
  background: none;
  color: var(--text-3);
}
.rm-gear[aria-expanded='true'] {
  background: var(--surface-2);
  color: var(--brand);
}
.rm-guide-action {
  flex-shrink: 0;
}
.rm-guide-settings {
  padding: 4px 12px 12px;
}
.rm-more {
  font-size: 13px;
  color: var(--text-2);
}
.rm-more summary {
  cursor: pointer;
  padding: 4px 0;
}
.rm-more-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 8px;
}
.rm-speed-row {
  gap: 6px;
}
.rm-speed-row .rm-label {
  width: auto;
}
.rm-speed-field {
  flex-shrink: 0;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  max-width: 88px;
  font-size: 12px;
  color: var(--text-2);
}
/* 所有数值/时间框共用实线边框, 数字和单位分层; 范围控件保持足够的触控高度。 */
.rm-position-input { width: 84px; }
.rm-lines-input { width: 64px; }
.rm-panel input[type=range] { accent-color: var(--brand); cursor: pointer; }
.rm-panel input[type=range]:focus-visible { outline: none; border-radius: var(--radius); box-shadow: var(--ring); }
:is(.rm-speed-input, .rm-number-input, .rm-time):disabled { opacity: 0.5; cursor: not-allowed; }
:is(.rm-speed-input, .rm-number-input, .rm-time)::placeholder { color: var(--text-3); font-weight: 400; }
@media (hover: hover) {
  :is(.rm-speed-input, .rm-number-input, .rm-time):hover:not(:disabled):not(:focus) { border-color: var(--border-strong); }
}
@media (max-width: 720px), (pointer: coarse) {
  :is(.rm-speed-input, .rm-number-input, .rm-time) { height: 44px; font-size: 16px; }
  .rm-panel input[type=range], .rm-panel :deep(.ls-range) { min-height: 44px; }
}
@media (prefers-reduced-motion: reduce) {
  :is(.rm-speed-input, .rm-number-input, .rm-time) { transition: none; }
}
.rm-gear:focus-visible, .rm-layout-link:focus-visible, .rm-more summary:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
@media (max-width: 720px), (pointer: coarse) {
  .rm-gear {
    width: 44px;
    height: 44px;
  }
  .rm-guide-action, .rm-running .btn {
    min-width: 44px;
    min-height: 44px;
  }
  .rm-guide-main {
    gap: 6px;
    padding: 10px 8px;
  }
  .rm-layout-link, .rm-more summary {
    min-height: 44px;
  }
}

/* ---- 摸鱼: 与点睛同样的一行 ---- */
.rm-stealth {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}
.rm-stealth-text {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}
.rm-stealth-title {
  font-weight: var(--fw-semibold);
  color: var(--text);
}
.rm-stealth-sub {
  font-size: var(--fs-caption);
  color: var(--text-3);
}
</style>
