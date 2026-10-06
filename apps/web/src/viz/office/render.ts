/** Draws the isometric office. Pure presentation over the Office model. */
import type { SessionState, WorldState } from '@oadt/protocol'
import { CATEGORY, harnessInfo } from '../../shared/theme'
import { activityOf, CABINET, COUCH, COUNTER, DOOR, ROOM_D, ROOM_W, SHELF, WINDOWS, type Char, type Effect, type Office, type Room } from './model'
import { clip } from '@oadt/protocol'
import { alpha, mix, shade } from '../../shared/color'
import { clamp } from '../../shared/dom'
import { box, easeInOut, easeOut, floorQuad, iso, poly, roundRect, shadow, wrapText, type Pt } from './iso'

const WALL_H = 2.9
const FONT = 'ui-rounded, "SF Pro Rounded", "Nunito", "Segoe UI", system-ui, sans-serif'

export interface Camera { x: number; y: number; zoom: number }

export interface RenderState {
  hovered?: string
  selected?: string
  labels: boolean
}

interface Sprite { depth: number; draw: () => void }

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
  // Sky-ish backdrop.
  const bg = ctx.createLinearGradient(0, 0, 0, h)
  bg.addColorStop(0, mix('#232a52', '#cfe6ff', day))
  bg.addColorStop(1, mix('#3a2d5c', '#fde8f3', day))
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, w, h)
  drawBackdropDots(ctx, w, h, now, day)

  ctx.setTransform(dpr * cam.zoom, 0, 0, dpr * cam.zoom, dpr * (w / 2 - cam.x * cam.zoom), dpr * (h / 2 - cam.y * cam.zoom))
  const rooms = [...office.rooms.values()].sort((a, b) => a.ox + a.oy - (b.ox + b.oy))
  const overlays: Array<() => void> = []
  for (const room of rooms) {
    const s = world.sessions[room.id]
    if (!s) continue
    const o = iso(room.ox, room.oy)
    ctx.save()
    ctx.translate(o.x, o.y)
    drawRoom(ctx, room, s, now, day, rs, overlays, o, cam)
    ctx.restore()
  }
  // Labels and bubbles on top of everything.
  for (const f of overlays) f()
}

// ─── Room ────────────────────────────────────────────────────────────────

