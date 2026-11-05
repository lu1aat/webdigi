import type { Module, AppContext } from '../../core/module'
import { settingField } from '../../core/controls'
import { t } from '../../core/i18n'
import { TxBusyError } from '../../core/audio/output'
import { HellDemodulator } from './demodulator'
import { HellToneGenerator } from './tone-generator'
import { HellStrip } from './hell-strip'
import { encodeText, estimateDurationSec } from './encoder'
import { MODES, FELD_HELL, type HellMode } from './modes'
import './hell.css'

const messages = {
  en: {
    'hell.title': 'Hellschreiber',
    'hell.mode': 'Mode',
    'hell.freq': 'Tone (Hz)',
    'hell.bw': 'Width',
    'hell.ppm': 'Slant trim',
    'hell.amp': 'TX level',
    'hell.inverse': 'Paper tape (black on white)',
    'hell.dual': 'Print twice',
    'hell.auto': 'Auto row alignment',
    'hell.hint': 'Hell is read by eye: the strip shows intensity, nothing is decoded. Click the spectrum to tune.',
    'hell.idle': 'Start listening to receive.',
    'hell.snr': 'Signal {db} dB',
    'hell.clear': 'Clear',
    'hell.send': 'Send',
    'hell.stop': 'Stop',
    'hell.loop': 'Loopback monitor (show own TX on the strip)',
    'hell.text': 'Text to send',
    'hell.eta': '{s} s on air',
    'hell.sending': 'Transmitting…',
    'hell.nyq': 'The output device can only play up to {n} Hz: lower the tone.',
    'hell.busy': '{owner} is transmitting: only one module can transmit at a time.',
    'hell.err': 'Cannot transmit: {e}',
  },
  es: {
    'hell.title': 'Hellschreiber',
    'hell.mode': 'Modo',
    'hell.freq': 'Tono (Hz)',
    'hell.bw': 'Ancho',
    'hell.ppm': 'Ajuste de inclinación',
    'hell.amp': 'Nivel TX',
    'hell.inverse': 'Cinta de papel (negro sobre blanco)',
    'hell.dual': 'Imprimir dos veces',
    'hell.auto': 'Alineación automática de filas',
    'hell.hint': 'Hell se lee a ojo: la tira muestra intensidad, no se decodifica nada. Haz clic en el espectro para sintonizar.',
    'hell.idle': 'Empieza a escuchar para recibir.',
    'hell.snr': 'Señal {db} dB',
    'hell.clear': 'Limpiar',
    'hell.send': 'Enviar',
    'hell.stop': 'Detener',
    'hell.loop': 'Monitor de lazo (ver el propio TX en la tira)',
    'hell.text': 'Texto a enviar',
    'hell.eta': '{s} s en el aire',
    'hell.sending': 'Transmitiendo…',
    'hell.nyq': 'La salida de audio solo reproduce hasta {n} Hz: baja el tono.',
    'hell.busy': '{owner} está transmitiendo: solo un módulo puede transmitir a la vez.',
    'hell.err': 'No se puede transmitir: {e}',
  },
}

const settings = [
  { key: 'hell.mode', label: 'hell.mode', type: 'select' as const, default: FELD_HELL.id, options: MODES.map((m) => ({ value: m.id, label: m.name })) },
  { key: 'hell.freq', label: 'hell.freq', type: 'number' as const, default: 1500, min: 200, max: 23000, step: 1, hidden: true },
  { key: 'hell.bw', label: 'hell.bw', type: 'number' as const, default: 350, min: 100, max: 1000, step: 10, control: 'slider' as const, unit: ' Hz', hidden: true },
  { key: 'hell.ppm', label: 'hell.ppm', type: 'number' as const, default: 0, min: -2000, max: 2000, step: 5, control: 'slider' as const, unit: ' ppm', hidden: true },
  { key: 'hell.amp', label: 'hell.amp', type: 'number' as const, default: 0.5, min: 0.05, max: 0.9, step: 0.05, control: 'slider' as const, hidden: true },
  { key: 'hell.inverse', label: 'hell.inverse', type: 'boolean' as const, default: true, hidden: true },
  { key: 'hell.dual', label: 'hell.dual', type: 'boolean' as const, default: true, hidden: true },
  { key: 'hell.auto', label: 'hell.auto', type: 'boolean' as const, default: true, hidden: true },
]

