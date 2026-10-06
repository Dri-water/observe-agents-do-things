/**
 * WorldState: a JSON-serialisable projection of the event stream.
 *
 * The server keeps one and sends it as the initial snapshot; clients keep a
 * mirror by applying the same events with the same function. Because the
 * projection lives here (not in a frontend), every wrapper sees identical
 * derived state — agent trees, open tool calls, file heat, token totals.
 */
import {
  clip,
  emptyUsage,
  isSafeKey,
  type AgentStatus,
  type FileOp,
  type FileRef,
  type Harness,
  type ObserverEvent,
  type SessionMeta,
  type SessionStatus,
  type ToolCategory,
  type Usage,
} from './events.js'

export interface ToolCallState {
  id: string
  agentId: string
  tool: string
  category: ToolCategory
  title: string
  input?: unknown
  files: FileRef[]
  mcpServer?: string
  startedAt: number
  endedAt?: number
  ok?: boolean
  output?: string
  durationMs?: number
  /** Set when this call spawned a subagent. */
  childAgentId?: string
}

export interface AgentState {
  id: string
  parentId?: string
  parentToolCallId?: string
  name: string
  role?: string
  task?: string
  model?: string
  depth: number
  status: AgentStatus
  statusReason?: string
  startedAt: number
  lastActivityAt: number
  /** Ids of tool calls currently in flight. */
  activeTools: string[]
  toolCount: number
  errorCount: number
  children: string[]
  lastText?: string
  thinking: boolean
  usage: Usage
  contextTokens?: number
  contextWindow?: number
}

export interface FileStats {
  path: string
  reads: number
  edits: number
  writes: number
  deletes: number
  searches: number
  touches: number
  lastOp: FileOp
  lastTs: number
  lastAgentId: string
}

export interface TurnState {
  active: boolean
  id?: string
  startedAt?: number
  endedAt?: number
  outcome?: 'completed' | 'aborted' | 'error'
}

export interface SessionCounts {
  tools: number
  toolErrors: number
  messages: number
  userMessages: number
  turns: number
  thinking: number
  agents: number
}

export interface SessionState {
  id: string
  harness: Harness
  meta: SessionMeta
  status: SessionStatus
  statusReason?: string
  startedAt: number
  lastActivityAt: number
  rootAgentId: string
  agents: Record<string, AgentState>
  /** Most recent tool calls (bounded — see `ProjectionLimits`). */
  tools: Record<string, ToolCallState>
  /** Insertion order of `tools`, oldest first. */
  toolOrder: string[]
  files: Record<string, FileStats>
  usage: Usage
  contextTokens?: number
  contextWindow?: number
  counts: SessionCounts
  byCategory: Partial<Record<ToolCategory, number>>
  lastMessage?: { role: 'user' | 'assistant' | 'agent'; text: string; ts: number; agentId: string }
  lastNote?: { level: 'info' | 'warn'; text: string; ts: number }
  turn: TurnState
}

export interface WorldState {
  protocol: 1
  /** Sequence number of the last applied event. */
  seq: number
  sessions: Record<string, SessionState>
}

export interface ProjectionLimits {
  /** Keep at most this many tool calls per session (open calls are never evicted). */
  maxToolsPerSession: number
  /** Truncate stored tool output to this many characters. */
  maxOutputChars: number
  /** Truncate `lastText` / `lastMessage` to this many characters. */
  maxPreviewChars: number
  /** Keep at most this many files per session (least recently touched are dropped). */
  maxFilesPerSession: number
}

export const DEFAULT_LIMITS: ProjectionLimits = {
  maxToolsPerSession: 400,
  maxOutputChars: 1500,
  maxFilesPerSession: 1000,
  maxPreviewChars: 400,
}

export function createWorld(): WorldState {
  return { protocol: 1, seq: 0, sessions: {} }
}

const TITLE_RANK = { prompt: 1, harness: 2, custom: 3 } as const

const NON_ACTIVITY = new Set(['session.status', 'agent.status', 'session.updated', 'note'])

function clipMaybe(text: string | undefined, max: number): string | undefined {
  return text === undefined ? undefined : clip(text, max)
}

