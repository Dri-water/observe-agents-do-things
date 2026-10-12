/**
 * The Court (朝堂): an isometric Tang–Song audience hall. Every session is a
 * hall in the palace, the lead agent is the Chancellor below the throne, and
 * subagents are ministers who kneel at their desks, raise their tablet (笏)
 * when they need you, and retire to the tea pavilion when they are done. You
 * are the empty throne. Fully self-contained: its own canvas, HUD, camera,
 * input and loop. It only *reads* protocol data from the client.
 */
import './court.css'
import {
  clip,
  contextFill,
  formatAgo,
  formatCount,
  formatDuration,
  mostRecentSession,
  recentChanges,
  recentSessions,
  shortPath,
  totalTokens,
  type AttentionItem,
  type ChangeEntry,
  type ObserverEvent,
  type WorldState,
} from '@oadt/protocol'
import { clamp, h } from '../../shared/dom'
import { CATEGORY, harnessInfo } from '../../shared/theme'
import { buddySeed, face, LOOKS } from '../../shared/buddy'
import { KeyedList, tickTo } from '../../shared/motion'
import { Disposer, type Visualization, type VizContext } from '../types'
import { resolveTheme, THEME_SETTING } from '../../host/settings'
import { iso } from '../office/iso'
import { activityOf, BAY_W, Court, HALL_D, HALL_W } from './model'
import { daylight, getTimeMode, renderCourt, setPalette, setTimeMode, terrainZ, WALL_H, type Camera, type TimeMode } from './render'
import { hallName, rankOf, shichen, titleOf, type Lang, type PaletteName } from './palette'

export const court: Visualization = {
  id: 'court',
  name: 'The Court',
  description: 'An isometric Tang–Song audience hall: every session is a delegation before the throne, each agent a minister who raises the tablet when it needs you.',
  icon: '朝',
  settings: [
    {
      key: 'palette', label: 'Palette', type: 'select', default: 'tang',
      description: 'Tang: vermilion and gold. Song: natural timber and celadon. Ink wash: monochrome with red seals.',
      options: [{ value: 'tang', label: 'Tang · vermilion & gold' }, { value: 'song', label: 'Song · celadon & timber' }, { value: 'ink', label: 'Ink wash (水墨)' }],
    },
    {
      key: 'layout', label: 'Halls', type: 'select', default: 'one',
      description: 'One great hall where every session is a delegation in its own bay (it grows as sessions and ministers arrive), or a hall for each session.',
      options: [{ value: 'one', label: 'One great hall' }, { value: 'rooms', label: 'A hall per session' }],
    },
    {
      key: 'throne', label: 'Throne', type: 'select', default: 'empty',
      description: 'The throne stands empty because you are the emperor. Or seat an emperor on it.',
      options: [{ value: 'empty', label: 'Empty: it is you' }, { value: 'emperor', label: 'Seat an emperor' }],
    },
    {
      key: 'lang', label: 'Labels', type: 'select', default: 'accent',
      description: 'How much Chinese the court uses in titles, name tags and panels.',
      options: [{ value: 'accent', label: 'English with Chinese accents' }, { value: 'zh', label: 'Chinese first (中文)' }, { value: 'en', label: 'English only' }],
    },
    { ...THEME_SETTING, description: 'Colours of the panels and controls around the halls. The palette and the lighting are separate.' },
    { key: 'labels', label: 'Name tags', type: 'toggle', default: true, description: 'Show name tags under the ministers. Shortcut: L.' },
    { key: 'sidebar', label: 'Memorials sidebar', type: 'toggle', default: true, description: 'Memorials that need you, the archive of filed diffs and the court diary. Shortcut: D.' },
    {
      key: 'lighting', label: 'Lighting', type: 'select', default: 'auto',
      description: 'Day and night follow your clock in auto mode. You can also click the clock.',
      options: [{ value: 'auto', label: 'Follow my clock' }, { value: 'day', label: 'Always day' }, { value: 'night', label: 'Always night' }],
    },
  ],
  mount,
}

const MAX_HALLS = 8
const ATTN_ICON: Record<AttentionItem['kind'], string> = { waiting: '奏', errors: '误', finished: '毕', aborted: '止', context: '香', 'long-tool': '久' }

