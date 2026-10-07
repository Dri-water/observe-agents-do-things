/**
 * A scripted, endlessly looping simulation of two coding sessions — one Claude
 * Code, one Codex — with subagents, failing tests, permission waits and fixes.
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
    const ctx = 20_000 + Math.random() * 60_000
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

export class DemoSource implements Source {
  readonly name = 'demo'
  private clock: Clock

  constructor(opts: { speed?: number } = {}) {
    this.clock = new Clock(opts.speed ?? 1)
  }

  async start(emit: Emit): Promise<void> {
    void claudeSession(emit, this.clock)
    void codexSession(emit, this.clock)
  }

  stop(): void {
    this.clock.stopped = true
  }

  describe(): Record<string, unknown> {
    return { simulated: true }
  }
}
