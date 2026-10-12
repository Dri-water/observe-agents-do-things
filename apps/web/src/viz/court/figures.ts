/** Ministers, the emperor, the palace cat, and everything drawn over them (name tags, bubbles, chips). */
import type { Activity, SessionState } from '@oadt/protocol'
import { clip } from '@oadt/protocol'
import { CATEGORY } from '../../shared/theme'
import { LOOKS } from '../../shared/buddy'
import { alpha, shade } from '../../shared/color'
import { clamp } from '../../shared/dom'
import { blobArt, blobMotion, drawBlob, type BlobArt, type Motion } from '../office/blob'
import { iso, roundRect, wrapText, type Pt } from '../office/iso'
import { activityOf, THRONE, type Cat, type Minister } from './model'
import { FONT, KAI, rankOf, titleOf, type Lang, type Palette } from './palette'

export interface FigureCtx { pal: Palette; day: number; now: number; hc: string; throne: 'empty' | 'emperor' }
export interface FigurePos { head: Pt; foot: Pt }

/** Head positions from this frame, so memorials can follow their author. */
export const heads = new Map<string, Pt>()

/** Rendered height of a blob's 100-unit viewBox, in scene px. */
const BLOB = 58
const LEAD = 66
const HAT = '#1c1a1e'
const IVORY = '#f1e7cc'

/** Body motion: the shared blob motion, adapted to court manners. */
function courtMotion(m: Minister, activity: Activity, t: number, now: number, presenting: boolean): Motion {
  const walking = m.mode === 'walking'
  const mo = blobMotion(presenting ? 'idle' : activity, walking, t, m.phase)
  if (m.mode === 'kneeling' || m.mode === 'resting') {
    mo.dy = Math.max(mo.dy * 0.35, -4); mo.rot *= 0.6; mo.dx *= 0.5
    mo.sy *= 0.93; mo.sx *= 1.05
  }
  if (presenting) {
    // Bow toward the throne, tablet raised, with a slow breathing bob.
    mo.rot = -(0.16 + 0.03 * Math.sin(t * 2.4 + m.phase))
    mo.dy = 1 + Math.sin(t * 2.4 + m.phase)
  }
  if (now < m.bowUntil) {
    const k = Math.sin(((m.bowUntil - now) / 1400) * Math.PI)
    mo.rot = -0.42 * k
    mo.dy = 2 * k
  }
  return mo
}

export function drawMinister(ctx: CanvasRenderingContext2D, fig: FigureCtx, m: Minister, act: ReturnType<typeof activityOf>, z: number, focus: boolean): FigurePos {
  const { now, pal, day } = fig
  const activity = act.activity
  const presenting = m.mode === 'presenting' || (activity === 'waiting' && m.mode === 'kneeling')
  const foot = iso(m.x, m.y, z + (m.mode === 'kneeling' || m.mode === 'resting' ? 0.01 : 0))
  const t = now / 1000
  ctx.save()
  ctx.globalAlpha = m.alpha

  if (activity === 'waiting') {
    // A golden pool on the floor, pulsing: someone is presenting a matter.
    const k = (now % 1500) / 1500
    const f = iso(m.x, m.y, z)
    ctx.strokeStyle = `rgba(232,176,74,${0.95 - k * 0.85})`
    ctx.lineWidth = 2
    ctx.beginPath(); ctx.ellipse(f.x, f.y, 14 + k * 16, 7 + k * 8, 0, 0, Math.PI * 2); ctx.stroke()
    ctx.strokeStyle = 'rgba(232,176,74,0.55)'
    ctx.beginPath(); ctx.ellipse(f.x, f.y, 13, 6.5, 0, 0, Math.PI * 2); ctx.stroke()
  }
  if (focus) {
    const f = iso(m.x, m.y, z)
    ctx.strokeStyle = 'rgba(255,240,200,0.95)'
    ctx.setLineDash([4, 3])
    ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.ellipse(f.x, f.y, 19, 9.5, 0, 0, Math.PI * 2); ctx.stroke()
    ctx.setLineDash([])
  }

  const art = blobArt(m.seed, activity)
  const mo = courtMotion(m, activity, t, now, presenting)
  const size = (m.isRoot ? LEAD : BLOB) * (m.mode === 'resting' ? 0.8 : 1)
  const blink = now >= m.blinkAt && now < m.blinkAt + 140 ? 0.08 : activity === 'sleeping' ? 0.12 : 1
  const rank = rankOf(m.depth)
  const prop = presenting ? 'raised' : propFor(activity, m)
  drawBlob(ctx, art, foot.x, foot.y, {
    size, facing: m.facing, eyes: blink, sx: mo.sx, sy: mo.sy, rot: mo.rot, dx: mo.dx, dyExtra: mo.dy,
    dim: activity === 'sleeping' ? 1 : activity === 'idle' ? 0.25 : 0,
    lift: 1 - day,
    dress: {
      body: (c, a) => drawRobe(c, a, rank.color, m.isRoot, m.depth, pal),
      top: (c, a) => {
        drawHat(c, a, m.isRoot, activity === 'sleeping', m.mode === 'walking' ? Math.sin(t * 9 + m.phase) * 0.05 : 0)
        drawProp(c, a, prop, t, m.phase, pal)
        if (activity === 'failed') {
          // An ink blot on the robe.
          c.fillStyle = 'rgba(20,18,16,0.85)'
          const f = a.frame
          c.beginPath(); c.arc(f.cx - f.rx * 0.3, f.cy + f.ry * 0.05, 4.5, 0, Math.PI * 2); c.fill()
          c.beginPath(); c.arc(f.cx - f.rx * 0.18, f.cy + f.ry * 0.18, 2.2, 0, Math.PI * 2); c.fill()
        }
      },
    },
  })
  ctx.restore()

  const s = size / 100
  const top = foot.y - (art.bottom - (art.frame.cy - art.frame.ry) - art.dy - mo.dy) * s * mo.sy - 8 * s
  return { head: { x: foot.x + mo.dx * s, y: top }, foot: { x: foot.x, y: foot.y + (m.mode === 'kneeling' || m.mode === 'resting' ? 3 : 0) } }
}

