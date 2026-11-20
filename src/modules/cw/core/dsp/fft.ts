interface Tables {
  rev: Uint32Array;
  cos: Float64Array;
  sin: Float64Array;
}
const cache = new Map<number, Tables>();

/** Bit-reversal permutation and twiddle factors for one size, computed once. */
function tables(n: number): Tables {
  let t = cache.get(n);
  if (t) return t;
  const rev = new Uint32Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    rev[i] = j;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    cos[k] = Math.cos((-2 * Math.PI * k) / n);
    sin[k] = Math.sin((-2 * Math.PI * k) / n);
  }
  cache.set(n, (t = { rev, cos, sin }));
  return t;
}

/** In-place radix-2 complex FFT. `re`/`im` length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  const { rev, cos, sin } = tables(n);
  for (let i = 1; i < n; i++) {
    const j = rev[i];
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0, w = 0; k < half; k++, w += step) {
        const a = i + k;
        const b = a + half;
        const cr = cos[w];
        const ci = sin[w];
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

/** Welch-averaged power spectrum (Hann window, 50% overlap) of a real signal. Returns n/2+1 bins. */
export function powerSpectrum(x: Float32Array, size = 4096): Float64Array {
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const acc = new Float64Array(size / 2 + 1);
  const win = new Float64Array(size).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
  let count = 0;
  for (let s = 0; s + size <= x.length; s += size / 2) {
    for (let i = 0; i < size; i++) { re[i] = x[s + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k <= size / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    count++;
  }
  if (count) for (let k = 0; k < acc.length; k++) acc[k] /= count;
  return acc;
}
