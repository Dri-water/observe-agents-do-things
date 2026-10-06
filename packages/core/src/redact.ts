/**
 * Privacy policy applied before anything is stored or served.
 *
 * - `none`     everything the adapters extracted (already truncated)
 * - `content`  drop prompts, replies, thinking, tool inputs and outputs; keep structure,
 *              tool titles and file paths — enough to watch the flow without the words
 * - `strict`   additionally reduce titles to tool names and drop paths, cwd and git info
 */
import type { EventDraft } from '@oadt/protocol'
import { basename } from './text.js'

export type RedactMode = 'none' | 'content' | 'strict'

export function redact(e: EventDraft, mode: RedactMode): EventDraft {
  if (mode === 'none') return e
  const strict = mode === 'strict'
  switch (e.kind) {
    case 'message':
      return { ...e, text: `[${e.text.length} chars]` }
    case 'thinking':
      return { ...e, text: undefined }
    case 'tool.started':
      return {
        ...e,
        input: undefined,
        title: strict ? e.tool : e.title,
        files: strict ? [] : e.files,
      }
    case 'tool.finished':
      return { ...e, output: undefined }
    case 'agent.spawned':
      return { ...e, task: strict ? undefined : e.task }
    case 'session.started':
    case 'session.updated': {
      const meta = { ...e.meta }
      if (meta.titleSource === 'prompt') meta.title = undefined
      if (strict) {
        meta.title = undefined
        meta.cwd = undefined
        meta.transcriptPath = undefined
        meta.gitBranch = undefined
        meta.prUrl = undefined
        meta.goal = undefined
        if (meta.project) meta.project = basename(meta.project)
      }
      return { ...e, meta }
    }
    case 'note':
      return strict ? { ...e, text: e.level } : e
    default:
      return e
  }
}
