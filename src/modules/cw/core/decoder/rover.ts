import type { DecodedChar } from './cw-decoder';

interface Slot {
  votes: Map<string, number>;
  members: { c: DecodedChar; w: number }[];
}

export interface VoteOptions {
  /** Winning character must hold at least this share of the total weight to be kept (else the slot is dropped as an insertion). */
  keepShare?: number;
}

/**
 * ROVER-style combination of several decodings of the same signal.
 *
 * Sequences (word gaps ignored) are aligned one by one onto a growing slot network with
 * edit-distance costs that favour matching what the network already believes; each slot then
 * keeps the character with the most weight. A slot most members skipped is dropped, so one
 * member's spurious letter doesn't survive. Confidence is the winner's share of all weight.
 */
export function vote(seqs: readonly (readonly DecodedChar[])[], weights: readonly number[] = [], opts: VoteOptions = {}): DecodedChar[] {
  const keepShare = opts.keepShare ?? 0.5;
  const letters = seqs.map((s) => s.filter((c) => c.char !== ' '));
  const slots: Slot[] = [];
  let total = 0;
  letters.forEach((seq, m) => {
    const w = weights[m] ?? 1;
    const n = slots.length;
    const k = seq.length;
    // dp[i][j]: cost of aligning first i letters of seq with first j slots
    const dp = Array.from({ length: k + 1 }, () => new Float64Array(n + 1));
    const bt = Array.from({ length: k + 1 }, () => new Uint8Array(n + 1)); // 1 diag, 2 insert letter, 3 skip slot
    for (let j = 1; j <= n; j++) { dp[0][j] = dp[0][j - 1] + 1 - missShare(slots[j - 1], total); bt[0][j] = 3; }
    for (let i = 1; i <= k; i++) { dp[i][0] = dp[i - 1][0] + 1; bt[i][0] = 2; }
    for (let i = 1; i <= k; i++) {
      for (let j = 1; j <= n; j++) {
        const sub = dp[i - 1][j - 1] + 1 - (total ? (slots[j - 1].votes.get(seq[i - 1].char) ?? 0) / total : 0);
        const ins = dp[i - 1][j] + 1;
        const skip = dp[i][j - 1] + 1 - missShare(slots[j - 1], total);
        let best = sub, b = 1;
        if (skip < best) { best = skip; b = 3; }
        if (ins < best) { best = ins; b = 2; }
        dp[i][j] = best; bt[i][j] = b;
      }
    }
    // trace back, building the merged slot list
    const merged: Slot[] = [];
    let i = k, j = n;
    while (i > 0 || j > 0) {
      const b = i === 0 ? 3 : j === 0 ? 2 : bt[i][j];
      if (b === 1) {
        const s = slots[j - 1];
        s.votes.set(seq[i - 1].char, (s.votes.get(seq[i - 1].char) ?? 0) + w);
        s.members.push({ c: seq[i - 1], w });
        merged.push(s); i--; j--;
      } else if (b === 2) {
        merged.push({ votes: new Map([[seq[i - 1].char, w]]), members: [{ c: seq[i - 1], w }] }); i--;
      } else { merged.push(slots[j - 1]); j--; }
    }
    slots.length = 0;
    slots.push(...merged.reverse());
    total += w;
  });

  const out: DecodedChar[] = [];
  for (const s of slots) {
    let bestC = '';
    let bestW = 0;
    for (const [c, w] of s.votes) if (w > bestW) { bestW = w; bestC = c; }
    if (bestW / total < keepShare) continue;
    const mem = s.members.filter((m) => m.c.char === bestC);
    const wsum = mem.reduce((a, m) => a + m.w, 0);
    const avg = (f: (c: DecodedChar) => number) => mem.reduce((a, m) => a + m.w * f(m.c), 0) / wsum;
    const pw = mem.filter((m) => m.c.pWordAfter !== undefined);
    out.push({
      char: bestC,
      confidence: (bestW / total) * avg((c) => c.confidence),
      time: avg((c) => c.time),
      wpm: avg((c) => c.wpm),
      gapAfter: pw.length ? pw.reduce((a, m) => a + m.w * Math.min(m.c.gapAfter ?? 0, 5), 0) / pw.reduce((a, m) => a + m.w, 0) : undefined,
      pWordAfter: pw.length ? pw.reduce((a, m) => a + m.w * m.c.pWordAfter!, 0) / pw.reduce((a, m) => a + m.w, 0) : undefined,
    });
  }
  return out;
}

function missShare(s: Slot, total: number): number {
  if (!total) return 0;
  let present = 0;
  for (const w of s.votes.values()) present += w;
  return Math.max(0, total - present) / total;
}
