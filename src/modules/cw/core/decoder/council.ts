import type { CwDecoderOptions, DecodedChar } from './cw-decoder';
import { decodePass, matchedBandwidth } from './decode-audio';
import { hsmmDecode, type HsmmOptions } from './hsmm';
import { plausibility } from '../ham/segment';
import { vote } from './rover';

/** What every member gets: the carrier's audio plus the speed seen by a scout pass. */
export interface MemberInput {
  samples: Float32Array;
  sampleRate: number;
  freq: number;
  wpm: number;
}

/** One voter: any decoder (or chain of decoders) that turns audio at a known carrier into letters. */
export interface Member {
  name: string;
  weight?: number;
  run(input: MemberInput): DecodedChar[];
}

/** The threshold decoder with a given filter width (per WPM) and settings. */
export function thresholdMember(name: string, bwPerWpm: number, decoder: CwDecoderOptions = {}, weight = 1): Member {
  return {
    name, weight,
    run: ({ samples, sampleRate, freq, wpm }) => decodePass(samples, sampleRate, freq, matchedBandwidth(wpm, bwPerWpm), decoder).chars,
  };
}

/** The semi-Markov decoder: joint segmentation of the raw envelope, no hard threshold. */
export function hsmmMember(name = 'hsmm', opts: Omit<HsmmOptions, 'wpmHint' | 'bandwidth'> & { bwPerWpm?: number } = {}, weight = 1.5): Member {
  return {
    name, weight,
    run: ({ samples, sampleRate, freq, wpm }) =>
      hsmmDecode(samples, sampleRate, freq, { ...opts, wpmHint: wpm, bandwidth: matchedBandwidth(wpm, opts.bwPerWpm ?? 1.5) }),
  };
}

export const DEFAULT_MEMBERS: readonly Member[] = [
  hsmmMember('hsmm-steady'),
  hsmmMember('hsmm-tracking', { carrierWindow: 0.7, carrierQuantile: 0.92, floorFraction: 0.5 }),
  thresholdMember('threshold-1.5x', 1.5),
];

export interface CouncilResult {
  /** The chosen transcript: the most plausible of the members' own and their vote. */
  chars: DecodedChar[];
  text: string;
  /** Letter-by-letter vote of all members, for comparison. */
  voted: DecodedChar[];
  /** Which candidate won ('vote' or a member name). */
  pick: string;
  members: { name: string; text: string; chars: DecodedChar[] }[];
}

/**
 * Decode one carrier with several decoders and let them vote letter by letter. A scout pass
 * (default width) gives the speed that members use as a starting point.
 */
export function councilDecode(
  samples: Float32Array,
  sampleRate: number,
  freq: number,
  members: readonly Member[] = DEFAULT_MEMBERS,
): CouncilResult {
  const scout = decodePass(samples, sampleRate, freq, undefined);
  const wpm = scout.chars.length > 8 ? scout.wpm : 20;
  const runs = members.map((m) => {
    const chars = m.run({ samples, sampleRate, freq, wpm });
    return { name: m.name, chars, text: chars.map((c) => c.char).join('').trim() };
  });
  const voted = vote(runs.map((r) => r.chars), members.map((m) => m.weight ?? 1));
  // a decoder that tracked noise produces strings no operator would send: let the language model arbitrate
  const cands = [{ name: 'vote', chars: voted }, ...runs.map((r) => ({ name: r.name, chars: r.chars }))];
  let win = cands[0];
  let ws = -Infinity;
  for (const c of cands) { const s = plausibility(c.chars); if (s > ws) { ws = s; win = c; } }
  return { chars: win.chars, text: win.chars.map((c) => c.char).join(''), voted, pick: win.name, members: runs };
}
