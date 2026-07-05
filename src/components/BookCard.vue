<script setup lang="ts">
import { computed } from 'vue'
import type { BookMeta } from '../storage'
import { FORMAT_LABELS } from '../services/format'
import { formatReadingTime } from '../composables/useReadingTimer'

const props = defineProps<{
  book: BookMeta
  coverUrl?: string
  /** 管理模式: 点击变为选择 */
  selectable?: boolean
  selected?: boolean
}>()

defineEmits<{
  open: []
  remove: []
  toggleSelect: []
}>()

const progressText = computed(() => {
  const p = props.book.progress
  if (p == null) return null
  return `${Math.round(p * 100)}%`
})

const tooltip = computed(() => {
  const parts = [props.book.title]
  if (props.book.readingSeconds && props.book.readingSeconds >= 60) {
    parts.push(`已读 ${formatReadingTime(props.book.readingSeconds)}`)
  }
  return parts.join('\n')
})

// 无封面时由书名生成稳定的柔和底色
const fallbackHue = computed(() => {
  let hash = 0
  for (const ch of props.book.title) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return Math.abs(hash) % 360
})
</script>

<template>
  <div
    class="book-card"
    :class="{ selected: selectable && selected }"
    :title="tooltip"
    @click="selectable ? $emit('toggleSelect') : $emit('open')"
  >
    <div class="cover">
      <span v-if="selectable" class="select-mark" :class="{ on: selected }">
        <svg v-if="selected" viewBox="0 0 24 24" width="14" height="14"><path fill="#fff" d="M9.55 15.51 5.7 11.66a1 1 0 0 0-1.4 1.42l4.54 4.54a1 1 0 0 0 1.42 0l9.44-9.44a1 1 0 1 0-1.42-1.42l-8.73 8.75z"/></svg>
      </span>
      <img v-if="coverUrl" :src="coverUrl" :alt="book.title" loading="lazy" decoding="async" />
      <div v-else class="cover-fallback" :style="{ background: `hsl(${fallbackHue}, 42%, 88%)`, color: `hsl(${fallbackHue}, 45%, 32%)` }">
        <span>{{ book.title.slice(0, 12) }}</span>
      </div>
      <span class="format">{{ FORMAT_LABELS[book.format] }}</span>
      <span v-if="progressText" class="progress">{{ progressText }}</span>
      <button v-if="!selectable" class="remove" title="从藏书中删除" @click.stop="$emit('remove')">
        <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M9 3h6a1 1 0 0 1 1 1v1h4a1 1 0 1 1 0 2h-1v12a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V7H4a1 1 0 1 1 0-2h4V4a1 1 0 0 1 1-1zm1 6a1 1 0 0 1 2 0v8a1 1 0 1 1-2 0V9zm4 0a1 1 0 0 1 2 0v8a1 1 0 1 1-2 0V9z"/></svg>
      </button>
    </div>
    <div class="title" :title="book.title">{{ book.title }}</div>
    <div class="author">{{ book.author || '佚名' }}</div>
  </div>
</template>

<style scoped>
.book-card {
  cursor: pointer;
  transition: transform 0.15s;
}
.book-card.selected .cover {
  outline: 3px solid var(--brand);
  outline-offset: -1px;
}
.select-mark {
  position: absolute;
  left: 6px;
  bottom: 6px;
  z-index: 2;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid #fff;
  background: rgba(29, 33, 41, 0.35);
  box-shadow: 0 0 0 1px rgba(29, 33, 41, 0.2);
  display: flex;
  align-items: center;
  justify-content: center;
}
.select-mark.on {
  background: var(--brand);
}
.book-card:hover {
  transform: translateY(-2px);
}
.cover {
  position: relative;
  aspect-ratio: 3 / 4.2;
  border-radius: var(--radius);
  overflow: hidden;
  box-shadow: var(--shadow);
  background: var(--card);
}
.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.cover-fallback {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 14px;
  text-align: center;
  font-size: 15px;
  font-weight: 500;
  line-height: 1.5;
}
.format {
  position: absolute;
  left: 6px;
  top: 6px;
  background: rgba(29, 33, 41, 0.65);
  color: #fff;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
}
.progress {
  position: absolute;
  right: 6px;
  bottom: 6px;
  background: rgba(22, 100, 255, 0.85);
  color: #fff;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
}
.remove {
  position: absolute;
  right: 6px;
  top: 6px;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 6px;
  background: rgba(29, 33, 41, 0.55);
  color: #fff;
  display: none;
  align-items: center;
  justify-content: center;
}
.cover:hover .remove {
  display: flex;
}
.remove:hover {
  background: var(--danger);
}
.title {
  margin-top: 8px;
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.author {
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
