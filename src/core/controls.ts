import type { Settings, SettingDef } from './settings'
import { t } from './i18n'

/**
 * Builds a labelled control for one setting (select, checkbox, slider, number or text).
 * It stays in sync when the setting changes elsewhere (zoom buttons, import, ...).
 * Used by the core Settings pane and available to modules for their own control panes.
 */
export function settingField(settings: Settings, d: SettingDef): HTMLElement {
  const row = document.createElement('label')
  row.className = 'field'
  const name = document.createElement('span')
  name.textContent = t(d.label)
  row.append(name)

  let sync: () => void
  const v = () => settings.get(d.key)

  if (d.type === 'select') {
    const s = document.createElement('select')
    d.options?.forEach((o) => s.add(new Option(t(o.label), o.value)))
    s.onchange = () => settings.set(d.key, s.value)
    sync = () => void (s.value = String(v()))
    row.append(s)
  } else if (d.type === 'boolean') {
    const i = document.createElement('input')
    i.type = 'checkbox'
    i.onchange = () => settings.set(d.key, i.checked)
    sync = () => void (i.checked = v() as boolean)
    row.append(i)
  } else if (d.type === 'number') {
    const i = document.createElement('input')
    const slider = d.control === 'slider'
    i.type = slider ? 'range' : 'number'
    if (d.min !== undefined) i.min = String(d.min)
    if (d.max !== undefined) i.max = String(d.max)
    if (d.step !== undefined) i.step = String(d.step)
    const out = document.createElement('output')
    const commit = () => {
      const n = Number(i.value)
      if (Number.isFinite(n)) settings.set(d.key, n)
    }
    if (slider) i.oninput = commit
    else i.onchange = commit
    sync = () => {
      i.value = String(v())
      out.textContent = `${v()}${d.unit ?? ''}`
    }
    row.append(i)
    if (slider) row.append(out)
  } else {
    const i = document.createElement('input')
    i.onchange = () => settings.set(d.key, i.value)
    sync = () => void (i.value = String(v()))
    row.append(i)
  }

  sync()
  const off = settings.watch(d.key, () => {
    if (!row.isConnected) return off() // the pane was re-rendered; stop updating a dead row
    sync()
  })
  return row
}
