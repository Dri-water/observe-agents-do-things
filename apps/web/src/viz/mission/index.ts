/**
 * Mission Control: a compact, IDE-style dashboard built for answering
 * "does anything need me, and what is changing right now?".
 *
 * The main screen only holds live material: KPIs and throughput, the attention
 * queue, session tiles, a live diff feed and the activity log. Zoomed-in
 * session detail opens in a drawer on demand (and can be pinned).
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
  recentChanges,
  agentActivity,
  sessionActivity,
  sessionList,
  shortPath,
  totalTokens,
  type AgentNode,
  type AttentionItem,
  type ChangeEntry,
  type ObserverEvent,
  type SessionState,
  type ToolCallState,
  type ToolCategory,
  type WorldState,
} from '@oadt/protocol'
import { resolveTheme, THEME_SETTING } from '../../host/settings'
import { h, render } from '../../shared/dom'
import { fadeSwap, KeyedList, tickTo, typeOut } from '../../shared/motion'
import { CATEGORY, harnessInfo } from '../../shared/theme'
import { buddySeed, createBuddy, face, LOOKS, type Buddy } from '../../shared/buddy'
import { Disposer, type ThemeName, type Visualization, type VizContext } from '../types'
import { heartbeat, stackedArea } from './charts'

export const mission: Visualization = {
  id: 'mission',
  name: 'Mission Control',
  description: 'A compact, practical dashboard: what needs you, what is changing, and how fast.',
  icon: '▦',
  settings: [
    { ...THEME_SETTING, description: 'Dark Modern, Light Modern or Gruvbox. Also in the title bar.' },
    {
      key: 'scope', label: 'Sessions shown', type: 'select', default: 'recent',
      options: [{ value: 'live', label: 'Live only' }, { value: 'recent', label: 'Live and last 3 hours' }, { value: 'all', label: 'Everything loaded' }],
    },
    { key: 'pinDetail', label: 'Keep the detail panel open', type: 'toggle', default: false, description: 'Dock session detail on the right instead of opening it as a drawer.' },
    {
      key: 'detailTab', label: 'Default detail tab', type: 'select', default: 'activity',
      options: [{ value: 'activity', label: 'Activity' }, { value: 'diffs', label: 'Diffs' }, { value: 'chat', label: 'Chat' }, { value: 'agents', label: 'Agents' }, { value: 'files', label: 'Files' }],
    },
  ],
  mount,
}

type View = 'overview' | 'attention' | 'log'
type Tab = 'activity' | 'diffs' | 'chat' | 'agents' | 'files'

const CATEGORIES = Object.keys(CATEGORY) as ToolCategory[]
const ATTN_ICON: Record<AttentionItem['kind'], string> = { waiting: '⏸', errors: '✕', finished: '✓', aborted: '■', context: '◔', 'long-tool': '⧗' }
const SPAN_MAX = 15 * 60_000
const BUCKETS = 60
const PULSE_MS = 90_000
const DIFF_PREVIEW = 10
const CREW_MAX = 5

const TEMPLATE = `
<div class="mc">
  <header class="mc-title">
    <div class="mc-brand"><span class="mc-logo"></span>Mission Control</div>
    <button class="mc-attn-badge"></button>
    <span class="mc-conn" role="status" hidden></span>
    <div class="mc-search"><input type="search" placeholder="Filter sessions (/)" spellcheck="false" aria-label="Filter sessions" /></div>
  </header>
  <nav class="mc-act" aria-label="Views">
    <button data-view="overview" title="Overview">▦</button>
    <button data-view="attention" title="Needs attention">⚑<span class="count" hidden></span></button>
    <button data-view="log" title="Activity log (all sessions)">≡</button>
  </nav>
  <main class="mc-main"></main>
  <div class="mc-scrim"></div>
  <aside class="mc-drawer" aria-label="Session detail">
    <div class="mc-drawer-bar">
      <span class="mc-drawer-title">Session</span>
      <button class="mc-iconbtn mc-pin" title="Keep open"></button>
      <button class="mc-iconbtn mc-close" title="Close (Esc)" aria-label="Close">×</button>
    </div>
    <div class="mc-detail-head"><span class="mc-hero"></span><div class="mc-detail-info"></div></div>
    <nav class="mc-tabs">
      <button data-tab="activity">Activity</button>
      <button data-tab="diffs">Diffs</button>
      <button data-tab="chat">Chat</button>
      <button data-tab="agents">Agents</button>
      <button data-tab="files">Files</button>
    </nav>
    <div class="mc-tab-body"></div>
  </aside>
</div>`

interface Tile {
  el: HTMLElement
  dot: HTMLElement
  title: HTMLElement
  badge: HTMLElement
  age: HTMLElement
  meta: HTMLElement
  now: HTMLElement
  pulse: HTMLCanvasElement
  stats: HTMLElement
  buddy: Buddy
  crew: HTMLElement
  crewBuddies: Map<string, Buddy>
}

function mount(root: HTMLElement, vctx: VizContext) {
  const d = new Disposer()
  const { client, settings, attention } = vctx
  root.innerHTML = TEMPLATE
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector(sel) as T
  const mc = q('.mc')
  q('.mc-act').append(vctx.controls)

  /** Set whenever something on screen may have changed; the loop repaints and clears it. */
  let dirty = true
  const ui = {
    view: 'overview' as View,
    tab: settings.get<string>('mission.detailTab') as Tab,
    selected: undefined as string | undefined,
    drawerOpen: false,
    search: '',
    expanded: new Set<string>(),
  }

  // ─── Theme ────────────────────────────────────────────────────────────
  let colors: Record<string, string> = {}
  let theme: ThemeName = 'dark'
  function refreshTheme(): void {
    theme = resolveTheme(settings.get<string>('mission.theme'))
    mc.dataset.theme = theme
    vctx.setChromeTheme(theme)
    const cs = getComputedStyle(mc)
    const get = (n: string) => cs.getPropertyValue(n).trim()
    colors = { grid: get('--border'), text: get('--fg-faint'), accent: get('--accent'), ok: get('--ok'), warn: get('--warn'), err: get('--err'), claude: get('--claude'), codex: get('--codex'), faint: get('--fg-faint') }
    for (const c of CATEGORIES) colors[c] = get(`--c-${c}`)
    dirty = true
  }
  refreshTheme()
  d.add(settings.on('mission.theme', refreshTheme))
  d.listen(matchMedia('(prefers-color-scheme: light)'), 'change', refreshTheme)

  // ─── Live data for charts ─────────────────────────────────────────────
  const toolStarts: Array<{ ts: number; cat: ToolCategory; sid: string }> = []
  const tokenTimes: Array<{ ts: number; n: number }> = []
  for (const s of Object.values(client.world.sessions)) for (const id of s.toolOrder) {
    const t = s.tools[id]
    if (t && t.startedAt > Date.now() - SPAN_MAX) toolStarts.push({ ts: t.startedAt, cat: t.category, sid: s.id })
  }
  toolStarts.sort((a, b) => a.ts - b.ts)
  const chats = new Map<string, ObserverEvent[]>()
  d.add(client.onChange((_w, events) => {
    for (const e of events) {
      if (e.kind === 'tool.started') toolStarts.push({ ts: e.ts, cat: e.category, sid: e.sessionId })
      if (e.kind === 'usage') tokenTimes.push({ ts: e.ts, n: e.delta.input + e.delta.output + e.delta.cacheWrite })
      if (e.kind === 'message') chats.get(e.sessionId)?.push(e)
    }
    const cutoff = Date.now() - SPAN_MAX
    while (toolStarts.length && toolStarts[0]!.ts < cutoff) toolStarts.shift()
    while (tokenTimes.length && tokenTimes[0]!.ts < cutoff) tokenTimes.shift()
    dirty = true
  }))

  // ─── Drawer ───────────────────────────────────────────────────────────

  const pinBtn = q('.mc-pin')
  const pinned = () => settings.get<boolean>('mission.pinDetail')
  function applyDrawer(): void {
    const isPinned = pinned()
    mc.classList.toggle('pinned', isPinned)
    mc.classList.toggle('drawer-open', !isPinned && ui.drawerOpen)
    pinBtn.textContent = isPinned ? '⇥' : '⇤'
    pinBtn.title = isPinned ? 'Unpin (open as a drawer)' : 'Pin to the side'
    pinBtn.setAttribute('aria-pressed', String(isPinned))
  }
  function openSession(sid: string, tab?: Tab): void {
    select(sid)
    if (tab) setTab(tab)
    ui.drawerOpen = true
    applyDrawer()
  }
  function closeDrawer(): void {
    ui.drawerOpen = false
    applyDrawer()
  }
  pinBtn.addEventListener('click', () => settings.set('mission.pinDetail', !pinned()))
  q('.mc-close').addEventListener('click', () => (pinned() ? settings.set('mission.pinDetail', false) : closeDrawer()))
  q('.mc-scrim').addEventListener('click', closeDrawer)
  d.add(settings.on('mission.pinDetail', () => { ui.drawerOpen = pinned() || ui.drawerOpen; applyDrawer() }))
  applyDrawer()

  // ─── Selection & navigation ───────────────────────────────────────────
  function select(sid: string | undefined): void {
    if (ui.selected === sid) return
    ui.selected = sid
    if (sid && !chats.has(sid)) {
      chats.set(sid, [])
      client.sessionEvents(sid).then((evs) => {
        const live = chats.get(sid) ?? []
        const seen = new Set(live.map((e) => e.seq))
        chats.set(sid, [...evs.filter((e) => e.kind === 'message' && !seen.has(e.seq)), ...live].sort((a, b) => a.seq - b.seq))
        tabBody.dataset.key = ''
        dirty = true
      }).catch(() => { /* history is optional */ })
    }
    tabBody.dataset.key = ''
    dirty = true
  }
  function setView(v: View): void {
    ui.view = v
    for (const b of root.querySelectorAll<HTMLElement>('.mc-act [data-view]')) b.classList.toggle('on', b.dataset.view === v)
    main.replaceChildren()
    main.dataset.key = ''
    overview = undefined
    dirty = true
  }
  function setTab(t: Tab): void {
    if (ui.tab !== t) fadeSwap(tabBody)
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
      case 'Enter': if (ui.selected) openSession(ui.selected); break
      case 'Escape': if (ui.drawerOpen && !pinned()) closeDrawer(); break
      case '1': setTab('activity'); break
      case '2': setTab('diffs'); break
      case '3': setTab('chat'); break
      case '4': setTab('agents'); break
      case '5': setTab('files'); break
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
  const sessionName = (s: SessionState | undefined, fallback: string) => s?.meta.title ?? s?.meta.project ?? fallback.slice(0, 8)
  const agentName = (s: SessionState, id: string) => (id === s.rootAgentId ? 'main' : s.agents[id]?.name ?? id.slice(0, 6))

  // ─── Overview ─────────────────────────────────────────────────────────
  const main = q('.mc-main')
  interface Overview {
    kpi: Record<'live' | 'liveOf' | 'working' | 'needs' | 'perMin' | 'tokMin' | 'errors', HTMLElement>
    kpiCells: Record<'needs' | 'errors' | 'live', HTMLElement>
    throughput: HTMLCanvasElement
    throughputLabel: HTMLElement
    attnWrap: HTMLElement
    attnCount: HTMLElement
    attn: KeyedList<AttentionItem>
    tiles: KeyedList<SessionState>
    tileParts: Map<string, Tile>
    scopeBtns: HTMLElement[]
    diffs: KeyedList<ChangeEntry>
    diffEmpty: HTMLElement
    activity: KeyedList<{ t: ToolCallState; s: SessionState }>
    activityEmpty: HTMLElement
  }
  let overview: Overview | undefined

  function kpiCell(label: string, ...value: HTMLElement[]): HTMLElement {
    return h('div.mc-kpi', null, h('div.v', null, ...value), h('div.k', null, label))
  }

  function buildOverview(): Overview {
    const kpi = {
      live: h('span'), liveOf: h('span.faint'), working: h('span'), needs: h('span'), perMin: h('span'), tokMin: h('span'), errors: h('span'),
    }
    const kpiCells = {
      live: kpiCell('live sessions', kpi.live, kpi.liveOf),
      needs: kpiCell('need you', kpi.needs),
      errors: kpiCell('errors · 10m', kpi.errors),
    }
    const throughput = h('canvas') as HTMLCanvasElement
    const throughputLabel = h('span.lbl')
    const attnList = h('div.mc-attn-list')
    const attnCount = h('span.faint')
    const attnWrap = h('section.mc-section.mc-attn-wrap', null,
      h('div.mc-section-head', null, 'Needs attention', attnCount, h('span.grow'), h('button', { onclick: () => attention.ackAll(), title: 'Acknowledge everything (X)' }, 'Clear all')),
      attnList,
      h('div.mc-allclear', null, '✓ Nothing needs you right now'),
    )
    const grid = h('div.mc-grid')
    const tileParts = new Map<string, Tile>()
    const scopeBtns = (['live', 'recent', 'all'] as const).map((sc) =>
      h('button', { onclick: () => settings.set('mission.scope', sc), 'data-scope': sc }, sc === 'live' ? 'Live' : sc === 'recent' ? 'Recent' : 'All'))
    const diffList = h('div.mc-diffs')
    const diffEmpty = h('div.mc-empty', null, 'Edits will stream in here as agents change files.')
    const activityList = h('div.mc-rows')
    const activityEmpty = h('div.mc-empty', null, 'No tool calls yet.')

    main.replaceChildren(
      h('section.mc-kpis', null,
        kpiCells.live, kpiCell('agents working', kpi.working), kpiCells.needs,
        kpiCell('tools / min', kpi.perMin), kpiCell('tokens / min', kpi.tokMin), kpiCells.errors,
        h('div.mc-throughput', null, throughputLabel, throughput),
      ),
      attnWrap,
      h('section.mc-section', null, h('div.mc-section-head', null, 'Sessions', h('span.grow'), ...scopeBtns), grid),
      h('section.mc-split', null,
        h('div.mc-pane', null, h('div.mc-section-head', null, 'Live diffs', h('span.grow'), h('span.faint', null, 'click a card to expand')), h('div.mc-pane-body', null, diffEmpty, diffList)),
        h('div.mc-pane', null, h('div.mc-section-head', null, 'Activity', h('span.grow'), h('button', { onclick: () => setView('log') }, 'Open log')), h('div.mc-pane-body', null, activityEmpty, activityList)),
      ),
    )

    const attn = new KeyedList<AttentionItem>(attnList, {
      key: (i) => i.id,
      create: (i) => attentionRow(i),
      update: (el, i) => {
        el.classList.toggle('acked', attention.isAcked(i.id))
        el.querySelector('.age')!.textContent = formatDuration(Date.now() - i.since)
      },
      flashClass: 'mo-flash',
      collapse: true,
    })
    const tiles = new KeyedList<SessionState>(grid, {
      key: (s) => s.id,
      create: (s) => tileFor(s, tileParts).el,
      update: (_el, s) => updateTile(tileParts.get(s.id)!, s, Date.now()),
      flashClass: 'mo-flash',
    })
    const diffs = new KeyedList<ChangeEntry>(diffList, {
      key: (c) => c.key,
      create: (c) => {
        const card = diffCard(c, true)
        // Changes that arrive while you watch are replayed as if typed; the backlog shows at once.
        if (diffsPrimed) typing.set(card, typeOut(Array.from(card.querySelectorAll<HTMLElement>('.ln')), {
          instant: (el) => !el.classList.contains('add') && !el.classList.contains('del'),
          struck: (el) => el.classList.contains('del'),
        }))
        return card
      },
      update: (el, c) => updateDiffCard(el, c),
      flashClass: 'mo-flash',
      collapse: true,
    })
    const activity = new KeyedList<{ t: ToolCallState; s: SessionState }>(activityList, {
      key: (r) => r.t.id,
      create: (r) => activityRow(r),
      update: (el, r) => updateActivityRow(el, r),
      flashClass: 'mo-flash',
      collapse: true,
    })
    return { kpi, kpiCells, throughput, throughputLabel, attnWrap, attnCount, attn, tiles, tileParts, scopeBtns, diffs, diffEmpty, activity, activityEmpty }
  }

  function renderOverview(o: Overview, world: WorldState, now: number): void {
    // KPIs tick between values.
    let live = 0, working = 0, errors = 0
    for (const s of Object.values(world.sessions)) {
      if (isLive(s)) live++
      for (const a of Object.values(s.agents)) if (a.status === 'working') working++
      for (const id of s.toolOrder) {
        const t = s.tools[id]
        if (t?.ok === false && (t.endedAt ?? 0) > now - 10 * 60_000) errors++
      }
    }
    const needs = attention.open().filter((a) => a.severity !== 'low').length
    const perMin = toolStarts.filter((t) => t.ts > now - 60_000).length
    const tokMin = tokenTimes.filter((t) => t.ts > now - 60_000).reduce((n, t) => n + t.n, 0)
    tickTo(o.kpi.live, live)
    o.kpi.liveOf.textContent = `/${Object.keys(world.sessions).length}`
    tickTo(o.kpi.working, working)
    tickTo(o.kpi.needs, needs)
    tickTo(o.kpi.perMin, perMin)
    tickTo(o.kpi.tokMin, tokMin, formatCount)
    tickTo(o.kpi.errors, errors)
    o.kpiCells.live.className = 'mc-kpi' + (live ? ' ok' : '')
    o.kpiCells.needs.className = 'mc-kpi' + (needs ? ' warn' : '')
    o.kpiCells.errors.className = 'mc-kpi' + (errors ? ' err' : '')

    // Attention collapses to a single line when there is nothing to do.
    const open = attention.open()
    o.attnWrap.classList.toggle('is-empty', open.length === 0)
    o.attnCount.textContent = open.length ? ` · ${open.length}` : ''
    o.attn.sync(open)

    const sessions = visibleSessions(world)
    if (!ui.selected && sessions[0]) select(sessions[0].id)
    o.tiles.sync(sessions)
    for (const b of o.scopeBtns) b.classList.toggle('on', b.dataset.scope === settings.get('mission.scope'))

    const ids = sessions.map((s) => s.id)
    const changes = recentChanges(world, 30, ids)
    o.diffEmpty.hidden = changes.length > 0
    o.diffs.sync(changes)
    diffsPrimed = true

    const rows = ids.flatMap((id) => sessionRows(world.sessions[id]!, 40))
      .sort((a, b) => Number(b.t.endedAt === undefined) - Number(a.t.endedAt === undefined) || b.t.startedAt - a.t.startedAt).slice(0, 60)
    o.activityEmpty.hidden = rows.length > 0
    o.activity.sync(rows)
  }

  // Canvases redraw every frame so they scroll smoothly.
  function drawCanvases(o: Overview, world: WorldState, now: number): void {
    const age = now - (toolStarts[0]?.ts ?? now)
    const span = Math.min(SPAN_MAX, Math.max(2 * 60_000, Math.ceil(age / 60_000) * 60_000))
    const bucketMs = span / BUCKETS
    const end = Math.ceil(now / bucketMs) * bucketMs
    const start = end - span
    const xs = Array.from({ length: BUCKETS }, (_, i) => ((start + (i + 1) * bucketMs) - (now - span)) / span)
    const series = CATEGORIES.map((c) => {
      const values = new Array<number>(BUCKETS).fill(0)
      for (const t of toolStarts) {
        if (t.cat !== c || t.ts < start) continue
        values[Math.min(BUCKETS - 1, Math.floor((t.ts - start) / bucketMs))]!++
      }
      return { values, color: colors[c] ?? colors.accent! }
    })
    stackedArea(o.throughput, series, { grid: colors.grid!, text: colors.text!, xs, label: (m) => `peak ${m} per ${Math.round(bucketMs / 1000)}s` })
    const cost = Object.values(world.sessions).reduce((n, s) => n + (s.meta.costUsd ?? 0), 0)
    const label = `Tool calls · last ${Math.round(span / 60_000)} min${cost ? ` · $${cost.toFixed(2)} reported` : ''}`
    if (o.throughputLabel.textContent !== label) o.throughputLabel.textContent = label

    for (const [sid, t] of o.tileParts) {
      const s = world.sessions[sid]
      if (!s || !t.el.isConnected) continue
      const beats = toolStarts.filter((x) => x.sid === sid && x.ts > now - PULSE_MS).map((x) => ({ ts: x.ts, color: colors[x.cat] ?? colors.accent! }))
      const line = s.harness === 'codex' ? colors.codex! : s.harness === 'claude-code' ? colors.claude! : colors.accent!
      heartbeat(t.pulse, beats, now, PULSE_MS, { line, idle: colors.faint!, active: s.status === 'working' || s.status === 'waiting' })
    }
  }

  // ─── Attention rows ───────────────────────────────────────────────────
  function attentionRow(item: AttentionItem): HTMLElement {
    const s = client.world.sessions[item.sessionId]
    return h('div.mc-attn.' + item.severity, { onclick: () => openSession(item.sessionId, item.kind === 'finished' ? 'chat' : item.kind === 'errors' ? 'activity' : undefined), title: item.detail ?? '' },
      h('span.ico', null, ATTN_ICON[item.kind]),
      h('div.txt', null, h('b', null, item.title), h('span.sess', null, sessionName(s, item.sessionId)), item.detail ? h('span.det', null, item.detail.replace(/\s+/g, ' ')) : ''),
      h('span.age', null, formatDuration(Date.now() - item.since)),
      h('div.acts', null,
        h('button', { onclick: (e: Event) => { e.stopPropagation(); attention.ack(item.id) }, title: 'Acknowledge' }, '✓')),
    )
  }

  // ─── Session tiles ────────────────────────────────────────────────────
  function tileFor(s: SessionState, parts: Map<string, Tile>): Tile {
    const dot = h('span.dot'), title = h('span.ttl'), badge = h('span.badge'), age = h('span.faint.mono')
    const meta = h('div.r2'), now = h('div.now'), pulse = h('canvas.pulse') as HTMLCanvasElement, stats = h('div.r5'), crew = h('span.crew')
    const buddy = createBuddy(s.id, { size: 52, prop: true })
    const el = h('div.mc-tile', { onclick: () => openSession(s.id), tabindex: '0' },
      h('div.hd', null, h('span.me', null, buddy.el), h('div.info', null, h('div.r1', null, dot, title, badge, age), meta, now)),
      pulse, h('div.r6', null, crew, stats))
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') openSession(s.id) })
    const t = { el, dot, title, badge, age, meta, now, pulse, stats, buddy, crew, crewBuddies: new Map<string, Buddy>() }
    parts.set(s.id, t)
    return t
  }

  /** Little buddies for the subagents that are busy right now. */
  function syncCrew(t: Tile, s: SessionState, now: number): void {
    const busy = Object.values(s.agents)
      .filter((a) => a.id !== s.rootAgentId && (a.status === 'working' || a.status === 'waiting'))
      .sort((a, b) => a.startedAt - b.startedAt)
    const shown = busy.slice(0, CREW_MAX)
    for (const [id] of t.crewBuddies) if (!shown.some((a) => a.id === id)) t.crewBuddies.delete(id)
    const els: Array<HTMLElement | string> = shown.map((a) => {
      let b = t.crewBuddies.get(a.id)
      if (!b) { b = createBuddy(buddySeed(s.id, a.id, s.rootAgentId), { size: 22 }); t.crewBuddies.set(a.id, b) }
      const act = agentActivity(s, a, now)
      b.set(act)
      b.el.title = `${a.name}: ${LOOKS[act].label}`
      return b.el
    })
    const more = busy.length - shown.length
    if (more > 0) els.push(`+${more}`)
    const same = els.length === t.crew.childNodes.length && els.every((e, i) => typeof e === 'string' ? t.crew.childNodes[i]!.textContent === e : t.crew.childNodes[i] === e)
    if (!same) t.crew.replaceChildren(...els)
  }

  function updateTile(t: Tile, s: SessionState, now: number): void {
    const hc = harnessInfo(s.harness)
    t.el.className = `mc-tile st-${s.status}${s.id === ui.selected && (ui.drawerOpen || pinned()) ? ' sel' : ''}${openTools(s).length ? ' running' : ''}`
    t.dot.className = `dot ${s.status}`
    t.title.textContent = sessionName(s, s.id)
    t.badge.className = `badge ${s.harness}`
    t.badge.textContent = hc.short
    t.age.textContent = formatAgo(s.lastActivityAt, now).replace(' ago', '')
    t.meta.textContent = [s.meta.project, s.meta.gitBranch, s.meta.model].filter(Boolean).join(' · ') || shortPath(s.meta.cwd ?? s.id, 2)
    const act = sessionActivity(s, now)
    t.buddy.set(act)
    t.buddy.el.title = LOOKS[act].label
    syncCrew(t, s, now)

    const waiting = Object.values(s.agents).find((a) => a.status === 'waiting')
    const running = openTools(s).filter((x) => x.category !== 'agent')
    const tool = running[running.length - 1]
    if (waiting) {
      t.now.className = 'now waiting'
      render(t.now, `w|${waiting.statusSince}|${Math.floor(now / 1000)}`, () => [h('span', null, '⏸'), h('span.t', null, waiting.statusReason ?? 'waiting for approval'), h('span.el', null, formatDuration(now - waiting.statusSince))])
    } else if (tool) {
      t.now.className = 'now'
      render(t.now, `t|${tool.id}|${Math.floor(now / 1000)}|${running.length}`, () => [
        h('span.chip', { style: `--c:var(--c-${tool.category})` }, CATEGORY[tool.category]?.label ?? tool.category),
        h('span.t', null, tool.title),
        h('span.el', null, `${formatDuration(now - tool.startedAt)}${running.length > 1 ? ` +${running.length - 1}` : ''}`),
      ])
    } else {
      const thinking = Object.values(s.agents).some((a) => a.thinking)
      const label = thinking ? 'thinking…' : s.status === 'working' ? 'working' : s.turn.outcome === 'completed' && s.turn.endedAt ? `finished ${formatAgo(s.turn.endedAt, now)}` : `idle ${formatAgo(s.lastActivityAt, now)}`
      t.now.className = 'now'
      render(t.now, `i|${label}`, () => [h('span.t.dim', null, label)])
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

  // ─── Diff cards ───────────────────────────────────────────────────────
  function diffCard(c: ChangeEntry, interactive: boolean): HTMLElement {
    const s = client.world.sessions[c.sessionId]
    const body = h('div.mc-diff-body')
    const more = h('button.mc-diff-more')
    const card = h('div.mc-diff', { 'data-op': c.change.op },
      h('div.mc-diff-head', { onclick: interactive ? () => toggleDiff(c.key) : undefined },
        h('span.chip', { style: `--c:var(--c-${c.change.op === 'write' ? 'write' : c.change.op === 'delete' ? 'shell' : 'edit'})` }, c.change.op),
        h('code.path', { title: c.change.path }, shortPath(c.change.path, 3)),
        h('span.add', null, `+${c.change.added}`), h('span.del', null, `−${c.change.removed}`),
        h('span.who', null, face(buddySeed(c.sessionId, c.agentId, s?.rootAgentId), 14), `${s ? agentName(s, c.agentId) : c.agentId} · ${sessionName(s, c.sessionId)}`),
        h('span.age.faint'),
        interactive ? h('button.mc-open', { onclick: (e: Event) => { e.stopPropagation(); openSession(c.sessionId, 'diffs') }, title: 'Open session' }, '↗') : '',
      ),
      body,
      more,
    )
    if (interactive) more.addEventListener('click', () => toggleDiff(c.key))
    else more.remove()
    fillDiff(card, c, !interactive || ui.expanded.has(c.key))
    updateDiffCard(card, c)
    return card
  }

  /** Cards whose lines are still being typed out, with the function that finishes them. */
  const typing = new WeakMap<HTMLElement, () => void>()
  let diffsPrimed = false

  function fillDiff(card: HTMLElement, c: ChangeEntry, full: boolean): void {
    typing.get(card)?.()
    typing.delete(card)
    const lines = full ? c.change.lines : c.change.lines.slice(0, DIFF_PREVIEW)
    const body = card.querySelector('.mc-diff-body') as HTMLElement
    body.replaceChildren(...lines.map((l) => {
      const kind = l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : l[0] === '@' ? 'gap' : 'ctx'
      return h('div.ln.' + kind, null, kind === 'gap' ? '⋯' : l.slice(1) || ' ')
    }))
    if (c.change.op === 'delete' && !lines.length) body.replaceChildren(h('div.ln.gap', null, 'file deleted'))
    const hidden = c.change.lines.length - lines.length
    const more = card.querySelector('.mc-diff-more') as HTMLElement | null
    if (!more) return
    more.hidden = !(hidden > 0 || (full && c.change.lines.length > DIFF_PREVIEW))
    more.textContent = hidden > 0 ? `${hidden} more line${hidden === 1 ? '' : 's'}${c.change.truncated ? ' (truncated)' : ''}` : 'show less'
  }

  function toggleDiff(key: string): void {
    const full = !ui.expanded.has(key)
    if (full) ui.expanded.add(key)
    else ui.expanded.delete(key)
    const card = overview?.diffs.element(key)
    const entry = card ? recentChanges(client.world, 60).find((c) => c.key === key) : undefined
    if (card && entry) {
      const from = card.offsetHeight
      fillDiff(card, entry, full)
      const to = card.offsetHeight
      card.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' })
    }
  }

  function updateDiffCard(card: HTMLElement, c: ChangeEntry): void {
    card.classList.toggle('running', c.tool.endedAt === undefined)
    card.classList.toggle('failed', c.tool.ok === false)
    const age = card.querySelector('.age') as HTMLElement
    const label = c.tool.endedAt === undefined ? 'applying…' : c.tool.ok === false ? 'failed' : formatAgo(c.ts).replace(' ago', '')
    if (age.textContent !== label) age.textContent = label
  }

  // ─── Activity rows ────────────────────────────────────────────────────
  function activityRow(r: { t: ToolCallState; s: SessionState }): HTMLElement {
    const { t, s } = r
    return h('div.mc-row', { onclick: () => openSession(s.id, 'activity'), title: t.title },
      h('span.time', null, new Date(t.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })),
      h('span.chip', { style: `--c:var(--c-${t.category})` }, CATEGORY[t.category]?.label ?? t.category),
      h('span.title', null, t.title),
      h('span.who', null, face(buddySeed(s.id, t.agentId, s.rootAgentId), 14), `${agentName(s, t.agentId)} · ${sessionName(s, s.id)}`),
      h('span.dur'),
    )
  }

  function updateActivityRow(el: HTMLElement, r: { t: ToolCallState; s: SessionState }): void {
    const t = r.t
    const running = t.endedAt === undefined
    el.classList.toggle('running', running)
    el.classList.toggle('failed', t.ok === false)
    const dur = el.querySelector('.dur') as HTMLElement
    render(dur, running ? `r|${Math.floor((Date.now() - t.startedAt) / 1000)}` : `d|${t.ok}`, () => running
      ? [h('span.spin'), ' ', formatDuration(Date.now() - t.startedAt)]
      : [t.ok === false ? `✕ ${formatDuration(t.durationMs ?? 0)}` : formatDuration(t.durationMs ?? 0)])
  }

  function sessionRows(s: SessionState, limit: number): Array<{ t: ToolCallState; s: SessionState }> {
    const all = s.toolOrder.map((id) => s.tools[id]).filter((t): t is ToolCallState => !!t)
    const running = all.filter((t) => t.endedAt === undefined)
    const done = all.filter((t) => t.endedAt !== undefined).sort((a, b) => b.startedAt - a.startedAt)
    return [...running, ...done].slice(0, limit).map((t) => ({ t, s }))
  }

  // ─── Full-page views ──────────────────────────────────────────────────
  function logTable(rows: Array<{ t: ToolCallState; s: SessionState }>, now: number, withSession: boolean): HTMLElement {
    const body: HTMLElement[] = []
    for (const { t, s } of rows) {
      const running = t.endedAt === undefined
      body.push(h('tr.row' + (running ? '.running' : '') + (t.ok === false ? '.failed' : ''), { onclick: () => { toggleRow(t.id) } },
        h('td.time', null, new Date(t.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })),
        withSession ? h('td', null, sessionName(s, s.id)) : '',
        h('td', null, agentName(s, t.agentId)),
        h('td', null, h('span.chip', { style: `--c:var(--c-${t.category})` }, CATEGORY[t.category]?.label ?? t.category)),
        h('td.title', { title: t.title }, t.title),
        h('td.dur.st', null, running ? h('span', null, h('span.spin'), ' ', formatDuration(now - t.startedAt)) : t.ok === false ? `✕ ${formatDuration(t.durationMs ?? 0)}` : formatDuration(t.durationMs ?? 0)),
      ))
      if (ui.expanded.has(t.id)) {
        const input = t.input === undefined ? '' : typeof t.input === 'string' ? t.input : JSON.stringify(t.input, null, 2)
        body.push(h('tr.expand', null, h('td', { colspan: withSession ? 6 : 5 },
          input ? h('pre', null, input) : '',
          t.output ? h('pre' + (t.ok === false ? '.bad' : ''), null, t.output) : h('div.faint', null, running ? 'Running…' : 'No output recorded.'),
        )))
      }
    }
    return h('table.mc-log', null,
      h('thead', null, h('tr', null,
        h('th', { style: 'width:74px' }, 'Time'),
        withSession ? h('th', { style: 'width:22%' }, 'Session') : '',
        h('th', { style: 'width:16%' }, 'Agent'),
        h('th', { style: 'width:64px' }, 'Kind'),
        h('th', null, 'Call'),
        h('th', { style: 'width:70px' }, 'Took'),
      )),
      h('tbody', null, ...body))
  }
  function toggleRow(id: string): void {
    if (ui.expanded.has(id)) ui.expanded.delete(id)
    else ui.expanded.add(id)
    tabBody.dataset.key = ''
    main.dataset.key = ''
    dirty = true
  }

  function renderLogView(world: WorldState, now: number): void {
    const rows = visibleSessions(world).flatMap((s) => sessionRows(s, 120))
      .sort((a, b) => Number(b.t.endedAt === undefined) - Number(a.t.endedAt === undefined) || b.t.startedAt - a.t.startedAt).slice(0, 400)
    render(main, `log|${world.seq}|${ui.expanded.size}|${Math.floor(now / 1000)}`, () => [h('section.mc-section', null, h('div.mc-section-head', null, 'Activity · all sessions', h('span.grow'), h('span.faint', null, `${rows.length} calls`)), logTable(rows, now, true))])
  }

  let attnView: KeyedList<AttentionItem> | undefined
  function renderAttentionView(): void {
    if (!attnView || !main.firstChild) {
      const list = h('div.mc-attn-list')
      main.replaceChildren(h('section.mc-section', null,
        h('div.mc-section-head', null, 'Needs attention', h('span.grow'),
          h('button', { onclick: () => attention.ackAll() }, 'Acknowledge all'),
          h('button', { onclick: () => vctx.openSettings('notifications') }, 'Notification settings…')),
        list))
      attnView = new KeyedList<AttentionItem>(list, {
        key: (i) => i.id,
        create: (i) => {
          const row = attentionRow(i)
          const acts = row.querySelector('.acts')!
          acts.replaceChildren(h('button', { onclick: (e: Event) => { e.stopPropagation(); attention.isAcked(i.id) ? attention.unack(i.id) : attention.ack(i.id) }, title: 'Acknowledge or restore' }, '✓ / ↺'))
          return row
        },
        update: (el, i) => {
          el.classList.toggle('acked', attention.isAcked(i.id))
          el.querySelector('.age')!.textContent = formatDuration(Date.now() - i.since)
        },
        collapse: true,
      })
    }
    const items = attention.all()
    attnView.sync(items)
    if (!items.length && !main.querySelector('.mc-empty')) main.firstElementChild!.append(h('div.mc-empty.ok', null, 'Nothing needs you right now.'))
    if (items.length) main.querySelector('.mc-empty')?.remove()
  }

  // ─── Drawer content ───────────────────────────────────────────────────
  const detailHead = q('.mc-detail-info')
  const heroSlot = q('.mc-hero')
  const tabBody = q('.mc-tab-body')
  let hero: { sid: string; buddy: Buddy } | undefined
  /** Agent rows in the Agents tab, kept across repaints so their buddies keep animating. */
  let agentRows: KeyedList<{ a: AgentNode; depth: number }> | undefined

  function renderDetail(world: WorldState, now: number): void {
    const s = ui.selected ? world.sessions[ui.selected] : undefined
    q('.mc-drawer-title').textContent = s ? sessionName(s, s.id) : 'Session'
    if (!s) {
      render(detailHead, 'none', () => [h('div.mc-noselect', null, 'Select a session')])
      render(tabBody, 'none', () => [])
      heroSlot.replaceChildren()
      hero = undefined
      return
    }
    if (hero?.sid !== s.id) {
      hero = { sid: s.id, buddy: createBuddy(s.id, { size: 64, prop: true }) }
      heroSlot.replaceChildren(hero.buddy.el)
    }
    const act = sessionActivity(s, now)
    hero.buddy.set(act)
    const fill = s.contextTokens && s.contextWindow ? Math.round((s.contextTokens / s.contextWindow) * 100) : undefined
    render(detailHead, `${s.id}|${s.status}|${act}|${s.counts.tools}|${s.counts.turns}|${s.counts.toolErrors}|${formatCount(totalTokens(s.usage))}|${s.meta.costUsd}|${fill}|${Math.floor((now - s.statusSince) / 1000)}`, () => [
      h('div.mc-mood.act-' + act, null, LOOKS[act].label),
      h('div.dim', null, h('span.dot.' + s.status), ` ${harnessInfo(s.harness).label} · ${s.status} for ${formatDuration(now - s.statusSince)}`),
      h('div.faint.mono', { title: s.meta.cwd ?? '' }, [s.meta.cwd ? shortPath(s.meta.cwd, 3) : '', s.meta.gitBranch, s.meta.model].filter(Boolean).join(' · ')),
      h('div.mc-facts', null,
        fact(s.counts.turns, 'turns'), fact(s.counts.tools, 'tools'), fact(s.counts.toolErrors, 'failed'),
        fact(formatCount(totalTokens(s.usage)), 'tokens'), fact(s.meta.costUsd !== undefined ? `$${s.meta.costUsd.toFixed(2)}` : '—', 'cost'), fact(fill !== undefined ? `${fill}%` : '—', 'context')),
    ])

    if (ui.tab === 'activity') {
      render(tabBody, `a|${s.id}|${s.counts.tools}|${openTools(s).length}|${ui.expanded.size}|${Math.floor(now / 1000)}|${s.toolOrder[s.toolOrder.length - 1]}`, () => [logTable(sessionRows(s, 200), now, false)])
    } else if (ui.tab === 'diffs') {
      const changes = recentChanges(world, 80, [s.id])
      render(tabBody, `d|${s.id}|${changes.length}|${changes[0]?.key}|${changes[0]?.tool.endedAt}`, () => [h('div.mc-diffs.static', null, ...(changes.length ? changes.map((c) => diffCard(c, false)) : [h('div.mc-empty', null, 'No edits in this session yet.')]))])
    } else if (ui.tab === 'chat') {
      const msgs = (chats.get(s.id) ?? []).filter((e): e is Extract<ObserverEvent, { kind: 'message' }> => e.kind === 'message').slice(-120)
      const atBottom = tabBody.scrollHeight - tabBody.scrollTop - tabBody.clientHeight < 40
      const key = `c|${s.id}|${msgs.length}`
      const changed = tabBody.dataset.key !== key
      render(tabBody, key, () => [h('div.mc-chat', null, ...(msgs.length ? msgs.map((m) => {
        const who = m.agentId === s.rootAgentId ? (m.role === 'user' ? 'you' : 'main') : `${s.agents[m.agentId]?.name ?? 'agent'}${m.role === 'agent' ? ' · task' : ''}`
        return h('div.mc-msg.' + m.role, null, h('div.who', null, h('span', null, who), h('span', null, new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))), m.text)
      }) : [h('div.mc-empty', null, 'No messages yet.')]))])
      if (changed && atBottom) tabBody.scrollTop = tabBody.scrollHeight
    } else if (ui.tab === 'agents') {
      const tree = agentTree(s)
      render(tabBody, `g|${s.id}`, () => {
        const box = h('div.mc-agents')
        const buddies = new Map<string, Buddy>()
        const sid = s.id
        agentRows = new KeyedList(box, {
            key: (r) => r.a.id,
            create: ({ a, depth }) => {
              const b = createBuddy(buddySeed(s.id, a.id, s.rootAgentId), { size: 30 })
              buddies.set(a.id, b)
              return h('div.ag', { style: `padding-left:${8 + depth * 16}px` },
                b.el,
                h('span.nm', null, a.id === s.rootAgentId ? 'main' : a.name, a.role ? h('span.faint', null, ` ${a.role}`) : ''),
                h('span.num'),
                h('div.cur'),
              )
            },
            update: (el, { a }) => {
              const sess = client.world.sessions[sid] ?? s
              const t = Date.now()
              const act = agentActivity(sess, a, t)
              buddies.get(a.id)?.set(act)
              const cur = a.activeTools.map((id) => sess.tools[id]).filter((x): x is ToolCallState => !!x).pop()
              setText(el.querySelector('.num')!, `${a.toolCount} tools · ${formatCount(totalTokens(a.usage))}`)
              setText(el.querySelector('.cur')!, a.status === 'waiting'
                ? `${LOOKS[act].label} · ${a.statusReason ?? 'waiting'} · ${formatDuration(t - a.statusSince)}`
                : cur ? `${LOOKS[act].label} · ${cur.title}` : `${LOOKS[act].label} · ${formatAgo(a.lastActivityAt, t)}`)
            },
            flashClass: 'mo-flash',
            collapse: true,
        })
        return [box]
      })
      agentRows?.sync(tree ? flatten(tree) : [])
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

  // ─── Chrome: title badge, activity bar, connection ────────────────────
  const conn = q('.mc-conn')
  function renderChrome(world: WorldState, now: number): void {
    const open = attention.open()
    const urgent = open.filter((a) => a.severity === 'high').length
    const needs = open.filter((a) => a.severity !== 'low').length
    const badge = q('.mc-attn-badge')
    badge.className = 'mc-attn-badge' + (needs ? (urgent ? ' pulse' : ' medium') : ' none')
    const badgeText = needs ? `⚑ ${needs} need${needs === 1 ? 's' : ''} you` : '✓ All clear'
    if (badge.textContent !== badgeText) badge.textContent = badgeText
    const count = q('.mc-act .count')
    count.hidden = !needs
    count.textContent = String(needs)

    // Only shown when something is wrong: a live connection needs no label.
    conn.hidden = client.status === 'live'
    const connText = client.status === 'reconnecting' ? 'Reconnecting…' : client.status === 'connecting' ? 'Connecting…' : 'Disconnected'
    if (conn.textContent !== connText) conn.textContent = connText
  }

  // ─── Loop ─────────────────────────────────────────────────────────────
  let lastDom = 0
  let lastCanvas = 0
  d.add(attention.subscribe(() => { dirty = true }))
  d.loop((t) => {
    const now = Date.now()
    const world = client.world
    if (ui.view === 'overview') {
      if (!overview) overview = buildOverview()
      // Canvases at ~30fps so the charts glide.
      if (t - lastCanvas > 33) {
        lastCanvas = t
        drawCanvases(overview, world, now)
      }
    }
    // DOM twice a second (timers), or as soon as data changes.
    if (!dirty && t - lastDom < 500) return
    dirty = false
    lastDom = t
    if (ui.view === 'overview') renderOverview(overview!, world, now)
    else if (ui.view === 'attention') renderAttentionView()
    else renderLogView(world, now)
    if (ui.drawerOpen || pinned()) renderDetail(world, now)
    renderChrome(world, now)
  })

  setView('overview')
  setTab(ui.tab)
  return {
    destroy: () => { d.dispose(); root.replaceChildren() },
    focusSession: (sid: string) => { setView('overview'); openSession(sid) },
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


function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text
}
