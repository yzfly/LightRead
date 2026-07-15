<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useLibrary } from '../stores/library'
import { importFiles } from '../services/importer'
import { importFromUrl } from '../services/urlImport'
import { ACCEPT, SUPPORTED_EXTS } from '../services/format'
import { toast } from '../services/toast'
import { formatReadingTime } from '../composables/useReadingTimer'
import BookCard from '../components/BookCard.vue'
import type { BookMeta } from '../storage'
import { t } from '../i18n'

const router = useRouter()
const route = useRoute()
const library = useLibrary()

/** /papers 路由复用本视图, 只显示论文 */
const paperMode = computed(() => route.meta.kind === 'paper')
const pageKind = computed<'book' | 'paper'>(() => (paperMode.value ? 'paper' : 'book'))

// 路由切换 (藏书 ↔ 论文) 时重置筛选与选择状态
watch(paperMode, () => {
  manageMode.value = false
  selectedIds.value = new Set()
  tagFilter.value = ''
  keyword.value = ''
})

const keyword = ref('')
const sortBy = ref<'recent' | 'added' | 'title' | 'author'>('recent')
const fileInput = ref<HTMLInputElement>()
const dragging = ref(false)
const importing = ref(false)
const importState = ref({ done: 0, total: 0, current: '' })

// 批量管理
const manageMode = ref(false)
const selectedIds = ref<Set<string>>(new Set())
const tagFilter = ref('')
const showTagModal = ref(false)
const tagDraft = ref('')

onMounted(() => library.refresh())

const totalReadingTime = computed(() => {
  const total = kindBooks.value.reduce((sum, b) => sum + (b.readingSeconds ?? 0), 0)
  return total >= 60 ? formatReadingTime(total) : ''
})

const allTags = computed(() => {
  const tags = new Set<string>()
  for (const book of kindBooks.value) for (const t of book.tags) tags.add(t)
  return [...tags].sort((a, b) => a.localeCompare(b, 'zh'))
})

const kindBooks = computed(() =>
  library.books.filter(b => (b.kind ?? 'book') === pageKind.value))

const filtered = computed(() => {
  let list = kindBooks.value
  if (tagFilter.value) list = list.filter(b => b.tags.includes(tagFilter.value))
  const kw = keyword.value.trim().toLowerCase()
  if (kw) {
    list = list.filter(b =>
      b.title.toLowerCase().includes(kw)
      || b.author.toLowerCase().includes(kw)
      || b.tags.some(t => t.toLowerCase().includes(kw)))
  }
  const sorted = [...list]
  switch (sortBy.value) {
    case 'recent':
      sorted.sort((a, b) => (b.lastReadAt ?? b.addedAt) - (a.lastReadAt ?? a.addedAt))
      break
    case 'added':
      sorted.sort((a, b) => b.addedAt - a.addedAt)
      break
    case 'title':
      sorted.sort((a, b) => a.title.localeCompare(b.title, 'zh'))
      break
    case 'author':
      sorted.sort((a, b) => a.author.localeCompare(b.author, 'zh'))
      break
  }
  // 置顶的书永远排最前 (按置顶时间新→旧)
  return [
    ...sorted.filter(b => b.pinnedAt).sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0)),
    ...sorted.filter(b => !b.pinnedAt),
  ]
})

async function handleFiles(files: FileList | File[]) {
  if (!files.length) return
  importing.value = true
  const results = await importFiles(files, '本地导入', (done, total, current) => {
    importState.value = { done, total, current }
  }, { kind: pageKind.value })
  importing.value = false
  await library.refresh()
  const okCount = results.filter(r => r.ok).length
  const failed = results.filter(r => !r.ok)
  if (okCount) toast(t(paperMode.value ? 'library.importPapersSuccess' : 'library.importSuccess', { count: okCount }), 'success')
  for (const f of failed) toast(`${f.fileName}: ${f.error}`, 'error', 5000)
}

