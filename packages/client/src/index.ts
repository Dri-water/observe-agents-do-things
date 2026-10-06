/**
 * @oadt/client — connect any frontend to an observe-agents-do-things server.
 *
 * ```ts
 * import { connect } from '@oadt/client'
 * const client = connect({ url: 'http://127.0.0.1:4545' })
 * client.onChange((world, events) => render(world))
 * ```
 *
 * The client keeps a live mirror of the server's WorldState by applying the
 * same pure projection (`applyEvent`) the server uses, and resumes from the
 * last seen sequence number after a disconnect.
 */
import { applyEvent, createWorld, type ObserverEvent, type WorldState } from '@oadt/protocol'

export * from '@oadt/protocol'

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'closed'

export interface ClientOptions {
  /** Server origin, e.g. `http://127.0.0.1:4545`. Defaults to the current page's origin. */
  url?: string
  /** Bearer token, if the server requires one. */
  token?: string
  /** Only stream this session. */
  session?: string
  /** Delay before reconnecting (ms). Default 1000, backs off to 10s. */
  reconnectMs?: number
  /** Custom fetch (tests, polyfills). */
  fetch?: typeof fetch
}

export interface ServerHello {
  protocol: number
  version: string
  seq: number
  sources: Array<Record<string, unknown>>
  redact: string
}

type Handlers = {
  event: (event: ObserverEvent, world: WorldState) => void
  snapshot: (world: WorldState) => void
  change: (world: WorldState, events: ObserverEvent[]) => void
  status: (status: ConnectionStatus, error?: unknown) => void
  hello: (hello: ServerHello) => void
}

export class ObserverClient {
  world: WorldState = createWorld()
  status: ConnectionStatus = 'closed'
  hello?: ServerHello
  private handlers: { [K in keyof Handlers]: Set<Handlers[K]> } = {
    event: new Set(), snapshot: new Set(), change: new Set(), status: new Set(), hello: new Set(),
  }
  private abort?: AbortController
  private lastSeq = 0
  private pending: ObserverEvent[] = []
  private flushScheduled = false
  private retryMs: number
  private readonly base: string
  private readonly fetchImpl: typeof fetch

  constructor(private opts: ClientOptions = {}) {
    this.base = (opts.url ?? '').replace(/\/+$/, '')
    this.retryMs = opts.reconnectMs ?? 1000
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis)
  }

  on<K extends keyof Handlers>(type: K, fn: Handlers[K]): () => void {
    this.handlers[type].add(fn)
    return () => this.handlers[type].delete(fn)
  }

  /** Called at most once per microtask with every event since the last call (and after snapshots). */
  onChange(fn: Handlers['change']): () => void {
    return this.on('change', fn)
  }

  connect(): this {
    if (this.status !== 'closed') return this
    this.abort = new AbortController()
    void this.loop(this.abort.signal)
    return this
  }

  close(): void {
    this.abort?.abort()
    this.setStatus('closed')
  }

  /** Full (bounded) event history for one session. */
  async sessionEvents(sessionId: string, after = 0): Promise<ObserverEvent[]> {
    const res = await this.get(`/api/sessions/${encodeURIComponent(sessionId)}/events?after=${after}`)
    const body = (await res.json()) as { events: ObserverEvent[] }
    return body.events
  }

  /** Server metadata: version, sources, privacy mode. */
  async info(): Promise<ServerHello> {
    return (await (await this.get('/api/info')).json()) as ServerHello
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.opts.token ? { authorization: `Bearer ${this.opts.token}`, ...extra } : extra
  }

  private async get(path: string): Promise<Response> {
    const res = await this.fetchImpl(this.base + path, { headers: this.headers() })
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
    return res
  }

  private setStatus(s: ConnectionStatus, err?: unknown): void {
    if (this.status === s && !err) return
    this.status = s
    for (const fn of this.handlers.status) fn(s, err)
  }

  private async loop(signal: AbortSignal): Promise<void> {
    let delay = this.retryMs
    while (!signal.aborted) {
      this.setStatus(this.lastSeq ? 'reconnecting' : 'connecting')
      try {
        const qs = this.opts.session ? `?session=${encodeURIComponent(this.opts.session)}` : ''
        const res = await this.fetchImpl(`${this.base}/api/stream${qs}`, {
          headers: this.headers({ accept: 'text/event-stream', ...(this.lastSeq ? { 'last-event-id': String(this.lastSeq) } : {}) }),
          signal,
        })
        if (!res.ok || !res.body) throw new Error(`stream: HTTP ${res.status}`)
        delay = this.retryMs
        await this.read(res.body, signal)
      } catch (err) {
        if (signal.aborted) return
        this.setStatus('reconnecting', err)
      }
      if (signal.aborted) return
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(delay * 2, 10_000)
    }
  }

  private async read(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (!signal.aborted) {
      const { value, done } = await reader.read()
      if (done) return
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
        const block = buf.slice(0, idx)
        buf = buf.slice(idx + (buf[idx] === '\r' ? 4 : 2))
        this.dispatch(block)
      }
    }
  }

  private dispatch(block: string): void {
    let type = 'message'
    const data: string[] = []
    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue
      const i = line.indexOf(':')
      const field = i < 0 ? line : line.slice(0, i)
      const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '')
      if (field === 'event') type = value
      else if (field === 'data') data.push(value)
    }
    if (!data.length) return
    const payload: unknown = JSON.parse(data.join('\n'))
    switch (type) {
      case 'hello':
        this.hello = payload as ServerHello
        for (const fn of this.handlers.hello) fn(this.hello)
        break
      case 'snapshot':
        this.world = payload as WorldState
        this.lastSeq = this.world.seq
        this.pending = []
        this.setStatus('live')
        for (const fn of this.handlers.snapshot) fn(this.world)
        this.scheduleFlush(true)
        break
      case 'event': {
        const e = payload as ObserverEvent
        if (e.seq <= this.lastSeq) break
        this.lastSeq = e.seq
        applyEvent(this.world, e)
        this.setStatus('live')
        for (const fn of this.handlers.event) fn(e, this.world)
        this.pending.push(e)
        this.scheduleFlush()
        break
      }
      case 'resumed':
        this.setStatus('live')
        break
    }
  }

  private scheduleFlush(force = false): void {
    if (this.flushScheduled) return
    if (!force && this.handlers.change.size === 0) { this.pending = []; return }
    this.flushScheduled = true
    queueMicrotask(() => {
      this.flushScheduled = false
      const events = this.pending
      this.pending = []
      for (const fn of this.handlers.change) fn(this.world, events)
    })
  }
}

/** Create a client and start streaming. */
export function connect(opts: ClientOptions = {}): ObserverClient {
  return new ObserverClient(opts).connect()
}
