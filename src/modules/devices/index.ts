import type { Module, AppContext } from '../../core/module'
import { t } from '../../core/i18n'

const messages = {
  en: {
    'devices.title': 'Devices',
    'devices.input': 'Input',
    'devices.output': 'Output',
    'devices.outputUnsupported': 'This browser can only play to the system default output.',
    'devices.test': 'Play test tone',
    'devices.refresh': 'Refresh',
    'devices.current': 'Current input',
    'devices.context': 'Audio engine',
    'devices.all': 'All devices',
    'devices.none': 'None found.',
    'devices.unnamed': 'Unnamed device',
    'devices.labelsHint': 'Names appear after you start listening and allow the microphone.',
    'devices.stopped': 'Not listening.',
    'devices.kind.audioinput': 'input',
    'devices.kind.audiooutput': 'output',
    'devices.k.label': 'Name',
    'devices.k.rate': 'Sample rate',
    'devices.k.channels': 'Channels',
    'devices.k.echo': 'Echo cancellation',
    'devices.k.noise': 'Noise suppression',
    'devices.k.agc': 'Auto gain',
    'devices.k.latency': 'Input latency',
    'devices.k.state': 'State',
    'devices.k.base': 'Base latency',
    'devices.k.outLatency': 'Output latency',
    'devices.on': 'on',
    'devices.off': 'off',
  },
  es: {
    'devices.title': 'Dispositivos',
    'devices.input': 'Entrada',
    'devices.output': 'Salida',
    'devices.outputUnsupported': 'Este navegador solo puede reproducir en la salida predeterminada del sistema.',
    'devices.test': 'Reproducir tono de prueba',
    'devices.refresh': 'Actualizar',
    'devices.current': 'Entrada actual',
    'devices.context': 'Motor de audio',
    'devices.all': 'Todos los dispositivos',
    'devices.none': 'No se encontró ninguno.',
    'devices.unnamed': 'Dispositivo sin nombre',
    'devices.labelsHint': 'Los nombres aparecen al empezar a escuchar y permitir el micrófono.',
    'devices.stopped': 'No está escuchando.',
    'devices.kind.audioinput': 'entrada',
    'devices.kind.audiooutput': 'salida',
    'devices.k.label': 'Nombre',
    'devices.k.rate': 'Frecuencia de muestreo',
    'devices.k.channels': 'Canales',
    'devices.k.echo': 'Cancelación de eco',
    'devices.k.noise': 'Supresión de ruido',
    'devices.k.agc': 'Ganancia automática',
    'devices.k.latency': 'Latencia de entrada',
    'devices.k.state': 'Estado',
    'devices.k.base': 'Latencia base',
    'devices.k.outLatency': 'Latencia de salida',
    'devices.on': 'sí',
    'devices.off': 'no',
  },
}

const OUTPUT_KEY = 'devices.output'
const ms = (s: number | undefined) => (s === undefined ? '—' : `${(s * 1000).toFixed(1)} ms`)
const flag = (b: boolean | undefined) => (b === undefined ? '—' : t(b ? 'devices.on' : 'devices.off'))
/** Device ids are long opaque strings; the head is enough to tell them apart. */
const short = (id: string) => (id ? `${id.slice(0, 8)}…` : '—')

