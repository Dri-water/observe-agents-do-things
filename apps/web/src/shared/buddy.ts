/**
 * Buddies: a little blob per agent whose face, motion and prop follow what the
 * agent is doing right now.
 *
 * The faces come from blobatar (https://github.com/Alain00/blobatar, MIT): the
 * same seed always draws the same blob, and an expression change morphs
 * between poses with CSS transitions. This file is a framework-free adapter in
 * the style of `@blobatar/react`: it builds the `<svg>` once and afterwards only
 * swaps the root class and the pose's custom properties, so the idle loops keep
 * their phase and the morph actually runs. On top of that it adds the part
 * blobatar leaves to the app: an activity-specific body motion and a prop.
 */
import { _parts } from 'blobatar/internal'
import { blobatarUri } from 'blobatar/uri'
import type { Expression } from 'blobatar'
import { happy, idle, love, sad, scared, shy, sick, sleepy, smug, surprised, thinking, unsure, wink } from 'blobatar/expression'
import type { Activity } from '@oadt/protocol'
import 'blobatar/motion.css'
import './buddy.css'

const SVG = 'http://www.w3.org/2000/svg'
const HOLD_MS = 1200
const URGENT = new Set<Activity>(['waiting', 'asking', 'failed'])

interface Look { expr: Expression; label: string }

/** Face and caption for each activity. Body motion and props live in buddy.css, keyed by `data-act`. */
export const LOOKS: Record<Activity, Look> = {
  thinking:   { expr: thinking,  label: 'thinking' },
  reading:    { expr: idle,      label: 'reading' },
  searching:  { expr: unsure,    label: 'searching' },
  editing:    { expr: happy,     label: 'editing' },
  writing:    { expr: love,      label: 'writing' },
  running:    { expr: smug,      label: 'running a command' },
  browsing:   { expr: surprised, label: 'browsing' },
  delegating: { expr: happy,     label: 'delegating' },
  planning:   { expr: thinking,  label: 'planning' },
  tooling:    { expr: wink,      label: 'using a tool' },
  asking:     { expr: shy,       label: 'asking you' },
  waiting:    { expr: scared,    label: 'needs approval' },
  failed:     { expr: sick,      label: 'hit an error' },
  finished:   { expr: happy,     label: 'done!' },
  aborted:    { expr: sad,       label: 'interrupted' },
  idle:       { expr: idle,      label: 'idle' },
  sleeping:   { expr: sleepy,    label: 'asleep' },
}

/** Small line-art props, drawn in a 24×24 box with `currentColor`. */
const PROPS: Partial<Record<Activity, string>> = {
  thinking: '<circle cx="4" cy="19" r="2.2"/><circle cx="10" cy="13" r="2.9"/><circle cx="18" cy="6" r="4"/>',
  planning: '<rect x="5" y="3.5" width="14" height="17" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 9l1.6 1.6L12.5 7.6M8 15l1.6 1.6 2.9-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M14.5 9.5h2M14.5 15.5h2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  reading: '<path d="M3 6.5C6 5 9 5 12 7c3-2 6-2 9-.5V19c-3-1.5-6-1.5-9 .5-3-2-6-2-9-.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path class="bb-scan" d="M5.5 10h4M5.5 13h4M14.5 10h4M14.5 13h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  searching: '<circle cx="10" cy="10" r="5.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M14.2 14.2L20 20" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>',
  editing: '<path d="M4 20l1.2-4.6L15.8 4.8a2 2 0 012.8 0l.6.6a2 2 0 010 2.8L8.6 18.8z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M13.6 7l3.4 3.4" stroke="currentColor" stroke-width="1.8"/>',
  writing: '<path d="M6 3h8l4 4v14H6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M14 3v4h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path class="bb-grow" d="M12 10.5v6M9 13.5h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  running: '<rect x="2.5" y="4" width="19" height="16" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M6.5 9.5l3 2.5-3 2.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path class="bb-caret" d="M11.5 15h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  browsing: '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4 9.5h16M4 14.5h16" stroke="currentColor" stroke-width="1.4"/><ellipse class="bb-globe" cx="12" cy="12" rx="3.8" ry="8.5" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  tooling: '<g class="bb-spin"><path d="M12 2.8l1.6 2.6 3-.5.6 3 2.6 1.6-1.2 2.5 1.2 2.5-2.6 1.6-.6 3-3-.5L12 21.2l-1.6-2.6-3 .5-.6-3-2.6-1.6L5.4 12 4.2 9.5l2.6-1.6.6-3 3 .5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.6"/></g>',
  asking: '<path d="M8.5 8.5a3.5 3.5 0 117 0c0 2.4-3.5 2.6-3.5 5.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="19" r="1.6"/>',
  waiting: '<path d="M12 4v10" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><circle cx="12" cy="19.5" r="1.9"/>',
  failed: '<path d="M7 7l10 10M17 7L7 17" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/>',
  finished: '<path class="bb-tw" d="M12 2l1.6 5.4L19 9l-5.4 1.6L12 16l-1.6-5.4L5 9l5.4-1.6z"/><path class="bb-tw bb-tw2" d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8z"/><path class="bb-tw bb-tw3" d="M5 15l.7 1.8 1.8.7-1.8.7L5 20l-.7-1.8-1.8-.7 1.8-.7z"/>',
  aborted: '<path d="M6 12a4 4 0 014-4 5 5 0 019.5 1.5A3 3 0 0119 15.5H7A3.5 3.5 0 016 12z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path class="bb-rain" d="M9 18l-1 2.5M13 18l-1 2.5M17 18l-1 2.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  sleeping: '<text class="bb-z" x="2" y="22">z</text><text class="bb-z bb-z2" x="10" y="14">z</text><text class="bb-z bb-z3" x="17" y="7">z</text>',
  delegating: '<circle class="bb-orb" cx="12" cy="4" r="3"/><circle class="bb-orb bb-orb2" cx="12" cy="4" r="2.4"/><circle class="bb-orb bb-orb3" cx="12" cy="4" r="2"/>',
}

