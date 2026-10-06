import './style.css'
import { connect } from '@oadt/client'
import {
  formatCount,
  isLive,
  mostRecentSession,
  sessionList,
  worldTotals,
  type ObserverEvent,
  type WorldState,
} from '@oadt/protocol'
import { $, clamp, h } from './dom'
import { drawScene, type Camera, type DrawState } from './draw'
import { feedItem, renderFiles, renderInspector, renderSessions, type PanelCallbacks, type Selection } from './panels'
import { Scene } from './scene'
import { CATEGORY } from './theme'
import { Timeline, type Mark } from './timeline'

// ─── Connection ─────────────────────────────────────────────────────────
// A token can arrive via ?token= (printed by the CLI). Keep it in session
// storage and strip it from the address bar so it doesn't linger in history.
const params = new URLSearchParams(location.search)
let token = params.get('token') ?? undefined
try {
  if (token) sessionStorage.setItem('oadt-token', token)
  else token = sessionStorage.getItem('oadt-token') ?? undefined
} catch { /* storage unavailable */ }
if (params.has('token')) {
  params.delete('token')
  history.replaceState(null, '', location.pathname + (params.toString() ? `?${params}` : '') + location.hash)
}
const client = connect({ url: params.get('api') ?? '', token })

// ─── UI state ───────────────────────────────────────────────────────────
const ui = {
  view: decodeURIComponent(/(?:^|[#&])s=([^&]+)/.exec(location.hash)?.[1] ?? 'auto'),
  selection: undefined as Selection | undefined,
  tab: 'feed' as 'feed' | 'inspect' | 'files',
  paused: false,
  autoFit: true,
  showLabels: true,
  filter: { text: '', showIdle: false },
  hovered: undefined as string | undefined,
}
try {
  ui.showLabels = localStorage.getItem('oadt-labels') !== '0'
  ui.filter.showIdle = localStorage.getItem('oadt-show-idle') === '1'
} catch { /* ignore */ }

const activity = new Map<string, number[]>()
const marks: Mark[] = []
const feedBuffer: ObserverEvent[] = []
let pending: ObserverEvent[] = []
let dirty = true
let lastPanel = 0
let visible: string[] = []
let inspectKey = ''

const scene = new Scene()
const cam: Camera = { x: 0, y: 0, scale: 0.8 }
const canvas = $('#scene') as HTMLCanvasElement
const ctx = canvas.getContext('2d')!
const tooltip = $('#tooltip')
const timeline = new Timeline($('#timeline') as HTMLCanvasElement, (sessionId, id) => select({ type: 'tool', sessionId, id }), tooltip)

const cb: PanelCallbacks = {
  selectView: (v) => setView(v),
  select: (sel) => select(sel),
}

function setView(v: string): void {
  ui.view = v
  ui.selection = undefined
  ui.autoFit = true
  history.replaceState(null, '', v === 'auto' ? location.pathname + location.search : `#s=${encodeURIComponent(v)}`)
  $('#sidebar').classList.remove('open')
  void rebuildFeed()
  dirty = true
  lastPanel = 0
}

function select(sel: Selection | undefined): void {
  ui.selection = sel
  if (sel && ui.view !== 'auto' && sel.sessionId !== ui.view) ui.view = sel.sessionId
  if (sel) setTab('inspect')
  lastPanel = 0
}

function setTab(tab: typeof ui.tab): void {
  ui.tab = tab
  inspectKey = ''
  for (const b of document.querySelectorAll<HTMLElement>('#tabs [data-tab]')) b.classList.toggle('on', b.dataset.tab === tab)
  for (const b of document.querySelectorAll<HTMLElement>('.tab-body')) b.hidden = b.dataset.tab !== tab
  lastPanel = 0
}

function visibleSessions(world: WorldState): string[] {
  if (ui.view !== 'auto') return world.sessions[ui.view] ? [ui.view] : []
  // Most recently active first to choose, then a stable order so sessions keep their place on stage.
  const live = sessionList(world).filter(isLive).slice(0, 4).sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1)).map((s) => s.id)
  if (live.length) return live
  const recent = mostRecentSession(world)
  return recent ? [recent.id] : []
}

// ─── Data ingestion ─────────────────────────────────────────────────────

function track(e: ObserverEvent): void {
  if (e.kind === 'tool.started') {
    let a = activity.get(e.sessionId)
    if (!a) activity.set(e.sessionId, (a = []))
    a.push(e.ts)
    if (a.length > 2000) a.splice(0, a.length - 1500)
  }
  const mark = e.kind === 'message' && e.role === 'user' ? 'user'
    : e.kind === 'turn.ended' ? (e.outcome === 'completed' ? 'turn-ok' : 'turn-bad')
    : e.kind === 'agent.spawned' ? 'spawn' : undefined
  if (mark) {
    marks.push({ sessionId: e.sessionId, agentId: e.agentId, ts: e.ts, kind: mark })
    if (marks.length > 3000) marks.splice(0, 1000)
  }
}

client.on('snapshot', (world) => {
  activity.clear()
  for (const s of Object.values(world.sessions)) {
    activity.set(s.id, s.toolOrder.map((id) => s.tools[id]?.startedAt ?? 0).filter(Boolean))
  }
  dirty = true
  void rebuildFeed()
})

client.onChange((_world, events) => {
  for (const e of events) {
    track(e)
    feedBuffer.push(e)
  }
  if (feedBuffer.length > 3000) feedBuffer.splice(0, feedBuffer.length - 2000)
  pending.push(...events)
  if (!ui.paused) appendFeed(events)
  dirty = true
})

client.on('status', (status) => {
  const el = $('#conn')
  el.className = `conn ${status}`
  el.textContent = status === 'live' ? 'live' : status === 'reconnecting' ? 'reconnecting…' : status
})

// ─── Feed ───────────────────────────────────────────────────────────────

const feedEl = $('#feed')
const FEED_MAX = 300

function feedVisible(e: ObserverEvent): boolean {
  return visible.includes(e.sessionId) || (ui.view === 'auto' && isLive(client.world.sessions[e.sessionId] ?? ({} as never)))
}

function appendFeed(events: ObserverEvent[]): void {
  const nodes: HTMLElement[] = []
  for (const e of events) {
    if (!feedVisible(e)) continue
    const item = feedItem(e, client.world, cb)
    if (item) nodes.push(item)
  }
  if (!nodes.length) return
  const atTop = feedEl.scrollTop < 40
  feedEl.prepend(...nodes.reverse())
  while (feedEl.childElementCount > FEED_MAX) feedEl.lastElementChild?.remove()
  if (!atTop) feedEl.scrollTop += nodes.reduce((n, el) => n + el.offsetHeight, 0)
}

async function rebuildFeed(): Promise<void> {
  const world = client.world
  visible = visibleSessions(world)
  let events: ObserverEvent[]
  if (ui.view !== 'auto' && world.sessions[ui.view]) {
    try {
      events = (await client.sessionEvents(ui.view)).slice(-1500)
    } catch {
      events = feedBuffer.filter((e) => e.sessionId === ui.view)
    }
  } else {
    events = feedBuffer.filter((e) => visible.includes(e.sessionId))
  }
  const items: HTMLElement[] = []
  for (let i = events.length - 1; i >= 0 && items.length < FEED_MAX; i--) {
    const item = feedItem(events[i]!, client.world, cb)
    if (item) items.push(item)
  }
  feedEl.replaceChildren(...(items.length ? items : [h('div.empty', null, 'Activity will stream here.')]))
  feedEl.querySelectorAll('.feed-item').forEach((n) => ((n as HTMLElement).style.animation = 'none'))
}

// ─── Panels ─────────────────────────────────────────────────────────────

let pointerInSidebar = false
const sidebarEl = $('#sidebar')
sidebarEl.addEventListener('pointerdown', () => { pointerInSidebar = true })
window.addEventListener('pointerup', () => { setTimeout(() => { pointerInSidebar = false }, 0) })


function renderPanels(now: number): void {
  const world = client.world
  // Never rebuild the list under a press, or the click would land on a detached node.
  if (!pointerInSidebar) renderSessions($('#sessions'), world, ui.view, activity, ui.filter, cb)

  const t = worldTotals(world)
  let perMin = 0
  for (const list of activity.values()) for (let i = list.length - 1; i >= 0 && list[i]! > now - 60_000; i--) perMin++
  $('#stats').replaceChildren(
    h('span.stat-pill.live', null, h('b', null, String(t.live)), 'live'),
    t.waiting ? h('span.stat-pill.wait', null, h('b', null, String(t.waiting)), 'waiting') : '',
    h('span.stat-pill', null, h('b', null, String(perMin)), 'tools/min'),
    h('span.stat-pill.opt', null, h('b', null, formatCount(t.agents)), 'agents'),
    h('span.stat-pill.opt', null, h('b', null, formatCount(t.tools)), 'tool calls'),
    h('span.stat-pill.opt', null, h('b', null, formatCount(t.tokens)), 'tokens'),
    t.costUsd ? h('span.stat-pill.opt', null, h('b', null, `$${t.costUsd.toFixed(2)}`), 'reported cost') : '',
  )

  const key = `${JSON.stringify(ui.selection)}|${visible[0]}|${world.seq}|${Math.floor(now / 5000)}`
  if (ui.tab === 'inspect' && key !== inspectKey) {
    inspectKey = key
    // Keep the reader's place (and any text selection) unless something they are looking at changed.
    if (!window.getSelection()?.toString()) renderInspector($('#inspector'), world, ui.selection, visible[0], cb)
  }
  if (ui.tab === 'files') renderFiles($('#files'), world, visible, cb)
  $('#empty-stage').hidden = Object.keys(world.sessions).length > 0
}

// ─── Canvas & camera ────────────────────────────────────────────────────

function resize(): void {
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth, hgt = canvas.clientHeight
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(hgt * dpr)
  }
}

