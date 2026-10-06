/**
 * @oadt/react — React bindings for observe-agents-do-things.
 *
 * ```tsx
 * <ObserverProvider url="http://127.0.0.1:4545">
 *   <App />
 * </ObserverProvider>
 *
 * function App() {
 *   const sessions = useSessions()
 *   return sessions.map((s) => <div key={s.id}>{s.meta.title} — {s.status}</div>)
 * }
 * ```
 *
 * The client keeps one live WorldState that it updates in place, so hooks
 * re-render on every (throttled) change rather than relying on object
 * identity. Read state through hooks in the component that renders it, or pass
 * ids down instead of state objects into `React.memo` components.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import {
  ObserverClient,
  agentTree,
  hotFiles,
  isLive,
  openTools,
  sessionList,
  worldTotals,
  type AgentNode,
  type ClientOptions,
  type ConnectionStatus,
  type FileStats,
  type ObserverEvent,
  type SessionState,
  type ToolCallState,
  type WorldState,
} from '@oadt/client'

export * from '@oadt/client'

/** A change feed over a client: one version number, bumped at most once per `throttleMs`. */
class Store {
  version = 0
  private listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private last = 0
  private offs: Array<() => void> = []

  constructor(readonly client: ObserverClient, private throttleMs: number) {
    this.offs.push(client.onChange(() => this.schedule()))
    this.offs.push(client.on('status', () => this.bump()))
  }

  private schedule(): void {
    if (this.timer) return
    const wait = Math.max(0, this.last + this.throttleMs - Date.now())
    if (wait === 0) return this.bump()
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.bump()
    }, wait)
  }

  private bump(): void {
    this.last = Date.now()
    this.version++
    for (const l of this.listeners) l()
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getVersion = (): number => this.version

  dispose(): void {
    for (const off of this.offs) off()
    if (this.timer) clearTimeout(this.timer)
  }
}

const Ctx = createContext<Store | null>(null)

export interface ObserverProviderProps extends ClientOptions {
  /** Use an existing client instead of creating one. The provider will not connect or close it. */
  client?: ObserverClient
  /** Re-render at most this often while events stream in (ms). Default 100. */
  throttleMs?: number
  children?: ReactNode
}

/** Connects to an observer server and makes its live state available to hooks. */
export function ObserverProvider({ client: external, throttleMs = 100, children, url, token, session, reconnectMs, fetch }: ObserverProviderProps) {
  const client = useMemo(
    () => external ?? new ObserverClient({ url, token, session, reconnectMs, fetch }),
    // Reconnect when the target changes.
    [external, url, token, session, reconnectMs, fetch],
  )
  const store = useMemo(() => new Store(client, throttleMs), [client, throttleMs])

  useEffect(() => {
    if (!external) client.connect()
    return () => {
      store.dispose()
      if (!external) client.close()
    }
  }, [client, store, external])

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>
}

function useStore(): Store {
  const store = useContext(Ctx)
  if (!store) throw new Error('@oadt/react hooks must be used inside <ObserverProvider>')
  return store
}

/** The underlying client (for `sessionEvents()`, `info()`, or custom subscriptions). */
export function useObserverClient(): ObserverClient {
  return useStore().client
}

/**
 * Subscribe to the live world and derive a value from it.
 * Re-renders whenever the world changes (throttled).
 */
export function useObserver<T>(select: (world: WorldState) => T): T {
  const store = useStore()
  const version = useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion)
  // Recompute on every version; the world is mutated in place.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => select(store.client.world), [version, select, store])
}

/** The whole live WorldState. */
export function useWorld(): WorldState {
  return useObserver(selectWorld)
}

/** Sessions ordered for display (waiting, then working, then most recent). */
export function useSessions(opts: { liveOnly?: boolean } = {}): SessionState[] {
  const liveOnly = !!opts.liveOnly
  return useObserver(useMemo(() => (w: WorldState) => {
    const list = sessionList(w)
    return liveOnly ? list.filter(isLive) : list
  }, [liveOnly]))
}

/** One session, or undefined if it isn't known (yet). */
export function useSession(id: string | undefined): SessionState | undefined {
  return useObserver(useMemo(() => (w: WorldState) => (id ? w.sessions[id] : undefined), [id]))
}

/** A session's agents as a tree rooted at the main agent. */
export function useAgentTree(sessionId: string | undefined): AgentNode | undefined {
  return useObserver(useMemo(() => (w: WorldState) => {
    const s = sessionId ? w.sessions[sessionId] : undefined
    return s ? agentTree(s) : undefined
  }, [sessionId]))
}

/** Tool calls currently in flight, for one session or across all of them. */
export function useOpenTools(sessionId?: string): ToolCallState[] {
  return useObserver(useMemo(() => (w: WorldState) => {
    if (sessionId) {
      const s = w.sessions[sessionId]
      return s ? openTools(s) : []
    }
    return Object.values(w.sessions).flatMap(openTools)
  }, [sessionId]))
}

/** The most-touched files in a session. */
export function useHotFiles(sessionId: string | undefined, limit = 30): FileStats[] {
  return useObserver(useMemo(() => (w: WorldState) => {
    const s = sessionId ? w.sessions[sessionId] : undefined
    return s ? hotFiles(s, limit) : []
  }, [sessionId, limit]))
}

/** Aggregate counts across every session. */
export function useTotals(): ReturnType<typeof worldTotals> {
  return useObserver(worldTotals)
}

/** `connecting` | `live` | `reconnecting` | `closed`. */
export function useConnectionStatus(): ConnectionStatus {
  const store = useStore()
  // The store bumps its version on status changes too.
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion)
  return store.client.status
}

export interface UseEventsOptions {
  /** Only events from this session. */
  session?: string
  /** Keep at most this many (newest last). Default 200. */
  limit?: number
  /** Keep only matching events. */
  filter?: (e: ObserverEvent) => boolean
  /** Pre-fill with the session's history from the server. Default true when `session` is set. */
  backfill?: boolean
}

/** A rolling list of recent events, newest last. Handy for feeds and logs. */
export function useEvents(opts: UseEventsOptions = {}): ObserverEvent[] {
  const { session, limit = 200, backfill = !!session } = opts
  const client = useObserverClient()
  const filterRef = useRef(opts.filter)
  filterRef.current = opts.filter
  const [events, setEvents] = useState<ObserverEvent[]>([])

  useEffect(() => {
    let cancelled = false
    const keep = (e: ObserverEvent) => (!session || e.sessionId === session) && (!filterRef.current || filterRef.current(e))
    setEvents([])
    if (backfill && session) {
      client.sessionEvents(session).then((history) => {
        if (cancelled) return
        setEvents((cur) => {
          const seen = new Set(cur.map((e) => e.seq))
          return [...history.filter((e) => keep(e) && !seen.has(e.seq)), ...cur].slice(-limit)
        })
      }).catch(() => { /* history is optional */ })
    }
    const off = client.onChange((_w, batch) => {
      const fresh = batch.filter(keep)
      if (fresh.length) setEvents((cur) => [...cur, ...fresh].slice(-limit))
    })
    return () => {
      cancelled = true
      off()
    }
  }, [client, session, limit, backfill])

  return events
}

/** Re-render every `ms` — for "3s ago" labels and running-tool timers. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

function selectWorld(w: WorldState): WorldState {
  return w
}
