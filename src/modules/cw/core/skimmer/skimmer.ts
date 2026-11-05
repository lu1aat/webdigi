import { CwDecoder, type DecodedChar } from '../decoder/cw-decoder';
import { matchedBandwidth } from '../decoder/decode-audio';
import { EnvelopeDetector } from '../dsp/envelope';
import { NoiseBlanker } from '../dsp/noise-blanker';
import { Spectrogram, type SpectrogramOptions } from '../dsp/stft';
import { segmentWords } from '../ham/segment';
import { SpotExtractor, type ExtractorOptions } from '../ham/spot-extractor';
import { CarrierTracker, type Track, type TrackerOptions } from './carrier-tracker';

export interface Spot {
  channel: number;
  call: string;
  freq: number;
  snr: number;
  wpm: number;
  cq: boolean;
  confidence: number;
  time: number;
}

export interface Channel {
  id: number;
  track: Track;
  wpm: number;
  /** Rolling decoded text with per-character confidence. */
  chars: DecodedChar[];
  /** Council re-decoding of the latest finished transmission (see `bursts`), when one was submitted. */
  refined?: DecodedChar[];
}

/** A finished transmission on one carrier, with its audio, for a slower and better second look. */
export interface Burst {
  id: number;
  channel: Channel;
  freq: number;
  /** Seconds since the start of the stream. */
  start: number;
  end: number;
  samples: Float32Array;
  sampleRate: number;
  /** What the live decoder read in this stretch. */
  live: DecodedChar[];
}

export type SkimmerEvent =
  | { type: 'spawn'; channel: Channel }
  | { type: 'chars'; channel: Channel; chars: DecodedChar[] }
  | { type: 'spot'; spot: Spot }
  | { type: 'retire'; channel: Channel }
  /** The carrier produced text no operator would send (noise tone, static): drop it and ignore that frequency for a while. */
  | { type: 'reject'; channel: Channel }
  /** A transmission ended (only with `bursts: true`). Decode `burst.samples` with the council and call `submitRefined`. */
  | { type: 'burst'; burst: Burst }
  | { type: 'refined'; channel: Channel; burst: number; chars: DecodedChar[] };

export interface SkimmerOptions {
  spectrogram?: SpectrogramOptions;
  tracker?: TrackerOptions;
  extractor?: ExtractorOptions;
  noiseBlanker?: boolean;
  /** Emit a 'burst' event with the audio of each finished transmission, for council re-decoding. */
  bursts?: boolean;
  /** Receive bandwidth of each CW decoder, Hz. */
  bandwidth?: number;
  /** Called for every spectrogram row (waterfall). `row` is reused: copy it if you keep it. */
  onRow?: (row: Float32Array, time: number) => void;
}

interface Live {
  channel: Channel;
  det: EnvelopeDetector;
  dec: CwDecoder;
  extractor: SpotExtractor;
  /** Stream time (s) of decoder time 0: decoder char times are relative to the start of the replayed history. */
  t0: number;
  /** Stream time (s) when the channel last (re)started. */
  born: number;
  letters: number;
  shortLetters: number;
  burst: { chars: DecodedChar[]; last: number } | null;
  /** Picked by the user, not found by the tracker: never rejected as noise, never followed, never retired by silence. */
  manual?: boolean;
}

const KEEP_CHARS = 400;
const REPLAY_SECONDS = 12;
const START_BANDWIDTH = 60;
/** Audio kept for burst re-decoding. */
const BURST_RING_SECONDS = 90;
const BURST_MIN_LETTERS = 6;
const BURST_IDLE_SECONDS = 2.5;
const BURST_MAX_SECONDS = 45;
const BURST_ABANDON_SECONDS = 12;
/** Letters a CW operator sends most often are not 'E I S T H 5 ?'-only: a channel made of them is noise. */
const SUSPECT_MIN_LETTERS = 8;
const SUSPECT_SHORT_RATIO = 0.75;
const SHORT_LETTERS = new Set(['E', 'I', 'S', 'T', 'H', '5', '?']);
const BAN_SECONDS = 90;
/** Track moved this far from the channel's carrier: retune (small) or restart from history (large). */
const RETUNE_HZ = 3;
const RESPAWN_HZ = 25;
/** A track's frequency is trusted to settle within this many seconds of its channel starting. */
const SETTLE_SECONDS = 8;
const SPOT_REPEAT_SECONDS = 60;
/** Ids of user-picked channels start here so they never collide with tracker ids. */
const MANUAL_ID_BASE = 1_000_000;

