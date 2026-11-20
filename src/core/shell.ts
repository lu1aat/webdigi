import type { AppContext, Module } from './module'
import { t } from './i18n'

const METER_MIN_DB = -60 // bottom of the level meter
const METER_FALL_DB_S = 15 // how fast the held peak tick falls
const SILENT_DB = -100 // below this RMS the input is digital silence
const SILENT_AFTER_S = 4 // ... for this long before we say so
const RX_HOLD_MS = 1200 // a module's RX lamp stays lit this long after its last message:rx
const PANEL_MIN = 100 // px, lower area
const DISPLAY_MIN = 180 // px the splitter always leaves for the display
const NS = 'http://www.w3.org/2000/svg'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text) e.textContent = text
  return e
}

function svg(viewBox: string, cls: string, shapes: [string, Record<string, string>][]): SVGSVGElement {
  const s = document.createElementNS(NS, 'svg')
  s.setAttribute('viewBox', viewBox)
  s.setAttribute('class', cls)
  s.setAttribute('aria-hidden', 'true')
  for (const [tag, attrs] of shapes) {
    const n = document.createElementNS(NS, tag)
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v)
    s.append(n)
  }
  return s
}

/**
 * webDIGI identity: a dot-dash-dot glyph (the shared language of the CW and Hell digimodes)
 * next to the name. Built with DOM calls, no inline markup; colours come from theme tokens.
 */
function logo(): HTMLElement {
  const mark = svg('0 0 24 24', 'logo-mark', [
    ['rect', { width: '24', height: '24', class: 'logo-bg' }],
    ['circle', { cx: '5.5', cy: '12', r: '2', class: 'logo-fg' }],
    ['rect', { x: '9', y: '10', width: '7', height: '4', class: 'logo-fg' }],
    ['circle', { cx: '19.5', cy: '12', r: '2', class: 'logo-fg' }],
  ])
  const name = el('span', 'logo-name')
  name.append('web', el('b', '', 'DIGI'))
  const box = el('span', 'wordmark')
  box.setAttribute('aria-label', 'webDIGI')
  box.append(mark, name)
  return box
}

/** A module's glyph in a square. Two-letter marks (CW) are set smaller so they fit the same square. */
function glyph(m: Module): HTMLElement {
  const g = m.icon ?? t(m.title).charAt(0).toUpperCase()
  const n = el('span', 'mod-icon', g)
  if ([...g].length > 1) n.classList.add('pair')
  return n
}

