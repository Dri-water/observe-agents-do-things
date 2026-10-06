#!/usr/bin/env node
// Get pinged when an agent needs you: it's waiting on a permission prompt,
// or it finished its turn. Optionally run a command for each notification.
//
//   node examples/notify/index.mjs
//   node examples/notify/index.mjs --cmd 'notify-send "agents" "{message}"'
//
// A "frontend" doesn't have to draw anything.
import { exec } from 'node:child_process'
import { connect } from '@oadt/client'

const args = process.argv.slice(2)
const cmdIdx = args.indexOf('--cmd')
const cmd = cmdIdx >= 0 ? args[cmdIdx + 1] : undefined
const url = args.find((a) => a.startsWith('http')) ?? process.env.OADT_URL ?? 'http://127.0.0.1:4545'

const client = connect({ url, token: process.env.OADT_TOKEN })
let ready = false
client.on('snapshot', () => { ready = true })

function notify(message) {
  process.stdout.write(`\x07${new Date().toLocaleTimeString()}  ${message}\n`)
  if (cmd) exec(cmd.replaceAll('{message}', message.replace(/"/g, "'")))
}

client.on('event', (e, world) => {
  if (!ready) return
  const s = world.sessions[e.sessionId]
  const name = s?.meta.title ?? s?.meta.project ?? e.sessionId.slice(0, 8)
  if (e.kind === 'agent.status' && e.status === 'waiting') notify(`⏸ ${name}: ${e.reason ?? 'waiting for you'}`)
  if (e.kind === 'turn.ended' && e.agentId === s?.rootAgentId) {
    notify(e.outcome === 'completed' ? `✓ ${name} finished its turn` : `✗ ${name} turn ${e.outcome}`)
  }
})

console.log(`listening to ${url} — Ctrl+C to stop`)