/**
 * Multi-carrier CW skimmer: spectrogram -> carrier tracker -> one decoder per carrier.
 *
 * Detecting a carrier takes about a second, so the last REPLAY_SECONDS of audio are
 * kept and replayed into a new carrier's decoder: the start of its message isn't lost.
 */
export class Skimmer {
  readonly spectrogram: Spectrogram;
  readonly tracker: CarrierTracker;
  private readonly nb: NoiseBlanker | null;
  private readonly live = new Map<number, Live>();
  private readonly ring: Float32Array;
  private ringPos = 0;
  private samples = 0;
  private events: SkimmerEvent[] = [];
  private readonly lastSpot = new Map<string, number>();
  private readonly spotAt: { freq: number; time: number }[] = [];
  private nextBurst = 1;
  private nextManual = MANUAL_ID_BASE;

  constructor(readonly sampleRate: number, private readonly opts: SkimmerOptions = {}) {
    this.spectrogram = new Spectrogram(sampleRate, opts.spectrogram);
    const s = this.spectrogram;
    this.tracker = new CarrierTracker(s.bins, s.binHz, s.firstBin, s.rowRate, opts.tracker);
    this.nb = opts.noiseBlanker ? new NoiseBlanker(sampleRate) : null;
    this.ring = new Float32Array(Math.round(sampleRate * (opts.bursts ? BURST_RING_SECONDS : REPLAY_SECONDS)));
  }

  get time(): number {
    return this.samples / this.sampleRate;
  }

  get channels(): Channel[] {
    return [...this.live.values()].map((l) => l.channel);
  }

  /** Feed audio samples; returns what happened (new carriers, text, spots, retired carriers). */
  process(input: Float32Array): SkimmerEvent[] {
    this.events = [];
    const x = this.nb ? this.nb.process(input) : input;
    // 1. detection (may create channels, replaying history that does NOT yet include x)
    this.spectrogram.process(x, (row) => {
      const t = this.time;
      this.opts.onRow?.(row, t);
      const { spawned, retired } = this.tracker.push(row, t);
      for (const tr of retired) this.retire(tr.id);
      for (const tr of spawned) this.spawn(tr);
    });
    // 2. decoding of this block by all channels
    for (const l of [...this.live.values()]) { this.follow(l); this.feed(this.live.get(l.channel.id) ?? l, x); }
    // 3. history
    for (let i = 0; i < x.length; i++) {
      this.ring[this.ringPos] = x[i];
      this.ringPos = (this.ringPos + 1) % this.ring.length;
    }
    this.samples += x.length;
    if (this.opts.bursts) this.checkBursts();
    return this.events;
  }

  /**
   * Decode whatever is on `freq` whether or not the tracker sees a carrier there: the user's pick.
   * Only one manual channel exists at a time; the previous one is retired. The recent history is replayed into it.
   */
  addManual(freq: number): Channel {
    for (const [id, l] of this.live) if (l.manual) this.retire(id);
    const now = this.time;
    const track: Track = { id: this.nextManual++, freq, snr: 0, firstSeen: now - REPLAY_SECONDS, lastSeen: now };
    this.spawn(track, undefined, true);
    return this.live.get(track.id)!.channel;
  }

  /** Close all channels (end of file): flushes pending characters and spots. */
  finish(): SkimmerEvent[] {
    this.events = [];
    for (const id of [...this.live.keys()]) this.retire(id);
    return this.events;
  }

