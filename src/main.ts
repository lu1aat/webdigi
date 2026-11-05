import './styles.css'
import { Bus } from './core/bus'
import { Settings } from './core/settings'
import { openStore } from './core/store'
import { AudioEngine } from './core/audio/engine'
import { AudioOutput } from './core/audio/output'
import { addMessages, detectLang, setLang, type Lang } from './core/i18n'
import { en, es } from './core/messages'
import { THEMES, applyTheme, readTheme } from './core/theme'
import { buildShell } from './core/shell'
import { settingsModule } from './core/settings-pane'
import type { AppContext } from './core/module'
import { modules as userModules } from './modules'

const modules = [...userModules, settingsModule]

async function main() {
  addMessages({ en, es })
  modules.forEach((m) => m.messages && addMessages(m.messages))

  const settings = new Settings()
  settings.register([
    {
      key: 'lang',
      label: 'settings.lang',
      type: 'select',
      default: detectLang(),
      options: [
        { value: 'en', label: 'English' },
        { value: 'es', label: 'Español' },
      ],
    },
    { key: 'theme', label: 'settings.theme', type: 'select', default: THEMES.includes('dark') ? 'dark' : THEMES[0], options: THEMES.map((id) => ({ value: id, label: id })) },
    { key: 'audio.device', label: 'settings.audioDevice', type: 'string', default: '', hidden: true },
    // Modules column + stage layout (see core/shell.ts)
    { key: 'ui.expanded', label: 'modules.title', type: 'boolean', default: true, hidden: true },
    { key: 'ui.selected', label: 'modules.title', type: 'string', default: '', hidden: true },
    { key: 'ui.panelHeight', label: 'modules.title', type: 'number', default: 380, min: 100, max: 4000, hidden: true },
    ...modules.filter((m) => !m.core).map((m) => ({ key: `modules.${m.id}.active`, label: m.title, type: 'boolean' as const, default: true, hidden: true })),
  ])
  modules.forEach((m) => m.settings && settings.register(m.settings))

  setLang(settings.get<Lang>('lang'))
  applyTheme(settings.get('theme'))

  const bus = new Bus()
  const audio = new AudioEngine(bus)
  const store = await openStore(modules.flatMap((m) => m.collections ?? []))
  const output = new AudioOutput()
  output.onTx = (owner) => bus.emit('tx:state', { owner })
  const themeSubs = new Set<() => void>()
  const ctx: AppContext = {
    bus,
    settings,
    store,
    audio,
    output,
    theme: readTheme,
    onTheme: (fn) => (themeSubs.add(fn), () => themeSubs.delete(fn)),
    isActive: (id) => !!modules.find((m) => m.id === id && (m.core || settings.get<boolean>(`modules.${id}.active`))),
  }
  for (const m of modules.filter((m) => !m.core)) settings.watch(`modules.${m.id}.active`, (v) => bus.emit('module:active', { id: m.id, active: !!v }))

  modules.forEach((m) => m.pipeline?.forEach((s) => audio.addStage(s)))
  buildShell(document.getElementById('app')!, ctx, modules)
  modules.forEach((m) => m.init?.(ctx))

  settings.watch('theme', (v) => {
    applyTheme(String(v))
    themeSubs.forEach((fn) => fn())
  })
  // Language changes rebuild the UI strings; simplest correct behaviour is a reload.
  settings.watch('lang', () => location.reload())

  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    navigator.serviceWorker.register('./sw.js').catch(() => {})
  }
}

void main()
