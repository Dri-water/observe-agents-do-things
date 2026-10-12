/**
 * The court model. Turns protocol state into an imperial audience hall: one
 * hall per session, the lead agent as Chancellor at the foot of the throne,
 * subagents as ministers kneeling at low desks in the east and west ranks.
 * Ministers climb the front steps when they are summoned, step forward and
 * raise their tablet (笏) when they need you, take tea in the side pavilion
 * when they are done, and leave afterwards. Events add flourishes: an edict
 * for every prompt, bamboo slips for file work, a tiger tally for delegation,
 * plum blossom for a finished turn.
 *
 * Everything here is derived from `WorldState` + `ObserverEvent`s; no harness knowledge.
 */
import { agentActivity, type Activity, type AgentState, type FileChange, type ObserverEvent, type SessionState, type ToolCallState, type WorldState } from '@oadt/protocol'
import { buddySeed } from '../../shared/buddy'
import type { Pt } from '../office/iso'

export const HALL_W = 15
export const HALL_D = 11
/** The central aisle (the imperial way) runs along y at this x. */
export const AISLE_X = 7.5
const GAP = 5
const WALK_SPEED = 2.2 // tiles per second
const RETIRE_MS = 3 * 60_000
const REST_MS = 45_000
/** A permission prompt has to last this long before the minister walks up to present it. */
const PRESENT_DELAY_MS = 450
const RETURN_DELAY_MS = 900

/** Hall furniture (hall-local tiles). */
export const DAIS = { x: 5.1, y: 0, w: 4.8, d: 2.4 }
export const THRONE = { x: AISLE_X, y: 1.05 }
export const SCREEN = { x0: 5.75, x1: 9.25, y: 0.22 }
export const CLOCK = { x: 0.55, y: 0.55, w: 1.5, d: 1.5 }
export const ARCHIVE = { x: 0.05, y: 3.2, w: 0.7, d: 3.4, h: 2.3 }
export const PILLARS: Pt[] = [{ x: 4.55, y: 2.75 }, { x: 10.45, y: 2.75 }]
export const CANDLES: Pt[] = [{ x: 5.0, y: 3.05 }, { x: 10.0, y: 3.05 }]
export const ENTRANCE: Pt = { x: AISLE_X, y: HALL_D + 1.5 }
export const ROWS = [4.9, 6.6, 8.3]
const LANE = 0.95

export interface Seat {
  /** Where the minister kneels. */
  at: Pt
  /** Walk from the imperial way to the seat (first point is on the aisle). */
  via: Pt[]
}

export interface Desk {
  x: number
  y: number
  w: number
  d: number
  lead: boolean
  seat: Seat
  /** Which side the minister faces while kneeling here. */
  facing: 1 | -1
  occupant?: string
}

const aisle = (y: number): Pt => ({ x: AISLE_X, y })

/** Everything a hall's ministers walk to, in the hall's own tiles. */
export interface CourtLayout {
  /** The aisle every walk runs along. */
  aisleX: number
  /** Cross-aisles, for routing from somewhere unexpected. */
  lanes: number[]
  /** Desks for this many rows of ministers (the classic hall has a fixed three). */
  desks(rows: number): Desk[]
  /** Kneeling places before the throne. */
  present: Seat[]
  /** In the one-hall court every delegation shares the places before the throne. */
  sharedPresent: boolean
  rest: Seat[]
  /** The tea table (centre) and the rug under the cushions. */
  tea: { table: Pt; rug: { x: number; y: number; w: number; d: number } }
  stand(i: number): Seat
  leave: Seat
  entrance: Pt
  throne: Pt3
  archive: Pt3
  window: Pt3
}

function classicDesks(): Desk[] {
  const lead: Desk = {
    x: 6.6, y: 4.2, w: 1.8, d: 0.68, lead: true, facing: 1,
    seat: { at: { x: AISLE_X, y: 3.4 }, via: [aisle(5.35), { x: 8.85, y: 5.35 }, { x: 8.85, y: 3.4 }, { x: AISLE_X, y: 3.4 }] },
  }
  const desks: Desk[] = [lead]
  for (const y of ROWS) {
    // West rank (civil officials) faces east toward the aisle; east rank (military) faces west.
    desks.push({ x: 3.45, y: y - 0.42, w: 0.66, d: 0.84, lead: false, facing: 1, seat: { at: { x: 2.95, y }, via: [aisle(y + LANE), { x: 2.95, y: y + LANE }, { x: 2.95, y }] } })
    desks.push({ x: 10.9, y: y - 0.42, w: 0.66, d: 0.84, lead: false, facing: -1, seat: { at: { x: 12.05, y }, via: [aisle(y + LANE), { x: 12.05, y: y + LANE }, { x: 12.05, y }] } })
  }
  return desks
}

