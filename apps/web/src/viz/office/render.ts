/** Draws the isometric office. Pure presentation over the Office model. */
import type { Activity, SessionState, ToolCategory, WorldState } from '@oadt/protocol'
import { CATEGORY, harnessInfo } from '../../shared/theme'
import { blobArt, blobMotion, drawBlob } from './blob'
import { activityOf, CABINET, COUCH, COUNTER, DIFF_FLY_MS, DOOR, DOORMAT, FLOOR_LAMP, ROOM_D, ROOM_W, SHELF, SIDE_TABLE, WINDOWS, type Char, type Desk, type Effect, type Office, type Room } from './model'
import { clip } from '@oadt/protocol'
import { LOOKS } from '../../shared/buddy'
import { alpha, mix, shade } from '../../shared/color'
import { clamp } from '../../shared/dom'
import { blobShadow, box, castShadow, cyl, easeInOut, easeOut, floorQuad, glowAt, grad, iso, line, poly, rnd, roundRect, TH, TW, wrapText, ZH, type Pt } from './iso'

const WALL_H = 2.9
const FONT = 'ui-rounded, "SF Pro Rounded", "Nunito", "Segoe UI", system-ui, sans-serif'
/** Rendered height of a blob's 100-unit viewBox, in scene px. */
const BLOB = 66

/** Materials. */
const M = {
  wall: '#f4ece2',
  wallSide: '#e4d8ca',
  cap: '#f9f4ee',
  baseboard: '#d9c8b4',
  rail: '#fbf7f1',
  floor: '#d6ae82',
  slab: '#c9b097',
  deskTop: '#f3ece2',
  walnut: '#b98559',
  steel: '#3a3e4e',
  screen: '#2d3140',
  white: '#ffffff',
  ink: '#2d2a3e',
}

export interface Camera { x: number; y: number; zoom: number }

export interface RenderState {
  hovered?: string
  selected?: string
  labels: boolean
  /** Where filed diffs fly to (scene coordinates, before camera): the front desk panel. */
  fileTarget?: Pt
}

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
/** Head positions from this frame, so bubbles can follow their blob. */
const heads = new Map<string, Pt>()

interface Sprite { depth: number; draw: () => void }
interface Light { p: Pt; rx: number; ry: number; color: string; day: number; night: number }

/** 0 = deep night, 1 = full day, based on the viewer's local clock. */
export type TimeMode = 'auto' | 'day' | 'night'
let timeMode: TimeMode = 'auto'
export function setTimeMode(m: TimeMode): void { timeMode = m }
export function getTimeMode(): TimeMode { return timeMode }

export function daylight(date = new Date()): number {
  if (timeMode === 'day') return 1
  if (timeMode === 'night') return 0
  const h = date.getHours() + date.getMinutes() / 60
  if (h >= 7.5 && h <= 17.5) return 1
  if (h <= 5.5 || h >= 20) return 0
  return h < 12 ? (h - 5.5) / 2 : 1 - (h - 17.5) / 2.5
}

/** Seat height of the worker depending on where they sit (shared with picking). */
export function seatZ(mode: Char['mode']): number {
  return mode === 'seated' ? 0.46 : mode === 'lounging' ? 0.44 : 0
}

export function renderOffice(
  ctx: CanvasRenderingContext2D,
  office: Office,
  world: WorldState,
  cam: Camera,
  w: number,
  h: number,
  dpr: number,
  now: number,
  rs: RenderState,
): void {
  const day = daylight()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  drawBackdrop(ctx, w, h, now, day)

  const sc = dpr * cam.zoom
  ctx.setTransform(sc, 0, 0, sc, Math.round(dpr * (w / 2 - cam.x * cam.zoom)), Math.round(dpr * (h / 2 - cam.y * cam.zoom)))
  const rooms = [...office.rooms.values()].sort((a, b) => a.ox + a.oy - (b.ox + b.oy))
  const overlays: Array<() => void> = []
  for (const room of rooms) {
    const s = world.sessions[room.id]
    if (!s) continue
    const o = iso(room.ox, room.oy)
    const born = clamp((now - room.bornAt) / 650, 0, 1)
    ctx.save()
    ctx.translate(o.x, o.y)
    if (born < 1) {
      // Pop in: rise, scale up and fade.
      const k = easeOut(born)
      const c = iso(ROOM_W / 2, ROOM_D / 2, 1)
      ctx.globalAlpha = k
      ctx.translate(c.x, c.y + (1 - k) * 40)
      ctx.scale(0.86 + 0.14 * k, 0.86 + 0.14 * k)
      ctx.translate(-c.x, -c.y)
    }
    drawRoom(ctx, room, s, now, day, rs, born < 1 ? [] : overlays, o, cam, dpr, born < 1)
    ctx.restore()
  }
  // Labels and bubbles on top of everything.
  for (const f of overlays) f()

  // Vignette.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  const v = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75)
  v.addColorStop(0, 'rgba(20,14,40,0)')
  v.addColorStop(1, `rgba(20,14,40,${0.1 + (1 - day) * 0.16})`)
  ctx.fillStyle = v
  ctx.fillRect(0, 0, w, h)
}

// ─── Backdrop ────────────────────────────────────────────────────────────

function drawBackdrop(ctx: CanvasRenderingContext2D, w: number, h: number, now: number, day: number): void {
  const bg = ctx.createLinearGradient(0, 0, 0, h)
  bg.addColorStop(0, mix('#171a3d', '#dfe8f4', day))
  bg.addColorStop(0.6, mix('#232150', '#eceaf2', day))
  bg.addColorStop(1, mix('#2e2653', '#f7eef0', day))
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, w, h)
  // A soft key light behind the rooms.
  const g = ctx.createRadialGradient(w * 0.42, h * 0.3, 0, w * 0.42, h * 0.3, Math.max(w, h) * 0.6)
  g.addColorStop(0, day > 0.5 ? `rgba(255,255,255,${0.45 * day})` : `rgba(120,110,210,${0.22 * (1 - day)})`)
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  if (day < 0.85) {
    // Stars.
    ctx.save()
    for (let i = 0; i < 70; i++) {
      const x = rnd(i, 1) * w, y = rnd(i, 2) * h * 0.85
      const tw = 0.55 + 0.45 * Math.sin(now / (500 + rnd(i, 3) * 900) + i)
      ctx.globalAlpha = (1 - day) * tw * (0.35 + rnd(i, 4) * 0.5)
      ctx.fillStyle = i % 7 === 0 ? '#ffe9b8' : '#ffffff'
      const r = 0.6 + rnd(i, 5) * 1.3
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill()
    }
    ctx.restore()
  }
  if (day > 0.15) {
    // Drifting bokeh.
    ctx.save()
    for (let i = 0; i < 14; i++) {
      const x = (rnd(i, 11) * w + now / (90 + rnd(i, 12) * 160)) % (w + 80) - 40
      const y = rnd(i, 13) * h
      ctx.globalAlpha = day * (0.05 + rnd(i, 14) * 0.07)
      ctx.fillStyle = '#ffffff'
      ctx.beginPath(); ctx.arc(x, y, 6 + rnd(i, 15) * 22, 0, Math.PI * 2); ctx.fill()
    }
    ctx.restore()
  }
}

// ─── Room ────────────────────────────────────────────────────────────────

/** Room-local screen bounds of everything the static layer draws. */
const STATIC_BOUNDS = { minX: -308, minY: -114, maxX: 404, maxY: 354 }
const SX = -0.3, SY = -0.3
interface StaticLayer { key: string; canvas: HTMLCanvasElement }
const staticLayers = new WeakMap<Room, StaticLayer>()

function drawRoom(ctx: CanvasRenderingContext2D, room: Room, s: SessionState, now: number, day: number, rs: RenderState, overlays: Array<() => void>, origin: Pt, cam: Camera, dpr: number, animating: boolean): void {
  const hc = harnessInfo(room.harness).color
  const live = s.status === 'working' || s.status === 'waiting'
  const lights: Light[] = []

  // Ground shadow under the diorama.
  {
    const c = iso(ROOM_W / 2 + 0.6, ROOM_D / 2 + 0.6, -0.35)
    ctx.save()
    ctx.translate(c.x, c.y + 14)
    ctx.scale(1, 0.5)
    const r = (ROOM_W + ROOM_D) * TW * 0.33
    const g = ctx.createRadialGradient(0, 0, r * 0.2, 0, 0, r)
    g.addColorStop(0, `rgba(25,18,50,${0.28 - day * 0.08})`)
    g.addColorStop(1, 'rgba(25,18,50,0)')
    ctx.fillStyle = g
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill()
    ctx.restore()
  }
  // The shell (slab, floor, walls, rugs, furniture shadows) only changes with
  // zoom and daylight, so it is rendered once into an offscreen canvas and
  // blitted at device resolution.
  const scale = dpr * cam.zoom
  const key = `${Math.round(scale * 64)}|${Math.round(day * 24)}|${hc}`
  if (animating || scale > 3.2) drawStatic(ctx, room, day, hc)
  else {
    let layer = staticLayers.get(room)
    if (!layer || layer.key !== key) {
      const canvas = layer?.canvas ?? document.createElement('canvas')
      canvas.width = Math.ceil((STATIC_BOUNDS.maxX - STATIC_BOUNDS.minX) * scale)
      canvas.height = Math.ceil((STATIC_BOUNDS.maxY - STATIC_BOUNDS.minY) * scale)
      const c2 = canvas.getContext('2d')!
      c2.setTransform(scale, 0, 0, scale, -STATIC_BOUNDS.minX * scale, -STATIC_BOUNDS.minY * scale)
      drawStatic(c2, room, day, hc)
      layer = { key, canvas }
      staticLayers.set(room, layer)
    }
    const m = ctx.getTransform()
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.drawImage(layer.canvas, Math.round(m.e + STATIC_BOUNDS.minX * scale), Math.round(m.f + STATIC_BOUNDS.minY * scale))
    ctx.restore()
  }
  drawWallsLive(ctx, room, s, now, day, hc)
  for (const c of room.chars.values()) if (c.mode === 'walking' || c.mode === 'standing') blobShadow(ctx, c.x, c.y, 0.34, 0.24 * c.alpha)
  blobShadow(ctx, room.cat.x, room.cat.y, 0.26, 0.2)

  // Depth-sorted furniture, people and the cat.
  const sprites: Sprite[] = []
  const add = (depth: number, draw: () => void) => sprites.push({ depth, draw })

  room.desks.forEach((d, i) => {
    const occupant = d.occupant ? room.chars.get(d.occupant) : undefined
    const agent = occupant ? s.agents[occupant.id] : undefined
    const act = occupant && occupant.mode === 'seated' ? activityOf(s, agent, now) : undefined
    add(d.seat.x + d.seat.y - 0.3, () => drawChair(ctx, d.seat.x, d.seat.y, hc))
    add(d.x + d.w / 2 + d.y + d.d / 2, () => drawDesk(ctx, d, act?.activity, now, hc, i, lights, day))
  })
  add(COUCH.x + COUCH.y - 0.5, () => drawCouchBack(ctx))
  add(COUCH.x + COUCH.w + COUCH.y + COUCH.d, () => drawCouchFront(ctx))
  add(SIDE_TABLE.x + SIDE_TABLE.y, () => drawSideTable(ctx))
  add(FLOOR_LAMP.x + FLOOR_LAMP.y, () => drawFloorLamp(ctx, lights, day))
  add(CABINET.x + CABINET.y + 0.8, () => drawCabinet(ctx))
  add(COUNTER.x + COUNTER.y + 1.4, () => drawCounter(ctx, now, lights))
  add(SHELF.x + SHELF.y + 0.8, () => drawShelf(ctx))
  PLANTS.forEach(([px, py, sz, kind], i) => add(px + py, () => drawPlant(ctx, px, py, sz, now, i, kind)))
  add(room.cat.x + room.cat.y, () => drawCat(ctx, room, now))

  for (const c of room.chars.values()) {
    const agent = s.agents[c.id]
    const act = activityOf(s, agent, now)
    add(c.x + c.y + (c.mode === 'seated' ? -0.05 : 0.05), () => {
      const pos = drawWorker(ctx, c, act.activity, now, rs.hovered === c.id || rs.selected === c.id, day)
      heads.set(`${room.id}/${c.id}`, pos.head)
      overlays.push(() => drawOverlay(ctx, origin, pos, c, act, now, rs, cam))
    })
  }
  sprites.sort((a, b) => a.depth - b.depth)
  for (const sp of sprites) sp.draw()

  // Effects in this room.
  overlays.push(() => {
    ctx.save()
    ctx.translate(origin.x, origin.y)
    drawEffects(ctx, room, now, origin, rs)
    ctx.restore()
  })

  // Night: multiply the whole diorama with a cool tone, then add the lamps back.
  if (day < 0.999) {
    ctx.save()
    ctx.globalCompositeOperation = 'multiply'
    poly(ctx, [iso(SX, SY, WALL_H), iso(ROOM_W, SY, WALL_H), iso(ROOM_W, SY, -0.35), iso(ROOM_W, ROOM_D, -0.35), iso(SX, ROOM_D, -0.35), iso(SX, ROOM_D, WALL_H)], mix('#ffffff', '#5a5fb5', (1 - day) * 0.72))
    ctx.restore()
    // Moonlight through the windows.
    for (const win of WINDOWS) {
      const a = iso(win.x + 0.1, 0.02), b = iso(win.x + win.w - 0.1, 0.02)
      const g = edgeGrad(ctx, a, b, iso(win.x, 2.8), `rgba(170,190,255,${0.2 * (1 - day)})`, 'rgba(170,190,255,0)')
      poly(ctx, [a, b, iso(win.x + win.w + 0.9, 2.8), iso(win.x - 0.7, 2.8)], g)
    }
    // Hallway light spilling through the door.
    glowAt(ctx, iso(DOOR.x + DOOR.w / 2, 0.3, 0), 95, 50, '#ffcf8a', 0.32 * (1 - day) * (0.6 + room.doorOpen * 0.4))
  }
  for (const l of lights) glowAt(ctx, l.p, l.rx, l.ry, l.color, l.day * day + l.night * (1 - day))

  // Live rooms get a gentle "lights on" glow at the doorway by day.
  if (live && day > 0.3) glowAt(ctx, iso(DOOR.x + DOOR.w / 2, 0.15, 0), 60, 30, hc, 0.12 * day)
}

