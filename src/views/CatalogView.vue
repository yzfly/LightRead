<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { getStorage, type CatalogSourceRec, isTauri } from '../storage'
import {
  downloadToLibrary, fillSearchTemplate, loadOpdsPage,
  type OpdsPage, type OpdsPublication,
} from '../services/opds'
import { arxivRootPage, arxivSearchUrl, isArxivUrl, loadArxivPage } from '../services/arxiv'
import {
  calibreAvailable, importCalibreBook, listCalibreBooks, pickCalibreLibrary,
  calibreCoverUrl, pickBestFormat, type CalibreBook,
} from '../services/calibre'
import { useSettings } from '../stores/settings'
import { useLibrary } from '../stores/library'
import { useRouter } from 'vue-router'
import { toast } from '../services/toast'

const library = useLibrary()
const settings = useSettings()
const router = useRouter()

const sources = ref<CatalogSourceRec[]>([])
const activeSource = ref<CatalogSourceRec | null>(null)
const page = ref<OpdsPage | null>(null)
const loading = ref(false)
const loadError = ref('')
const breadcrumbs = ref<Array<{ title: string; url: string }>>([])
const searchQuery = ref('')
const downloading = ref<Set<string>>(new Set())
const appendLoading = ref(false)

// 添加书源
const showAdd = ref(false)
const newTitle = ref('')
const newUrl = ref('')
const newUsername = ref('')
const newPassword = ref('')

const sourceAuth = () => ({
  username: activeSource.value?.username,
  password: activeSource.value?.password,
})

/** 按书源类型选择加载器 */
function loadPage(url: string) {
  return activeSource.value?.kind === 'arxiv' || isArxivUrl(url)
    ? loadArxivPage(url, sourceAuth())
    : loadOpdsPage(url, sourceAuth())
}

async function refreshSources() {
  const storage = await getStorage()
  sources.value = await storage.listSources()
}

onMounted(() => {
  refreshSources()
  library.refresh()
  if (settings.calibrePath) refreshCalibre()
})

// ---- Calibre 书库直读 (桌面版) ----
const calibreBooks = ref<CalibreBook[]>([])
const calibreCovers = ref<Record<number, string>>({})
const calibreLoading = ref(false)
const calibreBusy = ref<Set<number>>(new Set())
const calibreBatchBusy = ref(false)

/** 已入库判定: 标题+作者与 Calibre 来源匹配 */
const importedTitles = computed(() => new Set(
  library.books.filter(b => b.source === 'Calibre').map(b => b.title)))

async function connectCalibre() {
  const path = await pickCalibreLibrary()
  if (!path) return
  settings.calibrePath = path
  await refreshCalibre()
}

async function refreshCalibre() {
  if (!settings.calibrePath) return
  calibreLoading.value = true
  try {
    calibreBooks.value = await listCalibreBooks(settings.calibrePath)
    // 封面懒加载: 前 100 本, 4 并发
    const queue = calibreBooks.value.filter(b => b.has_cover).slice(0, 100)
    const workers = Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const book = queue.shift()!
        const url = await calibreCoverUrl(settings.calibrePath, book)
        if (url) calibreCovers.value[book.id] = url
      }
    })
    Promise.all(workers)
  } catch (e: any) {
    toast(e?.message ?? '读取 Calibre 书库失败', 'error', 5000)
    calibreBooks.value = []
  } finally {
    calibreLoading.value = false
  }
}

function disconnectCalibre() {
  settings.calibrePath = ''
  calibreBooks.value = []
  for (const url of Object.values(calibreCovers.value)) URL.revokeObjectURL(url)
  calibreCovers.value = {}
}

async function calibreImport(book: CalibreBook, thenOpen = false) {
  if (calibreBusy.value.has(book.id)) return
  calibreBusy.value.add(book.id)
  try {
    const result = await importCalibreBook(settings.calibrePath, book)
    if (!result.ok) throw new Error(result.error)
    await library.refresh()
    if (thenOpen && result.bookId) {
      const imported = library.books.find(b => b.id === result.bookId)
      router.push(imported?.format === 'pdf' ? `/read-pdf/${result.bookId}` : `/read/${result.bookId}`)
    } else {
      toast(`《${book.title}》已入库`, 'success')
    }
  } catch (e: any) {
    toast(`导入失败: ${e?.message}`, 'error', 5000)
  } finally {
    calibreBusy.value.delete(book.id)
  }
}

