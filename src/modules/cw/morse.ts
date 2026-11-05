/** International Morse table. Pure data + lookups, no audio. */
const TABLE: Record<string, string> = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--',
  N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
  '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-', '5': '.....', '6': '-....', '7': '--...', '8': '---..', '9': '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', '/': '-..-.', '=': '-...-', '+': '.-.-.', '-': '-....-', ':': '---...', '@': '.--.-.', '(': '-.--.', ')': '-.--.-', '"': '.-..-.', "'": '.----.',
}
const REVERSE = new Map(Object.entries(TABLE).map(([c, p]) => [p, c]))

/** Morse pattern ("-.-.") for a character, or undefined if it has none. */
export const patternFor = (ch: string): string | undefined => TABLE[ch.toUpperCase()]

/** Character for a pattern, or undefined for an unknown one. */
export const charFor = (pattern: string): string | undefined => REVERSE.get(pattern)

/** Dot units to send `text` at the given spacing: PARIS is exactly 50. */
export function dotUnits(text: string): number {
  let units = 0
  for (const word of text.toUpperCase().split(/\s+/).filter(Boolean)) {
    if (units) units += 7
    const letters = [...word].map(patternFor).filter((p): p is string => !!p)
    letters.forEach((p, i) => {
      if (i) units += 3
      units += [...p].reduce((n, e, j) => n + (e === '.' ? 1 : 3) + (j ? 1 : 0), 0)
    })
  }
  return units
}
