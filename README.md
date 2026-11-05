# webDIGI

**Live: https://lu1aat.github.io/webdigi/**

Spectrum, waterfall and digital-mode decoders for radio and audio signals, in your browser.
**Nothing to install** — it works on desktop and on mobile phones, and keeps working offline after
the first visit. No account, no server: audio never leaves your device.

## Features

- Live spectrum and waterfall: zoom, pan, linear or log scale, auto level adjustment, dark and light themes
- CW skimmer: finds and decodes Morse stations automatically, with callsign validation; can also send CW
- Hellschreiber: shows Hell modes as a strip you read by eye; can also transmit text
- Bookmarks: save frequencies, watch their levels, get alarms; import and export
- Recordings: record, play back and download as WAV
- Input/output device selection, English and Spanish

## Using it

Open the link, click **Start listening** and allow the microphone (feed it from a radio's audio
output, or hold the phone near a speaker). Click the spectrum to pick a frequency. The **Modules**
column on the left collapses to icons; expanded, each module is a card with its own options and an
on/off switch, and the selected module's panel opens under the waterfall. Zoom with the wheel or the
+ / − pad, pan with ◄ / ►, and press **A** (Auto adjust levels) when the waterfall is too dark or
washed out.

On a phone, use "Add to Home screen" to open it like an app.

## Running from source

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # dist/ works from any static host
npm test
```

Architecture, how to write a module, themes, offline behaviour and the CSP are in
[AGENTS.md](./AGENTS.md).

MIT licensed.
