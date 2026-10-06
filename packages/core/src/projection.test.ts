import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentTree, applyEvent, createWorld, sessionList, type EventDraft, type ObserverEvent } from '@oadt/protocol'
import { EventStore } from './store.js'
import { statusTransitions } from './status.js'

let seq = 0
const ev = (d: Partial<EventDraft> & { kind: EventDraft['kind'] }, ts = 1000): ObserverEvent =>
  ({ harness: 'claude-code', sessionId: 's1', agentId: 's1', ts, seq: ++seq, ...d }) as ObserverEvent

test('builds sessions, agents, tools and files from events', () => {
  const w = createWorld()
  applyEvent(w, ev({ kind: 'session.started', meta: { cwd: '/p', project: 'p' } }))
  applyEvent(w, ev({ kind: 'turn.started' }, 1001))
  applyEvent(w, ev({ kind: 'tool.started', callId: 'c1', tool: 'Read', category: 'read', title: 'Read a.ts', files: [{ path: '/p/a.ts', op: 'read' }] }, 1002))
  applyEvent(w, ev({ kind: 'tool.finished', callId: 'c1', ok: true }, 1500))
  applyEvent(w, ev({ kind: 'tool.started', callId: 'c2', tool: 'Edit', category: 'edit', title: 'Edit a.ts', files: [{ path: '/p/a.ts', op: 'edit' }] }, 1600))
  applyEvent(w, ev({ kind: 'tool.finished', callId: 'c2', ok: false, output: 'boom' }, 1700))
  const s = w.sessions.s1!
  assert.equal(s.counts.tools, 2)
  assert.equal(s.counts.toolErrors, 1)
  assert.equal(s.tools.c1!.durationMs, 498)
  assert.equal(s.files['/p/a.ts']!.touches, 2)
  assert.equal(s.files['/p/a.ts']!.edits, 1)
  assert.equal(s.agents.s1!.activeTools.length, 0)
  assert.equal(s.status, 'working')
  applyEvent(w, ev({ kind: 'turn.ended', outcome: 'completed' }, 1800))
  assert.equal(s.status, 'idle')
  assert.equal(s.turn.active, false)
})

test('links a subagent announced before the call that spawned it', () => {
  const w = createWorld()
  applyEvent(w, ev({ kind: 'agent.spawned', agentId: 'sub', parentToolCallId: 'task-1', name: 'Explore' }, 1000))
  assert.equal(w.sessions.s1!.agents.sub!.parentId, 's1', 'provisionally parented to the root')
  applyEvent(w, ev({ kind: 'agent.spawned', agentId: 'mid', name: 'planner' }, 1000))
  applyEvent(w, ev({ kind: 'tool.started', agentId: 'mid', callId: 'task-1', tool: 'Agent', category: 'agent', title: 'Explore' }, 1001))
  const s = w.sessions.s1!
  assert.equal(s.agents.sub!.parentId, 'mid')
  assert.equal(s.agents.sub!.depth, 2)
  assert.equal(s.tools['task-1']!.childAgentId, 'sub')
  const tree = agentTree(s)!
  assert.deepEqual(tree.childNodes.map((c) => c.id), ['mid'])
  assert.deepEqual(tree.childNodes[0]!.childNodes.map((c) => c.id), ['sub'])
})

test('metadata never makes a session look active', () => {
  const w = createWorld()
  applyEvent(w, ev({ kind: 'session.updated', meta: { title: 'x', titleSource: 'custom' } }, 9_999_999))
  assert.equal(w.sessions.s1!.lastActivityAt, 0)
})

test('title precedence: custom > harness > prompt', () => {
  const w = createWorld()
  applyEvent(w, ev({ kind: 'session.updated', meta: { title: 'first prompt', titleSource: 'prompt' } }))
  applyEvent(w, ev({ kind: 'session.updated', meta: { title: 'My name', titleSource: 'custom' } }))
  applyEvent(w, ev({ kind: 'session.updated', meta: { title: 'auto', titleSource: 'harness' } }))
  assert.equal(w.sessions.s1!.meta.title, 'My name')
})

test('aborted turns close dangling tool calls', () => {
  const w = createWorld()
  applyEvent(w, ev({ kind: 'tool.started', callId: 'c', tool: 'Bash', category: 'shell', title: '$ sleep 100' }))
  applyEvent(w, ev({ kind: 'turn.ended', outcome: 'aborted' }, 2000))
  const t = w.sessions.s1!.tools.c!
  assert.equal(t.ok, false)
  assert.equal(w.sessions.s1!.agents.s1!.activeTools.length, 0)
})

