/**
 * Discovers and tails transcript files for one adapter.
 *
 * Detection is layered so nothing is missed on any OS:
 *   1. recursive fs.watch on the adapter roots for instant notification,
 *   2. a fast poll of known files (fs.watch can go quiet on long-lived handles),
 *   3. a slower rediscovery scan for brand-new files.
 */
import { watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import { FileTail } from './tail.js'
import type { Emit, LineParser, TranscriptAdapter } from './adapters/types.js'

export interface WatcherOptions {
  /** Only backfill files modified within this window (ms). */
  sinceMs: number
  /** Bytes of history to read from each file on startup. */
  backfillBytes: number
  /** Poll interval for known files (ms). */
  pollMs: number
  /** Rediscovery interval (ms). */
  scanMs: number
  onError?: (err: unknown, path?: string) => void
}

interface Tracked {
  tail: FileTail
  parser: LineParser
  busy: boolean
  again: boolean
  lastSize: number
}

export class TranscriptWatcher {
  private files = new Map<string, Tracked>()
  private watchers: FSWatcher[] = []
  private timers: NodeJS.Timeout[] = []
  private stopped = false
  private sessions = new Set<string>()

  constructor(
    readonly adapter: TranscriptAdapter,
    private emit: Emit,
    private opts: WatcherOptions,
  ) {}

  get fileCount(): number {
    return this.files.size
  }

  /** Backfill recent history, then start live tailing. Resolves once the backfill is complete. */
  async start(): Promise<void> {
    const since = Date.now() - this.opts.sinceMs
    const found = await this.safe(() => this.adapter.discover(since), [])
    const order = this.adapter.order?.bind(this.adapter)
    const withTime = await Promise.all(found.map(async (p) => ({ p, t: (await this.safe(() => stat(p), null))?.mtimeMs ?? 0 })))
    withTime.sort((a, b) => (order ? order(a.p) - order(b.p) : 0) || a.t - b.t)
    for (const { p } of withTime) await this.track(p)
    await this.tickAdapter()
    if (this.stopped) return

    for (const root of this.adapter.roots()) {
      try {
        const w = watch(root, { recursive: true }, (_event, filename) => {
          if (!filename) return
          const full = joinPath(root, filename.toString())
          if (this.adapter.accepts(full)) void this.touch(full)
        })
        w.on('error', () => { /* root removed or watch unsupported; polling covers us */ })
        this.watchers.push(w)
      } catch {
        // Root may not exist yet or recursive watch is unsupported — polling covers it.
      }
    }
    this.timers.push(setInterval(() => void this.pollKnown(), this.opts.pollMs))
    this.timers.push(setInterval(() => void this.rescan(), this.opts.scanMs))
  }

  stop(): void {
    this.stopped = true
    for (const w of this.watchers) w.close()
    for (const t of this.timers) clearInterval(t)
    this.watchers = []
    this.timers = []
  }

  private async touch(path: string): Promise<void> {
    const t = this.files.get(path)
    if (t) return this.pump(path, t)
    await this.track(path)
  }

  private async track(path: string): Promise<void> {
    if (this.files.has(path) || this.stopped) return
    const parser = this.adapter.createParser(path, this.emit)
    const tracked: Tracked = { tail: new FileTail(path), parser, busy: true, again: false, lastSize: 0 }
    this.files.set(path, tracked)
    try {
      const init = await tracked.tail.init(this.opts.backfillBytes)
      if (init.partial) parser.markPartial()
      this.feed(tracked, init.lines)
      tracked.lastSize = tracked.tail.size
    } catch (err) {
      this.opts.onError?.(err, path)
    } finally {
      tracked.busy = false
    }
    if (tracked.again) await this.pump(path, tracked)
  }

  private async pump(path: string, t: Tracked): Promise<void> {
    if (t.busy) { t.again = true; return }
    t.busy = true
    try {
      do {
        t.again = false
        const lines = await t.tail.read()
        this.feed(t, lines)
        t.lastSize = t.tail.size
      } while (t.again && !this.stopped)
    } catch (err) {
      this.opts.onError?.(err, path)
    } finally {
      t.busy = false
    }
  }

  private feed(t: Tracked, lines: string[]): void {
    for (const line of lines) {
      try {
        t.parser.line(line)
      } catch (err) {
        this.opts.onError?.(err, t.tail.path)
      }
    }
    if (t.parser.sessionId) this.sessions.add(t.parser.sessionId)
  }

  private async pollKnown(): Promise<void> {
    for (const [path, t] of this.files) {
      if (t.busy) continue
      const st = await this.safe(() => stat(path), null)
      if (st && st.size !== t.lastSize) void this.pump(path, t)
    }
  }

  private async rescan(): Promise<void> {
    if (this.stopped) return
    // New files are by definition recent; a short window keeps the scan cheap.
    const found = await this.safe(() => this.adapter.discover(Date.now() - Math.max(this.opts.scanMs * 20, 120_000)), [])
    const order = this.adapter.order?.bind(this.adapter)
    if (order) found.sort((a, b) => order(a) - order(b))
    for (const p of found) if (!this.files.has(p)) await this.track(p)
    await this.tickAdapter()
  }

  private async tickAdapter(): Promise<void> {
    if (!this.adapter.tick) return
    await this.safe(() => this.adapter.tick!(this.emit, this.sessions), undefined)
  }

  private async safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') this.opts.onError?.(err)
      return fallback
    }
  }
}

function joinPath(root: string, rel: string): string {
  const sep = root.includes('\\') ? '\\' : '/'
  return root.replace(/[\\/]+$/, '') + sep + rel.replace(/[\\/]/g, sep)
}
