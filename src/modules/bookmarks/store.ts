/**
 * Bookmark model, ported from soundradar's marker store. No DOM and no storage:
 * persistence is injected, so it is unit-testable. A bookmark is a centre
 * frequency + bandwidth in Hz, so it stays put across FFT size, zoom and span changes.
 */
export interface Bookmark {
  id: string
  freq: number
  /** Full bandwidth in Hz (not ±). */
  bw: number
  name: string
  color: string
  alarm: boolean
  /** Alarm trigger level in dB. */
  alarmDb: number
}

export interface Level {
  /** Peak level in the band right now (NaN when not listening). */
  db: number
  /** Frequency of that peak. */
  hz: number
  /** Highest level seen since the last reset. */
  peak: number
}

export type NewBookmark = Partial<Omit<Bookmark, 'id'>> & { freq: number }

export const DEFAULT_BW = 50
export const DEFAULT_ALARM_DB = -50
export const PALETTE = ['#ffb45a', '#5ad1ff', '#ff7a90', '#9be564', '#c58bff', '#ffe066', '#4de0c0', '#ff9f6b']
const HISTORY = 300

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))
const roundHz = (f: number) => Number(f.toFixed(f < 1000 ? 1 : 0))
const alarmDbOf = (v: unknown, fallback = DEFAULT_ALARM_DB) => {
  const n = Number(v)
  return Number.isFinite(n) ? clamp(n, -150, 0) : fallback
}

/** Multiples 2..count+1 of a fundamental, up to maxHz: the stack a motor, fan or hum shows. */
export function harmonics(fundamental: number, maxHz: number, count = 8): number[] {
  const out: number[] = []
  for (let n = 2; n <= count + 1; n++) {
    if (fundamental * n > maxHz) break
    out.push(fundamental * n)
  }
  return out
}

/** Mains hum and its multiples 1..count, up to maxHz. */
export function mains(base: number, maxHz: number, count = 8): number[] {
  const out: number[] = []
  for (let n = 1; n <= count; n++) {
    if (base * n > maxHz) break
    out.push(base * n)
  }
  return out
}

/** Loudest level between lo and hi Hz in a dB spectrum, and where it is. */
export function bandPeak(d: Float32Array, lo: number, hi: number, sampleRate: number): { db: number; hz: number } {
  const n = d.length
  const nyq = sampleRate / 2
  const i0 = Math.max(0, Math.floor((lo / nyq) * n))
  const i1 = Math.min(n - 1, Math.ceil((hi / nyq) * n))
  let best = -Infinity
  let at = i0
  for (let i = i0; i <= i1; i++)
    if (d[i] > best) {
      best = d[i]
      at = i
    }
  return Number.isFinite(best) ? { db: best, hz: (at / n) * nyq } : { db: NaN, hz: NaN }
}

function normalise(m: Record<string, unknown>, i: number): Bookmark | null {
  const freq = Number(m.freq ?? m.hz) // "hz"/"label": the first version of this module
  if (!Number.isFinite(freq) || freq <= 0) return null
  const bw = Number(m.bw)
  return {
    id: typeof m.id === 'string' && m.id ? m.id : crypto.randomUUID(),
    freq,
    bw: bw > 0 ? bw : DEFAULT_BW,
    name: String(m.name ?? m.label ?? '').trim() || `M${i + 1}`,
    color: typeof m.color === 'string' && m.color ? m.color : PALETTE[i % PALETTE.length],
    alarm: Boolean(m.alarm),
    alarmDb: alarmDbOf(m.alarmDb),
  }
}

export class BookmarkStore {
  /** Newest first, where the eye lands. Row N is pin N on the ruler. */
  items: Bookmark[] = []
  private levels = new Map<string, Level>()
  private hist = new Map<string, { buf: Float32Array; len: number; pos: number }>()
  private subs = new Set<() => void>()

  constructor(private persist: (items: Bookmark[]) => void = () => {}) {}

  subscribe(fn: () => void): () => void {
    this.subs.add(fn)
    return () => this.subs.delete(fn)
  }

  private notify() {
    this.subs.forEach((fn) => fn())
  }

  /** Persist and notify. Called after every change; also after loading legacy data. */
  commit(): void {
    this.persist(this.items)
    this.notify()
  }

  /** Replace everything from stored data (not persisted back, not an edit). */
  load(raw: unknown[]): void {
    this.items = raw
      .map((m, i) => (m && typeof m === 'object' ? normalise(m as Record<string, unknown>, i) : null))
      .filter((m): m is Bookmark => m !== null)
    this.levels.clear()
    this.hist.clear()
    this.items.forEach((m) => this.resetHistory(m.id))
    this.notify()
  }

  private resetHistory(id: string) {
    this.hist.set(id, { buf: new Float32Array(HISTORY).fill(NaN), len: 0, pos: 0 })
  }

  private make(e: NewBookmark, offset: number): Bookmark {
    const at = this.items.length + offset
    const m: Bookmark = {
      id: crypto.randomUUID(),
      freq: roundHz(Math.max(1, e.freq)),
      bw: e.bw && e.bw > 0 ? e.bw : DEFAULT_BW,
      name: e.name?.trim() || `M${at + 1}`,
      color: e.color || PALETTE[at % PALETTE.length],
      alarm: Boolean(e.alarm),
      alarmDb: alarmDbOf(e.alarmDb),
    }
    this.resetHistory(m.id)
    return m
  }

