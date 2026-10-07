/**
 * A scripted, endlessly looping simulation of several coding sessions across
 * Claude Code and Codex: subagents, web research, MCP tools, questions for the
 * user, failing tests, permission waits, interruptions and fixes.
 * Used for `oadt --demo`, screenshots, and frontend development. No real data.
 */
import type { EventDraft, FileChange, FileRef, ToolCategory } from '@oadt/protocol'
import { claudeChanges, patchChanges } from '../diff.js'
import type { Emit } from '../adapters/types.js'
import type { Source } from '../observer.js'

type Body = EventDraft extends infer T ? (T extends unknown ? Omit<T, 'ts' | 'harness' | 'sessionId' | 'agentId'> : never) : never

let counter = 0
const uid = (p: string) => `${p}_${Date.now().toString(36)}${(counter++).toString(36)}`

class Clock {
  stopped = false
  constructor(private speed: number) {}
  sleep(ms: number): Promise<void> {
    if (this.stopped) return new Promise(() => {})
    const jitter = ms * (0.75 + Math.random() * 0.5)
    return new Promise((r) => setTimeout(r, jitter / this.speed).unref?.())
  }
}

class Actor {
  constructor(
    private emit: Emit,
    private clock: Clock,
    readonly harness: string,
    readonly sessionId: string,
    readonly agentId: string,
    private model: string,
    /** Range the simulated context fill wanders in (tokens). */
    private ctx: [number, number] = [20_000, 80_000],
  ) {}

  send(body: Body): void {
    if (this.clock.stopped) return
    this.emit({ ts: Date.now(), harness: this.harness, sessionId: this.sessionId, agentId: this.agentId, ...body } as EventDraft)
  }

  async think(ms = 1800, text?: string): Promise<void> {
    this.send({ kind: 'thinking', text })
    await this.clock.sleep(ms)
  }

  async say(text: string, ms = 900): Promise<void> {
    this.send({ kind: 'message', role: 'assistant', text })
    this.tokens(300 + Math.random() * 900)
    await this.clock.sleep(ms)
  }

  tokens(out: number): void {
    const ctx = this.ctx[0] + Math.random() * (this.ctx[1] - this.ctx[0])
    this.send({
      kind: 'usage',
      model: this.model,
      delta: { input: Math.round(200 + Math.random() * 1500), output: Math.round(out), cacheRead: Math.round(ctx * 0.8), cacheWrite: Math.round(Math.random() * 3000), reasoning: Math.round(out * 0.3) },
      contextTokens: Math.round(ctx),
      contextWindow: 200_000,
    })
  }

  start(tool: string, category: ToolCategory, title: string, files: FileRef[] = [], input?: unknown, changes?: FileChange[]): string {
    const callId = uid('call')
    this.send({ kind: 'tool.started', callId, tool, category, title, files, input, changes })
    return callId
  }

  finish(callId: string, ok = true, output?: string): void {
    this.send({ kind: 'tool.finished', callId, ok, output })
  }

  async tool(tool: string, category: ToolCategory, title: string, opts: { files?: FileRef[]; ms?: number; ok?: boolean; output?: string; input?: unknown; changes?: FileChange[] } = {}): Promise<string> {
    const id = this.start(tool, category, title, opts.files, opts.input, opts.changes)
    await this.clock.sleep(opts.ms ?? 1200)
    this.finish(id, opts.ok ?? true, opts.output ?? (opts.ok === false ? 'Error: command failed' : 'ok'))
    this.tokens(80 + Math.random() * 200)
    return id
  }

  child(agentId: string): Actor {
    return new Actor(this.emit, this.clock, this.harness, this.sessionId, agentId, this.model)
  }
}

const RATE_LIMIT_TS = [
  "import type { NextFunction, Request, Response } from 'express'",
  "",
  "const buckets = new Map<string, { tokens: number; at: number }>()",
  "",
  "/** Token bucket per user: `capacity` burst, refilled at `perMinute`. */",
  "export function rateLimit(capacity = 20, perMinute = 60) {",
  "  return (req: Request, res: Response, next: NextFunction) => {",
  "    const key = req.user?.id ?? req.ip",
  "    const now = Date.now()",
  "    const b = buckets.get(key) ?? { tokens: capacity, at: now }",
  "    b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 60_000) * perMinute)",
  "    b.at = now",
  "    if (b.tokens < 1) return res.status(429).set('Retry-After', '1').end()",
  "    b.tokens -= 1",
  "    buckets.set(key, b)",
  "    next()",
  "  }",
  "}",
].join('\n')

