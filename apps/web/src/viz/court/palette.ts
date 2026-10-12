/** Materials for each court palette, ranks, titles and hall names. */

export type PaletteName = 'tang' | 'song' | 'ink'
export type Lang = 'accent' | 'zh' | 'en'

export interface Palette {
  /** Plaster walls (back wall, then the darker left wall). */
  wall: string
  wallSide: string
  /** Low brick dado under the plaster. */
  dado: string
  /** Columns, window frames, lattice. */
  timber: string
  timberDark: string
  /** Painted beam (彩画): base and the two motif colours. */
  beam: string
  paintA: string
  paintB: string
  gold: string
  /** Floor bricks (金砖). */
  floor: string
  carpet: string
  carpetBorder: string
  /** Dais, terrace and balustrades (white marble). */
  marble: string
  /** Courtyard paving outside the hall. */
  paving: string
  /** Lacquered furniture. */
  lacquer: string
  mat: string
  /** Wall-top tiles and their glazed trim. */
  tile: string
  trim: string
  /** Palace enclosure walls. */
  palaceWall: string
  /** Silk and paper (screen, scrolls, memorials). */
  paper: string
  ink: string
  seal: string
  /** Backdrop gradient stops by day and by night. */
  day: [string, string, string]
  night: [string, string, string]
}

export const PALETTES: Record<PaletteName, Palette> = {
  // Tang: vermilion timber, gold, blue-green painted beams, white marble.
  tang: {
    wall: '#f2e6cc', wallSide: '#e3d4b5', dado: '#9a8f82', timber: '#b03a2c', timberDark: '#7d281f',
    beam: '#2f6466', paintA: '#3f8a80', paintB: '#2e5394', gold: '#dcae4c',
    floor: '#8e877a', carpet: '#9e2b27', carpetBorder: '#dcae4c', marble: '#ece6d8', paving: '#c7bfae',
    lacquer: '#5e1f17', mat: '#cdb67c', tile: '#4d585c', trim: '#3f8a63', palaceWall: '#a8392b',
    paper: '#f4ead1', ink: '#2a2420', seal: '#b3261e',
    day: ['#e7d9bf', '#efe2c9', '#f6ecd8'], night: ['#121628', '#191b33', '#211d36'],
  },
  // Song: natural dark timber, celadon, muted gold, soft greys.
  song: {
    wall: '#ede7d7', wallSide: '#ddd5c1', dado: '#8f8d86', timber: '#7a573b', timberDark: '#563c28',
    beam: '#55776d', paintA: '#8fb8a6', paintB: '#5a7d92', gold: '#bf9f5c',
    floor: '#9f9b90', carpet: '#4d6c64', carpetBorder: '#c9b98a', marble: '#ebe7dc', paving: '#c4c1b6',
    lacquer: '#3a2a20', mat: '#cdbd8e', tile: '#596266', trim: '#5f9184', palaceWall: '#8f4a3c',
    paper: '#f2ecdc', ink: '#262422', seal: '#a8322a',
    day: ['#dde5df', '#e7ece4', '#f1f1e7'], night: ['#111820', '#161e28', '#1c222d'],
  },
  // Ink wash (水墨): monochrome with only the seals in red.
  ink: {
    wall: '#f4f1e9', wallSide: '#e4e0d6', dado: '#8b8984', timber: '#33312e', timberDark: '#1f1e1c',
    beam: '#4b4946', paintA: '#7b7771', paintB: '#5d5a56', gold: '#a39c8c',
    floor: '#c6c1b5', carpet: '#3b3936', carpetBorder: '#9c2b23', marble: '#ede9e0', paving: '#d3cec3',
    lacquer: '#2b2927', mat: '#d6cfbd', tile: '#46474a', trim: '#6d6d6d', palaceWall: '#6b6763',
    paper: '#f6f2e8', ink: '#1e1d1c', seal: '#a62a22',
    day: ['#e9e8e2', '#f0eee8', '#f6f4ee'], night: ['#15161a', '#1b1c21', '#212227'],
  },
}

/** Robe colours by depth, after the Tang and Song rank colours: purple, crimson, green, blue. */
export const RANKS = [
  { color: '#6b3d9c', zh: '紫', label: 'purple' },
  { color: '#b3372b', zh: '绯', label: 'crimson' },
  { color: '#3a7d58', zh: '绿', label: 'green' },
  { color: '#3d6aa1', zh: '青', label: 'blue' },
]
export const rankOf = (depth: number) => RANKS[Math.min(RANKS.length - 1, Math.max(0, depth))]!

/** Official titles by subagent type. */
export function titleOf(isRoot: boolean, role: string | undefined): { zh: string; en: string } {
  if (isRoot) return { zh: '宰相', en: 'Chancellor' }
  const r = (role ?? '').toLowerCase()
  if (/explor|search|research/.test(r)) return { zh: '史官', en: 'Historian' }
  if (/plan|architect/.test(r)) return { zh: '枢密使', en: 'Privy Councillor' }
  if (/review|audit|security|verify/.test(r)) return { zh: '御史', en: 'Censor' }
  if (/test|qa|debug/.test(r)) return { zh: '大理寺丞', en: 'Magistrate' }
  if (/doc|writ/.test(r)) return { zh: '翰林学士', en: 'Academician' }
  if (/design|ui|front/.test(r)) return { zh: '将作监', en: 'Master of Works' }
  if (/general|worker|agent/.test(r) || !r) return { zh: '侍郎', en: 'Vice Minister' }
  return { zh: '郎官', en: 'Court Official' }
}

/** Halls of the Song palace at Kaifeng (and a few more). */
export const HALL_NAMES = [
  { zh: '紫宸殿', en: 'Hall of Purple Majesty' },
  { zh: '垂拱殿', en: 'Hall of Folded Hands' },
  { zh: '文德殿', en: 'Hall of Literary Virtue' },
  { zh: '集英殿', en: 'Hall of Gathered Talent' },
  { zh: '延和殿', en: 'Hall of Extended Harmony' },
  { zh: '大庆殿', en: 'Hall of Great Celebration' },
  { zh: '崇政殿', en: 'Hall of Revered Governance' },
  { zh: '宣和殿', en: 'Hall of Proclaimed Harmony' },
  { zh: '睿思殿', en: 'Hall of Wise Reflection' },
  { zh: '景福殿', en: 'Hall of Bright Fortune' },
]
export const hallName = (i: number) => HALL_NAMES[i % HALL_NAMES.length]!

/** The traditional double-hours (时辰). */
export function shichen(d = new Date()): string {
  const names = '子丑寅卯辰巳午未申酉戌亥'
  return names[Math.floor(((d.getHours() + 1) % 24) / 2)]! + '时'
}

export const SERIF = '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "STSong", "SimSun", "Noto Serif CJK SC", serif'
export const KAI = '"KaiTi", "STKaiti", "Kaiti SC", "BiauKai", "Noto Serif SC", "SimSun", serif'
export const FONT = 'ui-rounded, "SF Pro Rounded", "Nunito", "Segoe UI", system-ui, sans-serif'
export const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
