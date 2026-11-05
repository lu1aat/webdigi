import type { AppContext, Module } from './module'
import { t } from './i18n'

const METER_MIN_DB = -60 // bottom of the level meter
const METER_FALL_DB_S = 15 // how fast the held peak tick falls
const SILENT_DB = -100 // below this RMS the input is digital silence
const SILENT_AFTER_S = 4 // ... for this long before we say so

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text) e.textContent = text
  return e
}

/**
 * webDIGI identity: a dot-dash-dot glyph (the shared language of the CW and Hell digimodes)
 * next to the name. Built with DOM calls, no inline markup; colours come from theme tokens.
 */
function logo(): HTMLElement {
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('class', 'logo-mark')
  svg.setAttribute('aria-hidden', 'true')
  const shape = (tag: string, attrs: Record<string, string>) => {
    const n = document.createElementNS(NS, tag)
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v)
    svg.append(n)
  }
  shape('rect', { width: '24', height: '24', class: 'logo-bg' })
  shape('circle', { cx: '5.5', cy: '12', r: '2', class: 'logo-fg' })
  shape('rect', { x: '9', y: '10', width: '7', height: '4', class: 'logo-fg' })
  shape('circle', { cx: '19.5', cy: '12', r: '2', class: 'logo-fg' })
  const name = el('span', 'logo-name')
  name.append('web', el('b', '', 'DIGI'))
  const box = el('span', 'wordmark')
  box.setAttribute('aria-label', 'webDIGI')
  box.append(svg, name)
  return box
}

/**
 * Page layout:
 *   top bar (capture + input)
 *   Modules column | stage: display (upper) / splitter / selected module's panel (lower)
 * The Modules column is expanded (cards with options) or collapsed (tiles of active modules).
 * UI state lives in hidden settings: ui.expanded, ui.selected ("" = first panel, "none" = closed), ui.panelHeight.
 */
