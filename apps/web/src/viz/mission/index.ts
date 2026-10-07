/**
 * Mission Control: a compact, IDE-style dashboard built for answering
 * "does anything need me, and what is running right now?".
 */
import './mission.css'
import {
  agentTree,
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
  type AttentionItem,
  type ObserverEvent,
  type SessionState,
  type ToolCallState,
  type ToolCategory,
  type WorldState,
} from '@oadt/protocol'
import { h, render } from '../../shared/dom'
import { CATEGORY, harnessInfo } from '../../shared/theme'
import { Disposer, type ThemeName, type Visualization, type VizContext } from '../types'
import { bucket, sparkline, stackedArea } from './charts'

export const mission: Visualization = {
  id: 'mission',
  name: 'Mission Control',
  description: 'A compact, practical dashboard: what needs you, what is running, and how fast.',
  settings: [
    {
      key: 'scope', label: 'Sessions shown', type: 'select', default: 'recent',
      options: [{ value: 'live', label: 'Live only' }, { value: 'recent', label: 'Live and last 3 hours' }, { value: 'all', label: 'Everything loaded' }],
    },
    {
      key: 'detailTab', label: 'Default detail tab', type: 'select', default: 'activity',
      options: [{ value: 'activity', label: 'Activity' }, { value: 'chat', label: 'Chat' }, { value: 'agents', label: 'Agents' }, { value: 'files', label: 'Files' }],
    },
  ],
  mount,
}

type View = 'overview' | 'attention' | 'log'
type Tab = 'activity' | 'chat' | 'agents' | 'files'

const THEME_LABEL: Record<ThemeName, string> = { dark: 'Dark', light: 'Light', 'gruvbox-dark': 'Gruvbox Dark', 'gruvbox-light': 'Gruvbox Light' }
const CATEGORIES = Object.keys(CATEGORY) as ToolCategory[]
const ATTN_ICON: Record<AttentionItem['kind'], string> = { waiting: '⏸', errors: '✕', finished: '✓', aborted: '■', context: '◔', 'long-tool': '⧗' }
const SPAN_MS = 15 * 60_000
const BUCKETS = 60

const TEMPLATE = `
<div class="mc">
  <header class="mc-title">
    <div class="mc-brand"><span class="mc-logo"></span>Mission Control</div>
    <span class="mc-attn-badge"></span>
    <div class="mc-search"><input type="search" placeholder="Filter sessions (/)" spellcheck="false" /></div>
    <div class="mc-title-actions">
      <button class="mc-iconbtn mc-bell" title="Desktop notifications"></button>
      <select class="mc-theme" title="Theme"></select>
    </div>
  </header>
  <nav class="mc-act">
    <button data-view="overview" title="Overview">▦</button>
    <button data-view="attention" title="Needs attention">⚑<span class="count" hidden></span></button>
    <button data-view="log" title="Activity log (all sessions)">≡</button>
  </nav>
  <main class="mc-main"></main>
  <aside class="mc-detail">
    <div class="mc-detail-head"></div>
    <nav class="mc-tabs">
      <button data-tab="activity">Activity</button>
      <button data-tab="chat">Chat</button>
      <button data-tab="agents">Agents</button>
      <button data-tab="files">Files</button>
    </nav>
    <div class="mc-tab-body"></div>
  </aside>
  <footer class="mc-status"></footer>
</div>`

interface Tile {
  el: HTMLElement
  dot: HTMLElement
  title: HTMLElement
  badge: HTMLElement
  age: HTMLElement
  meta: HTMLElement
  now: HTMLElement
  spark: HTMLCanvasElement
  stats: HTMLElement
}

