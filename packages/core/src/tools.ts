/**
 * Turn raw harness tool calls into harness-agnostic descriptions:
 * a category, a one-line title, and the files they touch.
 */
import type { FileOp, FileRef, ToolCategory } from '@oadt/protocol'
import { basename, clip, firstLine, isRecord, relPath, str } from './text.js'

export interface ToolDescription {
  category: ToolCategory
  title: string
  files: FileRef[]
  mcpServer?: string
}

function file(path: unknown, op: FileOp): FileRef[] {
  return typeof path === 'string' && path ? [{ path, op }] : []
}

function urlLabel(raw: string): string {
  try {
    const u = new URL(raw)
    return clip(u.hostname + (u.pathname === '/' ? '' : u.pathname), 70)
  } catch {
    return clip(raw, 70)
  }
}

function planProgress(items: unknown, label: string): string {
  if (!Array.isArray(items) || items.length === 0) return label
  const done = items.filter((i) => isRecord(i) && i.status === 'completed').length
  const active = items.find((i) => isRecord(i) && i.status === 'in_progress') as Record<string, unknown> | undefined
  const what = str(active?.activeForm) ?? str(active?.content) ?? str(active?.step)
  return `${label} ${done}/${items.length}${what ? ` · ${clip(what, 60)}` : ''}`
}

/** Parse `*** Update File: x` style markers out of an apply_patch body. */
export function patchFiles(patch: string): FileRef[] {
  const out: FileRef[] = []
  const re = /^\*\*\* (Update|Add|Delete) File:\s*(.+?)\s*$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(patch))) {
    const op: FileOp = m[1] === 'Add' ? 'write' : m[1] === 'Delete' ? 'delete' : 'edit'
    out.push({ path: m[2]!, op })
  }
  return out
}

function patchTitle(files: FileRef[], cwd?: string): string {
  if (files.length === 0) return 'Apply patch'
  const first = relPath(files[0]!.path, cwd)
  return files.length === 1 ? `Patch ${first}` : `Patch ${first} +${files.length - 1}`
}

// ─── Claude Code ──────────────────────────────────────────────────────────

export function describeClaudeTool(name: string, input: Record<string, unknown>, cwd?: string): ToolDescription {
  const rel = (p: unknown) => (typeof p === 'string' ? relPath(p, cwd) : '')
  switch (name) {
    case 'Read':
      return { category: 'read', title: `Read ${rel(input.file_path)}`, files: file(input.file_path, 'read') }
    case 'Write':
      return { category: 'write', title: `Write ${rel(input.file_path)}`, files: file(input.file_path, 'write') }
    case 'Edit':
    case 'MultiEdit':
      return { category: 'edit', title: `Edit ${rel(input.file_path)}`, files: file(input.file_path, 'edit') }
    case 'NotebookEdit':
      return { category: 'edit', title: `Edit ${rel(input.notebook_path)}`, files: file(input.notebook_path, 'edit') }
    case 'Glob':
      return { category: 'search', title: `Glob ${clip(String(input.pattern ?? ''), 80)}${input.path ? ` in ${rel(input.path)}` : ''}`, files: [] }
    case 'Grep':
      return {
        category: 'search',
        title: `Grep "${clip(String(input.pattern ?? ''), 60)}"${input.path ? ` in ${rel(input.path)}` : ''}`,
        files: typeof input.path === 'string' && /\.[a-z0-9]+$/i.test(input.path) ? file(input.path, 'search') : [],
      }
    case 'Bash':
    case 'PowerShell':
      return { category: 'shell', title: `$ ${firstLine(String(input.command ?? ''), 100)}`, files: [] }
    case 'BashOutput':
    case 'KillShell':
    case 'KillBash':
    case 'Monitor':
      return { category: 'shell', title: name, files: [] }
    case 'WebFetch':
      return { category: 'web', title: `Fetch ${urlLabel(String(input.url ?? ''))}`, files: [] }
    case 'WebSearch':
      return { category: 'web', title: `Search "${clip(String(input.query ?? ''), 70)}"`, files: [] }
    case 'Agent':
    case 'Task': {
      const type = str(input.subagent_type) ?? 'agent'
      return { category: 'agent', title: `${type}: ${clip(String(input.description ?? input.prompt ?? ''), 70)}`, files: [] }
    }
    case 'SendMessage':
      return { category: 'agent', title: `Message ${str(input.to) ?? 'agent'}`, files: [] }
    case 'TodoWrite':
      return { category: 'plan', title: planProgress(input.todos, 'Todos'), files: [] }
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet':
    case 'EnterPlanMode':
    case 'ExitPlanMode':
      return { category: 'plan', title: name.replace(/([a-z])([A-Z])/g, '$1 $2'), files: [] }
    case 'AskUserQuestion': {
      const q = Array.isArray(input.questions) && isRecord(input.questions[0]) ? str(input.questions[0].question) : undefined
      return { category: 'interact', title: `Ask: ${clip(q ?? 'question', 80)}`, files: [] }
    }
    case 'Skill':
      return { category: 'other', title: `Skill ${String(input.skill ?? '')}`, files: [] }
    case 'ToolSearch':
      return { category: 'other', title: `Load tools ${clip(String(input.query ?? ''), 60)}`, files: [] }
  }
  if (name.startsWith('mcp__')) return describeMcp(name, input)
  return { category: 'other', title: name, files: [] }
}

