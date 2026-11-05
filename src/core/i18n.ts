export type Lang = 'en' | 'es'
export type Messages = Record<string, string>

const tables: Record<Lang, Messages> = { en: {}, es: {} }
let lang: Lang = 'en'

export function detectLang(): Lang {
  const nav = typeof navigator !== 'undefined' ? navigator.language : 'en'
  return nav.toLowerCase().startsWith('es') ? 'es' : 'en'
}

export function setLang(l: Lang): void {
  lang = l
}

export function getLang(): Lang {
  return lang
}

/** Merge message tables. Missing "es" keys fall back to "en", then to the key itself. */
export function addMessages(m: Partial<Record<Lang, Messages>>): void {
  for (const l of Object.keys(m) as Lang[]) Object.assign(tables[l], m[l])
}

/** t("key", { n: 3 }) replaces {n} in the string. */
export function t(key: string, params?: Record<string, string | number>): string {
  let s = tables[lang][key] ?? tables.en[key] ?? key
  if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v))
  return s
}
