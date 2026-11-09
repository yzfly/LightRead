<script setup lang="ts">
import { askConfirm, deleteConfirmOptions } from '../services/confirm'
import { vAutofocus } from '../directives/autofocus'
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { getStorage, type CatalogSourceRec, isTauri } from '../storage'
import {
  discoverSearchTemplate, downloadToLibrary, fillSearchTemplate, forgetSearchTemplate, loadOpdsPage,
  searchGutenberg, searchOpdsSource,
  type OpdsPage, type OpdsPublication,
} from '../services/opds'
import {
  looksLikeConnectionText, parseConnectionText, pickPrimaryAcquisition, splitUrlCredentials,
  userOpdsSources, withTimeout, type ConnectionInfo,
} from '../services/privateLibrary'
import { readerPath } from '../services/readerRoute'
import { arxivRootPage, arxivSearchUrl, isArxivUrl, loadArxivPage } from '../services/arxiv'
import {
  calibreAvailable, importCalibreBook, listCalibreBooks, pickCalibreLibrary,
  calibreCoverUrl, pickBestFormat, type CalibreBook,
} from '../services/calibre'
import {
  searchGithubBooks, isValidRepo, fmtBytes,
  type GithubBookHit,
} from '../services/githubBooks'
import { openDownload } from '../services/updater'
import { searchPhilosophyArchive, type PhilosophyWork } from '../services/philosophyArchive'
import { buildWendianEpub, fetchWendianBook, searchWendian, type WendianWork } from '../services/wendian'
import { sanitizeFileName } from '../services/epubWriter'
import { fetchRemote } from '../services/net'
import { importFile } from '../services/importer'
import { searchOpenLibrary, type OpenLibraryBook } from '../services/openLibrary'
import { searchInternetArchive, loadArchivePublication, type ArchiveBook } from '../services/internetArchive'
import { WEB_BOOK_SOURCES, webBookSourceUrl } from '../services/webBookSources'
import { catalogErrorKey } from '../services/catalogErrors'
import { normalizeBookQuery, titleRelevance } from '../services/bookQuery'
import { arxivSearchUrl as arxivSearchUrlOf, loadArxivPage as loadArxivPageOf } from '../services/arxiv'
import { importFromUrl } from '../services/urlImport'
import { useSettings } from '../stores/settings'
import { useLibrary } from '../stores/library'
import { useRoute, useRouter } from 'vue-router'
import { toast } from '../services/toast'
import { t } from '../i18n'
import LibraryUploadDialog from '../components/LibraryUploadDialog.vue'
import { libraryUploadTask } from '../services/libraryUploadTask'
import { syncState } from '../services/sync'
import { sourceKey } from '../services/sync/merge'
import {
  doubanSearchUrl, findMatchingBook, findQuery, yearLabel, type CuratedBook, type CuratedList,
} from '../services/booklists'
import { BUNDLED_CURATED, CURATED_LIST_PAGE, fetchCuratedLists } from '../services/curatedBooklists'

const library = useLibrary()
const settings = useSettings()
const router = useRouter()
const route = useRoute()
const uploadTarget = ref<CatalogSourceRec | null>(null)

// 后台上传每跑完一轮 (有书进了书库) 就刷新当前书库列表与搜索结果
watch(() => libraryUploadTask.generation, () => { void refreshAfterUpload() })
async function refreshAfterUpload() {
  if (activeSource.value) {
    const current = breadcrumbs.value[breadcrumbs.value.length - 1]
    await openUrl(current?.url ?? activeSource.value.url, current?.title ?? activeSource.value.title, false)
  }
  if (uniSearched.value && !uniSearching.value) await uniSearch()
}

// ---- GitHub 书库: 只搜用户自己添加的仓库 (随设置同步到账号); 应用不内置、不推荐第三方仓库 ----
const ghImporting = ref('')
const ghProgress = ref('')
const ghRepoDraft = ref('')
const hasGhRepos = computed(() => settings.githubBookRepos.length > 0)

const allGhRepos = () => [...new Set(settings.githubBookRepos)]

function addGhRepo() {
  const repo = ghRepoDraft.value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/$/, '')
  if (!isValidRepo(repo)) {
    toast(t('library.ghRepoInvalid'), 'error')
    return
  }
  if (!settings.githubBookRepos.includes(repo)) {
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

// ---- 统一搜书: 默认优先免登录的公开图书 ----
const uniQuery = ref('')
const uniScopes = reactive({ github: hasGhRepos.value, gutenberg: true, archive: true, philosophy: true, wendian: true, openlibrary: false, arxiv: false })
const hasSearchScope = computed(() =>
  Object.values(uniScopes).some(Boolean) || myLibraries.value.some(s => myScopeOn(s.id)))
const uniPhilosophy = ref<PhilosophyWork[]>([])
const uniWendian = ref<WendianWork[]>([])
const uniArchive = ref<ArchiveBook[]>([])
const uniOpenLibrary = ref<OpenLibraryBook[]>([])
const archivePublications = reactive<Record<string, OpdsPublication>>(Object.create(null))
const archiveLoading = reactive(new Set<string>())

async function showArchiveDownloads(book: ArchiveBook) {
  if (archiveLoading.has(book.identifier)) return
  archiveLoading.add(book.identifier)
  try {
    archivePublications[book.identifier] = await loadArchivePublication(book)
  } catch (e: any) {
    toast(t('catalog.loadFailed') + ': ' + sourceErrorText(e), 'error', 6000)
  } finally {
    archiveLoading.delete(book.identifier)
  }
}

function openBookWebsite(url: string) {
  void openDownload(url).catch(e => toast(t('catalog.loadFailed') + ': ' + (e?.message ?? e), 'error'))
}
const uniSearching = ref(false)
const uniSearched = ref(false)

/** 每组结果先显示前几条, 其余点「展开全部」; 新的搜索重新收起 */
const UNI_PREVIEW = 6
const expandedGroups = reactive(new Set<string>())
const shownOf = <T>(key: string, list: T[], cap = Infinity): T[] =>
  list.slice(0, expandedGroups.has(key) ? cap : UNI_PREVIEW)
function toggleGroup(key: string) {
  if (expandedGroups.has(key)) expandedGroups.delete(key)
  else expandedGroups.add(key)
}
const uniErrors = ref<string[]>([])
const uniGithub = ref<GithubBookHit[]>([])
const uniGutenberg = ref<OpdsPublication[]>([])
const uniArxiv = ref<OpdsPublication[]>([])
let uniSession = 0
/** 本次搜索实际发出的 (归一后的) 关键词, 用于结果分组排序 */
const uniActiveQuery = ref('')

// ---- 各公开书源的状态: 搜索中 / 有结果 / 未找到 / 出错, 分组按结果相关度排序 ----
type UniSource = 'philosophy' | 'wendian' | 'archive' | 'github' | 'gutenberg' | 'openlibrary' | 'arxiv'
/** 同等相关度时的默认顺序 */
const UNI_SOURCES: UniSource[] = ['philosophy', 'wendian', 'archive', 'github', 'gutenberg', 'openlibrary', 'arxiv']
const uniStatus = reactive<Record<UniSource, 'idle' | 'loading' | 'done' | 'error'>>({
  philosophy: 'idle', wendian: 'idle', archive: 'idle', github: 'idle', gutenberg: 'idle', openlibrary: 'idle', arxiv: 'idle',
})
/** 搜索范围里的公开来源 (顺序即显示顺序) */
const publicScopeChips = computed(() => ([
  { key: 'philosophy', name: t('catalog.philosophy'), title: t('catalog.philosophyHint') },
  { key: 'wendian', name: t('catalog.wendian'), title: t('catalog.wendianHint') },
  { key: 'gutenberg', name: t('catalog.gutenberg') },
  { key: 'archive', name: 'Internet Archive' },
  { key: 'arxiv', name: 'arXiv' },
  { key: 'openlibrary', name: 'Open Library' },
  // 没添加 GitHub 仓库时不出现在搜索范围里
  ...(hasGhRepos.value ? [{ key: 'github', name: 'GitHub' }] : []),
] as Array<{ key: UniSource; name: string; title?: string }>))
// 添加第一个 / 删光仓库时跟着打开 / 关闭 GitHub 搜索范围
watch(hasGhRepos, on => { uniScopes.github = on })
const uniSourceName = (key: UniSource) => ({
  philosophy: t('catalog.philosophy'), wendian: t('catalog.wendian'), archive: 'Internet Archive', github: 'GitHub',
  gutenberg: t('catalog.gutenberg'), openlibrary: 'Open Library', arxiv: 'arXiv',
})[key]

function uniTitles(key: UniSource): string[] {
  switch (key) {
    case 'philosophy': return uniPhilosophy.value.map(b => b.title)
    case 'wendian': return uniWendian.value.map(b => b.title)
    case 'archive': return uniArchive.value.map(b => b.title)
    case 'github': return uniGithub.value.map(h => h.name)
    case 'gutenberg': return uniGutenberg.value.map(p => p.title)
    case 'openlibrary': return uniOpenLibrary.value.map(b => b.title)
    case 'arxiv': return uniArxiv.value.map(p => p.title)
  }
}

/** 该来源最贴切的一条结果的相关度 (哲学文库在本地索引里已算好, 含繁简归一; 其余按书名比对) */
function uniBestRelevance(key: UniSource): number {
  if (key === 'philosophy') return Math.max(0, ...uniPhilosophy.value.map(b => b.relevance))
  if (key === 'wendian') return Math.max(0, ...uniWendian.value.map(b => b.relevance))
  // Open Library 只是书目: 只有能公开阅读/借阅的记录才算数, 免得「暂无电子版」排到可下载的来源前面
  const titles = key === 'openlibrary'
    ? uniOpenLibrary.value.filter(b => b.access === 'public' || b.access === 'borrowable').map(b => b.title)
    : uniTitles(key)
  return Math.max(0, ...titles.slice(0, 10).map(title => titleRelevance(title, uniActiveQuery.value)))
}

/** 有结果的来源按「最贴切结果」排序, 搜索中的排在后面; 未找到的折叠成一行 */
const uniVisibleGroups = computed(() => UNI_SOURCES
  .filter(key => uniScopes[key] && (uniStatus[key] === 'loading' || (uniStatus[key] === 'done' && uniTitles(key).length)))
  .map((key, index) => ({ key, rank: uniStatus[key] === 'loading' ? -1 : uniBestRelevance(key), index }))
  .sort((a, b) => b.rank - a.rank || a.index - b.index)
  .map(entry => entry.key))
const uniEmptySources = computed(() => UNI_SOURCES
  .filter(key => uniScopes[key] && uniStatus[key] === 'done' && !uniTitles(key).length)
  .map(uniSourceName))

/** 搜完了, 有来源正常返回, 但哪里都没有结果 */
const uniNoResults = computed(() => !uniSearching.value &&
  (UNI_SOURCES.some(key => uniStatus[key] === 'done') || myResults.value.some(r => r.status === 'done')) &&
  !myResults.value.some(r => r.publications.length) && UNI_SOURCES.every(key => !uniTitles(key).length))

/** 公开书源与私人书库共用: 原生 / 浏览器错误都转成短提示, 不展示底层网址。 */
function sourceErrorText(e: unknown): string {
  const message = e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e ?? '')
  // 这些是应用主动抛出的已翻译提示, 保留具体操作指引。
  for (const key of ['catalog.searchTimeout', 'catalog.noSearchTemplate', 'catalog.githubRateLimited']) {
    if (message === t(key)) return message
  }
  return t(catalogErrorKey(e, !isTauri() && !settings.corsProxy.trim()))
}

