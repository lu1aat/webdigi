import { describe, expect, it } from 'vitest';
import { CarrierTracker } from '../../src/modules/cw/core/skimmer/carrier-tracker';

const ROW_RATE = 20;
// After the tracker's ~2 s warm-up, which learns the noise floor (a carrier already on then would be learnt as floor).
const CARRIER_ON = 3;
const CARRIER_OFF = 7;

/**
 * A steady carrier (30 dB over a flat floor) from CARRIER_ON to CARRIER_OFF, then silence: returns the
 * seconds from the carrier stopping to its track being retired. `changeTo` switches the hold time
 * while the carrier is still on.
 */
function lingers(holdSeconds: number, changeTo?: number): number {
  const tr = new CarrierTracker(64, 10, 0, ROW_RATE, { holdSeconds, retireSeconds: 1 });
  const row = new Float32Array(64);
  let spawned = false;
  for (let i = 0; i < 30 * ROW_RATE; i++) {
    const t = i / ROW_RATE;
    if (changeTo !== undefined && i === 5 * ROW_RATE) tr.setHoldSeconds(changeTo);
    row.fill(1);
    if (t >= CARRIER_ON && t < CARRIER_OFF) row[30] = 1000;
    const r = tr.push(row, t);
    spawned ||= r.spawned.length > 0;
    if (r.retired.length) {
      expect(spawned).toBe(true);
      return t - CARRIER_OFF;
    }
  }
  return Infinity;
}

describe('carrier tracker hold time', () => {
  it('keeps a stopped carrier longer with a longer hold', () => {
    const short = lingers(0.3);
    const long = lingers(2);
    expect(short).toBeLessThan(2.5);
    expect(long).toBeGreaterThan(short + 4);
    expect(long).toBeLessThan(15);
  });

  it('applies a hold change while running', () => {
    const changed = lingers(0.3, 2);
    expect(changed).toBeLessThan(15);
    expect(changed).toBeCloseTo(lingers(2), 5);
  });
});
