import { describe, expect, it } from 'vitest';
import type { DecodedChar } from '../../src/modules/cw/core/decoder/cw-decoder';
import { segmentedText } from '../../src/modules/cw/core/ham/segment';

/** Build chars from text; `p` is the word-gap posterior after each letter (default: mildly unsure). */
function chars(text: string, p: (i: number) => number = () => 0.1, conf: (i: number) => number = () => 0.95): DecodedChar[] {
  return [...text].map((char, i) => ({ char, confidence: conf(i), time: i, wpm: 20, pWordAfter: p(i) }));
}

describe('segmentWords', () => {
  it('splits a hand-keyed run with misleading gaps using the vocabulary (real recording)', () => {
    // real fragment: the gap inside KEEP was longer than the one before UP
    const t = 'FBDAVEKEEPUPTHEGUD';
    expect(segmentedText(chars(t))).toBe('FB DAVE KEEP UP THE GUD');
  });

  it('keeps callsigns whole', () => {
    // word gaps after CQ, CQ, DE and LU1ABC are clear in the timing; the vocabulary must not break the call
    const ends = new Set([1, 3, 5, 11]);
    expect(segmentedText(chars('CQCQDELU1ABCK', (i) => (ends.has(i) ? 0.9 : 0.1)))).toBe('CQ CQ DE LU1ABC K');
  });

  it('trusts a confident word gap over the vocabulary', () => {
    const t = 'XQJVBZ';
    expect(segmentedText(chars(t, (i) => (i === 2 ? 0.97 : 0.05)))).toBe('XQJ VBZ');
  });

  it('repairs a doubtful letter towards a dictionary word', () => {
    expect(segmentedText(chars('THE?UD', () => 0.1, (i) => (i === 3 ? 0.2 : 0.95)))).toContain('GUD');
  });
});
