import { rmSync } from 'node:fs'
for (const p of ['packages/protocol/dist', 'packages/core/dist', 'packages/client/dist', 'packages/server/dist', 'packages/server/ui', 'apps/web/dist']) {
  rmSync(new URL(`../${p}`, import.meta.url), { recursive: true, force: true })
}
for (const p of ['protocol', 'core', 'client', 'server']) rmSync(new URL(`../packages/${p}/tsconfig.tsbuildinfo`, import.meta.url), { force: true })
console.log('cleaned')
