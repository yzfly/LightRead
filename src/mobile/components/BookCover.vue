<script setup lang="ts">
import { computed, ref } from 'vue'
const props = defineProps<{ title: string; author?: string; src?: string }>()
const tone = computed(() => [...props.title].reduce((n, c) => n + (c.codePointAt(0) ?? 0), 0) % 6)
/** 解码失败的封面地址: 改显示文字封面, 换了新地址 (修复后) 再试 */
const broken = ref<string>()
const vertical = computed(() => /^[\p{Script=Han}\p{Punctuation}\s]+$/u.test(props.title) && props.title.length <= 18)
</script>
<template>
  <div class="book-art" :class="{ vertical }" :style="{ '--cover-paper': `var(--cover-paper-${tone})`, '--cover-ink': `var(--cover-ink-${tone})` }" aria-hidden="true">
    <img v-if="src && src !== broken" :src="src" alt="" loading="lazy" decoding="async" @error="broken = src" />
    <template v-else>
      <span class="art-title">{{ title }}</span>
      <svg class="art-lines" viewBox="0 0 180 100" fill="none" aria-hidden="true"><path v-for="n in 6" :key="n" :d="`M-20 ${45+n*7} Q30 ${-40+n*7} 80 ${30+n*7} T200 ${20+n*7}`" /></svg>
      <small>{{ author || 'LIGHTREAD' }}</small>
    </template>
  </div>
</template>
<style scoped>
.book-art { position: relative; width: 100%; height: 100%; overflow: clip; background: var(--cover-paper); color: var(--cover-ink); border-radius: 3px 5px 5px 3px; border-inline-start: 3px solid color-mix(in srgb, var(--cover-ink) 12%, transparent); display: flex; flex-direction: column; justify-content: space-between; padding: 12% 10%; }
.book-art:has(img) { padding: 0; border: 0; }
.book-art img { width: 100%; height: 100%; object-fit: cover; }
.art-title { position: relative; z-index: 1; font-family: var(--font-book); font-size: clamp(15px, 4.8vw, 24px); line-height: 1.5; font-weight: 400; overflow: hidden; word-break: keep-all; overflow-wrap: anywhere; text-wrap: pretty; max-height: 76%; }
/* 横排书名按整行截断, 不把最后一行切成半截字 */
.book-art:not(.vertical) .art-title { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; max-height: none; }
.vertical .art-title { writing-mode: vertical-rl; align-self: flex-start; letter-spacing: .08em; }
.art-lines { position: absolute; width: 120%; left: -6%; bottom: 14%; opacity: .2; stroke: currentColor; stroke-width: .7; }
small { position: relative; z-index: 1; font-size: 9px; letter-spacing: .08em; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
</style>
