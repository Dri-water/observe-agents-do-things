import type { Harness, ToolCategory } from '@oadt/protocol'

export const CATEGORY: Record<ToolCategory, { color: string; label: string; glyph: string }> = {
  read: { color: '#5aa9ff', label: 'Read', glyph: '◉' },
  search: { color: '#8f7dff', label: 'Search', glyph: '⌕' },
  edit: { color: '#ffb547', label: 'Edit', glyph: '✎' },
  write: { color: '#4fe39b', label: 'Write', glyph: '✚' },
  shell: { color: '#ff6f91', label: 'Shell', glyph: '❯' },
  web: { color: '#36d6e7', label: 'Web', glyph: '◍' },
  agent: { color: '#ffd166', label: 'Agent', glyph: '✦' },
  plan: { color: '#b8c4d6', label: 'Plan', glyph: '☰' },
  mcp: { color: '#e083ff', label: 'MCP', glyph: '⬡' },
  interact: { color: '#ffffff', label: 'Ask', glyph: '?' },
  other: { color: '#7b8798', label: 'Other', glyph: '•' },
}

export function categoryColor(c: ToolCategory | string): string {
  return CATEGORY[c as ToolCategory]?.color ?? CATEGORY.other.color
}

export const HARNESS: Record<string, { color: string; label: string; short: string }> = {
  'claude-code': { color: '#ff8a4c', label: 'Claude Code', short: 'Claude' },
  codex: { color: '#3ee0c5', label: 'Codex', short: 'Codex' },
}

export function harnessInfo(h: Harness): { color: string; label: string; short: string } {
  return HARNESS[h] ?? { color: '#a0aec0', label: h, short: h }
}

export const STATUS_COLOR = {
  working: '#4fe39b',
  waiting: '#ffb547',
  idle: '#6b7789',
  done: '#4a5566',
  ended: '#4a5566',
} as const

export const FILE_OP_COLOR = {
  read: '#5aa9ff',
  search: '#8f7dff',
  edit: '#ffb547',
  write: '#4fe39b',
  delete: '#ff5d73',
} as const

/** Hex → rgba with alpha. */
export function alpha(hex: string, a: number): string {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}
