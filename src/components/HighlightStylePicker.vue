<script setup lang="ts">
/** 划线风格: 色块 / 下划线 / 波浪线 (issue #21)。桌面与 App 的划线工具条共用 */
import { HIGHLIGHT_STYLES, normalizeHighlightStyle, type HighlightStyle } from '../services/highlightStyle'
import { t } from '../i18n'

/** large: 手机工具条用, 按钮 40px 便于点按 */
const props = defineProps<{ modelValue: unknown; large?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [style: HighlightStyle] }>()
</script>

<template>
  <div class="hl-styles" :class="{ large: props.large }" role="group" :aria-label="t('reader.highlightStyle')">
    <button
      v-for="s in HIGHLIGHT_STYLES"
      :key="s"
      type="button"
      class="hl-style"
      :class="{ on: normalizeHighlightStyle(props.modelValue) === s }"
      :aria-pressed="normalizeHighlightStyle(props.modelValue) === s"
      :title="t(`reader.highlightStyle.${s}`)"
      :aria-label="t(`reader.highlightStyle.${s}`)"
      @click="emit('update:modelValue', s)"
    >
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect v-if="s === 'highlight'" x="3" y="4" width="18" height="15" rx="2" fill="currentColor" stroke="none" opacity=".25" />
        <path d="M7.5 16 12 5l4.5 11M9.2 12h5.6" />
        <path v-if="s === 'underline'" d="M5 20h14" />
        <path v-if="s === 'squiggly'" d="M4 20.5c1.3-1.6 2.7-1.6 4 0s2.7 1.6 4 0 2.7-1.6 4 0 2.7 1.6 4 0" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.hl-styles {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius-pill);
  background: var(--surface-2);
}
.hl-style {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 28px;
  border: 0;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
}
.large .hl-style {
  width: 40px;
  height: 40px;
}
.hl-style.on {
  background: var(--card);
  color: var(--text);
  box-shadow: var(--shadow-1);
}
@media (hover: hover) {
  .hl-style:not(.on):hover { color: var(--text); }
}
</style>
