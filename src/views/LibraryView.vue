<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
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
  activeBooklistId.value = ''
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

// 书单
const activeBooklistId = ref('')
const showBooklistCreate = ref(false)
const showBooklistManage = ref(false)
const showBooklistPicker = ref(false)
const booklistDraft = ref('')
const pickerBookIds = ref<string[]>([])
const pickerDraft = ref('')
const booklistRenames = ref<Record<string, string>>({})

onMounted(() => {
  library.refresh()
  window.addEventListener('keydown', onGlobalKeydown)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKeydown))

/** Esc 逐层关闭: 弹窗 → 导入菜单 → 管理模式 */
function onGlobalKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (showTagManage.value) showTagManage.value = false
  else if (showUrlModal.value) { if (!urlImporting.value) showUrlModal.value = false }
  else if (showTagModal.value) showTagModal.value = false
  else if (showBooklistManage.value) showBooklistManage.value = false
  else if (showBooklistPicker.value) showBooklistPicker.value = false
  else if (showBooklistCreate.value) showBooklistCreate.value = false
  else if (importMenu.value) importMenu.value = false
  else if (manageMode.value) toggleManage()
  else return
  e.preventDefault()
}

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

const activeBooklist = computed(() =>
  library.booklists.find(item => item.id === activeBooklistId.value))

