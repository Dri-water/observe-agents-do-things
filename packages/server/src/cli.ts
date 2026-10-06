#!/usr/bin/env node
/**
 * oadt — observe agents do things.
 *
 *   oadt                       watch Claude Code + Codex, serve the live view
 *   oadt --demo                simulated agents, no real data
 *   oadt replay <files…>       replay transcripts in compressed real time
 *   oadt tail [--json]         stream normalised events to the terminal
 *   oadt sessions [--json]     list recent sessions and exit
 */
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { spawn } from 'node:child_process'
import {
  DemoSource,
  Observer,
  ReplaySource,
  formatAgo,
  formatCount,
  sessionList,
  shortPath,
  totalTokens,
  type BuiltinHarness,
  type ObserverEvent,
  type RedactMode,
  type Source,
} from '@oadt/core'
import { ObserverServer, VERSION } from './server.js'

const HELP = `
observe-agents-do-things ${VERSION}
Watch your coding agents work — live, read-only, in any frontend.

Usage
  oadt [serve] [options]        start the observer + web UI (default)
  oadt replay <file...>         replay transcript files as if live
  oadt tail [options]           print live events in the terminal
  oadt sessions [options]       list recent sessions

Options
  -p, --port <n>          port (default 4545)
      --host <addr>       bind address (default 127.0.0.1). Non-loopback requires a token.
      --token <secret>    require this bearer token (auto-generated for non-loopback hosts)
      --no-auth           never require a token (e.g. in a container published only on 127.0.0.1)
      --since <dur>       backfill window, e.g. 30m, 6h, 2d (default 6h)
      --harness <list>    claude-code,codex (default both)
      --demo              simulated sessions instead of real transcripts
      --speed <n>         replay/demo speed multiplier (default 10 for replay, 1 for demo)
      --loop              loop replays
      --redact <mode>     none | content | strict (default none)
      --claude-dir <dir>  Claude config dir (default $CLAUDE_CONFIG_DIR or ~/.claude)
      --codex-home <dir>  Codex home (default $CODEX_HOME or ~/.codex)
      --ui <dir>          serve a different frontend build
      --no-ui             API only
      --cors <origin>     allow a cross-origin frontend (repeatable)
      --read-only         disable POST /api/ingest
      --open              open the browser
      --json              (tail, sessions) machine-readable output
      --session <id>      (tail) only this session
  -h, --help
  -v, --version
`

function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(s.trim())
  if (!m) throw new Error(`invalid duration: ${s}`)
  const n = Number(m[1])
  const unit = m[2] ?? 'h'
  return n * { ms: 1, s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[unit]!
}

function defaultUiDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const candidate of [join(here, '..', 'ui'), join(here, '..', '..', '..', 'apps', 'web', 'dist')]) {
    if (existsSync(join(candidate, 'index.html'))) return candidate
  }
  return undefined
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url]
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref()
}

function lanAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) for (const i of list ?? []) {
    if (i.family === 'IPv4' && !i.internal) out.push(i.address)
  }
  return out
}

