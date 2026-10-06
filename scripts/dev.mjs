// Dev loop: API server (demo data unless --real) + Vite with hot reload.
//   npm run dev            → demo data
//   npm run dev -- --real  → your real transcripts
import { spawn } from 'node:child_process'

const real = process.argv.includes('--real')
const run = (cmd, args, name) => {
  const p = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' })
  p.on('exit', (code) => { console.log(`${name} exited (${code})`); process.exit(code ?? 0) })
  return p
}
const api = run('node', ['packages/server/dist/cli.js', '--no-ui', '--cors', 'http://localhost:5175', ...(real ? [] : ['--demo'])], 'api')
const web = run('npm', ['run', 'dev', '--workspace', 'apps/web'], 'web')
process.on('SIGINT', () => { api.kill(); web.kill(); process.exit(0) })