function openImported(book: CalibreBook) {
  const imported = library.books.find(b => b.source === 'Calibre' && b.title === book.title)
  if (!imported) return
  router.push(imported.format === 'pdf' ? `/read-pdf/${imported.id}` : `/read/${imported.id}`)
}

async function calibreImportAllNew() {
  const fresh = calibreBooks.value.filter(b => !importedTitles.value.has(b.title) && pickBestFormat(b))
  if (!fresh.length) {
    toast('没有新书需要导入')
    return
  }
  if (!confirm(`导入 ${fresh.length} 本新书到藏书？`)) return
  calibreBatchBusy.value = true
  let ok = 0
  for (const book of fresh) {
    const result = await importCalibreBook(settings.calibrePath, book).catch(() => null)
    if (result?.ok) ok++
  }
  calibreBatchBusy.value = false
  await library.refresh()
  toast(`同步完成: 导入 ${ok}/${fresh.length} 本`, 'success', 4000)
}

async function openUrl(url: string, title: string, pushCrumb = true) {
  loading.value = true
  loadError.value = ''
  try {
    const result = await loadPage(url)
    page.value = result
    if (pushCrumb) breadcrumbs.value.push({ title: title || result.title, url })
  } catch (e: any) {
    loadError.value = e?.message ?? '加载失败'
    if (!isTauri()) {
      loadError.value += '。网页版受浏览器跨域限制, 建议使用桌面版, 或在设置中配置跨域代理。'
    }
  } finally {
    loading.value = false
  }
}

function openSource(s: CatalogSourceRec) {
  activeSource.value = s
  breadcrumbs.value = []
  page.value = null
  if (s.kind === 'arxiv') {
    // arXiv 根页面是本地分类导航, 无需网络请求
    page.value = arxivRootPage()
    breadcrumbs.value.push({ title: s.title, url: 'arxiv-root' })
    return
  }
  openUrl(s.url, s.title)
}

function gotoCrumb(i: number) {
  const crumb = breadcrumbs.value[i]
  breadcrumbs.value = breadcrumbs.value.slice(0, i)
  if (crumb.url === 'arxiv-root') {
    page.value = arxivRootPage()
    breadcrumbs.value.push(crumb)
    return
  }
  openUrl(crumb.url, crumb.title)
}

function backToSources() {
  activeSource.value = null
  page.value = null
  breadcrumbs.value = []
  loadError.value = ''
}

async function runSearch() {
  const query = searchQuery.value.trim()
  if (!query || !page.value?.searchUrl) return
  if (page.value.searchUrl === 'arxiv-search') {
    openUrl(arxivSearchUrl(query), `搜索: ${query}`)
    return
  }
  const template = page.value.searchUrl
  if (template.includes('{searchTerms}')) {
    // 直接内联的 OpenSearch 模板
    openUrl(fillSearchTemplate(template, query), `搜索: ${query}`)
    return
  }
  // 指向 OpenSearch description 文档
  try {
    const { getOpenSearch } = await import('foliate-js/opds.js')
    const { fetchXml } = await import('../services/net')
    const doc = await fetchXml(template)
    const os = getOpenSearch(doc)
    const url = os.search(new Map([[null, new Map([['searchTerms', query]])]]))
    openUrl(new URL(url, template).href, `搜索: ${query}`)
  } catch (e: any) {
    toast(`搜索失败: ${e?.message ?? '未知错误'}`, 'error')
  }
}

async function loadMore() {
  if (!page.value?.next || appendLoading.value) return
  appendLoading.value = true
  try {
    const nextPage = await loadPage(page.value.next)
    page.value = {
      ...nextPage,
      title: page.value.title,
      navigation: [...page.value.navigation, ...nextPage.navigation],
      publications: [...page.value.publications, ...nextPage.publications],
      searchUrl: page.value.searchUrl ?? nextPage.searchUrl,
    }
  } catch (e: any) {
    toast(e?.message ?? '加载更多失败', 'error')
  } finally {
    appendLoading.value = false
  }
}

