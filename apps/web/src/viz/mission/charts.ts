/** Tiny canvas charts that take their colours from the active theme. */
import { alpha } from '../../shared/color'

export function sizeCanvas(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | undefined {
  const w = canvas.clientWidth, h = canvas.clientHeight
  if (!w || !h) return undefined
  const dpr = window.devicePixelRatio || 1
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
  }
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  return { ctx, w, h }
}

/**
 * A scrolling heartbeat line: each event is a spike that drifts left as time
 * passes, so the line keeps moving even between events. Active sessions get a
 * gentle idle wobble; inactive ones flatten out.
 */
export function heartbeat(
  canvas: HTMLCanvasElement,
  beats: Array<{ ts: number; color: string }>,
  now: number,
  windowMs: number,
  style: { line: string; idle: string; active: boolean },
): void {
  const c = sizeCanvas(canvas)
  if (!c) return
  const { ctx, w, h } = c
  const base = h - 4
  const amp = h - 8
  const xOf = (ts: number) => w - ((now - ts) / windowMs) * w
  const spikes = beats.map((b) => ({ x: xOf(b.ts), color: b.color }))
  const y = (x: number) => {
    let v = 0
    for (const s of spikes) {
      const dx = x - s.x
      if (dx > -14 && dx < 14) v += Math.exp(-(dx * dx) / 18) * (dx < 0 ? 1 : 0.8)
    }
    const wobble = style.active ? Math.sin(x / 9 + now / 260) * 0.06 + Math.sin(x / 23 - now / 700) * 0.04 : 0
    return base - Math.min(1, v + Math.max(0, wobble)) * amp
  }
  const grad = ctx.createLinearGradient(0, 0, w, 0)
  grad.addColorStop(0, alpha(style.active ? style.line : style.idle, 0))
  grad.addColorStop(0.25, alpha(style.active ? style.line : style.idle, 0.55))
  grad.addColorStop(1, style.active ? style.line : style.idle)
  ctx.beginPath()
  for (let x = 0; x <= w; x += 1.5) (x ? ctx.lineTo(x, y(x)) : ctx.moveTo(x, y(x)))
  ctx.strokeStyle = grad
  ctx.lineWidth = 1.4
  ctx.stroke()
  // Coloured caps on each spike show what kind of work it was.
  for (const s of spikes) {
    if (s.x < 0 || s.x > w) continue
    ctx.fillStyle = s.color
    ctx.globalAlpha = Math.min(1, 0.25 + (s.x / w) * 0.85)
    ctx.beginPath()
    ctx.arc(s.x, y(s.x) - 1, 2, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
  // The "now" cursor.
  if (style.active) {
    ctx.fillStyle = style.line
    ctx.beginPath()
    ctx.arc(w - 2, y(w - 2), 2.2 + Math.sin(now / 200) * 0.6, 0, Math.PI * 2)
    ctx.fill()
  }
}

/**
 * Stacked area chart: one series per key, drawn bottom-up in the given order.
 * `xs` (0–1, one per bucket) lets the caller scroll the chart smoothly between buckets.
 */
export function stackedArea(
  canvas: HTMLCanvasElement,
  series: Array<{ values: number[]; color: string }>,
  opts: { grid: string; text: string; label?: (max: number) => string; padTop?: number; xs?: number[] },
): void {
  const c = sizeCanvas(canvas)
  if (!c) return
  const { ctx, w, h } = c
  const n = series[0]?.values.length ?? 0
  if (!n) return
  const totals = new Array<number>(n).fill(0)
  for (const s of series) s.values.forEach((v, i) => (totals[i]! += v))
  const max = Math.max(4, ...totals)
  const top = opts.padTop ?? 18
  const xAt = (i: number) => (opts.xs ? opts.xs[i]! * w : (i / Math.max(1, n - 1)) * w)
  const y = (v: number) => h - 2 - (v / max) * (h - top - 2)

  ctx.strokeStyle = opts.grid
  ctx.lineWidth = 1
  for (const f of [0.5, 1]) {
    const gy = Math.round(y(max * f)) + 0.5
    ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke()
  }
  const base = new Array<number>(n).fill(0)
  for (const s of series) {
    const next = base.map((b, i) => b + (s.values[i] ?? 0))
    if (next.every((v, i) => v === base[i])) continue
    ctx.beginPath()
    next.forEach((v, i) => (i ? ctx.lineTo(xAt(i), y(v)) : ctx.moveTo(xAt(i), y(v))))
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(xAt(i), y(base[i]!))
    ctx.closePath()
    ctx.fillStyle = alpha(s.color, 0.55)
    ctx.fill()
    ctx.beginPath()
    next.forEach((v, i) => (i ? ctx.lineTo(xAt(i), y(v)) : ctx.moveTo(xAt(i), y(v))))
    ctx.strokeStyle = s.color
    ctx.lineWidth = 1
    ctx.stroke()
    for (let i = 0; i < n; i++) base[i] = next[i]!
  }
  if (opts.label) {
    ctx.fillStyle = opts.text
    ctx.font = '10px ui-monospace, Menlo, Consolas, monospace'
    ctx.textAlign = 'right'
    ctx.fillText(opts.label(max), w - 4, top - 6)
  }
}
