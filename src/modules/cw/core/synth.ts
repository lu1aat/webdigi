import { MORSE, dotSeconds } from './morse';

export interface SynthOptions {
  text: string;
  wpm: number;
  /** Carrier (audio tone) frequency, Hz. */
  freq?: number;
  sampleRate?: number;
  /** SNR in a 2500 Hz reference bandwidth, dB. Omit for a noiseless signal. */
  snrDb?: number;
  /** Key-click-free rise/fall time, seconds. */
  riseSeconds?: number;
  /** Silence before the message, seconds (also after it unless `tailPadSeconds` is given). */
  padSeconds?: number;
  tailPadSeconds?: number;
  /** Slow amplitude fading (QSB): depth 0..1 and rate in Hz. */
  qsbDepth?: number;
  qsbHz?: number;
  /** Fist jitter: relative std-dev of every element/gap duration (0 = machine perfect). */
  jitter?: number;
  /** Linear speed change over the message, as a ratio of end WPM to start WPM. */
  speedRatio?: number;
  seed?: number;
}

/** Deterministic PRNG so tests and eval runs are repeatable. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rand: () => number): number {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** Key-down intervals [startSec, endSec) for a message. */
export function keyingSchedule(opts: SynthOptions, rand: () => number): { marks: [number, number][]; end: number } {
  const jitter = opts.jitter ?? 0;
  const pad = opts.padSeconds ?? 0.5;
  const words = opts.text.toUpperCase().split(/\s+/).filter(Boolean);
  const marks: [number, number][] = [];
  let t = pad;
  // total length in dot units, used to apply the linear speed ramp
  const units = opts.text.length * 8;
  let used = 0;
  const T = () => {
    const ratio = opts.speedRatio ?? 1;
    const frac = Math.min(1, used / Math.max(1, units));
    return dotSeconds(opts.wpm) / (1 + (ratio - 1) * frac);
  };
  const dur = (n: number) => {
    used += n;
    return n * T() * Math.max(0.3, 1 + jitter * gaussian(rand));
  };
  words.forEach((word, wi) => {
    if (wi > 0) t += dur(7);
    [...word].forEach((ch, ci) => {
      const code = MORSE[ch];
      if (!code) return;
      if (ci > 0) t += dur(3);
      [...code].forEach((el, ei) => {
        if (ei > 0) t += dur(1);
        const d = dur(el === '.' ? 1 : 3);
        marks.push([t, t + d]);
        t += d;
      });
    });
  });
  return { marks, end: t + (opts.tailPadSeconds ?? pad) };
}

/** Render CW audio: raised-cosine keyed tone + white Gaussian noise (+ optional QSB). */
export function synthCw(opts: SynthOptions): { samples: Float32Array; sampleRate: number } {
  const fs = opts.sampleRate ?? 8000;
  const f0 = opts.freq ?? 700;
  const rise = opts.riseSeconds ?? 0.005;
  const rand = mulberry32(opts.seed ?? 1);
  const { marks, end } = keyingSchedule(opts, rand);
  const n = Math.ceil(end * fs);
  const env = new Float32Array(n);
  for (const [a, b] of marks) {
    const i0 = Math.floor(a * fs);
    const i1 = Math.min(n, Math.ceil(b * fs));
    for (let i = i0; i < i1; i++) {
      const t = i / fs;
      const up = Math.min(1, Math.max(0, (t - a) / rise));
      const down = Math.min(1, Math.max(0, (b - t) / rise));
      const g = Math.min(up, down);
      env[i] = 0.5 - 0.5 * Math.cos(Math.PI * g);
    }
  }
  const amp = 0.5;
  const sigPower = (amp * amp) / 2;
  // noise variance such that sigPower / (sigma^2 * 2500 / (fs/2)) = snr
  const sigma = opts.snrDb === undefined
    ? 0
    : Math.sqrt((sigPower * (fs / 2)) / (2500 * 10 ** (opts.snrDb / 10)));
  const qd = opts.qsbDepth ?? 0;
  const qf = opts.qsbHz ?? 0.2;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const fade = qd ? 1 - qd * (0.5 - 0.5 * Math.cos(2 * Math.PI * qf * (i / fs))) : 1;
    samples[i] = amp * fade * env[i] * Math.sin(2 * Math.PI * f0 * (i / fs)) + (sigma ? sigma * gaussian(rand) : 0);
  }
  return { samples, sampleRate: fs };
}

export interface Station extends Omit<SynthOptions, 'snrDb' | 'sampleRate' | 'seed'> {
  /** Level relative to a reference station, dB (0 = reference). */
  levelDb?: number;
  /** Seconds before this station starts keying. */
  delay?: number;
}

/** Several stations plus one shared white noise floor. `snrDb` is the reference station's SNR in 2.5 kHz. */
export function synthPileup(
  stations: Station[],
  opts: { sampleRate?: number; snrDb?: number; seed?: number; tailSeconds?: number } = {},
): { samples: Float32Array; sampleRate: number } {
  const fs = opts.sampleRate ?? 8000;
  const parts = stations.map((s, i) => {
    const { samples } = synthCw({ ...s, sampleRate: fs, padSeconds: (s.delay ?? 0) + 0.5, tailPadSeconds: 0.5, seed: (opts.seed ?? 1) + i });
    const g = 10 ** ((s.levelDb ?? 0) / 20);
    return samples.map((v) => v * g);
  });
  const n = Math.max(0, ...parts.map((p) => p.length)) + Math.round((opts.tailSeconds ?? 2) * fs);
  const out = new Float32Array(n);
  for (const p of parts) for (let i = 0; i < p.length; i++) out[i] += p[i];
  if (opts.snrDb !== undefined) {
    const rand = mulberry32((opts.seed ?? 1) + 999);
    const sigma = Math.sqrt((0.125 * (fs / 2)) / (2500 * 10 ** (opts.snrDb / 10)));
    for (let i = 0; i < n; i++) out[i] += sigma * gaussian(rand);
  }
  return { samples: out, sampleRate: fs };
}
