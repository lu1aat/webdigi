import { defineConfig, type Plugin } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Hosts a module needs, declared in src/modules/<id>/hosts.json (array of CSP sources). */
function moduleHosts(): string[] {
  const root = join(__dirname, 'src/modules')
  const hosts: string[] = []
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    const file = join(root, dir.name, 'hosts.json')
    if (dir.isDirectory() && existsSync(file)) hosts.push(...JSON.parse(readFileSync(file, 'utf8')))
  }
  return hosts
}

/** Injects a strict CSP into built HTML (not in dev: HMR needs inline scripts and ws). */
function csp(): Plugin {
  return {
    name: 'audioweb-csp',
    transformIndexHtml(html, ctx) {
      if (ctx.server) return html
      const connect = ["'self'", ...moduleHosts()].join(' ')
      const policy = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "media-src 'self' blob:",
        "worker-src 'self' blob:",
        `connect-src ${connect}`,
        "object-src 'none'",
        "base-uri 'self'",
      ].join('; ')
      return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}">`)
    },
  }
}

// `npm run dev:https` / `preview:https` use --mode https: a self-signed cert, so getUserMedia
// works when the page is opened from another device on the LAN (accept the browser warning once).
export default defineConfig(({ mode }) => ({
  // Relative base: dist/ works from any static host or sub-path (e.g. GitHub Pages).
  base: './',
  plugins: [csp(), ...(mode === 'https' ? [basicSsl()] : [])],
  // Dev server on the LAN. Add your machine's hostname here (Vite blocks unknown Host headers).
  server: { host: '0.0.0.0', allowedHosts: ['mondiola', '.local'] },
  preview: { host: '0.0.0.0', allowedHosts: ['mondiola', '.local'] },
  build: { target: 'es2022' },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
}))
