<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { getStorage, type CatalogSourceRec, isTauri } from '../storage'
import {
  downloadToLibrary, fillSearchTemplate, loadOpdsPage, searchGutenberg,
  type OpdsPage, type OpdsPublication,
} from '../services/opds'
import { arxivRootPage, arxivSearchUrl, isArxivUrl, loadArxivPage } from '../services/arxiv'
import {
  calibreAvailable, importCalibreBook, listCalibreBooks, pickCalibreLibrary,
  calibreCoverUrl, pickBestFormat, type CalibreBook,
} from '../services/calibre'
import {
  searchGithubBooks, isValidRepo, fmtBytes, fetchCommunityRepos,
  BUNDLED_COMMUNITY, COMMUNITY_LIST_PAGE,
  type GithubBookHit, type CommunityRepo,
} from '../services/githubBooks'
import { openDownload } from '../services/updater'
import { arxivSearchUrl as arxivSearchUrlOf, loadArxivPage as loadArxivPageOf } from '../services/arxiv'
import { importFromUrl } from '../services/urlImport'
import { useSettings } from '../stores/settings'
import { useLibrary } from '../stores/library'
import { useRouter } from 'vue-router'
import { toast } from '../services/toast'
import { t } from '../i18n'

const library = useLibrary()
const settings = useSettings()
const router = useRouter()

// ---- GitHub 书库: 社区清单 + 用户自加 ----
const communityRepos = ref<CommunityRepo[]>(BUNDLED_COMMUNITY.repos)
const communityUpdated = ref(BUNDLED_COMMUNITY.updated)
const communityFromRemote = ref(false)
const ghImporting = ref('')
const ghProgress = ref('')
const ghRepoDraft = ref('')

const allGhRepos = () => [
  ...new Set([...communityRepos.value.map(r => r.repo), ...settings.githubBookRepos]),
]

async function refreshCommunity(force = false) {
  const result = await fetchCommunityRepos(force)
  communityRepos.value = result.repos
  communityUpdated.value = result.updated
  communityFromRemote.value = result.fromRemote
  if (!force) return
  if (result.fromRemote) {
    toast(t('catalog.communityRefreshed', { n: result.repos.length, date: result.updated }), 'success')
  } else {
    toast(t('catalog.communityRefreshFailed', { date: result.updated }), 'error', 5000)
  }
}

function addGhRepo() {
  const repo = ghRepoDraft.value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/$/, '')
  if (!isValidRepo(repo)) {
    toast(t('library.ghRepoInvalid'), 'error')
    return
  }
  if (!settings.githubBookRepos.includes(repo) && !communityRepos.value.some(r => r.repo === repo)) {
    settings.githubBookRepos.push(repo)
  }
  ghRepoDraft.value = ''
}

function removeGhRepo(repo: string) {
  settings.githubBookRepos = settings.githubBookRepos.filter(r => r !== repo)
}

async function importGhBook(hit: GithubBookHit) {
  if (ghImporting.value) return
  ghImporting.value = hit.url
  try {
    const result = await importFromUrl(hit.url, p => {
      ghProgress.value = p.fraction != null
        ? t('library.urlDownloading', { pct: (p.fraction * 100).toFixed(0), mb: p.receivedMB })
        : t('library.urlDownloadingMB', { mb: p.receivedMB })
    })
    if (!result.ok) throw new Error(result.error)
    await library.refresh()
    toast(t('library.importSuccess', { count: 1 }), 'success')
  } catch (e: any) {
    toast(t('library.urlImportFailed', { msg: e?.message ?? e }), 'error', 6000)
  } finally {
    ghImporting.value = ''
    ghProgress.value = ''
  }
}

// ---- 统一搜书: GitHub 书库 / 古登堡计划 / arXiv ----
const uniQuery = ref('')
const uniScopes = reactive({ github: true, gutenberg: true, arxiv: false })
const uniSearching = ref(false)
const uniSearched = ref(false)
const uniErrors = ref<string[]>([])
const uniGithub = ref<GithubBookHit[]>([])
const uniGutenberg = ref<OpdsPublication[]>([])
const uniArxiv = ref<OpdsPublication[]>([])
let uniSession = 0

