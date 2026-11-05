import { powerSpectrum } from './fft';

/** Strongest narrow tone in [lo, hi] Hz, with parabolic interpolation. Null if the band is empty. */
export function findTone(x: Float32Array, fs: number, lo = 300, hi = 1500): number | null {
  const size = 4096;
  if (x.length < size) return null;
  const p = powerSpectrum(x, size);
  const hz = fs / size;
  const k0 = Math.max(1, Math.floor(lo / hz));
  const k1 = Math.min(p.length - 2, Math.ceil(hi / hz));
  let best = k0;
  for (let k = k0; k <= k1; k++) if (p[k] > p[best]) best = k;
  const a = Math.log(p[best - 1] + 1e-30);
  const b = Math.log(p[best] + 1e-30);
  const c = Math.log(p[best + 1] + 1e-30);
  const d = a - 2 * b + c;
  const shift = d === 0 ? 0 : (0.5 * (a - c)) / d;
  return (best + shift) * hz;
}
