/**
 * Text -> keyed CW audio. DOM-free: used for TX and as the test signal source.
 * Keying uses raised-cosine edges (default 5 ms): hard keying splatters clicks
 * across the band, which matters to neighbours on a shared frequency.
 */
import { patternFor } from './morse'

export interface CwOptions {
  wpm: number
  freqHz: number
  amplitude?: number
  /** Edge rise/fall, seconds. */
  rampSec?: number
  /** Silence before and after, seconds. */
  padSec?: number
}

/** Key-down/up schedule in dot units: [on, units][] with alternating on/off. */
export function keyingFor(text: string): { on: boolean; units: number }[] {
  const out: { on: boolean; units: number }[] = []
  const push = (on: boolean, units: number) => {
    const last = out[out.length - 1]
    if (last && last.on === on) last.units += units
    else out.push({ on, units })
  }
  const words = text.toUpperCase().split(/\s+/).filter(Boolean)
  words.forEach((w, wi) => {
    if (wi) push(false, 7)
    const letters = [...w].map(patternFor).filter((p): p is string => !!p)
    letters.forEach((p, li) => {
      if (li) push(false, 3)
      ;[...p].forEach((e, ei) => {
        if (ei) push(false, 1)
        push(true, e === '.' ? 1 : 3)
      })
    })
  })
  return out
}

export function generateCw(text: string, sampleRate: number, o: CwOptions): Float32Array<ArrayBuffer> {
  const dot = 1.2 / o.wpm // seconds (PARIS standard)
  const amp = o.amplitude ?? 0.5
  const ramp = Math.max(1, Math.round((o.rampSec ?? 0.005) * sampleRate))
  const pad = Math.round((o.padSec ?? 0.3) * sampleRate)
  const sched = keyingFor(text)
  const total = pad * 2 + Math.ceil(sched.reduce((n, s) => n + s.units, 0) * dot * sampleRate) + ramp * 2
  // Envelope first (sample-accurate edges), then the carrier with continuous phase.
  const env = new Float32Array(total)
  let t = pad
  for (const s of sched) {
    const len = s.units * dot * sampleRate
    if (s.on) {
      const a = Math.round(t)
      const b = Math.round(t + len)
      for (let i = a; i < b && i < total; i++) {
        const up = Math.min(1, (i - a + 1) / ramp)
        const down = Math.min(1, (b - i) / ramp)
        env[i] = 0.5 - 0.5 * Math.cos(Math.PI * Math.min(up, down))
      }
    }
    t += len
  }
  const out = new Float32Array(total)
  const w = (2 * Math.PI * o.freqHz) / sampleRate
  for (let i = 0; i < total; i++) out[i] = Math.sin(w * i) * env[i] * amp
  return out
}
