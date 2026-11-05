import type { Module, AppContext } from '../../core/module'
import { t } from '../../core/i18n'
import { TakeRecorder, type Take } from './recorder'
import './recorder.css'

const messages = {
  en: {
    'recorder.title': 'Recordings',
    'recorder.record': 'Record',
    'recorder.stop': 'Stop',
    'recorder.empty': 'No recordings yet. Start listening, then press Record in the top bar.',
    'recorder.kept': '{n} of {max} kept. They are lost when the page is closed or reloaded.',
    'recorder.play': 'Play this recording',
    'recorder.stopPlaying': 'Stop playing',
    'recorder.download': 'Download as WAV',
    'recorder.delete': 'Delete this recording',
    'recorder.err.full': '{max} recordings are kept: delete one to record another.',
    'recorder.err.idle': 'Start listening before you record.',
  },
  es: {
    'recorder.title': 'Grabaciones',
    'recorder.record': 'Grabar',
    'recorder.stop': 'Detener',
    'recorder.empty': 'Aún no hay grabaciones. Empieza a escuchar y pulsa Grabar en la barra superior.',
    'recorder.kept': '{n} de {max} guardadas. Se pierden al cerrar o recargar la página.',
    'recorder.play': 'Reproducir esta grabación',
    'recorder.stopPlaying': 'Detener reproducción',
    'recorder.download': 'Descargar como WAV',
    'recorder.delete': 'Borrar esta grabación',
    'recorder.err.full': 'Se guardan {max} grabaciones: borra una para grabar otra.',
    'recorder.err.idle': 'Empieza a escuchar antes de grabar.',
  },
}

const mk = <E extends keyof HTMLElementTagNameMap>(tag: E, cls = '', text = '') => Object.assign(document.createElement(tag), { className: cls, textContent: text })
const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`
const size = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} kB`)

// One recorder per page, shared by the top-bar button and the list.
const rec = new TakeRecorder()

/** Top bar: the Record button, with the elapsed time while recording. */
function mountToolbar(host: HTMLElement, ctx: AppContext): () => void {
  const btn = mk('button', 'rec-btn')
  const dot = mk('span', 'rec-dot')
  const label = mk('span')
  btn.append(dot, label)
  const err = mk('span', 'err')
  err.setAttribute('role', 'status')
  host.append(btn, err)

  const render = () => {
    btn.classList.toggle('on', rec.recording)
    label.textContent = rec.recording ? `${t('recorder.stop')} ${clock(rec.elapsedMs)}` : t('recorder.record')
    btn.disabled = !rec.recording && !ctx.audio.running
    err.textContent = rec.error ? t(`recorder.err.${rec.error}`, { max: rec.limits.maxTakes }) : ''
  }
  btn.onclick = () => (rec.recording ? rec.stop() : rec.start(ctx.audio))
  const timer = setInterval(() => rec.recording && render(), 250)
  // Recording follows the audio: if listening stops, keep what was captured so far.
  const offAudio = ctx.bus.on('audio:state', ({ running }) => {
    if (!running) rec.stop()
    render()
  })
  const offRec = rec.subscribe(render)
  render()
  return () => {
    clearInterval(timer)
    offAudio()
    offRec()
  }
}

/** Lower panel: the takes, each of which can be played, saved as WAV or deleted. */
function mountPanel(host: HTMLElement): () => void {
  const urls = new Map<number, string>()
  const urlOf = (take: Take) => {
    let u = urls.get(take.id)
    if (!u) urls.set(take.id, (u = URL.createObjectURL(take.blob)))
    return u
  }
  const player = new Audio()
  let playing: number | null = null
  player.onended = () => {
    playing = null
    render()
  }

  const play = (take: Take) => {
    const was = playing
    player.pause()
    playing = null
    if (was !== take.id) {
      player.src = urlOf(take)
      void player.play()
      playing = take.id
    }
    render()
  }
  const save = (take: Take) => {
    const a = mk('a')
    a.href = urlOf(take)
    a.download = `recording-${new Date(take.wallStart).toISOString().replace(/[:.]/g, '-')}.wav`
    a.click()
  }
  const del = (take: Take) => {
    if (playing === take.id) play(take)
    const u = urls.get(take.id)
    if (u) URL.revokeObjectURL(u)
    urls.delete(take.id)
    rec.remove(take.id)
  }

  const btn = (cls: string, glyph: string, label: string, fn: () => void) => {
    const b = mk('button', `btn icon-btn ${cls}`, glyph)
    b.title = label
    b.setAttribute('aria-label', label)
    b.onclick = fn
    return b
  }

  function render() {
    if (!rec.takes.length) return host.replaceChildren(mk('p', 'hint', t('recorder.empty')))
    host.replaceChildren(
      ...rec.takes.map((take) => {
        const row = mk('div', 'rec-row')
        const info = mk('div', 'rec-info')
        info.append(
          mk('span', 'rec-name', new Date(take.wallStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })),
          mk('span', 'rec-meta', `${clock(take.ms)} · ${size(take.bytes)}`),
        )
        const on = playing === take.id
        row.append(
          info,
          btn('rec-play', on ? '■' : '▶', t(on ? 'recorder.stopPlaying' : 'recorder.play'), () => play(take)),
          btn('', '⤓', t('recorder.download'), () => save(take)),
          btn('', '✕', t('recorder.delete'), () => del(take)),
        )
        return row
      }),
      mk('p', 'hint', t('recorder.kept', { n: rec.takes.length, max: rec.limits.maxTakes })),
    )
  }
  const off = rec.subscribe(render)
  render()
  return () => {
    off()
    player.pause()
    urls.forEach((u) => URL.revokeObjectURL(u))
  }
}

const mod: Module = {
  id: 'recorder',
  title: 'recorder.title',
  icon: '●',
  messages,
  toolbar: mountToolbar,
  panel: mountPanel,
}
export default mod
