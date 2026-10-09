/**
 * The settings dialog.
 *
 *   Visualizations      list of visualizations: use one, or configure it
 *     › <visualization> that visualization's own settings
 *   Display             zoom
 *   Notifications       alerts shared by every visualization
 *   Keyboard shortcuts  reference
 *   About               version and connection
 */
import type { ObserverClient } from '@oadt/client'
import { h } from '../shared/dom'
import type { Visualization } from '../viz/types'
import type { AttentionService } from './attention'
import { DISPLAY_SETTINGS, NOTIFICATION_SETTINGS, type SettingDef, type Settings } from './settings'

export interface PanelOptions {
  settings: Settings
  attention: AttentionService
  client: ObserverClient
  visualizations: Visualization[]
  active: () => string | undefined
}

type Page = 'visualizations' | 'display' | 'notifications' | 'shortcuts' | 'about' | `viz:${string}`

const PAGES: Array<{ id: Page; title: string }> = [
  { id: 'visualizations', title: 'Visualizations' },
  { id: 'display', title: 'Display' },
  { id: 'notifications', title: 'Notifications' },
  { id: 'shortcuts', title: 'Keyboard shortcuts' },
  { id: 'about', title: 'About' },
]

const SHORTCUTS: Array<[string, string]> = [
  ['Ctrl + ,', 'Open or close settings'],
  ['V', 'Switch to the next visualization'],
  ['Ctrl + +', 'Zoom in'],
  ['Ctrl + −', 'Zoom out'],
  ['Ctrl + 0', 'Reset zoom'],
  ['Esc', 'Close dialogs and panels'],
]

export class SettingsPanel {
  readonly el: HTMLElement
  private page: Page = 'visualizations'
  private query = ''
  private returnFocus: Element | null = null

  constructor(private opts: PanelOptions) {
    this.el = h('div.oadt-settings', { hidden: true })
    this.el.addEventListener('mousedown', (e) => { if (e.target === this.el) this.close() })
    opts.settings.on('*', () => { if (this.isOpen) this.render() })
  }

  get isOpen(): boolean {
    return !this.el.hidden
  }

  /** Open at a page: 'visualizations', 'notifications', a visualization id, … */
  open(page?: string): void {
    if (page) this.page = (PAGES.some((p) => p.id === page) ? page : `viz:${page}`) as Page
    this.returnFocus = document.activeElement
    this.query = ''
    this.el.hidden = false
    this.render()
    ;(this.el.querySelector('input[type=search]') as HTMLInputElement | null)?.focus()
  }

  close(): void {
    if (!this.isOpen) return
    this.el.hidden = true
    ;(this.returnFocus as HTMLElement | null)?.focus?.()
  }

  toggle(): void {
    if (this.isOpen) this.close()
    else this.open()
  }

  private go(page: Page): void {
    this.page = page
    this.query = ''
    this.render()
    ;(this.el.querySelector('.oadt-settings-content') as HTMLElement | null)?.scrollTo(0, 0)
  }

  // ─── Rendering ───────────────────────────────────────────────────────

  private render(): void {
    const search = h('input', { type: 'search', placeholder: 'Search settings', value: this.query, 'aria-label': 'Search settings' }) as HTMLInputElement
    search.addEventListener('input', () => {
      this.query = search.value
      this.render()
      const again = this.el.querySelector('input[type=search]') as HTMLInputElement
      again.focus()
      again.setSelectionRange(again.value.length, again.value.length)
    })
    const navActive = this.page.startsWith('viz:') ? 'visualizations' : this.page
    const card = h('div.oadt-settings-card', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Settings' },
      h('header', null,
        h('b', null, 'Settings'),
        search,
        h('button.oadt-icon-btn', { onclick: () => this.close(), 'aria-label': 'Close settings', title: 'Close (Esc)' }, '×'),
      ),
      h('div.oadt-settings-body', null,
        h('nav', { 'aria-label': 'Settings sections' }, ...PAGES.map((p) =>
          h('button' + (p.id === navActive && !this.query ? '.on' : ''), { onclick: () => this.go(p.id), 'aria-current': p.id === navActive && !this.query ? 'page' : undefined }, p.title))),
        h('div.oadt-settings-content', null, ...(this.query ? this.searchResults() : this.pageContent())),
      ),
    )
    this.el.replaceChildren(card)
  }

