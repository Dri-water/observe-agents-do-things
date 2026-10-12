/** Court flourishes: edicts, bamboo slips, ink, seals, tallies, pigeons, plum blossom and memorials. */
import { CATEGORY } from '../../shared/theme'
import { alpha } from '../../shared/color'
import { clamp } from '../../shared/dom'
import { easeInOut, easeOut, iso, roundRect, type Pt } from '../office/iso'
import { MEMO_FLY_MS, type Court, type Effect, type Hall } from './model'
import { FONT, KAI, MONO } from './palette'
import { heads } from './figures'

const byHall = new WeakMap<Hall, Effect[]>()

export function groupEffects(court: Court): void {
  for (const h of court.halls.values()) byHall.set(h, [])
  for (const e of court.effects) {
    const h = court.halls.get(e.hall)
    if (h) byHall.get(h)?.push(e)
  }
}

export function drawEffects(ctx: CanvasRenderingContext2D, hall: Hall, now: number, origin: Pt, fileTarget: Pt | undefined): void {
  const target = fileTarget ? { x: fileTarget.x - origin.x, y: fileTarget.y - origin.y } : undefined
  // Memorials go over the other flourishes so their text stays readable.
  const effects = byHall.get(hall) ?? []
  for (const e of effects) if (e.kind !== 'memorial') drawEffect(ctx, e, now)
  let stack = 0
  for (const e of effects) if (e.kind === 'memorial') { drawMemorial(ctx, hall, e, now, target, stack); stack++ }
}

const OP_COLOR = { edit: CATEGORY.edit.color, write: CATEGORY.write.color, delete: CATEGORY.shell.color } as const
const INK = '#2a2420'
const VERMILION = '#b3261e'

