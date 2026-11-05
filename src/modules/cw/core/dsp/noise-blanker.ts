/**
 * Impulse noise blanker (static crashes, power-line noise).
 *
 * A sample is blanked only if it is far above the running average level *and* the
 * next few samples are not: a real signal onset stays high, an impulse does not.
 * That look-ahead is why the output is delayed by `delay` samples.
 */
export class NoiseBlanker {
  readonly delay: number;
  private readonly buf: Float32Array;
  private pos = 0;
  private avg = 0;
  private readonly rate: number;
  private blankLeft = 0;

  constructor(sampleRate: number, private readonly threshold = 6, lookaheadSeconds = 0.001) {
    this.delay = Math.max(4, Math.round(sampleRate * lookaheadSeconds));
    this.buf = new Float32Array(this.delay + 1);
    this.rate = 1 / (0.1 * sampleRate);
  }

  process(x: Float32Array): Float32Array {
    const out = new Float32Array(x.length);
    const len = this.buf.length;
    for (let n = 0; n < x.length; n++) {
      this.buf[this.pos] = x[n];
      const head = (this.pos + 1) % len; // oldest sample
      const y = this.buf[head];
      this.pos = head;
      const lim = this.threshold * this.avg;
      let blank = this.blankLeft > 0;
      if (blank) this.blankLeft--;
      else if (this.avg > 0 && Math.abs(y) > lim) {
        let ahead = 0;
        for (let i = 1; i < len; i++) ahead = Math.max(ahead, Math.abs(this.buf[(head + i) % len]));
        if (ahead < lim) { blank = true; this.blankLeft = 1; }
      }
      if (blank) out[n] = 0;
      else {
        out[n] = y;
        this.avg += this.rate * (Math.abs(y) - this.avg);
      }
    }
    return out;
  }
}
