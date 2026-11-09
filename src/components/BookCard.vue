<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import type { BookMeta } from '../storage'
import { formatLabelOf } from '../services/plainText'
import { formatReadingTime } from '../composables/useReadingTimer'
import { shortAuthor, shortTitle } from '../services/displayTitle'
import { t } from '../i18n'

const props = defineProps<{
  book: BookMeta
  coverUrl?: string
  /** 管理模式: 点击变为选择 */
  selectable?: boolean
  selected?: boolean
  showBooklists?: boolean
  /** 可转换为 EPUB (MOBI / AZW3 / FB2 / TXT 等) */
  convertible?: boolean
  /** 正在转换: 按钮禁用 */
  converting?: boolean
  /** 显示「发送到其他设备」(设置里开启了互传) */
  sendable?: boolean
  /** 手机书格: 封面只留进度条, 操作收进作者行的「⋯」(由父组件弹出操作面板) */
  compact?: boolean
}>()

/** 解码失败的封面地址: 改显示文字封面, 换了新地址 (修复后) 再试 */
const brokenCover = ref<string>()

/** 封面占位标题的断行点: 文件名式标题 (package.json / my_notes-v2) 在 . _ - / 之后换行, 不在词中间硬断 */
const coverTitleParts = computed(() => props.book.title.replace(/([._\-/])/g, '$1\u0000').split('\u0000'))

const emit = defineEmits<{
  open: []
  remove: []
  toggleSelect: []
  togglePin: []
  addToBooklist: []
  upload: []
  convert: []
  /** 发送到其他设备 (互传) */
  send: []
  /** compact: 点「⋯」 */
  menu: []
  /** 移到论文 / 藏书 */
  moveKind: []
  /** 设为 / 取消私密 */
  togglePrivate: []
  /** compact: 长按封面 */
  longPress: []
}>()

const progress = computed(() => {
  const p = props.book.progress
  if (p == null) return null
  return Math.min(100, Math.max(0, Math.round(p * 100)))
})

const tooltip = computed(() => {
  const parts = [props.book.title]
  if (props.book.author) parts.push(props.book.author)
  if (props.book.noSync) parts.push(t('library.privateBadge'))
  if (props.book.readingSeconds && props.book.readingSeconds >= 60) {
    parts.push(t('book.readTime', { time: formatReadingTime(props.book.readingSeconds) }))
  }
  return parts.join('\n')
})

const ariaLabel = computed(() => {
  const parts = [props.book.title]
  if (props.book.author) parts.push(props.book.author)
  if (progress.value != null) parts.push(`${progress.value}%`)
  if (props.book.noSync) parts.push(t('library.privateBadge'))
  return parts.join(', ')
})

// 无封面时由书名稳定地取一组纸色 + 墨色令牌 (与 App 的生成封面一致)
const titleHash = computed(() => {
  let hash = 0
  for (const ch of props.book.title) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return Math.abs(hash)
})
const fallbackTone = computed(() => titleHash.value % 6)

/* 书名 / 元信息: 短书名 (完整书名在悬停提示); 「12% · 作者」, 读完显示「读完」, 未读不显示进度。
   compact 无作者时写「佚名」(已确认的手机原型); 桌面省掉, 两项都空时写「未读」 */
const displayTitle = computed(() => shortTitle(props.book.title))
const metaProgress = computed(() => {
  const p = progress.value
  if (p == null || p <= 0) return ''
  return p >= 99 ? t('library.finished') : `${p}%`
})
const metaAuthor = computed(() => shortAuthor(props.book.author) || (props.compact ? t('common.anonymous') : ''))

function activate() {
  if (props.selectable) emit('toggleSelect')
  else emit('open')
}

