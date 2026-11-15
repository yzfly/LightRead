<script setup lang="ts">
/**
 * 摸鱼模式的颜色选择 (设置页与顶部细条共用): 色块 (系统取色框) + 屏幕取色 + 恢复跟随正文。
 * 值为 #rrggbb, 空串表示跟随正文主题; 屏幕取色只在 Chromium 内核 (Windows 的 WebView2) 上提供。
 */
import { computed } from 'vue'
import { t } from '../i18n'
import { eyeDropperSupported, pickScreenColor, stealthColor } from '../services/stealth'

const props = defineProps<{
  modelValue: string
  /** 跟随正文时色块显示的颜色 */
  fallback: string
  label: string
  /** 细条里用: 只留色块与取色, 恢复按钮收进色块的右键 */
  compact?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const value = computed(() => stealthColor(props.modelValue))
const shown = computed(() => value.value || stealthColor(props.fallback) || '#ffffff')
const dropper = eyeDropperSupported()

function onInput(e: Event) {
  emit('update:modelValue', stealthColor((e.target as HTMLInputElement).value))
}
async function pick() {
  const c = await pickScreenColor()
  if (c) emit('update:modelValue', c)
}
function reset() {
  emit('update:modelValue', '')
}
</script>

<template>
  <span class="scp" :class="{ compact }">
    <label class="scp-swatch" :title="compact ? `${label} · ${t('stealth.colorResetHint')}` : label" @contextmenu.prevent="compact && reset()">
      <input type="color" :value="shown" :aria-label="label" @input="onInput" />
      <span class="scp-chip" :style="{ background: shown }" aria-hidden="true" />
    </label>
    <button
      v-if="dropper"
      type="button"
      class="scp-btn"
      :title="t('stealth.pickFromScreen')"
      :aria-label="`${label}: ${t('stealth.pickFromScreen')}`"
      @click="pick"
    >
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M19.35 3.65a2.2 2.2 0 0 0-3.1 0l-2.6 2.6-1.4-1.4-1.42 1.41 1.42 1.42-7.6 7.6A2 2 0 0 0 4 16.7V20h3.3a2 2 0 0 0 1.42-.59l7.6-7.6 1.42 1.42 1.41-1.42-1.41-1.41 2.6-2.6a2.2 2.2 0 0 0 0-3.1zM7.3 18H6v-1.3l7.6-7.6 1.3 1.3L7.3 18z"/></svg>
    </button>
    <button v-if="!compact && value" type="button" class="btn btn-sm" @click="reset">{{ t('stealth.colorFollow') }}</button>
    <span v-else-if="!compact" class="scp-follow">{{ t('stealth.colorFollowing') }}</span>
  </span>
</template>

<style scoped>
.scp {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}
.scp-swatch {
  position: relative;
  display: inline-flex;
  cursor: pointer;
}
.scp-swatch input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
  width: 100%;
  height: 100%;
  padding: 0;
  border: 0;
}
.scp-chip {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
}
.compact .scp-chip {
  width: 16px;
  height: 16px;
  border-radius: var(--radius-xs);
}
.scp-swatch:focus-within .scp-chip {
  outline: 2px solid var(--brand);
  outline-offset: 1px;
}
.scp-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--card);
  color: var(--text-2);
  cursor: pointer;
}
.compact .scp-btn {
  width: 20px;
  height: 20px;
  border: 0;
  background: none;
  color: inherit;
}
.scp-btn:hover {
  color: var(--text);
}
.scp-follow {
  color: var(--text-3);
  font-size: var(--fs-small);
}
</style>