const mk = <E extends keyof HTMLElementTagNameMap>(tag: E, cls = '', text = '') => Object.assign(document.createElement(tag), { className: cls, textContent: text })
const modeOf = (id: string): HellMode => MODES.find((m) => m.id === id) ?? FELD_HELL

/** Module-level state shared by the panel (display, TX) and init (RX, tuning). */
let strip: HellStrip | null = null
let demod: HellDemodulator | null = null
let demodRate = 0
let snrDb = 0
let loopbackEnabled = false
const elems = new Uint8Array(4096)

function mountOptions(host: HTMLElement, ctx: AppContext): void {
  for (const d of settings) host.append(settingField(ctx.settings, d))
  host.append(mk('p', 'hint', t('hell.hint')))
}

function mountPanel(host: HTMLElement, ctx: AppContext): () => void {
  const canvas = mk('canvas', 'hell-strip')
  const status = mk('div', 'hell-status', t('hell.idle'))
  const clear = mk('button', 'btn', t('hell.clear'))
  const row = mk('div', 'hell-row')
  row.append(status, clear)

  const input = mk('input', 'hell-text')
  input.placeholder = t('hell.text')
  input.setAttribute('aria-label', t('hell.text'))
  const send = mk('button', 'btn btn-primary', t('hell.send'))
  const stop = mk('button', 'btn', t('hell.stop'))
  stop.disabled = true
  const eta = mk('span', 'hint')
  const loop = mk('input')
  loop.type = 'checkbox'
  const loopLabel = mk('label', 'hell-loop')
  loopLabel.append(loop, mk('span', '', t('hell.loop')))
  const tx = mk('div', 'hell-row')
  tx.append(input, send, stop, eta)
  host.append(canvas, row, tx, loopLabel)

  const s = ctx.settings
  const buildStrip = () => {
    strip = new HellStrip(canvas, modeOf(s.get<string>('hell.mode')), {
      scale: 3,
      dualPrint: s.get<boolean>('hell.dual'),
      inverse: s.get<boolean>('hell.inverse'),
      autoAlign: s.get<boolean>('hell.auto'),
    })
  }
  buildStrip()

  const offs = [
    s.watch('hell.mode', () => {
      buildStrip()
      demod = null
      updateEta()
    }),
    s.watch('hell.dual', (v) => strip?.setDualPrint(!!v)),
    s.watch('hell.inverse', (v) => strip?.setInverse(!!v)),
    s.watch('hell.auto', (v) => strip?.setAutoAlign(!!v)),
    s.watch('hell.freq', (v) => demod?.setCenterFrequency(Number(v))),
    s.watch('hell.bw', (v) => demod?.setBandwidth(Number(v))),
    s.watch('hell.ppm', (v) => demod?.setClockPpm(Number(v))),
  ]

  const updateEta = () => {
    eta.textContent = input.value ? t('hell.eta', { s: estimateDurationSec(input.value.toUpperCase(), modeOf(s.get<string>('hell.mode'))).toFixed(1) }) : ''
  }
  input.oninput = updateEta
  clear.onclick = () => strip?.clear()
  loop.onchange = () => (loopbackEnabled = loop.checked)

  let sending = false
  /** A message that replaces the status line until the next transmission (errors, busy). */
  let note = ''
  const doStop = () => {
    ctx.output.stopAll()
    loopFeed = null
  }
  stop.onclick = doStop
  // Another module holding the transmit lock disables ours (and says who).
  const offTx = ctx.bus.on('tx:state', ({ owner }) => {
    const other = owner && owner !== 'hell' ? owner : null
    send.disabled = !!other
    note = other ? t('hell.busy', { owner: other.toUpperCase() }) : ''
  })
  const transmit = async () => {
    const text = input.value.toUpperCase()
    if (!text || sending) return
    const holder = ctx.output.transmitting
    if (holder) return void (note = t('hell.busy', { owner: holder.toUpperCase() }))
    const mode = modeOf(s.get<string>('hell.mode'))
    const rate = 48000
    // The band edge sits half a bandwidth above the tone; it must still be below what the output can play.
    const nyq = Math.min(rate / 2, ctx.output.nyquist)
    const top = s.get<number>('hell.freq') + s.get<number>('hell.bw') / 2
    if (top > nyq) return void (note = t('hell.nyq', { n: Math.floor(nyq - s.get<number>('hell.bw') / 2) }))
    const gen = new HellToneGenerator(rate, mode, { freqHz: s.get<number>('hell.freq'), amplitude: s.get<number>('hell.amp') })
    gen.send(encodeText(text, mode))
    const out = new Float32Array(Math.ceil((estimateDurationSec(text, mode) + 0.3) * rate))
    gen.fill(out)
    sending = true
    note = ''
    send.disabled = true
    stop.disabled = false
    status.textContent = t('hell.sending')
    if (loopbackEnabled) loopFeed = { samples: out, rate, startedAt: performance.now(), pos: 0 }
    try {
      await ctx.output.transmit('hell', out, rate)
      input.value = ''
      updateEta()
    } catch (e) {
      note = e instanceof TxBusyError ? t('hell.busy', { owner: e.owner.toUpperCase() }) : t('hell.err', { e: e instanceof Error ? e.message : String(e) })
    } finally {
      sending = false
      loopFeed = null
      send.disabled = !!ctx.output.transmitting
      stop.disabled = true
    }
  }
  send.onclick = () => void transmit()
  input.onkeydown = (e) => {
    if (e.key === 'Enter') void transmit() // never return a value here: returning false would cancel every other keystroke
  }

  let raf = 0
  const frame = () => {
    raf = requestAnimationFrame(frame)
    pumpLoopback()
    strip?.render()
    if (!sending) status.textContent = note || (ctx.audio.running ? t('hell.snr', { db: snrDb.toFixed(0) }) : t('hell.idle'))
  }
  raf = requestAnimationFrame(frame)

  return () => {
    cancelAnimationFrame(raf)
    offTx()
    offs.forEach((o) => o())
  }
}