function ensureSession(world: WorldState, e: ObserverEvent): SessionState {
  let s = world.sessions[e.sessionId]
  if (!s) {
    s = {
      id: e.sessionId,
      harness: e.harness,
      meta: {},
      status: 'working',
      startedAt: e.ts,
      // Metadata and status events are not activity; never let them make a session look fresh.
      lastActivityAt: NON_ACTIVITY.has(e.kind) ? 0 : e.ts,
      rootAgentId: e.sessionId,
      agents: {},
      tools: {},
      toolOrder: [],
      files: {},
      usage: emptyUsage(),
      counts: { tools: 0, toolErrors: 0, messages: 0, userMessages: 0, turns: 0, thinking: 0, agents: 0 },
      byCategory: {},
      turn: { active: false },
    }
    world.sessions[e.sessionId] = s
  }
  return s
}

function ensureAgent(s: SessionState, agentId: string, ts: number): AgentState {
  let a = s.agents[agentId]
  if (!a) {
    const isRoot = agentId === s.rootAgentId
    a = {
      id: agentId,
      parentId: isRoot ? undefined : s.rootAgentId,
      name: isRoot ? 'main' : 'subagent',
      depth: isRoot ? 0 : 1,
      status: 'working',
      startedAt: ts || Date.now(),
      lastActivityAt: ts,
      activeTools: [],
      toolCount: 0,
      errorCount: 0,
      children: [],
      thinking: false,
      usage: emptyUsage(),
    }
    s.agents[agentId] = a
    s.counts.agents++
    if (!isRoot) {
      // Make sure the root exists so the tree always has an anchor.
      const root = ensureAgent(s, s.rootAgentId, ts)
      if (!root.children.includes(agentId)) root.children.push(agentId)
    }
  }
  return a
}

function reparent(s: SessionState, a: AgentState, parentId: string): void {
  if (a.parentId === parentId || parentId === a.id) return
  const old = a.parentId ? s.agents[a.parentId] : undefined
  if (old) old.children = old.children.filter((c) => c !== a.id)
  const parent = s.agents[parentId] ?? ensureAgent(s, parentId, a.startedAt)
  a.parentId = parentId
  if (!parent.children.includes(a.id)) parent.children.push(a.id)
  updateDepth(s, a)
}

function updateDepth(s: SessionState, a: AgentState, guard = 0): void {
  const parent = a.parentId ? s.agents[a.parentId] : undefined
  a.depth = parent ? parent.depth + 1 : 0
  if (guard > 32) return
  for (const c of a.children) {
    const child = s.agents[c]
    if (child) updateDepth(s, child, guard + 1)
  }
}

function addUsage(target: Usage, delta: Usage): void {
  target.input += delta.input
  target.output += delta.output
  target.cacheRead += delta.cacheRead
  target.cacheWrite += delta.cacheWrite
  target.reasoning += delta.reasoning
}

function touchFile(s: SessionState, ref: FileRef, ts: number, agentId: string, maxFiles: number): void {
  let f = s.files[ref.path]
  if (!f) {
    const paths = Object.keys(s.files)
    if (paths.length >= maxFiles) {
      // Drop the least recently touched tenth to make room.
      const oldest = paths.sort((x, y) => s.files[x]!.lastTs - s.files[y]!.lastTs).slice(0, Math.ceil(maxFiles / 10))
      for (const p of oldest) delete s.files[p]
    }
    f = { path: ref.path, reads: 0, edits: 0, writes: 0, deletes: 0, searches: 0, touches: 0, lastOp: ref.op, lastTs: ts, lastAgentId: agentId }
    s.files[ref.path] = f
  }
  f.touches++
  f.lastOp = ref.op
  f.lastTs = Math.max(f.lastTs, ts)
  f.lastAgentId = agentId
  if (ref.op === 'read') f.reads++
  else if (ref.op === 'edit') f.edits++
  else if (ref.op === 'write') f.writes++
  else if (ref.op === 'delete') f.deletes++
  else f.searches++
}

function closeTool(s: SessionState, t: ToolCallState, ok: boolean, ts: number, output?: string, durationMs?: number, limits = DEFAULT_LIMITS): void {
  if (t.endedAt !== undefined) return
  t.endedAt = ts
  t.ok = ok
  t.output = clipMaybe(output, limits.maxOutputChars)
  t.durationMs = durationMs ?? Math.max(0, ts - t.startedAt)
  const owner = s.agents[t.agentId]
  if (owner) {
    owner.activeTools = owner.activeTools.filter((id) => id !== t.id)
    if (!ok) owner.errorCount++
    if (owner.status === 'waiting' && owner.activeTools.length === 0) owner.status = 'working'
  }
  if (!ok) s.counts.toolErrors++
}

