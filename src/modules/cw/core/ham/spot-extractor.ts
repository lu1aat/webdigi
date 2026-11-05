import type { DecodedChar } from '../decoder/cw-decoder';
import { CallDatabase, classifyCall, passesValidation, splitCall, type ValidationLevel } from './callsign';

export interface CallHit {
  call: string;
  /** True when the call was sent after "CQ ... DE". */
  cq: boolean;
  /** Mean decoder confidence over the characters of the call, 0..1. */
  confidence: number;
}

export interface ExtractorOptions {
  level?: ValidationLevel;
  db?: CallDatabase;
  watch?: ReadonlySet<string>;
  /** Weight needed before a call is reported (a "DE x" counts 2, any other sighting 1). */
  minWeight?: number;
  /** Don't report anything below this mean confidence. */
  minConfidence?: number;
}

/**
 * Turns the character stream of one carrier into callsign sightings.
 *
 * Tokens come from word gaps. A token that validates as a callsign gains weight: 2 when
 * it directly follows "DE" (the sender), 1 otherwise. It is reported once the weight
 * reaches `minWeight`, so a one-off decode error needs a second matching sighting.
 * `cq` is set when "CQ" appeared in the last few tokens, which is what the spot feed
 * uses to separate stations calling from stations merely being worked.
 */
export class SpotExtractor {
  private tokens: { text: string; conf: number }[] = [];
  private cur = '';
  private curConf: number[] = [];
  private weights = new Map<string, number>();
  private reported = new Set<string>();
  private readonly o: Required<Omit<ExtractorOptions, 'db' | 'watch'>> & Pick<ExtractorOptions, 'db' | 'watch'>;

  constructor(opts: ExtractorOptions = {}) {
    this.o = {
      level: opts.level ?? 'normal',
      minWeight: opts.minWeight ?? 2,
      minConfidence: opts.minConfidence ?? 0.5,
      db: opts.db,
      watch: opts.watch,
    };
  }

  push(chars: readonly DecodedChar[]): CallHit[] {
    const hits: CallHit[] = [];
    for (const c of chars) {
      if (c.char === ' ') {
        this.endToken(hits);
      } else {
        this.cur += c.char;
        this.curConf.push(c.confidence);
      }
    }
    return hits;
  }

  /** Close the open token (call when the carrier goes quiet or retires). */
  flush(): CallHit[] {
    const hits: CallHit[] = [];
    this.endToken(hits);
    return hits;
  }

  private endToken(hits: CallHit[]): void {
    if (!this.cur) return;
    const conf = this.curConf.reduce((a, b) => a + b, 0) / this.curConf.length;
    this.tokens.push({ text: this.cur, conf });
    this.cur = '';
    this.curConf = [];
    if (this.tokens.length > 12) this.tokens.shift();
    const i = this.tokens.length - 1;
    const tok = this.tokens[i];
    if (classifyCall(tok.text) === 'invalid' || !/[0-9]/.test(tok.text)) return;
    if (!passesValidation(tok.text, this.o.level, this.o.db, this.o.watch)) return;
    const afterDe = i > 0 && this.tokens[i - 1].text === 'DE';
    const cq = afterDe && this.tokens.slice(Math.max(0, i - 6), i).some((t) => t.text === 'CQ' || t.text === 'TEST');
    const base = splitCall(tok.text)?.base ?? tok.text;
    const w = (this.weights.get(base) ?? 0) + (afterDe ? 2 : 1);
    this.weights.set(base, w);
    if (w >= this.o.minWeight && conf >= this.o.minConfidence && (!this.reported.has(base) || cq)) {
      this.reported.add(base);
      hits.push({ call: tok.text, cq, confidence: conf });
    }
  }
}
