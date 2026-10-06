/**
 * The constellation: a tiny force-directed scene built from WorldState plus
 * transient effects (particles, bubbles, shockwaves) triggered by events.
 * Pure model — drawing lives in draw.ts.
 */
import type { AgentStatus, FileOp, ObserverEvent, SessionState, ToolCategory, WorldState } from '@oadt/protocol'
import { categoryColor, FILE_OP_COLOR, harnessInfo } from '../../shared/theme'

export type NodeKind = 'agent' | 'tool' | 'file' | 'user'

export interface SNode {
  id: string
  kind: NodeKind
  sessionId: string
  x: number
  y: number
  vx: number
  vy: number
  r: number
  color: string
  label: string
  sublabel?: string
  alpha: number
  targetAlpha: number
  bornAt: number
  /** Scale-in animation (0→1). */
  grow: number
  // agent
  agentId?: string
  parentNodeId?: string
  status?: AgentStatus
  thinking?: boolean
  isRoot?: boolean
  depth?: number
  harness?: string
  contextFill?: number
  initials?: string
  // tool
  callId?: string
  category?: ToolCategory
  ownerId?: string
  open?: boolean
  ok?: boolean
  endedAt?: number
  fileNodeIds?: string[]
  slot?: number
  // file
  path?: string
  lastTs?: number
  lastOp?: FileOp
  touches?: number
  lastAgentNodeId?: string
  /** Position among visible siblings, for the radial layout. */
  sibIndex?: number
  sibCount?: number
  placed?: boolean
  flash?: number
  removing?: boolean
}

export interface Particle {
  from: string
  to: string
  t: number
  dur: number
  color: string
  size: number
}

export interface Bubble {
  nodeId: string
  text: string
  born: number
  ttl: number
  tone: 'assistant' | 'user' | 'agent'
}

export interface Ring {
  x: number
  y: number
  born: number
  ttl: number
  color: string
  maxR: number
}

const TOOL_RECENT_MS = 40_000
const TOOLS_PER_AGENT = 6
const FILES_PER_SESSION = 22
const FILE_RECENT_MS = 15 * 60_000
const AGENT_RETIRE_MS = 3 * 60_000
const CONTAIN_R = 470

const rand = (a: number, b: number) => a + Math.random() * (b - a)

export class Scene {
  nodes = new Map<string, SNode>()
  particles: Particle[] = []
  bubbles: Bubble[] = []
  rings: Ring[] = []
  anchors = new Map<string, { x: number; y: number }>()
  sessionIds: string[] = []
  private seen = new Set<string>()

  private portrait = false

  /** Choose which sessions are on stage. Order must be stable (it decides each session's spot). */
  setSessions(ids: string[], portrait = false): void {
    const same = portrait === this.portrait && ids.length === this.sessionIds.length && ids.every((id, i) => id === this.sessionIds[i])
    if (same) return
    this.sessionIds = ids
    this.portrait = portrait
    const keep = new Set(ids)
    let removed = false
    for (const [id, n] of this.nodes) if (!keep.has(n.sessionId)) { this.nodes.delete(id); removed = true }
    if (removed) {
      this.particles = []
      this.bubbles = []
      this.rings = []
    }
    // Lay sessions out on a grid (a single column on portrait screens).
    const cols = portrait ? 1 : Math.ceil(Math.sqrt(ids.length))
    const gap = 1150
    this.anchors.clear()
    ids.forEach((id, i) => {
      const row = Math.floor(i / cols)
      const col = i % cols
      const rowCount = Math.min(cols, ids.length - row * cols)
      this.anchors.set(id, { x: (col - (rowCount - 1) / 2) * gap, y: (row - (Math.ceil(ids.length / cols) - 1) / 2) * gap * 0.85 })
    })
  }

  /** Reconcile nodes with the world, then fire effects for new events. */
  sync(world: WorldState, events: ObserverEvent[], now: number): void {
    for (const sid of this.sessionIds) {
      const s = world.sessions[sid]
      if (s) this.syncSession(s, now)
    }
    for (const e of events) if (this.anchors.has(e.sessionId)) this.effect(world, e, now)
  }

  private node(id: string, init: () => SNode): SNode {
    let n = this.nodes.get(id)
    if (!n) {
      n = init()
      this.nodes.set(id, n)
    }
    return n
  }

