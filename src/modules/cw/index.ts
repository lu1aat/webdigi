import type { Module, AppContext } from '../../core/module'
import { settingField } from '../../core/controls'
import { t } from '../../core/i18n'
import { Skimmer, type Burst, type Channel, type Spot } from './core/skimmer/skimmer'
import { CallDatabase, classifyCall, classifyToken, type ValidationLevel } from './core/ham/callsign'
import { segmentWords } from './core/ham/segment'
import type { DecodedChar } from './core/decoder/cw-decoder'
import type { CouncilJob, CouncilResult } from './council.worker'
import { TxBusyError } from '../../core/audio/output'
import { generateCw } from './generator'
import { dotUnits } from './morse'
import './cw.css'

const messages = {
  en: {
    'cw.title': 'CW skimmer',
    'cw.thresh': 'Detection threshold',
    'cw.nb': 'Noise blanker',
    'cw.level': 'Callsign validation',
    'cw.council': 'Second look (council re-decode)',
    'cw.freq': 'TX tone (Hz)',
    'cw.txwpm': 'TX speed',
    'cw.amp': 'TX level',
    'cw.lv.minimal': 'Minimal',
    'cw.lv.normal': 'Normal',
    'cw.lv.aggressive': 'Aggressive',
    'cw.lv.paranoid': 'Paranoid',
    'cw.hint': 'Carriers are found and decoded automatically. Click the spectrum to decode any frequency by hand. Changes to the first four settings apply when you next start listening.',
    'cw.idle': 'Start listening to skim.',
    'cw.status': '{n} stations · {s} s',
    'cw.stations': 'Stations',
    'cw.col.freq': 'Hz',
    'cw.col.call': 'Call',
    'cw.col.wpm': 'WPM',
    'cw.col.snr': 'dB',
    'cw.col.text': 'Text',
    'cw.live': 'Live',
    'cw.refined': 'Second look',
    'cw.spots': 'Spots',
    'cw.empty': 'No stations yet.',
    'cw.clear': 'Clear spots',
    'cw.clearStations': 'Clear stations',
    'cw.clearStations.tip': 'Remove every station; their frequencies are ignored for 30 s',
    'cw.remove': 'Remove this station (ignored for 90 s)',
    'cw.setCall': 'Click a word to set it as this station\'s callsign (click it again to undo)',
    'cw.sent': 'Sent.',
    'cw.stopped': 'Stopped.',
    'cw.err.tx': 'Cannot transmit: {e}',
    'cw.nyq': 'The output device can only play up to {n} Hz: lower the TX tone.',
    'cw.busy': '{owner} is transmitting: only one module can transmit at a time.',
    'cw.send': 'Send',
    'cw.stop': 'Stop',
    'cw.text': 'Text to send',
    'cw.eta': '{s} s on air',
    'cw.sending': 'Transmitting…',
  },
  es: {
    'cw.title': 'Skimmer CW',
    'cw.thresh': 'Umbral de detección',
    'cw.nb': 'Supresor de ruido impulsivo',
    'cw.level': 'Validación de indicativos',
    'cw.council': 'Segunda lectura (consejo de decoders)',
    'cw.freq': 'Tono TX (Hz)',
    'cw.txwpm': 'Velocidad TX',
    'cw.amp': 'Nivel TX',
    'cw.lv.minimal': 'Mínima',
    'cw.lv.normal': 'Normal',
    'cw.lv.aggressive': 'Agresiva',
    'cw.lv.paranoid': 'Paranoica',
    'cw.hint': 'Las portadoras se detectan y decodifican solas. Haz clic en el espectro para decodificar una frecuencia a mano. Los cuatro primeros ajustes se aplican al volver a escuchar.',
    'cw.idle': 'Empieza a escuchar para hacer skimming.',
    'cw.status': '{n} estaciones · {s} s',
    'cw.stations': 'Estaciones',
    'cw.col.freq': 'Hz',
    'cw.col.call': 'Indicativo',
    'cw.col.wpm': 'WPM',
    'cw.col.snr': 'dB',
    'cw.col.text': 'Texto',
    'cw.live': 'En vivo',
    'cw.refined': 'Segunda lectura',
    'cw.spots': 'Spots',
    'cw.empty': 'Aún no hay estaciones.',
    'cw.clear': 'Limpiar spots',
    'cw.clearStations': 'Limpiar estaciones',
    'cw.clearStations.tip': 'Quita todas las estaciones; sus frecuencias se ignoran 30 s',
    'cw.remove': 'Quitar esta estación (se ignora 90 s)',
    'cw.setCall': 'Haz clic en una palabra para fijarla como indicativo de la estación (otro clic la deshace)',
    'cw.sent': 'Enviado.',
    'cw.stopped': 'Detenido.',
    'cw.err.tx': 'No se puede transmitir: {e}',
    'cw.nyq': 'La salida de audio solo reproduce hasta {n} Hz: baja el tono TX.',
    'cw.busy': '{owner} está transmitiendo: solo un módulo puede transmitir a la vez.',
    'cw.send': 'Enviar',
    'cw.stop': 'Detener',
    'cw.text': 'Texto a enviar',
    'cw.eta': '{s} s en el aire',
    'cw.sending': 'Transmitiendo…',
  },
}

