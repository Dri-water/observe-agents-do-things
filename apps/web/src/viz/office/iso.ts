/** Isometric projection and drawing primitives for the office. */
import { shade } from '../../shared/color'

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

// ─── Shapes ──────────────────────────────────────────────────────────────

export function poly(ctx: CanvasRenderingContext2D, pts: Pt[], fill?: string, stroke?: string, lw = 1): void {
  ctx.beginPath()
  ctx.moveTo(pts[0]!.x, pts[0]!.y)
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y)
  ctx.closePath()
  if (fill) { ctx.fillStyle = fill; ctx.fill() }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke() }
}

/**
 * An axis-aligned cuboid. Only the three camera-facing faces are drawn:
 * top, the +y face (lower-left on screen) and the +x face (lower-right).
 */
export function box(ctx: CanvasRenderingContext2D, x: number, y: number, z: number, w: number, d: number, h: number, color: string, opts: { top?: string; outline?: boolean } = {}): void {
  const p = (px: number, py: number, pz: number) => iso(px, py, pz)
  const top = [p(x, y, z + h), p(x + w, y, z + h), p(x + w, y + d, z + h), p(x, y + d, z + h)]
  const left = [p(x, y + d, z), p(x + w, y + d, z), p(x + w, y + d, z + h), p(x, y + d, z + h)]
  const right = [p(x + w, y, z), p(x + w, y + d, z), p(x + w, y + d, z + h), p(x + w, y, z + h)]
  const edge = opts.outline === false ? undefined : shade(color, -0.45, 0.35)
  poly(ctx, left, shade(color, -0.08), edge)
  poly(ctx, right, shade(color, -0.22), edge)
  poly(ctx, top, opts.top ?? shade(color, 0.1), edge)
}

/** A flat quad on the floor (z = const). */
export function floorQuad(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, d: number, fill: string, z = 0, stroke?: string): void {
  poly(ctx, [iso(x, y, z), iso(x + w, y, z), iso(x + w, y + d, z), iso(x, y + d, z)], fill, stroke)
}

/** Soft elliptical shadow on the floor. */
export function shadow(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, a = 0.22): void {
  const c = iso(x, y, 0)
  ctx.fillStyle = `rgba(40,30,60,${a})`
  ctx.beginPath()
  ctx.ellipse(c.x, c.y, rx * TW * 0.5, rx * TH * 0.5, 0, 0, Math.PI * 2)
  ctx.fill()
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
