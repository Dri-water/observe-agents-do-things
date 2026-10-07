/**
 * Small, pure helpers for reading a WorldState. Frontends can use these or
 * ignore them — they never mutate state.
 */
import type { FileChange, ToolCategory, Usage } from './events.js'
import type { AgentState, FileStats, SessionState, ToolCallState, WorldState } from './state.js'

const STATUS_ORDER = { waiting: 0, working: 1, idle: 2, ended: 3 } as const

/** Sessions ordered for display: waiting first, then working, then by most recent activity. */
export function sessionList(world: WorldState): SessionState[] {
  return Object.values(world.sessions).sort((a, b) => {
    const sa = STATUS_ORDER[a.status] ?? 9
    const sb = STATUS_ORDER[b.status] ?? 9
    if (sa !== sb) return sa - sb
    return b.lastActivityAt - a.lastActivityAt
  })
}

/** True when the session is actively doing something. */
export function isLive(s: SessionState): boolean {
  return s.status === 'working' || s.status === 'waiting'
}

/** The most recently active session, preferring live ones. */
export function mostRecentSession(world: WorldState): SessionState | undefined {
  let best: SessionState | undefined
  for (const s of Object.values(world.sessions)) {
    if (!best) { best = s; continue }
    const liveA = isLive(s), liveB = isLive(best)
    if (liveA !== liveB) { if (liveA) best = s; continue }
    if (s.lastActivityAt > best.lastActivityAt) best = s
  }
  return best
}

/** Tool calls that have started but not finished. */
export function openTools(s: SessionState): ToolCallState[] {
  const out: ToolCallState[] = []
  for (const a of Object.values(s.agents)) for (const id of a.activeTools) {
    const t = s.tools[id]
    if (t) out.push(t)
  }
  return out.sort((x, y) => x.startedAt - y.startedAt)
}

/** Tool calls in chronological order (bounded by the projection limits). */
export function toolTimeline(s: SessionState): ToolCallState[] {
  return s.toolOrder.map((id) => s.tools[id]).filter((t): t is ToolCallState => !!t)
}

export interface AgentNode extends AgentState {
  childNodes: AgentNode[]
}

/** The session's agents as a tree rooted at the main agent. */
export function agentTree(s: SessionState): AgentNode | undefined {
  const build = (id: string, guard: number): AgentNode | undefined => {
    const a = s.agents[id]
    if (!a) return undefined
    const childNodes = guard > 32 ? [] : a.children.map((c) => build(c, guard + 1)).filter((n): n is AgentNode => !!n)
    return { ...a, childNodes }
  }
  return build(s.rootAgentId, 0)
}

/** Files sorted by how often they were touched (then recency). */
export function hotFiles(s: SessionState, limit = 50): FileStats[] {
  return Object.values(s.files)
    .sort((a, b) => b.touches - a.touches || b.lastTs - a.lastTs)
    .slice(0, limit)
}

export function totalTokens(u: Usage): number {
  return u.input + u.output + u.cacheRead + u.cacheWrite
}

/** Fraction of the context window in use, if known. */
export function contextFill(s: SessionState | AgentState): number | undefined {
  if (!s.contextTokens || !s.contextWindow) return undefined
  return Math.min(1, s.contextTokens / s.contextWindow)
}

export function categoryBreakdown(s: SessionState): Array<{ category: ToolCategory; count: number }> {
  return Object.entries(s.byCategory)
    .map(([category, count]) => ({ category: category as ToolCategory, count: count ?? 0 }))
    .sort((a, b) => b.count - a.count)
}

/** Aggregate numbers across every session — handy for dashboards. */
export function worldTotals(world: WorldState) {
  let live = 0, waiting = 0, agents = 0, tools = 0, errors = 0, tokens = 0, cost = 0
  for (const s of Object.values(world.sessions)) {
    if (isLive(s)) live++
    if (s.status === 'waiting') waiting++
    agents += s.counts.agents
    tools += s.counts.tools
    errors += s.counts.toolErrors
    tokens += totalTokens(s.usage)
    cost += s.meta.costUsd ?? 0
  }
  return { sessions: Object.keys(world.sessions).length, live, waiting, agents, tools, errors, tokens, costUsd: cost }
}

/** Human-friendly compact numbers: 1234 → "1.2k". */
export function formatCount(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + 'k'
  if (n < 1e9) return (n / 1e6).toFixed(n < 1e7 ? 1 : 0) + 'M'
  return (n / 1e9).toFixed(1) + 'B'
}

/** 65000 → "1m 5s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

/** "3m ago" style relative time. */
export function formatAgo(ts: number, now = Date.now()): string {
  const d = Math.max(0, now - ts)
  if (d < 5000) return 'just now'
  if (d < 60_000) return `${Math.round(d / 1000)}s ago`
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`
  return `${Math.round(d / 86_400_000)}d ago`
}

/** Last two path segments, normalising Windows separators. */
export function shortPath(p: string, segments = 2): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.slice(-segments).join('/') || p
}

export interface ChangeEntry {
  /** Stable key: tool call id plus the change's index within it. */
  key: string
  sessionId: string
  agentId: string
  tool: ToolCallState
  change: FileChange
  ts: number
}

/** File edits across the given sessions (or all), newest first. */
export function recentChanges(world: WorldState, limit = 50, sessionIds?: Iterable<string>): ChangeEntry[] {
  const ids = sessionIds ? [...sessionIds] : Object.keys(world.sessions)
  const out: ChangeEntry[] = []
  for (const id of ids) {
    const s = world.sessions[id]
    if (!s) continue
    for (const toolId of s.toolOrder) {
      const t = s.tools[toolId]
      if (!t?.changes?.length) continue
      t.changes.forEach((change, i) => out.push({ key: `${s.id}:${t.id}:${i}`, sessionId: s.id, agentId: t.agentId, tool: t, change, ts: t.startedAt }))
    }
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, limit)
}