function onPick(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.files) handleFiles(input.files)
  input.value = ''
}

function onDrop(e: DragEvent) {
  dragging.value = false
  if (e.dataTransfer?.files) handleFiles(e.dataTransfer.files)
}

function openBook(book: BookMeta) {
  // PDF 统一走论文阅读器 (PDFium 渲染 + 几何选择 + 翻译/AI), 藏书与论文一套引擎
  const target = book.format === 'pdf'
    ? `/read-paper/${book.id}`
    : book.format === 'djvu' ? `/read-djvu/${book.id}`
      : `/read/${book.id}`
  router.push(target)
}

async function removeBook(book: BookMeta) {
  if (!confirm(t(paperMode.value ? 'library.deletePaperConfirm' : 'library.deleteConfirm', { title: book.title }))) return
  await library.removeBook(book.id)
  toast(t('library.deleted'), 'success')
}

// ---- URL 导入 ----
const showUrlModal = ref(false)
const urlDraft = ref('')
const urlImporting = ref('')

async function doUrlImport() {
  const url = urlDraft.value.trim()
  if (!url || urlImporting.value) return
  if (!/^https?:\/\//i.test(url)) {
    toast(t('library.urlInvalid'), 'error')
    return
  }
  urlImporting.value = t('common.connecting')
  try {
    const result = await importFromUrl(url, p => {
      urlImporting.value = p.fraction != null
        ? t('library.urlDownloading', { pct: (p.fraction * 100).toFixed(0), mb: p.receivedMB })
        : t('library.urlDownloadingMB', { mb: p.receivedMB })
    })
    if (!result.ok) throw new Error(result.error)
    await library.refresh()
    showUrlModal.value = false
    urlDraft.value = ''
    toast(t('library.importSuccess', { count: 1 }), 'success')
  } catch (e: any) {
    toast(t('library.urlImportFailed', { msg: e?.message ?? e }), 'error', 6000)
  } finally {
    urlImporting.value = ''
  }
}

// ---- 导入菜单 ----
const importMenu = ref(false)

// ---- 批量管理 ----
function toggleManage() {
  manageMode.value = !manageMode.value
  selectedIds.value = new Set()
}

function toggleSelect(id: string) {
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedIds.value = next
}

function selectAll() {
  selectedIds.value = selectedIds.value.size === filtered.value.length
    ? new Set()
    : new Set(filtered.value.map(b => b.id))
}

async function batchDelete() {
  const count = selectedIds.value.size
  if (!count || !confirm(t(paperMode.value ? 'library.batchDeletePapersConfirm' : 'library.batchDeleteConfirm', { count }))) return
  for (const id of selectedIds.value) await library.removeBook(id)
  selectedIds.value = new Set()
  toast(t('library.batchDeleted', { count }), 'success')
}

async function batchTag() {
  const tags = tagDraft.value.split(/[,，、]/).map(t => t.trim()).filter(Boolean)
  const storage = await (await import('../storage')).getStorage()
  for (const id of selectedIds.value) {
    const book = library.books.find(b => b.id === id)
    if (!book) continue
    const merged = [...new Set([...book.tags, ...tags])]
    await storage.updateBook(id, { tags: merged })
    book.tags = merged
  }
  showTagModal.value = false
  tagDraft.value = ''
  toast(t('library.tagsAdded', { count: selectedIds.value.size }), 'success')
}

async function togglePin(book: BookMeta) {
  const storage = await (await import('../storage')).getStorage()
  const pinnedAt = book.pinnedAt ? 0 : Date.now()
  await storage.updateBook(book.id, { pinnedAt })
  book.pinnedAt = pinnedAt || undefined
  toast(pinnedAt ? t('library.pinned') : t('library.unpinned'), 'success')
}

