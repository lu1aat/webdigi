import { describe, expect, it } from 'vitest';
import { councilDecode } from '../../src/modules/cw/core/decoder/council';
import { EnvelopeDetector } from '../../src/modules/cw/core/dsp/envelope';
import { Skimmer, type SkimmerEvent } from '../../src/modules/cw/core/skimmer/skimmer';
import { synthCw } from '../../src/modules/cw/core/synth';

function run(samples: Float32Array, sampleRate: number, opts: ConstructorParameters<typeof Skimmer>[1] = {}) {
  const sk = new Skimmer(sampleRate, opts);
  const events: SkimmerEvent[] = [];
  for (let i = 0; i < samples.length; i += 1024) events.push(...sk.process(samples.subarray(i, i + 1024)));
  events.push(...sk.finish());
  return { sk, events };
}

describe('bursts and council second look', () => {
  it('emits a burst with the audio of the transmission, and refined text confirms the call', () => {
    const msg = synthCw({ text: 'CQ CQ DE LU1ABC LU1ABC K', wpm: 22, freq: 900, snrDb: 15, padSeconds: 4, tailPadSeconds: 8, seed: 1 });
    const { sk, events } = run(msg.samples, msg.sampleRate, { bursts: true });
    const burst = events.find((e) => e.type === 'burst');
    expect(burst).toBeDefined();
    if (burst?.type !== 'burst') return;
    expect(Math.abs(burst.burst.freq - 900)).toBeLessThan(15);
    expect(burst.burst.samples.length).toBeGreaterThan(msg.sampleRate * 4);
    const r = councilDecode(burst.burst.samples, burst.burst.sampleRate, burst.burst.freq);
    expect(r.text.replace(/ /g, '')).toContain('LU1ABC');
    const out = sk.submitRefined(burst.burst, r.chars);
    expect(out.some((e) => e.type === 'refined')).toBe(true);
    expect(burst.burst.channel.refined?.length).toBeGreaterThan(5);
  }, 60000);

  it('rejects a carrier that only produces noise-like letters and ignores that frequency afterwards', () => {
    const junk = synthCw({ text: 'E E I S E T E S I E H E E S I E T E I S', wpm: 20, freq: 700, snrDb: 25, padSeconds: 3, tailPadSeconds: 3, seed: 2 });
    const { events } = run(junk.samples, junk.sampleRate);
    expect(events.some((e) => e.type === 'reject')).toBe(true);
    // after the ban no second channel appears on that frequency during the ban window
    const spawns = events.filter((e) => e.type === 'spawn');
    expect(spawns.length).toBe(1);
  }, 60000);

  it('does not reject real traffic', () => {
    const msg = synthCw({ text: 'CQ DX CQ DX PY1FJ PY1FJ K', wpm: 22, freq: 800, snrDb: 15, padSeconds: 3, tailPadSeconds: 3, seed: 3 });
    const { events } = run(msg.samples, msg.sampleRate);
    expect(events.some((e) => e.type === 'reject')).toBe(false);
  }, 60000);
});

describe('EnvelopeDetector.setFrequency', () => {
  it('follows a carrier that moved', () => {
    const fs = 8000;
    const x = new Float32Array(fs * 2);
    for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * (i < fs ? 600 : 900) * i) / fs);
    const det = new EnvelopeDetector(fs, 600, 60);
    const a = det.process(x.subarray(0, fs));
    det.setFrequency(900);
    const b = det.process(x.subarray(fs));
    expect(a[a.length - 1]).toBeGreaterThan(0.5);
    expect(b[b.length - 1]).toBeGreaterThan(0.5);
    expect(det.tunedFreq).toBe(900);
  });
});