/** Kneeling places before the throne for ministers who need you (the lead presents from its own seat). */
const PRESENT: Seat[] = [6.0, 9.0, 5.25, 9.75].map((x, i) => ({ at: { x, y: 3.3 + (i > 1 ? 0.4 : 0) }, via: [aisle(5.35), { x, y: 5.35 }, { x, y: 3.3 + (i > 1 ? 0.4 : 0) }] }))
/** Cushions in the tea pavilion for ministers whose work is done. */
export const REST_SPOTS = [{ x: 12.6, y: 10.55 }, { x: 13.5, y: 9.65 }, { x: 14.4, y: 8.8 }]
const REST: Seat[] = REST_SPOTS.map((at) => ({ at, via: [aisle(10.45), { x: at.x, y: 10.45 }, at] }))
/** Waiting along the front of the hall when every desk is taken. */
const STAND: Seat[] = [5.4, 9.6, 4.4, 10.6, 3.4].map((x) => ({ at: { x, y: 10.35 }, via: [aisle(10.35), { x, y: 10.35 }] }))

/** Where the i-th minister without a desk waits: along the front of the hall, then queueing down the steps into the courtyard. */
function standSeat(i: number): Seat {
  if (i < STAND.length) return STAND[i]!
  const k = i - STAND.length
  const row = Math.floor(k / 2) % 6, lap = Math.floor(k / 12)
  const x = AISLE_X + (k % 2 ? 0.6 : -0.6) + lap * 0.3, y = HALL_D + 0.4 + row * 0.62 + lap * 0.2
  return { at: { x, y }, via: [aisle(y), { x, y }] }
}

/** One session, one hall: the original layout. */
export const CLASSIC: CourtLayout = {
  aisleX: AISLE_X,
  lanes: [5.35, ...ROWS.map((y) => y + LANE), 10.45, ENTRANCE.y],
  desks: () => classicDesks(),
  present: PRESENT,
  sharedPresent: false,
  rest: REST,
  tea: { table: { x: 13.63, y: 10.25 }, rug: { x: 12.15, y: 8.45, w: 2.7, d: 2.45 } },
  stand: standSeat,
  leave: { at: ENTRANCE, via: [aisle(HALL_D + 1.5)] },
  entrance: ENTRANCE,
  throne: { x: THRONE.x, y: THRONE.y, z: 1.6 },
  archive: { x: ARCHIVE.x + ARCHIVE.w + 0.05, y: ARCHIVE.y + ARCHIVE.d / 2, z: 1.3 },
  window: { x: 11.6, y: 0.1, z: 2.2 },
}

// ─── The one-hall court: every session is a delegation in its own bay ─────

/** A bay is the space between two columns; the great hall grows a bay at a time. */
export const BAY_W = 6.4
/** Bays start this far from the back wall, in front of the throne's floor. */
export const BAY_Y0 = 4.9
/** The carpet down the middle stays clear; bays line up on both sides of it. */
const CARPET_HALF = 0.95
const STAGE_MARGIN = 1.1
/** The bay's own aisle, along its right-hand edge. */
const SIDE = 5.95
/** The corridor across the tops of the bays, in front of the throne. */
const TOP = -0.6
const ROW0 = 2.75
const ROW_STEP = 1.75
export const MAX_ROWS = 5

const restY = (rows: number) => ROW0 + (rows - 1) * ROW_STEP + 1.5
export const bayDepth = (rows: number) => restY(rows) + 2.0

export interface Stage { w: number; d: number }

/** Shared places before the throne, in great-hall tiles. */
function presentSpots(w: number): Pt[] {
  return [[-1, 3.35], [1, 3.35], [-1.7, 3.7], [1.7, 3.7], [-2.4, 3.35], [2.4, 3.35], [-3.1, 3.75], [3.1, 3.75]].map(([dx, y]) => ({ x: w / 2 + dx!, y: y! }))
}

