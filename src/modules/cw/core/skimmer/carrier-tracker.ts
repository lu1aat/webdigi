export interface Track {
  id: number;
  /** Refined carrier frequency, Hz. */
  freq: number;
  /** Rough SNR in a 2.5 kHz reference bandwidth, dB. */
  snr: number;
  firstSeen: number;
  lastSeen: number;
}

export interface TrackerOptions {
  /** Peak must exceed the noise floor by this many dB (in max-hold) to count. */
  thresholdDb?: number;
  /** Evaluations (every ~0.1 s) a peak must persist before a track is created. */
  confirmHits?: number;
  /** A candidate weaker than weakSnrDb must persist this many evaluations: a lone noise blip lasts about one hold time, a station keeps coming back. */
  weakConfirmHits?: number;
  weakSnrDb?: number;
  /** Seconds without a refresh before a track is retired. */
  retireSeconds?: number;
  /** Peaks this many dB below a stronger peak within ghostHz are treated as key-click sidebands. */
  ghostDb?: number;
  ghostHz?: number;
  /** Same, at any distance: broadband clicks of a very strong signal reach far from the carrier. */
  farGhostDb?: number;
  maxTracks?: number;
  /** This many weak tracks confirmed within burstSeconds is a broadband burst (static crash, AGC recovery), not stations. */
  burstCount?: number;
  burstSeconds?: number;
  /** Tracks stronger than this (dB, 2.5 kHz reference) are never dropped as part of a burst. */
  burstMaxSnrDb?: number;
}

interface Candidate {
  bin: number;
  hits: number;
  firstSeen: number;
  missed: number;
}

/**
 * Finds and follows CW carriers in a stream of power-spectrum rows.
 *
 * Noise floor per bin = slow, outlier-clipped average. Since CW keys on and off, a
 * decaying max-hold (~0.8 s) stands in for "is something keyed here recently".
 * A local maximum above the floor that persists becomes a track; a track that has not
 * been seen for a few seconds is retired. Peaks sitting well below a much stronger
 * neighbour are ignored: those are key-click sidebands, not stations.
 */
export class CarrierTracker {
  private readonly o: Required<TrackerOptions>;
  private floor: Float64Array;
  private hold: Float64Array;
  private rows = 0;
  private sinceEval = 0;
  private readonly evalEvery: number;
  private readonly decay: number;
  private readonly snrOffsetDb: number;
  private nextId = 1;
  private recentSpawns: Track[] = [];
  private bans: { freq: number; until: number }[] = [];
  private candidates: Candidate[] = [];
  readonly tracks = new Map<number, Track>();

  constructor(
    private readonly bins: number,
    private readonly binHz: number,
    private readonly firstBin: number,
    rowRate: number,
    opts: TrackerOptions = {},
  ) {
    this.o = {
      thresholdDb: opts.thresholdDb ?? 13,
      confirmHits: opts.confirmHits ?? 8,
      retireSeconds: opts.retireSeconds ?? 8,
      ghostDb: opts.ghostDb ?? 20,
      ghostHz: opts.ghostHz ?? 150,
      farGhostDb: opts.farGhostDb ?? 32,
      maxTracks: opts.maxTracks ?? 64,
      weakConfirmHits: opts.weakConfirmHits ?? 25,
      weakSnrDb: opts.weakSnrDb ?? 3,
      burstCount: opts.burstCount ?? 3,
      burstSeconds: opts.burstSeconds ?? 1.2,
      burstMaxSnrDb: opts.burstMaxSnrDb ?? 4,
    };
    this.floor = new Float64Array(bins);
    this.hold = new Float64Array(bins);
    this.evalEvery = Math.max(1, Math.round(rowRate * 0.1));
    this.decay = Math.exp(-1 / (0.8 * rowRate));
    this.snrOffsetDb = 10 * Math.log10(2500 / (1.5 * binHz));
  }

  /** Noise floor (linear power per bin), for display. */
  get noiseFloor(): Float64Array {
    return this.floor;
  }

