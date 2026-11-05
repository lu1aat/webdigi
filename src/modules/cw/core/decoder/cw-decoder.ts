import { patternToChar } from '../morse';

export interface DecodedChar {
  /** Decoded character, ' ' for a word gap, '?' for an unknown pattern. */
  char: string;
  /** 0..1 posterior confidence that this character is right. */
  confidence: number;
  /** Time of the end of the character, seconds from the start of the stream. */
  time: number;
  /** Estimated speed when the character was decoded. */
  wpm: number;
  /** Length in seconds of the silence that ended this character (Infinity at end of stream). */
  gapAfter?: number;
  /** Posterior that the silence after this character was a word gap. */
  pWordAfter?: number;
}

export interface CwDecoderOptions {
  /** Window used to place the key-up/key-down threshold, seconds. */
  windowSeconds?: number;
  /** 'otsu' splits the envelope histogram; 'relative' puts the threshold a fraction of the way between floor and peak percentiles. */
  threshold?: 'otsu' | 'relative';
  /** For 'relative': 0..1 position between floor (15th percentile) and peak (97th). */
  relativeFraction?: number;
  /** Adapt dash/gap ratios to the sender (default true); false keeps the textbook 1:3:7. */
  adaptRatios?: boolean;
}

interface Interval {
  mark: boolean;
  seconds: number;
}

const LOG_SIGMA_MARK = 0.28;
const LOG_SIGMA_GAP = 0.34;
const LN3 = Math.log(3);
const LN7 = Math.log(7);
/** Adaptation rate and bounds for the per-station timing ratios (hand keys are far from 1:3:7). */
const RATIO_RATE = 0.06;
const DASH_BOUNDS: [number, number] = [Math.log(2.4), Math.log(4.6)];
const CHAR_BOUNDS: [number, number] = [Math.log(2), Math.log(5)];
const WORD_BOUNDS: [number, number] = [Math.log(5), Math.log(10)];
const clamp = (v: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, v));
/** Intervals to collect before the first speed estimate; also suppresses lone noise blips. */
const WARMUP_INTERVALS = 8;

function logNormal(x: number, mu: number, sigma: number): number {
  const z = (x - mu) / sigma;
  return -0.5 * z * z - Math.log(sigma);
}