function mount(root: HTMLElement, vctx: VizContext) {
  const d = new Disposer()
  const { client, settings, attention } = vctx
  root.innerHTML = TEMPLATE
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector(sel) as T
  const mc = q('.mc')
  q('.mc-title-actions').append(vctx.switcher)

  /** Set whenever something on screen may have changed; the loop repaints and clears it. */
  let dirty = true
  const ui = {
    view: 'overview' as View,
    tab: settings.get<string>('mission.detailTab') as Tab,
    selected: undefined as string | undefined,
    search: '',
    expanded: undefined as string | undefined,
  }

  // ─── Theme ────────────────────────────────────────────────────────────
  let colors: Record<string, string> = {}
  const readColors = () => {
    const cs = getComputedStyle(mc)
    const get = (n: string) => cs.getPropertyValue(n).trim()
    colors = { grid: get('--border'), text: get('--fg-faint'), accent: get('--accent'), warn: get('--warn'), ok: get('--ok'), claude: get('--claude'), codex: get('--codex') }
    for (const c of CATEGORIES) colors[c] = get(`--c-${c}`)
  }
  const themeSelect = q<HTMLSelectElement>('.mc-theme')
  const applyTheme = (t: ThemeName) => {
    mc.dataset.theme = t
    readColors()
    renderThemeSelect()
    dirty = true
  }
  function renderThemeSelect(): void {
    const value = settings.get<string>('theme')
    themeSelect.replaceChildren(...[['system', 'System'], ...Object.entries(THEME_LABEL)].map(([v, l]) => {
      const o = h('option', { value: v }, l!) as HTMLOptionElement
      o.selected = v === value
      return o
    }))
  }
  themeSelect.addEventListener('change', () => settings.set('theme', themeSelect.value))
  applyTheme(vctx.theme())
  d.add(vctx.onTheme(applyTheme))

  // ─── Live data for charts ─────────────────────────────────────────────
  const toolStarts: Array<{ ts: number; cat: ToolCategory; sid: string }> = []
  const tokenTimes: Array<{ ts: number; n: number }> = []
  for (const s of Object.values(client.world.sessions)) for (const id of s.toolOrder) {
    const t = s.tools[id]
    if (t && t.startedAt > Date.now() - SPAN_MS) toolStarts.push({ ts: t.startedAt, cat: t.category, sid: s.id })
  }
  const chats = new Map<string, ObserverEvent[]>()
  d.add(client.onChange((_w, events) => {
    for (const e of events) {
      if (e.kind === 'tool.started') toolStarts.push({ ts: e.ts, cat: e.category, sid: e.sessionId })
      if (e.kind === 'usage') tokenTimes.push({ ts: e.ts, n: e.delta.input + e.delta.output + e.delta.cacheWrite })
      if (e.kind === 'message') chats.get(e.sessionId)?.push(e)
    }
    const cutoff = Date.now() - SPAN_MS
    while (toolStarts.length && toolStarts[0]!.ts < cutoff) toolStarts.shift()
    while (tokenTimes.length && tokenTimes[0]!.ts < cutoff) tokenTimes.shift()
    dirty = true
  }))

  // ─── Selection & navigation ───────────────────────────────────────────
  function select(sid: string | undefined): void {
    if (ui.selected === sid) return
    ui.selected = sid
    ui.expanded = undefined
    if (sid && !chats.has(sid)) {
      chats.set(sid, [])
      client.sessionEvents(sid).then((evs) => {
        const live = chats.get(sid) ?? []
        const seen = new Set(live.map((e) => e.seq))
        chats.set(sid, [...evs.filter((e) => e.kind === 'message' && !seen.has(e.seq)), ...live].sort((a, b) => a.seq - b.seq))
        dirty = true
      }).catch(() => { /* history is optional */ })
    }
    dirty = true
  }
  function setView(v: View): void {
    ui.view = v
    for (const b of root.querySelectorAll<HTMLElement>('.mc-act [data-view]')) b.classList.toggle('on', b.dataset.view === v)
    main.replaceChildren()
    main.dataset.key = ''
    tiles.clear()
    dirty = true
  }
  function setTab(t: Tab): void {
    ui.tab = t
    for (const b of root.querySelectorAll<HTMLElement>('.mc-tabs [data-tab]')) b.classList.toggle('on', b.dataset.tab === t)
    tabBody.dataset.key = ''
    dirty = true
  }
  for (const b of root.querySelectorAll<HTMLElement>('.mc-act [data-view]')) b.addEventListener('click', () => setView(b.dataset.view as View))
  for (const b of root.querySelectorAll<HTMLElement>('.mc-tabs [data-tab]')) b.addEventListener('click', () => setTab(b.dataset.tab as Tab))
  const search = q<HTMLInputElement>('.mc-search input')
  search.addEventListener('input', () => { ui.search = search.value; dirty = true })
  q('.mc-attn-badge').addEventListener('click', () => setView('attention'))

  const bell = q('.mc-bell')
  bell.addEventListener('click', async () => {
    const on = settings.get<boolean>('notify.desktop')
    if (on) return settings.set('notify.desktop', false)
    if ((await attention.requestPermission()) === 'granted') settings.set('notify.desktop', true)
    else vctx.openSettings('notifications')
  })
  d.add(settings.on('*', () => { dirty = true }))

  d.listen(window, 'keydown', (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) {
      if (e.key === 'Escape') (e.target as HTMLElement).blur()
      return
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const ids = visibleSessions(client.world).map((s) => s.id)
    const i = ui.selected ? ids.indexOf(ui.selected) : -1
    switch (e.key) {
      case '/': e.preventDefault(); search.focus(); break
      case 'j': if (ids.length) select(ids[Math.min(ids.length - 1, i + 1)]); break
      case 'k': if (ids.length) select(ids[Math.max(0, i - 1)]); break
      case '1': setTab('activity'); break
      case '2': setTab('chat'); break
      case '3': setTab('agents'); break
      case '4': setTab('files'); break
      case 'x': attention.ackAll(); break
    }
  })

  // ─── Which sessions ───────────────────────────────────────────────────
  function visibleSessions(world: WorldState): SessionState[] {
    const scope = settings.get<string>('mission.scope')
    const now = Date.now()
    const text = ui.search.trim().toLowerCase()
    const urgent = new Set(attention.open().filter((a) => a.severity === 'high').map((a) => a.sessionId))
    return sessionList(world)
      .filter((s) => scope === 'all' || isLive(s) || (scope === 'recent' && now - s.lastActivityAt < 3 * 3600_000) || s.id === ui.selected)
      .filter((s) => !text || [s.meta.title, s.meta.project, s.meta.gitBranch, s.meta.cwd, s.harness, s.id].some((v) => v?.toLowerCase().includes(text)))
      .sort((a, b) => Number(urgent.has(b.id)) - Number(urgent.has(a.id)) || Number(isLive(b)) - Number(isLive(a)) || b.lastActivityAt - a.lastActivityAt)
  }

  // ─── Main area ────────────────────────────────────────────────────────
  const main = q('.mc-main')
  const tiles = new Map<string, Tile>()
  let kpiEl: HTMLElement | undefined
  let throughput: HTMLCanvasElement | undefined
  let attnList: HTMLElement | undefined
  let grid: HTMLElement | undefined
  let scopeBar: HTMLElement | undefined
  let feedWrap: HTMLElement | undefined

  function buildOverview(): void {
    throughput = h('canvas') as HTMLCanvasElement
    kpiEl = h('section.mc-kpis')
    attnList = h('div.mc-attn-list')
    grid = h('div.mc-grid')
    scopeBar = h('span.grow')
    feedWrap = h('div.mc-feed')
    main.replaceChildren(
      kpiEl,
      h('section.mc-section', null, h('div.mc-section-head', null, 'Needs attention', h('span.grow'), h('button', { onclick: () => attention.ackAll(), title: 'Acknowledge everything (X)' }, 'Clear all')), attnList),
      h('section.mc-section', null, h('div.mc-section-head', null, 'Sessions', scopeBar, ...(['live', 'recent', 'all'] as const).map((s) =>
        h('button' + (settings.get('mission.scope') === s ? '.on' : ''), { onclick: () => settings.set('mission.scope', s), 'data-scope': s }, s === 'live' ? 'Live' : s === 'recent' ? 'Recent' : 'All'))), grid),
      h('section.mc-section.mc-fill', null, h('div.mc-section-head', null, 'Activity', h('span.grow'), h('button', { onclick: () => setView('log'), title: 'Open the full log' }, 'Open log')), feedWrap),
    )
  }

  function renderKpis(world: WorldState, now: number): void {
    if (!kpiEl || !throughput) return
    let live = 0, working = 0, errors = 0, cost = 0
    for (const s of Object.values(world.sessions)) {
      if (isLive(s)) live++
      cost += s.meta.costUsd ?? 0
      for (const a of Object.values(s.agents)) if (a.status === 'working') working++
      for (const id of s.toolOrder) {
        const t = s.tools[id]
        if (t?.ok === false && (t.endedAt ?? 0) > now - 10 * 60_000) errors++
      }
    }
    const needs = attention.open().filter((a) => a.severity !== 'low').length
    const perMin = toolStarts.filter((t) => t.ts > now - 60_000).length
    const tokMin = tokenTimes.filter((t) => t.ts > now - 60_000).reduce((n, t) => n + t.n, 0)
    const cells: Array<[string, string, string]> = [
      [`${live}/${Object.keys(world.sessions).length}`, 'live sessions', live ? 'ok' : ''],
      [String(working), 'agents working', ''],
      [String(needs), 'need you', needs ? 'warn' : ''],
      [String(perMin), 'tools / min', ''],
      [formatCount(tokMin), 'tokens / min', ''],
      [String(errors), 'errors · 10m', errors ? 'err' : ''],
    ]
    render(kpiEl, cells.map((c) => c.join('|')).join('/') + (cost ? `|${cost.toFixed(2)}` : ''), () => [
      ...cells.map(([v, k, cls]) => h('div.mc-kpi' + (cls ? `.${cls}` : ''), null, h('div.v', null, v), h('div.k', null, k))),
      h('div.mc-throughput', null, h('span.lbl', null, `Tool calls · last 15 min${cost ? ` · $${cost.toFixed(2)} reported` : ''}`), throughput!),
    ])
    // The window grows with the data (2 → 15 min), so the chart is lively from the first minute.
    const span = Math.min(SPAN_MS, Math.max(2 * 60_000, now - (toolStarts[0]?.ts ?? now)))
    const bucketSec = Math.round(span / BUCKETS / 1000)
    const series = CATEGORIES.map((c) => ({ values: bucket(toolStarts.filter((t) => t.cat === c).map((t) => t.ts), now, span, BUCKETS), color: colors[c] ?? colors.accent! }))
    stackedArea(throughput, series, { grid: colors.grid!, text: colors.text!, label: (m) => `peak ${m} per ${bucketSec}s` })
    const lbl = throughput.parentElement?.querySelector('.lbl')
    if (lbl) lbl.textContent = `Tool calls · last ${Math.round(span / 60_000)} min${cost ? ` · $${cost.toFixed(2)} reported` : ''}`
  }

  function attentionRow(item: AttentionItem, world: WorldState, now: number, acked: boolean): HTMLElement {
    const s = world.sessions[item.sessionId]
    return h('div.mc-attn.' + item.severity + (acked ? '.acked' : ''), { onclick: () => { select(item.sessionId); if (item.kind === 'finished') setTab('chat') }, title: item.detail ?? '' },
      h('span.ico', null, ATTN_ICON[item.kind]),
      h('div.txt', null, h('b', null, item.title), h('span.sess', null, s?.meta.title ?? s?.meta.project ?? item.sessionId.slice(0, 8)), item.detail ? h('span.det', null, item.detail.replace(/\s+/g, ' ')) : ''),
      h('span.age', null, formatDuration(now - item.since)),
      h('div.acts', null, acked
        ? h('button', { onclick: (e: Event) => { e.stopPropagation(); attention.unack(item.id) }, title: 'Restore' }, '↺')
        : h('button', { onclick: (e: Event) => { e.stopPropagation(); attention.ack(item.id) }, title: 'Acknowledge' }, '✓')),
    )
  }

  function renderAttention(el: HTMLElement, world: WorldState, now: number, includeAcked: boolean): void {
    const items = includeAcked ? attention.all() : attention.open()
    const key = items.map((i) => `${i.id}${attention.isAcked(i.id) ? 'a' : ''}`).join(',') + `|${Math.floor(now / 1000)}`
    render(el, key, () => items.length
      ? items.map((i) => attentionRow(i, world, now, attention.isAcked(i.id)))
      : [h('div.mc-empty.ok', null, 'Nothing needs you right now.')])
  }

  function tileFor(s: SessionState): Tile {
    let t = tiles.get(s.id)
    if (t) return t
    const dot = h('span.dot'), title = h('span.ttl'), badge = h('span.badge'), age = h('span.faint.mono')
    const meta = h('div.r2'), now = h('div.now'), spark = h('canvas.spark') as HTMLCanvasElement, stats = h('div.r5')
    const el = h('div.mc-tile', { onclick: () => select(s.id) }, h('div.r1', null, dot, title, badge, age), meta, now, spark, stats)
    t = { el, dot, title, badge, age, meta, now, spark, stats }
    tiles.set(s.id, t)
    return t
  }

  function updateTile(t: Tile, s: SessionState, now: number, drawSpark: boolean): void {
    const hc = harnessInfo(s.harness)
    t.el.className = `mc-tile st-${s.status}${s.id === ui.selected ? ' sel' : ''}${openTools(s).length ? ' running' : ''}`
    t.dot.className = `dot ${s.status}`
    t.title.textContent = s.meta.title ?? s.meta.project ?? s.id.slice(0, 8)
    t.badge.className = `badge ${s.harness}`
    t.badge.textContent = hc.short
    t.age.textContent = formatAgo(s.lastActivityAt, now).replace(' ago', '')
    t.meta.textContent = [s.meta.project, s.meta.gitBranch, s.meta.model].filter(Boolean).join(' · ') || shortPath(s.meta.cwd ?? s.id, 2)

    const waiting = Object.values(s.agents).find((a) => a.status === 'waiting')
    const running = openTools(s).filter((x) => x.category !== 'agent')
    const tool = running[running.length - 1]
    let nowKey: string
    let nowNodes: () => Array<Node | string>
    if (waiting) {
      nowKey = `w|${waiting.statusSince}|${Math.floor(now / 1000)}`
      nowNodes = () => [h('span', null, '⏸'), h('span.t', null, waiting.statusReason ?? 'waiting for approval'), h('span.el', null, formatDuration(now - waiting.statusSince))]
      t.now.className = 'now waiting'
    } else if (tool) {
      const c = CATEGORY[tool.category]
      nowKey = `t|${tool.id}|${Math.floor(now / 1000)}|${running.length}`
      nowNodes = () => [h('span.chip', { style: `--c:var(--c-${tool.category})` }, c?.label ?? tool.category), h('span.t', null, tool.title), h('span.el', null, `${formatDuration(now - tool.startedAt)}${running.length > 1 ? ` +${running.length - 1}` : ''}`)]
      t.now.className = 'now'
    } else {
      const thinking = Object.values(s.agents).some((a) => a.thinking)
      const label = thinking ? 'thinking…' : s.status === 'working' ? 'working' : s.turn.outcome === 'completed' && s.turn.endedAt ? `finished ${formatAgo(s.turn.endedAt, now)}` : `idle ${formatAgo(s.lastActivityAt, now)}`
      nowKey = `i|${label}`
      nowNodes = () => [h('span.t.dim', null, label)]
      t.now.className = 'now'
    }
    render(t.now, nowKey, nowNodes)

    if (drawSpark) {
      const times = toolStarts.filter((x) => x.sid === s.id).map((x) => x.ts)
      sparkline(t.spark, bucket(times, now, 10 * 60_000, 40), s.harness === 'codex' ? colors.codex! : s.harness === 'claude-code' ? colors.claude! : colors.accent!, { baseline: colors.grid })
    }

    const agents = Object.values(s.agents)
    const active = agents.filter((a) => a.status === 'working' || a.status === 'waiting').length
    const fill = s.contextTokens && s.contextWindow ? s.contextTokens / s.contextWindow : undefined
    render(t.stats, `${active}/${agents.length}|${s.counts.tools}|${s.counts.toolErrors}|${formatCount(totalTokens(s.usage))}|${s.meta.costUsd}|${fill?.toFixed(2)}`, () => [
      h('span', { title: 'agents active / total' }, `◎ ${active}/${agents.length}`),
      h('span', { title: 'tool calls' }, `⚒ ${formatCount(s.counts.tools)}`),
      s.counts.toolErrors ? h('span.err', { title: 'failed tool calls' }, `✕ ${s.counts.toolErrors}`) : '',
      h('span', { title: 'tokens' }, `◈ ${formatCount(totalTokens(s.usage))}`),
      s.meta.costUsd !== undefined ? h('span', { title: 'reported cost' }, `$${s.meta.costUsd.toFixed(2)}`) : '',
      fill !== undefined ? h('span.ctx', { title: `context ${Math.round(fill * 100)}%` }, h('i' + (fill > 0.85 ? '.full' : fill > 0.6 ? '.hot' : ''), { style: `width:${Math.round(fill * 100)}%` })) : '',
    ])
  }

  function renderGrid(world: WorldState, now: number, drawSpark: boolean): void {
    if (!grid) return
    const list = visibleSessions(world)
    if (!ui.selected && list[0]) select(list[0].id)
    const els: HTMLElement[] = []
    for (const s of list) {
      const t = tileFor(s)
      updateTile(t, s, now, drawSpark || !t.el.isConnected)
      els.push(t.el)
    }
    const current = [...grid.children]
    if (current.length !== els.length || current.some((c, i) => c !== els[i])) {
      grid.replaceChildren(...(els.length ? els : [h('div.mc-empty', null, ui.search ? 'No sessions match.' : 'No sessions yet. Start Claude Code or Codex.')]))
      // Canvases just (re)attached need a draw at their real size.
      for (const s of list) updateTile(tiles.get(s.id)!, s, now, true)
    }
    for (const id of [...tiles.keys()]) if (!list.some((s) => s.id === id)) tiles.delete(id)
    if (scopeBar?.parentElement) {
      for (const b of scopeBar.parentElement.querySelectorAll<HTMLElement>('[data-scope]')) b.classList.toggle('on', b.dataset.scope === settings.get('mission.scope'))
    }
  }

  // ─── Log table ────────────────────────────────────────────────────────
  function logTable(rows: Array<{ t: ToolCallState; s: SessionState }>, now: number, withSession: boolean): HTMLElement {
    const head = h('tr', null,
      h('th', { style: 'width:74px' }, 'Time'),
      withSession ? h('th', { style: 'width:22%' }, 'Session') : '',
      h('th', { style: 'width:18%' }, 'Agent'),
      h('th', { style: 'width:64px' }, 'Kind'),
      h('th', null, 'Call'),
      h('th', { style: 'width:70px' }, 'Took'),
    )
    const body: HTMLElement[] = []
    for (const { t, s } of rows) {
      const running = t.endedAt === undefined
      const agent = t.agentId === s.rootAgentId ? 'main' : s.agents[t.agentId]?.name ?? t.agentId.slice(0, 6)
      body.push(h('tr.row' + (running ? '.running' : '') + (t.ok === false ? '.failed' : ''), { onclick: () => { ui.expanded = ui.expanded === t.id ? undefined : t.id; tabBody.dataset.key = ''; if (ui.view === 'log') main.dataset.key = ''; dirty = true } },
        h('td.time', null, new Date(t.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })),
        withSession ? h('td', null, s.meta.title ?? s.meta.project ?? s.id.slice(0, 8)) : '',
        h('td', null, agent),
        h('td', null, h('span.chip', { style: `--c:var(--c-${t.category})` }, CATEGORY[t.category]?.label ?? t.category)),
        h('td.title', { title: t.title }, t.title),
        h('td.dur.st', null, running ? h('span', null, h('span.spin'), ' ', formatDuration(now - t.startedAt)) : t.ok === false ? `✕ ${formatDuration(t.durationMs ?? 0)}` : formatDuration(t.durationMs ?? 0)),
      ))
      if (ui.expanded === t.id) {
        const input = t.input === undefined ? '' : typeof t.input === 'string' ? t.input : JSON.stringify(t.input, null, 2)
        body.push(h('tr.expand', null, h('td', { colspan: withSession ? 6 : 5 },
          input ? h('pre', null, input) : '',
          t.output ? h('pre' + (t.ok === false ? '.bad' : ''), null, t.output) : h('div.faint', null, running ? 'Running…' : 'No output recorded.'),
        )))
      }
    }
    return h('table.mc-log', null, h('thead', null, head), h('tbody', null, ...body))
  }

  function sessionRows(s: SessionState, limit: number): Array<{ t: ToolCallState; s: SessionState }> {
    const all = s.toolOrder.map((id) => s.tools[id]).filter((t): t is ToolCallState => !!t)
    const running = all.filter((t) => t.endedAt === undefined)
    const done = all.filter((t) => t.endedAt !== undefined).sort((a, b) => b.startedAt - a.startedAt)
    return [...running, ...done].slice(0, limit).map((t) => ({ t, s }))
  }

  function renderLogView(world: WorldState, now: number): void {
    const rows = visibleSessions(world).flatMap((s) => sessionRows(s, 120))
      .sort((a, b) => Number(b.t.endedAt === undefined) - Number(a.t.endedAt === undefined) || b.t.startedAt - a.t.startedAt).slice(0, 400)
    const key = `log|${world.seq}|${ui.expanded}|${Math.floor(now / 1000)}`
    render(main, key, () => [h('section.mc-section', null, h('div.mc-section-head', null, `Activity · all sessions`, h('span.grow'), h('span.faint', null, `${rows.length} calls`)), logTable(rows, now, true))])
  }

  function renderFeed(world: WorldState, now: number): void {
    if (!feedWrap) return
    const rows = visibleSessions(world).flatMap((s) => sessionRows(s, 60))
      .sort((a, b) => Number(b.t.endedAt === undefined) - Number(a.t.endedAt === undefined) || b.t.startedAt - a.t.startedAt).slice(0, 80)
    render(feedWrap, `feed|${world.seq}|${ui.expanded}|${Math.floor(now / 1000)}`, () => [rows.length ? logTable(rows, now, true) : h('div.mc-empty', null, 'No tool calls yet.')])
  }

  function renderAttentionView(world: WorldState, now: number): void {
    if (!attnList || !attnList.isConnected) {
      attnList = h('div.mc-attn-list')
      main.replaceChildren(h('section.mc-section', null,
        h('div.mc-section-head', null, 'Needs attention', h('span.grow'),
          h('button', { onclick: () => attention.ackAll() }, 'Acknowledge all'),
          h('button', { onclick: () => vctx.openSettings('notifications') }, 'Notification settings…')),
        attnList))
    }
    renderAttention(attnList, world, now, true)
  }

  // ─── Detail panel ─────────────────────────────────────────────────────
  const detailHead = q('.mc-detail-head')
  const tabBody = q('.mc-tab-body')

  function renderDetail(world: WorldState, now: number): void {
    const s = ui.selected ? world.sessions[ui.selected] : undefined
    if (!s) {
      render(detailHead, 'none', () => [h('div.mc-noselect', null, 'Select a session')])
      render(tabBody, 'none', () => [])
      return
    }
    const fill = s.contextTokens && s.contextWindow ? Math.round((s.contextTokens / s.contextWindow) * 100) : undefined
    render(detailHead, `${s.id}|${s.status}|${s.counts.tools}|${s.counts.turns}|${s.counts.toolErrors}|${formatCount(totalTokens(s.usage))}|${s.meta.costUsd}|${fill}|${s.meta.title}|${Math.floor((now - s.statusSince) / 1000)}`, () => [
      h('div.ttl', null, h('span.dot.' + s.status), h('span', null, s.meta.title ?? s.meta.project ?? s.id)),
      h('div.dim', null, `${harnessInfo(s.harness).label} · ${s.status} for ${formatDuration(now - s.statusSince)}`),
      h('div.faint.mono', { title: s.meta.cwd ?? '' }, [s.meta.cwd ? shortPath(s.meta.cwd, 3) : '', s.meta.gitBranch, s.meta.model].filter(Boolean).join(' · ')),
      h('div.mc-facts', null,
        fact(s.counts.turns, 'turns'), fact(s.counts.tools, 'tools'), fact(s.counts.toolErrors, 'failed'),
        fact(formatCount(totalTokens(s.usage)), 'tokens'), fact(s.meta.costUsd !== undefined ? `$${s.meta.costUsd.toFixed(2)}` : '—', 'cost'), fact(fill !== undefined ? `${fill}%` : '—', 'context')),
    ])

    if (ui.tab === 'activity') {
      render(tabBody, `a|${s.id}|${s.counts.tools}|${openTools(s).length}|${ui.expanded}|${Math.floor(now / 1000)}|${s.toolOrder[s.toolOrder.length - 1]}`, () => [logTable(sessionRows(s, 200), now, false)])
    } else if (ui.tab === 'chat') {
      const msgs = (chats.get(s.id) ?? []).filter((e): e is Extract<ObserverEvent, { kind: 'message' }> => e.kind === 'message').slice(-120)
      const atBottom = tabBody.scrollHeight - tabBody.scrollTop - tabBody.clientHeight < 40
      const changed = tabBody.dataset.key !== `c|${s.id}|${msgs.length}`
      render(tabBody, `c|${s.id}|${msgs.length}`, () => [h('div.mc-chat', null, ...(msgs.length ? msgs.map((m) => {
        const who = m.agentId === s.rootAgentId ? (m.role === 'user' ? 'you' : 'main') : `${s.agents[m.agentId]?.name ?? 'agent'}${m.role === 'agent' ? ' · task' : ''}`
        return h('div.mc-msg.' + m.role, null, h('div.who', null, h('span', null, who), h('span', null, new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))), m.text)
      }) : [h('div.mc-empty', null, 'No messages yet.')]))])
      if (changed && atBottom) tabBody.scrollTop = tabBody.scrollHeight
    } else if (ui.tab === 'agents') {
      const tree = agentTree(s)
      render(tabBody, `g|${s.id}|${world.seq}|${Math.floor(now / 2000)}`, () => [h('div.mc-agents', null, ...(tree ? flatten(tree).map(({ a, depth }) => {
        const cur = a.activeTools.map((id) => s.tools[id]).filter((t): t is ToolCallState => !!t).pop()
        return h('div.ag', { style: `padding-left:${8 + depth * 14}px` },
          h('span.dot.' + a.status),
          h('span.nm', null, a.id === s.rootAgentId ? 'main' : a.name, a.role ? h('span.faint', null, ` ${a.role}`) : ''),
          h('span.num', null, `${a.toolCount} tools · ${formatCount(totalTokens(a.usage))}`),
          h('div.cur', null, a.status === 'waiting' ? `⏸ ${a.statusReason ?? 'waiting'} · ${formatDuration(now - a.statusSince)}` : cur ? `▸ ${cur.title}` : `${a.status} · ${formatAgo(a.lastActivityAt, now)}`),
        )
      }) : []))])
    } else {
      const files = hotFiles(s, 80)
      render(tabBody, `f|${s.id}|${Object.keys(s.files).length}|${files[0]?.lastTs}|${Math.floor(now / 10000)}`, () => [h('div.mc-files', null, ...(files.length ? files.map((f) => h('div.f', { title: f.path },
        h('code', null, shortPath(f.path, 4)),
        h('div.ops', null, ...(['read', 'search', 'edit', 'write', 'delete'] as const).map((op) => {
          const n = op === 'read' ? f.reads : op === 'search' ? f.searches : op === 'edit' ? f.edits : op === 'write' ? f.writes : f.deletes
          return n ? h('span', { style: `flex:${n};background:var(--c-${op === 'delete' ? 'shell' : op})`, title: `${n} ${op}` }) : ''
        })),
        h('span.when', null, formatAgo(f.lastTs, now).replace(' ago', '')),
      )) : [h('div.mc-empty', null, 'No files touched yet.')]))])
    }
  }

  // ─── Chrome: title badge, activity bar, status bar ────────────────────
  function renderChrome(world: WorldState, now: number): void {
    const open = attention.open()
    const urgent = open.filter((a) => a.severity === 'high').length
    const needs = open.filter((a) => a.severity !== 'low').length
    const badge = q('.mc-attn-badge')
    badge.className = 'mc-attn-badge' + (needs ? (urgent ? ' pulse' : ' medium') : ' none')
    badge.textContent = needs ? `⚑ ${needs} need${needs === 1 ? 's' : ''} you` : '✓ All clear'
    const count = q('.mc-act .count')
    count.hidden = !needs
    count.textContent = String(needs)
    const on = settings.get<boolean>('notify.desktop')
    bell.textContent = on ? '🔔' : '🔕'
    bell.classList.toggle('on', on)
    bell.title = on ? 'Desktop notifications on (click to turn off)' : 'Desktop notifications off (click to turn on)'

    const live = Object.values(world.sessions).filter(isLive).length
    const working = Object.values(world.sessions).reduce((n, s) => n + Object.values(s.agents).filter((a) => a.status === 'working').length, 0)
    const status = q('.mc-status')
    status.classList.toggle('offline', client.status !== 'live')
    const tokMin = tokenTimes.filter((t) => t.ts > now - 60_000).reduce((n, t) => n + t.n, 0)
    render(status, `${client.status}|${live}|${working}|${Object.keys(world.sessions).length}|${formatCount(tokMin)}|${vctx.theme()}|${on}|${settings.get('notify.sound')}`, () => [
      h('span', null, client.status === 'live' ? '● live' : `○ ${client.status}`),
      h('span', null, `${live} live / ${Object.keys(world.sessions).length} sessions`),
      h('span', null, `${working} agents working`),
      h('span.grow'),
      h('span', null, `${formatCount(tokMin)} tok/min`),
      h('button', { onclick: () => vctx.openSettings('notifications'), title: 'Notification settings' }, `${on ? '🔔' : '🔕'}${settings.get('notify.sound') ? ' ♪' : ''}`),
      h('button', { onclick: () => vctx.openSettings('appearance'), title: 'Theme' }, THEME_LABEL[vctx.theme()]),
      h('button', { onclick: () => vctx.openSettings(), title: 'Settings (Ctrl+,)' }, '⚙ Settings'),
    ])
  }

  // ─── Loop ─────────────────────────────────────────────────────────────
  let lastFrame = 0
  let lastSpark = 0
  d.add(attention.subscribe(() => { dirty = true }))
  d.loop((t) => {
    // Repaint text twice a second (timers) or when data changes; sparklines once a second.
    if (!dirty && t - lastFrame < 500) return
    dirty = false
    lastFrame = t
    const now = Date.now()
    const world = client.world
    const drawSpark = t - lastSpark > 1000
    if (drawSpark) lastSpark = t
    if (ui.view === 'overview') {
      if (!grid || !grid.isConnected) buildOverview()
      renderKpis(world, now)
      renderAttention(attnList!, world, now, false)
      renderGrid(world, now, drawSpark)
      renderFeed(world, now)
    } else if (ui.view === 'attention') {
      renderAttentionView(world, now)
    } else {
      renderLogView(world, now)
    }
    renderDetail(world, now)
    renderChrome(world, now)
  })

  setView('overview')
  setTab(ui.tab)
  return {
    destroy: () => { d.dispose(); root.replaceChildren() },
    focusSession: (sid: string) => { setView('overview'); select(sid) },
  }
}

function fact(v: string | number, k: string): HTMLElement {
  return h('div', null, h('b', null, String(v)), h('span', null, k))
}

function flatten(node: AgentNode, depth = 0, out: Array<{ a: AgentNode; depth: number }> = []): Array<{ a: AgentNode; depth: number }> {
  out.push({ a: node, depth })
  for (const c of node.childNodes) flatten(c, depth + 1, out)
  return out
}
