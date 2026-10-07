/**
 * Turn the edit payloads harnesses record into normalised unified-diff lines:
 * Claude Code's Edit / MultiEdit / Write inputs and Codex's apply_patch bodies.
 */
import type { FileChange } from '@oadt/protocol'

/** Lines kept per change; the rest are dropped and the change is flagged truncated. */
const MAX_LINES = 400
/** Characters kept per line. */
const MAX_LINE_CHARS = 400
/** Context lines shown around each changed region. */
const CONTEXT = 3
/** Above this many cells, skip the LCS and show a plain replace. */
const MAX_LCS_CELLS = 250_000

type Op = ' ' | '-' | '+'

/** Line-level diff via LCS. Small inputs only (edit strings, not whole repos). */
export function lineDiff(before: string[], after: string[]): Array<[Op, string]> {
  // Trim common prefix and suffix first; most edits touch a small region.
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let endA = before.length, endB = after.length
  while (endA > start && endB > start && before[endA - 1] === after[endB - 1]) { endA--; endB-- }
  const a = before.slice(start, endA)
  const b = after.slice(start, endB)
  const middle: Array<[Op, string]> = []
  if (a.length * b.length > MAX_LCS_CELLS) {
    for (const l of a) middle.push(['-', l])
    for (const l of b) middle.push(['+', l])
  } else {
    const n = a.length, m = b.length
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
    let i = 0, j = 0
    while (i < n && j < m) {
      if (a[i] === b[j]) { middle.push([' ', a[i]!]); i++; j++ }
      else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { middle.push(['-', a[i]!]); i++ }
      else { middle.push(['+', b[j]!]); j++ }
    }
    while (i < n) middle.push(['-', a[i++]!])
    while (j < m) middle.push(['+', b[j++]!])
  }
  return [
    ...before.slice(0, start).map((l): [Op, string] => [' ', l]),
    ...middle,
    ...before.slice(endA).map((l): [Op, string] => [' ', l]),
  ]
}

/** Keep `CONTEXT` lines around changes; replace longer unchanged runs with a gap marker. */
function withContext(ops: Array<[Op, string]>): string[] {
  const keep = new Array<boolean>(ops.length).fill(false)
  ops.forEach(([op], i) => {
    if (op === ' ') return
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(ops.length - 1, i + CONTEXT); k++) keep[k] = true
  })
  const out: string[] = []
  let gap = false
  ops.forEach(([op, text], i) => {
    if (keep[i]) {
      if (gap && out.length) out.push('@')
      gap = false
      out.push(op + text)
    } else gap = true
  })
  return out
}

function finish(path: string, op: FileChange['op'], lines: string[]): FileChange {
  let added = 0, removed = 0
  for (const l of lines) {
    if (l[0] === '+') added++
    else if (l[0] === '-') removed++
  }
  const truncated = lines.length > MAX_LINES
  const kept = lines.slice(0, MAX_LINES).map((l) => (l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS - 1) + '…' : l))
  return { path, op, added, removed, lines: kept, ...(truncated ? { truncated } : {}) }
}

const split = (s: string) => (s === '' ? [] : s.replace(/\r\n/g, '\n').split('\n'))

/** Claude Code: Edit, MultiEdit, Write, NotebookEdit. */
export function claudeChanges(tool: string, input: Record<string, unknown>): FileChange[] | undefined {
  const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined
  if (!path) return undefined
  if (tool === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    return [finish(path, 'edit', withContext(lineDiff(split(input.old_string), split(input.new_string))))]
  }
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    const lines: string[] = []
    for (const e of input.edits as Array<Record<string, unknown>>) {
      if (typeof e?.old_string !== 'string' || typeof e?.new_string !== 'string') continue
      if (lines.length) lines.push('@')
      lines.push(...withContext(lineDiff(split(e.old_string), split(e.new_string))))
    }
    return lines.length ? [finish(path, 'edit', lines)] : undefined
  }
  if (tool === 'Write' && typeof input.content === 'string') {
    return [finish(path, 'write', split(input.content).map((l) => '+' + l))]
  }
  if (tool === 'NotebookEdit' && typeof input.new_source === 'string') {
    return [finish(path, 'edit', split(input.new_source).map((l) => '+' + l))]
  }
  return undefined
}

/**
 * Codex: an apply_patch body, either given directly or embedded in an `exec`
 * script (as a template literal or an escaped string).
 */
export function patchChanges(text: string): FileChange[] | undefined {
  const begin = text.indexOf('*** Begin Patch')
  if (begin < 0) return undefined
  const endIdx = text.indexOf('*** End Patch', begin)
  let body = text.slice(begin, endIdx < 0 ? undefined : endIdx)
  // Embedded in a quoted JS string: real newlines are escaped.
  if (!body.includes('\n') && body.includes('\\n')) body = body.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\(["'`\\])/g, '$1')
  const changes: FileChange[] = []
  let current: { path: string; op: FileChange['op']; lines: string[] } | undefined
  const flush = () => { if (current) changes.push(finish(current.path, current.op, current.lines)) }
  for (const raw of body.split(/\r?\n/)) {
    const header = /^\*\*\* (Update|Add|Delete) File:\s*(.+?)\s*$/.exec(raw)
    if (header) {
      flush()
      current = { path: header[2]!, op: header[1] === 'Add' ? 'write' : header[1] === 'Delete' ? 'delete' : 'edit', lines: [] }
      continue
    }
    if (!current || raw.startsWith('***')) continue
    if (raw.startsWith('@@')) { if (current.lines.length) current.lines.push('@'); continue }
    const c = raw[0]
    if (c === '+' || c === '-' || c === ' ') current.lines.push(raw)
    else if (raw === '') current.lines.push(' ')
  }
  flush()
  return changes.length ? changes : undefined
}
