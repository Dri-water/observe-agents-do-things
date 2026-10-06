/**
 * The HTTP face of the observer. Zero dependencies — just node:http.
 *
 *   GET  /api/info                      server version, sources, privacy mode
 *   GET  /api/state[?session=id]        full WorldState snapshot
 *   GET  /api/sessions                  session summaries (no tool/file detail)
 *   GET  /api/sessions/:id              one session's full state
 *   GET  /api/sessions/:id/events       that session's event history (?after=seq)
 *   GET  /api/events?after=seq          global event log (for polling clients)
 *   GET  /api/stream[?session=id]       Server-Sent Events: hello → snapshot → live events
 *   POST /api/ingest                    push your own EventDrafts (JSON object or array)
 *
 * Security: binds to loopback by default, rejects foreign Host headers (DNS
 * rebinding) and only answers cross-origin requests from an explicit allowlist.
 * Transcripts contain your code and conversations — they never leave the machine
 * unless you deliberately expose the server (and then a token is required).
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { pickSessions, PROTOCOL_VERSION, type EventDraft, type ObserverEvent, type SessionState } from '@oadt/protocol'
import type { Observer } from '@oadt/core'

export const VERSION = '0.1.0'

export interface ServerOptions {
  observer: Observer
  host?: string
  port?: number
  /** Directory of a built frontend to serve at `/`. */
  uiDir?: string
  /** Required bearer token (also accepted as `?token=`). */
  token?: string
  /** Extra origins allowed to call the API cross-origin (e.g. a Vite dev server). */
  corsOrigins?: string[]
  /** Extra Host header values to accept (when bound to a LAN address). */
  allowedHosts?: string[]
  /** Disable POST /api/ingest. */
  readOnly?: boolean
  redactMode?: string
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function summarize(s: SessionState) {
  const { tools: _tools, toolOrder: _order, files, agents, ...rest } = s
  return { ...rest, agentCount: Object.keys(agents).length, fileCount: Object.keys(files).length }
}

export class ObserverServer {
  readonly http: Server
  private clients = new Set<ServerResponse>()
  private unsubscribe?: () => void
  private keepalive?: NodeJS.Timeout
  private readonly observer: Observer

