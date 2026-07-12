/**
 * 字体管理:
 *  - 桌面端枚举系统已安装字体 (Rust fontdb)
 *  - 自定义字体文件: 复制到应用数据目录, 阅读时以 FontFace 注入各章节文档
 */
import { isTauri } from '../storage/types'

export interface CustomFont {
  /** 展示名与 CSS font-family 名 (取自文件名) */
  name: string
  /** 应用数据目录内的字体文件路径 */
  file: string
}

let systemFontsCache: string[] | null = null

export async function listSystemFonts(): Promise<string[]> {
  if (!isTauri()) return []
  if (!systemFontsCache) {
    const { invoke } = await import('@tauri-apps/api/core')
    systemFontsCache = await invoke<string[]>('list_system_fonts')
  }
  return systemFontsCache
}

/** 弹文件选择框导入字体, 复制到 $APPDATA/fonts/; 取消返回 null */
export async function importFontFile(): Promise<CustomFont | null> {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const picked = await open({
    title: '选择字体文件',
    filters: [{ name: 'Fonts', extensions: ['ttf', 'otf', 'woff', 'woff2', 'ttc'] }],
  })
  if (typeof picked !== 'string') return null
  const { readFile, writeFile, mkdir, exists } = await import('@tauri-apps/plugin-fs')
  const { appDataDir, join, basename } = await import('@tauri-apps/api/path')
  const data = await readFile(picked)
  const dir = await join(await appDataDir(), 'fonts')
  if (!(await exists(dir))) await mkdir(dir, { recursive: true })
  const base = await basename(picked)
  const dest = await join(dir, base)
  await writeFile(dest, data)
  return { name: base.replace(/\.(ttf|otf|woff2?|ttc)$/i, ''), file: dest }
}

const bytesCache = new Map<string, Promise<ArrayBuffer>>()

function loadFontBytes(file: string): Promise<ArrayBuffer> {
  if (!bytesCache.has(file)) {
    bytesCache.set(file, (async () => {
      const { readFile } = await import('@tauri-apps/plugin-fs')
      const data = await readFile(file)
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    })())
  }
  return bytesCache.get(file)!
}

/** 把自定义字体注入章节 iframe 文档; FontFace 需在目标 realm 构造 */
export async function injectFontIntoDoc(doc: Document, font: CustomFont) {
  try {
    const win = doc.defaultView as any
    if (!win?.FontFace || (doc as any).__lrFonts?.has(font.file)) return
    const face = new win.FontFace(font.name, await loadFontBytes(font.file))
    await face.load()
    ;(doc.fonts as any).add(face)
    ;((doc as any).__lrFonts ??= new Set()).add(font.file)
  } catch (e) {
    console.warn('自定义字体加载失败:', font.name, e)
  }
}

/** 阅读设置里存的字体值 → 实际 CSS font-family (custom:Name → "Name") */
export function resolveFontFamily(value: string): string {
  const m = value.match(/^custom:(.+)$/)
  return m ? `"${m[1]}"` : value
}
