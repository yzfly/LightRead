<script setup lang="ts">
/**
 * 听书胶囊: 顶栏里 (variant="bar") 与沉浸阅读时的浮动胶囊 (variant="float") 共用一份。
 * 两处内容、按钮顺序和点击区域完全一致: 状态点 + 文字 + 语速 + 定时 | 回到听书处 | 暂停/继续 | 停止。
 * 触屏上按钮的点击区域放大到 36×40px (圆形底色仍是 28px), 胶囊高度不变; 顶栏放不下时书名让位。
 * 浮动胶囊的拖动由父组件挂在根元素上 (pointer 事件透传), 这里的按钮都阻止 pointerdown 冒泡。
 * 根元素会带上父组件的 scoped 属性: 类名统一加 lc- 前缀, 免得撞上阅读页自己的 .bar / .float 样式。
 */
import { ref } from 'vue'
import { t } from '../i18n'

const props = defineProps<{
  variant: 'bar' | 'float'
  playing: boolean
  /** 状态文字: 缓冲中 / 本章剩余时长 (约 12 分钟) / 听书中 / 已暂停 */
  label: string
  /** 完整说明 (本章还剩约 12 分钟), 作悬停提示与读屏文字 */
  detail?: string
  /** 非 1 倍速时的语速文字 */
  rate?: string
  /** 定时短写 (23:40 / 本章完) */
  sleep?: string
  sleepTitle?: string
  sleepFading?: boolean
  /** 翻到别处时显示「回到听书处」 */
  detached?: boolean
}>()

const emit = defineEmits<{ open: []; toggle: []; back: []; stop: [] }>()

const el = ref<HTMLElement>()
defineExpose({ el })

/** 浮动胶囊整个是拖动柄, 点按 (未拖动) 由父组件打开面板; 顶栏胶囊的主区是普通按钮 */
function onMain() {
  if (props.variant === 'bar') emit('open')
}
</script>

<template>
  <div
    ref="el"
    class="listen-capsule"
    :class="[`lc-${variant}`, { card: variant === 'float' }]"
    :role="variant === 'float' ? 'button' : 'group'"
    :tabindex="variant === 'float' ? 0 : undefined"
    :title="variant === 'float' ? t('tts.miniHint') : undefined"
    :aria-label="variant === 'float' ? t('tts.expandPanel') : t('tts.title')"
    @keydown.enter.self.prevent="emit('open')"
  >
    <component
      :is="variant === 'bar' ? 'button' : 'span'"
      class="lc-main"
      :title="variant === 'bar' ? [detail, t('tts.expandPanel')].filter(Boolean).join(' · ') : detail || undefined"
      @click="onMain"
    >
      <span class="lc-dot" :class="{ paused: !playing }" aria-hidden="true" />
      <span class="lc-label">{{ label }}</span>
      <span v-if="rate" class="lc-rate">{{ rate }}</span>
    </component>
    <!-- 定时: 一眼看到几点停; 点按打开面板更改或取消 -->
    <button
      v-if="sleep"
      class="lc-sleep"
      :class="{ fading: sleepFading }"
      :title="sleepTitle"
      :aria-label="sleepTitle"
      @pointerdown.stop
      @click.stop="emit('open')"
    ><svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0-16zm0 2a6 6 0 1 0 0 12 6 6 0 0 0 0-12zm0 1.5a1 1 0 0 1 1 1v3.09l2.2 1.27a1 1 0 0 1-1 1.73l-2.7-1.56A1 1 0 0 1 11 12V8.5a1 1 0 0 1 1-1z"/></svg>{{ sleep }}</button>
    <button
      v-if="detached"
      class="lc-btn"
      :title="t('tts.backToListening')"
      :aria-label="t('tts.backToListening')"
      @pointerdown.stop
      @click.stop="emit('back')"
    ><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 2a1 1 0 0 1 1 1v1.06A8 8 0 0 1 19.94 11H21a1 1 0 1 1 0 2h-1.06A8 8 0 0 1 13 19.94V21a1 1 0 1 1-2 0v-1.06A8 8 0 0 1 4.06 13H3a1 1 0 1 1 0-2h1.06A8 8 0 0 1 11 4.06V3a1 1 0 0 1 1-1zm0 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12zm0 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"/></svg></button>
    <button
      class="lc-btn"
      :title="playing ? t('common.pause') : t('common.resume')"
      :aria-label="playing ? t('common.pause') : t('common.resume')"
      @pointerdown.stop
      @click.stop="emit('toggle')"
    >
      <svg v-if="playing" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 5a1.5 1.5 0 0 1 1.5 1.5v11a1.5 1.5 0 0 1-3 0v-11A1.5 1.5 0 0 1 8 5zm8 0a1.5 1.5 0 0 1 1.5 1.5v11a1.5 1.5 0 0 1-3 0v-11A1.5 1.5 0 0 1 16 5z"/></svg>
      <svg v-else viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8.5 5.2a1 1 0 0 1 1.02.03l9 5.95a1 1 0 0 1 0 1.66l-9 5.95A1 1 0 0 1 8 17.95V6.05a1 1 0 0 1 .5-.85z"/></svg>
    </button>
    <button
      class="lc-btn"
      :title="t('common.stop')"
      :aria-label="t('common.stop')"
      @pointerdown.stop
      @click.stop="emit('stop')"
    ><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor"/></svg></button>
  </div>