  constructor(private opts: ServerOptions) {
    this.observer = opts.observer
    this.http = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        if (!res.headersSent) this.json(res, 500, { error: String(err) })
        else res.end()
      })
    })
  }

  async listen(): Promise<{ host: string; port: number; url: string }> {
    const host = this.opts.host ?? '127.0.0.1'
    await new Promise<void>((resolveListen, reject) => {
      this.http.once('error', reject)
      this.http.listen(this.opts.port ?? 4545, host, () => resolveListen())
    })
    const addr = this.http.address()
    const port = typeof addr === 'object' && addr ? addr.port : this.opts.port ?? 4545
    this.unsubscribe = this.observer.subscribe((e) => this.broadcast(e))
    this.keepalive = setInterval(() => {
      for (const c of this.clients) c.write(': keepalive\n\n')
    }, 15_000)
    this.keepalive.unref?.()
    const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host.includes(':') ? `[${host}]` : host
    return { host, port, url: `http://${shownHost}:${port}` }
  }

  close(): Promise<void> {
    this.unsubscribe?.()
    if (this.keepalive) clearInterval(this.keepalive)
    for (const c of this.clients) c.end()
    this.clients.clear()
    return new Promise((r) => this.http.close(() => r()))
  }

  // ─── security ──────────────────────────────────────────────────────────

  private hostAllowed(req: IncomingMessage): boolean {
    const raw = (req.headers.host ?? '').toLowerCase()
    const hostname = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.split(':')[0]!
    if (LOOPBACK.has(hostname)) return true
    const bound = (this.opts.host ?? '127.0.0.1').toLowerCase()
    if (hostname === bound) return true
    return (this.opts.allowedHosts ?? []).some((h) => h.toLowerCase() === hostname)
  }

  private originAllowed(origin: string | undefined, req: IncomingMessage): boolean {
    if (!origin) return true
    if ((this.opts.corsOrigins ?? []).includes(origin)) return true
    // Same-origin requests from our own UI.
    try {
      return new URL(origin).host === req.headers.host
    } catch {
      return false
    }
  }

  private authorized(req: IncomingMessage, url: URL): boolean {
    if (!this.opts.token) return true
    const header = req.headers.authorization
    if (header === `Bearer ${this.opts.token}`) return true
    return url.searchParams.get('token') === this.opts.token
  }

  // ─── routing ───────────────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!this.hostAllowed(req)) return this.json(res, 421, { error: 'host not allowed' })

    const origin = req.headers.origin
    if (origin) {
      if (!this.originAllowed(origin, req)) return this.json(res, 403, { error: 'origin not allowed' })
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('vary', 'origin')
      res.setHeader('access-control-allow-headers', 'authorization, content-type, last-event-id')
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    const path = url.pathname
    if (path.startsWith('/api/')) {
      if (!this.authorized(req, url)) return this.json(res, 401, { error: 'token required' })
      return this.api(req, res, url)
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return this.json(res, 405, { error: 'method not allowed' })
    return this.static(res, path)
  }

  private async api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname
    const store = this.observer.store
    const world = store.world

    if (req.method === 'POST' && path === '/api/ingest') return this.ingest(req, res)
    if (req.method !== 'GET') return this.json(res, 405, { error: 'method not allowed' })

    if (path === '/api/info') return this.json(res, 200, this.info())
    if (path === '/api/state') {
      const session = url.searchParams.get('session')
      return this.json(res, 200, session ? pickSessions(world, [session]) : world)
    }
    if (path === '/api/sessions') {
      return this.json(res, 200, { seq: world.seq, sessions: Object.values(world.sessions).map(summarize) })
    }
    if (path === '/api/events') {
      const after = Number(url.searchParams.get('after') ?? 0)
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 5000), 20000)
      const events = store.since(after, undefined, limit)
      if (!events) return this.json(res, 410, { error: 'history evicted; fetch /api/state', firstSeq: store.firstSeq })
      return this.json(res, 200, { seq: store.lastSeq, events })
    }
    if (path === '/api/stream') return this.stream(req, res, url)

    const m = /^\/api\/sessions\/([^/]+)(\/events)?$/.exec(path)
    if (m) {
      const id = decodeURIComponent(m[1]!)
      const s = world.sessions[id]
      if (!s) return this.json(res, 404, { error: 'unknown session' })
      if (!m[2]) return this.json(res, 200, s)
      const after = Number(url.searchParams.get('after') ?? 0)
      return this.json(res, 200, { seq: store.lastSeq, events: store.since(after, id) ?? store.sessionEvents(id) })
    }
    return this.json(res, 404, { error: 'not found' })
  }

  info() {
    return {
      protocol: PROTOCOL_VERSION,
      version: VERSION,
      seq: this.observer.store.lastSeq,
      sources: this.observer.describe(),
      redact: this.opts.redactMode ?? 'none',
      ingest: !this.opts.readOnly,
    }
  }

  // ─── streaming ─────────────────────────────────────────────────────────

  private stream(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const session = url.searchParams.get('session') ?? undefined
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const filter = session ? (e: ObserverEvent) => e.sessionId === session : undefined
    ;(res as ServerResponse & { filter?: typeof filter }).filter = filter
    res.write(`retry: 1000\n`)
    res.write(`event: hello\ndata: ${JSON.stringify(this.info())}\n\n`)

    const store = this.observer.store
    const lastId = Number(req.headers['last-event-id'] ?? url.searchParams.get('lastEventId') ?? NaN)
    const missed = Number.isFinite(lastId) && lastId > 0 ? store.since(lastId, session) : null
    if (missed) {
      res.write(`event: resumed\ndata: ${JSON.stringify({ from: lastId, count: missed.length })}\n\n`)
      for (const e of missed) res.write(frame(e))
    } else {
      const world = session ? pickSessions(store.world, [session]) : store.world
      res.write(`event: snapshot\ndata: ${JSON.stringify(world)}\n\n`)
    }
    this.clients.add(res)
    req.on('close', () => this.clients.delete(res))
  }

  private broadcast(e: ObserverEvent): void {
    if (this.clients.size === 0) return
    const data = frame(e)
    for (const c of this.clients) {
      const f = (c as ServerResponse & { filter?: (e: ObserverEvent) => boolean }).filter
      if (!f || f(e)) c.write(data)
    }
  }

  // ─── ingest ────────────────────────────────────────────────────────────

  private async ingest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.opts.readOnly) return this.json(res, 403, { error: 'ingest disabled' })
    // Requiring JSON forces a CORS preflight, so random web pages cannot post events.
    if (!(req.headers['content-type'] ?? '').includes('application/json')) {
      return this.json(res, 415, { error: 'content-type must be application/json' })
    }
    const chunks: Buffer[] = []
    let size = 0
    for await (const c of req) {
      size += (c as Buffer).length
      if (size > 4 * 1024 * 1024) return this.json(res, 413, { error: 'body too large' })
      chunks.push(c as Buffer)
    }
    let body: unknown
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return this.json(res, 400, { error: 'invalid JSON' })
    }
    const list = Array.isArray(body) ? body : [body]
    const drafts: EventDraft[] = []
    for (const item of list) {
      const problem = validateDraft(item)
      if (problem) return this.json(res, 400, { error: problem })
      const d = item as EventDraft
      drafts.push({ ...d, ts: typeof d.ts === 'number' ? d.ts : Date.now(), harness: d.harness ?? 'custom', agentId: d.agentId ?? d.sessionId } as EventDraft)
    }
    const events = this.observer.ingest(drafts)
    return this.json(res, 202, { accepted: events.length, seq: events[events.length - 1]?.seq })
  }

  // ─── static UI ─────────────────────────────────────────────────────────

  private async static(res: ServerResponse, path: string): Promise<void> {
    const dir = this.opts.uiDir
    if (!dir) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`observe-agents-do-things ${VERSION}\nNo UI bundled. The API is at /api/info and /api/stream.\n`)
      return
    }
    const root = resolve(dir)
    let file = normalize(join(root, decodeURIComponent(path)))
    if (!file.startsWith(root + sep) && file !== root) return this.json(res, 403, { error: 'forbidden' })
    let st = await stat(file).catch(() => null)
    if (st?.isDirectory()) {
      file = join(file, 'index.html')
      st = await stat(file).catch(() => null)
    }
    if (!st) {
      // SPA fallback
      file = join(root, 'index.html')
      st = await stat(file).catch(() => null)
      if (!st) return this.json(res, 404, { error: 'not found' })
    }
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
    const immutable = /[\\/]assets[\\/]/.test(file)
    res.writeHead(200, {
      'content-type': type,
      'content-length': st.size,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
    })
    createReadStream(file).pipe(res)
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const data = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(data)
  }
}

