import { defineStore } from 'pinia'
import type { BookMeta } from '../storage'
import { getStorage } from '../storage'

export const useLibrary = defineStore('library', {
  state: () => ({
    books: [] as BookMeta[],
    loaded: false,
    coverUrls: {} as Record<string, string>,
  }),
  actions: {
    async refresh() {
      const storage = await getStorage()
      this.books = await storage.listBooks()
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
      delete this.coverUrls[id]
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
