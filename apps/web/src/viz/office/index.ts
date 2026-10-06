/**
 * Agent Office: an isometric diorama where every session is a room and every
 * agent is a little worker. Fully self-contained: its own canvas, HUD, camera,
 * input and loop. It only *reads* protocol data from the client.
 */
import './office.css'
import {
  formatAgo,
  formatCount,
  formatDuration,
  isLive,
  mostRecentSession,
  sessionList,
  totalTokens,
  type ObserverEvent,
  type WorldState,
} from '@oadt/protocol'
import { h, render } from '../../shared/dom'
import { CATEGORY, harnessInfo } from '../../shared/theme'
import { Disposer, type Visualization, type VizContext } from '../types'
import { clamp, iso } from './iso'
import { activityOf, Office, ROOM_D, ROOM_W } from './model'
import { attachEffects, clip, daylight, getTimeMode, renderOffice, setTimeMode, type Camera, type TimeMode } from './render'

export const office: Visualization = {
  id: 'office',
  name: 'Agent Office',
  description: 'A cosy isometric office: each session is a room, each agent a little worker at a desk.',
  mount,
}

const TEMPLATE = `
<div class="of">
  <canvas class="of-canvas"></canvas>
  <header class="of-top">
    <div class="of-brand"><span class="of-logo"><i></i><i></i><i></i></span><b>Agent Office</b><span class="of-clock"></span></div>
    <div class="of-stats"></div>
    <div class="of-actions"><button class="of-btn of-labels" title="Name tags (L)">name tags</button><button class="of-btn of-fit" title="Fit view (F)">⤢ fit</button></div>
  </header>
  <nav class="of-rooms"></nav>
  <aside class="of-intercom"><div class="of-intercom-title"><span class="of-dot"></span>Intercom</div><ol></ol></aside>
  <div class="of-card" hidden></div>
  <div class="of-empty" hidden>
    <div class="of-empty-art">☕</div>
    <h2>The office is quiet</h2>
    <p>Start a Claude Code or Codex session and your agents will clock in here.</p>
  </div>
</div>`

