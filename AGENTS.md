# AGENTS.md

Base template for browser-only audio apps (capture, waterfall, decoders, visualisation) that work
online and offline. Copy the repo, delete the modules you don't need, add yours.

## Commands

```bash
npm run dev        # vite on :5173 (getUserMedia works on localhost)
npm run dev:https  # same, self-signed HTTPS: needed for the mic from another device on the LAN
npm run build      # tsc --noEmit && vite build -> dist/
npm test           # vitest (node environment, no DOM)
npm run typecheck
```

**After any change the user will see by refreshing the browser, run `npm run build`** (it also
typechecks). The site is often served from `dist/`, which only changes on a build.
`tsc` (strict, noUnused*) is the style gate; there is no linter.

## Hard constraints

1. No backend. `dist/` must work from any static host or sub-path (`base: './'`).
2. No runtime network requests. The build injects a CSP (see `vite.config.ts`); if a change trips
   it, the change is wrong. A module that needs the network declares its hosts (below).
3. No audio leaves the machine unless the user enables a module that says so.
4. TypeScript + Vite + Web Audio/`AudioWorklet`. No UI framework, no DSP dependencies.
5. DSP conventions: no allocation in worklet `process()` beyond the transferred block; thin
   worklets, heavy work on the main thread or a Worker.

## Layout

```
src/main.ts              composition root: settings, i18n, theme, engine, store, modules, shell
src/core/bus.ts          typed pub/sub (BusTopics); the only way modules talk to each other
src/core/settings.ts     typed settings registry over localStorage (prefix "awt:"), export/import
src/core/store.ts        IndexedDB key/value store, one collection per name
src/core/i18n.ts         en + es string tables, t("key", {param})
src/core/theme.ts        theme discovery + CanvasTheme (colours + waterfall LUT) for renderers
src/core/module.ts       the Module / AppContext contract
src/core/controls.ts     settingField(): one labelled control per setting, reused by modules
src/core/shell.ts        top bar, Modules column, stage (display / splitter / panel)
src/core/settings-pane.ts the built-in Settings module (language, theme, export/import)
src/core/audio/engine.ts input capture -> pipeline stages -> analyser + tap worklet
src/core/audio/output.ts tone / WAV / sample playback (transmit side)
src/modules/<id>/        feature modules, auto-discovered (src/modules/index.ts)
src/themes/*.css         one file per theme
public/sw.js             app-shell service worker (stale-while-revalidate)
```

Core knows nothing about specific modules. Modules never import each other: they use
`ctx.bus`, `ctx.settings`, `ctx.store`, `ctx.audio`.

## Screen model

```
top bar: Start listening | input device | module toolbar buttons
Modules column | display (spectrum, ruler, waterfall)      <- upper, always on
(collapsible)  | ---- splitter (drag, or Up/Down keys) ----
               | panel of the ONE selected module           <- lower
```

The Modules column is expanded (one bordered card per module: icon, name, on/off switch) or
collapsed (a tile per *active* module, rules between). Clicking a card or tile selects that module
(click again to deselect): its `panel`, if any, opens in the lower area, and its `options` expand
on its card. Options of unselected modules stay collapsed, so only one module's controls show at a
time. A module with only `options` (the spectrum) opens the column when its tile is clicked. State lives in
hidden settings `ui.expanded`, `ui.selected` (`""` = first active panel, `"none"` = closed) and
`ui.panelHeight`; each module's switch is `modules.<id>.active`.

## Adding a module

Create `src/modules/<id>/index.ts` with a default-exported `Module` (see `src/core/module.ts`).
It is picked up automatically; prefix a folder with `_` to disable it. Examples to copy:
`spectrum-waterfall` (`display` + `options`, core, many hidden settings, bus listeners),
`bookmarks` (`panel` + `options`, IndexedDB, per-frame levels and alarms, import/export; talks to the
spectrum through bus topics only), `recorder` (`toolbar` button + `panel`, in-memory takes, WAV) and
`devices` (`panel`: input/output selection and info). Keep a module's DOM-free logic in its own files
(`store.ts`, `recorder.ts`, `alarm.ts`) so it can be unit-tested; see `tests/modules.test.ts`.

A module can contribute any of:

