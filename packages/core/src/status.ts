/**
 * Time-based status heuristics.
 *
 * Transcripts say what happened, not what is happening *now*. A ticker turns
 * silence into status:
 *
 *  - waiting: a non-agent tool has been in flight for `waitingAfterMs` and the
 *             session has written nothing since — almost always a permission
 *             prompt (or a long-running command).
 *  - idle:    nothing in flight and quiet for `idleAfterMs`, or quiet for
 *             `staleAfterMs` regardless (the harness was closed mid-turn).
 *  - done:    a subagent with nothing in flight that has been quiet for `idleAfterMs`.
 */
import type { EventDraft, WorldState } from '@oadt/protocol'

export interface StatusOptions {
  waitingAfterMs: number
  idleAfterMs: number
  staleAfterMs: number
}

export const DEFAULT_STATUS: StatusOptions = {
  waitingAfterMs: 8_000,
  idleAfterMs: 5 * 60_000,
  staleAfterMs: 15 * 60_000,
}

export function statusTransitions(world: WorldState, now: number, opts: StatusOptions = DEFAULT_STATUS): EventDraft[] {
  const out: EventDraft[] = []
  for (const s of Object.values(world.sessions)) {
    if (s.status !== 'working' && s.status !== 'waiting') continue
    const base = { harness: s.harness, sessionId: s.id, ts: now }
    const quiet = now - s.lastActivityAt

    if (quiet >= opts.staleAfterMs) {
      out.push({ ...base, agentId: s.rootAgentId, kind: 'session.status', status: 'idle', reason: 'inactive' })
      continue
    }

    let anyOpen = false
    let anyWaiting = false
    for (const a of Object.values(s.agents)) {
      const open = a.activeTools.map((id) => s.tools[id]).filter((t) => t && t.endedAt === undefined && t.category !== 'agent')
      if (open.length) anyOpen = true
      const agentQuiet = now - a.lastActivityAt
      if (a.status === 'working' && open.length) {
        const oldest = Math.min(...open.map((t) => t!.startedAt))
        if (now - oldest >= opts.waitingAfterMs && quiet >= opts.waitingAfterMs) {
          anyWaiting = true
          out.push({ ...base, agentId: a.id, kind: 'agent.status', status: 'waiting', reason: `${open[0]!.title} — awaiting approval or still running` })
        }
      } else if (a.status === 'waiting') {
        anyWaiting = true
      } else if (a.status === 'working' && !open.length && a.id !== s.rootAgentId && a.activeTools.length === 0 && agentQuiet >= opts.idleAfterMs) {
        out.push({ ...base, agentId: a.id, kind: 'agent.status', status: 'done', reason: 'inactive' })
      }
    }

    if (anyWaiting && s.status !== 'waiting') {
      out.push({ ...base, agentId: s.rootAgentId, kind: 'session.status', status: 'waiting', reason: 'tool pending' })
    } else if (!anyOpen && !anyWaiting && quiet >= opts.idleAfterMs) {
      out.push({ ...base, agentId: s.rootAgentId, kind: 'session.status', status: 'idle', reason: 'inactive' })
    }
  }
  return out
}
