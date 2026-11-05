# webDIGI

**Live: https://lu1aat.github.io/webdigi/** — nothing to install, works in the browser on desktop and on mobile phones, and offline after the first visit.

Spectrum, waterfall, CW skimmer, Hellschreiber, bookmarks with alarms and recordings, all in the browser. Built from the audioweb-template.

Boilerplate for browser-only audio apps that work online and offline: input capture, spectrum +
waterfall, pluggable modules (decoders, visualisations, filters, bookmarks, MQTT...), settings and
data kept in the browser. TypeScript + Vite, no framework, dark theme.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # dist/ works from any static host
npm test
```

Click **Start listening**, grant the microphone, and the spectrum and waterfall run. Click the
spectrum to pick a frequency, then add it in the Bookmarks panel. The **Modules** column on the left
collapses to icons; expanded, each module is a card with its own options and an on/off switch, and
the selected module's panel opens under the waterfall. Zoom with the wheel or the + / − pad, pan
with ◄ / ►, and use **Auto adjust levels** (also the **A** button next to the waterfall's zoom pad) in the Spectrum options to set the level range.

To make your own app from this code, copy the folder, delete the modules you don't need and add
yours in `src/modules/`.

Everything about architecture, how to write a module, how to add or change a theme, offline
behaviour and the CSP is in [AGENTS.md](./AGENTS.md).

The landing page in `landing/` is published at the site root and the app under `/app/` by the
GitHub Pages workflow.

MIT licensed.