const RATE_LIMIT_TEST = [
  "import { describe, expect, it } from 'vitest'",
  "import request from 'supertest'",
  "import { app } from '../src/server'",
  "",
  "describe('rate limiting', () => {",
  "  it('allows bursts up to capacity', async () => {",
  "    for (let i = 0; i < 20; i++) await request(app).get('/status').expect(200)",
  "    await request(app).get('/status').expect(429)",
  "  })",
  "",
  "  it('sets Retry-After when limited', async () => {",
  "    const res = await request(app).get('/status')",
  "    expect(res.headers['retry-after']).toBe('1')",
  "  })",
  "})",
].join('\n')

const PIPELINE_PATCH = [
  "*** Begin Patch",
  "*** Update File: src/pipeline.rs",
  "@@ pub fn thumbnail(raw: &[u8], w: u32, h: u32) -> Result<Vec<u8>>",
  "-    let mut encoder = Encoder::new(Quality::High);",
  "+    let mut encoder = ENCODER.with(|e| e.take()).unwrap_or_else(|| Encoder::new(Quality::High));",
  "     let img = resize(&raw, w, h)?;",
  "-    encoder.encode(&img)",
  "+    let out = encoder.encode(&img);",
  "+    ENCODER.with(|e| e.set(Some(encoder)));",
  "+    out",
  "*** Update File: src/encoder.rs",
  "@@ impl Encoder",
  "+thread_local! {",
  "+    pub static ENCODER: Cell<Option<Encoder>> = const { Cell::new(None) };",
  "+}",
  "*** End Patch",
].join('\n')

const ENCODER_FIX = [
  "*** Begin Patch",
  "*** Update File: src/encoder.rs",
  "@@ pub fn encode(&mut self, img: &Image) -> Result<Vec<u8>>",
  "-        let buf = &mut self.scratch;",
  "-        self.write_header(buf)?;",
  "+        let mut buf = std::mem::take(&mut self.scratch);",
  "+        self.write_header(&mut buf)?;",
  "*** End Patch",
].join('\n')

const read = (path: string): FileRef[] => [{ path, op: 'read' }]
const edit = (path: string): FileRef[] => [{ path, op: 'edit' }]
const write = (path: string): FileRef[] => [{ path, op: 'write' }]

