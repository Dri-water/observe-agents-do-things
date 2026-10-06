# Protocol

Everything a frontend can know arrives as an `ObserverEvent`. Types live in
[`packages/protocol/src/events.ts`](../packages/protocol/src/events.ts), and the
projection lives in [`state.ts`](../packages/protocol/src/state.ts).

## Envelope

Every event carries:

| Field | Meaning |
|---|---|
| `seq` | Monotonic sequence number assigned by the observer. Use it to resume. |
| `ts` | Wall-clock time of the activity in epoch ms, taken from the transcript when available. |
| `harness` | `claude-code`, `codex`, or any string from a custom source. |
| `sessionId` | The session. For Codex this is the *root* thread, shared by its subagents. |
| `agentId` | The acting agent. **The root agent's id equals the session id.** |
| `kind` | One of the kinds below. |

Events are not guaranteed to arrive in `ts` order. Transcripts are read file by
file, so a subagent's history can arrive after its parent's. `applyEvent`
copes with any order.

## Event kinds

| Kind | Payload | Notes |
|---|---|---|
| `session.started` | `meta` | First sighting, with cwd, project, branch, harness version and entrypoint. |
| `session.updated` | `meta` (partial) | Title, model, cost, PR link, goal… Undefined fields are left unchanged. |
| `session.status` | `status`, `reason?` | `working`, `waiting`, `idle` or `ended`. Emitted by the status heuristics. |
| `agent.spawned` | `name`, `role?`, `task?`, `parentAgentId?`, `parentToolCallId?`, `model?` | A subagent appeared. Claude subagents link via `parentToolCallId`, Codex threads via `parentAgentId`. |
| `agent.status` | `status`, `reason?` | `working`, `waiting`, `idle` or `done`. |
| `turn.started` | `turnId?` | The user (or a parent agent) asked for something. |
| `turn.ended` | `outcome`, `turnId?`, `durationMs?` | `completed`, `aborted` or `error`. On a subagent it means *done*. |
| `message` | `role`, `text`, `to?` | `user`, `assistant`, or `agent` (inter-agent/task prompt). Harness-injected content is filtered out. |
| `thinking` | `text?`, `durationMs?` | Reasoning happened. Text appears only when the harness stores it in plain text. |
| `tool.started` | `callId`, `tool`, `category`, `title`, `input?`, `files?`, `mcpServer?` | `title` is a one-line human summary; `category` is harness-agnostic. |
| `tool.finished` | `callId`, `ok`, `output?`, `durationMs?` | |
| `usage` | `delta`, `model?`, `contextTokens?`, `contextWindow?` | Token **deltas**. Sum them for totals. |
| `note` | `level`, `text` | Context compaction, harness errors. |

### Tool categories

`read`, `search`, `edit`, `write`, `shell`, `web`, `agent`, `plan`, `mcp`,
`interact` and `other`. Frontends colour and group by these, so a Codex `exec` running
`rg` and a Claude `Grep` look like the same kind of work.

### Files

`tool.started.files` lists `{ path, op }` where `op` is `read`, `edit`, `write`,
`delete` or `search`. Codex `apply_patch` bodies are parsed for their file
headers, even inside `exec` scripts.

## WorldState

`applyEvent(world, event)` folds events into:

```ts
WorldState {
  seq
  sessions: {
    [id]: {
      harness, meta, status, statusReason, startedAt, lastActivityAt, rootAgentId,
      agents:  { [id]: { parentId, name, role, task, depth, status, activeTools[], toolCount,
                         errorCount, children[], lastText, thinking, usage, contextTokens, … } },
      tools:   { [callId]: { agentId, tool, category, title, input, files, startedAt, endedAt,
                             ok, output, durationMs, childAgentId } },   // bounded, newest kept
      toolOrder: string[],
      files:   { [path]: { reads, edits, writes, deletes, searches, touches, lastOp, lastTs, lastAgentId } },
      usage, contextTokens, contextWindow,
      counts:  { tools, toolErrors, messages, userMessages, turns, thinking, agents },
      byCategory, lastMessage, lastNote, turn,
    }
  }
}
```

It is plain JSON. The server sends it as the stream's first `snapshot`, and
clients keep it current by applying the same events. Useful selectors include
`sessionList`, `openTools`, `agentTree`, `hotFiles`, `contextFill`,
`worldTotals` and `formatCount`, all exported from `@oadt/protocol`.

## Status semantics

Transcripts record what *happened*, not what is happening *now*, so a 1-second
ticker in the observer converts silence into status:

- **waiting**: a non-agent tool has been in flight for 8 s and the session has
  written nothing since. In practice this is a permission prompt, or a slow
  command. The reason string names the tool.
- **idle**: the turn ended, or there has been no activity for 5 minutes with
  nothing in flight, or for 15 minutes regardless.
- **done**: a subagent whose spawning call returned, or whose own turn ended.

Any new activity puts an agent and its session back to `working`. Only events
newer than the last turn end can do that, so late-arriving history never
"revives" a finished session.

## Versioning

`PROTOCOL_VERSION` (currently `1`) is sent in the stream's `hello`. New
optional fields and new event kinds are additive. Ignore kinds you don't
understand.
