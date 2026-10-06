/**
 * Codex rollouts: <codex home>/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread-id>.jsonl
 *
 * Every thread — including subagents spawned with `spawn_agent` — gets its own
 * rollout. A subagent's `session_meta.source.subagent.thread_spawn` names its
 * parent thread, and `session_meta.session_id` names the root session, so we can
 * rebuild the whole agent tree across files.
 *
 * Thread titles live in <codex home>/session_index.jsonl ({ id, thread_name }).
 */
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { emptyUsage, type EventDraft, type Usage } from '@oadt/protocol'
import { basename, clip, compactInput, contentText, firstLine, humanText, isRecord, num, str, toMs } from '../text.js'
import { codexOutputOk, describeCodexTool } from '../tools.js'
import type { Emit, LineParser, TranscriptAdapter } from './types.js'

const HARNESS = 'codex'
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

export interface CodexAdapterOptions {
  /** Defaults to $CODEX_HOME or ~/.codex */
  codexHome?: string
  maxText?: number
}

export class CodexAdapter implements TranscriptAdapter {
  readonly harness = HARNESS
  readonly home: string
  readonly sessionsDir: string
  private titles = new Map<string, string>()
  private indexSize = -1
  private emittedTitles = new Map<string, string>()
  /** thread id → root session id, learned from parsers. */
  readonly threadToSession = new Map<string, string>()

  constructor(private opts: CodexAdapterOptions = {}) {
    this.home = opts.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
    this.sessionsDir = join(this.home, 'sessions')
  }

  roots(): string[] {
    return [this.sessionsDir]
  }

  accepts(path: string): boolean {
    return path.endsWith('.jsonl') && path.startsWith(this.sessionsDir) && basename(path).startsWith('rollout-')
  }

  async discover(sinceMs: number): Promise<string[]> {
    // Rollouts are partitioned by date; only walk the days inside the window
    // (±1 day for timezone differences between local and UTC partitioning).
    const out: string[] = []
    const days = new Set<string>()
    for (let t = sinceMs - 86_400_000; t <= Date.now() + 86_400_000; t += 86_400_000) {
      const d = new Date(t)
      days.add(`${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`)
      days.add(`${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`)
    }
    for (const day of days) {
      const dir = join(this.sessionsDir, ...day.split('/'))
      let names: string[]
      try {
        names = await readdir(dir)
      } catch {
        continue
      }
      for (const name of names) {
        if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue
        const p = join(dir, name)
        try {
          if ((await stat(p)).mtimeMs >= sinceMs) out.push(p)
        } catch { /* vanished */ }
      }
    }
    return out
  }

  createParser(path: string, emit: Emit): LineParser {
    return new CodexRolloutParser(path, emit, { maxText: this.opts.maxText, onThread: (thread, session) => this.threadToSession.set(thread, session) })
  }

  /** Pick up thread names from the session index as they change. */
  async tick(emit: Emit, sessions: ReadonlySet<string>): Promise<void> {
    const indexPath = join(this.home, 'session_index.jsonl')
    let size: number
    try {
      size = (await stat(indexPath)).size
    } catch {
      return
    }
    if (size !== this.indexSize) {
      this.indexSize = size
      const text = await readTail(indexPath, 4 * 1024 * 1024)
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
          const r: unknown = JSON.parse(line)
          if (isRecord(r) && str(r.id) && str(r.thread_name)) this.titles.set(r.id as string, r.thread_name as string)
        } catch { /* partial line */ }
      }
    }
    for (const id of sessions) {
      const title = this.titles.get(id)
      if (title && this.emittedTitles.get(id) !== title) {
        this.emittedTitles.set(id, title)
        emit({ ts: Date.now(), harness: HARNESS, sessionId: id, agentId: id, kind: 'session.updated', meta: { title: clip(title, 120), titleSource: 'custom' } })
      }
    }
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