function describeMcp(name: string, input: Record<string, unknown>): ToolDescription {
  // mcp__<server>__<tool>; server names may themselves contain single underscores.
  const rest = name.slice(5)
  const i = rest.indexOf('__')
  const server = i >= 0 ? rest.slice(0, i) : rest
  const tool = i >= 0 ? rest.slice(i + 2) : rest
  const hint = str(input.url) ?? str(input.query) ?? str(input.path) ?? str(input.file_path) ?? str(input.text) ?? str(input.action)
  const shortServer = server.length > 24 && /^[0-9a-f-]{20,}$/i.test(server) ? 'mcp' : server
  return {
    category: 'mcp',
    title: `${shortServer} · ${tool}${hint ? ` ${clip(hint, 50)}` : ''}`,
    files: file(input.file_path ?? input.path, 'read').filter((f) => /[\\/]/.test(f.path)),
    mcpServer: server,
  }
}

// ─── Codex ────────────────────────────────────────────────────────────────

/** `['bash','-lc','npm test']` → `npm test`. */
export function shellArgv(cmd: unknown): string {
  if (typeof cmd === 'string') return cmd
  if (!Array.isArray(cmd)) return ''
  const parts = cmd.map(String)
  const flagIdx = parts.findIndex((p) => p === '-lc' || p === '-c' || p === '-Command' || p === '/c')
  if (flagIdx >= 0 && parts[flagIdx + 1]) return parts.slice(flagIdx + 1).join(' ')
  return parts.join(' ')
}

const JS_STRING = /\b(?:cmd|command)\s*:\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/

