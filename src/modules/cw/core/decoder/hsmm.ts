import { patternToChar } from '../morse';
import { EnvelopeDetector } from '../dsp/envelope';
import type { DecodedChar } from './cw-decoder';

/**
 * A second, architecturally different CW decoder: joint segmentation of the raw envelope.
 *
 * The threshold decoder first makes a hard key-up/key-down decision per sample and only then
 * looks at durations, so a weak 20 ms dot that dips under the threshold is gone for good. This
 * one never thresholds. It runs a hidden semi-Markov model (Viterbi with explicit durations)
 * over the whole envelope: every candidate segment is scored by how well its samples fit
 * "carrier present" (Rician) or "noise only" (Rayleigh) *and* by how plausible its length is for
 * its class (dot, dash, element gap, letter gap, word gap). Speed and the sender's fist
 * (dash and gap ratios) are chosen by maximum likelihood over a small grid. Evidence for a short
 * element is summed over its duration, so a weak dot still counts.
 *
 * Offline: it needs the whole stretch of audio, which is what the council works on.
 */

type Cls = 0 | 1 | 2 | 3 | 4 | 5; // dot, dash, intra gap, letter gap, word gap, idle (long silence)
const DASH = 1, LETTER = 3, WORD = 4, IDLE = 5;
const isMark = (c: number) => c <= DASH;

/** Log-likelihood a key-down must earn from its own samples before it beats "nothing here": stops noise from being read as dots. */
const MARK_COST = 3;
const LLR_SCALE = 0.3;
/** Per-sample carrier evidence (cap 8*LLR_SCALE = 2.4) a letter needs: real letters measured 1.5-2.4, noise-only "letters" 0.2-1.4. */
const MIN_EVIDENCE = 1.45;
const GATE_FRACTION = 0.55;
const SIGMA_MARK = 0.3;
const SIGMA_GAP = 0.36;
const LOG_PRIOR = [Math.log(0.6), Math.log(0.4), Math.log(0.5), Math.log(0.35), Math.log(0.12), Math.log(0.03)];

function lnI0(z: number): number {
  if (z < 3) { const q = z * z / 4; return Math.log(1 + q * (1 + q / 4 * (1 + q / 9))); }
  return z - 0.5 * Math.log(2 * Math.PI * z) + Math.log(1 + 1 / (8 * z));
}

/** Value at fraction p of the sorted samples env[a..b). */
function quantile(env: Float32Array, a: number, b: number, p: number): number {
  const w = Float32Array.from(env.subarray(a, b)).sort();
  return w[Math.min(w.length - 1, Math.floor(p * (w.length - 1)))];
}

/**
 * Per-sample log-likelihood ratio (carrier present vs noise only). The noise level is stable, so
 * it is measured over a long window; the carrier level fades (QSB, AGC), so it is tracked over a
 * short one that still contains several key-downs.
 */
function llr(env: Float32Array, rate: number, win: number, q: number, floorFraction: number): Float64Array {
  const n = env.length;
  const halfNoise = Math.round(rate * 2.5);
  const halfSig = Math.round(rate * win);
  const out = new Float64Array(n);
  const step = Math.max(1, Math.round(rate * 0.1));
  let A = 0, sigma = 1;
  for (let i = 0; i < n; i++) {
    if (i % step === 0) {
      // lower quartile of a window that is ~40% carrier ~ the 42nd percentile of the noise-only Rayleigh
      sigma = Math.max(1e-9, quantile(env, Math.max(0, i - halfNoise), Math.min(n, i + halfNoise), 0.25) / Math.sqrt(2 * Math.log(1 / (1 - 0.42))));
      // never let the carrier model drop below ~half the long-term level: in a silent stretch the short window only sees noise peaks
      const aLong = quantile(env, Math.max(0, i - halfNoise), Math.min(n, i + halfNoise), 0.96);
      A = Math.max(quantile(env, Math.max(0, i - halfSig), Math.min(n, i + halfSig), q), floorFraction * aLong, 2.5 * sigma);
    }
    const s2 = sigma * sigma;
    // neighbouring envelope samples are correlated (narrow filter), so they carry less than one independent observation each
    out[i] = LLR_SCALE * Math.max(-8, Math.min(8, -(A * A) / (2 * s2) + lnI0((env[i] * A) / s2)));
  }
  return out;
}

