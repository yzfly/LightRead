import { defineStore } from 'pinia'
import type { BooklistRec, BooklistWantedRec, BookMeta } from '../storage'
import { getStorage, newId } from '../storage'
import { createCoverResolver } from '../services/coverRepair'
import { planAutoLink, planListImport, type BooklistEntry } from '../services/booklists'
import { recordReading } from '../services/readingLog.ts'
import { activeAgentTurn, cleanupAgentPaper, paperAgentRuntimeAvailable, stopAgentTurn } from '../services/paperAgent.ts'

const resolveCover = createCoverResolver({
  storage: {
    getCoverUrl: async id => (await getStorage()).getCoverUrl(id),
    setCover: async (id, cover) => (await getStorage()).setCover?.(id, cover),
    clearCover: async id => (await getStorage()).clearCover?.(id),
  },
  regenerate: async book => (await import('../services/importer')).regenerateCover(book),
})

/** 本次运行里各书最后一次保存的进度 (见 saveProgress / refresh) */
const lastSavedProgress = new Map<string, { location: string; progress: number; lastReadAt: number }>()

export const useLibrary = defineStore('library', {
  state: () => ({
    books: [] as BookMeta[],
    booklists: [] as BooklistRec[],
    booklistBookIds: {} as Record<string, string[]>,
    /** 书单 id → 待找条目 (还不在藏书里的书), 按加入时间升序 */
    booklistWanted: {} as Record<string, BooklistWantedRec[]>,
    loaded: false,
    coverUrls: {} as Record<string, string>,
  }),
  actions: {
    async refresh() {
      const storage = await getStorage()
      const [books, booklists] = await Promise.all([
        storage.listBooks(),
        storage.listBooklists(),
      ])
      const memberships = await Promise.all(booklists.map(async booklist => [
        booklist.id,
        await storage.listBooklistBookIds(booklist.id),
      ] as const))
      let wanted = await storage.listBooklistWanted()
      // 待找的书已经进了藏书 (导入 / 下载 / 同步之后): 自动加入书单并删除待找条目
      const links = planAutoLink(wanted, books)
      if (links.length) {
        const byList = Object.fromEntries(memberships.map(([id, ids]) => [id, [...ids]]))
        for (const link of links) {
          if (!byList[link.booklistId]) continue
          if (!byList[link.booklistId].includes(link.bookId)) {
            await storage.addBooksToBooklist(link.booklistId, [link.bookId])
            byList[link.booklistId].push(link.bookId)
          }
        }
        await storage.deleteBooklistWanted(links.map(link => link.wantedId))
        const linked = new Set(links.map(link => link.wantedId))
        wanted = wanted.filter(entry => !linked.has(entry.id))
        this.booklistBookIds = byList
      } else {
        this.booklistBookIds = Object.fromEntries(memberships)
      }
      // 本次运行里刚存的进度比列表新就以它为准 (列表可能是写入落盘前读的)
      for (const book of books) {
        const patch = lastSavedProgress.get(book.id)
        if (patch && patch.lastReadAt > (book.lastReadAt ?? 0)) Object.assign(book, patch)
      }
      this.books = books
      this.booklists = booklists
      this.booklistWanted = groupWanted(wanted)
      this.loaded = true
      // 封面异步补齐; 本地封面损坏 (空文件 / 缺失 / 不是图片) 时从书籍文件重新生成, 期间显示文字封面
      for (const book of this.books) {
        if (book.hasCover && !this.coverUrls[book.id]) {
          resolveCover(book).then(url => {
            if (url) this.coverUrls[book.id] = url
          }).catch(e => console.warn('[cover]', book.id, e))
        }
      }
    },
    async removeBook(id: string) {
      const storage = await getStorage()
      const book = this.books.find(item => item.id === id) ?? await storage.getBook(id)
      // Agent 数据与论文原文件分开存放；先停止并清理，任何失败都保留书库记录供重试。
      if (paperAgentRuntimeAvailable() && book?.format === 'pdf') {
        const active = await activeAgentTurn(id)
        if (active) {
          try {
            await stopAgentTurn(id, active.turnId)
          } catch (error) {
            if (await activeAgentTurn(id)) throw error
          }
        }
        await cleanupAgentPaper(id)
      }
      await storage.deleteBook(id)
      this.books = this.books.filter(b => b.id !== id)
      for (const booklistId of Object.keys(this.booklistBookIds)) {
        this.booklistBookIds[booklistId] =
          this.booklistBookIds[booklistId].filter(bookId => bookId !== id)
      }
      delete this.coverUrls[id]
    },
    async createBooklist(name: string) {
      const storage = await getStorage()
      const id = await storage.createBooklist(name)
      const now = Date.now()
      this.booklists.unshift({ id, name, createdAt: now, updatedAt: now })
      this.booklistBookIds[id] = []
      return id
    },
    async renameBooklist(id: string, name: string) {
      const storage = await getStorage()
      await storage.renameBooklist(id, name)
      const booklist = this.booklists.find(item => item.id === id)
      if (booklist) {
        booklist.name = name
        booklist.updatedAt = Date.now()
      }
    },
    async deleteBooklist(id: string) {
      const storage = await getStorage()
      await storage.deleteBooklist(id)
      this.booklists = this.booklists.filter(item => item.id !== id)
      delete this.booklistBookIds[id]
      delete this.booklistWanted[id]
    },
    /** 给书单添加待找的书 (书目信息); 已在藏书里的直接加入书单, 与已有条目重复的跳过. 返回 [加入的书, 新待找] 数量 */
    async addEntriesToBooklist(booklistId: string, entries: readonly BooklistEntry[]) {
      const storage = await getStorage()
      const plan = planListImport(entries, this.books, {
        bookIds: this.booklistBookIds[booklistId] ?? [],
        wanted: this.booklistWanted[booklistId] ?? [],
      })
      if (plan.bookIds.length) await this.addBooksToBooklist(booklistId, plan.bookIds)
      if (plan.wanted.length) {
        const now = Date.now()
        const recs: BooklistWantedRec[] = plan.wanted.map((entry, index) => ({
          ...entry,
          id: newId(),
          booklistId,
          addedAt: now + index,
        }))
        await storage.putBooklistWanted(recs)
        this.booklistWanted[booklistId] = [...(this.booklistWanted[booklistId] ?? []), ...recs]
        const booklist = this.booklists.find(item => item.id === booklistId)
        if (booklist) booklist.updatedAt = now
      }
      return { linked: plan.bookIds.length, wanted: plan.wanted.length }
    },
    /**
     * 把一组书目存成个人书单: 有同名书单就并进去, 否则新建 (uniqueName 时同名加序号另建).
     * 用于「全部加入我的书单」与「导入书单」.
     */
    async saveEntriesAsBooklist(name: string, entries: readonly BooklistEntry[], opts: { uniqueName?: boolean } = {}) {
      const trimmed = name.trim() || 'Booklist'
      const sameName = (n: string) => this.booklists.find(
        item => item.name.trim().toLocaleLowerCase() === n.trim().toLocaleLowerCase())
      let target = sameName(trimmed)
      let finalName = trimmed
      if (target && opts.uniqueName) {
        for (let i = 2; sameName(finalName); i++) finalName = `${trimmed} (${i})`
        target = undefined
      }
      const created = !target
      const id = target?.id ?? await this.createBooklist(finalName)
      const result = await this.addEntriesToBooklist(id, entries)
      return { id, name: finalName, created, ...result }
    },
    async updateWanted(rec: BooklistWantedRec) {
      const storage = await getStorage()
      const plain: BooklistWantedRec = JSON.parse(JSON.stringify(rec))
      await storage.putBooklistWanted([plain])
      const list = this.booklistWanted[rec.booklistId] ?? []
      this.booklistWanted[rec.booklistId] = list.map(item => (item.id === rec.id ? plain : item))
    },
    async removeWanted(ids: string[]) {
      const storage = await getStorage()
      await storage.deleteBooklistWanted(ids)
      const removed = new Set(ids)
      for (const listId of Object.keys(this.booklistWanted)) {
        this.booklistWanted[listId] = this.booklistWanted[listId].filter(item => !removed.has(item.id))
      }
    },
    async addBooksToBooklist(booklistId: string, bookIds: string[]) {
      const storage = await getStorage()
      await storage.addBooksToBooklist(booklistId, bookIds)
      this.booklistBookIds[booklistId] = [
        ...new Set([...(this.booklistBookIds[booklistId] ?? []), ...bookIds]),
      ]
      const booklist = this.booklists.find(item => item.id === booklistId)
      if (booklist) booklist.updatedAt = Date.now()
    },
    async removeBooksFromBooklist(booklistId: string, bookIds: string[]) {
      const storage = await getStorage()
      await storage.removeBooksFromBooklist(booklistId, bookIds)
      const removed = new Set(bookIds)
      this.booklistBookIds[booklistId] =
        (this.booklistBookIds[booklistId] ?? []).filter(id => !removed.has(id))
      const booklist = this.booklists.find(item => item.id === booklistId)
      if (booklist) booklist.updatedAt = Date.now()
    },
    async saveProgress(id: string, location: string, progress: number) {
      const patch = { location, progress, lastReadAt: Date.now() }
      // 先改内存再落盘: 离开阅读页时补存的进度和藏书页的 refresh 并发, refresh 读到旧值会盖掉卡片进度 (R3 overall R3O-01)
      const book = this.books.find(b => b.id === id)
      if (book) Object.assign(book, patch)
      lastSavedProgress.set(id, patch)
      await (await getStorage()).updateBook(id, patch)
    },
    /** 累加阅读时长 (秒), 同时记入每日阅读记录 (at: 归到哪一天, 缺省为现在) */
    async addReadingTime(id: string, seconds: number, at?: number) {
      if (seconds <= 0) return
      const storage = await getStorage()
      const meta = await storage.getBook(id)
      if (!meta) return
      const readingSeconds = (meta.readingSeconds ?? 0) + Math.round(seconds)
      await storage.updateBook(id, { readingSeconds })
      const book = this.books.find(b => b.id === id)
      if (book) book.readingSeconds = readingSeconds
      // 每日记录是附加统计: 失败不影响书的累计时长
      try {
        await recordReading({ id, title: meta.title, kind: meta.kind }, Math.round(seconds), at)
      } catch (err) {
        console.warn('[readingLog] record failed', err)
      }
    },
  },
})

function groupWanted(wanted: BooklistWantedRec[]): Record<string, BooklistWantedRec[]> {
  const out: Record<string, BooklistWantedRec[]> = {}
  for (const entry of wanted) (out[entry.booklistId] ??= []).push(entry)
  return out
}
