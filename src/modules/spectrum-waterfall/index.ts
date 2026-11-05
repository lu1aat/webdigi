import type { Module, AppContext } from '../../core/module'
import type { SettingDef } from '../../core/settings'
import { settingField } from '../../core/controls'
import { t } from '../../core/i18n'
import './spectrum.css'

const FFT_SIZES = [2048, 4096, 8192, 16384, 32768]
const K = (k: string) => `spectrum.${k}`

// All hidden: this module renders them itself in its controls pane.
const defs: SettingDef[] = [
  { key: K('minHz'), label: 'spectrum.from', type: 'number', default: 0, min: 0, max: 96000, step: 10, hidden: true },
  { key: K('maxHz'), label: 'spectrum.to', type: 'number', default: 4000, min: 10, max: 96000, step: 10, hidden: true },
  {
    key: K('scale'),
    label: 'spectrum.scale',
    type: 'select',
    default: 'linear',
    options: [
      { value: 'linear', label: 'spectrum.linear' },
      { value: 'log', label: 'spectrum.log' },
    ],
    hidden: true,
  },
  { key: K('minDb'), label: 'spectrum.floor', type: 'number', default: -110, min: -160, max: -10, step: 1, control: 'slider', unit: ' dB', hidden: true },
  { key: K('maxDb'), label: 'spectrum.ceiling', type: 'number', default: -20, min: -100, max: 0, step: 1, control: 'slider', unit: ' dB', hidden: true },
  { key: K('fftSize'), label: 'spectrum.fft', type: 'select', default: '8192', options: FFT_SIZES.map((n) => ({ value: String(n), label: String(n) })), hidden: true },
  { key: K('smoothing'), label: 'spectrum.smoothing', type: 'number', default: 0.5, min: 0, max: 0.95, step: 0.05, control: 'slider', hidden: true },
  { key: K('peakHold'), label: 'spectrum.peakHold', type: 'boolean', default: false, hidden: true },
  { key: K('peakDecay'), label: 'spectrum.peakDecay', type: 'number', default: 12, min: 1, max: 40, step: 1, control: 'slider', unit: ' dB/s', hidden: true },
  { key: K('split'), label: 'spectrum.split', type: 'number', default: 35, min: 10, max: 90, step: 5, control: 'slider', unit: '% spectrum', hidden: true },
  { key: K('waterfall'), label: 'spectrum.waterfall', type: 'boolean', default: true, hidden: true },
  { key: K('fill'), label: 'spectrum.fill', type: 'boolean', default: true, hidden: true },
]
const D = (k: string) => defs.find((d) => d.key === K(k))!

const messages = {
  en: {
    'spectrum.title': 'Spectrum',
    'spectrum.group.span': 'Frequency span',
    'spectrum.group.level': 'Level',
    'spectrum.group.analysis': 'Analysis',
    'spectrum.group.display': 'Display',
    'spectrum.from': 'From (Hz)',
    'spectrum.to': 'To (Hz)',
    'spectrum.scale': 'Scale',
    'spectrum.linear': 'Linear',
    'spectrum.log': 'Logarithmic',
    'spectrum.preset.full': 'Full range',
    'spectrum.preset.voice': 'Voice',
    'spectrum.preset.low': '0–1 kHz',
    'spectrum.floor': 'Floor',
    'spectrum.ceiling': 'Ceiling',
    'spectrum.fit': 'Auto adjust levels',
    'spectrum.fft': 'FFT size',
    'spectrum.smoothing': 'Smoothing',
    'spectrum.peakHold': 'Hold peaks',
    'spectrum.peakDecay': 'Decay',
    'spectrum.waterfall': 'Waterfall',
    'spectrum.split': 'Screen share (rest: waterfall)',
    'spectrum.dragRuler': 'Drag to resize the spectrum and the waterfall',
    'spectrum.fill': 'Fill under trace',
    'spectrum.panLeft': 'Pan left (←)',
    'spectrum.panRight': 'Pan right (→)',
    'spectrum.zoomOut': 'Zoom out (−)',
    'spectrum.zoomIn': 'Zoom in (+)',
  },
  es: {
    'spectrum.title': 'Espectro',
    'spectrum.group.span': 'Rango de frecuencia',
    'spectrum.group.level': 'Nivel',
    'spectrum.group.analysis': 'Análisis',
    'spectrum.group.display': 'Visualización',
    'spectrum.from': 'Desde (Hz)',
    'spectrum.to': 'Hasta (Hz)',
    'spectrum.scale': 'Escala',
    'spectrum.linear': 'Lineal',
    'spectrum.log': 'Logarítmica',
    'spectrum.preset.full': 'Rango completo',
    'spectrum.preset.voice': 'Voz',
    'spectrum.preset.low': '0–1 kHz',
    'spectrum.floor': 'Piso',
    'spectrum.ceiling': 'Techo',
    'spectrum.fit': 'Autoajustar niveles',
    'spectrum.fft': 'Tamaño FFT',
    'spectrum.smoothing': 'Suavizado',
    'spectrum.peakHold': 'Mantener picos',
    'spectrum.peakDecay': 'Caída',
    'spectrum.waterfall': 'Cascada',
    'spectrum.split': 'Espacio del espectro (el resto: cascada)',
    'spectrum.dragRuler': 'Arrastra para cambiar el tamaño del espectro y la cascada',
    'spectrum.fill': 'Rellenar bajo la traza',
    'spectrum.panLeft': 'Mover a la izquierda (←)',
    'spectrum.panRight': 'Mover a la derecha (→)',
    'spectrum.zoomOut': 'Alejar (−)',
    'spectrum.zoomIn': 'Acercar (+)',
  },
}