/** Own TX fed into the receiver at real time, so the strip shows what we send. */
let loopFeed: { samples: Float32Array; rate: number; startedAt: number; pos: number } | null = null
let loopSettings: AppContext['settings'] | null = null

function pumpLoopback(): void {
  const f = loopFeed
  if (!f || !loopSettings) return
  const upTo = Math.min(f.samples.length, Math.floor(((performance.now() - f.startedAt) / 1000) * f.rate))
  if (upTo <= f.pos) return
  feed(f.samples.subarray(f.pos, upTo), f.rate, loopSettings)
  f.pos = upTo
  if (f.pos >= f.samples.length) loopFeed = null
}

function feed(block: Float32Array, rate: number, s: AppContext['settings']): void {
  if (!strip) return
  if (!demod || demodRate !== rate) {
    demod = new HellDemodulator(rate, modeOf(s.get<string>('hell.mode')), {
      centerFreqHz: s.get<number>('hell.freq'),
      bandwidthHz: s.get<number>('hell.bw'),
      clockPpm: s.get<number>('hell.ppm'),
    })
    demodRate = rate
  }
  // Large blocks (loopback catch-up) are split so `elems` never overflows.
  const step = 2048
  for (let i = 0; i < block.length; i += step) {
    const n = demod.process(block.subarray(i, i + step), elems)
    if (n) strip.pushElements(elems.slice(0, n))
  }
  snrDb = demod.snrEstimateDb
}

function init(ctx: AppContext): void {
  loopSettings = ctx.settings
  ctx.audio.onSamples((block, rate) => {
    if (!ctx.isActive('hell') || loopFeed) return
    feed(block, rate, ctx.settings)
  })
  const marker = () => {
    if (!ctx.isActive('hell')) return ctx.bus.emit('marker:clear', { id: 'hell' })
    ctx.bus.emit('marker:set', { id: 'hell', hz: ctx.settings.get<number>('hell.freq'), label: 'Hell', bw: ctx.settings.get<number>('hell.bw') })
  }
  ctx.settings.watch('hell.freq', marker)
  ctx.settings.watch('hell.bw', marker)
  ctx.bus.on('module:active', ({ id }) => id === 'hell' && marker())
  ctx.bus.on('view:pick', ({ hz }) => {
    if (ctx.isActive('hell') && ctx.settings.get('ui.selected') === 'hell') ctx.settings.set('hell.freq', Math.round(hz))
  })
  marker()
}

const mod: Module = {
  id: 'hell',
  title: 'hell.title',
  icon: 'H',
  messages,
  settings,
  options: mountOptions,
  panel: mountPanel,
  init,
}
export default mod