/** Posterior over classes given log-likelihoods and log-priors. */
function posterior(ll: number[]): number[] {
  const m = Math.max(...ll);
  const e = ll.map((v) => Math.exp(v - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}

/**
 * Streaming single-carrier CW decoder.
 *
 * Stages: adaptive two-level threshold (Otsu over a sliding window) -> debounced
 * keying -> intervals -> Bayesian classification. Marks are dot/dash and gaps are
 * element/letter/word, each scored with a log-normal likelihood around 1T/3T/7T where
 * the dot length T is itself estimated by maximum marginal likelihood over a recent
 * window of intervals. Per-character confidence is the product of the class posteriors.
 */
export class CwDecoder {
  private time = 0; // seconds of envelope consumed
  private readonly window: Float32Array;
  private winPos = 0;
  private winFill = 0;
  private sinceThreshold = 0;
  private lo = 0; // threshold levels
  private hi = Infinity;
  private gateOpen = false;

  private keyed = false;
  private stateSince = 0;
  private pendingFlipAt = -1; // time of first sample on the other side of the threshold

  private logT = Math.log(0.06);
  // log of dash/dot, letter-gap/dot, word-gap/dot; adapted to the sender's fist
  private dashOff = LN3;
  private charOff = LN3;
  private wordOff = LN7;
  private gapAfter = Infinity;
  private pWordAfter = 0;
  private recent: Interval[] = [];
  private warmed = false;
  private pattern = '';
  private patternConf = 1;
  private out: DecodedChar[] = [];

  private readonly opts: Required<Omit<CwDecoderOptions, 'windowSeconds'>>;

  constructor(readonly envRate: number, options: CwDecoderOptions | number = {}) {
    const o = typeof options === 'number' ? { windowSeconds: options } : options;
    this.opts = {
      threshold: o.threshold ?? 'otsu',
      relativeFraction: o.relativeFraction ?? 0.5,
      adaptRatios: o.adaptRatios ?? true,
    };
    this.window = new Float32Array(Math.round(envRate * (o.windowSeconds ?? 8)));
  }

  /** True once enough intervals were seen for a speed estimate. */
  get ready(): boolean {
    return this.warmed;
  }

  get wpm(): number {
    return 1.2 / Math.exp(this.logT);
  }

  /** Fit the threshold on a chunk of envelope without decoding it (offline warm-up). */
  prime(env: Float32Array): void {
    for (const v of env) this.pushWindow(v);
    this.fitThreshold();
  }

  /** Consume envelope samples; returns characters completed by this chunk. */
  process(env: Float32Array): DecodedChar[] {
    this.out = [];
    const dt = 1 / this.envRate;
    for (const v of env) {
      this.pushWindow(v);
      if (++this.sinceThreshold >= Math.round(this.envRate * 0.25)) this.fitThreshold();
      this.time += dt;
      this.step(v);
    }
    return this.out;
  }

  /** Call at end of stream: closes the open interval and flushes the last character. */
  flush(): DecodedChar[] {
    this.out = [];
    if (this.keyed) this.endInterval(true);
    if (this.warmed) this.emitCharacter(this.time + 1);
    return this.out;
  }

  // --- thresholding -------------------------------------------------------

  private pushWindow(v: number): void {
    this.window[this.winPos] = v;
    this.winPos = (this.winPos + 1) % this.window.length;
    if (this.winFill < this.window.length) this.winFill++;
  }

  /** Otsu's method on a 64-bin histogram of the sliding window. */
  private fitThreshold(): void {
    this.sinceThreshold = 0;
    const n = this.winFill;
    if (n < this.envRate) return;
    let max = 0;
    for (let i = 0; i < n; i++) if (this.window[i] > max) max = this.window[i];
    if (max <= 0) return;
    const BINS = 64;
    const hist = new Float64Array(BINS);
    for (let i = 0; i < n; i++) hist[Math.min(BINS - 1, Math.floor((this.window[i] / max) * BINS))]++;
    let sumAll = 0;
    for (let b = 0; b < BINS; b++) sumAll += b * hist[b];
    let w0 = 0;
    let sum0 = 0;
    let bestVar = -1;
    let bestBin = 0;
    for (let b = 0; b < BINS - 1; b++) {
      w0 += hist[b];
      sum0 += b * hist[b];
      const w1 = n - w0;
      if (w0 === 0 || w1 === 0) continue;
      const m0 = sum0 / w0;
      const m1 = (sumAll - sum0) / w1;
      const v = w0 * w1 * (m0 - m1) * (m0 - m1);
      if (v > bestVar) { bestVar = v; bestBin = b; }
    }
    // class means for gating and hysteresis
    let s0 = 0, c0 = 0, s1 = 0, c1 = 0;
    for (let i = 0; i < n; i++) {
      if (Math.min(BINS - 1, Math.floor((this.window[i] / max) * BINS)) <= bestBin) { s0 += this.window[i]; c0++; }
      else { s1 += this.window[i]; c1++; }
    }
    if (!c0 || !c1) { this.gateOpen = false; return; }
    const m0 = s0 / c0;
    const m1 = s1 / c1;
    // Require a clear two-level signal: strong contrast and a plausible keying duty cycle.
    this.gateOpen = m1 > 2.5 * m0 && c1 / n > 0.03 && c1 / n < 0.8;
    let mid = (bestBin + 1) / BINS * max;
    if (this.opts.threshold === 'relative') {
      const sorted = Float32Array.from(this.window.subarray(0, n)).sort();
      const floor = sorted[Math.floor(0.15 * (n - 1))];
      const peak = sorted[Math.floor(0.97 * (n - 1))];
      mid = floor + this.opts.relativeFraction * (peak - floor);
    }
    const h = 0.08 * (m1 - m0);
    this.lo = mid - h;
    this.hi = mid + h;
  }

  // --- keying state machine ----------------------------------------------

  private debounceSeconds(): number {
    return Math.min(0.025, Math.max(0.006, 0.3 * Math.exp(this.logT)));
  }

  /** Key-up shorter than this is a fading dip inside a mark, not a gap (the shortest real gap is about one dot). */
  private dipSeconds(): number {
    return Math.min(0.03, Math.max(this.debounceSeconds(), 0.4 * Math.exp(this.logT)));
  }

  private step(v: number): void {
    if (!this.gateOpen) {
      if (this.keyed) this.endInterval(false);
      return;
    }
    const target = this.keyed ? v > this.lo : v >= this.hi; // hysteresis
    if (target === this.keyed) {
      this.pendingFlipAt = -1;
      return;
    }
    if (this.pendingFlipAt < 0) this.pendingFlipAt = this.time;
    if (this.time - this.pendingFlipAt >= (this.keyed ? this.dipSeconds() : this.debounceSeconds())) {
      this.flip(this.pendingFlipAt);
      this.pendingFlipAt = -1;
    }
  }

  private flip(at: number): void {
    const seconds = at - this.stateSince;
    if (this.stateSince > 0 || this.keyed) this.addInterval({ mark: this.keyed, seconds });
    this.keyed = !this.keyed;
    this.stateSince = at;
  }

  /** Close the open interval at the current time (gate closed or end of stream). */
  private endInterval(flushing: boolean): void {
    if (this.keyed) {
      this.addInterval({ mark: true, seconds: this.time - this.stateSince });
      this.keyed = false;
    }
    this.stateSince = this.time;
    this.pendingFlipAt = -1;
    if (!flushing) this.emitCharacter(this.time);
  }

  // --- classification -----------------------------------------------------

  private addInterval(iv: Interval): void {
    if (iv.mark === false && this.recent.length === 0) return; // leading silence
    this.recent.push(iv);
    if (this.recent.length > 40) this.recent.shift();
    if (!this.warmed) {
      // Hold the first intervals until T can be estimated from them, then replay.
      if (this.recent.length < WARMUP_INTERVALS) return;
      this.estimateT(true);
      this.warmed = true;
      for (const held of this.recent) this.classify(held);
      return;
    }
    this.estimateT(false);
    this.classify(iv);
  }

  private classify(iv: Interval): void {
    const lx = Math.log(iv.seconds);
    if (iv.mark) {
      const ll = [
        logNormal(lx, this.logT, LOG_SIGMA_MARK) + Math.log(0.6),
        logNormal(lx, this.logT + this.dashOff, LOG_SIGMA_MARK) + Math.log(0.4),
      ];
      const p = posterior(ll);
      const dash = p[1] > p[0];
      if (this.opts.adaptRatios && Math.max(p[0], p[1]) > 0.9 && dash) this.dashOff = clamp(this.dashOff + RATIO_RATE * (lx - this.logT - this.dashOff), DASH_BOUNDS);
      this.pattern += dash ? '-' : '.';
      this.patternConf *= Math.max(p[0], p[1]);
    } else {
      const p = posterior([
        logNormal(lx, this.logT, LOG_SIGMA_GAP) + Math.log(0.55),
        logNormal(lx, this.logT + this.charOff, LOG_SIGMA_GAP) + Math.log(0.35),
        logNormal(lx, this.logT + this.wordOff, LOG_SIGMA_GAP * 1.4) + Math.log(0.10),
      ]);
      const k = p.indexOf(Math.max(...p));
      if (this.opts.adaptRatios && p[k] > 0.8) {
        if (k === 1) this.charOff = clamp(this.charOff + RATIO_RATE * (lx - this.logT - this.charOff), CHAR_BOUNDS);
        if (k === 2) this.wordOff = clamp(this.wordOff + RATIO_RATE * (lx - this.logT - this.wordOff), WORD_BOUNDS);
        this.wordOff = Math.max(this.wordOff, this.charOff + Math.log(1.4));
      }
      if (k >= 1) {
        this.gapAfter = iv.seconds;
        this.pWordAfter = p[2];
        const conf = this.emitCharacter(this.time);
        if (k === 2 && conf !== null) this.push(' ', p[2], this.time);
      }
    }
  }

  private emitCharacter(at: number): number | null {
    if (!this.pattern) return null;
    const ch = patternToChar(this.pattern);
    const conf = ch ? this.patternConf : 0;
    this.push(ch ?? '?', conf, at);
    this.gapAfter = Infinity;
    this.pWordAfter = 0;
    this.pattern = '';
    this.patternConf = 1;
    return conf;
  }

  private push(char: string, confidence: number, time: number): void {
    this.out.push({ char, confidence, time, wpm: this.wpm, gapAfter: this.gapAfter, pWordAfter: this.pWordAfter });
  }

  /**
   * Maximum marginal likelihood estimate of log T over the recent intervals, searched on
   * a log grid, then blended with the previous value so one odd interval can't jerk it.
   */
  private estimateT(initial: boolean): void {
    const iv = this.recent;
    let bestLogT = this.logT;
    let bestScore = -Infinity;
    const lo = Math.log(1.2 / 50);
    const hi = Math.log(1.2 / 5);
    for (let g = 0; g <= 120; g++) {
      const lt = lo + ((hi - lo) * g) / 120;
      let score = 0;
      for (const x of iv) {
        const lx = Math.log(x.seconds);
        if (x.mark) {
          score += Math.max(logNormal(lx, lt, LOG_SIGMA_MARK), logNormal(lx, lt + this.dashOff, LOG_SIGMA_MARK));
        } else {
          score += Math.max(
            logNormal(lx, lt, LOG_SIGMA_GAP),
            logNormal(lx, lt + this.charOff, LOG_SIGMA_GAP),
            logNormal(lx, lt + this.wordOff, LOG_SIGMA_GAP * 1.4),
          );
        }
      }
      if (score > bestScore) { bestScore = score; bestLogT = lt; }
    }
    const k = initial ? 1 : 0.25;
    this.logT += k * (bestLogT - this.logT);
  }
}