const NICE = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000]

interface View {
  lo: number
  hi: number
  log: boolean
  nyq: number
}

/** What the controls pane can ask of the main view (set while the view is mounted). */
interface ViewApi {
  fit(): void
  span(lo: number, hi: number): void
}
let api: ViewApi | null = null

const hzAt = (v: View, f: number) => (v.log ? v.lo * Math.pow(v.hi / v.lo, f) : v.lo + (v.hi - v.lo) * f)
const fracAt = (v: View, hz: number) => (v.log ? Math.log(hz / v.lo) / Math.log(v.hi / v.lo) : (hz - v.lo) / (v.hi - v.lo))

function mountDisplay(host: HTMLElement, ctx: AppContext): () => void {
  const { settings, audio, bus } = ctx
  host.classList.add('spectrum')
  host.tabIndex = 0
  const mk = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '') => Object.assign(document.createElement(tag), { className: cls })
  const spec = mk('canvas')
  const wf = mk('canvas')
  const ruler = mk('canvas', 'ruler')
  const readout = mk('div', 'spectrum-readout')
  const pad = mk('div', 'spectrum-pad')
  const plateSpec = mk('div', 'plate spec')
  const plateWf = mk('div', 'plate wf')
  plateSpec.append(spec, readout)
  plateWf.append(wf, pad)
  host.append(plateSpec, ruler, plateWf)
  const sc = spec.getContext('2d')!
  const wc = wf.getContext('2d')!
  const rc = ruler.getContext('2d')!
  const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

  let theme = ctx.theme()
  let dirty = true
  const offTheme = ctx.onTheme(() => {
    theme = ctx.theme()
    dirty = true
  })

  // --- settings cache (avoids localStorage reads every frame)
  const cfg: Record<string, number | boolean | string> = {}
  const num = (k: string) => cfg[k] as number
  const offCfg = ['minHz', 'maxHz', 'scale', 'minDb', 'maxDb', 'smoothing', 'peakHold', 'peakDecay', 'waterfall', 'fill', 'split'].map((k) => {
    cfg[k] = settings.get(K(k))
    return settings.watch(K(k), (v) => {
      cfg[k] = v
      dirty = true
    })
  })

  // --- history of raw rows (newest first) so the waterfall can be redrawn when the span changes
  const rows: Float32Array[] = []
  let peaks = new Float32Array(0)
  const resetHistory = () => {
    rows.length = 0
    peaks = new Float32Array(0)
    dirty = true
  }
  const applyFft = () => {
    audio.setFftSize(Number(settings.get(K('fftSize'))))
    resetHistory()
  }
  applyFft()
  const offFft = settings.watch(K('fftSize'), applyFft)

  // --- markers from other modules
  const markers = new Map<string, { hz: number; label?: string; color?: string; bw?: number; strong?: boolean }>()
  const offs = [
    bus.on('marker:set', (m) => markers.set(m.id, { hz: m.hz, label: m.label, color: m.color, bw: m.bw, strong: m.strong })),
    bus.on('marker:clear', (m) => markers.delete(m.id)),
    bus.on('view:focus', ({ hz }) => {
      markers.set('_focus', { hz })
      setTimeout(() => markers.delete('_focus'), 2000)
      const v = view()
      if (hz < v.lo || hz > v.hi) {
        // off-screen: slide the span (same width) so the frequency is centred
        const [a, b] = domain(v)
        const c = v.log ? Math.log(Math.max(hz, 1)) : hz
        applySpan(c - (b - a) / 2, c + (b - a) / 2, v)
      }
    }),
  ]

  // --- view geometry
  const view = (): View => {
    const nyq = audio.sampleRate / 2
    const log = cfg.scale === 'log'
    const floor = log ? 1 : 0
    const lo = Math.min(Math.max(num('minHz'), floor), nyq - 10)
    let hi = Math.min(num('maxHz'), nyq)
    if (hi < lo + 10) hi = Math.min(nyq, lo + 10)
    return { lo, hi, log, nyq }
  }

  /** Set the span in the scale's own domain (Hz or ln Hz), clamped to [0|1 Hz, Nyquist]. */
  const applySpan = (a: number, b: number, v: View) => {
    const fwd = (x: number) => (v.log ? Math.log(x) : x)
    const inv = (x: number) => (v.log ? Math.exp(x) : x)
    const minA = 0 // 0 Hz in linear, ln(1 Hz) = 0 in log
    const maxB = fwd(v.nyq)
    const minW = v.log ? Math.log(1.1) : 10
    const w = Math.max(minW, Math.min(b - a, maxB - minA))
    const na = Math.min(Math.max(a, minA), maxB - w)
    const r = (x: number) => Math.round(x * 10) / 10
    settings.set(K('minHz'), r(inv(na)))
    settings.set(K('maxHz'), r(inv(na + w)))
  }
  const domain = (v: View): [number, number] => (v.log ? [Math.log(v.lo), Math.log(v.hi)] : [v.lo, v.hi])

  const zoom = (factor: number, anchor = 0.5) => {
    const v = view()
    const [a, b] = domain(v)
    const pivot = a + (b - a) * anchor
    applySpan(pivot - (pivot - a) * factor, pivot + (b - pivot) * factor, v)
  }
  const pan = (frac: number) => {
    const v = view()
    const [a, b] = domain(v)
    applySpan(a + (b - a) * frac, b + (b - a) * frac, v)
  }

  // --- columns: pixel x -> FFT bin, rebuilt only when the geometry changes
  let cols = new Int32Array(0)
  let colsKey = ''
  const ensureCols = (w: number, n: number, v: View): boolean => {
    const key = `${w}|${n}|${v.lo}|${v.hi}|${v.log}|${v.nyq}`
    if (key === colsKey) return false
    colsKey = key
    if (cols.length !== w) cols = new Int32Array(w)
    for (let x = 0; x < w; x++) cols[x] = Math.min(n - 1, Math.max(0, Math.floor((hzAt(v, (x + 0.5) / w) / v.nyq) * n)))
    return true
  }

  const dpr = () => window.devicePixelRatio || 1
  const fit = () => {
    for (const c of [spec, wf, ruler]) {
      c.width = Math.max(1, Math.round(c.clientWidth * dpr()))
      c.height = Math.max(1, Math.round(c.clientHeight * dpr()))
    }
    if (rows.length > wf.height) rows.length = wf.height
    dirty = true
  }
  const ro = new ResizeObserver(fit)
  ro.observe(spec)
  ro.observe(wf)
  ro.observe(ruler)
  fit()

  // --- interaction
  const fracOf = (clientX: number) => (clientX - spec.getBoundingClientRect().left) / spec.clientWidth
  for (const c of [spec, wf]) {
    // Drag to pan (the span follows the pointer, in the scale's own domain); a click that barely
    // moves picks a frequency instead. Positions are measured from where the drag began, so
    // clamping at the edges never makes the view drift.
    let drag: { x0: number; a: number; b: number; v: View; moved: boolean } | null = null
    const endDrag = () => {
      drag = null
      c.classList.remove('panning')
    }
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      c.setPointerCapture(e.pointerId)
      const v = view()
      const [a, b] = domain(v)
      drag = { x0: e.clientX, a, b, v, moved: false }
    })
    c.addEventListener('pointermove', (e) => {
      readout.textContent = `${Math.round(hzAt(view(), fracOf(e.clientX)))} Hz`
      if (!drag) return
      const dx = e.clientX - drag.x0
      if (!drag.moved && Math.abs(dx) < 4) return // still a click
      drag.moved = true
      c.classList.add('panning')
      const shift = -(dx / spec.clientWidth) * (drag.b - drag.a)
      applySpan(drag.a + shift, drag.b + shift, drag.v)
    })
    c.addEventListener('pointerup', (e) => {
      if (drag && !drag.moved) bus.emit('view:pick', { hz: hzAt(view(), fracOf(e.clientX)) })
      endDrag()
    })
    c.addEventListener('pointercancel', endDrag)
    c.addEventListener('wheel', (e) => {
      e.preventDefault()
      zoom(e.deltaY < 0 ? 0.8 : 1.25, fracOf(e.clientX))
    }, { passive: false })
  }
  // drag the ruler to move the boundary between the spectrum and the waterfall
  ruler.title = t('spectrum.dragRuler')
  ruler.onpointerdown = (e) => {
    ruler.setPointerCapture(e.pointerId)
    ruler.onpointermove = (ev) => {
      const r = host.getBoundingClientRect()
      const spectrumPx = ev.clientY - r.top - ruler.clientHeight / 2
      settings.set(K('split'), Math.round((spectrumPx / r.height) * 100))
    }
    ruler.onpointerup = () => void (ruler.onpointermove = ruler.onpointerup = null)
  }
  const padBtn = (label: string, title: string, fn: () => void) => {
    const b = document.createElement('button')
    b.className = 'btn'
    b.textContent = label
    b.title = t(title)
    b.setAttribute('aria-label', t(title))
    b.onclick = fn
    pad.append(b)
  }
  padBtn('◄', 'spectrum.panLeft', () => pan(-0.2))
  padBtn('►', 'spectrum.panRight', () => pan(0.2))
  padBtn('−', 'spectrum.zoomOut', () => zoom(1.25))
  padBtn('+', 'spectrum.zoomIn', () => zoom(0.8))
  padBtn('A', 'spectrum.fit', () => api?.fit())
  host.addEventListener('keydown', (e) => {
    const keys: Record<string, () => void> = {
      ArrowLeft: () => pan(-0.2),
      ArrowRight: () => pan(0.2),
      '+': () => zoom(0.8),
      '=': () => zoom(0.8),
      '-': () => zoom(1.25),
    }
    if (keys[e.key]) {
      e.preventDefault()
      keys[e.key]()
    }
  })

  // --- controls-pane API
  api = {
    span(lo, hi) {
      const v = view()
      const floor = v.log ? 1 : 0
      const f = (x: number) => (v.log ? Math.log(Math.max(x, floor)) : Math.max(x, floor))
      applySpan(f(lo), f(Math.min(hi, v.nyq)), v)
    },
    /** Floor/ceiling from the recent history inside the visible span. */
    fit() {
      const take = rows.slice(0, 30)
      if (!take.length) return
      const v = view()
      const n = take[0].length
      const i0 = Math.max(0, Math.floor((v.lo / v.nyq) * n))
      const i1 = Math.min(n - 1, Math.ceil((v.hi / v.nyq) * n))
      const vals: number[] = []
      for (const r of take) for (let i = i0; i <= i1; i++) if (Number.isFinite(r[i])) vals.push(r[i])
      if (!vals.length) return
      vals.sort((a, b) => a - b)
      const floor = Math.round(vals[Math.floor(vals.length * 0.05)] - 5)
      let ceil = Math.round(vals[vals.length - 1] + 5)
      if (ceil - floor < 20) ceil = floor + 20
      settings.set(K('minDb'), floor)
      settings.set(K('maxDb'), ceil)
    },
  }

  // --- drawing
  const range = () => ({ min: num('minDb'), span: Math.max(1, num('maxDb') - num('minDb')) })

  const ticks = (v: View, w: number): number[] => {
    const out: number[] = []
    if (v.log) {
      for (let dec = Math.floor(Math.log10(v.lo)); dec <= Math.ceil(Math.log10(v.hi)); dec++)
        for (const m of [1, 2, 5]) {
          const f = m * Math.pow(10, dec)
          if (f >= v.lo && f <= v.hi) out.push(f)
        }
      return out
    }
    const span = v.hi - v.lo
    const step = NICE.find((s) => (s / span) * w >= 70 * dpr()) ?? NICE[NICE.length - 1]
    for (let f = Math.ceil(v.lo / step) * step; f <= v.hi; f += step) out.push(f)
    return out
  }

  function drawSpectrum(d: Float32Array | null, v: View) {
    const { width: w, height: h } = spec
    sc.fillStyle = theme.plate
    sc.fillRect(0, 0, w, h)
    sc.lineWidth = 1
    sc.strokeStyle = theme.grid
    for (const f of ticks(v, w)) {
      const x = Math.round(fracAt(v, f) * w) + 0.5
      sc.beginPath()
      sc.moveTo(x, 0)
      sc.lineTo(x, h)
      sc.stroke()
    }
    const { min, span } = range()
    const y = (db: number) => h - Math.min(1, Math.max(0, (db - min) / span)) * h
    const trace = (arr: Float32Array) => {
      sc.beginPath()
      for (let x = 0; x < w; x++) (x ? sc.lineTo(x, y(arr[cols[x]])) : sc.moveTo(x, y(arr[cols[x]])))
    }
    if (d && cols.length === w) {
      if (cfg.peakHold && peaks.length === d.length) {
        sc.strokeStyle = theme.peak
        trace(peaks)
        sc.stroke()
      }
      sc.strokeStyle = theme.trace
      trace(d)
      sc.stroke()
      if (cfg.fill) {
        sc.lineTo(w, h)
        sc.lineTo(0, h)
        sc.fillStyle = theme.fill
        sc.fill()
      }
    }
    for (const m of markers.values()) {
      const f = fracAt(v, m.hz)
      if (f < 0 || f > 1) continue
      const x = Math.round(f * w) + 0.5
      if (m.bw) {
        const x0 = fracAt(v, Math.max(1, m.hz - m.bw / 2)) * w
        const x1 = fracAt(v, m.hz + m.bw / 2) * w
        if (x1 - x0 > 2) {
          sc.globalAlpha = m.strong ? 0.34 : 0.14
          sc.fillStyle = m.color ?? theme.mark
          sc.fillRect(x0, 0, x1 - x0, h)
          sc.globalAlpha = 1
        }
      }
      sc.strokeStyle = m.color ?? theme.mark
      sc.lineWidth = m.strong ? 2 * dpr() : 1
      sc.beginPath()
      sc.moveTo(x, 0)
      sc.lineTo(x, h)
      sc.stroke()
      sc.lineWidth = 1
    }
  }

  /** The ruler sits on the paper between the plates: tick labels below, marker flags above. */
  function drawRuler(v: View) {
    const { width: w, height: h } = ruler
    rc.clearRect(0, 0, w, h)
    rc.font = `${10 * dpr()}px ${MONO}`
    rc.textBaseline = 'alphabetic'
    let lastLabel = -Infinity
    for (const f of ticks(v, w)) {
      const x = Math.round(fracAt(v, f) * w) + 0.5
      rc.strokeStyle = theme.tick
      rc.beginPath()
      rc.moveTo(x, h - 5 * dpr())
      rc.lineTo(x, h)
      rc.stroke()
      if (x - lastLabel > 48 * dpr()) {
        rc.fillStyle = theme.label
        rc.fillText(f >= 1000 ? `${+(f / 1000).toFixed(2)}k` : String(+f.toFixed(1)), x + 3 * dpr(), h - 7 * dpr())
        lastLabel = x
      }
    }
    for (const m of markers.values()) {
      const f = fracAt(v, m.hz)
      if (f < 0 || f > 1) continue
      const x = Math.round(f * w) + 0.5
      rc.fillStyle = rc.strokeStyle = m.color ?? theme.mark
      rc.lineWidth = m.strong ? 2 * dpr() : 1
      rc.beginPath()
      rc.moveTo(x, 0)
      rc.lineTo(x, h)
      rc.stroke()
      rc.lineWidth = 1
      rc.beginPath()
      rc.moveTo(x, 0)
      rc.lineTo(x + 6 * dpr(), 0)
      rc.lineTo(x, 6 * dpr())
      rc.fill()
      if (m.label) rc.fillText(m.label, x + 8 * dpr(), 9 * dpr())
    }
  }

  const paintRow = (px: Uint32Array, offset: number, r: Float32Array) => {
    const { min, span } = range()
    const w = wf.width
    for (let x = 0; x < w; x++) px[offset + x] = theme.lut[Math.round(Math.min(1, Math.max(0, (r[cols[x]] - min) / span)) * 255)]
  }
  function redrawWaterfall() {
    const { width: w, height: h } = wf
    wc.fillStyle = theme.plate
    wc.fillRect(0, 0, w, h)
    if (!rows.length || cols.length !== w) return
    const img = wc.createImageData(w, h)
    const px = new Uint32Array(img.data.buffer)
    for (let y = 0; y < Math.min(rows.length, h); y++) paintRow(px, y * w, rows[y])
    wc.putImageData(img, 0, 0)
  }
  function scrollRow() {
    wc.drawImage(wf, 0, 1)
    const row = wc.createImageData(wf.width, 1)
    paintRow(new Uint32Array(row.data.buffer), 0, rows[0])
    wc.putImageData(row, 0, 0)
  }

  let last = performance.now()
  let raf = 0
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame)
    const dt = Math.min(0.25, (now - last) / 1000)
    last = now
    host.classList.toggle('no-wf', !cfg.waterfall)
    const basis = cfg.waterfall ? `${num('split')}%` : '' // without the waterfall the spectrum takes everything
    if (plateSpec.style.flexBasis !== basis) plateSpec.style.flexBasis = basis

    if (audio.analyser) audio.analyser.smoothingTimeConstant = num('smoothing')
    const d = audio.spectrum()
    const v = view()
    if (!cfg.waterfall) rows.length = 0
    const n = d ? d.length : (rows[0]?.length ?? 0)
    const colsChanged = n > 0 && ensureCols(spec.width, n, v)

    if (d) {
      if (cfg.peakHold) {
        if (peaks.length !== d.length) peaks = new Float32Array(d.length).fill(-Infinity)
        const drop = num('peakDecay') * dt
        for (let i = 0; i < d.length; i++) peaks[i] = Math.max(d[i], peaks[i] - drop)
      } else if (peaks.length) peaks = new Float32Array(0)
      if (cfg.waterfall) {
        const r = rows.length >= wf.height ? rows.pop()! : new Float32Array(d.length)
        r.set(d)
        rows.unshift(r)
      }
    }
    drawSpectrum(d, v)
    drawRuler(v)
    if (cfg.waterfall && wf.width > 1) {
      if (colsChanged || dirty) redrawWaterfall()
      else if (d && rows.length) scrollRow()
    }
    dirty = false
  }
  raf = requestAnimationFrame(frame)

  return () => {
    cancelAnimationFrame(raf)
    ro.disconnect()
    offTheme()
    offFft()
    offCfg.forEach((f) => f())
    offs.forEach((f) => f())
    api = null
  }
}