  /**
   * Hand back the council's decoding of a burst. It replaces the live text of that stretch in
   * `channel.refined` and, being more reliable, can confirm callsigns on its own.
   */
  submitRefined(burst: Burst, chars: DecodedChar[]): SkimmerEvent[] {
    this.events = [];
    burst.channel.refined = chars;
    this.events.push({ type: 'refined', channel: burst.channel, burst: burst.id, chars });
    const ex = new SpotExtractor({ ...this.opts.extractor, minWeight: 1, minConfidence: 0.6 });
    const words = segmentWords(chars);
    const spaced: DecodedChar[] = [];
    for (const w of words) {
      for (let k = 0; k < w.text.length; k++) spaced.push({ ...chars.filter((c) => c.char !== ' ')[w.start + k], char: w.text[k] });
      spaced.push({ char: ' ', confidence: 1, time: 0, wpm: 0 });
    }
    // a lone callsign-shaped token is too often a misread: require a CQ context or a repetition
    const seen = new Map<string, number>();
    for (const w of words) seen.set(w.text, (seen.get(w.text) ?? 0) + 1);
    const hits = [...ex.push(spaced), ...ex.flush()].filter((h) => h.cq || (seen.get(h.call) ?? 0) >= 2);
    const live = this.live.get(burst.channel.id);
    const now = this.time;
    // the live decoder already named the station on this frequency: a second, different call would be a misread of it
    const known = this.spotAt.some((q) => Math.abs(q.freq - burst.freq) < 30 && now - q.time < 120);
    for (const h of known ? [] : hits) {
      const last = this.lastSpot.get(h.call);
      if (last !== undefined && now - last < SPOT_REPEAT_SECONDS) continue;
      this.lastSpot.set(h.call, now);
      this.spotAt.push({ freq: burst.freq, time: now });
      this.events.push({
        type: 'spot',
        spot: { channel: burst.channel.id, call: h.call, freq: burst.freq, snr: burst.channel.track.snr, wpm: live?.dec.wpm ?? burst.channel.wpm, cq: h.cq, confidence: h.confidence, time: now },
      });
    }
    return this.events;
  }

  private history(seconds: number): Float32Array {
    const n = Math.min(this.ring.length, Math.round(seconds * this.sampleRate), this.samples);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = this.ring[(this.ringPos - n + i + this.ring.length * 2) % this.ring.length];
    return out;
  }

  private spawn(track: Track, reuse?: Channel, manual = false): void {
    const hist = this.history(Math.min(this.ring.length / this.sampleRate, this.time - track.firstSeen + 3, REPLAY_SECONDS));
    // a trial pass over the replayed audio gives the sender's speed, so the real decoder starts with a matched filter
    let bandwidth = this.opts.bandwidth;
    if (bandwidth === undefined && hist.length) {
      const td = new EnvelopeDetector(this.sampleRate, track.freq);
      const te = td.process(hist);
      const trial = new CwDecoder(td.envRate);
      trial.prime(te);
      trial.process(te);
      // before the speed is known use a middle width: wide filters smear weak short dots, narrow ones smear fast CW
      bandwidth = trial.ready ? matchedBandwidth(trial.wpm) : START_BANDWIDTH;
    }
    const det = new EnvelopeDetector(this.sampleRate, track.freq, bandwidth);
    const dec = new CwDecoder(det.envRate);
    const channel: Channel = reuse ?? { id: track.id, track, wpm: 0, chars: [] };
    if (reuse) { channel.chars = []; channel.refined = undefined; }
    const l: Live = {
      channel, det, dec, extractor: new SpotExtractor(this.opts.extractor),
      t0: this.time - hist.length / this.sampleRate, born: this.time, letters: 0, shortLetters: 0, burst: null, manual,
    };
    this.live.set(track.id, l);
    this.events.push({ type: 'spawn', channel });
    if (hist.length) {
      const env = l.det.process(hist);
      l.dec.prime(env);
      this.consume(l, l.dec.process(env), this.time);
    }
  }

  /**
   * Keep a channel on its carrier. A track's frequency settles over its first seconds (the first
   * peak can be a start-up transient a bin away) and real carriers drift: follow small moves by
   * retuning the detector, and start over from the replay history after a big jump.
   */
  private follow(l: Live): void {
    if (l.manual) return;
    const f = l.channel.track.freq;
    const d = Math.abs(f - l.det.tunedFreq);
    // Later a track can be pulled towards a close neighbour that starts keying, so an established channel stays put.
    if (this.time - l.born >= SETTLE_SECONDS) return;
    if (d >= RESPAWN_HZ) {
      this.live.delete(l.channel.id);
      this.spawn(l.channel.track, l.channel);
    } else if (d >= RETUNE_HZ) l.det.setFrequency(f);
  }

  private retire(id: number): void {
    const l = this.live.get(id);
    if (!l) return;
    this.live.delete(id);
    this.consume(l, l.dec.flush(), this.time);
    this.consume(l, [], this.time, l.extractor.flush());
    if (this.opts.bursts) this.closeBurst(l);
    this.events.push({ type: 'retire', channel: l.channel });
  }

  /**
   * Remove a station on the user's request: forget it without flushing text or submitting a burst, and
   * ignore its frequency for `banSeconds` so the tracker does not rediscover it at once.
   */
  remove(id: number, banSeconds = BAN_SECONDS): void {
    const l = this.live.get(id);
    if (!l) return;
    this.live.delete(id);
    this.tracker.drop(id);
    this.tracker.ban(l.channel.track.freq, this.time + banSeconds);
  }

