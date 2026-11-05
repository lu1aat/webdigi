import tapUrl from './tap.worklet.ts?worker&url'
import type { Bus } from '../bus'

/** A pipeline stage inserted between the input and the analyser/tap. */
export interface PipelineStage {
  id: string
  /** Lower runs first. */
  order: number
  create(ctx: AudioContext): { input: AudioNode; output: AudioNode; dispose?(): void }
}

export type SampleListener = (block: Float32Array, sampleRate: number) => void

/**
 * One shared AudioContext. Chain: input -> stages (by order) -> analyser
 *                                                          \-> tap worklet -> onSamples
 * The input is never routed to the speakers.
 */
export class AudioEngine {
  ctx: AudioContext | null = null
  analyser: AnalyserNode | null = null
  private stream: MediaStream | null = null
  private stages: PipelineStage[] = []
  private live: { input: AudioNode; output: AudioNode; dispose?(): void }[] = []
  private source: MediaStreamAudioSourceNode | null = null
  private tap: AudioWorkletNode | null = null
  private sink: GainNode | null = null
  private listeners = new Set<SampleListener>()

  constructor(private bus: Bus, public fftSize = 4096) {}

  get running(): boolean {
    return !!this.stream
  }
  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000
  }

  addStage(s: PipelineStage): void {
    this.stages.push(s)
    this.stages.sort((a, b) => a.order - b.order)
    if (this.running) this.rewire()
  }

  private spec = new Float32Array(0)
  private specAt = -Infinity

  /**
   * Current spectrum in dB (one value per FFT bin), or null when not listening.
   * Every module should read it here: the analyser is pulled at most once per frame,
   * so views never double-smooth the signal. Treat the array as read-only.
   */
  spectrum(): Float32Array | null {
    const a = this.analyser
    if (!this.stream || !a) return null
    const now = performance.now()
    if (now - this.specAt > 4) {
      if (this.spec.length !== a.frequencyBinCount) this.spec = new Float32Array(a.frequencyBinCount)
      a.getFloatFrequencyData(this.spec)
      this.specAt = now
    }
    return this.spec
  }

  private td = new Float32Array(0)
  private tdAt = -Infinity
  private lvl = { rmsDb: -Infinity, peakDb: -Infinity }

  /**
   * Input level in dBFS (RMS and sample peak over the last FFT window), or null when not
   * listening. Measured after the pipeline stages, i.e. on the signal the views analyse.
   * Read at most once per frame, like spectrum().
   */
  level(): { rmsDb: number; peakDb: number } | null {
    const a = this.analyser
    if (!this.stream || !a) return null
    const now = performance.now()
    if (now - this.tdAt > 4) {
      if (this.td.length !== a.fftSize) this.td = new Float32Array(a.fftSize)
      a.getFloatTimeDomainData(this.td)
      let peak = 0
      let sum = 0
      for (const x of this.td) {
        peak = Math.max(peak, Math.abs(x))
        sum += x * x
      }
      this.lvl = { rmsDb: 20 * Math.log10(Math.sqrt(sum / this.td.length)), peakDb: 20 * Math.log10(peak) }
      this.tdAt = now
    }
    return this.lvl
  }

  onSamples(fn: SampleListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Label and negotiated settings of the live input track, or null when stopped. */
  get inputInfo(): { label: string; settings: MediaTrackSettings } | null {
    const track = this.stream?.getAudioTracks()[0]
    return track ? { label: track.label, settings: track.getSettings() } : null
  }

  async listInputs(): Promise<MediaDeviceInfo[]> {
    const all = await navigator.mediaDevices.enumerateDevices()
    return all.filter((d) => d.kind === 'audioinput')
  }

  async start(deviceId?: string): Promise<void> {
    await this.stop()
    // mediaDevices is undefined outside secure contexts (HTTP on a LAN host).
    if (!navigator.mediaDevices) throw new DOMException('Audio capture needs HTTPS or localhost', 'SecurityError')
    // Processing off: we want the raw signal, not speech-tuned audio.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    })
    this.ctx ??= new AudioContext()
    if (this.ctx.state === 'suspended') await this.ctx.resume()
    if (!this.analyser) {
      this.analyser = this.ctx.createAnalyser()
      this.analyser.smoothingTimeConstant = 0
    }
    this.analyser.fftSize = this.fftSize
    if (!this.tap) {
      await this.ctx.audioWorklet.addModule(tapUrl)
      this.tap = new AudioWorkletNode(this.ctx, 'tap')
      this.tap.port.onmessage = (e: MessageEvent<Float32Array>) => this.listeners.forEach((fn) => fn(e.data, this.sampleRate))
      // Worklets only run while connected to the destination; mute so nothing is audible.
      this.sink = this.ctx.createGain()
      this.sink.gain.value = 0
      this.tap.connect(this.sink).connect(this.ctx.destination)
    }
    this.source = this.ctx.createMediaStreamSource(this.stream)
    this.rewire()
    this.bus.emit('audio:state', { running: true })
  }

  async stop(): Promise<void> {
    if (!this.stream) return
    this.stream.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.source?.disconnect()
    this.source = null
    this.teardown()
    this.bus.emit('audio:state', { running: false })
  }

  setFftSize(n: number): void {
    this.fftSize = n
    if (this.analyser) this.analyser.fftSize = n
  }

  private teardown(): void {
    this.live.forEach((l) => {
      l.output.disconnect()
      l.dispose?.()
    })
    this.live = []
    this.source?.disconnect()
  }

  private rewire(): void {
    if (!this.ctx || !this.source || !this.analyser || !this.tap) return
    this.teardown()
    this.live = this.stages.map((s) => s.create(this.ctx!))
    let prev: AudioNode = this.source
    for (const l of this.live) {
      prev.connect(l.input)
      prev = l.output
    }
    prev.connect(this.analyser)
    prev.connect(this.tap)
  }
}
