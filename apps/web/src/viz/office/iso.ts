/**
 * Isometric projection and lit drawing primitives for the office.
 *
 * One light source, up and to the back-left of the room: top faces are
 * brightest, the +y face (lower-left on screen) is mid-tone, the +x face
 * (lower-right) is darkest. Vertical faces get a soft gradient so objects
 * read as solid and sit on the floor instead of floating as flat colour.
 */
import { alpha, shade } from '../../shared/color'

/** Pixels per tile edge (2:1 dimetric) and per unit of height, at zoom 1. */
export const TW = 64
export const TH = 32
export const ZH = 34

export interface Pt { x: number; y: number }

/** World (tile x, tile y, height z) → screen pixels (before camera). */
export function iso(x: number, y: number, z = 0): Pt {
  return { x: (x - y) * (TW / 2), y: (x + y) * (TH / 2) - z * ZH }
}

/** Stable small hash for picking palette entries. */
export function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/** Deterministic 0..1 noise from integers. */
export function rnd(a: number, b = 0, c = 0): number {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

// ─── Shapes ──────────────────────────────────────────────────────────────

export function poly(ctx: CanvasRenderingContext2D, pts: Pt[], fill?: string | CanvasGradient, stroke?: string, lw = 1): void {
  ctx.beginPath()
  ctx.moveTo(pts[0]!.x, pts[0]!.y)
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y)
  ctx.closePath()
  if (fill) { ctx.fillStyle = fill; ctx.fill() }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke() }
}

export function line(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, stroke: string, lw = 1): void {
  ctx.strokeStyle = stroke
  ctx.lineWidth = lw
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.lineTo(b.x, b.y)
  ctx.stroke()
}

/** Linear gradient between two screen points. */
export function grad(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, c0: string, c1: string): CanvasGradient {
  const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y)
  g.addColorStop(0, c0)
  g.addColorStop(1, c1)
  return g
}

export const LIGHT = { top: 0.12, left: -0.07, right: -0.26, falloff: 0.11 }

export interface BoxOpts {
  top?: string | CanvasGradient
  left?: string | CanvasGradient
  right?: string | CanvasGradient
  /** Gradient-shade the vertical faces (default true). */
  lit?: boolean
  /** Bevel highlight on the top edges (default true for boxes taller than 0.1). */
  edge?: boolean
  /** Skip faces that are never visible (e.g. a book flush against a shelf back). */
  faces?: { top?: boolean; left?: boolean; right?: boolean }
}

/**
 * An axis-aligned cuboid. Only the three camera-facing faces are drawn:
 * top, the +y face (lower-left on screen) and the +x face (lower-right).
 */
export function box(ctx: CanvasRenderingContext2D, x: number, y: number, z: number, w: number, d: number, h: number, color: string, o: BoxOpts = {}): void {
  const lit = o.lit !== false
  const p000 = iso(x, y, z), p0d0 = iso(x, y + d, z), pwd0 = iso(x + w, y + d, z), pw00 = iso(x + w, y, z)
  const p00h = iso(x, y, z + h), p0dh = iso(x, y + d, z + h), pwdh = iso(x + w, y + d, z + h), pw0h = iso(x + w, y, z + h)
  const f = o.faces ?? {}
  // Gradients are the expensive part of canvas drawing, so only tall faces get
  // a real one; small faces fake the falloff with a flat shadow band.
  const smooth = lit && h >= 0.4
  const band = lit && !smooth && h > 0.12
  if (f.left !== false && d > 0) {
    const c = o.left ?? shade(color, LIGHT.left)
    poly(ctx, [p0d0, pwd0, pwdh, p0dh], typeof c === 'string' && smooth ? grad(ctx, p0dh, p0d0, c, shade(c, -LIGHT.falloff)) : c)
    if (band) poly(ctx, [p0d0, pwd0, iso(x + w, y + d, z + h * 0.35), iso(x, y + d, z + h * 0.35)], 'rgba(0,0,0,0.06)')
  }
  if (f.right !== false && w > 0) {
    const c = o.right ?? shade(color, LIGHT.right)
    poly(ctx, [pw00, pwd0, pwdh, pw0h], typeof c === 'string' && smooth ? grad(ctx, pw0h, pw00, c, shade(c, -LIGHT.falloff)) : c)
    if (band) poly(ctx, [pw00, pwd0, iso(x + w, y + d, z + h * 0.35), iso(x + w, y, z + h * 0.35)], 'rgba(0,0,0,0.06)')
  }
  if (f.top !== false) {
    const c = o.top ?? shade(color, LIGHT.top)
    poly(ctx, [p00h, pw0h, pwdh, p0dh], typeof c === 'string' && lit && w * d > 0.6 ? grad(ctx, p00h, pwdh, shade(c, 0.05), shade(c, -0.04)) : c)
  }
  if (o.edge !== false && h > 0.1 && w > 0.1 && d > 0.1) {
    // Bevel: a light line on the near top edges, a faint dark seam down the near corner.
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(255,255,255,0.28)'
    ctx.beginPath(); ctx.moveTo(p0dh.x, p0dh.y); ctx.lineTo(pwdh.x, pwdh.y); ctx.lineTo(pw0h.x, pw0h.y); ctx.stroke()
    ctx.strokeStyle = 'rgba(0,0,0,0.10)'
    ctx.beginPath(); ctx.moveTo(pwdh.x, pwdh.y); ctx.lineTo(pwd0.x, pwd0.y); ctx.stroke()
  }
}

