/** Swimlane timeline: one lane per agent, tool calls as bars, prompts and turn ends as markers. */
import type { ToolCallState, WorldState } from '@oadt/protocol'
import { clip } from '@oadt/protocol'
import { alpha } from '../../shared/color'
import { categoryColor, harnessInfo, STATUS_COLOR } from '../../shared/theme'

export interface Mark {
  sessionId: string
  agentId: string
  ts: number
  kind: 'user' | 'turn-ok' | 'turn-bad' | 'spawn'
}

interface Lane {
  sessionId: string
  agentId: string
  label: string
  color: string
  status: string
  depth: number
}

interface HitBox {
  x: number
  y: number
  w: number
  h: number
  tool: ToolCallState
  sessionId: string
}

const LABEL_W = 150
const LANE_H = 20

export class Timeline {
  windowMs = 3 * 60_000
  private hits: HitBox[] = []
  private hover?: HitBox
  private mouse = { x: -1, y: -1 }

  constructor(
    private canvas: HTMLCanvasElement,
    private onPick: (sessionId: string, toolId: string) => void,
    private tooltip: HTMLElement,
  ) {
    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect()
      this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top }
    })
    canvas.addEventListener('mouseleave', () => { this.mouse = { x: -1, y: -1 }; this.tooltip.hidden = true })
    canvas.addEventListener('click', () => {
      if (this.hover) this.onPick(this.hover.sessionId, this.hover.tool.id)
    })
  }

  render(world: WorldState, sessionIds: string[], marks: Mark[], now: number): void {
    const cssW = this.canvas.clientWidth
    const cssH = this.canvas.clientHeight
    const dpr = window.devicePixelRatio || 1
    if (this.canvas.width !== Math.round(cssW * dpr) || this.canvas.height !== Math.round(cssH * dpr)) {
      this.canvas.width = Math.round(cssW * dpr)
      this.canvas.height = Math.round(cssH * dpr)
    }
    const ctx = this.canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)

    const lanes: Lane[] = []
    for (const sid of sessionIds) {
      const s = world.sessions[sid]
      if (!s) continue
      const agents = Object.values(s.agents).sort((a, b) => a.depth - b.depth || a.startedAt - b.startedAt)
      for (const a of agents) {
        const hasRecent = a.lastActivityAt > now - this.windowMs || a.id === s.rootAgentId
        if (!hasRecent) continue
        lanes.push({
          sessionId: sid,
          agentId: a.id,
          label: a.id === s.rootAgentId ? (sessionIds.length > 1 ? s.meta.project ?? 'main' : 'main') : a.name,
          color: harnessInfo(s.harness).color,
          status: a.status,
          depth: a.depth,
        })
      }
    }
    const maxLanes = Math.max(1, Math.floor((cssH - 22) / LANE_H))
    const shown = lanes.slice(0, maxLanes)
    const plotW = cssW - LABEL_W - 12
    const start = now - this.windowMs
    const xOf = (ts: number) => LABEL_W + ((ts - start) / this.windowMs) * plotW

    // Grid
    ctx.font = '10px ui-monospace, "Cascadia Code", Menlo, Consolas, monospace'
    ctx.textBaseline = 'top'
    const step = this.windowMs <= 60_000 ? 10_000 : this.windowMs <= 180_000 ? 30_000 : this.windowMs <= 600_000 ? 60_000 : 300_000
    for (let ts = Math.ceil(start / step) * step; ts <= now; ts += step) {
      const x = xOf(ts)
      ctx.strokeStyle = 'rgba(140,160,190,0.08)'
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, cssH)
      ctx.stroke()
      const ago = Math.round((now - ts) / 1000)
      ctx.fillStyle = 'rgba(140,160,190,0.5)'
      ctx.textAlign = 'center'
      ctx.fillText(ago === 0 ? 'now' : ago < 60 ? `-${ago}s` : `-${Math.round(ago / 60)}m`, x, cssH - 13)
    }

    this.hits = []
    shown.forEach((lane, i) => {
      const y = 4 + i * LANE_H
      const s = world.sessions[lane.sessionId]!
      // Label
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = STATUS_COLOR[lane.status as keyof typeof STATUS_COLOR] ?? '#6b7789'
      ctx.beginPath()
      ctx.arc(10 + lane.depth * 10, y + LANE_H / 2, 3, 0, Math.PI * 2)
      ctx.fill()
      ctx.font = '500 11px system-ui, -apple-system, "Segoe UI", sans-serif'
      ctx.fillStyle = lane.depth === 0 ? alpha(lane.color, 0.95) : '#aab6c8'
      ctx.fillText(clip(lane.label, 18 - lane.depth), 18 + lane.depth * 10, y + LANE_H / 2)
      // Lane background
      ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.015)' : 'rgba(255,255,255,0.03)'
      ctx.fillRect(LABEL_W, y, plotW, LANE_H - 2)
      // Bars
      for (const id of s.toolOrder) {
        const t = s.tools[id]
        if (!t || t.agentId !== lane.agentId) continue
        const end = t.endedAt ?? now
        if (end < start) continue
        const x1 = Math.max(LABEL_W, xOf(t.startedAt))
        const x2 = Math.max(x1 + 3, xOf(end))
        const color = categoryColor(t.category)
        const bad = t.ok === false
        ctx.fillStyle = alpha(bad ? '#ff5d73' : color, t.endedAt === undefined ? 0.95 : 0.7)
        roundRect(ctx, x1, y + 3, x2 - x1, LANE_H - 8, 3)
        ctx.fill()
        if (t.endedAt === undefined) {
          ctx.fillStyle = alpha('#ffffff', 0.35 + 0.35 * Math.sin(now / 150))
          ctx.fillRect(x2 - 2, y + 3, 2, LANE_H - 8)
        }
        this.hits.push({ x: x1, y: y + 2, w: x2 - x1, h: LANE_H - 6, tool: t, sessionId: lane.sessionId })
      }
      // Marks
      for (const m of marks) {
        if (m.sessionId !== lane.sessionId || m.agentId !== lane.agentId || m.ts < start) continue
        const x = xOf(m.ts)
        ctx.fillStyle = m.kind === 'user' ? '#ffffff' : m.kind === 'turn-ok' ? '#4fe39b' : m.kind === 'spawn' ? '#ffd166' : '#ff5d73'
        ctx.beginPath()
        if (m.kind === 'user') {
          ctx.moveTo(x, y + 1); ctx.lineTo(x + 4, y + LANE_H / 2); ctx.lineTo(x, y + LANE_H - 3); ctx.lineTo(x - 4, y + LANE_H / 2)
        } else {
          ctx.arc(x, y + LANE_H / 2 - 1, 2.6, 0, Math.PI * 2)
        }
        ctx.fill()
      }
    })
    if (lanes.length > shown.length) {
      ctx.fillStyle = 'rgba(140,160,190,0.6)'
      ctx.textAlign = 'left'
      ctx.fillText(`+${lanes.length - shown.length} more agents`, 12, cssH - 12)
    }

    // Now line
    ctx.strokeStyle = 'rgba(79,227,155,0.5)'
    ctx.beginPath()
    ctx.moveTo(xOf(now), 0)
    ctx.lineTo(xOf(now), cssH - 16)
    ctx.stroke()

    // Hover
    const m = this.mouse
    this.hover = this.hits.find((b) => m.x >= b.x - 2 && m.x <= b.x + b.w + 2 && m.y >= b.y && m.y <= b.y + b.h)
    this.canvas.style.cursor = this.hover ? 'pointer' : 'default'
    if (this.hover) {
      const t = this.hover.tool
      const dur = (t.endedAt ?? now) - t.startedAt
      this.tooltip.hidden = false
      this.tooltip.textContent = `${t.title} · ${t.endedAt === undefined ? 'running' : t.ok ? 'ok' : 'failed'} · ${(dur / 1000).toFixed(1)}s`
      const r = this.canvas.getBoundingClientRect()
      this.tooltip.style.left = `${Math.min(r.left + m.x + 12, window.innerWidth - 320)}px`
      this.tooltip.style.top = `${r.top + m.y - 30}px`
    } else if (m.x >= 0) {
      this.tooltip.hidden = true
    }
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  r = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}