/** 十几个书库各报一遍同样的错 (多为 GitHub 匿名接口限流) 没有意义: 合并成一句 */
function githubErrorText(errors: Array<{ repo: string; message: string }>): string {
  if (errors.some(x => /\b(403|429)\b|rate limit/i.test(x.message))) return `GitHub: ${t('catalog.githubRateLimited')}`
  const messages = [...new Set(errors.map(x => sourceErrorText({ message: x.message })))]
  return errors.length === 1
    ? `${errors[0]!.repo}: ${messages[0]}`
    : `GitHub: ${t('catalog.githubReposFailed', { n: errors.length })} ${messages.slice(0, 2).join('; ')}`
}

async function uniSearch() {
  const raw = uniQuery.value.trim()
  // 书名号、全角标点等统一成空格: 「《思考，快与慢》」与「思考 快与慢」等价
  const query = normalizeBookQuery(raw)
  if (!query || !hasSearchScope.value) return
  // 同一关键词正在搜索时不重复发起; 换了关键词可以直接重搜, 旧结果按会话丢弃
  if (uniSearching.value && query === uniActiveQuery.value) return
  const session = ++uniSession
  uniActiveQuery.value = query
  uniSearching.value = true
  uniSearched.value = true
  uniPhilosophy.value = []
  uniWendian.value = []
  uniArchive.value = []
  uniOpenLibrary.value = []
  uniErrors.value = []
  uniGithub.value = []
  uniGutenberg.value = []
  uniArxiv.value = []
  expandedGroups.clear()
  for (const key of UNI_SOURCES) uniStatus[key] = uniScopes[key] ? 'loading' : 'idle'
  const jobs: Promise<void>[] = []
  // 我的书库 (用户添加的 OPDS 书源) 各自独立搜索: 一个慢/失败不影响其它; 用原始关键词, 交给书库自己的搜索
  myResults.value = myLibraries.value.filter(s => myScopeOn(s.id)).map(source => ({
    source, status: 'loading', error: '', publications: [], loadingMore: false,
  }))
  for (const entry of myResults.value) jobs.push(searchMyLibrary(session, entry, raw))
  /** 每个来源独立: 先到先显示, 失败只影响自己 */
  const run = <T>(key: UniSource, request: () => Promise<T>, apply: (result: T) => void) => {
    jobs.push(request().then(result => {
      if (session !== uniSession) return
      apply(result)
      uniStatus[key] = 'done'
    }).catch(e => {
      if (session !== uniSession) return
      uniStatus[key] = 'error'
      if (e?.message !== '') uniErrors.value.push(`${uniSourceName(key)}: ${sourceErrorText(e)}`)
    }))
  }
  if (uniScopes.github && hasGhRepos.value) {
    const repos = allGhRepos()
    run('github', () => searchGithubBooks(repos, query), r => {
      uniGithub.value = r.hits
      if (!r.errors.length) return
      uniErrors.value.push(githubErrorText(r.errors))
      // 全部书库都没取到时是「出错」而不是「未找到」
      if (!r.hits.length && r.errors.length >= new Set(repos.map(repo => repo.toLowerCase())).size) throw new Error('')
    })
  }
  if (uniScopes.gutenberg) run('gutenberg', () => searchGutenberg(query, 24), pubs => { uniGutenberg.value = pubs })
  if (uniScopes.philosophy) run('philosophy', () => searchPhilosophyArchive(query), works => { uniPhilosophy.value = works })
  if (uniScopes.wendian) run('wendian', () => searchWendian(query), works => { uniWendian.value = works })
  if (uniScopes.archive) run('archive', () => searchInternetArchive(query), books => { uniArchive.value = books })
  if (uniScopes.openlibrary) run('openlibrary', () => searchOpenLibrary(query), books => { uniOpenLibrary.value = books })
  if (uniScopes.arxiv) {
    run('arxiv', () => loadArxivPageOf(arxivSearchUrlOf(query)), p => { uniArxiv.value = (p.publications ?? []).slice(0, 20) })
  }
  await Promise.allSettled(jobs)
  if (session === uniSession) {
    uniSearched.value = true
    uniSearching.value = false
  }
}

// These providers omit CORS headers on downloads. Offer a browser download on Web
// when no proxy is configured, instead of failing an otherwise public download.
const publicDownloadInBrowser = computed(() => !isTauri() && !settings.corsProxy.trim())
function downloadPublicBook(pub: OpdsPublication, acq: OpdsPublication['acquisitions'][number], source: string) {
  if (publicDownloadInBrowser.value) openBookWebsite(acq.href)
  else void uniDownloadPub(pub, acq, source)
}

/** 哲学文库: 原站允许跨域的 (Early Modern Texts / Standard Ebooks) 网页版也能直接导入 */
const philosophyInBrowser = (work: PhilosophyWork) => publicDownloadInBrowser.value && !work.source.cors
/** 网页版无代理时 HTML 文章就是原网页本身, 只留「查看原网页」 */
const philosophyAcqs = (work: PhilosophyWork) => work.publication.acquisitions
  .filter(acq => !(philosophyInBrowser(work) && acq.label === 'HTML'))
  .slice(0, 2)
function downloadPhilosophy(work: PhilosophyWork, acq: OpdsPublication['acquisitions'][number]) {
  if (philosophyInBrowser(work)) openBookWebsite(acq.href)
  else void uniDownloadPub(work.publication, acq, t('catalog.philosophy'))
}

