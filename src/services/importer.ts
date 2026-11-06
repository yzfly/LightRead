import { getStorage, type BookMeta, type LocalFileRef, type NewBookMeta } from '../storage'
import { t } from '../i18n'
import { detectFormat, isFoliateNative, isTextLike } from './format'
import { detectReadableFormat, looksLikeText } from './plainText'
import { convertToEpub } from './textToEpub'
import { makeFoliateBook } from './foliateBook'
import { isTauri } from '../storage/types'

const isMobileUa = () => typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)

/** foliate 的 metadata 字段可能是字符串 / 对象 / 数组, 统一压平为字符串 (原生 epub_meta.rs 按同一规则对齐) */
export function flattenMeta(value: any): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(flattenMeta).filter(Boolean).join(', ')
  if (typeof value === 'object') {
    if (typeof value.name === 'string') return value.name
    if (typeof value.value === 'string') return value.value
    const first = Object.values(value).find(v => typeof v === 'string')
    if (typeof first === 'string') return first
  }
  return ''
}

async function extractFoliateMeta(file: File) {
  const book = await makeFoliateBook(file)
  const meta = book.metadata ?? {}
  let cover: Blob | undefined
  try {
    cover = (await book.getCover?.()) ?? undefined
  } catch { /* 无封面不影响导入 */ }
  const result = {
    title: flattenMeta(meta.title),
    author: flattenMeta(meta.author),
    description: flattenMeta(meta.description),
    language: flattenMeta(meta.language),
    cover,
  }
  book.destroy?.()
  return result
}

/** PDF 元数据与封面: PDFium (与阅读器同引擎) */
async function extractPdfMeta(file: File) {
  try {
    return await readPdfMeta(file)
  } catch (e) {
    // 解析失败: 文件名兜底, 无封面。留一条日志, 否则崩溃会被这里吞掉
    console.warn('PDF metadata failed', e)
  }
  return { title: '', author: '', cover: undefined }
}

/** 解析失败时抛出, 由调用方决定兜底 */
async function readPdfMeta(file: File) {
  const { PdfiumDoc } = await import('./pdfium')
  const doc = await PdfiumDoc.open(await file.arrayBuffer())
  try {
    const title = doc.meta('Title')
    const author = doc.meta('Author')
    let cover: Blob | undefined
    if (doc.pages[0]) {
      const img = doc.render(0, 0.6)
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      canvas.getContext('2d')!.putImageData(img, 0, 0)
      cover = await new Promise<Blob | undefined>(resolve =>
        canvas.toBlob(b => resolve(b?.size ? b : undefined), 'image/jpeg', 0.8))
    }
    return { title, author, cover }
  } finally {
    doc.close()
  }
}

/**
 * 从已入库的书籍文件重新取封面 (修复损坏封面用, 见 services/coverRepair.ts), 取法与导入时相同.
 * 书里没有封面返回 undefined; 读文件 / 解析出错时抛出, 以免把暂时的失败当成「没有封面」.
 */
export async function regenerateCover(book: BookMeta): Promise<Blob | undefined> {
  const storage = await getStorage()
  if (book.format === 'epub' && storage.getEpubMeta && isTauri() && !isMobileUa()) {
    const m = await storage.getEpubMeta(book.id)
    if (m) return m.cover
  }
  if (book.format === 'cbr') {
    const cbz = (await storage.getComicCbz?.(book.id))
      ?? await (await import('./comic')).cbrToCbz(new File([await storage.getBookFile(book.id)], book.fileName))
    return (await extractFoliateMeta(new File([cbz], 'cover.cbz'))).cover
  }
  if (book.format !== 'pdf' && book.format !== 'djvu' && !isFoliateNative(book.format)) return undefined
  const file = new File([await storage.getBookFile(book.id)], book.fileName)
  if (book.format === 'pdf') return (await readPdfMeta(file)).cover
  if (book.format === 'djvu') return (await import('./djvu')).djvuCover(file)
  return (await extractFoliateMeta(file)).cover
}

export interface ImportResult {
  ok: boolean
  fileName: string
  bookId?: string
  error?: string
}

export interface MetaOverrides {
  title?: string
  author?: string
  description?: string
  /** 归属: 论文入「论文」页 */
  kind?: 'book' | 'paper'
}