function fitCamera(dt: number): void {
  const b = scene.bounds()
  if (!b) return
  const w = canvas.clientWidth, hgt = canvas.clientHeight
  const bw = b.maxX - b.minX + 120, bh = b.maxY - b.minY + 160
  const target = clamp(Math.min(w / bw, hgt / bh), 0.22, 1.35)
  const k = Math.min(1, dt * 2.2)
  cam.scale += (target - cam.scale) * k
  cam.x += ((b.minX + b.maxX) / 2 - cam.x) * k
  cam.y += ((b.minY + b.maxY) / 2 + 10 - cam.y) * k
}

function toWorld(clientX: number, clientY: number): { x: number; y: number } {
  const r = canvas.getBoundingClientRect()
  return {
    x: (clientX - r.left - r.width / 2) / cam.scale + cam.x,
    y: (clientY - r.top - r.height / 2) / cam.scale + cam.y,
  }
}

let drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | undefined
canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false }
  canvas.setPointerCapture(e.pointerId)
})
canvas.addEventListener('pointermove', (e) => {
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y
    if (Math.abs(dx) + Math.abs(dy) > 4) {
      drag.moved = true
      ui.autoFit = false
      canvas.classList.add('dragging')
    }
    if (drag.moved) {
      cam.x = drag.cx - dx / cam.scale
      cam.y = drag.cy - dy / cam.scale
    }
    return
  }
  const p = toWorld(e.clientX, e.clientY)
  const n = scene.hit(p.x, p.y, cam.scale)
  ui.hovered = n?.id
  canvas.style.cursor = n ? 'pointer' : ''
  if (n && (n.kind === 'tool' || n.kind === 'file')) {
    tooltip.hidden = false
    tooltip.textContent = n.kind === 'file' ? n.path ?? n.label : `${n.label}${n.open ? ' · running' : n.ok === false ? ' · failed' : ''}`
    tooltip.style.left = `${Math.min(e.clientX + 14, window.innerWidth - 370)}px`
    tooltip.style.top = `${e.clientY + 14}px`
  } else tooltip.hidden = true
})
canvas.addEventListener('pointerup', (e) => {
  canvas.classList.remove('dragging')
  const wasDrag = drag?.moved
  drag = undefined
  if (wasDrag) return
  const p = toWorld(e.clientX, e.clientY)
  const n = scene.hit(p.x, p.y, cam.scale)
  if (!n) return select(undefined)
  if (n.kind === 'agent') select({ type: 'agent', sessionId: n.sessionId, id: n.agentId! })
  else if (n.kind === 'tool') select({ type: 'tool', sessionId: n.sessionId, id: n.callId! })
  else if (n.kind === 'file') select({ type: 'file', sessionId: n.sessionId, id: n.path! })
  else select({ type: 'session', sessionId: n.sessionId })
})
canvas.addEventListener('pointerleave', () => { ui.hovered = undefined; tooltip.hidden = true })
canvas.addEventListener('wheel', (e) => {
  e.preventDefault()
  ui.autoFit = false
  const before = toWorld(e.clientX, e.clientY)
  cam.scale = clamp(cam.scale * Math.exp(-e.deltaY * 0.0015), 0.15, 3)
  const after = toWorld(e.clientX, e.clientY)
  cam.x += before.x - after.x
  cam.y += before.y - after.y
}, { passive: false })