  private reject(l: Live): void {
    this.live.delete(l.channel.id);
    this.tracker.drop(l.channel.id);
    this.tracker.ban(l.channel.track.freq, this.time + BAN_SECONDS);
    this.events.push({ type: 'reject', channel: l.channel });
  }

  private checkBursts(): void {
    for (const l of this.live.values()) {
      const b = l.burst;
      if (!b) continue;
      const idle = this.time - b.last;
      const long = this.time - (l.t0 + b.chars[0].time) > BURST_MAX_SECONDS;
      // a weak signal reads only a few letters at a time: keep a short burst open (up to BURST_ABANDON_SECONDS) so the pieces join up
      if (long || (idle > BURST_IDLE_SECONDS && b.chars.length >= BURST_MIN_LETTERS) || idle > BURST_ABANDON_SECONDS) this.closeBurst(l);
    }
  }

  private closeBurst(l: Live): void {
    const b = l.burst;
    l.burst = null;
    if (!b || b.chars.length < BURST_MIN_LETTERS) return;
    const start = Math.max(0, l.t0 + b.chars[0].time - 3);
    const end = Math.min(this.time, b.last + 1);
    const samples = this.slice(start, end);
    if (samples.length < this.sampleRate) return;
    this.events.push({
      type: 'burst',
      burst: { id: this.nextBurst++, channel: l.channel, freq: l.det.tunedFreq, start, end, samples, sampleRate: this.sampleRate, live: b.chars },
    });
  }

  /** Audio between two stream times, as far as the ring still holds it. */
  private slice(start: number, end: number): Float32Array {
    const have = Math.min(this.ring.length, this.samples);
    const endIdx = Math.min(this.samples, Math.round(end * this.sampleRate));
    const startIdx = Math.max(this.samples - have, Math.round(start * this.sampleRate));
    const n = Math.max(0, endIdx - startIdx);
    const out = new Float32Array(n);
    const back = this.samples - startIdx; // samples from the live edge back to start
    for (let i = 0; i < n; i++) out[i] = this.ring[(this.ringPos - back + i + this.ring.length * 2) % this.ring.length];
    return out;
  }

  private feed(l: Live, x: Float32Array): void {
    // follow the sender's speed with the filter width (unless the caller fixed it)
    if (this.opts.bandwidth === undefined && l.dec.ready) l.det.setBandwidth(matchedBandwidth(l.dec.wpm));
    const env = l.det.process(x);
    this.consume(l, l.dec.process(env), this.time + x.length / this.sampleRate);
  }

  private consume(l: Live, chars: DecodedChar[], now: number, extra: ReturnType<SpotExtractor['flush']> = []): void {
    if (chars.length) {
      if (this.opts.bursts) {
        const letters = chars.filter((c) => c.char !== ' ');
        if (letters.length) {
          l.burst ??= { chars: [], last: 0 };
          l.burst.chars.push(...letters);
          l.burst.last = this.time;
        }
      }
      for (const c of chars) if (c.char !== ' ') { l.letters++; if (SHORT_LETTERS.has(c.char)) l.shortLetters++; }
      if (!l.manual && l.letters >= SUSPECT_MIN_LETTERS && l.shortLetters / l.letters >= SUSPECT_SHORT_RATIO) return this.reject(l);
      l.channel.chars.push(...chars);
      if (l.channel.chars.length > KEEP_CHARS) l.channel.chars.splice(0, l.channel.chars.length - KEEP_CHARS);
      l.channel.wpm = l.dec.wpm;
      this.events.push({ type: 'chars', channel: l.channel, chars });
    }
    for (const h of [...l.extractor.push(chars), ...extra]) {
      // one spot per call per SPOT_REPEAT_SECONDS, however often it is repeated on air
      const last = this.lastSpot.get(h.call);
      if (last !== undefined && now - last < SPOT_REPEAT_SECONDS) continue;
      this.lastSpot.set(h.call, now);
      this.spotAt.push({ freq: l.det.tunedFreq, time: now });
      this.events.push({
        type: 'spot',
        spot: {
          channel: l.channel.id, call: h.call, freq: l.det.tunedFreq, snr: l.channel.track.snr,
          wpm: l.dec.wpm, cq: h.cq, confidence: h.confidence, time: now,
        },
      });
    }
  }
}