export function buildShell(root: HTMLElement, ctx: AppContext, modules: Module[]): void {
  const S = ctx.settings
  root.replaceChildren()

  // ---------------------------------------------------------------- top bar
  const bar = el('header', 'bar')
  const capture = el('button', 'capture')
  const lamp = el('span', 'capture-dot')
  const captureLabel = el('span', '', t('audio.start'))
  capture.append(lamp, captureLabel)
  const devices = el('select', 'dev')
  devices.title = t('audio.device')
  devices.setAttribute('aria-label', t('audio.device'))
  // input level meter: RMS bar, held peak tick, readout, clip lamp
  const meter = el('div', 'meter')
  meter.setAttribute('role', 'meter')
  meter.setAttribute('aria-label', t('audio.level'))
  meter.setAttribute('aria-valuemin', String(METER_MIN_DB))
  meter.setAttribute('aria-valuemax', '0')
  const track = el('div', 'meter-track')
  const fill = el('div', 'meter-fill')
  const hold = el('div', 'meter-hold')
  track.append(fill, hold)
  const read = el('span', 'meter-read', '—')
  const clipLamp = el('span', 'meter-clip')
  clipLamp.title = t('audio.clip')
  meter.append(track, read, clipLamp)

  const toolbar = el('div', 'toolbar')
  bar.append(logo(), capture, devices, meter, toolbar)

  const refreshDevices = async () => {
    try {
      const list = await ctx.audio.listInputs()
      devices.replaceChildren(new Option(t('audio.default'), ''))
      list.forEach((d, i) => devices.add(new Option(d.label || `${t('audio.input')} ${i + 1}`, d.deviceId)))
      devices.value = S.get<string>('audio.device')
    } catch {
      /* no mediaDevices (insecure context) — start() reports it */
    }
  }
  devices.onchange = () => S.set('audio.device', devices.value)
  S.watch('audio.device', (v) => void (devices.value = String(v))) // changed from the Devices module
  navigator.mediaDevices?.addEventListener('devicechange', () => void refreshDevices())

  // ---- empty state: what the display says until there is something to show
  let lastError = ''
  let starting = false
  let silent = false
  let silentFor = 0
  const curtain = el('div', 'curtain')
  curtain.setAttribute('role', 'status')
  type Mode = 'none' | 'idle' | 'error' | 'insecure' | 'silent'
  const mode = (): Mode => {
    if (!navigator.mediaDevices) return 'insecure' // browsers hide getUserMedia outside HTTPS / localhost
    if (ctx.audio.running) return silent ? 'silent' : 'none'
    return lastError ? 'error' : 'idle'
  }
  let shown = ''
  const renderCurtain = () => {
    const m = mode()
    const key = `${m}|${starting}|${lastError}`
    if (key === shown) return
    shown = key
    curtain.hidden = m === 'none'
    curtain.classList.toggle('note', m === 'silent') // silence is a hint over a live plot, not a cover
    if (m === 'none') return curtain.replaceChildren()
    const title = el('h2', 'curtain-title', t(m === 'idle' ? 'curtain.idle.title' : `curtain.${m}.title`))
    const body = el('p', 'curtain-body', m === 'error' ? lastError : t(`curtain.${m}.body`))
    curtain.replaceChildren(title, body)
    if (m === 'idle' || m === 'error') {
      const go = el('button', 'capture', starting ? t('curtain.starting') : t(m === 'error' ? 'curtain.retry' : 'audio.start'))
      go.prepend(el('span', 'capture-dot'))
      go.disabled = starting
      go.onclick = () => void toggle()
      curtain.append(go)
    }
  }

  const toggle = async () => {
    lastError = ''
    starting = true
    renderCurtain()
    try {
      if (ctx.audio.running) await ctx.audio.stop()
      else {
        await ctx.audio.start(devices.value || undefined)
        await refreshDevices() // labels become available after permission
      }
    } catch (e) {
      const key = e instanceof DOMException ? `audio.err.${e.name}` : ''
      lastError = key && t(key) !== key ? t(key) : e instanceof Error ? e.message : String(e)
    }
    starting = false
    renderCurtain()
  }
  capture.onclick = () => void toggle()
  const frac = (db: number) => (Number.isFinite(db) ? Math.min(1, Math.max(0, (db - METER_MIN_DB) / -METER_MIN_DB)) : 0)
  let held = -Infinity
  let clipUntil = 0
  let lastFrame = performance.now()
  let lastAria = 0
  const meterFrame = (now: number) => {
    requestAnimationFrame(meterFrame)
    const dt = Math.min(0.25, (now - lastFrame) / 1000)
    lastFrame = now
    const lv = ctx.audio.level()
    // digital silence for a few seconds: the wrong device, or a muted/blocked one
    silentFor = lv && lv.rmsDb < SILENT_DB ? silentFor + dt : 0
    const wasSilent = silent
    silent = silentFor > SILENT_AFTER_S
    if (silent !== wasSilent) renderCurtain()
    if (!lv) {
      held = -Infinity
      fill.style.clipPath = 'inset(0 100% 0 0)'
      hold.style.opacity = '0'
      read.textContent = '—'
      clipLamp.classList.remove('on')
      return
    }
    held = Math.max(lv.peakDb, held - METER_FALL_DB_S * dt)
    if (lv.peakDb >= -0.1) clipUntil = now + 1500
    fill.style.clipPath = `inset(0 ${((1 - frac(lv.rmsDb)) * 100).toFixed(1)}% 0 0)`
    hold.style.opacity = '1'
    hold.style.left = `${(frac(held) * 100).toFixed(1)}%`
    read.textContent = Number.isFinite(lv.rmsDb) ? `${lv.rmsDb.toFixed(0)} dB` : '−∞ dB'
    clipLamp.classList.toggle('on', now < clipUntil)
    if (now - lastAria > 250) {
      lastAria = now
      meter.setAttribute('aria-valuenow', String(Math.max(METER_MIN_DB, Math.round(lv.rmsDb))))
    }
  }
  requestAnimationFrame(meterFrame)

  ctx.bus.on('audio:state', ({ running }) => {
    silentFor = 0
    silent = false
    renderCurtain()
    captureLabel.textContent = running ? t('audio.stop') : t('audio.start')
    capture.classList.toggle('on', running)
  })
  void refreshDevices()
  const toolbarSlots = new Map<string, HTMLElement>()
  for (const m of modules)
    if (m.toolbar) {
      const slot = el('div', 'toolbar-slot')
      toolbar.append(slot)
      toolbarSlots.set(m.id, slot)
      m.toolbar(slot, ctx)
    }

  // ------------------------------------------------------------------ stage
  const column = el('nav', 'modules')
  column.setAttribute('aria-label', t('modules.title'))
  const stage = el('main', 'stage')
  const display = el('section', 'display')
  const splitter = el('div', 'splitter')
  splitter.setAttribute('role', 'separator')
  splitter.setAttribute('aria-orientation', 'horizontal')
  splitter.tabIndex = 0
  const panel = el('section', 'panel')
  const panelHead = el('header', 'panel-head')
  const panelTitle = el('h2', 'panel-title')
  const panelClose = el('button', 'btn icon-btn', '×')
  panelClose.title = panelClose.ariaLabel = t('modules.close')
  panelHead.append(panelTitle, panelClose)
  const panelBody = el('div', 'panel-body')
  panel.append(panelHead, panelBody)
  display.append(curtain)
  stage.append(display, splitter, panel)
  const body = el('div', 'body')
  body.append(column, stage)
  root.append(bar, body)

  renderCurtain()

  // Mount every module's pieces once; they are shown/hidden, never rebuilt.
  const options = new Map<string, HTMLElement>()
  const panels = new Map<string, HTMLElement>()
  for (const m of modules) {
    if (m.display) {
      const slot = el('div', 'display-slot')
      display.append(slot)
      m.display(slot, ctx)
    }
    if (m.options) {
      const n = el('div', 'mod-options')
      options.set(m.id, n)
      m.options(n, ctx)
    }
    if (m.panel) {
      const n = el('div', 'panel-slot')
      n.hidden = true
      panels.set(m.id, n)
      panelBody.append(n)
      m.panel(n, ctx)
    }
  }

  // ------------------------------------------------------------------ state
  const isOn = (m: Module) => ctx.isActive(m.id)
  const selectedId = (): string => {
    const s = S.get<string>('ui.selected')
    if (s === 'none') return ''
    const valid = (id: string) => modules.some((m) => m.id === id && (m.panel || m.options) && isOn(m))
    if (s) return valid(s) ? s : ''
    return modules.find((m) => m.panel && isOn(m))?.id ?? '' // first run: open the first panel
  }
  const pick = (m: Module) => S.set('ui.selected', selectedId() === m.id ? 'none' : m.id)

  const applyStage = () => {
    const id = selectedId()
    const hasPanel = panels.has(id) // a module with only options has nothing for the lower area
    panel.hidden = splitter.hidden = !hasPanel
    panels.forEach((n, k) => (n.hidden = k !== id))
    const m = modules.find((x) => x.id === id)
    panelTitle.textContent = m && hasPanel ? t(m.title) : ''
    stage.style.setProperty('--panel-h', `${S.get<number>('ui.panelHeight')}px`)
  }
  panelClose.onclick = () => S.set('ui.selected', 'none')

  // splitter: drag or arrow keys
  splitter.onpointerdown = (e) => {
    splitter.setPointerCapture(e.pointerId)
    let h = S.get<number>('ui.panelHeight')
    splitter.onpointermove = (ev) => {
      const r = stage.getBoundingClientRect()
      h = Math.round(Math.min(r.height - 180, Math.max(100, r.bottom - ev.clientY)))
      stage.style.setProperty('--panel-h', `${h}px`)
    }
    splitter.onpointerup = () => {
      splitter.onpointermove = splitter.onpointerup = null
      S.set('ui.panelHeight', h)
    }
  }
  splitter.onkeydown = (e) => {
    const d = e.key === 'ArrowUp' ? 24 : e.key === 'ArrowDown' ? -24 : 0
    if (!d) return
    e.preventDefault()
    S.set('ui.panelHeight', S.get<number>('ui.panelHeight') + d)
  }

  // ----------------------------------------------------------- Modules column
  const renderColumn = () => {
    const expanded = S.get<boolean>('ui.expanded')
    const sel = selectedId()
    column.dataset.expanded = String(expanded)
    column.replaceChildren()

    const head = el('div', 'col-head')
    const toggle = el('button', 'btn icon-btn', expanded ? '«' : '»')
    toggle.title = toggle.ariaLabel = t(expanded ? 'modules.collapse' : 'modules.expand')
    toggle.setAttribute('aria-expanded', String(expanded))
    toggle.onclick = () => S.set('ui.expanded', !expanded)
    if (expanded) head.append(el('h2', 'col-title', t('modules.title')))
    head.append(toggle)
    const list = el('div', 'col-list')
    column.append(head, list)

    for (const m of modules) {
      const on = isOn(m)
      const icon = m.icon ?? t(m.title).charAt(0).toUpperCase()

      if (!expanded) {
        if (!on) continue // collapsed: only active modules
        const tile = el('button', 'mod-tile', icon)
        tile.title = tile.ariaLabel = t(m.title)
        tile.setAttribute('aria-pressed', String(sel === m.id))
        // options live in the expanded column, so a module without a panel opens it
        tile.onclick = () => (m.panel ? pick(m) : (S.set('ui.selected', m.id), S.set('ui.expanded', true)))
        list.append(tile)
        continue
      }

      const card = el('section', 'mod')
      card.classList.toggle('selected', sel === m.id)
      card.classList.toggle('off', !on)
      const mhead = el('div', 'mod-head')
      const selectable = on && !!(m.panel || m.options)
      const main = el(selectable ? 'button' : 'div', 'mod-main')
      main.append(el('span', 'mod-icon', icon), el('span', 'mod-name', t(m.title)))
      if (selectable) {
        main.title = t('modules.show')
        main.setAttribute('aria-pressed', String(sel === m.id))
        main.onclick = () => pick(m)
      }
      mhead.append(main)
      if (!m.core) {
        const sw = el('label', 'switch')
        sw.title = t('modules.active')
        const box = el('input')
        box.type = 'checkbox'
        box.setAttribute('role', 'switch')
        box.setAttribute('aria-label', `${t('modules.active')}: ${t(m.title)}`)
        box.checked = on
        box.onchange = () => S.set(`modules.${m.id}.active`, box.checked)
        sw.append(box, el('span', 'track'))
        mhead.append(sw)
      }
      card.append(mhead)
      const opts = options.get(m.id)
      if (on && opts && sel === m.id) card.append(opts) // options are collapsed until the module is selected
      list.append(card)
    }
  }

  const refresh = () => {
    toolbarSlots.forEach((n, id) => (n.hidden = !ctx.isActive(id)))
    applyStage()
    renderColumn()
  }
  for (const k of ['ui.expanded', 'ui.selected', 'ui.panelHeight', ...modules.filter((m) => !m.core).map((m) => `modules.${m.id}.active`)]) S.watch(k, refresh)
  refresh()
}
