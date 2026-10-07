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


export const HARNESS: Record<string, { color: string; label: string; short: string }> = {
  'claude-code': { color: '#ff8a4c', label: 'Claude Code', short: 'Claude' },
  codex: { color: '#3ee0c5', label: 'Codex', short: 'Codex' },
}

export function harnessInfo(h: Harness): { color: string; label: string; short: string } {
  return HARNESS[h] ?? { color: '#a0aec0', label: h, short: h }
}