function mountOptions(host: HTMLElement, ctx: AppContext): void {
  const { settings } = ctx
  const group = (title: string) => {
    const h = document.createElement('h4')
    h.className = 'group'
    h.textContent = t(title)
    host.append(h)
  }
  const field = (k: string) => host.append(settingField(settings, D(k)))
  const chips = (items: [string, () => void][]) => {
    const row = document.createElement('div')
    row.className = 'chips'
    for (const [label, fn] of items) {
      const b = document.createElement('button')
      b.className = 'chip'
      b.textContent = t(label)
      b.onclick = fn
      row.append(b)
    }
    host.append(row)
  }

  group('spectrum.group.span')
  field('minHz')
  field('maxHz')
  field('scale')
  chips([
    ['spectrum.preset.full', () => api?.span(0, Infinity)],
    ['spectrum.preset.voice', () => api?.span(300, 3400)],
    ['spectrum.preset.low', () => api?.span(0, 1000)],
  ])
  group('spectrum.group.level')
  field('minDb')
  field('maxDb')
  chips([['spectrum.fit', () => api?.fit()]])
  group('spectrum.group.analysis')
  field('fftSize')
  field('smoothing')
  field('peakHold')
  field('peakDecay')
  group('spectrum.group.display')
  field('waterfall')
  field('split')
  field('fill')
}

const mod: Module = {
  id: 'spectrum',
  title: 'spectrum.title',
  icon: '≋',
  core: true,
  messages,
  settings: defs,
  display: mountDisplay,
  options: mountOptions,
}
export default mod