  private pageContent(): Array<Node | string> {
    if (this.page === 'visualizations') return this.visualizationsPage()
    if (this.page === 'display') return this.displayPage()
    if (this.page === 'notifications') return this.notificationsPage()
    if (this.page === 'shortcuts') return this.shortcutsPage()
    if (this.page === 'about') return this.aboutPage()
    const viz = this.opts.visualizations.find((v) => `viz:${v.id}` === this.page)
    return viz ? this.vizPage(viz) : this.visualizationsPage()
  }

  private visualizationsPage(): Array<Node | string> {
    const active = this.opts.active()
    return [
      h('h2', null, 'Visualizations'),
      h('p.oadt-settings-desc', null, 'Each visualization is a different way of looking at the same live data. Pick the one to show, or configure its options.'),
      h('div.oadt-viz-list', { role: 'list' }, ...this.opts.visualizations.map((v) => {
        const isActive = v.id === active
        return h('div.oadt-viz' + (isActive ? '.active' : ''), { role: 'listitem' },
          h('div.oadt-viz-icon', { 'aria-hidden': 'true' }, v.icon ?? '◐'),
          h('div.oadt-viz-text', null,
            h('div.oadt-viz-name', null, v.name, isActive ? h('span.oadt-tag', null, 'Active') : ''),
            h('div.oadt-settings-desc', null, v.description),
          ),
          h('div.oadt-viz-actions', null,
            isActive ? '' : h('button.oadt-btn.primary', { onclick: () => this.opts.settings.set('viz', v.id) }, 'Use'),
            h('button.oadt-btn', { onclick: () => this.go(`viz:${v.id}`), 'aria-label': `Configure ${v.name}` }, 'Configure ›'),
          ),
        )
      })),
    ]
  }

  private vizPage(v: Visualization): Array<Node | string> {
    const isActive = v.id === this.opts.active()
    const defs = (v.settings ?? []).map((d) => ({ ...d, key: `${v.id}.${d.key}` }))
    return [
      h('nav.oadt-crumbs', { 'aria-label': 'Breadcrumb' },
        h('button', { onclick: () => this.go('visualizations') }, '‹ Visualizations'),
        h('span', { 'aria-hidden': 'true' }, '/'),
        h('span', { 'aria-current': 'page' }, v.name),
      ),
      h('div.oadt-viz-head', null,
        h('div.oadt-viz-icon.lg', { 'aria-hidden': 'true' }, v.icon ?? '◐'),
        h('div', null, h('h2', null, v.name), h('p.oadt-settings-desc', null, v.description)),
        isActive ? h('span.oadt-tag', null, 'Active') : h('button.oadt-btn.primary', { onclick: () => this.opts.settings.set('viz', v.id) }, 'Use this visualization'),
      ),
      ...(defs.length ? defs.map((d) => this.row(d)) : [h('p.oadt-settings-desc', null, 'This visualization has no settings.')]),
    ]
  }

  private displayPage(): Array<Node | string> {
    return [h('h2', null, 'Display'), ...DISPLAY_SETTINGS.map((d) => this.row(d))]
  }

  private notificationsPage(): Array<Node | string> {
    return [
      h('h2', null, 'Notifications'),
      h('p.oadt-settings-desc', null, 'Alerts come from the shared attention rules, so they work in every visualization.'),
      ...NOTIFICATION_SETTINGS.slice(0, 3).map((d) => this.row(d)),
      h('h3', null, 'Alert me when'),
      ...NOTIFICATION_SETTINGS.slice(3).map((d) => this.row(d)),
    ]
  }

  private shortcutsPage(): Array<Node | string> {
    return [
      h('h2', null, 'Keyboard shortcuts'),
      h('p.oadt-settings-desc', null, 'App-wide shortcuts. Visualizations add their own; see each one\'s help.'),
      h('dl.oadt-keys', null, ...SHORTCUTS.flatMap(([k, d]) => [h('dt', null, ...k.split(' + ').flatMap((p, i) => (i ? [' + ', h('kbd', null, p)] : [h('kbd', null, p)]))), h('dd', null, d)])),
    ]
  }

