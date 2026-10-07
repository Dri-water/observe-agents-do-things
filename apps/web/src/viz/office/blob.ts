/**
 * Blobs on canvas. The faces are blobatar's (the same ones Mission Control
 * shows in the DOM), drawn here as Path2D so they can live inside the
 * isometric scene, behind desks and under the night wash. The same seed gives
 * the same blob in both visualizations, and the expression is the shared
 * activity → look mapping from `shared/buddy`.
 */
import { _layout, _marks, type Mark } from 'blobatar/internal'
import type { Activity } from '@oadt/protocol'
import { LOOKS } from '../../shared/buddy'

export interface BlobArt {
  body: Array<{ path: Path2D; fill: string }>
  eyes: Array<{ path: Path2D; fill: string; cx: number; cy: number }>
  /** Pose offset of the whole figure, in viewBox units. */
  dy: number
  /** The body ellipse (viewBox units), for props that sit on the blob. */
  frame: { cx: number; cy: number; rx: number; ry: number }
  /** Lowest point of the figure (viewBox units). */
  bottom: number
}

const cache = new Map<string, BlobArt>()

/** Largest y in an absolute SVG path (M/L/C/Q/H/V/Z, as blobatar emits). Control points can only overshoot by a hair. */
function pathMaxY(d: string): number {
  let max = -Infinity, cmd = 'M', i = 0
  const nums: number[] = []
  const flush = () => {
    if (cmd === 'V') for (const v of nums) max = Math.max(max, v)
    else if (cmd !== 'H') for (let k = 1; k < nums.length; k += 2) max = Math.max(max, nums[k]!)
    nums.length = 0
  }
  for (const tok of d.match(/[A-Za-z]|-?[\d.]+(?:e-?\d+)?/g) ?? []) {
    if (/[A-Za-z]/.test(tok)) { flush(); cmd = tok.toUpperCase(); i++ }
    else nums.push(Number(tok))
  }
  flush()
  return Number.isFinite(max) ? max : 88
}

function toPath(m: Mark): Path2D {
  if (m.kind === 'circle') {
    const p = new Path2D()
    p.arc(m.cx, m.cy, m.r, 0, Math.PI * 2)
    return p
  }
  return new Path2D(m.d)
}

/** Geometry for `seed` wearing the expression for `activity`. Cached; cheap to call per frame. */
export function blobArt(seed: string, activity: Activity): BlobArt {
  const key = `${seed}|${activity}`
  const hit = cache.get(key)
  if (hit) return hit
  const expression = LOOKS[activity].expr
  const m = _marks(seed, { expression, background: false })
  const lay = _layout(seed, { expression })
  const n = lay.eyes.length
  const split = m.marks.length - n
  const body = m.marks.slice(0, split).map((mk) => ({ path: toPath(mk), fill: mk.fill }))
  const eyes = m.marks.slice(split).map((mk, i) => ({ path: toPath(mk), fill: mk.fill, cx: lay.eyes[i]!.cx, cy: lay.eyes[i]!.cy }))
  const dy = Number(/translate\(0 (-?[\d.]+)\)/.exec(m.transform)?.[1] ?? 0)
  const b = lay.body
  // The lowest point of the drawn figure, not of its bounding ellipse: a
  // triangle ends well above cy + ry and a rotated boxy shape dips below it.
  let bottom = 0
  for (const mk of m.marks.slice(0, split)) bottom = Math.max(bottom, mk.kind === 'circle' ? mk.cy + mk.r : pathMaxY(mk.d))
  const art: BlobArt = { body, eyes, dy, frame: { cx: b.cx, cy: b.cy, rx: b.rx, ry: b.ry }, bottom }
  if (cache.size > 600) cache.clear()
  cache.set(key, art)
  return art
}

export interface BlobDraw {
  /** Rendered height of the 100-unit viewBox, in canvas px. */
  size: number
  facing: 1 | -1
  /** Eye openness, 1 = open, 0 = shut. */
  eyes?: number
  /** Squash and stretch around the bottom centre. */
  sx?: number
  sy?: number
  /** Lean, radians, around the bottom centre. */
  rot?: number
  /** Extra offset in viewBox units (hops, slumps). */
  dx?: number
  dyExtra?: number
  /** Draw the lead's headset. */
  headset?: boolean
  /** 0..1 desaturation for sleepers. */
  dim?: number
  /** 0..1 brightness boost, to survive a darkening pass drawn on top. */
  lift?: number
}