</template>

<style scoped>
.listen-capsule {
  /* 圆形按钮的可见直径与点击区域; 触屏放大点击区域, 见下方 pointer: coarse */
  --lc-dot-size: 28px;
  --lc-hit: 30px;
  --lc-hit-w: 30px;
  --lc-h: 32px;
  display: inline-flex;
  align-items: center;
  gap: 0;
  height: var(--lc-h);
  max-width: 100%;
  padding: 0 1px 0 var(--space-1);
  border-radius: var(--radius-pill);
  white-space: nowrap;
  user-select: none;
  -webkit-user-select: none;
}
.listen-capsule.lc-bar {
  flex-shrink: 0;
  background: var(--brand-soft);
}
.listen-capsule.lc-float {
  box-shadow: var(--shadow-2);
  cursor: grab;
  touch-action: none;
}
.listen-capsule.lc-float:active {
  cursor: grabbing;
}
.listen-capsule:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.lc-main {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: 100%;
  padding: 0 6px 0 var(--space-2);
  border: none;
  border-radius: var(--radius-pill);
  background: none;
  color: var(--text-2);
  font: inherit;
  font-size: var(--fs-caption);
  font-variant-numeric: tabular-nums;
}
.lc-bar .lc-main {
  color: var(--brand);
  cursor: pointer;
}
.lc-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lc-rate {
  font-weight: var(--fw-semibold);
}
.lc-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--brand);
  animation: lc-pulse 1.6s ease-in-out infinite;
}
.lc-dot.paused {
  background: var(--text-3);
  animation: none;
}
@keyframes lc-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.75); }
}
.lc-sleep {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 24px;
  margin-right: 2px;
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-pill);
  background: var(--brand-soft);
  color: var(--brand);
  font: inherit;
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.lc-sleep.fading {
  opacity: 0.55;
  transition: opacity 3s linear;
}
/* 按钮本身是点击区域, 圆形底色画在内容框里: 可见大小一致, 触屏点击区域更大 */
.lc-btn {
  flex-shrink: 0;
  width: var(--lc-hit-w);
  height: var(--lc-hit);
  margin-block: calc((var(--lc-h) - var(--lc-hit)) / 2);
  padding: calc((var(--lc-hit) - var(--lc-dot-size)) / 2) calc((var(--lc-hit-w) - var(--lc-dot-size)) / 2);
  border: none;
  border-radius: 50%;
  background: var(--bg) content-box;
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.lc-bar .lc-btn {
  background-color: var(--card);
}
.lc-btn:hover {
  background-color: var(--brand-light);
  color: var(--brand);
}
.lc-sleep:focus-visible,
.lc-btn:focus-visible,
.lc-main:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
@media (pointer: coarse) {
  .listen-capsule {
    --lc-hit: 40px;
    --lc-hit-w: 36px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .lc-dot {
    animation: none;
  }
}
</style>