const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[22m` : s)
const bold = (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[22m` : s)
const color = (code: number, s: string) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[39m` : s)

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string' },
      token: { type: 'string' },
      'no-auth': { type: 'boolean' },
      since: { type: 'string' },
      harness: { type: 'string' },
      demo: { type: 'boolean' },
      speed: { type: 'string' },
      loop: { type: 'boolean' },
      redact: { type: 'string' },
      'claude-dir': { type: 'string' },
      'codex-home': { type: 'string' },
      ui: { type: 'string' },
      'no-ui': { type: 'boolean' },
      cors: { type: 'string', multiple: true },
      'read-only': { type: 'boolean' },
      open: { type: 'boolean' },
      json: { type: 'boolean' },
      session: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  })
  if (values.help) return void process.stdout.write(HELP)
  if (values.version) return void console.log(VERSION)

  const [command = 'serve', ...rest] = positionals
  const redact = (values.redact ?? 'none') as RedactMode
  if (!['none', 'content', 'strict'].includes(redact)) throw new Error(`--redact must be none, content or strict`)

  const sources: Source[] = []
  if (values.demo) sources.push(new DemoSource({ speed: values.speed ? Number(values.speed) : 1 }))
  if (command === 'replay') {
    if (!rest.length) throw new Error('replay needs at least one transcript file')
    sources.push(new ReplaySource(rest.map((f) => resolve(f)), { speed: values.speed ? Number(values.speed) : 10, loop: values.loop }))
  }
  const harnesses = values.harness
    ? (values.harness.split(',').map((h) => h.trim()).filter(Boolean) as BuiltinHarness[])
    : sources.length ? [] : undefined

  const errors: string[] = []
  const observer = new Observer({
    harnesses,
    sources,
    sinceMs: parseDuration(values.since ?? (command === 'sessions' ? '24h' : '6h')),
    claudeDir: values['claude-dir'],
    codexHome: values['codex-home'],
    redact,
    onError: (err, path) => { if (errors.length < 50) errors.push(`${path ?? ''} ${String(err)}`) },
  })

  if (command === 'sessions') {
    await observer.start()
    observer.stop()
    const list = sessionList(observer.world)
    if (values.json) return void console.log(JSON.stringify(list.map(({ tools: _t, toolOrder: _o, ...s }) => s), null, 2))
    if (!list.length) return void console.log('No sessions found in the window. Try --since 2d.')
    for (const s of list) {
      const status = s.status === 'working' ? color(32, '● working') : s.status === 'waiting' ? color(33, '◐ waiting') : dim('○ ' + s.status)
      const title = s.meta.title ?? s.meta.project ?? s.id.slice(0, 8)
      console.log(`${status.padEnd(20)} ${bold(title.slice(0, 60))}`)
      console.log(dim(`    ${s.harness} · ${s.meta.project ?? '?'} · ${Object.keys(s.agents).length} agents · ${s.counts.tools} tools · ${formatCount(totalTokens(s.usage))} tokens · ${formatAgo(s.lastActivityAt)} · ${s.id}`))
    }
    return
  }

  if (command === 'tail') {
    observer.subscribe((e) => printEvent(e, values.json, values.session))
    await observer.start()
    if (!values.json) console.error(dim(`watching ${observer.describe().map((s) => s.name).join(', ')} — Ctrl+C to stop`))
    return
  }

  if (command !== 'serve' && command !== 'replay') throw new Error(`unknown command: ${command}\n${HELP}`)

  const host = values.host ?? '127.0.0.1'
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host)
  const token = values.token ?? (loopback || values['no-auth'] ? undefined : randomBytes(18).toString('base64url'))
  const uiDir = values['no-ui'] ? undefined : values.ui ? resolve(values.ui) : defaultUiDir()

  const started = Date.now()
  await observer.start()
  const server = new ObserverServer({
    observer,
    host,
    port: values.port ? Number(values.port) : 4545,
    uiDir,
    token,
    corsOrigins: values.cors,
    allowedHosts: loopback ? [] : lanAddresses(),
    readOnly: values['read-only'],
    redactMode: redact,
  })
  const { url } = await server.listen()
  const sessions = Object.keys(observer.world.sessions).length
  const withToken = token ? `${url}/?token=${token}` : url

  console.log(`\n  ${bold('observe-agents-do-things')} ${dim(VERSION)}\n`)
  console.log(`  ${color(36, '➜')}  ${bold(withToken)}`)
  if (!loopback && token) for (const ip of lanAddresses()) console.log(`  ${color(36, '➜')}  http://${ip}:${new URL(url).port}/?token=${token}`)
  console.log(dim(`     ${observer.describe().map((s) => `${s.name}${s.files !== undefined ? ` (${s.files} files)` : ''}`).join(' · ')}`))
  console.log(dim(`     ${sessions} sessions backfilled in ${Date.now() - started}ms · redact=${redact}${uiDir ? '' : ' · API only'}`))
  if (errors.length) console.log(color(33, `     ${errors.length} read errors (first: ${errors[0]!.slice(0, 120)})`))
  console.log()
  if (values.open) openBrowser(withToken)

  const shutdown = () => {
    observer.stop()
    void server.close().then(() => process.exit(0))
    setTimeout(() => process.exit(0), 1500).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

const KIND_COLOR: Record<string, number> = {
  'tool.started': 36, 'tool.finished': 36, message: 37, thinking: 35, 'turn.started': 32, 'turn.ended': 32,
  'agent.spawned': 33, 'agent.status': 33, 'session.status': 34, 'session.started': 34, usage: 90, note: 90,
}

function printEvent(e: ObserverEvent, json?: boolean, only?: string): void {
  if (only && e.sessionId !== only) return
  if (json) return void process.stdout.write(JSON.stringify(e) + '\n')
  if (e.kind === 'usage' || e.kind === 'session.updated') return
  const time = new Date(e.ts).toLocaleTimeString()
  const who = `${e.harness === 'codex' ? 'codex' : 'claude'}:${e.sessionId.slice(0, 6)}${e.agentId !== e.sessionId ? '/' + e.agentId.slice(0, 6) : ''}`
  let detail = ''
  switch (e.kind) {
    case 'tool.started': detail = `▶ ${e.title}`; break
    case 'tool.finished': detail = e.ok ? '✓' : `✗ ${(e.output ?? '').split('\n')[0]!.slice(0, 80)}`; break
    case 'message': detail = `${e.role}: ${e.text.replace(/\s+/g, ' ').slice(0, 140)}`; break
    case 'thinking': detail = e.text ? e.text.replace(/\s+/g, ' ').slice(0, 100) : '…'; break
    case 'agent.spawned': detail = `spawned ${e.name}${e.role ? ` (${e.role})` : ''}`; break
    case 'agent.status': case 'session.status': detail = `${e.status}${e.reason ? ` — ${e.reason}` : ''}`; break
    case 'turn.ended': detail = e.outcome; break
    case 'session.started': detail = e.meta.cwd ? shortPath(e.meta.cwd, 3) : ''; break
    case 'note': detail = e.text; break
  }
  console.log(`${dim(time)} ${dim(who.padEnd(22))} ${color(KIND_COLOR[e.kind] ?? 37, e.kind.padEnd(14))} ${detail}`)
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err))
  process.exit(1)
})