type Prop = 'hu' | 'raised' | 'brush' | 'scroll' | 'slips' | 'abacus' | 'tally' | 'tea' | 'none'

function propFor(activity: Activity, m: Minister): Prop {
  if (m.mode === 'resting') return 'tea'
  if (m.mode === 'walking' || m.mode === 'standing') return 'hu'
  switch (activity) {
    case 'editing': case 'writing': return 'brush'
    case 'reading': return 'scroll'
    case 'searching': return 'slips'
    case 'running': return 'abacus'
    case 'delegating': return 'tally'
    case 'sleeping': case 'thinking': case 'planning': case 'browsing': return 'none'
    default: return 'hu'
  }
}

/** The robe: the lower body in the rank colour, with a belt and (for high ranks) a fish pouch. */
function drawRobe(ctx: CanvasRenderingContext2D, art: BlobArt, color: string, lead: boolean, depth: number, pal: Palette): void {
  const f = art.frame
  const belt = f.cy + f.ry * 0.36
  ctx.clip(art.body[0]!.path)
  const g = ctx.createLinearGradient(0, belt, 0, belt + f.ry)
  g.addColorStop(0, shade(color, 0.08))
  g.addColorStop(1, shade(color, -0.2))
  ctx.fillStyle = g
  ctx.fillRect(f.cx - f.rx * 2, belt, f.rx * 4, 100)
  // Round collar line suggestion and the fold of the robe.
  ctx.strokeStyle = alpha(shade(color, -0.35), 0.6)
  ctx.lineWidth = 1.4
  ctx.beginPath(); ctx.moveTo(f.cx + f.rx * 0.1, belt); ctx.quadraticCurveTo(f.cx + f.rx * 0.2, belt + f.ry * 0.4, f.cx + f.rx * 0.05, belt + f.ry); ctx.stroke()
  // Belt with jade plaques.
  ctx.fillStyle = lead ? pal.gold : '#2a2220'
  ctx.fillRect(f.cx - f.rx * 2, belt - 2.5, f.rx * 4, 5)
  ctx.fillStyle = lead ? '#fff1c4' : '#cfe3d4'
  for (let x = f.cx - f.rx; x < f.cx + f.rx; x += 9) ctx.fillRect(x, belt - 1.2, 4, 2.4)
  // Fish pouch (鱼袋): gold for the lead, silver for its direct ministers.
  if (depth <= 1) {
    ctx.fillStyle = depth === 0 ? '#e9c25a' : '#d6dbe0'
    const px = f.cx - f.rx * 0.55, py = belt + 9
    ctx.beginPath(); ctx.ellipse(px, py, 3, 5.5, 0.2, 0, Math.PI * 2); ctx.fill()
    ctx.beginPath(); ctx.moveTo(px - 2, py + 5); ctx.lineTo(px + 1, py + 9); ctx.lineTo(px + 3, py + 4); ctx.fill()
  }
}

