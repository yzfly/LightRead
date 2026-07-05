import type { LibraryStorage } from './types'
import { isTauri } from './types'

let instance: LibraryStorage | null = null
let ready: Promise<LibraryStorage> | null = null

/** 按运行环境选择存储后端 (桌面: 文件系统+SQLite, Web: IndexedDB), 单例 */
export function getStorage(): Promise<LibraryStorage> {
  if (!ready) {
    ready = (async () => {
      if (isTauri()) {
        const { TauriStorage } = await import('./tauri')
        instance = new TauriStorage()
      } else {
        const { DexieStorage } = await import('./dexie')
        instance = new DexieStorage()
      }
      await instance.init()
      return instance
    })()
  }
  return ready
}

export * from './types'
