/** OPDS 目录客户端: 基于 foliate-js 的协议解析 */
import { getFeed, isOPDSCatalog, SYMBOL } from 'foliate-js/opds.js'
import { fetchXml, fetchBlob, type RequestAuth } from './net'
import { detectFormat } from './format'
import { importFile } from './importer'

export interface OpdsNavItem {
  title: string
  href: string
  summary?: string
}

export interface OpdsPubLink {
  href: string
  type?: string
  rel?: string | string[]
}

export interface OpdsPublication {
  title: string
  author: string
  summary?: string
  coverUrl?: string
  /** 可下载的获取链接 (已过滤出可读格式) */
  acquisitions: Array<{ href: string; type: string; label: string }>
}

export interface OpdsPage {
  title: string
  navigation: OpdsNavItem[]
  publications: OpdsPublication[]
  /** 下一页链接 (分页目录) */
  next?: string
  /** OpenSearch 搜索模板 */
  searchUrl?: string
}

const ACQ_TYPE_LABELS: Array<[RegExp, string]> = [
  [/epub\+zip/, 'EPUB'],
  [/x-mobipocket/, 'MOBI'],
  [/fb2/, 'FB2'],
  [/pdf/, 'PDF'],
  [/plain/, 'TXT'],
]

const resolve = (base: string, href?: string) => {
  if (!href) return ''
  try {
    return new URL(href, base).href
  } catch {
    return href
  }
}

function flattenText(value: any): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(flattenText).filter(Boolean).join(', ')
  if (typeof value === 'object') return value.name ?? value.value ?? ''
  return ''
}

function toPublication(pub: any, baseUrl: string): OpdsPublication {
  const links: OpdsPubLink[] = pub.links ?? []
  const acquisitions: OpdsPublication['acquisitions'] = []
  for (const link of links) {
    const rels = Array.isArray(link.rel) ? link.rel : [link.rel ?? '']
    const isAcq = rels.some((r: string) => r?.includes('acquisition'))
    if (!isAcq || !link.href) continue
    const type = link.type ?? ''
    const labelEntry = ACQ_TYPE_LABELS.find(([re]) => re.test(type))
    // 只保留能读的格式
    if (!labelEntry) continue
    acquisitions.push({
      href: resolve(baseUrl, link.href),
      type,
      label: labelEntry[1],
    })
  }
  const summaryContent = pub.metadata?.[SYMBOL.CONTENT]
  const summary = typeof summaryContent === 'object'
    ? summaryContent?.value ?? ''
    : summaryContent ?? ''
  const coverHref = pub.images?.[0]?.href
  return {
    title: flattenText(pub.metadata?.title),
    author: flattenText(pub.metadata?.author),
    summary: summary ? String(summary).replace(/<[^>]+>/g, '').slice(0, 400) : undefined,
    coverUrl: coverHref ? resolve(baseUrl, coverHref) : undefined,
    acquisitions,
  }
}

export async function loadOpdsPage(url: string, auth?: RequestAuth): Promise<OpdsPage> {
  const doc = await fetchXml(url, auth)
  const feed = getFeed(doc)

  const navigation: OpdsNavItem[] = []
  const publications: OpdsPublication[] = []

  const collect = (items: any[] | undefined) => {
    for (const item of items ?? []) {
      if (item.metadata) {
        publications.push(toPublication(item, url))
      } else if (item.href) {
        navigation.push({
          title: item.title ?? item.href,
          href: resolve(url, item.href),
          summary: item[SYMBOL.SUMMARY] ? String(item[SYMBOL.SUMMARY]).slice(0, 200) : undefined,
        })
      }
    }
  }
  collect(feed.navigation)
  collect(feed.publications)
  for (const group of feed.groups ?? []) {
    collect(group.navigation)
    collect(group.publications)
  }

  const links: OpdsPubLink[] = feed.links ?? []
  const findRel = (want: string) => links.find(l => {
    const rels = Array.isArray(l.rel) ? l.rel : [l.rel ?? '']
    return rels.includes(want)
  })
  const next = findRel('next')?.href
  const search = links.find(l => {
    const rels = Array.isArray(l.rel) ? l.rel : [l.rel ?? '']
    return rels.includes('search') && (isOPDSCatalog(l.type ?? '') || l.type?.includes('opensearch'))
  })

  return {
    title: flattenText(feed.metadata?.title) || url,
    navigation,
    publications,
    next: next ? resolve(url, next) : undefined,
    searchUrl: search?.href ? resolve(url, search.href) : undefined,
  }
}

/** OpenSearch 模板简单填充 ({searchTerms}) */
export function fillSearchTemplate(template: string, query: string): string {
  return template
    .replace(/\{searchTerms\}/g, encodeURIComponent(query))
    .replace(/\{[^}]*\?\}/g, '')
}

/** 下载出版物并导入藏书, 书目元数据优先于文件内嵌元数据 */
export async function downloadToLibrary(
  pub: OpdsPublication,
  acq: OpdsPublication['acquisitions'][number],
  sourceTitle: string,
  auth?: RequestAuth,
  kind?: 'book' | 'paper',
) {
  const { blob, contentType } = await fetchBlob(acq.href, auth)
  // 从 URL 或 MIME 推断文件名
  let ext = acq.label.toLowerCase()
  if (ext === 'mobi') ext = 'mobi'
  if (/epub/.test(contentType)) ext = 'epub'
  const clean = pub.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'book'
  const file = new File([blob], `${clean}.${ext}`, { type: contentType })
  if (!detectFormat(file.name)) throw new Error('下载的文件格式无法识别')
  const result = await importFile(file, sourceTitle, {
    title: pub.title,
    author: pub.author,
    description: pub.summary,
    kind,
  })
  if (!result.ok) throw new Error(result.error)
  return result
}

/**
 * 古登堡计划搜索适配 (供统一搜书):
 * 其 search.opds 根层返回的是导航 (分组 / 单本书节点), 而非直接的出版物 —
 * 逐层跟随: 根层出版物 → 书节点列表 → titles 分组, 并行拉取书节点详情。
 */
export async function searchGutenberg(query: string, limit = 20): Promise<OpdsPublication[]> {
  const searchUrl = `https://www.gutenberg.org/ebooks/search.opds/?query=${encodeURIComponent(query)}`
  const root = await loadOpdsPage(searchUrl)
  if (root.publications.length) return root.publications.slice(0, limit)

  const bookNode = (href: string) => /\/ebooks\/\d+\.opds/.test(href)
  let bookLinks = root.navigation.filter(n => bookNode(n.href))
  if (!bookLinks.length) {
    const titles = root.navigation.find(n => n.href.includes('/ebooks/titles/'))
    if (titles) {
      const next = await loadOpdsPage(titles.href)
      if (next.publications.length) return next.publications.slice(0, limit)
      bookLinks = next.navigation.filter(n => bookNode(n.href))
    }
  }
  const pubs: OpdsPublication[] = []
  await Promise.all(bookLinks.slice(0, limit).map(async n => {
    try {
      const detail = await loadOpdsPage(n.href)
      if (detail.publications[0]) pubs.push(detail.publications[0])
    } catch { /* 单本失败忽略 */ }
  }))
  return pubs
}