/** The Song official's hat (展脚幞头): a black cap with long straight wings. */
function drawHat(ctx: CanvasRenderingContext2D, art: BlobArt, lead: boolean, askew: boolean, wobble: number): void {
  const f = art.frame
  const top = f.cy - f.ry
  ctx.translate(f.cx, top + f.ry * 0.1)
  ctx.rotate((askew ? 0.28 : 0) + wobble)
  const wing = f.rx * (lead ? 1.95 : 1.6)
  // Wings first, behind the cap.
  ctx.strokeStyle = HAT
  ctx.lineCap = 'round'
  ctx.lineWidth = 3
  ctx.beginPath(); ctx.moveTo(-wing, -1); ctx.lineTo(wing, -1); ctx.stroke()
  ctx.fillStyle = HAT
  for (const sx of [-1, 1]) {
    ctx.beginPath(); ctx.ellipse(sx * wing, -1, 6.5, 3.2, 0, 0, Math.PI * 2); ctx.fill()
    if (lead) { ctx.fillStyle = '#e9c25a'; ctx.beginPath(); ctx.ellipse(sx * wing, -1, 3, 1.2, 0, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = HAT }
  }
  // Cap: a low crown and a raised back.
  ctx.beginPath(); ctx.ellipse(0, -2, f.rx * 0.6, f.ry * 0.26, 0, Math.PI, 0); ctx.lineTo(f.rx * 0.6, 3); ctx.lineTo(-f.rx * 0.6, 3); ctx.closePath(); ctx.fill()
  ctx.beginPath(); ctx.ellipse(-f.rx * 0.06, -f.ry * 0.22, f.rx * 0.34, f.ry * 0.24, 0, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = 'rgba(255,255,255,0.22)'
  ctx.beginPath(); ctx.ellipse(-f.rx * 0.16, -f.ry * 0.3, f.rx * 0.12, f.ry * 0.07, -0.4, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = lead ? '#e9c25a' : '#3a3438'
  ctx.fillRect(-f.rx * 0.6, 0.5, f.rx * 1.2, 2.5)
}

function drawHu(ctx: CanvasRenderingContext2D, x: number, y: number, rot: number, len = 30): void {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(rot)
  ctx.fillStyle = 'rgba(0,0,0,0.18)'
  roundRect(ctx, -3, -len / 2 + 2, 8, len, 3); ctx.fill()
  const g = ctx.createLinearGradient(-4, 0, 4, 0)
  g.addColorStop(0, '#fbf5e4'); g.addColorStop(1, '#ddd0ad')
  ctx.fillStyle = g
  roundRect(ctx, -4, -len / 2, 8, len, 3.5); ctx.fill()
  ctx.strokeStyle = '#a8946a'; ctx.lineWidth = 0.8; ctx.stroke()
  ctx.restore()
}

function drawProp(ctx: CanvasRenderingContext2D, art: BlobArt, prop: Prop, t: number, phase: number, pal: Palette): void {
  const f = art.frame
  const fx = f.cx + f.rx * 0.4, fy = f.cy + f.ry * 0.3
  switch (prop) {
    case 'hu': drawHu(ctx, fx, fy, -0.22); break
    case 'raised': {
      const y = f.cy - f.ry * 0.62 + Math.sin(t * 2.4 + phase) * 1.5
      const g = ctx.createRadialGradient(fx, y, 0, fx, y, 26)
      g.addColorStop(0, 'rgba(255,214,120,0.6)'); g.addColorStop(1, 'rgba(255,214,120,0)')
      ctx.fillStyle = g
      ctx.fillRect(fx - 26, y - 26, 52, 52)
      drawHu(ctx, fx - 2, y, -0.08, 34)
      break
    }
    case 'brush': {
      const k = Math.sin(t * 15 + phase)
      const bx = fx + 4 + k * 2, by = fy + 6 + Math.abs(k) * 2
      ctx.strokeStyle = '#7a5a3a'; ctx.lineWidth = 2.6; ctx.lineCap = 'round'
      ctx.beginPath(); ctx.moveTo(bx - 4, by - 18); ctx.lineTo(bx, by); ctx.stroke()
      ctx.fillStyle = '#151515'
      ctx.beginPath(); ctx.ellipse(bx + 0.6, by + 3, 2, 4, -0.2, 0, Math.PI * 2); ctx.fill()
      break
    }
    case 'scroll': {
      const y = f.cy + f.ry * 0.5, w = f.rx * 1.3
      const sway = Math.sin(t * 2.4 + phase) * 1
      ctx.fillStyle = IVORY
      ctx.fillRect(f.cx - w / 2, y - 7 + sway, w, 14)
      ctx.strokeStyle = alpha(pal.ink, 0.6); ctx.lineWidth = 1
      for (let i = 1; i < 6; i++) { const x = f.cx - w / 2 + (i * w) / 6; ctx.beginPath(); ctx.moveTo(x, y - 4 + sway); ctx.lineTo(x, y + 4 + sway); ctx.stroke() }
      ctx.fillStyle = '#6b4a2e'
      ctx.fillRect(f.cx - w / 2 - 3, y - 9 + sway, 3.5, 18)
      ctx.fillRect(f.cx + w / 2 - 0.5, y - 9 + sway, 3.5, 18)
      break
    }
    case 'slips': {
      const k = Math.sin(t * 3 + phase) * 0.12
      ctx.save(); ctx.translate(fx + 2, fy); ctx.rotate(-0.15 + k)
      for (let i = 0; i < 5; i++) { ctx.fillStyle = i % 2 ? '#d9c38c' : '#e8d6a0'; ctx.fillRect(-10 + i * 4.2, -12, 3.6, 24) }
      ctx.fillStyle = '#7a2a1f'; ctx.fillRect(-10, -4, 21, 1.6); ctx.fillRect(-10, 5, 21, 1.6)
      ctx.restore()
      break
    }
    case 'abacus': {
      const y = f.cy + f.ry * 0.55
      ctx.fillStyle = '#5a3a24'
      ctx.fillRect(f.cx - 16, y - 9, 32, 18)
      ctx.fillStyle = '#e8d6a0'
      ctx.fillRect(f.cx - 14, y - 7, 28, 14)
      ctx.fillStyle = '#5a3a24'; ctx.fillRect(f.cx - 14, y - 3, 28, 1.4)
      for (let i = 0; i < 6; i++) {
        const x = f.cx - 12 + i * 4.8
        const flick = Math.sin(t * 20 + i * 1.7 + phase) > 0.6 ? -2 : 0
        ctx.fillStyle = '#7a2a1f'
        ctx.beginPath(); ctx.ellipse(x, y - 5 + flick * 0.3, 1.9, 1.3, 0, 0, Math.PI * 2); ctx.fill()
        ctx.beginPath(); ctx.ellipse(x, y + 3 + flick, 1.9, 1.3, 0, 0, Math.PI * 2); ctx.fill()
      }
      break
    }
    case 'tally': {
      // Half a tiger tally (虎符), raised to dispatch an order.
      const y = f.cy - f.ry * 0.3 + Math.sin(t * 3.5 + phase) * 2
      ctx.save(); ctx.translate(fx + 3, y)
      ctx.fillStyle = '#d9a441'
      ctx.beginPath(); ctx.ellipse(0, 0, 11, 5.5, 0, Math.PI, 0); ctx.lineTo(11, 2); ctx.lineTo(-11, 2); ctx.closePath(); ctx.fill()
      ctx.beginPath(); ctx.arc(10, -4, 3.5, 0, Math.PI * 2); ctx.fill()
      ctx.strokeStyle = '#7a5418'; ctx.lineWidth = 1
      for (const sx of [-6, -2, 2]) { ctx.beginPath(); ctx.moveTo(sx, -5); ctx.lineTo(sx + 1.5, 1); ctx.stroke() }
      ctx.restore()
      break
    }
    case 'tea': {
      ctx.fillStyle = '#9fc2b2'
      ctx.beginPath(); ctx.moveTo(fx - 6, fy - 2); ctx.lineTo(fx + 6, fy - 2); ctx.lineTo(fx + 3.5, fy + 6); ctx.lineTo(fx - 3.5, fy + 6); ctx.closePath(); ctx.fill()
      ctx.fillStyle = '#c8a86a'
      ctx.beginPath(); ctx.ellipse(fx, fy - 2, 6, 1.6, 0, 0, Math.PI * 2); ctx.fill()
      break
    }
    case 'none': break
  }
}

// ─── The emperor (optional) ──────────────────────────────────────────────

export function drawEmperor(ctx: CanvasRenderingContext2D, fig: FigureCtx, waiting: boolean, s: SessionState): void {
  const { now, day } = fig
  const finished = s.turn.endedAt !== undefined && !s.turn.active && now - s.turn.endedAt < 60_000 && s.turn.outcome === 'completed'
  const activity: Activity = waiting ? 'thinking' : finished ? 'finished' : s.status === 'working' ? 'idle' : 'sleeping'
  const art = blobArt('the-emperor', activity)
  const mo = blobMotion(activity === 'finished' ? 'idle' : activity, false, now / 1000, 0.7)
  const foot = iso(THRONE.x, THRONE.y - 0.05, 0.85)
  drawBlob(ctx, art, foot.x, foot.y, {
    size: 70, facing: 1, eyes: activity === 'sleeping' ? 0.12 : 1, sx: mo.sx * 1.04, sy: mo.sy * 0.95, rot: mo.rot * 0.4, dyExtra: Math.max(-3, mo.dy * 0.3),
    lift: 1 - day,
    dress: {
      body: (c, a) => drawRobe(c, a, '#e2ae2f', true, 0, fig.pal),
      top: (c, a) => {
        // The mian crown: a flat board with strings of jade beads.
        const f = a.frame
        const top = f.cy - f.ry
        c.fillStyle = '#1c1a1e'
        c.fillRect(f.cx - f.rx * 0.45, top - 4, f.rx * 0.9, 9)
        c.fillStyle = '#e9c25a'
        c.fillRect(f.cx - f.rx * 0.5, top + 3, f.rx, 2.4)
        c.fillStyle = '#1c1a1e'
        c.save(); c.translate(f.cx, top - 7); c.rotate(-0.05)
        c.fillRect(-f.rx * 0.95, -2.5, f.rx * 1.9, 5)
        c.fillStyle = '#e9c25a'; c.fillRect(-f.rx * 0.95, 1.5, f.rx * 1.9, 1.2)
        for (let i = 0; i < 6; i++) {
          const x = -f.rx * 0.88 + i * f.rx * 0.35
          c.strokeStyle = 'rgba(30,30,30,0.6)'; c.lineWidth = 0.6
          c.beginPath(); c.moveTo(x, 3); c.lineTo(x, 15); c.stroke()
          for (let b = 0; b < 3; b++) { c.fillStyle = b % 2 ? '#e14b3b' : '#cfe8d6'; c.beginPath(); c.arc(x, 6 + b * 4, 1.4, 0, Math.PI * 2); c.fill() }
        }
        c.restore()
      },
    },
  })
}

// ─── Overlays ────────────────────────────────────────────────────────────

export function nameLabel(m: Minister, lang: Lang): string {
  const title = titleOf(m.isRoot, m.role)
  if (m.isRoot) return lang === 'en' ? '★ Chancellor' : lang === 'zh' ? '★ 宰相' : '★ 宰相 lead'
  if (lang === 'en') return clip(m.name, 18)
  return `${title.zh} ${clip(m.name, lang === 'zh' ? 12 : 15)}`
}

const CN_ACT: Partial<Record<Activity, string>> = {
  thinking: '思', reading: '阅', searching: '查', editing: '改', writing: '书', running: '行', browsing: '探', delegating: '遣', planning: '谋', tooling: '用', asking: '问', waiting: '奏', failed: '误', finished: '毕', aborted: '止', idle: '闲', sleeping: '眠',
}

export function drawOverlay(ctx: CanvasRenderingContext2D, origin: Pt, pos: FigurePos, m: Minister, act: ReturnType<typeof activityOf>, now: number, rs: { hovered?: string; selected?: string; labels: boolean; lang: Lang }, zoom: number): void {
  ctx.save()
  ctx.translate(origin.x, origin.y)
  ctx.globalAlpha = m.alpha
  const x = pos.head.x
  const y = pos.head.y - 4
  const focus = rs.hovered === m.id || rs.selected === m.id
  const rank = rankOf(m.depth)

  if ((rs.labels && m.mode !== 'resting') || focus) {
    ctx.font = `700 9.5px ${FONT}`
    const base = nameLabel(m, rs.lang)
    const label = focus ? `${base} · ${LOOKS[act.activity].label}` : base
    const w = ctx.measureText(label).width + 14
    const ty = pos.foot.y + 5
    roundRect(ctx, x - w / 2, ty, w, 14, 3)
    ctx.fillStyle = focus ? shade(rank.color, -0.35) : alpha(shade(rank.color, -0.3), 0.86)
    ctx.fill()
    ctx.strokeStyle = alpha('#e9c25a', focus ? 0.9 : 0.45)
    ctx.lineWidth = 0.8
    ctx.stroke()
    ctx.fillStyle = '#ffffff'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, x, ty + 7.5)
    ctx.textAlign = 'left'
  }

  if (act.activity === 'sleeping' && !m.bubble) {
    ctx.fillStyle = '#a7b0ff'
    ctx.font = `800 11px ${FONT}`
    const k = (now % 2400) / 2400
    ctx.globalAlpha = m.alpha * (1 - k)
    ctx.fillText('z', x + 10 + k * 8, y - k * 18)
    ctx.fillText('z', x + 16 + k * 10, y - 8 - k * 22)
    ctx.globalAlpha = m.alpha
  }

  const bubble = m.bubble && now >= m.bubble.born ? m.bubble : undefined
  if (bubble) {
    drawScrollBubble(ctx, x, y, bubble.text, bubble.tone, (now - bubble.born) / bubble.ttl, rs.lang)
  } else if (act.activity === 'waiting') {
    // 启奏: a gold seal with a bell, and what is being asked.
    const b = Math.abs(Math.sin(now / 280)) * 4
    ctx.fillStyle = 'rgba(0,0,0,0.18)'
    ctx.fillRect(x - 9, y - 23 - b, 20, 20)
    ctx.fillStyle = '#e8b04a'
    ctx.fillRect(x - 10, y - 24 - b, 20, 20)
    ctx.strokeStyle = '#7a4b0a'
    ctx.lineWidth = 1
    ctx.strokeRect(x - 8, y - 22 - b, 16, 16)
    ctx.fillStyle = '#3a2600'
    ctx.font = `900 ${rs.lang === 'en' ? 13 : 12}px ${rs.lang === 'en' ? FONT : KAI}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(rs.lang === 'en' ? '!' : '奏', x, y - 13.5 - b)
    ctx.textAlign = 'left'
    if (act.tool && (focus || zoom > 1.0)) slip(ctx, x, y - 30 - b, `${rs.lang === 'en' ? 'needs you' : '启奏'} · ${act.tool.title}`, '#e8b04a', focus ? 46 : 30)
  } else if (act.activity === 'asking') {
    const b = Math.abs(Math.sin(now / 400)) * 3
    slip(ctx, x + 8, y - 6 - b, rs.lang === 'en' ? '? a question for you' : '问 · a question', '#5aa9ff', 30)
  } else if (act.activity === 'thinking' || act.activity === 'planning') {
    drawThoughtSmoke(ctx, x + 10, y - 4, now, act.activity === 'planning')
  } else if (act.tool) {
    const cat = CATEGORY[act.tool.category]
    slip(ctx, x, y - 8, `${cat?.glyph ?? '•'} ${act.tool.title}`, cat?.color ?? '#9aa3b5', focus || zoom > 1.25 ? 46 : 22, rs.lang === 'en' ? undefined : CN_ACT[act.activity])
  }
  ctx.restore()
}

/** A paper slip (签) tag: a coloured band, an optional character, the text. */
function slip(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string, max = 30, char?: string): void {
  ctx.font = `700 9.5px ${FONT}`
  const label = clip(text, max)
  const cw = char ? 13 : 0
  const w = ctx.measureText(label).width + 16 + cw
  const x0 = x - w / 2
  ctx.fillStyle = 'rgba(40,20,10,0.16)'
  ctx.fillRect(x0 + 1.5, y - 14.5, w, 16)
  ctx.fillStyle = '#fbf4e2'
  ctx.fillRect(x0, y - 16, w, 16)
  ctx.fillStyle = color
  ctx.fillRect(x0, y - 16, 3.5, 16)
  ctx.strokeStyle = alpha(shade(color, -0.3), 0.6)
  ctx.lineWidth = 0.8
  ctx.strokeRect(x0 + 0.4, y - 15.6, w - 0.8, 15.2)
  if (char) {
    ctx.fillStyle = '#b3261e'
    ctx.fillRect(x0 + 6, y - 13.5, 11, 11)
    ctx.fillStyle = '#fff'
    ctx.font = `700 8.5px ${KAI}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(char, x0 + 11.5, y - 7.6)
    ctx.font = `700 9.5px ${FONT}`
  }
  ctx.fillStyle = '#3a2a20'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, x + cw / 2 + 1, y - 7.5)
  ctx.textAlign = 'left'
}

/** Incense smoke curling up into a cloud scroll, with dots bubbling inside. */
function drawThoughtSmoke(ctx: CanvasRenderingContext2D, x: number, y: number, now: number, planning: boolean): void {
  ctx.save()
  ctx.strokeStyle = 'rgba(160,140,200,0.6)'
  ctx.lineWidth = 1.4
  ctx.lineCap = 'round'
  ctx.beginPath()
  for (let k = 0; k <= 12; k++) {
    const yy = y - k * 1.5
    const xx = x - 4 + Math.sin(k * 0.8 + now / 300) * 2.5
    if (k === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy)
  }
  ctx.stroke()
  // The cloud.
  const cx = x + 10, cy = y - 28
  ctx.fillStyle = '#fbf6ec'
  ctx.strokeStyle = planning ? '#a9b6c8' : '#b9a3e6'
  ctx.lineWidth = 1.4
  ctx.beginPath()
  ctx.arc(cx - 10, cy + 2, 7, Math.PI * 0.5, Math.PI * 1.5)
  ctx.arc(cx - 2, cy - 4, 8, Math.PI, Math.PI * 1.9)
  ctx.arc(cx + 10, cy + 0, 7, Math.PI * 1.4, Math.PI * 0.5)
  ctx.closePath()
  ctx.fill(); ctx.stroke()
  // Curl.
  ctx.beginPath()
  for (let k = 0; k < 18; k++) {
    const a = k * 0.45, r = 5 - k * 0.25
    const px = cx + 13 + Math.cos(a) * r, py = cy + 6 + Math.sin(a) * r * 0.8
    if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py)
  }
  ctx.stroke()
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = planning ? '#6f84a3' : '#8d6ad8'
    ctx.beginPath(); ctx.arc(cx - 8 + i * 8, cy - 0.5 - Math.max(0, Math.sin(now / 300 - i * 0.7)) * 3, 2, 0, Math.PI * 2); ctx.fill()
  }
  ctx.restore()
}