/** 导入单个文件到藏书库; overrides 来自书源目录的元数据, 优先于文件内嵌信息 */
export async function importFile(
  file: File,
  source = '本地导入',
  overrides?: MetaOverrides,
  staged?: LocalFileRef,
): Promise<ImportResult> {
  let format = detectReadableFormat(file.name)
  // 书籍格式以外的文本 (含认不出扩展名的): 看内容确实是文本才按 txt 收, 二进制照旧拒绝
  if (!detectFormat(file.name)) {
    const textual = looksLikeText(new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer()))
    format = textual ? 'txt' : null
  }
  if (!format) return { ok: false, fileName: file.name, error: t('library.importUnsupported') }

  const baseName = file.name.replace(/\.[^.]+$/, '')
  const meta: NewBookMeta = {
    title: baseName,
    author: '',
    format,
    fileName: file.name,
    tags: [],
    addedAt: Date.now(),
    source,
  }
  let cover: Blob | undefined
  const storage = await getStorage()
  // 桌面 CBR: 先入库, 再由原生层解包成 CBZ 缓存 (顺带预热首次打开) 并从缓存取封面; 不行再退回 unrar wasm
  const nativeCbr = format === 'cbr' && !!storage.getComicCbz && !!storage.setCover && isTauri() && !isMobileUa()
  // 桌面 EPUB: 先入库, 再由原生层从书库文件读元数据与封面 (src-tauri/src/epub_meta.rs), 不必整本交给 foliate
  const nativeEpub = format === 'epub' && !!storage.getEpubMeta && !!storage.setCover && isTauri() && !isMobileUa()

  try {
    if (isFoliateNative(format) && !nativeEpub) {
      const m = await extractFoliateMeta(file)
      if (m.title) meta.title = m.title
      meta.author = m.author
      meta.description = m.description || undefined
      meta.language = m.language || undefined
      cover = m.cover
    } else if (format === 'pdf') {
      const m = await extractPdfMeta(file)
      if (m.title) meta.title = m.title
      meta.author = m.author
      cover = m.cover
    } else if (format === 'cbr' && !nativeCbr) {
      // 转成 CBZ 后走 foliate 漫画解析取封面
      const { cbrToCbz } = await import('./comic')
      const cbz = await cbrToCbz(file)
      const m = await extractFoliateMeta(new File([cbz], baseName + '.cbz'))
      if (m.title) meta.title = m.title
      cover = m.cover
    } else if (format === 'djvu') {
      const { djvuCover } = await import('./djvu')
      cover = await djvuCover(file)
    } else if (isTextLike(format)) {
      // 仅取标题, 阅读时再实时转换
      const { title } = await convertToEpub(file, file.name, format as 'txt' | 'md' | 'html')
      meta.title = title
    }
  } catch (e: any) {
    // 底层报错 (如 Cannot read properties of null) 对读者没用, 原文留在控制台
    console.warn('[import]', file.name, e)
    return { ok: false, fileName: file.name, error: t('library.importParseFailed') }
  }

  if (overrides?.title) meta.title = overrides.title
  if (overrides?.author) meta.author = overrides.author
  if (overrides?.description) meta.description = overrides.description
  meta.kind = overrides?.kind ?? 'book'

  const bookId = staged && storage.addBookFromStaged
    ? await storage.addBookFromStaged(meta, staged, cover)
    : await storage.addBook(meta, file, cover)
  if (nativeEpub) {
    try {
      const m = (await storage.getEpubMeta!(bookId)) ?? await extractFoliateMeta(file)
      await storage.updateBook(bookId, {
        title: overrides?.title || m.title || meta.title,
        author: overrides?.author || m.author,
        description: overrides?.description || m.description || undefined,
        language: m.language || undefined,
      })
      if (m.cover) await storage.setCover!(bookId, m.cover)
    } catch (e) {
      console.warn('[import]', file.name, e)
      await storage.deleteBook(bookId).catch(() => { /* 尽力撤回 */ })
      return { ok: false, fileName: file.name, error: t('library.importParseFailed') }
    }
  }
  if (nativeCbr) {
    try {
      const cbz = (await storage.getComicCbz!(bookId))
        ?? await (await import('./comic')).cbrToCbz(file)
      const m = await extractFoliateMeta(new File([cbz], baseName + '.cbz'))
      if (m.title && !overrides?.title) await storage.updateBook(bookId, { title: m.title })
      if (m.cover) await storage.setCover!(bookId, m.cover)
    } catch (e) {
      // 原生与 wasm 都打不开 (加密 / 无图片): 撤回入库, 与原来一样报解析失败
      console.warn('[import]', file.name, e)
      await storage.deleteBook(bookId).catch(() => { /* 尽力撤回 */ })
      return { ok: false, fileName: file.name, error: t('library.importParseFailed') }
    }
  }
  return { ok: true, fileName: file.name, bookId }
}

/** 本地路径由 Rust 复制到书库; 解析读取暂存快照, 不再把整本书从 JS 写回磁盘。 */
export interface NativeImportFile { name: string; absPath: string }
export async function importNativeFile(item: NativeImportFile, source = '本地导入', overrides?: MetaOverrides): Promise<ImportResult> {
  const storage = await getStorage()
  if (!storage.stageBookFromPath || !storage.addBookFromStaged || !storage.discardStaged) {
    throw new Error('Native import storage unavailable')
  }
  const staged = await storage.stageBookFromPath(item.absPath)
  try {
    const file = new File([await staged.blob()], item.name)
    return await importFile(file, source, overrides, staged)
  } finally {
    await storage.discardStaged(staged).catch(error => console.warn('[import cleanup]', error))
  }
}

/** 延迟读取的文件 (桌面端选文件夹导入: 导到这一本时才从磁盘读出) */
export interface LazyImportFile {
  name: string
  load(): Promise<File>
}

/** 批量导入 */
export async function importFiles(
  files: Iterable<File | LazyImportFile | NativeImportFile>,
  source = '本地导入',
  onProgress?: (done: number, total: number, current: string) => void,
  overrides?: MetaOverrides,
): Promise<ImportResult[]> {
  const list = Array.from(files)
  const results: ImportResult[] = []
  let done = 0
  for (const item of list) {
    onProgress?.(done, list.length, item.name)
    try {
      results.push('absPath' in item
        ? await importNativeFile(item, source, overrides)
        : await importFile('load' in item ? await item.load() : item, source, overrides))
    } catch (error: any) {
      // 单本存储失败也要继续其余文件，并让界面能正常退出进度状态。
      results.push({ ok: false, fileName: item.name, error: error?.message ?? t('library.saveFileFailed') })
    }
    done++
  }
  onProgress?.(done, list.length, '')
  return results
}
