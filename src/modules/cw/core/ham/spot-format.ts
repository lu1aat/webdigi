import type { Spot } from '../skimmer/skimmer';

/** `1234Z` style UTC stamp. */
export function utcStamp(d: Date): string {
  return `${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
}

/**
 * One DX-cluster / Reverse Beacon Network style line:
 * `DX de LU1AAT-#:   7003.3  K1ABC         CW    23 dB  25 WPM  CQ      1234Z`
 * `dialKHz` is the radio's dial frequency; the audio tone offset is added to it.
 */
export function formatSpot(spot: Spot, spotter: string, dialKHz: number, when: Date): string {
  const khz = dialKHz + spot.freq / 1000;
  return (
    `DX de ${spotter}-#:`.padEnd(14) +
    khz.toFixed(1).padStart(9) + '  ' +
    spot.call.padEnd(12) + ' ' +
    'CW' +
    `${Math.round(spot.snr)} dB`.padStart(9) + '  ' +
    `${Math.round(spot.wpm)} WPM`.padStart(6) + '  ' +
    (spot.cq ? 'CQ' : 'DX').padEnd(8) +
    utcStamp(when)
  );
}
