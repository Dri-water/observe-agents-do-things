/**
 * Replays recorded transcripts as if they were happening now, compressed in time.
 * Great for demos, for building frontends without a live agent, and for
 * reviewing what an agent did overnight.
 */
import { open } from 'node:fs/promises'
import type { EventDraft } from '@oadt/protocol'
import { ClaudeTranscriptParser } from '../adapters/claude-code.js'
import { CodexRolloutParser } from '../adapters/codex.js'
import type { Emit, LineParser } from '../adapters/types.js'
import type { Source } from '../observer.js'
import { FileTail } from '../tail.js'

export interface ReplayOptions {
  /** Time compression factor. Default 10×. */
  speed?: number
  /** Never wait longer than this between two events (ms, after compression). Default 2000. */
  maxGapMs?: number
  /** Start over when finished. */
  loop?: boolean
  /** Bytes read per file. Default 64 MiB (tail of larger files). */
  maxBytes?: number
}

async function sniffHarness(path: string): Promise<'codex' | 'claude-code'> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(4096)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    const head = buf.toString('utf8', 0, bytesRead)
    return /"type"\s*:\s*"(session_meta|response_item|event_msg|turn_context)"/.test(head) ? 'codex' : 'claude-code'
  } finally {
    await fh.close()
  }
}

/** Parse transcript files into drafts (in timestamp order) without watching them. */
export async function loadTranscripts(files: string[], maxBytes = 64 * 1024 * 1024): Promise<EventDraft[]> {
  const drafts: EventDraft[] = []
  const emit: Emit = (d) => drafts.push(d)
  // Parents first so subagents can be linked to the calls that spawned them.
  const ordered = [...files].sort((a, b) => Number(/[\\/]subagents[\\/]/.test(a)) - Number(/[\\/]subagents[\\/]/.test(b)))
  for (const file of ordered) {
    const harness = await sniffHarness(file)
    const parser: LineParser = harness === 'codex' ? new CodexRolloutParser(file, emit) : new ClaudeTranscriptParser(file, emit)
    const tail = new FileTail(file)
    const { lines, partial } = await tail.init(maxBytes)
    if (partial) parser.markPartial()
    for (const l of lines) parser.line(l)
  }
  return drafts.map((d, i) => ({ d, i })).sort((a, b) => a.d.ts - b.d.ts || a.i - b.i).map((x) => x.d)
}

export class ReplaySource implements Source {
  readonly name = 'replay'
  private stopped = false
  private timer?: NodeJS.Timeout
  private total = 0
  private emitted = 0

  constructor(private files: string[], private opts: ReplayOptions = {}) {}

  async start(emit: Emit): Promise<void> {
    const drafts = await loadTranscripts(this.files, this.opts.maxBytes)
    this.total = drafts.length
    void this.play(drafts, emit, 0)
  }

  private async play(drafts: EventDraft[], emit: Emit, pass: number): Promise<void> {
    const speed = this.opts.speed ?? 10
    const maxGap = this.opts.maxGapMs ?? 2000
    const suffix = pass > 0 ? `~${pass}` : ''
    let prev = drafts[0]?.ts ?? 0
    for (const d of drafts) {
      if (this.stopped) return
      const wait = Math.min(Math.max(0, d.ts - prev) / speed, maxGap)
      prev = d.ts
      if (wait > 4) await new Promise<void>((r) => { this.timer = setTimeout(r, wait) })
      if (this.stopped) return
      const rewritten = { ...d, ts: Date.now(), sessionId: d.sessionId + suffix } as EventDraft
      if (suffix && rewritten.agentId === d.sessionId) rewritten.agentId = rewritten.sessionId
      if (suffix && rewritten.kind === 'agent.spawned' && rewritten.parentAgentId === d.sessionId) rewritten.parentAgentId = rewritten.sessionId
      emit(rewritten)
      this.emitted++
    }
    if (this.opts.loop && !this.stopped) {
      await new Promise<void>((r) => { this.timer = setTimeout(r, 3000) })
      return this.play(drafts, emit, pass + 1)
    }
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
  }

  describe(): Record<string, unknown> {
    return { files: this.files.length, events: this.total, emitted: this.emitted }
  }
}
