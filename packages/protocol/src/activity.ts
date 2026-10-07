/**
 * What an agent (or a whole session) is doing right now, as one word.
 *
 * Status says whether something is happening; activity says what. It folds the
 * agent's status, its newest in-flight tool, its last result and the turn
 * outcome into a single value a frontend can animate, label or colour without
 * knowing anything about either harness.
 */
import type { ToolCategory } from './events.js'
import type { AgentState, SessionState, ToolCallState } from './state.js'

export type Activity =
  | 'thinking'    // working, model is generating, no tool in flight
  | 'reading'
  | 'searching'
  | 'editing'
  | 'writing'
  | 'running'     // shell commands
  | 'browsing'    // web fetch / search
  | 'delegating'  // waiting on subagents it spawned
  | 'planning'
  | 'tooling'     // MCP or anything uncategorised
  | 'asking'      // asked the user a question
  | 'waiting'     // blocked on a permission prompt
  | 'failed'      // its last tool call just failed
  | 'finished'    // turn completed recently
  | 'aborted'     // turn was interrupted or errored
  | 'idle'
  | 'sleeping'    // idle for a long while, or the session ended

export const ACTIVITIES: readonly Activity[] = [
  'thinking', 'reading', 'searching', 'editing', 'writing', 'running', 'browsing', 'delegating',
  'planning', 'tooling', 'asking', 'waiting', 'failed', 'finished', 'aborted', 'idle', 'sleeping',
]

const BY_CATEGORY: Record<ToolCategory, Activity> = {
  read: 'reading',
  search: 'searching',
  edit: 'editing',
  write: 'writing',
  shell: 'running',
  web: 'browsing',
  agent: 'delegating',
  plan: 'planning',
  mcp: 'tooling',
  interact: 'asking',
  other: 'tooling',
}

export interface ActivityOptions {
  /** How long a failed tool call keeps the agent looking unhappy (ms). Default 6 s. */
  failedMs?: number
  /** How long a completed turn reads as "finished" before settling to idle (ms). Default 2 min. */
  finishedMs?: number
  /** Idle time after which an agent is "sleeping" (ms). Default 10 min. */
  sleepMs?: number
}

/** The activity for one tool category. */
export function activityForCategory(category: ToolCategory): Activity {
  return BY_CATEGORY[category] ?? 'tooling'
}

/** The newest tool call this agent finished, if it is still in the bounded timeline. */
function lastFinished(s: SessionState, agentId: string): ToolCallState | undefined {
  for (let i = s.toolOrder.length - 1; i >= 0; i--) {
    const t = s.tools[s.toolOrder[i]!]
    if (t && t.agentId === agentId && t.endedAt !== undefined) return t
  }
  return undefined
}

/** What one agent is doing at `now`. */
export function agentActivity(s: SessionState, a: AgentState, now: number, opts: ActivityOptions = {}): Activity {
  const failedMs = opts.failedMs ?? 6_000
  const finishedMs = opts.finishedMs ?? 120_000
  const sleepMs = opts.sleepMs ?? 600_000
  const isRoot = a.id === s.rootAgentId

  if (a.status === 'waiting') return 'waiting'
  if (s.status === 'ended') return 'sleeping'

  if (a.status === 'working') {
    // Prefer real work over delegation: a parent that is waiting on its
    // subagents and also running a command is running a command.
    let newest: ToolCallState | undefined
    let delegating = false
    for (const id of a.activeTools) {
      const t = s.tools[id]
      if (!t) continue
      if (t.category === 'agent') { delegating = true; continue }
      if (!newest || t.startedAt >= newest.startedAt) newest = t
    }
    if (newest) return activityForCategory(newest.category)
    const last = lastFinished(s, a.id)
    if (last && last.ok === false && now - (last.endedAt ?? 0) < failedMs) return 'failed'
    if (delegating) return 'delegating'
    return 'thinking'
  }

  if (isRoot && s.turn.endedAt !== undefined && !s.turn.active) {
    const since = now - s.turn.endedAt
    if (s.turn.outcome === 'aborted' || s.turn.outcome === 'error') { if (since < finishedMs) return 'aborted' }
    else if (since < finishedMs) return 'finished'
  }
  if (a.status === 'done' && now - a.statusSince < finishedMs) return 'finished'
  return now - a.lastActivityAt > sleepMs ? 'sleeping' : 'idle'
}

/** What a session's main agent is doing; "waiting" if any of its agents is blocked on a prompt. */
export function sessionActivity(s: SessionState, now: number, opts: ActivityOptions = {}): Activity {
  for (const a of Object.values(s.agents)) if (a.status === 'waiting') return 'waiting'
  const root = s.agents[s.rootAgentId]
  return root ? agentActivity(s, root, now, opts) : 'idle'
}