const filtered = computed(() => {
  let list = kindBooks.value
  if (!paperMode.value && activeBooklistId.value) {
    const ids = new Set(library.booklistBookIds[activeBooklistId.value] ?? [])
    list = list.filter(book => ids.has(book.id))
  }
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
  // PDF 统一走论文阅读器 (可选 MuPDF/PDFium 渲染 + PDFium 交互几何), 藏书与论文共用
  const target = book.format === 'pdf'
    ? `/read-paper/${book.id}`
    : book.format === 'djvu' ? `/read-djvu/${book.id}`
      : `/read/${book.id}`
  router.push(target)
}

async function removeBook(book: BookMeta) {
  const confirmation = paperMode.value
    ? 'library.deletePaperConfirm'
    : book.format === 'pdf'
      ? 'library.deletePdfConfirm'
      : 'library.deleteConfirm'
  if (!confirm(t(confirmation, { title: book.title }))) return
  try {
    await library.removeBook(book.id)
    toast(t('library.deleted'), 'success')
  } catch (error: any) {
    toast(t('library.deleteFailed', { msg: error?.message ?? error }), 'error', 6000)
  }
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
  const includesPdf = [...selectedIds.value].some(id => library.books.some(book => book.id === id && book.format === 'pdf'))
  const confirmation = paperMode.value
    ? 'library.batchDeletePapersConfirm'
    : includesPdf
      ? 'library.batchDeleteWithAgentConfirm'
      : 'library.batchDeleteConfirm'
  if (!count || !confirm(t(confirmation, { count }))) return
  let deleted = 0
  try {
    for (const id of selectedIds.value) {
      await library.removeBook(id)
      deleted += 1
    }
    selectedIds.value = new Set()
    toast(t('library.batchDeleted', { count }), 'success')
  } catch (error: any) {
    selectedIds.value = new Set([...selectedIds.value].filter(id => library.books.some(book => book.id === id)))
    toast(t('library.batchDeleteFailed', { deleted, msg: error?.message ?? error }), 'error', 7000)
  }
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

// ---- 书单 ----
function booklistCount(id: string) {
  const ids = new Set(library.booklistBookIds[id] ?? [])
  return library.books.filter(
    book => (book.kind ?? 'book') === 'book' && ids.has(book.id)).length
}

function isBooklistNameTaken(name: string, ignoreId = '') {
  const normalized = name.trim().toLocaleLowerCase()
  return library.booklists.some(
    item => item.id !== ignoreId && item.name.trim().toLocaleLowerCase() === normalized)
}

function openCreateBooklist() {
  booklistDraft.value = ''
  showBooklistCreate.value = true
}

async function createBooklist() {
  const name = booklistDraft.value.trim()
  if (!name) return
  if (isBooklistNameTaken(name)) {
    toast(t('library.booklistNameExists'), 'error')
    return
  }
  const id = await library.createBooklist(name)
  activeBooklistId.value = id
  showBooklistCreate.value = false
  booklistDraft.value = ''
  toast(t('library.booklistCreated', { name }), 'success')
}

function openBooklistManage() {
  booklistRenames.value = Object.fromEntries(
    library.booklists.map(item => [item.id, item.name]))
  showBooklistManage.value = true
}

async function renameBooklist(id: string) {
  const name = booklistRenames.value[id]?.trim()
  const current = library.booklists.find(item => item.id === id)
  if (!name || !current || name === current.name) return
  if (isBooklistNameTaken(name, id)) {
    toast(t('library.booklistNameExists'), 'error')
    return
  }
  await library.renameBooklist(id, name)
  booklistRenames.value[id] = name
  toast(t('library.booklistRenamed'), 'success')
}

async function deleteBooklist(id: string) {
  const item = library.booklists.find(booklist => booklist.id === id)
  if (!item || !confirm(t('library.deleteBooklistConfirm', { name: item.name }))) return
  await library.deleteBooklist(id)
  if (activeBooklistId.value === id) activeBooklistId.value = ''
  delete booklistRenames.value[id]
  toast(t('library.booklistDeleted'), 'success')
}

function openBooklistPicker(ids: string[]) {
  if (!ids.length) return
  pickerBookIds.value = [...new Set(ids)]
  pickerDraft.value = ''
  showBooklistPicker.value = true
}

async function addPickerBooks(booklistId: string) {
  const item = library.booklists.find(booklist => booklist.id === booklistId)
  if (!item) return
  await library.addBooksToBooklist(booklistId, pickerBookIds.value)
  toast(t('library.addedToBooklist', {
    count: pickerBookIds.value.length,
    name: item.name,
  }), 'success')
  showBooklistPicker.value = false
}

async function createBooklistAndAdd() {
  const name = pickerDraft.value.trim()
  if (!name) return
  if (isBooklistNameTaken(name)) {
    toast(t('library.booklistNameExists'), 'error')
    return
  }
  const id = await library.createBooklist(name)
  await library.addBooksToBooklist(id, pickerBookIds.value)
  toast(t('library.addedToBooklist', {
    count: pickerBookIds.value.length,
    name,
  }), 'success')
  showBooklistPicker.value = false
  pickerDraft.value = ''
}

async function removeSelectedFromBooklist() {
  if (!activeBooklist.value || !selectedIds.value.size) return
  const count = selectedIds.value.size
  await library.removeBooksFromBooklist(
    activeBooklist.value.id, [...selectedIds.value])
  selectedIds.value = new Set()
  toast(t('library.removedFromBooklist', {
    count,
    name: activeBooklist.value.name,
  }), 'success')
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
      <div class="heading">
        <h1>{{ paperMode ? t('nav.papers') : t('library.title') }}</h1>
        <span v-if="library.loaded" class="count">
          {{ t(paperMode ? 'library.paperCount' : 'library.bookCount', { count: kindBooks.length }) }}<template v-if="totalReadingTime"> · {{ t('library.totalReading', { time: totalReadingTime }) }}</template>
        </span>
      </div>
      <div class="spacer" />
      <div class="search-field">
        <svg class="search-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M10.5 3a7.5 7.5 0 0 1 5.96 12.06l4.24 4.24a1 1 0 0 1-1.42 1.4l-4.24-4.23A7.5 7.5 0 1 1 10.5 3zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z"/></svg>
        <input
          v-model="keyword"
          class="input search"
          type="search"
          :placeholder="t(paperMode ? 'library.searchPapersPlaceholder' : 'library.searchPlaceholder')"
          :aria-label="t('common.search')"
          autocomplete="off"
          spellcheck="false"
        />
        <button v-if="keyword" type="button" class="search-clear" :aria-label="t('common.clear')" @click="keyword = ''">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M6.7 5.3a1 1 0 0 0-1.4 1.4L10.6 12l-5.3 5.3a1 1 0 1 0 1.4 1.4l5.3-5.3 5.3 5.3a1 1 0 0 0 1.4-1.4L13.4 12l5.3-5.3a1 1 0 0 0-1.4-1.4L12 10.6 6.7 5.3z"/></svg>
        </button>
      </div>
      <select v-model="sortBy" class="input sort" :aria-label="t('common.sortBy')">
        <option value="recent">{{ t('library.sortRecent') }}</option>
        <option value="added">{{ t('library.sortAdded') }}</option>
        <option value="title">{{ t(paperMode ? 'library.sortPaperTitle' : 'library.sortTitle') }}</option>
        <option value="author">{{ t('library.sortAuthor') }}</option>
      </select>
      <button v-if="kindBooks.length" class="btn" :class="{ 'btn-primary': manageMode }" :aria-pressed="manageMode" @click="toggleManage">
        {{ manageMode ? t('common.done') : t('library.manage') }}
      </button>
      <div class="import-group">
        <button class="btn btn-primary import-main" @click="fileInput?.click()">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M11 13H5a1 1 0 1 1 0-2h6V5a1 1 0 1 1 2 0v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6z"/></svg>
          {{ t(paperMode ? 'library.importPapers' : 'library.import') }}
        </button>
        <button
          class="btn btn-primary import-caret"
          :title="t('library.moreImport')"
          :aria-label="t('library.moreImport')"
          aria-haspopup="menu"
          :aria-expanded="importMenu"
          @click.stop="importMenu = !importMenu"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M5.3 9.3a1 1 0 0 1 1.4 0l5.3 5.29 5.3-5.3a1 1 0 1 1 1.4 1.42l-6 6a1 1 0 0 1-1.4 0l-6-6a1 1 0 0 1 0-1.42z"/></svg>
        </button>
        <div v-if="importMenu" class="import-menu card" role="menu">
          <button role="menuitem" @click="importMenu = false; fileInput?.click()">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M4 6a3 3 0 0 1 3-3h3.6a3 3 0 0 1 2.1.9L14.4 5.6a1 1 0 0 0 .7.3H17a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V6zm3-1a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8.9a1 1 0 0 0-1-1h-1.9a3 3 0 0 1-2.1-.9L11.3 5.3a1 1 0 0 0-.7-.3H7z"/></svg>
            {{ t('library.importLocal') }}
          </button>
          <button role="menuitem" @click="importMenu = false; showUrlModal = true">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M10.6 13.4a1 1 0 0 1 0-1.4l2.8-2.8a1 1 0 0 1 1.4 1.4l-2.8 2.8a1 1 0 0 1-1.4 0zM7 17a3 3 0 0 1 0-4.24l2.12-2.12a1 1 0 1 1 1.42 1.42L8.4 14.17a1 1 0 0 0 1.42 1.42l2.12-2.12a1 1 0 1 1 1.41 1.41L11.24 17A3 3 0 0 1 7 17zm10-10a3 3 0 0 1 0 4.24l-2.12 2.12a1 1 0 1 1-1.42-1.42l2.12-2.11a1 1 0 0 0-1.42-1.42l-2.12 2.12a1 1 0 0 1-1.41-1.41L12.76 7A3 3 0 0 1 17 7z"/></svg>
            {{ t('library.urlImportTitle') }}
          </button>
        </div>
      </div>
      <input ref="fileInput" type="file" multiple :accept="ACCEPT" hidden @change="onPick" />
    </header>

    <!-- 书单: 一级内容分组，可与标签和搜索组合筛选 -->
    <section v-if="!paperMode" class="booklist-section">
      <div class="booklist-heading">
        <span>{{ t('library.booklists') }}</span>
        <button class="booklist-text-action" @click="openCreateBooklist">
          <svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M11 13H5a1 1 0 1 1 0-2h6V5a1 1 0 1 1 2 0v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6z"/></svg>
          {{ t('library.newBooklist') }}
        </button>
        <button
          v-if="library.booklists.length"
          class="booklist-text-action"
          @click="openBooklistManage"
        >{{ t('library.manageBooklists') }}</button>
      </div>
      <div class="booklist-row">
        <button
          class="booklist-chip"
          :class="{ active: !activeBooklistId }"
          @click="activeBooklistId = ''"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5a2.5 2.5 0 0 1-2.5 2.5H6.5A2.5 2.5 0 0 1 4 18.5v-13zM6.5 5A.5.5 0 0 0 6 5.5V16.05c.16-.03.32-.05.5-.05H18V5H6.5zM6 18.5a.5.5 0 0 0 .5.5H18v-1H6.5a.5.5 0 0 0-.5.5z"/></svg>
          <span>{{ t('library.allBooks') }}</span>
          <span class="booklist-count">{{ kindBooks.length }}</span>
        </button>
        <button
          v-for="item in library.booklists"
          :key="item.id"
          class="booklist-chip"
          :class="{ active: activeBooklistId === item.id }"
          @click="activeBooklistId = item.id"
        >
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M5 4a2 2 0 0 1 2-2h9a3 3 0 0 1 3 3v15a1 1 0 0 1-1.45.9L12 18.12 6.45 20.9A1 1 0 0 1 5 20V4zm2 0v14.38l4.55-2.28a1 1 0 0 1 .9 0L17 18.38V5a1 1 0 0 0-1-1H7z"/></svg>
          <span>{{ item.name }}</span>
          <span class="booklist-count">{{ booklistCount(item.id) }}</span>
        </button>
      </div>
    </section>

    <!-- 标签筛选 -->
    <div v-if="allTags.length" class="tag-row">
      <button class="tag-chip" :class="{ active: !tagFilter }" :aria-pressed="!tagFilter" @click="tagFilter = ''">{{ t('library.filterAll') }}</button>
      <button
        v-for="tag in allTags"
        :key="tag"
        class="tag-chip"
        :class="{ active: tagFilter === tag }"
        :aria-pressed="tagFilter === tag"
        @click="tagFilter = tagFilter === tag ? '' : tag"
      >{{ tag }}</button>
      <button class="tag-chip tag-manage" :title="t('library.manageTags')" @click="openTagManage">
        <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M16.9 3.1a2.5 2.5 0 0 1 3.54 0l.46.46a2.5 2.5 0 0 1 0 3.54L9.83 18.17a2 2 0 0 1-.9.52l-3.67 1a1 1 0 0 1-1.23-1.23l1-3.67a2 2 0 0 1 .52-.9L16.9 3.1zm2.12 1.42a.5.5 0 0 0-.7 0l-1.1 1.08 1.17 1.18 1.09-1.1a.5.5 0 0 0 0-.7l-.46-.46zM16.97 8.2 15.8 7.03 7 15.84l-.59 2.16 2.16-.59 8.4-9.2z"/></svg>
        {{ t('library.manageTags') }}
      </button>
    </div>

    <div v-if="importing" class="import-bar card" role="status" aria-live="polite">
      <div class="import-text">
        {{ t('library.importing', { name: importState.current, done: importState.done + 1, total: importState.total }) }}
      </div>
      <div class="import-track">
        <div class="import-fill" :style="{ width: `${(importState.done / Math.max(importState.total, 1)) * 100}%` }" />
      </div>
    </div>

    <div v-if="!library.loaded" class="grid" aria-busy="true" :aria-label="t('library.loading')">
      <div v-for="i in 12" :key="i" class="skeleton-card">
        <div class="skeleton skeleton-cover" />
        <div class="skeleton skeleton-line" />
        <div class="skeleton skeleton-line short" />
      </div>
    </div>

    <div v-else-if="!kindBooks.length" class="empty">
      <div class="empty-icon" aria-hidden="true">
        <svg v-if="paperMode" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6M9 9h1"/></svg>
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><path d="M9 7h7M9 11h5"/></svg>
      </div>
      <p class="empty-title">{{ t(paperMode ? 'library.papersEmptyTitle' : 'library.emptyTitle') }}</p>
      <p class="hint">
        <template v-if="paperMode">{{ t('library.papersEmptyHint') }}</template>
        <template v-else>{{ t('library.emptyHint') }}<br />{{ t('library.supportedFormats', { formats: SUPPORTED_EXTS.join(' / ') }) }}</template>
      </p>
      <div class="empty-actions">
        <button class="btn btn-primary" @click="fileInput?.click()">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M11 13H5a1 1 0 1 1 0-2h6V5a1 1 0 1 1 2 0v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6z"/></svg>
          {{ t(paperMode ? 'library.importPapers' : 'library.import') }}
        </button>
        <router-link to="/catalogs" class="btn">{{ t('library.browseCatalogs') }}</router-link>
      </div>
    </div>

    <div
      v-else-if="activeBooklist && !filtered.length && !keyword.trim() && !tagFilter"
      class="empty booklist-empty"
    >
      <div class="empty-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-3.5L5 21V4a1 1 0 0 1 1-1z"/></svg>
      </div>
      <p class="empty-title">{{ t('library.emptyBooklist') }}</p>
      <p class="hint">{{ t('library.emptyBooklistHint') }}</p>
      <div class="empty-actions">
        <button class="btn btn-primary" @click="activeBooklistId = ''; manageMode = true">
          {{ t('library.chooseBooks') }}
        </button>
      </div>
    </div>

    <div v-else-if="!filtered.length" class="empty">
      <div class="empty-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      </div>
      <p class="empty-title">{{ t('reader.noResults') }}</p>
      <div class="empty-actions">
        <button class="btn" @click="keyword = ''; tagFilter = ''">{{ t('common.clear') }}</button>
      </div>
    </div>

    <div v-else class="grid">
      <BookCard
        v-for="book in filtered"
        :key="book.id"
        :book="book"
        :cover-url="library.coverUrls[book.id]"
        :selectable="manageMode"
        :selected="selectedIds.has(book.id)"
        :show-booklists="!paperMode"
        @open="openBook(book)"
        @remove="removeBook(book)"
        @toggle-select="toggleSelect(book.id)"
        @toggle-pin="togglePin(book)"
        @add-to-booklist="openBooklistPicker([book.id])"
      />
    </div>

    <!-- 批量操作栏 -->
    <div v-if="manageMode" class="batch-bar card" role="toolbar" :aria-label="t('library.manage')">
      <span class="batch-count">{{ t('library.selectedCount', { count: selectedIds.size }) }}</span>
      <button class="btn btn-sm" @click="selectAll">
        {{ selectedIds.size === filtered.length && filtered.length ? t('library.deselectAll') : t('library.selectAll') }}
      </button>
      <button class="btn btn-sm" :disabled="!selectedIds.size" @click="batchMoveKind">
        {{ paperMode ? t('library.moveToBooks') : t('library.moveToPapers') }}
      </button>
      <button
        v-if="!paperMode"
        class="btn btn-sm"
        :disabled="!selectedIds.size"
        @click="openBooklistPicker([...selectedIds])"
      >{{ t('library.addToBooklist') }}</button>
      <button
        v-if="activeBooklist"
        class="btn btn-sm"
        :disabled="!selectedIds.size"
        @click="removeSelectedFromBooklist"
      >{{ t('library.removeFromBooklist') }}</button>
      <button class="btn btn-sm" :disabled="!selectedIds.size" @click="batchPin(true)">{{ t('library.pin') }}</button>
      <button class="btn btn-sm" :disabled="!selectedIds.size" @click="batchPin(false)">{{ t('library.unpin') }}</button>
      <button class="btn btn-sm" :disabled="!selectedIds.size" @click="showTagModal = true">{{ t('library.setTags') }}</button>
      <button class="btn btn-sm btn-danger" :disabled="!selectedIds.size" @click="batchDelete">{{ t('common.delete') }}</button>
      <button class="btn btn-sm" @click="toggleManage">{{ t('common.done') }}</button>
    </div>

    <!-- 新建书单 -->
    <div v-if="showBooklistCreate" class="modal-mask" @click.self="showBooklistCreate = false">
      <div class="modal booklist-modal" role="dialog" aria-modal="true" aria-labelledby="booklist-create-title">
        <h3 id="booklist-create-title">{{ t('library.newBooklist') }}</h3>
        <p class="modal-description">{{ t('library.booklistCreateHint') }}</p>
        <input
          v-model="booklistDraft"
          class="input"
          :placeholder="t('library.booklistNamePlaceholder')"
          :aria-label="t('library.booklistNamePlaceholder')"
          maxlength="40"
          autofocus
          @keyup.enter="createBooklist"
        />
        <div class="form-actions">
          <button class="btn btn-sm" @click="showBooklistCreate = false">{{ t('common.cancel') }}</button>
          <button class="btn btn-sm btn-primary" :disabled="!booklistDraft.trim()" @click="createBooklist">
            {{ t('library.createBooklist') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 选择书单 -->
    <div v-if="showBooklistPicker" class="modal-mask" @click.self="showBooklistPicker = false">
      <div class="modal booklist-modal" role="dialog" aria-modal="true" aria-labelledby="booklist-picker-title">
        <h3 id="booklist-picker-title">{{ t('library.chooseBooklist') }}</h3>
        <p class="modal-description">
          {{ t('library.chooseBooklistHint', { count: pickerBookIds.length }) }}
        </p>
        <div v-if="library.booklists.length" class="booklist-picker-list">
          <button
            v-for="item in library.booklists"
            :key="item.id"
            class="booklist-picker-row"
            @click="addPickerBooks(item.id)"
          >
            <span class="booklist-picker-icon">
              <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M5 4a2 2 0 0 1 2-2h9a3 3 0 0 1 3 3v15a1 1 0 0 1-1.45.9L12 18.12 6.45 20.9A1 1 0 0 1 5 20V4zm2 0v14.38l4.55-2.28a1 1 0 0 1 .9 0L17 18.38V5a1 1 0 0 0-1-1H7z"/></svg>
            </span>
            <span class="booklist-picker-name">{{ item.name }}</span>
            <span class="booklist-picker-count">{{ t('library.booklistBooks', { count: booklistCount(item.id) }) }}</span>
            <span class="booklist-picker-add">{{ t('common.add') }}</span>
          </button>
        </div>
        <div class="booklist-create-inline">
          <div class="inline-label">{{ t('library.createNewBooklist') }}</div>
          <div class="inline-fields">
            <input
              v-model="pickerDraft"
              class="input"
              :placeholder="t('library.booklistNamePlaceholder')"
              maxlength="40"
              @keyup.enter="createBooklistAndAdd"
            />
            <button
              class="btn btn-sm btn-primary"
              :disabled="!pickerDraft.trim()"
              @click="createBooklistAndAdd"
            >{{ t('library.createAndAdd') }}</button>
          </div>
        </div>
        <div class="form-actions">
          <button class="btn btn-sm" @click="showBooklistPicker = false">{{ t('common.cancel') }}</button>
        </div>
      </div>
    </div>

    <!-- 管理书单 -->
    <div v-if="showBooklistManage" class="modal-mask" @click.self="showBooklistManage = false">
      <div class="modal booklist-modal" role="dialog" aria-modal="true" aria-labelledby="booklist-manage-title">
        <div class="modal-title-row">
          <h3 id="booklist-manage-title">{{ t('library.manageBooklists') }}</h3>
          <button class="btn btn-sm" @click="showBooklistManage = false; openCreateBooklist()">
            {{ t('library.newBooklist') }}
          </button>
        </div>
        <p class="modal-description">{{ t('library.manageBooklistsHint') }}</p>
        <div class="booklist-manage-list">
          <div v-for="item in library.booklists" :key="item.id" class="booklist-manage-row">
            <input
              v-model="booklistRenames[item.id]"
              class="input"
              maxlength="40"
              @keyup.enter="renameBooklist(item.id)"
            />
            <span class="booklist-manage-count">
              {{ t('library.booklistBooks', { count: booklistCount(item.id) }) }}
            </span>
            <button
              class="btn btn-sm"
              :disabled="!booklistRenames[item.id]?.trim() || booklistRenames[item.id].trim() === item.name"
              @click="renameBooklist(item.id)"
            >{{ t('common.save') }}</button>
            <button class="btn btn-sm btn-danger" @click="deleteBooklist(item.id)">
              {{ t('common.delete') }}
            </button>
          </div>
          <p v-if="!library.booklists.length" class="tag-manage-empty">
            {{ t('library.noBooklists') }}
          </p>
        </div>
        <div class="form-actions">
          <button class="btn btn-sm" @click="showBooklistManage = false">{{ t('common.close') }}</button>
        </div>
      </div>
    </div>

    <!-- 批量标签弹窗 -->
    <div v-if="showTagModal" class="modal-mask" @click.self="showTagModal = false">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="tag-modal-title">
        <h3 id="tag-modal-title">{{ t('library.tagModalTitle', { count: selectedIds.size }) }}</h3>
        <input v-model="tagDraft" class="input full" :placeholder="t('library.tagPlaceholder')" :aria-label="t('library.setTags')" autofocus @keyup.enter="batchTag" />
        <div class="form-actions">
          <button class="btn btn-sm" @click="batchClearTags">{{ t('library.clearTags') }}</button>
          <button class="btn btn-sm" @click="showTagModal = false">{{ t('common.cancel') }}</button>
          <button class="btn btn-sm btn-primary" :disabled="!tagDraft.trim()" @click="batchTag">{{ t('common.add') }}</button>
        </div>
      </div>
    </div>

    <!-- URL 导入弹窗 -->
    <div v-if="showUrlModal" class="modal-mask" @click.self="!urlImporting && (showUrlModal = false)">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="url-modal-title">
        <h3 id="url-modal-title">{{ t('library.urlImportTitle') }}</h3>
        <input
          v-model="urlDraft"
          class="input full"
          type="url"
          inputmode="url"
          :placeholder="t('library.urlPlaceholder')"
          :aria-label="t('library.urlPlaceholder')"
          :disabled="!!urlImporting"
          autofocus
          @keyup.enter="doUrlImport"
        />
        <p class="url-hint">{{ t('library.urlHint') }}</p>
        <div v-if="urlImporting" class="url-progress" role="status">{{ urlImporting }}</div>
        <div class="form-actions">
          <button class="btn btn-sm" :disabled="!!urlImporting" @click="showUrlModal = false">{{ t('common.cancel') }}</button>
          <button class="btn btn-sm btn-primary" :disabled="!urlDraft.trim() || !!urlImporting" @click="doUrlImport">
            {{ urlImporting ? t('common.loading') : t('library.urlDownloadImport') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 分类管理弹窗 -->
    <div v-if="showTagManage" class="modal-mask" @click.self="showTagManage = false">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="tag-manage-title">
        <h3 id="tag-manage-title">{{ t('library.manageTags') }}</h3>
        <div class="tag-manage-list">
          <div v-for="tag in allTags" :key="tag" class="tag-manage-row">
            <input v-model="tagRenames[tag]" class="input" :aria-label="tag" @keyup.enter="renameTag(tag)" />
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
        <div class="form-actions">
          <button class="btn btn-sm" @click="showTagManage = false">{{ t('common.close') }}</button>
        </div>
      </div>
    </div>

    <div v-if="dragging" class="drop-hint" aria-hidden="true">
      <div class="drop-hint-inner">
        <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
        <span>{{ t(paperMode ? 'library.dropHintPapers' : 'library.dropHint') }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.library {
  min-height: 100%;
  padding: 0 28px calc(40px + env(safe-area-inset-bottom));
  position: relative;
}
/* 顶栏吸顶: 长书架滚动时搜索 / 导入随手可及 */
.toolbar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: 0 -28px 18px;
  padding: 16px 28px 12px;
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid transparent;
}
.heading {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}
.toolbar h1 {
  font-size: 20px;
  font-weight: 650;
  letter-spacing: -0.01em;
  white-space: nowrap;
}
.count {
  color: var(--text-3);
  font-size: 13px;
  white-space: nowrap;
}
.spacer {
  flex: 1;
}
.search-field {
  position: relative;
  display: flex;
  align-items: center;
  width: 260px;
  max-width: 100%;
}
.search-icon {
  position: absolute;
  left: 10px;
  color: var(--text-3);
  pointer-events: none;
}
.search {
  width: 100%;
  padding-left: 32px;
  padding-right: 30px;
}
.search-clear {
  position: absolute;
  right: 4px;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-3);
  display: grid;
  place-items: center;
}
.search-clear:hover {
  background: var(--surface-2);
  color: var(--text);
}
.sort {
  width: auto;
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
  background: var(--surface-3);
  overflow: hidden;
}
.import-fill {
  height: 100%;
  background: var(--brand);
  transition: width 0.2s;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 22px 16px;
}
.skeleton-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.skeleton-cover {
  aspect-ratio: 3 / 4.2;
}
.skeleton-line {
  height: 12px;
  border-radius: 4px;
}
.skeleton-line.short {
  width: 60%;
  height: 10px;
}
.booklist-section {
  margin: -2px 0 16px;
  padding: 12px 14px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background:
    linear-gradient(110deg, color-mix(in srgb, var(--brand-light) 55%, transparent), transparent 52%),
    var(--card);
}
.booklist-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
  color: var(--text-3);
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.booklist-text-action {
  border: 0;
  padding: 4px 6px;
  margin: -4px -6px;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text-3);
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0;
  text-transform: none;
}
.booklist-heading > span + .booklist-text-action {
  margin-left: auto;
}
.booklist-text-action:hover {
  color: var(--brand);
  background: var(--brand-soft);
}
.booklist-row {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 1px;
  scrollbar-width: none;
}
.booklist-row::-webkit-scrollbar {
  display: none;
}
.booklist-chip {
  flex: 0 0 auto;
  min-width: 112px;
  height: 38px;
  padding: 0 11px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: color-mix(in srgb, var(--card) 88%, transparent);
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-weight: 500;
  transition:
    border-color var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.booklist-chip:hover {
  border-color: color-mix(in srgb, var(--brand) 46%, var(--border));
  color: var(--text);
}
.booklist-chip:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.booklist-chip.active {
  border-color: color-mix(in srgb, var(--brand) 58%, var(--border));
  background: var(--brand-light);
  color: var(--brand);
}
.booklist-count {
  min-width: 20px;
  margin-left: auto;
  padding: 1px 6px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--text-3) 14%, transparent);
  color: currentColor;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.booklist-empty {
  padding-top: 52px;
}
.tag-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.tag-chip {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--card);
  color: var(--text-2);
  font-size: 12px;
  font-weight: 500;
  transition:
    border-color var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.tag-chip:hover {
  border-color: var(--border-strong);
  color: var(--text);
}
.tag-chip:focus-visible {
  outline: none;
  box-shadow: var(--ring);
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
  height: var(--control-h-sm);
}
.tag-book-count {
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
}
.booklist-modal {
  width: min(560px, 100%);
}
.booklist-modal > .input,
.input.full {
  width: 100%;
}
.modal-description {
  margin: -7px 0 14px;
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.6;
}
.form-actions {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}
.modal-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 7px;
}
.modal-title-row h3 {
  margin: 0;
}
.booklist-picker-list,
.booklist-manage-list {
  max-height: 300px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.booklist-picker-row {
  width: 100%;
  min-height: 44px;
  padding: 6px 9px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--card);
  color: var(--text-2);
  display: flex;
  align-items: center;
  gap: 9px;
  text-align: left;
  transition:
    border-color var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease);
}
.booklist-picker-row:hover {
  border-color: var(--brand);
  background: var(--brand-light);
}
.booklist-picker-row:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.booklist-picker-icon {
  width: 28px;
  height: 28px;
  border-radius: 7px;
  background: var(--brand-light);
  color: var(--brand);
  display: grid;
  place-items: center;
}
.booklist-picker-name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 550;
  color: var(--text);
}
.booklist-picker-count,
.booklist-manage-count {
  color: var(--text-3);
  font-size: 12px;
  white-space: nowrap;
}
.booklist-picker-add {
  color: var(--brand);
  font-size: 12px;
  font-weight: 550;
}
.booklist-create-inline {
  margin-top: 14px;
  padding-top: 13px;
  border-top: 1px solid var(--border);
}
.inline-label {
  margin-bottom: 7px;
  color: var(--text-3);
  font-size: 12px;
}
.inline-fields {
  display: flex;
  gap: 8px;
}
.inline-fields .input {
  min-width: 0;
  flex: 1;
}
.booklist-manage-row {
  display: grid;
  grid-template-columns: minmax(160px, 1fr) auto auto auto;
  align-items: center;
  gap: 8px;
}
.booklist-manage-row .input {
  min-width: 0;
  height: var(--control-h-sm);
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
  min-width: 200px;
  padding: 6px;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-lg);
  animation: menu-in var(--dur) var(--ease);
}
@keyframes menu-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.import-menu button {
  height: 36px;
  border: none;
  background: none;
  border-radius: 6px;
  text-align: left;
  padding: 0 10px;
  font-size: 13px;
  color: var(--text-2);
  display: flex;
  align-items: center;
  gap: 8px;
}
.import-menu button svg {
  color: var(--text-3);
}
.import-menu button:hover,
.import-menu button:focus-visible {
  background: var(--surface-2);
  color: var(--text);
  outline: none;
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
  bottom: calc(16px + env(safe-area-inset-bottom));
  margin-top: 20px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 14px;
  box-shadow: var(--shadow-lg);
  z-index: 10;
  animation: menu-in var(--dur) var(--ease);
}
.batch-count {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  min-width: 70px;
  font-variant-numeric: tabular-nums;
}
.hint {
  font-size: 13px;
  text-align: center;
  line-height: 1.8;
  max-width: 520px;
}
.drop-hint {
  position: absolute;
  inset: 12px;
  z-index: 40;
  border: 2px dashed var(--brand);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--brand) 6%, var(--bg));
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--brand);
  pointer-events: none;
}
.drop-hint-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  font-size: 17px;
  font-weight: 600;
  padding: 24px 32px;
  border-radius: var(--radius-lg);
  background: var(--card);
  box-shadow: var(--shadow-lg);
}