/** The layout of one bay at (bx, by) in a great hall of the given size, for `rows` rows of desks. Bay-local tiles. */
export function bayLayout(bx: number, by: number, stage: Stage, rows: number): CourtLayout {
  const side = (y: number): Pt => ({ x: SIDE, y })
  const seat = (x: number, y: number, lane: number): Seat => ({ at: { x, y }, via: [side(lane), { x, y: lane }, { x, y }] })
  const front = stage.d - 0.55 - by
  const ent = { x: stage.w / 2 - bx, y: stage.d + 1.5 - by }
  const ry = restY(rows)
  return {
    aisleX: SIDE,
    lanes: [TOP, 0.55, ...Array.from({ length: rows }, (_, r) => ROW0 + r * ROW_STEP + 0.88), ry, ry + 0.95, front],
    desks(n) {
      const lead: Desk = { x: 1.85, y: 1.12, w: 1.8, d: 0.66, lead: true, facing: 1, seat: { at: { x: 2.75, y: 0.55 }, via: [side(0.55), { x: 2.75, y: 0.55 }] } }
      const desks: Desk[] = [lead]
      for (let r = 0; r < n; r++) {
        const y = ROW0 + r * ROW_STEP, lane = y + 0.88
        desks.push({ x: 1.25, y: y - 0.42, w: 0.66, d: 0.84, lead: false, facing: 1, seat: seat(0.8, y, lane) })
        desks.push({ x: 3.6, y: y - 0.42, w: 0.66, d: 0.84, lead: false, facing: -1, seat: seat(4.75, y, lane) })
      }
      return desks
    },
    // Up the bay's aisle, along the corridor to the carpet, up the carpet and across to the place before the throne.
    present: presentSpots(stage.w).map((p) => {
      const x = p.x - bx, y = p.y - by, carpet = stage.w / 2 - bx
      return { at: { x, y }, via: [side(TOP), { x: carpet, y: TOP }, { x: carpet, y: y + 0.45 }, { x, y }] }
    }),
    sharedPresent: true,
    rest: [1.2, 2.5, 3.8].map((x) => seat(x, ry, ry)),
    tea: { table: { x: 2.5, y: ry + 0.42 }, rug: { x: 0.55, y: ry - 0.45, w: 3.9, d: 1.2 } },
    stand: (i) => { const y = ry + 0.95 + Math.floor(i / 4) * 0.7; return seat([1.0, 2.2, 3.4, 4.6][i % 4]!, y, y) },
    leave: { at: ent, via: [side(front), { x: ent.x, y: front }, ent] },
    entrance: ent,
    throne: { x: stage.w / 2 - bx, y: THRONE.y - by, z: 1.6 },
    archive: { x: ARCHIVE.x + ARCHIVE.w + 0.05 - bx, y: ARCHIVE.y + ARCHIVE.d / 2 - by, z: 1.3 },
    window: { x: stage.w - 3.4 - bx, y: 0.1 - by, z: 2.2 },
  }
}

/** How the bays are arranged: columns on each side of the carpet, and rows of bays going forward. */
export interface Grid { cols: number; rows: number; rowDepth: number }

/**
 * Halls grow wide, as real ones do: every delegation's Chancellor kneels in the front line before
 * the throne. One bay a side for two delegations, two a side for up to four, and only then a second line.
 */
export function bayGrid(n: number, deskRows: number): Grid {
  const cols = n <= 2 ? 1 : 2
  return { cols, rows: Math.max(1, Math.ceil(n / (2 * cols))), rowDepth: bayDepth(deskRows) + 0.9 }
}

/** The great hall's size for its grid of bays. */
export function stageSize(g: Grid): Stage {
  return { w: 2 * (STAGE_MARGIN + CARPET_HALF + g.cols * BAY_W), d: Math.max(HALL_D, BAY_Y0 + g.rows * g.rowDepth + 0.3) }
}

/** Where bay slot i sits: a row at a time, inner bays first, alternating left and right of the carpet. */
export function bayOrigin(slot: number, stage: Stage, g: Grid): Pt {
  const per = 2 * g.cols
  const row = Math.floor(slot / per), j = slot % per, k = Math.floor(j / 2)
  return { x: j % 2 === 0 ? stage.w / 2 - CARPET_HALF - (k + 1) * BAY_W : stage.w / 2 + CARPET_HALF + k * BAY_W, y: BAY_Y0 + row * g.rowDepth }
}

export type Mode = 'walking' | 'kneeling' | 'resting' | 'standing' | 'presenting'
export type Dest = 'desk' | 'rest' | 'stand' | 'present' | 'door'

export interface Bubble { text: string; tone: 'say' | 'task' | 'user'; born: number; ttl: number }

export interface Minister {
  id: string
  sessionId: string
  name: string
  role?: string
  isRoot: boolean
  depth: number
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
  /** Bow (finished turn) until this time. */
  bowUntil: number
  bubble?: Bubble
  blinkAt: number
  alpha: number
  doneSince?: number
  waitingSince?: number
  clearSince?: number
  /** The layout revision this minister's resting or waiting place belongs to. */
  rev: number
}

export interface Cat { x: number; y: number; path: Pt[]; napUntil: number; facing: 1 | -1; phase: number }

export interface Hall {
  id: string
  /** Index into the hall names, stable for the session. */
  nameIdx: number
  ox: number
  oy: number
  harness: string
  title: string
  desks: Desk[]
  ministers: Map<string, Minister>
  plan?: { done: number; total: number; label: string }
  cat: Cat
  initialized: boolean
  bornAt: number
  gone: Set<string>
  /** Gong struck at the steps (spawns), drives a ripple. */
  gongAt: number
  /** Last time the clock tower's drum struck (a shell command finished). */
  drumAt: number
  /** Pigeons out on errands: tool call id → when it left. */
  pigeons: Map<string, { born: number; from: Pt }>
  layout: CourtLayout
  /** Rows of minister desks (bays grow as the delegation does). */
  rows: number
  /** Bumped when the layout moves the tea mat or the waiting line. */
  rev: number
  /** Bay slot in the one-hall court (stable while the session is on stage). */
  slot: number
}

