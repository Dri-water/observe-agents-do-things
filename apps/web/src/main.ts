/**
 * The host: connects to the observer once, owns settings and attention
 * (notifications), and mounts one visualization at a time into #viz-root.
 * Visualizations own everything they draw — see viz/types.ts. Which
 * visualization is shown is chosen in Settings › Visualizations.
 */
import './host.css'
import { connect } from '@oadt/client'
import { AttentionService } from './host/attention'
import { DISPLAY_SETTINGS, NOTIFICATION_SETTINGS, resolveTheme, ZOOM_LEVELS, Settings, type SettingDef, type ThemeName } from './host/settings'
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

// ─── Settings ───────────────────────────────────────────────────────────

const settings = new Settings()
const VIZ_SETTING: SettingDef = { key: 'viz', label: 'Visualization', type: 'select', default: VISUALIZATIONS[0]!.id }
settings.define([VIZ_SETTING, ...DISPLAY_SETTINGS, ...NOTIFICATION_SETTINGS])

// Zoom scales the whole page (every visualization and the settings dialog) in one place.
const zoom = () => Number(settings.get<string>('ui.zoom')) || 100
const applyZoom = () => { document.documentElement.style.zoom = String(zoom() / 100) }
applyZoom()
settings.on('ui.zoom', applyZoom)
function stepZoom(dir: 1 | -1 | 0): void {
  const now = zoom()
  const next = dir === 0 ? 100 : dir > 0 ? ZOOM_LEVELS.find((z) => z > now) ?? now : [...ZOOM_LEVELS].reverse().find((z) => z < now) ?? now
  settings.set('ui.zoom', String(next))
}
for (const v of VISUALIZATIONS) settings.define((v.settings ?? []).map((d) => ({ ...d, key: `${v.id}.${d.key}` })))

// The host's own UI follows whatever the active visualization asks for.
function setChromeTheme(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme
}
setChromeTheme(resolveTheme('system'))

let current: { viz: Visualization; instance: VizInstance; slot: HTMLElement } | undefined
const attention = new AttentionService(client, settings, (sessionId) => current?.instance.focusSession?.(sessionId))
const panel = new SettingsPanel({ settings, attention, client, visualizations: VISUALIZATIONS, active: () => current?.viz.id })
document.body.append(panel.el)

// ─── Host controls: just the settings button ────────────────────────────

const controls = document.createElement('div')
controls.className = 'oadt-controls'
const gear = document.createElement('button')
gear.className = 'oadt-settings-button'
gear.title = 'Settings (Ctrl+,)'
gear.setAttribute('aria-label', 'Settings')
gear.innerHTML = '<span aria-hidden="true">⚙</span><span>Settings</span>'
gear.addEventListener('click', () => panel.toggle())
controls.append(gear)

// ─── Mounting ───────────────────────────────────────────────────────────

function show(id: string): void {
  const viz = VISUALIZATIONS.find((v) => v.id === id) ?? VISUALIZATIONS[0]!
  if (current?.viz.id === viz.id) return
  current?.instance.destroy()
  current?.slot.remove()
  controls.remove()
  controls.classList.remove('floating')
  setChromeTheme(resolveTheme('system'))

  // Each visualization gets a fresh element, so nothing leaks between them.
  const slot = document.createElement('div')
  slot.className = `viz viz-${viz.id}`
  root.append(slot)
  current = {
    viz,
    slot,
    instance: viz.mount(slot, {
      client,
      controls,
      settings,
      attention,
      setChromeTheme,
      openSettings: (page) => panel.open(page),
    }),
  }
  if (!controls.isConnected) {
    controls.classList.add('floating')
    document.body.append(controls)
  }
  const url = new URL(location.href)
  url.searchParams.set('viz', viz.id)
  history.replaceState(null, '', url)
  document.documentElement.dataset.viz = viz.id
}

settings.on('viz', (id) => show(String(id)))

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && ['=', '+', '-', '_', '0'].includes(e.key)) {
    e.preventDefault()
    e.stopImmediatePropagation()
    stepZoom(e.key === '0' ? 0 : e.key === '-' || e.key === '_' ? -1 : 1)
    return
  }
  if ((e.ctrlKey || e.metaKey) && e.key === ',') {
    e.preventDefault()
    panel.toggle()
    return
  }
  if (panel.isOpen) {
    // The dialog is modal: keep shortcuts from reaching the visualization behind it.
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
  openSettings: (page?: string) => panel.open(page),
  visualizations: VISUALIZATIONS,
  get current() { return current?.viz.id },
}
