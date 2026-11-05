import { describe, expect, it } from 'vitest';
import { decodeAudio } from '../../src/modules/cw/core/decoder/decode-audio';
import { synthCw } from '../../src/modules/cw/core/synth';
import { encodeWav16, parseWav } from '../../src/modules/cw/core/wav';
import { findTone } from '../../src/modules/cw/core/dsp/tone';

const MSG = 'CQ CQ DE LU1ABC LU1ABC K';

describe('findTone', () => {
  it('locates the carrier within a few Hz', () => {
    const { samples, sampleRate } = synthCw({ text: MSG, wpm: 20, freq: 812, snrDb: 10 });
    expect(Math.abs(findTone(samples, sampleRate)! - 812)).toBeLessThan(5);
  });
});

describe('single-channel decode', () => {
  for (const wpm of [12, 20, 30, 40]) {
    it(`clean signal at ${wpm} WPM`, () => {
      const { samples, sampleRate } = synthCw({ text: MSG, wpm, freq: 700, seed: 3 });
      expect(decodeAudio(samples, sampleRate).text).toBe(MSG);
    });
  }

  it('decodes with moderate noise (20 dB SNR in 2.5 kHz)', () => {
    const { samples, sampleRate } = synthCw({ text: MSG, wpm: 22, freq: 650, snrDb: 20, seed: 5 });
    expect(decodeAudio(samples, sampleRate).text).toBe(MSG);
  });

  it('tolerates human-like jitter and slow QSB', () => {
    const { samples, sampleRate } = synthCw({
      text: MSG, wpm: 18, freq: 600, snrDb: 22, jitter: 0.08, qsbDepth: 0.5, qsbHz: 0.15, seed: 9,
    });
    expect(decodeAudio(samples, sampleRate).text).toBe(MSG);
  });

  it('follows a speed change', () => {
    const { samples, sampleRate } = synthCw({ text: MSG + ' ' + MSG, wpm: 15, speedRatio: 1.6, freq: 700, seed: 2 });
    expect(decodeAudio(samples, sampleRate).text).toBe(MSG + ' ' + MSG);
  });

  it('reports speed close to the sent speed', () => {
    const { samples, sampleRate } = synthCw({ text: MSG, wpm: 25, freq: 700 });
    const r = decodeAudio(samples, sampleRate);
    const wpm = r.chars[r.chars.length - 1].wpm;
    expect(Math.abs(wpm - 25)).toBeLessThan(2.5);
  });

  it('outputs nothing for noise only', () => {
    const { samples, sampleRate } = synthCw({ text: '', wpm: 20, snrDb: 0, padSeconds: 6, seed: 4 });
    expect(decodeAudio(samples, sampleRate, { freq: 700 }).text).toBe('');
  });
});

describe('wav round trip', () => {
  it('survives 16-bit encode/parse', () => {
    const { samples, sampleRate } = synthCw({ text: MSG, wpm: 20, freq: 700 });
    const wav = parseWav(encodeWav16({ sampleRate, channels: [samples] }));
    expect(wav.sampleRate).toBe(sampleRate);
    expect(decodeAudio(wav.channels[0], wav.sampleRate).text).toBe(MSG);
  });
});