export type Effect =
  | { kind: 'edict'; hall: string; from: Pt3; to: Pt3; born: number; dur: number }
  | { kind: 'slip'; hall: string; from: Pt3; to: Pt3; born: number; dur: number; color: string }
  | { kind: 'ink'; hall: string; at: Pt3; born: number; dur: number }
  | { kind: 'smoke'; hall: string; at: Pt3; born: number; dur: number; color: string }
  | { kind: 'seal'; hall: string; at: Pt3; born: number; dur: number; text: string; color: string }
  | { kind: 'ring'; hall: string; at: Pt3; born: number; dur: number; color: string }
  | { kind: 'tally'; hall: string; at: Pt3; born: number; dur: number }
  | { kind: 'pigeon'; hall: string; from: Pt3; to: Pt3; born: number; dur: number }
  | { kind: 'petals'; hall: string; at: Pt3; born: number; dur: number; bits: Array<{ x: number; y: number; z: number; drift: number; spin: number; color: string; size: number }> }
  /** A diff written out as a memorial beside its author, then filed to the archive. */
  | { kind: 'memorial'; hall: string; agentId: string; at: Pt3; born: number; dur: number; typeMs: number; holdMs: number; key: string; path: string; op: FileChange['op']; added: number; removed: number; lines: string[]; chars: number }

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

export const MEMO_PREVIEW = 5
export const MEMO_FLY_MS = 700

export class Court {
  halls = new Map<string, Hall>()
  effects: Effect[] = []
  /** When each file change reaches the archive (change key → epoch ms). Unknown keys are shown at once. */
  filedAt = new Map<string, number>()
  private memoBusy = new Map<string, number>()
  private seen = new Set<number>()
  private names = new Map<string, number>()

  /** One great hall for every session (true), or a hall per session. */
  mono = false
  /** The great hall's size in the one-hall court. */
  stage: Stage = { w: HALL_W, d: HALL_D }
  /** The palace cat of the great hall. */
  cat: Cat = { x: 3, y: 10, path: [], napUntil: 0, facing: 1, phase: Math.random() * 10 }
  private slots = new Map<string, number>()

  /**
   * Place halls for the sessions on stage (stable order = stable positions).
   * With `oneHall`, two or more sessions share a great hall, each delegation in its own bay.
   */
  layout(ids: string[], world: WorldState, oneHall = false, now = Date.now()): void {
    const mono = oneHall && ids.length > 1
    if (mono !== this.mono) {
      // Switching between one hall and many: everyone takes their place again.
      this.halls.clear()
      this.slots.clear()
    }
    this.mono = mono
    for (const id of [...this.halls.keys()]) if (!ids.includes(id)) this.halls.delete(id)
    for (const id of [...this.slots.keys()]) if (!ids.includes(id)) this.slots.delete(id)
    const cols = ids.length <= 2 ? ids.length : Math.ceil(Math.sqrt(ids.length))
    ids.forEach((id, i) => {
      const s = world.sessions[id]
      if (!s) return
      let hall = this.halls.get(id)
      if (!hall) {
        if (!this.names.has(id)) this.names.set(id, this.names.size)
        hall = {
          id, nameIdx: this.names.get(id)!, ox: 0, oy: 0, harness: s.harness, title: '', desks: [], ministers: new Map(),
          cat: { x: 4.6, y: 9.6, path: [], napUntil: 0, facing: 1, phase: Math.random() * 10 }, initialized: false, gone: new Set(), bornAt: now,
          gongAt: 0, drumAt: 0, pigeons: new Map(), layout: CLASSIC, rows: mono ? 1 : ROWS.length, rev: 0, slot: -1,
        }
        this.halls.set(id, hall)
      }
      if (!mono) {
        hall.ox = (i % cols) * (HALL_W + GAP)
        hall.oy = Math.floor(i / cols) * (HALL_D + GAP)
        hall.layout = CLASSIC
        if (!hall.desks.length) hall.desks = CLASSIC.desks(ROWS.length)
      }
    })
    if (mono) this.placeBays()
  }

  /** Give every delegation a bay and size the great hall around them. */
  private placeBays(): void {
    const used = new Set(this.slots.values())
    for (const id of this.halls.keys()) {
      if (this.slots.has(id)) continue
      let k = 0
      while (used.has(k)) k++
      this.slots.set(id, k)
      used.add(k)
    }
    let maxSlot = 0, rows = 1
    for (const h of this.halls.values()) { maxSlot = Math.max(maxSlot, this.slots.get(h.id) ?? 0); rows = Math.max(rows, h.rows) }
    const grid = bayGrid(maxSlot + 1, rows)
    this.stage = stageSize(grid)
    for (const h of this.halls.values()) {
      h.slot = this.slots.get(h.id) ?? 0
      const o = bayOrigin(h.slot, this.stage, grid)
      h.ox = o.x
      h.oy = o.y
      h.layout = bayLayout(o.x, o.y, this.stage, h.rows)
      const want = h.layout.desks(h.rows)
      for (let i = h.desks.length; i < want.length; i++) h.desks.push(want[i]!)
    }
  }

