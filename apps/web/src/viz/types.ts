/**
 * The contract between the web host and a visualization.
 *
 * The host only connects to the observer and hands the visualization an empty
 * element. Everything inside it — DOM, canvas or WebGL, layout, panels, input,
 * animation loop, styling — belongs to the visualization. All data comes from
 * `ctx.client` (the live WorldState plus the event stream); a visualization
 * never parses transcripts or derives agent state on its own.
 */
import type { ObserverClient } from '@oadt/client'
import type { AttentionService } from '../host/attention'
import type { SettingDef, Settings, ThemeName } from '../host/settings'

export type { SettingDef, ThemeName }

export interface VizContext {
  /** Live connection: `client.world`, `client.onChange`, `client.on('event')`, `client.sessionEvents()`… */
  client: ObserverClient
  /**
   * The host's controls (visualization switcher and settings button). Put them
   * wherever they fit your layout. If you don't attach them during `mount`, the
   * host floats them in a corner.
   */
  switcher: HTMLElement
  /** Persisted settings. Your own settings live under `<viz id>.<key>`. */
  settings: Settings
  /** The resolved app theme, and a subscription for changes. */
  theme(): ThemeName
  onTheme(fn: (theme: ThemeName) => void): () => void
  /** What needs the user (shared with notifications), including acknowledgements. */
  attention: AttentionService
  /** Open the settings page, optionally at a section (e.g. your viz id). */
  openSettings(section?: string): void
}

export interface VizInstance {
  /** Tear down everything: animation frames, timers, listeners, client subscriptions. */
  destroy(): void
  /** Optional: bring a session into focus (used when a notification is clicked). */
  focusSession?(sessionId: string): void
}

export interface Visualization {
  id: string
  name: string
  /** One line for the switcher menu. */
  description: string
  /** Settings shown on the settings page under this visualization. Keys are relative (`labels` → `<id>.labels`). */
  settings?: SettingDef[]
  mount(root: HTMLElement, ctx: VizContext): VizInstance
}

/** Collects cleanup callbacks so a visualization can tear down in one call. */
export class Disposer {
  private fns: Array<() => void> = []
  add(fn: () => void): void {
    this.fns.push(fn)
  }
  listen<K extends keyof WindowEventMap>(target: Window, type: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions): void
  listen(target: EventTarget, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions): void
  listen(target: EventTarget, type: string, fn: (e: never) => void, opts?: AddEventListenerOptions): void {
    target.addEventListener(type, fn as EventListener, opts)
    this.fns.push(() => target.removeEventListener(type, fn as EventListener, opts))
  }
  /** requestAnimationFrame loop that stops on dispose. */
  loop(frame: (t: number) => void): void {
    let id = 0
    let alive = true
    const tick = (t: number) => {
      if (!alive) return
      frame(t)
      id = requestAnimationFrame(tick)
    }
    id = requestAnimationFrame(tick)
    this.fns.push(() => { alive = false; cancelAnimationFrame(id) })
  }
  dispose(): void {
    for (const fn of this.fns.splice(0).reverse()) {
      try { fn() } catch { /* keep tearing down */ }
    }
  }
}