@media (max-width: 720px) {
  .library {
    padding: 0 16px calc(24px + env(safe-area-inset-bottom));
  }
  .toolbar {
    margin: 0 -16px 14px;
    padding: 12px 16px 10px;
    gap: 8px;
  }
  .toolbar h1 {
    font-size: 18px;
  }
  /* 手机端三行: 标题+导入 / 搜索 / 排序+管理 */
  .heading {
    flex: 1;
    min-width: 0;
    order: 1;
  }
  .import-group {
    order: 2;
  }
  .spacer {
    display: none;
  }
  .search-field {
    width: 100%;
    order: 3;
  }
  .sort {
    order: 4;
    flex: 1;
    min-width: 0;
  }
  .toolbar > .btn {
    order: 5;
  }
  .import-main {
    padding-inline: 12px;
  }
  .grid {
    grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
    gap: 16px 12px;
  }
  .booklist-section {
    padding-inline: 11px;
  }
  .booklist-manage-row {
    grid-template-columns: minmax(0, 1fr) auto auto;
  }
  .booklist-manage-count {
    grid-column: 1;
    grid-row: 2;
  }
  .batch-bar {
    bottom: calc(8px + env(safe-area-inset-bottom));
    padding: 8px 10px;
  }
  .drop-hint {
    inset: 8px;
  }
}
</style>
