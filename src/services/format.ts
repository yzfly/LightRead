import type { BookFormat } from '../storage/types'

const EXT_MAP: Record<string, BookFormat> = {
  epub: 'epub',
  mobi: 'mobi',
  azw3: 'azw3',
  azw: 'azw',
  fb2: 'fb2',
  fbz: 'fbz',
  cbz: 'cbz',
  cbr: 'cbr',
  djvu: 'djvu',
  djv: 'djvu',
  pdf: 'pdf',
  txt: 'txt',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  md: 'md',
  markdown: 'md',
}

export const SUPPORTED_EXTS = Object.keys(EXT_MAP)

export const ACCEPT = SUPPORTED_EXTS.map(e => '.' + e).join(',') + ',.fb2.zip'

export function detectFormat(fileName: string): BookFormat | null {
  const name = fileName.toLowerCase()
  if (name.endsWith('.fb2.zip')) return 'fbz'
  const ext = name.split('.').pop() ?? ''
  return EXT_MAP[ext] ?? null
}

/** foliate-view 直接支持的格式 (其余走转换或专用阅读器) */
export function isFoliateNative(format: BookFormat): boolean {
  return ['epub', 'mobi', 'azw3', 'azw', 'fb2', 'fbz', 'cbz'].includes(format)
}

/** 文本类格式: 导入时动态转换为 EPUB 后交给 foliate-view */
export function isTextLike(format: BookFormat): boolean {
  return ['txt', 'html', 'md'].includes(format)
}

export const FORMAT_LABELS: Record<BookFormat, string> = {
  epub: 'EPUB',
  mobi: 'MOBI',
  azw3: 'AZW3',
  azw: 'AZW',
  fb2: 'FB2',
  fbz: 'FB2',
  cbz: '漫画',
  cbr: '漫画',
  djvu: 'DjVu',
  pdf: 'PDF',
  txt: 'TXT',
  html: 'HTML',
  md: 'Markdown',
}
