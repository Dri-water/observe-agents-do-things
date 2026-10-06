/**
 * EventStore: the single source of truth inside the observer.
 *
 * Adapters push drafts → the store stamps a sequence number, applies the
 * privacy policy, folds the event into the WorldState, keeps bounded logs for
 * replay/resume, and notifies subscribers.
 */
import {
  applyEvent,
  createWorld,
  DEFAULT_LIMITS,
  type EventDraft,
  type ObserverEvent,
  type ProjectionLimits,
  type WorldState,
} from '@oadt/protocol'
import { redact, type RedactMode } from './redact.js'

export interface StoreOptions {
  /** Global replay buffer size (events). */
  maxEvents?: number
  /** Per-session history size (events). */
  maxSessionEvents?: number
  /** Sessions kept in memory; the least recently active idle ones are dropped beyond this. */
  maxSessions?: number
  redact?: RedactMode
  limits?: Partial<ProjectionLimits>
}

export type Listener = (event: ObserverEvent) => void

export class EventStore {
  readonly world: WorldState = createWorld()
  private seq = 0
  private log: ObserverEvent[] = []
  private bySession = new Map<string, ObserverEvent[]>()
  private listeners = new Set<Listener>()
  private logTrimmed = false
  private trimmedSessions = new Set<string>()
  private readonly maxEvents: number
  private readonly maxSessionEvents: number
  private readonly maxSessions: number
  private readonly redactMode: RedactMode
  readonly limits: ProjectionLimits

  constructor(opts: StoreOptions = {}) {
    this.maxEvents = opts.maxEvents ?? 50_000
    this.maxSessionEvents = opts.maxSessionEvents ?? 5_000
    this.maxSessions = opts.maxSessions ?? 300
    this.redactMode = opts.redact ?? 'none'
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits }
  }

  get lastSeq(): number {
    return this.seq
  }

  /** The oldest sequence number still held in the replay buffer. */
  get firstSeq(): number {
    return this.log[0]?.seq ?? this.seq + 1
  }

  push(draft: EventDraft): ObserverEvent {
    const clean = redact(draft, this.redactMode)
    const event = { ...clean, seq: ++this.seq } as ObserverEvent
    applyEvent(this.world, event, this.limits)

    this.log.push(event)
    if (this.log.length > this.maxEvents * 1.1) {
      this.log = this.log.slice(-this.maxEvents)
      this.logTrimmed = true
    }
    let list = this.bySession.get(event.sessionId)
    if (!list) {
      this.bySession.set(event.sessionId, (list = []))
      this.evictSessions()
    }
    list.push(event)
    if (list.length > this.maxSessionEvents * 1.1) {
      this.bySession.set(event.sessionId, list.slice(-this.maxSessionEvents))
      this.trimmedSessions.add(event.sessionId)
    }

    for (const l of this.listeners) {
      try {
        l(event)
      } catch { /* a broken subscriber must not break ingestion */ }
    }
    return event
  }

  /** Keep long-running observers bounded: forget the oldest idle sessions. */
  private evictSessions(): void {
    const ids = Object.keys(this.world.sessions)
    if (ids.length <= this.maxSessions) return
    const idle = ids
      .map((id) => this.world.sessions[id]!)
      .filter((s) => s.status === 'idle' || s.status === 'ended')
      .sort((a, b) => a.lastActivityAt - b.lastActivityAt)
    for (const s of idle.slice(0, ids.length - this.maxSessions)) {
      delete this.world.sessions[s.id]
      this.bySession.delete(s.id)
      this.trimmedSessions.delete(s.id)
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /**
   * Events after `seq`, optionally for one session. Returns `null` when the
   * requested range has been evicted — callers should fall back to a snapshot.
   */
  since(seq: number, sessionId?: string, limit = Infinity): ObserverEvent[] | null {
    const source = sessionId ? this.bySession.get(sessionId) ?? [] : this.log
    const trimmed = sessionId ? this.trimmedSessions.has(sessionId) : this.logTrimmed
    if (trimmed && source.length > 0 && seq < source[0]!.seq - 1) return null
    const out: ObserverEvent[] = []
    // Binary search for the first event with seq > `seq`.
    let lo = 0, hi = source.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (source[mid]!.seq <= seq) lo = mid + 1
      else hi = mid
    }
    for (let i = lo; i < source.length && out.length < limit; i++) out.push(source[i]!)
    return out
  }

  sessionEvents(sessionId: string): ObserverEvent[] {
    return this.bySession.get(sessionId) ?? []
  }
}
