/** Draws the audience halls. Pure presentation over the Court model. */
import type { Activity, SessionState, ToolCategory, WorldState } from '@oadt/protocol'
import { CATEGORY, harnessInfo } from '../../shared/theme'
import { alpha, mix, shade } from '../../shared/color'
import { clamp } from '../../shared/dom'
import { blobShadow, box, castShadow, cyl, easeOut, floorQuad, glowAt, grad, iso, line, poly, rnd, TW, ZH, type Pt } from '../office/iso'
import {
  activityOf, AISLE_X, ARCHIVE, CANDLES, CLOCK, DAIS, HALL_D, HALL_W, PILLARS, SCREEN, THRONE,
  type Cat, type Court, type Desk, type Hall,
} from './model'
import { hallName, KAI, PALETTES, SERIF, FONT, type Lang, type Palette, type PaletteName } from './palette'
import { drawCat, drawEmperor, drawMinister, drawOverlay, heads, type FigureCtx } from './figures'
import { drawEffects, groupEffects } from './effects'

export const WALL_H = 3.7
/** The Chancellor kneels on a low lacquered platform. */
export const LEAD_Z = 0.12
/** Terrace edge beyond the open sides of the hall, and its height. */
const TER = 0.7
const TER_H = 0.6
/** Courtyard margin around the terrace. */
const YARD = 2.6

export interface Camera { x: number; y: number; zoom: number }

export interface RenderState {
  hovered?: string
  selected?: string
  labels: boolean
  throne: 'empty' | 'emperor'
  lang: Lang
  /** Where filed memorials fly to (scene coordinates, before camera): the archive panel. */
  fileTarget?: Pt
}

interface Sprite { depth: number; draw: () => void }
export interface Light { p: Pt; rx: number; ry: number; color: string; day: number; night: number }

// ─── Palette & time ──────────────────────────────────────────────────────

let pal: Palette = PALETTES.tang
let palName: PaletteName = 'tang'
export function setPalette(name: PaletteName): void { palName = name; pal = PALETTES[name] ?? PALETTES.tang }
export function palette(): Palette { return pal }

export type TimeMode = 'auto' | 'day' | 'night'
let timeMode: TimeMode = 'auto'
export function setTimeMode(m: TimeMode): void { timeMode = m }
export function getTimeMode(): TimeMode { return timeMode }

/** 0 = deep night, 1 = full day, based on the viewer's local clock. */
export function daylight(date = new Date()): number {
  if (timeMode === 'day') return 1
  if (timeMode === 'night') return 0
  const h = date.getHours() + date.getMinutes() / 60
  if (h >= 7.5 && h <= 17.5) return 1
  if (h <= 5.5 || h >= 20) return 0
  return h < 12 ? (h - 5.5) / 2 : 1 - (h - 17.5) / 2.5
}

/** Size of the hall being drawn (the classic hall, or the great hall of the one-hall court). */
let HW = HALL_W
let HD = HALL_D
/** The throne, its dais, screen and pillars are drawn in classic-hall tiles, shifted to the middle of the hall. */
let TX = 0

/** Ground height: the hall floor is 0, the front steps lead down to the courtyard. */
export function terrainZ(y: number): number {
  const edge = HD + TER
  if (y <= edge) return 0
  return -TER_H * clamp((y - edge) / 0.9, 0, 1)
}

/** Clock tower wheel angle and speed per hall. */
const clocks = new Map<string, { angle: number; speed: number }>()

export function renderCourt(ctx: CanvasRenderingContext2D, court: Court, world: WorldState, cam: Camera, w: number, h: number, dpr: number, now: number, dt: number, rs: RenderState): void {
  const day = daylight()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  drawBackdrop(ctx, w, h, now, day)

  const sc = dpr * cam.zoom
  ctx.setTransform(sc, 0, 0, sc, Math.round(dpr * (w / 2 - cam.x * cam.zoom)), Math.round(dpr * (h / 2 - cam.y * cam.zoom)))
  const halls = [...court.halls.values()].filter((hl) => world.sessions[hl.id]).sort((a, b) => a.ox + a.oy - (b.ox + b.oy))
  const overlays: Array<() => void> = []
  groupEffects(court)
  if (court.mono) {
    // One great hall: every session is a delegation in its own bay.
    const bornAt = Math.min(...halls.map((hl) => hl.bornAt))
    drawFrame(ctx, { key: court, w: court.stage.w, d: court.stage.d, pods: halls, cat: court.cat, mono: true }, world, now, dt, day, rs, overlays, cam, dpr, now - bornAt < 700)
  } else {
    for (const hall of halls) {
      const o = iso(hall.ox, hall.oy)
      const born = clamp((now - hall.bornAt) / 700, 0, 1)
      ctx.save()
      ctx.translate(o.x, o.y)
      if (born < 1) {
        const k = easeOut(born)
        const c = iso(HALL_W / 2, HALL_D / 2, 1)
        ctx.globalAlpha = k
        ctx.translate(c.x, c.y + (1 - k) * 40)
        ctx.scale(0.86 + 0.14 * k, 0.86 + 0.14 * k)
        ctx.translate(-c.x, -c.y)
      }
      drawFrame(ctx, { key: hall, w: HALL_W, d: HALL_D, pods: [hall], cat: hall.cat, mono: false, ox: hall.ox, oy: hall.oy }, world, now, dt, day, rs, born < 1 ? [] : overlays, cam, dpr, born < 1)
      ctx.restore()
    }
  }
  for (const f of overlays) f()

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  const v = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75)
  v.addColorStop(0, 'rgba(30,14,10,0)')
  v.addColorStop(1, `rgba(30,14,10,${0.12 + (1 - day) * 0.16})`)
  ctx.fillStyle = v
  ctx.fillRect(0, 0, w, h)
}

// ─── Backdrop: sky with auspicious clouds by day, stars by night ─────────

function drawBackdrop(ctx: CanvasRenderingContext2D, w: number, h: number, now: number, day: number): void {
  const bg = ctx.createLinearGradient(0, 0, 0, h)
  bg.addColorStop(0, mix(pal.night[0], pal.day[0], day))
  bg.addColorStop(0.6, mix(pal.night[1], pal.day[1], day))
  bg.addColorStop(1, mix(pal.night[2], pal.day[2], day))
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, w, h)
  const g = ctx.createRadialGradient(w * 0.45, h * 0.3, 0, w * 0.45, h * 0.3, Math.max(w, h) * 0.6)
  g.addColorStop(0, day > 0.5 ? `rgba(255,248,230,${0.5 * day})` : `rgba(110,120,200,${0.2 * (1 - day)})`)
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  if (day < 0.85) {
    ctx.save()
    for (let i = 0; i < 80; i++) {
      const x = rnd(i, 1) * w, y = rnd(i, 2) * h * 0.85
      const tw = 0.55 + 0.45 * Math.sin(now / (500 + rnd(i, 3) * 900) + i)
      ctx.globalAlpha = (1 - day) * tw * (0.3 + rnd(i, 4) * 0.5)
      ctx.fillStyle = i % 6 === 0 ? '#ffe2a8' : '#ffffff'
      ctx.beginPath(); ctx.arc(x, y, 0.6 + rnd(i, 5) * 1.3, 0, Math.PI * 2); ctx.fill()
    }
    // The moon.
    ctx.globalAlpha = 1 - day
    const mx = w * 0.84, my = h * 0.16
    const mg = ctx.createRadialGradient(mx, my, 0, mx, my, 70)
    mg.addColorStop(0, 'rgba(255,240,200,0.35)')
    mg.addColorStop(1, 'rgba(255,240,200,0)')
    ctx.fillStyle = mg
    ctx.fillRect(mx - 70, my - 70, 140, 140)
    ctx.fillStyle = '#fff3cf'
    ctx.beginPath(); ctx.arc(mx, my, 17, 0, Math.PI * 2); ctx.fill()
    ctx.restore()
  }
  // Auspicious clouds (祥云) drifting across: little spiral scrolls.
  ctx.save()
  for (let i = 0; i < 7; i++) {
    const speed = 60 + rnd(i, 12) * 90
    const x = ((rnd(i, 11) * (w + 300) + now / speed) % (w + 300)) - 150
    const y = 40 + rnd(i, 13) * h * 0.75
    const s = 0.6 + rnd(i, 14) * 0.9
    ctx.globalAlpha = (0.1 + rnd(i, 15) * 0.1) * (day > 0.5 ? 1 : 0.5)
    drawCloud(ctx, x, y, s, day > 0.5 ? '#ffffff' : '#c9cdf0')
  }
  ctx.restore()
}

function drawCloud(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, color: string): void {
  ctx.save()
  ctx.translate(x, y)
  ctx.scale(s, s)
  ctx.fillStyle = color
  ctx.strokeStyle = color
  ctx.lineWidth = 3
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.ellipse(0, 0, 46, 9, 0, 0, Math.PI * 2)
  ctx.fill()
  for (const [cx, cy, r, dir] of [[-22, -8, 11, 1], [4, -12, 14, -1], [28, -6, 9, 1]] as const) {
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill()
    // Curl.
    ctx.globalAlpha *= 0.9
    ctx.beginPath()
    for (let k = 0; k < 24; k++) {
      const a = k * 0.42 * dir, rr = r * 0.85 * (1 - k / 30)
      const px = cx + Math.cos(a) * rr, py = cy - r * 0.2 + Math.sin(a) * rr * 0.8
      if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py)
    }
    ctx.stroke()
  }
  ctx.restore()
}

// ─── Hall ────────────────────────────────────────────────────────────────

interface Frame {
  /** What the cached static layer belongs to. */
  key: object
  w: number
  d: number
  /** The sessions in this hall: one in a classic hall, every delegation in the great hall. */
  pods: Hall[]
  cat: Cat
  mono: boolean
  /** World offset of the frame (pods are placed relative to it). */
  ox?: number
  oy?: number
}

interface StaticLayer { key: string; canvas: HTMLCanvasElement }
const staticLayers = new WeakMap<object, StaticLayer>()

function staticBounds(w: number, d: number) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const x of [-YARD - 0.2, w + YARD + 0.2]) for (const y of [-YARD - 0.2, d + YARD + 1.2]) for (const z of [-TER_H - 0.4, WALL_H + 0.6]) {
    const p = iso(x, y, z)
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
  }
  return { minX: Math.floor(minX), minY: Math.floor(minY), maxX: Math.ceil(maxX), maxY: Math.ceil(maxY) }
}

/** Lattice windows along the back wall, clear of the clock tower and the throne's wall. */
function backWindows(): number[] {
  const xs: number[] = []
  for (let x = 2.6; x + 1.4 < TX + 2.55; x += 2.05) xs.push(x)
  for (let x = TX + 10.85; x + 1.4 < HW - 0.3; x += 2.05) xs.push(x)
  return xs
}

/** The great hall is named for grand audiences. */
const GREAT_HALL = 5

