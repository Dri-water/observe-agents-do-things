# HTTP API

The server is plain `node:http`, with no framework and no runtime dependencies.
The default address is `http://127.0.0.1:4545`.

## Authentication & origins

- Loopback binds need no token by default. Non-loopback binds always require one.
  Send it as `Authorization: Bearer <token>`, or as `?token=` for clients such as
  `EventSource` that cannot set headers.
- The `Host` header must be loopback, the bound address or a LAN address
  of the machine. Anything else gets `421`, which defeats DNS rebinding. Open the
  UI by IP (e.g. `http://192.168.1.20:4545`), not by hostname.
- Cross-origin requests are rejected with `403` unless the origin was allowed
  with `--cors <origin>`. Same-origin pages (anything served by `--ui`) just work.

## Endpoints

### `GET /api/stream`

[Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html).

```
retry: 1000

event: hello
data: {"protocol":1,"version":"0.1.0","seq":1234,"sources":[…],"redact":"none","ingest":true}

event: snapshot
data: { …WorldState… }

id: 1235
event: event
data: { …ObserverEvent… }
```

- `?session=<id>` limits both the snapshot and the events to one session.
- Reconnects that send `Last-Event-ID` (or `?lastEventId=`) receive an
  `event: resumed` and the missed events instead of a snapshot, as long as they
  are still in the replay buffer (50k events by default).
- A `: keepalive` comment is sent every 15 s.

### `GET /api/state`

The full `WorldState`. `?session=<id>` narrows it to one session.

### `GET /api/sessions`

`{ seq, sessions: [...] }`. Each session is summarised without its tool and
file maps, plus `agentCount` and `fileCount`.

### `GET /api/sessions/:id`

One session's full state.

### `GET /api/sessions/:id/events?after=<seq>`

That session's retained history (5k events by default). The web UI uses
it to fill the feed when you open a session.

### `GET /api/events?after=<seq>&limit=<n>`

The global event log, for clients that would rather poll than stream. It returns
`410` when `after` has fallen out of the buffer; fetch `/api/state` instead.

### `GET /api/info`

Version, protocol, sources (with file counts), redaction mode, and whether
ingest is enabled.

### `POST /api/ingest`

Push events from your own code. The body is a single `EventDraft` or an array
of them, and `Content-Type` must be `application/json`.

```json
[
  { "sessionId": "build-42", "kind": "session.started", "meta": { "title": "Nightly build", "project": "api" } },
  { "sessionId": "build-42", "kind": "tool.started", "callId": "c1", "tool": "make", "category": "shell", "title": "$ make test" },
  { "sessionId": "build-42", "kind": "tool.finished", "callId": "c1", "ok": true }
]
```

`harness` defaults to `custom`, `agentId` to the session id, and `ts` to now.
The response is `202 { accepted, seq }`. Disable ingest with `--read-only`.
