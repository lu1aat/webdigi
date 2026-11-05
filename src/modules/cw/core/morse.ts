/** International Morse code table (ITU-R M.1677) plus common prosigns. */
export const MORSE: Readonly<Record<string, string>> = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....',
  I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.',
  Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-',
  Y: '-.--', Z: '--..',
  '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-',
  '5': '.....', '6': '-....', '7': '--...', '8': '---..', '9': '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', '/': '-..-.', '=': '-...-',
  '+': '.-.-.', '-': '-....-', '@': '.--.-.',
};

const REVERSE: Record<string, string> = Object.fromEntries(
  Object.entries(MORSE).map(([ch, code]) => [code, ch]),
);

/** Dot/dash pattern -> character, or undefined if it is not a known symbol. */
export function patternToChar(pattern: string): string | undefined {
  return REVERSE[pattern];
}

/** Dot duration in seconds at the given PARIS-standard speed. */
export function dotSeconds(wpm: number): number {
  return 1.2 / wpm;
}