function drawFrame(
  ctx: CanvasRenderingContext2D, f: Frame, world: WorldState, now: number, dt: number, day: number, rs: RenderState,
  overlays: Array<() => void>, cam: Camera, dpr: number, animating: boolean,
): void {
  HW = f.w
  HD = f.d
  TX = f.w / 2 - AISLE_X
  const fox = f.ox ?? 0, foy = f.oy ?? 0
  const pods = f.pods.map((hall) => {
    const s = world.sessions[hall.id]!
    const acts = new Map<string, ReturnType<typeof activityOf>>()
    for (const m of hall.ministers.values()) acts.set(m.id, activityOf(s, s.agents[m.id], now))
    return { hall, s, acts, hc: harnessInfo(hall.harness).color }
  })
  const allActs = pods.flatMap((p) => [...p.acts.values()])
  const anyWaiting = allActs.some((a) => a.activity === 'waiting')
  const running = allActs.some((a) => a.activity === 'running')
  const live = pods.some((p) => p.s.status === 'working' || p.s.status === 'waiting')
  const hc = f.mono ? pal.gold : pods[0]!.hc
  const lights: Light[] = []
  const first = pods[0]!

  // Ground shadow under the diorama.
  {
    const c = iso(HW / 2 + 0.6, HD / 2 + 0.8, -TER_H)
    ctx.save()
    ctx.translate(c.x, c.y + 18)
    ctx.scale(1, 0.5)
    const r = (HW + HD + YARD * 2) * TW * 0.36
    const g = ctx.createRadialGradient(0, 0, r * 0.2, 0, 0, r)
    g.addColorStop(0, `rgba(40,20,10,${0.26 - day * 0.08})`)
    g.addColorStop(1, 'rgba(40,20,10,0)')
    ctx.fillStyle = g
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill()
    ctx.restore()
  }

  // The static shell only changes with size, zoom, daylight and palette: render it once offscreen.
  const scale = dpr * cam.zoom
  const bounds = staticBounds(HW, HD)
  const key = `${HW}x${HD}|${Math.round(scale * 64)}|${Math.round(day * 24)}|${palName}`
  if (animating || scale > 3.2) drawStatic(ctx, day)
  else {
    let layer = staticLayers.get(f.key)
    if (!layer || layer.key !== key) {
      const canvas = layer?.canvas ?? document.createElement('canvas')
      canvas.width = Math.ceil((bounds.maxX - bounds.minX) * scale)
      canvas.height = Math.ceil((bounds.maxY - bounds.minY) * scale)
      const c2 = canvas.getContext('2d')!
      c2.setTransform(scale, 0, 0, scale, -bounds.minX * scale, -bounds.minY * scale)
      drawStatic(c2, day)
      layer = { key, canvas }
      staticLayers.set(f.key, layer)
    }
    const m = ctx.getTransform()
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.drawImage(layer.canvas, Math.round(m.e + bounds.minX * scale), Math.round(m.f + bounds.minY * scale))
    ctx.restore()
  }
  for (const lx of backWindows()) drawWindowLight(ctx, lx, day, now)

  // The throne's end of the hall, drawn in classic tiles and shifted to the middle.
  const t0 = iso(TX, 0)
  const throneSide = (draw: () => void) => { ctx.save(); ctx.translate(t0.x, t0.y); draw(); ctx.restore() }
  throneSide(() => {
    if (f.mono) drawPlaque(ctx, hallName(GREAT_HALL), `${pods.length} ${rs.lang === 'zh' ? '殿议' : 'sessions in audience'}`, live ? 'working' : 'idle', rs.lang)
    else drawPlaque(ctx, hallName(first.hall.nameIdx), first.hall.title, first.s.status, rs.lang)
    drawPlanScroll(ctx, f.mono ? undefined : first.hall.plan)
    for (const lx of [4.75, 10.25]) drawLantern(ctx, lx, 0.45, now, live, lights, day)
    drawDais(ctx, now, live, lights)
    drawScreen(ctx, pods.map((p) => p.s), now)
    drawThrone(ctx, now, anyWaiting)
    lights.forEach((l) => { l.p = { x: l.p.x + t0.x, y: l.p.y + t0.y } })
  })

  // Shared furniture at the back: pillars, candles, the clock tower, the emperor.
  const back: Sprite[] = []
  const shifted = (draw: () => void) => () => {
    const n = lights.length
    throneSide(draw)
    for (let i = n; i < lights.length; i++) lights[i]!.p = { x: lights[i]!.p.x + t0.x, y: lights[i]!.p.y + t0.y }
  }
  PILLARS.forEach((p, i) => back.push({ depth: p.x + TX + p.y, draw: shifted(() => drawPillar(ctx, p.x, p.y, now, i)) }))
  CANDLES.forEach((p) => back.push({ depth: p.x + TX + p.y - 0.2, draw: shifted(() => drawCraneCandle(ctx, p.x, p.y, now, lights)) }))
  back.push({ depth: CLOCK.x + CLOCK.w + CLOCK.y + CLOCK.d - 0.6, draw: () => drawClockTower(ctx, f.mono ? 'great-hall' : first.hall.id, Math.max(...pods.map((p) => p.hall.drumAt)), now, dt, running, lights) })
  if (rs.throne === 'emperor') back.push({ depth: THRONE.x + TX + THRONE.y + 0.1, draw: shifted(() => drawEmperor(ctx, { pal, day, now, hc, throne: rs.throne }, anyWaiting, first.s)) })
  back.sort((a, b) => a.depth - b.depth)
  for (const sp of back) sp.draw()

  // Each delegation (in a classic hall, the whole hall's people).
  for (const pod of pods) {
    const { hall, s, acts } = pod
    const po = iso(hall.ox - fox, hall.oy - foy)
    const origin = iso(hall.ox, hall.oy)
    const podLights: Light[] = []
    ctx.save()
    ctx.translate(po.x, po.y)
    drawPodFloor(ctx, hall, f.mono, pod.hc)
    for (const m of hall.ministers.values()) {
      if (m.mode !== 'kneeling' && m.mode !== 'resting') blobShadow(ctx, m.x, m.y, 0.36, 0.3 * m.alpha)
    }
    if (!f.mono) blobShadow(ctx, f.cat.x, f.cat.y, 0.3, 0.3)
    const sprites: Sprite[] = []
    const add = (depth: number, draw: () => void) => sprites.push({ depth, draw })
    const fig: FigureCtx = { pal, day, now, hc: pod.hc, throne: rs.throne }
    hall.desks.forEach((d, i) => {
      const occ = d.occupant ? hall.ministers.get(d.occupant) : undefined
      const agent = occ ? s.agents[occ.id] : undefined
      const act = occ && occ.mode === 'kneeling' ? acts.get(occ.id) : undefined
      const fill = agent?.contextTokens && agent.contextWindow ? Math.min(1, agent.contextTokens / agent.contextWindow) : d.lead && s.contextTokens && s.contextWindow ? Math.min(1, s.contextTokens / s.contextWindow) : undefined
      add(d.x + d.w / 2 + d.y + d.d / 2 + (d.facing === -1 ? -0.4 : 0), () => drawDesk(ctx, d, act?.activity, fill, now, i, podLights, day))
    })
    const tea = hall.layout.tea.table
    add(tea.x + tea.y, () => drawTeaTable(ctx, tea.x, tea.y, now))
    if (f.mono) add(0.6 - 0.15, () => drawPodSign(ctx, hall, s, pod.hc, now, rs.lang))
    else add(f.cat.x + f.cat.y, () => drawCat(ctx, f.cat, now))
    for (const m of hall.ministers.values()) {
      const act = acts.get(m.id)!
      const z = terrainZ(m.y + hall.oy - foy) + (m.isRoot && m.mode === 'kneeling' ? LEAD_Z : 0)
      add(m.x + m.y + (m.mode === 'kneeling' ? -0.05 : 0.05), () => {
        const pos = drawMinister(ctx, fig, m, act, z, rs.hovered === m.id || rs.selected === m.id)
        heads.set(`${hall.id}/${m.id}`, pos.head)
        overlays.push(() => drawOverlay(ctx, origin, pos, m, act, now, rs, cam.zoom))
      })
    }
    sprites.sort((a, b) => a.depth - b.depth)
    for (const sp of sprites) sp.draw()
    ctx.restore()
    for (const l of podLights) lights.push({ ...l, p: { x: l.p.x + po.x, y: l.p.y + po.y } })
    overlays.push(() => {
      ctx.save()
      ctx.translate(origin.x, origin.y)
      drawEffects(ctx, hall, now, origin, rs.fileTarget)
      ctx.restore()
    })
    if (f.mono && cam.zoom < 0.7) overlays.push(() => drawPodBanner(ctx, origin, hall, pod.acts, now, rs.lang, cam.zoom))
  }

  // Shared things in front: balustrades, stone lanterns, the plum trees, the ding, the great hall's cat.
  const front: Sprite[] = []
  const addF = (depth: number, draw: () => void) => front.push({ depth, draw })
  const cx = HW / 2
  for (const lx of [cx - 2.1, cx + 2.1]) addF(lx + HD + 2.3, () => drawStoneLantern(ctx, lx, HD + 2.3, lights, day))
  addF(HW + 1.7 - 1.3 + 0.6, () => drawPlum(ctx, HW + 1.7, -1.3, now, 0))
  addF(-1.5 + HD + 2.2, () => drawPlum(ctx, -1.5, HD + 2.2, now, 1))
  addF(HW + 1.3 + HD + 1.7, () => drawDing(ctx, HW + 1.3, HD + 1.7, now, live))
  for (let x = -0.3; x < HW + TER - 0.1; x += 1) {
    const x1 = Math.min(x + 1, HW + TER - 0.05)
    if (x1 > cx - 1.3 && x < cx + 1.3) continue
    addF(x + 0.5 + HD + TER - 0.05, () => drawRail(ctx, x, HD + TER - 0.08, x1, HD + TER - 0.08))
  }
  for (let y = -0.3; y < HD + TER - 0.1; y += 1) {
    const y1 = Math.min(y + 1, HD + TER - 0.08)
    addF(HW + TER - 0.08 + y + 0.5, () => drawRail(ctx, HW + TER - 0.08, y, HW + TER - 0.08, y1))
  }
  if (f.mono) {
    blobShadow(ctx, f.cat.x, f.cat.y, 0.3, 0.3)
    addF(f.cat.x + f.cat.y, () => drawCat(ctx, f.cat, now))
  }
  front.sort((a, b) => a.depth - b.depth)
  for (const sp of front) sp.draw()

  // Gong ripple at the steps when someone is summoned.
  const gongAt = Math.max(...pods.map((p) => p.hall.gongAt))
  if (now - gongAt < 1800) {
    const k = (now - gongAt) / 1800
    const p = iso(cx, HD + 1.1, terrainZ(HD + 1.1))
    for (let i = 0; i < 3; i++) {
      const kk = clamp(k * 1.3 - i * 0.15, 0, 1)
      if (kk <= 0 || kk >= 1) continue
      ctx.strokeStyle = alpha(pal.gold, (1 - kk) * 0.8)
      ctx.lineWidth = 2
      ctx.beginPath(); ctx.ellipse(p.x, p.y, 12 + kk * 46, 6 + kk * 23, 0, 0, Math.PI * 2); ctx.stroke()
    }
  }

  // Night: multiply the diorama with a cool tone, then add the lights back.
  if (day < 0.999) {
    ctx.save()
    ctx.globalCompositeOperation = 'multiply'
    const X0 = -YARD, Y0 = -YARD, X1 = HW + YARD, Y1 = HD + YARD + 1, Z0 = -TER_H - 0.3, Z1 = WALL_H + 0.5
    poly(ctx, [iso(X0, Y0, Z1 + 1.5), iso(X1, Y0, Z1 + 1.5), iso(X1, Y0, Z0), iso(X1, Y1, Z0), iso(X0, Y1, Z0), iso(X0, Y1, Z1)], mix('#ffffff', '#4f56a8', (1 - day) * 0.72))
    ctx.restore()
    for (const lx of backWindows()) {
      const a = iso(lx + 0.1, 0.02), b = iso(lx + 1.3, 0.02)
      poly(ctx, [a, b, iso(lx + 2.2, 2.9), iso(lx - 0.6, 2.9)], grad(ctx, a, iso(lx, 2.9), `rgba(170,190,255,${0.18 * (1 - day)})`, 'rgba(170,190,255,0)'))
    }
  }
  for (const l of lights) glowAt(ctx, l.p, l.rx, l.ry, l.color, l.day * day + l.night * (1 - day))
  // The throne listens: a warm glow when someone is presenting a matter.
  if (anyWaiting) glowAt(ctx, iso(THRONE.x + TX, THRONE.y, 0.9), 70, 50, '#ffcf6a', 0.22 + 0.12 * Math.sin(now / 260))
  if (live && day > 0.3) glowAt(ctx, iso(cx, HD, 0), 80, 36, hc, 0.1 * day)
}

// ─── Static shell ────────────────────────────────────────────────────────

function drawStatic(ctx: CanvasRenderingContext2D, day: number): void {
  drawCourtyard(ctx)
  drawTerrace(ctx)
  drawFloor(ctx)
  drawWallsStatic(ctx, day)
  drawArchive(ctx)
  for (const p of PILLARS) blobShadow(ctx, p.x + TX + 0.15, p.y + 0.15, 0.5, 0.22)
  castShadow(ctx, CLOCK.x, CLOCK.y, CLOCK.w, CLOCK.d, 2.6, 0.14)
  castShadow(ctx, ARCHIVE.x, ARCHIVE.y, ARCHIVE.w, ARCHIVE.d, ARCHIVE.h, 0.13)
  castShadow(ctx, DAIS.x + TX, DAIS.y, DAIS.w, DAIS.d, 0.45, 0.12)
}

/** A delegation's floor: its rug (in the great hall), mats, the Chancellor's platform, the tea mat and cushions, desk shadows. */
function drawPodFloor(ctx: CanvasRenderingContext2D, hall: Hall, mono: boolean, hc: string): void {
  if (mono) {
    // The bay's rug, edged in the harness colour.
    const ys = hall.desks.map((d) => d.y + d.d)
    const d = Math.max(...ys, hall.layout.tea.rug.y + hall.layout.tea.rug.d) + 0.35
    floorQuad(ctx, 0.15, -0.15, 5.55, d + 0.15, alpha(mix(pal.carpet, hc, 0.35), 0.55), 0.001)
    floorQuad(ctx, 0.3, 0, 5.25, d - 0.15, alpha(shade(pal.floor, 0.06), 0.55), 0.0015)
  }
  for (const d of hall.desks) {
    const s = d.seat.at
    const mw = d.lead ? 1.15 : 0.86, md = d.lead ? 0.86 : 0.8
    const mz = d.lead ? LEAD_Z : 0
    if (d.lead) box(ctx, s.x - mw / 2 - 0.1, s.y - md / 2 - 0.1, 0, mw + 0.2, md + 0.2, LEAD_Z, pal.lacquer, { top: shade(pal.lacquer, 0.15) })
    floorQuad(ctx, s.x - mw / 2, s.y - md / 2, mw, md, shade(pal.mat, -0.12), mz + 0.004)
    floorQuad(ctx, s.x - mw / 2 + 0.05, s.y - md / 2 + 0.05, mw - 0.1, md - 0.1, pal.mat, mz + 0.005)
    for (let k = 0.12; k < mw - 0.1; k += 0.1) line(ctx, iso(s.x - mw / 2 + 0.05 + k, s.y - md / 2 + 0.05, mz + 0.006), iso(s.x - mw / 2 + 0.05 + k, s.y + md / 2 - 0.05, mz + 0.006), alpha(shade(pal.mat, -0.3), 0.3), 0.7)
    castShadow(ctx, d.x, d.y, d.w, d.d, 0.38, 0.14)
  }
  const { x, y, w, d } = hall.layout.tea.rug
  floorQuad(ctx, x, y, w, d, shade(pal.carpet, 0.05), 0.003)
  floorQuad(ctx, x + 0.1, y + 0.1, w - 0.2, d - 0.2, mix(pal.carpet, pal.paper, 0.35), 0.004)
  for (const { at } of hall.layout.rest) {
    floorQuad(ctx, at.x - 0.28, at.y - 0.24, 0.56, 0.48, shade(pal.gold, -0.15), 0.006)
    floorQuad(ctx, at.x - 0.22, at.y - 0.18, 0.44, 0.36, pal.gold, 0.008)
  }
}

