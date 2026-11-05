// Every src/themes/*.css file is a theme; its filename is the id.
const files = import.meta.glob('../themes/*.css', { eager: true })
export const THEMES: string[] = Object.keys(files).map((p) => p.match(/([^/]+)\.css$/)![1])

export function applyTheme(id: string): void {
  document.documentElement.dataset.theme = THEMES.includes(id) ? id : THEMES[0]
}

/** Colours canvas renderers need, read from the active theme's CSS variables. */
export interface CanvasTheme {
  /** Dark plate behind spectrum/waterfall, its grid lines and text. */
  plate: string
  grid: string
  text: string
  trace: string
  fill: string
  peak: string
  mark: string
  /** Ruler (drawn on the paper): background, ticks, labels. */
  paper: string
  tick: string
  label: string
  /** 256 RGBA entries (Uint32, little-endian ABGR) for the waterfall. */
  lut: Uint32Array
}

function hex(s: string): [number, number, number] {
  const n = parseInt(s.trim().replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function readTheme(): CanvasTheme {
  const cs = getComputedStyle(document.documentElement)
  const v = (n: string) => cs.getPropertyValue(n).trim()
  const stops = [v('--wf-0'), v('--wf-1'), v('--wf-2'), v('--wf-3')].map(hex)
  const lut = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    const p = (i / 255) * (stops.length - 1)
    const a = Math.min(stops.length - 2, Math.floor(p))
    const f = p - a
    const c = [0, 1, 2].map((k) => Math.round(stops[a][k] + (stops[a + 1][k] - stops[a][k]) * f))
    lut[i] = (255 << 24) | (c[2] << 16) | (c[1] << 8) | c[0]
  }
  return {
    plate: v('--plate'),
    grid: v('--plate-grid'),
    text: v('--plate-text'),
    trace: v('--plate-trace'),
    fill: v('--plate-fill'),
    peak: v('--plate-peak'),
    mark: v('--plate-mark'),
    paper: v('--paper-2'),
    tick: v('--rule-2'),
    label: v('--ink-3'),
    lut,
  }
}
