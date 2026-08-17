<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import type { BookMeta } from '../storage'
import { FORMAT_LABELS } from '../services/format'
import { formatReadingTime } from '../composables/useReadingTimer'
import { t } from '../i18n'

const props = defineProps<{
  book: BookMeta
  coverUrl?: string
  /** 管理模式: 点击变为选择 */
  selectable?: boolean
  selected?: boolean
  showBooklists?: boolean
}>()

const emit = defineEmits<{
  open: []
  remove: []
  toggleSelect: []
  togglePin: []
  addToBooklist: []
}>()

const progress = computed(() => {
  const p = props.book.progress
  if (p == null) return null
  return Math.min(100, Math.max(0, Math.round(p * 100)))
})

const tooltip = computed(() => {
  const parts = [props.book.title]
  if (props.book.author) parts.push(props.book.author)
  if (props.book.readingSeconds && props.book.readingSeconds >= 60) {
    parts.push(t('book.readTime', { time: formatReadingTime(props.book.readingSeconds) }))
  }
  return parts.join('\n')
})

const ariaLabel = computed(() => {
  const parts = [props.book.title]
  if (props.book.author) parts.push(props.book.author)
  if (progress.value != null) parts.push(`${progress.value}%`)
  return parts.join(', ')
})

// 无封面时由书名生成稳定的柔和底色
const fallbackHue = computed(() => {
  let hash = 0
  for (const ch of props.book.title) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return Math.abs(hash) % 360
})

function activate() {
  if (props.selectable) emit('toggleSelect')
  else emit('open')
}

/* 触屏设备: 封面操作收进「更多」按钮, 点一下展开, 点别处收起 */
const menuOpen = ref(false)
function closeMenu() {
  menuOpen.value = false
  document.removeEventListener('pointerdown', closeMenu, true)
}
function toggleMenu() {
  if (menuOpen.value) return closeMenu()
  menuOpen.value = true
  setTimeout(() => document.addEventListener('pointerdown', closeMenu, true))
}
onBeforeUnmount(() => document.removeEventListener('pointerdown', closeMenu, true))

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    activate()
  }
}
</script>

<template>
  <div
    class="book-card"
    :class="{ selected: selectable && selected, selectable }"
    :title="tooltip"
    :role="selectable ? 'checkbox' : 'button'"
    :aria-checked="selectable ? selected : undefined"
    :aria-label="ariaLabel"
    tabindex="0"
    @click="activate"
    @keydown="onKeydown"
  >
    <div class="cover">
      <span v-if="selectable" class="select-mark" :class="{ on: selected }" aria-hidden="true">
        <svg v-if="selected" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M9.55 15.51 5.7 11.66a1 1 0 0 0-1.4 1.42l4.54 4.54a1 1 0 0 0 1.42 0l9.44-9.44a1 1 0 1 0-1.42-1.42l-8.73 8.75z"/></svg>
      </span>
      <img v-if="coverUrl" :src="coverUrl" alt="" loading="lazy" decoding="async" />
      <div
        v-else
        class="cover-fallback"
        :style="{
          '--h': fallbackHue,
        }"
        aria-hidden="true"
      >
        <span class="cover-fallback-title">{{ book.title }}</span>
        <span v-if="book.author" class="cover-fallback-author">{{ book.author }}</span>
      </div>
      <span class="format" aria-hidden="true">{{ FORMAT_LABELS[book.format] }}</span>
      <span v-if="progress != null" class="progress" aria-hidden="true">{{ progress }}%</span>
      <span v-if="progress != null" class="progress-track" aria-hidden="true">
        <span class="progress-fill" :style="{ width: `${progress}%` }" />
      </span>

      <div v-if="!selectable" class="actions" :class="{ open: menuOpen }">
        <button
          type="button"
          class="action more"
          :title="t('common.moreActions')"
          :aria-label="t('common.moreActions')"
          :aria-expanded="menuOpen"
          @click.stop="toggleMenu"
          @keydown.stop
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 8a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm0 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm0 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/></svg>
        </button>
        <button
          type="button"
          class="action pin"
          :class="{ pinned: !!book.pinnedAt }"
          :title="book.pinnedAt ? t('library.unpin') : t('library.pin')"
          :aria-label="book.pinnedAt ? t('library.unpin') : t('library.pin')"
          :aria-pressed="!!book.pinnedAt"
          @click.stop="$emit('togglePin')"
          @keydown.stop
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M14.6 2.6a2 2 0 0 1 2.83 0l4 4a2 2 0 0 1 0 2.82l-3.18 3.18.35 2.47a2 2 0 0 1-.56 1.7l-1.1 1.1a1 1 0 0 1-1.42 0L11.6 13.9l-5.9 5.9a1 1 0 0 1-1.4-1.42l5.88-5.89-3.95-3.95a1 1 0 0 1 0-1.41l1.1-1.1a2 2 0 0 1 1.7-.57l2.47.35 3.1-3.2z"/></svg>
        </button>
        <button
          v-if="showBooklists"
          type="button"
          class="action booklist-action"
          :title="t('library.addToBooklist')"
          :aria-label="t('library.addToBooklist')"
          @click.stop="$emit('addToBooklist')"
          @keydown.stop
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M5 4a2 2 0 0 1 2-2h9a3 3 0 0 1 3 3v6a1 1 0 1 1-2 0V5a1 1 0 0 0-1-1H7v14.38l4.55-2.28a1 1 0 0 1 .9 0l1.1.55a1 1 0 1 1-.9 1.79L12 18.12 6.45 20.9A1 1 0 0 1 5 20V4zm14 10a1 1 0 0 1 1 1v2h2a1 1 0 1 1 0 2h-2v2a1 1 0 1 1-2 0v-2h-2a1 1 0 1 1 0-2h2v-2a1 1 0 0 1 1-1z"/></svg>
        </button>
        <button
          type="button"
          class="action remove"
          :title="t('book.removeFromLibrary')"
          :aria-label="t('book.removeFromLibrary')"
          @click.stop="$emit('remove')"
          @keydown.stop
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9 3h6a1 1 0 0 1 1 1v1h4a1 1 0 1 1 0 2h-1v12a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V7H4a1 1 0 1 1 0-2h4V4a1 1 0 0 1 1-1zm1 6a1 1 0 0 1 2 0v8a1 1 0 1 1-2 0V9zm4 0a1 1 0 0 1 2 0v8a1 1 0 1 1-2 0V9z"/></svg>
        </button>
      </div>
    </div>
    <div class="title">{{ book.title }}</div>
    <div class="author">{{ book.author || t('common.anonymous') }}</div>
  </div>
