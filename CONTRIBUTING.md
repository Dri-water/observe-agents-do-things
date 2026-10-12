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
| Improve a visualization | `apps/web/src/viz/<name>/` (each visualization is self-contained) |
| Add a visualization | a new folder under `apps/web/src/viz/`, registered in `viz/index.ts` (see `docs/VISUALIZATIONS.md`) |

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

## Releasing

```bash
npm run release -- patch    # or minor, major, or an exact version like 1.0.0
```

This bumps the version in the published packages, adds the commits since the last release to the extension's changelog, commits, tags and pushes. The tag starts the [Release workflow](.github/workflows/release.yml). It tests and packages everything, then publishes:

| Where | Needs the repository secret |
|---|---|
| GitHub release with the `.vsix` (also how Cursor, Windsurf and VSCodium install it) | nothing |
| VS Code Marketplace | `VSCE_PAT` |
| npm, for `npx observe-agents-do-things` | nothing: [trusted publishing](https://docs.npmjs.com/trusted-publishers) from this workflow |

A store whose secret isn't set is skipped with a notice, so releases keep working while a token is missing.

### Updating the VS Code Marketplace by hand

`VSCE_PAT` isn't set, so the Marketplace is updated by hand after each release. The [Marketplace in sync](.github/workflows/marketplace.yml) workflow runs after every release and once a day, and fails while the Marketplace is behind the latest release, so a red run means an upload is due.

1. Download `observe-agents-do-things-<version>.vsix` from the [latest release](https://github.com/Dri-water/observe-agents-do-things/releases/latest).
2. Open the [dri-water publisher page](https://marketplace.visualstudio.com/manage/publishers/dri-water) (sign in with the Microsoft account that owns the publisher).
3. Click **⋯** next to Observe Agents › **Update**, and upload the file. If it asks which product, choose **Visual Studio Code**: the Visual Studio uploader fails with "Value cannot be null. Parameter name: v1".
4. Verification takes a few minutes. Then re-run the workflow from the Actions tab, or let the daily check turn green.

To automate it instead, create an Azure DevOps personal access token with the **Marketplace › Manage** scope and **All accessible organizations**, and save it with `gh secret set VSCE_PAT`. The Release workflow then publishes to the Marketplace itself.
