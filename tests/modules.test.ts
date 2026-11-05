import { describe, it, expect } from 'vitest'
import { BookmarkStore, bandPeak, harmonics, mains } from '../src/modules/bookmarks/store'
import { AlarmScheduler, alarmIntensity, alarmPitch, ALARM_MIN_HZ, ALARM_MAX_HZ } from '../src/modules/bookmarks/alarm'
import { TakeRecorder, wavBlob } from '../src/modules/recorder/recorder'

describe('BookmarkStore', () => {
  it('adds newest first, rounds, names, and persists every change', () => {
    const saved: number[] = []
    const s = new BookmarkStore((items) => saved.push(items.length))
    s.add(440.123)
    s.add(1234.6, { name: ' carrier ' })
    expect(s.items.map((m) => m.freq)).toEqual([1235, 440.1])
    expect(s.items[0].name).toBe('carrier')
    expect(s.items[1].name).toBe('M1')
    expect(saved).toEqual([1, 2])
  })

  it('reorders, updates with clamping, and removes', () => {
    const s = new BookmarkStore()
    const a = s.add(100)
    const b = s.add(200)
    s.move(a.id, -1) // a is last: moves up
    expect(s.items.map((m) => m.id)).toEqual([a.id, b.id])
    s.update(a.id, { freq: 0, alarmDb: 99 })
    expect(s.get(a.id)).toMatchObject({ freq: 100, alarmDb: 0 }) // unusable freq ignored, dB clamped
    s.update(a.id, { freq: -5 })
    expect(s.get(a.id)?.freq).toBe(1) // never below 1 Hz
    s.remove(b.id)
    expect(s.items).toHaveLength(1)
  })

  it('tracks band peaks, peak hold, history and reset', () => {
    const s = new BookmarkStore()
    const m = s.add(1000, { bw: 200 })
    const spec = new Float32Array(1000).fill(-100)
    spec[41] = -30 // bin 41 of 1000 at 24 kHz Nyquist is ~984 Hz: inside 900-1100
    s.updateLevels(spec, 48000)
    expect(s.level(m.id).db).toBe(-30)
    spec[41] = -60
    s.updateLevels(spec, 48000)
    expect(s.level(m.id)).toMatchObject({ db: -60, peak: -30 })
    s.updateLevels(null, 48000) // stopped: level goes NaN, peak is kept
    expect(Number.isNaN(s.level(m.id).db)).toBe(true)
    expect(s.level(m.id).peak).toBe(-30)
    expect(s.history(m.id)).toEqual([-30, -60, NaN])
    s.resetPeaks()
    expect(s.level(m.id).peak).toBe(-Infinity)
  })

  it('exports CSV with quoting and JSON, and imports by merging', () => {
    const s = new BookmarkStore()
    s.add(500, { name: 'say "hi"' })
    expect(s.toCsv().split('\n')[1]).toBe('"say ""hi""","500","50","",""')
    const json = s.toJson()
    expect(s.importJson(json)).toBe(1)
    expect(s.items).toHaveLength(2) // merged, not replaced
    expect(() => s.importJson('nope')).toThrow('invalid-json')
    expect(() => s.importJson('{"a":1}')).toThrow('no-list')
    expect(() => s.importJson('[{"x":1}]')).toThrow('no-list')
  })

  it('loads the first-version shape (hz/label) and drops junk', () => {
    const s = new BookmarkStore()
    s.load([{ hz: 700, label: 'old' }, { hz: 'x' }, null, { freq: 900, bw: 20, name: 'new' }])
    expect(s.items.map((m) => [m.freq, m.name, m.bw])).toEqual([
      [700, 'old', 50],
      [900, 'new', 20],
    ])
  })

  it('disables all alarms with one change', () => {
    const s = new BookmarkStore()
    s.add(100, { alarm: true })
    s.add(200, { alarm: true })
    s.add(300)
    expect(s.armedCount()).toBe(2)
    expect(s.disableAllAlarms()).toBe(2)
    expect(s.armedCount()).toBe(0)
  })
})

describe('frequency helpers', () => {
  it('bandPeak finds the loudest bin in range and ignores the rest', () => {
    const d = new Float32Array(100).fill(-90)
    d[10] = -20
    d[80] = -10
    const r = bandPeak(d, 0, 6000, 48000) // 24 kHz / 100 bins: bin 10 = 2400 Hz, bin 80 = 19200 Hz
    expect(r.db).toBe(-20)
    expect(r.hz).toBeCloseTo(2400)
  })
  it('harmonics and mains stop at the limit', () => {
    expect(harmonics(100, 450)).toEqual([200, 300, 400])
    expect(mains(50, 220)).toEqual([50, 100, 150, 200])
  })
})

