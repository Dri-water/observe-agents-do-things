import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderToString } from 'react-dom/server'
import { applyEvent, ObserverClient, type EventDraft, type ObserverEvent } from '@oadt/client'
import { ObserverProvider, useAgentTree, useOpenTools, useSession, useSessions, useTotals } from './index.js'

function filledClient(): ObserverClient {
  const client = new ObserverClient({ url: 'http://127.0.0.1:1' }) // never connected
  const drafts: EventDraft[] = [
    { harness: 'claude-code', sessionId: 's1', agentId: 's1', ts: 1, kind: 'session.started', meta: { title: 'Fix login', project: 'web' } },
    { harness: 'claude-code', sessionId: 's1', agentId: 's1', ts: 2, kind: 'tool.started', callId: 'c1', tool: 'Bash', category: 'shell', title: '$ npm test' },
    { harness: 'claude-code', sessionId: 's1', agentId: 'sub', ts: 3, kind: 'agent.spawned', name: 'Explore', parentAgentId: 's1' },
    { harness: 'codex', sessionId: 's2', agentId: 's2', ts: 4, kind: 'session.started', meta: { title: 'Speed up importer' } },
  ]
  drafts.forEach((d, i) => applyEvent(client.world, { ...d, seq: i + 1 } as ObserverEvent))
  return client
}

function Dashboard() {
  const sessions = useSessions()
  const totals = useTotals()
  return (
    <main>
      <p>{totals.sessions} sessions, {totals.agents} agents</p>
      {sessions.map((s) => <Card key={s.id} id={s.id} />)}
    </main>
  )
}

function Card({ id }: { id: string }) {
  const s = useSession(id)
  const tree = useAgentTree(id)
  const open = useOpenTools(id)
  return (
    <section>
      <h2>{s?.meta.title}</h2>
      <span>children:{tree?.childNodes.map((c) => c.name).join(',')}</span>
      <ul>{open.map((t) => <li key={t.id}>{t.title}</li>)}</ul>
    </section>
  )
}

test('hooks read the live world through the provider', () => {
  const html = renderToString(
    <ObserverProvider client={filledClient()}>
      <Dashboard />
    </ObserverProvider>,
  ).replace(/<!-- -->/g, "")
  assert.match(html, /2 sessions, 3 agents/)
  assert.match(html, /<h2>Fix login<\/h2>/)
  assert.match(html, /<h2>Speed up importer<\/h2>/)
  assert.match(html, /children:Explore/)
  assert.match(html, /<li>\$ npm test<\/li>/)
})

test('hooks outside a provider fail loudly', () => {
  assert.throws(() => renderToString(<Dashboard />), /inside <ObserverProvider>/)
})
