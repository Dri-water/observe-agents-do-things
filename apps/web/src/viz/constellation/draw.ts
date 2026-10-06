/** Canvas renderer for the constellation. */
import type { Scene, SNode } from './scene'
import { clip } from '@oadt/protocol'
import { alpha } from '../../shared/color'
import { harnessInfo, STATUS_COLOR } from '../../shared/theme'

export interface Camera {
  x: number
  y: number
  scale: number
}

interface Star { x: number; y: number; r: number; a: number }
const STARS: Star[] = Array.from({ length: 260 }, () => ({
  x: Math.random() * 4000 - 2000,
  y: Math.random() * 4000 - 2000,
  r: Math.random() * 1.2 + 0.2,
  a: Math.random() * 0.5 + 0.1,
}))

export interface DrawState {
  hovered?: string
  selected?: string
  showLabels: boolean
  multi: boolean
  titles: Map<string, { title: string; harness: string; status: string }>
}

export function drawScene(ctx: CanvasRenderingContext2D, scene: Scene, cam: Camera, w: number, h: number, st: DrawState): void {
  const t = performance.now()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  const dpr = ctx.canvas.width / w
  ctx.scale(dpr, dpr)

  // Background
  const bg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.75)
  bg.addColorStop(0, '#0b1120')
  bg.addColorStop(1, '#05070d')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, w, h)
  for (const s of STARS) {
    const sx = ((s.x - cam.x * 0.15) % w + w) % w
    const sy = ((s.y - cam.y * 0.15) % h + h) % h
    ctx.fillStyle = `rgba(180,200,255,${s.a * (0.6 + 0.4 * Math.sin(t / 1500 + s.x))})`
    ctx.fillRect(sx, sy, s.r, s.r)
  }

  ctx.save()
  ctx.translate(w / 2, h / 2)
  ctx.scale(cam.scale, cam.scale)
  ctx.translate(-cam.x, -cam.y)

  // Session halos
  for (const [sid, a] of scene.anchors) {
    const info = st.titles.get(sid)
    const color = harnessInfo(info?.harness ?? '').color
    const g = ctx.createRadialGradient(a.x, a.y, 0, a.x, a.y, 420)
    g.addColorStop(0, alpha(color, info?.status === 'working' || info?.status === 'waiting' ? 0.09 : 0.04))
    g.addColorStop(1, alpha(color, 0))
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(a.x, a.y, 420, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = alpha(color, 0.06)
    ctx.setLineDash([2, 10])
    ctx.lineWidth = 1 / cam.scale
    ctx.beginPath()
    ctx.arc(a.x, a.y, 340, 0, Math.PI * 2)
    ctx.stroke()
    ctx.setLineDash([])
    if (st.multi && info) {
      ctx.font = `600 ${15}px system-ui, -apple-system, "Segoe UI", sans-serif`
      ctx.textAlign = 'center'
      ctx.fillStyle = alpha('#e6edf7', 0.75)
      ctx.fillText(clip(info.title, 48), a.x, a.y + 390)
    }
  }

  const nodes = [...scene.nodes.values()]
  const get = (id?: string) => (id ? scene.nodes.get(id) : undefined)

  // Edges
  ctx.lineCap = 'round'
  for (const n of nodes) {
    if (n.kind === 'agent' && !n.isRoot) {
      const p = get(n.parentNodeId)
      if (!p) continue
      const working = n.status === 'working' || n.status === 'waiting'
      ctx.strokeStyle = alpha(n.color, (working ? 0.55 : 0.18) * Math.min(n.alpha, p.alpha))
      ctx.lineWidth = working ? 2.2 : 1.4
      if (working) { ctx.setLineDash([6, 8]); ctx.lineDashOffset = -t / 30 }
      curve(ctx, p.x, p.y, n.x, n.y)
      ctx.setLineDash([])
    } else if (n.kind === 'tool') {
      const o = get(n.ownerId)
      if (o) {
        ctx.strokeStyle = alpha(n.color, (n.open ? 0.55 : 0.16) * n.alpha)
        ctx.lineWidth = n.open ? 1.6 : 1
        line(ctx, o.x, o.y, n.x, n.y)
      }
      for (const fid of n.fileNodeIds ?? []) {
        const f = get(fid)
        if (!f) continue
        ctx.strokeStyle = alpha(f.color, 0.22 * Math.min(n.alpha, f.alpha))
        ctx.setLineDash([2, 5])
        ctx.lineWidth = 1
        line(ctx, n.x, n.y, f.x, f.y)
        ctx.setLineDash([])
      }
    } else if (n.kind === 'user') {
      const root = nodes.find((m) => m.kind === 'agent' && m.isRoot && m.sessionId === n.sessionId)
      if (root) {
        ctx.strokeStyle = alpha('#e8eefc', 0.1)
        ctx.setLineDash([1, 7])
        ctx.lineWidth = 1.2
        line(ctx, n.x, n.y, root.x, root.y)
        ctx.setLineDash([])
      }
    }
  }

  // Shockwave rings
  for (const r of scene.rings) {
    const k = (t - r.born) / r.ttl
    ctx.strokeStyle = alpha(r.color, (1 - k) * 0.7)
    ctx.lineWidth = 2.5 * (1 - k) + 0.5
    ctx.beginPath()
    ctx.arc(r.x, r.y, 10 + r.maxR * easeOut(k), 0, Math.PI * 2)
    ctx.stroke()
  }

  // Nodes: files, tools, then agents on top
  for (const n of nodes) if (n.kind === 'file') drawFile(ctx, n, st, cam)
  const labels: Label[] = []
  for (const n of nodes) if (n.kind === 'tool') drawTool(ctx, n, t, st, cam, labels)
  for (const n of nodes) if (n.kind === 'user') drawUser(ctx, n)
  for (const n of nodes) if (n.kind === 'agent') drawAgent(ctx, n, t, st)
  placeLabels(labels)

  // Particles (additive)
  ctx.globalCompositeOperation = 'lighter'
  for (const p of scene.particles) {
    const a = get(p.from), b = get(p.to)
    if (!a || !b) continue
    for (let i = 0; i < 4; i++) {
      const k = Math.max(0, easeInOut(p.t) - i * 0.035)
      const [x, y] = curvePoint(a.x, a.y, b.x, b.y, k)
      const size = p.size * (1 - i * 0.22)
      const g = ctx.createRadialGradient(x, y, 0, x, y, size * 3)
      g.addColorStop(0, alpha(p.color, 0.9 - i * 0.2))
      g.addColorStop(1, alpha(p.color, 0))
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(x, y, size * 3, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  ctx.globalCompositeOperation = 'source-over'

  // Bubbles last so they are readable
  for (const b of scene.bubbles) {
    const n = get(b.nodeId)
    if (n) drawBubble(ctx, n, b.text, b.tone, (t - b.born) / b.ttl, cam)
  }
  ctx.restore()
}

function drawAgent(ctx: CanvasRenderingContext2D, n: SNode, t: number, st: DrawState): void {
  const r = n.r * (0.4 + 0.6 * n.grow)
  const a = n.alpha
  const working = n.status === 'working'
  const waiting = n.status === 'waiting'
  const statusColor = STATUS_COLOR[n.status ?? 'idle']

  // Glow
  if (working || waiting) {
    const pulse = 0.5 + 0.5 * Math.sin(t / (waiting ? 260 : 600))
    const g = ctx.createRadialGradient(n.x, n.y, r * 0.6, n.x, n.y, r * 3.2)
    g.addColorStop(0, alpha(waiting ? '#ffb547' : n.color, (0.28 + 0.15 * pulse) * a))
    g.addColorStop(1, alpha(n.color, 0))
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(n.x, n.y, r * 3.2, 0, Math.PI * 2)
    ctx.fill()
  }

  // Body
  const body = ctx.createRadialGradient(n.x - r * 0.3, n.y - r * 0.4, r * 0.1, n.x, n.y, r)
  body.addColorStop(0, alpha('#1d2740', a))
  body.addColorStop(1, alpha('#0a0f1c', a))
  ctx.fillStyle = body
  ctx.beginPath()
  ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.lineWidth = n.isRoot ? 2.5 : 2
  ctx.strokeStyle = alpha(n.color, (n.status === 'done' ? 0.35 : 0.95) * a)
  ctx.stroke()

  // Status ring
  ctx.lineWidth = 3
  if (working) {
    const rot = t / 520
    ctx.strokeStyle = alpha(statusColor, 0.9 * a)
    for (let i = 0; i < 3; i++) {
      ctx.beginPath()
      ctx.arc(n.x, n.y, r + 6, rot + (i * Math.PI * 2) / 3, rot + (i * Math.PI * 2) / 3 + 1.2)
      ctx.stroke()
    }
  } else if (waiting) {
    ctx.strokeStyle = alpha(statusColor, (0.5 + 0.5 * Math.sin(t / 200)) * a)
    ctx.beginPath()
    ctx.arc(n.x, n.y, r + 6, 0, Math.PI * 2)
    ctx.stroke()
  } else if (n.status === 'done') {
    ctx.strokeStyle = alpha(statusColor, 0.6 * a)
    ctx.setLineDash([3, 5])
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(n.x, n.y, r + 5, 0, Math.PI * 2)
    ctx.stroke()
    ctx.setLineDash([])
  }

  // Context gauge
  if (n.contextFill !== undefined && r > 12) {
    ctx.lineWidth = 2
    ctx.strokeStyle = alpha('#ffffff', 0.08 * a)
    ctx.beginPath()
    ctx.arc(n.x, n.y, r + 12, -Math.PI / 2, Math.PI * 1.5)
    ctx.stroke()
    ctx.strokeStyle = alpha(n.contextFill > 0.85 ? '#ff5d73' : n.contextFill > 0.6 ? '#ffb547' : '#cfe3ff', 0.6 * a)
    ctx.beginPath()
    ctx.arc(n.x, n.y, r + 12, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * n.contextFill)
    ctx.stroke()
  }

  // Thinking: orbiting dots
  if (n.thinking) {
    for (let i = 0; i < 3; i++) {
      const ang = t / 300 + (i * Math.PI * 2) / 3
      ctx.fillStyle = alpha('#c7a6ff', 0.9 * a)
      ctx.beginPath()
      ctx.arc(n.x + Math.cos(ang) * (r + 18), n.y + Math.sin(ang) * (r + 18), 2.6, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // Initials
  if (r > 10) {
    ctx.fillStyle = alpha(n.color, a)
    ctx.font = `700 ${Math.round(r * 0.62)}px ui-monospace, "Cascadia Code", Menlo, Consolas, monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(n.initials ?? '', n.x, n.y + 1)
  }

  // Waiting badge
  if (waiting) {
    ctx.fillStyle = '#ffb547'
    ctx.beginPath()
    ctx.arc(n.x + r * 0.75, n.y - r * 0.75, 8, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#1a1206'
    ctx.font = '800 11px system-ui'
    ctx.fillText('!', n.x + r * 0.75, n.y - r * 0.75 + 0.5)
  }

  // Labels
  const selected = st.selected === n.id || st.hovered === n.id
  if (n.isRoot || r > 12 || selected) {
    ctx.textBaseline = 'top'
    ctx.font = `600 ${n.isRoot ? 14 : 12}px system-ui, -apple-system, "Segoe UI", sans-serif`
    ctx.fillStyle = alpha('#eef3fb', 0.95 * a)
    ctx.fillText(clip(n.label, n.isRoot ? 44 : 30), n.x, n.y + r + (n.contextFill !== undefined ? 18 : 10))
    ctx.font = `500 11px system-ui, -apple-system, "Segoe UI", sans-serif`
    ctx.fillStyle = alpha('#8b98ad', 0.9 * a)
    ctx.fillText(clip(n.sublabel ?? '', 46), n.x, n.y + r + (n.contextFill !== undefined ? 36 : 27))
  }
  if (selected) {
    ctx.strokeStyle = alpha('#ffffff', 0.8)
    ctx.lineWidth = 1.5
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.arc(n.x, n.y, r + 20, 0, Math.PI * 2)
    ctx.stroke()
    ctx.setLineDash([])
  }
}

function drawTool(ctx: CanvasRenderingContext2D, n: SNode, t: number, st: DrawState, cam: Camera, labels: Label[]): void {
  const r = n.r * (0.2 + 0.8 * n.grow)
  const a = n.alpha
  const err = n.open === false && n.ok === false
  if (n.open) {
    const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, r * 3.5)
    g.addColorStop(0, alpha(n.color, 0.5 * a))
    g.addColorStop(1, alpha(n.color, 0))
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(n.x, n.y, r * 3.5, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = alpha(n.color, 0.9 * a)
    ctx.lineWidth = 1.6
    const rot = t / 250
    ctx.beginPath()
    ctx.arc(n.x, n.y, r + 4, rot, rot + 4)
    ctx.stroke()
  }
  ctx.fillStyle = alpha(err ? '#ff5d73' : n.color, (n.open ? 1 : 0.75) * a)
  ctx.beginPath()
  ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
  ctx.fill()
  if (err) {
    ctx.strokeStyle = alpha('#ff5d73', a)
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(n.x, n.y, r + 3.5, 0, Math.PI * 2)
    ctx.stroke()
  }
  const recent = n.endedAt === undefined || Date.now() - n.endedAt < 5000
  const focus = st.hovered === n.id || st.selected === n.id
  if ((n.open || focus || (recent && st.showLabels)) && cam.scale > 0.35) {
    const text = clip(n.label, focus ? 80 : 42)
    const x = n.x + r + 8, y = n.y, pa = a * (n.open || focus ? 1 : 0.7)
    ctx.font = PILL_FONT
    const w = ctx.measureText(text).width + 14
    labels.push({ x, y: y - 10, w, h: 20, prio: focus ? 3 : n.open ? 2 : 1 - (Date.now() - (n.endedAt ?? 0)) / 1e5, draw: () => pill(ctx, text, x, y, n.color, pa, err) })
  }
}

function drawFile(ctx: CanvasRenderingContext2D, n: SNode, st: DrawState, cam: Camera): void {
  const heat = n.lastTs ? Math.exp(-(Date.now() - n.lastTs) / 45_000) : 0
  const r = n.r * (0.3 + 0.7 * n.grow)
  const a = n.alpha
  const flash = n.flash ?? 0
  if (heat > 0.05 || flash > 0) {
    const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, r * 4)
    g.addColorStop(0, alpha(n.color, (0.35 * heat + 0.5 * flash) * a))
    g.addColorStop(1, alpha(n.color, 0))
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(n.x, n.y, r * 4, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.save()
  ctx.translate(n.x, n.y)
  ctx.rotate(Math.PI / 4)
  ctx.fillStyle = alpha(n.color, (0.35 + 0.65 * Math.max(heat, flash, 0.25)) * a)
  ctx.fillRect(-r * 0.8, -r * 0.8, r * 1.6, r * 1.6)
  ctx.restore()
  const focus = st.hovered === n.id || st.selected === n.id
  if ((focus || heat > 0.3 || flash > 0.2 || cam.scale > 1.4) && cam.scale > 0.3) {
    ctx.font = `500 11px ui-monospace, "Cascadia Code", Menlo, Consolas, monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillStyle = alpha('#c9d4e5', (0.4 + 0.6 * Math.max(heat, focus ? 1 : 0)) * a)
    ctx.fillText(clip(n.label, 28), n.x, n.y + r + 6)
  }
}

function drawUser(ctx: CanvasRenderingContext2D, n: SNode): void {
  ctx.fillStyle = alpha('#e8eefc', 0.12 * n.alpha)
  ctx.beginPath()
  ctx.arc(n.x, n.y, n.r + 7, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = alpha('#e8eefc', 0.9 * n.alpha)
  ctx.beginPath()
  ctx.arc(n.x, n.y, n.r * 0.55, 0, Math.PI * 2)
  ctx.fill()
  ctx.font = '600 11px system-ui, -apple-system, "Segoe UI", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  ctx.fillStyle = alpha('#8b98ad', n.alpha)
  ctx.fillText('you', n.x, n.y - n.r - 8)
}

function drawBubble(ctx: CanvasRenderingContext2D, n: SNode, text: string, tone: string, k: number, cam: Camera): void {
  if (cam.scale < 0.3) return
  const fade = k < 0.08 ? k / 0.08 : k > 0.85 ? (1 - k) / 0.15 : 1
  const typed = Math.min(text.length, Math.floor((k * 8) * text.length) + 1)
  const lines = wrap(text.slice(0, Math.min(typed, 150)) + (text.length > 150 && typed >= 150 ? '…' : ''), 40).slice(0, 3)
  ctx.font = '500 12px system-ui, -apple-system, "Segoe UI", sans-serif'
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 20
  const h = lines.length * 16 + 12
  const x = n.x - w / 2
  const y = n.y - n.r - 30 - h
  const color = tone === 'user' ? '#e8eefc' : tone === 'agent' ? '#ffd166' : n.color
  ctx.globalAlpha = fade
  ctx.fillStyle = 'rgba(10,15,28,0.92)'
  ctx.strokeStyle = alpha(color, 0.55)
  ctx.lineWidth = 1
  roundRect(ctx, x, y, w, h, 9)
  ctx.fill()
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(n.x - 6, y + h)
  ctx.lineTo(n.x, y + h + 7)
  ctx.lineTo(n.x + 6, y + h)
  ctx.fillStyle = 'rgba(10,15,28,0.92)'
  ctx.fill()
  ctx.fillStyle = '#dfe7f3'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  lines.forEach((l, i) => ctx.fillText(l, x + 10, y + 7 + i * 16))
  ctx.globalAlpha = 1
}

interface Label { x: number; y: number; w: number; h: number; prio: number; draw: () => void }

const PILL_FONT = '500 11px ui-monospace, "Cascadia Code", Menlo, Consolas, monospace'

/** Greedy collision avoidance: highest-priority labels win, overlapping ones are skipped. */
function placeLabels(labels: Label[]): void {
  labels.sort((a, b) => b.prio - a.prio)
  const placed: Label[] = []
  for (const l of labels) {
    const hit = placed.some((p) => l.x < p.x + p.w + 4 && l.x + l.w + 4 > p.x && l.y < p.y + p.h + 2 && l.y + l.h + 2 > p.y)
    if (hit && l.prio < 3) continue
    placed.push(l)
  }
  for (const l of placed.reverse()) l.draw()
}

function pill(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, a: number, err: boolean): void {
  ctx.font = PILL_FONT
  const w = ctx.measureText(text).width + 14
  ctx.fillStyle = `rgba(8,12,22,${0.85 * a})`
  roundRect(ctx, x, y - 10, w, 20, 6)
  ctx.fill()
  ctx.strokeStyle = alpha(err ? '#ff5d73' : color, 0.5 * a)
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.fillStyle = alpha(err ? '#ffb3bf' : '#dbe5f2', a)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x + 7, y + 0.5)
}

function wrap(text: string, max: number): string[] {
  const words = text.split(' ')
  const out: string[] = []
  let cur = ''
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max) {
      if (cur) out.push(cur)
      cur = w.length > max ? w.slice(0, max - 1) + '…' : w
    } else cur = (cur + ' ' + w).trim()
  }
  if (cur) out.push(cur)
  return out
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
}

function curve(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  const [cx, cy] = control(x1, y1, x2, y2)
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.quadraticCurveTo(cx, cy, x2, y2)
  ctx.stroke()
}

function control(x1: number, y1: number, x2: number, y2: number): [number, number] {
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2
  const dx = x2 - x1, dy = y2 - y1
  return [mx - dy * 0.15, my + dx * 0.15]
}

function curvePoint(x1: number, y1: number, x2: number, y2: number, k: number): [number, number] {
  const [cx, cy] = control(x1, y1, x2, y2)
  const u = 1 - k
  return [u * u * x1 + 2 * u * k * cx + k * k * x2, u * u * y1 + 2 * u * k * cy + k * k * y2]
}

const easeOut = (k: number) => 1 - Math.pow(1 - k, 3)
const easeInOut = (k: number) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2)