const LEVELS: ValidationLevel[] = ['minimal', 'normal', 'aggressive', 'paranoid']
const settings = [
  { key: 'cw.thresh', label: 'cw.thresh', type: 'number' as const, default: 13, min: 6, max: 25, step: 1, control: 'slider' as const, unit: ' dB', hidden: true },
  { key: 'cw.nb', label: 'cw.nb', type: 'boolean' as const, default: false, hidden: true },
  { key: 'cw.level', label: 'cw.level', type: 'select' as const, default: 'normal', options: LEVELS.map((l) => ({ value: l, label: `cw.lv.${l}` })), hidden: true },
  { key: 'cw.council', label: 'cw.council', type: 'boolean' as const, default: true, hidden: true },
  { key: 'cw.freq', label: 'cw.freq', type: 'number' as const, default: 700, min: 200, max: 23000, step: 1, hidden: true },
  { key: 'cw.txwpm', label: 'cw.txwpm', type: 'number' as const, default: 20, min: 5, max: 50, step: 1, control: 'slider' as const, unit: ' WPM', hidden: true },
  { key: 'cw.amp', label: 'cw.amp', type: 'number' as const, default: 0.5, min: 0.05, max: 0.9, step: 0.05, control: 'slider' as const, hidden: true },
]

const mk = <E extends keyof HTMLElementTagNameMap>(tag: E, cls = '', text = '') => Object.assign(document.createElement(tag), { className: cls, textContent: text })

// ---- skimmer state (module-level: init feeds it, the panel only reads it) ----
let ctxRef: AppContext
let sk: Skimmer | null = null
let skRate = 0
const BLOCK = 2048
let acc = new Float32Array(BLOCK)
let accFill = 0
const channels = new Map<number, Channel>()
const callOf = new Map<number, string>()
/** Callsigns the user set by clicking a word; they win over the automatic ones. */
const manualCall = new Map<number, string>()
const callFor = (id: number) => manualCall.get(id) ?? callOf.get(id)
const spots: Spot[] = []
let selected: number | null = null
let dirty = true
let spotsDirty = true
const db = new CallDatabase()