  private aboutPage(): Array<Node | string> {
    const hello = this.opts.client.hello
    return [
      h('h2', null, 'About'),
      h('p.oadt-settings-desc', null, 'observe-agents-do-things watches your coding agents through the transcripts they already write. It is read-only.'),
      h('dl.oadt-about', null,
        h('dt', null, 'Version'), h('dd', null, hello?.version ?? '—'),
        h('dt', null, 'Connection'), h('dd', null, this.opts.client.status),
        h('dt', null, 'Sources'), h('dd', null, (hello?.sources ?? []).map((s) => String(s.name)).join(', ') || '—'),
        h('dt', null, 'Privacy mode'), h('dd', null, hello?.redact ?? '—'),
      ),
      h('p.oadt-settings-desc', null, h('a', { href: 'https://github.com/Dri-water/observe-agents-do-things', target: '_blank', rel: 'noreferrer' }, 'Project on GitHub')),
    ]
  }

  private searchResults(): Array<Node | string> {
    const q = this.query.trim().toLowerCase()
    const groups: Array<{ crumb: string; page: Page; defs: SettingDef[] }> = [
      { crumb: 'Display', page: 'display', defs: DISPLAY_SETTINGS },
      { crumb: 'Notifications', page: 'notifications', defs: NOTIFICATION_SETTINGS },
      ...this.opts.visualizations.map((v) => ({
        crumb: `Visualizations › ${v.name}`,
        page: `viz:${v.id}` as Page,
        defs: (v.settings ?? []).map((d) => ({ ...d, key: `${v.id}.${d.key}` })),
      })),
    ]
    const out: Array<Node | string> = [h('h2', null, `Results for “${this.query.trim()}”`)]
    for (const g of groups) {
      const defs = g.defs.filter((d) => `${d.label} ${d.description ?? ''} ${g.crumb}`.toLowerCase().includes(q))
      if (!defs.length) continue
      out.push(h('button.oadt-crumb-link', { onclick: () => this.go(g.page) }, g.crumb, ' ›'), ...defs.map((d) => this.row(d)))
    }
    const vizMatches = this.opts.visualizations.filter((v) => `${v.name} ${v.description}`.toLowerCase().includes(q))
    if (vizMatches.length) {
      out.push(h('button.oadt-crumb-link', { onclick: () => this.go('visualizations') }, 'Visualizations ›'))
      for (const v of vizMatches) out.push(h('div.oadt-setting', null, h('div', null, h('div.oadt-setting-label', null, v.name), h('div.oadt-settings-desc', null, v.description)), h('button.oadt-btn', { onclick: () => this.go(`viz:${v.id}`) }, 'Configure ›')))
    }
    if (out.length === 1) out.push(h('p.oadt-settings-desc', null, 'No settings match.'))
    return out
  }

  private row(d: SettingDef): HTMLElement {
    const settings = this.opts.settings
    const value = settings.get(d.key)
    const id = `set-${d.key.replace(/[^a-z0-9]/gi, '-')}`
    let control: HTMLElement
    if (d.type === 'toggle') {
      const input = h('input', { type: 'checkbox', id, role: 'switch' }) as HTMLInputElement
      input.checked = value === true
      input.addEventListener('change', () => void this.change(d, input.checked, input))
      control = h('span.oadt-switch', null, input, h('span', { 'aria-hidden': 'true' }))
    } else {
      const select = h('select', { id }, ...(d.options ?? []).map((o) => {
        const opt = h('option', { value: o.value }, o.label) as HTMLOptionElement
        opt.selected = o.value === value
        return opt
      })) as HTMLSelectElement
      select.addEventListener('change', () => void this.change(d, select.value))
      control = select
    }
    return h('div.oadt-setting', null,
      h('div', null,
        h('label.oadt-setting-label', { for: id }, d.label),
        d.description ? h('div.oadt-settings-desc', null, d.description) : '',
        d.key === 'notify.desktop' ? permissionNote() : '',
      ),
      control,
    )
  }

  private async change(d: SettingDef, value: string | boolean, input?: HTMLInputElement): Promise<void> {
    if (d.key === 'notify.desktop' && value === true) {
      const permission = await this.opts.attention.requestPermission()
      if (permission !== 'granted') {
        if (input) input.checked = false
        this.render()
        return
      }
    }
    this.opts.settings.set(d.key, value)
  }
}

function permissionNote(): HTMLElement | string {
  if (!('Notification' in window)) return h('div.oadt-settings-warn', null, 'This browser does not support notifications.')
  if (Notification.permission === 'denied') return h('div.oadt-settings-warn', null, 'Notifications are blocked for this site in your browser settings.')
  return ''
}
