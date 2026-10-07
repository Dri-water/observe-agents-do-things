/**
 * Agent Office: an isometric diorama where every session is a room and every
 * agent a little blob. Fully self-contained: its own canvas, HUD, camera,
 * input and loop. It only *reads* protocol data from the client.
 */
import './office.css'
import {
  clip,
  contextFill,
  formatAgo,
  formatCount,
  formatDuration,
  isLive,
  mostRecentSession,
  recentChanges,
  sessionList,
  shortPath,
  totalTokens,
  type AttentionItem,
  type ChangeEntry,
  type ObserverEvent,
  type WorldState,
} from '@oadt/protocol'
import { h, render } from '../../shared/dom'
import { CATEGORY, harnessInfo } from '../../shared/theme'
import { buddySeed, face, LOOKS } from '../../shared/buddy'
import { KeyedList, tickTo } from '../../shared/motion'
import { Disposer, type Visualization, type VizContext } from '../types'
import { clamp } from '../../shared/dom'
import { iso } from './iso'
import { activityOf, Office, ROOM_D, ROOM_W } from './model'
import { attachEffects, daylight, getTimeMode, renderOffice, seatZ, setTimeMode, type Camera, type TimeMode } from './render'

export const office: Visualization = {
  id: 'office',
  name: 'Agent Office',
  description: 'A cosy isometric office: each session is a room, each agent a little blob at a desk.',
  icon: '⌂',
  settings: [
    { key: 'labels', label: 'Name tags', type: 'toggle', default: true, description: 'Show name tags under the blobs. Shortcut: L.' },
    { key: 'sidebar', label: 'Front desk sidebar', type: 'toggle', default: true, description: 'Attention queue, filed diffs and intercom in a sidebar next to the office. Shortcut: D.' },
    {
      key: 'lighting', label: 'Lighting', type: 'select', default: 'auto',
      description: 'Day and night follow your clock in auto mode. You can also click the clock in the office.',
      options: [{ value: 'auto', label: 'Follow my clock' }, { value: 'day', label: 'Always day' }, { value: 'night', label: 'Always night' }],
    },
  ],
  mount,
}

const ATTN_ICON: Record<AttentionItem['kind'], string> = { waiting: '⏸', errors: '✕', finished: '✓', aborted: '■', context: '◔', 'long-tool': '⧗' }

const TEMPLATE = `
<div class="of">
  <div class="of-stage">
    <canvas class="of-canvas"></canvas>
    <header class="of-top">
      <div class="of-brand"><span class="of-logo"><i></i><i></i><i></i></span><b>Agent Office</b><span class="of-clock"></span></div>
      <div class="of-stats"></div>
      <div class="of-actions">
        <button class="of-btn of-bell" title="Desktop notifications"></button>
        <button class="of-btn of-labels" title="Name tags (L)">name tags</button>
        <button class="of-btn of-sidebar" title="Front desk sidebar (D)">front desk</button>
        <button class="of-btn of-fit" title="Fit view (F)">⤢ fit</button>
      </div>
    </header>
    <nav class="of-rooms"></nav>
    <div class="of-card" hidden></div>
    <div class="of-empty" hidden>
      <div class="of-empty-art">☕</div>
      <h2>The office is quiet</h2>
      <p>Start a Claude Code or Codex session and your agents will clock in here.</p>
    </div>
  </div>
  <aside class="of-desk">
    <div class="of-desk-title"><span class="of-dot"></span>Front desk<span class="of-grow"></span><button class="of-clear" hidden title="Acknowledge everything (X)">clear all</button></div>
    <div class="of-attn"></div>
    <div class="of-allclear">✓ Nothing needs you</div>
    <div class="of-desk-sub" hidden>Filed diffs</div>
    <div class="of-diffs"></div>
    <div class="of-desk-sub">Intercom</div>
    <ol class="of-feed"></ol>
  </aside>
</div>`

