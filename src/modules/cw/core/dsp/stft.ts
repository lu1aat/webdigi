import { fft } from './fft';

export interface SpectrogramOptions {
  /** Lowest/highest frequency kept in each row, Hz. */
  minFreq?: number;
  maxFreq?: number;
  /** Target bin spacing, Hz (rounded to a power-of-two FFT size). */
  binHz?: number;
  /** Rows per second. */
  rowRate?: number;
}

/**
 * Streaming short-time power spectrum. Each row is linear power (Hann window,
 * normalised so white noise of variance s^2 gives a mean bin value of ~s^2) for the bins
 * in [minFreq, maxFreq]. Rows overlap heavily, which is what makes keyed CW look smooth.
 */
export class Spectrogram {
  readonly size: number;
  readonly hop: number;
  readonly binHz: number;
  /** FFT bin index of the first kept bin. */
  readonly firstBin: number;
  readonly bins: number;
  readonly rowRate: number;
  private readonly win: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly ring: Float32Array;
  private pos = 0;
  private filled = 0;
  private sinceRow = 0;
  private readonly norm: number;

  constructor(readonly sampleRate: number, opts: SpectrogramOptions = {}) {
    const target = opts.binHz ?? 31;
    this.size = 2 ** Math.max(6, Math.round(Math.log2(sampleRate / target)));
    this.binHz = sampleRate / this.size;
    this.hop = Math.max(1, Math.round(sampleRate / (opts.rowRate ?? 400)));
    this.rowRate = sampleRate / this.hop;
    const minF = opts.minFreq ?? 200;
    const maxF = Math.min(opts.maxFreq ?? 4000, sampleRate / 2 - this.binHz);
    this.firstBin = Math.max(1, Math.floor(minF / this.binHz));
    this.bins = Math.max(1, Math.ceil(maxF / this.binHz) - this.firstBin + 1);
    this.win = new Float64Array(this.size).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.size));
    let w2 = 0;
    for (const w of this.win) w2 += w * w;
    this.norm = 1 / w2;
    this.re = new Float64Array(this.size);
    this.im = new Float64Array(this.size);
    this.ring = new Float32Array(this.size);
  }

  /** Frequency of kept bin `i`, Hz. */
  freqOf(i: number): number {
    return (this.firstBin + i) * this.binHz;
  }

  /** Feed samples; `onRow` is called with a *reused* Float32Array for every completed row. */
  process(x: Float32Array, onRow: (row: Float32Array) => void): void {
    const row = this.rowBuf ?? (this.rowBuf = new Float32Array(this.bins));
    for (let n = 0; n < x.length; n++) {
      this.ring[this.pos] = x[n];
      this.pos = (this.pos + 1) % this.size;
      if (this.filled < this.size) this.filled++;
      if (++this.sinceRow >= this.hop && this.filled === this.size) {
        this.sinceRow = 0;
        for (let i = 0; i < this.size; i++) {
          this.re[i] = this.ring[(this.pos + i) % this.size] * this.win[i];
          this.im[i] = 0;
        }
        fft(this.re, this.im);
        for (let k = 0; k < this.bins; k++) {
          const b = this.firstBin + k;
          row[k] = (this.re[b] * this.re[b] + this.im[b] * this.im[b]) * this.norm;
        }
        onRow(row);
      }
    }
  }

  private rowBuf: Float32Array | null = null;
}
