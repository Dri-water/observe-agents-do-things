/** DOM panels: session list, live feed, inspector, files. */
import {
  agentTree,
  categoryBreakdown,
  contextFill,
  formatAgo,
  formatCount,
  formatDuration,
  hotFiles,
  isLive,
  openTools,
  sessionList,
  shortPath,
  totalTokens,
  type AgentNode,
  type ObserverEvent,
  type SessionState,
  type WorldState,
} from '@oadt/protocol'
import { h } from '../../shared/dom'
import { CATEGORY, categoryColor, FILE_OP_COLOR, harnessInfo, STATUS_COLOR } from '../../shared/theme'

export type Selection =
  | { type: 'session'; sessionId: string }
  | { type: 'agent'; sessionId: string; id: string }
  | { type: 'tool'; sessionId: string; id: string }
  | { type: 'file'; sessionId: string; id: string }

export interface PanelCallbacks {
  selectView: (view: string) => void
  select: (sel: Selection) => void
}

// ─── Session list ───────────────────────────────────────────────────────

export function renderSessions(
  el: HTMLElement,
  world: WorldState,
  view: string,
  activity: Map<string, number[]>,
  filter: { text: string; showIdle: boolean },
  cb: PanelCallbacks,
): void {
  const now = Date.now()
  const all = sessionList(world)
  const live = all.filter(isLive)
  const text = filter.text.trim().toLowerCase()
  const list = all.filter((s) => {
    if (!filter.showIdle && !isLive(s) && now - s.lastActivityAt > 60 * 60_000 && s.id !== view) return false
    if (!text) return true
    return [s.meta.title, s.meta.project, s.meta.cwd, s.meta.gitBranch, s.harness, s.id].some((v) => v?.toLowerCase().includes(text))
  })

  const auto = h('button.session.auto' + (view === 'auto' ? '.active' : ''), { onclick: () => cb.selectView('auto'), title: 'Follow whatever is running (A)' },
    h('div.session-top', null,
      h('span.dot', { style: `background:${live.length ? STATUS_COLOR.working : STATUS_COLOR.idle}` }),
      h('span.session-title', null, 'Follow live activity'),
    ),
    h('div.session-meta', null, live.length ? `${live.length} live session${live.length > 1 ? 's' : ''}` : 'nothing running — showing the latest'),
  )

  const cards = list.map((s) => {
    const hc = harnessInfo(s.harness)
    const open = openTools(s)
    const status = s.status
    return h('button.session' + (view === s.id ? '.active' : '') + (isLive(s) ? '.live' : ''), { onclick: () => cb.selectView(s.id), title: s.meta.cwd ?? s.id },
      h('div.session-top', null,
        h('span.dot' + (status === 'working' ? '.pulse' : ''), { style: `background:${STATUS_COLOR[status]}` }),
        h('span.session-title', null, s.meta.title ?? s.meta.project ?? s.id.slice(0, 10)),
        h('span.badge', { style: `color:${hc.color};border-color:${hc.color}55` }, hc.short),
      ),
      h('div.session-meta', null,
        [s.meta.project, s.meta.gitBranch].filter(Boolean).join(' · ') || shortPath(s.meta.cwd ?? '', 2),
        s.meta.demo ? h('span.demo', null, 'demo') : null,
      ),
      status === 'waiting' && s.statusReason ? h('div.session-wait', null, '⏸ ', clip(Object.values(s.agents).find((a) => a.status === 'waiting')?.statusReason ?? s.statusReason, 70)) : null,
      h('div.session-stats', null,
        h('span', { title: 'agents' }, `◎ ${Object.keys(s.agents).length}`),
        h('span', { title: 'tool calls' }, `⚒ ${formatCount(s.counts.tools)}`),
        s.counts.toolErrors ? h('span.err', { title: 'failed tool calls' }, `✗ ${s.counts.toolErrors}`) : null,
        h('span', { title: 'tokens' }, `◈ ${formatCount(totalTokens(s.usage))}`),
        h('span.ago', null, formatAgo(s.lastActivityAt, now)),
      ),
      sparkline(activity.get(s.id) ?? [], now, hc.color),
      open.length ? h('div.session-open', null, ...open.slice(0, 3).map((t) => h('span.chip', { style: `--c:${categoryColor(t.category)}` }, clip(t.title, 34)))) : null,
    )
  })
  el.replaceChildren(auto, ...cards, list.length === 0 ? h('div.empty', null, text ? 'No sessions match.' : 'No sessions yet. Start Claude Code or Codex — they will appear here.') : '')
}