/* 桌面: 书名下方的「⋯」展开操作菜单, 点别处 / Esc 收起 (compact 交给父组件的底部面板) */
const menuOpen = ref(false)
const actionsEl = ref<HTMLElement | null>(null)
const moreEl = ref<HTMLElement | null>(null)
function closeMenu() {
  menuOpen.value = false
  document.removeEventListener('pointerdown', onOutsidePointerDown, true)
}
function onOutsidePointerDown(e: PointerEvent) {
  // 按下点在菜单内部时不能收起: 收起会让按钮瞬间 pointer-events:none,
  // 随后的 click 命中测试会落到卡片上, 变成打开书籍 (触屏专属问题)
  if (e.target instanceof Node && (actionsEl.value?.contains(e.target) || moreEl.value?.contains(e.target))) return
  closeMenu()
}
function toggleMenu() {
  if (menuOpen.value) return closeMenu()
  openMenu()
}
function openMenu() {
  if (menuOpen.value) return
  menuOpen.value = true
  setTimeout(() => document.addEventListener('pointerdown', onOutsidePointerDown, true))
  // 靠近窗口下沿的书: 菜单会伸出可视区, 把页面滚到整个菜单可见
  void nextTick(() => actionsEl.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
}
type MenuEvent = 'remove' | 'togglePin' | 'addToBooklist' | 'upload' | 'convert' | 'send' | 'moveKind' | 'togglePrivate'
function menuAction(event: MenuEvent) {
  closeMenu()
  ;(emit as unknown as (e: MenuEvent) => void)(event)
}
function onMore() {
  if (props.compact) emit('menu')
  else toggleMenu()
}
/* 右键 / 触屏长按封面: 与点「⋯」一样展开操作 (系统菜单只有图片另存为之类, 拦掉) */
function onContextMenu(e: Event) {
  if (props.compact) {
    // 手机书格: 长按进入选择并选中这本 (选择模式下由点击切换)
    e.preventDefault()
    if (!props.selectable) emit('longPress')
    return
  }
  // 桌面右键 / 触屏长按: 都展开书卡自己的操作菜单, 不出 WebView 的「图像另存为 / 复制图像」
  e.preventDefault()
  if (!props.selectable) openMenu()
}
onBeforeUnmount(() => document.removeEventListener('pointerdown', onOutsidePointerDown, true))

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
    :class="{ selected: selectable && selected, selectable, compact, 'menu-open': menuOpen }"
    :title="tooltip"
    :role="selectable ? 'checkbox' : 'button'"
    :aria-checked="selectable ? selected : undefined"
    :aria-label="ariaLabel"
    tabindex="0"
    @click="activate"
    @keydown="onKeydown"
    @contextmenu="onContextMenu"
  >
    <div class="cover">
      <span v-if="selectable" class="select-mark" :class="{ on: selected }" aria-hidden="true">
        <svg v-if="selected" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M9.55 15.51 5.7 11.66a1 1 0 0 0-1.4 1.42l4.54 4.54a1 1 0 0 0 1.42 0l9.44-9.44a1 1 0 1 0-1.42-1.42l-8.73 8.75z"/></svg>
      </span>
      <img v-if="coverUrl && coverUrl !== brokenCover" :src="coverUrl" alt="" loading="lazy" decoding="async" @error="brokenCover = coverUrl" />
      <div
        v-else
        class="cover-fallback"
        :class="`tone-${fallbackTone}`"
        aria-hidden="true"
      >
        <span class="cover-fallback-title"><template v-if="compact">{{ displayTitle }}</template><template v-else v-for="(part, i) in coverTitleParts" :key="i">{{ part }}<wbr /></template></span>
        <span v-if="book.author" class="cover-fallback-author">{{ compact ? metaAuthor : book.author }}</span>
      </div>
      <span class="format" aria-hidden="true">{{ formatLabelOf(book) }}<svg v-if="book.noSync" class="private-mark" viewBox="0 0 24 24" width="11" height="11"><path fill="currentColor" d="M12 2a5 5 0 0 1 5 5v3h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h1V7a5 5 0 0 1 5-5zm0 2a3 3 0 0 0-3 3v3h6V7a3 3 0 0 0-3-3z"/></svg></span>
      <span v-if="progress != null" class="progress" aria-hidden="true">{{ progress }}%</span>
      <span v-if="progress != null" class="progress-track" aria-hidden="true">
        <span class="progress-fill" :style="{ width: `${progress}%` }" />
      </span>

      <span v-if="compact && book.noSync" class="compact-private" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="11" height="11"><path fill="currentColor" d="M12 2a5 5 0 0 1 5 5v3h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h1V7a5 5 0 0 1 5-5zm0 2a3 3 0 0 0-3 3v3h6V7a3 3 0 0 0-3-3z"/></svg>
      </span>

    </div>
    <div class="title">
      <svg v-if="book.pinnedAt" class="pinned-mark" viewBox="0 0 24 24" width="12" height="12" :aria-label="t('library.pin')"><path fill="currentColor" d="M14.6 2.6a2 2 0 0 1 2.83 0l4 4a2 2 0 0 1 0 2.82l-3.18 3.18.35 2.47a2 2 0 0 1-.56 1.7l-1.1 1.1a1 1 0 0 1-1.42 0L11.6 13.9l-5.9 5.9a1 1 0 0 1-1.4-1.42l5.88-5.89-3.95-3.95a1 1 0 0 1 0-1.41l1.1-1.1a2 2 0 0 1 1.7-.57l2.47.35 3.1-3.2z"/></svg>{{ displayTitle }}
    </div>
    <div class="meta">
      <span class="meta-text"><svg v-if="!compact && book.noSync" class="meta-private" viewBox="0 0 24 24" width="11" height="11" :aria-label="t('library.privateBadge')"><path fill="currentColor" d="M12 2a5 5 0 0 1 5 5v3h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h1V7a5 5 0 0 1 5-5zm0 2a3 3 0 0 0-3 3v3h6V7a3 3 0 0 0-3-3z"/></svg><template v-if="metaProgress"><span :class="{ 'meta-done': progress != null && progress >= 99 }">{{ metaProgress }}</span><template v-if="metaAuthor"> · </template></template>{{ metaAuthor }}<template v-if="!metaProgress && !metaAuthor">{{ t('library.unread') }}</template></span>
      <button
        v-if="!selectable"
        ref="moreEl"
        type="button"
        class="meta-more"
        :class="{ open: menuOpen }"
        :title="t('common.moreActions')"
        :aria-label="t('common.moreActions')"
        :aria-haspopup="compact ? 'dialog' : 'menu'"
        :aria-expanded="compact ? undefined : menuOpen"
        @click.stop="onMore"
        @keydown.stop
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="5" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="19" cy="12" r="1.7" fill="currentColor"/></svg>
      </button>
    </div>
    <!-- 桌面操作菜单: 始终在 DOM 里 (v-show), 便于按类名找到某本书的某个操作 -->
    <div
      v-if="!selectable && !compact"
      v-show="menuOpen"
      ref="actionsEl"
      class="card-menu"
      role="menu"
      :aria-label="t('common.moreActions')"
      @click.stop
      @keydown.stop
      @keydown.esc="closeMenu(); moreEl?.focus()"
    >
      <div class="card-menu-head" aria-hidden="true">{{ formatLabelOf(book) }}<template v-if="book.noSync"> · {{ t('library.privateBadge') }}</template></div>
      <button
        v-if="showBooklists"
        type="button"
        role="menuitem"
        class="action booklist-action"
        :title="t('library.addToBooklist')"
        :aria-label="t('library.addToBooklist')"
        @click="menuAction('addToBooklist')"
      >{{ t('library.addToBooklist') }}</button>
      <button
        type="button"
        role="menuitem"
        class="action pin"
        :title="book.pinnedAt ? t('library.unpin') : t('library.pin')"
        :aria-label="book.pinnedAt ? t('library.unpin') : t('library.pin')"
        @click="menuAction('togglePin')"
      >{{ book.pinnedAt ? t('library.unpin') : t('library.pin') }}</button>
      <button
        v-if="sendable"
        type="button"
        role="menuitem"
        class="action send"
        :title="t('transfer.sendToDevices')"
        :aria-label="t('transfer.sendToDevices')"
        @click="menuAction('send')"
      >{{ t('transfer.sendToDevices') }}</button>
      <button
        type="button"
        role="menuitem"
        class="action upload"
        :title="t('library.uploadToCloud')"
        :aria-label="t('library.uploadToCloud')"
        @click="menuAction('upload')"
      >{{ t('library.uploadToCloud') }}</button>
      <button
        v-if="convertible"
        type="button"
        role="menuitem"
        class="action convert"
        :title="t('book.convertToEpub')"
        :aria-label="t('book.convertToEpub')"
        :disabled="converting"
        @click="menuAction('convert')"
      >{{ t('book.convertToEpub') }}</button>
      <button type="button" role="menuitem" class="action move-kind" @click="menuAction('moveKind')">
        {{ book.kind === 'paper' ? t('library.moveToBooks') : t('library.moveToPapers') }}
      </button>
      <button type="button" role="menuitem" class="action private" @click="menuAction('togglePrivate')">
        {{ book.noSync ? t('library.unsetPrivate') : t('library.setPrivate') }}
      </button>
      <hr />
      <button
        type="button"
        role="menuitem"
        class="action remove"
        :title="t('book.removeFromLibrary')"
        :aria-label="t('book.removeFromLibrary')"
        @click="menuAction('remove')"
      >{{ t('book.removeFromLibrary') }}</button>
    </div>
  </div>
</template>

<style scoped>
.book-card {
  position: relative;
  min-width: 0;
  cursor: pointer;
  border-radius: var(--radius-xs);
  outline: none;
}
.book-card.menu-open {
  z-index: 30;
}
.book-card:focus-visible .cover {
  box-shadow: var(--ring), var(--cover-shadow);
}
.book-card.selected .cover {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
}
/* 书封: 2:3 书本比例 + 书脊高光 (与 App 书格一致) */
.cover {
  position: relative;
  aspect-ratio: 2 / 3;
  border-radius: 3px 5px 5px 3px;
  overflow: hidden;
  box-shadow: var(--cover-shadow);
  background: var(--surface-2);
  transition:
    box-shadow var(--dur) var(--ease),
    transform var(--dur) var(--ease);
}
.cover::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  border-radius: inherit;
  box-shadow: inset 0 0 0 1px var(--cover-edge);
  background: linear-gradient(90deg, rgba(0, 0, 0, 0.12) 0, rgba(255, 255, 255, 0.14) 2.5%, transparent 6%);
}
@media (hover: hover) {
  .book-card:not(.compact):not(.selectable):hover .cover {
    transform: translateY(-2px);
    box-shadow: var(--cover-shadow), var(--shadow-2);
  }
}
.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.cover-fallback {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  gap: 0;
  padding: 16% 12% 10%;
  text-align: left;
  /* 生成封面: 纸色 + 衬线书名 + 细线 (与 App 一致), 不用渐变色块 */
  color: var(--ink);
  background: var(--paper);
}
.cover-fallback::before {
  content: '';
  height: 1px;
  margin-bottom: 14%;
  background: currentColor;
  opacity: 0.35;
}
.cover-fallback-title {
  font-family: 'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', 'STSong', serif;
  font-size: var(--fs-subtitle);
  overflow-wrap: anywhere;
  font-weight: var(--fw-semibold);
  line-height: 1.4;
  letter-spacing: 0.03em;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.cover-fallback-author {
  margin-top: auto;
  font-size: var(--fs-caption);
  opacity: 0.7;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.select-mark {
  position: absolute;
  right: 6px;
  top: 6px;
  z-index: 2;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 2px solid #fff;
  background: rgba(17, 20, 26, 0.28);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
}
.select-mark.on {
  background: var(--brand);
  border-color: var(--brand);
}
/* 格式 / 进度角标不再画在封面上 (格式在「⋯」菜单顶部, 进度在书名下);
   仍留在 DOM 里: 读屏与按格式定位书卡的脚本都靠它们 */
.format,
.progress {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
.progress-track {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: rgba(255, 255, 255, 0.55);
}
:root[data-theme='dark'] .progress-track {
  background: rgba(0, 0, 0, 0.45);
}
.progress-fill {
  display: block;
  height: 100%;
  background: var(--brand);
  transition: width var(--dur-slow) var(--ease);
}
.title {
  margin-top: var(--space-3);
  font-size: var(--fs-body);
  font-weight: var(--fw-medium);
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.meta-private {
  display: inline-block;
  margin-right: 4px;
  vertical-align: -1px;
}

/* 桌面「⋯」菜单 */
.card-menu {
  position: absolute;
  top: calc(100% + 2px);
  right: -6px;
  z-index: 40;
  min-width: 184px;
  padding: var(--space-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--card);
  box-shadow: var(--shadow-3);
  cursor: default;
}
.card-menu-head {
  padding: 6px var(--space-3);
  font-size: var(--fs-caption);
  color: var(--text-3);
}
.card-menu .action {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 32px;
  padding: 0 var(--space-3);
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text);
  font-size: var(--fs-body);
  text-align: left;
  white-space: nowrap;
}
.card-menu .action:hover,
.card-menu .action:focus-visible {
  background: var(--surface-2);
  outline: none;
}
.card-menu .action:disabled {
  color: var(--text-3);
  cursor: progress;
}
.card-menu .remove {
  color: var(--danger);
}
.card-menu hr {
  margin: var(--space-1) 0;
  border: none;
  border-top: 1px solid var(--border);
}

/* ---- 手机书格 (compact): 封面像书, 只留进度条; 书名 + 「进度 · 作者 ⋯」 ---- */
.compact,
.compact:hover {
  transform: none;
}
.compact .cover {
  aspect-ratio: 2 / 3;
  border-radius: 3px 5px 5px 3px;
  box-shadow: var(--cover-shadow);
}
.compact:hover .cover {
  box-shadow: var(--cover-shadow);
}
.compact:active:not(.selectable) .cover {
  transform: scale(0.97);
  transition: transform var(--dur-fast) var(--ease);
}
/* 书脊高光 + 细描边: 白封面也有边界 */
.compact .cover::after {
  box-shadow: inset 0 0 0 1px var(--cover-edge);
  background: linear-gradient(90deg, rgba(0, 0, 0, 0.12) 0, rgba(255, 255, 255, 0.14) 2.5%, transparent 6%);
}
.compact .format,
.compact .progress {
  display: none;
}
.compact .progress-track {
  background: rgba(255, 255, 255, 0.55);
}
:root[data-theme='dark'] .compact .progress-track {
  background: rgba(0, 0, 0, 0.45);
}
.compact.selected .cover {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
}
.compact .select-mark {
  left: auto;
  bottom: auto;
  right: 6px;
  top: 6px;
  width: 24px;
  height: 24px;
  background: rgba(17, 20, 26, 0.28);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
}
.compact .select-mark.on {
  background: var(--brand);
  border-color: var(--brand);
}
.compact-private {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: rgba(17, 20, 26, 0.5);
  color: #fff;
}
.selectable .compact-private {
  display: none;
}
/* 生成封面: 纸色 + 衬线书名 + 细线, 不再是渐变色块 */
.compact .cover-fallback {
  justify-content: flex-start;
  gap: 0;
  padding: 14% 12% 10%;
  border-left: 0;
  color: var(--ink);
  background: var(--paper);
}
.compact .cover-fallback::before {
  content: '';
  height: 1px;
  margin-bottom: 12%;
  background: currentColor;
  opacity: 0.35;
}
.compact .cover-fallback-title {
  font-family: 'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', 'STSong', serif;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
  letter-spacing: 0.03em;
  -webkit-line-clamp: 5;
}
.compact .cover-fallback-author {
  margin-top: auto;
  font-size: 10px;
  opacity: 0.7;
}
.tone-0 { --paper: var(--cover-paper-0); --ink: var(--cover-ink-0); }
.tone-1 { --paper: var(--cover-paper-1); --ink: var(--cover-ink-1); }
.tone-2 { --paper: var(--cover-paper-2); --ink: var(--cover-ink-2); }
.tone-3 { --paper: var(--cover-paper-3); --ink: var(--cover-ink-3); }
.tone-4 { --paper: var(--cover-paper-4); --ink: var(--cover-ink-4); }
.tone-5 { --paper: var(--cover-paper-5); --ink: var(--cover-ink-5); }
:root[data-theme='dark'] .compact .cover-fallback {
  color: var(--ink);
  background: var(--paper);
}
.compact .title {
  margin-top: 9px;
  font-size: 13.5px;
  font-weight: 550;
  line-height: 1.38;
  white-space: normal;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  word-break: break-word;
}
.pinned-mark {
  display: inline-block;
  margin-right: 3px;
  vertical-align: -1px;
  color: var(--brand);
}
.meta {
  display: flex;
  align-items: center;
  margin-top: 2px;
  margin-right: -10px;
}
.book-card:not(.compact) .meta {
  min-height: 24px;
}
.book-card:not(.compact) .meta-text {
  font-size: var(--fs-small);
}
.meta-text {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-caption);
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
}
.meta-done {
  color: var(--success);
}
/* 36×36 按钮, 上下负边距不撑高作者行; 热区再外扩到 ≥44px */
.meta-more {
  position: relative;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  margin: -6px 0;
  display: grid;
  place-items: center;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text-3);
}
/* 热区外扩到 ≥44px 高 */
.meta-more::before {
  content: '';
  position: absolute;
  inset: -4px;
}
.meta-more:active {
  background: var(--surface-3);
}
.meta-more:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 1px;
}
/* 桌面: 悬停 / 聚焦 / 菜单展开时才出现; 触屏设备常显 */
.book-card:not(.compact) .meta-more {
  width: 28px;
  height: 28px;
  margin: -2px 4px -2px 0;
}
.book-card:not(.compact) .meta-more:hover,
.book-card:not(.compact) .meta-more.open {
  background: var(--surface-2);
  color: var(--text);
}
@media (hover: hover) {
  .book-card:not(.compact) .meta-more {
    opacity: 0;
    transition: opacity var(--dur-fast) var(--ease);
  }
  .book-card:not(.compact):hover .meta-more,
  .book-card:not(.compact):focus-within .meta-more,
  .book-card:not(.compact) .meta-more.open {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .book-card,
  .book-card:hover {
    transform: none;
  }
}
</style>