/** The seed for an agent's blob: the session id for the main agent, so a session keeps its face. */
export function buddySeed(sessionId: string, agentId: string, rootAgentId?: string): string {
  return agentId === rootAgentId || agentId === sessionId ? sessionId : `${sessionId}/${agentId}`
}

const uris = new Map<string, string>()

/** A still face as a plain `<img>`, for dense lists where a live buddy would be noise. */
export function face(seed: string, size: number): HTMLImageElement {
  const img = document.createElement('img')
  img.className = 'bb-face'
  let src = uris.get(seed)
  if (!src) {
    if (uris.size > 500) uris.clear()
    src = blobatarUri(seed)
    uris.set(seed, src)
  }
  img.src = src
  img.width = img.height = size
  img.alt = ''
  return img
}

export interface BuddyOptions {
  /** Rendered size in CSS pixels. */
  size: number
  /** Show the floating prop. Off for tiny buddies, where it would be noise. */
  prop?: boolean
  /** Accessible name; without it the buddy is decorative. */
  title?: string
}

export interface Buddy {
  el: HTMLElement
  /** Show `activity`. Changing it morphs the face and restarts the prop's entrance. */
  set(activity: Activity): void
  readonly activity: Activity | undefined
}

/** A buddy for `seed` (the same seed always draws the same blob). */
export function createBuddy(seed: string, opts: BuddyOptions): Buddy {
  const el = document.createElement('span')
  el.className = 'bb'
  el.style.setProperty('--bb-size', `${opts.size}px`)
  const body = document.createElement('span')
  body.className = 'bb-body'
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', '0 0 100 100')
  if (opts.title) {
    svg.setAttribute('role', 'img')
    const t = document.createElementNS(SVG, 'title')
    t.textContent = opts.title
    svg.append(t)
  } else svg.setAttribute('aria-hidden', 'true')
  const root = document.createElementNS(SVG, 'g')
  svg.append(root)
  body.append(svg)
  const shadow = document.createElement('span')
  shadow.className = 'bb-shadow'
  el.append(shadow, body)
  let prop: HTMLElement | undefined
  if (opts.prop) {
    prop = document.createElement('span')
    prop.className = 'bb-prop'
    prop.setAttribute('aria-hidden', 'true')
    el.append(prop)
  }

  let current: Activity | undefined
  let wanted: Activity | undefined
  let shownAt = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let vars: string[] = []

  function show(activity: Activity): void {
    const first = current === undefined
    current = activity
    shownAt = performance.now()
    const parts = _parts(seed, { animate: 'always', expression: LOOKS[activity].expr })
    // The figure is the same for every pose; only the root class and the custom properties change.
    if (first) root.innerHTML = parts.inner
    root.setAttribute('class', parts.cls ?? '')
    const next = parts.vars as Record<string, string>
    for (const k of vars) if (!(k in next)) svg.style.removeProperty(k)
    for (const [k, v] of Object.entries(next)) svg.style.setProperty(k, v)
    vars = Object.keys(next)
    el.dataset.act = activity
    if (prop) {
      const art = PROPS[activity]
      prop.innerHTML = art ? `<svg viewBox="0 0 24 24" fill="currentColor">${art}</svg>` : ''
      prop.classList.remove('bb-in')
      // Reading layout restarts the entrance animation.
      if (art && !first) { prop.getBoundingClientRect(); prop.classList.add('bb-in') }
    }
  }

  return {
    el,
    get activity() { return current },
    set(activity) {
      wanted = activity
      if (activity === current) return
      // Hold each pose long enough to read, so a burst of quick tools does not
      // flicker; anything that needs the user shows at once.
      const wait = current === undefined || URGENT.has(activity) ? 0 : HOLD_MS - (performance.now() - shownAt)
      if (wait <= 0) { clearTimeout(timer); timer = undefined; show(activity); return }
      timer ??= setTimeout(() => { timer = undefined; if (wanted && wanted !== current) show(wanted) }, wait)
    },
  }
}