async function batchMoveKind() {
  const target: 'book' | 'paper' = paperMode.value ? 'book' : 'paper'
  const storage = await (await import('../storage')).getStorage()
  for (const id of selectedIds.value) {
    const book = library.books.find(b => b.id === id)
    if (!book) continue
    await storage.updateBook(id, { kind: target })
    book.kind = target
  }
  toast(t(target === 'paper' ? 'library.movedToPapers' : 'library.movedToBooks', { count: selectedIds.value.size }), 'success')
  selectedIds.value = new Set()
}

async function batchPin(pin: boolean) {
  const storage = await (await import('../storage')).getStorage()
  let stamp = Date.now()
  for (const id of selectedIds.value) {
    const book = library.books.find(b => b.id === id)
    if (!book) continue
    const pinnedAt = pin ? stamp-- : 0
    await storage.updateBook(id, { pinnedAt })
    book.pinnedAt = pinnedAt || undefined
  }
  toast(pin ? t('library.pinned') : t('library.unpinned'), 'success')
}

// ---- 分类 (标签) 管理: 重命名 / 删除 ----
const showTagManage = ref(false)
const tagRenames = ref<Record<string, string>>({})

function openTagManage() {
  tagRenames.value = Object.fromEntries(allTags.value.map(tag => [tag, tag]))
  showTagManage.value = true
}

function tagCount(tag: string) {
  return library.books.filter(b => b.tags.includes(tag)).length
}

async function renameTag(oldName: string) {
  const newName = tagRenames.value[oldName]?.trim()
  if (!newName || newName === oldName) return
  const storage = await (await import('../storage')).getStorage()
  for (const book of library.books) {
    if (!book.tags.includes(oldName)) continue
    const tags = [...new Set(book.tags.map(x => (x === oldName ? newName : x)))]
    await storage.updateBook(book.id, { tags })
    book.tags = tags
  }
  if (tagFilter.value === oldName) tagFilter.value = newName
  delete tagRenames.value[oldName]
  tagRenames.value[newName] = newName
  toast(t('library.tagRenamed'), 'success')
}

async function deleteTag(tag: string) {
  if (!confirm(t('library.deleteTagConfirm', { tag }))) return
  const storage = await (await import('../storage')).getStorage()
  for (const book of library.books) {
    if (!book.tags.includes(tag)) continue
    const tags = book.tags.filter(x => x !== tag)
    await storage.updateBook(book.id, { tags })
    book.tags = tags
  }
  if (tagFilter.value === tag) tagFilter.value = ''
  delete tagRenames.value[tag]
  toast(t('library.tagDeleted'), 'success')
}

async function batchClearTags() {
  const storage = await (await import('../storage')).getStorage()
  for (const id of selectedIds.value) {
    const book = library.books.find(b => b.id === id)
    if (!book) continue
    await storage.updateBook(id, { tags: [] })
    book.tags = []
  }
  showTagModal.value = false
  toast(t('library.tagsCleared'), 'success')
}
</script>

