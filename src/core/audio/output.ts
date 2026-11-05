/** Thrown by `transmit` when another transmission (possibly from another module) is in progress. */
export class TxBusyError extends Error {
  constructor(public readonly owner: string) {
    super(`${owner} is transmitting`)
  }
}

/** Transmit side: tone generator and WAV/buffer playback to the speakers. */
export class AudioOutput {
  /** Module id holding the transmit lock, or null. Only one module may transmit at a time. */
  private txOwner: string | null = null
  /** Called whenever the lock is taken or released (main.ts publishes it on the bus). */
  onTx: (owner: string | null) => void = () => {}

  /** Highest frequency (Hz) the output device can reproduce: half the output context's sample rate. */
  get nyquist(): number {
    return this.ac.sampleRate / 2
  }

  get transmitting(): string | null {
    return this.txOwner
  }

  private ctx: AudioContext | null = null

  constructor() {
    // Browsers keep new contexts suspended until a user gesture; resume on the first one
    // so alarms and tones can sound later without a click.
    if (typeof document !== 'undefined') document.addEventListener('pointerdown', () => void this.ac.resume(), { once: true })
  }

  private get ac(): AudioContext {
    return (this.ctx ??= new AudioContext())
  }

  /** False in browsers without AudioContext.setSinkId (Firefox, Safari): only the system default is available. */
  get canSelectDevice(): boolean {
    return 'setSinkId' in AudioContext.prototype
  }

  /** Route output to a specific device where the browser supports setSinkId. */
  async setDevice(deviceId: string): Promise<void> {
    const c = this.ac as AudioContext & { setSinkId?: (id: string) => Promise<void> }
    await c.setSinkId?.(deviceId)
  }

  /** One short pip that does not block (alarms). Silent until the first user gesture has resumed the context. */
  beep(hz: number, volume: number, seconds = 0.075): void {
    const ac = this.ac
    if (ac.state !== 'running') return void ac.resume()
    const osc = ac.createOscillator()
    const g = ac.createGain()
    const t0 = ac.currentTime
    osc.type = 'sine'
    osc.frequency.setValueAtTime(hz, t0)
    // Ramped, not switched: a square-edged gate on a sine clicks.
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), t0 + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + seconds)
    osc.connect(g).connect(ac.destination)
    osc.start(t0)
    osc.stop(t0 + seconds + 0.02)
    osc.onended = () => {
      osc.disconnect()
      g.disconnect()
    }
  }

  /** Play a sine tone; resolves when it ends. Short fades avoid clicks. */
  async tone(hz: number, seconds: number, gain = 0.3): Promise<void> {
    const ac = this.ac
    await ac.resume()
    const osc = ac.createOscillator()
    const g = ac.createGain()
    const t0 = ac.currentTime
    osc.frequency.value = hz
    g.gain.setValueAtTime(0, t0)
    g.gain.linearRampToValueAtTime(gain, t0 + 0.01)
    g.gain.setValueAtTime(gain, t0 + seconds - 0.01)
    g.gain.linearRampToValueAtTime(0, t0 + seconds)
    osc.connect(g).connect(ac.destination)
    osc.start(t0)
    osc.stop(t0 + seconds)
    await new Promise<void>((r) => (osc.onended = () => r()))
  }

  /**
   * Send `samples` to the output as a transmission owned by `owner` (a module id).
   * Takes the transmit lock for the whole duration, so two modules can never key the rig at once;
   * throws TxBusyError if it is already held. The lock is released when playback ends, on
   * `stopAll()`, on an error, or by a watchdog if the browser never starts or finishes the audio
   * (autoplay blocked, output device gone), so a stuck transmission cannot lock the app forever.
   */
  async transmit(owner: string, samples: Float32Array<ArrayBuffer>, sampleRate: number): Promise<void> {
    if (this.txOwner) throw new TxBusyError(this.txOwner)
    this.txOwner = owner
    this.onTx(owner)
    const seconds = samples.length / sampleRate
    let timer: ReturnType<typeof setTimeout> | undefined
    const fail = (ms: number, msg: string) =>
      new Promise<never>((_, reject) => {
        clearTimeout(timer)
        timer = setTimeout(() => (this.stopAll(), reject(new Error(msg))), ms)
      })
    try {
      const ac = this.ac
      await Promise.race([ac.resume(), fail(3000, 'the browser blocked audio output (click the page, then retry)')])
      const buf = ac.createBuffer(1, samples.length, sampleRate)
      buf.copyToChannel(samples, 0)
      const src = ac.createBufferSource()
      src.buffer = buf
      src.connect(ac.destination)
      this.playing.add(src)
      const ended = new Promise<void>((r) => (src.onended = () => (this.playing.delete(src), r())))
      src.start()
      await Promise.race([ended, fail((seconds + 2) * 1000, 'playback did not finish')])
    } finally {
      clearTimeout(timer)
      this.txOwner = null
      this.onTx(null)
    }
  }

  private playing = new Set<AudioBufferSourceNode>()

  /** Stop every buffer started by playBuffer/playSamples/playFile (their promises resolve). */
  stopAll(): void {
    this.playing.forEach((s) => s.stop())
  }

  async playBuffer(buf: AudioBuffer): Promise<void> {
    const ac = this.ac
    await ac.resume()
    const src = ac.createBufferSource()
    src.buffer = buf
    src.connect(ac.destination)
    this.playing.add(src)
    src.start()
    await new Promise<void>((r) => (src.onended = () => (this.playing.delete(src), r())))
  }

  /** Decode and play a WAV (or any browser-decodable) file. */
  async playFile(data: ArrayBuffer): Promise<void> {
    return this.playBuffer(await this.ac.decodeAudioData(data))
  }

  /** Play raw mono samples (what an encoder module produces). */
  async playSamples(samples: Float32Array<ArrayBuffer>, sampleRate: number): Promise<void> {
    const buf = this.ac.createBuffer(1, samples.length, sampleRate)
    buf.copyToChannel(samples, 0)
    return this.playBuffer(buf)
  }
}
