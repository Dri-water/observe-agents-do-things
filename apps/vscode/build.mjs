// Bundle the extension (with the observer core, server and client) into one file,
// and copy the built web UI next to it so an embedded observer can serve it.
import { build } from 'esbuild'
import { copyFileSync, cpSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const ui = fileURLToPath(new URL('../web/dist', import.meta.url))
if (!existsSync(ui)) {
  console.error('apps/web/dist is missing: run `npm run build` at the repo root first')
  process.exit(1)
}
rmSync(`${here}dist`, { recursive: true, force: true })
rmSync(`${here}ui`, { recursive: true, force: true })
await build({
  entryPoints: [`${here}src/extension.ts`],
  outfile: `${here}dist/extension.js`,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  legalComments: 'none',
  logLevel: 'warning',
})
cpSync(ui, `${here}ui`, { recursive: true, filter: (p) => !p.endsWith('.map') })
copyFileSync(fileURLToPath(new URL('../../LICENSE', import.meta.url)), `${here}LICENSE`)
console.log('apps/vscode built')