async function download(pub: OpdsPublication, acq: OpdsPublication['acquisitions'][number]) {
  const key = acq.href
  if (downloading.value.has(key)) return
  downloading.value.add(key)
  try {
    await downloadToLibrary(pub, acq, activeSource.value?.title ?? 'OPDS', sourceAuth())
    await library.refresh()
    toast(`《${pub.title}》已入库`, 'success')
  } catch (e: any) {
    toast(`下载失败: ${e?.message ?? '未知错误'}`, 'error', 5000)
  } finally {
    downloading.value.delete(key)
  }
}

async function addSource() {
  const url = newUrl.value.trim()
  if (!url) return
  const storage = await getStorage()
  await storage.addSource({
    title: newTitle.value.trim() || url,
    url,
    kind: isArxivUrl(url) ? 'arxiv' : 'opds',
    builtin: false,
    addedAt: Date.now(),
    username: newUsername.value.trim() || undefined,
    password: newPassword.value || undefined,
  })
  showAdd.value = false
  newTitle.value = ''
  newUrl.value = ''
  newUsername.value = ''
  newPassword.value = ''
  await refreshSources()
  toast('书源已添加', 'success')
}

async function removeSource(s: CatalogSourceRec) {
  if (!confirm(`删除书源「${s.title}」？`)) return
  const storage = await getStorage()
  await storage.deleteSource(s.id)
  await refreshSources()
}
</script>

