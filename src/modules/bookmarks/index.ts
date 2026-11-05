import type { Module, AppContext } from '../../core/module'
import { settingField } from '../../core/controls'
import { t } from '../../core/i18n'
import { messages } from './messages'
import { controller, defs, K } from './controller'
import type { Bookmark } from './store'
import './bookmarks.css'

const mk = <E extends keyof HTMLElementTagNameMap>(tag: E, cls = '', text = '') => Object.assign(document.createElement(tag), { className: cls, textContent: text })

function numInput(value: number, label: string, onChange: (n: number) => void): HTMLInputElement {
  const i = mk('input')
  i.type = 'number'
  i.value = String(value)
  i.setAttribute('aria-label', label)
  i.onchange = () => onChange(Number(i.value))
  return i
}

function iconBtn(glyph: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = mk('button', 'btn icon-btn', glyph)
  b.title = label
  b.setAttribute('aria-label', label)
  b.onclick = onClick
  return b
}

function download(name: string, text: string, type: string) {
  const a = mk('a')
  a.href = URL.createObjectURL(new Blob([text], { type }))
  a.download = name
  a.click()
  URL.revokeObjectURL(a.href)
}

interface Row {
  fill: HTMLElement
  peakMark: HTMLElement
  now: HTMLElement
  peak: HTMLElement
  bell: HTMLElement
  trend: HTMLCanvasElement
  bm: Bookmark
}

/** Lower panel: one row per bookmark, numbered like its pin on the ruler. */
function mountPanel(host: HTMLElement, ctx: AppContext): () => void {
  const ctl = controller(ctx)
  const { store } = ctl
  const empty = mk('p', 'hint', t('bookmarks.empty'))
  const wrap = mk('div', 'bm-wrap')
  const table = mk('table', 'bm-table')
  const head = mk('tr')
  for (const c of ['', 'name', 'freq', 'bw', 'level', 'now', 'peak', 'trend', 'alarm', '']) head.append(mk('th', `c-${c || 'x'}`, c ? t(`bookmarks.col.${c}`) : ''))
  const thead = mk('thead')
  thead.append(head)
  const body = mk('tbody')
  table.append(thead, body)
  wrap.append(table)
  host.append(empty, wrap)

  let rows: Row[] = []
  const rebuild = () => {
    const items = store.items
    empty.hidden = items.length > 0
    wrap.hidden = items.length === 0
    rows = []
    body.replaceChildren(
      ...items.map((m, i) => {
        const tr = mk('tr')
        tr.style.setProperty('--pin', m.color)

        const pin = mk('td', 'c-pin')
        const badge = mk('button', 'pin-badge', String(i + 1))
        badge.title = t('bookmarks.focus')
        badge.onclick = () => ctx.bus.emit('view:focus', { hz: m.freq })
        const color = mk('input', 'pin-color')
        color.type = 'color'
        color.value = /^#[0-9a-f]{6}$/i.test(m.color) ? m.color : '#ffb45a'
        color.title = t('bookmarks.color')
        color.onchange = () => store.update(m.id, { color: color.value })
        pin.append(badge, color)

        const name = mk('input', 'cell-name')
        name.value = m.name
        name.setAttribute('aria-label', t('bookmarks.col.name'))
        name.onchange = () => store.update(m.id, { name: name.value.trim() || m.name })
        const tdName = mk('td', 'c-name')
        tdName.append(name)

        const tdFreq = mk('td', 'c-freq')
        tdFreq.append(numInput(m.freq, t('bookmarks.col.freq'), (n) => store.update(m.id, { freq: n })))
        const tdBw = mk('td', 'c-bw')
        tdBw.append(numInput(m.bw, t('bookmarks.col.bw'), (n) => store.update(m.id, { bw: n })))

        const meter = mk('div', 'row-meter')
        const fill = mk('div', 'row-meter-fill')
        const peakMark = mk('div', 'row-meter-peak')
        meter.append(fill, peakMark)
        const tdMeter = mk('td', 'c-level')
        tdMeter.append(meter)

        const now = mk('td', 'c-now num', '—')
        const peak = mk('td', 'c-peak num', '—')
        const trend = mk('canvas', 'row-trend')
        const tdTrend = mk('td', 'c-trend')
        tdTrend.append(trend)

        const bell = mk('button', 'btn icon-btn alarm-bell', '◉')
        bell.title = bell.ariaLabel = t('bookmarks.alarmOn', { n: i + 1 })
        bell.classList.toggle('on', m.alarm)
        bell.setAttribute('aria-pressed', String(m.alarm))
        bell.onclick = () => store.update(m.id, { alarm: !m.alarm })
        const trigger = numInput(m.alarmDb, t('bookmarks.col.alarm'), (n) => store.update(m.id, { alarmDb: n }))
        trigger.min = '-150'
        trigger.max = '0'
        const tdAlarm = mk('td', 'c-alarm')
        tdAlarm.append(bell, trigger)

        const up = iconBtn('▲', t('bookmarks.up'), () => store.move(m.id, -1))
        up.disabled = i === 0
        const down = iconBtn('▼', t('bookmarks.down'), () => store.move(m.id, 1))
        down.disabled = i === items.length - 1
        const rm = iconBtn('✕', t('bookmarks.remove'), () => store.remove(m.id))
        const tdAct = mk('td', 'c-actions')
        tdAct.append(up, down, rm)

        tr.append(pin, tdName, tdFreq, tdBw, tdMeter, now, peak, tdTrend, tdAlarm, tdAct)
        rows.push({ fill, peakMark, now, peak, bell, trend, bm: m })
        return tr
      }),
    )
  }

  const frac = (db: number) => {
    const { min, max } = ctl.range
    return Number.isFinite(db) ? Math.min(1, Math.max(0, (db - min) / Math.max(1, max - min))) : 0
  }

  function drawTrend(r: Row) {
    const c = r.trend
    const dpr = window.devicePixelRatio || 1
    const w = Math.max(1, Math.round(c.clientWidth * dpr))
    const h = Math.max(1, Math.round(c.clientHeight * dpr))
    if (c.width !== w || c.height !== h) [c.width, c.height] = [w, h]
    const g = c.getContext('2d')!
    g.clearRect(0, 0, w, h)
    const hist = store.history(r.bm.id)
    const finite = hist.filter(Number.isFinite)
    if (finite.length < 2) return
    // floor the span so a steady reading is not magnified into noise
    let min = Math.min(...finite)
    let max = Math.max(...finite)
    if (max - min < 6) [min, max] = [(max + min) / 2 - 3, (max + min) / 2 + 3]
    g.strokeStyle = r.bm.color
    g.lineWidth = 1.2 * dpr
    g.lineJoin = 'round'
    g.beginPath()
    let pen = false
    hist.forEach((v, i) => {
      if (!Number.isFinite(v)) return void (pen = false)
      const x = (i / (hist.length - 1)) * w
      const y = h - ((v - min) / (max - min)) * h
      pen ? g.lineTo(x, y) : g.moveTo(x, y)
      pen = true
    })
    g.stroke()
  }

  let last = 0
  const offFrame = ctl.onFrame((now) => {
    if (now - last < 66 || !wrap.offsetParent) return // ~15 fps, and only while the panel is visible
    last = now
    for (const r of rows) {
      const l = store.level(r.bm.id)
      r.fill.style.width = `${(frac(l.db) * 100).toFixed(1)}%`
      r.now.textContent = Number.isFinite(l.db) ? l.db.toFixed(1) : '—'
      r.peakMark.style.opacity = Number.isFinite(l.peak) ? '0.85' : '0'
      r.peakMark.style.left = `${(frac(l.peak) * 100).toFixed(1)}%`
      r.peak.textContent = Number.isFinite(l.peak) ? l.peak.toFixed(1) : '—'
      r.bell.classList.toggle('is-sounding', ctl.alarm.active.has(r.bm.id))
      drawTrend(r)
    }
  })
  const offStore = store.subscribe(rebuild)
  rebuild()
  return () => {
    offFrame()
    offStore()
  }
}

