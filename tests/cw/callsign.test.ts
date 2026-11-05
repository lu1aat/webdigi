import { describe, expect, it } from 'vitest';
import { CallDatabase, classifyCall, classifyToken, passesValidation } from '../../src/modules/cw/core/ham/callsign';
import { SpotExtractor } from '../../src/modules/cw/core/ham/spot-extractor';

const feed = (ex: SpotExtractor, text: string) =>
  ex.push([...text].map((char) => ({ char, confidence: 0.95, time: 0, wpm: 20 })));

describe('callsign classification', () => {
  it.each(['LU1AAT', 'W1AW', 'EA8ZZ', '9A1A', 'VK4DO', '3A2MD', 'K1ABC/P', 'EA8/LU1AAT'])('%s is typical', (c) => {
    expect(classifyCall(c)).toBe('typical');
  });
  it.each(['HELLO', 'CQ', '599', 'LU', '1234'])('%s is invalid', (c) => expect(classifyCall(c)).toBe('invalid'));
  it('applies validation levels and the database', () => {
    const db = new CallDatabase('LU1ABC\n# x\nPY2XYZ');
    expect(passesValidation('LU1ABC', 'paranoid', db)).toBe(true);
    expect(passesValidation('LU1ABD', 'paranoid', db)).toBe(false);
    expect(passesValidation('LU1ABD', 'aggressive', db)).toBe(true);
  });
  it('labels tokens', () => {
    expect(classifyToken('CQ')).toBe('keyword');
    expect(classifyToken('5NN')).toBe('rst');
    expect(classifyToken('599')).toBe('rst');
    expect(classifyToken('LU1AAT')).toBe('call');
    expect(classifyToken('THE')).toBe('other');
  });
});

describe('SpotExtractor', () => {
  it('reports the sender after DE and marks CQ', () => {
    const ex = new SpotExtractor();
    const hits = [...feed(ex, 'CQ CQ DE LU1ABC LU1ABC K '), ...ex.flush()];
    expect(hits[0]).toMatchObject({ call: 'LU1ABC', cq: true });
  });
  it('ignores a call heard only once away from DE', () => {
    const ex = new SpotExtractor();
    expect([...feed(ex, 'LU1ABC 599 TU '), ...ex.flush()]).toHaveLength(0);
  });
  it('reports a call seen twice', () => {
    const ex = new SpotExtractor();
    expect([...feed(ex, 'PY2XYZ PY2XYZ 5NN '), ...ex.flush()].map((h) => h.call)).toEqual(['PY2XYZ']);
  });
});

import { formatSpot, utcStamp } from '../../src/modules/cw/core/ham/spot-format';

describe('spot format', () => {
  it('formats an RBN-style line', () => {
    const line = formatSpot(
      { channel: 1, call: 'K1ABC', freq: 703.3, snr: 22.6, wpm: 24.8, cq: true, confidence: 1, time: 0 },
      'LU1AAT', 7000, new Date(Date.UTC(2026, 9, 16, 12, 34)),
    );
    expect(line).toBe('DX de LU1AAT-#:   7000.7  K1ABC        CW    23 dB  25 WPM  CQ      1234Z');
    expect(utcStamp(new Date(Date.UTC(2026, 0, 1, 5, 7)))).toBe('0507Z');
  });
});
