/** Website sources use the system browser so sign-in stays on the provider's site. */
export interface WebBookSource {
  id: string
  title: string
  url: string
  searchUrl?: string
  descriptionKey: string
  /** 影子图书馆: App Store / TestFlight 审核会以版权为由拒绝, iOS 构建不提供 (2026-11-14 用户要求) */
  shadowLibrary?: boolean
}

export const ALL_WEB_BOOK_SOURCES: WebBookSource[] = [
  { id: 'standardebooks', title: 'Standard Ebooks', url: 'https://standardebooks.org/ebooks', searchUrl: 'https://standardebooks.org/ebooks?query={query}', descriptionKey: 'catalog.standardebooksHint' },
  { id: 'shuge', title: '书格 · Shuge', url: 'https://www.shuge.org/', searchUrl: 'https://www.shuge.org/?s={query}&post_type=portfolio', descriptionKey: 'catalog.shugeHint' },
  { id: 'globalgrey', title: 'Global Grey', url: 'https://www.globalgreyebooks.com/index.html', descriptionKey: 'catalog.globalgreyHint' },
  { id: 'fadedpage', title: 'Faded Page', url: 'https://www.fadedpage.com/csearch.php', descriptionKey: 'catalog.fadedpageHint' },
  { id: 'zlibrary', title: 'Z-Library', url: 'https://z-library.sk/', searchUrl: 'https://z-library.sk/s/{query}', descriptionKey: 'catalog.zlibraryHint', shadowLibrary: true },
  { id: 'annas', title: "Anna’s Archive", url: 'https://annas-archive.gl/', searchUrl: 'https://annas-archive.gl/search?q={query}', descriptionKey: 'catalog.annasHint', shadowLibrary: true },
]

/** 某个构建平台 (__APP_PLATFORM__) 提供的网站书源 */
export function webBookSourcesFor(platform: string): WebBookSource[] {
  return platform === 'ios' ? ALL_WEB_BOOK_SOURCES.filter(s => !s.shadowLibrary) : ALL_WEB_BOOK_SOURCES
}

export const WEB_BOOK_SOURCES: WebBookSource[] = webBookSourcesFor(
  typeof __APP_PLATFORM__ !== 'undefined' ? __APP_PLATFORM__ : 'web',
)

export function webBookSourceUrl(source: WebBookSource, query: string): string {
  const trimmed = query.trim()
  return trimmed && source.searchUrl
    ? source.searchUrl.replace('{query}', encodeURIComponent(trimmed))
    : source.url
}
