// Build the standalone `observe-agents-do-things` npm package in packages/cli:
// the server CLI with core and protocol bundled into one file (no dependencies),
// plus the built web UI. Run `npm run build` first.
import { build } from 'esbuild'
import { chmodSync, copyFileSync, cpSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = `${root}packages/cli`
const ui = `${root}apps/web/dist`
if (!existsSync(ui)) {
  console.error('apps/web/dist is missing: run `npm run build` first')
  process.exit(1)
}

rmSync(`${out}/dist`, { recursive: true, force: true })
rmSync(`${out}/ui`, { recursive: true, force: true })
await build({
  entryPoints: [`${root}packages/server/src/cli.ts`],
  outfile: `${out}/dist/cli.js`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  legalComments: 'none',
  logLevel: 'warning',
})
chmodSync(`${out}/dist/cli.js`, 0o755)
cpSync(ui, `${out}/ui`, { recursive: true, filter: (p) => !p.endsWith('.map') })
copyFileSync(`${root}README.md`, `${out}/README.md`)
copyFileSync(`${root}LICENSE`, `${out}/LICENSE`)
console.log('packages/cli ready: cd packages/cli && npm publish')