describe('alarm', () => {
  it('intensity and pitch map the trigger..ceiling range onto 700..5600 Hz', () => {
    expect(alarmIntensity(-50, -50, -20)).toBe(0)
    expect(alarmIntensity(-20, -50, -20)).toBe(1)
    expect(alarmIntensity(NaN, -50, -20)).toBe(0)
    expect(alarmPitch(0)).toBeCloseTo(ALARM_MIN_HZ)
    expect(alarmPitch(1)).toBeCloseTo(ALARM_MAX_HZ)
  })

  it('beeps at once when armed and over the trigger, then at a spacing that tightens with level', () => {
    const s = new BookmarkStore()
    const m = s.add(1000, { alarm: true, alarmDb: -50 })
    const beeps: number[] = []
    const sched = new AlarmScheduler()
    const frame = (now: number, db: number) =>
      sched.update({ items: s.items, levelOf: () => ({ db, hz: 1000, peak: db }), ceilingDb: -20, volume: 0.3, live: true, now, beep: (hz) => beeps.push(Math.round(hz)) })

    frame(0, -60) // below the trigger: silent
    expect(beeps).toHaveLength(0)
    frame(10, -50) // just over: beeps immediately, next one due after the slow 520 ms gap
    expect(beeps).toHaveLength(1)
    frame(300, -50)
    expect(beeps).toHaveLength(1)
    frame(540, -20) // louder: beeps again, higher, and the following gap is now only 90 ms
    expect(beeps).toHaveLength(2)
    expect(beeps[1]).toBeGreaterThan(beeps[0])
    frame(600, -20)
    expect(beeps).toHaveLength(2)
    frame(640, -20)
    expect(beeps).toHaveLength(3)
    expect(sched.active.has(m.id)).toBe(true)
    frame(660, -70) // fell below the trigger: stops
    expect(sched.active.has(m.id)).toBe(false)
  })

  it('is silent when muted or not listening', () => {
    const s = new BookmarkStore()
    s.add(1000, { alarm: true })
    const sched = new AlarmScheduler()
    const beeps: number[] = []
    const base = { items: s.items, levelOf: () => ({ db: -10, hz: 0, peak: -10 }), ceilingDb: -20, now: 0, beep: (hz: number) => beeps.push(hz) }
    sched.update({ ...base, volume: 0, live: true })
    sched.update({ ...base, volume: 0.3, live: false })
    expect(beeps).toHaveLength(0)
  })
})

describe('TakeRecorder', () => {
  const source = (running = true) => {
    let push: (b: Float32Array, sr: number) => void = () => {}
    return {
      src: { running, onSamples: (fn: typeof push) => ((push = fn), () => void (push = () => {})) },
      feed: (b: Float32Array, sr = 1000) => push(b, sr),
    }
  }

  it('records samples into a take, and refuses to start when idle or full', () => {
    const rec = new TakeRecorder({ maxMs: 60000, maxTakes: 1 })
    expect(rec.start(source(false).src)).toBe(false)
    expect(rec.error).toBe('idle')
    const s = source()
    expect(rec.start(s.src)).toBe(true)
    s.feed(new Float32Array(500).fill(0.5)) // 0.5 s at 1 kHz
    const take = rec.stop()!
    expect(take.bytes).toBe(44 + 500 * 2)
    expect(take.ms).toBeCloseTo(500)
    expect(rec.start(s.src)).toBe(false)
    expect(rec.error).toBe('full')
    rec.remove(take.id)
    expect(rec.takes).toHaveLength(0)
  })

  it('discards takes under a quarter second and stops itself at the length cap', () => {
    const rec = new TakeRecorder({ maxMs: 1000, maxTakes: 5 })
    const s = source()
    rec.start(s.src)
    s.feed(new Float32Array(100)) // 0.1 s
    expect(rec.stop()).toBeNull()
    rec.start(s.src)
    s.feed(new Float32Array(1500)) // 1.5 s offered, 1 s allowed
    expect(rec.recording).toBe(false)
    expect(rec.takes[0].ms).toBeCloseTo(1000)
  })

  it('writes a valid mono 16-bit WAV header', async () => {
    const blob = wavBlob([Int16Array.of(1, -1)], 2, 8000)
    const v = new DataView(await blob.arrayBuffer())
    const tag = (at: number) => String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3))
    expect([tag(0), tag(8), tag(36)]).toEqual(['RIFF', 'WAVE', 'data'])
    expect(v.getUint32(24, true)).toBe(8000)
    expect(v.getUint32(40, true)).toBe(4)
    expect(v.getInt16(46, true)).toBe(-1)
  })
})
