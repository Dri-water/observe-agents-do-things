/**
 * Claude Code transcripts.
 *
 *   <claude dir>/projects/<encoded-cwd>/<session-id>.jsonl                       main agent
 *   <claude dir>/projects/<encoded-cwd>/<session-id>/subagents/agent-<id>.jsonl  subagents
 *   <claude dir>/projects/<encoded-cwd>/<session-id>/subagents/agent-<id>.meta.json
 *        { agentType, description, toolUseId }  ← links the subagent to its spawning tool call
 *
 * Works the same for the CLI, IDE extensions and the desktop app — they all write here.
 */
import { readFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { emptyUsage, type EventDraft, type Usage } from '@oadt/protocol'
import { basename, clip, compactInput, contentText, firstLine, humanText, isRecord, num, str, toMs } from '../text.js'
import { claudeChanges } from '../diff.js'
import { describeClaudeTool } from '../tools.js'
import type { Emit, LineParser, TranscriptAdapter } from './types.js'

const HARNESS = 'claude-code'
const SUBAGENT_FILE = /agent-([A-Za-z0-9_-]+)\.jsonl$/
const INTERRUPTED = '[Request interrupted by user'
/** Tool output kept per call (the projection trims further for display). */
const OUTPUT_MAX = 2000

export interface ClaudeCodeAdapterOptions {
  /** Defaults to $CLAUDE_CONFIG_DIR or ~/.claude */
  claudeDir?: string
  maxText?: number
}

export class ClaudeCodeAdapter implements TranscriptAdapter {
  readonly harness = HARNESS
  readonly projectsDir: string

  constructor(private opts: ClaudeCodeAdapterOptions = {}) {
    const base = opts.claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
    this.projectsDir = join(base, 'projects')
  }

  roots(): string[] {
    return [this.projectsDir]
  }

  accepts(path: string): boolean {
    return path.endsWith('.jsonl') && path.startsWith(this.projectsDir)
  }

  order(path: string): number {
    return path.includes(`${sep}subagents${sep}`) || path.includes('/subagents/') ? 1 : 0
  }

  async discover(sinceMs: number): Promise<string[]> {
    const out: string[] = []
    const recent = async (p: string) => {
      try {
        return (await stat(p)).mtimeMs >= sinceMs
      } catch {
        return false
      }
    }
    let projects: string[]
    try {
      projects = await readdir(this.projectsDir)
    } catch {
      return out
    }
    for (const project of projects) {
      const dir = join(this.projectsDir, project)
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        const p = join(dir, e.name)
        if (e.isFile() && e.name.endsWith('.jsonl')) {
          if (await recent(p)) out.push(p)
        } else if (e.isDirectory()) {
          const subDir = join(p, 'subagents')
          let subs: string[] = []
          try {
            subs = await readdir(subDir)
          } catch {
            continue
          }
          for (const s of subs) {
            if (s.endsWith('.jsonl')) {
              const sp = join(subDir, s)
              if (await recent(sp)) out.push(sp)
            }
          }
        }
      }
    }
    return out
  }

  createParser(path: string, emit: Emit): LineParser {
    return new ClaudeTranscriptParser(path, emit, { maxText: this.opts.maxText })
  }
}

interface SubagentMeta {
  agentType?: string
  description?: string
  toolUseId?: string
}

