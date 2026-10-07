/**
 * The office model. Turns protocol state into a little world: one room per
 * session, a desk per agent, workers who walk in when they're spawned, go to the
 * couch when they're done and head home afterwards. Events add flourishes —
 * paper planes for prompts, flying papers for file work, confetti for finished turns.
 *
 * Everything here is derived from `WorldState` + `ObserverEvent`s; no harness knowledge.
 */
import { agentActivity, type Activity, type AgentState, type FileChange, type ObserverEvent, type SessionState, type ToolCallState, type WorldState } from '@oadt/protocol'
import { buddySeed } from '../../shared/buddy'
import type { Pt } from './iso'

export const ROOM_W = 12
export const ROOM_D = 9
const GAP = 4
const WALK_SPEED = 2.4 // tiles per second
const RETIRE_MS = 3 * 60_000
const LOUNGE_MS = 45_000

export interface Desk {
  x: number
  y: number
  w: number
  d: number
  boss: boolean
  seat: Pt
  occupant?: string
}

export const ENTRANCE: Pt = { x: 10.2, y: 0.7 }
export const DOOR = { x: 9.6, w: 1.25, h: 2.05 }
export const WINDOWS = [{ x: 1.0, w: 1.9 }, { x: 3.4, w: 1.9 }]
export const CABINET = { x: 0.05, y: 4.55, w: 0.75, d: 0.75, h: 1.25 }
export const COUNTER = { x: 0.05, y: 6.3, w: 0.85, d: 2.3, h: 0.95 }
export const COUCH = { x: 8.3, y: 7.9, w: 2.7, d: 1.0 }
export const SIDE_TABLE = { x: 7.55, y: 8.4 }
export const FLOOR_LAMP = { x: 7.45, y: 7.75 }
export const DOORMAT = { x: 9.5, y: 0.1, w: 1.45, d: 0.62 }
export const SHELF = { x: 6.0, y: 0.05, w: 1.6, d: 0.5, h: 1.9 }
const COUCH_SPOTS: Pt[] = [{ x: 8.62, y: 8.52 }, { x: 9.65, y: 8.52 }, { x: 10.68, y: 8.52 }]
const STAND_SPOTS: Pt[] = [{ x: 1.45, y: 6.7 }, { x: 1.5, y: 7.5 }, { x: 1.45, y: 8.3 }, { x: 4.6, y: 8.4 }, { x: 6.2, y: 8.4 }]

function deskLayout(): Desk[] {
  const sub = (x: number, y: number): Desk => ({ x, y, w: 1.6, d: 0.9, boss: false, seat: { x: x + 0.8, y: y - 0.55 } })
  return [
    { x: 4.8, y: 3.7, w: 2.5, d: 1.1, boss: true, seat: { x: 6.05, y: 3.1 } },
    sub(1.7, 3.0), sub(8.9, 3.0), sub(1.7, 5.7), sub(8.9, 5.7), sub(3.7, 6.9), sub(6.6, 6.9),
  ]
}

export type Mode = 'walking' | 'seated' | 'lounging' | 'standing'
export type Dest = 'desk' | 'couch' | 'stand' | 'door'

export interface Bubble { text: string; tone: 'say' | 'task' | 'user'; born: number; ttl: number }

export interface Char {
  id: string
  sessionId: string
  name: string
  role?: string
  isRoot: boolean
  x: number
  y: number
  path: Pt[]
  mode: Mode
  dest: Dest
  deskIdx: number
  spotIdx: number
  /** The blob's seed: the session id for the lead, so a session keeps its face across visualizations. */
  seed: string
  facing: 1 | -1
  phase: number
  jumpUntil: number
  bubble?: Bubble
  blinkAt: number
  alpha: number
  doneSince?: number
}

export interface Cat { x: number; y: number; path: Pt[]; napUntil: number; facing: 1 | -1; phase: number }

export interface Room {
  id: string
  ox: number
  oy: number
  harness: string
  title: string
  desks: Desk[]
  chars: Map<string, Char>
  doorOpen: number
  doorUntil: number
  plan?: { done: number; total: number; label: string }
  cat: Cat
  initialized: boolean
  /** When the room first appeared (for the pop-in animation). */
  bornAt: number
  /** Workers who already went home (only come back if they get work again). */
  gone: Set<string>
}

