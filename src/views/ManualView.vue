<script setup lang="ts">
import AppSelect from '../components/AppSelect.vue'
/**
 * 应用内《轻阅使用手册》: 打包 docs/manual/*.md (离线可看), 用 marked 渲染。
 * 文档之间的相对链接 (02-阅读模式.md#xxx) 在页内切换; 仓库里其他文档链到 GitHub; 外链用系统浏览器打开。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { marked, type Tokens } from 'marked'
import { t } from '../i18n'
import { siteUrlForRepoPath } from '../services/siteLinks'

const route = useRoute()
const router = useRouter()

const loaders = import.meta.glob('../../docs/manual/*.md', { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>
const REPO = 'https://github.com/yzfly/LightRead/blob/main/'

/** 手册章节: 文件名 → 标题 (取文档首个 # 标题, 未加载前用文件名) */
const files = Object.keys(loaders)
  .map(p => p.split('/').pop()!)
  .sort((a, b) => (a === 'README.md' ? -1 : b === 'README.md' ? 1 : a.localeCompare(b)))
const titles = ref<Record<string, string>>({})
const current = ref<string>(files.includes(String(route.query.doc)) ? String(route.query.doc) : 'README.md')
const html = ref('')
const loading = ref(false)
const article = ref<HTMLElement>()

/** 与 GitHub 一致的标题锚点: 小写, 去掉标点, 空白换成 - */
function slug(text: string) {
  return text.trim().toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
}

function render(md: string) {
  const used = new Map<string, number>()
  const renderer = new marked.Renderer()
  renderer.heading = function (this: any, token: Tokens.Heading) {
    const text = this.parser.parseInline(token.tokens)
    let id = slug(token.text)
    const n = used.get(id) ?? 0
    used.set(id, n + 1)
    if (n) id = `${id}-${n}`
    return `<h${token.depth} id="${id}">${text}</h${token.depth}>\n`
  }
  return marked.parse(md, { renderer, gfm: true, async: false }) as string
}

