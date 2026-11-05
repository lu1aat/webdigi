import type { Module, AppContext } from './module'
import { t } from './i18n'
import { THEMES } from './theme'
import { settingField } from './controls'

function mount(host: HTMLElement, ctx: AppContext): void {
  const { settings } = ctx
  const render = () => {
    host.replaceChildren()
    const groups = new Map<string, ReturnType<typeof settings.definitions>>()
    for (const d of settings.definitions().filter((d) => !d.hidden)) {
      const g = d.key.includes('.') ? d.key.split('.')[0] : 'app'
      groups.set(g, [...(groups.get(g) ?? []), d])
    }
    for (const list of groups.values()) {
      for (const d of list) {
        const row = settingField(settings, d)
        // hide the theme picker until a second theme exists
        if (d.key === 'theme' && THEMES.length < 2) row.hidden = true
        host.append(row)
      }
    }
    const io = document.createElement('div')
    io.className = 'row'
    const exp = document.createElement('button')
    exp.className = 'btn'
    exp.textContent = t('settings.export')
    exp.onclick = () => {
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([JSON.stringify(settings.exportAll(), null, 2)], { type: 'application/json' }))
      a.download = 'webdigi-settings.json'
      a.click()
      URL.revokeObjectURL(a.href)
    }
    const imp = document.createElement('button')
    imp.className = 'btn'
    imp.textContent = t('settings.import')
    imp.onclick = () => {
      const inp = document.createElement('input')
      inp.type = 'file'
      inp.accept = 'application/json'
      inp.onchange = async () => {
        const f = inp.files?.[0]
        if (!f) return
        try {
          settings.importAll(JSON.parse(await f.text()))
          render()
        } catch {
          /* ignore invalid file */
        }
      }
      inp.click()
    }
    io.append(exp, imp)
    const reset = document.createElement('button')
    reset.className = 'btn danger'
    reset.textContent = t('settings.reset')
    reset.onclick = () => {
      if (!confirm(t('settings.resetConfirm'))) return
      settings.resetAll()
      location.reload() // views hold the old values; start clean
    }
    io.append(reset)
    host.append(io)
  }
  render()
}

/** The built-in Settings module (language, theme, export/import). Always the last card. */
export const settingsModule: Module = { id: 'settings', title: 'settings.title', icon: '⚙', core: true, panel: mount }
