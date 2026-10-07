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
