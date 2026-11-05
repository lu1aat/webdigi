/** In-place radix-2 complex FFT. `re`/`im` length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
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