/** Draw a blob with its bottom centre at (x, y) on the current transform. */
export function drawBlob(ctx: CanvasRenderingContext2D, art: BlobArt, x: number, y: number, o: BlobDraw): void {
  const s = o.size / 100
  ctx.save()
  ctx.translate(x, y)
  if (o.rot) ctx.rotate(o.rot * o.facing)
  ctx.scale(o.facing * s * (o.sx ?? 1), s * (o.sy ?? 1))
  ctx.translate(-50 + (o.dx ?? 0), -art.bottom + art.dy + (o.dyExtra ?? 0))
  const filters: string[] = []
  if (o.dim) filters.push(`saturate(${1 - o.dim * 0.5})`, `brightness(${1 - o.dim * 0.08})`)
  if (o.lift) filters.push(`brightness(${1 + o.lift * 0.9})`, `saturate(${1 + o.lift * 0.25})`)
  if (filters.length) ctx.filter = filters.join(' ')
  for (const b of art.body) { ctx.fillStyle = b.fill; ctx.fill(b.path) }
  // A soft highlight so the blob reads as a rounded thing under the room's light.
  const f = art.frame
  ctx.save()
  ctx.beginPath(); ctx.ellipse(f.cx - f.rx * 0.32, f.cy - f.ry * 0.38, f.rx * 0.34, f.ry * 0.2, -0.6, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(255,255,255,0.28)'
  ctx.fill()
  ctx.restore()
  const open = o.eyes ?? 1
  for (const e of art.eyes) {
    ctx.fillStyle = e.fill
    if (open >= 0.98) { ctx.fill(e.path); continue }
    ctx.save()
    ctx.translate(e.cx, e.cy)
    ctx.scale(1, Math.max(0.08, open))
    ctx.translate(-e.cx, -e.cy)
    ctx.fill(e.path)
    ctx.restore()
  }
  if (o.headset) {
    ctx.strokeStyle = '#2d2a3e'
    ctx.lineCap = 'round'
    ctx.lineWidth = 4
    ctx.beginPath(); ctx.arc(f.cx, f.cy + f.ry * 0.05, f.rx * 1.04, Math.PI * 1.12, Math.PI * 1.88); ctx.stroke()
    ctx.fillStyle = '#2d2a3e'
    const ex = f.cx - f.rx * 1.04 * Math.cos(Math.PI * 0.12), ey = f.cy + f.ry * 0.05 - f.rx * 1.04 * Math.sin(Math.PI * 0.12)
    ctx.beginPath(); ctx.ellipse(ex, ey + 2, 5, 7, 0, 0, Math.PI * 2); ctx.fill()
    ctx.lineWidth = 2.6
    ctx.beginPath(); ctx.moveTo(ex + 1, ey + 8); ctx.quadraticCurveTo(ex + 6, ey + 22, f.cx - 4, f.cy + f.ry * 0.62); ctx.stroke()
    ctx.fillStyle = '#4fe39b'
    ctx.beginPath(); ctx.arc(f.cx - 4, f.cy + f.ry * 0.62, 2.4, 0, Math.PI * 2); ctx.fill()
  }
  ctx.restore()
}

export interface Motion { sx: number; sy: number; rot: number; dx: number; dy: number }

/** Body motion per activity, mirroring buddy.css. `t` in seconds, `phase` per blob. */
export function blobMotion(activity: Activity, walking: boolean, t: number, phase: number): Motion {
  const m: Motion = { sx: 1, sy: 1, rot: 0, dx: 0, dy: 0 }
  // Everyone breathes.
  const br = Math.sin(t * 2.1 + phase)
  m.sy += 0.018 * br
  m.sx -= 0.012 * br
  if (walking) {
    const k = Math.abs(Math.sin(t * 9 + phase))
    m.dy = -k * 7
    m.sy = 0.94 + 0.1 * k
    m.sx = 1.06 - 0.08 * k
    m.rot = 0.09
    return m
  }
  switch (activity) {
    case 'thinking': case 'planning': m.rot = 0.07 * Math.sin(t * 2 + phase); break
    case 'reading': m.dy = 2 * Math.max(0, Math.sin(t * 2.4 + phase)); m.rot = 0.04 * Math.sin(t * 2.4 + phase); break
    case 'searching': m.dx = 5 * Math.sin(t * 2.8 + phase); m.rot = 0.1 * Math.sin(t * 2.8 + phase); break
    case 'editing': case 'writing': { const k = Math.sin(t * 17 + phase); m.sx += 0.04 * k; m.sy -= 0.05 * k; m.dy = -1.5 * Math.max(0, k); break }
    case 'running': m.dx = 1.3 * Math.sin(t * 44 + phase); m.rot = 0.012 * Math.sin(t * 44 + phase); break
    case 'browsing': m.dy = -5 * (0.5 + 0.5 * Math.sin(t * 3.5 + phase)); break
    case 'delegating': { const k = Math.abs(Math.sin(t * 3.5 + phase)); m.dy = -7 * k; m.sy = 0.96 + 0.08 * k; m.sx = 1.04 - 0.06 * k; break }
    case 'tooling': m.rot = 0.11 * Math.sin(t * 5.2 + phase) * (0.5 + 0.5 * Math.sin(t * 0.9 + phase)); break
    case 'asking': m.rot = -0.14 + 0.04 * Math.sin(t * 2.6 + phase); m.dy = -1.5; break
    case 'waiting': { const k = Math.max(0, Math.sin(t * 5.7 + phase)); m.dy = -14 * k; m.sy = 0.92 + 0.14 * k; m.sx = 1.08 - 0.12 * k; break }
    case 'failed': m.dx = 3 * Math.sin(t * 38 + phase); m.rot = 0.05 * Math.sin(t * 38 + phase); break
    case 'finished': { const k = Math.abs(Math.sin(t * 4 + phase)); m.dy = -5 * k; m.rot = 0.1 * Math.sin(t * 8 + phase); break }
    case 'aborted': m.dy = 3; m.sx = 0.97; m.sy = 0.92; break
    case 'sleeping': m.dy = 3; m.sx = 1.06 + 0.02 * Math.sin(t * 1.4 + phase); m.sy = 0.88 + 0.03 * Math.sin(t * 1.4 + phase); break
    default: break
  }
  return m
}