const TEMPLATE = `
<div class="ct">
  <div class="ct-stage">
    <canvas class="ct-canvas"></canvas>
    <header class="ct-top">
      <div class="ct-brand"><span class="ct-logo">朝</span><b class="ct-name"></b><span class="ct-clock"></span></div>
      <div class="ct-stats"></div>
      <div class="ct-actions"><button class="ct-btn ct-fit" title="Fit view (F)">⤢ fit</button></div>
    </header>
    <nav class="ct-halls"></nav>
    <div class="ct-needs-pop" role="dialog" aria-label="Who needs you" hidden></div>
    <div class="ct-card" hidden></div>
    <div class="ct-empty" hidden>
      <div class="ct-empty-art">退朝</div>
      <h2>The court is in recess</h2>
      <p>Start a Claude Code or Codex session and your ministers will assemble here.</p>
    </div>
  </div>
  <aside class="ct-side">
    <div class="ct-side-title"><span class="ct-dot"></span><span class="ct-memos-h"></span><span class="ct-grow"></span><button class="ct-clear" hidden title="Approve everything (X)"></button></div>
    <div class="ct-attn"></div>
    <div class="ct-allclear"></div>
    <div class="ct-side-sub ct-archive-h" hidden></div>
    <div class="ct-diffs"></div>
    <div class="ct-side-sub ct-diary-h"></div>
    <ol class="ct-feed"></ol>
  </aside>
</div>`

