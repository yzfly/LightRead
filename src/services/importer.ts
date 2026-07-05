import { getStorage, type NewBookMeta } from '../storage'
import { detectFormat, isFoliateNative, isTextLike } from './format'
import { convertToEpub } from './textToEpub'

/** foliate 的 metadata 字段可能是字符串 / 对象 / 数组, 统一压平为字符串 */
function flattenMeta(value: any): string {
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
  const { makeBook } = await import('foliate-js/view.js')
  const book = await makeBook(file)
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

export async function initPdfjs() {
  const pdfjs = await import('pdfjs-dist')
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
  }
  return pdfjs
}

async function extractPdfMeta(file: File) {
  const pdfjs = await initPdfjs()
  const loadingTask = pdfjs.getDocument({ data: await file.arrayBuffer() })
  const pdf = await loadingTask.promise
  let title = ''
  let author = ''
  try {
    const { info } = (await pdf.getMetadata()) as any
    title = info?.Title ?? ''
    author = info?.Author ?? ''
  } catch { /* 元数据缺失时用文件名兜底 */ }
  // 首页渲染为封面
  let cover: Blob | undefined
  try {
    const page = await pdf.getPage(1)
    const viewport = page.getViewport({ scale: 0.6 })
    const canvas = document.createElement('canvas')
    canvas.width = viewport.width
    canvas.height = viewport.height
    await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport } as any).promise
    cover = await new Promise<Blob | undefined>(resolve =>
      canvas.toBlob(b => resolve(b ?? undefined), 'image/jpeg', 0.8))
  } catch { /* 封面渲染失败可忽略 */ }
  await loadingTask.destroy()
  return { title, author, cover }
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
}

/** 导入单个文件到藏书库; overrides 来自书源目录的元数据, 优先于文件内嵌信息 */
export async function importFile(
  file: File,
  source = '本地导入',
  overrides?: MetaOverrides,
): Promise<ImportResult> {
  const format = detectFormat(file.name)
  if (!format) return { ok: false, fileName: file.name, error: '不支持的格式' }

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

  try {
    if (isFoliateNative(format)) {
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
    } else if (isTextLike(format)) {
      // 仅取标题, 阅读时再实时转换
      const { title } = await convertToEpub(file, file.name, format as 'txt' | 'md' | 'html')
      meta.title = title
    }
  } catch (e: any) {
    return { ok: false, fileName: file.name, error: e?.message ?? '文件解析失败' }
  }

  if (overrides?.title) meta.title = overrides.title
  if (overrides?.author) meta.author = overrides.author
  if (overrides?.description) meta.description = overrides.description

  const storage = await getStorage()
  const bookId = await storage.addBook(meta, file, cover)
  return { ok: true, fileName: file.name, bookId }
}

/** 批量导入 */
export async function importFiles(
  files: Iterable<File>,
  source = '本地导入',
  onProgress?: (done: number, total: number, current: string) => void,
): Promise<ImportResult[]> {
  const list = Array.from(files)
  const results: ImportResult[] = []
  let done = 0
  for (const file of list) {
    onProgress?.(done, list.length, file.name)
    results.push(await importFile(file, source))
    done++
  }
  onProgress?.(done, list.length, '')
  return results
}