export type Effect =
  | { kind: 'plane'; room: string; from: Pt3; to: Pt3; born: number; dur: number }
  | { kind: 'paper'; room: string; from: Pt3; to: Pt3; born: number; dur: number; color: string }
  | { kind: 'puff'; room: string; at: Pt3; born: number; dur: number; color: string }
  | { kind: 'popup'; room: string; at: Pt3; born: number; dur: number; text: string; color: string }
  | { kind: 'ring'; room: string; at: Pt3; born: number; dur: number; color: string }
  | { kind: 'phone'; room: string; at: Pt3; born: number; dur: number }
  | { kind: 'confetti'; room: string; at: Pt3; born: number; dur: number; bits: Array<{ vx: number; vy: number; vz: number; color: string; spin: number }> }
  /** A diff typed out above the agent's head, then filed to the front desk. */
  | { kind: 'diff'; room: string; agentId: string; at: Pt3; born: number; dur: number; typeMs: number; holdMs: number; key: string; path: string; op: FileChange['op']; added: number; removed: number; lines: string[]; chars: number }

export interface Pt3 { x: number; y: number; z: number }

/** What an agent is doing right now (the shared protocol activity) plus its newest open tool. */
export function activityOf(s: SessionState, a: AgentState | undefined, now: number): { activity: Activity; tool?: ToolCallState } {
  if (!a) return { activity: 'idle' }
  const activity = agentActivity(s, a, now)
  const open = a.activeTools.map((id) => s.tools[id]).filter((t): t is ToolCallState => !!t)
  const live = open.filter((t) => t.endedAt === undefined)
  const tool = live.filter((t) => t.category !== 'agent').pop() ?? live.pop() ?? (activity === 'waiting' ? open.pop() : undefined)
  return { activity, tool }
}

export const DIFF_PREVIEW = 5
export const DIFF_FLY_MS = 650

export class Office {
  rooms = new Map<string, Room>()
  effects: Effect[] = []
  /** When each file change reaches the front desk (change key → epoch ms). Unknown keys are shown at once. */
  filedAt = new Map<string, number>()
  private diffBusy = new Map<string, number>()
  private seen = new Set<number>()

  /** Place rooms for the sessions on stage (stable order = stable positions). */
  layout(ids: string[], world: WorldState, now = Date.now()): void {
    for (const id of [...this.rooms.keys()]) if (!ids.includes(id)) this.rooms.delete(id)
    const cols = ids.length <= 2 ? ids.length : Math.ceil(Math.sqrt(ids.length))
    ids.forEach((id, i) => {
      const s = world.sessions[id]
      if (!s) return
      let room = this.rooms.get(id)
      if (!room) {
        room = {
          id, ox: 0, oy: 0, harness: s.harness, title: '', desks: deskLayout(), chars: new Map(),
          doorOpen: 0, doorUntil: 0, cat: { x: 5, y: 5.6, path: [], napUntil: 0, facing: 1, phase: Math.random() * 10 }, initialized: false, gone: new Set(), bornAt: now,
        }
        this.rooms.set(id, room)
      }
      // Rooms march along the x axis (down-right) and wrap to new rows along y.
      room.ox = (i % cols) * (ROOM_W + GAP)
      room.oy = Math.floor(i / cols) * (ROOM_D + GAP)
    })
  }

  sync(world: WorldState, events: ObserverEvent[], now: number): void {
    for (const room of this.rooms.values()) {
      const s = world.sessions[room.id]
      if (!s) continue
      room.harness = s.harness
      room.title = s.meta.title ?? s.meta.project ?? s.id.slice(0, 8)
      this.syncChars(room, s, now)
      room.initialized = true
    }
    for (const e of events) {
      if (this.seen.has(e.seq)) continue
      this.seen.add(e.seq)
      const room = this.rooms.get(e.sessionId)
      if (room) this.effect(room, world.sessions[e.sessionId], e, now)
    }
    if (this.seen.size > 4000) this.seen = new Set([...this.seen].slice(-1500))
  }