function frame(e: ObserverEvent): string {
  return `id: ${e.seq}\nevent: event\ndata: ${JSON.stringify(e)}\n\n`
}

const KINDS = new Set([
  'session.started', 'session.updated', 'session.status', 'agent.spawned', 'agent.status', 'turn.started',
  'turn.ended', 'message', 'thinking', 'tool.started', 'tool.finished', 'usage', 'note',
])

export function validateDraft(item: unknown): string | undefined {
  if (!item || typeof item !== 'object') return 'event must be an object'
  const d = item as Record<string, unknown>
  if (typeof d.kind !== 'string' || !KINDS.has(d.kind)) return `unknown kind: ${String(d.kind)}`
  if (typeof d.sessionId !== 'string' || !d.sessionId) return 'sessionId is required'
  if (d.agentId !== undefined && typeof d.agentId !== 'string') return 'agentId must be a string'
  if (d.kind === 'tool.started' && (typeof d.callId !== 'string' || typeof d.tool !== 'string' || typeof d.title !== 'string' || typeof d.category !== 'string')) {
    return 'tool.started needs callId, tool, title and category'
  }
  if (d.kind === 'tool.finished' && (typeof d.callId !== 'string' || typeof d.ok !== 'boolean')) return 'tool.finished needs callId and ok'
  if (d.kind === 'message' && (typeof d.text !== 'string' || typeof d.role !== 'string')) return 'message needs role and text'
  if (d.kind === 'usage' && (typeof d.delta !== 'object' || d.delta === null)) return 'usage needs delta'
  if ((d.kind === 'session.started' || d.kind === 'session.updated') && (typeof d.meta !== 'object' || d.meta === null)) return 'meta is required'
  return undefined
}
