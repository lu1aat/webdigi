/**
 * Manual recordings, ported from soundradar: press Record, hear it again, save it.
 * Audio is kept only in this tab's memory and only because the user asked for it: never stored
 * in the browser, never uploaded. Samples are kept as 16-bit chunks (about 5.8 MB a minute at
 * 48 kHz) and put together into a WAV blob only when the take ends, without copying them into
 * one array first. No DOM here, so it is unit-testable.
 */
export interface Take {
  id: number
  blob: Blob
  ms: number
  bytes: number
  wallStart: number
}

export interface Limits {
  /** Longest take; recording stops by itself here. */
  maxMs: number
  /** Record refuses past this rather than dropping the user's audio. */
  maxTakes: number
}
export const LIMITS: Limits = { maxMs: 10 * 60 * 1000, maxTakes: 5 }
const MIN_SECONDS = 0.25
/** Samples per stored chunk (128 KB): one allocation a second and a half instead of one per audio block. */
const CHUNK = 65536

/** Where raw samples come from (AudioEngine implements this). */
export interface SampleSource {
  readonly running: boolean
  onSamples(fn: (block: Float32Array, sampleRate: number) => void): () => void
}

let nextId = 1

export class TakeRecorder {
  takes: Take[] = []
  recording = false
  /** Why the last start() did not start, for the view to show. */
  error: '' | 'full' | 'idle' = ''
  private chunks: Int16Array[] = []
  private cur = new Int16Array(CHUNK)
  private curFill = 0
  private samples = 0
  private sampleRate = 0
  private wallStart = 0
  private off: (() => void) | null = null
  private subs = new Set<() => void>()

  constructor(readonly limits: Limits = LIMITS) {}

  subscribe(fn: () => void): () => void {
    this.subs.add(fn)
    return () => this.subs.delete(fn)
  }
  private notify() {
    this.subs.forEach((fn) => fn())
  }

  get full(): boolean {
    return this.takes.length >= this.limits.maxTakes
  }

  /** Length of the take in progress, counted from samples (so pauses never stretch it). */
  get elapsedMs(): number {
    return this.sampleRate ? (this.samples / this.sampleRate) * 1000 : 0
  }

  start(source: SampleSource): boolean {
    if (this.recording) return false
    this.error = this.full ? 'full' : !source.running ? 'idle' : ''
    if (this.error) {
      this.notify()
      return false
    }
    this.chunks = []
    this.cur = new Int16Array(CHUNK)
    this.curFill = 0
    this.samples = 0
    this.sampleRate = 0
    this.wallStart = Date.now()
    this.recording = true
    this.off = source.onSamples((block, sr) => this.push(block, sr))
    this.notify()
    return true
  }

  push(block: Float32Array, sampleRate: number): void {
    if (!this.recording) return
    this.sampleRate = sampleRate
    const room = Math.round((sampleRate * this.limits.maxMs) / 1000) - this.samples
    const n = Math.min(block.length, room)
    for (let i = 0; i < n; i++) {
      const v = Math.max(-1, Math.min(1, block[i]))
      this.cur[this.curFill++] = v < 0 ? v * 0x8000 : v * 0x7fff
      if (this.curFill === CHUNK) {
        this.chunks.push(this.cur)
        this.cur = new Int16Array(CHUNK)
        this.curFill = 0
      }
    }
    this.samples += n
    if (n < block.length) this.stop() // reached the cap
  }

  /** End the take and keep it. Returns it, or null when it was too short to keep. */
  stop(): Take | null {
    if (!this.recording) return null
    this.recording = false
    this.off?.()
    this.off = null
    let take: Take | null = null
    if (this.sampleRate && this.samples >= this.sampleRate * MIN_SECONDS) {
      const blob = wavBlob([...this.chunks, this.cur.subarray(0, this.curFill)], this.samples, this.sampleRate)
      take = { id: nextId++, blob, ms: this.elapsedMs, bytes: blob.size, wallStart: this.wallStart }
      this.takes.push(take)
    }
    this.chunks = []
    this.cur = new Int16Array(0)
    this.curFill = 0
    this.samples = 0
    this.notify()
    return take
  }

  remove(id: number): void {
    const i = this.takes.findIndex((t) => t.id === id)
    if (i < 0) return
    this.takes.splice(i, 1)
    this.error = ''
    this.notify()
  }
}

/** 16-bit mono PCM chunks to a WAV blob; the chunks are referenced, not copied. */
export function wavBlob(chunks: Int16Array[], samples: number, sampleRate: number): Blob {
  const head = new DataView(new ArrayBuffer(44))
  const str = (at: number, s: string) => [...s].forEach((c, i) => head.setUint8(at + i, c.charCodeAt(0)))
  str(0, 'RIFF')
  head.setUint32(4, 36 + samples * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  head.setUint32(16, 16, true)
  head.setUint16(20, 1, true) // PCM
  head.setUint16(22, 1, true) // mono
  head.setUint32(24, sampleRate, true)
  head.setUint32(28, sampleRate * 2, true)
  head.setUint16(32, 2, true)
  head.setUint16(34, 16, true)
  str(36, 'data')
  head.setUint32(40, samples * 2, true)
  return new Blob([head.buffer, ...(chunks as BlobPart[])], { type: 'audio/wav' })
}