// ---- 研辞问典: 只取选中的这一本, 解析正文生成 EPUB 后导入并打开 ----
const wendianBusy = ref('')
/** 原站不允许跨域: 网页版没配书源代理时只能查看原站 */
const wendianInBrowser = computed(() => publicDownloadInBrowser.value)
function charsLabel(chars: number): string {
  const n = settings.language === 'en'
    ? (chars >= 1000 ? `${Math.round(chars / 1000)}k` : String(chars))
    : (chars >= 10000 ? `${(chars / 10000).toFixed(1)} 万` : String(chars))
  return t('catalog.charsApprox', { n })
}
async function importWendianWork(work: WendianWork) {
  if (wendianBusy.value) return
  wendianBusy.value = work.id
  ghProgress.value = t('catalog.wendianFetching', { title: work.title })
  try {
    const book = await fetchWendianBook(
      work,
      async url => (await fetchRemote(url, undefined, { headers: { accept: 'text/html,application/xhtml+xml,*/*' } })).text(),
      p => {
        if (p.total > 1) ghProgress.value = t('catalog.wendianFetchingParts', { title: work.title, done: p.done, total: p.total })
      },
    )
    ghProgress.value = t('catalog.wendianBuilding', { title: book.title })
    const bytes = await buildWendianEpub(book, {
      note: [t('catalog.wendianNoteSource', { url: book.url }), t('catalog.wendianNoteTerms')],
      tocTitle: t('reader.toc'),
    })
    const file = new File([bytes as BlobPart], sanitizeFileName(book.title, 'epub'), { type: 'application/epub+zip' })
    const result = await importFile(file, t('catalog.wendian'), {
      title: book.title,
      author: book.author,
      description: [book.category, book.url].filter(Boolean).join(' · '),
    })
    if (!result.ok || !result.bookId) throw new Error(result.error)
    await library.refresh()
    toast(t('library.importSuccess', { count: 1 }), 'success')
    openLibraryBook({ id: result.bookId, format: 'epub' })
  } catch (e: any) {
    toast(t('library.urlImportFailed', { msg: e?.message === 'empty' ? t('catalog.wendianEmpty') : sourceErrorText(e) }), 'error', 6000)
  } finally {
    wendianBusy.value = ''
    ghProgress.value = ''
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

// ---- 书单推荐: 自带 + 远程更新的精选书单; 详情里「找书」复用统一搜书, 结果显示在这本书下面 ----
const curatedLists = ref<CuratedList[]>(BUNDLED_CURATED.lists)
const curatedUpdated = ref(BUNDLED_CURATED.updated)
const curatedFromRemote = ref(false)
const curatedOpen = ref<CuratedList | null>(null)
/** 正在「找书」的那本 (书单内序号); 统一搜书的结果区传送到它下面 */
const findIndex = ref(-1)
const findSlot = ref<HTMLElement | null>(null)
const findSlots = new Map<number, HTMLElement>()
const curatedSectionEl = ref<HTMLElement | null>(null)

async function refreshCurated(force = false) {
  const result = await fetchCuratedLists(force)
  curatedLists.value = result.lists
  curatedUpdated.value = result.updated
  curatedFromRemote.value = result.fromRemote
  if (curatedOpen.value) curatedOpen.value = result.lists.find(list => list.id === curatedOpen.value!.id) ?? curatedOpen.value
  if (!force) return
  if (result.fromRemote) toast(t('booklist.listsRefreshed', { n: result.lists.length, date: result.updated }), 'success')
  else toast(t('booklist.listsRefreshFailed', { date: result.updated }), 'error', 5000)
}

const curatedTitle = (list: CuratedList) => (settings.language === 'en' && list.en?.title) || list.title
const curatedDesc = (list: CuratedList) => (settings.language === 'en' && list.en?.description) || list.description
const ownedBook = (book: CuratedBook) => findMatchingBook(book, library.books)
const ownedCount = (list: CuratedList) => list.books.filter(book => ownedBook(book)).length
const bookYear = (book: CuratedBook) => yearLabel(book.year, settings.language === 'en' ? 'en' : 'zh')

function setFindSlot(index: number, el: unknown) {
  if (el instanceof HTMLElement) findSlots.set(index, el)
  else findSlots.delete(index)
}

function openCurated(list: CuratedList) {
  curatedOpen.value = list
  findIndex.value = -1
  findSlot.value = null
  scrollToTop()
}

function closeCurated() {
  // 先把搜索结果区收回统一搜书卡片, 再卸载详情
  findSlot.value = null
  findIndex.value = -1
  curatedOpen.value = null
  void nextTick(() => curatedSectionEl.value?.scrollIntoView({ block: 'start' }))
}

/** 「找书」: 用书名 + 作者 (或外文原名) 跑统一搜书, 结果显示在这本书下面 */
async function findCuratedBook(index: number, book: CuratedBook, original = false) {
  findIndex.value = index
  await nextTick()
  findSlot.value = findSlots.get(index) ?? null
  uniQuery.value = original && book.originalTitle
    ? findQuery(book.originalTitle, book.originalAuthor ?? '')
    : findQuery(book.title, book.author)
  await uniSearch()
}

function closeFind() {
  findSlot.value = null
  findIndex.value = -1
}

function openOwned(book: CuratedBook) {
  const owned = ownedBook(book)
  if (owned) openLibraryBook(owned)
}

const addingCurated = ref(false)
async function addCuratedToMine(list: CuratedList) {
  if (addingCurated.value) return
  addingCurated.value = true
  try {
    const result = await library.saveEntriesAsBooklist(curatedTitle(list), list.books)
    const msg = result.linked || result.wanted
      ? t('booklist.addedAll', { name: result.name, linked: result.linked, wanted: result.wanted })
      : t('booklist.addedAllNothing', { name: result.name })
    toast(msg, 'success', 6000, {
      label: t('booklist.viewInLibrary'),
      run: () => router.push({ path: '/library', query: { booklist: result.id } }),
    })
  } catch (e: any) {
    toast(e?.message ?? t('common.unknownError'), 'error', 6000)
  } finally {
    addingCurated.value = false
  }
}

const sources = ref<CatalogSourceRec[]>([])
/** 卡片上只显示主机名, 完整地址放在悬停提示里 */
/** 内置书源存的是「古登堡计划 (Project Gutenberg)」, 卡片宽度放不下: 显示本地化短名, 全名留在悬停提示 */
function sourceTitle(s: CatalogSourceRec): string {
  return s.builtin && s.url.includes('gutenberg.org') ? t('catalog.gutenberg') : s.title
}
function hostOf(url: string) {
  try { return new URL(url).host || url } catch { return url }
}
const activeSource = ref<CatalogSourceRec | null>(null)
const page = ref<OpdsPage | null>(null)
const loading = ref(false)
const loadError = ref('')
const breadcrumbs = ref<Array<{ title: string; url: string }>>([])
const searchQuery = ref('')
const downloading = ref<Set<string>>(new Set())
const appendLoading = ref(false)

// 添加 / 编辑书源 (editingSource 非空为编辑)
const showAdd = ref(false)
const editingSource = ref<CatalogSourceRec | null>(null)
const newTitle = ref('')
const newUrl = ref('')
const newUsername = ref('')
const newPassword = ref('')

const sourceAuth = () => ({
  username: activeSource.value?.username,
  password: activeSource.value?.password,
})

// ---- 我的书库: 统一搜书里同时搜索用户自己添加的 OPDS 书源 (带各自账号) ----
interface MyLibraryResult {
  source: CatalogSourceRec
  status: 'loading' | 'done' | 'error' | 'nosearch'
  error: string
  publications: OpdsPublication[]
  next?: string
  loadingMore: boolean
}
const MY_LIBRARY_SEARCH_TIMEOUT = 25_000
const myLibraries = computed(() => userOpdsSources(sources.value))
/** 搜索范围: 默认全选, 只记录用户关掉的 */
const myScopes = reactive<Record<string, boolean>>({})
const myScopeOn = (id: string) => myScopes[id] !== false
const myResults = ref<MyLibraryResult[]>([])
const fetchingNotice = ref('')
const authOf = (s: CatalogSourceRec) => ({ username: s.username, password: s.password })

function toggleMyScope(id: string, e: Event) {
  myScopes[id] = (e.target as HTMLInputElement).checked
}

async function searchMyLibrary(session: number, entry: MyLibraryResult, query: string) {
  const ctrl = new AbortController()
  try {
    const result = await withTimeout(
      searchOpdsSource(entry.source, query, ctrl.signal),
      MY_LIBRARY_SEARCH_TIMEOUT, t('catalog.searchTimeout'), () => ctrl.abort(),
    )
    if (session !== uniSession) return
    if (!result) {
      entry.status = 'nosearch'
      return
    }
    entry.publications = result.publications
    entry.next = result.next
    entry.status = 'done'
  } catch (e: any) {
    if (session !== uniSession) return
    entry.status = 'error'
    entry.error = sourceErrorText(e)
  }
}

async function loadMoreMine(entry: MyLibraryResult) {
  if (!entry.next || entry.loadingMore) return
  entry.loadingMore = true
  try {
    const more = await loadOpdsPage(entry.next, authOf(entry.source))
    entry.publications = [...entry.publications, ...more.publications]
    entry.next = more.next
  } catch (e: any) {
    toast(`${t('catalog.loadMoreFailed')}: ${sourceErrorText(e)}`, 'error', 5000)
  } finally {
    entry.loadingMore = false
  }
}

const primaryAcq = (pub: OpdsPublication) => pickPrimaryAcquisition(pub.acquisitions).primary
const otherAcqs = (pub: OpdsPublication) => pickPrimaryAcquisition(pub.acquisitions).others

/** 同书库、同名且同格式才复用本地书，保留其他格式的下载入口。 */
const importedFromSource = (source: CatalogSourceRec, pub: OpdsPublication) =>
  library.books.find(b => b.source === source.title && b.title === pub.title &&
    b.format.toUpperCase() === primaryAcq(pub)?.label.toUpperCase())

function openLibraryBook(book: { id: string; format: any }) {
  router.push(readerPath(book))
}

/** 一步到位: 下载 (带书库账号) → 导入藏书 → 打开阅读; open=false 时只入库 */
async function getFromMyLibrary(
  entry: MyLibraryResult, pub: OpdsPublication, acq: OpdsPublication['acquisitions'][number], open: boolean,
) {
  if (downloading.value.has(acq.href)) return
  downloading.value.add(acq.href)
  fetchingNotice.value = t('catalog.fetchingBook', { title: entry.source.title })
  try {
    const result = await downloadToLibrary(pub, acq, entry.source.title, authOf(entry.source))
    await library.refresh()
    const book = result.bookId ? library.books.find(b => b.id === result.bookId) : undefined
    if (open && book) openLibraryBook(book)
    else toast(t('catalog.bookImported', { title: pub.title }), 'success')
  } catch (e: any) {
    toast(t('catalog.downloadFailed', { msg: e?.message ?? t('common.unknownError') }), 'error', 6000)
  } finally {
    downloading.value.delete(acq.href)
    if (!downloading.value.size) fetchingNotice.value = ''
  }
}

// ---- 添加书源: 粘贴连接信息自动填表 ----
const connText = ref('')
const connStatus = ref<{ ok: boolean; text: string } | null>(null)

function applyConnection(info: ConnectionInfo) {
  if (info.title) newTitle.value = info.title
  if (info.url) newUrl.value = info.url
  if (info.username) newUsername.value = info.username
  if (info.password) newPassword.value = info.password
  const fields = [
    info.title && t('catalog.name'),
    info.url && t('catalog.opdsUrl'),
    info.username && t('catalog.username'),
    info.password && t('catalog.password'),
  ].filter(Boolean)
  connStatus.value = {
    ok: true,
    text: t('catalog.connectionParsed', { fields: fields.join(settings.language === 'en' ? ', ' : '、') }),
  }
}

/** 手动输入/编辑连接信息时同样识别 (粘贴走 onConnectionPaste) */
watch(connText, text => {
  if (!text.trim()) {
    // 清空输入框不抹掉「已识别」提示, 只清掉报错
    if (connStatus.value && !connStatus.value.ok) connStatus.value = null
    return
  }
  const info = parseConnectionText(text)
  if (info) applyConnection(info)
  else connStatus.value = { ok: false, text: t('catalog.connectionNotRecognized') }
})

/**
 * 粘贴即识别: 识别成功时拦下这次粘贴, 只填表单, 不把含密码的原文留在输入框里。
 * 地址栏 (wholeBlockOnly) 只拦整段连接信息, 单个网址照常粘贴。
 */
function onConnectionPaste(e: ClipboardEvent, wholeBlockOnly: boolean) {
  const text = e.clipboardData?.getData('text') ?? ''
  if (wholeBlockOnly && !looksLikeConnectionText(text)) return
  const info = parseConnectionText(text)
  if (!info) return
  e.preventDefault()
  connText.value = ''
  applyConnection(info)
}

function openAdd() {
  if (editingSource.value) clearSourceForm()
  editingSource.value = null
  showAdd.value = true
}

function openEdit(s: CatalogSourceRec) {
  editingSource.value = s
  newTitle.value = s.title
  newUrl.value = s.url
  newUsername.value = s.username ?? ''
  newPassword.value = s.password ?? ''
  connText.value = ''
  connStatus.value = null
  showAdd.value = true
}

function clearSourceForm() {
  newTitle.value = ''
  newUrl.value = ''
  newUsername.value = ''
  newPassword.value = ''
}

function closeAdd() {
  // 取消编辑时不把那条书源的内容留给下一次「添加」
  if (editingSource.value) clearSourceForm()
  editingSource.value = null
  showAdd.value = false
  connText.value = ''
  connStatus.value = null
}

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

// 同步可能带来别的设备添加 / 修改 / 删除的书源 (私人书库): 每次同步结束后重读
watch(() => syncState.running, running => {
  if (!running) refreshSources()
})

onMounted(() => {
  refreshSources()
  // 书单推荐 (设置 → 功能, 默认关): 关闭时不显示也不联网拉取
  if (settings.features.recommendedBooklists) void refreshCurated()
  library.refresh()
  // 藏书页待找条目的「找书」: /catalogs?q=书名 作者
  const q = typeof route.query.q === 'string' ? route.query.q.trim() : ''
  if (q) {
    uniQuery.value = q
    void uniSearch()
  }
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
  if (!(await askConfirm(t('catalog.importNewConfirm', { count: fresh.length })))) return
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

const catalogEl = ref<HTMLElement | null>(null)
/** 进入 / 切换目录时回到顶部 (滚动容器是应用壳的 main, 不随路由重置) */
function scrollToTop() {
  catalogEl.value?.scrollIntoView({ block: 'start' })
}

async function openUrl(url: string, title: string, pushCrumb = true) {
  loading.value = true
  loadError.value = ''
  if (pushCrumb) scrollToTop()
  try {
    const result = await loadPage(url)
    page.value = result
    if (pushCrumb) breadcrumbs.value.push({ title: title || result.title, url })
  } catch (e: any) {
    loadError.value = sourceErrorText(e)
  } finally {
    loading.value = false
  }
}

function openSource(s: CatalogSourceRec) {
  scrollToTop()
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
  scrollToTop()
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
  // 指向 OpenSearch description 文档: 需要登录的书源, 描述文档同样带上账号
  try {
    const resolved = await discoverSearchTemplate(template, sourceAuth())
    openUrl(fillSearchTemplate(resolved, query), t('catalog.searchCrumb', { query }))
  } catch (e: any) {
    toast(t('catalog.searchFailed', { msg: sourceErrorText(e) }), 'error')
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
    toast(sourceErrorText(e), 'error')
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

/**
 * 保存添加 / 编辑的书源. 多端同步按规范化地址认书源 (sync/merge.sourceKey), 所以:
 * 添加一个地址已存在的自定义书源时改写那一条 (更新名称与账号), 不重复添加;
 * 编辑成另一条自定义书源的地址时拒绝. 每次保存记下修改时间 updatedAt, 多端同步按它决定谁的改动胜出.
 */
async function saveSource() {
  // 地址里内嵌的 user:pass@ 拆到账号字段 (浏览器 fetch 不接受带凭据的 URL)
  const split = splitUrlCredentials(newUrl.value)
  const url = split.url
  if (!url) return
  const storage = await getStorage()
  const now = Date.now()
  const fields = {
    title: newTitle.value.trim() || url,
    url,
    kind: isArxivUrl(url) ? 'arxiv' as const : 'opds' as const,
    username: newUsername.value.trim() || split.username || undefined,
    password: newPassword.value || split.password || undefined,
  }
  const key = sourceKey(url)
  const editing = editingSource.value
  const sameAddress = sources.value.find(s => !s.builtin && s.id !== editing?.id && sourceKey(s.url) === key)
  if (editing && sameAddress) {
    toast(t('catalog.sourceDuplicate', { title: sameAddress.title }), 'error', 5000)
    return
  }
  const target = editing ?? sameAddress
  if (!editing && sameAddress) {
    // 重复添加同一书库: 没填的名称 / 账号沿用已有的, 只覆盖新填的
    if (!newTitle.value.trim()) fields.title = sameAddress.title
    fields.username ??= sameAddress.username
    fields.password ??= sameAddress.password
  }
  if (target) {
    await storage.updateSource(target.id, { ...fields, addedAt: target.addedAt, updatedAt: now })
    forgetSearchTemplate(target.id)
  } else {
    await storage.addSource({ ...fields, builtin: false, addedAt: now, updatedAt: now })
  }
  editingSource.value = null
  clearSourceForm()
  closeAdd()
  await refreshSources()
  toast(t(target ? 'catalog.sourceUpdated' : 'catalog.sourceAdded'), 'success')
}

async function removeSource(s: CatalogSourceRec) {
  if (!(await askConfirm(t('catalog.deleteSourceConfirm', { title: s.title }), deleteConfirmOptions()))) return
  const storage = await getStorage()
  await storage.deleteSource(s.id)
  forgetSearchTemplate(s.id)
  delete myScopes[s.id]
  myResults.value = myResults.value.filter(r => r.source.id !== s.id)
  await refreshSources()
}
</script>

<template>
  <div ref="catalogEl" class="catalog">
    <!-- 书源列表 -->
    <template v-if="!activeSource">
      <header v-show="!curatedOpen" class="page-head">
        <div class="page-title">
          <h1>{{ t('catalog.title') }}</h1>
          <p>{{ t('catalog.subtitle') }}</p>
        </div>
        <button class="btn btn-primary add-source-btn" :aria-label="t('catalog.add')" :title="t('catalog.add')" @click="openAdd">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M11 13H5a1 1 0 1 1 0-2h6V5a1 1 0 1 1 2 0v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6z"/></svg>
          <span class="add-source-label">{{ t('catalog.add') }}</span>
        </button>
      </header>

      <!-- 统一搜书: 找书是这一页的主要任务, 放在书源列表之前 -->
      <section v-show="!curatedOpen" class="uni-section card" :aria-label="t('catalog.uniTitle')">
        <form class="uni-search" role="search" @submit.prevent="uniSearch">
          <div class="uni-field">
            <svg class="uni-field-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
            <input
              v-model="uniQuery"
              class="uni-input"
              type="search"
              enterkeyhint="search"
              :placeholder="t('catalog.uniPlaceholder')"
              :aria-label="t('catalog.uniTitle')"
            />
          </div>
          <button type="submit" class="btn btn-primary uni-submit" :disabled="uniSearching || !uniQuery.trim() || !hasSearchScope">
            <svg v-if="uniSearching" class="spin" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9"/></svg>
            {{ uniSearching ? t('library.ghSearching') : t('library.ghSearch') }}
          </button>
        </form>

        <div class="uni-scope-row">
          <span class="uni-scope-label">{{ t('catalog.scopeLabel') }}</span>
          <div class="uni-scopes">
            <label
              v-for="s in myLibraries"
              :key="s.id"
              class="check-chip mine"
              :class="{ on: myScopeOn(s.id), disabled: uniSearching }"
              :title="t('catalog.myLibraryScope', { title: s.title })"
            >
              <input :checked="myScopeOn(s.id)" :disabled="uniSearching" type="checkbox" @change="toggleMyScope(s.id, $event)" />
              <svg class="chip-mark" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/><path d="M10 20v-5h4v5"/></svg>
              {{ s.title }}
            </label>
            <label
              v-for="chip in publicScopeChips"
              :key="chip.key"
              class="check-chip"
              :class="{ on: uniScopes[chip.key], disabled: uniSearching }"
              :title="chip.title"
            >
              <input v-model="uniScopes[chip.key]" :disabled="uniSearching" type="checkbox" />
              <svg class="chip-mark chip-check" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>
              {{ chip.name }}
            </label>
          </div>
        </div>
        <p v-if="!hasSearchScope" class="uni-hint warn" role="status">{{ t('catalog.chooseSearchSource') }}</p>
        <p v-else-if="!uniSearched" class="uni-hint">{{ t('catalog.freeSearchHint') }}<template v-if="myLibraries.length"> {{ t('catalog.privateSearchHint') }}</template></p>

        <!-- 书单详情里「找书」时, 下面的提示与结果区传送到那本书下面 (同一份结果, 不复制代码) -->
        <Teleport :to="findSlot" :disabled="!findSlot">
        <div v-if="uniErrors.length" class="gh-notice" role="alert">
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M10.3 3.9a2 2 0 0 1 3.4 0l8 13.6A2 2 0 0 1 20 20.5H4a2 2 0 0 1-1.7-3l8-13.6zM12 9a1 1 0 0 0-1 1v4a1 1 0 1 0 2 0v-4a1 1 0 0 0-1-1zm0 9.2a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4z"/></svg>
          <ul class="source-errors">
            <li v-for="(error, index) in uniErrors" :key="index">{{ error }}</li>
          </ul>
        </div>
        <div v-if="ghProgress || fetchingNotice" class="uni-progress" role="status">
          <svg class="spin" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9"/></svg>
          {{ ghProgress || fetchingNotice }}
        </div>

        <div v-if="uniSearched" class="uni-results">
          <div v-if="uniNoResults" class="uni-empty" role="status">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M8.5 11h5"/></svg>
            <div>
              <p class="uni-empty-title">{{ t('catalog.noSearchResults') }}</p>
              <p>{{ t('catalog.copyrightHint') }}</p>
            </div>
          </div>

          <!-- 我的书库排在最前 -->
          <div v-for="entry in myResults" :key="entry.source.id" class="uni-group mine-group" :aria-busy="entry.status === 'loading'">
            <div class="uni-group-head">
              <span class="tag mine-tag">{{ t('catalog.myLibrary') }}</span>
              <span class="uni-group-name">{{ entry.source.title }}</span>
              <span v-if="entry.status === 'done'" class="uni-group-count"> · {{ t('reader.resultCount', { n: entry.next ? `${entry.publications.length}+` : entry.publications.length }) }}</span>
              <span v-else-if="entry.status === 'loading'" class="uni-group-count"> · {{ t('catalog.sourceSearching') }}</span>
            </div>
            <div v-if="entry.status === 'loading'" class="uni-skeleton" aria-hidden="true"><span class="skeleton" /><span class="skeleton" /></div>
            <p v-else-if="entry.status === 'error'" class="uni-group-msg error" role="alert">{{ entry.error }}</p>
            <p v-else-if="entry.status === 'nosearch'" class="uni-group-msg">{{ t('catalog.sourceNoSearch') }}</p>
            <div v-for="(pub, i) in shownOf(entry.source.id, entry.publications)" :key="i" class="gh-item uni-pub">
              <div class="uni-pub-main">
                <span class="gh-name">{{ pub.title }}</span>
                <span class="gh-meta">{{ pub.author || t('common.anonymous') }}</span>
              </div>
              <span class="uni-acts">
                <button
                  v-if="importedFromSource(entry.source, pub)"
                  class="btn btn-sm btn-primary"
                  @click="openLibraryBook(importedFromSource(entry.source, pub)!)"
                >{{ t('catalog.continueReading') }}</button>
                <template v-else-if="primaryAcq(pub)">
                  <button
                    class="btn btn-sm btn-primary"
                    :disabled="downloading.has(primaryAcq(pub)!.href)"
                    :aria-busy="downloading.has(primaryAcq(pub)!.href)"
                    @click.stop="getFromMyLibrary(entry, pub, primaryAcq(pub)!, true)"
                  >{{ downloading.has(primaryAcq(pub)!.href) ? t('catalog.downloading') : t('catalog.readNow', { label: primaryAcq(pub)!.label }) }}</button>
                  <button
                    v-for="acq in otherAcqs(pub)"
                    :key="acq.href"
                    class="btn btn-sm"
                    :disabled="downloading.has(acq.href)"
                    @click.stop="getFromMyLibrary(entry, pub, acq, false)"
                  >{{ downloading.has(acq.href) ? t('catalog.downloading') : t('catalog.download', { label: acq.label }) }}</button>
                </template>
                <span v-else class="gh-meta">{{ t('catalog.noDownloadFormat') }}</span>
              </span>
            </div>
            <div v-if="entry.publications.length > UNI_PREVIEW || entry.next" class="uni-more">
              <button v-if="entry.publications.length > UNI_PREVIEW" class="btn btn-sm btn-ghost" :aria-expanded="expandedGroups.has(entry.source.id)" @click="toggleGroup(entry.source.id)">
                {{ expandedGroups.has(entry.source.id) ? t('catalog.showFewer') : t('catalog.showAllResults', { n: entry.publications.length }) }}
              </button>
              <button v-if="entry.next && (expandedGroups.has(entry.source.id) || entry.publications.length <= UNI_PREVIEW)" class="btn btn-sm btn-ghost" :disabled="entry.loadingMore" @click="loadMoreMine(entry)">
                {{ entry.loadingMore ? t('common.loading') : t('catalog.loadMore') }}
              </button>
            </div>
          </div>

          <!-- 公开书源: 有结果的按最贴切结果排序, 搜索中的在后, 未找到的折叠成一行 -->
          <template v-for="key in uniVisibleGroups" :key="key">
            <div class="uni-group" :aria-busy="uniStatus[key] === 'loading'">
              <div class="uni-group-head">
                <span class="uni-group-name">{{ uniSourceName(key) }}</span>
                <span class="uni-group-count"> · {{ uniStatus[key] === 'loading' ? t('catalog.sourceSearching') : t('reader.resultCount', { n: uniTitles(key).length }) }}</span>
              </div>
              <div v-if="uniStatus[key] === 'loading'" class="uni-skeleton" aria-hidden="true"><span class="skeleton" /><span class="skeleton" /></div>

              <template v-if="key === 'philosophy'">
                <div v-for="work in shownOf(key, uniPhilosophy)" :key="work.id" class="gh-item uni-pub">
                  <div class="uni-pub-main">
                    <span class="gh-name">{{ work.title }}</span>
                    <span class="gh-meta"><template v-if="work.author">{{ work.author }} · </template>{{ work.source.name }}</span>
                  </div>
                  <span class="uni-acts">
                    <button v-for="(acq, ai) in philosophyAcqs(work)" :key="acq.href" class="btn btn-sm" :class="{ 'btn-accent': ai === 0 }" :disabled="downloading.has(acq.href)" @click="downloadPhilosophy(work, acq)">{{ downloading.has(acq.href) ? t('catalog.downloading') : t(philosophyInBrowser(work) ? 'catalog.browserDownload' : 'catalog.download', { label: acq.label }) }}</button>
                    <button class="btn btn-sm btn-ghost" @click="openBookWebsite(work.url)">{{ t('catalog.viewOriginal') }}</button>
                  </span>
                </div>
              </template>

              <template v-else-if="key === 'wendian'">
                <p v-if="uniStatus.wendian === 'done'" class="uni-group-msg">{{ t('catalog.wendianTerms') }}<template v-if="wendianInBrowser"> {{ t('catalog.wendianWebHint') }}</template></p>
                <div v-for="work in shownOf(key, uniWendian)" :key="work.id" class="gh-item uni-pub" :class="{ busy: wendianBusy === work.id }">
                  <div class="uni-pub-main">
                    <span class="gh-name">{{ work.title }}</span>
                    <span class="gh-meta"><template v-if="work.author">{{ work.author }} · </template>{{ work.category }}<template v-if="work.chars"> · {{ charsLabel(work.chars) }}</template></span>
                  </div>
                  <span class="uni-acts">
                    <button v-if="!wendianInBrowser" class="btn btn-sm btn-accent" :disabled="!!wendianBusy" :aria-busy="wendianBusy === work.id" @click="importWendianWork(work)">{{ wendianBusy === work.id ? t('catalog.downloading') : t('catalog.wendianImport') }}</button>
                    <button class="btn btn-sm btn-ghost" @click="openBookWebsite(work.url)">{{ t('catalog.viewOriginal') }}</button>
                  </span>
                </div>
              </template>

              <template v-else-if="key === 'archive'">
                <div v-for="book in shownOf(key, uniArchive)" :key="book.identifier" class="gh-item uni-pub">
                  <div class="uni-pub-main">
                    <span class="gh-name">{{ book.title }}</span>
                    <span class="gh-meta">{{ book.author || t('common.anonymous') }}<template v-if="book.year"> · {{ book.year }}</template></span>
                  </div>
                  <span class="uni-acts">
                    <template v-if="archivePublications[book.identifier]">
                      <button v-for="(acq, ai) in archivePublications[book.identifier].acquisitions" :key="acq.href" class="btn btn-sm" :class="{ 'btn-accent': ai === 0 }" :disabled="downloading.has(acq.href)" @click="downloadPublicBook(archivePublications[book.identifier], acq, 'Internet Archive')">{{ downloading.has(acq.href) ? t('catalog.downloading') : t(publicDownloadInBrowser ? 'catalog.browserDownload' : 'catalog.download', { label: acq.label }) }}</button>
                      <span v-if="!archivePublications[book.identifier].acquisitions.length" class="gh-meta">{{ t('catalog.noDownloadFormat') }}</span>
                    </template>
                    <button v-else class="btn btn-sm btn-accent" :disabled="archiveLoading.has(book.identifier)" @click="showArchiveDownloads(book)">{{ archiveLoading.has(book.identifier) ? t('catalog.readingLibrary') : t('catalog.showDownloads') }}</button>
                    <button class="btn btn-sm btn-ghost" @click="openBookWebsite(book.url)">{{ t('catalog.viewOriginal') }}</button>
                  </span>
                </div>
              </template>

              <template v-else-if="key === 'openlibrary'">
                <p v-if="uniStatus.openlibrary === 'done'" class="uni-group-msg">{{ t('catalog.openlibraryHint') }}</p>
                <div v-for="book in shownOf(key, uniOpenLibrary)" :key="book.key" class="gh-item uni-pub">
                  <div class="uni-pub-main">
                    <span class="gh-name">{{ book.title }}</span>
                    <span class="gh-meta">{{ book.author || t('common.anonymous') }}<template v-if="book.year"> · {{ book.year }}</template> · <span class="access" :class="book.access">{{ t('catalog.access.' + book.access) }}</span></span>
                  </div>
                  <span class="uni-acts"><button class="btn btn-sm btn-ghost" @click="openBookWebsite(book.url)">{{ t('catalog.viewOriginal') }}</button></span>
                </div>
              </template>

              <template v-else-if="key === 'github'">
                <div v-for="hit in shownOf(key, uniGithub, 60)" :key="hit.url" class="gh-item uni-pub" :class="{ busy: ghImporting === hit.url }">
                  <div class="uni-pub-main">
                    <span class="gh-name">{{ hit.name }}</span>
                    <span class="gh-meta">{{ hit.repo }}<template v-if="hit.size"> · {{ fmtBytes(hit.size) }}</template></span>
                  </div>
                  <span class="uni-acts">
                    <button class="btn btn-sm btn-accent" :disabled="!!ghImporting" :aria-busy="ghImporting === hit.url" @click="importGhBook(hit)">{{ ghImporting === hit.url ? t('catalog.downloading') : t('catalog.importToLibrary') }}</button>
                  </span>
                </div>
              </template>

              <template v-else-if="key === 'gutenberg'">
                <div v-for="(pub, i) in shownOf(key, uniGutenberg)" :key="i" class="gh-item uni-pub">
                  <div class="uni-pub-main">
                    <span class="gh-name">{{ pub.title }}</span>
                    <span class="gh-meta">{{ pub.author || t('common.anonymous') }}</span>
                  </div>
                  <span class="uni-acts">
                    <button
                      v-for="(acq, ai) in pub.acquisitions.slice(0, 2)"
                      :key="acq.href"
                      class="btn btn-sm"
                      :class="{ 'btn-accent': ai === 0 }"
                      :disabled="downloading.has(acq.href)"
                      @click.stop="uniDownloadPub(pub, acq, t('catalog.gutenberg'))"
                    >{{ downloading.has(acq.href) ? t('catalog.downloading') : t('catalog.download', { label: acq.label }) }}</button>
                    <span v-if="!pub.acquisitions.length" class="gh-meta">{{ t('catalog.noDownloadFormat') }}</span>
                  </span>
                </div>
              </template>

              <template v-else-if="key === 'arxiv'">
                <div v-for="(pub, i) in shownOf(key, uniArxiv)" :key="i" class="gh-item uni-pub">
                  <div class="uni-pub-main">
                    <span class="gh-name">{{ pub.title }}</span>
                    <span class="gh-meta">{{ pub.author || '' }}</span>
                  </div>
                  <span class="uni-acts">
                    <button
                      v-for="acq in pub.acquisitions.slice(0, 1)"
                      :key="acq.href"
                      class="btn btn-sm btn-accent"
                      :disabled="downloading.has(acq.href)"
                      @click.stop="uniDownloadPub(pub, acq, 'arXiv')"
                    >{{ downloading.has(acq.href) ? t('catalog.downloading') : t('catalog.download', { label: acq.label }) }}</button>
                  </span>
                </div>
              </template>

              <div v-if="uniTitles(key).length > UNI_PREVIEW" class="uni-more">
                <button class="btn btn-sm btn-ghost" :aria-expanded="expandedGroups.has(key)" @click="toggleGroup(key)">
                  {{ expandedGroups.has(key) ? t('catalog.showFewer') : t('catalog.showAllResults', { n: key === 'github' ? Math.min(uniTitles(key).length, 60) : uniTitles(key).length }) }}
                </button>
              </div>
            </div>
          </template>
          <p v-if="uniEmptySources.length && uniVisibleGroups.length" class="uni-empty-sources" role="status">{{ t('catalog.notFoundIn', { sources: uniEmptySources.join(settings.language === 'en' ? ', ' : '、') }) }}</p>
        </div>
        </Teleport>
      </section>

      <!-- 书单推荐: 精选书单 (自带 + 远程更新) -->
      <section v-if="settings.features.recommendedBooklists" v-show="!curatedOpen" ref="curatedSectionEl" class="cat-section curated-section">
        <div class="section-head">
          <div>
            <h2 class="display-heading">{{ t('booklist.curatedTitle') }}</h2>
            <p class="section-desc">{{ t('booklist.curatedDesc') }}</p>
          </div>
          <div class="section-actions">
            <button class="btn btn-sm" @click="refreshCurated(true)">{{ t('booklist.updateLists') }}</button>
            <button class="btn btn-sm" @click="openBookWebsite(CURATED_LIST_PAGE)">{{ t('booklist.suggestList') }}</button>
          </div>
        </div>
        <div class="curated-grid">
          <button
            v-for="list in curatedLists"
            :key="list.id"
            class="curated-card card"
            :aria-label="t('booklist.openList', { title: curatedTitle(list) })"
            @click="openCurated(list)"
          >
            <span class="curated-top">
              <span class="source-icon curated-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01" stroke-width="2.6"/></svg>
              </span>
              <span class="source-body">
                <span class="source-title">{{ curatedTitle(list) }}</span>
                <span class="source-url">{{ t('booklist.curatedBy', { curator: list.curator }) }}</span>
              </span>
              <svg class="source-chevron" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M9.3 6.3a1 1 0 0 1 1.4 0l5 5a1 1 0 0 1 0 1.4l-5 5a1 1 0 0 1-1.4-1.4L13.58 12 9.3 7.7a1 1 0 0 1 0-1.4z"/></svg>
            </span>
            <span v-if="curatedDesc(list)" class="curated-desc">{{ curatedDesc(list) }}</span>
            <span class="curated-foot">
              <span class="tag tag-muted">{{ t('booklist.bookCount', { n: list.books.length }) }}</span>
              <span v-if="ownedCount(list)" class="tag curated-owned">{{ t('booklist.ownedCount', { n: ownedCount(list) }) }}</span>
              <span v-for="tag in list.tags.slice(0, 2)" :key="tag" class="curated-tag">#{{ tag }}</span>
            </span>
          </button>
        </div>
        <p class="curated-updated">{{ t('booklist.updatedOn', { date: curatedUpdated }) }}{{ curatedFromRemote ? '' : t('catalog.communityBundled') }}</p>
      </section>

      <!-- 书库与目录 (内置 + 用户添加的 OPDS) -->
      <section v-show="!curatedOpen" class="cat-section">
        <div class="section-head">
          <div>
            <h2 class="display-heading">{{ t('catalog.sourcesTitle') }}</h2>
            <p class="section-desc">{{ t('catalog.sourcesDesc') }}</p>
          </div>
        </div>
        <div class="source-grid">
          <div
            v-for="s in sources"
            :key="s.id"
            class="source-card card"
            :class="{ custom: !s.builtin }"
            role="button"
            tabindex="0"
            @click="openSource(s)"
            @keydown.enter.prevent="openSource(s)"
            @keydown.space.prevent="openSource(s)"
          >
            <div class="source-top">
              <div class="source-icon" aria-hidden="true">
                <svg v-if="s.kind === 'arxiv'" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>
                <svg v-else-if="s.builtin" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2zM22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/></svg>
                <svg v-else viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/><path d="M10 20v-5h4v5"/></svg>
              </div>
              <div class="source-body">
                <div class="source-title-row">
                  <span class="source-title" :title="s.title">{{ sourceTitle(s) }}</span>
                  <span v-if="s.builtin" class="tag tag-muted">{{ t('catalog.builtin') }}</span>
                </div>
                <div class="source-url" :title="s.url">
                  <svg v-if="s.username" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" :aria-label="t('catalog.hasAccount')" role="img"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
                  {{ hostOf(s.url) }}
                </div>
              </div>
              <svg class="source-chevron" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M9.3 6.3a1 1 0 0 1 1.4 0l5 5a1 1 0 0 1 0 1.4l-5 5a1 1 0 0 1-1.4-1.4L13.58 12 9.3 7.7a1 1 0 0 1 0-1.4z"/></svg>
            </div>
            <div v-if="!s.builtin" class="source-foot">
              <span class="tag">{{ t('catalog.myLibrary') }}</span>
              <span class="source-actions">
                <button v-if="s.kind === 'opds'" class="btn btn-sm" @click.stop="uploadTarget = s" @keydown.stop>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4m0 0-4.5 4.5M12 4l4.5 4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>
                  {{ t('library.addBooks') }}
                </button>
                <button class="btn btn-sm btn-icon btn-ghost" :title="t('common.edit')" :aria-label="t('catalog.editSourceNamed', { title: s.title })" @click.stop="openEdit(s)" @keydown.stop>
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>
                </button>
                <button class="btn btn-sm btn-icon btn-ghost btn-danger" :title="t('common.delete')" :aria-label="t('catalog.deleteSourceNamed', { title: s.title })" @click.stop="removeSource(s)" @keydown.stop>
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>
                </button>
              </span>
            </div>
          </div>
          <button class="add-source-card" @click="openAdd">
            <span class="add-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M11 13H5a1 1 0 1 1 0-2h6V5a1 1 0 1 1 2 0v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6z"/></svg>
            </span>
            <span class="add-text">
              <strong>{{ t('catalog.connectOwn') }}</strong>
              <span>{{ t('catalog.connectOwnHint') }}</span>
            </span>
          </button>
        </div>
      </section>

      <!-- Calibre 书库直读 (桌面版) -->
      <section v-if="calibreAvailable()" v-show="!curatedOpen" class="cat-section calibre-section">
        <div class="section-head">
          <div>
            <h2 class="display-heading">{{ t('catalog.calibreTitle') }}</h2>
            <p v-if="!settings.calibrePath" class="section-desc">{{ t('catalog.calibreIntro') }}</p>
            <p v-else class="section-desc calibre-path" :title="settings.calibrePath">{{ settings.calibrePath }}</p>
          </div>
          <div class="section-actions">
            <template v-if="settings.calibrePath">
              <button class="btn btn-sm" :disabled="calibreLoading" @click="refreshCalibre">{{ t('common.refresh') }}</button>
              <button class="btn btn-sm btn-primary" :disabled="calibreBatchBusy" @click="calibreImportAllNew">
                {{ calibreBatchBusy ? t('catalog.syncing') : t('catalog.importAllNew') }}
              </button>
              <button class="btn btn-sm btn-ghost btn-danger" @click="disconnectCalibre">{{ t('catalog.disconnect') }}</button>
            </template>
            <button v-else class="btn btn-sm" @click="connectCalibre">{{ t('catalog.connectCalibre') }}</button>
          </div>
        </div>
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
                <span v-for="f in book.formats" :key="f.format" class="tag tag-muted">{{ f.format.toUpperCase() }}</span>
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

      <!-- 更多下载网站 (外部浏览器) -->
      <section v-show="!curatedOpen" class="cat-section web-sources">
        <div class="section-head">
          <div>
            <h2 class="display-heading">{{ t('catalog.webSourcesTitle') }}</h2>
            <p class="section-desc">{{ t('catalog.webSourcesHint') }}</p>
          </div>
        </div>
        <div class="web-grid">
          <article v-for="source in WEB_BOOK_SOURCES" :key="source.id" class="card web-source-card">
            <div class="web-head">
              <span class="web-avatar" aria-hidden="true">{{ source.title.charAt(0) }}</span>
              <div class="source-title">{{ source.title }}</div>
            </div>
            <p class="web-desc">{{ t(source.descriptionKey) }}</p>
            <button class="btn btn-sm web-open" @click="openBookWebsite(webBookSourceUrl(source, uniQuery))">{{ uniQuery.trim() && source.searchUrl ? t('catalog.searchWebsite') : t('catalog.openWebsite') }}</button>
          </article>
        </div>
      </section>

      <!-- GitHub 书库 (用户自己添加, 随账号同步) -->
      <section v-show="!curatedOpen" class="cat-section gh-section">
        <div class="section-head">
          <div>
            <h2 class="display-heading">{{ t('catalog.ghListTitle') }}</h2>
            <p class="section-desc">{{ t('catalog.ghListIntro') }}</p>
          </div>
        </div>
        <div class="card gh-card">
          <div class="gh-row">
            <span class="gh-row-label">{{ t('catalog.ghMine') }}</span>
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
          </div>
        </div>
      </section>

      <!-- 推荐书单详情 -->
      <template v-if="curatedOpen && settings.features.recommendedBooklists">
        <header class="toolbar dir-toolbar">
          <button class="btn btn-sm" @click="closeCurated">
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M14.7 6.3a1 1 0 0 1 0 1.4L10.42 12l4.3 4.3a1 1 0 0 1-1.42 1.4l-5-5a1 1 0 0 1 0-1.4l5-5a1 1 0 0 1 1.42 0z"/></svg>
            {{ t('common.back') }}
          </button>
          <nav class="crumbs" aria-label="Breadcrumb">
            <button class="crumb" @click="closeCurated">{{ t('catalog.title') }}</button>
            <span class="crumb-sep" aria-hidden="true">/</span>
            <button class="crumb" @click="closeCurated">{{ t('booklist.curatedTitle') }}</button>
            <span class="crumb-sep" aria-hidden="true">/</span>
            <span class="crumb current" aria-current="page">{{ curatedTitle(curatedOpen) }}</span>
          </nav>
        </header>

        <section class="curated-hero card">
          <div class="curated-hero-main">
            <h1>{{ curatedTitle(curatedOpen) }}</h1>
            <p v-if="curatedDesc(curatedOpen)" class="curated-hero-desc">{{ curatedDesc(curatedOpen) }}</p>
            <p class="curated-meta">
              <span>{{ t('booklist.curatedBy', { curator: curatedOpen.curator }) }}</span>
              <span aria-hidden="true">·</span>
              <span>{{ t('booklist.bookCount', { n: curatedOpen.books.length }) }}</span>
              <template v-if="ownedCount(curatedOpen)">
                <span aria-hidden="true">·</span>
                <span class="curated-owned-text">{{ t('booklist.ownedCount', { n: ownedCount(curatedOpen) }) }}</span>
              </template>
              <span aria-hidden="true">·</span>
              <span>{{ t('booklist.updatedOn', { date: curatedOpen.updated }) }}</span>
            </p>
            <p class="curated-meta">
              {{ t('booklist.source') }}
              <button class="curated-link" @click="openBookWebsite(curatedOpen.source.url)">{{ curatedOpen.source.name }}</button>
              <span aria-hidden="true">·</span>
              <span>{{ curatedOpen.source.license }}</span>
            </p>
          </div>
          <button class="btn btn-primary curated-add" :disabled="addingCurated" @click="addCuratedToMine(curatedOpen)">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M11 13H5a1 1 0 1 1 0-2h6V5a1 1 0 1 1 2 0v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6z"/></svg>
            {{ t('booklist.addAll') }}
          </button>
        </section>

        <ol class="curated-books card">
          <li v-for="(book, i) in curatedOpen.books" :key="`${curatedOpen.id}-${i}`" class="curated-book" :class="{ owned: !!ownedBook(book), finding: findIndex === i }">
            <div class="curated-row">
              <span class="curated-num" aria-hidden="true">{{ i + 1 }}</span>
              <div class="uni-pub-main">
                <span class="gh-name">{{ book.title }}<span v-if="book.originalTitle" class="curated-orig"> {{ book.originalTitle }}</span></span>
                <span class="gh-meta">{{ book.author }}<template v-if="bookYear(book)"> · {{ bookYear(book) }}</template></span>
                <span v-if="book.note" class="curated-note">{{ book.note }}</span>
              </div>
              <span class="uni-acts">
                <template v-if="ownedBook(book)">
                  <span class="tag curated-owned">{{ t('booklist.inLibrary') }}</span>
                  <button class="btn btn-sm btn-primary" @click="openOwned(book)">{{ t('booklist.open') }}</button>
                </template>
                <template v-else>
                  <button class="btn btn-sm btn-accent" :disabled="uniSearching && findIndex === i" :aria-expanded="findIndex === i" @click="findCuratedBook(i, book)">{{ t('booklist.find') }}</button>
                  <button v-if="book.originalTitle" class="btn btn-sm" :disabled="uniSearching && findIndex === i" @click="findCuratedBook(i, book, true)">{{ t('booklist.findOriginal') }}</button>
                </template>
                <button class="btn btn-sm btn-ghost" :title="t('booklist.doubanTitle')" @click="openBookWebsite(doubanSearchUrl(book.title, book.author))">{{ t('booklist.douban') }}</button>
              </span>
            </div>
            <div :ref="el => setFindSlot(i, el)" class="curated-find" />
            <div v-if="findIndex === i" class="curated-find-foot">
              <button class="btn btn-sm btn-ghost" @click="closeFind">{{ t('booklist.closeFind') }}</button>
            </div>
          </li>
        </ol>
      </template>
    </template>

    <!-- 目录浏览 -->
    <template v-else>
      <header class="toolbar dir-toolbar">
        <button class="btn btn-sm" @click="breadcrumbs.length > 1 ? gotoCrumb(breadcrumbs.length - 2) : backToSources()">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M14.7 6.3a1 1 0 0 1 0 1.4L10.42 12l4.3 4.3a1 1 0 0 1-1.42 1.4l-5-5a1 1 0 0 1 0-1.4l5-5a1 1 0 0 1 1.42 0z"/></svg>
          {{ t('common.back') }}
        </button>
        <nav class="crumbs" aria-label="Breadcrumb">
          <button class="crumb" @click="backToSources">{{ t('catalog.title') }}</button>
          <template v-for="(c, i) in breadcrumbs" :key="i">
            <span class="crumb-sep" aria-hidden="true">/</span>
            <button class="crumb" :class="{ current: i === breadcrumbs.length - 1 }" :aria-current="i === breadcrumbs.length - 1 ? 'page' : undefined" @click="gotoCrumb(i)">
              {{ c.title }}
            </button>
          </template>
        </nav>
        <div class="spacer" />
        <form v-if="page?.searchUrl" class="dir-search" role="search" @submit.prevent="runSearch">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <input v-model="searchQuery" class="input" type="search" enterkeyhint="search" :placeholder="t('catalog.searchThisSource')" :aria-label="t('catalog.searchThisSource')" />
        </form>
        <button v-if="!activeSource.builtin && activeSource.kind === 'opds'" class="btn btn-primary" @click="uploadTarget = activeSource">{{ t('library.addBooks') }}</button>
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
            <span class="nav-text">
              <span class="nav-title">{{ nav.title }}</span>
              <span v-if="nav.summary" class="nav-summary">{{ nav.summary }}</span>
            </span>
            <svg class="nav-chevron" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M9.3 6.3a1 1 0 0 1 1.4 0l5 5a1 1 0 0 1 0 1.4l-5 5a1 1 0 0 1-1.4-1.4L13.58 12 9.3 7.7a1 1 0 0 1 0-1.4z"/></svg>
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
                  v-for="(acq, ai) in pub.acquisitions"
                  :key="acq.href"
                  class="btn btn-sm"
                  :class="{ 'btn-accent': ai === 0 }"
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
    <div v-if="showAdd" class="modal-mask" @click.self="closeAdd" @keydown.esc="closeAdd">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="add-source-title">
        <h3 id="add-source-title">{{ editingSource ? t('catalog.editModalTitle') : t('catalog.addModalTitle') }}</h3>
        <div class="form-row">
          <label for="src-conn">{{ t('catalog.pasteConnection') }}</label>
          <textarea
            id="src-conn"
            v-model="connText"
            class="input conn-input"
            rows="3"
            autocomplete="off"
            spellcheck="false"
            :placeholder="t('catalog.pasteConnectionPlaceholder')"
            aria-describedby="src-conn-status"
            @paste="onConnectionPaste($event, false)"
          />
          <p id="src-conn-status" class="conn-status" :class="{ error: connStatus && !connStatus.ok }" role="status">{{ connStatus?.text ?? '' }}</p>
        </div>
        <div class="form-row">
          <label for="src-name">{{ t('catalog.name') }}</label>
          <input id="src-name" v-model="newTitle" class="input" :placeholder="t('catalog.namePlaceholder')" v-autofocus />
        </div>
        <div class="form-row">
          <label for="src-url">{{ t('catalog.opdsUrl') }}</label>
          <input id="src-url" v-model="newUrl" class="input" type="url" inputmode="url" placeholder="https://example.com/opds" @paste="onConnectionPaste($event, true)" />
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
          <button class="btn" @click="closeAdd">{{ t('common.cancel') }}</button>
          <button class="btn btn-primary" :disabled="!newUrl.trim()" @click="saveSource">{{ editingSource ? t('common.save') : t('common.add') }}</button>
        </div>
      </div>
    </div>
    <LibraryUploadDialog v-if="uploadTarget" :source="uploadTarget" @close="uploadTarget = null" />
  </div>
</template>

<style scoped>
.catalog {
  min-width: 0;
  overflow-wrap: anywhere;
  padding: var(--page-top) var(--page-x) calc(var(--page-bottom) + var(--lr-safe-bottom));
  min-height: 100%;
  max-width: calc(var(--page-max) + 2 * var(--page-x));
  margin: 0 auto;
}
.spacer {
  flex: 1;
}
.spin {
  animation: spin 0.9s linear infinite;
}

/* ---- 页头 ---- */
.page-head {
  display: flex;
  /* Windows 自绘窗口按钮在右上角, 标题行右侧让开 (--chrome-inset-right, styles/main.css) */
  padding-right: var(--chrome-inset-right);
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}
.page-title h1 {
  font-size: var(--page-title);
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.3;
}
.page-title p {
  margin-top: 4px;
  font-size: 13px;
  color: var(--text-3);
  line-height: 1.6;
}
.page-head .btn {
  flex-shrink: 0;
}

/* ---- 统一搜书 ---- */
.uni-section {
  padding: 18px 20px;
  margin-bottom: 36px;
}
.uni-search {
  display: flex;
  gap: 10px;
}
.uni-field {
  flex: 1;
  min-width: 0;
  position: relative;
  display: flex;
  align-items: center;
}
.uni-field-icon {
  position: absolute;
  left: 14px;
  color: var(--text-3);
  pointer-events: none;
  transition: color var(--dur-fast) var(--ease);
}
.uni-field:focus-within .uni-field-icon {
  color: var(--brand);
}
.uni-input {
  width: 100%;
  height: 46px;
  padding: 0 16px 0 42px;
  border: 1px solid transparent;
  border-radius: var(--radius-pill);
  background: var(--surface-2);
  color: var(--text);
  font: inherit;
  font-size: 15px;
  outline: none;
  transition:
    border-color var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease);
}
.uni-input::placeholder {
  color: var(--text-3);
}
.uni-input:hover:not(:focus) {
  border-color: var(--border-strong);
}
.uni-input:focus {
  background: var(--card);
  border-color: var(--brand);
  box-shadow: var(--ring);
}
.uni-input::-webkit-search-cancel-button {
  -webkit-appearance: none;
  appearance: none;
}
.uni-submit {
  height: 46px;
  min-width: 88px;
  padding: 0 22px;
  border-radius: var(--radius-pill);
  font-size: 15px;
}

.uni-scope-row {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-top: 14px;
}
.uni-scope-label {
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-3);
}
.uni-scopes {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 13px;
}
.check-chip {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--card);
  color: var(--text-2);
  cursor: pointer;
  user-select: none;
  transition:
    border-color var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
/* 原生复选框铺满整个胶囊、透明: 保留可访问性与点击区域, 状态由胶囊样式表达 */
.check-chip input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: inherit;
}
.check-chip:hover {
  border-color: var(--border-strong);
  color: var(--text);
}
.check-chip.on {
  background: var(--brand-soft);
  border-color: color-mix(in srgb, var(--brand) 45%, transparent);
  color: var(--brand);
}
.check-chip:focus-within {
  box-shadow: var(--ring);
}
.check-chip.disabled {
  opacity: 0.6;
  cursor: default;
}
.chip-mark {
  flex-shrink: 0;
}
.chip-check {
  width: 0;
  margin-left: -5px;
  opacity: 0;
  transition:
    width var(--dur-fast) var(--ease),
    margin var(--dur-fast) var(--ease),
    opacity var(--dur-fast) var(--ease);
}
.check-chip.on .chip-check {
  width: 13px;
  margin-left: -2px;
  opacity: 1;
}
.uni-hint {
  margin-top: 12px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-3);
}
.uni-hint.warn {
  color: var(--warning);
}
.gh-notice {
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
  margin-top: 12px;
  padding: 8px 12px;
  border-radius: var(--radius);
  background: var(--warning-soft);
  color: var(--warning);
  font-size: 12px;
  line-height: 1.6;
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.source-errors {
  flex: 1;
  min-width: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}
.source-errors li + li {
  margin-top: 4px;
}
.gh-notice svg {
  flex-shrink: 0;
  margin-top: 2px;
}
.uni-progress {
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--brand);
}

/* 搜索结果 */
.uni-results {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.uni-group {
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 4px 6px 6px;
}
.uni-group.mine-group {
  border-color: color-mix(in srgb, var(--brand) 30%, var(--border));
}
.uni-group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 10px 6px;
  font-size: 13px;
}
.uni-group-name {
  min-width: 0;
  overflow-wrap: anywhere;
  font-weight: 600;
  color: var(--text);
}
.uni-group-count {
  color: var(--text-3);
  font-size: 12px;
}
.mine-tag {
  height: 20px;
  font-size: 11px;
}
.uni-group-msg {
  overflow-wrap: anywhere;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-3);
  padding: 0 10px 8px;
}
.uni-group-msg.error {
  color: var(--danger);
}
.uni-skeleton {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 6px 10px 10px;
}
.uni-skeleton .skeleton {
  height: 14px;
  width: 46%;
  border-radius: var(--radius-sm);
}
.uni-skeleton .skeleton + .skeleton {
  width: 28%;
  height: 11px;
}
.gh-item {
  position: relative;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 16px;
  padding: 9px 10px;
  border-radius: var(--radius);
  transition: background var(--dur-fast) var(--ease);
}
.gh-item + .gh-item::before {
  content: '';
  position: absolute;
  top: 0;
  left: 10px;
  right: 10px;
  border-top: 1px solid var(--border);
}
.gh-item:hover {
  background: var(--surface-2);
}
.gh-item:hover::before,
.gh-item:hover + .gh-item::before {
  border-color: transparent;
}
.gh-item.busy {
  background: var(--brand-soft);
}
.uni-pub-main {
  flex: 1 1 260px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.gh-name {
  font-size: 14px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--text);
  overflow-wrap: anywhere;
}
.gh-meta {
  font-size: 12px;
  color: var(--text-3);
  overflow-wrap: anywhere;
}
.access.public {
  color: var(--success);
}
.uni-acts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-left: auto;
}
.btn-accent {
  background: var(--brand-soft);
  border-color: transparent;
  color: var(--brand);
}
.btn-accent:hover {
  background: color-mix(in srgb, var(--brand) 18%, transparent);
  border-color: transparent;
  color: var(--brand);
}
.btn-accent:disabled {
  background: var(--brand-soft);
  border-color: transparent;
}
.uni-more {
  display: flex;
  justify-content: center;
  gap: 6px;
  padding: 4px 0 2px;
}
.uni-more .btn {
  color: var(--brand);
}
.uni-empty {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 14px 16px;
  border-radius: var(--radius-lg);
  background: var(--surface-2);
  color: var(--text-3);
  font-size: 13px;
  line-height: 1.7;
}
.uni-empty svg {
  flex-shrink: 0;
  margin-top: 1px;
}
.uni-empty-title {
  color: var(--text);
  font-weight: 500;
}
.uni-empty-sources {
  font-size: 12px;
  color: var(--text-3);
  padding: 0 4px;
}

