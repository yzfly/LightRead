/**
 * 有打开密码的 PDF: 先试这台设备记住的密码, 不行就让阅读页显示输入框, 等读者输入后再打开。
 * 密码只存在本机 localStorage (按书), 不进书库元数据, 也不参与同步。
 */
import { ref } from 'vue'
import { PdfiumDoc, PdfPasswordError } from '../services/pdfium'
import { getStorage } from '../storage'
import { pdfCoverBlob } from '../services/importer'
import { useLibrary } from '../stores/library'

const storageKey = (bookId: string) => `lightread.pdfPassword.${bookId}`

function savedPassword(bookId: string): string {
  try {
    return localStorage.getItem(storageKey(bookId)) ?? ''
  } catch {
    return ''
  }
}

function savePassword(bookId: string, password: string | null) {
  try {
    if (password) localStorage.setItem(storageKey(bookId), password)
    else localStorage.removeItem(storageKey(bookId))
  } catch { /* 存不了就每次输入 */ }
}

/** 导入时没密码取不到封面: 解锁后补上第一页做封面 */
async function addMissingCover(bookId: string, doc: PdfiumDoc, library: ReturnType<typeof useLibrary>) {
  const storage = await getStorage()
  const book = await storage.getBook(bookId)
  if (!book || book.hasCover || !storage.setCover || !doc.alive) return
  const cover = await pdfCoverBlob(doc)
  if (!cover) return
  await storage.setCover(bookId, cover)
  // 书架只在刷新时读封面: 回到书架就能看到新封面
  await library.refresh()
}

export function usePdfPassword(bookId: string) {
  const library = useLibrary()
  /** 正在等读者输入密码; wrong = 刚输入的密码不对, attempt 每输错一次加一 */
  const prompt = ref<{ wrong: boolean; attempt: number } | null>(null)
  type Answer = { password: string; remember: boolean }
  let answer: ((value: Answer) => void) | null = null

  /** 打开文档; 要密码时一直等到读者输对为止。返回的 password 要交给 MuPDF 渲染 */
  async function open(data: ArrayBuffer): Promise<{ doc: PdfiumDoc; password: string }> {
    let password = savedPassword(bookId)
    let remember = true
    let typed = false
    for (;;) {
      try {
        const doc = await PdfiumDoc.open(data, password)
        prompt.value = null
        if (password) {
          savePassword(bookId, remember ? password : null)
          void addMissingCover(bookId, doc, library).catch(e => console.warn('[pdf] cover after unlock', e))
        }
        return { doc, password }
      } catch (e) {
        if (!(e instanceof PdfPasswordError)) throw e
        // 记住的密码失效 (文件换了密码) 时不算输错, 只是重新问
        if (!typed) savePassword(bookId, null)
        prompt.value = { wrong: typed, attempt: (prompt.value?.attempt ?? 0) + 1 }
        ;({ password, remember } = await new Promise<Answer>(resolve => { answer = resolve }))
        typed = true
      }
    }
  }

  function submit(password: string, remember: boolean) {
    answer?.({ password, remember })
    answer = null
  }

  return { prompt, open, submit }
}