function mount(host: HTMLElement, ctx: AppContext): () => void {
  const { audio, output, settings, bus } = ctx
  const mk = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => Object.assign(document.createElement(tag), { className: cls, textContent: text })

  const field = (label: string, control: HTMLElement) => {
    const row = mk('label', 'field')
    row.append(mk('span', '', t(label)), control)
    return row
  }
  const inSel = mk('select', 'wide')
  const outSel = mk('select', 'wide')
  const err = mk('p', 'err')
  err.setAttribute('role', 'status')
  const note = mk('p', 'hint')
  const actions = mk('div', 'row')
  const test = mk('button', 'btn', t('devices.test'))
  const refreshBtn = mk('button', 'btn', t('devices.refresh'))
  actions.append(test, refreshBtn)
  const current = mk('div')
  const all = mk('div')
  host.append(field('devices.input', inSel), field('devices.output', outSel), note, err, actions, current, all)

  /** A titled list of label/value rows. */
  const kv = (title: string, rows: [string, string][]) => {
    const box = mk('div')
    box.append(mk('h4', 'group', t(title)))
    const dl = mk('dl', 'kv')
    for (const [k, v] of rows) dl.append(mk('dt', '', t(k)), mk('dd', '', v))
    box.append(dl)
    return box
  }

  function renderInfo() {
    const info = audio.inputInfo
    const s = info?.settings
    current.replaceChildren(
      info
        ? kv('devices.current', [
            ['devices.k.label', info.label || '—'],
            ['devices.k.rate', s?.sampleRate ? `${s.sampleRate} Hz` : '—'],
            ['devices.k.channels', String(s?.channelCount ?? '—')],
            ['devices.k.echo', flag(s?.echoCancellation)],
            ['devices.k.noise', flag(s?.noiseSuppression)],
            ['devices.k.agc', flag(s?.autoGainControl)],
            ['devices.k.latency', ms((s as { latency?: number } | undefined)?.latency)],
          ])
        : mk('p', 'hint', t('devices.stopped')),
    )
    if (audio.ctx) {
      current.append(
        kv('devices.context', [
          ['devices.k.state', audio.ctx.state],
          ['devices.k.rate', `${audio.ctx.sampleRate} Hz`],
          ['devices.k.base', ms(audio.ctx.baseLatency)],
          ['devices.k.outLatency', ms(audio.ctx.outputLatency)],
        ]),
      )
    }
  }

  async function refresh() {
    let devs: MediaDeviceInfo[] = []
    try {
      devs = await navigator.mediaDevices.enumerateDevices()
    } catch {
      err.textContent = t('audio.err.SecurityError') // mediaDevices only exists on HTTPS / localhost
    }
    const fill = (sel: HTMLSelectElement, kind: MediaDeviceKind, saved: string) => {
      sel.replaceChildren(new Option(t('audio.default'), ''))
      devs.filter((d) => d.kind === kind).forEach((d, i) => sel.add(new Option(d.label || `${t('devices.unnamed')} ${i + 1}`, d.deviceId)))
      sel.value = saved
    }
    fill(inSel, 'audioinput', settings.get<string>('audio.device'))
    fill(outSel, 'audiooutput', settings.get<string>(OUTPUT_KEY))
    outSel.disabled = !output.canSelectDevice
    test.disabled = false
    note.textContent = !output.canSelectDevice ? t('devices.outputUnsupported') : devs.some((d) => d.label) ? '' : t('devices.labelsHint')

    all.replaceChildren(mk('h4', 'group', t('devices.all')))
    if (!devs.length) all.append(mk('p', 'hint', t('devices.none')))
    for (const d of devs) {
      const row = mk('div', 'dev-row')
      row.append(mk('span', 'dev-kind', t(`devices.kind.${d.kind}`)), mk('span', 'dev-name', d.label || t('devices.unnamed')))
      row.title = `id ${short(d.deviceId)} · group ${short(d.groupId)}`
      all.append(row)
    }
    renderInfo()
  }

  inSel.onchange = async () => {
    err.textContent = ''
    settings.set('audio.device', inSel.value)
    if (!audio.running) return
    try {
      await audio.start(inSel.value || undefined) // restart the stream on the new device
    } catch (e) {
      err.textContent = e instanceof Error ? e.message : String(e)
    }
    renderInfo()
  }
  outSel.onchange = async () => {
    err.textContent = ''
    settings.set(OUTPUT_KEY, outSel.value)
    try {
      await output.setDevice(outSel.value)
    } catch (e) {
      err.textContent = e instanceof Error ? e.message : String(e)
    }
  }
  test.onclick = () => void output.tone(440, 0.5, 0.2).catch((e) => (err.textContent = e instanceof Error ? e.message : String(e)))
  refreshBtn.onclick = () => void refresh()

  navigator.mediaDevices?.addEventListener('devicechange', refresh)
  const offState = bus.on('audio:state', () => void refresh()) // labels appear once permission is granted
  const offDevice = settings.watch('audio.device', () => (inSel.value = settings.get<string>('audio.device'))) // changed from the top bar
  void refresh()

  return () => {
    navigator.mediaDevices?.removeEventListener('devicechange', refresh)
    offState()
    offDevice()
  }
}

const mod: Module = {
  id: 'devices',
  title: 'devices.title',
  icon: '◉',
  messages,
  settings: [{ key: OUTPUT_KEY, label: 'devices.output', type: 'string', default: '', hidden: true }],
  panel: mount,
  /** Restore the saved output device on load. */
  init(ctx) {
    const id = ctx.settings.get<string>(OUTPUT_KEY)
    if (id) ctx.output.setDevice(id).catch(() => {})
  },
}
export default mod