function drawRoom(ctx: CanvasRenderingContext2D, room: Room, s: SessionState, now: number, day: number, rs: RenderState, overlays: Array<() => void>, origin: Pt, cam: Camera): void {
  const hc = harnessInfo(room.harness).color
  const live = s.status === 'working' || s.status === 'waiting'

  // Soft drop shadow under the diorama.
  ctx.fillStyle = 'rgba(30,20,60,0.18)'
  poly(ctx, [iso(-0.6, ROOM_D + 0.2), iso(ROOM_W + 0.2, ROOM_D + 0.2), iso(ROOM_W + 0.9, ROOM_D + 0.9), iso(0.1, ROOM_D + 0.9)].map((p) => ({ x: p.x, y: p.y + 10 })), 'rgba(30,20,60,0.14)')
  // Floor slab edge.
  poly(ctx, [iso(0, ROOM_D, 0), iso(ROOM_W, ROOM_D, 0), iso(ROOM_W, ROOM_D, -0.35), iso(0, ROOM_D, -0.35)], '#c99b6d')
  poly(ctx, [iso(ROOM_W, 0, 0), iso(ROOM_W, ROOM_D, 0), iso(ROOM_W, ROOM_D, -0.35), iso(ROOM_W, 0, -0.35)], '#b0855c')
  // Wooden floor planks.
  for (let x = 0; x < ROOM_W; x++) for (let y = 0; y < ROOM_D; y++) {
    floorQuad(ctx, x, y, 1, 1, (x + y) % 2 ? '#f1d8b4' : '#ecd0a8', 0, 'rgba(170,120,80,0.12)')
  }
  // Team rug under the desks, tinted by harness.
  floorQuad(ctx, 1.2, 2.55, 9.9, 5.3, mix('#fff4e6', hc, 0.28), 0.001)
  floorQuad(ctx, 1.45, 2.8, 9.4, 4.8, mix('#fff4e6', hc, 0.16), 0.002)
  // Rug under the couch.
  floorQuad(ctx, 7.9, 7.5, 3.6, 1.4, '#e8dcff', 0.002)

  drawWalls(ctx, room, s, now, day, hc)

  // Depth-sorted furniture, people and the cat.
  const sprites: Sprite[] = []
  const add = (depth: number, draw: () => void) => sprites.push({ depth, draw })

  room.desks.forEach((d, i) => {
    const occupant = d.occupant ? room.chars.get(d.occupant) : undefined
    const agent = occupant ? s.agents[occupant.id] : undefined
    const act = occupant && occupant.mode === 'seated' ? activityOf(s, agent, now) : undefined
    add(d.seat.x + d.seat.y - 0.3, () => drawChair(ctx, d.seat.x, d.seat.y, hc))
    add(d.x + d.w / 2 + d.y + d.d / 2, () => drawDesk(ctx, d.x, d.y, d.w, d.d, d.boss, act?.activity, now, hc, i))
  })
  add(COUCH.x + COUCH.w / 2 + COUCH.y + COUCH.d / 2 + 0.3, () => drawCouch(ctx))
  add(CABINET.x + CABINET.y + 0.8, () => drawCabinet(ctx))
  add(COUNTER.x + COUNTER.y + 1.4, () => drawCounter(ctx, now))
  add(SHELF.x + SHELF.y + 0.8, () => drawShelf(ctx))
  add(0.9, () => drawPlant(ctx, 0.55, 0.55, 1.1, now, 0))
  add(8.2, () => drawPlant(ctx, 8.2, 0.45, 0.8, now, 1))
  add(ROOM_W - 0.6 + ROOM_D - 0.6, () => drawPlant(ctx, ROOM_W - 0.6, ROOM_D - 0.6, 1.0, now, 2))
  add(room.cat.x + room.cat.y, () => drawCat(ctx, room, now))

  for (const c of room.chars.values()) {
    const agent = s.agents[c.id]
    const act = activityOf(s, agent, now)
    add(c.x + c.y + (c.mode === 'seated' ? -0.05 : 0.05), () => {
      const head = drawWorker(ctx, c, act.activity, now, rs.hovered === c.id || rs.selected === c.id)
      overlays.push(() => drawOverlay(ctx, origin, head, c, act, now, rs, cam))
    })
  }
  sprites.sort((a, b) => a.depth - b.depth)
  for (const sp of sprites) sp.draw()

  // Effects in this room.
  overlays.push(() => {
    ctx.save()
    ctx.translate(origin.x, origin.y)
    drawEffects(ctx, room, now)
    ctx.restore()
  })

  // Night: a cool wash over the room, warm desk-lamp pools on top.
  if (day < 1) {
    ctx.save()
    ctx.globalAlpha = (1 - day) * 0.32
    poly(ctx, [iso(-0.3, -0.3, WALL_H), iso(ROOM_W, -0.3, WALL_H), iso(ROOM_W, -0.3, 0), iso(ROOM_W, ROOM_D, 0), iso(0, ROOM_D, 0), iso(-0.3, ROOM_D, 0)], '#1d1a4a')
    ctx.globalCompositeOperation = 'lighter'
    ctx.globalAlpha = (1 - day) * 0.5
    for (const d of room.desks) {
      if (!d.occupant) continue
      const c = iso(d.x + d.w / 2, d.y + d.d / 2, 0.75)
      const g = ctx.createRadialGradient(c.x, c.y, 2, c.x, c.y, 70)
      g.addColorStop(0, 'rgba(255,200,120,0.55)')
      g.addColorStop(1, 'rgba(255,200,120,0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.ellipse(c.x, c.y, 70, 40, 0, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }

  // Live rooms get a gentle "lights on" glow at the doorway.
  if (live) {
    const p = iso(DOOR.x + DOOR.w / 2, 0.15, 0)
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 60)
    g.addColorStop(0, alpha(hc, 0.18))
    g.addColorStop(1, alpha(hc, 0))
    ctx.fillStyle = g
    ctx.fillRect(p.x - 60, p.y - 60, 120, 120)
    ctx.restore()
  }
}

function drawWalls(ctx: CanvasRenderingContext2D, room: Room, s: SessionState, now: number, day: number, hc: string): void {
  const wall = '#fbf1e4'
  const wallSide = '#f3e2cf'
  const trim = '#e7c9a8'
  // Left wall (x = 0), seen from inside.
  poly(ctx, [iso(0, 0, 0), iso(0, ROOM_D, 0), iso(0, ROOM_D, WALL_H), iso(0, 0, WALL_H)], wallSide)
  poly(ctx, [iso(0, 0, 0), iso(0, ROOM_D, 0), iso(0, ROOM_D, 0.55), iso(0, 0, 0.55)], mix(wallSide, hc, 0.25))
  // Back wall (y = 0).
  poly(ctx, [iso(0, 0, 0), iso(ROOM_W, 0, 0), iso(ROOM_W, 0, WALL_H), iso(0, 0, WALL_H)], wall)
  poly(ctx, [iso(0, 0, 0), iso(ROOM_W, 0, 0), iso(ROOM_W, 0, 0.55), iso(0, 0, 0.55)], mix(wall, hc, 0.25))
  // Wall caps (thickness).
  poly(ctx, [iso(-0.3, -0.3, WALL_H), iso(ROOM_W, -0.3, WALL_H), iso(ROOM_W, 0, WALL_H), iso(0, 0, WALL_H)], trim)
  poly(ctx, [iso(-0.3, -0.3, WALL_H), iso(0, 0, WALL_H), iso(0, ROOM_D, WALL_H), iso(-0.3, ROOM_D, WALL_H)], trim)
  poly(ctx, [iso(-0.3, ROOM_D, 0), iso(0, ROOM_D, 0), iso(0, ROOM_D, WALL_H), iso(-0.3, ROOM_D, WALL_H)], shade(trim, -0.1))
  poly(ctx, [iso(ROOM_W, -0.3, 0), iso(ROOM_W, 0, 0), iso(ROOM_W, 0, WALL_H), iso(ROOM_W, -0.3, WALL_H)], shade(trim, -0.2))

  // Windows with sky.
  for (const win of WINDOWS) drawWindow(ctx, win.x, win.w, now, day)

  // Door + doorway.
  const dx = DOOR.x, dw = DOOR.w, dh = DOOR.h
  const hall = ctx.createLinearGradient(iso(dx, 0, 0).x, iso(dx, 0, dh).y, iso(dx, 0, 0).x, iso(dx, 0, 0).y)
  hall.addColorStop(0, '#fff6d8')
  hall.addColorStop(1, '#ffd9a0')
  poly(ctx, [iso(dx, 0, 0), iso(dx + dw, 0, 0), iso(dx + dw, 0, dh), iso(dx, 0, dh)], undefined)
  ctx.fillStyle = hall
  ctx.fill()
  const ang = room.doorOpen * 1.35
  const ex = dx + Math.cos(ang) * dw, ey = Math.sin(ang) * dw
  poly(ctx, [iso(dx, 0, 0), iso(ex, ey, 0), iso(ex, ey, dh), iso(dx, 0, dh)], '#c98f5f', 'rgba(90,50,30,0.35)')
  const knob = iso(dx + Math.cos(ang) * dw * 0.85, Math.sin(ang) * dw * 0.85, dh * 0.48)
  ctx.fillStyle = '#ffd166'
  ctx.beginPath()
  ctx.arc(knob.x, knob.y, 2.2, 0, Math.PI * 2)
  ctx.fill()
  // Frame.
  ctx.strokeStyle = '#a8724a'
  ctx.lineWidth = 2
  ctx.beginPath()
  const f1 = iso(dx, 0, 0), f2 = iso(dx, 0, dh), f3 = iso(dx + dw, 0, dh), f4 = iso(dx + dw, 0, 0)
  ctx.moveTo(f1.x, f1.y); ctx.lineTo(f2.x, f2.y); ctx.lineTo(f3.x, f3.y); ctx.lineTo(f4.x, f4.y)
  ctx.stroke()

  // Name plaque above the door.
  onWallX(ctx, dx - 1.6, 0, dh + 0.62, () => {
    const label = clip(room.title, 26)
    ctx.font = `700 11px ${FONT}`
    const tw = Math.max(ctx.measureText(label).width + 26, 70)
    roundRect(ctx, 0, -16, tw, 20, 6)
    ctx.fillStyle = hc
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, 18, -6)
    ctx.beginPath()
    ctx.arc(9, -6, 3, 0, Math.PI * 2)
    ctx.fillStyle = s.status === 'working' ? '#bfffd9' : s.status === 'waiting' ? '#ffe2a8' : '#ffffff88'
    ctx.fill()
  })

  // Whiteboard on the left wall: the agent's plan.
  onWallY(ctx, 0, 3.7, 0.95, () => {
    const W = 150, H = 66
    roundRect(ctx, 0, -H, W, H, 4)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.strokeStyle = '#b9c2d4'
    ctx.lineWidth = 2.5
    ctx.stroke()
    ctx.fillStyle = '#8a95ab'
    ctx.fillRect(18, 0, W - 36, 3)
    const plan = room.plan
    ctx.font = `700 9px ${FONT}`
    ctx.textBaseline = 'top'
    if (plan) {
      ctx.fillStyle = '#5a6b8c'
      ctx.fillText(`PLAN ${plan.done}/${plan.total}`, 8, -H + 6)
      const n = Math.min(plan.total, 8)
      for (let i = 0; i < n; i++) {
        const bx = 8 + (i % 4) * 34, by = -H + 22 + Math.floor(i / 4) * 16
        ctx.strokeStyle = '#7d8aa3'
        ctx.lineWidth = 1.2
        ctx.strokeRect(bx, by, 9, 9)
        if (i < plan.done) {
          ctx.strokeStyle = '#2fbf71'
          ctx.lineWidth = 2
          ctx.beginPath(); ctx.moveTo(bx + 1, by + 5); ctx.lineTo(bx + 4, by + 8); ctx.lineTo(bx + 10, by - 1); ctx.stroke()
        }
        ctx.fillStyle = '#c3cad8'
        ctx.fillRect(bx + 12, by + 3, 16, 2)
      }
      if (plan.label) {
        ctx.fillStyle = '#ff7a59'
        ctx.font = `600 8px ${FONT}`
        ctx.fillText(clip(plan.label, 30), 8, -12)
      }
    } else {
      // Doodles.
      ctx.strokeStyle = '#7fa8ff'
      ctx.lineWidth = 1.6
      ctx.beginPath()
      ctx.moveTo(12, -20); ctx.bezierCurveTo(30, -50, 50, -10, 70, -38); ctx.stroke()
      ctx.strokeStyle = '#ff8fab'
      ctx.strokeRect(86, -50, 26, 20)
      ctx.beginPath(); ctx.moveTo(112, -40); ctx.lineTo(134, -40); ctx.lineTo(128, -46); ctx.stroke()
      ctx.fillStyle = '#5a6b8c'
      ctx.fillText('ideas ✦', 10, -H + 6)
    }
  })

  // Clock with real time.
  onWallY(ctx, 0, 5.4, 2.3, () => {
    const d = new Date()
    ctx.beginPath(); ctx.arc(0, 0, 13, 0, Math.PI * 2)
    ctx.fillStyle = '#ffffff'; ctx.fill()
    ctx.lineWidth = 3; ctx.strokeStyle = hc; ctx.stroke()
    const hr = ((d.getHours() % 12) + d.getMinutes() / 60) / 12 * Math.PI * 2
    const mn = (d.getMinutes() + d.getSeconds() / 60) / 60 * Math.PI * 2
    ctx.strokeStyle = '#3d3a55'
    ctx.lineCap = 'round'
    ctx.lineWidth = 2.2; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.sin(hr) * 6, -Math.cos(hr) * 6); ctx.stroke()
    ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.sin(mn) * 9.5, -Math.cos(mn) * 9.5); ctx.stroke()
  })

  // Poster.
  onWallY(ctx, 0, 8.2, 1.15, () => {
    roundRect(ctx, 0, -46, 40, 46, 3)
    ctx.fillStyle = mix('#ffffff', hc, 0.35)
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.font = `800 9px ${FONT}`
    ctx.textBaseline = 'top'
    ctx.fillText('SHIP', 9, -38)
    ctx.fillText(' IT ✦', 6, -26)
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

/** Draw in a plane aligned with the left wall (along y); +x goes toward smaller y (reads left to right). */
function onWallY(ctx: CanvasRenderingContext2D, x: number, y: number, z: number, draw: () => void): void {
  const p = iso(x, y, z)
  ctx.save()
  ctx.transform(1, -0.5, 0, 1, p.x, p.y)
  draw()
  ctx.restore()
}

function drawWindow(ctx: CanvasRenderingContext2D, x: number, w: number, now: number, day: number): void {
  const z0 = 1.0, h = 1.35
  const top = iso(x, 0, z0 + h), bottom = iso(x, 0, z0)
  const sky = ctx.createLinearGradient(top.x, top.y, bottom.x, bottom.y)
  sky.addColorStop(0, mix('#1b2350', '#7ec8ff', day))
  sky.addColorStop(1, mix('#4a3a7a', '#d6f0ff', day))
  poly(ctx, [iso(x, 0, z0), iso(x + w, 0, z0), iso(x + w, 0, z0 + h), iso(x, 0, z0 + h)])
  ctx.fillStyle = sky
  ctx.fill()
  ctx.save()
  ctx.clip()
  if (day > 0.4) {
    // A drifting cloud.
    const t = ((now / 40000) % 1) * (w + 1) - 0.5
    const c = iso(x + t, 0, z0 + h * 0.65)
    ctx.fillStyle = 'rgba(255,255,255,0.9)'
    for (const [dx, dy, r] of [[0, 0, 7], [8, -3, 9], [17, 1, 6]] as const) {
      ctx.beginPath(); ctx.arc(c.x + dx, c.y + dy + dx * 0.5, r, 0, Math.PI * 2); ctx.fill()
    }
  } else {
    ctx.fillStyle = '#fff6c8'
    const m = iso(x + w * 0.7, 0, z0 + h * 0.72)
    ctx.beginPath(); ctx.arc(m.x, m.y, 7, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = mix('#1b2350', '#7ec8ff', day)
    ctx.beginPath(); ctx.arc(m.x + 3, m.y - 2, 6, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = '#ffffff'
    for (let i = 0; i < 5; i++) {
      const s = iso(x + ((i * 0.37) % 1) * w, 0, z0 + 0.2 + ((i * 0.53) % 1) * h * 0.8)
      ctx.globalAlpha = 0.5 + 0.5 * Math.sin(now / 500 + i)
      ctx.fillRect(s.x, s.y, 1.5, 1.5)
    }
    ctx.globalAlpha = 1
  }
  ctx.restore()
  // Frame + mullions + sill.
  poly(ctx, [iso(x, 0, z0), iso(x + w, 0, z0), iso(x + w, 0, z0 + h), iso(x, 0, z0 + h)], undefined, '#ffffff', 3)
  const m1 = iso(x + w / 2, 0, z0), m2 = iso(x + w / 2, 0, z0 + h)
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 2
  ctx.beginPath(); ctx.moveTo(m1.x, m1.y); ctx.lineTo(m2.x, m2.y); ctx.stroke()
  box(ctx, x - 0.08, 0, z0 - 0.08, w + 0.16, 0.18, 0.08, '#ffffff', { outline: false })
  // Curtains.
  poly(ctx, [iso(x - 0.05, 0.02, z0 + h + 0.1), iso(x + 0.3, 0.02, z0 + h + 0.1), iso(x + 0.15, 0.02, z0 - 0.1), iso(x - 0.05, 0.02, z0 - 0.1)], '#ffb3c7')
  poly(ctx, [iso(x + w - 0.3, 0.02, z0 + h + 0.1), iso(x + w + 0.05, 0.02, z0 + h + 0.1), iso(x + w + 0.05, 0.02, z0 - 0.1), iso(x + w - 0.15, 0.02, z0 - 0.1)], '#ffb3c7')
}

// ─── Furniture ───────────────────────────────────────────────────────────

function drawDesk(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, d: number, boss: boolean, activity: string | undefined, now: number, hc: string, idx: number): void {
  const wood = boss ? '#d9a877' : '#e8c49a'
  shadow(ctx, x + w / 2, y + d / 2 + 0.1, w * 0.62, 0.16)
  // Legs + modesty panel.
  box(ctx, x + 0.05, y + d - 0.12, 0.22, w - 0.1, 0.06, 0.4, shade(wood, -0.08))
  box(ctx, x + 0.04, y + d - 0.14, 0, 0.08, 0.08, 0.62, shade(wood, -0.2))
  box(ctx, x + w - 0.12, y + d - 0.14, 0, 0.08, 0.08, 0.62, shade(wood, -0.2))
  box(ctx, x + 0.04, y + 0.06, 0, 0.08, 0.08, 0.62, shade(wood, -0.2))
  box(ctx, x + w - 0.12, y + 0.06, 0, 0.08, 0.08, 0.62, shade(wood, -0.2))
  box(ctx, x, y, 0.62, w, d, 0.09, wood)
  const active = activity && activity !== 'idle' && activity !== 'done' && activity !== 'sleeping'
  const screenColor = activity && CATEGORY[activity as keyof typeof CATEGORY] ? CATEGORY[activity as keyof typeof CATEGORY].color : activity === 'thinking' ? '#c7a6ff' : activity === 'waiting' ? '#ffb547' : '#9fd8ff'

  if (boss) {
    // Two monitors, a mug and a tiny plant.
    for (const mx of [x + 0.35, x + 1.3]) {
      box(ctx, mx + 0.32, y + 0.25, 0.71, 0.12, 0.12, 0.2, '#5b5f73')
      box(ctx, mx, y + 0.18, 0.88, 0.8, 0.07, 0.48, '#3a3f55')
      glow(ctx, mx + 0.4, y + 0.15, 1.1, active ? screenColor : '#7fc4ff', active ? 0.55 + 0.15 * Math.sin(now / 180) : 0.18)
    }
    box(ctx, x + 2.15, y + 0.6, 0.71, 0.16, 0.16, 0.18, '#ffffff')
    box(ctx, x + 0.08, y + 0.6, 0.71, 0.18, 0.18, 0.14, '#e07a5f')
    const p = iso(x + 0.17, y + 0.69, 0.98)
    ctx.fillStyle = '#5cc98a'
    ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.fill()
  } else {
    // Laptop: base plus a lid facing the worker.
    const lx = x + w / 2 - 0.3
    box(ctx, lx, y + 0.22, 0.71, 0.6, 0.42, 0.03, '#c7ccd8')
    box(ctx, lx, y + 0.18, 0.74, 0.6, 0.05, 0.38, '#d9dde7')
    const logo = iso(lx + 0.3, y + 0.23, 0.94)
    ctx.fillStyle = active ? screenColor : alpha(hc, 0.6)
    ctx.beginPath(); ctx.arc(logo.x, logo.y, 2.4, 0, Math.PI * 2); ctx.fill()
    glow(ctx, lx + 0.3, y + 0.12, 0.95, active ? screenColor : '#9fd8ff', active ? 0.5 + 0.15 * Math.sin(now / 160 + idx) : 0.12)
    // A paper stack for flavour.
    box(ctx, x + 0.12, y + 0.52, 0.71, 0.32, 0.26, 0.05 + (idx % 3) * 0.03, '#ffffff')
  }
}

/** Screen light spilling toward the worker's face. */
function glow(ctx: CanvasRenderingContext2D, x: number, y: number, z: number, color: string, a: number): void {
  if (a <= 0.01) return
  const p = iso(x, y, z)
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  const g = ctx.createRadialGradient(p.x, p.y, 1, p.x, p.y, 26)
  g.addColorStop(0, alpha(color, a))
  g.addColorStop(1, alpha(color, 0))
  ctx.fillStyle = g
  ctx.fillRect(p.x - 26, p.y - 26, 52, 52)
  ctx.restore()
}

function drawChair(ctx: CanvasRenderingContext2D, x: number, y: number, hc: string): void {
  shadow(ctx, x, y, 0.42, 0.14)
  box(ctx, x - 0.04, y - 0.04, 0.05, 0.08, 0.08, 0.3, '#6d7187')
  box(ctx, x - 0.24, y - 0.24, 0.35, 0.48, 0.48, 0.08, shade(hc, -0.25))
  box(ctx, x - 0.24, y - 0.3, 0.42, 0.48, 0.08, 0.55, shade(hc, -0.35))
}

function drawCouch(ctx: CanvasRenderingContext2D): void {
  const { x, y, w, d } = COUCH
  const c = '#9fb0ff'
  shadow(ctx, x + w / 2, y + d / 2, w * 0.6, 0.18)
  box(ctx, x, y, 0, w, d, 0.32, shade(c, -0.1))
  box(ctx, x, y + d - 0.22, 0.32, w, 0.22, 0.42, c)
  box(ctx, x - 0.18, y, 0, 0.18, d, 0.55, shade(c, -0.05))
  box(ctx, x + w, y, 0, 0.18, d, 0.55, shade(c, -0.05))
  for (let i = 0; i < 3; i++) box(ctx, x + 0.08 + i * (w / 3), y + 0.06, 0.32, w / 3 - 0.12, d - 0.3, 0.08, shade(c, 0.12))
  box(ctx, x + 0.15, y + d - 0.38, 0.38, 0.4, 0.14, 0.32, '#ffd166')
}

function drawCabinet(ctx: CanvasRenderingContext2D): void {
  const { x, y, w, d, h } = CABINET
  box(ctx, x, y, 0, w, d, h, '#b9c4dc')
  for (let i = 0; i < 3; i++) {
    const a = iso(x + w, y + 0.12, 0.2 + i * 0.36), b = iso(x + w, y + d - 0.12, 0.2 + i * 0.36)
    ctx.strokeStyle = 'rgba(70,80,110,0.35)'
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
    const k = iso(x + w, y + d / 2, 0.36 + i * 0.36)
    ctx.fillStyle = '#7d89a8'
    ctx.fillRect(k.x - 1, k.y - 4, 2, 4)
  }
}

function drawCounter(ctx: CanvasRenderingContext2D, now: number): void {
  const { x, y, w, d, h } = COUNTER
  box(ctx, x, y, 0, w, d, h, '#f7f0ea', { top: '#d8cfc7' })
  // Coffee machine.
  box(ctx, x + 0.1, y + 0.25, h, 0.55, 0.5, 0.62, '#4a4e63')
  box(ctx, x + 0.62, y + 0.33, h + 0.16, 0.04, 0.34, 0.12, '#ff8a4c')
  // Mugs.
  box(ctx, x + 0.3, y + 1.15, h, 0.16, 0.16, 0.15, '#ff9fb8')
  box(ctx, x + 0.32, y + 1.55, h, 0.16, 0.16, 0.15, '#9fd8ff')
  // Steam.
  const p = iso(x + 0.4, y + 0.5, h + 0.72)
  ctx.strokeStyle = 'rgba(255,255,255,0.75)'
  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  for (let i = 0; i < 2; i++) {
    const t = (now / 1400 + i * 0.5) % 1
    ctx.globalAlpha = 1 - t
    ctx.beginPath()
    for (let k = 0; k <= 8; k++) {
      const yy = p.y - t * 26 - k * 2
      const xx = p.x + i * 6 + Math.sin(k * 0.8 + now / 300) * 2.5
      if (k === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy)
    }
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

function drawShelf(ctx: CanvasRenderingContext2D): void {
  const { x, y, w, d, h } = SHELF
  box(ctx, x, y, 0, w, d, h, '#d39f6e')
  const colors = ['#ff8a4c', '#5aa9ff', '#ffd166', '#3ee0c5', '#9d8cff', '#ff7aa8', '#7bd389']
  for (let row = 0; row < 3; row++) {
    let bx = x + 0.08
    let i = row * 3
    while (bx < x + w - 0.15) {
      const bw = 0.12 + ((i * 37) % 5) * 0.025
      const bh = 0.36 + ((i * 13) % 4) * 0.04
      box(ctx, bx, y + d - 0.02, 0.12 + row * 0.6, bw, 0.02, bh, colors[i % colors.length]!, { outline: false })
      bx += bw + 0.02
      i++
    }
  }
}

function drawPlant(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, now: number, seed: number): void {
  shadow(ctx, x, y, 0.35 * size, 0.18)
  box(ctx, x - 0.2 * size, y - 0.2 * size, 0, 0.4 * size, 0.4 * size, 0.35 * size, '#e8846b')
  const base = iso(x, y, 0.35 * size)
  const sway = Math.sin(now / 1200 + seed) * 1.5
  const leaves: Array<[number, number, number, string]> = [
    [0, -18, 11, '#5cc98a'], [-9, -10, 9, '#4fb97d'], [9, -11, 9, '#6ad89a'], [-4, -26, 8, '#7ee0a8'], [6, -24, 8, '#4fb97d'],
  ]
  for (const [dx, dy, r, c] of leaves) {
    ctx.fillStyle = c
    ctx.beginPath()
    ctx.ellipse(base.x + dx * size + sway * (-dy / 26), base.y + dy * size, r * size, r * size * 0.85, 0, 0, Math.PI * 2)
    ctx.fill()
  }
}

function drawCat(ctx: CanvasRenderingContext2D, room: Room, now: number): void {
  const cat = room.cat
  const p = iso(cat.x, cat.y, 0)
  const napping = now < cat.napUntil
  const walking = cat.path.length > 0
  shadow(ctx, cat.x, cat.y, 0.28, 0.2)
  ctx.save()
  ctx.translate(p.x, p.y)
  ctx.scale(cat.facing, 1)
  const fur = '#f2a65a'
  ctx.fillStyle = fur
  if (napping) {
    ctx.beginPath(); ctx.ellipse(0, -5, 10, 6, 0, 0, Math.PI * 2); ctx.fill()
    ctx.beginPath(); ctx.arc(7, -6, 4.5, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.font = `700 8px ${FONT}`
    ctx.fillText('z', 10, -16 - ((now / 400) % 6))
  } else {
    const bob = walking ? Math.sin(cat.phase * 12) * 1.2 : 0
    // Legs.
    ctx.fillStyle = shade(fur, -0.15)
    for (const lx of [-6, -2, 3, 7]) ctx.fillRect(lx, -4 + (walking ? Math.sin(cat.phase * 12 + lx) : 0), 2, 4)
    ctx.fillStyle = fur
    ctx.beginPath(); ctx.ellipse(0, -8 + bob, 9, 5.5, 0, 0, Math.PI * 2); ctx.fill()
    // Tail.
    ctx.strokeStyle = fur; ctx.lineWidth = 2.5; ctx.lineCap = 'round'
    ctx.beginPath(); ctx.moveTo(-8, -9); ctx.quadraticCurveTo(-15, -14 + Math.sin(now / 300) * 3, -12, -20); ctx.stroke()
    // Head + ears.
    ctx.beginPath(); ctx.arc(9, -13 + bob, 5, 0, Math.PI * 2); ctx.fill()
    ctx.beginPath(); ctx.moveTo(5.5, -16 + bob); ctx.lineTo(6.5, -21 + bob); ctx.lineTo(9, -17 + bob); ctx.fill()
    ctx.beginPath(); ctx.moveTo(10, -17 + bob); ctx.lineTo(12.5, -21 + bob); ctx.lineTo(13.5, -15 + bob); ctx.fill()
    ctx.fillStyle = '#3a2a2a'
    ctx.fillRect(10, -14 + bob, 1.4, 1.4)
    ctx.fillRect(12.4, -14 + bob, 1.4, 1.4)
  }
  ctx.restore()
}

// ─── Workers ─────────────────────────────────────────────────────────────

/** Draws a worker; returns the head position (screen space, before camera). */
function drawWorker(ctx: CanvasRenderingContext2D, c: Char, activity: string, now: number, focus: boolean): Pt {
  const seated = c.mode === 'seated'
  const lounging = c.mode === 'lounging'
  const walking = c.mode === 'walking'
  const jump = now < c.jumpUntil ? Math.abs(Math.sin(((c.jumpUntil - now) / 900) * Math.PI * 2)) * 0.35 : 0
  const z = (seated ? 0.43 : lounging ? 0.36 : 0) + jump
  const foot = iso(c.x, c.y, z)
  const pal = c.palette
  const t = now / 1000
  ctx.save()
  ctx.globalAlpha = c.alpha

  if (!seated && !lounging) shadow(ctx, c.x, c.y, 0.32, 0.22)
  if (activity === 'waiting') {
    const k = (now % 1200) / 1200
    const f = iso(c.x, c.y, 0)
    ctx.strokeStyle = `rgba(255,181,71,${0.9 - k * 0.8})`
    ctx.lineWidth = 2
    ctx.beginPath(); ctx.ellipse(f.x, f.y, 14 + k * 14, 7 + k * 7, 0, 0, Math.PI * 2); ctx.stroke()
  }

  ctx.translate(foot.x, foot.y)
  ctx.scale(c.facing * CHAR_SCALE, CHAR_SCALE)
  const typing = seated && activity !== 'idle' && activity !== 'thinking' && activity !== 'waiting' && activity !== 'sleeping'
  const bob = walking ? Math.abs(Math.sin(t * 9)) * 2 : typing ? Math.sin(t * 14) * 0.6 : Math.sin(t * 2 + c.phase) * 0.5

  // Legs.
  const pants = '#4b4f6b'
  if (!seated) {
    const swing = walking ? Math.sin(t * 9) * 4 : 0
    ctx.fillStyle = pants
    roundRect(ctx, -6 + swing * 0.3, -10, 5, 10, 2); ctx.fill()
    roundRect(ctx, 1 - swing * 0.3, -10, 5, 10, 2); ctx.fill()
    ctx.fillStyle = '#2d2f40'
    ctx.beginPath(); ctx.ellipse(-3.5 + swing * 0.3, 0, 3.5, 1.8, 0, 0, Math.PI * 2); ctx.fill()
    ctx.beginPath(); ctx.ellipse(3.5 - swing * 0.3, 0, 3.5, 1.8, 0, 0, Math.PI * 2); ctx.fill()
  } else if (lounging) {
    ctx.fillStyle = pants
    roundRect(ctx, -6, -6, 12, 6, 3); ctx.fill()
  }

  // Body.
  const bodyY = -10 - bob
  ctx.fillStyle = pal.shirt
  roundRect(ctx, -9, bodyY - 17, 18, 19, 8)
  ctx.fill()
  ctx.fillStyle = shade(pal.shirt, -0.12)
  roundRect(ctx, -9, bodyY - 6, 18, 8, 6)
  ctx.fill()
  // Collar / badge.
  ctx.fillStyle = pal.accent
  ctx.beginPath(); ctx.moveTo(-3, bodyY - 17); ctx.lineTo(0, bodyY - 12); ctx.lineTo(3, bodyY - 17); ctx.fill()

  // Arms.
  const armY = bodyY - 9
  const typingL = typing ? Math.sin(t * 22) * 1.6 : 0
  const typingR = typing ? Math.cos(t * 22) * 1.6 : 0
  ctx.fillStyle = shade(pal.shirt, -0.06)
  if (activity === 'waiting') {
    // Hand up!
    roundRect(ctx, 6, armY - 16 + Math.sin(t * 8) * 1.5, 4.5, 13, 2.5); ctx.fill()
    ctx.fillStyle = pal.skin
    ctx.beginPath(); ctx.arc(8.2, armY - 17 + Math.sin(t * 8) * 1.5, 2.8, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = shade(pal.shirt, -0.06)
    roundRect(ctx, -11, armY, 4.5, 9, 2.5); ctx.fill()
  } else {
    roundRect(ctx, -11, armY + typingL, 4.5, 9, 2.5); ctx.fill()
    roundRect(ctx, 6.5, armY + typingR, 4.5, 9, 2.5); ctx.fill()
    ctx.fillStyle = pal.skin
    ctx.beginPath(); ctx.arc(-8.8, armY + 9 + typingL, 2.4, 0, Math.PI * 2); ctx.fill()
    ctx.beginPath(); ctx.arc(8.8, armY + 9 + typingR, 2.4, 0, Math.PI * 2); ctx.fill()
  }
  // Mug when lounging or idle at desk.
  if (lounging || (seated && activity === 'idle')) {
    ctx.fillStyle = '#ffffff'
    roundRect(ctx, 6, armY + 4, 6, 7, 1.5); ctx.fill()
    ctx.fillStyle = '#ff8fab'
    ctx.fillRect(6, armY + 6, 6, 2)
  }

  // Head.
  const headY = bodyY - 26
  ctx.fillStyle = pal.skin
  ctx.beginPath(); ctx.arc(0, headY, 10.5, 0, Math.PI * 2); ctx.fill()
  drawHair(ctx, pal.hair, pal.hairStyle, headY)

  // Face.
  const sleeping = activity === 'sleeping'
  const blink = now >= c.blinkAt && now < c.blinkAt + 140
  ctx.fillStyle = '#2d2433'
  ctx.strokeStyle = '#2d2433'
  ctx.lineWidth = 1.3
  const ex = 2.5
  if (sleeping || blink) {
    ctx.beginPath(); ctx.moveTo(-3.5 + ex - 1.5, headY + 1); ctx.lineTo(-3.5 + ex + 1.5, headY + 1); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(3.5 + ex - 1.5, headY + 1); ctx.lineTo(3.5 + ex + 1.5, headY + 1); ctx.stroke()
  } else {
    ctx.beginPath(); ctx.ellipse(-3.5 + ex, headY + 0.5, 1.5, 2, 0, 0, Math.PI * 2); ctx.fill()
    ctx.beginPath(); ctx.ellipse(3.5 + ex, headY + 0.5, 1.5, 2, 0, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(-3.8 + ex, headY - 0.6, 0.8, 0.8)
    ctx.fillRect(3.2 + ex, headY - 0.6, 0.8, 0.8)
  }
  ctx.fillStyle = 'rgba(255,120,140,0.45)'
  ctx.beginPath(); ctx.ellipse(-5.5 + ex, headY + 4, 2.2, 1.3, 0, 0, Math.PI * 2); ctx.fill()
  ctx.beginPath(); ctx.ellipse(6 + ex, headY + 4, 2.2, 1.3, 0, 0, Math.PI * 2); ctx.fill()
  ctx.strokeStyle = '#2d2433'
  ctx.lineWidth = 1.2
  ctx.beginPath()
  if (activity === 'waiting') { ctx.arc(ex, headY + 5, 1.6, 0, Math.PI * 2) }
  else if (activity === 'thinking') { ctx.moveTo(ex - 1.5, headY + 5); ctx.lineTo(ex + 1.5, headY + 5) }
  else { ctx.arc(ex, headY + 3.5, 2.2, 0.15 * Math.PI, 0.85 * Math.PI) }
  ctx.stroke()

  // The lead wears a headset in the team colour.
  if (c.isRoot) {
    ctx.strokeStyle = '#3d3a55'
    ctx.lineWidth = 2.2
    ctx.beginPath(); ctx.arc(0, headY - 1, 11.5, Math.PI * 1.08, Math.PI * 1.92); ctx.stroke()
    ctx.fillStyle = '#3d3a55'
    roundRect(ctx, -12.5, headY - 3, 4, 7, 2); ctx.fill()
    ctx.strokeStyle = '#3d3a55'
    ctx.lineWidth = 1.4
    ctx.beginPath(); ctx.moveTo(-11, headY + 3); ctx.quadraticCurveTo(-9, headY + 9, -3, headY + 7.5); ctx.stroke()
  }
  ctx.restore()

  if (focus) {
    ctx.save()
    const f = iso(c.x, c.y, 0)
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    ctx.setLineDash([4, 3])
    ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.ellipse(f.x, f.y, 18, 9, 0, 0, Math.PI * 2); ctx.stroke()
    ctx.restore()
  }
  return { x: foot.x, y: foot.y + (-36 - bob) * CHAR_SCALE }
}

const CHAR_SCALE = 1.35

function drawHair(ctx: CanvasRenderingContext2D, color: string, style: number, headY: number): void {
  ctx.fillStyle = color
  switch (style) {
    case 0: // bowl
      ctx.beginPath(); ctx.arc(0, headY - 1, 11, Math.PI * 1.02, Math.PI * 1.98); ctx.lineTo(10, headY - 2); ctx.closePath(); ctx.fill()
      ctx.fillRect(-11, headY - 3, 5, 6)
      break
    case 1: // spiky
      ctx.beginPath()
      ctx.moveTo(-11, headY - 2)
      for (let i = 0; i <= 6; i++) ctx.lineTo(-11 + i * 3.7, headY - (i % 2 ? 15 : 10))
      ctx.lineTo(11, headY - 2)
      ctx.closePath(); ctx.fill()
      break
    case 2: // bun
      ctx.beginPath(); ctx.arc(0, headY - 2, 11, Math.PI, 0); ctx.fill()
      ctx.beginPath(); ctx.arc(-2, headY - 13, 5, 0, Math.PI * 2); ctx.fill()
      break
    default: // long
      ctx.beginPath(); ctx.arc(0, headY - 2, 11.2, Math.PI, 0); ctx.fill()
      ctx.fillRect(-11.2, headY - 2, 4.5, 13)
      ctx.fillRect(6.7, headY - 2, 4.5, 6)
  }
}

// ─── Overlays (labels, bubbles, chips) ───────────────────────────────────

function drawOverlay(ctx: CanvasRenderingContext2D, origin: Pt, head: Pt, c: Char, act: ReturnType<typeof activityOf>, now: number, rs: RenderState, cam: Camera): void {
  ctx.save()
  ctx.translate(origin.x, origin.y)
  ctx.globalAlpha = c.alpha
  const x = head.x
  let y = head.y - 20
  const focus = rs.hovered === c.id || rs.selected === c.id

  // Name tag.
  if ((rs.labels && c.mode !== 'lounging') || focus) {
    ctx.font = `700 9.5px ${FONT}`
    const label = c.isRoot ? '★ lead' : clip(c.name, 18)
    const w = ctx.measureText(label).width + 12
    const ty = head.y + 36 * 1.35 + 8 + (c.mode === 'seated' ? -12 : 0)
    roundRect(ctx, x - w / 2, ty, w, 14, 7)
    ctx.fillStyle = focus ? '#2d2a4a' : 'rgba(45,42,74,0.72)'
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, x, ty + 7.5)
    ctx.textAlign = 'left'
  }

  if (act.activity === 'sleeping' && !c.bubble) {
    ctx.fillStyle = '#7d86ff'
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
    ctx.fillStyle = '#ffb547'
    ctx.beginPath(); ctx.arc(x, y - 6 - b, 9, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = '#3a2600'
    ctx.font = `900 12px ${FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('!', x, y - 5.5 - b)
    ctx.textAlign = 'left'
    if (act.tool && (focus || cam.zoom > 1.1)) chip(ctx, x, y - 24 - b, `waiting · ${act.tool.title}`, '#ffb547')
  } else if (act.activity === 'thinking') {
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
  const w = ctx.measureText(label).width + 14
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
  const bx = x - w / 2, by = y - h - 10
  const border = tone === 'user' ? '#ff8fab' : tone === 'task' ? '#ffd166' : '#8fb8ff'
  roundRect(ctx, bx, by, w, h, 10)
  ctx.fillStyle = tone === 'user' ? '#fff3f6' : '#ffffff'
  ctx.fill()
  ctx.strokeStyle = border
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(x - 5, by + h); ctx.lineTo(x, by + h + 8); ctx.lineTo(x + 5, by + h)
  ctx.fillStyle = tone === 'user' ? '#fff3f6' : '#ffffff'
  ctx.fill()
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

function drawEffects(ctx: CanvasRenderingContext2D, room: Room, now: number): void {
  for (const e of (room as Room & { _effects?: Effect[] })._effects ?? []) drawEffect(ctx, e, now)
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
      const x = e.from.x + (e.to.x - e.from.x) * t
      const y = e.from.y + (e.to.y - e.from.y) * t
      const z = e.from.z + (e.to.z - e.from.z) * t + Math.sin(t * Math.PI) * 1.4
      const p = iso(x, y, z)
      const next = iso(e.from.x + (e.to.x - e.from.x) * Math.min(1, t + 0.02), e.from.y + (e.to.y - e.from.y) * Math.min(1, t + 0.02), z)
      const ang = Math.atan2(next.y - p.y, next.x - p.x)
      ctx.save()
      ctx.translate(p.x, p.y)
      ctx.rotate(ang)
      ctx.fillStyle = '#ffffff'
      ctx.strokeStyle = '#ff8fab'
      ctx.lineWidth = 1.2
      ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(-8, -6); ctx.lineTo(-4, 0); ctx.lineTo(-8, 6); ctx.closePath()
      ctx.fill(); ctx.stroke()
      ctx.restore()
      // Dotted trail.
      ctx.fillStyle = 'rgba(255,143,171,0.6)'
      for (let i = 1; i < 6; i++) {
        const tt = Math.max(0, t - i * 0.035)
        const q = iso(e.from.x + (e.to.x - e.from.x) * tt, e.from.y + (e.to.y - e.from.y) * tt, e.from.z + (e.to.z - e.from.z) * tt + Math.sin(tt * Math.PI) * 1.4)
        ctx.beginPath(); ctx.arc(q.x, q.y, 1.4, 0, Math.PI * 2); ctx.fill()
      }
      break
    }
    case 'paper': {
      const t = easeInOut(k)
      const p = iso(e.from.x + (e.to.x - e.from.x) * t, e.from.y + (e.to.y - e.from.y) * t, e.from.z + (e.to.z - e.from.z) * t + Math.sin(t * Math.PI) * 1.1)
      ctx.save()
      ctx.translate(p.x, p.y)
      ctx.rotate(Math.sin(k * 12) * 0.4)
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
      for (let i = 0; i < 4; i++) {
        ctx.fillStyle = alpha(e.color, (1 - k) * 0.55)
        ctx.beginPath(); ctx.arc(p.x + Math.cos(i * 1.7) * 7 * (1 + k), p.y - i * 3 * k, 5 + k * 6, 0, Math.PI * 2); ctx.fill()
      }
      break
    }
    case 'popup': {
      const p = iso(e.at.x, e.at.y, e.at.z + 0.2 + easeOut(k) * 0.7)
      ctx.globalAlpha = 1 - k * k
      ctx.fillStyle = e.color
      ctx.beginPath(); ctx.arc(p.x + 14, p.y - 30, 7, 0, Math.PI * 2); ctx.fill()
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
      const shake = Math.sin(now / 30) * 2
      ctx.font = `16px ${FONT}`
      ctx.globalAlpha = 1 - k * k
      ctx.fillText('☎', p.x - 22 + shake, p.y - 34)
      ctx.globalAlpha = 1
      break
    }
    case 'confetti': {
      const t = (now - e.born) / 1000
      for (const b of e.bits) {
        const p = iso(e.at.x + b.vx * t * 0.5, e.at.y + b.vy * t * 0.5, Math.max(0, e.at.z + b.vz * t - 4.9 * t * t * 0.6))
        ctx.save()
        ctx.translate(p.x, p.y)
        ctx.rotate(b.spin * t)
        ctx.globalAlpha = 1 - k
        ctx.fillStyle = b.color
        ctx.fillRect(-2.5, -1.5, 5, 3)
        ctx.restore()
      }
      break
    }
  }
}

function drawBackdropDots(ctx: CanvasRenderingContext2D, w: number, h: number, now: number, day: number): void {
  ctx.save()
  for (let i = 0; i < 40; i++) {
    const x = ((i * 137.5) % w)
    const y = ((i * 91.3 + now / (day > 0.5 ? 120 : 400) * (1 + (i % 3))) % (h + 40)) - 20
    ctx.globalAlpha = day > 0.5 ? 0.18 : 0.5 * (0.5 + 0.5 * Math.sin(now / 700 + i))
    ctx.fillStyle = day > 0.5 ? '#ffffff' : '#fff6c8'
    ctx.beginPath()
    ctx.arc(x, h - y, day > 0.5 ? 2 + (i % 4) : 1 + (i % 2), 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

