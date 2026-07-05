/**
 * arXiv 适配器: 官方 API 本身就是 Atom 格式, 解析为与 OPDS 页面同构的数据,
 * 目录界面直接复用. API 文档: https://info.arxiv.org/help/api/
 */
import { fetchXml, type RequestAuth } from './net'
import type { OpdsPage, OpdsPublication } from './opds'

export const ARXIV_API = 'https://export.arxiv.org/api/query'
const PAGE_SIZE = 20

export const isArxivUrl = (url: string) => url.includes('export.arxiv.org')

/** 常用分类导航 (根页面) */
const CATEGORIES: Array<{ title: string; query: string; summary: string }> = [
  { title: '人工智能 cs.AI', query: 'cat:cs.AI', summary: 'Artificial Intelligence' },
  { title: '计算与语言 cs.CL', query: 'cat:cs.CL', summary: 'Computation and Language (NLP)' },
  { title: '机器学习 cs.LG', query: 'cat:cs.LG', summary: 'Machine Learning' },
  { title: '计算机视觉 cs.CV', query: 'cat:cs.CV', summary: 'Computer Vision and Pattern Recognition' },
  { title: '统计机器学习 stat.ML', query: 'cat:stat.ML', summary: 'Machine Learning (Statistics)' },
  { title: '软件工程 cs.SE', query: 'cat:cs.SE', summary: 'Software Engineering' },
  { title: '分布式计算 cs.DC', query: 'cat:cs.DC', summary: 'Distributed, Parallel, and Cluster Computing' },
  { title: '密码与安全 cs.CR', query: 'cat:cs.CR', summary: 'Cryptography and Security' },
  { title: '信息检索 cs.IR', query: 'cat:cs.IR', summary: 'Information Retrieval' },
  { title: '量化金融 q-fin', query: 'cat:q-fin.*', summary: 'Quantitative Finance' },
  { title: '数学 math', query: 'cat:math.*', summary: 'Mathematics' },
  { title: '物理 physics', query: 'cat:physics.*', summary: 'Physics' },
]

export function arxivListUrl(query: string, start = 0): string {
  const params = new URLSearchParams({
    search_query: query,
    start: String(start),
    max_results: String(PAGE_SIZE),
    sortBy: 'submittedDate',
    sortOrder: 'descending',
  })
  return `${ARXIV_API}?${params}`
}

export function arxivSearchUrl(keyword: string, start = 0): string {
  // all: 全字段检索; 引号包裹短语
  const q = /\s/.test(keyword) ? `all:"${keyword}"` : `all:${keyword}`
  const params = new URLSearchParams({
    search_query: q,
    start: String(start),
    max_results: String(PAGE_SIZE),
    sortBy: 'relevance',
  })
  return `${ARXIV_API}?${params}`
}

/** 根页面: 分类导航, 不发请求 */
export function arxivRootPage(): OpdsPage {
  return {
    title: 'arXiv 论文',
    navigation: CATEGORIES.map(c => ({
      title: c.title,
      href: arxivListUrl(c.query),
      summary: c.summary,
    })),
    publications: [],
    searchUrl: 'arxiv-search',
  }
}

const text = (el: Element | null | undefined) => el?.textContent?.trim() ?? ''

export async function loadArxivPage(url: string, auth?: RequestAuth): Promise<OpdsPage> {
  const doc = await fetchXml(url, auth)
  const ATOM = 'http://www.w3.org/2005/Atom'
  const OS = 'http://a9.com/-/spec/opensearch/1.1/'

  const publications: OpdsPublication[] = []
  for (const entry of Array.from(doc.getElementsByTagNameNS(ATOM, 'entry'))) {
    const title = text(entry.getElementsByTagNameNS(ATOM, 'title')[0]).replace(/\s+/g, ' ')
    const authors = Array.from(entry.getElementsByTagNameNS(ATOM, 'author'))
      .map(a => text(a.getElementsByTagNameNS(ATOM, 'name')[0]))
      .filter(Boolean)
    const summary = text(entry.getElementsByTagNameNS(ATOM, 'summary')[0]).replace(/\s+/g, ' ')
    const published = text(entry.getElementsByTagNameNS(ATOM, 'published')[0]).slice(0, 10)
    const links = Array.from(entry.getElementsByTagNameNS(ATOM, 'link'))
    const pdfHref = links.find(l => l.getAttribute('title') === 'pdf'
      || l.getAttribute('type') === 'application/pdf')?.getAttribute('href')
    // arXiv id 如 http://arxiv.org/abs/2501.01234v1
    const idUrl = text(entry.getElementsByTagNameNS(ATOM, 'id')[0])
    const arxivId = idUrl.split('/abs/')[1] ?? ''

    publications.push({
      title,
      author: authors.slice(0, 6).join(', ') + (authors.length > 6 ? ' 等' : ''),
      summary: `[${arxivId}${published ? ' · ' + published : ''}] ${summary}`.slice(0, 400),
      acquisitions: pdfHref
        ? [{ href: pdfHref.replace(/^http:/, 'https:'), type: 'application/pdf', label: 'PDF' }]
        : [],
    })
  }

  // 分页
  const total = parseInt(text(doc.getElementsByTagNameNS(OS, 'totalResults')[0]), 10) || 0
  const startIndex = parseInt(text(doc.getElementsByTagNameNS(OS, 'startIndex')[0]), 10) || 0
  let next: string | undefined
  if (startIndex + PAGE_SIZE < total) {
    const u = new URL(url)
    u.searchParams.set('start', String(startIndex + PAGE_SIZE))
    next = u.href
  }

  return {
    title: 'arXiv',
    navigation: [],
    publications,
    next,
    searchUrl: 'arxiv-search',
  }
}
