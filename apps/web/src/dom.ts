type Attrs = Record<string, string | number | boolean | undefined | null | EventListener>
type Child = Node | string | number | null | undefined | false

/** Tiny hyperscript: h('div.card', { onclick }, 'text', child) */
export function h(tag: string, attrs?: Attrs | null, ...children: Child[]): HTMLElement {
  const [name, ...rest] = tag.split(/(?=[.#])/)
  const el = document.createElement(name!)
  for (const part of rest) {
    if (part.startsWith('.')) el.classList.add(part.slice(1))
    else if (part.startsWith('#')) el.id = part.slice(1)
  }
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener)
      else if (k === 'style') el.setAttribute('style', String(v))
      else if (v === true) el.setAttribute(k, '')
      else el.setAttribute(k, String(v))
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue
    el.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return el
}

export function $(sel: string, root: ParentNode = document): HTMLElement {
  const el = root.querySelector(sel)
  if (!el) throw new Error(`missing ${sel}`)
  return el as HTMLElement
}

/** Replace an element's children only when the content key changed (cheap diffing for panels). */
export function render(el: HTMLElement, key: string, build: () => Child[]): void {
  if (el.dataset.key === key) return
  el.dataset.key = key
  el.replaceChildren(...build().filter((c): c is Node | string => c !== null && c !== undefined && c !== false).map((c) => (c instanceof Node ? c : document.createTextNode(String(c)))))
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
