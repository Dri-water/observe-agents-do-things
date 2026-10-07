/** The settings page: renders every section (host + visualizations) from its definitions. */
import { h } from '../shared/dom'
import type { AttentionService } from './attention'
import type { SettingDef, Settings, SettingsSection } from './settings'

export interface PanelOptions {
  settings: Settings
  sections: () => SettingsSection[]
  attention: AttentionService
}

export class SettingsPanel {
  readonly el: HTMLElement
  private active = 'appearance'
  private query = ''
  private offs: Array<() => void> = []

  constructor(private opts: PanelOptions) {
    this.el = h('div.oadt-settings', { hidden: true, role: 'dialog', 'aria-label': 'Settings' })
    this.el.addEventListener('click', (e) => { if (e.target === this.el) this.close() })
    this.offs.push(opts.settings.on('*', () => { if (!this.el.hidden) this.render() }))
  }

  get isOpen(): boolean {
    return !this.el.hidden
  }

  open(section?: string): void {
    if (section) this.active = section
    this.el.hidden = false
    this.render()
    ;(this.el.querySelector('input[type=search]') as HTMLInputElement | null)?.focus()
  }

  close(): void {
    this.el.hidden = true
  }

  toggle(): void {
    if (this.isOpen) this.close()
    else this.open()
  }

  destroy(): void {
    for (const off of this.offs) off()
    this.el.remove()
  }

  private render(): void {
    const sections = this.opts.sections()
    const q = this.query.trim().toLowerCase()
    const matches = (d: SettingDef) => !q || `${d.label} ${d.description ?? ''} ${d.key}`.toLowerCase().includes(q)
    const shown = q ? sections.map((s) => ({ ...s, settings: s.settings.filter(matches) })).filter((s) => s.settings.length) : sections.filter((s) => s.id === this.active)
    if (!q && !shown.length && sections[0]) { this.active = sections[0].id; return this.render() }

    const search = h('input', { type: 'search', placeholder: 'Search settings', value: this.query }) as HTMLInputElement
    search.addEventListener('input', () => {
      this.query = search.value
      this.render()
      const again = this.el.querySelector('input[type=search]') as HTMLInputElement
      again.focus()
      again.setSelectionRange(again.value.length, again.value.length)
    })

    const card = h('div.oadt-settings-card', null,
      h('header', null,
        h('b', null, 'Settings'),
        search,
        h('button.oadt-settings-close', { onclick: () => this.close(), 'aria-label': 'Close', title: 'Close (Esc)' }, '×'),
      ),
      h('div.oadt-settings-body', null,
        h('nav', null, ...sections.map((s) => h('button' + (s.id === this.active && !q ? '.on' : ''), { onclick: () => { this.active = s.id; this.query = ''; this.render() } }, s.title))),
        h('div.oadt-settings-list', null,
          ...shown.flatMap((s) => [
            h('h3', null, s.title),
            s.description ? h('p.oadt-settings-desc', null, s.description) : '',
            ...s.settings.map((d) => this.row(d)),
          ]),
          shown.length ? '' : h('p.oadt-settings-desc', null, 'No settings match.'),
        ),
      ),
    )
    this.el.replaceChildren(card)
  }

  private row(d: SettingDef): HTMLElement {
    const settings = this.opts.settings
    const value = settings.get(d.key)
    let control: HTMLElement
    if (d.type === 'toggle') {
      const input = h('input', { type: 'checkbox' }) as HTMLInputElement
      input.checked = value === true
      input.addEventListener('change', () => void this.change(d, input.checked, input))
      control = h('label.oadt-switch', null, input, h('span'))
    } else {
      const select = h('select', null, ...(d.options ?? []).map((o) => {
        const opt = h('option', { value: o.value }, o.label) as HTMLOptionElement
        opt.selected = o.value === value
        return opt
      })) as HTMLSelectElement
      select.addEventListener('change', () => void this.change(d, select.value))
      control = select
    }
    const extra = d.key === 'notify.desktop' ? permissionNote() : ''
    return h('div.oadt-setting', null,
      h('div', null, h('div.oadt-setting-label', null, d.label), d.description ? h('div.oadt-settings-desc', null, d.description) : '', extra),
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
