<script setup lang="ts">
/**
 * 速读视图 (§4.9): 全屏面板, 按章列出要义与要句 (按密度过滤); 点任意一句回到原文并闪 1 秒。
 * 打开时正文里的要句加朱色底 (engine.setBand); 固定显示「适合预览和复习，不能代替细读」。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { t } from '../i18n'
import type { Dianjing } from '../composables/useDianjing'
import type { DjPosition } from '../services/dianjing/engine'

const props = defineProps<{ dj: Dianjing }>()
const emit = defineEmits<{ close: [] }>()
const data = computed(() => props.dj.outline.value)
const loading = computed(() => props.dj.outlineLoading.value)
const root = ref<HTMLElement | null>(null)

function close() {
  props.dj.closeSkim()
  emit('close')
}
function go(pos: DjPosition) {
  close()
  void props.dj.goTo(pos)
}
const title = (s: { title: string; section: number }) => s.title || t('dianjing.untitledSection', { n: s.section + 1 })
const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
onMounted(() => {
  root.value?.focus()
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div ref="root" class="dj-skim" role="dialog" aria-modal="true" :aria-label="t('dianjing.skimTitle')" tabindex="-1">
    <header class="dj-skim-head">
      <div class="dj-skim-title">
        <h2>{{ t('dianjing.skimTitle') }}</h2>
        <p class="dj-skim-disclaimer">{{ t('dianjing.skimDisclaimer') }}</p>
      </div>
      <button type="button" class="btn btn-ghost btn-icon" :aria-label="t('dianjing.close')" :title="t('dianjing.close')" @click="close">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
      </button>
    </header>
    <div class="dj-skim-body">
      <p v-if="data?.spoilerSafe" class="dj-skim-hint">{{ t('dianjing.outlineSpoiler') }}</p>
      <p v-if="loading && !data" class="dj-skim-empty">{{ t('dianjing.loading') }}</p>
      <p v-else-if="!data?.sections.length" class="dj-skim-empty">{{ t('dianjing.skimEmpty') }}</p>
      <article v-for="s in data?.sections ?? []" :key="s.section" class="dj-skim-sec" :class="{ current: s.current }">
        <h3>{{ title(s) }}</h3>
        <p v-if="s.summary" class="dj-skim-summary">{{ s.summary }}</p>
        <ol class="dj-skim-keys">
          <li v-for="(k, i) in s.keys" :key="i">
            <button type="button" class="dj-skim-key" @click="go(k.pos)">
              <span class="dj-skim-text">{{ k.text }}</span>
              <span v-if="k.why" class="dj-skim-why">{{ k.why }}</span>
            </button>
          </li>
        </ol>
      </article>
      <p class="dj-skim-source">{{ t('dianjing.aiSource') }}</p>
    </div>
  </div>
</template>

<style scoped>
.dj-skim {
  position: fixed;
  inset: 0;
  z-index: 70;
  background: var(--bg);
  color: var(--text);
  display: flex;
  flex-direction: column;
  padding-top: var(--lr-safe-top);
  outline: none;
}
.dj-skim-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-4) var(--space-3);
  border-bottom: 1px solid var(--border);
  background: var(--card);
}
.dj-skim-title h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}
.dj-skim-disclaimer {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--text-2);
}
.dj-skim-body {
  flex: 1;
  overflow: auto;
  padding: var(--space-4) var(--space-4) calc(var(--space-8) + var(--lr-safe-bottom));
  max-width: 760px;
  width: 100%;
  margin: 0 auto;
  overscroll-behavior: contain;
}
.dj-skim-hint,
.dj-skim-empty {
  font-size: 13px;
  color: var(--text-3);
}
.dj-skim-sec {
  padding: var(--space-4) 0;
  border-bottom: 1px solid var(--border);
}
.dj-skim-sec.current h3 {
  color: var(--brand);
}
.dj-skim-sec h3 {
  margin: 0 0 var(--space-2);
  font-size: 16px;
  font-weight: 600;
}
.dj-skim-summary {
  margin: 0 0 var(--space-3);
  line-height: 1.7;
  color: var(--text-2);
}
.dj-skim-keys {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.dj-skim-key {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  text-align: left;
  border: 1px solid var(--border);
  background: var(--card);
  border-radius: var(--radius);
  padding: var(--space-2) var(--space-3);
  font: inherit;
  color: var(--text);
  cursor: pointer;
}
.dj-skim-key:hover {
  background: var(--surface-2);
}
.dj-skim-key:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.dj-skim-text {
  line-height: 1.7;
}
.dj-skim-why {
  font-size: 12px;
  color: var(--text-3);
}
.dj-skim-source {
  margin-top: var(--space-4);
  font-size: 12px;
  color: var(--text-3);
}
</style>