/** A vertical cylinder (mugs, lamp stems, pots, stools). */
export function cyl(ctx: CanvasRenderingContext2D, x: number, y: number, z: number, r: number, h: number, color: string, o: { top?: string } = {}): void {
  const rx = r * (TW / 2), ry = r * (TH / 2)
  const b = iso(x, y, z), t = iso(x, y, z + h)
  const body = () => {
    ctx.beginPath()
    ctx.moveTo(t.x - rx, t.y)
    ctx.lineTo(b.x - rx, b.y)
    ctx.ellipse(b.x, b.y, rx, ry, 0, Math.PI, 0, true)
    ctx.lineTo(t.x + rx, t.y)
    ctx.closePath()
  }
  if (r >= 0.12) {
    const g = ctx.createLinearGradient(b.x - rx, 0, b.x + rx, 0)
    g.addColorStop(0, shade(color, -0.02))
    g.addColorStop(0.35, shade(color, LIGHT.left + 0.04))
    g.addColorStop(1, shade(color, LIGHT.right - 0.06))
    ctx.fillStyle = g
    body()
    ctx.fill()
  } else {
    // Small cylinders: flat body plus a shaded right half.
    ctx.fillStyle = shade(color, LIGHT.left + 0.02)
    body()
    ctx.fill()
    ctx.save()
    ctx.beginPath()
    ctx.rect(b.x, t.y - ry, rx + 1, b.y - t.y + ry * 2)
    ctx.clip()
    ctx.fillStyle = shade(color, LIGHT.right - 0.04)
    body()
    ctx.fill()
    ctx.restore()
  }
  ctx.fillStyle = o.top ?? shade(color, LIGHT.top)
  ctx.beginPath()
  ctx.ellipse(t.x, t.y, rx, ry, 0, 0, Math.PI * 2)
  ctx.fill()
}

/** A flat quad on the floor (z = const). */
export function floorQuad(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, d: number, fill: string | CanvasGradient, z = 0, stroke?: string): void {
  poly(ctx, [iso(x, y, z), iso(x + w, y, z), iso(x + w, y + d, z), iso(x, y + d, z)], fill, stroke)
}

/** Soft contact shadow under something round-ish. */
export function blobShadow(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, a = 0.22, ry = rx * 0.5): void {
  const c = iso(x, y, 0)
  const sx = rx * (TW / 2), sy = ry * (TW / 2)
  ctx.save()
  ctx.translate(c.x, c.y)
  ctx.scale(1, sy / sx)
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, sx)
  g.addColorStop(0, `rgba(40,28,64,${a})`)
  g.addColorStop(0.55, `rgba(40,28,64,${a * 0.55})`)
  g.addColorStop(1, 'rgba(40,28,64,0)')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(0, 0, sx, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/** Directional shadow a box of this footprint and height throws on the floor (toward +x, +y). */
export function castShadow(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, d: number, h: number, a = 0.16): void {
  const sx = h * 0.34, sy = h * 0.16
  const pts = [iso(x, y), iso(x + w, y), iso(x + w + sx, y + sy), iso(x + w + sx, y + d + sy), iso(x + sx, y + d + sy), iso(x, y + d)]
  const g = grad(ctx, iso(x + w / 2, y + d / 2), iso(x + w / 2 + sx, y + d / 2 + sy), `rgba(40,28,64,${a})`, `rgba(40,28,64,${a * 0.35})`)
  poly(ctx, pts, g)
}

/** Additive light pool on the floor (or any plane): a soft radial glow. */
export function glowAt(ctx: CanvasRenderingContext2D, p: Pt, rx: number, ry: number, color: string, a: number): void {
  if (a <= 0.005) return
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  ctx.translate(p.x, p.y)
  ctx.scale(1, ry / rx)
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx)
  g.addColorStop(0, alpha(color, a))
  g.addColorStop(0.4, alpha(color, a * 0.45))
  g.addColorStop(1, alpha(color, 0))
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(0, 0, rx, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  r = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ')
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w
    if (ctx.measureText(next).width > maxWidth && cur) {
      lines.push(cur)
      cur = w
      if (lines.length === maxLines) break
    } else cur = next
  }
  if (lines.length < maxLines && cur) lines.push(cur)
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    let last = lines[maxLines - 1]!
    while (last.length > 1 && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1)
    lines[maxLines - 1] = last + '…'
  }
  return lines
}

export const easeOut = (k: number) => 1 - Math.pow(1 - k, 3)
export const easeInOut = (k: number) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2)
