import { describe, expect, it } from 'vitest';
import { hsmmDecode, type HsmmOptions } from '../../src/modules/cw/core/decoder/hsmm';
import { gaussian, mulberry32, synthCw } from '../../src/modules/cw/core/synth';

const MSG = 'CQ CQ DE LU1ABC K';
const letters = (s: string) => s.replace(/ /g, '');
const run = (o: Parameters<typeof synthCw>[0], h: HsmmOptions = {}) => {
  const { samples, sampleRate } = synthCw(o);
  return hsmmDecode(samples, sampleRate, o.freq ?? 700, { wpmHint: o.wpm, ...h }).map((c) => c.char).join('');
};

describe('hsmm decoder', () => {
  it('decodes clean CW at several speeds', () => {
    for (const wpm of [15, 25, 35]) expect(run({ text: MSG, wpm, freq: 700, seed: 2 })).toBe(letters(MSG));
  });

  it('survives noise, a sloppy fist and deep fading', () => {
    const got = run({ text: MSG, wpm: 22, freq: 650, snrDb: 6, jitter: 0.12, qsbDepth: 0.5, qsbHz: 0.4, seed: 5 }, { carrierWindow: 0.7, carrierQuantile: 0.92, floorFraction: 0.5 });
    expect(got).toBe(letters(MSG));
  });

  it('reads nothing from noise alone', () => {
    const fs = 44100;
    const rand = mulberry32(3);
    const x = new Float32Array(fs * 8);
    for (let i = 0; i < x.length; i++) x[i] = 0.002 * gaussian(rand);
    expect(hsmmDecode(x, fs, 1000, { wpmHint: 22 }).map((c) => c.char).join('').length).toBeLessThanOrEqual(2);
  });

  it('splits two letters a sloppy fist ran together', () => {
    // "UP" sent with a letter gap shorter than usual still comes out as two letters, not '?'
    const got = run({ text: 'THE UP THE', wpm: 25, freq: 700, seed: 4 });
    expect(got).toBe('THEUPTHE');
  });
});
