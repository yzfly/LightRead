<script setup lang="ts">
/**
 * 摸鱼模式的顶部细条 (两个桌面阅读页共用): 窗口没有标题栏, 拖这里移动窗口;
 * 悬停时露出快捷键提示、背景 / 文字浓淡滑块与退出按钮。固定在窗口顶部, 不依赖阅读页的布局。
 * 第一次进入时另显示一张说明卡: 老板键 (藏起 / 恢复)、Esc (回到正常阅读)、细条与找回窗口的办法。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { t } from '../i18n'
import { useSettings } from '../stores/settings'
import { bossKeyLabel, STEALTH_BG_MIN, STEALTH_TEXT_MIN } from '../services/stealth'

const props = defineProps<{
  /** 显示首次说明卡 */
  intro?: boolean
  /** 老板键本次注册成功 */
  bossKeyOk?: boolean
}>()
const emit = defineEmits<{ exit: []; dismissIntro: [] }>()
const settings = useSettings()
/** 调完浓淡移开鼠标: 把键盘还给正文, 免得接着按 PageDown 改的是滑块 */
function releaseFocus(e: MouseEvent) {
  const el = document.activeElement as HTMLElement | null
  if (el && (e.currentTarget as HTMLElement).contains(el)) el.blur()
}
/** 用鼠标拖完滑块就把焦点还给正文, 否则接着按 PageDown / 空格会去改滑块而不是翻页 (键盘 Tab 进来的保留焦点) */
function blurAfterPointer(e: PointerEvent) {
  ;(e.currentTarget as HTMLElement).blur()
}
/** 每次进入先把细条展开约 3 秒 (提示老板键 / Esc), 再收成一条线; 不再弹白色提示框挡正文 (R3 pro: 反复进出很显眼) */
const peek = ref(true)
let peekTimer = 0
onMounted(() => { peekTimer = window.setTimeout(() => (peek.value = false), 3000) })
onBeforeUnmount(() => clearTimeout(peekTimer))
const pct = (v: number) => `${Math.round(v * 100)}%`
const keyLabel = computed(() => (props.bossKeyOk && settings.stealth.bossKey ? bossKeyLabel(settings.stealth.bossKey) : ''))
</script>

<template>
  <div class="stealth-strip" :class="{ peek: peek && !intro }" data-tauri-drag-region :title="t('stealth.dragHint')" @mouseleave="releaseFocus">
    <span class="stealth-hint" data-tauri-drag-region>
      {{ keyLabel ? t('stealth.stripHint', { key: keyLabel }) : t('stealth.stripHintNoKey') }}
    </span>
    <label class="stealth-range" :title="`${t('stealth.bgOpacity')} ${pct(settings.stealth.bgOpacity)}`">
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v12h14V6H5zm2 2h4v4H7V8zm6 4h4v4h-4v-4z"/></svg>
      <input
        v-model.number="settings.stealth.bgOpacity"
        type="range"
        @pointerup="blurAfterPointer"
        :min="STEALTH_BG_MIN"
        max="1"
        step="0.05"
        :aria-label="t('stealth.bgOpacity')"
      />
    </label>
    <label class="stealth-range" :title="`${t('stealth.textOpacity')} ${pct(settings.stealth.textOpacity)}`">
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M10.6 4h2.8l5.5 15h-2.4l-1.4-4H8.9l-1.4 4H5.1l5.5-15zm-1 9h4.8L12 6.2 9.6 13z"/></svg>
      <input
        v-model.number="settings.stealth.textOpacity"
        type="range"
        @pointerup="blurAfterPointer"
        :min="STEALTH_TEXT_MIN"
        max="1"
        step="0.05"
        :aria-label="t('stealth.textOpacity')"
      />
    </label>
    <button class="stealth-exit" :title="t('stealth.exitHint')" :aria-label="t('stealth.exit')" @click="emit('exit')">
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M6.7 5.3a1 1 0 0 0-1.4 1.4L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3a1 1 0 0 0 1.4-1.42L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3z"/></svg>
    </button>
  </div>

  <div v-if="intro" class="stealth-intro" role="dialog" :aria-label="t('stealth.introTitle')">
    <div class="si-title">{{ t('stealth.introTitle') }}</div>
    <ul class="si-list">
      <li v-if="keyLabel"><kbd>{{ keyLabel }}</kbd><span>{{ t('stealth.introBossKey') }}</span></li>
      <li v-else><kbd>—</kbd><span>{{ t('stealth.introNoBossKey') }}</span></li>
      <li><kbd>Esc</kbd><span>{{ t('stealth.introEsc') }}</span></li>
      <li><kbd>↕</kbd><span>{{ t('stealth.introStrip') }}</span></li>
    </ul>
    <div class="si-foot">{{ t('stealth.introRecover') }}</div>
    <button type="button" class="btn btn-primary si-ok" @click="emit('dismissIntro')">{{ t('stealth.introOk') }}</button>
  </div>
</template>

<style scoped>
.stealth-strip {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 60;
  height: 10px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-3);
  padding: 0 var(--space-2);
  color: var(--text-2);
  cursor: move;
  transition: height var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease);
}
.stealth-strip.peek,
.stealth-strip:hover,
.stealth-strip:focus-within {
  height: 30px;
  background: color-mix(in srgb, var(--card) 80%, transparent);
}
.stealth-strip > * {
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease);
}
.stealth-strip.peek > *,
.stealth-strip:hover > *,
.stealth-strip:focus-within > * {
  opacity: 1;
}
.stealth-hint {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: var(--fs-caption);
  white-space: nowrap;
  text-overflow: ellipsis;
}
.stealth-range {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  cursor: default;
}
.stealth-range input {
  width: 80px;
  cursor: pointer;
}
.stealth-exit {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--radius-pill);
  background: none;
  color: var(--text-2);
  cursor: pointer;
}
.stealth-exit:hover {
  background: var(--brand-light);
  color: var(--brand);
}

.stealth-intro {
  position: fixed;
  top: 50%;
  left: 50%;
  z-index: 61;
  width: min(360px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
  overflow: auto;
  transform: translate(-50%, -50%);
  padding: var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--card);
  color: var(--text);
  box-shadow: var(--shadow-3);
}
.si-title {
  margin-bottom: var(--space-3);
  font-size: var(--fs-subtitle);
  font-weight: var(--fw-semibold);
}
.si-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: var(--fs-small);
}
.si-list li {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}
.si-list kbd {
  flex-shrink: 0;
  min-width: 2.5em;
  padding: 0 var(--space-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
  background: var(--surface-2);
  font-family: inherit;
  font-size: var(--fs-caption);
  text-align: center;
}
.si-foot {
  margin-top: var(--space-3);
  color: var(--text-2);
  font-size: var(--fs-caption);
}
.si-ok {
  width: 100%;
  margin-top: var(--space-3);
}
</style>
