/**
 * Motion helpers for DOM visualizations: keyed lists that animate insertions,
 * removals and reorders (FLIP), and numbers that tick between values.
 * Everything collapses to instant updates under prefers-reduced-motion.
 */

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const EASE = 'cubic-bezier(.2,.8,.2,1)'

export interface KeyedListOptions<T> {
  key: (item: T) => string
  create: (item: T) => HTMLElement
  update?: (el: HTMLElement, item: T) => void
  /** Class added briefly to new elements (for a highlight flash). */
  flashClass?: string
  /** Animate the height of leaving elements (lists) or only fade them (table rows). */
  collapse?: boolean
}

export class KeyedList<T> {
  private els = new Map<string, HTMLElement>()
  private primed = false

  constructor(private container: HTMLElement, private opts: KeyedListOptions<T>) {}

  get size(): number {
    return this.els.size
  }

  element(key: string): HTMLElement | undefined {
    return this.els.get(key)
  }

  /** Make the container show `items` in order, animating what changed. */
  sync(items: T[]): void {
    const animate = this.primed && !reduced() && this.container.isConnected
    this.primed = true
    const before = new Map<HTMLElement, DOMRect>()
    if (animate) for (const el of this.els.values()) before.set(el, el.getBoundingClientRect())

    const next = new Map<string, HTMLElement>()
    const entering: HTMLElement[] = []
    for (const item of items) {
      const k = this.opts.key(item)
      let el = this.els.get(k)
      if (!el) {
        el = this.opts.create(item)
        entering.push(el)
      }
      this.opts.update?.(el, item)
      next.set(k, el)
    }

    // Leaving elements animate out, then go.
    for (const [k, el] of this.els) {
      if (next.has(k)) continue
      if (animate) this.leave(el)
      else el.remove()
    }
    this.els = next

    // Put elements in order with as few moves as possible.
    let cursor: ChildNode | null = this.container.firstChild
    for (const el of next.values()) {
      while (cursor && cursor !== el && (cursor as HTMLElement).dataset?.leaving === '1') cursor = cursor.nextSibling
      if (cursor === el) cursor = el.nextSibling
      else this.container.insertBefore(el, cursor)
    }

    if (!animate) return
    for (const el of entering) {
      el.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: EASE })
      if (this.opts.flashClass) {
        el.classList.add(this.opts.flashClass)
        setTimeout(() => el.classList.remove(this.opts.flashClass!), 1400)
      }
    }
    for (const [el, rect] of before) {
      if (!el.isConnected || el.dataset.leaving === '1') continue
      const now = el.getBoundingClientRect()
      const dx = rect.left - now.left, dy = rect.top - now.top
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 300, easing: EASE })
    }
  }

  private leave(el: HTMLElement): void {
    el.dataset.leaving = '1'
    el.style.pointerEvents = 'none'
    const frames: Keyframe[] = this.opts.collapse
      ? [{ opacity: 1, height: `${el.offsetHeight}px` }, { opacity: 0, height: '0px', paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px' }]
      : [{ opacity: 1 }, { opacity: 0 }]
    if (this.opts.collapse) el.style.overflow = 'hidden'
    el.animate(frames, { duration: 220, easing: EASE, fill: 'forwards' }).finished.then(() => el.remove(), () => el.remove())
  }
}

const shown = new WeakMap<HTMLElement, { value: number; raf: number }>()

/** Animate an element's number from what it shows now to `value`. */
export function tickTo(el: HTMLElement, value: number, format: (n: number) => string = (n) => String(Math.round(n))): void {
  const state = shown.get(el)
  const from = state?.value ?? value
  if (state) cancelAnimationFrame(state.raf)
  if (from === value || reduced()) {
    el.textContent = format(value)
    shown.set(el, { value, raf: 0 })
    return
  }
  const start = performance.now()
  const step = (t: number) => {
    const k = Math.min(1, (t - start) / 450)
    const eased = 1 - Math.pow(1 - k, 3)
    const v = from + (value - from) * eased
    el.textContent = format(v)
    shown.set(el, { value: k < 1 ? v : value, raf: k < 1 ? requestAnimationFrame(step) : 0 })
  }
  shown.set(el, { value: from, raf: requestAnimationFrame(step) })
}

/** Cross-fade an element's content swap. */
export function fadeSwap(el: HTMLElement): void {
  if (reduced()) return
  el.animate([{ opacity: 0.25, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: EASE })
}

export interface TypeOutOptions {
  /** Lines shown at once (context). Everything else in `lines` is replayed. */
  instant?: (el: HTMLElement) => boolean
  /** Lines that are struck in one by one before the typing starts (removals). */
  struck?: (el: HTMLElement) => boolean
  /** Upper bound for the whole replay, however long the text (ms). */
  budgetMs?: number
}

/**
 * Replay already-rendered lines as if someone were typing them: struck lines
 * appear one after another, then the rest are typed character by character
 * behind a caret. Returns a function that stops and shows everything.
 *
 * Styling hooks: `.ty-hide` (not reached yet), `.ty-cut` (just struck in),
 * `.typing` (the line with the caret).
 */
export function typeOut(lines: HTMLElement[], opts: TypeOutOptions = {}): () => void {
  if (reduced()) return () => {}
  const struck = lines.filter((el) => !opts.instant?.(el) && opts.struck?.(el))
  const typed = lines.filter((el) => !opts.instant?.(el) && !opts.struck?.(el))
  const texts = typed.map((el) => el.textContent ?? '')
  const chars = texts.reduce((n, t) => n + t.length, 0)
  for (const el of [...struck, ...typed]) el.classList.add('ty-hide')

  const cutMs = Math.min(70, 400 / Math.max(1, struck.length))
  const typeMs = Math.min(opts.budgetMs ?? 1800, Math.max(250, chars * 16))
  const start = performance.now()
  let raf = 0
  let current: HTMLElement | undefined

  const finish = () => {
    cancelAnimationFrame(raf)
    struck.forEach((el) => el.classList.remove('ty-hide'))
    typed.forEach((el, i) => { el.classList.remove('ty-hide', 'typing'); el.textContent = texts[i]! })
  }
  const step = (t: number) => {
    const elapsed = t - start
    struck.forEach((el, i) => {
      if (elapsed >= i * cutMs && el.classList.contains('ty-hide')) el.classList.replace('ty-hide', 'ty-cut')
    })
    const k = Math.max(0, elapsed - struck.length * cutMs) / typeMs
    if (k >= 1) { finish(); return }
    // Ease out so the typing starts brisk and settles at the end of the change.
    let left = Math.floor(chars * (1 - Math.pow(1 - k, 1.6)))
    typed.forEach((el, i) => {
      const full = texts[i]!
      if (left <= 0 && el.classList.contains('ty-hide')) return
      const n = Math.min(full.length, Math.max(0, left))
      left -= full.length
      el.classList.remove('ty-hide')
      const text = full.slice(0, n) || (n < full.length ? '' : full)
      if (el.textContent !== text) el.textContent = text
      if (n < full.length && el !== current) { current?.classList.remove('typing'); current = el; el.classList.add('typing') }
    })
    raf = requestAnimationFrame(step)
  }
  raf = requestAnimationFrame(step)
  return finish
}