async function claudeSession(emit: Emit, clock: Clock): Promise<void> {
  const sessionId = uid('demo-claude')
  const root = '/home/dev/orbit-api'
  const main = new Actor(emit, clock, 'claude-code', sessionId, sessionId, 'claude-opus-demo')
  main.send({ kind: 'session.started', meta: { cwd: root, project: 'orbit-api', gitBranch: 'feat/rate-limits', entrypoint: 'claude-desktop', model: 'claude-opus-demo', demo: true, title: 'Per-user rate limiting', titleSource: 'custom' } })
  let cost = 0
  const prompts = [
    'Add per-user rate limiting to the public API and make sure the tests cover burst traffic.',
    'Now expose the limits in the /status endpoint and document them.',
    'Tighten the error messages — clients should know when to retry.',
  ]
  for (let round = 0; !clock.stopped; round++) {
    const prompt = prompts[round % prompts.length]!
    main.send({ kind: 'turn.started', turnId: uid('turn') })
    main.send({ kind: 'message', role: 'user', text: prompt })
    await clock.sleep(700)
    await main.think(2200, 'Need to find where requests are authenticated, then add a token bucket keyed by user id.')
    await main.tool('Grep', 'search', 'Grep "rateLimit" in src', { ms: 700, output: 'src/server.ts:41: // TODO rateLimit' })
    await Promise.all([
      main.tool('Read', 'read', 'Read src/server.ts', { files: read(`${root}/src/server.ts`), ms: 600 }),
      main.tool('Read', 'read', 'Read src/middleware/auth.ts', { files: read(`${root}/src/middleware/auth.ts`), ms: 800 }),
    ])

    // An Explore subagent surveys the middleware stack.
    const exploreCall = main.start('Agent', 'agent', 'Explore: Survey middleware and config loading', [], { subagent_type: 'Explore', description: 'Survey middleware and config loading' })
    const explore = main.child(uid('agent'))
    explore.send({ kind: 'agent.spawned', parentToolCallId: exploreCall, name: 'Survey middleware', role: 'Explore', task: 'Survey middleware and config loading' })
    explore.send({ kind: 'message', role: 'agent', text: 'Map every middleware in src/middleware and how config reaches them.' })
    await explore.tool('Glob', 'search', 'Glob src/middleware/**/*.ts', { ms: 500 })
    for (const f of ['cors.ts', 'logging.ts', 'errors.ts']) await explore.tool('Read', 'read', `Read src/middleware/${f}`, { files: read(`${root}/src/middleware/${f}`), ms: 650 })
    await explore.tool('Read', 'read', 'Read src/config.ts', { files: read(`${root}/src/config.ts`), ms: 600 })
    await explore.say('Middleware is registered in src/server.ts in a fixed order; config is a frozen object from src/config.ts.')
    explore.send({ kind: 'turn.ended', outcome: 'completed' })
    main.finish(exploreCall, true, 'Middleware order: cors → logging → auth → routes → errors.')

    await main.tool('TodoWrite', 'plan', 'Todos 0/4 · Writing token bucket', { ms: 300 })
    await main.tool('Write', 'write', 'Write src/middleware/rateLimit.ts', { files: write(`${root}/src/middleware/rateLimit.ts`), ms: 1400, changes: claudeChanges('Write', { file_path: `${root}/src/middleware/rateLimit.ts`, content: RATE_LIMIT_TS }) })
    await main.tool('Edit', 'edit', 'Edit src/server.ts', { files: edit(`${root}/src/server.ts`), ms: 900, changes: claudeChanges('Edit', { file_path: `${root}/src/server.ts`, old_string: "import { auth } from './middleware/auth'\nimport { routes } from './routes'\n\napp.use(cors())\napp.use(logging())\napp.use(auth())\napp.use(routes)", new_string: "import { auth } from './middleware/auth'\nimport { rateLimit } from './middleware/rateLimit'\nimport { routes } from './routes'\n\napp.use(cors())\napp.use(logging())\napp.use(auth())\napp.use(rateLimit(config.rateLimit.burst, config.rateLimit.perMinute))\napp.use(routes)" }) })
    await main.tool('Edit', 'edit', 'Edit src/config.ts', { files: edit(`${root}/src/config.ts`), ms: 700, changes: claudeChanges('Edit', { file_path: `${root}/src/config.ts`, old_string: "export const config = Object.freeze({\n  port: Number(process.env.PORT ?? 8080),\n  logLevel: process.env.LOG_LEVEL ?? 'info',\n})", new_string: "export const config = Object.freeze({\n  port: Number(process.env.PORT ?? 8080),\n  logLevel: process.env.LOG_LEVEL ?? 'info',\n  rateLimit: { burst: 20, perMinute: 60 },\n})" }) })
    await main.tool('Write', 'write', 'Write test/rateLimit.test.ts', { files: write(`${root}/test/rateLimit.test.ts`), ms: 1200, changes: claudeChanges('Write', { file_path: `${root}/test/rateLimit.test.ts`, content: RATE_LIMIT_TEST }) })
    await main.tool('Bash', 'shell', '$ npm test -- rateLimit', { ms: 3200, ok: false, output: '✗ allows bursts up to capacity\n  expected 429, received 200\n1 failing, 11 passing' })
    await main.think(1600, 'The refill happens before the capacity check — off by one on the first burst.')
    await main.tool('Edit', 'edit', 'Edit src/middleware/rateLimit.ts', { files: edit(`${root}/src/middleware/rateLimit.ts`), ms: 800, changes: claudeChanges('Edit', { file_path: `${root}/src/middleware/rateLimit.ts`, old_string: "    const b = buckets.get(key) ?? { tokens: capacity, at: now }\n    b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 60_000) * perMinute)\n    b.at = now\n    if (b.tokens < 1) return res.status(429).set('Retry-After', '1').end()", new_string: "    const b = buckets.get(key)\n    if (!b) {\n      buckets.set(key, { tokens: capacity - 1, at: now })\n      return next()\n    }\n    b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 60_000) * perMinute)\n    b.at = now\n    if (b.tokens < 1) return res.status(429).set('Retry-After', '1').end()" }) })

    // A permission prompt: the command sits pending until "approved".
    const install = main.start('Bash', 'shell', '$ npm install --save-dev autocannon', [], { command: 'npm install --save-dev autocannon' })
    await clock.sleep(11_000)
    main.finish(install, true, 'added 14 packages in 3s')
    await main.tool('Bash', 'shell', '$ npm test', { ms: 3000, output: '12 passing (2s)' })

    // Two reviewers in parallel.
    const reviewers = [
      { name: 'Security review', role: 'security-reviewer', files: ['rateLimit.ts', 'auth.ts'] },
      { name: 'Docs pass', role: 'docs-writer', files: ['README.md', 'docs/limits.md'] },
    ]
    await Promise.all(reviewers.map(async (r) => {
      const call = main.start('Agent', 'agent', `${r.role}: ${r.name}`, [], { subagent_type: r.role })
      const sub = main.child(uid('agent'))
      sub.send({ kind: 'agent.spawned', parentToolCallId: call, name: r.name, role: r.role, task: r.name })
      for (const f of r.files) {
        const p = f.includes('/') || f.endsWith('.md') ? `${root}/${f}` : `${root}/src/middleware/${f}`
        await sub.tool(f.endsWith('.md') ? 'Edit' : 'Read', f.endsWith('.md') ? 'edit' : 'read', `${f.endsWith('.md') ? 'Edit' : 'Read'} ${f}`, { files: f.endsWith('.md') ? edit(p) : read(p), ms: 900 })
      }
      await sub.say(r.role === 'security-reviewer' ? 'Keys are hashed before use; no user id leaks into logs.' : 'Documented limits and Retry-After semantics.')
      sub.send({ kind: 'turn.ended', outcome: 'completed' })
      main.finish(call, true, 'done')
    }))

    await main.tool('TodoWrite', 'plan', 'Todos 4/4', { ms: 300 })
    await main.say('Rate limiting is live: a token bucket per user (60 req/min, bursts of 20), wired after auth. Tests cover burst and refill; docs updated.')
    cost += 0.4 + Math.random() * 0.3
    main.send({ kind: 'session.updated', meta: { costUsd: Number(cost.toFixed(2)), linesAdded: 180 + round * 40, linesRemoved: 22 + round * 6 } })
    main.send({ kind: 'turn.ended', outcome: 'completed' })
    await clock.sleep(14_000)
  }
}