  private syncChars(room: Room, s: SessionState, now: number): void {
    const present = new Set<string>()
    const agents = Object.values(s.agents).sort((a, b) => a.depth - b.depth || a.startedAt - b.startedAt)
    for (const a of agents) {
      const isRoot = a.id === s.rootAgentId
      const retired = !isRoot && a.status === 'done' && now - a.lastActivityAt > RETIRE_MS
      let c = room.chars.get(a.id)
      if (retired) {
        if (c && c.dest !== 'door') this.sendHome(room, c)
        if (c) present.add(a.id)
        continue
      }
      present.add(a.id)
      if (!c && room.gone.has(a.id)) {
        if (a.status === 'done') continue
        room.gone.delete(a.id)
      }
      if (c && c.dest === 'door' && a.status === 'done') continue
      if (!c) {
        c = {
          id: a.id, sessionId: s.id, name: isRoot ? 'lead' : a.name, role: a.role, isRoot,
          x: ENTRANCE.x, y: ENTRANCE.y, path: [], mode: 'standing', dest: 'stand', deskIdx: -1, spotIdx: -1,
          seed: buddySeed(s.id, a.id, s.rootAgentId), facing: 1, phase: Math.random() * 10, jumpUntil: 0,
          blinkAt: now + 1000 + Math.random() * 4000, alpha: room.initialized ? 0 : 1,
        }
        room.chars.set(a.id, c)
        if (room.initialized) this.openDoor(room, now)
      }
      c.name = isRoot ? 'lead' : a.name
      c.role = a.role
      // Where should this worker be?
      const want: Dest = isRoot || a.status !== 'done' ? 'desk' : 'couch'
      if (a.status === 'done' && !c.doneSince) c.doneSince = now
      if (a.status !== 'done') c.doneSince = undefined
      const loungedOut = c.doneSince !== undefined && now - c.doneSince > LOUNGE_MS
      if (loungedOut && !isRoot) {
        if (c.dest !== 'door') this.sendHome(room, c)
        continue
      }
      if (c.dest !== want || (want === 'desk' && c.deskIdx < 0)) this.assign(room, c, want, !room.initialized)
    }
    for (const [id, c] of room.chars) {
      if (!present.has(id) && c.dest !== 'door') this.sendHome(room, c)
    }
  }

  private assign(room: Room, c: Char, want: Dest, instant: boolean): void {
    this.release(room, c)
    let target: Pt | undefined
    if (want === 'desk') {
      const idx = c.isRoot ? 0 : room.desks.findIndex((d, i) => i > 0 && !d.occupant)
      if (idx >= 0) {
        room.desks[idx]!.occupant = c.id
        c.deskIdx = idx
        c.dest = 'desk'
        target = room.desks[idx]!.seat
      }
    } else if (want === 'couch') {
      const taken = new Set([...room.chars.values()].filter((o) => o.dest === 'couch').map((o) => o.spotIdx))
      const idx = COUCH_SPOTS.findIndex((_, i) => !taken.has(i))
      if (idx >= 0) {
        c.spotIdx = idx
        c.dest = 'couch'
        target = COUCH_SPOTS[idx]
      }
    }
    if (!target && want === 'couch') {
      // Couch is full: clock out early.
      this.sendHome(room, c)
      return
    }
    if (!target) {
      // No desk free: hang out by the coffee machine until one opens up.
      const taken = new Set([...room.chars.values()].filter((o) => o.dest === 'stand').map((o) => o.spotIdx))
      const idx = Math.max(0, STAND_SPOTS.findIndex((_, i) => !taken.has(i)))
      c.spotIdx = idx
      c.dest = 'stand'
      target = STAND_SPOTS[idx % STAND_SPOTS.length]!
    }
    if (instant) {
      c.x = target.x
      c.y = target.y
      c.path = []
      c.mode = c.dest === 'desk' ? 'seated' : c.dest === 'couch' ? 'lounging' : 'standing'
    } else {
      c.path = route(c, target)
      c.mode = 'walking'
    }
  }

  private release(room: Room, c: Char): void {
    if (c.deskIdx >= 0 && room.desks[c.deskIdx]?.occupant === c.id) room.desks[c.deskIdx]!.occupant = undefined
    c.deskIdx = -1
    c.spotIdx = -1
  }

  private sendHome(room: Room, c: Char): void {
    this.release(room, c)
    c.dest = 'door'
    c.path = route(c, ENTRANCE)
    c.mode = 'walking'
  }

  private openDoor(room: Room, now: number): void {
    room.doorUntil = Math.max(room.doorUntil, now + 2600)
  }