/** A diff written out as a memorial (奏折) beside its author: new lines in black ink, removed lines struck in vermilion. Stamped 准, then filed. */
function drawMemorial(ctx: CanvasRenderingContext2D, hall: Hall, e: Extract<Effect, { kind: 'memorial' }>, now: number, target: Pt | undefined, stack: number): void {
  if (now < e.born) return
  const age = now - e.born
  const head = heads.get(`${hall.id}/${e.agentId}`) ?? iso(e.at.x, e.at.y, e.at.z)
  const anchor = { x: head.x + 16, y: head.y - 40 - stack * 10 }
  const flyK = clamp((age - e.typeMs - e.holdMs) / MEMO_FLY_MS, 0, 1)
  const typedChars = Math.floor(e.chars * easeOut(clamp(age / e.typeMs, 0, 1)))
  const W = 200, LH = 11.5, HEAD = 18
  let reached = 0, budget = typedChars
  for (const l of e.lines) { if (budget <= 0 && reached > 0 && typedChars < e.chars) break; reached++; budget -= l.length }
  const H = HEAD + Math.max(1, reached) * LH + 7
  const color = OP_COLOR[e.op] ?? CATEGORY.edit.color

  ctx.save()
  if (flyK > 0) {
    const to = target ?? { x: anchor.x + 300, y: anchor.y + 300 }
    const t = easeInOut(flyK)
    const px = anchor.x + (to.x - anchor.x) * t
    const py = anchor.y + (to.y - anchor.y) * t - Math.sin(t * Math.PI) * 60
    const sc = 1 - 0.8 * t
    ctx.globalAlpha *= 1 - 0.85 * t
    ctx.translate(px, py)
    ctx.scale(sc, sc)
    ctx.rotate(t * 0.3)
    ctx.translate(-anchor.x, -anchor.y)
  } else {
    const k = easeOut(clamp(age / 240, 0, 1))
    ctx.globalAlpha *= k
    ctx.translate(anchor.x, anchor.y + H)
    ctx.scale(0.85 + 0.15 * k, 0.85 + 0.15 * k)
    ctx.translate(-anchor.x, -anchor.y - H)
  }
  const bx = anchor.x, by = anchor.y - H
  ctx.fillStyle = 'rgba(40,20,10,0.2)'
  ctx.fillRect(bx + 2, by + 3, W, H)
  ctx.fillStyle = '#fbf4e2'
  ctx.fillRect(bx, by, W, H)
  // Folded-memorial creases.
  ctx.strokeStyle = 'rgba(120,90,50,0.12)'
  ctx.lineWidth = 1
  for (let x = bx + 40; x < bx + W; x += 40) { ctx.beginPath(); ctx.moveTo(x, by); ctx.lineTo(x, by + H); ctx.stroke() }
  ctx.strokeStyle = alpha(color, 0.9)
  ctx.lineWidth = 1.4
  ctx.strokeRect(bx + 0.7, by + 0.7, W - 1.4, H - 1.4)
  if (flyK === 0) {
    ctx.fillStyle = '#fbf4e2'
    ctx.beginPath(); ctx.moveTo(bx + 2, by + H - 4); ctx.lineTo(bx - 9, by + H + 8); ctx.lineTo(bx + 12, by + H - 1); ctx.closePath(); ctx.fill()
    ctx.strokeStyle = alpha(color, 0.9)
    ctx.beginPath(); ctx.moveTo(bx + 2, by + H - 3); ctx.lineTo(bx - 9, by + H + 8); ctx.lineTo(bx + 12, by + H - 0.7); ctx.stroke()
  }
  ctx.save()
  ctx.beginPath(); ctx.rect(bx, by, W, H); ctx.clip()
  ctx.fillStyle = alpha(color, 0.16)
  ctx.fillRect(bx, by, W, HEAD)
  ctx.fillStyle = color
  ctx.fillRect(bx + 6, by + 5, 8, 8)
  ctx.fillStyle = '#fff'
  ctx.font = `700 6.5px ${KAI}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(e.op === 'write' ? '新' : e.op === 'delete' ? '删' : '改', bx + 10, by + 9.3)
  ctx.textAlign = 'left'
  ctx.font = `700 9.5px ${MONO}`
  const del = `−${e.removed}`, add = `+${e.added}`
  const delW = ctx.measureText(del).width, addW = ctx.measureText(add).width
  ctx.fillStyle = VERMILION
  ctx.fillText(del, bx + W - 8 - delW, by + HEAD / 2)
  ctx.fillStyle = '#1f6a40'
  ctx.fillText(add, bx + W - 12 - delW - addW, by + HEAD / 2)
  ctx.fillStyle = INK
  ctx.font = `700 9.5px ${FONT}`
  const pathMax = W - 32 - delW - addW
  let path = e.op === 'delete' ? `delete ${shortName(e.path)}` : shortName(e.path)
  while (path.length > 4 && ctx.measureText(path).width > pathMax) path = '…' + path.slice(2)
  ctx.fillText(path, bx + 19, by + HEAD / 2)
  ctx.font = `9.5px ${MONO}`
  let left = typedChars
  let caret: Pt | undefined
  e.lines.forEach((l, i) => {
    const y0 = by + HEAD + 3 + i * LH
    const kind = l === '@' ? 'gap' : l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : 'ctx'
    const full = kind === 'gap' ? '⋯' : l.slice(1)
    const n = Math.min(l.length, Math.max(0, left))
    left -= l.length
    if (n <= 0 && flyK === 0 && typedChars < e.chars) return
    const shown = kind === 'gap' ? full : full.slice(0, Math.max(0, n - 1))
    if (kind === 'add') { ctx.fillStyle = 'rgba(46,125,79,0.1)'; ctx.fillRect(bx, y0 - 1, W, LH) }
    ctx.fillStyle = kind === 'add' ? INK : kind === 'del' ? VERMILION : kind === 'gap' ? '#a4977f' : '#7a6c58'
    const prefix = kind === 'add' ? '+' : kind === 'del' ? '−' : ' '
    ctx.fillText(prefix + shown, bx + 7, y0 + LH / 2)
    const tw = ctx.measureText(prefix + shown).width
    if (kind === 'del' && shown) {
      // Struck through with the vermilion brush (朱批).
      ctx.strokeStyle = alpha(VERMILION, 0.8)
      ctx.lineWidth = 1.2
      ctx.beginPath(); ctx.moveTo(bx + 14, y0 + LH / 2 + 0.5); ctx.quadraticCurveTo(bx + 7 + tw / 2, y0 + LH / 2 - 1, bx + 9 + tw, y0 + LH / 2 + 0.8); ctx.stroke()
    }
    if (n < l.length && n > 0) caret = { x: bx + 7 + tw + 1, y: y0 + 1 }
  })
  if (caret && flyK === 0) {
    // The brush tip as caret.
    ctx.fillStyle = INK
    ctx.beginPath(); ctx.ellipse(caret.x + 1, caret.y + 4, 1.4, 3.6, 0.3, 0, Math.PI * 2); ctx.fill()
  }
  ctx.restore()
  // 准 seal during the hold.
  if (age > e.typeMs + e.holdMs * 0.3 && flyK === 0) {
    const k = easeOut(clamp((age - e.typeMs - e.holdMs * 0.3) / 200, 0, 1))
    ctx.save()
    ctx.translate(bx + W - 22, by + H - 13)
    ctx.rotate(-0.12)
    ctx.scale(1.6 - 0.6 * k, 1.6 - 0.6 * k)
    ctx.globalAlpha *= k * 0.92
    ctx.fillStyle = VERMILION
    roundRect(ctx, -10, -10, 20, 20, 2); ctx.fill()
    ctx.strokeStyle = '#fbf4e2'
    ctx.lineWidth = 0.8
    ctx.strokeRect(-8, -8, 16, 16)
    ctx.fillStyle = '#fbf4e2'
    ctx.font = `700 12px ${KAI}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('准', 0, 0.8)
    ctx.restore()
  }
  ctx.restore()
}

