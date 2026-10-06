/** Colour helpers shared by the visualizations. Accept #hex or rgb()/rgba() strings. */

export function hexToRgb(hex: string): [number, number, number] {
  if (hex.startsWith('rgb')) {
    const m = hex.match(/[\d.]+/g) ?? []
    return [Number(m[0] ?? 0), Number(m[1] ?? 0), Number(m[2] ?? 0)]
  }
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function rgb(r: number, g: number, b: number, a = 1): string {
  return a >= 1 ? `rgb(${r | 0},${g | 0},${b | 0})` : `rgba(${r | 0},${g | 0},${b | 0},${a})`
}

/** Lighten (k > 0) or darken (k < 0) a hex colour; optionally tint toward another colour. */
export function shade(hex: string, k: number, a = 1): string {
  const [r, g, b] = hexToRgb(hex)
  const t = k >= 0 ? 255 : 0
  const f = Math.abs(k)
  return rgb(r + (t - r) * f, g + (t - g) * f, b + (t - b) * f, a)
}

export function mix(hexA: string, hexB: string, t: number, a = 1): string {
  const [r1, g1, b1] = hexToRgb(hexA)
  const [r2, g2, b2] = hexToRgb(hexB)
  return rgb(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t, a)
}

export function alpha(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex)
  return rgb(r, g, b, a)
}
