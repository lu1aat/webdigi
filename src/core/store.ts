/**
 * Tiny IndexedDB key/value store for data that does not belong in settings
 * (bookmarks, recordings, logs...). One object store per collection.
 */
export interface Store {
  get<T>(collection: string, key: string): Promise<T | undefined>
  put<T>(collection: string, key: string, value: T): Promise<void>
  delete(collection: string, key: string): Promise<void>
  list<T>(collection: string): Promise<{ key: string; value: T }[]>
}

const DB = 'awt'
/** Every collection a module uses must be declared in `Module.collections`. */
export async function openStore(collections: string[]): Promise<Store> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    // Version is derived from the collection list so adding a collection upgrades the schema.
    const probe = indexedDB.open(DB)
    probe.onsuccess = () => {
      const existing = probe.result
      const have = new Set(Array.from(existing.objectStoreNames))
      const missing = collections.filter((c) => !have.has(c))
      if (!missing.length) return resolve(existing)
      const version = existing.version + 1
      existing.close()
      const up = indexedDB.open(DB, version)
      up.onupgradeneeded = () => missing.forEach((c) => up.result.createObjectStore(c))
      up.onsuccess = () => resolve(up.result)
      up.onerror = () => reject(up.error)
    }
    probe.onerror = () => reject(probe.error)
  })

  const tx = <R>(c: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<R>) =>
    new Promise<R>((resolve, reject) => {
      const req = run(db.transaction(c, mode).objectStore(c))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })

  return {
    get: <T>(c: string, k: string) => tx<T | undefined>(c, 'readonly', (s) => s.get(k)),
    put: async (c, k, v) => void (await tx(c, 'readwrite', (s) => s.put(v, k))),
    delete: async (c, k) => void (await tx(c, 'readwrite', (s) => s.delete(k))),
    list: async <T>(c: string) => {
      const keys = await tx<IDBValidKey[]>(c, 'readonly', (s) => s.getAllKeys())
      const vals = await tx<T[]>(c, 'readonly', (s) => s.getAll())
      return keys.map((k, i) => ({ key: String(k), value: vals[i] }))
    },
  }
}