  sync(world: WorldState, events: ObserverEvent[], now: number): void {
    if (this.mono) {
      // Bays deepen when a delegation outgrows its desks (and never shrink while it is on stage).
      let grew = false
      for (const hall of this.halls.values()) {
        const s = world.sessions[hall.id]
        if (!s) continue
        const busy = Object.values(s.agents).filter((a) => a.id !== s.rootAgentId && a.status !== 'done').length
        const rows = Math.min(MAX_ROWS, Math.max(hall.rows, Math.ceil(busy / 2)))
        if (rows !== hall.rows) { hall.rows = rows; hall.rev++; grew = true }
      }
      if (grew) this.placeBays()
    }
    for (const hall of this.halls.values()) {
      const s = world.sessions[hall.id]
      if (!s) continue
      hall.harness = s.harness
      hall.title = s.meta.title ?? s.meta.project ?? s.id.slice(0, 8)
      this.syncMinisters(hall, s, now)
      hall.initialized = true
    }
    for (const e of events) {
      if (this.seen.has(e.seq)) continue
      this.seen.add(e.seq)
      const hall = this.halls.get(e.sessionId)
      if (hall) this.effect(hall, world.sessions[e.sessionId], e, now)
    }
    if (this.seen.size > 4000) this.seen = new Set([...this.seen].slice(-1500))
  }

  private syncMinisters(hall: Hall, s: SessionState, now: number): void {
    const present = new Set<string>()
    const agents = Object.values(s.agents).sort((a, b) => a.depth - b.depth || a.startedAt - b.startedAt)
    for (const a of agents) {
      const isRoot = a.id === s.rootAgentId
      const retired = !isRoot && a.status === 'done' && now - a.lastActivityAt > RETIRE_MS
      let m = hall.ministers.get(a.id)
      if (retired) {
        if (m && m.dest !== 'door') this.sendHome(hall, m)
        if (m) present.add(a.id)
        continue
      }
      present.add(a.id)
      if (!m && hall.gone.has(a.id)) {
        if (a.status === 'done') continue
        hall.gone.delete(a.id)
      }
      if (m && m.dest === 'door' && a.status === 'done') continue
      if (!m) {
        m = {
          id: a.id, sessionId: s.id, name: isRoot ? 'lead' : a.name, role: a.role, isRoot, depth: a.depth,
          x: hall.layout.entrance.x, y: hall.layout.entrance.y, path: [], mode: 'standing', dest: 'stand', deskIdx: -1, spotIdx: -1, rev: hall.rev,
          seed: buddySeed(s.id, a.id, s.rootAgentId), facing: 1, phase: Math.random() * 10, bowUntil: 0,
          blinkAt: now + 1000 + Math.random() * 4000, alpha: hall.initialized ? 0 : 1,
        }
        hall.ministers.set(a.id, m)
        if (hall.initialized) hall.gongAt = now
      }
      m.name = isRoot ? 'lead' : a.name
      m.role = a.role
      m.depth = a.depth

      // Waiting on you: after a beat, walk up and present the matter before the throne.
      if (a.status === 'waiting') { m.waitingSince ??= now; m.clearSince = undefined }
      else if (m.waitingSince !== undefined) { m.clearSince ??= now }
      if (m.clearSince !== undefined && now - m.clearSince > RETURN_DELAY_MS) { m.waitingSince = undefined; m.clearSince = undefined }
      const presenting = m.waitingSince !== undefined && now - m.waitingSince > PRESENT_DELAY_MS && !isRoot

      if (a.status === 'done' && !m.doneSince) m.doneSince = now
      if (a.status !== 'done') m.doneSince = undefined
      const restedOut = m.doneSince !== undefined && now - m.doneSince > REST_MS
      if (restedOut && !isRoot) {
        if (m.dest !== 'door') this.sendHome(hall, m)
        continue
      }
      const want: Dest = presenting ? 'present' : isRoot || a.status !== 'done' ? 'desk' : 'rest'
      // The bay moved its tea mat or waiting line: go to the new one.
      if (m.rev !== hall.rev && (m.dest === 'rest' || m.dest === 'stand') && m.mode !== 'walking') { m.rev = hall.rev; this.assign(hall, m, m.dest, false); continue }
      if (want === 'present' && m.dest !== 'present') this.toPresent(hall, m)
      else if (want === 'desk' && m.dest === 'stand' && !hall.desks.some((d, i) => (isRoot ? i === 0 : i > 0) && !d.occupant)) {
        // Waiting for a desk: stay put until one is actually free.
      } else if (want !== 'present' && (m.dest !== want || (want === 'desk' && m.deskIdx < 0)) && !(want === 'desk' && m.dest === 'present' && m.deskIdx >= 0 && this.backToDesk(hall, m))) {
        this.assign(hall, m, want, !hall.initialized)
      }
    }
    for (const [id, m] of hall.ministers) {
      if (!present.has(id) && m.dest !== 'door') this.sendHome(hall, m)
    }
  }

