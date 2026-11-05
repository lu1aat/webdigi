/** Runs the (slow) decoder council off the UI thread: one finished transmission per message. */
import { councilDecode } from './core/decoder/council';
import type { DecodedChar } from './core/decoder/cw-decoder';

export interface CouncilJob { id: number; samples: Float32Array; sampleRate: number; freq: number }
export interface CouncilResult { id: number; chars: DecodedChar[]; pick: string }

self.onmessage = (e: MessageEvent<CouncilJob>) => {
  const { id, samples, sampleRate, freq } = e.data;
  const r = councilDecode(samples, sampleRate, freq);
  (self as unknown as Worker).postMessage({ id, chars: r.chars, pick: r.pick } satisfies CouncilResult);
};