<template>
  <div
    class="library"
    :class="{ dragging }"
    @dragover.prevent="dragging = true"
    @dragleave.self="dragging = false"
    @drop.prevent="onDrop"
    @click="importMenu = false"
  >
    <header class="toolbar">
      <h1>{{ paperMode ? t('nav.papers') : t('library.title') }}</h1>
      <span v-if="library.loaded" class="count">
        {{ t(paperMode ? 'library.paperCount' : 'library.bookCount', { count: kindBooks.length }) }}<template v-if="totalReadingTime"> · {{ t('library.totalReading', { time: totalReadingTime }) }}</template>
      </span>
      <div class="spacer" />
      <input v-model="keyword" class="input search" type="search" :placeholder="t(paperMode ? 'library.searchPapersPlaceholder' : 'library.searchPlaceholder')" />
      <select v-model="sortBy" class="input">
        <option value="recent">{{ t('library.sortRecent') }}</option>
        <option value="added">{{ t('library.sortAdded') }}</option>
        <option value="title">{{ t(paperMode ? 'library.sortPaperTitle' : 'library.sortTitle') }}</option>
        <option value="author">{{ t('library.sortAuthor') }}</option>
      </select>
      <button v-if="kindBooks.length" class="btn" :class="{ 'btn-primary': manageMode }" @click="toggleManage">
        {{ manageMode ? t('common.done') : t('library.manage') }}
      </button>
      <div class="import-group">
        <button class="btn btn-primary import-main" @click="fileInput?.click()">
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M11 13H5a1 1 0 1 1 0-2h6V5a1 1 0 1 1 2 0v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6z"/></svg>
          {{ t(paperMode ? 'library.importPapers' : 'library.import') }}
        </button>
        <button class="btn btn-primary import-caret" :title="t('library.moreImport')" @click.stop="importMenu = !importMenu">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M5.3 9.3a1 1 0 0 1 1.4 0l5.3 5.29 5.3-5.3a1 1 0 1 1 1.4 1.42l-6 6a1 1 0 0 1-1.4 0l-6-6a1 1 0 0 1 0-1.42z"/></svg>
        </button>
        <div v-if="importMenu" class="import-menu card">
          <button @click="importMenu = false; fileInput?.click()">{{ t('library.importLocal') }}</button>
          <button @click="importMenu = false; showUrlModal = true">{{ t('library.urlImportTitle') }}</button>
        </div>
      </div>
      <input ref="fileInput" type="file" multiple :accept="ACCEPT" hidden @change="onPick" />
    </header>

    <!-- 标签筛选 -->
    <div v-if="allTags.length" class="tag-row">
      <button class="tag-chip" :class="{ active: !tagFilter }" @click="tagFilter = ''">{{ t('library.filterAll') }}</button>
      <button
        v-for="t in allTags"
        :key="t"
        class="tag-chip"
        :class="{ active: tagFilter === t }"
        @click="tagFilter = tagFilter === t ? '' : t"
      >{{ t }}</button>
      <button class="tag-chip tag-manage" :title="t('library.manageTags')" @click="openTagManage">
        <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M16.9 3.1a2.5 2.5 0 0 1 3.54 0l.46.46a2.5 2.5 0 0 1 0 3.54L9.83 18.17a2 2 0 0 1-.9.52l-3.67 1a1 1 0 0 1-1.23-1.23l1-3.67a2 2 0 0 1 .52-.9L16.9 3.1zm2.12 1.42a.5.5 0 0 0-.7 0l-1.1 1.08 1.17 1.18 1.09-1.1a.5.5 0 0 0 0-.7l-.46-.46zM16.97 8.2 15.8 7.03 7 15.84l-.59 2.16 2.16-.59 8.4-9.2z"/></svg>
        {{ t('library.manageTags') }}
      </button>
    </div>

    <div v-if="importing" class="import-bar card">
      <div class="import-text">
        {{ t('library.importing', { name: importState.current, done: importState.done + 1, total: importState.total }) }}
      </div>
      <div class="import-track">
        <div class="import-fill" :style="{ width: `${(importState.done / Math.max(importState.total, 1)) * 100}%` }" />
      </div>
    </div>

    <div v-if="library.loaded && !kindBooks.length" class="empty">
      <div class="empty-icon">{{ paperMode ? '🎓' : '📚' }}</div>
      <p>{{ t(paperMode ? 'library.papersEmptyTitle' : 'library.emptyTitle') }}</p>
      <p class="hint">
        <template v-if="paperMode">{{ t('library.papersEmptyHint') }}</template>
        <template v-else>{{ t('library.emptyHint') }}<br />{{ t('library.supportedFormats', { formats: SUPPORTED_EXTS.join(' / ') }) }}</template>
      </p>
    </div>

    <div v-else class="grid">
      <BookCard
        v-for="book in filtered"
        :key="book.id"
        :book="book"
        :cover-url="library.coverUrls[book.id]"
        :selectable="manageMode"
        :selected="selectedIds.has(book.id)"
        @open="openBook(book)"
        @remove="removeBook(book)"
        @toggle-select="toggleSelect(book.id)"
        @toggle-pin="togglePin(book)"
      />
    </div>

    <!-- 批量操作栏 -->
    <div v-if="manageMode" class="batch-bar card">
      <span class="batch-count">{{ t('library.selectedCount', { count: selectedIds.size }) }}</span>
      <button class="btn btn-sm" @click="selectAll">
        {{ selectedIds.size === filtered.length && filtered.length ? t('library.deselectAll') : t('library.selectAll') }}
      </button>
      <button class="btn btn-sm" :disabled="!selectedIds.size" @click="batchMoveKind">
        {{ paperMode ? t('library.moveToBooks') : t('library.moveToPapers') }}
      </button>
      <button class="btn btn-sm" :disabled="!selectedIds.size" @click="batchPin(true)">{{ t('library.pin') }}</button>
      <button class="btn btn-sm" :disabled="!selectedIds.size" @click="batchPin(false)">{{ t('library.unpin') }}</button>
      <button class="btn btn-sm" :disabled="!selectedIds.size" @click="showTagModal = true">{{ t('library.setTags') }}</button>
      <button class="btn btn-sm btn-danger" :disabled="!selectedIds.size" @click="batchDelete">{{ t('common.delete') }}</button>
      <button class="btn btn-sm" @click="toggleManage">{{ t('common.done') }}</button>
    </div>

    <!-- 批量标签弹窗 -->
    <div v-if="showTagModal" class="modal-mask" @click.self="showTagModal = false">
      <div class="modal">
        <h3>{{ t('library.tagModalTitle', { count: selectedIds.size }) }}</h3>
        <input v-model="tagDraft" class="input" style="width: 100%" :placeholder="t('library.tagPlaceholder')" @keyup.enter="batchTag" />
        <div class="form-actions" style="margin-top: 16px; display: flex; justify-content: flex-end; gap: 8px">
          <button class="btn btn-sm" @click="batchClearTags">{{ t('library.clearTags') }}</button>
          <button class="btn btn-sm" @click="showTagModal = false">{{ t('common.cancel') }}</button>
          <button class="btn btn-sm btn-primary" :disabled="!tagDraft.trim()" @click="batchTag">{{ t('common.add') }}</button>
        </div>
      </div>
    </div>

    <!-- URL 导入弹窗 -->
    <div v-if="showUrlModal" class="modal-mask" @click.self="!urlImporting && (showUrlModal = false)">
      <div class="modal">
        <h3>{{ t('library.urlImportTitle') }}</h3>
        <input
          v-model="urlDraft"
          class="input"
          style="width: 100%; margin-top: 12px"
          :placeholder="t('library.urlPlaceholder')"
          :disabled="!!urlImporting"
          @keyup.enter="doUrlImport"
        />
        <p class="url-hint">{{ t('library.urlHint') }}</p>
        <div v-if="urlImporting" class="url-progress">{{ urlImporting }}</div>
        <div style="margin-top: 14px; display: flex; justify-content: flex-end; gap: 8px">
          <button class="btn btn-sm" :disabled="!!urlImporting" @click="showUrlModal = false">{{ t('common.cancel') }}</button>
          <button class="btn btn-sm btn-primary" :disabled="!urlDraft.trim() || !!urlImporting" @click="doUrlImport">
            {{ urlImporting ? t('common.loading') : t('library.urlDownloadImport') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 分类管理弹窗 -->
    <div v-if="showTagManage" class="modal-mask" @click.self="showTagManage = false">
      <div class="modal">
        <h3>{{ t('library.manageTags') }}</h3>
        <div class="tag-manage-list">
          <div v-for="tag in allTags" :key="tag" class="tag-manage-row">
            <input v-model="tagRenames[tag]" class="input" @keyup.enter="renameTag(tag)" />
            <span class="tag-book-count">{{ t('library.tagBooks', { count: tagCount(tag) }) }}</span>
            <button
              class="btn btn-sm"
              :disabled="!tagRenames[tag]?.trim() || tagRenames[tag].trim() === tag"
              @click="renameTag(tag)"
            >{{ t('common.save') }}</button>
            <button class="btn btn-sm btn-danger" @click="deleteTag(tag)">{{ t('common.delete') }}</button>
          </div>
          <p v-if="!allTags.length" class="tag-manage-empty">{{ t('library.noTags') }}</p>
        </div>
        <div style="margin-top: 16px; display: flex; justify-content: flex-end">
          <button class="btn btn-sm" @click="showTagManage = false">{{ t('common.close') }}</button>
        </div>
      </div>
    </div>

    <div v-if="dragging" class="drop-hint">{{ t(paperMode ? 'library.dropHintPapers' : 'library.dropHint') }}</div>
  </div>
</template>

<style scoped>
.library {
  min-height: 100%;
  padding: 24px 28px 40px;
  position: relative;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}
.toolbar h1 {
  font-size: 20px;
}
.count {
  color: var(--text-3);
  font-size: 13px;
}
.spacer {
  flex: 1;
}
.search {
  width: 240px;
}
.import-bar {
  padding: 12px 16px;
  margin-bottom: 16px;
}
.import-text {
  font-size: 13px;
  color: var(--text-2);
  margin-bottom: 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.import-track {
  height: 4px;
  border-radius: 2px;
  background: var(--bg);
  overflow: hidden;
}
.import-fill {
  height: 100%;
  background: var(--brand);
  transition: width 0.2s;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(136px, 1fr));
  gap: 20px 16px;
}
.tag-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.tag-chip {
  height: 26px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 13px;
  background: var(--card);
  color: var(--text-2);
  font-size: 12px;
}
.tag-chip.active {
  background: var(--brand-light);
  border-color: var(--brand);
  color: var(--brand);
}
.tag-manage {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border-style: dashed;
  color: var(--text-3);
}
.tag-manage:hover {
  color: var(--brand);
  border-color: var(--brand);
}
.tag-manage-list {
  max-height: 320px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}
.tag-manage-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tag-manage-row .input {
  flex: 1;
  min-width: 0;
  height: 30px;
}
.tag-book-count {
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
}
.import-group {
  position: relative;
  display: flex;
}
.import-main {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}
.import-caret {
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
  border-left: 1px solid rgba(255, 255, 255, 0.35);
  padding: 0 8px;
  min-width: 0;
}
.import-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 30;
  min-width: 180px;
  padding: 6px;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-lg);
}
.import-menu button {
  height: 34px;
  border: none;
  background: none;
  border-radius: 6px;
  text-align: left;
  padding: 0 10px;
  font-size: 13px;
  color: var(--text-2);
}
.import-menu button:hover {
  background: var(--bg);
  color: var(--text);
}
.url-hint {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 8px;
  line-height: 1.7;
}
.url-progress {
  font-size: 13px;
  color: var(--brand);
  margin-top: 8px;
}
.tag-manage-empty {
  color: var(--text-3);
  font-size: 13px;
  text-align: center;
  padding: 16px 0;
}
.batch-bar {
  position: sticky;
  bottom: 16px;
  margin-top: 20px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  box-shadow: var(--shadow-lg);
  z-index: 10;
}
.batch-count {
  font-size: 13px;
  color: var(--text-2);
  min-width: 70px;
}
@media (max-width: 600px) {
  .library {
    padding: 16px 14px 32px;
  }
  .grid {
    grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
    gap: 14px 10px;
  }
  .search {
    width: 100%;
    order: 5;
  }
}
.hint {
  font-size: 13px;
  text-align: center;
  line-height: 1.8;
}
.drop-hint {
  position: absolute;
  inset: 12px;
  border: 2px dashed var(--brand);
  border-radius: var(--radius-lg);
  background: rgba(22, 100, 255, 0.06);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  color: var(--brand);
  pointer-events: none;
}
</style>
