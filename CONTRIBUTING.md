# Contributing

Thanks for helping people see what their agents are doing.

## Setup

```bash
npm install
npm run build
npm test
npm run dev        # API (demo data) + Vite UI with hot reload at http://localhost:5175
```

## Where things go

| You want to… | Edit |
|---|---|
| Support a new harness or a new record type | `packages/core/src/adapters/` (+ a synthetic test in `adapters.test.ts`) |
| Derive new state for every frontend | `packages/protocol/src/state.ts` (keep `applyEvent` pure and order-tolerant) |
| Add an event kind or field | `packages/protocol/src/events.ts`, document it in `docs/PROTOCOL.md` |
| Change status heuristics | `packages/core/src/status.ts` |
| Add an endpoint | `packages/server/src/server.ts` and `docs/API.md` |
| Improve the visuals | `apps/web/src/` (scene model in `scene.ts`, drawing in `draw.ts`) |

The rule of thumb: **if two frontends would both need it, it belongs in the
core or protocol, not in a frontend.**

## Ground rules

- **Never commit real transcripts.** They contain people's code and
  conversations. Write small synthetic fixtures that mirror the shapes.
- **No runtime dependencies** in `protocol`, `core`, `client` or `server`
  without a very good reason.
- **The observer is read-only.** It must never write to agent directories.
- **Protocol changes are additive.** New optional fields and kinds are fine;
  renames and removals need a `PROTOCOL_VERSION` bump.
- **Run the whole suite.** `npm test` runs unit tests and an end-to-end
  server + client test.
