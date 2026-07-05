/** Calibre 书库直读 (桌面版): Rust 侧只读访问 metadata.db 与书籍文件 */
import { isTauri } from '../storage/types'
import { detectFormat } from './format'
import { importFile, type ImportResult } from './importer'

export interface CalibreFormat {
  format: string
  file_name: string
}

export interface CalibreBook {
  id: number
  title: string
  authors: string
  path: string
  has_cover: boolean
  formats: CalibreFormat[]
}

export const calibreAvailable = () => isTauri()

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

/** 选择 Calibre 书库文件夹 */
export async function pickCalibreLibrary(): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const picked = await open({ directory: true, title: '选择 Calibre 书库文件夹' })
  return typeof picked === 'string' ? picked : null
}

export function listCalibreBooks(library: string): Promise<CalibreBook[]> {
  return invoke('calibre_list_books', { library })
}

export async function readCalibreFile(library: string, relative: string): Promise<Blob> {
  const bytes = await invoke<ArrayBuffer>('calibre_read_file', { library, relative })
  return new Blob([bytes])
}

export async function calibreCoverUrl(library: string, book: CalibreBook): Promise<string | undefined> {
  if (!book.has_cover) return undefined
  try {
    const blob = await readCalibreFile(library, `${book.path}/cover.jpg`)
    return URL.createObjectURL(new Blob([blob], { type: 'image/jpeg' }))
  } catch {
    return undefined
  }
}

/** 挑选最适合阅读的格式 (epub 优先) */
export function pickBestFormat(book: CalibreBook): CalibreFormat | undefined {
  const priority = ['epub', 'azw3', 'mobi', 'fb2', 'pdf', 'txt']
  const readable = book.formats.filter(f => detectFormat(`x.${f.format}`))
  readable.sort((a, b) => {
    const ai = priority.indexOf(a.format)
    const bi = priority.indexOf(b.format)
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi)
  })
  return readable[0]
}

/** 导入一本 Calibre 书到藏书库 */
export async function importCalibreBook(
  library: string,
  book: CalibreBook,
): Promise<ImportResult> {
  const fmt = pickBestFormat(book)
  if (!fmt) return { ok: false, fileName: book.title, error: '没有可读的格式' }
  const relative = `${book.path}/${fmt.file_name}.${fmt.format}`
  const blob = await readCalibreFile(library, relative)
  const file = new File([blob], `${fmt.file_name}.${fmt.format}`)
  return importFile(file, 'Calibre', { title: book.title, author: book.authors })
}