/** A gradient whose iso-lines are parallel to the screen line a→b, running from that line to the parallel line through c. */
function edgeGrad(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, c: Pt, c0: string, c1: string): CanvasGradient {
  const dx = b.x - a.x, dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  let nx = -dy / len, ny = dx / len
  const t = (c.x - a.x) * nx + (c.y - a.y) * ny
  if (t < 0) { nx = -nx; ny = -ny }
  const d = Math.abs(t)
  return grad(ctx, a, { x: a.x + nx * d, y: a.y + ny * d }, c0, c1)
}

const PLANTS: Array<[number, number, number, number]> = [[0.55, 0.6, 1.1, 0], [8.25, 0.45, 0.8, 1], [11.45, 8.5, 1.0, 2], [3.2, 0.5, 0.55, 1]]

function drawStatic(ctx: CanvasRenderingContext2D, room: Room, day: number, hc: string): void {
  // Floor slab (the walls sit on it too).
  poly(ctx, [iso(SX, ROOM_D, 0), iso(ROOM_W, ROOM_D, 0), iso(ROOM_W, ROOM_D, -0.35), iso(SX, ROOM_D, -0.35)], grad(ctx, iso(SX, ROOM_D, 0), iso(SX, ROOM_D, -0.35), shade(M.slab, -0.02), shade(M.slab, -0.16)))
  poly(ctx, [iso(ROOM_W, SY, 0), iso(ROOM_W, ROOM_D, 0), iso(ROOM_W, ROOM_D, -0.35), iso(ROOM_W, SY, -0.35)], grad(ctx, iso(ROOM_W, SY, 0), iso(ROOM_W, SY, -0.35), shade(M.slab, -0.2), shade(M.slab, -0.34)))
  drawFloor(ctx)
  drawWallsStatic(ctx, day, hc)

  // Floor decals: rugs, light pools, doormat, shadows. Nothing here has height.
  drawRug(ctx, 1.2, 2.55, 9.9, 5.3, hc)
  drawRug(ctx, 7.7, 7.45, 3.9, 1.5, '#9aa3e6', true)
  floorQuad(ctx, DOORMAT.x, DOORMAT.y, DOORMAT.w, DOORMAT.d, '#a99274', 0.004, 'rgba(60,40,20,0.25)')
  floorQuad(ctx, DOORMAT.x + 0.1, DOORMAT.y + 0.08, DOORMAT.w - 0.2, DOORMAT.d - 0.16, '#b9a283', 0.005)
  if (day > 0.02) for (const win of WINDOWS) {
    const a = iso(win.x + 0.1, 0.02), b = iso(win.x + win.w - 0.1, 0.02)
    const g = edgeGrad(ctx, a, b, iso(win.x, 2.6), `rgba(255,246,220,${0.4 * day})`, 'rgba(255,246,220,0)')
    poly(ctx, [a, b, iso(win.x + win.w + 0.75, 2.6), iso(win.x - 0.55, 2.6)], g)
  }
  for (const d of room.desks) castShadow(ctx, d.x, d.y, d.w, d.d, 0.75, 0.13)
  castShadow(ctx, COUCH.x - 0.2, COUCH.y, COUCH.w + 0.4, COUCH.d, 0.8, 0.14)
  castShadow(ctx, CABINET.x, CABINET.y, CABINET.w, CABINET.d, CABINET.h, 0.14)
  castShadow(ctx, COUNTER.x, COUNTER.y, COUNTER.w, COUNTER.d, COUNTER.h, 0.14)
  castShadow(ctx, SHELF.x, SHELF.y, SHELF.w, SHELF.d, SHELF.h, 0.12)
  blobShadow(ctx, SIDE_TABLE.x, SIDE_TABLE.y, 0.4, 0.18)
  for (const [px, py, sz] of PLANTS) blobShadow(ctx, px, py, 0.42 * sz, 0.2)
  for (const d of room.desks) blobShadow(ctx, d.seat.x, d.seat.y + 0.05, 0.42, 0.16)
}

function drawFloor(ctx: CanvasRenderingContext2D): void {
  floorQuad(ctx, 0, 0, ROOM_W, ROOM_D, M.floor)
  // Staggered oak planks.
  for (let y = 0; y < ROOM_D; y++) {
    let x = -rnd(y, 1) * 2.4
    let i = 0
    while (x < ROOM_W) {
      const len = 1.9 + rnd(y, i, 2) * 1.5
      const x0 = Math.max(0, x), x1 = Math.min(ROOM_W, x + len)
      floorQuad(ctx, x0, y, x1 - x0, 1, shade(M.floor, (rnd(y, i, 3) - 0.5) * 0.1))
      if (x1 < ROOM_W) line(ctx, iso(x1, y), iso(x1, y + 1), 'rgba(90,55,25,0.22)')
      x += len
      i++
    }
    if (y > 0) line(ctx, iso(0, y), iso(ROOM_W, y), 'rgba(90,55,25,0.2)')
  }
  // Sheen from the windows, and ambient occlusion along the walls.
  floorQuad(ctx, 0, 0, ROOM_W, ROOM_D, grad(ctx, iso(2, 0), iso(ROOM_W, ROOM_D), 'rgba(255,246,228,0.22)', 'rgba(255,246,228,0)'))
  floorQuad(ctx, 0, 0, ROOM_W, 1.1, edgeGrad(ctx, iso(0, 0), iso(ROOM_W, 0), iso(0, 1.1), 'rgba(70,45,30,0.2)', 'rgba(70,45,30,0)'))
  floorQuad(ctx, 0, 0, 1.1, ROOM_D, edgeGrad(ctx, iso(0, 0), iso(0, ROOM_D), iso(1.1, 0), 'rgba(70,45,30,0.2)', 'rgba(70,45,30,0)'))
}

function drawRug(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, d: number, color: string, plain = false): void {
  const base = mix('#fbf3ea', color, plain ? 0.3 : 0.26)
  floorQuad(ctx, x, y, w, d, base, 0.002)
  floorQuad(ctx, x + 0.22, y + 0.22, w - 0.44, d - 0.44, mix('#fbf3ea', color, plain ? 0.18 : 0.14), 0.003)
  if (!plain) {
    // Woven stripes.
    ctx.save()
    poly(ctx, [iso(x + 0.22, y + 0.22), iso(x + w - 0.22, y + 0.22), iso(x + w - 0.22, y + d - 0.22), iso(x + 0.22, y + d - 0.22)])
    ctx.clip()
    for (let k = 0.6; k < d; k += 0.8) floorQuad(ctx, x, y + k, w, 0.22, mix('#fbf3ea', color, 0.2), 0.004)
    ctx.restore()
  }
  // Fringe on the short ends.
  ctx.strokeStyle = alpha(shade(base, -0.25), 0.55)
  ctx.lineWidth = 1
  for (let k = 0.08; k < d; k += 0.16) {
    const a = iso(x, y + k), b = iso(x - 0.12, y + k), c = iso(x + w, y + k), e = iso(x + w + 0.12, y + k)
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.moveTo(c.x, c.y); ctx.lineTo(e.x, e.y); ctx.stroke()
  }
}

function drawWallsStatic(ctx: CanvasRenderingContext2D, day: number, hc: string): void {
  const W = ROOM_W, D = ROOM_D, H = WALL_H
  const RAIL = 0.95
  // Back wall (y = 0).
  poly(ctx, [iso(0, 0, 0), iso(W, 0, 0), iso(W, 0, H), iso(0, 0, H)], edgeGrad(ctx, iso(0, 0, H), iso(W, 0, H), iso(0, 0, 0), shade(M.wall, 0.04), shade(M.wall, -0.04)))
  poly(ctx, [iso(0, 0, 0), iso(W, 0, 0), iso(W, 0, RAIL), iso(0, 0, RAIL)], mix(shade(M.wall, -0.06), hc, 0.16))
  poly(ctx, [iso(0, 0, RAIL), iso(W, 0, RAIL), iso(W, 0, RAIL + 0.06), iso(0, 0, RAIL + 0.06)], M.rail)
  poly(ctx, [iso(0, 0, RAIL - 0.03), iso(W, 0, RAIL - 0.03), iso(W, 0, RAIL), iso(0, 0, RAIL)], 'rgba(0,0,0,0.08)')
  poly(ctx, [iso(0, 0, 0), iso(W, 0, 0), iso(W, 0, 0.14), iso(0, 0, 0.14)], M.baseboard)
  // Left wall (x = 0), seen from inside: faces away from the light, so darker.
  poly(ctx, [iso(0, 0, 0), iso(0, D, 0), iso(0, D, H), iso(0, 0, H)], edgeGrad(ctx, iso(0, 0, H), iso(0, D, H), iso(0, 0, 0), shade(M.wallSide, 0.03), shade(M.wallSide, -0.06)))
  poly(ctx, [iso(0, 0, 0), iso(0, D, 0), iso(0, D, RAIL), iso(0, 0, RAIL)], mix(shade(M.wallSide, -0.07), hc, 0.16))
  poly(ctx, [iso(0, 0, RAIL), iso(0, D, RAIL), iso(0, D, RAIL + 0.06), iso(0, 0, RAIL + 0.06)], shade(M.rail, -0.06))
  poly(ctx, [iso(0, 0, RAIL - 0.03), iso(0, D, RAIL - 0.03), iso(0, D, RAIL), iso(0, 0, RAIL)], 'rgba(0,0,0,0.08)')
  poly(ctx, [iso(0, 0, 0), iso(0, D, 0), iso(0, D, 0.14), iso(0, 0, 0.14)], shade(M.baseboard, -0.08))
  // Corner seam and wall caps (thickness).
  line(ctx, iso(0, 0, 0.14), iso(0, 0, H), 'rgba(60,40,30,0.12)')
  poly(ctx, [iso(-0.3, -0.3, H), iso(W, -0.3, H), iso(W, 0, H), iso(0, 0, H)], M.cap)
  poly(ctx, [iso(-0.3, -0.3, H), iso(0, 0, H), iso(0, D, H), iso(-0.3, D, H)], M.cap)
  poly(ctx, [iso(-0.3, D, -0.35), iso(0, D, -0.35), iso(0, D, H), iso(-0.3, D, H)], grad(ctx, iso(0, D, H), iso(0, D, 0), shade(M.cap, -0.1), shade(M.cap, -0.2)))
  poly(ctx, [iso(W, -0.3, -0.35), iso(W, 0, -0.35), iso(W, 0, H), iso(W, -0.3, H)], grad(ctx, iso(W, 0, H), iso(W, 0, 0), shade(M.cap, -0.22), shade(M.cap, -0.32)))
  ctx.strokeStyle = 'rgba(255,255,255,0.6)'
  ctx.lineWidth = 1
  ctx.beginPath()
  const c1 = iso(-0.3, D, H), c2 = iso(-0.3, -0.3, H), c3 = iso(W, -0.3, H)
  ctx.moveTo(c1.x, c1.y); ctx.lineTo(c2.x, c2.y); ctx.lineTo(c3.x, c3.y)
  ctx.stroke()

  for (const win of WINDOWS) drawWindow(ctx, win.x, win.w, day)
  drawDoorFrame(ctx)
  drawPrint(ctx, hc)
}

