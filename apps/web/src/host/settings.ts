/**
 * App settings: a tiny persisted key/value store with change subscriptions.
 * The host owns app-wide settings (which visualization, notifications);
 * each visualization declares its own, stored under `<viz id>.<key>`.
 */

export type SettingValue = string | boolean

export interface SettingDef {
  key: string
  label: string
  description?: string
  type: 'select' | 'toggle'
  options?: Array<{ value: string; label: string }>
  default: SettingValue
}

type Listener = (value: SettingValue, key: string) => void

const STORAGE_KEY = 'oadt-settings'

export class Settings {
  private values: Record<string, SettingValue> = {}
  private defaults: Record<string, SettingValue> = {}
  private listeners = new Map<string, Set<Listener>>()

  constructor() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) this.values = JSON.parse(raw) as Record<string, SettingValue>
    } catch { /* storage unavailable or corrupt: start fresh */ }
  }

  /** Register defaults so `get` has something to return before the user changes anything. */
  define(defs: SettingDef[]): void {
    for (const d of defs) this.defaults[d.key] = d.default
  }

  get<T extends SettingValue>(key: string): T {
    return (key in this.values ? this.values[key] : this.defaults[key]) as T
  }

  set(key: string, value: SettingValue): void {
    if (this.get(key) === value) return
    this.values[key] = value
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.values))
    } catch { /* not persisted, still applied */ }
    for (const fn of this.listeners.get(key) ?? []) fn(value, key)
    for (const fn of this.listeners.get('*') ?? []) fn(value, key)
  }

  /** Subscribe to one key (or '*' for all). Returns an unsubscribe function. */
  on(key: string, fn: Listener): () => void {
    let set = this.listeners.get(key)
    if (!set) this.listeners.set(key, (set = new Set()))
    set.add(fn)
    return () => set!.delete(fn)
  }
}

export type ThemeName = 'dark' | 'light' | 'gruvbox-dark' | 'gruvbox-light'

/** Resolve a theme setting ('system' follows the OS) to a concrete theme. */
export function resolveTheme(setting: string): ThemeName {
  if (setting === 'system') return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  return setting as ThemeName
}

/** A ready-made theme setting for visualizations that support the app's themes. */
export const THEME_SETTING: SettingDef = {
  key: 'theme', label: 'Theme', type: 'select', default: 'system',
  options: [
    { value: 'system', label: 'Follow system' },
    { value: 'dark', label: 'Dark' },
    { value: 'light', label: 'Light' },
    { value: 'gruvbox-dark', label: 'Gruvbox Dark' },
    { value: 'gruvbox-light', label: 'Gruvbox Light' },
  ],
}

export const NOTIFICATION_SETTINGS: SettingDef[] = [
  { key: 'notify.desktop', label: 'Desktop notifications', type: 'toggle', default: false, description: 'Show a system notification when something needs you. Your browser will ask for permission.' },
  { key: 'notify.sound', label: 'Sound', type: 'toggle', default: false, description: 'Play a short chime with each alert.' },
  { key: 'notify.title', label: 'Count in tab title', type: 'toggle', default: true, description: 'Prefix the tab title with the number of unacknowledged items.' },
  { key: 'notify.waiting', label: 'Approval needed', type: 'toggle', default: true, description: 'An agent is waiting on a permission prompt.' },
  { key: 'notify.finished', label: 'Turn finished', type: 'toggle', default: true, description: 'A session finished its turn and is ready for review.' },
  { key: 'notify.errors', label: 'Failure streaks', type: 'toggle', default: true, description: 'Several tool calls failed in a row.' },
  { key: 'notify.context', label: 'Context almost full', type: 'toggle', default: false, description: 'A live session is close to its context window.' },
  { key: 'notify.long-tool', label: 'Long-running tools', type: 'toggle', default: false, description: 'A tool has been running for several minutes.' },
]