<template>
  <div class="catalog">
    <!-- 书源列表 -->
    <template v-if="!activeSource">
      <header class="toolbar">
        <h1>书源</h1>
        <div class="spacer" />
        <button class="btn btn-primary" @click="showAdd = true">添加书源</button>
      </header>
      <p class="intro">
        书源使用开放的 <strong>OPDS</strong> 协议——电子书界的 RSS。可接入古登堡计划、Standard Ebooks
        等公版书站点, 也可以连接你自己的 Calibre 内容服务器 (calibre-server / calibre-web)。
      </p>
      <div class="source-grid">
        <div v-for="s in sources" :key="s.id" class="source-card card" @click="openSource(s)">
          <div class="source-title">{{ s.title }}</div>
          <div class="source-url">{{ s.url }}</div>
          <div class="source-foot">
            <span v-if="s.builtin" class="tag">内置</span>
            <button v-else class="btn btn-sm btn-danger" @click.stop="removeSource(s)">删除</button>
          </div>
        </div>
      </div>

      <!-- Calibre 书库直读 (桌面版) -->
      <section v-if="calibreAvailable()" class="calibre-section">
        <header class="toolbar">
          <h2>Calibre 书库</h2>
          <div class="spacer" />
          <template v-if="settings.calibrePath">
            <span class="calibre-path" :title="settings.calibrePath">{{ settings.calibrePath }}</span>
            <button class="btn btn-sm" :disabled="calibreLoading" @click="refreshCalibre">刷新</button>
            <button class="btn btn-sm btn-primary" :disabled="calibreBatchBusy" @click="calibreImportAllNew">
              {{ calibreBatchBusy ? '同步中…' : '导入全部新书' }}
            </button>
            <button class="btn btn-sm btn-danger" @click="disconnectCalibre">断开</button>
          </template>
          <button v-else class="btn btn-primary" @click="connectCalibre">连接 Calibre 书库</button>
        </header>
        <p v-if="!settings.calibrePath" class="intro">
          直接读取本机 Calibre 书库文件夹 (含 metadata.db 的目录), 书目、作者、封面即刻可见,
          点一本即可开始阅读, 也可以一键把新书同步进藏书。
        </p>
        <div v-if="calibreLoading" class="empty">读取书库中…</div>
        <div v-else-if="settings.calibrePath && calibreBooks.length" class="calibre-grid">
          <div v-for="book in calibreBooks" :key="book.id" class="calibre-card card">
            <img v-if="calibreCovers[book.id]" class="calibre-cover" :src="calibreCovers[book.id]" loading="lazy" decoding="async" alt="" />
            <div v-else class="calibre-cover placeholder">📕</div>
            <div class="calibre-info">
              <div class="calibre-title" :title="book.title">{{ book.title }}</div>
              <div class="calibre-authors">{{ book.authors || '佚名' }}</div>
              <div class="calibre-formats">
                <span v-for="f in book.formats" :key="f.format" class="tag">{{ f.format.toUpperCase() }}</span>
              </div>
              <div class="calibre-actions">
                <template v-if="importedTitles.has(book.title)">
                  <button class="btn btn-sm btn-primary" @click="openImported(book)">继续阅读</button>
                </template>
                <template v-else-if="pickBestFormat(book)">
                  <button class="btn btn-sm btn-primary" :disabled="calibreBusy.has(book.id)" @click="calibreImport(book, true)">
                    {{ calibreBusy.has(book.id) ? '打开中…' : '阅读' }}
                  </button>
                  <button class="btn btn-sm" :disabled="calibreBusy.has(book.id)" @click="calibreImport(book)">导入</button>
                </template>
                <span v-else class="no-acq">无可读格式</span>
              </div>
            </div>
          </div>
        </div>
        <div v-else-if="settings.calibrePath" class="empty"><p>书库是空的</p></div>
      </section>
    </template>

    <!-- 目录浏览 -->
    <template v-else>
      <header class="toolbar">
        <button class="btn btn-sm" @click="breadcrumbs.length > 1 ? gotoCrumb(breadcrumbs.length - 2) : backToSources()">
          ← 返回
        </button>
        <nav class="crumbs">
          <button class="crumb" @click="backToSources">书源</button>
          <template v-for="(c, i) in breadcrumbs" :key="i">
            <span class="crumb-sep">/</span>
            <button class="crumb" :class="{ current: i === breadcrumbs.length - 1 }" @click="gotoCrumb(i)">
              {{ c.title }}
            </button>
          </template>
        </nav>
        <div class="spacer" />
        <form v-if="page?.searchUrl" @submit.prevent="runSearch">
          <input v-model="searchQuery" class="input" type="search" placeholder="搜索此书源" />
        </form>
      </header>

      <div v-if="loading" class="empty">加载中…</div>
      <div v-else-if="loadError" class="empty">
        <div class="empty-icon">⚠️</div>
        <p style="max-width: 480px; text-align: center; line-height: 1.8">{{ loadError }}</p>
        <button class="btn" @click="backToSources">返回书源列表</button>
      </div>

      <template v-else-if="page">
        <!-- 子目录 -->
        <div v-if="page.navigation.length" class="nav-grid">
          <button
            v-for="(nav, i) in page.navigation"
            :key="i"
            class="nav-card card"
            @click="openUrl(nav.href, nav.title)"
          >
            <span class="nav-title">{{ nav.title }}</span>
            <span v-if="nav.summary" class="nav-summary">{{ nav.summary }}</span>
          </button>
        </div>

        <!-- 出版物 -->
        <div v-if="page.publications.length" class="pub-list">
          <div v-for="(pub, i) in page.publications" :key="i" class="pub card">
            <img v-if="pub.coverUrl" class="pub-cover" :src="pub.coverUrl" loading="lazy" alt="" />
            <div v-else class="pub-cover placeholder">📖</div>
            <div class="pub-info">
              <div class="pub-title">{{ pub.title }}</div>
              <div class="pub-author">{{ pub.author || '佚名' }}</div>
              <p v-if="pub.summary" class="pub-summary">{{ pub.summary }}</p>
              <div class="pub-actions">
                <button
                  v-for="acq in pub.acquisitions"
                  :key="acq.href"
                  class="btn btn-sm"
                  :disabled="downloading.has(acq.href)"
                  @click="download(pub, acq)"
                >
                  {{ downloading.has(acq.href) ? '下载中…' : `下载 ${acq.label}` }}
                </button>
                <span v-if="!pub.acquisitions.length" class="no-acq">无可下载格式</span>
              </div>
            </div>
          </div>
        </div>

        <div v-if="!page.navigation.length && !page.publications.length" class="empty">
          <p>此目录为空</p>
        </div>

        <div v-if="page.next" class="load-more">
          <button class="btn" :disabled="appendLoading" @click="loadMore">
            {{ appendLoading ? '加载中…' : '加载更多' }}
          </button>
        </div>
      </template>
    </template>

    <!-- 添加书源弹窗 -->
    <div v-if="showAdd" class="modal-mask" @click.self="showAdd = false">
      <div class="modal">
        <h3>添加 OPDS 书源</h3>
        <div class="form-row">
          <label>名称</label>
          <input v-model="newTitle" class="input" placeholder="如: 我的 Calibre 书库" />
        </div>
        <div class="form-row">
          <label>OPDS 地址</label>
          <input v-model="newUrl" class="input" placeholder="https://example.com/opds" />
        </div>
        <div class="form-row-pair">
          <div class="form-row">
            <label>用户名 (可选)</label>
            <input v-model="newUsername" class="input" autocomplete="off" />
          </div>
          <div class="form-row">
            <label>密码 (可选)</label>
            <input v-model="newPassword" class="input" type="password" autocomplete="new-password" />
          </div>
        </div>
        <p class="form-hint">
          常见地址: calibre-web 为 <code>http://主机:8083/opds</code>,
          calibre 内容服务器为 <code>http://主机:8080/opds</code>。
          需要登录的书源 (如 calibre-web) 填写用户名密码, 以 HTTP Basic 方式鉴权。
        </p>
        <div class="form-actions">
          <button class="btn" @click="showAdd = false">取消</button>
          <button class="btn btn-primary" :disabled="!newUrl.trim()" @click="addSource">添加</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.catalog {
  padding: 24px 28px 40px;
  min-height: 100%;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 18px;
  flex-wrap: wrap;
}
.toolbar h1 {
  font-size: 20px;
}
.spacer {
  flex: 1;
}
.intro {
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.8;
  margin-bottom: 20px;
  max-width: 640px;
}
.source-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 14px;
}
.source-card {
  padding: 16px;
  cursor: pointer;
  transition: box-shadow 0.15s;
}
.source-card:hover {
  box-shadow: var(--shadow-lg);
}
.source-title {
  font-weight: 500;
  margin-bottom: 6px;
}
.source-url {
  font-size: 12px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-bottom: 10px;
}
.source-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  min-height: 24px;
}
.crumbs {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  min-width: 0;
}
.crumb {
  border: none;
  background: none;
  color: var(--brand);
  font-size: 13px;
  padding: 2px 4px;
  border-radius: 4px;
}
.crumb:hover {
  background: var(--brand-light);
}
.crumb.current {
  color: var(--text);
  font-weight: 500;
}
.crumb-sep {
  color: var(--text-3);
  font-size: 12px;
}
.nav-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
  margin-bottom: 20px;
}
.nav-card {
  padding: 12px 14px;
  border: none;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 4px;
  cursor: pointer;
}
.nav-card:hover {
  box-shadow: var(--shadow-lg);
}
.nav-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--text);
}
.nav-summary {
  font-size: 12px;
  color: var(--text-3);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.pub-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.pub {
  display: flex;
  gap: 16px;
  padding: 14px;
}
.pub-cover {
  width: 84px;
  height: 118px;
  object-fit: cover;
  border-radius: 6px;
  flex-shrink: 0;
  background: var(--bg);
}
.pub-cover.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 30px;
}
.pub-info {
  min-width: 0;
  flex: 1;
}
.pub-title {
  font-weight: 500;
  margin-bottom: 4px;
}
.pub-author {
  font-size: 13px;
  color: var(--text-3);
  margin-bottom: 6px;
}
.pub-summary {
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.7;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin-bottom: 10px;
}
.pub-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.no-acq {
  font-size: 12px;
  color: var(--text-3);
}
.load-more {
  display: flex;
  justify-content: center;
  padding: 20px;
}
.form-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}
.form-row-pair {
  display: flex;
  gap: 10px;
}
.form-row-pair .form-row {
  flex: 1;
}
.form-row label {
  font-size: 13px;
  color: var(--text-2);
}
.form-hint {
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.7;
  margin-bottom: 16px;
}
.form-hint code {
  background: var(--bg);
  padding: 1px 5px;
  border-radius: 4px;
}
.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* Calibre 书库 */
.calibre-section {
  margin-top: 32px;
}
.calibre-section h2 {
  font-size: 16px;
}
.calibre-path {
  font-size: 12px;
  color: var(--text-3);
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.calibre-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
}
.calibre-card {
  display: flex;
  gap: 12px;
  padding: 12px;
}
.calibre-cover {
  width: 72px;
  height: 100px;
  object-fit: cover;
  border-radius: 4px;
  flex-shrink: 0;
  background: var(--bg);
}
.calibre-cover.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 26px;
}
.calibre-info {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.calibre-title {
  font-weight: 500;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.calibre-authors {
  font-size: 12px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.calibre-formats {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.calibre-actions {
  display: flex;
  gap: 6px;
  margin-top: auto;
}
</style>