  private effect(room: Room, s: SessionState | undefined, e: ObserverEvent, now: number): void {
    if (!s) return
    const c = room.chars.get(e.agentId)
    const head = (ch: Char | undefined): Pt3 => ({ x: ch?.x ?? 6, y: ch?.y ?? 3, z: 1.5 })
    const deskTop = (ch: Char | undefined): Pt3 => {
      const d = ch && ch.deskIdx >= 0 ? room.desks[ch.deskIdx] : undefined
      return d ? { x: d.x + d.w / 2, y: d.y + d.d / 2, z: 0.85 } : head(ch)
    }
    switch (e.kind) {
      case 'message': {
        const text = e.text.replace(/\s+/g, ' ').trim()
        if (e.role === 'user') {
          const root = room.chars.get(s.rootAgentId)
          this.effects.push({ kind: 'plane', room: room.id, from: { x: 2.0, y: 0.1, z: 1.7 }, to: head(root), born: now, dur: 1700 })
          if (root) root.bubble = { text, tone: 'user', born: now + 1500, ttl: 6500 }
        } else if (c) {
          c.bubble = { text, tone: e.role === 'agent' ? 'task' : 'say', born: now, ttl: e.role === 'agent' ? 4500 : 7000 }
        }
        break
      }
      case 'tool.started': {
        if (e.category === 'agent' && c) this.effects.push({ kind: 'phone', room: room.id, at: head(c), born: now, dur: 1500 })
        if (e.category === 'plan') room.plan = parsePlan(e.title) ?? room.plan
        break
      }
      case 'tool.finished': {
        const t = s.tools[e.callId]
        if (!c || !t) break
        if (!e.ok) {
          this.effects.push({ kind: 'puff', room: room.id, at: deskTop(c), born: now, dur: 1200, color: '#ff6b81' })
          this.effects.push({ kind: 'popup', room: room.id, at: head(c), born: now, dur: 1400, text: '✗', color: '#ff5d73' })
        } else if (t.category !== 'agent' && t.category !== 'plan') {
          this.effects.push({ kind: 'popup', room: room.id, at: head(c), born: now, dur: 900, text: '✓', color: '#36c98a' })
        }
        // Edits with a recorded diff get typed out in a bubble and filed; the rest fly as papers.
        const changed = new Set<string>()
        for (const ch of (t.changes ?? []).slice(0, 2)) {
          changed.add(ch.path)
          const lines = ch.lines.slice(0, DIFF_PREVIEW).map((l) => (l[0] === '@' ? '@' : l.slice(0, 40)))
          const chars = lines.reduce((n, l) => n + l.length, 0)
          const typeMs = Math.min(3200, Math.max(1100, 300 + chars * 16))
          const holdMs = 1000
          const dur = typeMs + holdMs + DIFF_FLY_MS
          const born = Math.max(now, this.diffBusy.get(e.agentId) ?? 0)
          this.diffBusy.set(e.agentId, born + dur - DIFF_FLY_MS * 0.5)
          const key = `${s.id}:${t.id}:${t.changes!.indexOf(ch)}`
          this.filedAt.set(key, born + dur)
          if (this.filedAt.size > 600) for (const k of [...this.filedAt.keys()].slice(0, 300)) this.filedAt.delete(k)
          this.effects.push({ kind: 'diff', room: room.id, agentId: e.agentId, at: head(c), born, dur, typeMs, holdMs, key, path: ch.path, op: ch.op, added: ch.added, removed: ch.removed, lines, chars })
        }
        const cabinet: Pt3 = { x: CABINET.x + CABINET.w / 2, y: CABINET.y + CABINET.d / 2, z: CABINET.h + 0.1 }
        for (const f of t.files.slice(0, 3)) {
          if (changed.has(f.path)) continue
          const toCabinet = f.op === 'edit' || f.op === 'write' || f.op === 'delete'
          const desk = deskTop(c)
          this.effects.push({
            kind: 'paper', room: room.id, from: toCabinet ? desk : cabinet, to: toCabinet ? cabinet : desk,
            born: now + Math.random() * 250, dur: 1000, color: f.op === 'read' || f.op === 'search' ? '#e9f2ff' : f.op === 'delete' ? '#ffd0d6' : '#fff5cf',
          })
        }
        break
      }
      case 'agent.spawned': {
        this.openDoor(room, now)
        break
      }
      case 'turn.ended': {
        if (e.agentId === s.rootAgentId && e.outcome === 'completed' && c) {
          c.jumpUntil = now + 900
          const colors = ['#ff8a4c', '#ffd166', '#3ee0c5', '#9d8cff', '#ff7aa8', '#5aa9ff']
          this.effects.push({
            kind: 'confetti', room: room.id, at: head(c), born: now, dur: 2600,
            bits: Array.from({ length: 46 }, (_, i) => ({ vx: (Math.random() - 0.5) * 3, vy: (Math.random() - 0.5) * 3, vz: 2.5 + Math.random() * 2.5, color: colors[i % colors.length]!, spin: Math.random() * 10 })),
          })
        } else if (c && e.outcome !== 'completed') {
          this.effects.push({ kind: 'puff', room: room.id, at: head(c), born: now, dur: 1100, color: '#9aa3b5' })
        }
        break
      }
      case 'agent.status': {
        if (e.status === 'waiting' && c) this.effects.push({ kind: 'ring', room: room.id, at: { x: c.x, y: c.y, z: 0 }, born: now, dur: 1400, color: '#ffb547' })
        break
      }
    }
  }