/* ---- 分区 ---- */
.cat-section {
  margin-top: 36px;
}
.section-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px 16px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.section-head h2 {
  font-size: 19px;
  font-weight: 650;
  line-height: 1.4;
}
.section-desc {
  margin-top: 2px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-3);
  max-width: 640px;
}
.section-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

/* 书库与目录 */
.source-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}
.source-card {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 14px 12px 16px;
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
.source-top {
  display: flex;
  align-items: center;
  gap: 12px;
}
.source-icon {
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  border-radius: var(--radius-lg);
  display: grid;
  place-items: center;
  background: var(--surface-2);
  color: var(--text-2);
}
.source-card.custom .source-icon {
  background: var(--brand-soft);
  color: var(--brand);
}
.source-body {
  flex: 1;
  min-width: 0;
}
.source-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.source-title-row .tag {
  flex-shrink: 0;
  height: 20px;
  font-size: 11px;
}
.source-title {
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.source-url {
  margin-top: 2px;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.source-url svg {
  flex-shrink: 0;
}
.source-chevron {
  color: var(--text-3);
  flex-shrink: 0;
  transition: transform var(--dur) var(--ease), color var(--dur) var(--ease);
}
.source-card:hover .source-chevron {
  color: var(--brand);
  transform: translateX(2px);
}
.source-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding-left: 52px;
}
.tag-muted {
  background: var(--surface-2);
  color: var(--text-3);
}
.source-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
}
.source-actions .btn:first-child:not(.btn-icon) {
  margin-right: 4px;
}
.add-source-card {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 72px;
  padding: 14px 16px;
  border: 1.5px dashed var(--border-strong);
  border-radius: var(--radius-lg);
  background: transparent;
  color: var(--text-2);
  text-align: left;
  cursor: pointer;
  transition:
    border-color var(--dur) var(--ease),
    background var(--dur) var(--ease),
    color var(--dur) var(--ease);
}
.add-source-card:hover {
  border-color: var(--brand);
  background: var(--brand-soft);
  color: var(--brand);
}
.add-source-card:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.add-icon {
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  border-radius: var(--radius-lg);
  display: grid;
  place-items: center;
  background: var(--surface-2);
  color: inherit;
}
.add-source-card:hover .add-icon {
  background: var(--card);
}
.add-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.add-text strong {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}
.add-source-card:hover .add-text strong {
  color: var(--brand);
}
.add-text span {
  font-size: 12px;
  color: var(--text-3);
}

/* 更多下载网站 */
.web-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}
.web-source-card {
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.web-head {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.web-avatar {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  border-radius: var(--radius);
  display: grid;
  place-items: center;
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 13px;
  font-weight: 650;
}
.web-desc {
  flex: 1;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-3);
}
.web-open {
  align-self: flex-start;
}

/* GitHub 书库 */
.gh-card {
  padding: 4px 16px;
}
.gh-row {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 12px 0;
}
.gh-row-label {
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-3);
}
.gh-repos {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
  min-width: 0;
}
.gh-repo-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  font-size: 12px;
  color: var(--text-2);
  background: var(--card);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  width: 220px;
  max-width: 100%;
  font-size: 12px;
  border-radius: var(--radius-pill);
}