async function uniSearch() {
  const query = uniQuery.value.trim()
  if (!query || uniSearching.value) return
  const session = ++uniSession
  uniSearching.value = true
  uniErrors.value = []
  uniGithub.value = []
  uniGutenberg.value = []
  uniArxiv.value = []
  const jobs: Promise<void>[] = []
  if (uniScopes.github) {
    jobs.push(searchGithubBooks(allGhRepos(), query).then(r => {
      if (session !== uniSession) return
      uniGithub.value = r.hits
      if (r.errors.length) uniErrors.value.push(...r.errors.map(x => `${x.repo}: ${x.message}`))
    }).catch(e => { uniErrors.value.push(`GitHub: ${e?.message ?? e}`) }))
  }
  if (uniScopes.gutenberg) {
    jobs.push(searchGutenberg(query, 24).then(pubs => {
      if (session !== uniSession) return
      uniGutenberg.value = pubs
    }).catch(e => { uniErrors.value.push(`Gutenberg: ${e?.message ?? e}`) }))
  }
  if (uniScopes.arxiv) {
    jobs.push(loadArxivPageOf(arxivSearchUrlOf(query)).then(p => {
      if (session !== uniSession) return
      uniArxiv.value = (p.publications ?? []).slice(0, 20)
    }).catch(e => { uniErrors.value.push(`arXiv: ${e?.message ?? e}`) }))
  }
  await Promise.allSettled(jobs)
  if (session === uniSession) {
    uniSearched.value = true
    uniSearching.value = false
  }
}

/** 统一搜书里下载 OPDS/arXiv 出版物 */
async function uniDownloadPub(pub: OpdsPublication, acq: OpdsPublication['acquisitions'][number], sourceTitle: string) {
  if (downloading.value.has(acq.href)) return
  downloading.value.add(acq.href)
  try {
    await downloadToLibrary(pub, acq, sourceTitle, undefined, sourceTitle === 'arXiv' ? 'paper' : undefined)
    await library.refresh()
    toast(t('library.importSuccess', { count: 1 }), 'success')
  } catch (e: any) {
    toast(t('library.urlImportFailed', { msg: e?.message ?? e }), 'error', 6000)
  } finally {
    downloading.value.delete(acq.href)
  }
}

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
  refreshCommunity()
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
    toast(e?.message ?? t('catalog.calibreReadFailed'), 'error', 5000)
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
      router.push(imported?.format === 'pdf' ? `/read-paper/${result.bookId}` : `/read/${result.bookId}`)
    } else {
      toast(t('catalog.bookImported', { title: book.title }), 'success')
    }
  } catch (e: any) {
    toast(t('catalog.importFailed', { msg: e?.message }), 'error', 5000)
  } finally {
    calibreBusy.value.delete(book.id)
  }
}

function openImported(book: CalibreBook) {
  const imported = library.books.find(b => b.source === 'Calibre' && b.title === book.title)
  if (!imported) return
  router.push(imported.format === 'pdf' ? `/read-paper/${imported.id}` : `/read/${imported.id}`)
}

async function calibreImportAllNew() {
  const fresh = calibreBooks.value.filter(b => !importedTitles.value.has(b.title) && pickBestFormat(b))
  if (!fresh.length) {
    toast(t('catalog.noNewBooks'))
    return
  }
  if (!confirm(t('catalog.importNewConfirm', { count: fresh.length }))) return
  calibreBatchBusy.value = true
  let ok = 0
  for (const book of fresh) {
    const result = await importCalibreBook(settings.calibrePath, book).catch(() => null)
    if (result?.ok) ok++
  }
  calibreBatchBusy.value = false
  await library.refresh()
  toast(t('catalog.syncDone', { ok, total: fresh.length }), 'success', 4000)
}

