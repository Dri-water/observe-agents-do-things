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

/** Bucket timestamps into `n` bins ending at `now`. */
export function bucket(times: number[], now: number, spanMs: number, n: number): number[] {
  const out = new Array<number>(n).fill(0)
  const start = now - spanMs
  const size = spanMs / n
  for (const t of times) {
    if (t < start || t > now) continue
    out[Math.min(n - 1, Math.floor((t - start) / size))]!++
  }
  return out
}

/** Filled sparkline. */
export function sparkline(canvas: HTMLCanvasElement, values: number[], color: string, opts: { max?: number; baseline?: string } = {}): void {
  const c = sizeCanvas(canvas)
  if (!c) return
  const { ctx, w, h } = c
  const max = Math.max(opts.max ?? 0, 1, ...values)
  const step = values.length > 1 ? w / (values.length - 1) : w
  const y = (v: number) => h - 1 - (v / max) * (h - 3)
  if (opts.baseline) {
    ctx.fillStyle = opts.baseline
    ctx.fillRect(0, h - 1, w, 1)
  }
  ctx.beginPath()
  ctx.moveTo(0, h)
  values.forEach((v, i) => ctx.lineTo(i * step, y(v)))
  ctx.lineTo(w, h)
  ctx.closePath()
  ctx.fillStyle = alpha(color, 0.18)
  ctx.fill()
  ctx.beginPath()
  values.forEach((v, i) => (i ? ctx.lineTo(i * step, y(v)) : ctx.moveTo(0, y(v))))
  ctx.strokeStyle = color
  ctx.lineWidth = 1.2
  ctx.stroke()
  // A live dot on the newest value.
  const last = values[values.length - 1] ?? 0
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(w - 1.5, y(last), 1.8, 0, Math.PI * 2)
  ctx.fill()
}

/** Stacked area chart: one series per key, drawn bottom-up in the given order. */
export function stackedArea(
  canvas: HTMLCanvasElement,
  series: Array<{ values: number[]; color: string }>,
  opts: { grid: string; text: string; label?: (max: number) => string; padTop?: number },
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
  const step = w / Math.max(1, n - 1)
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
    next.forEach((v, i) => (i ? ctx.lineTo(i * step, y(v)) : ctx.moveTo(0, y(v))))
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(i * step, y(base[i]!))
    ctx.closePath()
    ctx.fillStyle = alpha(s.color, 0.55)
    ctx.fill()
    ctx.beginPath()
    next.forEach((v, i) => (i ? ctx.lineTo(i * step, y(v)) : ctx.moveTo(0, y(v))))
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
