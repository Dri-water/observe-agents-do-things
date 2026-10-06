/**
 * The host: connects to the observer once, then mounts one visualization at a
 * time into #viz-root. Visualizations own everything they draw — see viz/types.ts.
 */
import './host.css'
import { connect } from '@oadt/client'
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

function storedViz(): string | undefined {
  try { return localStorage.getItem('oadt-viz') ?? undefined } catch { return undefined }
}

let current: { viz: Visualization; instance: VizInstance; slot: HTMLElement } | undefined

// ─── Switcher ───────────────────────────────────────────────────────────

const switcher = document.createElement('div')
switcher.className = 'viz-switcher'
const button = document.createElement('button')
button.className = 'viz-switcher-button'
button.title = 'Switch visualization (V)'
const menu = document.createElement('div')
menu.className = 'viz-switcher-menu'
menu.hidden = true
switcher.append(button, menu)

function renderSwitcher(): void {
  button.innerHTML = `<span class="viz-switcher-icon">◐</span><span>${current?.viz.name ?? 'View'}</span><span class="viz-switcher-caret">▾</span>`
  menu.replaceChildren(...VISUALIZATIONS.map((v) => {
    const item = document.createElement('button')
    item.className = 'viz-switcher-item' + (v.id === current?.viz.id ? ' on' : '')
    item.innerHTML = `<b></b><span></span>`
    item.querySelector('b')!.textContent = v.name
    item.querySelector('span')!.textContent = v.description
    item.addEventListener('click', () => { menu.hidden = true; show(v.id) })
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
  current = { viz, instance: viz.mount(slot, { client, switcher }), slot }
  if (!switcher.isConnected) {
    switcher.classList.add('floating')
    document.body.append(switcher)
  }
  renderSwitcher()
  try { localStorage.setItem('oadt-viz', viz.id) } catch { /* ignore */ }
  const url = new URL(location.href)
  url.searchParams.set('viz', viz.id)
  history.replaceState(null, '', url)
  document.documentElement.dataset.viz = viz.id
}

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
  if (e.metaKey || e.ctrlKey || e.altKey) return
  if (e.key === 'v' || e.key === 'V') {
    const i = VISUALIZATIONS.findIndex((v) => v.id === current?.viz.id)
    show(VISUALIZATIONS[(i + 1) % VISUALIZATIONS.length]!.id)
  }
})

show(params.get('viz') ?? storedViz() ?? VISUALIZATIONS[0]!.id)

// Debug handle for DevTools: the live client and the mounted visualization.
;(window as unknown as { __oadt: unknown }).__oadt = {
  client,
  show,
  visualizations: VISUALIZATIONS,
  get current() { return current?.viz.id },
}
