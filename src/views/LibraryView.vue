<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useLibrary } from '../stores/library'
import { importFiles } from '../services/importer'
import { ACCEPT, SUPPORTED_EXTS } from '../services/format'
import { toast } from '../services/toast'
import { formatReadingTime } from '../composables/useReadingTimer'
import BookCard from '../components/BookCard.vue'
import type { BookMeta } from '../storage'

const router = useRouter()
const library = useLibrary()

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
  const total = library.books.reduce((sum, b) => sum + (b.readingSeconds ?? 0), 0)
  return total >= 60 ? formatReadingTime(total) : ''
})

const allTags = computed(() => {
  const tags = new Set<string>()
  for (const book of library.books) for (const t of book.tags) tags.add(t)
  return [...tags].sort((a, b) => a.localeCompare(b, 'zh'))
})

const filtered = computed(() => {
  let list = library.books
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
  return sorted
})

async function handleFiles(files: FileList | File[]) {
  if (!files.length) return
  importing.value = true
  const results = await importFiles(files, '本地导入', (done, total, current) => {
    importState.value = { done, total, current }
  })
  importing.value = false
  await library.refresh()
  const okCount = results.filter(r => r.ok).length
  const failed = results.filter(r => !r.ok)
  if (okCount) toast(`成功导入 ${okCount} 本书`, 'success')
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
  router.push(book.format === 'pdf' ? `/read-pdf/${book.id}` : `/read/${book.id}`)
}

async function removeBook(book: BookMeta) {
  if (!confirm(`确定从藏书中删除《${book.title}》吗？文件将一并移除。`)) return
  await library.removeBook(book.id)
  toast('已删除', 'success')
}

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
  if (!count || !confirm(`确定删除选中的 ${count} 本书吗？文件将一并移除。`)) return
  for (const id of selectedIds.value) await library.removeBook(id)
  selectedIds.value = new Set()
  toast(`已删除 ${count} 本`, 'success')
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
  toast(`已为 ${selectedIds.value.size} 本书添加标签`, 'success')
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
  toast('已清空所选书籍的标签', 'success')
}
</script>

<template>
  <div
    class="library"
    :class="{ dragging }"
    @dragover.prevent="dragging = true"
    @dragleave.self="dragging = false"
    @drop.prevent="onDrop"
  >
    <header class="toolbar">
      <h1>藏书</h1>
      <span v-if="library.loaded" class="count">
        {{ library.books.length }} 本<template v-if="totalReadingTime"> · 累计阅读 {{ totalReadingTime }}</template>
      </span>
      <div class="spacer" />
      <input v-model="keyword" class="input search" type="search" placeholder="搜索书名 / 作者 / 标签" />
      <select v-model="sortBy" class="input">
        <option value="recent">最近阅读</option>
        <option value="added">最近添加</option>
        <option value="title">书名</option>
        <option value="author">作者</option>
      </select>
      <button v-if="library.books.length" class="btn" :class="{ 'btn-primary': manageMode }" @click="toggleManage">
        {{ manageMode ? '完成' : '管理' }}
      </button>
      <button class="btn btn-primary" @click="fileInput?.click()">
        <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M11 13H5a1 1 0 1 1 0-2h6V5a1 1 0 1 1 2 0v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6z"/></svg>
        导入书籍
      </button>
      <input ref="fileInput" type="file" multiple :accept="ACCEPT" hidden @change="onPick" />
    </header>

    <!-- 标签筛选 -->
    <div v-if="allTags.length" class="tag-row">
      <button class="tag-chip" :class="{ active: !tagFilter }" @click="tagFilter = ''">全部</button>
      <button
        v-for="t in allTags"
        :key="t"
        class="tag-chip"
        :class="{ active: tagFilter === t }"
        @click="tagFilter = tagFilter === t ? '' : t"
      >{{ t }}</button>
    </div>

    <div v-if="importing" class="import-bar card">
      <div class="import-text">
        正在导入 {{ importState.current }} ({{ importState.done + 1 }}/{{ importState.total }})
      </div>
      <div class="import-track">
        <div class="import-fill" :style="{ width: `${(importState.done / Math.max(importState.total, 1)) * 100}%` }" />
      </div>
    </div>

    <div v-if="library.loaded && !library.books.length" class="empty">
      <div class="empty-icon">📚</div>
      <p>书架还是空的</p>
      <p class="hint">点击「导入书籍」或直接把文件拖进来<br />支持 {{ SUPPORTED_EXTS.join(' / ') }}</p>
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
      />
    </div>

    <!-- 批量操作栏 -->
    <div v-if="manageMode" class="batch-bar card">
      <span class="batch-count">已选 {{ selectedIds.size }} 本</span>
      <button class="btn btn-sm" @click="selectAll">
        {{ selectedIds.size === filtered.length && filtered.length ? '取消全选' : '全选' }}
      </button>
      <button class="btn btn-sm" :disabled="!selectedIds.size" @click="showTagModal = true">设置标签</button>
      <button class="btn btn-sm btn-danger" :disabled="!selectedIds.size" @click="batchDelete">删除</button>
      <button class="btn btn-sm" @click="toggleManage">完成</button>
    </div>

    <!-- 批量标签弹窗 -->
    <div v-if="showTagModal" class="modal-mask" @click.self="showTagModal = false">
      <div class="modal">
        <h3>为 {{ selectedIds.size }} 本书设置标签</h3>
        <input v-model="tagDraft" class="input" style="width: 100%" placeholder="多个标签用逗号分隔, 如: 科幻, 待读" @keyup.enter="batchTag" />
        <div class="form-actions" style="margin-top: 16px; display: flex; justify-content: flex-end; gap: 8px">
          <button class="btn btn-sm" @click="batchClearTags">清空标签</button>
          <button class="btn btn-sm" @click="showTagModal = false">取消</button>
          <button class="btn btn-sm btn-primary" :disabled="!tagDraft.trim()" @click="batchTag">添加</button>
        </div>
      </div>
    </div>

    <div v-if="dragging" class="drop-hint">松开导入书籍</div>
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
