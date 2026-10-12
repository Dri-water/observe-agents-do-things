/**
 * Registered visualizations. Add yours here: implement `Visualization`
 * (see ./types.ts) — the host handles connection, switching and persistence.
 * The first entry is the default.
 */
import { mission } from './mission'
import { court } from './court'
import { office } from './office'
import type { Visualization } from './types'

export const VISUALIZATIONS: Visualization[] = [mission, office, court]