// The council re-decoder is ~20x real time per decoder: it must never run on the UI thread.
let worker: Worker | null = null
const jobs = new Map<number, { sk: Skimmer; burst: Burst }>()
let jobSeq = 0
function sendToCouncil(from: Skimmer, burst: Burst): void {
  worker ??= (() => {
    const w = new Worker(new URL('./council.worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (e: MessageEvent<CouncilResult>) => {
      const job = jobs.get(e.data.id)
      jobs.delete(e.data.id)
      // A stale result from a skimmer that has since been replaced is dropped.
      if (job && job.sk === sk) handle(job.sk.submitRefined(job.burst, e.data.chars))
    }
    return w
  })()
  const id = ++jobSeq
  jobs.set(id, { sk: from, burst })
  const msg: CouncilJob = { id, samples: burst.samples, sampleRate: burst.sampleRate, freq: burst.freq }
  worker.postMessage(msg, [burst.samples.buffer])
}

const markerId = (id: number) => `cw:${id}`
let hovered: number | null = null
/** Canvas colours cannot use var(); read the theme's "listening" green when marking. */
const liveGreen = () => getComputedStyle(document.documentElement).getPropertyValue('--live').trim() || undefined
function mark(c: Channel): void {
  const sel = c.id === selected
  ctxRef.bus.emit('marker:set', {
    id: markerId(c.id),
    hz: c.track.freq,
    label: callFor(c.id) ?? `${c.wpm ? c.wpm.toFixed(0) : '?'}`,
    bw: 60,
    // Selected = green; hovered (row under the pointer) = emphasised, whatever its colour.
    color: sel ? liveGreen() : undefined,
    strong: sel || c.id === hovered,
  })
}
function markAll(): void {
  channels.forEach(mark)
}
function select(id: number | null): void {
  selected = id
  dirty = true
  markAll()
}
function hover(id: number | null): void {
  if (hovered === id) return
  hovered = id
  markAll()
}

function handle(events: ReturnType<Skimmer['process']>): void {
  for (const ev of events) {
    dirty = true
    if (ev.type === 'spawn') {
      channels.set(ev.channel.id, ev.channel)
      mark(ev.channel)
    } else if (ev.type === 'retire' || ev.type === 'reject') {
      // Keep the text of a retired station readable if it is the one being looked at.
      if (ev.type === 'reject' || ev.channel.id !== selected) channels.delete(ev.channel.id)
      if (ev.type === 'reject' && ev.channel.id === selected) selected = null
      if (hovered === ev.channel.id) hovered = null
      ctxRef.bus.emit('marker:clear', { id: markerId(ev.channel.id) })
    } else if (ev.type === 'spot') {
      callOf.set(ev.spot.channel, ev.spot.call)
      spots.push(ev.spot)
      spotsDirty = true
      const c = channels.get(ev.spot.channel)
      if (c) mark(c)
    } else if (ev.type === 'chars') {
      const text = ev.chars.map((c) => c.char).join('')
      if (text.trim()) ctxRef.bus.emit('message:rx', { source: 'cw', text, time: Date.now(), hz: ev.channel.track.freq })
    } else if (ev.type === 'burst' && sk) {
      sendToCouncil(sk, ev.burst)
    }
  }
}

function resetSkimmer(): void {
  for (const id of channels.keys()) ctxRef.bus.emit('marker:clear', { id: markerId(id) })
  sk = null
  channels.clear()
  callOf.clear()
  manualCall.clear()
  selected = null
  hovered = null
  accFill = 0
  dirty = spotsDirty = true
}

function buildSkimmer(rate: number): Skimmer {
  const s = ctxRef.settings
  skRate = rate
  return new Skimmer(rate, {
    noiseBlanker: s.get<boolean>('cw.nb'),
    bursts: s.get<boolean>('cw.council'),
    tracker: { thresholdDb: s.get<number>('cw.thresh') },
    extractor: { level: s.get<ValidationLevel>('cw.level'), db },
    spectrogram: { minFreq: 200, maxFreq: Math.min(3000, rate / 2 - 100) },
  })
}

function feed(block: Float32Array, rate: number): void {
  if (!sk || skRate !== rate) {
    resetSkimmer()
    sk = buildSkimmer(rate)
  }
  // The AudioWorklet delivers 128-sample blocks; the STFT is happier with bigger ones.
  for (let i = 0; i < block.length; ) {
    const n = Math.min(block.length - i, BLOCK - accFill)
    acc.set(block.subarray(i, i + n), accFill)
    accFill += n
    i += n
    if (accFill === BLOCK) {
      handle(sk.process(acc.slice()))
      accFill = 0
    }
  }
}

function removeStation(id: number, banSeconds = 90): void {
  const c = channels.get(id)
  if (!c) return
  sk?.remove(id, banSeconds)
  channels.delete(id)
  callOf.delete(id)
  manualCall.delete(id)
  if (selected === id) selected = null
  if (hovered === id) hovered = null
  ctxRef.bus.emit('marker:clear', { id: markerId(id) })
  dirty = true
}

function clearStations(): void {
  for (const id of [...channels.keys()]) removeStation(id, 30)
}

function setCall(id: number, word: string): void {
  const call = word.toUpperCase()
  // Clicking the call that is already set undoes it and returns to the automatic one.
  if (manualCall.get(id) === call) manualCall.delete(id)
  else manualCall.set(id, call)
  const c = channels.get(id)
  if (c) mark(c)
  dirty = true
}

function pick(hz: number): void {
  if (!sk) return
  const c = sk.addManual(Math.round(hz))
  handle([{ type: 'spawn', channel: c }])
  select(c.id)
  ctxRef.settings.set('cw.freq', Math.round(hz))
}

// ---- UI ----
function renderDecoded(el: HTMLElement, chars: readonly DecodedChar[], onWord?: (word: string) => void): void {
  const frag = document.createDocumentFragment()
  const letters = chars.filter((c) => c.char !== ' ')
  const words = segmentWords(letters)
  words.forEach((w, wi) => {
    const span = mk('span', `tok-${classifyToken(w.text)}${onWord ? ' word' : ''}`)
    if (onWord) span.onclick = () => onWord(w.text)
    for (let k = 0; k < w.text.length; k++) {
      const src = letters[w.start + k]
      // A letter repaired from the dictionary was doubtful in the first place.
      span.append(mk('span', src.confidence < 0.6 || src.char !== w.text[k] ? 'low' : '', w.text[k]))
    }
    frag.append(span)
    if (wi < words.length - 1) frag.append(' ')
  })
  const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 8
  el.replaceChildren(frag)
  if (stick) el.scrollTop = el.scrollHeight
}

function mountOptions(host: HTMLElement, ctx: AppContext): void {
  for (const d of settings) host.append(settingField(ctx.settings, d))
  host.append(mk('p', 'hint', t('cw.hint')))
}

function mountPanel(host: HTMLElement, ctx: AppContext): () => void {
  const tbody = mk('tbody')
  const table = mk('table', 'cw-table')
  const head = mk('tr')
  for (const c of ['freq', 'call', 'wpm', 'snr', 'text', '']) head.append(mk('th', '', c ? t(`cw.col.${c}`) : ''))
  table.append(Object.assign(mk('thead'), {}).appendChild(head).parentElement!, tbody)
  const tableWrap = mk('div', 'cw-scroll')
  tableWrap.append(table)
  // The rows are rebuilt while text arrives, so a row can vanish under the pointer without a mouseleave.
  tableWrap.onmouseleave = () => hover(null)
  const status = mk('span', '', t('cw.idle'))
  const clearStationsBtn = mk('button', 'btn', t('cw.clearStations'))
  clearStationsBtn.title = t('cw.clearStations.tip')
  clearStationsBtn.onclick = clearStations
  const h1 = mk('div', 'cw-h')
  h1.append(mk('span', '', t('cw.stations')), status, clearStationsBtn)

  const live = mk('div', 'cw-log')
  const refined = mk('div', 'cw-log refined')
  live.title = refined.title = t('cw.setCall')
  const info = mk('span')
  const h2 = mk('div', 'cw-h')
  h2.append(mk('span', '', t('cw.live')), info)
  const h3 = mk('div', 'cw-h')
  h3.append(mk('span', '', t('cw.refined')))

  const spotBox = mk('div', 'cw-scroll cw-spots')
  const clear = mk('button', 'btn', t('cw.clear'))
  const h4 = mk('div', 'cw-h')
  h4.append(mk('span', '', t('cw.spots')), clear)
  clear.onclick = () => ((spots.length = 0), (spotsDirty = true))

  const left = mk('div', 'cw-col')
  left.append(h1, tableWrap)
  const right = mk('div', 'cw-col')
  right.append(h2, live, h3, refined, h4, spotBox)
  const grid = mk('div', 'cw-grid')
  grid.append(left, right)
  // The second look only exists when the council is on, so hide its heading and box otherwise.
  const showRefined = () => (h3.hidden = refined.hidden = !s.get<boolean>('cw.council'))

  const s = ctx.settings
  const input = mk('input', 'cw-text')
  input.placeholder = t('cw.text')
  input.setAttribute('aria-label', t('cw.text'))
  const send = mk('button', 'btn btn-primary', t('cw.send'))
  const stop = mk('button', 'btn', t('cw.stop'))
  stop.disabled = true
  const eta = mk('span', 'hint cw-eta')
  const tx = mk('div', 'cw-row')
  tx.append(input, send, stop, eta)
  const root = mk('div', 'cw-root')
  root.append(tx, grid)
  host.append(root)

  showRefined()
  const offCouncil = s.watch('cw.council', showRefined)
  const updateEta = () => {
    eta.textContent = input.value ? t('cw.eta', { s: ((dotUnits(input.value) * 1.2) / s.get<number>('cw.txwpm')).toFixed(1) }) : ''
  }
  input.oninput = () => !sending && updateEta()
  let sending = false
  let stopped = false
  stop.onclick = () => ((stopped = true), ctx.output.stopAll())
  // Another module holding the transmit lock disables ours (and says who).
  const offTx = ctx.bus.on('tx:state', ({ owner }) => {
    const other = owner && owner !== 'cw' ? owner : null
    send.disabled = !!other
    if (other) eta.textContent = t('cw.busy', { owner: other.toUpperCase() })
    else if (!sending) updateEta()
  })
  const transmit = async () => {
    const text = input.value
    if (!text.trim() || sending) return
    const rate = 48000
    // A tone above the output device's Nyquist would be silently lost; say so instead of "sending" nothing.
    const nyq = Math.min(rate / 2, ctx.output.nyquist)
    if (s.get<number>('cw.freq') > nyq - 200) return void (eta.textContent = t('cw.nyq', { n: Math.floor(nyq - 200) }))
    const samples = generateCw(text, rate, { wpm: s.get<number>('cw.txwpm'), freqHz: s.get<number>('cw.freq'), amplitude: s.get<number>('cw.amp') })
    sending = true
    stopped = false
    send.disabled = true
    stop.disabled = false
    // Visible feedback matters: the sound goes to the system output, not to this page.
    eta.textContent = `${t('cw.sending')} (${s.get<number>('cw.freq')} Hz, ${(samples.length / rate).toFixed(1)} s)`
    try {
      await ctx.output.transmit('cw', samples, rate)
      // A stopped transmission keeps its text so it can be sent again.
      if (!stopped) input.value = ''
      eta.textContent = t(stopped ? 'cw.stopped' : 'cw.sent')
    } catch (e) {
      eta.textContent = e instanceof TxBusyError ? t('cw.busy', { owner: e.owner.toUpperCase() }) : t('cw.err.tx', { e: e instanceof Error ? e.message : String(e) })
    } finally {
      sending = false
      send.disabled = !!ctx.output.transmitting
      stop.disabled = true
    }
  }
  send.onclick = () => void transmit()
  input.onkeydown = (e) => {
    if (e.key === 'Enter') void transmit() // never return a value here: returning false would cancel every other keystroke
  }

  const render = () => {
    const list = [...channels.values()].sort((a, b) => a.track.freq - b.track.freq)
    tbody.replaceChildren(
      ...(list.length
        ? list.map((c) => {
            const tr = mk('tr', c.id === selected ? 'sel' : '')
            const call = callFor(c.id)
            const cells: [string, string][] = [
              [String(Math.round(c.track.freq)), ''],
              [call ?? '—', call ? 'call' : ''],
              [c.wpm ? c.wpm.toFixed(0) : '—', ''],
              [c.track.snr.toFixed(0), ''],
              [c.chars.slice(-24).map((x) => x.char).join(''), ''],
            ]
            for (const [text, cls] of cells) tr.append(mk('td', cls, text))
            const del = mk('button', 'btn icon-btn cw-del', '✕')
            del.title = del.ariaLabel = t('cw.remove')
            del.onclick = (e) => {
              e.stopPropagation() // do not also select the row we are removing
              removeStation(c.id)
            }
            tr.append(Object.assign(mk('td'), {}).appendChild(del).parentElement!)
            tr.onclick = () => select(c.id)
            tr.onmouseenter = () => hover(c.id)
            tr.onmouseleave = () => hover(null)
            return tr
          })
        : [Object.assign(mk('tr'), {}).appendChild(Object.assign(mk('td', '', t('cw.empty')), { colSpan: 6 })).parentElement!]),
    )
    const c = selected !== null ? channels.get(selected) : undefined
    if (c) {
      const setCallOfSelected = (w: string) => setCall(c.id, w)
      renderDecoded(live, c.chars, setCallOfSelected)
      if (c.refined) renderDecoded(refined, c.refined, setCallOfSelected)
      else refined.replaceChildren()
      info.textContent = `${Math.round(c.track.freq)} Hz · ${c.wpm.toFixed(0)} WPM · ${c.track.snr.toFixed(0)} dB`
    } else {
      live.replaceChildren()
      refined.replaceChildren()
      info.textContent = ''
    }
  }
  const renderSpots = () => {
    spotBox.replaceChildren(
      ...spots.slice(-200).map((p) => {
        const row = mk('div', p.cq ? 'cq' : '')
        const mm = Math.floor(p.time / 60)
        row.textContent = `${mm}:${String(Math.floor(p.time % 60)).padStart(2, '0')}  ${String(Math.round(p.freq)).padEnd(5)} ${p.call.padEnd(10)} ${p.cq ? 'CQ' : '  '} ${p.snr.toFixed(0).padStart(3)} dB ${p.wpm.toFixed(0).padStart(2)} WPM${classifyCall(p.call) === 'typical' ? '' : ' ?'}`
        return row
      }),
    )
    spotBox.scrollTop = spotBox.scrollHeight
  }

  let raf = 0
  let last = 0
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame)
    if (now - last < 250) return // chars arrive constantly; 4 Hz is plenty for text
    last = now
    status.textContent = ctx.audio.running && sk ? t('cw.status', { n: channels.size, s: Math.round(sk.time) }) : t('cw.idle')
    if (dirty) (dirty = false), render()
    if (spotsDirty) (spotsDirty = false), renderSpots()
  }
  raf = requestAnimationFrame(frame)
  return () => {
    cancelAnimationFrame(raf)
    offCouncil()
    offTx()
  }
}

function init(ctx: AppContext): void {
  ctxRef = ctx
  ctx.onTheme(markAll) // the green comes from the theme
  ctx.audio.onSamples((block, rate) => {
    if (ctx.isActive('cw')) feed(block, rate)
  })
  // Stopping the input or switching the module off drops the stations (and their ruler pins).
  ctx.bus.on('audio:state', ({ running }) => !running && resetSkimmer())
  ctx.bus.on('module:active', ({ id, active }) => id === 'cw' && !active && resetSkimmer())
  ctx.bus.on('view:pick', ({ hz }) => {
    if (ctx.isActive('cw') && ctx.settings.get('ui.selected') === 'cw') pick(hz)
  })
}

const mod: Module = { id: 'cw', title: 'cw.title', icon: 'CW', messages, settings, options: mountOptions, panel: mountPanel, init }
export default mod