/** The delegation's signboard at the head of its bay: hall name, session title, and a bell when it needs you. */
function drawPodSign(ctx: CanvasRenderingContext2D, hall: Hall, s: SessionState, hc: string, now: number, lang: Lang): void {
  const x0 = 0.2, x1 = 1.85, y = -0.2
  for (const px of [x0 + 0.1, x1 - 0.1]) box(ctx, px - 0.04, y - 0.04, 0, 0.08, 0.08, 1.45, pal.timberDark, { edge: false })
  const W = (x1 - x0) * 32, H = 0.62 * ZH
  const waiting = Object.values(s.agents).some((a) => a.status === 'waiting')
  onWallX(ctx, x0, y + 0.05, 1.55, () => {
    ctx.fillStyle = 'rgba(0,0,0,0.2)'
    ctx.fillRect(2, 2, W, H)
    ctx.fillStyle = pal.lacquer
    ctx.fillRect(0, 0, W, H)
    ctx.fillStyle = hc
    ctx.fillRect(0, 0, W, 3)
    ctx.strokeStyle = alpha(pal.gold, 0.7)
    ctx.lineWidth = 0.8
    ctx.strokeRect(1.5, 4.5, W - 3, H - 6)
    const name = hallName(hall.nameIdx)
    ctx.textBaseline = 'middle'
    ctx.fillStyle = pal.gold
    ctx.font = lang === 'en' ? `700 6.5px ${SERIF}` : `700 9px ${KAI}`
    ctx.fillText(lang === 'en' ? name.en : name.zh, 5, 10.5)
    ctx.fillStyle = '#fff6e0'
    ctx.font = `700 6px ${FONT}`
    let title = hall.title
    while (title.length > 3 && ctx.measureText(title).width > W - 10) title = title.slice(0, -2) + '…'
    ctx.fillText(title, 5, H - 5.5)
    ctx.fillStyle = s.status === 'working' ? '#e0483a' : waiting ? '#f2b33d' : 'rgba(255,255,255,0.3)'
    ctx.fillRect(W - 9, 7.5, 5, 5)
  })
  if (waiting) {
    // A little bronze bell swings under the board.
    const p = iso(x1 - 0.3, y, 0.95)
    const sw = Math.sin(now / 160) * 0.35
    ctx.save()
    ctx.translate(p.x, p.y)
    ctx.rotate(sw)
    ctx.fillStyle = '#d9a441'
    ctx.beginPath(); ctx.moveTo(-4, 6); ctx.quadraticCurveTo(-4, -2, 0, -3); ctx.quadraticCurveTo(4, -2, 4, 6); ctx.closePath(); ctx.fill()
    ctx.fillStyle = '#7a5418'
    ctx.beginPath(); ctx.arc(0, 7, 1.4, 0, Math.PI * 2); ctx.fill()
    ctx.restore()
  }
}

/** From far away, each delegation gets a readable banner over its bay. */
function drawPodBanner(ctx: CanvasRenderingContext2D, origin: Pt, hall: Hall, acts: Map<string, { activity: Activity }>, now: number, lang: Lang, zoom: number): void {
  const waiting = [...acts.values()].filter((a) => a.activity === 'waiting').length
  const p = iso(1.05, -0.2, 2.4)
  ctx.save()
  ctx.translate(origin.x + p.x, origin.y + p.y)
  const k = clamp((0.7 - zoom) / 0.12, 0, 1)
  ctx.globalAlpha = k
  ctx.scale(0.75 / zoom, 0.75 / zoom)
  const name = hallName(hall.nameIdx)
  const title = hall.title.length > 28 ? hall.title.slice(0, 27) + '…' : hall.title
  ctx.font = `700 12px ${FONT}`
  const tw = ctx.measureText(title).width
  const label = lang === 'en' ? '' : name.zh
  ctx.font = `700 13px ${KAI}`
  const lw = label ? ctx.measureText(label).width + 8 : 0
  const w = tw + lw + 22, h = 24
  const b = waiting ? Math.abs(Math.sin(now / 260)) * 4 : 0
  ctx.translate(0, -b)
  ctx.fillStyle = 'rgba(0,0,0,0.22)'
  ctx.fillRect(-w / 2 + 2, -h + 3, w, h)
  ctx.fillStyle = waiting ? '#f2b33d' : pal.lacquer
  ctx.fillRect(-w / 2, -h, w, h)
  ctx.fillStyle = harnessInfo(hall.harness).color
  ctx.fillRect(-w / 2, -h, 4, h)
  ctx.textBaseline = 'middle'
  let x = -w / 2 + 11
  if (label) {
    ctx.fillStyle = waiting ? '#3a2600' : pal.gold
    ctx.font = `700 13px ${KAI}`
    ctx.fillText(label, x, -h / 2 + 0.5)
    x += lw
  }
  ctx.fillStyle = waiting ? '#3a2600' : '#fff6e0'
  ctx.font = `700 12px ${FONT}`
  ctx.fillText(title, x, -h / 2 + 0.5)
  if (waiting) {
    ctx.fillStyle = '#b3261e'
    ctx.beginPath(); ctx.arc(w / 2, -h, 9, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.font = `800 11px ${FONT}`
    ctx.textAlign = 'center'
    ctx.fillText(String(waiting), w / 2, -h + 0.5)
  }
  ctx.restore()
}

function drawCourtyard(ctx: CanvasRenderingContext2D): void {
  const X0 = -YARD, Y0 = -YARD, X1 = HW + YARD, Y1 = HD + YARD + 1, Z = -TER_H
  // Ground slab sides.
  poly(ctx, [iso(X0, Y1, Z), iso(X1, Y1, Z), iso(X1, Y1, Z - 0.3), iso(X0, Y1, Z - 0.3)], grad(ctx, iso(X0, Y1, Z), iso(X0, Y1, Z - 0.3), shade(pal.paving, -0.15), shade(pal.paving, -0.3)))
  poly(ctx, [iso(X1, Y0, Z), iso(X1, Y1, Z), iso(X1, Y1, Z - 0.3), iso(X1, Y0, Z - 0.3)], grad(ctx, iso(X1, Y0, Z), iso(X1, Y0, Z - 0.3), shade(pal.paving, -0.28), shade(pal.paving, -0.4)))
  floorQuad(ctx, X0, Y0, X1 - X0, Y1 - Y0, pal.paving, Z)
  // Large stone slabs.
  for (let y = Y0; y < Y1; y += 1.3) {
    const off = rnd(Math.round(y * 10), 7) * 1.3
    for (let x = X0 - off; x < X1; x += 1.3) {
      const x0 = Math.max(X0, x), x1 = Math.min(X1, x + 1.3), y1 = Math.min(Y1, y + 1.3)
      floorQuad(ctx, x0, y, x1 - x0, y1 - y, shade(pal.paving, (rnd(Math.round(x * 10), Math.round(y * 10)) - 0.5) * 0.07), Z)
    }
    line(ctx, iso(X0, y, Z), iso(X1, y, Z), 'rgba(60,45,30,0.12)')
  }
  // Palace walls behind and to the left: vermilion with a tiled coping.
  const PW = 1.75
  const wallC = pal.palaceWall
  poly(ctx, [iso(X0, Y0, Z), iso(X1, Y0, Z), iso(X1, Y0, Z + PW), iso(X0, Y0, Z + PW)], grad(ctx, iso(X0, Y0, Z + PW), iso(X0, Y0, Z), shade(wallC, 0.04), shade(wallC, -0.12)))
  poly(ctx, [iso(X0, Y0, Z), iso(X0, Y1, Z), iso(X0, Y1, Z + PW), iso(X0, Y0, Z + PW)], grad(ctx, iso(X0, Y0, Z + PW), iso(X0, Y0, Z), shade(wallC, -0.1), shade(wallC, -0.24)))
  poly(ctx, [iso(X0, Y0, Z), iso(X1, Y0, Z), iso(X1, Y0, Z + 0.22), iso(X0, Y0, Z + 0.22)], shade(pal.marble, -0.1))
  poly(ctx, [iso(X0, Y0, Z), iso(X0, Y1, Z), iso(X0, Y1, Z + 0.22), iso(X0, Y0, Z + 0.22)], shade(pal.marble, -0.2))
  // Coping: a little tiled roof on top.
  const cz = Z + PW
  poly(ctx, [iso(X0 - 0.25, Y0 - 0.25, cz + 0.32), iso(X1, Y0 - 0.25, cz + 0.32), iso(X1, Y0 + 0.3, cz), iso(X0 + 0.3, Y0 + 0.3, cz)], shade(pal.tile, 0.08))
  poly(ctx, [iso(X0 - 0.25, Y0 - 0.25, cz + 0.32), iso(X0 + 0.3, Y0 + 0.3, cz), iso(X0 + 0.3, Y1, cz), iso(X0 - 0.25, Y1, cz + 0.32)], shade(pal.tile, -0.08))
  line(ctx, iso(X0 + 0.3, Y0 + 0.3, cz), iso(X1, Y0 + 0.3, cz), pal.trim, 1.6)
  line(ctx, iso(X0 + 0.3, Y0 + 0.3, cz), iso(X0 + 0.3, Y1, cz), pal.trim, 1.6)
  for (let x = X0 + 0.5; x < X1; x += 0.28) line(ctx, iso(x, Y0 - 0.2, cz + 0.3), iso(x + 0.02, Y0 + 0.28, cz + 0.02), 'rgba(0,0,0,0.18)', 0.8)
  for (let y = Y0 + 0.5; y < Y1; y += 0.28) line(ctx, iso(X0 - 0.2, y, cz + 0.3), iso(X0 + 0.28, y + 0.02, cz + 0.02), 'rgba(0,0,0,0.14)', 0.8)
}

function drawTerrace(ctx: CanvasRenderingContext2D): void {
  const X0 = -0.3, Y0 = -0.3, X1 = HW + TER, Y1 = HD + TER, Z = -TER_H
  const m = pal.marble
  castShadow(ctx, X0, Y0, X1 - X0, Y1 - Y0, 0.1, 0)
  // Front face (须弥座: a plinth with carved bands).
  poly(ctx, [iso(X0, Y1, 0), iso(X1, Y1, 0), iso(X1, Y1, Z), iso(X0, Y1, Z)], grad(ctx, iso(X0, Y1, 0), iso(X0, Y1, Z), shade(m, -0.05), shade(m, -0.18)))
  poly(ctx, [iso(X1, Y0, 0), iso(X1, Y1, 0), iso(X1, Y1, Z), iso(X1, Y0, Z)], grad(ctx, iso(X1, Y0, 0), iso(X1, Y0, Z), shade(m, -0.2), shade(m, -0.32)))
  for (const k of [0.12, 0.42]) {
    line(ctx, iso(X0, Y1, -k), iso(X1, Y1, -k), 'rgba(80,60,40,0.18)', 1)
    line(ctx, iso(X1, Y0, -k), iso(X1, Y1, -k), 'rgba(60,40,30,0.2)', 1)
  }
  for (let x = X0 + 0.8; x < X1; x += 1.6) line(ctx, iso(x, Y1, -0.12), iso(x, Y1, -0.42), 'rgba(80,60,40,0.15)', 1)
  for (let y = Y0 + 0.8; y < Y1; y += 1.6) line(ctx, iso(X1, y, -0.12), iso(X1, y, -0.42), 'rgba(60,40,30,0.18)', 1)
  floorQuad(ctx, X0, Y0, X1 - X0, Y1 - Y0, m, 0)
  // Front steps with the carved imperial ramp (御路) in the middle.
  const sx0 = (HW / 2) - 1.3, sx1 = (HW / 2) + 1.3, N = 4
  for (let i = 0; i < N; i++) {
    const y0 = Y1 + (i * 0.9) / N, y1 = Y1 + ((i + 1) * 0.9) / N, z = -(i + 1) * (TER_H / N)
    box(ctx, sx0, y0, Z, sx1 - sx0, y1 - y0, z - Z + TER_H / N, shade(m, -0.02 - i * 0.015), { edge: false })
  }
  const ramp = [iso((HW / 2) - 0.42, Y1, 0.002), iso((HW / 2) + 0.42, Y1, 0.002), iso((HW / 2) + 0.42, Y1 + 0.9, Z + 0.002), iso((HW / 2) - 0.42, Y1 + 0.9, Z + 0.002)]
  poly(ctx, ramp, shade(m, -0.08))
  // A cloud-and-dragon relief, suggested.
  ctx.strokeStyle = 'rgba(90,70,50,0.28)'
  ctx.lineWidth = 0.9
  for (let k = 0; k < 4; k++) {
    const p = iso((HW / 2) - 0.25 + (k % 2) * 0.5, Y1 + 0.15 + k * 0.2, -0.1 - k * 0.13)
    ctx.beginPath(); ctx.arc(p.x, p.y, 2.6, 0, Math.PI * 1.6); ctx.stroke()
  }
  // Carpet runner continues across the terrace to the steps.
  floorQuad(ctx, (HW / 2) - 0.62, HD, 1.24, TER, pal.carpet, 0.003)
}

function drawFloor(ctx: CanvasRenderingContext2D): void {
  // Polished floor bricks (金砖), laid square.
  floorQuad(ctx, 0, 0, HW, HD, pal.floor)
  for (let y = 0; y < HD; y++) {
    for (let x = 0; x < HW; x++) {
      floorQuad(ctx, x, y, 1, 1, shade(pal.floor, (rnd(x, y, 3) - 0.5) * 0.08 + ((x + y) % 2 ? 0.015 : -0.015)))
    }
    if (y > 0) line(ctx, iso(0, y), iso(HW, y), 'rgba(30,20,10,0.22)')
  }
  for (let x = 1; x < HW; x++) line(ctx, iso(x, 0), iso(x, HD), 'rgba(30,20,10,0.2)')
  // Polish: a sheen from the light, occlusion along the walls.
  floorQuad(ctx, 0, 0, HW, HD, grad(ctx, iso(3, 0), iso(HW, HD), 'rgba(255,240,210,0.2)', 'rgba(255,240,210,0)'))
  floorQuad(ctx, 0, 0, HW, 1.2, edgeGrad(ctx, iso(0, 0), iso(HW, 0), iso(0, 1.2), 'rgba(40,20,10,0.22)', 'rgba(40,20,10,0)'))
  floorQuad(ctx, 0, 0, 1.2, HD, edgeGrad(ctx, iso(0, 0), iso(0, HD), iso(1.2, 0), 'rgba(40,20,10,0.22)', 'rgba(40,20,10,0)'))
  // The imperial carpet down the aisle, with a gold border and roundels.
  const cx0 = (HW / 2) - 0.62, cw = 1.24, cy0 = DAIS.d
  floorQuad(ctx, cx0, cy0, cw, HD - cy0, shade(pal.carpet, -0.08), 0.002)
  floorQuad(ctx, cx0 + 0.07, cy0, cw - 0.14, HD - cy0, pal.carpetBorder, 0.003)
  floorQuad(ctx, cx0 + 0.12, cy0, cw - 0.24, HD - cy0, pal.carpet, 0.004)
  for (let y = cy0 + 0.9; y < HD; y += 1.5) {
    const c = iso((HW / 2), y, 0.005)
    ctx.save()
    ctx.translate(c.x, c.y)
    ctx.scale(1, 0.5)
    ctx.strokeStyle = alpha(pal.carpetBorder, 0.8)
    ctx.lineWidth = 1.4
    ctx.beginPath(); ctx.arc(0, 0, 11, 0, Math.PI * 2); ctx.stroke()
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2
      ctx.beginPath(); ctx.ellipse(Math.cos(a) * 5.5, Math.sin(a) * 5.5, 3.4, 1.8, a, 0, Math.PI * 2); ctx.fillStyle = alpha(pal.carpetBorder, 0.55); ctx.fill()
    }
    ctx.restore()
  }
}

