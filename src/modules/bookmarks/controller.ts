import type { AppContext } from '../../core/module'
import type { SettingDef } from '../../core/settings'
import { BookmarkStore, type Bookmark, harmonics, mains, DEFAULT_BW } from './store'
import { AlarmScheduler } from './alarm'

export const K = (k: string) => `bookmarks.${k}`

// Hidden: the module renders these itself in its Modules-column card.
export const defs: SettingDef[] = [
  { key: K('clickAdds'), label: 'bookmarks.clickAdds', type: 'boolean', default: false, hidden: true },
  { key: K('defaultBw'), label: 'bookmarks.defaultBw', type: 'number', default: DEFAULT_BW, min: 1, max: 5000, step: 1, hidden: true },
  { key: K('alarmVolume'), label: 'bookmarks.alarmVolume', type: 'number', default: 0.25, min: 0, max: 1, step: 0.05, control: 'slider', hidden: true },
  { key: K('alarmMuted'), label: 'bookmarks.alarmMuted', type: 'boolean', default: false, hidden: true },
]

/**
 * Everything the bookmarks panel and options card share: the store, persistence, the per-frame
 * level/alarm loop, and the markers sent to the spectrum. One instance per page.
 */
export class BookmarksController {
  readonly store: BookmarkStore
  readonly alarm = new AlarmScheduler()
  /** Last frequency clicked on a view, for "Add at ...". */
  lastHz: number | null = null
  private shown = new Set<string>()
  private frameFns = new Set<(now: number) => void>()
  private pickFns = new Set<() => void>()

  constructor(private ctx: AppContext) {
    // One ordered list in a single document, so the order (= pin numbers) survives reloads.
    this.store = new BookmarkStore((items) => void ctx.store.put('bookmarks', 'list', items))
    this.store.subscribe(() => this.syncMarkers())
    ctx.bus.on('module:active', ({ id }) => id === 'bookmarks' && this.syncMarkers())
    ctx.bus.on('view:pick', ({ hz }) => {
      this.lastHz = hz
      this.pickFns.forEach((f) => f())
      if (ctx.settings.get<boolean>(K('clickAdds')) && ctx.isActive('bookmarks')) this.store.add(hz, { bw: this.setting('defaultBw') })
    })
    requestAnimationFrame(this.frame)
    void this.load()
  }

  setting(k: string): number {
    return this.ctx.settings.get<number>(K(k))
  }

  /** A number from another module's settings (display range), with a fallback when it is not loaded. */
  private peer(key: string, fallback: number): number {
    return (this.ctx.settings.get(key) as number | undefined) ?? fallback
  }
  /** Display window of the spectrum, used to scale level meters and the alarm's top intensity. */
  get range(): { min: number; max: number } {
    return { min: this.peer('spectrum.minDb', -110), max: this.peer('spectrum.maxDb', -20) }
  }

  onFrame(fn: (now: number) => void): () => void {
    this.frameFns.add(fn)
    return () => this.frameFns.delete(fn)
  }
  onPick(fn: () => void): () => void {
    this.pickFns.add(fn)
    return () => this.pickFns.delete(fn)
  }

  private async load() {
    const rows = await this.ctx.store.list<unknown>('bookmarks')
    const doc = rows.find((r) => r.key === 'list')?.value
    if (Array.isArray(doc)) return this.store.load(doc)
    // First version of the module stored one record per bookmark: fold them into the list.
    const legacy = rows.filter((r) => r.key !== 'list').map((r) => r.value)
    if (legacy.length) {
      this.store.load(legacy)
      this.store.commit()
      await Promise.all(rows.map((r) => this.ctx.store.delete('bookmarks', r.key)))
    }
  }

  private frame = (now: number) => {
    requestAnimationFrame(this.frame)
    const { audio, output } = this.ctx
    const on = this.ctx.isActive('bookmarks')
    const data = on ? audio.spectrum() : null
    if (on) this.store.updateLevels(data, audio.sampleRate)
    this.alarm.update({
      items: on ? this.store.items : [],
      levelOf: (id) => this.store.level(id),
      ceilingDb: this.range.max,
      volume: this.ctx.settings.get<boolean>(K('alarmMuted')) ? 0 : this.setting('alarmVolume'),
      live: !!data,
      now,
      beep: (hz, v) => output.beep(hz, v),
    })
    this.frameFns.forEach((f) => f(now))
  }

  /** Pins on the spectrum ruler: numbered like the table rows, with colour and band. */
  private syncMarkers() {
    const { bus } = this.ctx
    const on = this.ctx.isActive('bookmarks')
    const next = new Map<string, { m: Bookmark; i: number }>(on ? this.store.items.map((m, i) => [`bm:${m.id}`, { m, i }] as [string, { m: Bookmark; i: number }]) : [])
    for (const id of this.shown) if (!next.has(id)) bus.emit('marker:clear', { id })
    for (const [id, { m, i }] of next) bus.emit('marker:set', { id, hz: m.freq, bw: m.bw, color: m.color, label: `${i + 1} ${m.name}` })
    this.shown = new Set(next.keys())
  }

  add(): boolean {
    if (this.lastHz === null) return false
    this.store.add(this.lastHz, { bw: this.setting('defaultBw') })
    return true
  }

  /** Bookmarks on the loudest frequency and its harmonics. Returns how many, or -1 when not listening. */
  markHarmonics(): number {
    const d = this.ctx.audio.spectrum()
    if (!d) return -1
    const nyq = this.ctx.audio.sampleRate / 2
    const from = Math.max(1, Math.ceil((20 / nyq) * d.length)) // ignore DC and rumble
    let at = from
    for (let i = from; i < d.length; i++) if (d[i] > d[at]) at = i
    const f0 = (at / d.length) * nyq
    const bw = this.setting('defaultBw')
    const entries = [f0, ...harmonics(f0, nyq)].map((freq, n) => ({ freq, bw, name: `H${n + 1}` }))
    this.store.addMany(entries)
    return entries.length
  }

  markMains(base: 50 | 60): number {
    const bw = this.setting('defaultBw')
    const entries = mains(base, this.ctx.audio.sampleRate / 2).map((freq, n) => ({ freq, bw, name: `${base} Hz ×${n + 1}` }))
    this.store.addMany(entries)
    return entries.length
  }
}

let instance: BookmarksController | null = null
export const controller = (ctx: AppContext): BookmarksController => (instance ??= new BookmarksController(ctx))
