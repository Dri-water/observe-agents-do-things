#!/usr/bin/env node
// A live `top` for your agents, built on @oadt/client.
//
//   oadt --no-ui &                      # or any running oadt server
//   node examples/terminal-dashboard/index.mjs [http://127.0.0.1:4545]
//
// Everything on screen comes from the shared WorldState projection — this file
// only decides how to draw it.
import {
  connect,
  formatAgo,
  formatCount,
  formatDuration,
  openTools,
  sessionList,
  totalTokens,
  worldTotals,
} from '@oadt/client'

const url = process.argv[2] ?? process.env.OADT_URL ?? 'http://127.0.0.1:4545'
const client = connect({ url, token: process.env.OADT_TOKEN })

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', orange: '\x1b[38;5;209m', teal: '\x1b[38;5;43m' }
const STATUS = { working: `${C.green}●${C.reset}`, waiting: `${C.yellow}◐${C.reset}`, idle: `${C.dim}○${C.reset}`, ended: `${C.dim}·${C.reset}` }
const pad = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n))

function draw() {
  const world = client.world
  const cols = process.stdout.columns || 100
  const t = worldTotals(world)
  const out = []
  out.push(`${C.bold}observe·agents·do·things${C.reset}  ${C.dim}${url} · ${client.status}${C.reset}`)
  out.push(`${C.green}${t.live} live${C.reset}  ${t.waiting ? `${C.yellow}${t.waiting} waiting${C.reset}  ` : ''}${t.agents} agents  ${formatCount(t.tools)} tool calls  ${formatCount(t.tokens)} tokens${t.costUsd ? `  $${t.costUsd.toFixed(2)}` : ''}`)
  out.push('')
  for (const s of sessionList(world).slice(0, 12)) {
    const color = s.harness === 'codex' ? C.teal : C.orange
    const title = s.meta.title ?? s.meta.project ?? s.id.slice(0, 8)
    out.push(`${STATUS[s.status] ?? '?'} ${color}${pad(s.harness, 11)}${C.reset} ${C.bold}${pad(title, Math.max(20, cols - 60))}${C.reset} ${C.dim}${pad(formatAgo(s.lastActivityAt), 10)}${C.reset} ${pad(`${Object.keys(s.agents).length} ag`, 6)} ${pad(`${formatCount(s.counts.tools)} tools`, 11)} ${formatCount(totalTokens(s.usage))}`)
    for (const tool of openTools(s).slice(0, 3)) {
      const agent = s.agents[tool.agentId]
      const who = tool.agentId === s.rootAgentId ? 'main' : agent?.name ?? '?'
      out.push(`    ${C.cyan}▸${C.reset} ${C.dim}${pad(who, 16)}${C.reset} ${pad(tool.title, cols - 40)} ${C.dim}${formatDuration(Date.now() - tool.startedAt)}${C.reset}`)
    }
    if (s.status === 'waiting') out.push(`    ${C.yellow}⏸ ${s.statusReason ?? 'waiting'}${C.reset}`)
  }
  if (!Object.keys(world.sessions).length) out.push(`${C.dim}No sessions yet.${C.reset}`)
  process.stdout.write('\x1b[H\x1b[2J' + out.join('\n') + '\n')
}

let scheduled = false
client.onChange(() => {
  if (scheduled) return
  scheduled = true
  setTimeout(() => { scheduled = false; draw() }, 100)
})
setInterval(draw, 1000)
process.on('SIGINT', () => { process.stdout.write(C.reset + '\n'); process.exit(0) })