  private syncSession(s: SessionState, now: number): void {
    const anchor = this.anchors.get(s.id)!
    const hc = harnessInfo(s.harness)
    const userId = `u:${s.id}`
    this.node(userId, () => ({
      id: userId, kind: 'user', sessionId: s.id, x: anchor.x, y: anchor.y - 300, vx: 0, vy: 0, r: 9,
      color: '#e8eefc', label: 'you', alpha: 0, targetAlpha: 1, bornAt: now, grow: 1,
    }))

    // Agents
    for (const a of Object.values(s.agents)) {
      const id = `a:${s.id}:${a.id}`
      const isRoot = a.id === s.rootAgentId
      // Finished subagents retire from the constellation after a while (they stay in the inspector).
      if (!isRoot && a.status === 'done' && now - a.lastActivityAt > AGENT_RETIRE_MS) {
        const old = this.nodes.get(id)
        if (old) { old.removing = true; old.targetAlpha = 0 }
        continue
      }
      const parentNodeId = a.parentId ? `a:${s.id}:${a.parentId}` : undefined
      const n = this.node(id, () => {
        const p = parentNodeId ? this.nodes.get(parentNodeId) : undefined
        const siblings = a.parentId ? s.agents[a.parentId]?.children.indexOf(a.id) ?? 0 : 0
        const ang = siblings * 2.39996 + 0.6
        return {
          id, kind: 'agent', sessionId: s.id,
          x: (p?.x ?? anchor.x) + (isRoot ? 0 : Math.cos(ang) * 150), y: (p?.y ?? anchor.y) + (isRoot ? 0 : Math.sin(ang) * 150),
          vx: 0, vy: 0, r: isRoot ? 30 : 18, color: hc.color, label: '', alpha: 0, targetAlpha: 1, bornAt: now, grow: isRoot ? 1 : 0,
        }
      })
      n.agentId = a.id
      n.isRoot = isRoot
      n.parentNodeId = parentNodeId
      n.status = a.status
      n.thinking = a.thinking
      n.depth = a.depth
      n.harness = s.harness
      n.label = isRoot ? (s.meta.title ?? s.meta.project ?? 'main') : a.name
      n.sublabel = isRoot ? `${hc.short}${s.meta.model ? ' · ' + s.meta.model : ''}` : a.role ?? 'subagent'
      n.initials = isRoot ? (s.harness === 'codex' ? 'CX' : s.harness === 'claude-code' ? 'CC' : s.harness.slice(0, 2).toUpperCase()) : initials(a.role ?? a.name)
      const fillTokens = isRoot ? s.contextTokens : a.contextTokens
      const fillWindow = isRoot ? s.contextWindow : a.contextWindow
      n.contextFill = fillTokens && fillWindow ? Math.min(1, fillTokens / fillWindow) : undefined
      const stale = !isRoot && a.status === 'done' && now - a.lastActivityAt > 60_000
      n.r = isRoot ? 30 : stale ? 9 : 18
      n.targetAlpha = stale ? 0.45 : 1
      n.removing = false
    }

    // Radial slots: each agent knows its index among the visible children of its parent.
    const byParent = new Map<string, SNode[]>()
    for (const n of this.nodes.values()) {
      if (n.kind !== 'agent' || n.sessionId !== s.id || n.isRoot || n.removing || !n.parentNodeId) continue
      let list = byParent.get(n.parentNodeId)
      if (!list) byParent.set(n.parentNodeId, (list = []))
      list.push(n)
    }
    for (const [parentId, list] of byParent) {
      list.sort((a, b) => a.bornAt - b.bornAt || (a.id < b.id ? -1 : 1))
      list.forEach((n, i) => { n.sibIndex = i; n.sibCount = list.length })
      const p = this.nodes.get(parentId)
      if (p) for (const n of list) {
        if (n.placed) continue
        // Start new subagents near their slot so they glide out instead of spawning on the parent.
        const target = this.slotTarget(n, p)
        n.x = p.x + (target.x - p.x) * 0.35
        n.y = p.y + (target.y - p.y) * 0.35
        n.vx = n.vy = 0
        n.placed = true
      }
    }

    // Tools: open ones plus a few recent per agent.
    const visible = new Set<string>()
    const perAgent = new Map<string, number>()
    for (let i = s.toolOrder.length - 1; i >= 0; i--) {
      const t = s.tools[s.toolOrder[i]!]
      if (!t) continue
      const open = t.endedAt === undefined
      const recent = open || now - (t.endedAt ?? 0) < TOOL_RECENT_MS
      if (!recent) {
        if (now - t.startedAt > TOOL_RECENT_MS * 4) break
        continue
      }
      const count = perAgent.get(t.agentId) ?? 0
      if (!open && count >= TOOLS_PER_AGENT) continue
      perAgent.set(t.agentId, count + 1)
      const id = `t:${s.id}:${t.id}`
      visible.add(id)
      const ownerId = `a:${s.id}:${t.agentId}`
      const n = this.node(id, () => {
        const o = this.nodes.get(ownerId)
        const ang = rand(0, Math.PI * 2)
        return {
          id, kind: 'tool', sessionId: s.id, x: (o?.x ?? anchor.x) + Math.cos(ang) * 30, y: (o?.y ?? anchor.y) + Math.sin(ang) * 30,
          vx: Math.cos(ang) * 120, vy: Math.sin(ang) * 120, r: 7, color: categoryColor(t.category), label: t.title,
          alpha: 0, targetAlpha: 1, bornAt: now, grow: 0, slot: count,
        }
      })
      n.callId = t.id
      n.category = t.category
      n.ownerId = ownerId
      n.open = open
      n.ok = t.ok
      n.endedAt = t.endedAt
      n.label = t.title
      n.removing = false
      n.targetAlpha = open ? 1 : 0.85
      n.fileNodeIds = t.files.map((f) => `f:${s.id}:${f.path}`)
    }

    // Files: the hottest recent ones.
    const files = Object.values(s.files)
      .filter((f) => now - f.lastTs < FILE_RECENT_MS || f.touches >= 3)
      .sort((a, b) => b.lastTs - a.lastTs)
      .slice(0, FILES_PER_SESSION)
    for (const f of files) {
      const id = `f:${s.id}:${f.path}`
      visible.add(id)
      const lastAgentNodeId = `a:${s.id}:${f.lastAgentId}`
      const n = this.node(id, () => {
        const ang = rand(0, Math.PI * 2)
        return {
          id, kind: 'file', sessionId: s.id, x: anchor.x + Math.cos(ang) * 340, y: anchor.y + Math.sin(ang) * 340, vx: 0, vy: 0, r: 6,
          color: FILE_OP_COLOR[f.lastOp], label: basename(f.path), alpha: 0, targetAlpha: 1, bornAt: now, grow: 0,
        }
      })
      n.path = f.path
      n.lastTs = f.lastTs
      n.lastOp = f.lastOp
      n.touches = f.touches
      n.color = FILE_OP_COLOR[f.lastOp]
      n.lastAgentNodeId = lastAgentNodeId
      n.r = 5 + Math.min(5, Math.log2(1 + f.touches) * 1.4)
      n.removing = false
      n.targetAlpha = 1
    }

    for (const n of this.nodes.values()) {
      if (n.sessionId !== s.id || (n.kind !== 'tool' && n.kind !== 'file')) continue
      if (!visible.has(n.id)) {
        n.removing = true
        n.targetAlpha = 0
      }
    }
  }

