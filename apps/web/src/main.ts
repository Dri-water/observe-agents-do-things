/**
 * The host: connects to the observer once, owns settings, theme and attention
 * (notifications), and mounts one visualization at a time into #viz-root.
 * Visualizations own everything they draw — see viz/types.ts.
 */
import './host.css'
import { connect } from '@oadt/client'
import { AttentionService } from './host/attention'
import { GLOBAL_SETTINGS, resolveTheme, Settings, type SettingDef, type SettingsSection, type ThemeName } from './host/settings'
import { SettingsPanel } from './host/settings-panel'
import { VISUALIZATIONS } from './viz'
import type { VizInstance, Visualization } from './viz/types'

// A token can arrive via ?token= (printed by the CLI). Keep it in session
// storage and strip it from the address bar so it doesn't linger in history.
const params = new URLSearchParams(location.search)
let token = params.get('token') ?? undefined
try {
  if (token) sessionStorage.setItem('oadt-token', token)
  else token = sessionStorage.getItem('oadt-token') ?? undefined
} catch { /* storage unavailable */ }
if (params.has('token')) {
  params.delete('token')
  history.replaceState(null, '', location.pathname + (params.toString() ? `?${params}` : '') + location.hash)
}

const client = connect({ url: params.get('api') ?? '', token })
const root = document.getElementById('viz-root')!

// ─── Settings & theme ───────────────────────────────────────────────────

const settings = new Settings()
const vizSetting: SettingDef = {
  key: 'viz', label: 'Visualization', type: 'select', default: VISUALIZATIONS[0]!.id,
  description: 'Each visualization is a different way of looking at the same live data. Shortcut: V.',
  options: VISUALIZATIONS.map((v) => ({ value: v.id, label: v.name })),
}
settings.define([vizSetting, ...GLOBAL_SETTINGS.flatMap((s) => s.settings)])
for (const v of VISUALIZATIONS) settings.define((v.settings ?? []).map((d) => ({ ...d, key: `${v.id}.${d.key}` })))

function sections(): SettingsSection[] {
  const [appearance, ...rest] = GLOBAL_SETTINGS
  return [
    { ...appearance!, settings: [vizSetting, ...appearance!.settings] },
    ...rest,
    ...VISUALIZATIONS.filter((v) => v.settings?.length).map((v) => ({
      id: v.id,
      title: v.name,
      description: v.description,
      settings: v.settings!.map((d) => ({ ...d, key: `${v.id}.${d.key}` })),
    })),
  ]
}

const themeListeners = new Set<(t: ThemeName) => void>()
let theme = resolveTheme(settings.get<string>('theme'))
function applyTheme(): void {
  theme = resolveTheme(settings.get<string>('theme'))
  document.documentElement.dataset.theme = theme
  for (const fn of themeListeners) fn(theme)
}
settings.on('theme', applyTheme)
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (settings.get('theme') === 'system') applyTheme()
})
applyTheme()

// ─── Attention & settings page ──────────────────────────────────────────

let current: { viz: Visualization; instance: VizInstance; slot: HTMLElement } | undefined
const attention = new AttentionService(client, settings, (sessionId) => current?.instance.focusSession?.(sessionId))
const panel = new SettingsPanel({ settings, sections, attention })
document.body.append(panel.el)

// ─── Host controls (switcher + settings button) ─────────────────────────

const switcher = document.createElement('div')
switcher.className = 'viz-switcher'
const button = document.createElement('button')
button.className = 'viz-switcher-button'
button.title = 'Switch visualization (V)'
const gear = document.createElement('button')
gear.className = 'viz-switcher-button viz-settings-button'
gear.title = 'Settings (Ctrl+,)'
gear.setAttribute('aria-label', 'Settings')
gear.textContent = '⚙'
gear.addEventListener('click', () => panel.toggle())
const menu = document.createElement('div')
menu.className = 'viz-switcher-menu'
menu.hidden = true
switcher.append(button, gear, menu)

function renderSwitcher(): void {
  button.innerHTML = `<span class="viz-switcher-icon">◐</span><span></span><span class="viz-switcher-caret">▾</span>`
  button.children[1]!.textContent = current?.viz.name ?? 'View'
  menu.replaceChildren(...VISUALIZATIONS.map((v) => {
    const item = document.createElement('button')
    item.className = 'viz-switcher-item' + (v.id === current?.viz.id ? ' on' : '')
    item.innerHTML = `<b></b><span></span>`
    item.querySelector('b')!.textContent = v.name
    item.querySelector('span')!.textContent = v.description
    item.addEventListener('click', () => { menu.hidden = true; settings.set('viz', v.id) })
    return item
  }))
}
button.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden })
document.addEventListener('click', (e) => { if (!switcher.contains(e.target as Node)) menu.hidden = true })

// ─── Mounting ───────────────────────────────────────────────────────────

function show(id: string): void {
  const viz = VISUALIZATIONS.find((v) => v.id === id) ?? VISUALIZATIONS[0]!
  if (current?.viz.id === viz.id) return
  current?.instance.destroy()
  current?.slot.remove()
  switcher.remove()
  switcher.classList.remove('floating')

  // Each visualization gets a fresh element, so nothing leaks between them.
  const slot = document.createElement('div')
  slot.className = `viz viz-${viz.id}`
  root.append(slot)
  current = {
    viz,
    slot,
    instance: viz.mount(slot, {
      client,
      switcher,
      settings,
      attention,
      theme: () => theme,
      onTheme: (fn) => { themeListeners.add(fn); return () => themeListeners.delete(fn) },
      openSettings: (section) => panel.open(section),
    }),
  }
  if (!switcher.isConnected) {
    switcher.classList.add('floating')
    document.body.append(switcher)
  }
  renderSwitcher()
  const url = new URL(location.href)
  url.searchParams.set('viz', viz.id)
  history.replaceState(null, '', url)
  document.documentElement.dataset.viz = viz.id
}

settings.on('viz', (id) => show(String(id)))

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === ',') {
    e.preventDefault()
    panel.toggle()
    return
  }
  if (panel.isOpen) {
    // The settings page is modal: keep shortcuts from reaching the visualization behind it.
    e.stopImmediatePropagation()
    if (e.key === 'Escape') panel.close()
    return
  }
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return
  if (e.metaKey || e.ctrlKey || e.altKey) return
  if (e.key === 'v' || e.key === 'V') {
    const i = VISUALIZATIONS.findIndex((v) => v.id === current?.viz.id)
    settings.set('viz', VISUALIZATIONS[(i + 1) % VISUALIZATIONS.length]!.id)
  }
}, true)

const requested = params.get('viz')
if (requested && VISUALIZATIONS.some((v) => v.id === requested)) settings.set('viz', requested)
show(settings.get<string>('viz'))

// Debug handle for DevTools: the live client and the mounted visualization.
;(window as unknown as { __oadt: unknown }).__oadt = {
  client,
  show: (id: string) => settings.set('viz', id),
  settings,
  attention,
  visualizations: VISUALIZATIONS,
  get current() { return current?.viz.id },
}
