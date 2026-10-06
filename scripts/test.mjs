// Run every compiled test file with node:test (portable across Node 20+, no glob support needed).
import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const files = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (name.endsWith('.test.js')) files.push(p)
  }
}
for (const pkg of readdirSync('packages')) {
  try { walk(join('packages', pkg, 'dist')) } catch { /* not built */ }
}
if (!files.length) {
  console.error('no compiled tests found — run `npm run build:packages`')
  process.exit(1)
}
const res = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' })
process.exit(res.status ?? 1)
