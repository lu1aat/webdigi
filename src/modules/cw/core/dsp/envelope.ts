/**
 * Narrowband envelope extractor for one CW carrier.
 *
 * Mixes the real input down to complex baseband at `freq`, low-passes I and Q with
 * four cascaded one-pole filters (~`bandwidth` Hz wide), then emits |I+jQ| decimated
 * to `envRate`. DOM-free so it can run in a worklet, a worker or a test.
 */
export class EnvelopeDetector {
  readonly envRate: number;
  private readonly decim: number;
  private alpha: number;
  private dPhase: number;
  private phase = 0;
  private readonly sI = new Float64Array(4);
  private readonly sQ = new Float64Array(4);
  private count = 0;
  private currentFreq: number;

  constructor(
    readonly sampleRate: number,
    readonly freq: number,
    readonly bandwidth = 120,
    envRate = 400,
  ) {
    this.decim = Math.max(1, Math.round(sampleRate / envRate));
    this.envRate = sampleRate / this.decim;
    // 4 cascaded poles narrow the -3 dB point by ~2.2x, so compensate
    this.alpha = this.alphaFor(bandwidth);
    this.dPhase = (2 * Math.PI * freq) / sampleRate;
    this.currentFreq = freq;
  }

  private alphaFor(bandwidth: number): number {
    return 1 - Math.exp((-2 * Math.PI * (bandwidth / 2 / 0.435)) / this.sampleRate);
  }

  /** Retune the carrier on the fly (phase is continuous, so small drifts cost nothing). */
  setFrequency(freq: number): void {
    this.dPhase = (2 * Math.PI * freq) / this.sampleRate;
    this.currentFreq = freq;
  }

  get tunedFreq(): number {
    return this.currentFreq;
  }

  /** Change the filter width on the fly (filter state is kept). */
  setBandwidth(bandwidth: number): void {
    this.alpha = this.alphaFor(bandwidth);
  }

  /** Feed real samples; returns envelope samples at `envRate`. */
  process(x: Float32Array): Float32Array {
    const out = new Float32Array(Math.floor((this.count + x.length) / this.decim));
    let o = 0;
    for (let n = 0; n < x.length; n++) {
      const c = Math.cos(this.phase);
      const s = -Math.sin(this.phase);
      this.phase += this.dPhase;
      if (this.phase > Math.PI * 2) this.phase -= Math.PI * 2;
      let i = x[n] * c;
      let q = x[n] * s;
      for (let k = 0; k < 4; k++) {
        this.sI[k] += this.alpha * (i - this.sI[k]);
        this.sQ[k] += this.alpha * (q - this.sQ[k]);
        i = this.sI[k];
        q = this.sQ[k];
      }
      if (++this.count % this.decim === 0) out[o++] = 2 * Math.hypot(i, q);
    }
    return out.subarray(0, o);
  }
}