  /** Step forward from the desk (keeping it) to kneel before the throne. */
  private toPresent(hall: Hall, m: Minister): void {
    // In the great hall the places before the throne are shared by every delegation.
    const pool = hall.layout.sharedPresent ? [...this.halls.values()] : [hall]
    const taken = new Set(pool.flatMap((h) => [...h.ministers.values()]).filter((o) => o.dest === 'present').map((o) => o.spotIdx))
    const idx = hall.layout.present.findIndex((_, i) => !taken.has(i))
    if (idx < 0) return
    m.spotIdx = idx
    m.dest = 'present'
    m.path = route(m, seatOf(hall, m), hall.layout.present[idx]!, hall.layout)
    m.mode = 'walking'
  }

  private backToDesk(hall: Hall, m: Minister): boolean {
    const desk = hall.desks[m.deskIdx]
    if (!desk || desk.occupant !== m.id) return false
    const from = hall.layout.present[m.spotIdx]
    m.spotIdx = -1
    m.dest = 'desk'
    m.path = route(m, from, desk.seat, hall.layout)
    m.mode = 'walking'
    return true
  }

  private assign(hall: Hall, m: Minister, want: Dest, instant: boolean): void {
    const from = seatOf(hall, m)
    this.release(hall, m)
    let target: Seat | undefined
    if (want === 'desk') {
      const idx = m.isRoot ? 0 : hall.desks.findIndex((d, i) => i > 0 && !d.occupant)
      if (idx >= 0) {
        hall.desks[idx]!.occupant = m.id
        m.deskIdx = idx
        m.dest = 'desk'
        target = hall.desks[idx]!.seat
      }
    } else if (want === 'rest') {
      const taken = new Set([...hall.ministers.values()].filter((o) => o.dest === 'rest').map((o) => o.spotIdx))
      const idx = hall.layout.rest.findIndex((_, i) => !taken.has(i))
      if (idx >= 0) {
        m.spotIdx = idx
        m.dest = 'rest'
        target = hall.layout.rest[idx]
      }
    }
    if (!target && want === 'rest') {
      // The pavilion is full: take leave early.
      this.sendHome(hall, m)
      return
    }
    if (!target) {
      // No desk free: wait along the front of the hall until one opens up.
      const taken = new Set([...hall.ministers.values()].filter((o) => o.dest === 'stand').map((o) => o.spotIdx))
      let idx = 0
      while (taken.has(idx)) idx++
      m.spotIdx = idx
      m.dest = 'stand'
      target = hall.layout.stand(idx)
    }
    if (instant) {
      m.x = target.at.x
      m.y = target.at.y
      m.path = []
      m.mode = settled(m.dest)
      if (m.dest === 'desk') m.facing = hall.desks[m.deskIdx]!.facing
    } else {
      m.path = route(m, from, target, hall.layout)
      m.mode = 'walking'
    }
  }

  private release(hall: Hall, m: Minister): void {
    if (m.deskIdx >= 0 && hall.desks[m.deskIdx]?.occupant === m.id) hall.desks[m.deskIdx]!.occupant = undefined
    m.deskIdx = -1
    m.spotIdx = -1
  }

  private sendHome(hall: Hall, m: Minister): void {
    const from = seatOf(hall, m)
    this.release(hall, m)
    m.dest = 'door'
    m.path = route(m, from, hall.layout.leave, hall.layout)
    m.mode = 'walking'
  }

