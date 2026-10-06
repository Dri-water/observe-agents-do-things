/**
 * The observe-agents-do-things wire protocol.
 *
 * Every harness (Claude Code, Codex, your own agent…) is normalised into one
 * small vocabulary of events. Frontends never see harness-specific formats:
 * they consume `ObserverEvent`s and, optionally, fold them into a `WorldState`
 * with the pure `applyEvent` projection exported from this package.
 */

export const PROTOCOL_VERSION = 1 as const

/** Which agent harness produced the activity. Open-ended so custom adapters can add their own. */
export type Harness = 'claude-code' | 'codex' | (string & {})

/** Harness-agnostic tool buckets. Frontends colour and group by these. */
export type ToolCategory =
  | 'read'
  | 'edit'
  | 'write'
  | 'search'
  | 'shell'
  | 'web'
  | 'agent'
  | 'plan'
  | 'mcp'
  | 'interact'
  | 'other'

export const TOOL_CATEGORIES: readonly ToolCategory[] = [
  'read', 'edit', 'write', 'search', 'shell', 'web', 'agent', 'plan', 'mcp', 'interact', 'other',
]

export type FileOp = 'read' | 'edit' | 'write' | 'delete' | 'search'

export interface FileRef {
  /** Path as the agent referenced it (absolute when the harness provides one). */
  path: string
  op: FileOp
}

/**
 * - `working`  the agent produced activity recently or has a tool in flight
 * - `waiting`  a tool has been pending with no transcript activity — usually a permission prompt
 * - `idle`     the turn ended (or the session went quiet); the agent is waiting for the user
 * - `ended`    the session is over (reserved for harnesses that report it explicitly)
 */
export type SessionStatus = 'working' | 'waiting' | 'idle' | 'ended'

/** Agent status mirrors session status; `done` marks a finished subagent. */
export type AgentStatus = 'working' | 'waiting' | 'idle' | 'done'

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
}

export interface SessionMeta {
  title?: string
  /** Where the title came from: a user-set name, the harness's own index, or the first prompt. */
  titleSource?: 'custom' | 'harness' | 'prompt'
  cwd?: string
  /** Basename of the working directory — handy for display. */
  project?: string
  gitBranch?: string
  model?: string
  harnessVersion?: string
  /** How the harness was launched, e.g. `claude-desktop`, `cli`, `Codex Desktop`. */
  entrypoint?: string
  transcriptPath?: string
  permissionMode?: string
  costUsd?: number
  linesAdded?: number
  linesRemoved?: number
  prUrl?: string
  /** A long-running objective the harness is tracking (e.g. Codex goals). */
  goal?: string
  goalStatus?: string
  /** True when the observer only read the tail of a very large transcript. */
  partialHistory?: boolean
  /** True for sessions produced by the built-in demo simulator. */
  demo?: boolean
}

interface EventBase {
  /** Monotonic sequence number assigned by the observer. Use it to resume streams. */
  seq: number
  /** Wall-clock time of the underlying activity (epoch ms), taken from the transcript when available. */
  ts: number
  harness: Harness
  sessionId: string
  /** The agent the event belongs to. The root agent's id equals the session id. */
  agentId: string
}

export type EventBody =
  | { kind: 'session.started'; meta: SessionMeta }
  | { kind: 'session.updated'; meta: SessionMeta }
  | { kind: 'session.status'; status: SessionStatus; reason?: string }
  | {
      kind: 'agent.spawned'
      /** Parent agent, when the harness states it directly (Codex). */
      parentAgentId?: string
      /** The tool call that spawned this agent, when known (Claude Code `Agent`/`Task`). */
      parentToolCallId?: string
      name: string
      /** Agent type / role, e.g. `Explore`, `general-purpose`, `worker`. */
      role?: string
      task?: string
      model?: string
    }
  | { kind: 'agent.status'; status: AgentStatus; reason?: string }
  | { kind: 'turn.started'; turnId?: string }
  | { kind: 'turn.ended'; turnId?: string; outcome: 'completed' | 'aborted' | 'error'; durationMs?: number }
  | {
      kind: 'message'
      /** `agent` = a message sent between agents. */
      role: 'user' | 'assistant' | 'agent'
      text: string
      /** Recipient for inter-agent messages. */
      to?: string
    }
  | { kind: 'thinking'; text?: string; durationMs?: number }
  | {
      kind: 'tool.started'
      callId: string
      /** The harness's raw tool name, e.g. `Read`, `exec_command`, `mcp__github__create_issue`. */
      tool: string
      category: ToolCategory
      /** One-line human summary, e.g. `Read src/app.ts` or `$ npm test`. */
      title: string
      input?: unknown
      files?: FileRef[]
      mcpServer?: string
    }
  | {
      kind: 'tool.finished'
      callId: string
      ok: boolean
      output?: string
      durationMs?: number
    }
  | {
      kind: 'usage'
      /** Token deltas since the previous usage event for this agent. Sum them for totals. */
      delta: Usage
      model?: string
      /** Current context fill, when known. */
      contextTokens?: number
      contextWindow?: number
    }
  | { kind: 'note'; level: 'info' | 'warn'; text: string }

type Distribute<B> = B extends unknown ? EventBase & B : never
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** A normalised event as delivered to frontends. */
export type ObserverEvent = Distribute<EventBody>
export type EventKind = ObserverEvent['kind']
export type EventOf<K extends EventKind> = Extract<ObserverEvent, { kind: K }>

/** An event before the observer stamps it with a sequence number. Adapters and `/api/ingest` produce these. */
export type EventDraft = DistributiveOmit<ObserverEvent, 'seq'>

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
}