function mount(root: HTMLElement, vctx: VizContext) {
  const d = new Disposer()
  root.innerHTML = TEMPLATE
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector(sel) as T
  const { client, settings, attention } = vctx
  q('.ct-actions').prepend(vctx.controls)

  const canvas = q<HTMLCanvasElement>('.ct-canvas')
  const ctx = canvas.getContext('2d')!
  const model = new Court()
  const cam: Camera = { x: 0, y: 0, zoom: 1.0 }
  const ui = {
    view: 'auto',
    autoFit: true,
    labels: settings.get<boolean>('court.labels'),
    lang: (settings.get<string>('court.lang') ?? 'accent') as Lang,
    throne: (settings.get<string>('court.throne') === 'emperor' ? 'emperor' : 'empty') as 'empty' | 'emperor',
    hovered: undefined as string | undefined,
    selected: undefined as { hall: string; minister: string } | undefined,
  }
  d.add(settings.on('court.labels', (v) => { ui.labels = v === true }))
  d.add(settings.on('court.throne', (v) => { ui.throne = v === 'emperor' ? 'emperor' : 'empty' }))
  d.add(settings.on('court.lang', (v) => { ui.lang = (v as Lang) ?? 'accent'; applyLang() }))
  const ct = q('.ct')
  const stage = q('.ct-stage')
  const applySidebar = () => ct.classList.toggle('no-side', !settings.get<boolean>('court.sidebar'))
  applySidebar()
  d.add(settings.on('court.sidebar', applySidebar))
  const applyPalette = () => { const p = (settings.get<string>('court.palette') ?? 'tang') as PaletteName; setPalette(p); ct.dataset.palette = p }
  applyPalette()
  d.add(settings.on('court.palette', applyPalette))

  /** A heading in the chosen language: Chinese, English, or Chinese as an accent. */
  const L = (zh: string, en: string): Array<string | Node> =>
    ui.lang === 'zh' ? [zh] : ui.lang === 'en' ? [en] : [h('i.ct-zh', null, zh), en]
  const Ls = (zh: string, en: string) => (ui.lang === 'zh' ? zh : ui.lang === 'en' ? en : `${zh} ${en}`)

  let pending: ObserverEvent[] = []
  let dirty = true
  const toolTimes: number[] = []
  const diary: ObserverEvent[] = []
  d.add(client.onChange((_world, events) => {
    pending.push(...events)
    dirty = true
    for (const e of events) {
      if (e.kind === 'tool.started') toolTimes.push(Date.now())
      if (notable(e)) diary.push(e)
    }
    if (toolTimes.length > 4000) toolTimes.splice(0, 2000)
    if (diary.length > 60) diary.splice(0, diary.length - 40)
  }))

  const oneHall = () => settings.get<string>('court.layout') !== 'rooms'
  d.add(settings.on('court.layout', () => { ui.autoFit = true; ui.selected = undefined; renderCard() }))

  function visibleSessions(world: WorldState): string[] {
    // In the great hall a tab only moves the camera: every delegation stays in its bay.
    if (ui.view !== 'auto' && !oneHall()) return world.sessions[ui.view] ? [ui.view] : []
    const list = recentSessions(world).slice(0, MAX_HALLS)
    const focused = ui.view !== 'auto' ? world.sessions[ui.view] : undefined
    if (focused && !list.includes(focused)) list.splice(MAX_HALLS - 1, 1, focused)
    const shown = list.sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1)).map((s) => s.id)
    if (shown.length) return shown
    const recent = mostRecentSession(world)
    return recent ? [recent.id] : []
  }

  // ─── Camera ───────────────────────────────────────────────────────────

  function hallBounds() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    const grow = (x: number, y: number, z: number) => {
      const p = iso(x, y, z)
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
    }
    if (model.mono) {
      const pod = ui.view !== 'auto' ? model.halls.get(ui.view) : undefined
      if (pod) {
        // Frame one delegation's bay, with the throne's corridor above it.
        const depth = Math.max(...pod.desks.map((dk) => dk.y + dk.d), pod.layout.tea.rug.y + pod.layout.tea.rug.d) + 1.2
        for (const [x, y, z] of [[-0.6, -1.4, 2.6], [BAY_W + 0.4, -1.4, 2.0], [-0.6, depth, 1.6], [BAY_W + 0.4, depth, -0.2]] as const) grow(pod.ox + x, pod.oy + y, z)
      } else {
        const { w, d } = model.stage
        for (const [x, y, z] of [[-1.2, -1.2, WALL_H + 1.4], [w + 1.6, -1.6, WALL_H + 0.8], [-2.2, d + 1, WALL_H + 0.6], [w + 1.6, d + 2.6, -0.8], [-2.2, d + 2.6, -0.8], [w + 1.6, -0.5, -0.8]] as const) grow(x, y, z)
      }
      return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : undefined
    }
    for (const r of model.halls.values()) {
      const pts: Array<[number, number, number]> = [[-1.2, -1.2, WALL_H + 1.4], [HALL_W + 1.6, -1.6, WALL_H + 0.8], [-2.2, HALL_D + 1, WALL_H + 0.6], [HALL_W + 1.6, HALL_D + 2.6, -0.8], [-2.2, HALL_D + 2.6, -0.8], [HALL_W + 1.6, -0.5, -0.8]]
      for (const [x, y, z] of pts) {
        const p = iso(r.ox + x, r.oy + y, z)
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
      }
    }
    return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : undefined
  }

  function fit(dt: number): void {
    const b = hallBounds()
    if (!b) return
    const w = canvas.clientWidth, hh = canvas.clientHeight
    const padTop = 76, padBottom = w < 760 ? 56 : 64
    // A single bay is small: don't dive in further than a comfortable reading distance.
    const maxZoom = model.mono && ui.view !== 'auto' ? 1.25 : 2.4
    const zoom = clamp(Math.min((w - 40) / (b.maxX - b.minX), (hh - padTop - padBottom) / (b.maxY - b.minY)), 0.25, maxZoom)
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

  function pick(clientX: number, clientY: number): { hall: string; minister: string } | undefined {
    const r = canvas.getBoundingClientRect()
    const mx = clientX - r.left, my = clientY - r.top
    let best: { hall: string; minister: string; d: number } | undefined
    for (const hall of model.halls.values()) for (const m of hall.ministers.values()) {
      const p = toScreen(hall.ox + m.x, hall.oy + m.y, terrainZ(m.y + (model.mono ? hall.oy : 0)))
      const cy = p.y - (m.isRoot ? 26 : 22) * cam.zoom
      const dist = Math.hypot(mx - p.x, my - cy)
      if (dist < 26 * cam.zoom && (!best || dist < best.d)) best = { hall: hall.id, minister: m.id, d: dist }
    }
    return best && { hall: best.hall, minister: best.minister }
  }

  /** The hall under the pointer (on its floor plane). */
  function pickHall(clientX: number, clientY: number): string | undefined {
    const r = canvas.getBoundingClientRect()
    const sx = (clientX - r.left - canvas.clientWidth / 2) / cam.zoom + cam.x
    const sy = (clientY - r.top - canvas.clientHeight / 2) / cam.zoom + cam.y + (model.mono ? 0 : 2.4 * 34)
    const wx = (sx / 32 + sy / 16) / 2, wy = (sy / 16 - sx / 32) / 2
    for (const hall of model.halls.values()) {
      const lx = wx - hall.ox, ly = wy - hall.oy
      if (model.mono ? lx > 0 && lx < BAY_W && ly > -0.6 && ly < Math.max(...hall.desks.map((dk) => dk.y + dk.d)) + 2.5 : lx > -1.5 && lx < HALL_W + 1.5 && ly > -1.5 && ly < HALL_D + 1.5) return hall.id
    }
    return undefined
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
    ui.hovered = hit?.minister
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
  d.listen(canvas, 'dblclick', (e: Event) => {
    // Double-click a hall in the palace view to enter it.
    const me = e as MouseEvent
    const id = pickHall(me.clientX, me.clientY)
    if (id && model.halls.size > 1) setView(id)
  })
  d.listen(canvas, 'wheel', (e: Event) => {
    const we = e as WheelEvent
    we.preventDefault()
    ui.autoFit = false
    const r = canvas.getBoundingClientRect()
    const mx = we.clientX - r.left - r.width / 2, my = we.clientY - r.top - r.height / 2
    const before = { x: mx / cam.zoom + cam.x, y: my / cam.zoom + cam.y }
    cam.zoom = clamp(cam.zoom * Math.exp(-we.deltaY * 0.0015), 0.25, 4)
    cam.x = before.x - mx / cam.zoom
    cam.y = before.y - my / cam.zoom
  }, { passive: false })
  d.listen(canvas, 'pointerleave', () => { ui.hovered = undefined })

  const timeParam = new URLSearchParams(location.search).get('time') as TimeMode | null
  setTimeMode(timeParam ?? settings.get<TimeMode>('court.lighting'))
  d.add(settings.on('court.lighting', (v) => { setTimeMode(v as TimeMode); renderTop(Date.now()) }))
  const clockEl = q('.ct-clock')
  clockEl.title = 'Lighting: click to switch between auto, day and night'
  d.listen(clockEl, 'click', () => {
    const mode = getTimeMode()
    settings.set('court.lighting', mode === 'auto' ? 'day' : mode === 'day' ? 'night' : 'auto')
  })
  d.add(() => setTimeMode('auto'))
  d.listen(q('.ct-fit'), 'click', () => { ui.autoFit = true })
  d.listen(q('.ct-clear'), 'click', () => attention.ackAll())

  const hallChoices = () => ['auto', ...recentSessions(client.world).slice(0, 10).map((s) => s.id)]
  d.listen(window, 'keydown', (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.metaKey || e.ctrlKey || e.altKey) return
    switch (e.key) {
      case 'f': case 'F': ui.autoFit = true; break
      case 'l': case 'L': settings.set('court.labels', !ui.labels); break
      case 'a': case 'A': setView('auto'); break
      case 'x': case 'X': attention.ackAll(); break
      case 'd': case 'D': settings.set('court.sidebar', !settings.get<boolean>('court.sidebar')); break
      case 'j': case 'k': case 'J': case 'K': {
        const choices = hallChoices()
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
    renderHalls()
  }

  function focus(sessionId: string, agentId?: string): void {
    if (!model.halls.has(sessionId) || model.halls.size > 1) setView(sessionId)
    else ui.autoFit = true
    if (agentId) {
      ui.selected = { hall: sessionId, minister: agentId }
      renderCard()
    }
  }

  // ─── Theme & language ─────────────────────────────────────────────────

  const dark = matchMedia('(prefers-color-scheme: dark)')
  function applyTheme(): void {
    const theme = resolveTheme(settings.get<string>('court.theme'))
    ct.dataset.theme = theme
    vctx.setChromeTheme(theme)
  }
  applyTheme()
  d.add(settings.on('court.theme', applyTheme))
  d.listen(dark, 'change', applyTheme)

  const stats = { working: h('b'), needs: h('b'), perMin: h('b'), tokens: h('b') }
  const statLabels = { working: h('span'), needs: h('span'), perMin: h('span'), tokens: h('span') }
  q('.ct-stats').append(
    h('span.ct-tablet', null, stats.working, statLabels.working),
    h('span.ct-tablet.urgent', { hidden: true }, stats.needs, statLabels.needs),
    h('span.ct-tablet.wide', null, stats.perMin, statLabels.perMin),
    h('span.ct-tablet.wide', null, stats.tokens, statLabels.tokens),
  )
  const needsTablet = stats.needs.parentElement as HTMLElement
  needsTablet.title = 'Who needs you'

  function applyLang(): void {
    ct.dataset.lang = ui.lang
    q('.ct-name').replaceChildren(...(ui.lang === 'zh' ? ['朝堂'] : ui.lang === 'en' ? ['The Court'] : [h('i.ct-zh', null, '朝堂'), 'The Court']))
    statLabels.working.replaceChildren(...L('在朝', 'at court'))
    statLabels.needs.replaceChildren(...L('启奏', 'need you'))
    statLabels.perMin.replaceChildren(...L('事/分', 'tasks/min'))
    statLabels.tokens.replaceChildren(...L('字', 'tokens'))
    q('.ct-memos-h').replaceChildren(...L('奏章', 'Memorials'))
    q('.ct-clear').textContent = Ls('准', 'approve all')
    q('.ct-allclear').replaceChildren(h('span.ct-seal-mini', null, '安'), ...L('无事', 'Nothing needs you'))
    q('.ct-archive-h').replaceChildren(...L('档案', 'Archive · filed diffs'))
    q('.ct-diary-h').replaceChildren(...L('起居注', 'Court diary'))
    renderHalls()
    if (ui.selected) renderCard()

  }

  // ─── HUD ──────────────────────────────────────────────────────────────

  const hallsEl = q('.ct-halls')
  let pressingHalls = false
  d.listen(hallsEl, 'pointerdown', () => { pressingHalls = true })
  d.listen(window, 'pointerup', () => { setTimeout(() => { pressingHalls = false }, 0) })

  function renderHalls(): void {
    if (pressingHalls) return
    const world = client.world
    const open = attention.open().filter((a) => a.severity !== 'low')
    const urgent = new Set(open.filter((a) => a.severity === 'high').map((a) => a.sessionId))
    const counts = new Map<string, number>()
    for (const a of open) counts.set(a.sessionId, (counts.get(a.sessionId) ?? 0) + 1)
    const list = recentSessions(world).slice(0, 10)
    hallsEl.replaceChildren(
      h('button.ct-hall' + (ui.view === 'auto' ? '.on' : ''), { onclick: () => setView('auto') }, h('span.ct-hall-dot.live'), ...L('宫城', 'All halls')),
      ...list.map((s) => {
        const hall = model.halls.get(s.id)
        const name = hall ? hallName(hall.nameIdx) : undefined
        return h('button.ct-hall' + (ui.view === s.id ? '.on' : '') + (urgent.has(s.id) ? '.urgent' : ''), { onclick: () => setView(s.id), title: `${name ? `${name.zh} ${name.en} · ` : ''}${s.meta.cwd ?? s.id}`, style: `--hc:${harnessInfo(s.harness).color}` },
          h('span.ct-hall-dot.' + (urgent.has(s.id) ? 'waiting' : s.status)),
          name && ui.lang !== 'en' ? h('i.ct-zh', null, name.zh) : '',
          clip(s.meta.title ?? s.meta.project ?? s.id.slice(0, 8), 24),
          counts.get(s.id) ? h('span.ct-hall-badge' + (urgent.has(s.id) ? '.urgent' : ''), null, String(counts.get(s.id))) : '',
        )
      }),
    )
  }

  const needsPop = q('.ct-needs-pop')
  const needsRows = h('div.ct-needs-rows')
  const needsHead = h('b')
  needsPop.append(h('div.ct-needs-head', null, needsHead, h('span.ct-grow'), h('button.ct-clear', { onclick: () => attention.ackAll() }, '准')), needsRows)
  const attnRow = (i: AttentionItem, onOpen: () => void) => h('div.ct-attn-row.' + i.severity, { onclick: onOpen, title: i.detail ?? '' },
    h('span.ct-attn-ico', null, ATTN_ICON[i.kind]),
    h('div.ct-attn-txt', null, h('b', null, i.title), h('span', null, sessionName(i.sessionId))),
    h('span.ct-attn-age'),
    h('button.ct-ack', { onclick: (e: Event) => { e.stopPropagation(); attention.ack(i.id) }, title: 'Acknowledge' }, '准'),
  )
  const needsList = new KeyedList<AttentionItem>(needsRows, {
    key: (i) => i.id,
    create: (i) => attnRow(i, () => { closeNeeds(); focus(i.sessionId, i.agentId) }),
    update: (el, i) => { el.querySelector('.ct-attn-age')!.textContent = formatDuration(Date.now() - i.since) },
    collapse: true,
  })
  function renderNeeds(): void {
    if (needsPop.hidden) return
    needsHead.replaceChildren(...L('启奏', 'Needs you'))
    const items = attention.open().filter((a) => a.severity !== 'low')
    needsList.sync(items)
    if (!items.length) closeNeeds()
  }
  function closeNeeds(): void { needsPop.hidden = true; needsTablet.classList.remove('open') }
  d.listen(needsTablet, 'click', () => {
    if (!needsPop.hidden) return closeNeeds()
    needsPop.hidden = false
    needsTablet.classList.add('open')
    renderNeeds()
  })
  d.listen(window, 'pointerdown', (e: Event) => {
    const t = e.target as Node
    if (!needsPop.hidden && !needsPop.contains(t) && !needsTablet.contains(t)) closeNeeds()
  })
  d.listen(window, 'keydown', (e: KeyboardEvent) => { if (e.key === 'Escape' && !needsPop.hidden) closeNeeds() })

  function renderTop(now: number): void {
    const world = client.world
    const day = daylight()
    const t = new Date()
    const time = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    q('.ct-clock').textContent = `${day > 0.5 ? '☀' : '☾'} ${ui.lang === 'en' ? time : `${shichen(t)} · ${time}`}${getTimeMode() === 'auto' ? '' : ` · ${getTimeMode()}`}`
    let working = 0, tokens = 0
    for (const id of model.halls.keys()) {
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
    needsTablet.hidden = !needs
    tickTo(stats.perMin, perMin)
    tickTo(stats.tokens, tokens, formatCount)
    q('.ct-empty').hidden = Object.keys(world.sessions).length > 0
  }

  // ─── Sidebar: memorials, archive, court diary ─────────────────────────
  const sessionName = (id: string) => { const s = client.world.sessions[id]; return s?.meta.title ?? s?.meta.project ?? id.slice(0, 8) }
  const attnList = new KeyedList<AttentionItem>(q('.ct-attn'), {
    key: (i) => i.id,
    create: (i) => attnRow(i, () => focus(i.sessionId, i.agentId)),
    update: (el, i) => { el.querySelector('.ct-attn-age')!.textContent = formatDuration(Date.now() - i.since) },
    flashClass: 'ct-flash',
    collapse: true,
  })
  const ministerName = (sid: string, aid: string) => {
    const s = client.world.sessions[sid]
    if (!s) return 'minister'
    if (aid === s.rootAgentId) return Ls('宰相', 'Chancellor')
    return s.agents[aid]?.name ?? 'minister'
  }
  const feed = new KeyedList<ObserverEvent>(q('.ct-feed'), {
    key: (e) => String(e.seq),
    create: (e) => {
      const s = client.world.sessions[e.sessionId]
      return h('li', { onclick: () => focus(e.sessionId, e.agentId) },
        h('span.ct-who', { style: `color:${rankOf(s?.agents[e.agentId]?.depth ?? 0).color}` }, clip(ministerName(e.sessionId, e.agentId), 16)),
        h('span', null, describe(e, ui.lang)),
      )
    },
    flashClass: 'ct-flash',
    collapse: true,
  })
  const DIFF_LINES = 4
  const expanded = new Set<string>()
  function fillDiff(card: HTMLElement, c: ChangeEntry): void {
    const full = expanded.has(c.key)
    const lines = full ? c.change.lines.slice(0, 60) : c.change.lines.slice(0, DIFF_LINES)
    const body = card.querySelector('.ct-diff-body') as HTMLElement
    body.replaceChildren(...lines.map((l) => {
      const kind = l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : l[0] === '@' ? 'gap' : 'ctx'
      return h('div.ln.' + kind, null, kind === 'gap' ? '⋯' : l.slice(1) || ' ')
    }))
    if (c.change.op === 'delete' && !lines.length) body.replaceChildren(h('div.ln.gap', null, 'file deleted'))
    const hidden = c.change.lines.length - lines.length
    const more = card.querySelector('.ct-diff-more') as HTMLElement
    more.hidden = !(hidden > 0 || (full && c.change.lines.length > DIFF_LINES))
    more.textContent = hidden > 0 ? `${hidden} more line${hidden === 1 ? '' : 's'}${c.change.truncated ? ' (truncated)' : ''}` : 'show less'
  }
  const diffs = new KeyedList<ChangeEntry>(q('.ct-diffs'), {
    key: (c) => c.key,
    create: (c) => {
      const s = client.world.sessions[c.sessionId]
      const op = c.change.op === 'write' ? 'write' : c.change.op === 'delete' ? 'shell' : 'edit'
      const card = h('div.ct-diff', { style: `--op:${CATEGORY[op].color}`, onclick: () => { if (expanded.has(c.key)) expanded.delete(c.key); else expanded.add(c.key); fillDiff(card, c) } },
        h('div.ct-diff-head', null,
          h('i', null, c.change.op === 'write' ? '新' : c.change.op === 'delete' ? '删' : '改'),
          h('code', { title: c.change.path }, shortPath(c.change.path, 3)),
          h('span.add', null, `+${c.change.added}`), h('span.del', null, `−${c.change.removed}`),
          face(buddySeed(c.sessionId, c.agentId, s?.rootAgentId), 14),
          h('span.who', null, clip(ministerName(c.sessionId, c.agentId), 14)),
          h('span.age'),
        ),
        h('div.ct-diff-body'),
        h('div.ct-diff-more'),
      )
      fillDiff(card, c)
      return card
    },
    update: (el, c) => { el.querySelector('.age')!.textContent = c.tool.ok === false ? 'failed' : formatAgo(c.ts).replace(' ago', '') },
    flashClass: 'ct-flash',
    collapse: true,
  })

  function renderSide(): void {
    const now = Date.now()
    const open = attention.open()
    attnList.sync(open)
    q('.ct-allclear').hidden = open.length > 0
    q('.ct-clear').hidden = open.length === 0
    const changes = recentChanges(client.world, 20, model.halls.keys())
      .filter((c) => c.tool.endedAt !== undefined && (model.filedAt.get(c.key) ?? 0) <= now)
      .slice(0, 8)
    q('.ct-archive-h').hidden = changes.length === 0
    diffs.sync(changes)
    feed.sync(diary.filter((e) => model.halls.has(e.sessionId)).slice(-10).reverse())
  }
  d.add(attention.subscribe(() => { renderSide(); renderHalls(); renderNeeds() }))

  // ─── Card: the appointment certificate (告身) ─────────────────────────
  const card = q('.ct-card')
  function renderCard(): void {
    const sel = ui.selected
    const s = sel ? client.world.sessions[sel.hall] : undefined
    const a = s && sel ? s.agents[sel.minister] : undefined
    const hall = sel ? model.halls.get(sel.hall) : undefined
    const m = hall && sel ? hall.ministers.get(sel.minister) : undefined
    if (!s || !a || !m || !hall) { card.hidden = true; return }
    const now = Date.now()
    const act = activityOf(s, a, now)
    const recent = s.toolOrder.map((id) => s.tools[id]).filter((t) => t && t.agentId === a.id).slice(-4).reverse()
    const changes = recentChanges(client.world, 40, [s.id]).filter((ch) => ch.agentId === a.id).slice(0, 3)
    const isRoot = a.id === s.rootAgentId
    const mood = LOOKS[act.activity].label
    const actLabel = act.activity === 'waiting' ? `${Ls('启奏', 'needs you')}${act.tool ? `: ${act.tool.title}` : ''}` : act.tool ? `${mood}: ${act.tool.title}` : mood
    const fill = isRoot ? contextFill(s) : contextFill(a)
    const title = titleOf(isRoot, a.role)
    const rank = rankOf(a.depth)
    const hn = hallName(hall.nameIdx)
    card.style.setProperty('--rank', rank.color)
    card.replaceChildren(
      h('div.ct-card-head', null,
        h('span.ct-avatar', null, face(m.seed, 40)),
        h('div', null,
          h('b', null, isRoot ? (s.meta.title ?? Ls('宰相', 'Chancellor')) : a.name),
          h('div.ct-muted', null, [ui.lang === 'en' ? title.en : ui.lang === 'zh' ? title.zh : `${title.zh} ${title.en}`, harnessInfo(s.harness).label, a.model ?? s.meta.model].filter(Boolean).join(' · ')),
        ),
        h('button.ct-x', { onclick: () => { ui.selected = undefined; renderCard() }, 'aria-label': 'Close' }, '×'),
      ),
      h('div.ct-rankline', null, h('i'), ui.lang === 'en' ? `${rank.label} robe · ${hn.en}` : `${rank.zh}袍 · ${hn.zh}${ui.lang === 'accent' ? ` · ${rank.label} robe` : ''}`),
      h('div.ct-status.' + a.status + '.act-' + act.activity, null, actLabel),
      a.task && !isRoot ? h('p.ct-task', null, clip(a.task, 160)) : '',
      isRoot
        ? h('div.ct-card-stats.six', null,
          h('span', null, h('b', null, String(s.counts.turns)), 'turns'),
          h('span', null, h('b', null, formatCount(s.counts.tools)), 'tools'),
          h('span', null, h('b', null, String(s.counts.toolErrors)), 'failed'),
          h('span', null, h('b', null, formatCount(totalTokens(s.usage))), 'tokens'),
          h('span', null, h('b', null, s.meta.costUsd !== undefined ? `$${s.meta.costUsd.toFixed(2)}` : '—'), 'cost'),
          h('span', null, h('b', null, fill !== undefined ? `${Math.round(fill * 100)}%` : '—'), 'context'))
        : h('div.ct-card-stats', null,
          h('span', null, h('b', null, String(a.toolCount)), 'tools'),
          h('span', null, h('b', null, String(a.errorCount)), 'failed'),
          h('span', null, h('b', null, formatCount(totalTokens(a.usage))), 'tokens'),
          h('span', null, h('b', null, formatAgo(a.startedAt, now).replace(' ago', '')), 'at court')),
      fill !== undefined ? h('div.ct-incense' + (fill > 0.85 ? '.full' : fill > 0.6 ? '.hot' : ''), { title: `context window ${Math.round(fill * 100)}% full: the incense burns down as it fills` }, h('span', null, Ls('香', 'context')), h('div', null, h('i', { style: `width:${Math.round((1 - fill) * 100)}%` }))) : '',
      isRoot && (s.meta.gitBranch || s.meta.cwd) ? h('div.ct-muted.ct-where', { title: s.meta.cwd ?? '' }, [s.meta.cwd ? shortPath(s.meta.cwd, 2) : '', s.meta.gitBranch].filter(Boolean).join(' · ')) : '',
      changes.length ? h('ul.ct-changes', null, ...changes.map((ch) => h('li', { title: ch.change.path },
        h('i', { style: `background:${CATEGORY[ch.change.op === 'write' ? 'write' : ch.change.op === 'delete' ? 'shell' : 'edit'].color}` }),
        h('code', null, shortPath(ch.change.path, 2)),
        h('span.add', null, `+${ch.change.added}`), h('span.del', null, `−${ch.change.removed}`),
      ))) : '',
      recent.length ? h('ul.ct-recent', null, ...recent.map((t) => h('li', null,
        h('i', { style: `background:${CATEGORY[t!.category]?.color ?? '#999'}` }),
        h('span', null, clip(t!.title, 46)),
        h('em', null, t!.endedAt === undefined ? 'now' : t!.ok ? formatDuration(t!.durationMs ?? 0) : 'failed'),
      ))) : '',
      h('span.ct-card-seal', null, isRoot ? '相印' : '告身'),
    )
    card.hidden = false
    const p = toScreen(hall.ox + m.x, hall.oy + m.y, terrainZ(m.y + (model.mono ? hall.oy : 0)))
    const cw = card.offsetWidth || 290, ch = card.offsetHeight || 220
    const x = clamp(p.x + 30, 12, canvas.clientWidth - cw - 12)
    const y = clamp(p.y - ch / 2 - 20, 70, canvas.clientHeight - ch - 12)
    card.style.transform = `translate(${x}px, ${y}px)`
  }

  applyLang()

  // ─── Loop ─────────────────────────────────────────────────────────────

  let last = performance.now()
  let lastHud = 0
  let visible = ''
  d.loop((t) => {
    const dt = Math.min(0.1, (t - last) / 1000)
    last = t
    const now = Date.now()
    const world = client.world
    const ids = visibleSessions(world)
    const sig = `${oneHall()}|${ids.join('|')}`
    if (sig !== visible) {
      visible = sig
      model.layout(ids, world, oneHall())
      dirty = true
      renderHalls()
    }
    if (dirty || Math.floor(t / 500) !== Math.floor((t - dt * 1000) / 500)) {
      model.sync(world, pending, now)
      pending = []
      dirty = false
    }
    model.step(dt, now)

    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth, hh = canvas.clientHeight
    stage.classList.toggle('narrow', w < 1040)
    stage.classList.toggle('tiny', w < 720)
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hh * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(hh * dpr)
    }
    if (ui.autoFit) fit(dt)
    const diffsEl = q('.ct-diffs')
    const dr = diffsEl.offsetParent ? diffsEl.getBoundingClientRect() : undefined
    const cr = canvas.getBoundingClientRect()
    const tx = dr ? dr.left - cr.left + 30 : w + 40, ty = dr ? clamp(dr.top - cr.top + 24, 60, hh - 40) : hh / 2
    const fileTarget = { x: (tx - w / 2) / cam.zoom + cam.x, y: (ty - hh / 2) / cam.zoom + cam.y }
    renderCourt(ctx, model, world, cam, w, hh, dpr, now, dt, {
      hovered: ui.hovered, selected: ui.selected?.minister, labels: ui.labels,
      throne: ui.throne, lang: ui.lang, fileTarget,
    })

    if (t - lastHud > 400) {
      lastHud = t
      renderTop(now)
      renderSide()
      renderHalls()
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

/** One line for the court diary (起居注). */
function describe(e: ObserverEvent, lang: Lang): string {
  const zh = lang !== 'en'
  switch (e.kind) {
    case 'message': return e.role === 'user' ? `${zh ? '圣谕' : '📜 edict'} · ${clip(e.text, 80)}` : `${zh ? '奏对' : '💬'} · ${clip(e.text, 80)}`
    case 'tool.finished': return `${zh ? '失误' : '✒ ink spilled'} · ${e.output ? clip(e.output.split('\n')[0] ?? '', 50) : 'something failed'}`
    case 'agent.spawned': return `${zh ? '召见' : '🔔 summoned'} · ${e.name}${e.role ? ` (${e.role})` : ''}`
    case 'turn.ended': return e.outcome === 'completed' ? `${zh ? '事毕' : '🌸 settled'} · the matter is settled` : `${zh ? '罢朝' : '✋ halted'} · turn ${e.outcome}`
    case 'agent.status': return `${zh ? '启奏' : '🙇 presents'} · ${clip(e.reason ?? 'awaits your word', 60)}`
    default: return e.kind
  }
}
