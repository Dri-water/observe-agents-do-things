# Building a frontend

The bundled constellation UI is just one consumer. Any frontend gets the same
data, and the core does the hard parts:

- parsing each harness's format
- linking subagents to the calls that spawned them
- de-duplicating streamed records
- deciding when an agent is waiting
- summarising tool calls into titles and categories

There are three ways to plug in, from least to most structured.

## 1. Raw SSE (no dependencies)

```html
<script>
  const es = new EventSource('/api/stream')
  es.addEventListener('snapshot', (m) => render(JSON.parse(m.data)))
  es.addEventListener('event', (m) => onEvent(JSON.parse(m.data)))
</script>
```

Serve it with `oadt --ui ./my-frontend`. [`examples/minimal-feed`](../examples/minimal-feed/index.html)
is a complete 60-line version.

## 2. `@oadt/client` (recommended)

A live mirror of the server's world that works in browsers and in Node:

```ts
import { connect, sessionList, agentTree, openTools, formatCount, totalTokens } from '@oadt/client'

const client = connect({ url: 'http://127.0.0.1:4545', token: process.env.OADT_TOKEN })

client.on('status', (s) => console.log('connection:', s))      // connecting | live | reconnecting | closed
client.on('event', (e, world) => { /* one event at a time */ })
client.onChange((world, events) => {                             // batched per microtask: draw here
  for (const s of sessionList(world)) {
    console.log(s.status, s.meta.title, formatCount(totalTokens(s.usage)))
    console.log(agentTree(s))                                    // nested agents
    console.log(openTools(s))                                    // what is running right now
  }
})

const history = await client.sessionEvents(sessionId)          // backfill a feed
```

Behaviour:

- **Resume.** The client reconnects with backoff and resumes from the last
  sequence number, so no events are lost or duplicated.
- **Same projection.** It applies events with the same `applyEvent` the
  server uses, so `client.world` always equals the server's world.
- **Draw in `onChange`.** It coalesces bursts, such as a backfill, into one call.

## 3. Embed the core

Skip HTTP entirely, for example in an Electron app, a VS Code extension or a
CLI tool:

```ts
import { Observer, sessionList } from '@oadt/core'

const obs = new Observer({ sinceMs: 3 * 3600_000, redact: 'none' })
obs.subscribe((event) => { /* live */ })
await obs.start()                 // resolves after the backfill
console.log(sessionList(obs.world))
```

## Tips

- **Status colours.** `working`, `waiting`, `idle` and `done` are deliberately few.
  `waiting` is the one users care about most, because the agent is blocked on them.
- **Order.** Events are not strictly time-ordered. Use `ts` for placing
  things on a timeline and `seq` for "what's new since".
- **Volume.** A busy session can produce hundreds of events a minute. Redraw on
  `onChange` and throttle DOM work. The bundled UI redraws canvas every frame
  and panels every ~400 ms.
- **Privacy.** Respect `hello.redact`. If it is `content`, message texts are
  placeholders such as `[123 chars]`.
- **Debugging.** In the bundled UI, `window.__oadt` exposes the live client,
  scene and camera.