async function load(file: string) {
  const key = Object.keys(loaders).find(p => p.endsWith('/' + file))
  if (!key) return
  loading.value = true
  try {
    const md = await loaders[key]()
    html.value = render(md)
    const h1 = md.match(/^#\s+(.+)$/m)
    if (h1) titles.value = { ...titles.value, [file]: h1[1].trim() }
  } finally {
    loading.value = false
  }
  await nextTick()
  const hash = String(route.hash || '').slice(1)
  if (hash) document.getElementById(decodeURIComponent(hash))?.scrollIntoView({ block: 'start' })
  else article.value?.scrollTo?.({ top: 0 })
}

watch(current, file => {
  void router.replace({ query: { ...route.query, doc: file }, hash: '' })
  void load(file)
})

onMounted(async () => {
  await load(current.value)
  // 预取各章标题, 目录显示中文名
  for (const f of files) {
    if (titles.value[f]) continue
    const key = Object.keys(loaders).find(p => p.endsWith('/' + f))!
    const md = await loaders[key]()
    const h1 = md.match(/^#\s+(.+)$/m)
    if (h1) titles.value = { ...titles.value, [f]: h1[1].trim() }
  }
})

/** 在官网打开当前这一章 (网页版与应用内同一份 docs/manual) */
function openOnWeb() {
  void openExternal(siteUrlForRepoPath(`docs/manual/${current.value}`))
}

const chapters = computed(() => files.map(f => ({ file: f, title: titles.value[f] ?? f.replace(/\.md$/, '') })))

async function openExternal(url: string) {
  const { openDownload } = await import('../services/updater')
  openDownload(url)
}

/** 拦截正文里的链接: 手册内跳转 / 仓库文档 / 外链 */
function onClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest('a')
  if (!a) return
  const href = a.getAttribute('href') ?? ''
  if (!href) return
  e.preventDefault()
  if (href.startsWith('#')) {
    document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    return
  }
  if (/^https?:/i.test(href)) {
    void openExternal(href)
    return
  }
  const [rawPath, hash] = href.split('#')
  // marked 会把中文文件名编码成 %E8…, 先还原再比对
  let path = rawPath
  try { path = decodeURIComponent(rawPath) } catch { /* 保持原样 */ }
  const name = path.split('/').pop() ?? ''
  if (!path.includes('/') && files.includes(name)) {
    if (name === current.value) {
      if (hash) document.getElementById(decodeURIComponent(hash))?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } else {
      void router.replace({ query: { ...route.query, doc: name }, hash: hash ? `#${hash}` : '' })
      current.value = name
    }
    return
  }
  // 仓库里的其他文件 (../paper-reading.md 等) 去官网看, 官网没有的去 GitHub
  let repoPath = new URL(href, `${REPO}docs/manual/`).href.slice(REPO.length)
  try { repoPath = decodeURIComponent(repoPath) } catch { /* 保持原样 */ }
  void openExternal(siteUrlForRepoPath(repoPath))
}
</script>

<template>
  <div class="manual">
    <header class="page-head">
      <button class="icon-btn" :title="t('common.back')" :aria-label="t('common.back')" @click="router.back()">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M14.7 5.3a1 1 0 0 1 0 1.4L9.42 12l5.3 5.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0z"/></svg>
      </button>
      <h1>{{ t('manual.title') }}</h1>
      <button class="icon-btn web-btn" :title="t('manual.openOnWeb')" :aria-label="t('manual.openOnWeb')" @click="openOnWeb">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></svg>
      </button>
    </header>

    <div class="manual-body">
      <nav class="manual-toc" :aria-label="t('manual.toc')">
        <button
          v-for="c in chapters"
          :key="c.file"
          type="button"
          class="toc-item"
          :class="{ active: c.file === current }"
          :aria-current="c.file === current ? 'page' : undefined"
          @click="current = c.file"
        >{{ c.title }}</button>
      </nav>

      <AppSelect v-model="current" class="input manual-select" :aria-label="t('manual.toc')">
        <option v-for="c in chapters" :key="c.file" :value="c.file">{{ c.title }}</option>
      </AppSelect>

      <!-- 手册内容来自仓库内的 docs/manual, 不含用户输入 -->
      <article ref="article" class="manual-content" :aria-busy="loading" @click="onClick" v-html="html" />
    </div>
  </div>
</template>

<style scoped>
.manual {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg);
  color: var(--text);
}
.page-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: calc(12px + var(--lr-safe-top)) calc(var(--page-x) + var(--chrome-inset-right)) 12px var(--page-x);
}
.web-btn {
  margin-left: auto;
}
.page-head h1 {
  margin: 0;
  font-size: var(--page-title);
}
.icon-btn {
  width: var(--icon-btn);
  height: var(--icon-btn);
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.icon-btn:hover {
  background: var(--surface-2);
  color: var(--brand);
}
.manual-body {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 20px;
  padding: 0 var(--page-x) calc(20px + var(--lr-safe-bottom));
}
.manual-toc {
  flex-shrink: 0;
  width: 200px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
}
.toc-item {
  padding: 8px 12px;
  border: none;
  border-radius: var(--radius);
  background: none;
  color: var(--text-2);
  font-size: 14px;
  text-align: left;
}
.toc-item:hover {
  background: var(--surface-2);
}
.toc-item.active {
  background: var(--brand-light);
  color: var(--brand);
  font-weight: 500;
}
.manual-select {
  display: none;
}
.manual-content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 8px 28px 40px;
  border-radius: var(--radius-lg);
  background: var(--card);
  line-height: 1.8;
  font-size: 15px;
}
.manual-content :deep(h1) {
  font-size: 24px;
  margin: 20px 0 12px;
}
.manual-content :deep(h2) {
  font-size: 19px;
  margin: 28px 0 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}
.manual-content :deep(h3) {
  font-size: 16px;
  margin: 20px 0 8px;
}
.manual-content :deep(p),
.manual-content :deep(li) {
  color: var(--text);
}
.manual-content :deep(ul),
.manual-content :deep(ol) {
  padding-left: 1.4em;
}
.manual-content :deep(li + li) {
  margin-top: 2px;
}
.manual-content :deep(a) {
  color: var(--brand);
  text-decoration: none;
}
.manual-content :deep(a:hover) {
  text-decoration: underline;
}
.manual-content :deep(blockquote) {
  margin: 12px 0;
  padding: 8px 14px;
  border-left: 3px solid var(--brand);
  background: var(--surface-2);
  color: var(--text-2);
}
.manual-content :deep(code) {
  padding: 1px 5px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  font-size: 0.9em;
}
.manual-content :deep(table) {
  width: 100%;
  margin: 12px 0;
  border-collapse: collapse;
  font-size: 14px;
  display: block;
  overflow-x: auto;
}
.manual-content :deep(th),
.manual-content :deep(td) {
  padding: 6px 10px;
  border: 1px solid var(--border);
  text-align: left;
  vertical-align: top;
}
.manual-content :deep(th) {
  background: var(--surface-2);
}
.manual-content :deep(hr) {
  margin: 24px 0;
  border: none;
  border-top: 1px solid var(--border);
}

@media (max-width: 720px) {
  .manual-body {
    flex-direction: column;
    gap: 10px;
    padding-bottom: calc(12px + var(--lr-safe-bottom));
  }
  .manual-toc {
    display: none;
  }
  .manual-select {
    display: block;
    font-size: 16px;
  }
  .manual-content {
    padding: 4px 16px 32px;
  }
}
</style>