function drawWallsLive(ctx: CanvasRenderingContext2D, room: Room, s: SessionState, now: number, day: number, hc: string): void {
  for (const win of WINDOWS) drawWindowLive(ctx, win.x, win.w, now, day)
  drawDoorLeaf(ctx, room)
  drawWallScreen(ctx, s, now, hc)

  // Name plaque above the door.
  onWallX(ctx, DOOR.x - 1.5, 0, DOOR.h + 0.6, () => {
    const label = clip(room.title, 26)
    ctx.font = `700 11px ${FONT}`
    const tw = Math.max(ctx.measureText(label).width + 28, 70)
    roundRect(ctx, 0, -17, tw, 22, 7)
    ctx.fillStyle = 'rgba(0,0,0,0.12)'
    ctx.fill()
    roundRect(ctx, 0, -19, tw, 22, 7)
    ctx.fillStyle = hc
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, 19, -8)
    ctx.beginPath()
    ctx.arc(9.5, -8, 3.2, 0, Math.PI * 2)
    ctx.fillStyle = s.status === 'working' ? '#c9ffe0' : s.status === 'waiting' ? '#ffe7b0' : 'rgba(255,255,255,0.55)'
    ctx.fill()
  })

  // Whiteboard on the left wall: the agent's plan.
  onWallY(ctx, 0, 5.2, 1.08, () => {
    const Wb = 3.4 * (TW / 2), Hb = 1.4 * ZH
    ctx.fillStyle = 'rgba(0,0,0,0.1)'
    ctx.fillRect(2, -Hb + 3, Wb, Hb)
    roundRect(ctx, 0, -Hb, Wb, Hb, 3)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.strokeStyle = '#c8cfdc'
    ctx.lineWidth = 2.5
    ctx.stroke()
    // Marker tray + markers.
    ctx.fillStyle = '#b9c1cf'
    ctx.fillRect(14, 1, Wb - 28, 3)
    for (const [i, c] of ['#ff6f91', '#5aa9ff', '#2fbf71'].entries()) { ctx.fillStyle = c; ctx.fillRect(22 + i * 11, -2, 8, 2.5) }
    const plan = room.plan
    ctx.font = `800 8px ${FONT}`
    ctx.textBaseline = 'top'
    if (plan) {
      ctx.fillStyle = '#5a6b8c'
      ctx.fillText(`PLAN ${plan.done}/${plan.total}`, 7, -Hb + 5)
      // Progress bar.
      ctx.fillStyle = '#e8ecf3'
      roundRect(ctx, 56, -Hb + 6, Wb - 64, 5, 2.5); ctx.fill()
      ctx.fillStyle = '#2fbf71'
      roundRect(ctx, 56, -Hb + 6, (Wb - 64) * clamp(plan.done / plan.total, 0, 1), 5, 2.5); ctx.fill()
      const n = Math.min(plan.total, 8)
      for (let i = 0; i < n; i++) {
        const bx = 7 + (i % 4) * 26, by = -Hb + 17 + Math.floor(i / 4) * 12
        ctx.strokeStyle = '#8f9bb3'
        ctx.lineWidth = 1.1
        ctx.strokeRect(bx, by, 7, 7)
        if (i < plan.done) {
          ctx.strokeStyle = '#2fbf71'
          ctx.lineWidth = 1.8
          ctx.beginPath(); ctx.moveTo(bx + 1, by + 4); ctx.lineTo(bx + 3, by + 6.5); ctx.lineTo(bx + 8, by - 1); ctx.stroke()
        }
        ctx.fillStyle = i < plan.done ? '#c3cad8' : '#8f9bb3'
        ctx.fillRect(bx + 10, by + 2.5, 12, 1.6)
      }
      if (plan.label) {
        ctx.fillStyle = '#ff7a59'
        ctx.font = `700 7.5px ${FONT}`
        ctx.fillText(clip(plan.label, 30), 7, -11)
      }
    } else {
      // Architecture doodle.
      ctx.strokeStyle = '#7fa8ff'
      ctx.lineWidth = 1.5
      ctx.strokeRect(10, -Hb + 14, 18, 11)
      ctx.strokeRect(44, -Hb + 14, 18, 11)
      ctx.strokeRect(27, -Hb + 32, 18, 11)
      ctx.beginPath(); ctx.moveTo(28, -Hb + 19.5); ctx.lineTo(44, -Hb + 19.5); ctx.moveTo(19, -Hb + 25); ctx.lineTo(36, -Hb + 32); ctx.moveTo(53, -Hb + 25); ctx.lineTo(36, -Hb + 32); ctx.stroke()
      ctx.strokeStyle = '#ff8fab'
      ctx.beginPath(); ctx.moveTo(72, -Hb + 36); ctx.bezierCurveTo(80, -Hb + 10, 90, -Hb + 36, 100, -Hb + 14); ctx.stroke()
      ctx.fillStyle = '#5a6b8c'
      ctx.fillText('ideas ✦', 7, -Hb + 4)
    }
  })

  // Clock with real time.
  onWallY(ctx, 0, 6.35, 2.2, () => {
    const d = new Date()
    ctx.fillStyle = 'rgba(0,0,0,0.1)'
    ctx.beginPath(); ctx.arc(1.5, 1.5, 12.5, 0, Math.PI * 2); ctx.fill()
    ctx.beginPath(); ctx.arc(0, 0, 12.5, 0, Math.PI * 2)
    ctx.fillStyle = '#ffffff'; ctx.fill()
    ctx.lineWidth = 2.5; ctx.strokeStyle = M.ink; ctx.stroke()
    ctx.fillStyle = M.ink
    for (let i = 0; i < 12; i += 3) { const a = (i / 12) * Math.PI * 2; ctx.fillRect(Math.sin(a) * 9 - 0.7, -Math.cos(a) * 9 - 0.7, 1.4, 1.4) }
    const hr = ((d.getHours() % 12) + d.getMinutes() / 60) / 12 * Math.PI * 2
    const mn = (d.getMinutes() + d.getSeconds() / 60) / 60 * Math.PI * 2
    ctx.strokeStyle = M.ink
    ctx.lineCap = 'round'
    ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.sin(hr) * 5.5, -Math.cos(hr) * 5.5); ctx.stroke()
    ctx.lineWidth = 1.3; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.sin(mn) * 9, -Math.cos(mn) * 9); ctx.stroke()
    ctx.strokeStyle = hc
    ctx.lineWidth = 0.8
    const sc = (d.getSeconds() / 60) * Math.PI * 2
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.sin(sc) * 9.5, -Math.cos(sc) * 9.5); ctx.stroke()
  })

}

function drawPrint(ctx: CanvasRenderingContext2D, hc: string): void {
  onWallY(ctx, 0, 8.35, 1.25, () => {
    const Wp = 1.1 * (TW / 2), Hp = 1.0 * ZH
    ctx.fillStyle = 'rgba(0,0,0,0.1)'
    ctx.fillRect(2, -Hp + 3, Wp, Hp)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, -Hp, Wp, Hp)
    ctx.strokeStyle = '#3d3a55'
    ctx.lineWidth = 2
    ctx.strokeRect(0, -Hp, Wp, Hp)
    ctx.save()
    ctx.beginPath(); ctx.rect(4, -Hp + 4, Wp - 8, Hp - 8); ctx.clip()
    const g = ctx.createLinearGradient(0, -Hp, 0, 0)
    g.addColorStop(0, mix('#ffe1b8', hc, 0.25))
    g.addColorStop(1, mix('#ffb6a1', hc, 0.35))
    ctx.fillStyle = g
    ctx.fillRect(0, -Hp, Wp, Hp)
    ctx.fillStyle = '#fff3d6'
    ctx.beginPath(); ctx.arc(Wp * 0.62, -Hp * 0.6, 5, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = mix('#5b4a8a', hc, 0.25)
    ctx.beginPath(); ctx.moveTo(2, -4); ctx.lineTo(13, -20); ctx.lineTo(22, -8); ctx.lineTo(28, -16); ctx.lineTo(Wp - 2, -4); ctx.closePath(); ctx.fill()
    ctx.restore()
  })
}

/** Draw in a 2D plane aligned with the back wall (along x). Origin at world (x, y, z); +x along the wall, +y down. */
function onWallX(ctx: CanvasRenderingContext2D, x: number, y: number, z: number, draw: () => void): void {
  const p = iso(x, y, z)
  ctx.save()
  ctx.transform(1, 0.5, 0, 1, p.x, p.y)
  draw()
  ctx.restore()
}

/** Draw in a plane aligned with the left wall (along y); +x goes toward smaller y (reads left to right). 1 tile = 32 px. */
function onWallY(ctx: CanvasRenderingContext2D, x: number, y: number, z: number, draw: () => void): void {
  const p = iso(x, y, z)
  ctx.save()
  ctx.transform(1, -0.5, 0, 1, p.x, p.y)
  draw()
  ctx.restore()
}

const WIN_Z0 = 1.2, WIN_H = 1.3
const wq = (x0: number, za: number, x1: number, zb: number) => [iso(x0, 0, za), iso(x1, 0, za), iso(x1, 0, zb), iso(x0, 0, zb)]

/** Clouds by day, twinkling stars by night: the only parts of a window that move. */
function drawWindowLive(ctx: CanvasRenderingContext2D, x: number, w: number, now: number, day: number): void {
  const z0 = WIN_Z0, h = WIN_H
  const gx0 = x + 0.05, gx1 = x + w - 0.05, gz0 = z0 + 0.05, gz1 = z0 + h - 0.05
  ctx.save()
  poly(ctx, wq(gx0, gz0, gx1, gz1))
  ctx.clip()
  if (day > 0.4) {
    const t = ((now / 42000 + x) % 1) * (w + 1) - 0.5
    const c = iso(x + t, 0, z0 + h * 0.62)
    ctx.fillStyle = `rgba(255,255,255,${0.92 * day})`
    for (const [dx, dy, r] of [[0, 0, 6], [7, -3, 8], [15, 1, 5]] as const) {
      ctx.beginPath(); ctx.arc(c.x + dx, c.y + dy + dx * 0.5, r, 0, Math.PI * 2); ctx.fill()
    }
  }
  if (day < 0.6) {
    ctx.fillStyle = '#ffffff'
    for (let i = 0; i < 7; i++) {
      const s = iso(gx0 + rnd(i, 21) * (gx1 - gx0), 0, gz0 + 0.5 + rnd(i, 22) * (gz1 - gz0 - 0.5))
      ctx.globalAlpha = (1 - day) * (0.4 + 0.6 * Math.abs(Math.sin(now / 600 + i * 1.7)))
      ctx.fillRect(s.x, s.y, 1.5, 1.5)
    }
  }
  ctx.restore()
}