async function readTail(path: string, max: number): Promise<string> {
  const fh = await open(path, 'r')
  try {
    const { size } = await fh.stat()
    const start = Math.max(0, size - max)
    const buf = Buffer.alloc(size - start)
    await fh.read(buf, 0, buf.length, start)
    return buf.toString('utf8')
  } finally {
    await fh.close()
  }
}

/** Parses one Codex rollout (one thread). */
export class CodexRolloutParser implements LineParser {
  sessionId: string | undefined
  private threadId: string | undefined
  private cwd: string | undefined
  private model: string | undefined
  private metaSeen = false
  private isSubagent = false
  private titled = false
  private partial = false
  private totals: Usage | undefined
  private lastTs: number | undefined
  private openCalls = new Map<string, string>()
  private seenCalls = new Set<string>()
  private readonly maxText: number
  private readonly onThread?: (thread: string, session: string) => void

  constructor(
    readonly path: string,
    private emit: Emit,
    opts: { maxText?: number; onThread?: (thread: string, session: string) => void } = {},
  ) {
    this.maxText = opts.maxText ?? 4000
    this.onThread = opts.onThread
    // Fallback ids from the filename until session_meta arrives.
    const ids = basename(path).match(UUID)
    const fromName = ids?.[ids.length - 1]?.toLowerCase()
    this.threadId = fromName
    this.sessionId = fromName
  }

  markPartial(): void {
    this.partial = true
    if (this.metaSeen && !this.isSubagent) this.send(Date.now(), { kind: 'session.updated', meta: { partialHistory: true } })
  }

  line(raw: string): void {
    let rec: unknown
    try {
      rec = JSON.parse(raw)
    } catch {
      return
    }
    if (!isRecord(rec)) return
    const ts = toMs(rec.timestamp, this.lastTs ?? Date.now())
    if (rec.timestamp !== undefined) this.lastTs = ts
    const payload = isRecord(rec.payload) ? rec.payload : {}
    switch (rec.type) {
      case 'session_meta':
        return this.sessionMeta(payload, ts)
      case 'turn_context':
        return this.turnContext(payload, ts)
      case 'response_item':
        return this.responseItem(payload, ts)
      case 'event_msg':
        return this.eventMsg(payload, ts)
      case 'compacted':
        return this.send(ts, { kind: 'note', level: 'info', text: 'Context compacted' })
    }
  }

  private send(ts: number, body: Body): void {
    if (!this.sessionId || !this.threadId) return
    this.emit({ ts, harness: HARNESS, sessionId: this.sessionId, agentId: this.threadId, ...body } as EventDraft)
  }

  private sessionMeta(p: Record<string, unknown>, ts: number): void {
    if (this.metaSeen) return
    this.metaSeen = true
    const thread = str(p.id)?.toLowerCase()
    const root = (str(p.session_id) ?? thread)?.toLowerCase()
    if (thread) this.threadId = thread
    if (root) this.sessionId = root
    if (thread && root) this.onThread?.(thread, root)
    this.cwd = str(p.cwd)
    const git = isRecord(p.git) ? p.git : undefined
    const source = p.source
    const spawn = isRecord(source) && isRecord(source.subagent) && isRecord(source.subagent.thread_spawn) ? source.subagent.thread_spawn : undefined

    if (spawn || (thread && root && thread !== root)) {
      this.isSubagent = true
      const agentPath = str(spawn?.agent_path)
      this.send(ts, {
        kind: 'agent.spawned',
        parentAgentId: str(spawn?.parent_thread_id)?.toLowerCase() ?? root,
        name: str(spawn?.agent_nickname) ?? (agentPath ? basename(agentPath) : 'subagent'),
        role: str(spawn?.agent_role),
        task: agentPath,
      })
      return
    }
    this.send(ts, {
      kind: 'session.started',
      meta: {
        cwd: this.cwd,
        project: this.cwd ? basename(this.cwd) : undefined,
        gitBranch: str(git?.branch),
        harnessVersion: str(p.cli_version),
        entrypoint: str(p.originator) ?? (typeof source === 'string' ? source : undefined),
        transcriptPath: this.path,
        partialHistory: this.partial || undefined,
      },
    })
  }

