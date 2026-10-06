#!/usr/bin/env node
// Make your own agent observable: POST protocol events to /api/ingest and it
// shows up next to Claude Code and Codex in every frontend.
//
//   oadt &                                 # the observer
//   node examples/custom-agent/index.mjs   # this fake agent
//
// In a real agent, call `send(...)` from your tool-execution loop.
const url = process.env.OADT_URL ?? 'http://127.0.0.1:4545'
const sessionId = `my-agent-${Date.now().toString(36)}`

async function send(...events) {
  const res = await fetch(`${url}/api/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(process.env.OADT_TOKEN ? { authorization: `Bearer ${process.env.OADT_TOKEN}` } : {}) },
    body: JSON.stringify(events.map((e) => ({ harness: 'my-agent', sessionId, agentId: sessionId, ts: Date.now(), ...e }))),
  })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let n = 0
async function tool(tool, category, title, ms, ok = true) {
  const callId = `call-${n++}`
  await send({ kind: 'tool.started', callId, tool, category, title })
  await sleep(ms)
  await send({ kind: 'tool.finished', callId, ok })
}

await send({ kind: 'session.started', meta: { title: 'My custom agent', project: 'weather-bot', model: 'my-model-1' } })
await send({ kind: 'turn.started' }, { kind: 'message', role: 'user', text: 'What should I wear in Oslo tomorrow?' })
await send({ kind: 'thinking' })
await sleep(800)
await tool('get_forecast', 'web', 'Forecast for Oslo', 1500)
await tool('read_wardrobe', 'read', 'Read wardrobe.json', 600)
await send({ kind: 'message', role: 'assistant', text: 'Rain and 6°C — bring the waterproof jacket and a scarf.' })
await send({ kind: 'usage', delta: { input: 1200, output: 80, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, contextTokens: 1300, contextWindow: 32000 })
await send({ kind: 'turn.ended', outcome: 'completed' })
console.log(`sent session ${sessionId} to ${url}`)
