# Adding a harness

An adapter teaches the observer one on-disk transcript format. You implement
`TranscriptAdapter` (in [`packages/core/src/adapters/types.ts`](../packages/core/src/adapters/types.ts)),
and the shared `TranscriptWatcher` takes care of discovery, `fs.watch` plus
polling, byte-safe tailing, huge-file handling and backfill ordering.

```ts
import type { TranscriptAdapter, LineParser, Emit } from '@oadt/core'

export class MyHarnessAdapter implements TranscriptAdapter {
  readonly harness = 'my-harness'
  roots() { return ['/home/me/.my-harness/logs'] }                 // watched recursively
  accepts(path: string) { return path.endsWith('.jsonl') }
  async discover(sinceMs: number) { /* return files modified since sinceMs */ return [] }
  order(path: string) { return path.includes('/children/') ? 1 : 0 }  // parents first
  createParser(path: string, emit: Emit): LineParser { return new MyParser(path, emit) }
}

class MyParser implements LineParser {
  sessionId: string | undefined
  constructor(readonly path: string, private emit: Emit) {}
  markPartial() { /* the middle of a huge file was skipped */ }
  line(raw: string) {
    const r = JSON.parse(raw)
    this.sessionId ??= r.session
    this.emit({ harness: 'my-harness', sessionId: r.session, agentId: r.session, ts: Date.parse(r.time),
                kind: 'tool.started', callId: r.id, tool: r.tool, category: 'shell', title: `$ ${r.cmd}` })
  }
}
```

Register it:

```ts
new Observer({ adapters: [new MyHarnessAdapter()] })
```

If your harness can't be tailed, for example because it lives in a database or
comes over a socket, implement a `Source` instead (`start(emit)` / `stop()`) or
push events to `POST /api/ingest`.

## Lessons from the built-in adapters

- **Timestamps.** Use the transcript's own timestamps. Some records have none
  (Claude's title and cost records), so inherit the last seen time rather
  than "now". Otherwise old sessions look freshly active.
- **Injected content.** Harnesses put system reminders, environment blocks and IDE
  context into the *user* role. Filter them, or every session looks like the
  human typed a wall of XML. `humanText()` in `text.ts` handles the known
  prefixes, and renders slash commands as `/command args`.
- **Split records.** Claude writes one record per content block, and the
  blocks share a `message.id` and repeat `usage`. Emit token *deltas* per
  message id.
- **Cumulative counters.** Codex reports running totals, so diff them.
- **Replays.** Compaction and resume can repeat records. Make parsing
  idempotent with record uuids and tool-call ids.
- **Subagents.** Emit `agent.spawned` with `parentToolCallId` when you can.
  The projection links the subagent to the call even when it is announced first.
- **Huge files.** Don't read whole files. The watcher reads a head chunk,
  where metadata usually lives, plus a bounded tail.

## Test with synthetic transcripts

Copy the pattern in [`packages/core/src/adapters.test.ts`](../packages/core/src/adapters.test.ts):
hand-write a handful of records that mirror the real shapes, run them
through your parser and assert on the projected `WorldState`. Never commit real
transcripts, because they contain people's code and conversations.