| Field | Effect |
|---|---|
| `title`, `icon` | Name (i18n key) and 1-2 character glyph on its card / collapsed tile. |
| `core` | Cannot be switched off (no on/off switch). |
| `display` | Mounted in the upper area, always visible. Normally only the spectrum uses it. |
| `panel` | Shown in the lower area while the module is selected. Mounted once at startup, hidden when not selected. |
| `options` | Controls on the module's card in the Modules column, shown while the module is selected. Use `settingField()` for each setting. |
| `settings` | `SettingDef[]`, persisted and validated by type/min/max. Prefix keys with the module id (`mymod.threshold`). Set `hidden: true` if the module renders them itself in `options`; otherwise they appear in the Settings panel. |
| `collections` | IndexedDB collections you use via `ctx.store`. Must be declared here. |
| `pipeline` | `PipelineStage` inserted into the input chain (filters, gain, notch...), sorted by `order`. |
| `toolbar` | A `Mount` for the top bar (e.g. the Record button, which has state). Shown while the module is active. |
| `messages` | `{ en: {...}, es: {...} }` string tables. Missing `es` falls back to `en`. |
| `init(ctx)` | Run once after the UI is built. |

Modules are always *loaded*; "active" only controls their UI. A module that does background work
(a decoder) should check `ctx.isActive(id)` and listen to the bus topic `module:active`.

Spectrum data: read it with `ctx.audio.spectrum()` (dB per FFT bin, or `null` when not listening). The
analyser is pulled at most once per frame, so several modules never double-smooth it. Do not call
`getFloatFrequencyData` yourself. Alarms/beeps: `ctx.output.beep(hz, volume)`.

Decoders: subscribe to raw samples with `ctx.audio.onSamples((block, sampleRate) => ...)` and
publish results on the bus topic `message:rx`. Any log pane can display them without knowing the
decoder. Transmit: `ctx.output.tone / playSamples / playFile`.

New bus topics: declaration-merge into `BusTopics`:

```ts
declare module '../../core/bus' {
  interface BusTopics { 'mymod:event': { value: number } }
}
```

### Modules that need the network (e.g. MQTT)

Add `src/modules/<id>/hosts.json` with CSP `connect-src` sources, e.g.
`["wss://broker.example.com:8084"]`. `vite.config.ts` merges every module's hosts into the CSP at
build time. Keep such modules off by default (a setting, default `false`) and say so in the UI.
Nothing is allowed in dev (no CSP there), so test with `npm run build && npm run preview`.

## Themes

`dark` (default) and `light` ship. The look follows soundradar (square, solid ultramarine buttons; green while listening): the chrome is "paper" and the plots are dark
"plates" inset into it, so a spectrogram always has the dark ground its colour map needs.

A theme is one CSS file, `src/themes/<id>.css`, defining every token under
`:root[data-theme='<id>']` (copy `dark.css`, which documents each token group: `--paper*`, `--rule*`,
`--ink*`, `--accent`, `--flag`, `--live`, `--plate*`, `--wf-*`). Files in `src/themes/` are
discovered automatically: the id is the filename, and the Theme select in Settings appears as soon
as there are two. The `--wf-*` waterfall stops must be 6-digit hex (renderers interpolate them).

To change the current look, edit the tokens in `dark.css`. Component layout lives in
`src/styles.css` and uses only `var(--token)` colours; keep it that way (no hard-coded colours).
Canvas code takes colours from `ctx.theme()` and re-reads them after `ctx.onTheme(...)`.

## i18n

Core strings in `src/core/messages.ts`, module strings in the module's `messages`. Always use
`t('key')`. Changing language reloads the page.

## PWA / offline

`public/sw.js` caches same-origin GETs on first use, so one online visit makes the app work
offline. Bump `VERSION` in `sw.js` when you need clients to drop old caches. The manifest has no
`id` on purpose (it then defaults to `start_url`, keeping the install scoped to the sub-path).
Only an SVG icon is provided; add PNG 192/512 icons to `public/` and the manifest if a target
browser requires them for installability.

## Deploy

`.github/workflows/deploy.yml` runs tests + build and publishes `dist/` to GitHub Pages on push to
`main` (enable Pages > Source: GitHub Actions in the repo settings).

## Commit attribution

`.claude/settings.json` sets `attribution.commit` and `attribution.pr` to empty so Claude Code adds
no co-author or "generated with" lines to commits and PRs.