/** A gradient whose iso-lines are parallel to the screen line a→b, running from that line to the parallel line through c. */
export function edgeGrad(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, c: Pt, c0: string, c1: string): CanvasGradient {
  const dx = b.x - a.x, dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  let nx = -dy / len, ny = dx / len
  const t = (c.x - a.x) * nx + (c.y - a.y) * ny
  if (t < 0) { nx = -nx; ny = -ny }
  const d = Math.abs(t)
  return grad(ctx, a, { x: a.x + nx * d, y: a.y + ny * d }, c0, c1)
}

/** Draw in a 2D plane aligned with the back wall (along x). Origin at world (x, y, z); +x along the wall, +y down. 1 tile = 32 px. */
export function onWallX(ctx: CanvasRenderingContext2D, x: number, y: number, z: number, draw: () => void): void {
  const p = iso(x, y, z)
  ctx.save()
  ctx.transform(1, 0.5, 0, 1, p.x, p.y)
  draw()
  ctx.restore()
}

/** Draw in a plane aligned with the left wall (along y); +x goes toward smaller y (reads left to right). 1 tile = 32 px. */
export function onWallY(ctx: CanvasRenderingContext2D, x: number, y: number, z: number, draw: () => void): void {
  const p = iso(x, y, z)
  ctx.save()
  ctx.transform(1, -0.5, 0, 1, p.x, p.y)
  draw()
  ctx.restore()
}

const DADO = 0.62, PLASTER = 3.02, BEAM = 3.34
const WIN_Z0 = 1.0, WIN_Z1 = 2.55

function drawWallsStatic(ctx: CanvasRenderingContext2D, day: number): void {
  const W = HW, D = HD, H = WALL_H
  const bq = (x0: number, x1: number, z0: number, z1: number) => [iso(x0, 0, z0), iso(x1, 0, z0), iso(x1, 0, z1), iso(x0, 0, z1)]
  const lq = (y0: number, y1: number, z0: number, z1: number) => [iso(0, y0, z0), iso(0, y1, z0), iso(0, y1, z1), iso(0, y0, z1)]
  // Back wall: brick dado, plaster, painted beam, brackets.
  poly(ctx, bq(0, W, 0, H), edgeGrad(ctx, iso(0, 0, H), iso(W, 0, H), iso(0, 0, 0), shade(pal.wall, 0.04), shade(pal.wall, -0.05)))
  poly(ctx, lq(0, D, 0, H), edgeGrad(ctx, iso(0, 0, H), iso(0, D, H), iso(0, 0, 0), shade(pal.wallSide, 0.02), shade(pal.wallSide, -0.07)))
  poly(ctx, bq(0, W, 0, DADO), pal.dado)
  poly(ctx, lq(0, D, 0, DADO), shade(pal.dado, -0.08))
  for (let z = 0.155; z < DADO; z += 0.155) {
    line(ctx, iso(0, 0, z), iso(W, 0, z), 'rgba(255,255,255,0.12)')
    line(ctx, iso(0, 0, z), iso(0, D, z), 'rgba(255,255,255,0.1)')
  }
  poly(ctx, bq(0, W, DADO, DADO + 0.06), pal.marble)
  poly(ctx, lq(0, D, DADO, DADO + 0.06), shade(pal.marble, -0.08))
  // Plaster ends under the beam with a red frame line.
  poly(ctx, bq(0, W, PLASTER - 0.05, PLASTER), pal.timber)
  poly(ctx, lq(0, D, PLASTER - 0.05, PLASTER), shade(pal.timber, -0.1))
  // Painted beam (彩画): alternating blue and green with gold-edged roundels.
  poly(ctx, bq(0, W, PLASTER, BEAM), pal.beam)
  poly(ctx, lq(0, D, PLASTER, BEAM), shade(pal.beam, -0.1))
  for (let x = 0.3, i = 0; x < W - 0.4; x += 1.2, i++) {
    poly(ctx, bq(x, x + 0.9, PLASTER + 0.04, BEAM - 0.04), i % 2 ? pal.paintB : pal.paintA)
    const c = iso(x + 0.45, 0, (PLASTER + BEAM) / 2)
    ctx.save(); ctx.translate(c.x, c.y); ctx.transform(1, 0.5, 0, 1, 0, 0)
    ctx.strokeStyle = pal.gold; ctx.lineWidth = 1.2
    ctx.beginPath(); ctx.ellipse(0, 0, 7, 4.2, 0, 0, Math.PI * 2); ctx.stroke()
    ctx.fillStyle = alpha('#ffffff', 0.35)
    ctx.beginPath(); ctx.ellipse(0, 0, 3, 1.8, 0, 0, Math.PI * 2); ctx.fill()
    ctx.restore()
  }
  for (let y = 0.3, i = 0; y < D - 0.4; y += 1.2, i++) {
    poly(ctx, lq(y, y + 0.9, PLASTER + 0.04, BEAM - 0.04), shade(i % 2 ? pal.paintB : pal.paintA, -0.1))
    const c = iso(0, y + 0.45, (PLASTER + BEAM) / 2)
    ctx.save(); ctx.translate(c.x, c.y); ctx.transform(1, -0.5, 0, 1, 0, 0)
    ctx.strokeStyle = shade(pal.gold, -0.1); ctx.lineWidth = 1.2
    ctx.beginPath(); ctx.ellipse(0, 0, 7, 4.2, 0, 0, Math.PI * 2); ctx.stroke()
    ctx.restore()
  }
  line(ctx, iso(0, 0, PLASTER), iso(W, 0, PLASTER), pal.gold, 1)
  line(ctx, iso(0, 0, BEAM), iso(W, 0, BEAM), pal.gold, 1)
  line(ctx, iso(0, 0, PLASTER), iso(0, D, PLASTER), shade(pal.gold, -0.1), 1)
  line(ctx, iso(0, 0, BEAM), iso(0, D, BEAM), shade(pal.gold, -0.1), 1)
  // Bracket sets (斗拱) under the eaves.
  poly(ctx, bq(0, W, BEAM, H), shade(pal.timberDark, -0.15))
  poly(ctx, lq(0, D, BEAM, H), shade(pal.timberDark, -0.25))
  for (let x = 0.45; x < W - 0.2; x += 0.75) {
    box(ctx, x - 0.12, 0, BEAM, 0.24, 0.12, 0.1, pal.timber, { edge: false })
    box(ctx, x - 0.2, 0, BEAM + 0.1, 0.4, 0.16, 0.08, pal.paintA, { edge: false })
    box(ctx, x - 0.09, 0, BEAM + 0.18, 0.18, 0.2, 0.1, pal.gold, { edge: false })
  }
  for (let y = 0.45; y < D - 0.2; y += 0.75) {
    box(ctx, 0, y - 0.12, BEAM, 0.12, 0.24, 0.1, shade(pal.timber, -0.1), { edge: false })
    box(ctx, 0, y - 0.2, BEAM + 0.1, 0.16, 0.4, 0.08, shade(pal.paintA, -0.1), { edge: false })
    box(ctx, 0, y - 0.09, BEAM + 0.18, 0.2, 0.18, 0.1, shade(pal.gold, -0.1), { edge: false })
  }
  // Embedded columns.
  for (const x of [2.45, HW - 2.45]) {
    box(ctx, x - 0.18, 0, 0, 0.36, 0.14, BEAM, pal.timber, { top: pal.timber })
    cyl(ctx, x, 0.1, 0, 0.26, 0.12, pal.marble)
  }
  for (const y of [2.85, HD - 1.15]) {
    box(ctx, 0, y - 0.18, 0, 0.14, 0.36, BEAM, shade(pal.timber, -0.06), { top: pal.timber })
    cyl(ctx, 0.1, y, 0, 0.26, 0.12, pal.marble)
  }
  box(ctx, -0.02, -0.02, 0, 0.2, 0.2, BEAM, pal.timberDark, { edge: false })
  // Wall caps (thickness) where the cutaway ends.
  const cap = pal.timberDark
  poly(ctx, [iso(-0.3, -0.3, H), iso(W, -0.3, H), iso(W, 0, H), iso(0, 0, H)], shade(pal.tile, 0.05))
  poly(ctx, [iso(-0.3, -0.3, H), iso(0, 0, H), iso(0, D, H), iso(-0.3, D, H)], shade(pal.tile, 0.05))
  line(ctx, iso(0, D, H), iso(0, 0, H), pal.trim, 1.6)
  line(ctx, iso(0, 0, H), iso(W, 0, H), pal.trim, 1.6)
  poly(ctx, [iso(-0.3, D, 0), iso(0, D, 0), iso(0, D, H), iso(-0.3, D, H)], grad(ctx, iso(0, D, H), iso(0, D, 0), shade(cap, 0.1), shade(cap, -0.05)))
  poly(ctx, [iso(W, -0.3, 0), iso(W, 0, 0), iso(W, 0, H), iso(W, -0.3, H)], grad(ctx, iso(W, 0, H), iso(W, 0, 0), shade(cap, -0.02), shade(cap, -0.15)))
  // Lattice windows.
  for (const x of backWindows()) drawLatticeWindow(ctx, (u, z) => iso(x + u * 1.4, 0, z), 1.4, day, false)
  drawLatticeWindow(ctx, (u, z) => iso(0, HD - 2.05 - u * 1.6, z), 1.6, day, true)
}

/** A lattice window with paper behind straight mullions. `at(u, z)` maps 0..1 along the window and height to the wall. */
function drawLatticeWindow(ctx: CanvasRenderingContext2D, at: (u: number, z: number) => Pt, len: number, day: number, side: boolean): void {
  const q = (u0: number, u1: number, z0: number, z1: number) => [at(u0, z0), at(u1, z0), at(u1, z1), at(u0, z1)]
  const fr = side ? shade(pal.timber, -0.08) : pal.timber
  poly(ctx, q(-0.04, 1.04, WIN_Z0 - 0.1, WIN_Z1 + 0.1), fr)
  const paper = mix('#2a3156', mix(pal.paper, '#fff6dc', 0.3), day)
  poly(ctx, q(0.02, 0.98, WIN_Z0, WIN_Z1), grad(ctx, at(0, WIN_Z1), at(0, WIN_Z0), paper, shade(paper, -0.06)))
  const n = Math.round(len / 0.11)
  for (let i = 1; i < n; i++) line(ctx, at(0.02 + (0.96 * i) / n, WIN_Z0), at(0.02 + (0.96 * i) / n, WIN_Z1), alpha(shade(fr, -0.1), 0.9), 1.4)
  for (const z of [WIN_Z0 + 0.5, WIN_Z1 - 0.5]) line(ctx, at(0.02, z), at(0.98, z), shade(fr, -0.1), 1.6)
  poly(ctx, q(-0.06, 1.06, WIN_Z0 - 0.16, WIN_Z0 - 0.08), shade(fr, 0.1))
}