/** A speech bubble as a small hand scroll with wooden rollers. */
function drawScrollBubble(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, tone: string, k: number, lang: Lang): void {
  const fade = k < 0.06 ? k / 0.06 : k > 0.88 ? (1 - k) / 0.12 : 1
  ctx.globalAlpha *= clamp(fade, 0, 1)
  ctx.font = `600 10.5px ${FONT}`
  const shown = text.slice(0, Math.max(1, Math.floor(clamp(k * 6, 0, 1) * Math.min(text.length, 140))))
  const lines = wrapText(ctx, shown, 170, 3)
  const unroll = easeOutBack(clamp(k * 8, 0, 1))
  const w = (Math.max(40, ...lines.map((l) => ctx.measureText(l).width)) + 22) * unroll
  const h = lines.length * 14 + 12
  const bx = x - w / 2, by = y - h - 14
  const paper = tone === 'user' ? '#f9e9a8' : '#fbf4e2'
  const edge = tone === 'user' ? '#b3261e' : tone === 'task' ? '#d6a645' : '#8a6d4a'
  ctx.fillStyle = 'rgba(40,20,10,0.18)'
  ctx.fillRect(bx + 2, by + 3, w, h)
  ctx.fillStyle = paper
  ctx.fillRect(bx, by, w, h)
  ctx.strokeStyle = alpha(edge, 0.7)
  ctx.lineWidth = 1
  ctx.strokeRect(bx + 3, by + 2.5, w - 6, h - 5)
  // Tail.
  ctx.fillStyle = paper
  ctx.beginPath(); ctx.moveTo(x - 5, by + h); ctx.lineTo(x, by + h + 8); ctx.lineTo(x + 5, by + h); ctx.fill()
  // Rollers.
  for (const rx of [bx - 3, bx + w - 1]) {
    ctx.fillStyle = '#6b4a2e'
    roundRect(ctx, rx, by - 3, 4, h + 6, 2); ctx.fill()
    ctx.fillStyle = '#d6a645'
    ctx.fillRect(rx, by - 4, 4, 2); ctx.fillRect(rx, by + h + 2, 4, 2)
  }
  if (unroll > 0.95) {
    ctx.fillStyle = '#3a2a20'
    ctx.textBaseline = 'top'
    ctx.font = `600 10.5px ${FONT}`
    lines.forEach((l, i) => ctx.fillText(l, bx + 11, by + 7 + i * 14))
  }
  if (tone === 'user') {
    const label = lang === 'en' ? 'EDICT · FROM YOU' : lang === 'zh' ? '圣谕' : '圣谕 · FROM YOU'
    ctx.font = `800 8px ${FONT}`
    const lw = ctx.measureText(label).width + 8
    ctx.fillStyle = '#b3261e'
    ctx.fillRect(bx + 6, by - 13, lw, 11)
    ctx.fillStyle = '#fff3c4'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, bx + 10, by - 7.2)
  }
}