  add(freq: number, opts: Partial<Omit<Bookmark, 'id' | 'freq'>> = {}): Bookmark {
    const m = this.make({ freq, ...opts }, 0)
    this.items.unshift(m)
    this.commit()
    return m
  }

  /** Add several with a single notification (harmonic stacks, imports). */
  addMany(entries: NewBookmark[]): Bookmark[] {
    const added = entries.map((e, i) => this.make(e, i))
    this.items.unshift(...added)
    this.commit()
    return added
  }

  get(id: string): Bookmark | undefined {
    return this.items.find((m) => m.id === id)
  }

  remove(id: string): void {
    const before = this.items.length
    this.items = this.items.filter((m) => m.id !== id)
    if (this.items.length === before) return
    this.levels.delete(id)
    this.hist.delete(id)
    this.commit()
  }

  update(id: string, patch: Partial<Omit<Bookmark, 'id'>>): void {
    const m = this.get(id)
    if (!m) return
    const p = { ...patch }
    if (p.freq !== undefined) p.freq = Math.max(1, Number(p.freq) || m.freq)
    if (p.bw !== undefined) p.bw = Math.max(1, Number(p.bw) || m.bw)
    if (p.alarmDb !== undefined) p.alarmDb = alarmDbOf(p.alarmDb, m.alarmDb)
    Object.assign(m, p)
    this.commit()
  }

  move(id: string, delta: number): void {
    const i = this.items.findIndex((m) => m.id === id)
    const j = i + delta
    if (i === -1 || j < 0 || j >= this.items.length) return
    ;[this.items[i], this.items[j]] = [this.items[j], this.items[i]]
    this.commit()
  }

  clear(): void {
    if (!this.items.length) return
    this.items = []
    this.levels.clear()
    this.hist.clear()
    this.commit()
  }

  armedCount(): number {
    return this.items.filter((m) => m.alarm).length
  }

  /** Disarm every alarm with one notification. Returns how many were armed. */
  disableAllAlarms(): number {
    const armed = this.items.filter((m) => m.alarm)
    if (!armed.length) return 0
    armed.forEach((m) => (m.alarm = false))
    this.commit()
    return armed.length
  }

  /** Nearest bookmark within `tolerance` Hz, or undefined. */
  nearest(freq: number, tolerance: number): Bookmark | undefined {
    let best: Bookmark | undefined
    let bestD = Infinity
    for (const m of this.items) {
      const d = Math.abs(m.freq - freq)
      if (d < bestD && d <= tolerance) [best, bestD] = [m, d]
    }
    return best
  }

  /** Peak level in every band. Call once per frame; null data = not listening. */
  updateLevels(data: Float32Array | null, sampleRate: number): void {
    for (const m of this.items) {
      const half = m.bw / 2
      const res = data ? bandPeak(data, m.freq - half, m.freq + half, sampleRate) : { db: NaN, hz: NaN }
      const prev = this.levels.get(m.id)
      const peak = Number.isFinite(res.db) ? Math.max(res.db, prev?.peak ?? -Infinity) : (prev?.peak ?? -Infinity)
      this.levels.set(m.id, { db: res.db, hz: res.hz, peak })
      const h = this.hist.get(m.id)
      if (h) {
        h.buf[h.pos] = res.db
        h.pos = (h.pos + 1) % HISTORY
        h.len = Math.min(HISTORY, h.len + 1)
      }
    }
  }

  resetPeaks(): void {
    for (const [id, l] of this.levels) this.levels.set(id, { ...l, peak: -Infinity })
  }

  level(id: string): Level {
    return this.levels.get(id) ?? { db: NaN, hz: NaN, peak: -Infinity }
  }

  /** History oldest to newest, so charts plot left to right directly. */
  history(id: string): number[] {
    const h = this.hist.get(id)
    if (!h) return []
    return Array.from({ length: h.len }, (_, i) => h.buf[(h.pos - h.len + i + HISTORY * 2) % HISTORY])
  }

  toCsv(): string {
    const rows: (string | number)[][] = [['name', 'frequency_hz', 'bandwidth_hz', 'level_db', 'peak_db']]
    for (const m of this.items) {
      const l = this.level(m.id)
      rows.push([m.name, m.freq, m.bw, Number.isFinite(l.db) ? l.db.toFixed(2) : '', Number.isFinite(l.peak) ? l.peak.toFixed(2) : ''])
    }
    return rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
  }

  toJson(): string {
    return JSON.stringify(
      this.items.map((m) => ({ name: m.name, freq: m.freq, bw: m.bw, color: m.color, alarm: m.alarm, alarmDb: m.alarmDb })),
      null,
      2,
    )
  }

  /**
   * Merge an exported list into the current one (never replaces). Returns how many were added.
   * Throws Error('invalid-json') or Error('no-list').
   */
  importJson(text: string): number {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error('invalid-json')
    }
    if (!Array.isArray(parsed)) throw new Error('no-list')
    const entries: NewBookmark[] = parsed
      .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object' && Number.isFinite(Number((m as Record<string, unknown>).freq ?? (m as Record<string, unknown>).hz)))
      .map((m) => ({
        freq: Number(m.freq ?? m.hz),
        bw: Number(m.bw) || undefined,
        name: m.name === undefined && m.label === undefined ? undefined : String(m.name ?? m.label),
        color: typeof m.color === 'string' ? m.color : undefined,
        alarm: Boolean(m.alarm),
        alarmDb: m.alarmDb === undefined ? undefined : Number(m.alarmDb),
      }))
    if (!entries.length) throw new Error('no-list')
    this.addMany(entries)
    return entries.length
  }
}