  /** Feed one row at time `t` (s). Returns tracks created and retired by this row. */
  push(row: Float32Array, t: number): { spawned: Track[]; retired: Track[] } {
    const spawned: Track[] = [];
    const retired: Track[] = [];
    const warm = this.rows < 40;
    const a = warm ? 0.05 : 0.002;
    for (let k = 0; k < this.bins; k++) {
      const p = row[k];
      if (warm) this.floor[k] += a * (p - this.floor[k]);
      else if (p < 4 * this.floor[k]) this.floor[k] += a * (p - this.floor[k]);
      this.hold[k] = Math.max(p, this.hold[k] * this.decay);
    }
    this.rows++;
    if (warm || ++this.sinceEval < this.evalEvery) return { spawned, retired };
    this.sinceEval = 0;

    const peaks = this.findPeaks();
    const seen = new Set<number>();
    for (const pk of peaks) {
      const track = this.nearestTrack(pk.freq);
      if (track) {
        track.freq += 0.15 * (pk.freq - track.freq);
        track.snr += 0.3 * (pk.snr - track.snr);
        track.lastSeen = t;
        seen.add(track.id);
        continue;
      }
      if (this.tracks.size >= this.o.maxTracks) continue;
      if (this.bans.some((b) => b.until > t && Math.abs(b.freq - pk.freq) < 3 * this.binHz)) continue;
      const c = this.candidates.find((x) => Math.abs(x.bin - pk.bin) <= 1);
      if (c) {
        c.bin = pk.bin; c.hits++; c.missed = 0;
        if (c.hits >= (pk.snr < this.o.weakSnrDb ? this.o.weakConfirmHits : this.o.confirmHits)) {
          const tr: Track = { id: this.nextId++, freq: pk.freq, snr: pk.snr, firstSeen: c.firstSeen, lastSeen: t };
          this.tracks.set(tr.id, tr);
          spawned.push(tr);
          this.candidates = this.candidates.filter((x) => x !== c);
        }
      } else {
        this.candidates.push({ bin: pk.bin, hits: 1, firstSeen: t, missed: 0 });
      }
    }
    // age out candidates that stopped appearing
    for (const c of this.candidates) if (!peaks.some((p) => Math.abs(p.bin - c.bin) <= 1)) c.missed++;
    this.candidates = this.candidates.filter((c) => c.missed < 2);

    this.dropBursts(t, spawned);
    for (const tr of [...this.tracks.values()]) {
      if (t - tr.lastSeen > this.o.retireSeconds) {
        this.tracks.delete(tr.id);
        retired.push(tr);
      }
    }
    return { spawned, retired };
  }

  /** Weak tracks that all appear at once are one broadband event, not several stations. */
  private dropBursts(t: number, spawned: Track[]): void {
    this.recentSpawns = this.recentSpawns.filter((tr) => t - tr.firstSeen <= this.o.burstSeconds && this.tracks.has(tr.id));
    this.recentSpawns.push(...spawned);
    const weak = this.recentSpawns.filter((tr) => tr.snr < this.o.burstMaxSnrDb);
    if (weak.length < this.o.burstCount) return;
    for (const tr of weak) {
      this.tracks.delete(tr.id);
      const k = spawned.indexOf(tr);
      if (k >= 0) spawned.splice(k, 1);
    }
    this.recentSpawns = this.recentSpawns.filter((tr) => !weak.includes(tr));
  }

  /** Stop creating tracks near `freq` until time `until` (a tone that turned out not to be a station). */
  ban(freq: number, until: number): void {
    this.bans = this.bans.filter((b) => b.until > until - 1e6 && Math.abs(b.freq - freq) > this.binHz);
    this.bans.push({ freq, until });
  }

  /** Forget a track without reporting it as retired. */
  drop(id: number): void {
    this.tracks.delete(id);
  }

  private nearestTrack(freq: number): Track | undefined {
    let best: Track | undefined;
    let bd = 1.6 * this.binHz;
    for (const tr of this.tracks.values()) {
      const d = Math.abs(tr.freq - freq);
      if (d < bd) { bd = d; best = tr; }
    }
    return best;
  }

  private findPeaks(): { bin: number; freq: number; snr: number }[] {
    const thr = 10 ** (this.o.thresholdDb / 10);
    const h = this.hold;
    const raw: { bin: number; power: number; ratio: number }[] = [];
    for (let k = 2; k < this.bins - 2; k++) {
      const f = this.floor[k] || 1e-20;
      if (h[k] / f < thr) continue;
      if (h[k] < h[k - 1] || h[k] < h[k + 1] || h[k] < h[k - 2] || h[k] < h[k + 2]) continue;
      raw.push({ bin: k, power: h[k], ratio: h[k] / f });
    }
    const ghostRatio = 10 ** (this.o.ghostDb / 10);
    const ghostBins = this.o.ghostHz / this.binHz;
    const farRatio = 10 ** (this.o.farGhostDb / 10);
    const kept = raw.filter(
      (p) => !raw.some((q) => q !== p && q.power > p.power * (Math.abs(q.bin - p.bin) <= ghostBins ? ghostRatio : farRatio)),
    );
    return kept.map((p) => {
      const a = Math.log(h[p.bin - 1] + 1e-30);
      const b = Math.log(h[p.bin] + 1e-30);
      const c = Math.log(h[p.bin + 1] + 1e-30);
      const d = a - 2 * b + c;
      const shift = d === 0 ? 0 : Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d));
      return {
        bin: p.bin,
        freq: (this.firstBin + p.bin + shift) * this.binHz,
        snr: 10 * Math.log10(p.ratio) - this.snrOffsetDb,
      };
    });
  }
}
