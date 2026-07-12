/**
 * GitHub 书库搜索: 拉取书库仓库的完整文件树 (Git Trees API, 无需登录),
 * 本地按关键词过滤书籍文件, 点选后经 raw 直链下载导入。
 * 未登录接口限流 60 次/小时/IP, 文件树按仓库缓存 24 小时。
 */
import { fetchRemote } from './net'
import { detectFormat } from './format'

export interface GithubBookHit {
  repo: string
  /** 仓库内完整路径 */
  path: string
  /** 文件名 */
  name: string
  /** 字节数 */
  size: number
  /** raw 下载直链 */
  url: string
}

interface TreeCacheEntry {
  at: number
  files: Array<{ path: string; size: number }>
  truncated: boolean
}

const CACHE_PREFIX = 'lightread-ghtree-'
const CACHE_TTL = 24 * 60 * 60 * 1000

/** owner/repo 合法性 */
export function isValidRepo(repo: string): boolean {
  return /^[\w.-]+\/[\w.-]+$/.test(repo.trim())
}

async function fetchRepoTree(repo: string): Promise<TreeCacheEntry> {
  const key = CACHE_PREFIX + repo
  try {
    const cached: TreeCacheEntry = JSON.parse(localStorage.getItem(key) ?? '')
    if (cached.at > Date.now() - CACHE_TTL && cached.files) return cached
  } catch { /* 无缓存 */ }

  const res = await fetchRemote(
    `https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`,
    undefined,
    { headers: { accept: 'application/vnd.github+json' } },
  )
  const data = await res.json()
  const files = (data.tree ?? [])
    .filter((n: any) => n.type === 'blob' && detectFormat(String(n.path)))
    .map((n: any) => ({ path: String(n.path), size: Number(n.size ?? 0) }))
  const entry: TreeCacheEntry = { at: Date.now(), files, truncated: !!data.truncated }
  try {
    localStorage.setItem(key, JSON.stringify(entry))
  } catch { /* 缓存写满则放弃, 不影响功能 */ }
  return entry
}

/** 路径分段编码, 保留斜杠 */
function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

export interface GithubSearchResult {
  hits: GithubBookHit[]
  /** 拉取失败的仓库及原因 */
  errors: Array<{ repo: string; message: string }>
  /** 超大仓库文件树被 GitHub 截断 */
  truncated: boolean
}

/** 多仓库并行搜索; 关键词空格分隔, 路径需同时包含全部词 (不区分大小写) */
export async function searchGithubBooks(repos: string[], keyword: string): Promise<GithubSearchResult> {
  const terms = keyword.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const result: GithubSearchResult = { hits: [], errors: [], truncated: false }
  await Promise.all(repos.map(async repo => {
    try {
      const tree = await fetchRepoTree(repo)
      if (tree.truncated) result.truncated = true
      for (const file of tree.files) {
        const lower = file.path.toLowerCase()
        if (terms.length && !terms.every(term => lower.includes(term))) continue
        result.hits.push({
          repo,
          path: file.path,
          name: file.path.split('/').pop() ?? file.path,
          size: file.size,
          url: `https://raw.githubusercontent.com/${repo}/HEAD/${encodePath(file.path)}`,
        })
      }
    } catch (e: any) {
      result.errors.push({ repo, message: e?.message ?? String(e) })
    }
  }))
  result.hits.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  return result
}

export const fmtBytes = (n: number) =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(0)} KB` : `${n} B`