  private turnContext(p: Record<string, unknown>, ts: number): void {
    const model = str(p.model)
    const cwd = str(p.cwd)
    if (cwd) this.cwd = cwd
    if (model && model !== this.model) {
      this.model = model
      if (!this.isSubagent) this.send(ts, { kind: 'session.updated', meta: { model } })
      this.send(ts, { kind: 'usage', delta: emptyUsage(), model })
    }
  }

  private responseItem(p: Record<string, unknown>, ts: number): void {
    switch (p.type) {
      case 'message': {
        const role = p.role
        const text = contentText(p.content).trim()
        if (!text) return
        if (role === 'assistant') {
          this.send(ts, { kind: 'message', role: 'assistant', text: clip(text, this.maxText) })
        } else if (role === 'user') {
          const human = humanText(text)
          if (!human) return
          if (!this.isSubagent && !this.titled) {
            this.titled = true
            this.send(ts, { kind: 'session.updated', meta: { title: firstLine(human, 80), titleSource: 'prompt' } })
          }
          this.send(ts, { kind: 'message', role: this.isSubagent ? 'agent' : 'user', text: clip(human, this.maxText) })
        }
        return
      }
      case 'agent_message': {
        const text = contentText(p.content).trim()
        if (text) this.send(ts, { kind: 'message', role: 'agent', text: clip(text, this.maxText), to: str(p.recipient) })
        return
      }
      case 'reasoning': {
        const summary = Array.isArray(p.summary) ? contentText(p.summary).trim() : ''
        this.send(ts, { kind: 'thinking', text: summary ? clip(summary, this.maxText) : undefined })
        return
      }
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call': {
        const callId = str(p.call_id) ?? str(p.id)
        if (!callId || this.seenCalls.has(callId)) return
        this.seenCalls.add(callId)
        let name = str(p.name) ?? (p.type === 'local_shell_call' ? 'local_shell' : 'tool')
        let args: Record<string, unknown> | undefined
        const rawInput = typeof p.input === 'string' ? p.input : undefined
        if (typeof p.arguments === 'string') {
          try {
            const parsed: unknown = JSON.parse(p.arguments)
            if (isRecord(parsed)) args = parsed
          } catch { /* free-form arguments */ }
        } else if (isRecord(p.action)) {
          args = { command: p.action.command }
          name = 'local_shell'
        }
        const d = describeCodexTool(name, args, rawInput, str(p.namespace), this.cwd)
        this.openCalls.set(callId, name)
        this.send(ts, {
          kind: 'tool.started',
          callId,
          tool: name,
          category: d.category,
          title: d.title,
          input: compactInput(args ?? rawInput),
          files: d.files,
          mcpServer: d.mcpServer,
        })
        return
      }
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'local_shell_call_output': {
        const callId = str(p.call_id)
        if (!callId || !this.openCalls.has(callId)) return
        this.openCalls.delete(callId)
        const text = outputText(p.output)
        this.send(ts, { kind: 'tool.finished', callId, ok: codexOutputOk(text), output: text ? clip(text, 2000) : undefined })
        return
      }
      case 'web_search_call': {
        const callId = str(p.id) ?? `ws-${ts}`
        if (this.seenCalls.has(callId)) return
        this.seenCalls.add(callId)
        const action = isRecord(p.action) ? p.action : {}
        const d = describeCodexTool('web_search', { query: action.query ?? action.url }, undefined, undefined, this.cwd)
        this.send(ts, { kind: 'tool.started', callId, tool: 'web_search', category: d.category, title: d.title, files: [] })
        this.send(ts, { kind: 'tool.finished', callId, ok: p.status !== 'failed' })
        return
      }
    }
  }

  private eventMsg(p: Record<string, unknown>, ts: number): void {
    switch (p.type) {
      case 'task_started':
        this.send(ts, { kind: 'turn.started', turnId: str(p.turn_id) })
        return
      case 'task_complete':
        this.closeOpen(ts, true)
        this.send(ts, { kind: 'turn.ended', turnId: str(p.turn_id), outcome: 'completed', durationMs: typeof p.duration_ms === 'number' ? p.duration_ms : undefined })
        return
      case 'turn_aborted':
        this.closeOpen(ts, false)
        this.send(ts, { kind: 'turn.ended', turnId: str(p.turn_id), outcome: 'aborted', durationMs: typeof p.duration_ms === 'number' ? p.duration_ms : undefined })
        return
      case 'token_count': {
        const info = isRecord(p.info) ? p.info : undefined
        const total = info && isRecord(info.total_token_usage) ? info.total_token_usage : undefined
        if (!total) return
        const cached = num(total.cached_input_tokens)
        const current: Usage = {
          input: Math.max(0, num(total.input_tokens) - cached),
          cacheRead: cached,
          cacheWrite: num(total.cache_write_input_tokens),
          output: num(total.output_tokens),
          reasoning: num(total.reasoning_output_tokens),
        }
        const prev = this.totals ?? emptyUsage()
        this.totals = current
        const delta: Usage = {
          input: Math.max(0, current.input - prev.input),
          cacheRead: Math.max(0, current.cacheRead - prev.cacheRead),
          cacheWrite: Math.max(0, current.cacheWrite - prev.cacheWrite),
          output: Math.max(0, current.output - prev.output),
          reasoning: Math.max(0, current.reasoning - prev.reasoning),
        }
        const last = info && isRecord(info.last_token_usage) ? info.last_token_usage : undefined
        this.send(ts, {
          kind: 'usage',
          delta,
          model: this.model,
          contextTokens: last ? num(last.input_tokens) : undefined,
          contextWindow: typeof info?.model_context_window === 'number' ? info.model_context_window : undefined,
        })
        return
      }
      case 'thread_goal_updated': {
        const goal = isRecord(p.goal) ? p.goal : undefined
        if (goal && !this.isSubagent) this.send(ts, { kind: 'session.updated', meta: { goal: str(goal.objective) ? clip(goal.objective as string, 400) : undefined, goalStatus: str(goal.status) } })
        return
      }
      case 'thread_name_updated': {
        const name = str(p.thread_name) ?? str(p.name)
        if (name && !this.isSubagent) this.send(ts, { kind: 'session.updated', meta: { title: clip(name, 120), titleSource: 'custom' } })
        return
      }
      case 'error':
        this.send(ts, { kind: 'note', level: 'warn', text: clip(str(p.message) ?? 'error', 300) })
        return
    }
  }

  private closeOpen(ts: number, ok: boolean): void {
    for (const id of this.openCalls.keys()) this.send(ts, { kind: 'tool.finished', callId: id, ok, output: ok ? undefined : 'interrupted' })
    this.openCalls.clear()
  }
}

function outputText(out: unknown): string {
  if (typeof out === 'string') {
    try {
      const parsed: unknown = JSON.parse(out)
      if (isRecord(parsed) && typeof parsed.output === 'string') {
        const code = isRecord(parsed.metadata) ? parsed.metadata.exit_code : undefined
        return typeof code === 'number' ? `${parsed.output}\n"exit_code": ${code}` : parsed.output
      }
    } catch { /* plain text */ }
    return out
  }
  if (isRecord(out) && typeof out.output === 'string') return out.output
  return contentText(out)
}

type Body = EventDraft extends infer T ? (T extends unknown ? Omit<T, 'ts' | 'harness' | 'sessionId' | 'agentId'> : never) : never