async function codexSession(emit: Emit, clock: Clock): Promise<void> {
  const sessionId = uid('demo-codex')
  const root = '/home/dev/pixel-forge'
  const main = new Actor(emit, clock, 'codex', sessionId, sessionId, 'gpt-codex-demo')
  main.send({ kind: 'session.started', meta: { cwd: root, project: 'pixel-forge', gitBranch: 'main', entrypoint: 'Codex Desktop', model: 'gpt-codex-demo', demo: true } })
  main.send({ kind: 'session.updated', meta: { title: 'Cut thumbnail p95 latency', titleSource: 'custom', goal: 'Thumbnail p95 under 120 ms', goalStatus: 'active' } })
  await clock.sleep(4000)
  for (let round = 0; !clock.stopped; round++) {
    main.send({ kind: 'turn.started', turnId: uid('turn') })
    main.send({ kind: 'message', role: 'user', text: round % 2 === 0 ? 'Profile the thumbnail pipeline and cut p95 latency.' : 'Run the benchmark again and summarise the delta.' })
    await clock.sleep(900)
    await main.think(1500)
    await main.tool('exec', 'shell', '$ rg -n "resize|encode" src --type rust', { ms: 900, output: 'src/pipeline.rs:88: let img = resize(&raw, w, h)?;' })
    await main.tool('exec', 'read', 'View src/pipeline.rs', { files: read(`${root}/src/pipeline.rs`), ms: 700 })
    await main.tool('update_plan', 'plan', 'Plan 1/3 · Benchmark baseline', { ms: 300 })

    // Codex subagents are separate threads that report back.
    const spawn = main.start('spawn_agent', 'agent', 'spawn agent · bench-runner')
    const worker = main.child(uid('thread'))
    worker.send({ kind: 'agent.spawned', parentAgentId: sessionId, parentToolCallId: spawn, name: 'bench-runner', role: 'worker', task: 'Measure p50/p95 on the sample corpus' })
    main.finish(spawn, true, '{"accepted":true}')
    const waiting = main.start('wait_agent', 'agent', 'wait agent · bench-runner')
    worker.send({ kind: 'turn.started' })
    worker.send({ kind: 'message', role: 'agent', text: 'Measure p50/p95 on the sample corpus' })
    await worker.tool('exec', 'shell', '$ cargo bench --bench thumbs', { ms: 4200, output: 'p50 61ms  p95 188ms' })
    await worker.say('Baseline: p50 61 ms, p95 188 ms. 70% of the tail is in the encoder allocating per frame.')
    worker.send({ kind: 'turn.ended', outcome: 'completed' })
    main.finish(waiting, true, 'bench-runner: p95 188ms')

    await main.tool('apply_patch', 'edit', 'Patch src/pipeline.rs +1', { files: [...edit(`${root}/src/pipeline.rs`), ...edit(`${root}/src/encoder.rs`)], ms: 1300, changes: patchChanges(PIPELINE_PATCH) })
    await main.tool('exec', 'shell', '$ cargo test', { ms: 2600, ok: round % 3 !== 1, output: round % 3 !== 1 ? 'test result: ok. 41 passed' : 'error[E0502]: cannot borrow `buf` as mutable' })
    if (round % 3 === 1) {
      await main.think(1200)
      await main.tool('apply_patch', 'edit', 'Patch src/encoder.rs', { files: edit(`${root}/src/encoder.rs`), ms: 900, changes: patchChanges(ENCODER_FIX) })
      await main.tool('exec', 'shell', '$ cargo test', { ms: 2400, output: 'test result: ok. 41 passed' })
    }
    await main.tool('exec', 'shell', '$ cargo bench --bench thumbs', { ms: 3800, output: 'p50 44ms  p95 109ms' })
    await main.tool('update_plan', 'plan', 'Plan 3/3', { ms: 300 })
    await main.say('Reused the encoder scratch buffer across frames: p95 188 → 109 ms, p50 61 → 44 ms. All tests pass.')
    main.send({ kind: 'turn.ended', outcome: 'completed' })
    await clock.sleep(22_000)
  }
}

