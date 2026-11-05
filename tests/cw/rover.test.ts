import { describe, expect, it } from 'vitest';
import type { DecodedChar } from '../../src/modules/cw/core/decoder/cw-decoder';
import { vote } from '../../src/modules/cw/core/decoder/rover';

const seq = (s: string): DecodedChar[] => [...s].map((char, i) => ({ char, confidence: 0.9, time: i, wpm: 20, pWordAfter: 0.1, gapAfter: 0.15 }));
const text = (c: DecodedChar[]) => c.map((x) => x.char).join('');

describe('vote (ROVER)', () => {
  it('returns a single sequence unchanged', () => {
    expect(text(vote([seq('CQ DE K')]))).toBe('CQDEK');
  });

  it('majority fixes a substitution', () => {
    expect(text(vote([seq('CQDEK'), seq('CQDEK'), seq('CQXEK')]))).toBe('CQDEK');
  });

  it('majority fixes an insertion and a deletion', () => {
    expect(text(vote([seq('PY1FJ'), seq('PY1FJ'), seq('PEY1FJ')]))).toBe('PY1FJ');
    expect(text(vote([seq('PY1FJ'), seq('PY1FJ'), seq('PY1J')]))).toBe('PY1FJ');
  });

  it('weights can overrule the head count', () => {
    expect(text(vote([seq('ABCD'), seq('ABXD'), seq('ABXD')], [5, 1, 1]))).toBe('ABCD');
  });

  it('confidence reflects agreement', () => {
    const out = vote([seq('AB'), seq('AB'), seq('AX')]);
    expect(out[0].confidence).toBeGreaterThan(out[1].confidence);
  });
});