async function openUrl(url: string, title: string, pushCrumb = true) {
  loading.value = true
  loadError.value = ''
  try {
    const result = await loadPage(url)
    page.value = result
    if (pushCrumb) breadcrumbs.value.push({ title: title || result.title, url })
  } catch (e: any) {
    loadError.value = e?.message ?? t('catalog.loadFailed')
    if (!isTauri()) {
      loadError.value += t('catalog.corsHint')
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
    openUrl(arxivSearchUrl(query), t('catalog.searchCrumb', { query }))
    return
  }
  const template = page.value.searchUrl
  if (template.includes('{searchTerms}')) {
    // 直接内联的 OpenSearch 模板
    openUrl(fillSearchTemplate(template, query), t('catalog.searchCrumb', { query }))
    return
  }
  // 指向 OpenSearch description 文档
  try {
    const { getOpenSearch } = await import('foliate-js/opds.js')
    const { fetchXml } = await import('../services/net')
    const doc = await fetchXml(template)
    const os = getOpenSearch(doc)
    const url = os.search(new Map([[null, new Map([['searchTerms', query]])]]))
    openUrl(new URL(url, template).href, t('catalog.searchCrumb', { query }))
  } catch (e: any) {
    toast(t('catalog.searchFailed', { msg: e?.message ?? t('common.unknownError') }), 'error')
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
    toast(e?.message ?? t('catalog.loadMoreFailed'), 'error')
  } finally {
    appendLoading.value = false
  }
}

async function download(pub: OpdsPublication, acq: OpdsPublication['acquisitions'][number]) {
  const key = acq.href
  if (downloading.value.has(key)) return
  downloading.value.add(key)
  try {
    await downloadToLibrary(
      pub, acq, activeSource.value?.title ?? 'OPDS', sourceAuth(),
      activeSource.value?.kind === 'arxiv' ? 'paper' : undefined,
    )
    await library.refresh()
    toast(t('catalog.bookImported', { title: pub.title }), 'success')
  } catch (e: any) {
    toast(t('catalog.downloadFailed', { msg: e?.message ?? t('common.unknownError') }), 'error', 5000)
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
  toast(t('catalog.sourceAdded'), 'success')
}

async function removeSource(s: CatalogSourceRec) {
  if (!confirm(t('catalog.deleteSourceConfirm', { title: s.title }))) return
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
        <h1>{{ t('catalog.title') }}</h1>
        <div class="spacer" />
        <button class="btn btn-primary" @click="showAdd = true">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M11 13H5a1 1 0 1 1 0-2h6V5a1 1 0 1 1 2 0v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6z"/></svg>
          {{ t('catalog.add') }}
        </button>
      </header>
      <p class="intro">
        {{ t('catalog.intro') }}
      </p>
      <div class="source-grid">
        <div
          v-for="s in sources"
          :key="s.id"
          class="source-card card"
          role="button"
          tabindex="0"
          @click="openSource(s)"
          @keydown.enter.prevent="openSource(s)"
          @keydown.space.prevent="openSource(s)"
        >
          <div class="source-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1.5" fill="currentColor" stroke="none"/></svg>
          </div>
          <div class="source-body">
            <div class="source-title">{{ s.title }}</div>
            <div class="source-url">{{ s.url }}</div>
            <div class="source-foot">
              <span v-if="s.builtin" class="tag">{{ t('catalog.builtin') }}</span>
              <button v-else class="btn btn-sm btn-danger" @click.stop="removeSource(s)" @keydown.stop>{{ t('common.delete') }}</button>
            </div>
          </div>
          <svg class="source-chevron" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M9.3 6.3a1 1 0 0 1 1.4 0l5 5a1 1 0 0 1 0 1.4l-5 5a1 1 0 0 1-1.4-1.4L13.58 12 9.3 7.7a1 1 0 0 1 0-1.4z"/></svg>
        </div>
      </div>

      <!-- 统一搜书 -->
      <section class="uni-section card">
        <h2>{{ t('catalog.uniTitle') }}</h2>
        <div class="gh-search-row">
          <input
            v-model="uniQuery"
            class="input"
            type="search"
            :placeholder="t('catalog.uniPlaceholder')"
            :aria-label="t('catalog.uniTitle')"
            @keyup.enter="uniSearch"
          />
          <button class="btn btn-primary" :disabled="uniSearching" @click="uniSearch">
            {{ uniSearching ? t('library.ghSearching') : t('library.ghSearch') }}
          </button>
        </div>
        <div class="uni-scopes">
          <label class="check-chip" :class="{ on: uniScopes.github }"><input v-model="uniScopes.github" type="checkbox" /> GitHub</label>
          <label class="check-chip" :class="{ on: uniScopes.gutenberg }"><input v-model="uniScopes.gutenberg" type="checkbox" /> {{ t('catalog.gutenberg') }}</label>
          <label class="check-chip" :class="{ on: uniScopes.arxiv }"><input v-model="uniScopes.arxiv" type="checkbox" /> arXiv</label>
        </div>
        <div v-if="uniErrors.length" class="gh-notice" role="alert">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M10.3 3.9a2 2 0 0 1 3.4 0l8 13.6A2 2 0 0 1 20 20.5H4a2 2 0 0 1-1.7-3l8-13.6zM12 9a1 1 0 0 0-1 1v4a1 1 0 1 0 2 0v-4a1 1 0 0 0-1-1zm0 9.2a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4z"/></svg>
          {{ uniErrors.join('; ') }}
        </div>
        <div v-if="ghProgress" class="gh-progress" role="status">{{ ghProgress }}</div>

        <template v-if="uniSearched">
          <div v-if="uniScopes.github" class="uni-group">
            <div class="uni-group-head">GitHub · {{ t('reader.resultCount', { n: uniGithub.length }) }}</div>
            <div v-for="hit in uniGithub.slice(0, 60)" :key="hit.url" class="gh-item" :class="{ busy: ghImporting === hit.url }" role="button" tabindex="0" @click="importGhBook(hit)" @keydown.enter.prevent="importGhBook(hit)">
              <span class="gh-name">{{ hit.name }}</span>
              <span class="gh-meta">{{ hit.repo }}<template v-if="hit.size"> · {{ fmtBytes(hit.size) }}</template></span>
            </div>
          </div>
          <div v-if="uniScopes.gutenberg" class="uni-group">
            <div class="uni-group-head">{{ t('catalog.gutenberg') }} · {{ t('reader.resultCount', { n: uniGutenberg.length }) }}</div>
            <div v-for="(pub, i) in uniGutenberg" :key="i" class="gh-item uni-pub">
              <span class="gh-name">{{ pub.title }}</span>
              <span class="gh-meta">{{ pub.author || t('common.anonymous') }}</span>
              <span class="uni-acts">
                <button
                  v-for="acq in pub.acquisitions.slice(0, 2)"
                  :key="acq.href"
                  class="btn btn-sm"
                  :disabled="downloading.has(acq.href)"
                  @click.stop="uniDownloadPub(pub, acq, t('catalog.gutenberg'))"
                >{{ downloading.has(acq.href) ? t('catalog.downloading') : acq.label }}</button>
              </span>
            </div>
          </div>
          <div v-if="uniScopes.arxiv" class="uni-group">
            <div class="uni-group-head">arXiv · {{ t('reader.resultCount', { n: uniArxiv.length }) }}</div>
            <div v-for="(pub, i) in uniArxiv" :key="i" class="gh-item uni-pub">
              <span class="gh-name">{{ pub.title }}</span>
              <span class="gh-meta">{{ pub.author || '' }}</span>
              <span class="uni-acts">
                <button
                  v-for="acq in pub.acquisitions.slice(0, 1)"
                  :key="acq.href"
                  class="btn btn-sm"
                  :disabled="downloading.has(acq.href)"
                  @click.stop="uniDownloadPub(pub, acq, 'arXiv')"
                >{{ downloading.has(acq.href) ? t('catalog.downloading') : acq.label }}</button>
              </span>
            </div>
          </div>
        </template>
      </section>

      <!-- GitHub 书源列表 (社区共建) -->
      <section class="gh-section">
        <header class="toolbar">
          <h2>{{ t('catalog.ghListTitle') }}</h2>
          <span class="gh-updated">{{ t('catalog.communityMeta', { date: communityUpdated, n: communityRepos.length }) }}{{ communityFromRemote ? '' : t('catalog.communityBundled') }}</span>
          <div class="spacer" />
          <button class="btn btn-sm" @click="refreshCommunity(true)">{{ t('catalog.updateList') }}</button>
          <button class="btn btn-sm" @click="openDownload(COMMUNITY_LIST_PAGE)">{{ t('catalog.contribute') }}</button>
        </header>
        <p class="intro">{{ t('catalog.ghListIntro') }}</p>
        <div class="gh-repos">
          <span v-for="item in communityRepos" :key="item.repo" class="gh-repo-chip community" :title="item.note ?? ''">
            {{ item.repo }}
          </span>
        </div>
        <div class="gh-repos">
          <span v-for="repo in settings.githubBookRepos" :key="repo" class="gh-repo-chip">
            {{ repo }}
            <button class="gh-repo-del" :title="t('common.delete')" :aria-label="`${t('common.delete')} ${repo}`" @click="removeGhRepo(repo)">
              <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M6.7 5.3a1 1 0 0 0-1.4 1.4L10.6 12l-5.3 5.3a1 1 0 1 0 1.4 1.4l5.3-5.3 5.3 5.3a1 1 0 0 0 1.4-1.4L13.4 12l5.3-5.3a1 1 0 0 0-1.4-1.4L12 10.6 6.7 5.3z"/></svg>
            </button>
          </span>
          <input
            v-model="ghRepoDraft"
            class="input gh-repo-add"
            :placeholder="t('library.ghAddRepo')"
            :aria-label="t('library.ghAddRepo')"
            @keyup.enter="addGhRepo"
          />
        </div>
      </section>

      <!-- Calibre 书库直读 (桌面版) -->
      <section v-if="calibreAvailable()" class="calibre-section">
        <header class="toolbar">
          <h2>{{ t('catalog.calibreTitle') }}</h2>
          <div class="spacer" />
          <template v-if="settings.calibrePath">
            <span class="calibre-path" :title="settings.calibrePath">{{ settings.calibrePath }}</span>
            <button class="btn btn-sm" :disabled="calibreLoading" @click="refreshCalibre">{{ t('common.refresh') }}</button>
            <button class="btn btn-sm btn-primary" :disabled="calibreBatchBusy" @click="calibreImportAllNew">
              {{ calibreBatchBusy ? t('catalog.syncing') : t('catalog.importAllNew') }}
            </button>
            <button class="btn btn-sm btn-danger" @click="disconnectCalibre">{{ t('catalog.disconnect') }}</button>
          </template>
          <button v-else class="btn btn-primary" @click="connectCalibre">{{ t('catalog.connectCalibre') }}</button>
        </header>
        <p v-if="!settings.calibrePath" class="intro">
          {{ t('catalog.calibreIntro') }}
        </p>
        <div v-if="calibreLoading" class="empty">{{ t('catalog.readingLibrary') }}</div>
        <div v-else-if="settings.calibrePath && calibreBooks.length" class="calibre-grid">
          <div v-for="book in calibreBooks" :key="book.id" class="calibre-card card">
            <img v-if="calibreCovers[book.id]" class="calibre-cover" :src="calibreCovers[book.id]" loading="lazy" decoding="async" alt="" />
            <div v-else class="calibre-cover placeholder" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
            </div>
            <div class="calibre-info">
              <div class="calibre-title" :title="book.title">{{ book.title }}</div>
              <div class="calibre-authors">{{ book.authors || t('common.anonymous') }}</div>
              <div class="calibre-formats">
                <span v-for="f in book.formats" :key="f.format" class="tag">{{ f.format.toUpperCase() }}</span>
              </div>
              <div class="calibre-actions">
                <template v-if="importedTitles.has(book.title)">
                  <button class="btn btn-sm btn-primary" @click="openImported(book)">{{ t('catalog.continueReading') }}</button>
                </template>
                <template v-else-if="pickBestFormat(book)">
                  <button class="btn btn-sm btn-primary" :disabled="calibreBusy.has(book.id)" @click="calibreImport(book, true)">
                    {{ calibreBusy.has(book.id) ? t('catalog.opening') : t('catalog.read') }}
                  </button>
                  <button class="btn btn-sm" :disabled="calibreBusy.has(book.id)" @click="calibreImport(book)">{{ t('catalog.import') }}</button>
                </template>
                <span v-else class="no-acq">{{ t('catalog.noReadableFormat') }}</span>
              </div>
            </div>
          </div>
        </div>
        <div v-else-if="settings.calibrePath" class="empty"><p>{{ t('catalog.libraryEmpty') }}</p></div>
      </section>
    </template>

    <!-- 目录浏览 -->
    <template v-else>
      <header class="toolbar">
        <button class="btn btn-sm" @click="breadcrumbs.length > 1 ? gotoCrumb(breadcrumbs.length - 2) : backToSources()">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M14.7 6.3a1 1 0 0 1 0 1.4L10.42 12l4.3 4.3a1 1 0 0 1-1.42 1.4l-5-5a1 1 0 0 1 0-1.4l5-5a1 1 0 0 1 1.42 0z"/></svg>
          {{ t('common.back') }}
        </button>
        <nav class="crumbs" aria-label="Breadcrumb">
          <button class="crumb" @click="backToSources">{{ t('catalog.title') }}</button>
          <template v-for="(c, i) in breadcrumbs" :key="i">
            <span class="crumb-sep">/</span>
            <button class="crumb" :class="{ current: i === breadcrumbs.length - 1 }" :aria-current="i === breadcrumbs.length - 1 ? 'page' : undefined" @click="gotoCrumb(i)">
              {{ c.title }}
            </button>
          </template>
        </nav>
        <div class="spacer" />
        <form v-if="page?.searchUrl" @submit.prevent="runSearch">
          <input v-model="searchQuery" class="input" type="search" :placeholder="t('catalog.searchThisSource')" :aria-label="t('catalog.searchThisSource')" />
        </form>
      </header>

      <div v-if="loading" class="empty" role="status" aria-busy="true">
        <div class="empty-icon spinner" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9" /></svg>
        </div>
        <p class="hint">{{ t('common.loading') }}</p>
      </div>
      <div v-else-if="loadError" class="empty">
        <div class="empty-icon danger" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9a2 2 0 0 1 3.4 0l8 13.6A2 2 0 0 1 20 20.5H4a2 2 0 0 1-1.7-3l8-13.6z"/><path d="M12 9v5m0 3.5h.01"/></svg>
        </div>
        <p class="hint" style="max-width: 480px">{{ loadError }}</p>
        <div class="empty-actions">
          <button class="btn" @click="backToSources">{{ t('catalog.backToSources') }}</button>
        </div>
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
            <div v-else class="pub-cover placeholder" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2V4zm20 0h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7V4z"/></svg>
            </div>
            <div class="pub-info">
              <div class="pub-title">{{ pub.title }}</div>
              <div class="pub-author">{{ pub.author || t('common.anonymous') }}</div>
              <p v-if="pub.summary" class="pub-summary">{{ pub.summary }}</p>
              <div class="pub-actions">
                <button
                  v-for="acq in pub.acquisitions"
                  :key="acq.href"
                  class="btn btn-sm"
                  :disabled="downloading.has(acq.href)"
                  @click="download(pub, acq)"
                >
                  {{ downloading.has(acq.href) ? t('catalog.downloading') : t('catalog.download', { label: acq.label }) }}
                </button>
                <span v-if="!pub.acquisitions.length" class="no-acq">{{ t('catalog.noDownloadFormat') }}</span>
              </div>
            </div>
          </div>
        </div>

        <div v-if="!page.navigation.length && !page.publications.length" class="empty">
          <p>{{ t('catalog.thisDirEmpty') }}</p>
        </div>

        <div v-if="page.next" class="load-more">
          <button class="btn" :disabled="appendLoading" @click="loadMore">
            {{ appendLoading ? t('common.loading') : t('catalog.loadMore') }}
          </button>
        </div>
      </template>
    </template>

    <!-- 添加书源弹窗 -->
    <div v-if="showAdd" class="modal-mask" @click.self="showAdd = false" @keydown.esc="showAdd = false">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="add-source-title">
        <h3 id="add-source-title">{{ t('catalog.addModalTitle') }}</h3>
        <div class="form-row">
          <label for="src-name">{{ t('catalog.name') }}</label>
          <input id="src-name" v-model="newTitle" class="input" :placeholder="t('catalog.namePlaceholder')" autofocus />
        </div>
        <div class="form-row">
          <label for="src-url">{{ t('catalog.opdsUrl') }}</label>
          <input id="src-url" v-model="newUrl" class="input" type="url" inputmode="url" placeholder="https://example.com/opds" />
        </div>
        <div class="form-row-pair">
          <div class="form-row">
            <label for="src-user">{{ t('common.usernameOptional') }}</label>
            <input id="src-user" v-model="newUsername" class="input" autocomplete="off" />
          </div>
          <div class="form-row">
            <label for="src-pass">{{ t('common.passwordOptional') }}</label>
            <input id="src-pass" v-model="newPassword" class="input" type="password" autocomplete="new-password" />
          </div>
        </div>
        <p class="form-hint">
          {{ t('catalog.hintCommon') }} <code>http://host:8083/opds</code>{{ t('catalog.hintServer') }}
          <code>http://host:8080/opds</code>{{ t('catalog.hintAuth') }}
        </p>
        <div class="form-actions">
          <button class="btn" @click="showAdd = false">{{ t('common.cancel') }}</button>
          <button class="btn btn-primary" :disabled="!newUrl.trim()" @click="addSource">{{ t('common.add') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.catalog {
  padding: 24px 28px calc(40px + env(safe-area-inset-bottom));
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
  font-weight: 650;
  letter-spacing: -0.01em;
}
.toolbar h2,
.uni-section h2 {
  font-size: 15px;
  font-weight: 650;
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
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 14px 14px 16px;
  cursor: pointer;
  transition:
    box-shadow var(--dur) var(--ease),
    border-color var(--dur) var(--ease),
    transform var(--dur) var(--ease);
}
.source-card:hover {
  box-shadow: var(--shadow-md);
  border-color: color-mix(in srgb, var(--brand) 30%, var(--border));
  transform: translateY(-1px);
}
.source-card:focus-visible {
  outline: none;
  box-shadow: var(--ring), var(--shadow-md);
}
.source-icon {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border-radius: 10px;
  display: grid;
  place-items: center;
  background: var(--brand-light);
  color: var(--brand);
}
.source-body {
  flex: 1;
  min-width: 0;
}
.source-chevron {
  color: var(--text-3);
  flex-shrink: 0;
  margin-top: 9px;
  transition: transform var(--dur) var(--ease), color var(--dur) var(--ease);
}
.source-card:hover .source-chevron {
  color: var(--brand);
  transform: translateX(2px);
}
.source-title {
  font-weight: 600;
  margin-bottom: 3px;
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
  padding: 4px 6px;
  border-radius: 4px;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 4px;
  cursor: pointer;
  transition:
    box-shadow var(--dur) var(--ease),
    border-color var(--dur) var(--ease);
}
.nav-card:hover {
  box-shadow: var(--shadow-md);
  border-color: color-mix(in srgb, var(--brand) 30%, var(--border));
}
.nav-card:focus-visible {
  outline: none;
  box-shadow: var(--ring), var(--shadow-md);
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
  background: var(--surface-2);
}
.pub-cover.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
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
  font-family: var(--font-mono);
  font-size: 0.92em;
  background: var(--surface-2);
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
  background: var(--surface-2);
}
.calibre-cover.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
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

.gh-section {
  margin-top: 28px;
}
.gh-section h2 {
  font-size: 16px;
}
.gh-search-row {
  display: flex;
  gap: 8px;
  max-width: 560px;
}
.gh-search-row .input {
  flex: 1;
}
.gh-repos {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
  margin-top: 10px;
}
.gh-repo-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 14px;
  font-size: 12px;
  color: var(--text-2);
  background: var(--card);
}
.gh-repo-del {
  border: none;
  background: none;
  color: var(--text-3);
  width: 20px;
  height: 20px;
  margin-right: -6px;
  border-radius: 50%;
  display: inline-grid;
  place-items: center;
  padding: 0;
}
.gh-repo-del:hover {
  color: var(--danger);
  background: var(--danger-soft);
}
.gh-repo-add {
  height: 28px;
  width: 210px;
  font-size: 12px;
  border-radius: 14px;
}
.gh-notice {
  margin-top: 8px;
  font-size: 12px;
  color: var(--warning);
  display: flex;
  align-items: center;
  gap: 6px;
}
.gh-progress {
  margin-top: 8px;
  font-size: 13px;
  color: var(--brand);
}
.gh-results {
  margin-top: 12px;
  max-width: 720px;
  max-height: 420px;
  overflow: auto;
  padding: 8px;
}
.gh-item {
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.gh-item:hover {
  background: var(--surface-2);
}
.gh-item:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.gh-item.busy {
  opacity: 0.5;
  pointer-events: none;
}
.gh-name {
  font-size: 13px;
  color: var(--text);
  word-break: break-all;
}
.gh-meta {
  font-size: 11px;
  color: var(--text-3);
  word-break: break-all;
}
.gh-empty {
  color: var(--text-3);
  font-size: 13px;
  text-align: center;
  padding: 16px 0;
}
.gh-count {
  font-size: 12px;
  color: var(--text-3);
  padding: 8px 10px 2px;
  border-top: 1px solid var(--border);
}

.uni-section {
  margin-top: 24px;
  padding: 16px 18px;
  max-width: 760px;
}
.uni-section h2 {
  font-size: 16px;
  margin-bottom: 10px;
}
.uni-scopes {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 10px;
  font-size: 13px;
  color: var(--text-2);
}
.check-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px 0 10px;
  border: 1px solid var(--border);
  border-radius: 15px;
  cursor: pointer;
  user-select: none;
  transition:
    border-color var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.check-chip:hover {
  border-color: var(--border-strong);
}
.check-chip.on {
  background: var(--brand-light);
  border-color: color-mix(in srgb, var(--brand) 50%, var(--border));
  color: var(--brand);
}
.check-chip:focus-within {
  box-shadow: var(--ring);
}
.check-chip input {
  width: 14px;
  height: 14px;
}
.uni-group {
  margin-top: 12px;
  border-top: 1px solid var(--border);
  max-height: 300px;
  overflow: auto;
}
.uni-group-head {
  position: sticky;
  top: 0;
  background: var(--card);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  padding: 8px 4px 4px;
}
.uni-pub {
  position: relative;
}
.uni-acts {
  display: flex;
  gap: 6px;
  margin-top: 4px;
}
.gh-updated {
  font-size: 12px;
  color: var(--text-3);
  margin-left: 10px;
}
.gh-repo-chip.community {
  background: var(--brand-light);
  border-color: transparent;
  color: var(--brand);
}
.empty-icon.spinner svg {
  animation: spin 0.9s linear infinite;
}
.empty-icon.danger {
  background: var(--danger-soft);
  color: var(--danger);
}
.hint {
  font-size: 13px;
  line-height: 1.8;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 720px) {
  .catalog {
    padding: 16px 16px calc(28px + env(safe-area-inset-bottom));
  }
  .source-grid {
    grid-template-columns: 1fr;
  }
  .toolbar {
    gap: 8px;
  }
  .gh-search-row {
    max-width: none;
  }
  .calibre-path {
    display: none;
  }
  .form-row-pair {
    flex-direction: column;
    gap: 0;
  }
  .pub {
    gap: 12px;
    padding: 12px;
  }
  .pub-cover {
    width: 64px;
    height: 90px;
  }
}
</style>
