/**
 * Observer: wires sources → EventStore → subscribers.
 *
 * ```ts
 * const obs = new Observer({ sinceMs: 3 * 3600_000 })
 * obs.subscribe((e) => console.log(e.kind, e.agentId))
 * await obs.start()
 * ```
 */
import type { EventDraft, ObserverEvent, WorldState } from '@oadt/protocol'
import { ClaudeCodeAdapter } from './adapters/claude-code.js'
import { CodexAdapter } from './adapters/codex.js'
import type { Emit, TranscriptAdapter } from './adapters/types.js'
import type { RedactMode } from './redact.js'
import { DEFAULT_STATUS, statusTransitions, type StatusOptions } from './status.js'
import { EventStore, type Listener, type StoreOptions } from './store.js'
import { TranscriptWatcher } from './watcher.js'

/** Anything that produces events: transcript watchers, the demo simulator, a replayer, your own code. */
export interface Source {
  readonly name: string
  start(emit: Emit): Promise<void>
  stop(): void
  describe?(): Record<string, unknown>
}

export type BuiltinHarness = 'claude-code' | 'codex'

export interface ObserverOptions {
  /** Built-in harnesses to watch. Defaults to both. */
  harnesses?: BuiltinHarness[]
  /** Backfill transcripts modified within this window. Default 6 hours. */
  sinceMs?: number
  /** History read per transcript on startup. Default 8 MiB. */
  backfillBytes?: number
  claudeDir?: string
  codexHome?: string
  /** Extra transcript adapters (see docs/ADAPTERS.md). */
  adapters?: TranscriptAdapter[]
  /** Extra event sources (demo, replay, custom). */
  sources?: Source[]
  redact?: RedactMode
  /** Max characters kept for messages and thinking. Default 4000. */
  maxText?: number
  status?: Partial<StatusOptions>
  store?: StoreOptions
  onError?: (err: unknown, path?: string) => void
}

class TranscriptSource implements Source {
  private watcher?: TranscriptWatcher
  constructor(
    private adapter: TranscriptAdapter,
    private opts: { sinceMs: number; backfillBytes: number; onError?: (err: unknown, path?: string) => void },
  ) {}
  get name(): string {
    return this.adapter.harness
  }
  async start(emit: Emit): Promise<void> {
    this.watcher = new TranscriptWatcher(this.adapter, emit, {
      sinceMs: this.opts.sinceMs,
      backfillBytes: this.opts.backfillBytes,
      pollMs: 750,
      scanMs: 3000,
      onError: this.opts.onError,
    })
    await this.watcher.start()
  }
  stop(): void {
    this.watcher?.stop()
  }
  describe(): Record<string, unknown> {
    return { roots: this.adapter.roots(), files: this.watcher?.fileCount ?? 0 }
  }
}

export class Observer {
  readonly store: EventStore
  readonly sources: Source[] = []
  private ticker?: NodeJS.Timeout
  private readonly statusOpts: StatusOptions
  private started = false

  constructor(opts: ObserverOptions = {}) {
    this.store = new EventStore({ redact: opts.redact, ...opts.store })
    this.statusOpts = { ...DEFAULT_STATUS, ...opts.status }
    const common = {
      sinceMs: opts.sinceMs ?? 6 * 3600_000,
      backfillBytes: opts.backfillBytes ?? 8 * 1024 * 1024,
      onError: opts.onError,
    }
    const harnesses = opts.harnesses ?? (opts.sources?.length ? [] : ['claude-code', 'codex'])
    if (harnesses.includes('claude-code')) {
      this.sources.push(new TranscriptSource(new ClaudeCodeAdapter({ claudeDir: opts.claudeDir, maxText: opts.maxText }), common))
    }
    if (harnesses.includes('codex')) {
      this.sources.push(new TranscriptSource(new CodexAdapter({ codexHome: opts.codexHome, maxText: opts.maxText }), common))
    }
    for (const a of opts.adapters ?? []) this.sources.push(new TranscriptSource(a, common))
    for (const s of opts.sources ?? []) this.sources.push(s)
  }

  get world(): WorldState {
    return this.store.world
  }

  /** Backfill every source, then go live. Resolves once the backfill completes. */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    const emit: Emit = (d) => { this.store.push(d) }
    await Promise.all(this.sources.map((s) => s.start(emit)))
    this.tick()
    this.ticker = setInterval(() => this.tick(), 1000)
    this.ticker.unref?.()
  }

  stop(): void {
    for (const s of this.sources) s.stop()
    if (this.ticker) clearInterval(this.ticker)
  }

  /** Push events from your own code (or `POST /api/ingest`). */
  ingest(draft: EventDraft | EventDraft[]): ObserverEvent[] {
    const list = Array.isArray(draft) ? draft : [draft]
    return list.map((d) => this.store.push(d))
  }

  subscribe(fn: Listener): () => void {
    return this.store.subscribe(fn)
  }

  describe(): Array<Record<string, unknown>> {
    return this.sources.map((s) => ({ name: s.name, ...s.describe?.() }))
  }

  private tick(): void {
    for (const d of statusTransitions(this.store.world, Date.now(), this.statusOpts)) this.store.push(d)
  }
}
