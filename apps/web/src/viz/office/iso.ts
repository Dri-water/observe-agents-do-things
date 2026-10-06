/** Isometric projection and drawing primitives for the office. */

/** Pixels per tile edge (2:1 dimetric) and per unit of height, at zoom 1. */
export const TW = 64
export const TH = 32
export const ZH = 34

export interface Pt { x: number; y: number }

/** World (tile x, tile y, height z) → screen pixels (before camera). */
export function iso(x: number, y: number, z = 0): Pt {
  return { x: (x - y) * (TW / 2), y: (x + y) * (TH / 2) - z * ZH }
}

/** Screen pixels → world tile at floor level. */
export function unIso(sx: number, sy: number): Pt {
  const a = sx / (TW / 2)
  const b = sy / (TH / 2)
  return { x: (a + b) / 2, y: (b - a) / 2 }
}

// ─── Colour helpers ──────────────────────────────────────────────────────

export function hexToRgb(hex: string): [number, number, number] {
  if (hex.startsWith('rgb')) {
    const m = hex.match(/[\d.]+/g) ?? []
    return [Number(m[0] ?? 0), Number(m[1] ?? 0), Number(m[2] ?? 0)]
  }
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function rgb(r: number, g: number, b: number, a = 1): string {
  return a >= 1 ? `rgb(${r | 0},${g | 0},${b | 0})` : `rgba(${r | 0},${g | 0},${b | 0},${a})`
}

/** Lighten (k > 0) or darken (k < 0) a hex colour; optionally tint toward another colour. */
export function shade(hex: string, k: number, a = 1): string {
  const [r, g, b] = hexToRgb(hex)
  const t = k >= 0 ? 255 : 0
  const f = Math.abs(k)
  return rgb(r + (t - r) * f, g + (t - g) * f, b + (t - b) * f, a)
}

export function mix(hexA: string, hexB: string, t: number, a = 1): string {
  const [r1, g1, b1] = hexToRgb(hexA)
  const [r2, g2, b2] = hexToRgb(hexB)
  return rgb(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t, a)
}

export function withAlpha(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex)
  return rgb(r, g, b, a)
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

/** A rectangle painted on the back wall that runs along x (y = const, facing +y). */
export function wallQuadX(ctx: CanvasRenderingContext2D, x: number, y: number, z: number, w: number, h: number, fill: string | CanvasGradient, stroke?: string): void {
  ctx.beginPath()
  const a = iso(x, y, z), b = iso(x + w, y, z), c = iso(x + w, y, z + h), d = iso(x, y, z + h)
  ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.closePath()
  ctx.fillStyle = fill
  ctx.fill()
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke() }
}

/** A rectangle painted on the back wall that runs along y (x = const, facing +x). */
export function wallQuadY(ctx: CanvasRenderingContext2D, x: number, y: number, z: number, d: number, h: number, fill: string | CanvasGradient, stroke?: string): void {
  ctx.beginPath()
  const a = iso(x, y, z), b = iso(x, y + d, z), c = iso(x, y + d, z + h), e = iso(x, y, z + h)
  ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(e.x, e.y); ctx.closePath()
  ctx.fillStyle = fill
  ctx.fill()
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke() }
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
export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
