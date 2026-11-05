import type { DecodedChar } from '../decoder/cw-decoder';
import { classifyCall } from './callsign';
import { LEXICON, WEAK_SINGLES } from './lexicon';

export interface Word {
  text: string;
  /** Index range [start, end) into the letters passed in. */
  start: number;
  end: number;
}

export interface SegmentOptions {
  /** Bonus for a dictionary word, per word. */
  lexiconBonus?: number;
  /** Penalty per character of a word that is neither a dictionary word, call, nor number. */
  oovPerChar?: number;
  /** Penalty for each doubtful letter replaced to make a dictionary word. */
  repairPenalty?: number;
  /** Characters below this confidence may be replaced by a dictionary letter. */
  repairBelow?: number;
}

const MAX_TOKEN = 14;

/** Log-odds of a word gap, tempered because hand-keyed timing is only a weak cue. */
function boundaryScore(c: DecodedChar | undefined): { yes: number; no: number } {
  const p = Math.min(0.97, Math.max(0.03, c?.pWordAfter ?? 0.1));
  return { yes: 0.6 * Math.log(p), no: 0.6 * Math.log(1 - p) };
}

function matchLexicon(tok: DecodedChar[], o: Required<SegmentOptions>): { text: string; score: number } | null {
  const s = tok.map((c) => c.char).join('');
  if (LEXICON.has(s)) return { text: s, score: 0 };
  if (tok.length < 3) return null;
  // allow repairing doubtful letters ('?' or low confidence) towards a dictionary word
  const doubt = tok.map((c) => c.char === '?' || c.confidence < o.repairBelow);
  if (!doubt.some(Boolean)) return null;
  let best: { text: string; score: number } | null = null;
  for (const w of LEXICON) {
    if (w.length !== tok.length) continue;
    let cost = 0;
    let ok = true;
    for (let i = 0; i < w.length && ok; i++) {
      if (w[i] === s[i]) continue;
      if (doubt[i]) cost += o.repairPenalty; else ok = false;
    }
    if (ok && (!best || cost < -best.score)) best = { text: w, score: -cost };
  }
  return best;
}

/**
 * Place word gaps (and repair doubtful letters) using timing evidence plus a vocabulary.
 *
 * The decoder only knows how long each silence was; a hand-keyed "KEEP" can contain a gap
 * longer than the one after it, so timing alone mis-splits words. This finds the split of
 * the letter stream that maximises timing agreement plus word plausibility (dictionary
 * words, callsigns and numbers score well; unknown strings are charged per character).
 */
export function segmentWords(chars: readonly DecodedChar[], opts: SegmentOptions = {}): Word[] {
  return segment(chars, opts).words;
}

/** Plausibility of a transcript: the best segmentation's score per letter (higher = more like real ham traffic). */
export function plausibility(chars: readonly DecodedChar[], opts: SegmentOptions = {}): number {
  const letters = chars.filter((c) => c.char !== ' ').length;
  return letters ? segment(chars, opts).score / letters : -Infinity;
}

function segment(chars: readonly DecodedChar[], opts: SegmentOptions): { words: Word[]; score: number } {
  const o: Required<SegmentOptions> = {
    lexiconBonus: opts.lexiconBonus ?? 2.5,
    oovPerChar: opts.oovPerChar ?? 0.7,
    repairPenalty: opts.repairPenalty ?? 1.2,
    repairBelow: opts.repairBelow ?? 0.5,
  };
  const L = chars.filter((c) => c.char !== ' ');
  const n = L.length;
  const best = new Float64Array(n + 1).fill(-Infinity);
  const from = new Int32Array(n + 1).fill(-1);
  const text: string[] = new Array(n + 1).fill('');
  best[0] = 0;
  for (let j = 1; j <= n; j++) {
    for (let i = Math.max(0, j - MAX_TOKEN); i < j; i++) {
      if (best[i] === -Infinity) continue;
      const tok = L.slice(i, j);
      const s = tok.map((c) => c.char).join('');
      let wordScore: number;
      let out = s;
      const lex = matchLexicon(tok, o);
      if (lex && (s.length > 1 || !WEAK_SINGLES.has(s) ? true : true)) {
        const single = lex.text.length === 1;
        wordScore = (single ? 0.5 : o.lexiconBonus) + lex.score;
        out = lex.text;
      } else if (/^[0-9]{1,5}$/.test(s) || /^[5][0-9N]{2}$/.test(s)) {
        wordScore = 1.5;
      } else if (/[0-9]/.test(s) && classifyCall(s) !== 'invalid') {
        wordScore = 3;
      } else if (/\?/.test(s)) {
        wordScore = -o.oovPerChar * s.length - 1.5;
      } else {
        wordScore = -o.oovPerChar * s.length;
      }
      const inside = tok.slice(0, -1).reduce((a, c) => a + boundaryScore(c).no, 0);
      const edge = j < n ? boundaryScore(L[j - 1]).yes : 0;
      const score = best[i] + wordScore + inside + edge;
      if (score > best[j]) { best[j] = score; from[j] = i; text[j] = out; }
    }
  }
  const words: Word[] = [];
  for (let j = n; j > 0; j = from[j]) words.unshift({ text: text[j], start: from[j], end: j });
  return { words, score: best[n] };
}

/** Convenience: segmented text as a string. */
export function segmentedText(chars: readonly DecodedChar[], opts?: SegmentOptions): string {
  return segmentWords(chars, opts).map((w) => w.text).join(' ');
}