const LOGIN_TS = [
  "import { setTimeout as sleep } from 'node:timers/promises'",
  "import { keychain } from '../keychain'",
  "",
  "const CLIENT_ID = 'atlas-cli'",
  "",
  "/** `atlas login`: OAuth 2.0 device authorization grant (RFC 8628). */",
  "export async function login(api: string): Promise<void> {",
  "  const code = await post(`${api}/oauth/device/code`, { client_id: CLIENT_ID })",
  "  console.log(`Open ${code.verification_uri} and enter ${code.user_code}`)",
  "  for (let interval = code.interval; ; ) {",
  "    await sleep(interval * 1000)",
  "    const res = await post(`${api}/oauth/token`, {",
  "      client_id: CLIENT_ID,",
  "      device_code: code.device_code,",
  "      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',",
  "    })",
  "    if (res.error === 'authorization_pending') continue",
  "    if (res.error === 'slow_down') { interval += 5; continue }",
  "    if (res.error) throw new Error(`login failed: ${res.error}`)",
  "    await keychain.set('atlas', res.access_token)",
  "    return console.log('Logged in.')",
  "  }",
  "}",
].join('\n')

const PATHS_FIX = [
  "*** Begin Patch",
  "*** Update File: src/paths.rs",
  "@@ pub fn cache_key(path: &Path) -> String",
  "-    path.to_string_lossy().to_string()",
  "+    // Windows runners hand us `C:\\x\\y`; everything else uses `/`.",
  "+    path.components()",
  "+        .map(|c| c.as_os_str().to_string_lossy())",
  "+        .collect::<Vec<_>>()",
  "+        .join(\"/\")",
  "*** Update File: .github/workflows/ci.yml",
  "@@ jobs:",
  "       - run: cargo test --all-features",
  "+        env:",
  "+          RUST_TEST_THREADS: 4",
  "*** End Patch",
].join('\n')