  step(dt: number, now: number): void {
    for (const room of this.rooms.values()) {
      const target = now < room.doorUntil || [...room.chars.values()].some((c) => Math.hypot(c.x - ENTRANCE.x, c.y - ENTRANCE.y) < 1.4 && c.mode === 'walking') ? 1 : 0
      room.doorOpen += (target - room.doorOpen) * Math.min(1, dt * 6)
      for (const [id, c] of room.chars) {
        c.alpha = Math.min(1, c.alpha + dt * 2.5)
        c.phase += dt
        if (c.mode === 'walking') {
          let budget = WALK_SPEED * dt
          while (budget > 0 && c.path.length) {
            const p = c.path[0]!
            const dx = p.x - c.x, dy = p.y - c.y
            const d = Math.hypot(dx, dy)
            if (Math.abs(dx - dy) > 0.01) c.facing = dx - dy > 0 ? 1 : -1
            if (d <= budget) { c.x = p.x; c.y = p.y; c.path.shift(); budget -= d }
            else { c.x += (dx / d) * budget; c.y += (dy / d) * budget; budget = 0 }
          }
          if (!c.path.length) {
            if (c.dest === 'door') { room.chars.delete(id); room.gone.add(id); continue }
            c.mode = c.dest === 'desk' ? 'seated' : c.dest === 'couch' ? 'lounging' : 'standing'
          }
        }
        if (now > c.blinkAt + 140) c.blinkAt = now + 2200 + Math.random() * 4200
        if (c.bubble && now > c.bubble.born + c.bubble.ttl) c.bubble = undefined
      }
      stepCat(room, dt, now)
    }
    this.effects = this.effects.filter((e) => now < e.born + e.dur)
  }
}

/** An L-shaped walk that keeps to the aisles. */
function route(from: Pt, to: Pt): Pt[] {
  const aisleY = 2.25
  if (Math.abs(from.y - to.y) < 0.2 || Math.abs(from.x - to.x) < 0.2) return [{ ...to }]
  // Walk to the aisle behind the desks, along it, then down to the seat.
  return [{ x: from.x, y: Math.min(from.y, aisleY) }, { x: to.x, y: Math.min(from.y, aisleY) }, { ...to }]
}

function parsePlan(title: string): { done: number; total: number; label: string } | undefined {
  const m = /(\d+)\s*\/\s*(\d+)/.exec(title)
  if (!m) return undefined
  const label = title.split('·').slice(1).join('·').trim()
  return { done: Number(m[1]), total: Math.max(1, Number(m[2])), label }
}

const CAT_SPOTS: Pt[] = [{ x: 3.2, y: 2.4 }, { x: 7.8, y: 5.3 }, { x: 5.0, y: 8.2 }, { x: 10.6, y: 4.6 }, { x: 1.4, y: 4.2 }, { x: 7.0, y: 7.6 }]

function stepCat(room: Room, dt: number, now: number): void {
  const cat = room.cat
  cat.phase += dt
  if (now < cat.napUntil) return
  if (!cat.path.length) {
    if (Math.random() < 0.004) {
      const spot = CAT_SPOTS[Math.floor(Math.random() * CAT_SPOTS.length)]!
      cat.path = [{ x: spot.x, y: cat.y }, { ...spot }]
    } else if (Math.random() < 0.002) {
      cat.napUntil = now + 8000 + Math.random() * 12000
    }
    return
  }
  let budget = 1.1 * dt
  while (budget > 0 && cat.path.length) {
    const p = cat.path[0]!
    const dx = p.x - cat.x, dy = p.y - cat.y
    const d = Math.hypot(dx, dy)
    if (Math.abs(dx - dy) > 0.01) cat.facing = dx - dy > 0 ? 1 : -1
    if (d <= budget) { cat.x = p.x; cat.y = p.y; cat.path.shift(); budget -= d }
    else { cat.x += (dx / d) * budget; cat.y += (dy / d) * budget; budget = 0 }
  }
}
