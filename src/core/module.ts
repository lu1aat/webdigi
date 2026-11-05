import type { Bus } from './bus'
import type { Settings, SettingDef } from './settings'
import type { Store } from './store'
import type { AudioEngine, PipelineStage } from './audio/engine'
import type { AudioOutput } from './audio/output'
import type { Messages, Lang } from './i18n'
import type { CanvasTheme } from './theme'

/** Everything a module may use. Modules must not import each other; use the bus. */
export interface AppContext {
  bus: Bus
  settings: Settings
  store: Store
  audio: AudioEngine
  output: AudioOutput
  /** Re-read canvas colours (call again after a theme change; also emitted via onTheme). */
  theme(): CanvasTheme
  onTheme(fn: () => void): () => void
  /** Whether the user has this module switched on in the Modules column. Core modules are always active. */
  isActive(id: string): boolean
}

/** Build UI into `el`; return a cleanup function if needed. */
export type Mount = (el: HTMLElement, ctx: AppContext) => void | (() => void)

export interface Module {
  /** Unique, lowercase, used to prefix settings keys and store collections. */
  id: string
  /** i18n key. */
  title: string
  /** Short glyph for the collapsed Modules column (1-2 characters). */
  icon?: string
  /** Cannot be switched off (e.g. the spectrum display). */
  core?: boolean

  /** Always-visible view in the upper area. Normally only one module provides it. */
  display?: Mount
  /** Shown in the lower area while this module is the selected one. */
  panel?: Mount
  /** Controls shown on this module's card in the Modules column (visible while the module is active). */
  options?: Mount

  messages?: Partial<Record<Lang, Messages>>
  settings?: SettingDef[]
  /** IndexedDB collections this module uses. */
  collections?: string[]
  /** Controls for the top bar (e.g. a Record button). Shown while the module is active. */
  toolbar?: Mount
  /** Audio filters/effects inserted into the input chain. */
  pipeline?: PipelineStage[]
  /** Called once after everything is mounted. Return a cleanup if needed. */
  init?(ctx: AppContext): void | (() => void)
}
