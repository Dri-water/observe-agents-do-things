/**
 * What needs a human right now? A pure function over WorldState so every
 * frontend (dashboards, notifiers, chat bots) agrees on the answer.
 */
import type { SessionState, ToolCallState, WorldState } from './state.js'

export type AttentionKind = 'waiting' | 'errors' | 'finished' | 'aborted' | 'context' | 'long-tool'
export type AttentionSeverity = 'high' | 'medium' | 'low'

export interface AttentionItem {
  /** Stable for one occurrence — use it to acknowledge or de-duplicate notifications. */
  id: string
  kind: AttentionKind
  severity: AttentionSeverity
  sessionId: string
  agentId: string
  /** When the condition started (epoch ms). */
  since: number
  title: string
  detail?: string
}

export interface AttentionOptions {
  /** Show finished turns for this long (ms). Default 30 min. */
  finishedWithinMs: number
  /** Flag tools running longer than this while the agent isn't waiting (ms). Default 3 min. */
  longToolMs: number
  /** Consecutive failed tool calls that count as a streak. Default 3. */
  errorStreak: number
  /** Only report streaks whose last failure is this recent (ms). Default 10 min. */
  errorWithinMs: number
  /** Context fill (0–1) that counts as nearly full. Default 0.85. */
  contextFill: number
}

export const DEFAULT_ATTENTION: AttentionOptions = {
  finishedWithinMs: 30 * 60_000,
  longToolMs: 3 * 60_000,
  errorStreak: 3,
  errorWithinMs: 10 * 60_000,
  contextFill: 0.85,
}

const SEVERITY_RANK: Record<AttentionSeverity, number> = { high: 0, medium: 1, low: 2 }

function agentName(s: SessionState, agentId: string): string {
  return agentId === s.rootAgentId ? 'main' : s.agents[agentId]?.name ?? 'agent'
}

/** Failed tool calls at the end of the session's history, newest last. */
function failureStreak(s: SessionState): ToolCallState[] {
  const ended = s.toolOrder.map((id) => s.tools[id]).filter((t): t is ToolCallState => !!t && t.endedAt !== undefined)
  ended.sort((a, b) => a.endedAt! - b.endedAt!)
  const streak: ToolCallState[] = []
  for (let i = ended.length - 1; i >= 0 && ended[i]!.ok === false; i--) streak.unshift(ended[i]!)
  return streak
}

export function attentionItems(world: WorldState, now: number, options: Partial<AttentionOptions> = {}): AttentionItem[] {
  const o = { ...DEFAULT_ATTENTION, ...options }
  const items: AttentionItem[] = []
  for (const s of Object.values(world.sessions)) {
    for (const a of Object.values(s.agents)) {
      if (a.status === 'waiting') {
        items.push({
          id: `waiting:${s.id}:${a.id}:${a.statusSince}`,
          kind: 'waiting', severity: 'high', sessionId: s.id, agentId: a.id, since: a.statusSince,
          title: `${agentName(s, a.id)} is waiting for you`,
          detail: a.statusReason,
        })
      }
      if (a.status === 'working') {
        for (const id of a.activeTools) {
          const t = s.tools[id]
          if (!t || t.endedAt !== undefined || t.category === 'agent' || t.category === 'interact') continue
          if (now - t.startedAt >= o.longToolMs) {
            items.push({
              id: `long-tool:${s.id}:${t.id}`,
              kind: 'long-tool', severity: 'low', sessionId: s.id, agentId: a.id, since: t.startedAt,
              title: `${agentName(s, a.id)}: tool running a long time`,
              detail: t.title,
            })
          }
        }
      }
    }

    const streak = failureStreak(s)
    const lastFail = streak[streak.length - 1]
    if (streak.length >= o.errorStreak && lastFail && now - lastFail.endedAt! <= o.errorWithinMs) {
      items.push({
        id: `errors:${s.id}:${streak[0]!.id}`,
        kind: 'errors', severity: 'high', sessionId: s.id, agentId: lastFail.agentId, since: streak[0]!.endedAt!,
        title: `${streak.length} failures in a row`,
        detail: lastFail.title,
      })
    }

    const root = s.agents[s.rootAgentId]
    const fill = s.contextTokens && s.contextWindow ? s.contextTokens / s.contextWindow : undefined
    if (fill !== undefined && fill >= o.contextFill && (s.status === 'working' || s.status === 'waiting')) {
      items.push({
        id: `context:${s.id}`,
        kind: 'context', severity: 'medium', sessionId: s.id, agentId: s.rootAgentId, since: root?.lastActivityAt ?? now,
        title: `Context ${Math.round(fill * 100)}% full`,
        detail: 'Expect compaction soon',
      })
    }

    const ended = s.turn.endedAt
    if (s.status === 'idle' && !s.turn.active && ended && now - ended <= o.finishedWithinMs) {
      const completed = s.turn.outcome === 'completed'
      items.push({
        id: `${completed ? 'finished' : 'aborted'}:${s.id}:${ended}`,
        kind: completed ? 'finished' : 'aborted',
        severity: completed ? 'medium' : 'low',
        sessionId: s.id, agentId: s.rootAgentId, since: ended,
        title: completed ? 'Turn finished — ready for review' : `Turn ${s.turn.outcome ?? 'stopped'}`,
        detail: s.lastMessage?.role === 'assistant' ? s.lastMessage.text : undefined,
      })
    }
  }
  return items.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.since - b.since)
}