function shortName(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('/')
}

function drawEffect(ctx: CanvasRenderingContext2D, e: Effect, now: number): void {
  if (now < e.born) return
  const k = clamp((now - e.born) / e.dur, 0, 1)
  ctx.save()
  switch (e.kind) {
    case 'edict': {
      // An imperial edict scroll glides down from the throne.
      const t = easeInOut(k)
      const at = (tt: number) => iso(e.from.x + (e.to.x - e.from.x) * tt, e.from.y + (e.to.y - e.from.y) * tt, e.from.z + (e.to.z - e.from.z) * tt + Math.sin(tt * Math.PI) * 1.2)
      const p = at(t)
      for (let i = 1; i < 9; i++) {
        const q = at(Math.max(0, t - i * 0.03))
        ctx.fillStyle = `rgba(240,200,90,${0.6 - i * 0.065})`
        ctx.beginPath(); ctx.arc(q.x, q.y, 2.2 - i * 0.15, 0, Math.PI * 2); ctx.fill()
      }
      ctx.translate(p.x, p.y)
      ctx.rotate(Math.sin(k * 9) * 0.12)
      ctx.globalAlpha = k > 0.9 ? (1 - k) * 10 : 1
      ctx.fillStyle = 'rgba(0,0,0,0.18)'
      ctx.fillRect(-11, -5, 24, 12)
      ctx.fillStyle = '#f2c94c'
      ctx.fillRect(-12, -6, 24, 12)
      ctx.fillStyle = '#8a5a14'
      ctx.fillRect(-14, -7.5, 3, 15); ctx.fillRect(11, -7.5, 3, 15)
      ctx.fillStyle = VERMILION
      ctx.fillRect(-2, -6, 3, 12)
      ctx.strokeStyle = 'rgba(120,70,0,0.5)'
      ctx.lineWidth = 0.8
      for (const x of [-8, -5, 4, 7]) { ctx.beginPath(); ctx.moveTo(x, -3.5); ctx.lineTo(x, 3.5); ctx.stroke() }
      break
    }
    case 'slip': {
      const t = easeInOut(k)
      const p = iso(e.from.x + (e.to.x - e.from.x) * t, e.from.y + (e.to.y - e.from.y) * t, e.from.z + (e.to.z - e.from.z) * t + Math.sin(t * Math.PI) * 1.2)
      ctx.translate(p.x, p.y)
      ctx.rotate(Math.sin(k * 10) * 0.5)
      ctx.fillStyle = 'rgba(0,0,0,0.14)'
      ctx.fillRect(-5, -6, 12, 14)
      for (let i = 0; i < 4; i++) {
        ctx.fillStyle = i % 2 ? e.color : '#d6c08a'
        ctx.fillRect(-6 + i * 3.2, -7, 2.8, 14)
      }
      ctx.fillStyle = '#7a2a1f'
      ctx.fillRect(-6, -3, 12.6, 1.2); ctx.fillRect(-6, 3, 12.6, 1.2)
      break
    }
    case 'ink': {
      // Spilled ink spreading across the desk and floor.
      const p = iso(e.at.x, e.at.y, e.at.z)
      const spread = easeOut(clamp(k * 3, 0, 1))
      ctx.globalAlpha = k > 0.6 ? (1 - k) / 0.4 : 1
      ctx.fillStyle = 'rgba(18,16,15,0.9)'
      ctx.beginPath(); ctx.ellipse(p.x, p.y, 13 * spread, 6 * spread, 0, 0, Math.PI * 2); ctx.fill()
      for (let i = 0; i < 7; i++) {
        const a = i * 0.9 + 0.4, r = (14 + (i % 3) * 5) * spread
        ctx.beginPath(); ctx.ellipse(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r * 0.5, 2.6 - (i % 3) * 0.6, 1.4, 0, 0, Math.PI * 2); ctx.fill()
      }
      // Droplets thrown up.
      for (let i = 0; i < 5; i++) {
        const tt = clamp(k * 2.5, 0, 1)
        const a = -Math.PI / 2 + (i - 2) * 0.45
        ctx.beginPath(); ctx.arc(p.x + Math.cos(a) * 22 * tt, p.y + Math.sin(a) * 26 * tt + 30 * tt * tt, 1.6, 0, Math.PI * 2); ctx.fill()
      }
      break
    }
    case 'smoke': {
      const p = iso(e.at.x, e.at.y, e.at.z + k * 1.2)
      for (let i = 0; i < 6; i++) {
        ctx.fillStyle = alpha(e.color, (1 - k) * 0.45)
        ctx.beginPath(); ctx.arc(p.x + Math.sin(i * 1.7 + k * 4) * 7 * (1 + k), p.y - i * 4 * k, 4 + k * 8, 0, Math.PI * 2); ctx.fill()
      }
      break
    }
    case 'seal': {
      const p = iso(e.at.x, e.at.y, e.at.z + 0.2 + easeOut(k) * 0.6)
      const stamp = 1.5 - 0.5 * easeOut(clamp(k * 5, 0, 1))
      ctx.globalAlpha = 1 - k * k
      ctx.translate(p.x + 14, p.y - 30)
      ctx.scale(stamp, stamp)
      ctx.rotate(-0.1)
      ctx.fillStyle = 'rgba(0,0,0,0.15)'
      ctx.fillRect(-6.5, -6.5, 15, 15)
      ctx.fillStyle = e.color
      ctx.fillRect(-7.5, -7.5, 15, 15)
      ctx.strokeStyle = 'rgba(255,255,255,0.7)'
      ctx.lineWidth = 0.7
      ctx.strokeRect(-5.5, -5.5, 11, 11)
      ctx.fillStyle = '#ffffff'
      ctx.font = `900 9px ${FONT}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(e.text, 0, 0.5)
      break
    }
    case 'ring': {
      const p = iso(e.at.x, e.at.y, 0)
      ctx.strokeStyle = alpha(e.color, 1 - k)
      ctx.lineWidth = 2.5
      ctx.beginPath(); ctx.ellipse(p.x, p.y, 10 + k * 40, 5 + k * 20, 0, 0, Math.PI * 2); ctx.stroke()
      ctx.lineWidth = 1.2
      ctx.beginPath(); ctx.ellipse(p.x, p.y, 6 + k * 26, 3 + k * 13, 0, 0, Math.PI * 2); ctx.stroke()
      break
    }
    case 'tally': {
      // Two halves of a tiger tally come together: an order is dispatched.
      const p = iso(e.at.x, e.at.y, e.at.z + 0.6)
      const join = easeOut(clamp(k * 2, 0, 1))
      ctx.globalAlpha = k > 0.75 ? (1 - k) * 4 : 1
      ctx.translate(p.x - 18, p.y - 26 - k * 10)
      for (const side of [-1, 1]) {
        ctx.save()
        ctx.translate(side * (12 - join * 12), 0)
        ctx.scale(side, 1)
        ctx.fillStyle = side < 0 ? '#e0b04e' : '#c99632'
        ctx.beginPath(); ctx.moveTo(0, -6); ctx.quadraticCurveTo(-12, -9, -14, -1); ctx.quadraticCurveTo(-13, 5, 0, 5); ctx.closePath(); ctx.fill()
        ctx.beginPath(); ctx.arc(-14, -4, 3.4, 0, Math.PI * 2); ctx.fill()
        ctx.strokeStyle = '#6b4a14'; ctx.lineWidth = 1
        for (const sx of [-4, -8]) { ctx.beginPath(); ctx.moveTo(sx, -6); ctx.lineTo(sx + 1.5, 3); ctx.stroke() }
        ctx.restore()
      }
      if (join > 0.95) {
        ctx.strokeStyle = `rgba(255,220,130,${1 - k})`
        ctx.lineWidth = 2
        ctx.beginPath(); ctx.arc(0, 0, 10 + (k - 0.5) * 30, 0, Math.PI * 2); ctx.stroke()
      }
      break
    }
    case 'pigeon': {
      const t = easeInOut(k)
      const at = (tt: number) => iso(e.from.x + (e.to.x - e.from.x) * tt, e.from.y + (e.to.y - e.from.y) * tt, e.from.z + (e.to.z - e.from.z) * tt + Math.sin(tt * Math.PI) * 1.4)
      const p = at(t), q = at(Math.min(1, t + 0.02))
      const dir = q.x >= p.x ? 1 : -1
      ctx.globalAlpha = k < 0.1 ? k * 10 : k > 0.9 ? (1 - k) * 10 : 1
      ctx.translate(p.x, p.y)
      ctx.scale(dir, 1)
      const flap = Math.sin(now / 55)
      ctx.fillStyle = '#f4f2ee'
      ctx.beginPath(); ctx.ellipse(0, 0, 7, 3.6, 0, 0, Math.PI * 2); ctx.fill()
      ctx.beginPath(); ctx.arc(6, -2, 2.6, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = '#d9a441'
      ctx.beginPath(); ctx.moveTo(8.4, -2.2); ctx.lineTo(11, -1.6); ctx.lineTo(8.4, -0.9); ctx.fill()
      ctx.fillStyle = '#e4e1da'
      ctx.beginPath(); ctx.moveTo(-1, -1); ctx.lineTo(-6, -1 - flap * 9); ctx.lineTo(3, -2); ctx.closePath(); ctx.fill()
      ctx.fillStyle = '#1c1a1e'
      ctx.fillRect(6.4, -2.6, 1, 1)
      // The message tube on its leg.
      ctx.fillStyle = VERMILION
      ctx.fillRect(-1, 3, 3, 2)
      break
    }
    case 'petals': {
      // Plum blossom drifting down over the hall.
      const t = (now - e.born) / 1000
      for (const b of e.bits) {
        const z = Math.max(0, b.z - t * 0.9)
        const p = iso(e.at.x + b.x + Math.sin(t * 1.6 + b.drift) * 0.4, e.at.y + b.y + t * 0.25, z)
        ctx.save()
        ctx.globalAlpha = (1 - k) * (z <= 0 ? 0.5 : 1)
        ctx.translate(p.x, p.y)
        ctx.rotate(b.spin * t)
        ctx.scale(b.size, b.size * (0.5 + 0.5 * Math.abs(Math.sin(t * 2 + b.drift))))
        ctx.fillStyle = b.color
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2
          ctx.beginPath(); ctx.ellipse(Math.cos(a) * 2.4, Math.sin(a) * 2.4, 2.1, 1.6, a, 0, Math.PI * 2); ctx.fill()
        }
        ctx.fillStyle = '#d9a441'
        ctx.beginPath(); ctx.arc(0, 0, 0.9, 0, Math.PI * 2); ctx.fill()
        ctx.restore()
      }
      break
    }
    case 'memorial':
      break
  }
  ctx.restore()
}