  private effect(world: WorldState, e: ObserverEvent, now: number): void {
    const s = world.sessions[e.sessionId]
    if (!s) return
    const key = `${e.seq}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2000))
    const agentNode = `a:${s.id}:${e.agentId}`
    const rootNode = `a:${s.id}:${s.rootAgentId}`
    const userNode = `u:${s.id}`

    switch (e.kind) {
      case 'tool.started': {
        const toolNode = `t:${s.id}:${e.callId}`
        this.particle(agentNode, toolNode, categoryColor(e.category), 3, 0.5)
        break
      }
      case 'tool.finished': {
        const toolNode = `t:${s.id}:${e.callId}`
        const t = this.nodes.get(toolNode)
        this.particle(toolNode, agentNode, e.ok ? '#9dffcf' : '#ff5d73', e.ok ? 2.5 : 3.5, 0.55)
        if (t) {
          if (!e.ok) this.ring(t.x, t.y, '#ff5d73', 46, 900)
          for (const f of t.fileNodeIds ?? []) {
            this.particle(toolNode, f, t.color, 2.4, 0.7)
            const fn = this.nodes.get(f)
            if (fn) fn.flash = 1
          }
        }
        break
      }
      case 'message': {
        const text = e.text.replace(/\s+/g, ' ').trim()
        if (e.role === 'user') {
          this.particle(userNode, rootNode, '#ffffff', 4, 0.9)
          this.bubble(userNode, text, 'user', 7000)
        } else if (e.role === 'assistant') {
          this.bubble(agentNode, text, 'assistant', 6500)
          if (e.agentId === s.rootAgentId) this.particle(rootNode, userNode, harnessInfo(s.harness).color, 3, 0.9)
          else {
            const parent = s.agents[e.agentId]?.parentId
            if (parent) this.particle(agentNode, `a:${s.id}:${parent}`, '#ffd166', 3, 0.8)
          }
        } else {
          const parent = s.agents[e.agentId]?.parentId
          if (parent) this.particle(`a:${s.id}:${parent}`, agentNode, '#ffd166', 3.5, 0.8)
          this.bubble(agentNode, text, 'agent', 5000)
        }
        break
      }
      case 'agent.spawned': {
        const a = s.agents[e.agentId]
        const parent = a?.parentId ? `a:${s.id}:${a.parentId}` : rootNode
        const p = this.nodes.get(parent)
        if (p) this.ring(p.x, p.y, '#ffd166', 90, 1100)
        this.particle(parent, agentNode, '#ffd166', 5, 0.7)
        break
      }
      case 'turn.ended': {
        const n = this.nodes.get(agentNode)
        if (n) this.ring(n.x, n.y, e.outcome === 'completed' ? '#4fe39b' : '#ff5d73', n.isRoot ? 120 : 70, 1300)
        break
      }
      case 'agent.status': {
        if (e.status === 'waiting') {
          const n = this.nodes.get(agentNode)
          if (n) this.ring(n.x, n.y, '#ffb547', 80, 1200)
        }
        break
      }
    }
  }

  particle(from: string, to: string, color: string, size: number, dur: number): void {
    if (this.particles.length > 400) this.particles.shift()
    this.particles.push({ from, to, t: 0, dur, color, size })
  }

  bubble(nodeId: string, text: string, tone: Bubble['tone'], ttl: number): void {
    if (!text) return
    this.bubbles = this.bubbles.filter((b) => b.nodeId !== nodeId)
    this.bubbles.push({ nodeId, text, born: performance.now(), ttl, tone })
  }

  ring(x: number, y: number, color: string, maxR: number, ttl: number): void {
    if (this.rings.length > 60) this.rings.shift()
    this.rings.push({ x, y, born: performance.now(), ttl, color, maxR })
  }

  /** Where an agent sits in the radial tree around its parent. */
  slotTarget(n: SNode, p: SNode): { x: number; y: number } {
    const count = Math.max(1, n.sibCount ?? 1)
    const i = n.sibIndex ?? 0
    const dist = Math.max(170, 240 - (n.depth ?? 1) * 30) + Math.min(140, count > 8 ? (count - 8) * 9 : 0)
    let angle: number
    const gp = p.parentNodeId ? this.nodes.get(p.parentNodeId) : undefined
    if (p.isRoot || !gp) {
      angle = 0.35 + (i * Math.PI * 2) / count // full circle around the root, clear of the user node above
    } else {
      const dir = Math.atan2(p.y - gp.y, p.x - gp.x)
      const spread = Math.min(Math.PI * 1.1, 0.7 * count)
      angle = dir - spread / 2 + ((i + 0.5) * spread) / count
    }
    return { x: p.x + Math.cos(angle) * dist, y: p.y + Math.sin(angle) * dist }
  }

  /** Advance physics and effects by `dt` seconds (sub-stepped so slow frames still converge). */
  step(dt: number, now: number): void {
    dt = Math.min(dt, 0.25)
    const steps = Math.min(8, Math.max(1, Math.ceil(dt / 0.017)))
    for (let i = 0; i < steps; i++) this.physics(dt / steps)
    this.effects(dt, now)
  }

  private physics(dt: number): void {
    const nodes = [...this.nodes.values()]
    const bySession = new Map<string, SNode[]>()
    for (const n of nodes) {
      let list = bySession.get(n.sessionId)
      if (!list) bySession.set(n.sessionId, (list = []))
      list.push(n)
    }

    for (const [sid, list] of bySession) {
      const anchor = this.anchors.get(sid)
      if (!anchor) continue
      // Pairwise repulsion.
      for (let i = 0; i < list.length; i++) {
        const a = list[i]!
        for (let j = i + 1; j < list.length; j++) {
          const b = list[j]!
          let dx = b.x - a.x, dy = b.y - a.y
          let d2 = dx * dx + dy * dy
          if (d2 < 1) { dx = rand(-1, 1); dy = rand(-1, 1); d2 = 1 }
          const small = a.r < 12 || b.r < 12 ? 0.5 : 1
          const strength = a.kind === 'agent' && b.kind === 'agent' ? 200_000 * small : a.kind === 'tool' && b.kind === 'tool' ? 6_000 : a.kind === 'file' && b.kind === 'file' ? 30_000 : 16_000
          if (d2 > 640_000) continue
          const d = Math.sqrt(d2)
          const f = strength / Math.max(d2, 144)
          const fx = (dx / d) * f, fy = (dy / d) * f
          a.vx -= fx * dt; a.vy -= fy * dt
          b.vx += fx * dt; b.vy += fy * dt
        }
      }
      for (const n of list) {
        let tx: number | undefined, ty: number | undefined, rest = 0, k = 0
        if (n.kind === 'user') {
          n.x += (anchor.x - n.x) * Math.min(1, dt * 4)
          n.y += (anchor.y - 300 - n.y) * Math.min(1, dt * 4)
          n.vx = n.vy = 0
          continue
        }
        if (n.kind === 'agent') {
          if (n.isRoot) { tx = anchor.x; ty = anchor.y; rest = 0; k = 3.5 }
          else {
            const p = n.parentNodeId ? this.nodes.get(n.parentNodeId) : undefined
            if (p) {
              // Pull toward this agent's slot in a radial tree around its parent.
              const target = this.slotTarget(n, p)
              tx = target.x
              ty = target.y
              rest = 0
              k = 6
            }
          }
        } else if (n.kind === 'tool') {
          const o = n.ownerId ? this.nodes.get(n.ownerId) : undefined
          if (o) { tx = o.x; ty = o.y; rest = o.r + 48 + (n.slot ?? 0) * 9; k = 5 }
        } else if (n.kind === 'file') {
          // Hold files on a loose outer orbit, leaning toward whoever touched them last.
          const dx = n.x - anchor.x, dy = n.y - anchor.y
          const d = Math.hypot(dx, dy) || 1
          const R = 340
          const pull = (d - R) * 2
          n.vx -= (dx / d) * pull * dt
          n.vy -= (dy / d) * pull * dt
          const la = n.lastAgentNodeId ? this.nodes.get(n.lastAgentNodeId) : undefined
          if (la) { tx = la.x; ty = la.y; rest = 240; k = 0.12 }
        }
        // Keep every node inside its own session's neighbourhood.
        {
          const dx = n.x - anchor.x, dy = n.y - anchor.y
          const d = Math.hypot(dx, dy)
          if (d > CONTAIN_R) {
            const f = (d - CONTAIN_R) * 6
            n.vx -= (dx / d) * f * dt
            n.vy -= (dy / d) * f * dt
          }
        }
        if (tx !== undefined && ty !== undefined) {
          const dx = tx - n.x, dy = ty - n.y
          const d = Math.hypot(dx, dy) || 1
          const f = (d - rest) * k
          n.vx += (dx / d) * f * dt
          n.vy += (dy / d) * f * dt
        }
        const damp = Math.pow(0.86, dt * 60)
        n.vx *= damp
        n.vy *= damp
        n.x += n.vx * dt
        n.y += n.vy * dt
      }
    }

  }

  private effects(dt: number, now: number): void {
    const nodes = [...this.nodes.values()]
    for (const n of nodes) {
      n.alpha += (n.targetAlpha - n.alpha) * Math.min(1, dt * 6)
      n.grow += (1 - n.grow) * Math.min(1, dt * 7)
      if (n.flash) n.flash = Math.max(0, n.flash - dt * 1.5)
      if (n.removing && n.alpha < 0.02) this.nodes.delete(n.id)
    }
    for (const p of this.particles) p.t += dt / p.dur
    this.particles = this.particles.filter((p) => p.t < 1 && this.nodes.has(p.from) && this.nodes.has(p.to))
    const t = performance.now()
    this.bubbles = this.bubbles.filter((b) => t - b.born < b.ttl && this.nodes.has(b.nodeId))
    this.rings = this.rings.filter((r) => t - r.born < r.ttl)
    void now
  }

  /** Bounding box of visible nodes, for camera fitting. */
  bounds(): { minX: number; minY: number; maxX: number; maxY: number } | undefined {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const n of this.nodes.values()) {
      if (n.alpha < 0.2 || n.targetAlpha < 0.5) continue
      const pad = n.kind === 'agent' ? 70 : 30
      minX = Math.min(minX, n.x - pad); maxX = Math.max(maxX, n.x + pad)
      minY = Math.min(minY, n.y - pad); maxY = Math.max(maxY, n.y + pad)
    }
    return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : undefined
  }

  hit(x: number, y: number, scale: number): SNode | undefined {
    let best: SNode | undefined
    let bestD = Infinity
    for (const n of this.nodes.values()) {
      if (n.alpha < 0.15) continue
      const d = Math.hypot(n.x - x, n.y - y) - n.r
      const slop = 8 / scale
      if (d < slop && d < bestD) { best = n; bestD = d }
    }
    return best
  }
}

function initials(s: string): string {
  const words = s.replace(/[^A-Za-z0-9 _-]/g, '').split(/[\s_-]+/).filter(Boolean)
  if (!words.length) return '·'
  return (words.length === 1 ? words[0]!.slice(0, 2) : words[0]![0]! + words[1]![0]!).toUpperCase()
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || p
}
