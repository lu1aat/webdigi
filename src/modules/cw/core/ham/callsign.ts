/** Callsign recognition and validation for decoded CW text. */

export type CallClass = 'typical' | 'unusual' | 'suspicious' | 'invalid';
export type ValidationLevel = 'minimal' | 'normal' | 'aggressive' | 'paranoid';
export type TokenKind = 'call' | 'rst' | 'keyword' | 'other';

const TYPICAL = /^(?:[A-Z]{1,2}|[0-9][A-Z]|[A-Z][0-9])[0-9][A-Z]{1,3}$/;
const UNUSUAL = /^[A-Z0-9]{1,3}[0-9][A-Z]{1,4}$/;
const SUSPICIOUS = /^(?=.*[0-9])(?=.*[A-Z])[A-Z0-9]{3,8}$/;
const SUFFIXES = new Set(['P', 'M', 'MM', 'AM', 'QRP', 'A', 'B']);
const KEYWORDS = new Set([
  'CQ', 'DE', 'K', 'KN', 'BK', 'AR', 'SK', 'TU', 'TEST', 'QRZ', 'QRL', 'QRS', 'QRQ', 'QSL',
  'QTH', 'QSY', 'UP', 'DN', '73', '72', '88', 'RST', 'PSE', 'AGN', 'R', 'RR', 'FB', 'GM', 'GA', 'GE',
]);

/** Splits `EA8/LU1AAT/P` into the base call and flags. Returns null for nonsense. */
export function splitCall(token: string): { base: string; portable: boolean } | null {
  const parts = token.split('/');
  if (parts.length > 3 || parts.some((p) => p === '')) return null;
  let portable = parts.length > 1;
  const rest = parts.filter((p, i) => !(i > 0 && SUFFIXES.has(p)) || ((portable = true), false));
  // longest remaining part that looks like a call carries the identity
  const base = rest.reduce((a, b) => (b.length > a.length ? b : a), '');
  return base ? { base, portable } : null;
}

export function classifyCall(token: string): CallClass {
  const sp = splitCall(token.toUpperCase());
  if (!sp) return 'invalid';
  if (TYPICAL.test(sp.base)) return 'typical';
  if (UNUSUAL.test(sp.base)) return 'unusual';
  if (SUSPICIOUS.test(sp.base) && /[A-Z]$/.test(sp.base)) return 'suspicious';
  return 'invalid';
}

/** SuperCheckPartial-style list: one callsign per line, `#` comments, `!` lines ignored. */
export class CallDatabase {
  private readonly calls = new Set<string>();
  constructor(text = '') {
    if (text) this.load(text);
  }
  load(text: string): void {
    for (const line of text.split(/\r?\n/)) {
      const c = line.trim().toUpperCase().split(/\s+/)[0];
      if (c && !c.startsWith('#') && !c.startsWith('!')) this.calls.add(c);
    }
  }
  has(call: string): boolean {
    return this.calls.has(call.toUpperCase());
  }
  get size(): number {
    return this.calls.size;
  }
}

export function passesValidation(
  call: string,
  level: ValidationLevel,
  db?: CallDatabase,
  watch?: ReadonlySet<string>,
): boolean {
  if (watch?.has(call)) return true;
  const base = splitCall(call)?.base ?? call;
  const cls = classifyCall(call);
  const inDb = !!db && db.size > 0 && db.has(base);
  switch (level) {
    case 'minimal': return cls !== 'invalid';
    case 'normal': return cls === 'typical' || cls === 'unusual' || inDb;
    case 'aggressive': return cls === 'typical' || inDb;
    case 'paranoid': return db && db.size > 0 ? inDb : cls === 'typical';
  }
}


export function classifyToken(token: string): TokenKind {
  const t = token.toUpperCase();
  if (KEYWORDS.has(t)) return 'keyword';
  if (/^5[1-9N][9N]$/.test(t)) return 'rst';
  if (classifyCall(t) !== 'invalid' && /[0-9]/.test(t) && /[A-Z]/.test(t)) return 'call';
  return 'other';
}
