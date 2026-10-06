import type { EventDraft, Harness } from '@oadt/protocol'

export type Emit = (draft: EventDraft) => void

/** Stateful parser for one transcript file. Receives complete lines in file order. */
export interface LineParser {
  line(raw: string): void
  /** Called when the watcher skipped the middle of a large file. */
  markPartial(): void
  /** The session this file belongs to, once known. */
  readonly sessionId: string | undefined
}

/**
 * A transcript adapter teaches the observer about one harness's on-disk format.
 * Implement this to add support for a new agent (see docs/ADAPTERS.md).
 */
export interface TranscriptAdapter {
  readonly harness: Harness
  /** Directories to watch. They may not exist yet. */
  roots(): string[]
  /** Transcript files modified at or after `sinceMs`. */
  discover(sinceMs: number): Promise<string[]>
  /** Whether a path reported by the file watcher belongs to this adapter. */
  accepts(path: string): boolean
  /** Sort key for the initial backfill (lower first). Use it to load parents before children. */
  order?(path: string): number
  createParser(path: string, emit: Emit): LineParser
  /** Optional periodic hook, e.g. to read a title index. `sessions` are the ids seen so far. */
  tick?(emit: Emit, sessions: ReadonlySet<string>): Promise<void>
}