/** Modules-column card: adding, tools, alarm settings, import/export. */
function mountOptions(host: HTMLElement, ctx: AppContext): void {
  const ctl = controller(ctx)
  const { store } = ctl
  const { settings } = ctx
  const def = (k: string) => defs.find((d) => d.key === K(k))!
  const status = mk('p', 'hint')
  status.setAttribute('role', 'status')
  const say = (msg: string) => void (status.textContent = msg)
  const group = (key: string) => host.append(mk('h4', 'group', t(key)))
  const chips = (items: [string, () => void, string?][]) => {
    const row = mk('div', 'chips')
    for (const [label, fn, tip] of items) {
      const b = mk('button', 'chip', t(label))
      if (tip) b.title = t(tip)
      b.onclick = fn
      row.append(b)
    }
    host.append(row)
  }

  group('bookmarks.group.add')
  const add = mk('button', 'btn wide-btn')
  const label = () => {
    add.textContent = ctl.lastHz === null ? t('bookmarks.add') : t('bookmarks.addAt', { hz: Math.round(ctl.lastHz) })
    add.title = ctl.lastHz === null ? t('bookmarks.addHint') : ''
  }
  add.onclick = () => (ctl.add() ? say('') : say(t('bookmarks.addHint')))
  label()
  ctl.onPick(label)
  host.append(add, settingField(settings, def('clickAdds')), settingField(settings, def('defaultBw')))

  group('bookmarks.group.tools')
  const listening = (n: number) => say(n < 0 ? t('bookmarks.listenFirst') : t('bookmarks.added', { n }))
  chips([
    ['bookmarks.harmonics', () => listening(ctl.markHarmonics()), 'bookmarks.harmonicsTip'],
    ['bookmarks.mains50', () => listening(ctl.markMains(50))],
    ['bookmarks.mains60', () => listening(ctl.markMains(60))],
    ['bookmarks.resetPeaks', () => store.resetPeaks()],
  ])

  group('bookmarks.group.alarms')
  host.append(settingField(settings, def('alarmVolume')), settingField(settings, def('alarmMuted')))
  chips([['bookmarks.disableAlarms', () => say(t('bookmarks.disabled', { n: store.disableAllAlarms() }))]])

  group('bookmarks.group.data')
  const file = mk('input')
  file.type = 'file'
  file.accept = 'application/json,.json'
  file.hidden = true
  file.onchange = async () => {
    const f = file.files?.[0]
    file.value = ''
    if (!f) return
    try {
      say(t('bookmarks.imported', { n: store.importJson(await f.text()) }))
    } catch (e) {
      say(t(`bookmarks.err.${e instanceof Error ? e.message : ''}`))
    }
  }
  chips([
    ['bookmarks.exportCsv', () => download('bookmarks.csv', store.toCsv(), 'text/csv')],
    ['bookmarks.exportJson', () => download('bookmarks.json', store.toJson(), 'application/json')],
    ['bookmarks.import', () => file.click()],
    ['bookmarks.clear', () => confirm(t('bookmarks.clearConfirm')) && store.clear()],
  ])
  host.append(file, status)
}

const mod: Module = {
  id: 'bookmarks',
  title: 'bookmarks.title',
  icon: '★',
  messages,
  settings: defs,
  collections: ['bookmarks'],
  panel: mountPanel,
  options: mountOptions,
  init: (ctx) => void controller(ctx),
}
export default mod
