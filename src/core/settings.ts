export type SettingValue = number | boolean | string

export interface SettingDef {
  /** Unique key; modules should prefix with their id, e.g. "spectrum.minDb". */
  key: string
  /** i18n key for the label. */
  label: string
  type: 'number' | 'boolean' | 'select' | 'string'
  default: SettingValue
  min?: number
  max?: number
  step?: number
  /** Number settings: render as a slider with a live value instead of a number box. */
  control?: 'slider'
  /** Suffix shown after a slider value, e.g. " dB". */
  unit?: string
  /** Hide from the core Settings pane; the owning module renders its own controls. Still persisted/exported. */
  hidden?: boolean
  /** For type "select". */
  options?: { value: string; label: string }[]
}

/** Minimal Storage subset so tests can inject a fake. */
export interface KV {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
  removeItem(k: string): void
  key(i: number): string | null
  readonly length: number
}

export function browserKV(): KV {
  try {
    localStorage.getItem('x')
    return localStorage
  } catch {
    const m = new Map<string, string>()
    return {
      getItem: (k) => m.get(k) ?? null,
      setItem: (k, v) => void m.set(k, v),
      removeItem: (k) => void m.delete(k),
      key: (i) => [...m.keys()][i] ?? null,
      get length() {
        return m.size
      },
    }
  }
}

const PREFIX = 'awt:'

export class Settings {
  private defs = new Map<string, SettingDef>()
  private subs = new Map<string, Set<(v: SettingValue) => void>>()

  constructor(private kv: KV = browserKV()) {}

  register(defs: SettingDef[]): void {
    for (const d of defs) this.defs.set(d.key, d)
  }

  definitions(): SettingDef[] {
    return [...this.defs.values()]
  }

  get<T extends SettingValue = SettingValue>(key: string): T {
    const def = this.defs.get(key)
    const raw = this.kv.getItem(PREFIX + key)
    if (raw !== null) {
      try {
        const v = JSON.parse(raw)
        if (!def || typeof v === typeof def.default) return v as T
      } catch {
        /* fall through to default */
      }
    }
    return def?.default as T
  }

  set(key: string, value: SettingValue): void {
    const def = this.defs.get(key)
    if (def?.type === 'number' && typeof value === 'number') {
      value = Math.min(def.max ?? Infinity, Math.max(def.min ?? -Infinity, value))
    }
    this.kv.setItem(PREFIX + key, JSON.stringify(value))
    this.subs.get(key)?.forEach((fn) => fn(value))
  }

  /** Subscribe to changes of one key. Returns an unsubscribe function. */
  watch(key: string, fn: (v: SettingValue) => void): () => void {
    let set = this.subs.get(key)
    if (!set) this.subs.set(key, (set = new Set()))
    set.add(fn)
    return () => set!.delete(fn)
  }

  /**
   * Forget every stored value so each setting is back at its default. Saved data (IndexedDB) is
   * untouched. Callers should reload afterwards: running views hold the old values.
   */
  resetAll(): void {
    const keys: string[] = []
    for (let i = 0; i < this.kv.length; i++) {
      const k = this.kv.key(i)
      if (k?.startsWith(PREFIX)) keys.push(k)
    }
    keys.forEach((k) => this.kv.removeItem(k))
  }

  /** All stored values (including keys of modules not currently loaded). */
  exportAll(): Record<string, SettingValue> {
    const out: Record<string, SettingValue> = {}
    for (let i = 0; i < this.kv.length; i++) {
      const k = this.kv.key(i)
      if (k?.startsWith(PREFIX)) {
        try {
          out[k.slice(PREFIX.length)] = JSON.parse(this.kv.getItem(k)!)
        } catch {
          /* skip corrupt entry */
        }
      }
    }
    return out
  }

  importAll(data: Record<string, SettingValue>): void {
    for (const [k, v] of Object.entries(data)) this.set(k, v)
  }
}
