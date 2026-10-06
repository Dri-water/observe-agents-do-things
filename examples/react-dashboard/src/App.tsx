import { useState } from 'react'
import {
  formatAgo,
  formatCount,
  formatDuration,
  totalTokens,
  useAgentTree,
  useConnectionStatus,
  useEvents,
  useHotFiles,
  useNow,
  useOpenTools,
  useSession,
  useSessions,
  useTotals,
  type AgentNode,
  type ObserverEvent,
} from '@oadt/react'

const HARNESS_COLOR: Record<string, string> = { 'claude-code': '#ff8a4c', codex: '#3ee0c5' }

export function App() {
  const [selected, setSelected] = useState<string>()
  const sessions = useSessions()
  const current = selected ?? sessions[0]?.id
  return (
    <div className="app">
      <Header />
      <aside>
        {sessions.length === 0 && <p className="muted">No sessions yet — start Claude Code or Codex.</p>}
        {sessions.map((s) => (
          <button key={s.id} className={`card ${s.id === current ? 'active' : ''}`} onClick={() => setSelected(s.id)}>
            <span className={`dot ${s.status}`} />
            <span className="title">{s.meta.title ?? s.meta.project ?? s.id.slice(0, 8)}</span>
            <span className="harness" style={{ color: HARNESS_COLOR[s.harness] }}>{s.harness}</span>
            <span className="meta">
              {Object.keys(s.agents).length} agents · {formatCount(s.counts.tools)} tools · {formatAgo(s.lastActivityAt)}
            </span>
          </button>
        ))}
      </aside>
      <main>{current ? <SessionView id={current} /> : null}</main>
    </div>
  )
}

function Header() {
  const t = useTotals()
  const status = useConnectionStatus()
  return (
    <header>
      <b>agents</b>
      <span className="live">{t.live} live</span>
      {t.waiting > 0 && <span className="waiting">{t.waiting} waiting</span>}
      <span>{t.agents} agents</span>
      <span>{formatCount(t.tools)} tool calls</span>
      <span>{formatCount(t.tokens)} tokens</span>
      <span className={`conn ${status}`}>{status}</span>
    </header>
  )
}

function SessionView({ id }: { id: string }) {
  const s = useSession(id)
  const tree = useAgentTree(id)
  if (!s) return null
  return (
    <div className="session">
      <h1>{s.meta.title ?? s.meta.project ?? s.id}</h1>
      <p className="muted">
        {[s.meta.project, s.meta.gitBranch, s.meta.model].filter(Boolean).join(' · ')} — <b className={s.status}>{s.status}</b>
        {s.status === 'waiting' && s.statusReason ? ` (${s.statusReason})` : ''}
      </p>
      <div className="stats">
        <Stat label="turns" value={s.counts.turns} />
        <Stat label="tools" value={s.counts.tools} />
        <Stat label="failed" value={s.counts.toolErrors} />
        <Stat label="tokens" value={formatCount(totalTokens(s.usage))} />
        {s.meta.costUsd !== undefined && <Stat label="cost" value={`$${s.meta.costUsd.toFixed(2)}`} />}
      </div>
      <div className="grid">
        <section>
          <h2>Running</h2>
          <Running id={id} />
          <h2>Agents</h2>
          {tree && <ul className="tree"><Agent node={tree} root /></ul>}
          <h2>Hot files</h2>
          <Files id={id} />
        </section>
        <section>
          <h2>Feed</h2>
          <Feed id={id} />
        </section>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return <div className="stat"><b>{value}</b><span>{label}</span></div>
}

function Running({ id }: { id: string }) {
  const tools = useOpenTools(id)
  const now = useNow(500)
  if (!tools.length) return <p className="muted">Nothing in flight.</p>
  return (
    <ul className="running">
      {tools.map((t) => (
        <li key={t.id} className={t.category}>
          <code>{t.title}</code>
          <span className="muted">{formatDuration(now - t.startedAt)}</span>
        </li>
      ))}
    </ul>
  )
}

function Agent({ node, root }: { node: AgentNode; root?: boolean }) {
  return (
    <li>
      <span className={`dot ${node.status}`} /> {root ? 'main' : node.name}
      {node.role && <span className="muted"> {node.role}</span>}
      <span className="muted"> · {node.toolCount} tools</span>
      {node.childNodes.length > 0 && <ul>{node.childNodes.map((c) => <Agent key={c.id} node={c} />)}</ul>}
    </li>
  )
}

function Files({ id }: { id: string }) {
  const files = useHotFiles(id, 12)
  if (!files.length) return <p className="muted">No files yet.</p>
  return (
    <ul className="files">
      {files.map((f) => (
        <li key={f.path}>
          <code>{f.path.replace(/\\/g, '/').split('/').slice(-2).join('/')}</code>
          <span className="muted">{f.reads}r {f.edits}e {f.writes}w</span>
        </li>
      ))}
    </ul>
  )
}

const interesting = (e: ObserverEvent) =>
  e.kind === 'message' || e.kind === 'tool.started' || (e.kind === 'tool.finished' && !e.ok) || e.kind === 'agent.spawned' || e.kind === 'turn.ended'

function Feed({ id }: { id: string }) {
  const events = useEvents({ session: id, limit: 150, filter: interesting })
  return (
    <ol className="feed">
      {[...events].reverse().map((e) => (
        <li key={e.seq} className={e.kind.replace('.', '-')}>
          <time>{new Date(e.ts).toLocaleTimeString()}</time>
          <span>{describe(e)}</span>
        </li>
      ))}
    </ol>
  )
}

function describe(e: ObserverEvent): string {
  switch (e.kind) {
    case 'message': return `${e.role === 'user' ? 'you' : e.role}: ${e.text.slice(0, 240)}`
    case 'tool.started': return `▸ ${e.title}`
    case 'tool.finished': return `✗ failed${e.output ? `: ${e.output.split('\n')[0]}` : ''}`
    case 'agent.spawned': return `✦ spawned ${e.name}${e.role ? ` (${e.role})` : ''}`
    case 'turn.ended': return `■ turn ${e.outcome}`
    default: return e.kind
  }
}