interface Seg { cls: Cls; start: number; end: number }

/** Scratch buffers reused between Viterbi runs (the grid search runs it a dozen times). */
interface Scratch { best: Float64Array; from: Int32Array; markBest: Float64Array; markArg: Int8Array; downBest: Float64Array; downArg: Int8Array; n: number }
function scratch(n: number, cache?: Scratch): Scratch {
  if (cache && cache.n === n) return cache;
  return {
    n,
    best: new Float64Array((n + 1) * 6),
    from: new Int32Array((n + 1) * 6),
    markBest: new Float64Array(n + 1),
    markArg: new Int8Array(n + 1),
    downBest: new Float64Array(n + 1),
    downArg: new Int8Array(n + 1),
  };
}

function viterbi(
  prefix: Float64Array, // prefix[i] = sum of llr[0..i)
  n: number,
  rate: number,
  logT: number,
  dashOff: number,
  letterOff: number,
  wordOff: number,
  buf: Scratch,
): { score: number; segs: Seg[] } {
  const mu = [logT, logT + dashOff, logT, logT + letterOff, logT + wordOff];
  const sig = [SIGMA_MARK, SIGMA_MARK, SIGMA_GAP, SIGMA_GAP, SIGMA_GAP * 1.3];
  const minD: number[] = [];
  const maxD: number[] = [];
  for (let c = 0; c < IDLE; c++) {
    minD[c] = Math.max(1, Math.round(rate * Math.exp(mu[c] - 2.2 * sig[c])));
    maxD[c] = Math.max(2, Math.round(rate * Math.exp(mu[c] + 2.2 * sig[c])));
  }
  const minIdle = Math.max(2, Math.round(rate * Math.exp(mu[WORD] + 1.2 * sig[WORD])));
  // duration log-likelihood per class and length, computed once per run
  const maxAll = Math.max(...maxD);
  const durLL: Float64Array[] = [];
  for (let c = 0; c < IDLE; c++) {
    const a = new Float64Array(maxAll + 1);
    for (let d = minD[c]; d <= maxD[c]; d++) a[d] = -0.5 * ((Math.log(d / rate) - mu[c]) / sig[c]) ** 2 - Math.log(sig[c]) + LOG_PRIOR[c];
    durLL.push(a);
  }
  const { best, from, markBest, markArg, downBest, downArg } = buf;
  best.fill(-Infinity);
  from.fill(-1);
  // markBest[s] / downBest[s]: best path ending at s with a mark / a gap (class remembered); s = 0 is the virtual start for both
  markBest.fill(-Infinity); downBest.fill(-Infinity);
  markBest[0] = 0; markArg[0] = 7; downBest[0] = 0; downArg[0] = 7;
  let runScore = -Infinity, runAt = -1, runCls = -1;
  for (let t = 1; t <= n; t++) {
    const pt = prefix[t];
    for (let c = 0; c < IDLE; c++) {
      const mark = c <= DASH;
      const prevBest = mark ? downBest : markBest; // a mark follows a gap, a gap follows a mark
      const prevArg = mark ? downArg : markArg;
      const dl = durLL[c];
      const hi = Math.min(maxD[c], t);
      let bs = -Infinity, bfrom = -1;
      for (let d = minD[c]; d <= hi; d++) {
        const s = t - d;
        const bp = prevBest[s];
        if (bp === -Infinity) continue;
        const sc = bp + (mark ? pt - prefix[s] - MARK_COST : 0) + dl[d];
        if (sc > bs) { bs = sc; bfrom = s * 8 + prevArg[s]; }
      }
      best[t * 6 + c] = bs; from[t * 6 + c] = bfrom;
    }
    // IDLE: long silence after a mark (or from the start), no duration cost
    const e = t - minIdle;
    if (e >= 0) {
      if (e === 0 && runScore < 0) { runScore = 0; runAt = 0; runCls = 7; }
      if (e > 0) for (let c = 0; c <= DASH; c++) { const v = best[e * 6 + c]; if (v > runScore) { runScore = v; runAt = e; runCls = c; } }
      if (runAt >= 0) { best[t * 6 + IDLE] = runScore + LOG_PRIOR[IDLE]; from[t * 6 + IDLE] = runAt * 8 + runCls; }
    }
    // best mark-ending / gap-ending path at t, for later segments to chain from
    let mb = -Infinity, ma = 0, db = -Infinity, da = 0;
    for (let c = 0; c < 6; c++) {
      const v = best[t * 6 + c];
      if (c <= DASH) { if (v > mb) { mb = v; ma = c; } } else if (v > db) { db = v; da = c; }
    }
    markBest[t] = mb; markArg[t] = ma; downBest[t] = db; downArg[t] = da;
  }
  let bc = 0, bs = -Infinity;
  for (let c = 0; c < 6; c++) if (best[n * 6 + c] > bs) { bs = best[n * 6 + c]; bc = c; }
  const segs: Seg[] = [];
  let t = n, c = bc;
  while (t > 0 && c >= 0 && c < 6) {
    const f = from[t * 6 + c];
    if (f < 0) break;
    const s = Math.floor(f / 8), pc = f % 8;
    segs.unshift({ cls: c as Cls, start: s, end: t });
    t = s; c = pc === 7 ? -1 : pc;
  }
  return { score: bs, segs };
}

