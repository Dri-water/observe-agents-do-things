import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentActivity, applyEvent, createWorld, sessionActivity, type EventDraft, type ObserverEvent } from '@oadt/protocol'

let seq = 0
const ev = (d: Partial<EventDraft> & { kind: EventDraft['kind'] }, ts = 1000): ObserverEvent =>
  ({ harness: 'codex', sessionId: 's1', agentId: 's1', ts, seq: ++seq, ...d }) as ObserverEvent

test('activity follows the tool in flight, then the outcome', () => {
  const w = createWorld()
  applyEvent(w, ev({ kind: 'session.started', meta: {} }))
  applyEvent(w, ev({ kind: 'turn.started' }, 1001))
  const s = w.sessions.s1!
  const root = () => s.agents.s1!
  assert.equal(agentActivity(s, root(), 1002), 'thinking')

  applyEvent(w, ev({ kind: 'tool.started', callId: 'c1', tool: 'exec', category: 'shell', title: 'npm test' }, 1010))
  assert.equal(sessionActivity(s, 1011), 'running')
  applyEvent(w, ev({ kind: 'tool.finished', callId: 'c1', ok: false, output: 'fail' }, 1500))
  assert.equal(agentActivity(s, root(), 2000), 'failed')
  assert.equal(agentActivity(s, root(), 9000), 'thinking', 'a failure only shows briefly')

  applyEvent(w, ev({ kind: 'tool.started', callId: 'c2', tool: 'apply_patch', category: 'edit', title: 'a.ts' }, 9100))
  assert.equal(sessionActivity(s, 9200), 'editing')
  applyEvent(w, ev({ kind: 'tool.finished', callId: 'c2', ok: true }, 9300))
  applyEvent(w, ev({ kind: 'turn.ended', outcome: 'completed' }, 9400))
  assert.equal(sessionActivity(s, 10_000), 'finished')
  assert.equal(sessionActivity(s, 9400 + 5 * 60_000), 'idle')
  assert.equal(sessionActivity(s, 9400 + 60 * 60_000), 'sleeping')
})

test('a parent waiting on subagents is delegating; any waiting agent makes the session wait', () => {
  const w = createWorld()
  applyEvent(w, ev({ kind: 'session.started', meta: {} }))
  applyEvent(w, ev({ kind: 'tool.started', callId: 't1', tool: 'Agent', category: 'agent', title: 'Explore' }, 1001))
  applyEvent(w, ev({ kind: 'agent.spawned', agentId: 'sub', parentToolCallId: 't1', name: 'Explore' }, 1002))
  applyEvent(w, ev({ kind: 'tool.started', agentId: 'sub', callId: 'r1', tool: 'Grep', category: 'search', title: 'TODO' }, 1003))
  const s = w.sessions.s1!
  assert.equal(sessionActivity(s, 1004), 'delegating')
  assert.equal(agentActivity(s, s.agents.sub!, 1004), 'searching')
  applyEvent(w, ev({ kind: 'agent.status', agentId: 'sub', status: 'waiting', reason: 'approve Bash' }, 1005))
  assert.equal(sessionActivity(s, 1006), 'waiting')
})
