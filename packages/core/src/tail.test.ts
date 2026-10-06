import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { FileTail } from './tail.js'

const tmp = () => join(mkdtempSync(join(tmpdir(), 'oadt-tail-')), 'log.jsonl')

test('reads complete lines and carries partial lines over', async () => {
  const file = tmp()
  writeFileSync(file, '{"a":1}\n{"b":')
  const tail = new FileTail(file)
  const first = await tail.init(1024)
  assert.deepEqual(first.lines, ['{"a":1}'])
  appendFileSync(file, '2}\n{"c":3}\r\n')
  assert.deepEqual(await tail.read(), ['{"b":2}', '{"c":3}'])
  assert.deepEqual(await tail.read(), [])
})

test('never splits multi-byte characters across reads', async () => {
  const file = tmp()
  const text = '{"t":"héllo 🌍 wörld"}'
  const bytes = Buffer.from(text + '\n')
  // Write the line in two halves, splitting inside the emoji.
  const cut = bytes.indexOf(Buffer.from('🌍')) + 2
  writeFileSync(file, bytes.subarray(0, cut))
  const tail = new FileTail(file)
  assert.deepEqual((await tail.init(1024)).lines, [])
  appendFileSync(file, bytes.subarray(cut))
  assert.deepEqual(await tail.read(), [text])
})

test('starts over when the file is truncated', async () => {
  const file = tmp()
  writeFileSync(file, '{"old":1}\n{"old":2}\n')
  const tail = new FileTail(file)
  await tail.init(1024)
  writeFileSync(file, '{"new":1}\n')
  assert.deepEqual(await tail.read(), ['{"new":1}'])
})

test('large files yield the head plus a bounded tail', async () => {
  const file = tmp()
  const lines = Array.from({ length: 5000 }, (_, i) => JSON.stringify({ i, pad: 'x'.repeat(40) }))
  writeFileSync(file, lines.join('\n') + '\n')
  const tail = new FileTail(file)
  const init = await tail.init(20_000, 2_000)
  assert.equal(init.partial, true)
  assert.equal(JSON.parse(init.lines[0]!).i, 0, 'head is preserved')
  assert.equal(JSON.parse(init.lines[init.lines.length - 1]!).i, 4999, 'tail reaches the end')
  assert.ok(init.lines.length < 600, 'middle is skipped')
  for (const l of init.lines) JSON.parse(l) // no torn lines
})
