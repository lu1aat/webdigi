import type { Bookmark, Level } from './store'

/**
 * The "finder" alarm, ported from soundradar. Arm it on a bookmark and it beeps while that band is
 * at or above its trigger level: the louder, the higher the pitch and the faster the beeps, so you
 * can walk a mic around and hear yourself getting closer without watching the screen.
 */
export const ALARM_MIN_HZ = 700 // at the trigger level
export const ALARM_MAX_HZ = 5600 // at the top of the display window
const SLOW_MS = 520 // beep spacing just above the trigger
const FAST_MS = 90 // ... and at full intensity
const SPAN_FLOOR_DB = 6 // never map intensity across less than this

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

/** 0-1 position of db between the trigger level and the display ceiling. */
export function alarmIntensity(db: number, triggerDb: number, ceilingDb: number): number {
  if (!Number.isFinite(db)) return 0
  return clamp01((db - triggerDb) / Math.max(SPAN_FLOOR_DB, ceilingDb - triggerDb))
}

/** Geometric, so the rise sounds even to the ear. */
export function alarmPitch(intensity: number): number {
  return ALARM_MIN_HZ * Math.pow(ALARM_MAX_HZ / ALARM_MIN_HZ, clamp01(intensity))
}

export interface AlarmFrame {
  items: Bookmark[]
  levelOf(id: string): Level
  /** Top of the display window: full intensity. */
  ceilingDb: number
  /** 0-1 master level; 0 = muted. */
  volume: number
  /** Listening. */
  live: boolean
  /** Current time in ms (injectable for tests). */
  now: number
  beep(hz: number, volume: number): void
}

export class AlarmScheduler {
  private next = new Map<string, number>()
  /** Ids sounding right now, for the UI. */
  readonly active = new Set<string>()

  reset(): void {
    this.next.clear()
    this.active.clear()
  }

  update(f: AlarmFrame): void {
    if (!f.live || !(f.volume > 0)) return this.reset()
    const seen = new Set<string>()
    for (const m of f.items) {
      if (!m.alarm) continue
      seen.add(m.id)
      const db = f.levelOf(m.id).db
      if (!Number.isFinite(db) || db < m.alarmDb) {
        this.active.delete(m.id)
        this.next.delete(m.id)
        continue
      }
      this.active.add(m.id)
      const t = alarmIntensity(db, m.alarmDb, f.ceilingDb)
      const due = this.next.get(m.id)
      // Just crossed the trigger: beep at once. The gap is re-read every time, so it tightens as you close in.
      if (due !== undefined && f.now < due) continue
      f.beep(alarmPitch(t), f.volume)
      this.next.set(m.id, f.now + SLOW_MS + (FAST_MS - SLOW_MS) * t)
    }
    for (const id of [...this.next.keys()]) if (!seen.has(id)) this.next.delete(id)
    for (const id of [...this.active]) if (!seen.has(id)) this.active.delete(id)
  }
}