/* Calibre 书库 */
.calibre-path {
  max-width: 520px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 12px;
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
  border-radius: var(--radius-sm);
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

/* ---- 书单推荐 ---- */
.curated-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}
.curated-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 14px 12px 16px;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    box-shadow var(--dur) var(--ease),
    border-color var(--dur) var(--ease),
    transform var(--dur) var(--ease);
}
.curated-card:hover {
  box-shadow: var(--shadow-md);
  border-color: color-mix(in srgb, var(--brand) 30%, var(--border));
  transform: translateY(-1px);
}
.curated-card:focus-visible {
  outline: none;
  box-shadow: var(--ring), var(--shadow-md);
}
.curated-card:hover .source-chevron {
  color: var(--brand);
  transform: translateX(2px);
}
.curated-top {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.curated-icon {
  background: var(--brand-soft);
  color: var(--brand);
}
.curated-card .source-title {
  display: block;
}
.curated-desc {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.curated-foot {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 22px;
}
.curated-foot .tag {
  height: 20px;
  font-size: 11px;
}
.curated-owned {
  background: color-mix(in srgb, var(--success) 14%, transparent);
  color: var(--success);
}
.curated-tag {
  font-size: 12px;
  color: var(--text-3);
}
.curated-updated {
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-3);
}

/* 书单详情 */
.curated-hero {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px 24px;
  flex-wrap: wrap;
  padding: 18px 20px;
  margin-bottom: 16px;
}
.curated-hero-main {
  flex: 1 1 360px;
  min-width: 0;
}
.curated-hero h1 {
  font-size: 22px;
  font-weight: 650;
  letter-spacing: -0.01em;
  line-height: 1.3;
}
.curated-hero-desc {
  margin-top: 6px;
  font-size: 14px;
  line-height: 1.7;
  color: var(--text-2);
  max-width: 720px;
}
.curated-meta {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  font-size: 12px;
  color: var(--text-3);
}
.curated-owned-text {
  color: var(--success);
}
.curated-link {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  color: var(--brand);
  cursor: pointer;
}
.curated-link:hover {
  text-decoration: underline;
}
.curated-add {
  flex-shrink: 0;
}
.curated-books {
  list-style: none;
  margin: 0;
  padding: 6px;
}
.curated-book {
  position: relative;
  border-radius: var(--radius);
}
.curated-book + .curated-book::before {
  content: '';
  position: absolute;
  top: 0;
  left: 10px;
  right: 10px;
  border-top: 1px solid var(--border);
}
.curated-book.finding {
  background: var(--surface-2);
}
.curated-book.finding::before,
.curated-book.finding + .curated-book::before {
  border-color: transparent;
}
.curated-row {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 6px 14px;
  padding: 11px 10px;
}
.curated-num {
  flex-shrink: 0;
  width: 24px;
  padding-top: 1px;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--text-3);
  text-align: right;
}
.curated-row .uni-pub-main {
  flex: 1 1 240px;
}
.curated-row .uni-acts {
  align-items: center;
}
.curated-orig {
  margin-left: 6px;
  font-size: 12px;
  font-weight: 400;
  color: var(--text-3);
}
.curated-note {
  margin-top: 2px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-2);
}
.curated-book.owned .gh-name {
  color: var(--text);
}
.curated-find:empty {
  display: none;
}
.curated-find {
  padding: 0 10px 4px 48px;
}
.curated-find .uni-results {
  margin-top: 4px;
}
.curated-find .uni-group {
  background: var(--card);
}
.curated-find-foot {
  display: flex;
  justify-content: flex-end;
  padding: 0 10px 8px;
}