/** Moonlit paper and bamboo shadows on the back windows. */
function drawWindowLight(ctx: CanvasRenderingContext2D, x: number, day: number, now: number): void {
  // Bamboo leaves outside cast moving shadows on the paper.
  ctx.save()
  poly(ctx, [iso(x + 0.03, 0, WIN_Z0), iso(x + 1.37, 0, WIN_Z0), iso(x + 1.37, 0, WIN_Z1), iso(x + 0.03, 0, WIN_Z1)])
  ctx.clip()
  const sway = Math.sin(now / 1400 + x) * 0.04
  ctx.fillStyle = `rgba(30,50,40,${0.1 + (1 - day) * 0.05})`
  for (let i = 0; i < 9; i++) {
    const u = rnd(i, Math.round(x * 10)) * 1.3 + sway, z = WIN_Z0 + 0.2 + rnd(i, 3, Math.round(x)) * 1.2
    const p = iso(x + u, 0, z)
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(-0.6 + rnd(i, 9) * 0.9 + sway * 3)
    ctx.beginPath(); ctx.ellipse(0, 0, 9, 2.2, 0, 0, Math.PI * 2); ctx.fill()
    ctx.restore()
  }
  const s0 = iso(x + 0.25 + sway, 0, WIN_Z0), s1 = iso(x + 0.35 + sway * 2, 0, WIN_Z1)
  line(ctx, s0, s1, `rgba(30,50,40,${0.12})`, 2)
  ctx.restore()
}

// ─── Live walls ──────────────────────────────────────────────────────────

function drawPlaque(ctx: CanvasRenderingContext2D, name: { zh: string; en: string }, plaqueTitle: string, status: string, lang: Lang): void {
  const W = 2.5 * 32, H = 0.78 * ZH
  onWallX(ctx, AISLE_X - 1.25, 0.08, BEAM + 0.36, () => {
    ctx.fillStyle = 'rgba(0,0,0,0.25)'
    ctx.fillRect(2, 3, W, H)
    ctx.fillStyle = pal.gold
    ctx.fillRect(-2, -2, W + 4, H + 4)
    const g = ctx.createLinearGradient(0, 0, 0, H)
    g.addColorStop(0, palName === 'ink' ? '#2d2c2a' : '#1f3a63')
    g.addColorStop(1, palName === 'ink' ? '#1f1e1c' : '#152a4b')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, W, H)
    ctx.strokeStyle = alpha(pal.gold, 0.6)
    ctx.lineWidth = 0.8
    ctx.strokeRect(2.5, 2.5, W - 5, H - 5)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = pal.gold
    if (lang === 'en') {
      ctx.font = `700 7.5px ${SERIF}`
      ctx.fillText(name.en, W / 2, H / 2 - 4.5)
    } else {
      // Plaques read right to left.
      ctx.font = `700 12px ${KAI}`
      ctx.fillText([...name.zh].reverse().join(''), W / 2, H / 2 - 3.5)
    }
    ctx.font = `700 6px ${FONT}`
    ctx.fillStyle = alpha('#ffffff', 0.82)
    let title = plaqueTitle
    while (title.length > 3 && ctx.measureText(title).width > W - 14) title = title.slice(0, -2) + '…'
    ctx.fillText(title, W / 2, H - 6)
    // Status: a tiny seal in the corner.
    ctx.fillStyle = status === 'working' ? '#e0483a' : status === 'waiting' ? '#f2b33d' : 'rgba(255,255,255,0.3)'
    ctx.fillRect(W - 9, 4, 5, 5)
    ctx.textAlign = 'left'
  })
}

/** The hanging scroll on the back wall: the plan, or a motto when there is none. */
function drawPlanScroll(ctx: CanvasRenderingContext2D, plan: Hall['plan']): void {
  const W = 1.4 * 32, H = 2.1 * ZH
  onWallX(ctx, 2.75, 0.04, 3.0, () => {
    ctx.fillStyle = 'rgba(0,0,0,0.16)'
    ctx.fillRect(3, 3, W, H)
    ctx.fillStyle = mix(pal.paintA, pal.paper, 0.55)
    ctx.fillRect(0, 0, W, H)
    ctx.fillStyle = shade(pal.paper, 0.02)
    ctx.fillRect(5, 9, W - 10, H - 18)
    // Rollers.
    for (const y of [-1.5, H - 1.5]) {
      ctx.fillStyle = pal.timberDark
      ctx.fillRect(-3, y, W + 6, 4)
      ctx.fillStyle = pal.gold
      ctx.fillRect(-5, y - 0.5, 3, 5); ctx.fillRect(W + 2, y - 0.5, 3, 5)
    }
    ctx.strokeStyle = shade(pal.timberDark, 0.2)
    ctx.lineWidth = 0.8
    ctx.beginPath(); ctx.moveTo(W / 2, -1.5); ctx.lineTo(W / 2 - 8, -10); ctx.lineTo(W / 2 + 8, -10); ctx.closePath(); ctx.stroke()
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    if (plan) {
      ctx.fillStyle = pal.ink
      ctx.font = `700 7px ${KAI}`
      ctx.fillText('方略', W / 2, 15)
      ctx.font = `800 5.5px ${FONT}`
      ctx.fillText(`PLAN ${plan.done}/${plan.total}`, W / 2, 23)
      const n = Math.min(plan.total, 7)
      for (let i = 0; i < n; i++) {
        const y = 31 + i * 6.6
        const done = i < plan.done
        ctx.strokeStyle = alpha(pal.ink, done ? 0.35 : 0.8)
        ctx.lineWidth = 1.4
        ctx.lineCap = 'round'
        ctx.beginPath(); ctx.moveTo(10, y); ctx.quadraticCurveTo(20, y - 1.2, W - 15, y + 0.4); ctx.stroke()
        if (done) {
          ctx.fillStyle = pal.seal
          ctx.fillRect(W - 11.5, y - 2.4, 4.8, 4.8)
        } else {
          ctx.strokeStyle = alpha(pal.ink, 0.5); ctx.lineWidth = 0.7
          ctx.strokeRect(W - 11.5, y - 2.4, 4.8, 4.8)
        }
      }
      if (plan.label) {
        ctx.fillStyle = pal.seal
        ctx.font = `700 5px ${FONT}`
        let label = plan.label
        while (label.length > 3 && ctx.measureText(label).width > W - 10) label = label.slice(0, -2) + '…'
        ctx.fillText(label, W / 2, H - 13)
      }
    } else {
      // 政通人和: "good governance, people at peace".
      ctx.fillStyle = pal.ink
      ctx.font = `13px ${KAI}`
      ;['政', '通', '人', '和'].forEach((ch, i) => ctx.fillText(ch, W / 2, 20 + i * 12.5))
      ctx.fillStyle = pal.seal
      ctx.fillRect(W / 2 + 6, H - 17, 5, 5)
    }
    ctx.textAlign = 'left'
  })
}

function drawLantern(ctx: CanvasRenderingContext2D, x: number, y: number, now: number, live: boolean, lights: Light[], day: number): void {
  const sway = Math.sin(now / 1300 + x) * 0.025
  const top = iso(x, y, BEAM + 0.05), a = iso(x + sway, y, 2.85)
  line(ctx, top, a, shade(pal.gold, -0.3), 1)
  const c = iso(x + sway, y, 2.55)
  ctx.save()
  ctx.translate(c.x, c.y)
  const body = '#c8322a'
  const g = ctx.createRadialGradient(-3, -3, 1, 0, 0, 12)
  const lit = live ? 1 : 0.55
  g.addColorStop(0, mix(body, '#ffd38a', 0.55 * lit + (1 - day) * 0.3))
  g.addColorStop(1, shade(body, -0.25))
  ctx.fillStyle = g
  ctx.beginPath(); ctx.ellipse(0, 0, 10, 11, 0, 0, Math.PI * 2); ctx.fill()
  ctx.strokeStyle = 'rgba(80,10,10,0.35)'
  ctx.lineWidth = 0.8
  for (const k of [-5, 0, 5]) { ctx.beginPath(); ctx.ellipse(0, 0, Math.abs(k) === 5 ? 6 : 1, 11, 0, 0, Math.PI * 2); ctx.stroke() }
  ctx.fillStyle = pal.gold
  ctx.fillRect(-5, -13, 10, 3)
  ctx.fillRect(-5, 10, 10, 3)
  ctx.strokeStyle = pal.gold
  ctx.lineWidth = 1.2
  for (let i = -2; i <= 2; i++) { ctx.beginPath(); ctx.moveTo(i * 1.5, 13); ctx.lineTo(i * 1.8, 21 + Math.sin(now / 500 + i) * 0.6); ctx.stroke() }
  ctx.restore()
  lights.push({ p: c, rx: 42, ry: 38, color: '#ff9a5a', day: live ? 0.12 : 0.04, night: live ? 0.62 : 0.32 })
  lights.push({ p: iso(x, y + 0.6, 0), rx: 70, ry: 34, color: '#ff8f4f', day: 0, night: live ? 0.28 : 0.12 })
}

// ─── Dais, screen, throne ────────────────────────────────────────────────

function drawDais(ctx: CanvasRenderingContext2D, now: number, live: boolean, lights: Light[]): void {
  const m = pal.marble
  const tiers: Array<[number, number, number, number, number]> = [[5.1, 2.4, 4.8, 0, 0.15], [5.5, 2.0, 4.0, 0.15, 0.15], [5.9, 1.65, 3.2, 0.3, 0.15]]
  for (const [x, d, w, z, h] of tiers) {
    box(ctx, x, 0, z, w, d, h, m, { top: shade(m, 0.04) })
    line(ctx, iso(x, d, z + h * 0.5), iso(x + w, d, z + h * 0.5), 'rgba(90,70,50,0.18)', 0.8)
    line(ctx, iso(x + w, 0, z + h * 0.5), iso(x + w, d, z + h * 0.5), 'rgba(70,50,40,0.2)', 0.8)
    // The carpet climbs the steps.
    poly(ctx, [iso(AISLE_X - 0.5, d, z), iso(AISLE_X + 0.5, d, z), iso(AISLE_X + 0.5, d, z + h), iso(AISLE_X - 0.5, d, z + h)], shade(pal.carpet, -0.12))
    floorQuad(ctx, AISLE_X - 0.5, d - 0.36, 1.0, 0.36, pal.carpet, z + h + 0.002)
  }
  floorQuad(ctx, AISLE_X - 0.5, 0.2, 1.0, 1.45 - 0.2, pal.carpet, 0.452)
  // Balustrade along the top tier, open at the centre.
  for (const [x0, x1] of [[5.95, 6.95], [8.05, 9.05]] as const) drawRail(ctx, x0, 1.62, x1, 1.62, 0.45, 0.3)
  // Bronze tripod censers on the lowest tier, smoking more when the hall is busy.
  for (const cx of [5.42, 9.58]) {
    const z = 0.15
    for (const [lx, ly] of [[-0.1, -0.06], [0.1, -0.06], [0, 0.1]] as const) box(ctx, cx + lx - 0.02, 2.1 + ly - 0.02, z, 0.04, 0.04, 0.14, '#5c4a32', { lit: false, edge: false })
    cyl(ctx, cx, 2.1, z + 0.12, 0.17, 0.2, '#8a6d3f', { top: '#3a2e22' })
    box(ctx, cx - 0.15, 2.08, z + 0.32, 0.05, 0.04, 0.08, '#8a6d3f', { edge: false, lit: false })
    box(ctx, cx + 0.1, 2.08, z + 0.32, 0.05, 0.04, 0.08, '#8a6d3f', { edge: false, lit: false })
    smoke(ctx, iso(cx, 2.1, z + 0.35), now, live ? 3 : 1, cx)
    lights.push({ p: iso(cx, 2.1, z + 0.3), rx: 14, ry: 9, color: '#ff8a3c', day: 0, night: 0.35 })
  }
}

/** Curling incense smoke from a point. */
export function smoke(ctx: CanvasRenderingContext2D, p: Pt, now: number, strands: number, seed: number, color = 'rgba(235,230,225,0.55)', height = 34): void {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineCap = 'round'
  for (let i = 0; i < strands; i++) {
    const t = ((now / 2600 + i / strands + seed * 0.37) % 1)
    ctx.globalAlpha = (1 - t) * 0.8
    ctx.lineWidth = 1.2 + t * 1.6
    ctx.beginPath()
    for (let k = 0; k <= 10; k++) {
      const yy = p.y - t * height * 0.4 - k * (height / 14)
      const xx = p.x + Math.sin(k * 0.7 + now / 700 + i * 2 + seed) * (1.5 + k * 0.5)
      if (k === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy)
    }
    ctx.stroke()
  }
  ctx.restore()
}

function drawRail(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, z = 0, h = 0.38): void {
  const m = pal.marble
  const len = Math.hypot(x1 - x0, y1 - y0)
  const n = Math.max(1, Math.round(len / 0.5))
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n, y = y0 + ((y1 - y0) * i) / n
    box(ctx, x - 0.04, y - 0.04, z, 0.08, 0.08, h, m, { edge: false })
    cyl(ctx, x, y, z + h, 0.05, 0.05, shade(m, 0.05))
  }
  // Two rails.
  for (const k of [0.55, 0.92]) {
    line(ctx, iso(x0, y0, z + h * k), iso(x1, y1, z + h * k), shade(m, -0.12), 2.2)
    line(ctx, iso(x0, y0, z + h * k + 0.02), iso(x1, y1, z + h * k + 0.02), shade(m, 0.06), 1)
  }
}

