import { describe, expect, it } from 'vitest';
import { Skimmer, type SkimmerEvent } from '../../src/modules/cw/core/skimmer/skimmer';
import { synthPileup } from '../../src/modules/cw/core/synth';
import { NoiseBlanker } from '../../src/modules/cw/core/dsp/noise-blanker';
import { synthCw, mulberry32 } from '../../src/modules/cw/core/synth';
import { decodeAudio } from '../../src/modules/cw/core/decoder/decode-audio';

function run(samples: Float32Array, fs: number, opts = {}) {
  const sk = new Skimmer(fs, opts);
  const events: SkimmerEvent[] = [];
  for (let i = 0; i < samples.length; i += 1024) events.push(...sk.process(samples.subarray(i, i + 1024)));
  events.push(...sk.finish());
  return events;
}

function textOf(events: SkimmerEvent[], near: number): string {
  const chars = events.filter((e) => e.type === 'chars' && Math.abs(e.channel.track.freq - near) < 40) as Extract<SkimmerEvent, { type: 'chars' }>[];
  return chars.flatMap((e) => e.chars.map((c) => c.char)).join('').replace(/\s+/g, ' ').trim();
}

describe('skimmer', () => {
  const A = 'CQ CQ DE LU1ABC LU1ABC K';
  const B = 'CQ TEST DE PY2XYZ PY2XYZ TEST';
  const C = 'W1AW DE EA8ZZ 599 0042 BK';

  it('decodes three simultaneous stations on separate carriers', () => {
    const { samples, sampleRate } = synthPileup(
      [
        { text: A, wpm: 18, freq: 600 },
        { text: B, wpm: 26, freq: 950, delay: 2, levelDb: -6 },
        { text: C, wpm: 32, freq: 1400, delay: 1, levelDb: -3 },
      ],
      { snrDb: 25, seed: 4 },
    );
    const ev = run(samples, sampleRate);
    expect(textOf(ev, 600)).toBe(A);
    expect(textOf(ev, 950)).toBe(B);
    expect(textOf(ev, 1400)).toBe(C);
    const calls = ev.filter((e) => e.type === 'spot').map((e) => (e as { spot: { call: string } }).spot.call);
    expect(calls).toContain('LU1ABC');
    expect(calls).toContain('PY2XYZ');
  });

  it('flags CQ stations and estimates carrier frequency', () => {
    const { samples, sampleRate } = synthPileup([{ text: A, wpm: 20, freq: 733 }], { snrDb: 25, seed: 8 });
    const ev = run(samples, sampleRate);
    const spot = ev.find((e) => e.type === 'spot') as Extract<SkimmerEvent, { type: 'spot' }>;
    expect(spot.spot.call).toBe('LU1ABC');
    expect(spot.spot.cq).toBe(true);
    expect(Math.abs(spot.spot.freq - 733)).toBeLessThan(10);
  });

  it('creates no channels from noise alone', () => {
    const { samples, sampleRate } = synthPileup([], { snrDb: 0, seed: 3, tailSeconds: 40 });
    expect(run(samples, sampleRate).filter((e) => e.type === 'spawn')).toHaveLength(0);
  });

  it('retires a carrier after it goes away', () => {
    const { samples, sampleRate } = synthPileup([{ text: A, wpm: 22, freq: 800 }], { snrDb: 25, seed: 2, tailSeconds: 12 });
    const ev = run(samples, sampleRate);
    expect(ev.filter((e) => e.type === 'spawn')).toHaveLength(1);
    expect(ev.filter((e) => e.type === 'retire')).toHaveLength(1);
  });

  it('does not treat key clicks of a strong station as separate stations', () => {
    const { samples, sampleRate } = synthPileup([{ text: A, wpm: 30, freq: 700, riseSeconds: 0.0005 }], { snrDb: 40, seed: 6 });
    const spawns = run(samples, sampleRate).filter((e) => e.type === 'spawn');
    expect(spawns).toHaveLength(1);
  });
});

describe('noise blanker', () => {
  it('lets a decode survive heavy impulse noise', () => {
    const { samples, sampleRate } = synthCw({ text: 'CQ DE LU1ABC K', wpm: 20, freq: 700, snrDb: 25, seed: 1 });
    const rand = mulberry32(5);
    const noisy = samples.map((v) => v);
    for (let i = 0; i < 120; i++) noisy[Math.floor(rand() * noisy.length)] += (rand() < 0.5 ? -1 : 1) * 40;
    const nb = new NoiseBlanker(sampleRate);
    const cleaned = new Float32Array(noisy.length);
    for (let i = 0; i < noisy.length; i += 512) cleaned.set(nb.process(noisy.subarray(i, i + 512)), i);
    expect(decodeAudio(cleaned, sampleRate, { freq: 700 }).text).toContain('LU1ABC');
  });
});