function unescapeJs(s: string): string {
  return s.replace(/\\(["'`\\])/g, '$1').replace(/\\n/g, '\n').replace(/\\t/g, '\t')
}

/** Codex's `exec` custom tool runs a JS snippet that calls `tools.*`. Summarise what it does. */
export function describeCodexExec(code: string, cwd?: string): ToolDescription {
  const calls: string[] = []
  const re = /\btools\.([A-Za-z_][\w]*)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) calls.push(m[1]!)
  const files = patchFiles(code)
  const imgs = [...code.matchAll(/view_image\s*\(\s*\{\s*path\s*:\s*(["'`])((?:\\.|(?!\1).)*)\1/g)].map((x) => x[2]!)
  for (const p of imgs) files.push({ path: unescapeJs(p), op: 'read' })

  const cmd = JS_STRING.exec(code)
  const uniq = [...new Set(calls)]
  let category: ToolCategory = 'other'
  if (uniq.includes('apply_patch')) category = 'edit'
  else if (uniq.some((c) => c === 'exec_command' || c === 'write_stdin' || c === 'shell')) category = 'shell'
  else if (uniq.some((c) => c.includes('agent') || c === 'send_message' || c === 'followup_task')) category = 'agent'
  else if (uniq.some((c) => c.includes('search') || c.includes('fetch'))) category = 'web'
  else if (uniq.includes('view_image')) category = 'read'
  else if (uniq.includes('update_plan')) category = 'plan'

  let title: string
  if (category === 'edit') title = patchTitle(files, cwd)
  else if (cmd) {
    const shellCalls = calls.filter((c) => c === 'exec_command' || c === 'shell').length
    title = `$ ${firstLine(unescapeJs(cmd[2]!), 100)}${shellCalls > 1 ? `  (+${shellCalls - 1} more)` : ''}`
  } else if (uniq.length) title = `exec · ${uniq.slice(0, 3).join(', ')}${uniq.length > 3 ? '…' : ''}`
  else title = `exec · ${firstLine(code, 80)}`
  return { category, title, files }
}

const CODEX_AGENT_TOOLS = new Set([
  'spawn_agent', 'wait_agent', 'wait', 'list_agents', 'send_message', 'send_input', 'followup_task',
  'close_agent', 'resume_agent', 'interrupt_agent',
])

export function describeCodexTool(
  name: string,
  args: Record<string, unknown> | undefined,
  rawInput: string | undefined,
  namespace: string | undefined,
  cwd?: string,
): ToolDescription {
  const a = args ?? {}
  if (name === 'exec' && rawInput) return describeCodexExec(rawInput, cwd)
  switch (name) {
    case 'shell':
    case 'shell_command':
    case 'exec_command':
    case 'local_shell':
    case 'container.exec':
      return { category: 'shell', title: `$ ${firstLine(shellArgv(a.command ?? a.cmd), 100)}`, files: [] }
    case 'write_stdin':
      return { category: 'shell', title: `stdin → ${String(a.session_id ?? 'process')}`, files: [] }
    case 'apply_patch': {
      const body = rawInput ?? str(a.input) ?? str(a.patch) ?? ''
      const files = patchFiles(body)
      return { category: 'edit', title: patchTitle(files, cwd), files }
    }
    case 'update_plan':
      return { category: 'plan', title: planProgress(a.plan, 'Plan'), files: [] }
    case 'view_image':
      return { category: 'read', title: `View ${relPath(String(a.path ?? ''), cwd)}`, files: file(a.path, 'read') }
    case 'read_file':
      return { category: 'read', title: `Read ${relPath(String(a.path ?? a.file_path ?? ''), cwd)}`, files: file(a.path ?? a.file_path, 'read') }
    case 'list_dir':
      return { category: 'search', title: `List ${relPath(String(a.path ?? a.dir_path ?? '.'), cwd)}`, files: [] }
    case 'grep_files':
      return { category: 'search', title: `Grep "${clip(String(a.pattern ?? ''), 60)}"`, files: [] }
    case 'web_search':
    case 'web_search_call':
      return { category: 'web', title: `Search "${clip(String(a.query ?? ''), 70)}"`, files: [] }
    case 'request_user_input':
    case 'request_user_input_async':
      return { category: 'interact', title: 'Ask user', files: [] }
  }
  if (CODEX_AGENT_TOOLS.has(name)) {
    const target = str(a.task_name) ?? str(a.agent_type) ?? str(a.target) ?? str(a.agent_id) ?? str(a.id)
    const verb = name.replace(/_/g, ' ')
    return { category: 'agent', title: target ? `${verb} · ${clip(target, 50)}` : verb, files: [] }
  }
  if (name.startsWith('mcp__')) return describeMcp(name, a)
  if (namespace && namespace !== 'functions' && !namespace.startsWith('multi_agent')) {
    return { category: 'mcp', title: `${basename(namespace)} · ${name}`, files: [], mcpServer: namespace }
  }
  return { category: 'other', title: name, files: [] }
}

/** Best-effort success detection for Codex tool output text. */
export function codexOutputOk(text: string): boolean {
  const t = text.trimStart()
  if (/^(script failed|aborted by user|error|failed|fatal)\b/i.test(t)) return false
  const codes = [...t.matchAll(/(?:exit code:?|"exit_code"\s*:|exited with code)\s*(-?\d+)/gi)].map((m) => Number(m[1]))
  if (codes.length) return codes.every((c) => c === 0)
  return true
}
