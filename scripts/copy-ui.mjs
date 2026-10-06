// Copy the built web UI into the server package so `oadt` can serve it standalone.
import { cpSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = fileURLToPath(new URL('../apps/web/dist', import.meta.url))
const dest = fileURLToPath(new URL('../packages/server/ui', import.meta.url))
if (!existsSync(src)) {
  console.error('apps/web/dist is missing — run `npm run build:web` first')
  process.exit(1)
}
rmSync(dest, { recursive: true, force: true })
cpSync(src, dest, { recursive: true, filter: (p) => !p.endsWith('.map') })
console.log('UI copied to packages/server/ui')