/**
 * Page layout:
 *   top bar (capture + input)
 *   Modules column | stage: display (upper) / splitter / selected module's panel (lower)
 * The Modules column is expanded (a row per module, options under the selected one) or collapsed
 * (tiles of active modules). Rows and tiles are built once and patched, so focus survives updates.
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
  let meterIdle = false // the idle meter has been drawn; don't touch styles again until there is a level
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
      if (meterIdle) return
      meterIdle = true
      held = -Infinity
      fill.style.clipPath = 'inset(0 100% 0 0)'
      hold.style.opacity = '0'
      read.textContent = '—'
      clipLamp.classList.remove('on')
      meter.removeAttribute('aria-valuenow')
      return
    }
    meterIdle = false
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
  splitter.setAttribute('aria-label', t('modules.resize'))
  splitter.setAttribute('aria-valuemin', String(PANEL_MIN))
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
    // Nothing chosen yet: open the first active feature panel (not Settings), so a fresh session
    // shows the display alone and the first module switched on opens by itself.
    return modules.find((m) => m.panel && !m.core && isOn(m))?.id ?? ''
  }
  const pick = (m: Module) => S.set('ui.selected', selectedId() === m.id ? 'none' : m.id)

  const applyStage = () => {
    const id = selectedId()
    const hasPanel = panels.has(id) // a module with only options has nothing for the lower area
    panel.hidden = splitter.hidden = !hasPanel
    panels.forEach((n, k) => (n.hidden = k !== id))
    const m = modules.find((x) => x.id === id)
    panelTitle.textContent = m && hasPanel ? t(m.title) : ''
  }
  panelClose.onclick = () => S.set('ui.selected', 'none')

  // splitter: drag or arrow keys, always leaving DISPLAY_MIN for the display
  const maxPanel = () => Math.max(PANEL_MIN, Math.round(stage.getBoundingClientRect().height - DISPLAY_MIN))
  const applyHeight = () => {
    const h = S.get<number>('ui.panelHeight')
    stage.style.setProperty('--panel-h', `${h}px`)
    splitter.setAttribute('aria-valuenow', String(h))
    splitter.setAttribute('aria-valuemax', String(maxPanel()))
  }
  splitter.onpointerdown = (e) => {
    splitter.setPointerCapture(e.pointerId)
    let h = S.get<number>('ui.panelHeight')
    const bottom = stage.getBoundingClientRect().bottom
    const max = maxPanel()
    splitter.onpointermove = (ev) => {
      h = Math.round(Math.min(max, Math.max(PANEL_MIN, bottom - ev.clientY)))
      stage.style.setProperty('--panel-h', `${h}px`)
    }
    splitter.onpointerup = splitter.onpointercancel = () => {
      splitter.onpointermove = splitter.onpointerup = splitter.onpointercancel = null
      S.set('ui.panelHeight', h)
    }
  }
  splitter.onkeydown = (e) => {
    const d = e.key === 'ArrowUp' ? 24 : e.key === 'ArrowDown' ? -24 : 0
    if (!d) return
    e.preventDefault()
    const max = maxPanel() // a height saved on a taller window is clamped first, so Down acts at once
    S.set('ui.panelHeight', Math.min(max, Math.max(PANEL_MIN, Math.min(max, S.get<number>('ui.panelHeight')) + d)))
  }

  // ----------------------------------------------------------- Modules column
  // Built once: a row per module (expanded) and a tile per module (collapsed). renderColumn()
  // only patches classes and attributes, so a focused switch or row keeps focus when state changes.
  const colHead = el('div', 'col-head')
  const colTitle = el('h2', 'col-title', t('modules.title'))
  const colToggle = el('button', 'btn icon-btn col-toggle')
  colToggle.append(svg('0 0 16 16', 'chev', [['path', { d: 'M10 3.5 5.5 8l4.5 4.5' }]]))
  colToggle.onclick = () => S.set('ui.expanded', !S.get<boolean>('ui.expanded'))
  colHead.append(colTitle, colToggle)
  const rowList = el('div', 'col-list rows')
  // Active modules first, in column order; the switched-off ones are gathered below their own heading.
  const onList = el('div', 'mod-group')
  const offTitle = el('h3', 'mod-group-title', t('modules.inactive'))
  offTitle.id = 'mod-off-title'
  const offList = el('div', 'mod-group')
  offList.setAttribute('role', 'group')
  offList.setAttribute('aria-labelledby', offTitle.id)
  rowList.append(onList, offTitle, offList)
  const tileList = el('div', 'col-list tiles')
  column.append(colHead, rowList, tileList)

  /** A row that just changed group flashes once, so the eye can follow it to its new place. */
  const flash = (row: HTMLElement) => {
    row.classList.remove('moved')
    void row.offsetWidth // restart the animation when toggled again before it ends
    row.classList.add('moved')
  }

  interface Entry { m: Module; row: HTMLElement; main: HTMLButtonElement; box?: HTMLInputElement; tile: HTMLButtonElement; on?: boolean }
  const entries = new Map<string, Entry>()
  for (const m of modules) {
    const name = t(m.title)
    const row = el('section', 'mod')
    const head = el('div', 'mod-head')
    const main = el('button', 'mod-main')
    main.append(glyph(m), el('span', 'mod-name', name))
    main.title = t('modules.show')
    main.onclick = () => pick(m)
    head.append(main)
    let box: HTMLInputElement | undefined
    if (!m.core) {
      const sw = el('label', 'switch')
      sw.title = t('modules.active')
      const input = el('input')
      input.type = 'checkbox'
      input.setAttribute('role', 'switch')
      input.setAttribute('aria-label', `${t('modules.active')}: ${name}`)
      input.onchange = () => S.set(`modules.${m.id}.active`, input.checked)
      sw.append(input, el('span', 'track'))
      head.append(sw)
      box = input
    }
    row.append(head)
    // Options stay in the document (hidden, not removed): settingField() stops syncing a control
    // that is disconnected when its setting changes, e.g. the From/To fields when the spectrum pad zooms.
    const opts = options.get(m.id)
    if (opts) {
      opts.hidden = true
      row.append(opts)
    }
    row.addEventListener('animationend', (e) => e.animationName === 'moved' && row.classList.remove('moved'))
    onList.append(row) // renderColumn() moves it to its group
    const tile = el('button', 'mod-tile')
    tile.append(glyph(m))
    // options live in the expanded column, so a module without a panel opens it
    tile.onclick = () => (m.panel ? pick(m) : (S.set('ui.selected', m.id), S.set('ui.expanded', true)))
    tileList.append(tile)
    entries.set(m.id, { m, row, main, box, tile })
  }

  const renderColumn = () => {
    const expanded = S.get<boolean>('ui.expanded')
    const sel = selectedId()
    column.dataset.expanded = String(expanded)
    colTitle.hidden = rowList.hidden = !expanded
    tileList.hidden = expanded
    colToggle.title = colToggle.ariaLabel = t(expanded ? 'modules.collapse' : 'modules.expand')
    colToggle.setAttribute('aria-expanded', String(expanded))
    // Rows are re-slotted only when their group or place changes. Moving a node blurs it, so the
    // control that had focus gets it back (a keyboard user toggling a switch follows the row).
    const focused = document.activeElement
    const slot = { on: 0, off: 0 }
    for (const e of entries.values()) {
      const on = isOn(e.m)
      const list = on ? onList : offList
      const i = on ? slot.on++ : slot.off++
      if (list.children[i] !== e.row) list.insertBefore(e.row, list.children[i] ?? null)
      if (e.on !== undefined && e.on !== on) flash(e.row)
      e.on = on
    }
    offTitle.hidden = slot.off === 0
    if (focused instanceof HTMLElement && focused !== document.activeElement && focused.isConnected) focused.focus()
    for (const { m, row, main, box, tile } of entries.values()) {
      const on = isOn(m)
      const picked = sel === m.id
      row.classList.toggle('selected', picked)
      row.classList.toggle('off', !on)
      main.disabled = !(on && (m.panel || m.options))
      main.setAttribute('aria-pressed', String(picked))
      if (box) box.checked = on
      tile.hidden = !on // collapsed: only active modules
      tile.setAttribute('aria-pressed', String(picked))
      const opts = options.get(m.id)
      if (opts) opts.hidden = !(on && picked) // options are collapsed until the module is selected
    }
  }

  // RX / TX lamps on each module's glyph, driven by bus traffic modules already publish:
  // message:rx lights its source for RX_HOLD_MS, tx:state keeps the owner lit while it transmits.
  const rxTimers = new Map<string, number>()
  let txOwner: string | null = null
  const signal = (id: string) => {
    const e = entries.get(id)
    if (!e) return
    const s = txOwner === id ? 'tx' : rxTimers.has(id) ? 'rx' : ''
    for (const n of [e.row, e.tile]) {
      if (s) n.dataset.signal = s
      else delete n.dataset.signal
    }
    e.tile.title = e.tile.ariaLabel = s ? `${t(e.m.title)} (${t(`modules.${s}`)})` : t(e.m.title)
  }
  ctx.bus.on('message:rx', ({ source }) => {
    clearTimeout(rxTimers.get(source))
    rxTimers.set(
      source,
      window.setTimeout(() => {
        rxTimers.delete(source)
        signal(source)
      }, RX_HOLD_MS),
    )
    signal(source)
  })
  ctx.bus.on('tx:state', ({ owner }) => {
    const prev = txOwner
    txOwner = owner
    if (prev) signal(prev)
    if (owner) signal(owner)
  })

  const refresh = () => {
    toolbarSlots.forEach((n, id) => (n.hidden = !ctx.isActive(id)))
    applyStage()
    renderColumn()
  }
  for (const k of ['ui.expanded', 'ui.selected', ...modules.filter((m) => !m.core).map((m) => `modules.${m.id}.active`)]) S.watch(k, refresh)
  S.watch('ui.panelHeight', applyHeight) // the height only moves the splitter; nothing else re-renders
  refresh()
  applyHeight()
  entries.forEach((_, id) => signal(id))
}
