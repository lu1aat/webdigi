import { EnvelopeDetector } from '../dsp/envelope';
import { findTone } from '../dsp/tone';
import { CwDecoder, type CwDecoderOptions, type DecodedChar } from './cw-decoder';

export interface DecodeResult {
  text: string;
  chars: DecodedChar[];
  freq: number | null;
}

/** Filter width suited to a keying speed: about twice the WPM, kept within 30..120 Hz. */
export function matchedBandwidth(wpm: number, perWpm = 2): number {
  return Math.min(120, Math.max(30, perWpm * wpm));
}

/** One pass of envelope detection + decoding at a fixed filter width. */
export function decodePass(
  samples: Float32Array,
  sampleRate: number,
  freq: number,
  bandwidth: number | undefined,
  decoder: CwDecoderOptions = {},
): { chars: DecodedChar[]; wpm: number } {
  const det = new EnvelopeDetector(sampleRate, freq, bandwidth);
  const env = det.process(samples);
  const dec = new CwDecoder(det.envRate, decoder);
  dec.prime(env.subarray(0, Math.min(env.length, Math.round(det.envRate * 8))));
  return { chars: [...dec.process(env), ...dec.flush()], wpm: dec.wpm };
}

/** Offline convenience: find the strongest tone (or use `freq`), decode the whole buffer. */
export function decodeAudio(
  samples: Float32Array,
  sampleRate: number,
  opts: { freq?: number; bandwidth?: number } = {},
): DecodeResult {
  const freq = opts.freq ?? findTone(samples, sampleRate);
  if (freq === null) return { text: '', chars: [], freq: null };
  let r = decodePass(samples, sampleRate, freq, opts.bandwidth);
  // second pass with a filter matched to the sender's speed: weak short dots survive a narrower filter
  if (opts.bandwidth === undefined && r.chars.length > 8) r = decodePass(samples, sampleRate, freq, matchedBandwidth(r.wpm));
  const chars = r.chars;
  return { text: chars.map((c) => c.char).join('').trim(), chars, freq };
}