function mount(root: HTMLElement, vctx: VizContext) {
  const d = new Disposer()
  root.innerHTML = TEMPLATE
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector(sel) as T
  const { client, settings, attention } = vctx
  q('.of-actions').prepend(vctx.controls)

  const canvas = q<HTMLCanvasElement>('.of-canvas')
  const ctx = canvas.getContext('2d')!
  const model = new Office()
  const cam: Camera = { x: 0, y: 0, zoom: 1.2 }
  const ui = {
    view: 'auto',
    autoFit: true,
    labels: true,
    hovered: undefined as string | undefined,
    selected: undefined as { room: string; char: string } | undefined,
  }
  ui.labels = settings.get<boolean>('office.labels')
  d.add(settings.on('office.labels', (v) => { ui.labels = v === true }))
  const of = q('.of')
  const stage = q('.of-stage')
  const sidebarBtn = q('.of-sidebar')
  function applySidebar(): void {
    const on = settings.get<boolean>('office.sidebar')
    of.classList.toggle('no-desk', !on)
    sidebarBtn.classList.toggle('on', on)
  }
  applySidebar()
  d.add(settings.on('office.sidebar', applySidebar))
  d.listen(sidebarBtn, 'click', () => settings.set('office.sidebar', !settings.get<boolean>('office.sidebar')))

  let pending: ObserverEvent[] = []
  let dirty = true
  const toolTimes: number[] = []
  const intercom: ObserverEvent[] = []

  d.add(client.onChange((_world, events) => {
    pending.push(...events)
    dirty = true
    for (const e of events) {
      if (e.kind === 'tool.started') toolTimes.push(Date.now())
      if (notable(e)) intercom.push(e)
    }
    if (toolTimes.length > 4000) toolTimes.splice(0, 2000)
    if (intercom.length > 60) intercom.splice(0, intercom.length - 40)
  }))

  function visibleSessions(world: WorldState): string[] {
    if (ui.view !== 'auto') return world.sessions[ui.view] ? [ui.view] : []
    const live = sessionList(world).filter(isLive).slice(0, 4).sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1)).map((s) => s.id)
    if (live.length) return live
    const recent = mostRecentSession(world)
    return recent ? [recent.id] : []
  }

  // ─── Camera ───────────────────────────────────────────────────────────

  function roomBounds() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const r of model.rooms.values()) {
      for (const [x, y, z] of [[r.ox - 0.3, r.oy - 0.3, 3.4], [r.ox + ROOM_W, r.oy - 0.3, 3.4], [r.ox - 0.3, r.oy + ROOM_D, 3.4], [r.ox + ROOM_W, r.oy + ROOM_D, -0.4], [r.ox - 0.3, r.oy + ROOM_D, -0.4]] as const) {
        const p = iso(x, y, z)
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
      }
    }
    return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : undefined
  }

  function fit(dt: number): void {
    const b = roomBounds()
    if (!b) return
    const w = canvas.clientWidth, hh = canvas.clientHeight
    const padTop = 80, padBottom = w < 760 ? 60 : 70
    const zoom = clamp(Math.min((w - 40) / (b.maxX - b.minX), (hh - padTop - padBottom) / (b.maxY - b.minY)), 0.35, 2.4)
    const cx = (b.minX + b.maxX) / 2
    const cy = (b.minY + b.maxY) / 2 - (padTop - padBottom) / 2 / zoom
    const k = Math.min(1, dt * 3)
    cam.zoom += (zoom - cam.zoom) * k
    cam.x += (cx - cam.x) * k
    cam.y += (cy - cam.y) * k
  }

  function toScreen(x: number, y: number, z: number): { x: number; y: number } {
    const p = iso(x, y, z)
    return { x: (p.x - cam.x) * cam.zoom + canvas.clientWidth / 2, y: (p.y - cam.y) * cam.zoom + canvas.clientHeight / 2 }
  }

  function pick(clientX: number, clientY: number): { room: string; char: string } | undefined {
    const r = canvas.getBoundingClientRect()
    const mx = clientX - r.left, my = clientY - r.top
    let best: { room: string; char: string; d: number } | undefined
    for (const room of model.rooms.values()) for (const c of room.chars.values()) {
      const p = toScreen(room.ox + c.x, room.oy + c.y, seatZ(c.mode))
      const cy = p.y - 24 * cam.zoom
      const dist = Math.hypot(mx - p.x, my - cy)
      if (dist < 27 * cam.zoom && (!best || dist < best.d)) best = { room: room.id, char: c.id, d: dist }
    }
    return best && { room: best.room, char: best.char }
  }

  // ─── Input ────────────────────────────────────────────────────────────

  let drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | undefined
  d.listen(canvas, 'pointerdown', (e: Event) => {
    const pe = e as PointerEvent
    drag = { x: pe.clientX, y: pe.clientY, cx: cam.x, cy: cam.y, moved: false }
    canvas.setPointerCapture(pe.pointerId)
  })
  d.listen(canvas, 'pointermove', (e: Event) => {
    const pe = e as PointerEvent
    if (drag) {
      const dx = pe.clientX - drag.x, dy = pe.clientY - drag.y
      if (Math.abs(dx) + Math.abs(dy) > 4) { drag.moved = true; ui.autoFit = false; canvas.classList.add('dragging') }
      if (drag.moved) { cam.x = drag.cx - dx / cam.zoom; cam.y = drag.cy - dy / cam.zoom }
      return
    }
    const hit = pick(pe.clientX, pe.clientY)
    ui.hovered = hit?.char
    canvas.style.cursor = hit ? 'pointer' : ''
  })
  d.listen(canvas, 'pointerup', (e: Event) => {
    const pe = e as PointerEvent
    canvas.classList.remove('dragging')
    const moved = drag?.moved
    drag = undefined
    if (moved) return
    ui.selected = pick(pe.clientX, pe.clientY)
    renderCard()
  })
  d.listen(canvas, 'wheel', (e: Event) => {
    const we = e as WheelEvent
    we.preventDefault()
    ui.autoFit = false
    const r = canvas.getBoundingClientRect()
    const mx = we.clientX - r.left - r.width / 2, my = we.clientY - r.top - r.height / 2
    const before = { x: mx / cam.zoom + cam.x, y: my / cam.zoom + cam.y }
    cam.zoom = clamp(cam.zoom * Math.exp(-we.deltaY * 0.0015), 0.3, 4)
    cam.x = before.x - mx / cam.zoom
    cam.y = before.y - my / cam.zoom
  }, { passive: false })
  d.listen(canvas, 'pointerleave', () => { ui.hovered = undefined })

  const labelsBtn = q('.of-labels')
  const toggleLabels = () => settings.set('office.labels', !ui.labels)
  d.listen(labelsBtn, 'click', toggleLabels)
  const timeParam = new URLSearchParams(location.search).get('time') as TimeMode | null
  setTimeMode(timeParam ?? settings.get<TimeMode>('office.lighting'))
  d.add(settings.on('office.lighting', (v) => { setTimeMode(v as TimeMode); renderTop(Date.now()) }))
  const clockEl = q('.of-clock')
  clockEl.title = 'Lighting: click to switch between auto, day and night'
  clockEl.style.cursor = 'pointer'
  d.listen(clockEl, 'click', () => {
    const mode = getTimeMode()
    settings.set('office.lighting', mode === 'auto' ? 'day' : mode === 'day' ? 'night' : 'auto')
  })
  d.add(() => setTimeMode('auto'))
  d.listen(q('.of-fit'), 'click', () => { ui.autoFit = true })

  // Desktop notifications, same toggle as Mission Control's bell.
  const bell = q('.of-bell')
  d.listen(bell, 'click', async () => {
    if (settings.get<boolean>('notify.desktop')) return settings.set('notify.desktop', false)
    if ((await attention.requestPermission()) === 'granted') settings.set('notify.desktop', true)
    else vctx.openSettings('notifications')
  })
  d.listen(q('.of-clear'), 'click', () => attention.ackAll())

  /** The rooms you can cycle through with J/K: all live, then each recent session. */
  const roomChoices = () => ['auto', ...sessionList(client.world).filter((s) => isLive(s) || Date.now() - s.lastActivityAt < 3 * 3600_000).slice(0, 10).map((s) => s.id)]
  d.listen(window, 'keydown', (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.metaKey || e.ctrlKey || e.altKey) return
    switch (e.key) {
      case 'f': case 'F': ui.autoFit = true; break
      case 'l': case 'L': toggleLabels(); break
      case 'a': case 'A': setView('auto'); break
      case 'x': case 'X': attention.ackAll(); break
      case 'd': case 'D': settings.set('office.sidebar', !settings.get<boolean>('office.sidebar')); break
      case 'j': case 'k': case 'J': case 'K': {
        const choices = roomChoices()
        const i = Math.max(0, choices.indexOf(ui.view))
        const next = choices[(i + (e.key.toLowerCase() === 'j' ? 1 : choices.length - 1)) % choices.length]
        if (next) setView(next)
        break
      }
      case 'Escape': ui.selected = undefined; renderCard(); break
    }
  })

  function setView(v: string): void {
    ui.view = v
    ui.autoFit = true
    ui.selected = undefined
    renderCard()
    renderRooms()
  }

  /** Bring a session's room (and optionally one of its agents) into view. */
  function focus(sessionId: string, agentId?: string): void {
    if (!model.rooms.has(sessionId)) setView(sessionId)
    else ui.autoFit = true
    if (agentId) {
      ui.selected = { room: sessionId, char: agentId }
      renderCard()
    }
  }

  // ─── HUD ──────────────────────────────────────────────────────────────

  const roomsEl = q('.of-rooms')
  let pressingRooms = false
  d.listen(roomsEl, 'pointerdown', () => { pressingRooms = true })
  d.listen(window, 'pointerup', () => { setTimeout(() => { pressingRooms = false }, 0) })

  function renderRooms(): void {
    if (pressingRooms) return
    const world = client.world
    const urgent = new Set(attention.open().filter((a) => a.severity === 'high').map((a) => a.sessionId))
    const list = sessionList(world).filter((s) => isLive(s) || Date.now() - s.lastActivityAt < 3 * 3600_000).slice(0, 10)
    roomsEl.replaceChildren(
      h('button.of-room' + (ui.view === 'auto' ? '.on' : ''), { onclick: () => setView('auto') }, h('span.of-room-dot.live'), 'All live rooms'),
      ...list.map((s) => h('button.of-room' + (ui.view === s.id ? '.on' : '') + (urgent.has(s.id) ? '.urgent' : ''), { onclick: () => setView(s.id), title: s.meta.cwd ?? s.id, style: `--hc:${harnessInfo(s.harness).color}` },
        h('span.of-room-dot.' + (urgent.has(s.id) ? 'waiting' : s.status)),
        clip(s.meta.title ?? s.meta.project ?? s.id.slice(0, 8), 26),
      )),
    )
  }

  let chrome: 'light' | 'dark' | undefined
  const stats = { working: h('b'), needs: h('b'), perMin: h('b'), tokens: h('b') }
  q('.of-stats').append(
    h('span.of-sticky.yellow', null, stats.working, 'at work'),
    h('span.of-sticky.orange', { hidden: true }, stats.needs, 'need you'),
    h('span.of-sticky.blue', null, stats.perMin, 'tasks/min'),
    h('span.of-sticky.pink', null, stats.tokens, 'tokens'),
  )
  const needsSticky = stats.needs.parentElement as HTMLElement
  needsSticky.title = 'Show the front desk'
  d.listen(needsSticky, 'click', () => { settings.set('office.sidebar', true); q('.of-desk').scrollTo({ top: 0, behavior: 'smooth' }) })

  function renderTop(now: number): void {
    const world = client.world
    const day = daylight()
    const t = new Date()
    q('.of-clock').textContent = `${day > 0.5 ? '☀' : '☾'} ${t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${getTimeMode() === 'auto' ? '' : ` · ${getTimeMode()}`}`
    const theme = day > 0.5 ? 'light' : 'dark'
    if (theme !== chrome) { chrome = theme; vctx.setChromeTheme(theme); root.firstElementChild?.classList.toggle('night', theme === 'dark') }
    let working = 0, tokens = 0
    for (const id of model.rooms.keys()) {
      const s = world.sessions[id]
      if (!s) continue
      tokens += totalTokens(s.usage)
      for (const a of Object.values(s.agents)) if (a.status === 'working') working++
    }
    const needs = attention.open().filter((a) => a.severity !== 'low').length
    let perMin = 0
    for (let i = toolTimes.length - 1; i >= 0 && toolTimes[i]! > now - 60_000; i--) perMin++
    tickTo(stats.working, working)
    tickTo(stats.needs, needs)
    needsSticky.hidden = !needs
    tickTo(stats.perMin, perMin)
    tickTo(stats.tokens, tokens, formatCount)
    const on = settings.get<boolean>('notify.desktop')
    bell.textContent = on ? '🔔' : '🔕'
    bell.classList.toggle('on', on)
    bell.title = on ? 'Desktop notifications on (click to turn off)' : 'Desktop notifications off (click to turn on)'
    q('.of-empty').hidden = Object.keys(world.sessions).length > 0
  }

  // ─── Front desk: what needs you, then the intercom ────────────────────
  const sessionName = (id: string) => { const s = client.world.sessions[id]; return s?.meta.title ?? s?.meta.project ?? id.slice(0, 8) }
  const attnList = new KeyedList<AttentionItem>(q('.of-attn'), {
    key: (i) => i.id,
    create: (i) => h('div.of-attn-row.' + i.severity, { onclick: () => focus(i.sessionId, i.agentId), title: i.detail ?? '' },
      h('span.of-attn-ico', null, ATTN_ICON[i.kind]),
      h('div.of-attn-txt', null, h('b', null, i.title), h('span', null, sessionName(i.sessionId))),
      h('span.of-attn-age'),
      h('button.of-ack', { onclick: (e: Event) => { e.stopPropagation(); attention.ack(i.id) }, title: 'Acknowledge' }, '✓'),
    ),
    update: (el, i) => { el.querySelector('.of-attn-age')!.textContent = formatDuration(Date.now() - i.since) },
    flashClass: 'of-flash',
    collapse: true,
  })
  const feed = new KeyedList<ObserverEvent>(q('.of-feed'), {
    key: (e) => String(e.seq),
    create: (e) => {
      const s = client.world.sessions[e.sessionId]
      const who = !s ? 'agent' : e.agentId === s.rootAgentId ? 'lead' : s.agents[e.agentId]?.name ?? 'agent'
      return h('li', { onclick: () => focus(e.sessionId, e.agentId) },
        h('span.of-who', { style: `color:${harnessInfo(s?.harness ?? 'claude-code').color}` }, clip(who, 16)),
        h('span', null, describe(e)),
      )
    },
    flashClass: 'of-flash',
    collapse: true,
  })
  // Filed diffs: a change shows up here once its bubble has flown over from the room.
  const DIFF_LINES = 4
  const expanded = new Set<string>()
  const agentName = (sid: string, aid: string) => { const s = client.world.sessions[sid]; return !s ? 'agent' : aid === s.rootAgentId ? 'lead' : s.agents[aid]?.name ?? 'agent' }
  function fillDiff(card: HTMLElement, c: ChangeEntry): void {
    const full = expanded.has(c.key)
    const lines = full ? c.change.lines.slice(0, 60) : c.change.lines.slice(0, DIFF_LINES)
    const body = card.querySelector('.of-diff-body') as HTMLElement
    body.replaceChildren(...lines.map((l) => {
      const kind = l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : l[0] === '@' ? 'gap' : 'ctx'
      return h('div.ln.' + kind, null, kind === 'gap' ? '⋯' : l.slice(1) || ' ')
    }))
    if (c.change.op === 'delete' && !lines.length) body.replaceChildren(h('div.ln.gap', null, 'file deleted'))
    const hidden = c.change.lines.length - lines.length
    const more = card.querySelector('.of-diff-more') as HTMLElement
    more.hidden = !(hidden > 0 || (full && c.change.lines.length > DIFF_LINES))
    more.textContent = hidden > 0 ? `${hidden} more line${hidden === 1 ? '' : 's'}${c.change.truncated ? ' (truncated)' : ''}` : 'show less'
  }
  const diffs = new KeyedList<ChangeEntry>(q('.of-diffs'), {
    key: (c) => c.key,
    create: (c) => {
      const s = client.world.sessions[c.sessionId]
      const op = c.change.op === 'write' ? 'write' : c.change.op === 'delete' ? 'shell' : 'edit'
      const card = h('div.of-diff', { style: `--op:${CATEGORY[op].color}`, onclick: () => { if (expanded.has(c.key)) expanded.delete(c.key); else expanded.add(c.key); fillDiff(card, c) } },
        h('div.of-diff-head', null,
          h('i'),
          h('code', { title: c.change.path }, shortPath(c.change.path, 3)),
          h('span.add', null, `+${c.change.added}`), h('span.del', null, `−${c.change.removed}`),
          face(buddySeed(c.sessionId, c.agentId, s?.rootAgentId), 14),
          h('span.who', null, clip(agentName(c.sessionId, c.agentId), 14)),
          h('span.age'),
        ),
        h('div.of-diff-body'),
        h('div.of-diff-more'),
      )
      fillDiff(card, c)
      return card
    },
    update: (el, c) => { el.querySelector('.age')!.textContent = c.tool.ok === false ? 'failed' : formatAgo(c.ts).replace(' ago', '') },
    flashClass: 'of-flash',
    collapse: true,
  })

  function renderDesk(): void {
    const now = Date.now()
    const open = attention.open()
    attnList.sync(open)
    q('.of-allclear').hidden = open.length > 0
    q('.of-clear').hidden = open.length === 0
    const changes = recentChanges(client.world, 20, model.rooms.keys())
      .filter((c) => c.tool.endedAt !== undefined && (model.filedAt.get(c.key) ?? 0) <= now)
      .slice(0, 8)
    q('.of-desk-sub').hidden = changes.length === 0
    diffs.sync(changes)
    feed.sync(intercom.filter((e) => model.rooms.has(e.sessionId)).slice(-10).reverse())
  }
  d.add(attention.subscribe(() => { renderDesk(); renderRooms() }))

  // ─── Card ─────────────────────────────────────────────────────────────
  const card = q('.of-card')
  function renderCard(): void {
    const sel = ui.selected
    const s = sel ? client.world.sessions[sel.room] : undefined
    const a = s && sel ? s.agents[sel.char] : undefined
    const room = sel ? model.rooms.get(sel.room) : undefined
    const c = room && sel ? room.chars.get(sel.char) : undefined
    if (!s || !a || !c || !room) { card.hidden = true; return }
    const now = Date.now()
    const act = activityOf(s, a, now)
    const recent = s.toolOrder.map((id) => s.tools[id]).filter((t) => t && t.agentId === a.id).slice(-4).reverse()
    const changes = recentChanges(client.world, 40, [s.id]).filter((ch) => ch.agentId === a.id).slice(0, 3)
    const isRoot = a.id === s.rootAgentId
    const mood = LOOKS[act.activity].label
    const actLabel = act.activity === 'waiting' ? `needs you${act.tool ? `: ${act.tool.title}` : ''}` : act.tool ? `${mood}: ${act.tool.title}` : mood
    const fill = contextFill(s)
    card.replaceChildren(
      h('div.of-card-head', null,
        h('span.of-avatar', null, face(c.seed, 40)),
        h('div', null,
          h('b', null, isRoot ? (s.meta.title ?? 'Team lead') : a.name),
          h('div.of-muted', null, [isRoot ? 'team lead' : a.role ?? 'subagent', harnessInfo(s.harness).label, a.model ?? s.meta.model].filter(Boolean).join(' · ')),
        ),
        h('button.of-x', { onclick: () => { ui.selected = undefined; renderCard() }, 'aria-label': 'Close' }, '×'),
      ),
      h('div.of-status.' + a.status + '.act-' + act.activity, null, actLabel),
      a.task && !isRoot ? h('p.of-task', null, clip(a.task, 160)) : '',
      isRoot
        ? h('div.of-card-stats.six', null,
          h('span', null, h('b', null, String(s.counts.turns)), 'turns'),
          h('span', null, h('b', null, formatCount(s.counts.tools)), 'tools'),
          h('span', null, h('b', null, String(s.counts.toolErrors)), 'failed'),
          h('span', null, h('b', null, formatCount(totalTokens(s.usage))), 'tokens'),
          h('span', null, h('b', null, s.meta.costUsd !== undefined ? `$${s.meta.costUsd.toFixed(2)}` : '—'), 'cost'),
          h('span', null, h('b', null, fill !== undefined ? `${Math.round(fill * 100)}%` : '—'), 'context'))
        : h('div.of-card-stats', null,
          h('span', null, h('b', null, String(a.toolCount)), 'tools'),
          h('span', null, h('b', null, String(a.errorCount)), 'failed'),
          h('span', null, h('b', null, formatCount(totalTokens(a.usage))), 'tokens'),
          h('span', null, h('b', null, formatAgo(a.startedAt, now).replace(' ago', '')), 'on shift')),
      isRoot && fill !== undefined ? h('div.of-ctx' + (fill > 0.85 ? '.full' : fill > 0.6 ? '.hot' : ''), { title: `context window ${Math.round(fill * 100)}% full` }, h('i', { style: `width:${Math.round(fill * 100)}%` })) : '',
      isRoot && (s.meta.gitBranch || s.meta.cwd) ? h('div.of-muted.of-where', { title: s.meta.cwd ?? '' }, [s.meta.cwd ? shortPath(s.meta.cwd, 2) : '', s.meta.gitBranch].filter(Boolean).join(' · ')) : '',
      changes.length ? h('ul.of-changes', null, ...changes.map((ch) => h('li', { title: ch.change.path },
        h('i', { style: `background:${CATEGORY[ch.change.op === 'write' ? 'write' : ch.change.op === 'delete' ? 'shell' : 'edit'].color}` }),
        h('code', null, shortPath(ch.change.path, 2)),
        h('span.add', null, `+${ch.change.added}`), h('span.del', null, `−${ch.change.removed}`),
      ))) : '',
      recent.length ? h('ul.of-recent', null, ...recent.map((t) => h('li', null,
        h('i', { style: `background:${CATEGORY[t!.category]?.color ?? '#999'}` }),
        h('span', null, clip(t!.title, 46)),
        h('em', null, t!.endedAt === undefined ? 'now' : t!.ok ? formatDuration(t!.durationMs ?? 0) : 'failed'),
      ))) : '',
    )
    card.hidden = false
    const p = toScreen(room.ox + c.x, room.oy + c.y, seatZ(c.mode))
    const cw = card.offsetWidth || 280, ch = card.offsetHeight || 200
    const x = clamp(p.x + 30, 12, canvas.clientWidth - cw - 12)
    const y = clamp(p.y - ch / 2 - 20, 70, canvas.clientHeight - ch - 12)
    card.style.transform = `translate(${x}px, ${y}px)`
  }

  // ─── Loop ─────────────────────────────────────────────────────────────

  let last = performance.now()
  let lastHud = 0
  let visible: string[] = []
  d.loop((t) => {
    const dt = Math.min(0.1, (t - last) / 1000)
    last = t
    const now = Date.now()
    const world = client.world
    const ids = visibleSessions(world)
    if (ids.join('|') !== visible.join('|')) {
      visible = ids
      model.layout(ids, world)
      dirty = true
      renderRooms()
    }
    if (dirty || Math.floor(t / 500) !== Math.floor((t - dt * 1000) / 500)) {
      model.sync(world, pending, now)
      pending = []
      dirty = false
    }
    model.step(dt, now)
    attachEffects(model)

    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth, hh = canvas.clientHeight
    // The stage shrinks when the sidebar is open: compact the HUD before it wraps.
    stage.classList.toggle('narrow', w < 1040)
    stage.classList.toggle('tiny', w < 720)
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hh * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(hh * dpr)
    }
    if (ui.autoFit) fit(dt)
    // Filed diffs fly to the sidebar's diff list (or off the right edge when the sidebar is hidden).
    const diffsEl = q('.of-diffs')
    const dr = diffsEl.offsetParent ? diffsEl.getBoundingClientRect() : undefined
    const cr = canvas.getBoundingClientRect()
    const tx = dr ? dr.left - cr.left + 30 : w + 40, ty = dr ? clamp(dr.top - cr.top + 24, 60, hh - 40) : hh / 2
    const fileTarget = { x: (tx - w / 2) / cam.zoom + cam.x, y: (ty - hh / 2) / cam.zoom + cam.y }
    renderOffice(ctx, model, world, cam, w, hh, dpr, now, { hovered: ui.hovered, selected: ui.selected?.char, labels: ui.labels, fileTarget })
    labelsBtn.classList.toggle('on', ui.labels)

    if (t - lastHud > 400) {
      lastHud = t
      renderTop(now)
      renderDesk()
      renderRooms()
      if (ui.selected) renderCard()
    }
  })

  return {
    destroy: () => { d.dispose(); root.replaceChildren() },
    focusSession: (sid: string) => focus(sid),
  }
}

function notable(e: ObserverEvent): boolean {
  if (e.kind === 'message') return e.role === 'user' || e.role === 'assistant'
  if (e.kind === 'tool.finished') return !e.ok
  if (e.kind === 'agent.spawned' || e.kind === 'turn.ended') return true
  if (e.kind === 'agent.status') return e.status === 'waiting'
  return false
}

function describe(e: ObserverEvent): string {
  switch (e.kind) {
    case 'message': return e.role === 'user' ? `📨 ${clip(e.text, 80)}` : `💬 ${clip(e.text, 80)}`
    case 'tool.finished': return `💥 something failed${e.output ? `: ${clip(e.output.split('\n')[0] ?? '', 50)}` : ''}`
    case 'agent.spawned': return `🙋 new hire: ${e.name}${e.role ? ` (${e.role})` : ''}`
    case 'turn.ended': return e.outcome === 'completed' ? '🎉 finished the task' : `✋ turn ${e.outcome}`
    case 'agent.status': return `⏸ needs you — ${clip(e.reason ?? 'waiting', 60)}`
    default: return e.kind
  }
}