const THEME_TOGGLE = [
  "import { useEffect, useState } from 'react'",
  "",
  "type Theme = 'light' | 'dark' | 'system'",
  "",
  "export function ThemeToggle() {",
  "  const [theme, setTheme] = useState<Theme>(() => (localStorage.theme as Theme) ?? 'system')",
  "  useEffect(() => {",
  "    const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)",
  "    document.documentElement.dataset.theme = dark ? 'dark' : 'light'",
  "    localStorage.theme = theme",
  "  }, [theme])",
  "  return (",
  "    <select value={theme} onChange={(e) => setTheme(e.target.value as Theme)} aria-label=\"Theme\">",
  "      <option value=\"system\">System</option>",
  "      <option value=\"light\">Light</option>",
  "      <option value=\"dark\">Dark</option>",
  "    </select>",
  "  )",
  "}",
].join('\n')

/** Claude Code researching the web, asking the user a question and opening a PR through MCP. */
async function loginSession(emit: Emit, clock: Clock): Promise<void> {
  const sessionId = uid('demo-claude')
  const root = '/home/dev/atlas-cli'
  const main = new Actor(emit, clock, 'claude-code', sessionId, sessionId, 'claude-sonnet-demo')
  await clock.sleep(1500)
  main.send({ kind: 'session.started', meta: { cwd: root, project: 'atlas-cli', gitBranch: 'feat/device-login', entrypoint: 'vscode', model: 'claude-sonnet-demo', demo: true, title: 'atlas login via device flow', titleSource: 'custom' } })
  let cost = 0
  for (let round = 0; !clock.stopped; round++) {
    main.send({ kind: 'turn.started', turnId: uid('turn') })
    main.send({ kind: 'message', role: 'user', text: round % 2 === 0 ? 'Add `atlas login` using the OAuth device flow. Check the spec first.' : 'Handle slow_down properly and open a PR.' })
    await clock.sleep(600)
    await main.think(1400, 'The device grant is RFC 8628. Read it before writing the polling loop.')
    await main.tool('WebSearch', 'web', 'WebSearch "OAuth device authorization grant RFC 8628"', { ms: 1600 })
    await main.tool('WebFetch', 'web', 'WebFetch datatracker.ietf.org/doc/html/rfc8628', { ms: 2200, output: 'Section 3.5: slow_down means increase the interval by 5 seconds.' })
    await Promise.all([
      main.tool('Read', 'read', 'Read src/commands/index.ts', { files: read(`${root}/src/commands/index.ts`), ms: 500 }),
      main.tool('Grep', 'search', 'Grep "keychain" in src', { ms: 700 }),
    ])
    const ask = main.start('AskUserQuestion', 'interact', 'Store the token in the OS keychain or ~/.atlas/credentials?', [], { question: 'Where should the token live?' })
    await clock.sleep(5200)
    main.finish(ask, true, 'OS keychain')
    main.send({ kind: 'message', role: 'user', text: 'OS keychain, please.' })
    await main.tool('Write', 'write', 'Write src/commands/login.ts', { files: write(`${root}/src/commands/login.ts`), ms: 1500, changes: claudeChanges('Write', { file_path: `${root}/src/commands/login.ts`, content: LOGIN_TS }) })
    await main.tool('Edit', 'edit', 'Edit src/commands/index.ts', { files: edit(`${root}/src/commands/index.ts`), ms: 800, changes: claudeChanges('Edit', { file_path: `${root}/src/commands/index.ts`, old_string: "export const commands = {\n  status,\n  deploy,\n}", new_string: "export const commands = {\n  status,\n  deploy,\n  login,\n}" }) })
    await main.tool('Bash', 'shell', '$ npm run build', { ms: 2600, output: 'built in 1.9s' })
    await main.tool('Bash', 'shell', '$ npm test -- login', { ms: 2200, output: '6 passing' })
    await main.tool('mcp__github__create_pull_request', 'mcp', 'github · create_pull_request "atlas login via device flow"', { ms: 1800, output: 'https://github.com/example/atlas-cli/pull/214' })
    await main.say('Added `atlas login` (RFC 8628 device flow): polls with backoff on slow_down and stores the token in the OS keychain. PR #214 is open.')
    cost += 0.2 + Math.random() * 0.2
    main.send({ kind: 'session.updated', meta: { costUsd: Number(cost.toFixed(2)), prUrl: 'https://github.com/example/atlas-cli/pull/214' } })
    main.send({ kind: 'turn.ended', outcome: 'completed' })
    await clock.sleep(9000)
  }
}