// ─── Controls ───────────────────────────────────────────────────────────

const fitBtn = $('#fit')
const labelsBtn = $('#labels')
fitBtn.addEventListener('click', () => { ui.autoFit = true })
labelsBtn.addEventListener('click', () => toggleLabels())
function toggleLabels(): void {
  ui.showLabels = !ui.showLabels
  try { localStorage.setItem('oadt-labels', ui.showLabels ? '1' : '0') } catch { /* ignore */ }
}
for (const b of document.querySelectorAll<HTMLElement>('#tabs [data-tab]')) b.addEventListener('click', () => setTab(b.dataset.tab as typeof ui.tab))
const pauseBtn = $('#pause')
function togglePause(): void {
  ui.paused = !ui.paused
  pauseBtn.classList.toggle('on', ui.paused)
  pauseBtn.textContent = ui.paused ? '▶' : '❚❚'
  if (!ui.paused) void rebuildFeed()
}
pauseBtn.addEventListener('click', togglePause)
const windows = [...document.querySelectorAll<HTMLElement>('#window button')]
function setWindow(ms: number): void {
  timeline.windowMs = ms
  for (const b of windows) b.classList.toggle('on', Number(b.dataset.ms) === ms)
}
for (const b of windows) b.addEventListener('click', () => setWindow(Number(b.dataset.ms)))
const search = $('#search') as HTMLInputElement
search.addEventListener('input', () => { ui.filter.text = search.value; lastPanel = 0 })
const showIdle = $('#show-idle') as HTMLInputElement
showIdle.checked = ui.filter.showIdle
showIdle.addEventListener('change', () => {
  ui.filter.showIdle = showIdle.checked
  try { localStorage.setItem('oadt-show-idle', showIdle.checked ? '1' : '0') } catch { /* ignore */ }
  lastPanel = 0
})
$('#menu').addEventListener('click', () => $('#sidebar').classList.toggle('open'))
const help = $('#help')
$('#help-btn').addEventListener('click', () => { help.hidden = false })
help.addEventListener('click', () => { help.hidden = true })