function sparkline(times: number[], now: number, color: string): SVGSVGElement {
  const buckets = 40
  const span = 10 * 60_000
  const counts = new Array<number>(buckets).fill(0)
  for (const t of times) {
    const i = Math.floor((t - (now - span)) / (span / buckets))
    if (i >= 0 && i < buckets) counts[i]!++
  }
  const max = Math.max(1, ...counts)
  const w = 220, hgt = 22
  const pts = counts.map((c, i) => `${(i / (buckets - 1)) * w},${hgt - 2 - (c / max) * (hgt - 4)}`)
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`)
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.classList.add('spark')
  const area = document.createElementNS(ns, 'path')
  area.setAttribute('d', `M0,${hgt} L${pts.join(' L')} L${w},${hgt} Z`)
  area.setAttribute('fill', color + '22')
  const line = document.createElementNS(ns, 'polyline')
  line.setAttribute('points', pts.join(' '))
  line.setAttribute('fill', 'none')
  line.setAttribute('stroke', color)
  line.setAttribute('stroke-width', '1.2')
  line.setAttribute('vector-effect', 'non-scaling-stroke')
  svg.append(area, line)
  return svg
}

// ─── Feed ───────────────────────────────────────────────────────────────

const FEED_ICON: Record<string, string> = {
  'tool.started': '▸', 'tool.finished': '✓', message: '❝', thinking: '∴', 'agent.spawned': '✦', 'turn.started': '↳',
  'turn.ended': '■', 'session.status': '●', 'agent.status': '●', note: 'ℹ', 'session.started': '◆',
}

export function feedItem(e: ObserverEvent, world: WorldState, cb: PanelCallbacks): HTMLElement | null {
  const s = world.sessions[e.sessionId]
  if (!s) return null
  const agent = s.agents[e.agentId]
  const who = e.agentId === s.rootAgentId ? 'main' : agent?.name ?? e.agentId.slice(0, 6)
  const hc = harnessInfo(s.harness)
  let body: (Node | string)[] = []
  let cls = e.kind.replace('.', '-')
  let onclick: (() => void) | undefined
  switch (e.kind) {
    case 'tool.started':
      body = [h('span.cat', { style: `color:${categoryColor(e.category)}` }, CATEGORY[e.category]?.label ?? e.category), ' ', e.title]
      onclick = () => cb.select({ type: 'tool', sessionId: s.id, id: e.callId })
      break
    case 'tool.finished': {
      const t = s.tools[e.callId]
      if (e.ok) return null // keep the feed calm; failures are interesting
      cls += ' bad'
      body = [h('span.cat.bad', null, 'failed'), ' ', t?.title ?? e.callId, e.output ? h('div.out', null, clip(e.output.split('\n').filter(Boolean).slice(-2).join(' ⏎ '), 160)) : '']
      onclick = () => cb.select({ type: 'tool', sessionId: s.id, id: e.callId })
      break
    }
    case 'message':
      cls += ` ${e.role}`
      body = [h('span.role', null, e.role === 'user' ? 'you' : e.role === 'agent' ? (e.to ? `→ ${e.to}` : 'task') : 'says'), ' ', clip(e.text.replace(/\s+/g, ' '), 320)]
      break
    case 'thinking':
      if (!e.text) return null
      body = [h('span.role', null, 'thinks'), ' ', clip(e.text.replace(/\s+/g, ' '), 200)]
      break
    case 'agent.spawned':
      body = [h('span.role', null, 'spawned'), ' ', e.name, e.role ? h('span.muted', null, ` (${e.role})`) : '']
      onclick = () => cb.select({ type: 'agent', sessionId: s.id, id: e.agentId })
      break
    case 'turn.ended':
      body = [e.outcome === 'completed' ? 'turn complete' : `turn ${e.outcome}`, e.durationMs ? h('span.muted', null, ` · ${formatDuration(e.durationMs)}`) : '']
      break
    case 'agent.status':
      if (e.status !== 'waiting') return null
      cls += ' wait'
      body = ['waiting', e.reason ? h('span.muted', null, ` — ${clip(e.reason, 90)}`) : '']
      break
    case 'note':
      body = [e.text]
      break
    default:
      return null
  }
  const time = new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return h('div.feed-item.' + cls.split(' ').join('.'), onclick ? { onclick } : null,
    h('span.feed-icon', null, FEED_ICON[e.kind] ?? '·'),
    h('div.feed-main', null,
      h('div.feed-head', null,
        h('span.who', { style: `color:${e.agentId === s.rootAgentId ? hc.color : '#ffd166'}` }, who),
        h('span.time', null, time),
      ),
      h('div.feed-body', null, ...body),
    ),
  )
}

// ─── Inspector ──────────────────────────────────────────────────────────

function kv(label: string, value: Node | string | number | undefined | null): HTMLElement | null {
  if (value === undefined || value === null || value === '') return null
  return h('div.kv', null, h('span.k', null, label), h('span.v', null, value instanceof Node ? value : String(value)))
}

function bar(fraction: number, color: string): HTMLElement {
  return h('div.bar', null, h('div.bar-fill', { style: `width:${Math.round(Math.min(1, fraction) * 100)}%;background:${color}` }))
}

export function renderInspector(el: HTMLElement, world: WorldState, sel: Selection | undefined, focus: string | undefined, cb: PanelCallbacks): void {
  const sid = sel?.sessionId ?? focus
  const s = sid ? world.sessions[sid] : undefined
  if (!s) {
    el.replaceChildren(h('div.empty', null, 'Select a session, agent, tool or file.'))
    return
  }
  const nodes = sel?.type === 'tool' ? toolView(s, sel.id, cb) : sel?.type === 'agent' ? agentView(s, sel.id, cb) : sel?.type === 'file' ? fileView(s, sel.id, cb) : sessionView(s, cb)
  el.replaceChildren(...nodes.filter((n): n is Node => n !== null))
}

function crumbs(s: SessionState, cb: PanelCallbacks, ...rest: string[]): HTMLElement {
  return h('div.crumbs', null,
    h('a', { href: '#', onclick: (ev: Event) => { ev.preventDefault(); cb.select({ type: 'session', sessionId: s.id }) } }, s.meta.title ?? s.meta.project ?? 'session'),
    ...rest.map((r) => h('span', null, ' / ', r)),
  )
}

function sessionView(s: SessionState, cb: PanelCallbacks): (Node | null)[] {
  const hc = harnessInfo(s.harness)
  const fill = contextFill(s)
  const cats = categoryBreakdown(s)
  const maxCat = Math.max(1, ...cats.map((c) => c.count))
  const tree = agentTree(s)
  const u = s.usage
  return [
    h('h2', null, s.meta.title ?? s.meta.project ?? s.id),
    h('div.tags', null,
      h('span.badge', { style: `color:${hc.color};border-color:${hc.color}55` }, hc.label),
      h('span.badge', { style: `color:${STATUS_COLOR[s.status]};border-color:${STATUS_COLOR[s.status]}55` }, s.status),
      s.meta.permissionMode ? h('span.badge', null, s.meta.permissionMode) : null,
      s.meta.partialHistory ? h('span.badge', { title: 'Large transcript: only the tail was loaded' }, 'partial history') : null,
      s.meta.demo ? h('span.badge', null, 'demo') : null,
    ),
    s.meta.goal ? h('div.goal', null, h('span.k', null, 'Goal '), s.meta.goal, s.meta.goalStatus ? h('span.muted', null, ` (${s.meta.goalStatus})`) : '') : null,
    s.status === 'waiting' && s.statusReason ? h('div.waiting', null, '⏸ Waiting — ', Object.values(s.agents).find((a) => a.status === 'waiting')?.statusReason ?? s.statusReason) : null,
    h('section', null,
      kv('Project', s.meta.cwd ? h('code', null, s.meta.cwd) : s.meta.project),
      kv('Branch', s.meta.gitBranch),
      kv('Model', s.meta.model),
      kv('Harness', [s.meta.entrypoint, s.meta.harnessVersion].filter(Boolean).join(' · ')),
      kv('Started', `${new Date(s.startedAt).toLocaleString()} (${formatAgo(s.startedAt)})`),
      kv('Last activity', formatAgo(s.lastActivityAt)),
      s.meta.prUrl ? kv('Pull request', h('a', { href: s.meta.prUrl, target: '_blank', rel: 'noreferrer' }, s.meta.prUrl.replace(/^https:\/\/github.com\//, ''))) : null,
    ),
    h('div.stats', null,
      stat('Turns', s.counts.turns),
      stat('Tool calls', s.counts.tools),
      stat('Failures', s.counts.toolErrors, s.counts.toolErrors ? '#ff5d73' : undefined),
      stat('Agents', Object.keys(s.agents).length),
      stat('Tokens', formatCount(totalTokens(u))),
      s.meta.costUsd !== undefined ? stat('Cost', `$${s.meta.costUsd.toFixed(2)}`) : stat('Output', formatCount(u.output)),
      s.meta.linesAdded !== undefined ? stat('Lines', h('span', null, h('span.add', null, `+${s.meta.linesAdded}`), ' ', h('span.del', null, `−${s.meta.linesRemoved ?? 0}`))) : null,
    ),
    fill !== undefined ? h('section', null, h('h3', null, `Context ${Math.round(fill * 100)}%`), bar(fill, fill > 0.85 ? '#ff5d73' : fill > 0.6 ? '#ffb547' : '#5aa9ff'), h('div.muted.small', null, `${formatCount(s.contextTokens ?? 0)} of ${formatCount(s.contextWindow ?? 0)} tokens`)) : null,
    h('section', null,
      h('h3', null, 'Tokens'),
      tokenRow('Input', u.input, totalTokens(u), '#5aa9ff'),
      tokenRow('Cache read', u.cacheRead, totalTokens(u), '#8f7dff'),
      tokenRow('Cache write', u.cacheWrite, totalTokens(u), '#e083ff'),
      tokenRow('Output', u.output, totalTokens(u), '#4fe39b'),
    ),
    cats.length ? h('section', null, h('h3', null, 'Tools by kind'), ...cats.map((c) => h('div.catrow', null, h('span.k', { style: `color:${categoryColor(c.category)}` }, CATEGORY[c.category]?.label ?? c.category), bar(c.count / maxCat, categoryColor(c.category)), h('span.n', null, String(c.count))))) : null,
    tree ? h('section', null, h('h3', null, 'Agents'), treeView(tree, s, cb)) : null,
  ]
}

function stat(label: string, value: string | number | Node, color?: string): HTMLElement {
  return h('div.stat', null, h('div.stat-v', color ? { style: `color:${color}` } : null, value instanceof Node ? value : String(value)), h('div.stat-k', null, label))
}

function tokenRow(label: string, n: number, total: number, color: string): HTMLElement {
  return h('div.catrow', null, h('span.k', null, label), bar(total ? n / total : 0, color), h('span.n', null, formatCount(n)))
}

function treeView(node: AgentNode, s: SessionState, cb: PanelCallbacks): HTMLElement {
  return h('ul.tree', null, h('li', null,
    h('a', { href: '#', onclick: (ev: Event) => { ev.preventDefault(); cb.select({ type: 'agent', sessionId: s.id, id: node.id }) } },
      h('span.dot', { style: `background:${STATUS_COLOR[node.status]}` }),
      node.id === s.rootAgentId ? 'main' : node.name,
      node.role ? h('span.muted', null, ` ${node.role}`) : '',
      h('span.muted', null, ` · ${node.toolCount} tools`),
    ),
    ...node.childNodes.map((c) => treeView(c, s, cb)),
  ))
}

function agentView(s: SessionState, id: string, cb: PanelCallbacks): (Node | null)[] {
  const a = s.agents[id]
  if (!a) return [h('div.empty', null, 'Agent not found.')]
  const tools = s.toolOrder.map((t) => s.tools[t]).filter((t) => t && t.agentId === id).slice(-25).reverse()
  const fill = contextFill(a)
  const parent = a.parentId ? s.agents[a.parentId] : undefined
  return [
    crumbs(s, cb, a.id === s.rootAgentId ? 'main' : a.name),
    h('h2', null, a.id === s.rootAgentId ? 'Main agent' : a.name),
    h('div.tags', null,
      h('span.badge', { style: `color:${STATUS_COLOR[a.status]};border-color:${STATUS_COLOR[a.status]}55` }, a.status),
      a.role ? h('span.badge', null, a.role) : null,
      a.thinking ? h('span.badge', { style: 'color:#c7a6ff;border-color:#c7a6ff55' }, 'thinking') : null,
    ),
    a.statusReason && a.status === 'waiting' ? h('div.waiting', null, '⏸ ', a.statusReason) : null,
    a.task ? h('section', null, h('h3', null, 'Task'), h('p', null, a.task)) : null,
    h('section', null,
      kv('Model', a.model),
      kv('Parent', parent ? (parent.id === s.rootAgentId ? 'main' : parent.name) : undefined),
      kv('Started', formatAgo(a.startedAt)),
      kv('Tool calls', `${a.toolCount}${a.errorCount ? ` (${a.errorCount} failed)` : ''}`),
      kv('Tokens', formatCount(totalTokens(a.usage))),
      fill !== undefined ? kv('Context', `${Math.round(fill * 100)}%`) : null,
    ),
    a.lastText ? h('section', null, h('h3', null, 'Last said'), h('p.quote', null, a.lastText)) : null,
    tools.length ? h('section', null, h('h3', null, 'Recent tools'), ...tools.map((t) => toolRow(s, t!, cb))) : null,
  ]
}

function toolRow(s: SessionState, t: NonNullable<SessionState['tools'][string]>, cb: PanelCallbacks): HTMLElement {
  const state = t.endedAt === undefined ? 'running' : t.ok ? formatDuration(t.durationMs ?? 0) : 'failed'
  return h('a.toolrow' + (t.ok === false ? '.bad' : ''), { href: '#', onclick: (ev: Event) => { ev.preventDefault(); cb.select({ type: 'tool', sessionId: s.id, id: t.id }) } },
    h('span.cdot', { style: `background:${categoryColor(t.category)}` }),
    h('span.tt', null, t.title),
    h('span.muted', null, state),
  )
}

function toolView(s: SessionState, id: string, cb: PanelCallbacks): (Node | null)[] {
  const t = s.tools[id]
  if (!t) return [crumbs(s, cb), h('div.empty', null, 'This tool call has scrolled out of the retained window.')]
  const a = s.agents[t.agentId]
  const color = categoryColor(t.category)
  const input = t.input === undefined ? undefined : typeof t.input === 'string' ? t.input : JSON.stringify(t.input, null, 2)
  return [
    crumbs(s, cb, a ? (a.id === s.rootAgentId ? 'main' : a.name) : t.agentId, t.tool),
    h('h2', { style: `color:${color}` }, t.title),
    h('div.tags', null,
      h('span.badge', { style: `color:${color};border-color:${color}55` }, CATEGORY[t.category]?.label ?? t.category),
      h('span.badge', null, t.tool),
      h('span.badge', { style: t.ok === false ? 'color:#ff5d73;border-color:#ff5d7355' : t.endedAt === undefined ? 'color:#4fe39b;border-color:#4fe39b55' : '' }, t.endedAt === undefined ? 'running' : t.ok ? 'ok' : 'failed'),
      t.mcpServer ? h('span.badge', null, t.mcpServer) : null,
    ),
    h('section', null,
      kv('Agent', a ? h('a', { href: '#', onclick: (ev: Event) => { ev.preventDefault(); cb.select({ type: 'agent', sessionId: s.id, id: t.agentId }) } }, a.id === s.rootAgentId ? 'main' : a.name) : t.agentId),
      kv('Started', new Date(t.startedAt).toLocaleTimeString()),
      kv('Duration', t.endedAt === undefined ? `running for ${formatDuration(Date.now() - t.startedAt)}` : formatDuration(t.durationMs ?? 0)),
      t.childAgentId ? kv('Spawned', h('a', { href: '#', onclick: (ev: Event) => { ev.preventDefault(); cb.select({ type: 'agent', sessionId: s.id, id: t.childAgentId! }) } }, s.agents[t.childAgentId]?.name ?? t.childAgentId)) : null,
    ),
    t.files.length ? h('section', null, h('h3', null, 'Files'), ...t.files.map((f) => h('a.filerow', { href: '#', onclick: (ev: Event) => { ev.preventDefault(); cb.select({ type: 'file', sessionId: s.id, id: f.path }) } }, h('span.cdot', { style: `background:${FILE_OP_COLOR[f.op]}` }), h('code', null, shortPath(f.path, 4)), h('span.muted', null, f.op)))) : null,
    input ? h('section', null, h('h3', null, 'Input'), h('pre', null, input)) : null,
    t.output ? h('section', null, h('h3', null, 'Output'), h('pre' + (t.ok === false ? '.bad' : ''), null, t.output)) : null,
  ]
}

function fileView(s: SessionState, path: string, cb: PanelCallbacks): (Node | null)[] {
  const f = s.files[path]
  if (!f) return [crumbs(s, cb), h('div.empty', null, 'File not found.')]
  const who = s.agents[f.lastAgentId]
  const tools = s.toolOrder.map((t) => s.tools[t]).filter((t) => t && t.files.some((x) => x.path === path)).slice(-15).reverse()
  return [
    crumbs(s, cb, 'files'),
    h('h2', null, shortPath(path, 1)),
    h('code.path', null, path),
    h('div.stats', null, stat('Reads', f.reads), stat('Edits', f.edits, f.edits ? '#ffb547' : undefined), stat('Writes', f.writes, f.writes ? '#4fe39b' : undefined), stat('Searches', f.searches)),
    h('section', null, kv('Last touched', `${formatAgo(f.lastTs)} by ${who ? (who.id === s.rootAgentId ? 'main' : who.name) : f.lastAgentId}`), kv('Last op', f.lastOp)),
    tools.length ? h('section', null, h('h3', null, 'Tool calls'), ...tools.map((t) => toolRow(s, t!, cb))) : null,
  ]
}

// ─── Files tab ──────────────────────────────────────────────────────────

export function renderFiles(el: HTMLElement, world: WorldState, sessionIds: string[], cb: PanelCallbacks): void {
  const rows: HTMLElement[] = []
  for (const sid of sessionIds) {
    const s = world.sessions[sid]
    if (!s) continue
    const files = hotFiles(s, 60)
    if (!files.length) continue
    const max = Math.max(1, ...files.map((f) => f.touches))
    if (sessionIds.length > 1) rows.push(h('h3', null, s.meta.title ?? s.meta.project ?? s.id))
    for (const f of files) {
      const segs = (['read', 'search', 'edit', 'write', 'delete'] as const).map((op) => {
        const n = op === 'read' ? f.reads : op === 'search' ? f.searches : op === 'edit' ? f.edits : op === 'write' ? f.writes : f.deletes
        return n ? h('span', { style: `flex:${n};background:${FILE_OP_COLOR[op]}`, title: `${n} ${op}` }) : null
      })
      rows.push(h('a.hotfile', { href: '#', onclick: (ev: Event) => { ev.preventDefault(); cb.select({ type: 'file', sessionId: s.id, id: f.path }) } },
        h('div.hotfile-top', null, h('code', null, shortPath(f.path, 3)), h('span.muted', null, formatAgo(f.lastTs))),
        h('div.opbar', { style: `width:${Math.max(8, (f.touches / max) * 100)}%` }, ...segs),
      ))
    }
  }
  el.replaceChildren(...(rows.length ? rows : [h('div.empty', null, 'No files touched yet.')]))
}

export function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