/** Codex chasing a flaky test: a run of failures, a fix, and now and then an interrupted turn. */
async function flakySession(emit: Emit, clock: Clock): Promise<void> {
  const sessionId = uid('demo-codex')
  const root = '/home/dev/quarry'
  const main = new Actor(emit, clock, 'codex', sessionId, sessionId, 'gpt-codex-demo')
  await clock.sleep(6000)
  main.send({ kind: 'session.started', meta: { cwd: root, project: 'quarry', gitBranch: 'fix/windows-ci', entrypoint: 'codex-cli', model: 'gpt-codex-demo', demo: true } })
  main.send({ kind: 'session.updated', meta: { title: 'Fix flaky Windows CI', titleSource: 'custom' } })
  for (let round = 0; !clock.stopped; round++) {
    main.send({ kind: 'turn.started', turnId: uid('turn') })
    main.send({ kind: 'message', role: 'user', text: 'CI keeps failing on the Windows runner. Find out why and fix it.' })
    await clock.sleep(700)
    await main.tool('exec', 'shell', '$ gh run view 4821 --log-failed', { ms: 1800, output: 'paths::tests::cache_key_is_stable FAILED' })
    await main.tool('exec', 'read', 'View .github/workflows/ci.yml', { files: read(`${root}/.github/workflows/ci.yml`), ms: 600 })
    for (let i = 0; i < 3; i++) {
      await main.tool('exec', 'shell', `$ cargo test cache_key ${i ? '-- --test-threads=1' : ''}`.trim(), { ms: 1700, ok: false, output: 'assertion failed: left == right\n  left: "C:\\\\tmp\\\\a"\n right: "C:/tmp/a"' })
      await main.think(900)
    }
    if (round % 3 === 2) {
      main.send({ kind: 'turn.ended', outcome: 'aborted' })
      await clock.sleep(8000)
      continue
    }
    await main.tool('exec', 'read', 'View src/paths.rs', { files: read(`${root}/src/paths.rs`), ms: 700 })
    await main.tool('apply_patch', 'edit', 'Patch src/paths.rs +1', { files: [...edit(`${root}/src/paths.rs`), ...edit(`${root}/.github/workflows/ci.yml`)], ms: 1200, changes: patchChanges(PATHS_FIX) })
    await main.tool('exec', 'shell', '$ cargo test', { ms: 3000, output: 'test result: ok. 87 passed' })
    await main.say('Cache keys used the platform separator, so Windows produced different keys. They are now joined with `/` on every platform; 87 tests pass.')
    main.send({ kind: 'turn.ended', outcome: 'completed' })
    await clock.sleep(11_000)
  }
}