$('#legend').replaceChildren(...(['read', 'search', 'edit', 'write', 'shell', 'web', 'agent', 'mcp', 'plan'] as const).map((c) =>
  h('span', null, h('i', { style: `background:${CATEGORY[c].color}` }), CATEGORY[c].label)))

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) {
    if (e.key === 'Escape') (e.target as HTMLInputElement).blur()
    return
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const list = sessionList(client.world).filter((s) => ui.filter.showIdle || isLive(s) || Date.now() - s.lastActivityAt < 3600_000)
  const idx = list.findIndex((s) => s.id === ui.view)
  switch (e.key) {
    case 'a': case 'A': setView('auto'); break
    case 'f': case 'F': ui.autoFit = true; break
    case 'l': case 'L': toggleLabels(); break
    case 'j': if (list.length) setView(list[Math.min(list.length - 1, idx + 1)]!.id); break
    case 'k': if (list.length) setView(list[Math.max(0, idx - 1)]!.id); break
    case '1': setTab('feed'); break
    case '2': setTab('inspect'); break
    case '3': setTab('files'); break
    case ' ': e.preventDefault(); togglePause(); break
    case '[': setWindow(Math.min(1_800_000, timeline.windowMs * (timeline.windowMs >= 600_000 ? 3 : timeline.windowMs >= 180_000 ? 3.34 : 3)) | 0); break
    case ']': setWindow(Math.max(60_000, timeline.windowMs / (timeline.windowMs > 600_000 ? 3 : timeline.windowMs > 180_000 ? 3.34 : 3)) | 0); break
    case '/': e.preventDefault(); search.focus(); break
    case '?': help.hidden = !help.hidden; break
    case 'Escape': help.hidden = true; select(undefined); setTab('feed'); break
  }
})

// ─── Frame loop ─────────────────────────────────────────────────────────

let last = performance.now()
function frame(t: number): void {
  const dt = (t - last) / 1000
  last = t
  const now = Date.now()
  const world = client.world
  const ids = visibleSessions(world)
  if (ids.join('|') !== visible.join('|')) {
    visible = ids
    dirty = true
    if (ui.view === 'auto') void rebuildFeed()
  }
  scene.setSessions(ids, canvas.clientHeight > canvas.clientWidth * 1.15)
  if (dirty) {
    scene.sync(world, pending, now)
    pending = []
    dirty = false
  } else if (Math.floor(t / 500) !== Math.floor((t - dt * 1000) / 500)) {
    scene.sync(world, [], now) // periodic reconcile for time-based fading
  }
  scene.step(dt, now)
  resize()
  if (ui.autoFit) fitCamera(dt)
  fitBtn.classList.toggle('on', ui.autoFit)
  labelsBtn.classList.toggle('on', ui.showLabels)

  const titles: DrawState['titles'] = new Map()
  for (const id of ids) {
    const s = world.sessions[id]
    if (s) titles.set(id, { title: s.meta.title ?? s.meta.project ?? id, harness: s.harness, status: s.status })
  }
  const sel = ui.selection
  const selectedNode = sel?.type === 'agent' ? `a:${sel.sessionId}:${sel.id}` : sel?.type === 'tool' ? `t:${sel.sessionId}:${sel.id}` : sel?.type === 'file' ? `f:${sel.sessionId}:${sel.id}` : undefined
  drawScene(ctx, scene, cam, canvas.clientWidth, canvas.clientHeight, { hovered: ui.hovered, selected: selectedNode, showLabels: ui.showLabels, multi: ids.length > 1, titles })
  timeline.render(world, ids, marks, now)

  if (t - lastPanel > 400) {
    lastPanel = t
    renderPanels(now)
  }
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)

// Debug handle for frontend hackers: inspect the live world and scene from DevTools.
;(window as unknown as { __oadt: unknown }).__oadt = { client, scene, cam, ui }
