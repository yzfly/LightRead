import { defineStore } from 'pinia'
import type { BooklistRec, BookMeta } from '../storage'
import { getStorage } from '../storage'

export const useLibrary = defineStore('library', {
  state: () => ({
    books: [] as BookMeta[],
    booklists: [] as BooklistRec[],
    booklistBookIds: {} as Record<string, string[]>,
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
      this.books = books
      this.booklists = booklists
      this.booklistBookIds = Object.fromEntries(memberships)
      this.loaded = true
      // 封面异步补齐
      for (const book of this.books) {
        if (book.hasCover && !this.coverUrls[book.id]) {
          storage.getCoverUrl(book.id).then(url => {
            if (url) this.coverUrls[book.id] = url
          })
        }
      }
    },
    async removeBook(id: string) {
      const storage = await getStorage()
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
      const storage = await getStorage()
      const patch = { location, progress, lastReadAt: Date.now() }
      await storage.updateBook(id, patch)
      const book = this.books.find(b => b.id === id)
      if (book) Object.assign(book, patch)
    },
    /** 累加阅读时长 (秒) */
    async addReadingTime(id: string, seconds: number) {
      if (seconds <= 0) return
      const storage = await getStorage()
      const meta = await storage.getBook(id)
      if (!meta) return
      const readingSeconds = (meta.readingSeconds ?? 0) + Math.round(seconds)
      await storage.updateBook(id, { readingSeconds })
      const book = this.books.find(b => b.id === id)
      if (book) book.readingSeconds = readingSeconds
    },
  },
})
