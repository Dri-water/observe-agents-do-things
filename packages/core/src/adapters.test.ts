/**
 * Adapter tests against small synthetic transcripts that mirror the real
 * on-disk shapes. No real user data lives in this repository.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyEvent, createWorld, type EventDraft, type ObserverEvent } from '@oadt/protocol'
import { ClaudeTranscriptParser } from './adapters/claude-code.js'
import { CodexRolloutParser } from './adapters/codex.js'
import { Observer } from './observer.js'
import { describeCodexExec, codexOutputOk, patchFiles } from './tools.js'
import { humanText } from './text.js'

const SID = '11111111-2222-3333-4444-555555555555'
const t = (s: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, s)).toISOString()

function claudeLines(): object[] {
  const base = { sessionId: SID, cwd: '/work/app', gitBranch: 'main', version: '2.1.0', entrypoint: 'cli', isSidechain: false }
  return [
    { type: 'custom-title', customTitle: 'Fix the flaky test', sessionId: SID },
    { ...base, type: 'user', uuid: 'u1', promptId: 'p1', timestamp: t(0), message: { role: 'user', content: '<system-reminder>ignore me</system-reminder>' } },
    { ...base, type: 'user', uuid: 'u2', promptId: 'p1', timestamp: t(1), message: { role: 'user', content: 'Why does test/api.test.ts fail on CI?' } },
    { ...base, type: 'assistant', uuid: 'a1', timestamp: t(2), message: { id: 'msg_1', model: 'claude-test', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: 'Look at the test first.' }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } },
    // Same message id, later block: usage grows → only the delta is counted.
    { ...base, type: 'assistant', uuid: 'a2', timestamp: t(3), message: { id: 'msg_1', model: 'claude-test', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: '/work/app/test/api.test.ts' } }], usage: { input_tokens: 10, output_tokens: 25, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } },
    { ...base, type: 'user', uuid: 'u3', timestamp: t(4), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content: 'file contents' }] }, toolUseResult: { durationMs: 12 } },
    { ...base, type: 'assistant', uuid: 'a3', timestamp: t(5), message: { id: 'msg_2', model: 'claude-test', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'npm test -- api\nexit 0', description: 'run tests' } }], usage: { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 1100, cache_creation_input_tokens: 50 } } },
    { ...base, type: 'user', uuid: 'u4', timestamp: t(9), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bash', content: '1 failing', is_error: true }] } },
    { ...base, type: 'assistant', uuid: 'a4', timestamp: t(10), message: { id: 'msg_3', model: 'claude-test', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_task', name: 'Agent', input: { description: 'Find timing assumptions', subagent_type: 'Explore', prompt: '...' } }], usage: { input_tokens: 1, output_tokens: 3, cache_read_input_tokens: 1200, cache_creation_input_tokens: 0 } } },
    { ...base, type: 'user', uuid: 'u5', timestamp: t(20), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_task', content: [{ type: 'text', text: 'Found a sleep(10)' }] }] } },
    { ...base, type: 'assistant', uuid: 'a5', timestamp: t(21), message: { id: 'msg_4', model: 'claude-test', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'The test sleeps for 10 ms; CI is slower.' }], usage: { input_tokens: 1, output_tokens: 30, cache_read_input_tokens: 1300, cache_creation_input_tokens: 0 } } },
    { ...base, type: 'assistant', uuid: 'a5', timestamp: t(21), message: { id: 'msg_4', role: 'assistant', content: [{ type: 'text', text: 'duplicate replay' }] } },
    { type: 'cost-state', sessionId: SID, totalCostUSD: 0.42, totalLinesAdded: 3, totalLinesRemoved: 1 },
    { type: 'pr-link', sessionId: SID, prUrl: 'https://github.com/o/r/pull/7', timestamp: t(22) },
    { ...base, type: 'user', uuid: 'u6', timestamp: t(30), message: { role: 'user', content: '<command-name>/review</command-name><command-args>now</command-args>' } },
    { ...base, type: 'user', uuid: 'u7', timestamp: t(31), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
  ]
}

function subagentLines(): object[] {
  return [
    { sessionId: SID, agentId: 'abc123', isSidechain: true, type: 'user', uuid: 's1', timestamp: t(11), cwd: '/work/app', message: { role: 'user', content: 'Find timing assumptions in test/' } },
    { sessionId: SID, agentId: 'abc123', isSidechain: true, type: 'assistant', uuid: 's2', timestamp: t(12), cwd: '/work/app', message: { id: 'm', model: 'claude-fast', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_grep', name: 'Grep', input: { pattern: 'sleep\\(', path: '/work/app/test' } }] } },
    { sessionId: SID, agentId: 'abc123', isSidechain: true, type: 'user', uuid: 's3', timestamp: t(13), cwd: '/work/app', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_grep', content: 'test/api.test.ts:4' }] } },
    { sessionId: SID, agentId: 'abc123', isSidechain: true, type: 'assistant', uuid: 's4', timestamp: t(19), cwd: '/work/app', message: { id: 'm2', model: 'claude-fast', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Found a sleep(10)' }] } },
  ]
}

function collect(parser: { line(raw: string): void }, lines: object[]): void {
  for (const l of lines) parser.line(JSON.stringify(l))
}

test('claude: normalises a main transcript', () => {
  const drafts: EventDraft[] = []
  const p = new ClaudeTranscriptParser(`/x/projects/-work-app/${SID}.jsonl`, (d) => drafts.push(d))
  collect(p, claudeLines())
  const kinds = drafts.map((d) => d.kind)
  assert.equal(kinds.filter((k) => k === 'session.started').length, 1)
  const started = drafts.find((d) => d.kind === 'session.started')!
  assert.equal(started.kind === 'session.started' && started.meta.project, 'app')

  const msgs = drafts.filter((d) => d.kind === 'message').map((d) => d.kind === 'message' && d.text)
  assert.deepEqual(msgs, ['Why does test/api.test.ts fail on CI?', 'The test sleeps for 10 ms; CI is slower.', '/review now'])

  const tools = drafts.filter((d) => d.kind === 'tool.started')
  assert.deepEqual(tools.map((d) => d.kind === 'tool.started' && [d.category, d.title]), [
    ['read', 'Read test/api.test.ts'],
    ['shell', '$ npm test -- api …'],
    ['agent', 'Explore: Find timing assumptions'],
  ])
  const finished = drafts.filter((d) => d.kind === 'tool.finished').map((d) => d.kind === 'tool.finished' && d.ok)
  assert.deepEqual(finished, [true, false, true])

  const usage = drafts.filter((d) => d.kind === 'usage')
  const out = usage.reduce((n, d) => n + (d.kind === 'usage' ? d.delta.output : 0), 0)
  assert.equal(out, 25 + 7 + 3 + 30, 'streamed records of one message are not double counted')

  assert.ok(drafts.some((d) => d.kind === 'turn.ended' && d.outcome === 'completed'))
  assert.ok(drafts.some((d) => d.kind === 'turn.ended' && d.outcome === 'aborted'))
  const metas = drafts.filter((d) => d.kind === 'session.updated').map((d) => d.kind === 'session.updated' && d.meta)
  assert.ok(metas.some((m) => m && m.title === 'Fix the flaky test' && m.titleSource === 'custom'))
  assert.ok(metas.some((m) => m && m.costUsd === 0.42))
  assert.ok(metas.some((m) => m && m.prUrl === 'https://github.com/o/r/pull/7'))
})

test('claude: subagent files link to the spawning call through meta.json', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oadt-claude-'))
  const project = join(root, 'projects', '-work-app')
  const subDir = join(project, SID, 'subagents')
  mkdirSync(subDir, { recursive: true })
  writeFileSync(join(project, `${SID}.jsonl`), claudeLines().map((l) => JSON.stringify(l)).join('\n') + '\n')
  writeFileSync(join(subDir, 'agent-abc123.jsonl'), subagentLines().map((l) => JSON.stringify(l)).join('\n') + '\n')
  writeFileSync(join(subDir, 'agent-abc123.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Find timing assumptions', toolUseId: 'toolu_task' }))

  const obs = new Observer({ harnesses: ['claude-code'], claudeDir: root, sinceMs: 1e12 })
  await obs.start()
  obs.stop()
  const s = obs.world.sessions[SID]!
  assert.ok(s, 'session discovered')
  const sub = s.agents.abc123!
  assert.equal(sub.parentId, SID)
  assert.equal(sub.role, 'Explore')
  assert.equal(sub.status, 'done')
  assert.equal(s.tools.toolu_task!.childAgentId, 'abc123')
  assert.equal(sub.toolCount, 1)
  assert.equal(s.meta.title, 'Fix the flaky test')
  assert.equal(s.status, 'idle')
})

const ROOT = '019a0000-0000-7000-8000-000000000001'
const CHILD = '019a0000-0000-7000-8000-000000000002'

function codexRoot(): object[] {
  return [
    { timestamp: t(0), type: 'session_meta', payload: { id: ROOT, session_id: ROOT, cwd: '/work/svc', cli_version: '0.9.0', originator: 'codex_cli', source: 'cli', git: { branch: 'feat/x' } } },
    { timestamp: t(1), type: 'turn_context', payload: { model: 'gpt-test', cwd: '/work/svc' } },
    { timestamp: t(1), type: 'event_msg', payload: { type: 'task_started', turn_id: 'T1' } },
    { timestamp: t(1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } },
    { timestamp: t(2), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Speed up the importer' }] } },
    { timestamp: t(3), type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Profile first' }], encrypted_content: 'zzz' } },
    { timestamp: t(4), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'cargo test' }), call_id: 'call_1' } },
    { timestamp: t(6), type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: 'Process exited with code 101\nerror: test failed' } },
    { timestamp: t(7), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call_2', status: 'completed', input: 'const r = await tools.apply_patch({input: `*** Begin Patch\n*** Update File: src/import.rs\n@@\n-a\n+b\n*** Add File: src/cache.rs\n+x\n*** End Patch`})' } },
    { timestamp: t(8), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_2', output: [{ type: 'input_text', text: 'Script completed\nWall time: 0.2s' }] } },
    { timestamp: t(9), type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', namespace: 'multi_agent', arguments: JSON.stringify({ task_name: 'bench', message: 'run benches' }), call_id: 'call_3' } },
    { timestamp: t(9), type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_3', output: '{"accepted":true}' } },
    { timestamp: t(10), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50, reasoning_output_tokens: 10 }, last_token_usage: { input_tokens: 1000 }, model_context_window: 200000 } } },
    { timestamp: t(30), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1500, cached_input_tokens: 1200, output_tokens: 90, reasoning_output_tokens: 20 }, last_token_usage: { input_tokens: 500 }, model_context_window: 200000 } } },
    { timestamp: t(31), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Importer is 3x faster.' }] } },
    { timestamp: t(31), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'T1', duration_ms: 30000 } },
    { timestamp: t(32), type: 'event_msg', payload: { type: 'thread_goal_updated', goal: { objective: 'Importer under 1s', status: 'active' } } },
  ]
}

function codexChild(): object[] {
  return [
    { timestamp: t(9), type: 'session_meta', payload: { id: CHILD, session_id: ROOT, cwd: '/work/svc', source: { subagent: { thread_spawn: { parent_thread_id: ROOT, depth: 1, agent_path: '/root/bench', agent_nickname: 'Bench', agent_role: 'worker' } } } } },
    { timestamp: t(10), type: 'event_msg', payload: { type: 'task_started', turn_id: 'C1' } },
    { timestamp: t(11), type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'cargo bench'] }), call_id: 'c_1' } },
    { timestamp: t(25), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c_1', output: JSON.stringify({ output: 'bench ok', metadata: { exit_code: 0 } }) } },
    { timestamp: t(26), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'C1' } },
  ]
}

test('codex: normalises rollouts and rebuilds the agent tree across threads', () => {
  const drafts: EventDraft[] = []
  collect(new CodexRolloutParser(`/c/sessions/2026/01/01/rollout-2026-01-01T12-00-00-${ROOT}.jsonl`, (d) => drafts.push(d)), codexRoot())
  collect(new CodexRolloutParser(`/c/sessions/2026/01/01/rollout-2026-01-01T12-00-09-${CHILD}.jsonl`, (d) => drafts.push(d)), codexChild())
  const w = createWorld()
  let seq = 0
  for (const d of drafts) applyEvent(w, { ...d, seq: ++seq } as ObserverEvent)
  const s = w.sessions[ROOT]!
  assert.equal(s.meta.gitBranch, 'feat/x')
  assert.equal(s.meta.model, 'gpt-test')
  assert.equal(s.meta.title, 'Speed up the importer')
  assert.equal(s.meta.goal, 'Importer under 1s')
  assert.equal(s.contextWindow, 200000)
  assert.equal(s.contextTokens, 500)
  assert.equal(s.usage.cacheRead, 1200)
  assert.equal(s.usage.input, 300, 'input excludes cached tokens')
  assert.equal(s.counts.toolErrors, 1, 'non-zero exit code is a failure')
  const patch = Object.values(s.tools).find((x) => x.category === 'edit')!
  assert.equal(patch.title, 'Patch src/import.rs +1')
  assert.deepEqual(patch.files.map((f) => f.op), ['edit', 'write'])
  const child = s.agents[CHILD]!
  assert.equal(child.parentId, ROOT)
  assert.equal(child.name, 'Bench')
  assert.equal(child.role, 'worker')
  assert.equal(child.status, 'done')
  assert.equal(child.toolCount, 1)
  assert.equal(s.tools.c_1!.title, '$ cargo bench')
  assert.equal(s.tools.c_1!.ok, true)
  assert.equal(s.status, 'idle')
})

test('tool helpers', () => {
  assert.equal(codexOutputOk('Script completed\n{"exit_code": 0}'), true)
  assert.equal(codexOutputOk('Script completed\n{"exit_code": 0} {"exit_code": 2}'), false)
  assert.equal(codexOutputOk('Script failed\nboom'), false)
  assert.equal(codexOutputOk('Exit code: 0\nWall time: 1s'), true)
  assert.deepEqual(patchFiles('*** Delete File: a.txt').map((f) => f.op), ['delete'])
  const d = describeCodexExec('await Promise.all([tools.exec_command({cmd:"rg -n foo src"}), tools.exec_command({cmd:"ls"})])')
  assert.equal(d.category, 'shell')
  assert.equal(d.title, '$ rg -n foo src  (+1 more)')
  assert.equal(humanText('# Context from my IDE setup:\n...\n## My request for Codex:\nAdd tests'), 'Add tests')
  assert.equal(humanText('<environment_context>x</environment_context>'), null)
})