  private effect(hall: Hall, s: SessionState | undefined, e: ObserverEvent, now: number): void {
    if (!s) return
    const m = hall.ministers.get(e.agentId)
    const head = (mm: Minister | undefined): Pt3 => ({ x: mm?.x ?? hall.desks[0]?.seat.at.x ?? 0, y: mm?.y ?? hall.desks[0]?.seat.at.y ?? 0, z: 1.25 })
    const deskTop = (mm: Minister | undefined): Pt3 => {
      const d = mm && mm.deskIdx >= 0 ? hall.desks[mm.deskIdx] : undefined
      return d ? { x: d.x + d.w / 2, y: d.y + d.d / 2, z: 0.45 } : head(mm)
    }
    switch (e.kind) {
      case 'message': {
        const text = e.text.replace(/\s+/g, ' ').trim()
        if (e.role === 'user') {
          // An edict descends from the throne to the Chancellor.
          const root = hall.ministers.get(s.rootAgentId)
          this.effects.push({ kind: 'edict', hall: hall.id, from: hall.layout.throne, to: head(root), born: now, dur: 1900 })
          if (root) root.bubble = { text, tone: 'user', born: now + 1700, ttl: 6500 }
        } else if (m) {
          m.bubble = { text, tone: e.role === 'agent' ? 'task' : 'say', born: now, ttl: e.role === 'agent' ? 4500 : 7000 }
        }
        break
      }
      case 'tool.started': {
        if (e.category === 'agent' && m) this.effects.push({ kind: 'tally', hall: hall.id, at: head(m), born: now, dur: 1800 })
        if (e.category === 'plan') hall.plan = parsePlan(e.title) ?? hall.plan
        if (e.category === 'web' && m) {
          // A messenger pigeon leaves through the lattice window.
          const from = deskTop(m)
          hall.pigeons.set(e.callId, { born: now, from })
          this.effects.push({ kind: 'pigeon', hall: hall.id, from, to: hall.layout.window, born: now, dur: 1500 })
        }
        break
      }
      case 'tool.finished': {
        const t = s.tools[e.callId]
        if (!m || !t) break
        if (t.category === 'shell') hall.drumAt = now
        const out = hall.pigeons.get(e.callId)
        if (out) {
          hall.pigeons.delete(e.callId)
          this.effects.push({ kind: 'pigeon', hall: hall.id, from: hall.layout.window, to: deskTop(m), born: Math.max(now, out.born + 1500), dur: 1500 })
        }
        if (!e.ok) {
          this.effects.push({ kind: 'ink', hall: hall.id, at: deskTop(m), born: now, dur: 2200 })
          this.effects.push({ kind: 'seal', hall: hall.id, at: head(m), born: now, dur: 1500, text: '✗', color: '#b3261e' })
        } else if (t.category !== 'agent' && t.category !== 'plan') {
          this.effects.push({ kind: 'seal', hall: hall.id, at: head(m), born: now, dur: 1000, text: '✓', color: '#2e7d4f' })
        }
        // Edits with a recorded diff are written out as a memorial and filed; the rest fly as bamboo slips.
        const changed = new Set<string>()
        for (const ch of (t.changes ?? []).slice(0, 2)) {
          changed.add(ch.path)
          const lines = ch.lines.slice(0, MEMO_PREVIEW).map((l) => (l[0] === '@' ? '@' : l.slice(0, 40)))
          const chars = lines.reduce((n, l) => n + l.length, 0)
          const typeMs = Math.min(3200, Math.max(1100, 300 + chars * 16))
          const holdMs = 1100
          const dur = typeMs + holdMs + MEMO_FLY_MS
          const born = Math.max(now, this.memoBusy.get(e.agentId) ?? 0)
          this.memoBusy.set(e.agentId, born + dur - MEMO_FLY_MS * 0.5)
          const key = `${s.id}:${t.id}:${t.changes!.indexOf(ch)}`
          this.filedAt.set(key, born + dur)
          if (this.filedAt.size > 600) for (const k of [...this.filedAt.keys()].slice(0, 300)) this.filedAt.delete(k)
          this.effects.push({ kind: 'memorial', hall: hall.id, agentId: e.agentId, at: head(m), born, dur, typeMs, holdMs, key, path: ch.path, op: ch.op, added: ch.added, removed: ch.removed, lines, chars })
        }
        for (const f of t.files.slice(0, 3)) {
          if (changed.has(f.path)) continue
          const toArchive = f.op === 'edit' || f.op === 'write' || f.op === 'delete'
          const desk = deskTop(m)
          this.effects.push({
            kind: 'slip', hall: hall.id, from: toArchive ? desk : hall.layout.archive, to: toArchive ? hall.layout.archive : desk,
            born: now + Math.random() * 250, dur: 1100, color: f.op === 'read' || f.op === 'search' ? '#e8d9a8' : f.op === 'delete' ? '#d9a3a0' : '#f3ead2',
          })
        }
        break
      }
      case 'agent.spawned': {
        hall.gongAt = now
        break
      }
      case 'turn.ended': {
        if (e.agentId === s.rootAgentId && e.outcome === 'completed' && m) {
          m.bowUntil = now + 1400
          const colors = ['#f7c6d0', '#ffffff', '#f19bb0', '#fbe3e8', '#e8758f']
          this.effects.push({
            kind: 'petals', hall: hall.id, at: head(m), born: now, dur: 4200,
            bits: Array.from({ length: 34 }, (_, i) => ({
              x: (Math.random() - 0.5) * 5, y: (Math.random() - 0.5) * 4, z: 3.2 + Math.random() * 1.6,
              drift: Math.random() * Math.PI * 2, spin: (Math.random() - 0.5) * 6, color: colors[i % colors.length]!, size: 0.8 + Math.random() * 0.6,
            })),
          })
        } else if (m && e.outcome !== 'completed') {
          this.effects.push({ kind: 'smoke', hall: hall.id, at: deskTop(m), born: now, dur: 1800, color: '#8a8580' })
        }
        break
      }
      case 'agent.status': {
        if (e.status === 'waiting' && m) this.effects.push({ kind: 'ring', hall: hall.id, at: { x: m.x, y: m.y, z: 0 }, born: now, dur: 1600, color: '#e8b04a' })
        break
      }
    }
  }