</template>

<style scoped>
.book-card {
  cursor: pointer;
  border-radius: var(--radius);
  outline: none;
  transition: transform var(--dur) var(--ease);
}
.book-card:hover {
  transform: translateY(-2px);
}
.book-card:hover .cover {
  box-shadow: var(--shadow-md);
}
.book-card:focus-visible .cover {
  box-shadow: var(--ring), var(--shadow-md);
}
.book-card.selected .cover {
  outline: 3px solid var(--brand);
  outline-offset: -1px;
}
.cover {
  position: relative;
  aspect-ratio: 3 / 4.2;
  border-radius: var(--radius);
  overflow: hidden;
  box-shadow: var(--shadow);
  background: var(--surface-2);
  transition: box-shadow var(--dur) var(--ease);
}
.cover::after {
  /* 书页内阴影, 让纯色封面有一点厚度 */
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  border-radius: inherit;
  box-shadow:
    inset 0 0 0 1px rgba(0, 0, 0, 0.06),
    inset 3px 0 6px -3px rgba(0, 0, 0, 0.18);
}
.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.cover-fallback {
  --h: 210;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  padding: 16px 12px 14px 16px;
  text-align: left;
  color: hsl(var(--h) 40% 24%);
  background:
    linear-gradient(160deg, hsl(var(--h) 55% 92%) 0%, hsl(var(--h) 45% 82%) 100%);
  border-left: 5px solid hsl(var(--h) 45% 62%);
}
:root[data-theme='dark'] .cover-fallback {
  color: hsl(var(--h) 60% 88%);
  background: linear-gradient(160deg, hsl(var(--h) 26% 30%) 0%, hsl(var(--h) 24% 20%) 100%);
  border-left-color: hsl(var(--h) 40% 50%);
}
.cover-fallback-title {
  font-size: 14px;
  font-weight: 650;
  line-height: 1.35;
  letter-spacing: 0.01em;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.cover-fallback-author {
  font-size: 11px;
  opacity: 0.75;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
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
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
}
.select-mark.on {
  background: var(--brand);
}
.format {
  position: absolute;
  left: 6px;
  top: 6px;
  background: rgba(17, 20, 26, 0.6);
  -webkit-backdrop-filter: blur(4px);
  backdrop-filter: blur(4px);
  color: #fff;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 2px 6px;
  border-radius: 4px;
  line-height: 1.4;
}
.progress {
  position: absolute;
  right: 6px;
  bottom: 8px;
  background: rgba(17, 20, 26, 0.6);
  -webkit-backdrop-filter: blur(4px);
  backdrop-filter: blur(4px);
  color: #fff;
  font-size: 10.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  padding: 2px 6px;
  border-radius: 4px;
  line-height: 1.4;
}
.progress-track {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: rgba(17, 20, 26, 0.25);
}
.progress-fill {
  display: block;
  height: 100%;
  background: var(--brand);
  transition: width var(--dur-slow) var(--ease);
}

/* 封面上的操作: 桌面悬停 / 键盘聚焦时显示; 触屏设备常显; 已置顶徽标常显 */
.actions {
  position: absolute;
  right: 6px;
  top: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.action {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 7px;
  background: rgba(17, 20, 26, 0.6);
  -webkit-backdrop-filter: blur(4px);
  backdrop-filter: blur(4px);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transform: translateY(-2px);
  transition:
    opacity var(--dur-fast) var(--ease),
    transform var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease);
}
.action.pinned {
  opacity: 1;
  transform: none;
}
.action:hover {
  background: rgba(17, 20, 26, 0.85);
}
.action:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 1px;
}
.pin.pinned,
.pin:hover,
.booklist-action:hover {
  background: var(--brand);
}
.remove:hover {
  background: var(--danger);
}
/* 「更多」按钮仅触屏设备可见 */
.action.more {
  display: none;
}
/* 有悬停能力的设备: 悬停 / 键盘聚焦时展开全部操作 */
@media (hover: hover) {
  .book-card:hover .action,
  .book-card:focus-within .action {
    opacity: 1;
    transform: none;
  }
}
/* 触屏设备: 点「更多」展开 */
@media (hover: none) {
  .action {
    width: 32px;
    height: 32px;
  }
  .action.more {
    display: flex;
    opacity: 1;
    transform: none;
  }
  .actions.open .action {
    opacity: 1;
    transform: none;
  }
  .actions.open .action.more {
    background: var(--brand);
  }
  .actions:not(.open) .action:not(.more):not(.pinned) {
    pointer-events: none;
  }
}

.title {
  margin-top: 8px;
  font-size: 13px;
  font-weight: 550;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.author {
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (prefers-reduced-motion: reduce) {
  .book-card,
  .book-card:hover {
    transform: none;
  }
}
</style>
