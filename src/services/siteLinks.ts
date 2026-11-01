/**
 * 轻阅官网 (https://code.jiangshu.ai/LightRead/, 源码 site/ + scripts/build-site.mjs) 上的固定地址。
 * 应用里面向用户的说明、手册、下载入口一律跳官网; 站点路径改动时同时改这里和 build-site.mjs 的 PAGES。
 * 应用内《使用手册》仍打包离线可看, 这里只决定「去网页看」时打开哪一页。
 */
export const SITE_URL = 'https://code.jiangshu.ai/LightRead/'
export const SITE_MANUAL_URL = `${SITE_URL}manual/`
export const SITE_DOWNLOAD_SECTION = `${SITE_URL}#download`

/** 仓库文档 → 官网页面 (与 scripts/build-site.mjs 的 PAGES 一致) */
const SITE_PAGES: Record<string, string> = {
  'docs/manual/README.md': 'manual/',
  'docs/manual/04-使用说明.md': 'manual/guide.html',
  'docs/manual/02-阅读模式.md': 'manual/reading-modes.html',
  'docs/manual/05-点睛阅读.md': 'manual/dianjing.html',
  'docs/manual/03-声音.md': 'manual/sound.html',
  'docs/manual/01-读书方法.md': 'manual/reading-methods.html',
  'docs/installation.md': 'docs/installation.html',
  'docs/paper-reading.md': 'docs/paper-reading.html',
  'docs/ambient-sources.md': 'docs/ambient-sources.html',
  'docs/library-okf-profile.md': 'docs/library-okf-profile.html',
}
const REPO_BLOB = 'https://github.com/yzfly/LightRead/blob/main/'

/**
 * 仓库内路径 (可带 #锚点) 对应的网页地址: 官网有的页面去官网, 项目 README 去官网首页
 * (下载 / 安装类锚点落到下载区), 其余仍去 GitHub。
 */
export function siteUrlForRepoPath(repoPath: string): string {
  const [path, hash] = repoPath.replace(/^\/+/, '').split('#')
  const page = SITE_PAGES[path]
  if (page !== undefined) return SITE_URL + page + (hash ? `#${hash}` : '')
  if (path === 'README.md' || path === 'README.en.md') {
    let anchor = hash ?? ''
    try { anchor = decodeURIComponent(anchor) } catch { /* 保持原样 */ }
    return /下载|安装|android|download|install/i.test(anchor) ? SITE_DOWNLOAD_SECTION : SITE_URL
  }
  return REPO_BLOB + path + (hash ? `#${hash}` : '')
}
