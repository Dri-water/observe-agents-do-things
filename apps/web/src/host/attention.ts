/**
 * Attention service: turns the protocol's attention rules into acknowledgements,
 * desktop notifications, a chime and a tab-title count. Owned by the host so it
 * keeps working whichever visualization is on screen.
 */
import { attentionItems, type AttentionItem, type ObserverClient } from '@oadt/client'
import type { Settings } from './settings'

const ACK_KEY = 'oadt-acked'
const MAX_ACKS = 500

export class AttentionService {
  private items: AttentionItem[] = []
  private acked: Set<string>
  private seen = new Set<string>()
  private primed = false
  private listeners = new Set<(items: AttentionItem[]) => void>()
  private timer: ReturnType<typeof setInterval>
  private readonly baseTitle = document.title
  private audio?: AudioContext

  constructor(private client: ObserverClient, private settings: Settings, private onOpen: (sessionId: string) => void) {
    let stored: string[] = []
    try { stored = JSON.parse(localStorage.getItem(ACK_KEY) ?? '[]') as string[] } catch { /* ignore */ }
    this.acked = new Set(stored)
    this.timer = setInterval(() => this.refresh(), 1000)
    settings.on('notify.title', () => this.updateTitle())
    client.onChange(() => { if (!this.primed && client.status === 'live') this.refresh() })
  }

  /** Current items, most urgent first. */
  all(): AttentionItem[] {
    return this.items
  }

  /** Items the user hasn't acknowledged. */
  open(): AttentionItem[] {
    return this.items.filter((i) => !this.acked.has(i.id))
  }

  isAcked(id: string): boolean {
    return this.acked.has(id)
  }

  ack(id: string): void {
    this.acked.add(id)
    this.persist()
  }

  unack(id: string): void {
    this.acked.delete(id)
    this.persist()
  }

  ackAll(): void {
    for (const i of this.items) this.acked.add(i.id)
    this.persist()
  }

  subscribe(fn: (items: AttentionItem[]) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Ask the browser for notification permission (must be called from a user gesture). */
  async requestPermission(): Promise<NotificationPermission | 'unsupported'> {
    if (!('Notification' in window)) return 'unsupported'
    if (Notification.permission === 'default') return Notification.requestPermission()
    return Notification.permission
  }

  destroy(): void {
    clearInterval(this.timer)
    document.title = this.baseTitle
  }

  private persist(): void {
    try { localStorage.setItem(ACK_KEY, JSON.stringify([...this.acked].slice(-MAX_ACKS))) } catch { /* ignore */ }
    this.emit()
  }

  private refresh(): void {
    if (this.client.status !== 'live' && !this.primed) return
    this.items = attentionItems(this.client.world, Date.now())
    const fresh = this.items.filter((i) => !this.seen.has(i.id) && !this.acked.has(i.id))
    for (const i of this.items) this.seen.add(i.id)
    if (this.seen.size > 2000) this.seen = new Set([...this.seen].slice(-1000))
    // Don't alert for everything that was already going on when the page opened.
    if (this.primed) for (const i of fresh) this.alert(i)
    this.primed = true
    this.emit()
  }

  private emit(): void {
    this.updateTitle()
    for (const fn of this.listeners) fn(this.items)
  }

  private updateTitle(): void {
    const n = this.open().filter((i) => i.severity !== 'low').length
    document.title = this.settings.get<boolean>('notify.title') && n ? `(${n}) ${this.baseTitle}` : this.baseTitle
  }

  private alert(item: AttentionItem): void {
    const kind = item.kind === 'aborted' ? 'finished' : item.kind
    if (!this.settings.get<boolean>(`notify.${kind}`)) return
    const s = this.client.world.sessions[item.sessionId]
    const where = s?.meta.title ?? s?.meta.project ?? 'Agent session'
    if (this.settings.get<boolean>('notify.desktop') && 'Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(`${where}: ${item.title}`, { body: item.detail ?? '', tag: item.id, silent: true })
      n.onclick = () => {
        window.focus()
        this.onOpen(item.sessionId)
        n.close()
      }
    }
    if (this.settings.get<boolean>('notify.sound')) this.chime(item.severity === 'high')
  }

  private chime(urgent: boolean): void {
    try {
      this.audio ??= new AudioContext()
      const ctx = this.audio
      const notes = urgent ? [880, 660, 880] : [660, 880]
      notes.forEach((f, i) => {
        const o = ctx.createOscillator()
        const g = ctx.createGain()
        o.type = 'sine'
        o.frequency.value = f
        const t = ctx.currentTime + i * 0.13
        g.gain.setValueAtTime(0, t)
        g.gain.linearRampToValueAtTime(0.12, t + 0.02)
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.25)
        o.connect(g).connect(ctx.destination)
        o.start(t)
        o.stop(t + 0.3)
      })
    } catch { /* audio unavailable */ }
  }
}