const BINS = 15
/** The folding screen behind the throne: a blue-green landscape whose ridges are the last 15 minutes of tool calls. */
function drawScreen(ctx: CanvasRenderingContext2D, sessions: SessionState[], now: number): void {
  const { x0, x1, y } = SCREEN
  const z0 = 0.45, z1 = 2.72
  const n = 3, pw = (x1 - x0) / n
  // Frames.
  box(ctx, x0 - 0.06, y - 0.06, z0, x1 - x0 + 0.12, 0.1, z1 - z0 + 0.08, pal.timberDark, { edge: false })
  // Landscape on the front face.
  const bins: Array<Map<ToolCategory, number>> = Array.from({ length: BINS }, () => new Map())
  const totals = new Array<number>(BINS).fill(0)
  for (const s of sessions) for (let i = s.toolOrder.length - 1; i >= 0; i--) {
    const t = s.tools[s.toolOrder[i]!]
    if (!t) continue
    const age = now - t.startedAt
    if (age > BINS * 60_000) break
    const bi = BINS - 1 - Math.min(BINS - 1, Math.floor(age / 60_000))
    bins[bi]!.set(t.category, (bins[bi]!.get(t.category) ?? 0) + 1)
    totals[bi]!++
  }
  const peak = Math.max(4, ...totals)
  const cats = (Object.keys(CATEGORY) as ToolCategory[]).filter((c) => bins.some((b) => b.has(c)))
  const W = (x1 - x0) * 32, H = (z1 - z0 - 0.1) * ZH
  onWallX(ctx, x0, y + 0.045, z1 - 0.05, () => {
    // Silk sky.
    const sky = ctx.createLinearGradient(0, 0, 0, H)
    sky.addColorStop(0, shade(pal.paper, 0.03))
    sky.addColorStop(1, mix(pal.paper, pal.paintA, 0.18))
    ctx.fillStyle = sky
    ctx.fillRect(0, 0, W, H)
    // Sun (or moon) in the corner.
    ctx.fillStyle = alpha(pal.seal, 0.75)
    ctx.beginPath(); ctx.arc(W - 16, 13, 5.5, 0, Math.PI * 2); ctx.fill()
    // Far range for depth.
    ctx.fillStyle = alpha(mix(pal.paintB, pal.paper, 0.6), 0.6)
    ctx.beginPath(); ctx.moveTo(0, H * 0.62)
    for (let i = 0; i <= 24; i++) ctx.lineTo((i / 24) * W, H * 0.62 - Math.abs(Math.sin(i * 1.3)) * 9 - rnd(i, 4) * 6)
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath(); ctx.fill()
    // Stacked ridges: each tool kind is a mountain layer.
    const base = H - 3, span = H * 0.72
    const cum = new Array<number>(BINS).fill(0)
    const xs = (i: number) => ((i + 0.5) / BINS) * W
    for (const cat of cats) {
      const prev = [...cum]
      for (let i = 0; i < BINS; i++) cum[i]! += bins[i]!.get(cat) ?? 0
      const color = mix(CATEGORY[cat].color, pal.paintA, palName === 'ink' ? 0.75 : 0.3)
      const top = (i: number) => base - (cum[i]! / peak) * span
      const bot = (i: number) => base - (prev[i]! / peak) * span
      ctx.beginPath()
      ctx.moveTo(0, top(0))
      for (let i = 0; i < BINS - 1; i++) {
        const mx = (xs(i) + xs(i + 1)) / 2, my = (top(i) + top(i + 1)) / 2
        ctx.quadraticCurveTo(xs(i), top(i), mx, my)
      }
      ctx.lineTo(W, top(BINS - 1))
      ctx.lineTo(W, bot(BINS - 1))
      for (let i = BINS - 1; i > 0; i--) {
        const mx = (xs(i) + xs(i - 1)) / 2, my = (bot(i) + bot(i - 1)) / 2
        ctx.quadraticCurveTo(xs(i), bot(i), mx, my)
      }
      ctx.lineTo(0, bot(0))
      ctx.closePath()
      const g = ctx.createLinearGradient(0, base - span, 0, base)
      g.addColorStop(0, shade(color, 0.1))
      g.addColorStop(1, shade(color, -0.15))
      ctx.fillStyle = g
      ctx.fill()
      ctx.strokeStyle = alpha(shade(color, -0.45), 0.55)
      ctx.lineWidth = 0.8
      ctx.stroke()
    }
    // Mist along the foot.
    const mist = ctx.createLinearGradient(0, H * 0.75, 0, H)
    mist.addColorStop(0, alpha(pal.paper, 0))
    mist.addColorStop(1, alpha(pal.paper, 0.7))
    ctx.fillStyle = mist
    ctx.fillRect(0, H * 0.75, W, H * 0.25)
    if (!cats.length) {
      ctx.fillStyle = alpha(pal.ink, 0.35)
      ctx.font = `600 5.5px ${FONT}`
      ctx.textAlign = 'center'
      ctx.fillText('quiet hills · no tool calls in 15 min', W / 2, H * 0.45)
      ctx.textAlign = 'left'
    }
    ctx.fillStyle = alpha(pal.ink, 0.5)
    ctx.font = `800 5px ${FONT}`
    ctx.textBaseline = 'top'
    ctx.fillText('ACTIVITY · 15 MIN', 5, 4)
    // Panel frames over the painting.
    ctx.fillStyle = pal.timber
    for (let i = 1; i < n; i++) ctx.fillRect(i * pw * 32 - 1.5, 0, 3, H)
    ctx.strokeStyle = pal.gold
    ctx.lineWidth = 1.5
    ctx.strokeRect(0.75, 0.75, W - 1.5, H - 1.5)
  })
  box(ctx, x0 - 0.08, y - 0.06, z1, x1 - x0 + 0.16, 0.14, 0.07, pal.timber, { top: pal.gold })
}

function drawThrone(ctx: CanvasRenderingContext2D, now: number, waiting: boolean): void {
  const z = 0.45
  const lac = pal.lacquer
  const gold = pal.gold
  // Platform and footstool.
  box(ctx, 6.7, 0.55, z, 1.6, 1.05, 0.12, lac, { top: shade(lac, 0.15) })
  line(ctx, iso(6.7, 1.6, z + 0.06), iso(8.3, 1.6, z + 0.06), gold, 1)
  box(ctx, 7.2, 1.62, z, 0.6, 0.26, 0.09, lac, { top: mix(lac, gold, 0.3) })
  // Back: a tall carved panel with a crest.
  box(ctx, 6.85, 0.6, z + 0.12, 1.3, 0.14, 1.05, mix(lac, gold, 0.15), { top: gold })
  onWallX(ctx, 6.9, 0.745, z + 1.12, () => {
    const W = 1.2 * 32, H = 0.95 * ZH
    ctx.strokeStyle = alpha(gold, 0.85)
    ctx.lineWidth = 1
    ctx.strokeRect(3, 3, W - 6, H - 6)
    // A coiled dragon roundel.
    ctx.beginPath(); ctx.arc(W / 2, H * 0.42, 8, 0, Math.PI * 2); ctx.stroke()
    ctx.beginPath()
    for (let k = 0; k < 40; k++) {
      const a = k * 0.32, r = 7 - k * 0.15
      const px = W / 2 + Math.cos(a) * r, py = H * 0.42 + Math.sin(a) * r
      if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py)
    }
    ctx.stroke()
  })
  // Crest arc and dragon-head finials.
  const c0 = iso(6.85, 0.67, z + 1.17), c1 = iso(8.15, 0.67, z + 1.17), cm = iso(AISLE_X, 0.67, z + 1.42)
  ctx.fillStyle = gold
  ctx.beginPath(); ctx.moveTo(c0.x, c0.y); ctx.quadraticCurveTo(cm.x, cm.y - 6, c1.x, c1.y); ctx.lineTo(c1.x, c1.y + 3); ctx.quadraticCurveTo(cm.x, cm.y - 1, c0.x, c0.y + 3); ctx.fill()
  for (const p of [iso(6.85, 0.67, z + 1.2), iso(8.15, 0.67, z + 1.2)]) {
    ctx.beginPath(); ctx.arc(p.x, p.y - 2, 3.4, 0, Math.PI * 2); ctx.fill()
  }
  // Seat with a yellow brocade cushion and armrests.
  box(ctx, 6.9, 0.74, z + 0.12, 1.2, 0.72, 0.26, lac, { top: shade(lac, 0.1) })
  box(ctx, 7.0, 0.78, z + 0.38, 1.0, 0.62, 0.08, '#e2b53c', { top: '#f0c95a' })
  for (const ax of [6.86, 7.98]) box(ctx, ax, 0.74, z + 0.38, 0.16, 0.72, 0.3, mix(lac, gold, 0.25), { top: gold })
  if (waiting) {
    const k = 0.5 + 0.5 * Math.sin(now / 300)
    glowAt(ctx, iso(AISLE_X, 1.1, z + 0.6), 26, 18, '#ffd36a', 0.25 + 0.2 * k)
  }
}

function drawPillar(ctx: CanvasRenderingContext2D, x: number, y: number, now: number, idx: number): void {
  // Lotus base, vermilion shaft with a coiling gold dragon, bracket cap.
  cyl(ctx, x, y, 0, 0.36, 0.1, pal.marble)
  cyl(ctx, x, y, 0.1, 0.3, 0.08, shade(pal.marble, -0.05))
  const r = 0.24, H = WALL_H - 0.1
  cyl(ctx, x, y, 0.18, r, H - 0.18, pal.timber)
  // Dragon: a gold coil on the visible half of the shaft.
  ctx.save()
  const rx = r * (TW / 2)
  ctx.lineCap = 'round'
  let prev: Pt | undefined
  let prevFront = false
  for (let k = 0; k <= 120; k++) {
    const t = k / 120
    const a = t * Math.PI * 5.2 + idx * Math.PI
    const z = 0.4 + t * (H - 1.0)
    const front = Math.sin(a) > -0.15
    const c = iso(x, y, z)
    const p = { x: c.x + Math.cos(a) * rx, y: c.y + Math.sin(a) * rx * 0.5 }
    if (prev && front && prevFront) {
      ctx.strokeStyle = shade(pal.gold, -0.15 + Math.sin(a) * 0.2)
      ctx.lineWidth = 3.4 - t * 1.2
      ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(p.x, p.y); ctx.stroke()
      if (k % 6 === 0) {
        ctx.fillStyle = shade(pal.gold, 0.25)
        ctx.beginPath(); ctx.arc(p.x, p.y - 1, 1, 0, Math.PI * 2); ctx.fill()
      }
    }
    prev = p
    prevFront = front
  }
  // Head near the top, facing the throne.
  const hp = iso(x, y, H - 0.45)
  const dir = x < AISLE_X ? 1 : -1
  ctx.fillStyle = pal.gold
  ctx.beginPath(); ctx.ellipse(hp.x + dir * 3, hp.y, 5.5, 3.6, dir * -0.3, 0, Math.PI * 2); ctx.fill()
  ctx.strokeStyle = pal.gold; ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(hp.x + dir * 6, hp.y - 2); ctx.quadraticCurveTo(hp.x + dir * 12, hp.y - 7, hp.x + dir * 9, hp.y - 11); ctx.stroke()
  ctx.fillStyle = '#c0392b'
  ctx.beginPath(); ctx.arc(hp.x + dir * 6.5, hp.y - 0.5, 0.9, 0, Math.PI * 2); ctx.fill()
  // A flaming pearl it chases.
  const pp = iso(x, y, H - 0.9 + Math.sin(now / 900 + idx) * 0.04)
  glowAt(ctx, { x: pp.x + dir * 13, y: pp.y }, 8, 8, '#ffd27a', 0.5)
  ctx.fillStyle = '#ffe7a8'
  ctx.beginPath(); ctx.arc(pp.x + dir * 13, pp.y, 2.2, 0, Math.PI * 2); ctx.fill()
  ctx.restore()
  // Capital.
  box(ctx, x - 0.3, y - 0.3, H, 0.6, 0.6, 0.12, pal.paintA, { top: pal.gold })
}