function evictTools(s: SessionState, max: number): void {
  if (s.toolOrder.length <= max) return
  const keep: string[] = []
  let excess = s.toolOrder.length - max
  for (const id of s.toolOrder) {
    const t = s.tools[id]
    if (excess > 0 && t && t.endedAt !== undefined) {
      delete s.tools[id]
      excess--
    } else if (t) {
      keep.push(id)
    }
  }
  s.toolOrder = keep
}

/**
 * Fold one event into the world. Mutates and returns `world`.
 * Safe to call with events in any order: unknown sessions and agents are created on demand.
 */
export function applyEvent(world: WorldState, e: ObserverEvent, limits: ProjectionLimits = DEFAULT_LIMITS): WorldState {
  if (e.seq > world.seq) world.seq = e.seq
  if (!isSafeKey(e.sessionId) || !isSafeKey(e.agentId)) return world
  if ((e.kind === 'tool.started' || e.kind === 'tool.finished') && !isSafeKey(e.callId)) return world
  const s = ensureSession(world, e)
  const a = ensureAgent(s, e.agentId, NON_ACTIVITY.has(e.kind) ? 0 : e.ts)
  const isRoot = a.id === s.rootAgentId

  if (!NON_ACTIVITY.has(e.kind)) {
    // Transcripts are read file by file, so older events can arrive after newer ones.
    // Only the newest activity may wake an agent or session back up.
    const newestForAgent = e.ts >= a.lastActivityAt
    const newestForSession = e.ts >= s.lastActivityAt && e.ts >= (s.turn.endedAt ?? 0)
    if (e.ts > s.lastActivityAt) s.lastActivityAt = e.ts
    if (e.ts > a.lastActivityAt) a.lastActivityAt = e.ts
    if (e.kind !== 'turn.ended' && e.kind !== 'usage') {
      if (a.status !== 'working' && newestForAgent) { a.status = 'working'; a.statusReason = undefined }
      if (s.status !== 'working' && newestForSession) {
        s.status = 'working'
        s.statusReason = undefined
      }
    }
  }
  if (e.ts < s.startedAt) s.startedAt = e.ts

  switch (e.kind) {
    case 'session.started':
    case 'session.updated': {
      const { title, titleSource, ...rest } = e.meta
      for (const [k, v] of Object.entries(rest)) {
        if (v !== undefined) (s.meta as Record<string, unknown>)[k] = v
      }
      if (title) {
        const incoming = TITLE_RANK[titleSource ?? 'harness']
        const current = s.meta.titleSource ? TITLE_RANK[s.meta.titleSource] : 0
        if (incoming >= current) {
          s.meta.title = title
          s.meta.titleSource = titleSource ?? 'harness'
        }
      }
      if (e.harness && s.harness !== e.harness && e.kind === 'session.started') s.harness = e.harness
      break
    }

    case 'session.status': {
      s.status = e.status
      s.statusReason = e.reason
      if (e.status === 'idle' || e.status === 'ended') {
        for (const ag of Object.values(s.agents)) {
          if (ag.status === 'working' || ag.status === 'waiting') {
            ag.status = ag.id === s.rootAgentId ? 'idle' : 'done'
            ag.thinking = false
          }
        }
      }
      break
    }

    case 'agent.spawned': {
      a.name = e.name || a.name
      if (e.role) a.role = e.role
      if (e.task) a.task = e.task
      if (e.model) a.model = e.model
      if (isSafeKey(e.parentToolCallId)) {
        a.parentToolCallId = e.parentToolCallId
        const t = s.tools[e.parentToolCallId]
        if (t) {
          t.childAgentId = a.id
          reparent(s, a, t.agentId)
        }
      }
      if (isSafeKey(e.parentAgentId)) reparent(s, a, e.parentAgentId)
      if (e.ts < a.startedAt) a.startedAt = e.ts
      break
    }

    case 'agent.status': {
      a.status = e.status
      a.statusReason = e.reason
      if (e.status !== 'working') a.thinking = false
      if (e.status === 'waiting' && s.status === 'working') s.status = 'waiting'
      break
    }

    case 'turn.started': {
      if (isRoot) {
        s.turn = { active: true, id: e.turnId, startedAt: e.ts }
        s.counts.turns++
      }
      break
    }

    case 'turn.ended': {
      a.thinking = false
      const ok = e.outcome === 'completed'
      for (const id of [...a.activeTools]) {
        const t = s.tools[id]
        if (t && t.category !== 'agent') closeTool(s, t, ok, e.ts, ok ? undefined : 'interrupted', undefined, limits)
      }
      if (isRoot) {
        s.turn = { ...s.turn, active: false, id: e.turnId ?? s.turn.id, endedAt: e.ts, outcome: e.outcome }
        s.status = 'idle'
        s.statusReason = e.outcome === 'completed' ? 'turn complete' : e.outcome
        a.status = 'idle'
      } else {
        a.status = 'done'
      }
      break
    }

    case 'message': {
      s.counts.messages++
      if (e.role === 'user') s.counts.userMessages++
      const preview = clip(e.text, limits.maxPreviewChars)
      s.lastMessage = { role: e.role, text: preview, ts: e.ts, agentId: a.id }
      if (e.role !== 'user') a.lastText = preview
      a.thinking = false
      break
    }

    case 'thinking': {
      a.thinking = true
      s.counts.thinking++
      break
    }

    case 'tool.started': {
      a.thinking = false
      if (s.tools[e.callId]) break // duplicate delivery
      const t: ToolCallState = {
        id: e.callId,
        agentId: a.id,
        tool: e.tool,
        category: e.category,
        title: e.title,
        input: e.input,
        files: e.files ?? [],
        mcpServer: e.mcpServer,
        startedAt: e.ts,
      }
      s.tools[e.callId] = t
      s.toolOrder.push(e.callId)
      a.activeTools.push(e.callId)
      a.toolCount++
      s.counts.tools++
      s.byCategory[e.category] = (s.byCategory[e.category] ?? 0) + 1
      for (const f of t.files) if (isSafeKey(f.path)) touchFile(s, f, e.ts, a.id, limits.maxFilesPerSession)
      // A subagent may have been announced before the call that spawned it.
      for (const other of Object.values(s.agents)) {
        if (other.parentToolCallId === e.callId) {
          t.childAgentId = other.id
          reparent(s, other, a.id)
        }
      }
      evictTools(s, limits.maxToolsPerSession)
      break
    }

    case 'tool.finished': {
      const t = s.tools[e.callId]
      if (!t) break
      closeTool(s, t, e.ok, e.ts, e.output, e.durationMs, limits)
      if (t.childAgentId) {
        const child = s.agents[t.childAgentId]
        if (child && child.status !== 'done' && child.lastActivityAt <= e.ts && child.activeTools.length === 0) {
          child.status = 'done'
          child.thinking = false
        }
      }
      break
    }

    case 'usage': {
      addUsage(s.usage, e.delta)
      addUsage(a.usage, e.delta)
      if (e.model) a.model = e.model
      if (e.contextTokens !== undefined) a.contextTokens = e.contextTokens
      if (e.contextWindow !== undefined) a.contextWindow = e.contextWindow
      if (isRoot) {
        if (e.model) s.meta.model = e.model
        if (e.contextTokens !== undefined) s.contextTokens = e.contextTokens
        if (e.contextWindow !== undefined) s.contextWindow = e.contextWindow
      }
      break
    }

    case 'note': {
      s.lastNote = { level: e.level, text: e.text, ts: e.ts }
      break
    }
  }
  return world
}

/** Fold many events. */
export function applyEvents(world: WorldState, events: Iterable<ObserverEvent>, limits?: ProjectionLimits): WorldState {
  for (const e of events) applyEvent(world, e, limits)
  return world
}

/** Restrict a world to a subset of sessions (cheap shallow copy). */
export function pickSessions(world: WorldState, ids: Iterable<string>): WorldState {
  const sessions: Record<string, SessionState> = {}
  for (const id of ids) {
    const s = world.sessions[id]
    if (s) sessions[id] = s
  }
  return { protocol: 1, seq: world.seq, sessions }
}
