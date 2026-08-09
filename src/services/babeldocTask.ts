import { reactive } from 'vue'
import { t } from '../i18n'
import { router } from '../router'
import { useLibrary } from '../stores/library'
import {
  BABELDOC_STARTING_LINE,
  babeldocCancel,
  babeldocReadOutput,
  babeldocTranslate,
  bookFilePath,
  onBabeldocProgress,
} from './babeldoc'
import { importFile } from './importer'
import { toast } from './toast'
import {
  resolveBabeldocTargetLanguage,
  type BabeldocTargetLanguageCode,
} from './babeldocLanguages'

export type BabeldocTaskPhase = 'idle' | 'running' | 'cancelling' | 'importing' | 'error'

export interface BabeldocTaskRequest {
  bookId: string
  fileName: string
  title: string
  kind: 'book' | 'paper'
  targetLanguage: BabeldocTargetLanguageCode
  pages?: string
  backgroundPrompt?: string
}

export interface BabeldocTaskState {
  phase: BabeldocTaskPhase
  sourceTitle: string
  percent: number | null
  line: string
  stage?: string
  current?: number
  total?: number
  startedAt: number
  error: string
}

export const babeldocTask = reactive<BabeldocTaskState>({
  phase: 'idle',
  sourceTitle: '',
  percent: null,
  line: '',
  startedAt: 0,
  error: '',
})

export function babeldocTaskActive(): boolean {
  return babeldocTask.phase === 'running'
    || babeldocTask.phase === 'cancelling'
    || babeldocTask.phase === 'importing'
}

function resetProgress(request: BabeldocTaskRequest) {
  Object.assign(babeldocTask, {
    phase: 'running' as const,
    sourceTitle: request.title,
    percent: null,
    line: BABELDOC_STARTING_LINE,
    stage: undefined,
    current: undefined,
    total: undefined,
    startedAt: Date.now(),
    error: '',
  })
}

function openImportedPdf(id: string) {
  void router.push(`/read-paper/${id}`).catch(error => {
    toast(t('paper.bdOpenFailed', { msg: String(error) }), 'error', 6000)
  })
}

function cancellationRequested(): boolean {
  return babeldocTask.phase === 'cancelling'
}

/**
 * 将重排版翻译交给应用级任务运行。调用会立即返回；页面切换不会终止任务。
 */
export function startBabeldocTask(request: BabeldocTaskRequest): boolean {
  if (babeldocTaskActive()) {
    toast(t('paper.bdAlreadyRunning'), 'info')
    return false
  }

  resetProgress(request)
  toast(t('paper.bdBackgroundStarted'), 'success', 4200)
  void executeBabeldocTask(request)
  return true
}

async function executeBabeldocTask(request: BabeldocTaskRequest) {
  let unlisten: (() => void) | undefined
  try {
    unlisten = await onBabeldocProgress(progress => {
      if (!babeldocTaskActive()) return
      if (progress.percent != null) babeldocTask.percent = progress.percent
      babeldocTask.line = progress.line
      babeldocTask.stage = progress.stage ?? undefined
      babeldocTask.current = progress.current ?? undefined
      babeldocTask.total = progress.total ?? undefined
    })

    if (cancellationRequested()) throw new Error('已取消')
    const path = await bookFilePath(request.bookId, request.fileName)
    if (cancellationRequested()) throw new Error('已取消')
    const outputs = await babeldocTranslate({
      filePath: path,
      targetLanguage: request.targetLanguage,
      pages: request.pages,
      backgroundPrompt: request.backgroundPrompt,
    })
    if (cancellationRequested()) throw new Error('已取消')
    babeldocTask.phase = 'importing'
    const imported: Array<{ id: string; variant: 'mono' | 'dual' }> = []
    const importErrors: string[] = []

    for (const output of outputs) {
      const variant = output.includes('.dual.') ? 'dual' : 'mono'
      const languageLabel = t(resolveBabeldocTargetLanguage(request.targetLanguage).labelKey)
      const label = variant === 'dual'
        ? `${languageLabel} · ${t('paper.bdDual')}`
        : languageLabel
      try {
        const blob = await babeldocReadOutput(output)
        const title = `${request.title} · ${label}`
        const file = new File([blob], `${title}.pdf`, { type: 'application/pdf' })
        const result = await importFile(file, 'BabelDOC', { kind: request.kind, title })
        if (!result.ok || !result.bookId) {
          throw new Error(result.error || t('paper.bdImportFailed'))
        }
        imported.push({ id: result.bookId, variant })
      } catch (error: any) {
        importErrors.push(String(error?.message ?? error))
      }
    }

    if (!imported.length) {
      throw new Error(importErrors[0] || t('paper.bdImportFailed'))
    }
    await useLibrary().refresh().catch(() => {})
    const preferred = imported.find(item => item.variant === 'mono') ?? imported[0]
    babeldocTask.phase = 'idle'
    if (importErrors.length) {
      toast(t('paper.bdPartialSuccess', { count: importErrors.length }), 'info', 6000)
    }
    toast(t('paper.bdCompletedOpening'), 'success', 4200)
    openImportedPdf(preferred.id)
  } catch (error: any) {
    const message = String(error?.message ?? error).slice(0, 300)
    if (babeldocTask.phase === 'cancelling' || message === '已取消') {
      babeldocTask.phase = 'idle'
      toast(t('paper.bdCancelled'), 'info')
    } else {
      babeldocTask.error = message
      babeldocTask.phase = 'error'
      toast(t('paper.bdBackgroundFailed', { msg: message }), 'error', 7000)
    }
  } finally {
    unlisten?.()
  }
}

export async function cancelBabeldocTask() {
  if (babeldocTask.phase !== 'running') return
  babeldocTask.phase = 'cancelling'
  await babeldocCancel().catch(() => {
    babeldocTask.phase = 'running'
  })
}

export function dismissBabeldocTaskError() {
  if (babeldocTask.phase === 'error') babeldocTask.phase = 'idle'
}