/** Claude Code fanning out three explorers on a nearly full context window. */
async function themeSession(emit: Emit, clock: Clock): Promise<void> {
  const sessionId = uid('demo-claude')
  const root = '/home/dev/lumen-docs'
  const main = new Actor(emit, clock, 'claude-code', sessionId, sessionId, 'claude-opus-demo', [171_000, 182_000])
  await clock.sleep(3000)
  main.send({ kind: 'session.started', meta: { cwd: root, project: 'lumen-docs', gitBranch: 'feat/dark-mode', entrypoint: 'cli', model: 'claude-opus-demo', demo: true, title: 'Docs site dark mode', titleSource: 'custom' } })
  for (let round = 0; !clock.stopped; round++) {
    main.send({ kind: 'turn.started', turnId: uid('turn') })
    main.send({ kind: 'message', role: 'user', text: 'Add a dark mode toggle to the docs site that follows the system setting.' })
    await clock.sleep(500)
    await main.think(1200)
    const scouts = [
      { name: 'Theme tokens', steps: [['Glob', 'search', 'Glob src/styles/**/*.css'], ['Read', 'read', 'Read src/styles/tokens.css'], ['Read', 'read', 'Read src/styles/base.css']] },
      { name: 'Hard-coded colours', steps: [['Grep', 'search', 'Grep "#[0-9a-f]{6}" in src/components'], ['Read', 'read', 'Read src/components/Callout.tsx'], ['Read', 'read', 'Read src/components/CodeBlock.tsx']] },
      { name: 'Component tests', steps: [['Glob', 'search', 'Glob test/**/*.test.tsx'], ['Read', 'read', 'Read test/Header.test.tsx']] },
    ] as const
    await Promise.all(scouts.map(async (sc) => {
      const call = main.start('Agent', 'agent', `Explore: ${sc.name}`, [], { subagent_type: 'Explore' })
      const sub = main.child(uid('agent'))
      sub.send({ kind: 'agent.spawned', parentToolCallId: call, name: sc.name, role: 'Explore', task: sc.name })
      for (const [tool, cat, title] of sc.steps) {
        const file = title.startsWith('Read ') ? read(`${root}/${title.slice(5)}`) : []
        await sub.tool(tool, cat, title, { files: file, ms: 900 + Math.random() * 1200 })
      }
      await sub.say(`${sc.name}: done.`)
      sub.send({ kind: 'turn.ended', outcome: 'completed' })
      main.finish(call, true, 'done')
    }))
    await main.tool('TodoWrite', 'plan', 'Todos 0/3 · Tokens for dark', { ms: 300 })
    await main.tool('Edit', 'edit', 'Edit src/styles/tokens.css', { files: edit(`${root}/src/styles/tokens.css`), ms: 900, changes: claudeChanges('Edit', { file_path: `${root}/src/styles/tokens.css`, old_string: ":root {\n  --bg: #ffffff;\n  --fg: #1f2328;\n  --accent: #0969da;\n}", new_string: ":root {\n  --bg: #ffffff;\n  --fg: #1f2328;\n  --accent: #0969da;\n}\n\n:root[data-theme='dark'] {\n  --bg: #0d1117;\n  --fg: #e6edf3;\n  --accent: #4493f8;\n}" }) })
    await main.tool('Write', 'write', 'Write src/components/ThemeToggle.tsx', { files: write(`${root}/src/components/ThemeToggle.tsx`), ms: 1300, changes: claudeChanges('Write', { file_path: `${root}/src/components/ThemeToggle.tsx`, content: THEME_TOGGLE }) })
    await main.tool('Edit', 'edit', 'Edit src/components/Callout.tsx', { files: edit(`${root}/src/components/Callout.tsx`), ms: 700, changes: claudeChanges('Edit', { file_path: `${root}/src/components/Callout.tsx`, old_string: "  background: '#fff8c5',\n  color: '#1f2328',", new_string: "  background: 'var(--callout-bg)',\n  color: 'var(--fg)'," }) })
    await main.tool('TodoWrite', 'plan', 'Todos 2/3 · Verify', { ms: 300 })
    await main.tool('Bash', 'shell', '$ npm run build', { ms: 4200, output: 'built 214 pages in 3.8s' })
    await main.tool('Bash', 'shell', '$ npm test', { ms: 2400, output: '48 passing' })
    await main.say('Dark mode follows the system by default, with a toggle in the header. Colours come from tokens, so the callouts and code blocks switch too.')
    main.send({ kind: 'turn.ended', outcome: 'completed' })
    await clock.sleep(8000)
  }
}

export class DemoSource implements Source {
  readonly name = 'demo'
  private clock: Clock

  constructor(opts: { speed?: number } = {}) {
    this.clock = new Clock(opts.speed ?? 1)
  }

  async start(emit: Emit): Promise<void> {
    void claudeSession(emit, this.clock)
    void codexSession(emit, this.clock)
    void loginSession(emit, this.clock)
    void flakySession(emit, this.clock)
    void themeSession(emit, this.clock)
  }

  stop(): void {
    this.clock.stopped = true
  }

  describe(): Record<string, unknown> {
    return { simulated: true }
  }
}