  step(dt: number, now: number): void {
    for (const hall of this.halls.values()) {
      for (const [id, m] of hall.ministers) {
        m.alpha = Math.min(1, m.alpha + dt * 2.5)
        m.phase += dt
        if (m.mode === 'walking') {
          let budget = WALK_SPEED * dt
          while (budget > 0 && m.path.length) {
            const p = m.path[0]!
            const dx = p.x - m.x, dy = p.y - m.y
            const d = Math.hypot(dx, dy)
            if (Math.abs(dx - dy) > 0.01) m.facing = dx - dy > 0 ? 1 : -1
            if (d <= budget) { m.x = p.x; m.y = p.y; m.path.shift(); budget -= d }
            else { m.x += (dx / d) * budget; m.y += (dy / d) * budget; budget = 0 }
          }
          if (!m.path.length) {
            if (m.dest === 'door') { hall.ministers.delete(id); hall.gone.add(id); continue }
            m.mode = settled(m.dest)
            if (m.dest === 'desk' && m.deskIdx >= 0) m.facing = hall.desks[m.deskIdx]!.facing
            if (m.dest === 'present') m.facing = m.x < hall.layout.throne.x ? 1 : -1
            if (m.dest === 'rest') m.facing = m.x < hall.layout.tea.table.x ? 1 : -1
          }
        }
        if (now > m.blinkAt + 140) m.blinkAt = now + 2200 + Math.random() * 4200
        if (m.bubble && now > m.bubble.born + m.bubble.ttl) m.bubble = undefined
      }
      if (!this.mono) stepCat(hall.cat, CAT_SPOTS, dt, now)
    }
    if (this.mono) stepCat(this.cat, stageCatSpots(this.stage), dt, now)
    this.effects = this.effects.filter((e) => now < e.born + e.dur)
  }
}

function settled(dest: Dest): Mode {
  return dest === 'desk' ? 'kneeling' : dest === 'rest' ? 'resting' : dest === 'present' ? 'presenting' : 'standing'
}

/** Where a minister currently belongs, as a seat (for routing away from it). */
function seatOf(hall: Hall, m: Minister): Seat | undefined {
  if (m.dest === 'desk' && m.deskIdx >= 0) return hall.desks[m.deskIdx]!.seat
  if (m.dest === 'present') return hall.layout.present[m.spotIdx]
  if (m.dest === 'rest') return hall.layout.rest[m.spotIdx]
  if (m.dest === 'stand') return hall.layout.stand(m.spotIdx)
  return undefined
}

/** Out of the current seat to the aisle, along it, and into the target seat. */
function route(m: Minister, from: Seat | undefined, to: Seat, layout: CourtLayout): Pt[] {
  const out = from && Math.hypot(from.at.x - m.x, from.at.y - m.y) < 0.3 && !m.path.length ? [...from.via].reverse().slice(1) : []
  if (!out.length) {
    // Mid-walk or somewhere unexpected: along the nearest cross-aisle to the imperial way.
    const lanes = layout.lanes
    const lane = lanes.reduce((best, y) => (Math.abs(y - m.y) < Math.abs(best - m.y) ? y : best), lanes[0]!)
    const ax = layout.aisleX
    if (Math.abs(m.x - ax) > 0.3) out.push({ x: m.x, y: lane })
    out.push({ x: ax, y: Math.abs(m.x - ax) > 0.3 ? lane : m.y })
  }
  const path = [...out, ...to.via.map((p) => ({ ...p }))]
  // Drop zero-length hops.
  const clean: Pt[] = []
  let cur: Pt = { x: m.x, y: m.y }
  for (const p of path) {
    if (Math.hypot(p.x - cur.x, p.y - cur.y) < 0.01) continue
    clean.push(p)
    cur = p
  }
  return clean
}

function parsePlan(title: string): { done: number; total: number; label: string } | undefined {
  const m = /(\d+)\s*\/\s*(\d+)/.exec(title)
  if (!m) return undefined
  const label = title.split('·').slice(1).join('·').trim()
  return { done: Number(m[1]), total: Math.max(1, Number(m[2])), label }
}

const CAT_SPOTS: Pt[] = [{ x: 4.6, y: 9.6 }, { x: 1.6, y: 8.4 }, { x: 6.0, y: 7.4 }, { x: 13.8, y: 3.6 }, { x: 9.2, y: 9.9 }, { x: 1.4, y: 3.0 }]
const stageCatSpots = (st: Stage): Pt[] => [{ x: 1.6, y: 3.6 }, { x: st.w - 2, y: 3.8 }, { x: st.w / 2 + 1.6, y: st.d - 0.5 }, { x: 2.4, y: st.d - 0.45 }, { x: st.w - 3, y: st.d - 0.5 }, { x: st.w / 2 - 4, y: 4.3 }]

function stepCat(cat: Cat, spots: Pt[], dt: number, now: number): void {
  cat.phase += dt
  if (now < cat.napUntil) return
  if (!cat.path.length) {
    if (Math.random() < 0.004) {
      const spot = spots[Math.floor(Math.random() * spots.length)]!
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