function mount(root: HTMLElement, vctx: VizContext) {
  const d = new Disposer()
  root.innerHTML = TEMPLATE
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector(sel) as T
  const client = vctx.client
  q('.of-actions').prepend(vctx.switcher)

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
  try { ui.labels = localStorage.getItem('oadt-office-labels') !== '0' } catch { /* ignore */ }

  let pending: ObserverEvent[] = []
  let dirty = true
  const toolTimes: number[] = []
  const intercom: ObserverEvent[] = []

  d.add(client.onChange((world, events) => {
    pending.push(...events)
    dirty = true
    for (const e of events) {
      if (e.kind === 'tool.started') toolTimes.push(Date.now())
      if (notable(e, world)) intercom.push(e)
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
      const z = c.mode === 'seated' ? 0.43 : c.mode === 'lounging' ? 0.36 : 0
      const p = toScreen(room.ox + c.x, room.oy + c.y, z)
      const cy = p.y - 26 * cam.zoom
      const dist = Math.hypot(mx - p.x, my - cy)
      if (dist < 24 * cam.zoom && (!best || dist < best.d)) best = { room: room.id, char: c.id, d: dist }
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
  const toggleLabels = () => {
    ui.labels = !ui.labels
    try { localStorage.setItem('oadt-office-labels', ui.labels ? '1' : '0') } catch { /* ignore */ }
  }
  d.listen(labelsBtn, 'click', toggleLabels)
  const params = new URLSearchParams(location.search)
  let mode = (params.get('time') as TimeMode | null) ?? (() => { try { return (localStorage.getItem('oadt-office-time') as TimeMode | null) ?? 'auto' } catch { return 'auto' } })()
  setTimeMode(mode)
  const clockEl = q('.of-clock')
  clockEl.title = 'Lighting: click to switch between auto, day and night'
  clockEl.style.cursor = 'pointer'
  d.listen(clockEl, 'click', () => {
    mode = mode === 'auto' ? 'day' : mode === 'day' ? 'night' : 'auto'
    setTimeMode(mode)
    try { localStorage.setItem('oadt-office-time', mode) } catch { /* ignore */ }
    renderTop(Date.now())
  })
  d.add(() => setTimeMode('auto'))
  d.listen(q('.of-fit'), 'click', () => { ui.autoFit = true })
  d.listen(window, 'keydown', (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === 'f' || e.key === 'F') ui.autoFit = true
    if (e.key === 'l' || e.key === 'L') toggleLabels()
    if (e.key === 'a' || e.key === 'A') setView('auto')
    if (e.key === 'Escape') { ui.selected = undefined; renderCard() }
  })

  function setView(v: string): void {
    ui.view = v
    ui.autoFit = true
    ui.selected = undefined
    renderCard()
    renderRooms()
  }

  // ─── HUD ──────────────────────────────────────────────────────────────

  const roomsEl = q('.of-rooms')
  let pressingRooms = false
  d.listen(roomsEl, 'pointerdown', () => { pressingRooms = true })
  d.listen(window, 'pointerup', () => { setTimeout(() => { pressingRooms = false }, 0) })

  function renderRooms(): void {
    if (pressingRooms) return
    const world = client.world
    const list = sessionList(world).filter((s) => isLive(s) || Date.now() - s.lastActivityAt < 3 * 3600_000).slice(0, 10)
    roomsEl.replaceChildren(
      h('button.of-room' + (ui.view === 'auto' ? '.on' : ''), { onclick: () => setView('auto') }, h('span.of-room-dot.live'), 'All live rooms'),
      ...list.map((s) => h('button.of-room' + (ui.view === s.id ? '.on' : ''), { onclick: () => setView(s.id), title: s.meta.cwd ?? s.id, style: `--hc:${harnessInfo(s.harness).color}` },
        h('span.of-room-dot.' + s.status),
        clip(s.meta.title ?? s.meta.project ?? s.id.slice(0, 8), 26),
      )),
    )
  }

  function renderTop(now: number): void {
    const world = client.world
    const day = daylight()
    const t = new Date()
    q('.of-clock').textContent = `${day > 0.5 ? '☀' : '☾'} ${t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${getTimeMode() === 'auto' ? '' : ` · ${getTimeMode()}`}`
    let working = 0, waiting = 0, tokens = 0
    for (const id of model.rooms.keys()) {
      const s = world.sessions[id]
      if (!s) continue
      tokens += totalTokens(s.usage)
      for (const a of Object.values(s.agents)) {
        if (a.status === 'working') working++
        if (a.status === 'waiting') waiting++
      }
    }
    let perMin = 0
    for (let i = toolTimes.length - 1; i >= 0 && toolTimes[i]! > now - 60_000; i--) perMin++
    render(q('.of-stats'), `${working}|${waiting}|${perMin}|${formatCount(tokens)}`, () => [
      h('span.of-sticky.yellow', null, h('b', null, String(working)), 'at work'),
      waiting ? h('span.of-sticky.orange', null, h('b', null, String(waiting)), 'need you') : '',
      h('span.of-sticky.blue', null, h('b', null, String(perMin)), 'tasks/min'),
      h('span.of-sticky.pink', null, h('b', null, formatCount(tokens)), 'tokens'),
    ])
    q('.of-empty').hidden = Object.keys(world.sessions).length > 0
  }

  function renderIntercom(): void {
    const world = client.world
    const list = intercom.filter((e) => model.rooms.has(e.sessionId)).slice(-7).reverse()
    render(q('.of-intercom ol'), list.map((e) => e.seq).join(','), () => (list.length ? list.map((e) => {
      const s = world.sessions[e.sessionId]!
      const who = e.agentId === s.rootAgentId ? 'lead' : s.agents[e.agentId]?.name ?? 'agent'
      return h('li', null,
        h('span.of-who', { style: `color:${harnessInfo(s.harness).color}` }, clip(who, 16)),
        h('span', null, describe(e)),
      )
    }) : [h('li.of-muted', null, 'All quiet…')]))
  }

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
    const isRoot = a.id === s.rootAgentId
    const actLabel = act.activity === 'waiting' ? 'needs your approval'
      : act.tool ? `${CATEGORY[act.tool.category]?.label.toLowerCase() ?? 'working'}: ${act.tool.title}`
      : act.activity === 'thinking' ? 'thinking…' : act.activity === 'done' ? 'finished — on a break' : act.activity === 'sleeping' ? 'asleep at the desk' : act.activity === 'busy' ? 'working' : 'idle'
    card.replaceChildren(
      h('div.of-card-head', null,
        h('span.of-avatar', { style: `background:${c.palette.shirt}` }, isRoot ? '★' : (a.role ?? a.name).slice(0, 1).toUpperCase()),
        h('div', null,
          h('b', null, isRoot ? (s.meta.title ?? 'Team lead') : a.name),
          h('div.of-muted', null, [isRoot ? 'team lead' : a.role ?? 'subagent', harnessInfo(s.harness).label, a.model].filter(Boolean).join(' · ')),
        ),
        h('button.of-x', { onclick: () => { ui.selected = undefined; renderCard() }, 'aria-label': 'Close' }, '×'),
      ),
      h('div.of-status.' + a.status, null, actLabel),
      a.task && !isRoot ? h('p.of-task', null, clip(a.task, 160)) : '',
      h('div.of-card-stats', null,
        h('span', null, h('b', null, String(a.toolCount)), 'tools'),
        h('span', null, h('b', null, String(a.errorCount)), 'oops'),
        h('span', null, h('b', null, formatCount(totalTokens(a.usage))), 'tokens'),
        h('span', null, h('b', null, formatAgo(a.startedAt, now).replace(' ago', '')), 'on shift'),
      ),
      recent.length ? h('ul.of-recent', null, ...recent.map((t) => h('li', null,
        h('i', { style: `background:${CATEGORY[t!.category]?.color ?? '#999'}` }),
        h('span', null, clip(t!.title, 46)),
        h('em', null, t!.endedAt === undefined ? 'now' : t!.ok ? formatDuration(t!.durationMs ?? 0) : 'failed'),
      ))) : '',
    )
    card.hidden = false
    const z = c.mode === 'seated' ? 0.43 : 0
    const p = toScreen(room.ox + c.x, room.oy + c.y, z)
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
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hh * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(hh * dpr)
    }
    if (ui.autoFit) fit(dt)
    renderOffice(ctx, model, world, cam, w, hh, dpr, now, { hovered: ui.hovered, selected: ui.selected?.char, labels: ui.labels })
    labelsBtn.classList.toggle('on', ui.labels)

    if (t - lastHud > 400) {
      lastHud = t
      renderTop(now)
      renderIntercom()
      renderRooms()
      if (ui.selected) renderCard()
    }
  })

  ;(window as unknown as { __oadtOffice: unknown }).__oadtOffice = { model, cam, ui }
  return { destroy: () => { d.dispose(); root.replaceChildren() } }
}

function notable(e: ObserverEvent, world: WorldState): boolean {
  if (e.kind === 'message') return e.role === 'user' || e.role === 'assistant'
  if (e.kind === 'tool.finished') return !e.ok
  if (e.kind === 'agent.spawned' || e.kind === 'turn.ended') return true
  if (e.kind === 'agent.status') return e.status === 'waiting'
  void world
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