test('tool history is bounded but open calls survive eviction', () => {
  const w = createWorld()
  const limits = { maxToolsPerSession: 10, maxOutputChars: 100, maxPreviewChars: 100, maxFilesPerSession: 100 }
  applyEvent(w, ev({ kind: 'tool.started', callId: 'open', tool: 'Bash', category: 'shell', title: 'long' }), limits)
  for (let i = 0; i < 50; i++) {
    applyEvent(w, ev({ kind: 'tool.started', callId: `t${i}`, tool: 'Read', category: 'read', title: 'r' }, 1000 + i), limits)
    applyEvent(w, ev({ kind: 'tool.finished', callId: `t${i}`, ok: true }, 1000 + i), limits)
  }
  const s = w.sessions.s1!
  assert.ok(s.toolOrder.length <= 11)
  assert.ok(s.tools.open, 'open call kept')
  assert.equal(s.counts.tools, 51, 'counters are not affected by eviction')
})

test('status heuristics: waiting on a stuck tool, idle when quiet', () => {
  const w = createWorld()
  applyEvent(w, ev({ kind: 'tool.started', callId: 'c', tool: 'Bash', category: 'shell', title: '$ rm -rf build' }, 1000))
  assert.deepEqual(statusTransitions(w, 3000), [], 'not yet')
  const waiting = statusTransitions(w, 20_000)
  assert.ok(waiting.some((d) => d.kind === 'agent.status' && d.status === 'waiting'))
  assert.ok(waiting.some((d) => d.kind === 'session.status' && d.status === 'waiting'))
  for (const d of waiting) applyEvent(w, { ...d, seq: ++seq } as ObserverEvent)
  assert.equal(w.sessions.s1!.status, 'waiting')
  // Approval granted → activity resumes → working again.
  applyEvent(w, ev({ kind: 'tool.finished', callId: 'c', ok: true }, 21_000))
  assert.equal(w.sessions.s1!.status, 'working')
  const idle = statusTransitions(w, 21_000 + 16 * 60_000)
  assert.ok(idle.some((d) => d.kind === 'session.status' && d.status === 'idle'))
})

test('store assigns sequence numbers and serves resumable history', () => {
  const store = new EventStore({ maxEvents: 100 })
  for (let i = 0; i < 300; i++) store.push({ harness: 'x', sessionId: i % 2 ? 'a' : 'b', agentId: i % 2 ? 'a' : 'b', ts: i, kind: 'thinking' })
  assert.equal(store.lastSeq, 300)
  assert.equal(store.since(10), null, 'evicted range → snapshot needed')
  assert.deepEqual(store.since(295)!.map((e) => e.seq), [296, 297, 298, 299, 300])
  assert.ok(store.sessionEvents('a').every((e) => e.sessionId === 'a'))
  assert.equal(sessionList(store.world).length, 2)
})

test('redaction strips content but keeps structure', () => {
  const store = new EventStore({ redact: 'content' })
  store.push({ harness: 'x', sessionId: 's', agentId: 's', ts: 1, kind: 'message', role: 'user', text: 'secret plans' })
  store.push({ harness: 'x', sessionId: 's', agentId: 's', ts: 2, kind: 'tool.started', callId: 'c', tool: 'Read', category: 'read', title: 'Read a.ts', input: { file_path: 'a.ts' } })
  const [m, t] = store.sessionEvents('s')
  assert.equal(m!.kind === 'message' && m!.text, '[12 chars]')
  assert.equal(t!.kind === 'tool.started' && t!.input, undefined)
  assert.equal(t!.kind === 'tool.started' && t!.title, 'Read a.ts')
  const strict = new EventStore({ redact: 'strict' })
  strict.push({ harness: 'x', sessionId: 's', agentId: 's', ts: 2, kind: 'tool.started', callId: 'c', tool: 'Read', category: 'read', title: 'Read a.ts', files: [{ path: '/secret/a.ts', op: 'read' }] })
  const [st] = strict.sessionEvents('s')
  assert.equal(st!.kind === 'tool.started' && st!.title, 'Read')
  assert.deepEqual(st!.kind === 'tool.started' && st!.files, [])
})

test('reserved object keys in ids are ignored rather than polluting prototypes', () => {
  const w = createWorld()
  applyEvent(w, ev({ kind: 'thinking', agentId: '__proto__' }))
  applyEvent(w, ev({ kind: 'thinking', sessionId: 'constructor', agentId: 'constructor' }))
  applyEvent(w, ev({ kind: 'tool.started', callId: 'c', tool: 'Read', category: 'read', title: 'r', files: [{ path: '__proto__', op: 'read' }] }))
  const probe = {} as Record<string, unknown>
  assert.equal(probe.thinking, undefined)
  assert.equal(probe.touches, undefined)
  assert.equal(Object.hasOwn(w.sessions, 'constructor'), false)
  assert.equal(Object.keys(w.sessions.s1!.files).length, 0)
})