function readSubagentMeta(transcriptPath: string): SubagentMeta | undefined {
  try {
    const raw = readFileSync(transcriptPath.replace(/\.jsonl$/, '.meta.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? (parsed as SubagentMeta) : undefined
  } catch {
    return undefined
  }
}

/** Parses one Claude Code transcript (main or subagent). */
export class ClaudeTranscriptParser implements LineParser {
  sessionId: string | undefined
  private agentId: string | undefined
  private readonly isSubagentFile: boolean
  private readonly fileAgentId: string | undefined
  private started = false
  private spawned = false
  private cwd: string | undefined
  private gitBranch: string | undefined
  private titled = false
  private seenTools = new Set<string>()
  private seenRecords = new Set<string>()
  private metaCache = new Map<string, unknown>()
  private lastTs: number | undefined
  /** Set on inline (progress-record) subagents: the Agent call that spawned them. */
  private inlineParent: string | undefined
  private openTools = new Map<string, string>() // callId → tool name
  private usageByMessage = new Map<string, Usage>()
  private lastModel: string | undefined
  private inline = new Map<string, ClaudeTranscriptParser>()
  private readonly maxText: number

  constructor(
    readonly path: string,
    private emit: Emit,
    opts: { maxText?: number; sessionId?: string; agentId?: string } = {},
  ) {
    this.maxText = opts.maxText ?? 4000
    const sub = SUBAGENT_FILE.exec(path)
    this.isSubagentFile = !!sub && /[\\/]subagents[\\/]/.test(path)
    if (opts.sessionId) {
      this.sessionId = opts.sessionId
      this.agentId = opts.agentId
      this.fileAgentId = opts.agentId
    } else if (this.isSubagentFile) {
      // <session>/subagents/agent-<id>.jsonl
      const parts = path.split(/[\\/]/)
      this.sessionId = parts[parts.length - 3]
      this.fileAgentId = sub![1]
      this.agentId = this.fileAgentId
    } else {
      this.sessionId = basename(path).replace(/\.jsonl$/, '')
      this.agentId = this.sessionId
    }
  }

  markPartial(): void {
    if (!this.sessionId) return
    this.send(Date.now(), { kind: 'session.updated', meta: { partialHistory: true } }, this.sessionId)
  }

  line(raw: string): void {
    let rec: unknown
    try {
      rec = JSON.parse(raw)
    } catch {
      return
    }
    if (!isRecord(rec)) return
    this.record(rec)
  }

  private send(ts: number, body: DistributiveBody, agentId = this.agentId): void {
    if (!this.sessionId || !agentId) return
    this.emit({ ts, harness: HARNESS, sessionId: this.sessionId, agentId, ...body } as EventDraft)
  }

  private record(r: Record<string, unknown>): void {
    const type = r.type
    // Metadata records carry no timestamp; inherit the transcript's clock instead of "now".
    const dated = r.timestamp !== undefined
    const ts = dated ? toMs(r.timestamp) : this.lastTs ?? Date.now()
    if (dated && ts > (this.lastTs ?? 0)) this.lastTs = ts
    if (typeof r.sessionId === 'string' && !this.sessionId) this.sessionId = r.sessionId

    // Metadata records (no message body).
    switch (type) {
      case 'custom-title':
        if (str(r.customTitle)) this.sendSession(ts, { title: clip(r.customTitle as string, 120), titleSource: 'custom' })
        return
      case 'summary':
        if (str(r.summary)) this.sendSession(ts, { title: clip(r.summary as string, 120), titleSource: 'harness' })
        return
      case 'agent-name':
        if (str(r.agentName)) this.sendSession(ts, { title: clip(r.agentName as string, 120), titleSource: 'harness' })
        return
      case 'cost-state':
        this.sendSession(ts, {
          costUsd: typeof r.totalCostUSD === 'number' ? r.totalCostUSD : undefined,
          linesAdded: typeof r.totalLinesAdded === 'number' ? r.totalLinesAdded : undefined,
          linesRemoved: typeof r.totalLinesRemoved === 'number' ? r.totalLinesRemoved : undefined,
        })
        return
      case 'pr-link':
        if (str(r.prUrl)) this.sendSession(ts, { prUrl: r.prUrl as string })
        return
      case 'mode':
        if (str(r.mode)) this.sendSession(ts, { permissionMode: r.mode as string })
        return
      case 'progress':
        this.progress(r)
        return
      case 'system':
        this.ensureStarted(r, ts)
        if (r.subtype === 'compact_boundary') this.send(ts, { kind: 'note', level: 'info', text: 'Context compacted' })
        return
      case 'user':
      case 'assistant':
        break
      default:
        return
    }

    // Replays after compaction/resume repeat records; uuids make them idempotent.
    const uuid = str(r.uuid)
    if (uuid) {
      if (this.seenRecords.has(uuid)) return
      this.seenRecords.add(uuid)
      if (this.seenRecords.size > 20000) this.seenRecords = new Set([...this.seenRecords].slice(-10000))
    }

    this.ensureStarted(r, ts)
    const msg = r.message
    if (!isRecord(msg)) return
    if (type === 'assistant') this.assistant(r, msg, ts)
    else this.user(r, msg, ts)
  }

  /** Only the main transcript owns session-level metadata. */
  private get isMain(): boolean {
    return !this.isSubagentFile && this.agentId === this.sessionId
  }

  /** Claude rewrites title/cost records every turn; only forward values that changed. */
  private sendSession(ts: number, meta: Record<string, unknown>): void {
    if (!this.isMain) return
    const changed: Record<string, unknown> = {}
    let any = false
    for (const [k, v] of Object.entries(meta)) {
      if (v === undefined || k === 'titleSource') continue
      const key = k === 'title' ? `title:${meta.titleSource}` : k
      if (this.metaCache.get(key) === v) continue
      this.metaCache.set(key, v)
      changed[k] = v
      any = true
    }
    if (!any) return
    if ('title' in changed) changed.titleSource = meta.titleSource
    this.send(ts, { kind: 'session.updated', meta: changed }, this.sessionId)
  }


  private ensureStarted(r: Record<string, unknown>, ts: number): void {
    if (r.timestamp === undefined) return
    const cwd = str(r.cwd)
    const branch = str(r.gitBranch)
    if (!this.isMain) {
      if (!this.spawned) {
        this.spawned = true
        const meta = this.isSubagentFile ? readSubagentMeta(this.path) : undefined
        this.send(ts, {
          kind: 'agent.spawned',
          parentToolCallId: meta?.toolUseId ?? this.inlineParent,
          name: meta?.description ? clip(meta.description, 60) : meta?.agentType ?? 'subagent',
          role: meta?.agentType,
          task: meta?.description,
        })
      }
      if (cwd) this.cwd = cwd
      return
    }
    if (!this.started && (cwd || r.type === 'user' || r.type === 'assistant')) {
      this.started = true
      this.cwd = cwd
      this.gitBranch = branch
      this.send(ts, {
        kind: 'session.started',
        meta: {
          cwd,
          project: cwd ? basename(cwd) : undefined,
          gitBranch: branch && branch !== 'HEAD' ? branch : undefined,
          harnessVersion: str(r.version),
          entrypoint: str(r.entrypoint),
          transcriptPath: this.path,
        },
      }, this.sessionId)
      return
    }
    if (this.started && ((cwd && cwd !== this.cwd) || (branch && branch !== this.gitBranch && branch !== 'HEAD'))) {
      this.cwd = cwd ?? this.cwd
      this.gitBranch = branch ?? this.gitBranch
      this.send(ts, { kind: 'session.updated', meta: { cwd: this.cwd, project: this.cwd ? basename(this.cwd) : undefined, gitBranch: this.gitBranch } }, this.sessionId)
    }
  }

  /** Older Claude Code versions stream subagent activity inline as `progress` records. */
  private progress(r: Record<string, unknown>): void {
    const data = r.data
    const parent = str(r.parentToolUseID)
    if (!isRecord(data) || data.type !== 'agent_progress' || !parent || !isRecord(data.message)) return
    let child = this.inline.get(parent)
    if (!child) {
      child = new ClaudeTranscriptParser(this.path, this.emit, { maxText: this.maxText, sessionId: this.sessionId, agentId: `inline-${parent}` })
      child.inlineParent = parent
      this.inline.set(parent, child)
    }
    const inner = { ...data.message, timestamp: (data.message as Record<string, unknown>).timestamp ?? r.timestamp }
    child.record(inner)
  }

  private assistant(r: Record<string, unknown>, msg: Record<string, unknown>, ts: number): void {
    const content = Array.isArray(msg.content) ? msg.content : []
    const model = str(msg.model)
    let sawToolUse = false

    for (const block of content) {
      if (!isRecord(block)) continue
      if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        const text = str(block.thinking)
        this.send(ts, { kind: 'thinking', text: text ? clip(text, this.maxText) : undefined, durationMs: typeof r.thinkingDurationMs === 'number' ? r.thinkingDurationMs : undefined })
      } else if (block.type === 'text') {
        const text = str(block.text)?.trim()
        if (text) this.send(ts, { kind: 'message', role: 'assistant', text: clip(text, this.maxText) })
      } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
        sawToolUse = true
        const id = str(block.id)
        const name = str(block.name) ?? 'tool'
        if (!id || this.seenTools.has(id)) continue
        this.seenTools.add(id)
        if (this.seenTools.size > 20000) this.seenTools = new Set([...this.seenTools].slice(-10000))
        const input = isRecord(block.input) ? block.input : {}
        const d = describeClaudeTool(name, input, this.cwd)
        this.openTools.set(id, name)
        this.send(ts, {
          kind: 'tool.started',
          callId: id,
          tool: name,
          category: d.category,
          title: d.title,
          input: compactInput(input),
          files: d.files,
          changes: claudeChanges(name, input),
          mcpServer: d.mcpServer,
        })
        if (block.type === 'server_tool_use') {
          // Server-side tools (web search) resolve inside the same response.
          this.openTools.delete(id)
          this.send(ts, { kind: 'tool.finished', callId: id, ok: true })
        }
      }
    }

    // Usage: a streamed response is split across several records that share message.id.
    const usage = msg.usage
    const messageId = str(msg.id)
    if (isRecord(usage) && model !== '<synthetic>') {
      const current: Usage = {
        input: num(usage.input_tokens),
        output: num(usage.output_tokens),
        cacheRead: num(usage.cache_read_input_tokens),
        cacheWrite: num(usage.cache_creation_input_tokens),
        reasoning: isRecord(usage.output_tokens_details) ? num(usage.output_tokens_details.thinking_tokens) : 0,
      }
      const prev = (messageId && this.usageByMessage.get(messageId)) || emptyUsage()
      const delta: Usage = {
        input: Math.max(0, current.input - prev.input),
        output: Math.max(0, current.output - prev.output),
        cacheRead: Math.max(0, current.cacheRead - prev.cacheRead),
        cacheWrite: Math.max(0, current.cacheWrite - prev.cacheWrite),
        reasoning: Math.max(0, current.reasoning - prev.reasoning),
      }
      if (messageId) {
        this.usageByMessage.set(messageId, current)
        if (this.usageByMessage.size > 500) {
          const first = this.usageByMessage.keys().next().value
          if (first !== undefined) this.usageByMessage.delete(first)
        }
      }
      const changed = delta.input + delta.output + delta.cacheRead + delta.cacheWrite + delta.reasoning > 0
      if (changed || model !== this.lastModel) {
        this.send(ts, {
          kind: 'usage',
          delta,
          model,
          contextTokens: current.input + current.cacheRead + current.cacheWrite,
          contextWindow: model && /\[1m\]|-1m\b/i.test(model) ? 1_000_000 : undefined,
        })
      }
    }
    if (model && model !== '<synthetic>') this.lastModel = model

    if (msg.stop_reason === 'end_turn' && !sawToolUse) {
      this.send(ts, { kind: 'turn.ended', outcome: 'completed' })
    }
  }

  private user(r: Record<string, unknown>, msg: Record<string, unknown>, ts: number): void {
    const content = msg.content
    if (typeof content === 'string') {
      this.userText(r, content, ts)
      return
    }
    if (!Array.isArray(content)) return
    const toolResult = isRecord(r.toolUseResult) ? r.toolUseResult : undefined
    for (const block of content) {
      if (!isRecord(block)) continue
      if (block.type === 'tool_result') {
        const id = str(block.tool_use_id)
        if (!id) continue
        this.openTools.delete(id)
        const text = contentText(block.content)
        const interrupted = toolResult?.interrupted === true
        this.send(ts, {
          kind: 'tool.finished',
          callId: id,
          ok: block.is_error !== true && !interrupted,
          output: text ? clip(text, OUTPUT_MAX) : undefined,
          durationMs: typeof toolResult?.durationMs === 'number' ? (toolResult.durationMs as number) : undefined,
        })
      } else if (block.type === 'text' && typeof block.text === 'string') {
        this.userText(r, block.text, ts)
      }
    }
  }

  private userText(r: Record<string, unknown>, raw: string, ts: number): void {
    if (r.isMeta === true || r.isCompactSummary === true) return
    if (raw.startsWith(INTERRUPTED)) {
      for (const id of this.openTools.keys()) this.send(ts, { kind: 'tool.finished', callId: id, ok: false, output: 'interrupted' })
      this.openTools.clear()
      this.send(ts, { kind: 'turn.ended', outcome: 'aborted' })
      return
    }
    const text = humanText(raw)
    if (!text) return
    const isMain = this.isMain
    if (isMain) {
      this.send(ts, { kind: 'turn.started', turnId: str(r.promptId) ?? str(r.uuid) })
      if (!this.titled && !text.startsWith('/')) {
        this.titled = true
        this.sendSession(ts, { title: firstLine(text, 80), titleSource: 'prompt' })
      }
    }
    // A subagent's first "user" message is its task prompt — show it as the task.
    this.send(ts, { kind: 'message', role: isMain ? 'user' : 'agent', text: clip(text, this.maxText) })
  }
}

// EventDraft minus the routing fields every event shares.
type DistributiveBody = EventDraft extends infer T ? (T extends unknown ? Omit<T, 'ts' | 'harness' | 'sessionId' | 'agentId'> : never) : never