function drawWindow(ctx: CanvasRenderingContext2D, x: number, w: number, day: number): void {
  const z0 = WIN_Z0, h = WIN_H
  const q = wq
  // Frame.
  poly(ctx, q(x - 0.06, z0 - 0.06, x + w + 0.06, z0 + h + 0.06), '#ffffff')
  poly(ctx, q(x, z0, x + w, z0 + h), 'rgba(0,0,0,0.12)')
  // Glass.
  const gx0 = x + 0.05, gx1 = x + w - 0.05, gz0 = z0 + 0.05, gz1 = z0 + h - 0.05
  const top = iso(gx0, 0, gz1), bottom = iso(gx0, 0, gz0)
  const sky = ctx.createLinearGradient(top.x, top.y, bottom.x, bottom.y)
  sky.addColorStop(0, mix('#141a46', '#79c3ff', day))
  sky.addColorStop(1, mix('#3b3570', '#dff2ff', day))
  poly(ctx, q(gx0, gz0, gx1, gz1), sky)
  ctx.save()
  poly(ctx, q(gx0, gz0, gx1, gz1))
  ctx.clip()
  // Distant skyline.
  const sk = [[0.05, 0.28], [0.22, 0.42], [0.34, 0.2], [0.5, 0.5], [0.66, 0.3], [0.8, 0.38], [0.92, 0.22]] as const
  for (const [fx, fh] of sk) {
    const bx = gx0 + fx * (gx1 - gx0), bw = 0.16 * (gx1 - gx0)
    poly(ctx, q(bx, gz0, bx + bw, gz0 + fh * (gz1 - gz0) * 0.8), mix('#2a2f5a', '#b7d3ee', day))
    if (day < 0.6) for (let i = 0; i < 4; i++) {
      const p = iso(bx + 0.03 + (i % 2) * 0.06, 0, gz0 + 0.05 + Math.floor(i / 2) * 0.12)
      ctx.fillStyle = `rgba(255,224,150,${(1 - day) * (0.5 + 0.5 * rnd(i, fx * 100))})`
      ctx.fillRect(p.x, p.y, 1.5, 1.5)
    }
  }
  if (day > 0.4) {
    const sun = iso(gx0 + (gx1 - gx0) * 0.78, 0, gz1 - 0.3)
    ctx.fillStyle = `rgba(255,236,170,${0.9 * day})`
    ctx.beginPath(); ctx.arc(sun.x, sun.y, 6, 0, Math.PI * 2); ctx.fill()
  }
  if (day < 0.6) {
    ctx.globalAlpha = 1 - day
    const m = iso(gx0 + (gx1 - gx0) * 0.72, 0, gz1 - 0.32)
    ctx.fillStyle = '#fff6c8'
    ctx.beginPath(); ctx.arc(m.x, m.y, 6.5, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = mix('#141a46', '#79c3ff', day)
    ctx.beginPath(); ctx.arc(m.x + 3, m.y - 2, 5.5, 0, Math.PI * 2); ctx.fill()
    ctx.globalAlpha = 1
  }
  // Depth shadow under the top of the reveal; glass reflection.
  poly(ctx, q(gx0, gz1 - 0.12, gx1, gz1), grad(ctx, iso(gx0, 0, gz1), iso(gx0, 0, gz1 - 0.12), 'rgba(0,0,0,0.22)', 'rgba(0,0,0,0)'))
  poly(ctx, [iso(gx0, 0, gz0), iso(gx0 + 0.45, 0, gz0), iso(gx0 + 0.15, 0, gz1), iso(gx0, 0, gz1)], 'rgba(255,255,255,0.14)')
  ctx.restore()
  // Mullions.
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 1.8
  ctx.beginPath()
  const m1 = iso(x + w / 2, 0, gz0), m2 = iso(x + w / 2, 0, gz1)
  const h1 = iso(gx0, 0, z0 + h * 0.66), h2 = iso(gx1, 0, z0 + h * 0.66)
  ctx.moveTo(m1.x, m1.y); ctx.lineTo(m2.x, m2.y); ctx.moveTo(h1.x, h1.y); ctx.lineTo(h2.x, h2.y)
  ctx.stroke()
  // Sill and roller blind.
  box(ctx, x - 0.1, 0, z0 - 0.14, w + 0.2, 0.2, 0.09, '#ffffff', { edge: false })
  box(ctx, x - 0.04, 0, z0 + h - 0.04, w + 0.08, 0.1, 0.16, '#efe9e1', { edge: false })
}

function drawDoorFrame(ctx: CanvasRenderingContext2D): void {
  const dx = DOOR.x, dw = DOOR.w, dh = DOOR.h
  // Casing.
  poly(ctx, [iso(dx - 0.1, 0, 0), iso(dx + dw + 0.1, 0, 0), iso(dx + dw + 0.1, 0, dh + 0.1), iso(dx - 0.1, 0, dh + 0.1)], '#fbf7f1')
  poly(ctx, [iso(dx - 0.1, 0, dh + 0.1), iso(dx + dw + 0.1, 0, dh + 0.1), iso(dx + dw + 0.1, 0, dh + 0.02), iso(dx - 0.1, 0, dh + 0.02)], 'rgba(0,0,0,0.08)')
  // Hallway behind the door.
  const hall = grad(ctx, iso(dx, 0, dh), iso(dx, 0, 0), '#fff4d6', '#f2c98f')
  poly(ctx, [iso(dx, 0, 0), iso(dx + dw, 0, 0), iso(dx + dw, 0, dh), iso(dx, 0, dh)], hall)
  poly(ctx, [iso(dx, 0, 0), iso(dx + dw, 0, 0), iso(dx + dw, 0, 0.04), iso(dx, 0, 0.04)], '#c9a06a')
  // Frame highlight.
  ctx.strokeStyle = 'rgba(255,255,255,0.7)'
  ctx.lineWidth = 1.2
  ctx.beginPath()
  const f1 = iso(dx - 0.1, 0, 0), f2 = iso(dx - 0.1, 0, dh + 0.1), f3 = iso(dx + dw + 0.1, 0, dh + 0.1), f4 = iso(dx + dw + 0.1, 0, 0)
  ctx.moveTo(f1.x, f1.y); ctx.lineTo(f2.x, f2.y); ctx.lineTo(f3.x, f3.y); ctx.lineTo(f4.x, f4.y)
  ctx.stroke()
}

function drawDoorLeaf(ctx: CanvasRenderingContext2D, room: Room): void {
  const dx = DOOR.x, dw = DOOR.w, dh = DOOR.h
  // The leaf swings into the room around its hinge at x = dx.
  const ang = room.doorOpen * 1.3
  const ex = dx + Math.cos(ang) * dw, ey = Math.sin(ang) * dw
  const leaf = [iso(dx, 0, 0), iso(ex, ey, 0), iso(ex, ey, dh), iso(dx, 0, dh)]
  const wood = '#8d5d3f'
  poly(ctx, leaf, grad(ctx, leaf[3]!, leaf[2]!, shade(wood, 0.06), shade(wood, -0.1 - room.doorOpen * 0.12)))
  // Panels.
  const at = (u: number, z: number) => iso(dx + Math.cos(ang) * dw * u, Math.sin(ang) * dw * u, z)
  for (const [z0, z1] of [[0.25, 0.85], [1.1, 1.8]] as const) {
    poly(ctx, [at(0.18, z0), at(0.82, z0), at(0.82, z1), at(0.18, z1)], shade(wood, -0.16))
    poly(ctx, [at(0.22, z0 + 0.04), at(0.78, z0 + 0.04), at(0.78, z1 - 0.04), at(0.22, z1 - 0.04)], shade(wood, -0.04))
  }
  // Leaf thickness edge and handle.
  line(ctx, leaf[1]!, leaf[2]!, 'rgba(255,255,255,0.25)', 1.2)
  const knob = at(0.86, dh * 0.47)
  ctx.fillStyle = '#e9c46a'
  ctx.beginPath(); ctx.ellipse(knob.x, knob.y, 3, 1.6, 0, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = '#b48a2e'
  ctx.fillRect(knob.x - 0.6, knob.y - 2, 1.2, 2)
}

/** Wall-mounted dashboard: tool calls over the last 15 minutes, stacked by kind, like Mission Control's throughput chart. */
function drawWallScreen(ctx: CanvasRenderingContext2D, s: SessionState, now: number, hc: string): void {
  const x0 = 7.95, x1 = 9.3, z0 = 1.5, z1 = 2.32
  poly(ctx, [iso(x0 - 0.04, 0, z0 - 0.04), iso(x1 + 0.04, 0, z0 - 0.04), iso(x1 + 0.04, 0, z1 + 0.04), iso(x0 - 0.04, 0, z1 + 0.04)], '#1f2230')
  poly(ctx, [iso(x0, 0, z0), iso(x1, 0, z0), iso(x1, 0, z1), iso(x0, 0, z1)], grad(ctx, iso(x0, 0, z1), iso(x0, 0, z0), '#1b2340', '#101523'))
  const BINS = 15
  const bins: Array<Map<ToolCategory, number>> = Array.from({ length: BINS }, () => new Map())
  const totals = new Array<number>(BINS).fill(0)
  for (let i = s.toolOrder.length - 1; i >= 0; i--) {
    const t = s.tools[s.toolOrder[i]!]
    if (!t) continue
    const age = now - t.startedAt
    if (age > BINS * 60_000) break
    const bi = BINS - 1 - Math.min(BINS - 1, Math.floor(age / 60_000))
    bins[bi]!.set(t.category, (bins[bi]!.get(t.category) ?? 0) + 1)
    totals[bi]!++
  }
  const peak = Math.max(1, ...totals)
  const bw = (x1 - x0 - 0.16) / BINS
  const span = z1 - z0 - 0.3
  for (let i = 0; i < BINS; i++) {
    const bx = x0 + 0.08 + i * bw
    let z = z0 + 0.1
    if (!totals[i]) {
      poly(ctx, [iso(bx + 0.01, 0, z), iso(bx + bw - 0.01, 0, z), iso(bx + bw - 0.01, 0, z + 0.04), iso(bx + 0.01, 0, z + 0.04)], 'rgba(255,255,255,0.12)')
      continue
    }
    for (const [cat, n] of bins[i]!) {
      const hgt = (n / peak) * span
      poly(ctx, [iso(bx + 0.01, 0, z), iso(bx + bw - 0.01, 0, z), iso(bx + bw - 0.01, 0, z + hgt), iso(bx + 0.01, 0, z + hgt)], alpha(CATEGORY[cat].color, i === BINS - 1 ? 1 : 0.75))
      z += hgt
    }
  }
  onWallX(ctx, x0 + 0.08, 0, z1 - 0.08, () => {
    ctx.font = `800 6px ${FONT}`
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.textBaseline = 'top'
    ctx.fillText('ACTIVITY', 0, 0)
    ctx.fillStyle = s.status === 'working' ? '#4fe39b' : s.status === 'waiting' ? '#ffb547' : 'rgba(255,255,255,0.4)'
    ctx.beginPath(); ctx.arc(72, 3.5, 2, 0, Math.PI * 2); ctx.fill()
  })
  void hc
}

// ─── Furniture ───────────────────────────────────────────────────────────

const ACT_CATEGORY: Partial<Record<Activity, ToolCategory>> = {
  reading: 'read', searching: 'search', editing: 'edit', writing: 'write', running: 'shell', browsing: 'web', delegating: 'agent', planning: 'plan', tooling: 'mcp', asking: 'interact',
}
const IDLE: ReadonlySet<Activity> = new Set<Activity>(['idle', 'sleeping', 'finished', 'aborted'])

/** Colour an agent's screen glows in, from what it is doing. */
export function activityColor(activity: Activity, hc: string): string {
  const cat = ACT_CATEGORY[activity]
  if (cat) return CATEGORY[cat].color
  if (activity === 'thinking') return '#c7a6ff'
  if (activity === 'waiting') return '#ffb547'
  if (activity === 'failed') return '#ff5d73'
  return mix('#9fd8ff', hc, 0.3)
}

function screenColorFor(activity: Activity | undefined, hc: string): { color: string; active: boolean } {
  const active = !!activity && !IDLE.has(activity)
  return { color: activity ? activityColor(activity, hc) : '#9fd8ff', active }
}

function drawDesk(ctx: CanvasRenderingContext2D, desk: Desk, activity: Activity | undefined, now: number, hc: string, idx: number, lights: Light[], day: number): void {
  const { x, y, w, d, boss } = desk
  const top = boss ? M.walnut : M.deskTop
  const legC = boss ? '#c8a165' : M.steel
  // Legs, modesty panel, drawer unit.
  for (const [lx, ly] of [[x + 0.05, y + 0.05], [x + w - 0.11, y + 0.05], [x + 0.05, y + d - 0.11], [x + w - 0.11, y + d - 0.11]]) {
    box(ctx, lx!, ly!, 0, 0.06, 0.06, 0.7, legC, { lit: false, edge: false })
  }
  box(ctx, x + 0.1, y + d - 0.1, 0.14, w - 0.2, 0.03, 0.42, boss ? shade(top, -0.12) : '#e4dccf', { edge: false })
  if (!boss) {
    box(ctx, x + w - 0.46, y + 0.12, 0.06, 0.38, d - 0.26, 0.58, '#e9e2d7')
    for (let i = 1; i < 3; i++) line(ctx, iso(x + w - 0.46, y + d - 0.14, 0.06 + i * 0.19), iso(x + w - 0.08, y + d - 0.14, 0.06 + i * 0.19), 'rgba(0,0,0,0.12)')
  }
  // Top.
  box(ctx, x, y, 0.7, w, d, 0.07, top, { top: boss ? shade(top, 0.12) : '#f8f3eb' })
  if (boss) {
    // Wood grain.
    ctx.strokeStyle = 'rgba(80,45,20,0.12)'
    ctx.lineWidth = 1
    for (let k = 0.18; k < d; k += 0.22) { const a = iso(x + 0.1, y + k, 0.771), b = iso(x + w - 0.1, y + k + 0.02, 0.771); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke() }
  }
  const Z = 0.77
  const { color: sc, active } = screenColorFor(activity, hc)
  const pulse = active ? 0.75 + 0.25 * Math.sin(now / 190 + idx) : 1
  const screenGlow = active ? 0.42 * pulse : 0.1

  if (boss) {
    // Two monitors on stands, keyboard, mouse, mug, plant, lamp.
    // The lead sits behind the desk (smaller y), so the keyboard goes on that
    // side and the monitors stand in front of it with their backs to us.
    floorQuad(ctx, x + 0.78, y + 0.1, 0.78, 0.22, '#e6e9ef', Z + 0.01)
    floorQuad(ctx, x + 0.82, y + 0.13, 0.7, 0.16, '#cfd4de', Z + 0.012)
    cyl(ctx, x + 1.72, y + 0.2, Z, 0.06, 0.03, '#dfe3ea')
    for (const mx of [x + 0.4, x + 1.32]) {
      box(ctx, mx + 0.28, y + 0.5, Z, 0.3, 0.16, 0.03, M.steel, { edge: false })
      box(ctx, mx + 0.4, y + 0.55, Z + 0.03, 0.06, 0.05, 0.2, M.steel, { lit: false, edge: false })
      box(ctx, mx, y + 0.56, Z + 0.22, 0.86, 0.05, 0.52, M.screen, { left: grad(ctx, iso(mx, y + 0.61, Z + 0.74), iso(mx, y + 0.61, Z + 0.22), '#3a3f52', '#262a38') })
      const logo = iso(mx + 0.43, y + 0.61, Z + 0.46)
      ctx.fillStyle = active ? sc : 'rgba(255,255,255,0.35)'
      ctx.beginPath(); ctx.arc(logo.x, logo.y, 2, 0, Math.PI * 2); ctx.fill()
      // Rim light from the screen leaking around the edge, and its pool on the keyboard side.
      const rim = iso(mx + 0.43, y + 0.52, Z + 0.5)
      lights.push({ p: rim, rx: 34, ry: 30, color: sc, day: screenGlow * 0.3, night: screenGlow * 1.5 + 0.1 })
      lights.push({ p: iso(mx + 0.43, y + 0.05, Z + 0.1), rx: 46, ry: 26, color: sc, day: screenGlow * 0.3, night: screenGlow * 1.2 })
    }
    drawMug(ctx, x + 2.22, y + 0.72, Z, '#e07a5f')
    drawMiniPlant(ctx, x + 0.14, y + 0.82, Z, now)
    drawDeskLamp(ctx, x + w - 0.2, y + 0.18, Z, lights, day, '#2f3342')
    // Name plate.
    box(ctx, x + 0.2, y + d - 0.26, Z, 0.42, 0.06, 0.1, '#1f2230', { lit: false })
  } else {
    // Laptop. The worker sits behind the desk (smaller y), so the keyboard is on
    // the far half of the base, the hinge on the near edge, and the lid leans
    // toward us: we see its back, which hides part of the keyboard.
    const lx = x + w / 2 - 0.3, ly = y + 0.22
    box(ctx, lx, ly, Z, 0.6, 0.4, 0.025, '#cfd4de', { edge: false, top: '#dde1e9' })
    floorQuad(ctx, lx + 0.06, ly + 0.05, 0.48, 0.2, '#b4bac8', Z + 0.03)
    const lidTop = Z + 0.4
    const hinge = ly + 0.4
    const lid = [iso(lx, hinge, Z + 0.025), iso(lx + 0.6, hinge, Z + 0.025), iso(lx + 0.6, hinge + 0.1, lidTop), iso(lx, hinge + 0.1, lidTop)]
    poly(ctx, lid, grad(ctx, lid[3]!, lid[0]!, '#d7dbe4', '#aeb5c4'))
    line(ctx, lid[3]!, lid[2]!, 'rgba(255,255,255,0.7)', 1)
    const logo = iso(lx + 0.3, hinge + 0.05, Z + 0.22)
    ctx.fillStyle = active ? sc : alpha(hc, 0.55)
    ctx.beginPath(); ctx.arc(logo.x, logo.y, 2.2, 0, Math.PI * 2); ctx.fill()
    lights.push({ p: iso(lx + 0.3, ly - 0.15, Z + 0.15), rx: 40, ry: 24, color: sc, day: screenGlow * 0.35, night: screenGlow * 1.3 + 0.06 })
    // Flavour: papers, mug, sticky note, lamp, sometimes a plant.
    box(ctx, x + 0.1, y + 0.5, Z, 0.32, 0.26, 0.035 + (idx % 3) * 0.02, '#fbfaf7', { edge: false })
    line(ctx, iso(x + 0.16, y + 0.58, Z + 0.06), iso(x + 0.34, y + 0.58, Z + 0.06), 'rgba(90,100,130,0.35)')
    line(ctx, iso(x + 0.16, y + 0.66, Z + 0.06), iso(x + 0.3, y + 0.66, Z + 0.06), 'rgba(90,100,130,0.35)')
    drawMug(ctx, x + w - 0.28, y + 0.62, Z, ['#f28482', '#84a59d', '#f6bd60', '#8ecae6'][idx % 4]!)
    floorQuad(ctx, x + w - 0.42, y + 0.12, 0.16, 0.16, ['#ffe066', '#ff9fb8', '#9fd8ff'][idx % 3]!, Z + 0.01)
    drawDeskLamp(ctx, x + 0.22, y + 0.18, Z, lights, day, M.steel)
    if (idx % 3 === 1) drawMiniPlant(ctx, x + w - 0.2, y + 0.3, Z, now)
  }
}

function drawMug(ctx: CanvasRenderingContext2D, x: number, y: number, z: number, color: string): void {
  cyl(ctx, x, y, z, 0.075, 0.14, color, { top: '#3b2a22' })
  const h = iso(x + 0.09, y, z + 0.07)
  ctx.strokeStyle = shade(color, -0.1)
  ctx.lineWidth = 1.6
  ctx.beginPath(); ctx.arc(h.x, h.y, 2.6, -Math.PI / 2, Math.PI / 2); ctx.stroke()
}

function drawMiniPlant(ctx: CanvasRenderingContext2D, x: number, y: number, z: number, now: number): void {
  cyl(ctx, x, y, z, 0.08, 0.12, '#d98c6b')
  const p = iso(x, y, z + 0.12)
  const sway = Math.sin(now / 1100 + x) * 0.6
  for (const [dx, dy, r, c] of [[-3, -4, 3.2, '#4fb97d'], [3, -5, 3.2, '#6ad89a'], [0, -8, 3, '#7ee0a8']] as const) {
    ctx.fillStyle = c
    ctx.beginPath(); ctx.ellipse(p.x + dx + sway, p.y + dy, r, r * 0.8, 0, 0, Math.PI * 2); ctx.fill()
  }
}

function drawDeskLamp(ctx: CanvasRenderingContext2D, x: number, y: number, z: number, lights: Light[], day: number, color: string): void {
  cyl(ctx, x, y, z, 0.09, 0.03, color)
  box(ctx, x - 0.015, y - 0.015, z + 0.03, 0.03, 0.03, 0.42, color, { lit: false, edge: false })
  // Arm leaning toward the desk centre, then the shade.
  const a = iso(x, y, z + 0.45), b = iso(x + 0.12, y + 0.16, z + 0.56)
  line(ctx, a, b, color, 2.2)
  const shadeC = '#f4e7d0'
  cyl(ctx, x + 0.12, y + 0.16, z + 0.42, 0.13, 0.14, shadeC, { top: shade(shadeC, -0.04) })
  const bulb = iso(x + 0.12, y + 0.16, z + 0.42)
  ctx.fillStyle = `rgba(255,214,150,${0.35 + (1 - day) * 0.65})`
  ctx.beginPath(); ctx.ellipse(bulb.x, bulb.y, 0.11 * TW / 2, 0.11 * TH / 2, 0, 0, Math.PI * 2); ctx.fill()
  lights.push({ p: iso(x + 0.14, y + 0.2, z), rx: 62, ry: 34, color: '#ffbe78', day: 0, night: 0.42 })
  lights.push({ p: bulb, rx: 18, ry: 12, color: '#ffe2b0', day: 0, night: 0.45 })
}

function drawChair(ctx: CanvasRenderingContext2D, sx: number, sy: number, hc: string): void {
  const fabric = mix('#3d4460', hc, 0.38)
  const metal = '#565b6e'
  // Five-star base with casters.
  const c = iso(sx, sy, 0.03)
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.4
    const e = iso(sx + Math.cos(a) * 0.27, sy + Math.sin(a) * 0.27, 0.03)
    line(ctx, c, e, metal, 2.4)
    ctx.fillStyle = '#2e3140'
    ctx.beginPath(); ctx.ellipse(e.x, e.y + 1, 2.2, 1.4, 0, 0, Math.PI * 2); ctx.fill()
  }
  cyl(ctx, sx, sy, 0.03, 0.045, 0.32, metal)
  box(ctx, sx - 0.26, sy - 0.24, 0.33, 0.52, 0.5, 0.1, fabric, { top: shade(fabric, 0.16) })
  box(ctx, sx - 0.24, sy - 0.33, 0.43, 0.48, 0.1, 0.62, fabric, { top: shade(fabric, 0.14) })
  box(ctx, sx - 0.32, sy - 0.1, 0.43, 0.06, 0.28, 0.2, '#4b4f63', { edge: false })
  box(ctx, sx + 0.26, sy - 0.1, 0.43, 0.06, 0.28, 0.2, '#4b4f63', { edge: false })
}

function drawCouchBack(ctx: CanvasRenderingContext2D): void {
  const { x, y, w, d } = COUCH
  const c = '#7f8fd8'
  box(ctx, x, y, 0, w, d, 0.3, shade(c, -0.08))
  box(ctx, x, y, 0.3, w, 0.26, 0.6, c, { top: shade(c, 0.14) })
  for (let i = 0; i < 3; i++) box(ctx, x + 0.06 + i * (w / 3), y + 0.02, 0.33, w / 3 - 0.12, 0.26, 0.5, shade(c, 0.05), { top: shade(c, 0.2) })
  box(ctx, x - 0.2, y, 0, 0.2, d, 0.62, shade(c, -0.02), { top: shade(c, 0.12) })
  box(ctx, x + w, y, 0, 0.2, d, 0.62, shade(c, -0.02), { top: shade(c, 0.12) })
  // Throw pillow.
  box(ctx, x + 0.16, y + 0.3, 0.42, 0.36, 0.14, 0.34, '#f6bd60', { top: '#ffd68a' })
}

function drawCouchFront(ctx: CanvasRenderingContext2D): void {
  const { x, y, w, d } = COUCH
  const c = '#7f8fd8'
  for (let i = 0; i < 3; i++) box(ctx, x + 0.04 + i * (w / 3), y + 0.26, 0.3, w / 3 - 0.08, d - 0.26, 0.14, shade(c, 0.06), { top: shade(c, 0.22) })
}

function drawSideTable(ctx: CanvasRenderingContext2D): void {
  const { x, y } = SIDE_TABLE
  cyl(ctx, x, y, 0, 0.16, 0.03, M.walnut)
  cyl(ctx, x, y, 0.03, 0.03, 0.5, shade(M.walnut, -0.2))
  cyl(ctx, x, y, 0.53, 0.3, 0.05, M.walnut, { top: shade(M.walnut, 0.14) })
  // A stack of books.
  box(ctx, x - 0.16, y - 0.12, 0.58, 0.3, 0.22, 0.04, '#ff7aa8', { edge: false })
  box(ctx, x - 0.14, y - 0.1, 0.62, 0.28, 0.2, 0.04, '#5aa9ff', { edge: false })
}

function drawFloorLamp(ctx: CanvasRenderingContext2D, lights: Light[], day: number): void {
  const { x, y } = FLOOR_LAMP
  cyl(ctx, x, y, 0, 0.18, 0.03, '#2f3342')
  cyl(ctx, x, y, 0.03, 0.025, 1.55, '#4b4f63')
  const shade0 = '#f3e3c8'
  cyl(ctx, x, y, 1.45, 0.3, 0.38, shade0, { top: shade(shade0, -0.08) })
  const p = iso(x, y, 1.45)
  ctx.fillStyle = `rgba(255,226,170,${0.3 + 0.7 * (1 - day)})`
  ctx.beginPath(); ctx.ellipse(p.x, p.y, 0.3 * TW / 2, 0.3 * TH / 2, 0, 0, Math.PI * 2); ctx.fill()
  lights.push({ p: iso(x, y, 0), rx: 100, ry: 55, color: '#ffb66e', day: 0, night: 0.3 })
  lights.push({ p: iso(x, y, 1.6), rx: 44, ry: 40, color: '#ffdca6', day: 0, night: 0.4 })
}

function drawCabinet(ctx: CanvasRenderingContext2D): void {
  const { x, y, w, d, h } = CABINET
  const c = '#9aa6c4'
  box(ctx, x, y, 0, w, d, h, c)
  for (let i = 0; i < 3; i++) {
    const z0 = 0.08 + i * (h / 3), z1 = z0 + h / 3 - 0.06
    poly(ctx, [iso(x + w, y + 0.06, z0), iso(x + w, y + d - 0.06, z0), iso(x + w, y + d - 0.06, z1), iso(x + w, y + 0.06, z1)], shade(c, -0.3))
    poly(ctx, [iso(x + w, y + 0.08, z0 + 0.02), iso(x + w, y + d - 0.08, z0 + 0.02), iso(x + w, y + d - 0.08, z1 - 0.02), iso(x + w, y + 0.08, z1 - 0.02)], shade(c, -0.2))
    const k = iso(x + w + 0.01, y + d / 2, z0 + 0.2)
    ctx.fillStyle = '#e8ecf5'
    ctx.fillRect(k.x - 4, k.y - 1, 8, 2)
    const lbl = iso(x + w + 0.01, y + d / 2, z1 - 0.07)
    ctx.fillStyle = 'rgba(255,255,255,0.75)'
    ctx.fillRect(lbl.x - 5, lbl.y - 2, 10, 3)
  }
  // Something on top: a tray and a small radio.
  box(ctx, x + 0.1, y + 0.1, h, 0.5, 0.3, 0.03, '#e3d6c4', { edge: false })
  box(ctx, x + 0.15, y + 0.42, h, 0.4, 0.22, 0.2, '#2f3342')
}

function drawCounter(ctx: CanvasRenderingContext2D, now: number, lights: Light[]): void {
  const { x, y, w, d, h } = COUNTER
  box(ctx, x, y, 0, w, d, h - 0.06, '#e8e1d8', { top: '#e8e1d8' })
  box(ctx, x - 0.02, y - 0.02, h - 0.06, w + 0.04, d + 0.04, 0.06, '#f6f2ec', { top: '#fbf8f4' })
  // Cupboard doors on the +x face.
  for (let i = 0; i < 2; i++) {
    const y0 = y + 0.1 + i * (d / 2), y1 = y0 + d / 2 - 0.2
    poly(ctx, [iso(x + w, y0, 0.1), iso(x + w, y1, 0.1), iso(x + w, y1, h - 0.16), iso(x + w, y0, h - 0.16)], 'rgba(0,0,0,0.07)')
    const k = iso(x + w + 0.01, y1 - 0.08, h / 2)
    ctx.fillStyle = '#9aa0ad'
    ctx.fillRect(k.x - 1, k.y - 4, 2, 7)
  }
  // Espresso machine.
  box(ctx, x + 0.08, y + 0.2, h, 0.6, 0.55, 0.62, '#3a3e4e')
  box(ctx, x + 0.08, y + 0.2, h + 0.62, 0.6, 0.55, 0.06, '#50556a', { top: '#5d6378' })
  box(ctx, x + 0.68, y + 0.3, h + 0.2, 0.03, 0.34, 0.1, '#ff8a4c', { edge: false })
  box(ctx, x + 0.3, y + 0.75, h, 0.2, 0.08, 0.12, '#8a8f9f', { edge: false })
  const led = iso(x + 0.69, y + 0.6, h + 0.48)
  ctx.fillStyle = '#4fe39b'
  ctx.beginPath(); ctx.arc(led.x, led.y, 1.4, 0, Math.PI * 2); ctx.fill()
  lights.push({ p: led, rx: 8, ry: 6, color: '#4fe39b', day: 0.1, night: 0.6 })
  // Mugs and a fruit bowl.
  drawMug(ctx, x + 0.32, y + 1.22, h, '#ff9fb8')
  drawMug(ctx, x + 0.56, y + 1.42, h, '#9fd8ff')
  cyl(ctx, x + 0.42, y + 1.95, h, 0.2, 0.08, '#e9e1d4', { top: '#f1ebe2' })
  for (const [dx, dy, c] of [[-0.05, -0.04, '#ff6b6b'], [0.06, -0.02, '#ffd166'], [0, 0.06, '#8ac926']] as const) {
    const p = iso(x + 0.42 + dx, y + 1.95 + dy, h + 0.1)
    ctx.fillStyle = c
    ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill()
  }
  // Steam.
  const p = iso(x + 0.36, y + 0.47, h + 0.68)
  ctx.strokeStyle = 'rgba(255,255,255,0.7)'
  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  for (let i = 0; i < 2; i++) {
    const t = (now / 1500 + i * 0.5) % 1
    ctx.globalAlpha = (1 - t) * 0.9
    ctx.beginPath()
    for (let k = 0; k <= 8; k++) {
      const yy = p.y - t * 24 - k * 2
      const xx = p.x + i * 6 + Math.sin(k * 0.8 + now / 320) * 2.5
      if (k === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy)
    }
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

function drawShelf(ctx: CanvasRenderingContext2D): void {
  const { x, y, w, d, h } = SHELF
  const wood = '#c69a6c'
  // Back panel, sides, shelves.
  box(ctx, x, y, 0, w, 0.04, h, shade(wood, -0.2), { lit: false, edge: false })
  box(ctx, x, y, 0, 0.06, d, h, wood)
  box(ctx, x + w - 0.06, y, 0, 0.06, d, h, wood)
  const rows = 3
  const colors = ['#ff8a4c', '#5aa9ff', '#ffd166', '#3ee0c5', '#9d8cff', '#ff7aa8', '#7bd389', '#f4a261', '#e76f51', '#2a9d8f']
  for (let r = 0; r <= rows; r++) {
    const z = (r / rows) * (h - 0.05)
    box(ctx, x, y, z, w, d, 0.05, wood, { top: shade(wood, 0.1) })
    if (r === rows) break
    let bx = x + 0.1
    let i = r * 5
    const lean = rnd(r, 9) > 0.5
    while (bx < x + w - 0.16) {
      const bw = 0.09 + rnd(r, i) * 0.07
      const bh = 0.34 + rnd(r, i, 2) * 0.12
      if (lean && bx > x + w - 0.42 && r === 1) {
        // A leaning book at the end of the row.
        const a = iso(bx, y + d - 0.03, z + 0.05), b = iso(bx + 0.26, y + d - 0.03, z + 0.05 + bh)
        ctx.strokeStyle = colors[i % colors.length]!
        ctx.lineWidth = bw * TW * 0.7
        ctx.beginPath(); ctx.moveTo(a.x + 2, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
        break
      }
      box(ctx, bx, y + 0.1, z + 0.05, bw, d - 0.14, bh, colors[i % colors.length]!, { lit: false, edge: false })
      const sp = iso(bx + bw / 2, y + d - 0.04, z + 0.05 + bh * 0.72)
      ctx.fillStyle = 'rgba(255,255,255,0.45)'
      ctx.fillRect(sp.x - 1, sp.y, 2, 1.2)
      bx += bw + 0.015
      i++
    }
    if (r === 2) {
      // Top row: a plant and a trophy instead of books.
      drawMiniPlant(ctx, x + w - 0.3, y + 0.25, z + 0.05, 0)
    }
  }
  cyl(ctx, x + 0.25, y + 0.25, h, 0.07, 0.04, '#e9c46a')
  cyl(ctx, x + 0.25, y + 0.25, h + 0.04, 0.03, 0.12, '#e9c46a')
  cyl(ctx, x + 0.25, y + 0.25, h + 0.16, 0.08, 0.1, '#f1d27a', { top: '#ffe59a' })
}

function drawPlant(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, now: number, seed: number, kind: number): void {
  const potC = ['#d98c6b', '#8ea8b8', '#c9b7a0'][kind % 3]!
  cyl(ctx, x, y, 0, 0.2 * size, 0.08 * size, shade(potC, -0.08))
  cyl(ctx, x, y, 0.08 * size, 0.22 * size, 0.3 * size, potC, { top: '#5a3f2c' })
  const base = iso(x, y, 0.38 * size)
  const sway = Math.sin(now / 1300 + seed) * 1.4
  if (kind === 1) {
    // Snake plant: tall tapered blades.
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2
      const dx = Math.cos(a) * 5 * size, dh = (22 + rnd(i, seed) * 14) * size
      ctx.fillStyle = i % 2 ? '#3f9d6a' : '#5cc98a'
      ctx.beginPath()
      ctx.moveTo(base.x + dx - 2.5 * size, base.y)
      ctx.quadraticCurveTo(base.x + dx + sway * (dh / 30), base.y - dh, base.x + dx + 2.5 * size, base.y)
      ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.25)'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(base.x + dx, base.y - 2); ctx.lineTo(base.x + dx + sway * (dh / 30) * 0.5, base.y - dh * 0.55); ctx.stroke()
    }
    return
  }
  // Leafy: layered leaves with a vein.
  const leaves: Array<[number, number, number, number, string]> = [
    [-11, -9, 9, -0.5, '#4fb97d'], [11, -11, 9, 0.5, '#6ad89a'], [0, -19, 11, 0, '#5cc98a'], [-6, -27, 8, -0.3, '#7ee0a8'], [7, -25, 8, 0.3, '#4fb97d'], [0, -33, 6, 0, '#8be8b4'],
  ]
  for (const [dx, dy, r, rot, c] of leaves) {
    const px = base.x + dx * size + sway * (-dy / 30), py = base.y + dy * size
    ctx.fillStyle = c
    ctx.beginPath()
    ctx.ellipse(px, py, r * size, r * size * 0.78, rot, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.3)'
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(px - Math.cos(rot) * r * size * 0.7, py - Math.sin(rot) * r * size * 0.7); ctx.lineTo(px + Math.cos(rot) * r * size * 0.7, py + Math.sin(rot) * r * size * 0.7); ctx.stroke()
  }
}

function drawCat(ctx: CanvasRenderingContext2D, room: Room, now: number): void {
  const cat = room.cat
  const p = iso(cat.x, cat.y, 0)
  const napping = now < cat.napUntil
  const walking = cat.path.length > 0
  ctx.save()
  ctx.translate(p.x, p.y)
  ctx.scale(cat.facing, 1)
  const fur = '#f2a65a', dark = shade(fur, -0.22)
  ctx.fillStyle = fur
  if (napping) {
    ctx.beginPath(); ctx.ellipse(0, -5, 10, 6, 0, 0, Math.PI * 2); ctx.fill()
    ctx.strokeStyle = fur; ctx.lineWidth = 3; ctx.lineCap = 'round'
    ctx.beginPath(); ctx.moveTo(-8, -4); ctx.quadraticCurveTo(-14, -2, -9, 0.5); ctx.stroke()
    ctx.beginPath(); ctx.arc(7, -6, 4.5, 0, Math.PI * 2); ctx.fill()
    ctx.beginPath(); ctx.moveTo(4, -9); ctx.lineTo(4.5, -13); ctx.lineTo(7, -10); ctx.fill()
    ctx.beginPath(); ctx.moveTo(8, -10); ctx.lineTo(10.5, -13); ctx.lineTo(11, -9); ctx.fill()
    ctx.fillStyle = dark
    for (const sx of [-4, -1, 2]) ctx.fillRect(sx, -10, 1.4, 3)
    ctx.strokeStyle = '#3a2a2a'; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(7, -6); ctx.lineTo(9, -6); ctx.stroke()
    ctx.fillStyle = '#ffffff'
    ctx.font = `700 8px ${FONT}`
    ctx.fillText('z', 10, -16 - ((now / 400) % 6))
  } else {
    const bob = walking ? Math.sin(cat.phase * 12) * 1.2 : 0
    ctx.fillStyle = dark
    for (const lx of [-6, -2, 3, 7]) ctx.fillRect(lx, -4 + (walking ? Math.sin(cat.phase * 12 + lx) : 0), 2.2, 4.5)
    ctx.fillStyle = fur
    ctx.beginPath(); ctx.ellipse(0, -8 + bob, 9, 5.5, 0, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = dark
    for (const sx of [-5, -2, 1]) ctx.fillRect(sx, -13 + bob, 1.5, 4)
    ctx.strokeStyle = fur; ctx.lineWidth = 2.6; ctx.lineCap = 'round'
    ctx.beginPath(); ctx.moveTo(-8, -9); ctx.quadraticCurveTo(-15, -14 + Math.sin(now / 300) * 3, -12, -21); ctx.stroke()
    ctx.fillStyle = fur
    ctx.beginPath(); ctx.arc(9, -13 + bob, 5, 0, Math.PI * 2); ctx.fill()
    ctx.beginPath(); ctx.moveTo(5.5, -16 + bob); ctx.lineTo(6.5, -21 + bob); ctx.lineTo(9, -17 + bob); ctx.fill()
    ctx.beginPath(); ctx.moveTo(10, -17 + bob); ctx.lineTo(12.5, -21 + bob); ctx.lineTo(13.5, -15 + bob); ctx.fill()
    ctx.fillStyle = '#ffd9c2'
    ctx.beginPath(); ctx.moveTo(6.6, -18.5 + bob); ctx.lineTo(7, -20 + bob); ctx.lineTo(8, -18 + bob); ctx.fill()
    ctx.fillStyle = '#3a2a2a'
    ctx.fillRect(10, -14 + bob, 1.4, 1.6)
    ctx.fillRect(12.4, -14 + bob, 1.4, 1.6)
    ctx.fillStyle = '#e07a9a'
    ctx.fillRect(13.2, -11.5 + bob, 1.4, 1)
  }
  ctx.restore()
}

// ─── Blobs ───────────────────────────────────────────────────────────────

export interface WorkerPos { head: Pt; foot: Pt; hip: Pt }

/** Draws an agent's blob and returns screen positions (before camera) for overlays. */
function drawWorker(ctx: CanvasRenderingContext2D, c: Char, activity: Activity, now: number, focus: boolean, day: number): WorkerPos {
  const seated = c.mode === 'seated'
  const lounging = c.mode === 'lounging'
  const walking = c.mode === 'walking'
  const jump = now < c.jumpUntil ? Math.abs(Math.sin(((c.jumpUntil - now) / 900) * Math.PI * 2)) * 0.35 : 0
  const z = seatZ(c.mode) + jump
  const foot = iso(c.x, c.y, z)
  const t = now / 1000
  ctx.save()
  ctx.globalAlpha = c.alpha

  if (activity === 'waiting') {
    const k = (now % 1200) / 1200
    const f = iso(c.x, c.y, 0)
    ctx.strokeStyle = `rgba(255,181,71,${0.9 - k * 0.8})`
    ctx.lineWidth = 2
    ctx.beginPath(); ctx.ellipse(f.x, f.y, 14 + k * 14, 7 + k * 7, 0, 0, Math.PI * 2); ctx.stroke()
  }
  if (focus) {
    const f = iso(c.x, c.y, 0)
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    ctx.setLineDash([4, 3])
    ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.ellipse(f.x, f.y, 19, 9.5, 0, 0, Math.PI * 2); ctx.stroke()
    ctx.setLineDash([])
  }

  // Sitting blobs don't do the big hops; they settle into the seat.
  const art = blobArt(c.seed, activity)
  const m = blobMotion(activity, walking, t, c.phase)
  if (seated || lounging) { m.dy = Math.max(m.dy * 0.4, -5); m.rot *= 0.6; m.dx *= 0.5 }
  const blink = now >= c.blinkAt && now < c.blinkAt + 140 ? 0.08 : activity === 'sleeping' ? 0.12 : 1
  drawBlob(ctx, art, foot.x, foot.y, {
    size: BLOB, facing: c.facing, eyes: blink, sx: m.sx, sy: m.sy, rot: m.rot, dx: m.dx, dyExtra: m.dy,
    headset: c.isRoot, dim: activity === 'sleeping' ? 1 : activity === 'idle' ? 0.3 : 0,
    // The night wash multiplies everything afterwards; blobs are pre-lit so faces stay readable.
    lift: 1 - day,
  })
  // A mug for the break room and for idle desk time.
  if (lounging || (seated && activity === 'idle')) {
    const mx = foot.x + c.facing * 14, my = foot.y - 9
    ctx.fillStyle = '#ffffff'
    roundRect(ctx, mx - 3.5, my - 5, 7, 8, 1.6); ctx.fill()
    ctx.fillStyle = '#ff8fab'
    ctx.fillRect(mx - 3.5, my - 2.5, 7, 2)
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.4
    ctx.beginPath(); ctx.arc(mx + 4, my - 1, 2.2, -Math.PI / 2, Math.PI / 2); ctx.stroke()
  }
  ctx.restore()

  const s = BLOB / 100
  const top = foot.y - (art.bottom - (art.frame.cy - art.frame.ry) - art.dy - m.dy) * s * m.sy
  return { head: { x: foot.x + m.dx * s, y: top }, foot: { x: foot.x, y: foot.y + (lounging ? 6 : seated ? 3 : 0) }, hip: { x: foot.x, y: foot.y - 10 } }
}

// ─── Overlays (labels, bubbles, chips) ───────────────────────────────────

function drawOverlay(ctx: CanvasRenderingContext2D, origin: Pt, pos: WorkerPos, c: Char, act: ReturnType<typeof activityOf>, now: number, rs: RenderState, cam: Camera): void {
  ctx.save()
  ctx.translate(origin.x, origin.y)
  ctx.globalAlpha = c.alpha
  const x = pos.head.x
  const y = pos.head.y - 6
  const focus = rs.hovered === c.id || rs.selected === c.id

  // Name tag.
  if ((rs.labels && c.mode !== 'lounging') || focus) {
    ctx.font = `700 9.5px ${FONT}`
    const base = c.isRoot ? '★ lead' : clip(c.name, 18)
    const label = focus ? `${base} · ${LOOKS[act.activity].label}` : base
    const w = ctx.measureText(label).width + 12
    const ty = pos.foot.y + 5
    roundRect(ctx, x - w / 2, ty, w, 14, 7)
    ctx.fillStyle = focus ? '#2d2a4a' : 'rgba(45,42,74,0.74)'
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, x, ty + 7.5)
    ctx.textAlign = 'left'
  }

  if (act.activity === 'sleeping' && !c.bubble) {
    ctx.fillStyle = '#9aa2ff'
    ctx.font = `800 11px ${FONT}`
    const k = (now % 2400) / 2400
    ctx.globalAlpha = c.alpha * (1 - k)
    ctx.fillText('z', x + 10 + k * 8, y - k * 18)
    ctx.fillText('z', x + 16 + k * 10, y - 8 - k * 22)
    ctx.globalAlpha = c.alpha
  }

  const bubble = c.bubble && now >= c.bubble.born ? c.bubble : undefined
  if (bubble) {
    drawSpeech(ctx, x, y, bubble.text, bubble.tone, (now - bubble.born) / bubble.ttl)
  } else if (act.activity === 'waiting') {
    const b = Math.abs(Math.sin(now / 250)) * 4
    ctx.fillStyle = 'rgba(0,0,0,0.15)'
    ctx.beginPath(); ctx.arc(x + 1, y - 5 - b, 9.5, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = '#ffb547'
    ctx.beginPath(); ctx.arc(x, y - 6 - b, 9.5, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = '#3a2600'
    ctx.font = `900 12px ${FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('!', x, y - 5.5 - b)
    ctx.textAlign = 'left'
    if (act.tool && (focus || cam.zoom > 1.1)) chip(ctx, x, y - 24 - b, `waiting · ${act.tool.title}`, '#ffb547')
  } else if (act.activity === 'asking') {
    const b = Math.abs(Math.sin(now / 400)) * 3
    ctx.fillStyle = '#ffffff'
    ctx.strokeStyle = '#5aa9ff'
    ctx.lineWidth = 1.6
    ctx.beginPath(); ctx.arc(x + 8, y - 8 - b, 9.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
    ctx.fillStyle = '#2f6fd1'
    ctx.font = `900 12px ${FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('?', x + 8, y - 7.5 - b)
    ctx.textAlign = 'left'
  } else if (act.activity === 'thinking' || act.activity === 'planning') {
    const k = now / 300
    ctx.fillStyle = '#ffffff'
    ctx.strokeStyle = '#c7a6ff'
    ctx.lineWidth = 1.5
    for (const [dx, dy, r] of [[6, -2, 2.5], [11, -8, 3.5]] as const) {
      ctx.beginPath(); ctx.arc(x + dx, y + dy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
    }
    roundRect(ctx, x + 6, y - 30, 34, 18, 9)
    ctx.fill(); ctx.stroke()
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = '#9d7cf0'
      ctx.beginPath(); ctx.arc(x + 15 + i * 8, y - 21 - Math.max(0, Math.sin(k - i * 0.7)) * 3, 2.2, 0, Math.PI * 2); ctx.fill()
    }
  } else if (act.tool) {
    const cat = CATEGORY[act.tool.category]
    chip(ctx, x, y - 6, `${cat?.glyph ?? '•'} ${act.tool.title}`, cat?.color ?? '#9aa3b5', focus || cam.zoom > 1.25 ? 46 : 22)
  }
  ctx.restore()
}

function chip(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string, max = 30): void {
  ctx.font = `700 9.5px ${FONT}`
  const label = clip(text, max)
  const w = ctx.measureText(label).width + 16
  roundRect(ctx, x - w / 2 + 1, y - 15, w, 16, 8)
  ctx.fillStyle = 'rgba(0,0,0,0.14)'
  ctx.fill()
  roundRect(ctx, x - w / 2, y - 16, w, 16, 8)
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  ctx.strokeStyle = color
  ctx.lineWidth = 1.6
  ctx.stroke()
  ctx.fillStyle = shade(color, -0.45)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, x, y - 7.5)
  ctx.textAlign = 'left'
}

function drawSpeech(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, tone: string, k: number): void {
  const fade = k < 0.06 ? k / 0.06 : k > 0.88 ? (1 - k) / 0.12 : 1
  ctx.globalAlpha *= clamp(fade, 0, 1)
  ctx.font = `600 10.5px ${FONT}`
  const shown = text.slice(0, Math.max(1, Math.floor(clamp(k * 6, 0, 1) * Math.min(text.length, 140))))
  const lines = wrapText(ctx, shown, 170, 3)
  const w = Math.max(40, ...lines.map((l) => ctx.measureText(l).width)) + 18
  const h = lines.length * 14 + 12
  const bx = x - w / 2, by = y - h - 12
  const border = tone === 'user' ? '#ff8fab' : tone === 'task' ? '#ffd166' : '#8fb8ff'
  const fill = tone === 'user' ? '#fff3f6' : '#ffffff'
  roundRect(ctx, bx + 2, by + 3, w, h, 10)
  ctx.fillStyle = 'rgba(30,20,60,0.16)'
  ctx.fill()
  roundRect(ctx, bx, by, w, h, 10)
  ctx.fillStyle = fill
  ctx.fill()
  ctx.strokeStyle = border
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(x - 5, by + h); ctx.lineTo(x, by + h + 8); ctx.lineTo(x + 5, by + h)
  ctx.fillStyle = fill
  ctx.fill()
  ctx.strokeStyle = border
  ctx.beginPath(); ctx.moveTo(x - 5, by + h); ctx.lineTo(x, by + h + 8); ctx.lineTo(x + 5, by + h); ctx.stroke()
  ctx.fillStyle = '#3a3552'
  ctx.textBaseline = 'top'
  lines.forEach((l, i) => ctx.fillText(l, bx + 9, by + 7 + i * 14))
  if (tone === 'user') {
    ctx.font = `800 8px ${FONT}`
    ctx.fillStyle = '#ff6f91'
    ctx.fillText('FROM YOU', bx + 9, by - 10)
  }
}

// ─── Effects ─────────────────────────────────────────────────────────────

function drawEffects(ctx: CanvasRenderingContext2D, room: Room, now: number, origin: Pt, rs: RenderState): void {
  const target = rs.fileTarget ? { x: rs.fileTarget.x - origin.x, y: rs.fileTarget.y - origin.y } : undefined
  let stack = 0
  for (const e of (room as Room & { _effects?: Effect[] })._effects ?? []) {
    if (e.kind === 'diff') { drawDiffBubble(ctx, room, e, now, target, stack); stack++ }
    else drawEffect(ctx, e, now)
  }
}

const OP_COLOR = { edit: CATEGORY.edit.color, write: CATEGORY.write.color, delete: CATEGORY.shell.color } as const

/** A diff typed out beside its author, held, then filed to the front desk. */
function drawDiffBubble(ctx: CanvasRenderingContext2D, room: Room, e: Extract<Effect, { kind: 'diff' }>, now: number, target: Pt | undefined, stack: number): void {
  if (now < e.born) return
  const age = now - e.born
  const head = heads.get(`${room.id}/${e.agentId}`) ?? iso(e.at.x, e.at.y, e.at.z)
  const anchor = { x: head.x + 16, y: head.y - 26 - stack * 10 }
  const flyK = clamp((age - e.typeMs - e.holdMs) / DIFF_FLY_MS, 0, 1)
  const typedChars = Math.floor(e.chars * easeOut(clamp(age / e.typeMs, 0, 1)))
  const W = 196, LH = 11.5, HEAD = 17
  // The card grows a line at a time as the typing reaches it.
  let reached = 0, budget = typedChars
  for (const l of e.lines) { if (budget <= 0 && reached > 0 && typedChars < e.chars) break; reached++; budget -= l.length }
  const H = HEAD + Math.max(1, reached) * LH + 6
  const color = OP_COLOR[e.op] ?? CATEGORY.edit.color

  ctx.save()
  if (flyK > 0) {
    const to = target ?? { x: anchor.x + 300, y: anchor.y + 300 }
    const t = easeInOut(flyK)
    const px = anchor.x + (to.x - anchor.x) * t
    const py = anchor.y + (to.y - anchor.y) * t - Math.sin(t * Math.PI) * 60
    const sc = 1 - 0.78 * t
    ctx.globalAlpha = 1 - 0.85 * t
    ctx.translate(px, py)
    ctx.scale(sc, sc)
    ctx.translate(-anchor.x, -anchor.y)
  } else {
    // Pop in.
    const k = easeOut(clamp(age / 220, 0, 1))
    ctx.globalAlpha = k
    ctx.translate(anchor.x, anchor.y + H)
    ctx.scale(0.85 + 0.15 * k, 0.85 + 0.15 * k)
    ctx.translate(-anchor.x, -anchor.y - H)
  }
  const bx = anchor.x, by = anchor.y - H
  roundRect(ctx, bx + 2, by + 3, W, H, 8)
  ctx.fillStyle = 'rgba(30,20,60,0.18)'
  ctx.fill()
  roundRect(ctx, bx, by, W, H, 8)
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  ctx.strokeStyle = color
  ctx.lineWidth = 1.6
  ctx.stroke()
  // Tail toward the blob.
  if (flyK === 0) {
    ctx.fillStyle = '#ffffff'
    ctx.beginPath(); ctx.moveTo(bx + 2, by + H - 4); ctx.lineTo(bx - 9, by + H + 8); ctx.lineTo(bx + 12, by + H - 1); ctx.closePath(); ctx.fill()
    ctx.strokeStyle = color
    ctx.beginPath(); ctx.moveTo(bx + 2, by + H - 4); ctx.lineTo(bx - 9, by + H + 8); ctx.lineTo(bx + 12, by + H - 1); ctx.stroke()
  }
  ctx.save()
  roundRect(ctx, bx, by, W, H, 8)
  ctx.clip()
  // Header: op dot, path, counts.
  ctx.fillStyle = alpha(color, 0.14)
  ctx.fillRect(bx, by, W, HEAD)
  ctx.fillStyle = color
  ctx.beginPath(); ctx.arc(bx + 10, by + HEAD / 2, 3.2, 0, Math.PI * 2); ctx.fill()
  ctx.textBaseline = 'middle'
  ctx.font = `700 9.5px ${MONO}`
  ctx.fillStyle = '#c7324a'
  const del = `−${e.removed}`
  const delW = ctx.measureText(del).width
  ctx.fillText(del, bx + W - 8 - delW, by + HEAD / 2)
  ctx.fillStyle = '#1f7a4d'
  const add = `+${e.added}`
  const addW = ctx.measureText(add).width
  ctx.fillText(add, bx + W - 12 - delW - addW, by + HEAD / 2)
  ctx.fillStyle = M.ink
  ctx.font = `700 9.5px ${FONT}`
  const pathMax = W - 30 - delW - addW
  let path = e.op === 'delete' ? `delete ${shortName(e.path)}` : shortName(e.path)
  while (path.length > 4 && ctx.measureText(path).width > pathMax) path = '…' + path.slice(2)
  ctx.fillText(path, bx + 18, by + HEAD / 2)
  // Lines, typed.
  ctx.font = `9.5px ${MONO}`
  let left = typedChars
  let caret: Pt | undefined
  e.lines.forEach((l, i) => {
    const y0 = by + HEAD + 3 + i * LH
    const kind = l === '@' ? 'gap' : l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : 'ctx'
    const full = kind === 'gap' ? '⋯' : l.slice(1)
    const n = Math.min(l.length, Math.max(0, left))
    left -= l.length
    if (n <= 0 && flyK === 0 && typedChars < e.chars) return
    const shown = kind === 'gap' ? full : full.slice(0, Math.max(0, n - 1))
    if (kind === 'add') { ctx.fillStyle = 'rgba(79,227,155,0.16)'; ctx.fillRect(bx, y0 - 1, W, LH) }
    if (kind === 'del') { ctx.fillStyle = 'rgba(255,93,115,0.14)'; ctx.fillRect(bx, y0 - 1, W, LH) }
    ctx.fillStyle = kind === 'add' ? '#1f7a4d' : kind === 'del' ? '#c7324a' : kind === 'gap' ? '#9a93b0' : '#5d587a'
    const prefix = kind === 'add' ? '+' : kind === 'del' ? '−' : ' '
    ctx.fillText(prefix + shown, bx + 7, y0 + LH / 2)
    if (n < l.length && n > 0) caret = { x: bx + 7 + ctx.measureText(prefix + shown).width + 1, y: y0 + 1 }
  })
  if (caret && flyK === 0 && Math.floor(now / 260) % 2 === 0) {
    ctx.fillStyle = M.ink
    ctx.fillRect(caret.x, caret.y, 1.6, LH - 3)
  }
  ctx.restore()
  // "Filed" stamp during the hold.
  if (age > e.typeMs + e.holdMs * 0.35 && flyK === 0) {
    const k = easeOut(clamp((age - e.typeMs - e.holdMs * 0.35) / 200, 0, 1))
    ctx.save()
    ctx.translate(bx + W - 26, by + H - 12)
    ctx.rotate(-0.25)
    ctx.scale(1.4 - 0.4 * k, 1.4 - 0.4 * k)
    ctx.globalAlpha *= k
    ctx.font = `900 8px ${FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.strokeStyle = '#1f7a4d'
    ctx.lineWidth = 1.4
    roundRect(ctx, -19, -7, 38, 14, 3)
    ctx.stroke()
    ctx.fillStyle = '#1f7a4d'
    ctx.fillText('FILED', 0, 0.5)
    ctx.restore()
  }
  ctx.restore()
}

function shortName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.slice(-2).join('/')
}

export function attachEffects(office: Office): void {
  for (const r of office.rooms.values()) (r as Room & { _effects?: Effect[] })._effects = []
  for (const e of office.effects) {
    const r = office.rooms.get(e.room) as (Room & { _effects?: Effect[] }) | undefined
    r?._effects?.push(e)
  }
}

function drawEffect(ctx: CanvasRenderingContext2D, e: Effect, now: number): void {
  const k = clamp((now - e.born) / e.dur, 0, 1)
  if (now < e.born) return
  switch (e.kind) {
    case 'plane': {
      const t = easeInOut(k)
      const at = (tt: number) => iso(e.from.x + (e.to.x - e.from.x) * tt, e.from.y + (e.to.y - e.from.y) * tt, e.from.z + (e.to.z - e.from.z) * tt + Math.sin(tt * Math.PI) * 1.4)
      const p = at(t)
      const next = at(Math.min(1, t + 0.02))
      const ang = Math.atan2(next.y - p.y, next.x - p.x)
      // Dotted trail.
      for (let i = 1; i < 7; i++) {
        const q = at(Math.max(0, t - i * 0.035))
        ctx.fillStyle = `rgba(255,143,171,${0.65 - i * 0.09})`
        ctx.beginPath(); ctx.arc(q.x, q.y, 1.6, 0, Math.PI * 2); ctx.fill()
      }
      ctx.save()
      ctx.translate(p.x, p.y)
      ctx.rotate(ang)
      ctx.fillStyle = '#ffffff'
      ctx.strokeStyle = '#ff8fab'
      ctx.lineWidth = 1.2
      ctx.beginPath(); ctx.moveTo(11, 0); ctx.lineTo(-8, -6.5); ctx.lineTo(-4, 0); ctx.lineTo(-8, 6.5); ctx.closePath()
      ctx.fill(); ctx.stroke()
      ctx.fillStyle = '#ffe1ea'
      ctx.beginPath(); ctx.moveTo(11, 0); ctx.lineTo(-4, 0); ctx.lineTo(-8, 6.5); ctx.closePath(); ctx.fill()
      ctx.restore()
      break
    }
    case 'paper': {
      const t = easeInOut(k)
      const p = iso(e.from.x + (e.to.x - e.from.x) * t, e.from.y + (e.to.y - e.from.y) * t, e.from.z + (e.to.z - e.from.z) * t + Math.sin(t * Math.PI) * 1.1)
      ctx.save()
      ctx.translate(p.x, p.y)
      ctx.rotate(Math.sin(k * 12) * 0.4)
      ctx.fillStyle = 'rgba(0,0,0,0.12)'
      ctx.fillRect(-4, -5, 10, 12)
      ctx.fillStyle = e.color
      ctx.strokeStyle = 'rgba(80,90,120,0.4)'
      ctx.fillRect(-5, -6, 10, 12)
      ctx.strokeRect(-5, -6, 10, 12)
      ctx.fillStyle = 'rgba(80,90,120,0.35)'
      for (let i = 0; i < 3; i++) ctx.fillRect(-3, -3 + i * 3, 6, 1)
      ctx.restore()
      break
    }
    case 'puff': {
      const p = iso(e.at.x, e.at.y, e.at.z + k * 0.8)
      for (let i = 0; i < 5; i++) {
        ctx.fillStyle = alpha(e.color, (1 - k) * 0.5)
        ctx.beginPath(); ctx.arc(p.x + Math.cos(i * 1.4) * 8 * (1 + k), p.y - i * 3 * k, 5 + k * 7, 0, Math.PI * 2); ctx.fill()
      }
      break
    }
    case 'popup': {
      const p = iso(e.at.x, e.at.y, e.at.z + 0.2 + easeOut(k) * 0.7)
      ctx.globalAlpha = 1 - k * k
      ctx.fillStyle = 'rgba(0,0,0,0.14)'
      ctx.beginPath(); ctx.arc(p.x + 15, p.y - 29, 7.5, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = e.color
      ctx.beginPath(); ctx.arc(p.x + 14, p.y - 30, 7.5, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = '#ffffff'
      ctx.font = `900 9px ${FONT}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(e.text, p.x + 14, p.y - 29.5)
      ctx.textAlign = 'left'
      ctx.globalAlpha = 1
      break
    }
    case 'ring': {
      const p = iso(e.at.x, e.at.y, 0)
      ctx.strokeStyle = alpha(e.color, 1 - k)
      ctx.lineWidth = 2.5
      ctx.beginPath(); ctx.ellipse(p.x, p.y, 10 + k * 40, 5 + k * 20, 0, 0, Math.PI * 2); ctx.stroke()
      break
    }
    case 'phone': {
      const p = iso(e.at.x, e.at.y, e.at.z)
      const shake = Math.sin(now / 30) * 1.5
      ctx.save()
      ctx.globalAlpha = 1 - k * k
      ctx.translate(p.x - 20 + shake, p.y - 38)
      ctx.rotate(Math.sin(now / 40) * 0.15)
      roundRect(ctx, -4, -7, 8, 14, 2)
      ctx.fillStyle = '#2d2a3e'
      ctx.fill()
      ctx.fillStyle = '#9fd8ff'
      ctx.fillRect(-2.6, -5.2, 5.2, 9)
      ctx.strokeStyle = '#ffd166'
      ctx.lineWidth = 1.4
      for (const r of [8, 12]) { ctx.beginPath(); ctx.arc(0, 0, r, -Math.PI * 0.75, -Math.PI * 0.35); ctx.stroke(); ctx.beginPath(); ctx.arc(0, 0, r, Math.PI * 0.35, Math.PI * 0.75); ctx.stroke() }
      ctx.restore()
      break
    }
    case 'diff':
      break
    case 'confetti': {
      const t = (now - e.born) / 1000
      for (const b of e.bits) {
        const p = iso(e.at.x + b.vx * t * 0.5, e.at.y + b.vy * t * 0.5, Math.max(0, e.at.z + b.vz * t - 4.9 * t * t * 0.6))
        ctx.save()
        ctx.translate(p.x, p.y)
        ctx.rotate(b.spin * t)
        ctx.scale(1, 0.4 + 0.6 * Math.abs(Math.sin(b.spin * t * 1.7)))
        ctx.globalAlpha = 1 - k
        ctx.fillStyle = b.color
        ctx.fillRect(-2.5, -1.5, 5, 3)
        ctx.restore()
      }
      break
    }
  }
}