function drawCraneCandle(ctx: CanvasRenderingContext2D, x: number, y: number, now: number, lights: Light[]): void {
  const bronze = '#7c6440'
  // A bronze crane standing on a tortoise, holding a candle dish in its beak.
  cyl(ctx, x, y, 0, 0.2, 0.08, shade(bronze, -0.15))
  const b = iso(x, y, 0.08)
  ctx.fillStyle = shade(bronze, -0.05)
  ctx.beginPath(); ctx.ellipse(b.x, b.y - 2, 7, 4, 0, 0, Math.PI * 2); ctx.fill()
  const dir = x < AISLE_X ? 1 : -1
  const leg0 = iso(x - 0.04, y, 0.12), legTop = iso(x, y, 0.75)
  line(ctx, leg0, legTop, bronze, 1.6)
  line(ctx, iso(x + 0.05, y, 0.12), legTop, bronze, 1.6)
  const body = iso(x, y, 0.85)
  ctx.fillStyle = shade(bronze, 0.08)
  ctx.beginPath(); ctx.ellipse(body.x, body.y, 8, 5, dir * -0.25, 0, Math.PI * 2); ctx.fill()
  ctx.strokeStyle = shade(bronze, 0.08)
  ctx.lineWidth = 2.2
  ctx.lineCap = 'round'
  const head = { x: body.x + dir * 6, y: body.y - 24 }
  ctx.beginPath(); ctx.moveTo(body.x + dir * 4, body.y - 2); ctx.quadraticCurveTo(body.x + dir * 12, body.y - 12, head.x, head.y); ctx.stroke()
  ctx.fillStyle = '#c0392b'
  ctx.beginPath(); ctx.arc(head.x, head.y - 1.5, 1.6, 0, Math.PI * 2); ctx.fill()
  // Candle dish and flame.
  const dish = { x: head.x + dir * 6, y: head.y - 1 }
  line(ctx, head, dish, bronze, 1.4)
  ctx.fillStyle = shade(bronze, -0.1)
  ctx.beginPath(); ctx.ellipse(dish.x, dish.y, 5, 2, 0, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = '#f6efe0'
  ctx.fillRect(dish.x - 1.2, dish.y - 7, 2.4, 6)
  const f = 1 + Math.sin(now / 90 + x) * 0.12
  ctx.fillStyle = '#ffcf5a'
  ctx.beginPath(); ctx.ellipse(dish.x, dish.y - 10, 1.8, 3.2 * f, 0, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = '#fff5d0'
  ctx.beginPath(); ctx.ellipse(dish.x, dish.y - 9.5, 0.8, 1.6 * f, 0, 0, Math.PI * 2); ctx.fill()
  lights.push({ p: { x: dish.x, y: dish.y - 10 }, rx: 34, ry: 30, color: '#ffb35a', day: 0.06, night: 0.55 })
  lights.push({ p: iso(x, y, 0), rx: 90, ry: 46, color: '#ff9a48', day: 0, night: 0.32 })
}

// ─── Clock tower, archive, desks, pavilion ───────────────────────────────

/** Su Song's astronomical clock tower: its water wheel and armillary sphere turn while commands run. */
function drawClockTower(ctx: CanvasRenderingContext2D, id: string, drumAt: number, now: number, dt: number, running: boolean, lights: Light[]): void {
  const st = clocks.get(id) ?? { angle: 0, speed: 0 }
  st.speed += ((running ? 1 : 0.06) - st.speed) * Math.min(1, dt * 1.5)
  st.angle += st.speed * dt * 2.2
  clocks.set(id, st)
  const { x, y, w, d } = CLOCK
  const wood = pal.timberDark
  // Base storey.
  box(ctx, x, y, 0, w, d, 1.05, shade(pal.wall, -0.06), { top: wood })
  for (const [px, py] of [[x, y + d], [x + w, y + d], [x + w, y]] as const) box(ctx, px - 0.06, py - 0.06, 0, 0.12, 0.12, 1.05, pal.timber, { edge: false })
  // Water tank and the wheel on the room-facing side.
  box(ctx, x + w - 0.02, y + 0.12, 0.85, 0.22, 0.38, 0.32, '#5b6b6e', { top: '#7da2b0' })
  const wc = { y: y + d * 0.6, z: 0.52 }
  onWallY(ctx, x + w + 0.03, wc.y, wc.z, () => {
    const R = 15
    ctx.strokeStyle = shade(wood, 0.15)
    ctx.lineWidth = 2.4
    ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke()
    ctx.lineWidth = 1.2
    for (let i = 0; i < 8; i++) {
      const a = st.angle + (i / 8) * Math.PI * 2
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * R, Math.sin(a) * R); ctx.stroke()
      ctx.fillStyle = shade(wood, 0.25)
      ctx.fillRect(Math.cos(a) * R - 2, Math.sin(a) * R - 2, 4, 4)
    }
    ctx.fillStyle = pal.gold
    ctx.beginPath(); ctx.arc(0, 0, 2.4, 0, Math.PI * 2); ctx.fill()
    // Water falling onto the buckets.
    if (st.speed > 0.2) {
      ctx.strokeStyle = `rgba(120,180,220,${0.4 + st.speed * 0.4})`
      ctx.lineWidth = 1.5
      ctx.setLineDash([3, 3])
      ctx.lineDashOffset = -now / 40
      ctx.beginPath(); ctx.moveTo(6, -R - 10); ctx.lineTo(6, -R + 2); ctx.stroke()
      ctx.setLineDash([])
    }
  })
  // Middle storey with little doors where the time-jack appears when the drum strikes.
  box(ctx, x + 0.1, y + 0.1, 1.05, w - 0.2, d - 0.2, 0.9, pal.timber, { top: wood })
  const drumK = clamp(1 - (now - drumAt) / 900, 0, 1)
  for (let i = 0; i < 2; i++) {
    const u0 = 0.25 + i * 0.6
    poly(ctx, [iso(x + 0.1 + u0, y + d - 0.1, 1.3), iso(x + 0.1 + u0 + 0.35, y + d - 0.1, 1.3), iso(x + 0.1 + u0 + 0.35, y + d - 0.1, 1.75), iso(x + 0.1 + u0, y + d - 0.1, 1.75)], i === 0 && drumK > 0 ? '#ffe4a0' : shade(pal.timberDark, -0.2))
  }
  if (drumK > 0) {
    // The jack: a tiny figure striking the drum.
    const p = iso(x + 0.52, y + d - 0.1, 1.32)
    ctx.fillStyle = pal.seal
    ctx.beginPath(); ctx.arc(p.x, p.y - 8, 3, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = '#222'
    ctx.fillRect(p.x - 3, p.y - 12, 6, 1.6)
  }
  // Drum on the right face.
  onWallY(ctx, x + w - 0.1 + 0.005, y + d * 0.5, 1.5, () => {
    const s = 1 + drumK * 0.25
    ctx.fillStyle = '#7a2a1f'
    ctx.beginPath(); ctx.ellipse(0, 0, 9 * s, 9 * s, 0, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = '#e9d4a8'
    ctx.beginPath(); ctx.ellipse(0, 0, 6.5 * s, 6.5 * s, 0, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = pal.gold
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; ctx.fillRect(Math.cos(a) * 7.8 * s - 0.6, Math.sin(a) * 7.8 * s - 0.6, 1.2, 1.2) }
  })
  if (drumK > 0) {
    const p = iso(x + w, y + d * 0.5, 1.5)
    ctx.save()
    ctx.globalAlpha = drumK
    ctx.fillStyle = pal.ink
    ctx.font = `700 10px ${KAI}`
    ctx.fillText('咚', p.x + 8, p.y - 10 - (1 - drumK) * 12)
    ctx.restore()
  }
  // Eave between storeys.
  box(ctx, x - 0.12, y - 0.12, 1.95, w + 0.24, d + 0.24, 0.08, pal.tile, { top: shade(pal.tile, 0.12) })
  line(ctx, iso(x - 0.12, y + d + 0.12, 1.95), iso(x + w + 0.12, y + d + 0.12, 1.95), pal.trim, 1.5)
  line(ctx, iso(x + w + 0.12, y - 0.12, 1.95), iso(x + w + 0.12, y + d + 0.12, 1.95), pal.trim, 1.5)
  // Open top platform with a railing and the armillary sphere.
  box(ctx, x + 0.15, y + 0.15, 2.03, w - 0.3, d - 0.3, 0.06, wood)
  const c = iso(x + w / 2, y + d / 2, 2.6)
  cyl(ctx, x + w / 2, y + d / 2, 2.09, 0.08, 0.2, '#8a6d3f')
  ctx.save()
  ctx.translate(c.x, c.y)
  const R = 15
  ctx.lineWidth = 1.6
  for (let i = 0; i < 3; i++) {
    const a = st.angle * (0.35 + i * 0.12) + i * 1.1
    ctx.strokeStyle = i === 1 ? pal.gold : shade('#a88a52', i * 0.1)
    ctx.beginPath(); ctx.ellipse(0, 0, R, Math.abs(Math.cos(a)) * R * 0.95 + 1, i * 0.6, 0, Math.PI * 2); ctx.stroke()
  }
  ctx.strokeStyle = shade(pal.gold, -0.2)
  ctx.beginPath(); ctx.ellipse(0, 0, R, R * 0.4, 0, 0, Math.PI * 2); ctx.stroke()
  ctx.fillStyle = '#4b7fb0'
  ctx.beginPath(); ctx.arc(0, 0, 3, 0, Math.PI * 2); ctx.fill()
  ctx.restore()
  for (let i = 0; i <= 4; i++) {
    const u = i / 4
    box(ctx, x + 0.15 + u * (w - 0.3) - 0.025, y + d - 0.18, 2.09, 0.05, 0.05, 0.22, pal.timber, { edge: false, lit: false })
    box(ctx, x + w - 0.18, y + 0.15 + u * (d - 0.3) - 0.025, 2.09, 0.05, 0.05, 0.22, pal.timber, { edge: false, lit: false })
  }
  line(ctx, iso(x + 0.15, y + d - 0.16, 2.3), iso(x + w - 0.15, y + d - 0.16, 2.3), pal.timber, 1.6)
  line(ctx, iso(x + w - 0.16, y + 0.15, 2.3), iso(x + w - 0.16, y + d - 0.15, 2.3), pal.timber, 1.6)
  if (st.speed > 0.3) lights.push({ p: c, rx: 22, ry: 22, color: '#ffd27a', day: 0.06, night: 0.2 })
}

function drawArchive(ctx: CanvasRenderingContext2D): void {
  const { x, y, w, d, h } = ARCHIVE
  const wood = mix(pal.lacquer, pal.timberDark, 0.5)
  box(ctx, x, y, 0, w, d, h, wood, { top: shade(wood, 0.12) })
  box(ctx, x - 0.04, y - 0.06, h, w + 0.1, d + 0.12, 0.06, shade(wood, -0.1), { top: pal.gold })
  // Pigeonholes full of scrolls on the room-facing side.
  const rows = 5, cols = 8
  onWallY(ctx, x + w + 0.004, y + d, h - 0.08, () => {
    const W = d * 32, H = (h - 0.25) * ZH
    const cw = (W - 6) / cols, ch = (H - 6) / rows
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const cx = 3 + c * cw, cy = 3 + r * ch
      ctx.fillStyle = shade(wood, -0.45)
      ctx.fillRect(cx + 0.8, cy + 0.8, cw - 1.6, ch - 1.6)
      ctx.fillStyle = 'rgba(0,0,0,0.25)'
      ctx.fillRect(cx + 0.8, cy + 0.8, cw - 1.6, 1.4)
      // Scrolls stacked end-on, a few with coloured silk tags.
      const n = 2 + Math.floor(rnd(r, c, 5) * 3)
      for (let k = 0; k < n; k++) {
        const sx = cx + 3.6 + (k % 3) * 3.3 + (k >= 3 ? 1.6 : 0), sy = cy + ch - 3.4 - (k >= 3 ? 3.2 : 0)
        ctx.fillStyle = shade('#ead9b0', (rnd(r, c, k) - 0.5) * 0.12)
        ctx.beginPath(); ctx.arc(sx, sy, 1.75, 0, Math.PI * 2); ctx.fill()
        ctx.fillStyle = '#6b4a2e'
        ctx.beginPath(); ctx.arc(sx, sy, 0.6, 0, Math.PI * 2); ctx.fill()
      }
      if (rnd(r, c, 9) > 0.62) {
        ctx.fillStyle = ['#b3261e', '#2e5394', '#dcae4c', '#3a7d58'][(r + c) % 4]!
        ctx.fillRect(cx + cw - 4, cy + 2, 1.6, ch * 0.5)
      }
    }
    ctx.strokeStyle = alpha(pal.gold, 0.5)
    ctx.lineWidth = 0.8
    ctx.strokeRect(2, 2, W - 4, H - 4)
  })
  // A brass label plate.
  onWallY(ctx, x + w + 0.006, y + d / 2 + 0.35, h + 0.02, () => {
    ctx.fillStyle = pal.gold
    ctx.fillRect(0, -1, 22, 7)
    ctx.fillStyle = pal.ink
    ctx.font = `700 5px ${KAI}`
    ctx.textBaseline = 'middle'
    ctx.fillText('档案', 6, 2.6)
  })
}

const ACT_CATEGORY: Partial<Record<Activity, ToolCategory>> = {
  reading: 'read', searching: 'search', editing: 'edit', writing: 'write', running: 'shell', browsing: 'web', delegating: 'agent', planning: 'plan', tooling: 'mcp', asking: 'interact',
}
const QUIET: ReadonlySet<Activity> = new Set<Activity>(['idle', 'sleeping', 'finished', 'aborted'])

export function activityColor(activity: Activity, hc: string): string {
  const cat = ACT_CATEGORY[activity]
  if (cat) return CATEGORY[cat].color
  if (activity === 'thinking') return '#c7a6ff'
  if (activity === 'waiting') return '#ffb547'
  if (activity === 'failed') return '#ff5d73'
  return mix('#ffe2a8', hc, 0.3)
}

function drawDesk(ctx: CanvasRenderingContext2D, desk: Desk, activity: Activity | undefined, fill: number | undefined, now: number, idx: number, lights: Light[], day: number): void {
  const { x, y, w, d, lead } = desk
  const lac = pal.lacquer
  const H = lead ? 0.4 : 0.36
  // Curved legs suggested by two slab ends, then the lacquered top with a raised lip.
  const ends = d > w ? [[x + 0.04, y + 0.02, w - 0.08, 0.08], [x + 0.04, y + d - 0.1, w - 0.08, 0.08]] : [[x + 0.02, y + 0.04, 0.08, d - 0.08], [x + w - 0.1, y + 0.04, 0.08, d - 0.08]]
  for (const [ex, ey, ew, ed] of ends) box(ctx, ex!, ey!, 0, ew!, ed!, H - 0.05, shade(lac, -0.1), { edge: false })
  box(ctx, x, y, H - 0.05, w, d, 0.05, lac, { top: shade(lac, 0.16) })
  line(ctx, iso(x, y + d, H - 0.02), iso(x + w, y + d, H - 0.02), alpha(pal.gold, 0.8), 0.8)
  line(ctx, iso(x + w, y, H - 0.02), iso(x + w, y + d, H - 0.02), alpha(pal.gold, 0.7), 0.8)
  const Z = H
  const active = !!activity && !QUIET.has(activity)
  const color = activity ? activityColor(activity, '#ffd27a') : '#ffd27a'
  // Paper (an open memorial) on the minister's side: it glows with what they are doing.
  const px = lead ? x + 0.45 : desk.facing === 1 ? x + 0.06 : x + w - 0.42
  const py = lead ? y + 0.1 : y + 0.18
  const pw = lead ? 0.9 : 0.36, pd = lead ? 0.34 : 0.48
  floorQuad(ctx, px, py, pw, pd, pal.paper, Z + 0.004)
  ctx.strokeStyle = alpha(pal.ink, 0.45)
  ctx.lineWidth = 0.8
  const cols = lead ? 7 : 4
  for (let i = 0; i < cols; i++) {
    const u = (i + 0.6) / (cols + 0.4)
    const len = 0.4 + rnd(idx, i) * 0.5
    if (lead) line(ctx, iso(px + 0.05 + u * (pw - 0.1), py + 0.04, Z + 0.005), iso(px + 0.05 + u * (pw - 0.1), py + 0.04 + len * (pd - 0.08), Z + 0.005), alpha(pal.ink, 0.45), 0.8)
    else line(ctx, iso(px + 0.04, py + 0.05 + u * (pd - 0.1), Z + 0.005), iso(px + 0.04 + len * (pw - 0.08), py + 0.05 + u * (pd - 0.1), Z + 0.005), alpha(pal.ink, 0.45), 0.8)
  }
  if (active) {
    const pulse = 0.75 + 0.25 * Math.sin(now / 220 + idx)
    floorQuad(ctx, px, py, pw, pd, alpha(color, 0.18 * pulse), Z + 0.006)
    lights.push({ p: iso(px + pw / 2, py + pd / 2, Z), rx: 34, ry: 20, color, day: 0.25 * pulse, night: 0.75 * pulse })
  }
  // Inkstone with a brush, and rolled scrolls.
  const ix = lead ? x + 0.15 : desk.facing === 1 ? x + w - 0.24 : x + 0.06
  const iy = lead ? y + 0.42 : y + 0.08
  box(ctx, ix, iy, Z, 0.18, 0.13, 0.04, '#2b2a2c', { top: '#3a393d', edge: false })
  floorQuad(ctx, ix + 0.03, iy + 0.03, 0.08, 0.07, '#111', Z + 0.042)
  line(ctx, iso(ix + 0.02, iy + 0.16, Z + 0.03), iso(ix + 0.2, iy + 0.18, Z + 0.06), '#7a5a3a', 1.6)
  line(ctx, iso(ix + 0.02, iy + 0.16, Z + 0.03), iso(ix - 0.02, iy + 0.155, Z + 0.025), '#151515', 2)
  const sx = lead ? x + w - 0.42 : desk.facing === 1 ? x + w - 0.26 : x + 0.06
  const sy = lead ? y + 0.48 : y + d - 0.3
  for (let k = 0; k < (lead ? 3 : 2); k++) {
    const cx = sx + k * 0.1, cy = sy + (k % 2) * 0.05
    const a = iso(cx, cy, Z + 0.035 + (k === 2 ? 0.06 : 0)), b = iso(cx, cy + 0.2, Z + 0.035 + (k === 2 ? 0.06 : 0))
    line(ctx, a, b, pal.paper, 5)
    ctx.fillStyle = ['#b3261e', '#2e5394', '#dcae4c'][k % 3]!
    ctx.beginPath(); ctx.ellipse(b.x, b.y, 2.4, 2.2, 0, 0, Math.PI * 2); ctx.fill()
  }
  // The incense stick is the context window: it burns down as the context fills.
  if (fill !== undefined) {
    const hx = lead ? x + w - 0.12 : desk.facing === 1 ? x + w - 0.1 : x + 0.1
    const hy = lead ? y + 0.16 : y + d - 0.1
    cyl(ctx, hx, hy, Z, 0.06, 0.05, '#8a6d3f', { top: '#6b5a44' })
    const len = 0.5 * (1 - fill) + 0.03
    const base = iso(hx, hy, Z + 0.05), tip = iso(hx, hy, Z + 0.05 + len)
    line(ctx, base, tip, fill > 0.85 ? '#a8463a' : '#8c5a3c', 1.6)
    const hot = fill > 0.85
    ctx.fillStyle = hot ? '#ff5a3a' : '#ff9a4a'
    ctx.beginPath(); ctx.arc(tip.x, tip.y, 1.4 + Math.sin(now / 200 + idx) * 0.3, 0, Math.PI * 2); ctx.fill()
    smoke(ctx, tip, now, 2, idx + 0.5, 'rgba(230,226,220,0.5)', 26)
    lights.push({ p: tip, rx: 6, ry: 6, color: '#ff8a3a', day: 0, night: 0.5 })
  }
  // Lead's desk: a boshan censer (博山炉) and the seal box.
  if (lead) {
    const cx = x + w / 2 + 0.05, cy = y + 0.52
    cyl(ctx, cx, cy, Z, 0.09, 0.03, '#7c6440')
    cyl(ctx, cx, cy, Z + 0.03, 0.025, 0.06, '#7c6440')
    cyl(ctx, cx, cy, Z + 0.09, 0.1, 0.06, '#8a6d3f')
    const top = iso(cx, cy, Z + 0.15)
    ctx.fillStyle = '#8a6d3f'
    ctx.beginPath(); ctx.moveTo(top.x - 6, top.y); ctx.lineTo(top.x - 3, top.y - 5); ctx.lineTo(top.x, top.y - 3); ctx.lineTo(top.x + 2, top.y - 8); ctx.lineTo(top.x + 6, top.y); ctx.closePath(); ctx.fill()
    const thinking = activity === 'thinking' || activity === 'planning'
    smoke(ctx, { x: top.x, y: top.y - 6 }, now, thinking ? 4 : 2, 3.3, 'rgba(235,232,228,0.6)', thinking ? 48 : 28)
    box(ctx, x + 0.12, y + 0.12, Z, 0.2, 0.2, 0.12, pal.seal, { top: shade(pal.seal, 0.2) })
    cyl(ctx, x + 0.22, y + 0.22, Z + 0.12, 0.04, 0.05, pal.gold)
  }
  // A small oil lamp for the night.
  const lx = lead ? x + 0.12 : desk.facing === 1 ? x + w - 0.12 : x + 0.12
  const ly = lead ? y + d - 0.12 : y + 0.42
  cyl(ctx, lx, ly, Z, 0.05, 0.04, '#8a6d3f')
  const fl = iso(lx, ly, Z + 0.07)
  ctx.fillStyle = `rgba(255,200,110,${0.4 + (1 - day) * 0.6})`
  ctx.beginPath(); ctx.ellipse(fl.x, fl.y - 1.5, 1.2, 2.2 + Math.sin(now / 110 + idx) * 0.3, 0, 0, Math.PI * 2); ctx.fill()
  lights.push({ p: fl, rx: 40, ry: 26, color: '#ffb25a', day: 0, night: 0.38 })
}

function drawTeaTable(ctx: CanvasRenderingContext2D, cx: number, cy: number, now: number): void {
  const w = 0.66, d = 0.4, H = 0.22, x = cx - w / 2, y = cy - 0.2
  box(ctx, x + 0.03, y + 0.03, 0, w - 0.06, d - 0.06, H - 0.04, shade(pal.lacquer, -0.1), { edge: false })
  box(ctx, x, y, H - 0.04, w, d, 0.04, pal.lacquer, { top: shade(pal.lacquer, 0.15) })
  // Celadon teapot and cups.
  const pot = '#8fb8a6'
  cyl(ctx, x + 0.35, y + 0.2, H, 0.09, 0.1, pot, { top: shade(pot, 0.1) })
  const sp = iso(x + 0.46, y + 0.2, H + 0.07)
  line(ctx, iso(x + 0.42, y + 0.2, H + 0.05), sp, pot, 2)
  for (const [cx, cy] of [[x + 0.12, y + 0.14], [x + 0.6, y + 0.28], [x + 0.2, y + 0.33]] as const) cyl(ctx, cx, cy, H, 0.04, 0.04, '#eef1ea', { top: '#c8a86a' })
  smoke(ctx, sp, now, 1, 7, 'rgba(255,255,255,0.6)', 18)
}

function drawStoneLantern(ctx: CanvasRenderingContext2D, x: number, y: number, lights: Light[], day: number): void {
  const z = -TER_H
  const s = shade(pal.marble, -0.12)
  box(ctx, x - 0.22, y - 0.22, z, 0.44, 0.44, 0.12, s)
  cyl(ctx, x, y, z + 0.12, 0.08, 0.55, s)
  box(ctx, x - 0.2, y - 0.2, z + 0.67, 0.4, 0.4, 0.06, s)
  box(ctx, x - 0.16, y - 0.16, z + 0.73, 0.32, 0.32, 0.26, s)
  const glow = iso(x + 0.165, y, z + 0.86)
  ctx.fillStyle = `rgba(255,205,120,${0.25 + (1 - day) * 0.7})`
  ctx.fillRect(glow.x - 2, glow.y - 3, 4, 6)
  const glow2 = iso(x, y + 0.165, z + 0.86)
  ctx.fillRect(glow2.x - 2, glow2.y - 3, 4, 6)
  const p = iso(x, y, z + 1.0)
  poly(ctx, [{ x: p.x, y: p.y - 10 }, { x: p.x + 17, y: p.y + 1 }, { x: p.x, y: p.y + 9 }, { x: p.x - 17, y: p.y + 1 }], shade(pal.tile, 0.05))
  ctx.fillStyle = shade(pal.tile, -0.1)
  ctx.beginPath(); ctx.arc(p.x, p.y - 11, 2.5, 0, Math.PI * 2); ctx.fill()
  lights.push({ p: iso(x, y, z + 0.86), rx: 30, ry: 24, color: '#ffbe6a', day: 0, night: 0.5 })
  lights.push({ p: iso(x, y, z), rx: 60, ry: 30, color: '#ffa850', day: 0, night: 0.22 })
}

/** A flowering plum (梅) in the courtyard. */
function drawPlum(ctx: CanvasRenderingContext2D, x: number, y: number, now: number, seed: number): void {
  const z = -TER_H
  blobShadow(ctx, x + 0.4, y + 0.3, 1.1, 0.18)
  const base = iso(x, y, z)
  ctx.save()
  ctx.lineCap = 'round'
  ctx.strokeStyle = '#3d2a22'
  const sway = Math.sin(now / 1800 + seed) * 1.2
  const branch = (bx: number, by: number, a: number, len: number, wdt: number, depth: number, k: number): void => {
    const ex = bx + Math.cos(a) * len + sway * (4 - depth) * 0.2, ey = by + Math.sin(a) * len
    ctx.lineWidth = wdt
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.quadraticCurveTo((bx + ex) / 2 + Math.sin(k) * 5, (by + ey) / 2, ex, ey); ctx.stroke()
    if (depth >= 4) return
    const n = depth < 2 ? 2 : 2 + (rnd(k, seed) > 0.5 ? 1 : 0)
    for (let i = 0; i < n; i++) branch(ex, ey, a + (i - (n - 1) / 2) * 0.75 + (rnd(k, i, seed) - 0.5) * 0.5, len * 0.68, wdt * 0.62, depth + 1, k * 3 + i + 1)
  }
  branch(base.x, base.y, -Math.PI / 2 - 0.15 + seed * 0.3, 34, 6, 0, 1 + seed * 7)
  // Blossoms.
  for (let i = 0; i < 46; i++) {
    const a = rnd(i, 3, seed) * Math.PI * 2, r = 18 + rnd(i, 4, seed) * 36
    const bx = base.x + Math.cos(a) * r * 0.9 + sway, by = base.y - 68 + Math.sin(a) * r * 0.55
    ctx.fillStyle = i % 4 === 0 ? '#ffffff' : i % 3 === 0 ? '#f19bb0' : '#f7c6d0'
    ctx.beginPath(); ctx.arc(bx, by, 2 + rnd(i, 5) * 1.3, 0, Math.PI * 2); ctx.fill()
    if (i % 3 === 0) { ctx.fillStyle = '#d9a441'; ctx.fillRect(bx - 0.5, by - 0.5, 1, 1) }
  }
  ctx.restore()
}

/** The great bronze ding in the courtyard: it smokes while the hall is in session. */
function drawDing(ctx: CanvasRenderingContext2D, x: number, y: number, now: number, live: boolean): void {
  const z = -TER_H
  const bronze = '#6f5b3a'
  for (const [lx, ly] of [[-0.25, -0.15], [0.25, -0.15], [0, 0.28]] as const) box(ctx, x + lx - 0.05, y + ly - 0.05, z, 0.1, 0.1, 0.32, shade(bronze, -0.15), { edge: false })
  cyl(ctx, x, y, z + 0.28, 0.42, 0.42, bronze, { top: '#2f2619' })
  const rim = iso(x, y, z + 0.7)
  ctx.strokeStyle = shade(bronze, 0.2)
  ctx.lineWidth = 1
  ctx.beginPath(); ctx.ellipse(rim.x, rim.y, 0.42 * 32, 0.42 * 16, 0, 0, Math.PI * 2); ctx.stroke()
  // Taotie band.
  const band = iso(x, y + 0.42, z + 0.52)
  ctx.strokeStyle = shade(bronze, 0.25)
  ctx.beginPath(); ctx.moveTo(band.x - 10, band.y - 4); ctx.lineTo(band.x - 4, band.y); ctx.lineTo(band.x, band.y - 3); ctx.lineTo(band.x + 4, band.y); ctx.lineTo(band.x + 10, band.y - 4); ctx.stroke()
  for (const dx of [-0.32, 0.32]) {
    const h0 = iso(x + dx, y, z + 0.7)
    ctx.strokeStyle = bronze; ctx.lineWidth = 2.2
    ctx.beginPath(); ctx.moveTo(h0.x - 3, h0.y); ctx.lineTo(h0.x - 3, h0.y - 8); ctx.lineTo(h0.x + 3, h0.y - 8); ctx.lineTo(h0.x + 3, h0.y); ctx.stroke()
  }
  smoke(ctx, { x: rim.x, y: rim.y - 2 }, now, live ? 4 : 1, x, 'rgba(240,236,230,0.5)', live ? 70 : 30)
}