export interface HsmmOptions {
  /** Filter width in Hz; defaults to 1.5x the scout speed (30..120). */
  bandwidth?: number;
  /** Carrier-level tracking: window half-width in s (short follows fast QSB, long is steadier), quantile of the window, and the floor as a fraction of the long-term level. */
  carrierWindow?: number;
  carrierQuantile?: number;
  floorFraction?: number;
  /** Speed hint in WPM (a scout pass of another decoder works); the search covers about -20%..+27% around it. */
  wpmHint?: number;
}

export function hsmmDecode(samples: Float32Array, sampleRate: number, freq: number, opts: HsmmOptions = {}): DecodedChar[] {
  return hsmmDecodeScored(samples, sampleRate, freq, opts).chars;
}

/** Same, also returning the log-likelihood (vs noise only) of the best segmentation, for model selection. */
export function hsmmDecodeScored(samples: Float32Array, sampleRate: number, freq: number, opts: HsmmOptions = {}): { chars: DecodedChar[]; score: number } {
  const wpmHint = opts.wpmHint ?? 20;
  const bw = opts.bandwidth ?? Math.min(120, Math.max(30, 1.5 * wpmHint));
  const det = new EnvelopeDetector(sampleRate, freq, bw, 400);
  const env = det.process(samples);
  const rate = det.envRate;
  const L = llr(env, rate, opts.carrierWindow ?? 1.0, opts.carrierQuantile ?? 0.95, opts.floorFraction ?? 0.6);
  const prefix = new Float64Array(L.length + 1);
  for (let i = 0; i < L.length; i++) prefix[i + 1] = prefix[i] + L[i];

  const buf = scratch(L.length);
  let best: { score: number; segs: Seg[]; logT: number; dash: number; letter: number; word: number } | null = null;
  const T0 = 1.2 / wpmHint;
  const grid: number[] = [0.8, 0.9, 1, 1.12, 1.27];
  for (const tf of grid) {
    const logT: number = Math.log(T0 * tf);
    for (const [dash, letter, word] of [[Math.log(3), Math.log(3), Math.log(7)], [Math.log(3.6), Math.log(4), Math.log(7.5)]] as const) {
      const r = viterbi(prefix, L.length, rate, logT, dash, letter, word, buf);
      if (!best || r.score > best.score) best = { ...r, logT, dash, letter, word };
    }
  }
  if (!best) return { chars: [], score: -Infinity };
  // refine speed around the best grid point
  for (const tf of [0.95, 1.05]) {
    const logT: number = best.logT + Math.log(tf);
    const r = viterbi(prefix, L.length, rate, logT, best.dash, best.letter, best.word, buf);
    if (r.score > best.score) best = { ...r, logT, dash: best.dash, letter: best.letter, word: best.word };
  }

  const out: DecodedChar[] = [];
  const wpm = 1.2 / Math.exp(best.logT);
  let els: { sym: string; gapBefore: number; conf: number; ev: number }[] = [];
  let lastGap = 0;
  const evidence: number[] = []; // mean carrier-vs-noise evidence per emitted letter
  let pendingEv = 0;
  const emit = (text: string, conf: number, endSample: number, gapSec: number, pWord: number) => {
    out.push({ char: text, confidence: conf, time: endSample / rate, wpm, gapAfter: gapSec, pWordAfter: pWord });
    evidence.push(pendingEv);
  };
  const flush = (endSample: number, gapSec: number, pWord: number) => {
    if (!els.length) return;
    const pattern = els.map((e) => e.sym).join('');
    const conf = els.reduce((a, e) => a * e.conf, 1);
    pendingEv = els.reduce((a, e) => a + e.ev, 0) / els.length;
    if (patternToChar(pattern)) emit(patternToChar(pattern)!, conf, endSample, gapSec, pWord);
    else {
      // not a letter: split at the longest internal gap that leaves two valid letters (a sloppy fist ran two together)
      let bestK = -1;
      for (let k = 1; k < els.length; k++) {
        if (!patternToChar(els.slice(0, k).map((e) => e.sym).join('')) || !patternToChar(els.slice(k).map((e) => e.sym).join(''))) continue;
        if (bestK < 0 || els[k].gapBefore > els[bestK].gapBefore) bestK = k;
      }
      if (bestK > 0) {
        const a = els.slice(0, bestK), b = els.slice(bestK);
        emit(patternToChar(a.map((e) => e.sym).join(''))!, 0.5 * a.reduce((x, e) => x * e.conf, 1), endSample - (b.length + 1) * 0, els[bestK].gapBefore, 0.05);
        emit(patternToChar(b.map((e) => e.sym).join(''))!, 0.5 * b.reduce((x, e) => x * e.conf, 1), endSample, gapSec, pWord);
      } else emit('?', 0, endSample, gapSec, pWord);
    }
    els = [];
  };
  const segs = best.segs;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const sec = (s.end - s.start) / rate;
    if (isMark(s.cls)) {
      if (sec * 1000 < 8) continue;
      const a = Math.abs(Math.log(sec) - best.logT), b = Math.abs(Math.log(sec) - (best.logT + best.dash));
      els.push({ sym: s.cls === DASH ? '-' : '.', gapBefore: lastGap, conf: 1 / (1 + Math.exp(-Math.abs(a - b) * 3)), ev: (prefix[s.end] - prefix[s.start]) / (s.end - s.start) });
    } else if (s.cls === LETTER || s.cls === WORD || s.cls === IDLE) {
      const lw = Math.abs(Math.log(sec) - (best.logT + best.letter)), ww = Math.abs(Math.log(sec) - (best.logT + best.word));
      const pWord = s.cls === LETTER ? (1 / (1 + Math.exp((ww - lw) * 3))) * 0.5 : s.cls === WORD ? 0.9 : 1;
      flush(s.start, sec, pWord);
      lastGap = 0;
    } else lastGap = sec;
  }
  flush(L.length, Infinity, 0);
  // Noise stretches still yield lucky "dots". Real letters carry clearly more carrier evidence than
  // that: drop letters below an absolute floor and far below the strong end of this recording.
  const sorted = [...evidence].sort((a, b) => a - b);
  const strong = sorted.length ? sorted[Math.floor(0.9 * (sorted.length - 1))] : 0;
  const floor = Math.max(MIN_EVIDENCE, GATE_FRACTION * strong);
  const kept = out.filter((_, i) => evidence[i] >= floor);
  return { chars: kept, score: best.score };
}
