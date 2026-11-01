/** Preserve folder categories using existing, syncable booklists; no filesystem access. */
interface FolderEntry { path: string }
interface ImportResult { ok: boolean; bookId?: string }
interface BooklistLibrary {
  booklists: readonly { id: string; name: string }[]
  createBooklist(name: string): Promise<string>
  addBooksToBooklist(id: string, bookIds: string[]): Promise<void>
}

/** Import results retain input order, including failures; never match by basename. */
export function groupFolderBooks(rootName: string, entries: readonly FolderEntry[], results: readonly ImportResult[]) {
  const groups = new Map<string, string[]>()
  entries.forEach((entry, index) => {
    const result = results[index]
    if (!result?.ok || !result.bookId) return
    const parts = entry.path.replace(/\\/g, '/').split('/')
    // Only relative scan paths belong in a booklist name.
    if (!parts[0] || /^[A-Za-z]:$/.test(parts[0]) || parts.some(p => p === '.' || p === '..')) return
    const name = [rootName, ...parts.slice(0, -1)].filter(Boolean).join('/').trim()
    if (!name) return // A loose file in a multi-root drop has no folder category.
    const ids = groups.get(name) ?? []
    if (!ids.includes(result.bookId)) ids.push(result.bookId)
    groups.set(name, ids)
  })
  return groups
}

export async function addFolderBooklists(
  library: BooklistLibrary,
  rootName: string,
  entries: readonly FolderEntry[],
  results: readonly ImportResult[],
) {
  const names = new Map(library.booklists.map(list => [list.name.trim().toLocaleLowerCase(), list.id]))
  for (const [name, bookIds] of groupFolderBooks(rootName, entries, results)) {
    const key = name.toLocaleLowerCase()
    const id = names.get(key) ?? await library.createBooklist(name)
    names.set(key, id)
    await library.addBooksToBooklist(id, bookIds)
  }
}