/* ---- 目录浏览 ---- */
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}
.crumbs {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;
  min-width: 0;
}
.crumb {
  border: none;
  background: none;
  color: var(--text-3);
  font-size: 13px;
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.crumb:hover {
  background: var(--surface-2);
  color: var(--text);
}
.crumb.current {
  color: var(--text);
  font-weight: 600;
}
.crumb-sep {
  color: var(--border-strong);
  font-size: 12px;
}
.dir-search {
  position: relative;
  display: flex;
  align-items: center;
}
.dir-search svg {
  position: absolute;
  left: 11px;
  color: var(--text-3);
  pointer-events: none;
}
.dir-search .input {
  width: 240px;
  padding-left: 32px;
}
.nav-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 10px;
  margin-bottom: 24px;
}
.nav-card {
  padding: 12px 12px 12px 16px;
  text-align: left;
  display: flex;
  align-items: center;
  gap: 8px;
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
.nav-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
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
.nav-chevron {
  flex-shrink: 0;
  color: var(--text-3);
  transition: transform var(--dur) var(--ease), color var(--dur) var(--ease);
}
.nav-card:hover .nav-chevron {
  color: var(--brand);
  transform: translateX(2px);
}
.pub-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 440px), 1fr));
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
  border-radius: var(--radius-sm);
  flex-shrink: 0;
  background: var(--surface-2);
  box-shadow: var(--shadow-sm);
}
.pub-cover.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
  box-shadow: none;
}
.pub-info {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
}
.pub-title {
  font-weight: 600;
  line-height: 1.5;
  margin-bottom: 2px;
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
  gap: 6px;
  flex-wrap: wrap;
  margin-top: auto;
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

/* ---- 添加 / 编辑书源弹窗 ---- */
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
.conn-input {
  min-height: 72px;
  resize: vertical;
  font-size: 13px;
  line-height: 1.6;
  padding: 8px 10px;
  height: auto;
}
.conn-status {
  min-height: 1em;
  font-size: 12px;
  color: var(--success);
  line-height: 1.5;
}
.conn-status:empty {
  display: none;
}
.conn-status.error {
  color: var(--warning);
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spin,
  .empty-icon.spinner svg {
    animation-duration: 2.4s;
  }
  .source-card:hover,
  .curated-card:hover {
    transform: none;
  }
}

@media (max-width: 720px) {
  .page-title p {
    display: none;
  }
  .uni-section {
    padding: 14px;
    margin-bottom: 28px;
  }
  .uni-search {
    gap: 8px;
  }
  .uni-input,
  .uni-submit {
    height: 44px;
  }
  .uni-submit {
    min-width: 0;
    padding: 0 16px;
  }
  .uni-scope-row {
    flex-direction: column;
    gap: 8px;
  }
  .uni-group {
    padding: 2px 2px 4px;
  }
  .uni-pub-main {
    flex-basis: 180px;
  }
  .uni-acts {
    margin-left: 0;
  }
  .uni-acts > .btn-ghost:first-child {
    margin-left: -11px;
  }
  .check-chip {
    padding: 0 10px;
  }
  .web-source-card {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 6px 10px;
    padding: 12px 14px;
  }
  .web-desc {
    grid-column: 1 / -1;
    grid-row: 2;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .web-open {
    grid-column: 2;
    grid-row: 1;
    align-self: center;
  }
  .cat-section {
    margin-top: 28px;
  }
  .source-grid,
  .web-grid,
  .curated-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .curated-hero {
    padding: 14px;
  }
  .curated-hero h1 {
    font-size: 19px;
  }
  .curated-add {
    width: 100%;
    justify-content: center;
  }
  .curated-row {
    padding: 10px 6px;
  }
  .curated-num {
    width: 18px;
  }
  .curated-row .uni-acts {
    margin-left: 32px;
  }
  .curated-find {
    padding: 0 4px 4px;
  }
  .gh-row {
    flex-direction: column;
    gap: 8px;
  }
  .gh-repo-add {
    width: 100%;
  }
  .toolbar {
    gap: 8px;
  }
  .dir-search {
    order: 10;
    flex: 1 1 100%;
  }
  .dir-search .input {
    width: 100%;
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
/* ---- 手机书源页 (原型 2026-10-17): 圆形「＋」、搜索条去卡片、范围一行横滑、书单横滑、书源与网站合成分组列表 ---- */
@media (max-width: 720px) {
  .page-head {
    align-items: center;
    margin: 0 0 8px;
    min-height: 44px;
  }
  .page-title h1 {
    font-size: 26px;
    font-weight: 700;
    letter-spacing: 0.02em;
  }
  .add-source-btn {
    position: relative;
    width: 36px;
    height: 36px;
    min-height: 0;
    padding: 0;
    border-radius: 50%;
    justify-content: center;
    box-shadow: 0 2px 8px -2px color-mix(in srgb, var(--brand) 60%, transparent);
  }
  .add-source-btn::before {
    content: '';
    position: absolute;
    inset: -4px;
  }
  .add-source-btn svg {
    width: 20px;
    height: 20px;
  }
  .add-source-label {
    display: none;
  }

  .uni-section {
    margin: 0 0 8px;
    padding: 0;
    border: none;
    background: none;
    box-shadow: none;
  }
  .uni-search {
    position: relative;
  }
  .uni-input {
    height: 44px;
    padding-right: 72px;
    border-color: transparent;
    background: var(--card);
    box-shadow: var(--shadow-sm);
    font-size: 16px;
  }
  :root[data-theme='dark'] .uni-input {
    background: var(--surface-2);
    box-shadow: none;
  }
  .uni-submit {
    position: absolute;
    top: 4px;
    right: 4px;
    height: 36px;
    padding: 0 14px;
    border: none;
    border-radius: var(--radius);
    font-size: 14px;
  }
  .uni-submit:disabled {
    background: none;
    color: var(--text-3);
    opacity: 1;
  }
  .uni-scope-row {
    flex-direction: row;
    align-items: center;
    gap: 8px;
    margin: 10px calc(-1 * var(--page-x)) 0;
    padding: 0 var(--page-x) 2px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .uni-scope-row::-webkit-scrollbar {
    display: none;
  }
  .uni-scopes {
    flex-wrap: nowrap;
  }
  .check-chip {
    flex-shrink: 0;
    white-space: nowrap;
    border-color: transparent;
    background: var(--card);
    box-shadow: var(--shadow-sm);
  }
  :root[data-theme='dark'] .check-chip {
    background: var(--surface-2);
    box-shadow: none;
  }
  .check-chip.on {
    border-color: transparent;
    box-shadow: none;
  }
  .uni-hint {
    margin-top: 8px;
  }
  .uni-group {
    padding: 4px 14px 6px;
    border: none;
    border-radius: var(--radius-xl);
    background: var(--card);
    box-shadow: var(--shadow-sm);
  }

  /* 区块标题: 标题一行, 说明收成一行小字, 操作按钮变成文字按钮 */
  .cat-section {
    margin-top: 24px;
  }
  .section-head {
    flex-wrap: nowrap;
    align-items: center;
    margin-bottom: 10px;
  }
  .section-head > div:first-child {
    min-width: 0;
  }
  .section-head h2 {
    font-size: 17px;
    font-weight: 700;
  }
  .section-desc {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
  }
  .section-actions {
    flex-wrap: nowrap;
    gap: 0;
    flex-shrink: 0;
  }
  .gh-section .section-head {
    flex-wrap: wrap;
  }
  .gh-section .section-actions {
    margin-left: -8px;
  }
  .section-actions .btn {
    height: 32px;
    padding: 0 8px;
    border: none;
    background: none;
    box-shadow: none;
    color: var(--brand);
    font-size: 13px;
  }

  /* 书单推荐: 一行横滑 */
  .curated-grid {
    display: flex;
    gap: 12px;
    margin: 0 calc(-1 * var(--page-x));
    padding: 2px var(--page-x) 6px;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    scroll-padding-inline: var(--page-x);
    scrollbar-width: none;
  }
  .curated-grid::-webkit-scrollbar {
    display: none;
  }
  .curated-card {
    flex: none;
    width: 228px;
    scroll-snap-align: start;
    border: none;
    box-shadow: var(--shadow-sm);
  }
  .curated-card .curated-desc {
    -webkit-line-clamp: 2;
  }
  .curated-card .source-chevron {
    display: none;
  }
  .curated-updated {
    display: none;
  }

  /* 书源 / 下载网站: 一张卡片里的分组列表 */
  .source-grid,
  .web-grid {
    display: block;
    border-radius: var(--radius-xl);
    background: var(--card);
    box-shadow: var(--shadow-sm);
    overflow: hidden;
  }
  .source-card,
  .web-source-card {
    position: relative;
    gap: 6px;
    padding: 12px 14px;
    border: none;
    border-radius: 0;
    background: none;
    box-shadow: none;
  }
  .source-card:hover {
    transform: none;
    box-shadow: none;
  }
  .source-card:active,
  .add-source-card:active {
    background: var(--surface-2);
  }
  .source-card + .source-card::before,
  .source-grid > .add-source-card::before,
  .web-source-card + .web-source-card::before {
    content: '';
    position: absolute;
    top: 0;
    left: 66px;
    right: 0;
    height: 1px;
    background: var(--border);
  }
  .source-icon {
    width: 40px;
    height: 40px;
  }
  .source-foot {
    min-height: 0;
  }
  .add-source-card {
    position: relative;
    width: 100%;
    min-height: 56px;
    justify-content: center;
    border: none;
    border-radius: 0;
    color: var(--brand);
  }
  .add-source-card::before {
    left: 14px !important;
  }
  .add-source-card .add-icon {
    width: auto;
    height: auto;
    background: none;
  }
  .add-source-card .add-text strong {
    color: var(--brand);
  }
  .add-source-card .add-text span {
    display: none;
  }
  .web-source-card {
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 2px 12px;
  }
  .web-head {
    display: contents;
  }
  .web-avatar {
    grid-row: 1 / 3;
    width: 40px;
    height: 40px;
    border-radius: var(--radius-lg);
    font-size: 15px;
  }
  .web-head .source-title {
    grid-column: 2;
    grid-row: 1;
  }
  .web-desc {
    grid-column: 2;
    grid-row: 2;
    -webkit-line-clamp: 1;
    line-height: 1.5;
  }
  .web-open {
    grid-column: 3;
    grid-row: 1 / 3;
    height: 36px;
    padding: 0 12px;
    border: none;
    background: var(--brand-soft);
    color: var(--brand);
  }
}
</style>
