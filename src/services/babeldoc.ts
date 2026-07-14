/**
 * BabelDOC 引擎桥: 检测本机 CLI / 启动整本重排版翻译 / 进度事件。
 * 引擎是可选外部程序 (uv tool install babeldoc), 仅桌面端可用。
 */
import { isTauri, getLibraryRoot } from '../storage/types'
import { useSettings } from '../stores/settings'
import { TRIAL_BASE_URL } from './ai'

export interface BabeldocStatus {
  found: boolean
  path: string
  version: string
}
export interface BabeldocProgress {
  line: string
  percent: number | null
  stage?: string | null
  current?: number | null
  total?: number | null
}

/** 引擎阶段名 → 中文 (模糊匹配, 未识别的显示原文) */
export function stageLabel(stage: string): string {
  const s = stage.toLowerCase()
  if (s === 'init') return '初始化引擎'
  if (s.includes('scan')) return '检测扫描件'
  if (s.includes('layout')) return '版面分析'
  if (s.includes('paragraph') && s.includes('translate')) return '翻译段落'
  if (s.includes('translate')) return '翻译段落'
  if (s.includes('formula') || s.includes('style')) return '识别公式与样式'
  if (s.includes('parse')) return '解析文档'
  if (s.includes('typeset')) return '排版'
  if (s.includes('font')) return '字体处理'
  if (s.includes('save') || s.includes('render')) return '生成 PDF'
  if (s.includes('glossary') || s.includes('term')) return '提取术语'
  return stage
}

export const INSTALL_CMD = 'uv tool install babeldoc'

export const babeldocSupported = () => isTauri()

/** 试用通道走中转鉴权头, CLI 无法携带 — 需要用户自己的模型服务 */
export function babeldocUsableProvider(): boolean {
  const s = useSettings()
  return !s.aiBaseUrl.startsWith(TRIAL_BASE_URL)
}

export async function babeldocStatus(): Promise<BabeldocStatus> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<BabeldocStatus>('babeldoc_status')
}

/** 论文文件的磁盘绝对路径 (books/<id>.<ext>) */
export async function bookFilePath(bookId: string, fileName: string): Promise<string> {
  const lower = fileName.toLowerCase()
  const ext = lower.endsWith('.fb2.zip') ? 'fb2.zip' : fileName.split('.').pop() || 'bin'
  let root = getLibraryRoot().replace(/\/+$/, '')
  if (!root) {
    const { appDataDir } = await import('@tauri-apps/api/path')
    root = (await appDataDir()).replace(/[\\/]+$/, '')
  }
  return `${root}/books/${bookId}.${ext}`
}

/** 启动翻译 (长任务), 返回产出 PDF 的绝对路径列表 (mono/dual) */
export async function babeldocTranslate(filePath: string, pages?: string): Promise<string[]> {
  const s = useSettings()
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<string[]>('babeldoc_translate', {
    filePath,
    baseUrl: s.aiBaseUrl.trim().replace(/\/+$/, ''),
    apiKey: s.aiApiKey.trim(),
    model: s.aiModel.trim(),
    pages: pages?.trim() || null,
  })
}

export async function babeldocCancel(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('babeldoc_cancel')
}

export async function babeldocReadOutput(path: string): Promise<Blob> {
  const { invoke } = await import('@tauri-apps/api/core')
  const bytes = await invoke<ArrayBuffer>('babeldoc_read_output', { path })
  return new Blob([bytes], { type: 'application/pdf' })
}

export async function onBabeldocProgress(cb: (p: BabeldocProgress) => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event')
  return listen<BabeldocProgress>('babeldoc:progress', e => cb(e.payload))
}