function easeOutBack(k: number): number {
  const c1 = 1.4, c3 = c1 + 1
  return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2)
}

// ─── The palace cat (狸奴) ───────────────────────────────────────────────

export function drawCat(ctx: CanvasRenderingContext2D, cat: Cat, now: number): void {
  const p = iso(cat.x, cat.y, 0)
  const napping = now < cat.napUntil
  const walking = cat.path.length > 0
  ctx.save()
  ctx.translate(p.x, p.y)
  ctx.scale(cat.facing, 1)
  // A white cat with ginger patches, as in Song paintings.
  const fur = '#f6f0e4', patch = '#e39a4f', dark = shade(fur, -0.18)
  ctx.fillStyle = fur
  if (napping) {
    ctx.beginPath(); ctx.ellipse(0, -5, 10, 6, 0, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = patch
    ctx.beginPath(); ctx.ellipse(-3, -7, 5, 3.4, 0.3, 0, Math.PI * 2); ctx.fill()
    ctx.strokeStyle = patch; ctx.lineWidth = 3; ctx.lineCap = 'round'
    ctx.beginPath(); ctx.moveTo(-8, -4); ctx.quadraticCurveTo(-14, -2, -9, 0.5); ctx.stroke()
    ctx.fillStyle = fur
    ctx.beginPath(); ctx.arc(7, -6, 4.5, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = patch
    ctx.beginPath(); ctx.moveTo(4, -9); ctx.lineTo(4.5, -13); ctx.lineTo(7, -10); ctx.fill()
    ctx.beginPath(); ctx.moveTo(8, -10); ctx.lineTo(10.5, -13); ctx.lineTo(11, -9); ctx.fill()
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
    ctx.fillStyle = patch
    ctx.beginPath(); ctx.ellipse(-3, -10 + bob, 5, 3.2, 0.2, 0, Math.PI * 2); ctx.fill()
    ctx.strokeStyle = patch; ctx.lineWidth = 2.6; ctx.lineCap = 'round'
    ctx.beginPath(); ctx.moveTo(-8, -9); ctx.quadraticCurveTo(-15, -14 + Math.sin(now / 300) * 3, -12, -21); ctx.stroke()
    ctx.fillStyle = fur
    ctx.beginPath(); ctx.arc(9, -13 + bob, 5, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = patch
    ctx.beginPath(); ctx.moveTo(5.5, -16 + bob); ctx.lineTo(6.5, -21 + bob); ctx.lineTo(9, -17 + bob); ctx.fill()
    ctx.fillStyle = fur
    ctx.beginPath(); ctx.moveTo(10, -17 + bob); ctx.lineTo(12.5, -21 + bob); ctx.lineTo(13.5, -15 + bob); ctx.fill()
    ctx.fillStyle = '#3a2a2a'
    ctx.fillRect(10, -14 + bob, 1.4, 1.6)
    ctx.fillRect(12.4, -14 + bob, 1.4, 1.6)
    ctx.fillStyle = '#e07a9a'
    ctx.fillRect(13.2, -11.5 + bob, 1.4, 1)
    // A red ribbon with a little bell.
    ctx.fillStyle = '#c0392b'
    ctx.fillRect(6.5, -10 + bob, 5, 1.6)
    ctx.fillStyle = '#e9c25a'
    ctx.beginPath(); ctx.arc(9, -7.6 + bob, 1.3, 0, Math.PI * 2); ctx.fill()
  }
  ctx.restore()
}
