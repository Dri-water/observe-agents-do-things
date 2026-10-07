import assert from 'node:assert/strict'
import { test } from 'node:test'
import { claudeChanges, lineDiff, patchChanges } from './diff.js'

test('lineDiff keeps shared lines and marks changes', () => {
  const ops = lineDiff(['a', 'b', 'c', 'd'], ['a', 'B', 'c', 'd', 'e'])
  assert.deepEqual(ops, [[' ', 'a'], ['-', 'b'], ['+', 'B'], [' ', 'c'], [' ', 'd'], ['+', 'e']])
})

test('Edit produces a hunk with context and counts', () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
  const after = before.replace('line 10', 'line ten')
  const [c] = claudeChanges('Edit', { file_path: '/p/a.ts', old_string: before, new_string: after })!
  assert.equal(c!.op, 'edit')
  assert.equal(c!.added, 1)
  assert.equal(c!.removed, 1)
  assert.deepEqual(c!.lines, [' line 7', ' line 8', ' line 9', '-line 10', '+line ten', ' line 11', ' line 12', ' line 13'])
})

test('MultiEdit joins hunks with gap markers; Write is all additions', () => {
  const [m] = claudeChanges('MultiEdit', { file_path: 'x', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] })!
  assert.deepEqual(m!.lines, ['-a', '+b', '@', '-c', '+d'])
  const [w] = claudeChanges('Write', { file_path: 'x', content: 'one\ntwo' })!
  assert.equal(w!.op, 'write')
  assert.deepEqual(w!.lines, ['+one', '+two'])
  assert.equal(claudeChanges('Read', { file_path: 'x' }), undefined)
})

test('long changes are truncated and flagged', () => {
  const [w] = claudeChanges('Write', { file_path: 'x', content: Array.from({ length: 1000 }, (_, i) => `l${i}`).join('\n') })!
  assert.equal(w!.lines.length, 400)
  assert.equal(w!.added, 1000)
  assert.equal(w!.truncated, true)
})

test('apply_patch bodies, including ones embedded in exec scripts', () => {
  const patch = '*** Begin Patch\n*** Update File: src/a.rs\n@@ fn main\n-let x = 1;\n+let x = 2;\n context\n*** Add File: src/b.rs\n+pub fn b() {}\n*** Delete File: old.rs\n*** End Patch'
  const changes = patchChanges(patch)!
  assert.deepEqual(changes.map((c) => [c.path, c.op, c.added, c.removed]), [['src/a.rs', 'edit', 1, 1], ['src/b.rs', 'write', 1, 0], ['old.rs', 'delete', 0, 0]])
  const embedded = patchChanges(`await tools.apply_patch({input: "${patch.replace(/\n/g, '\\n')}"})`)!
  assert.equal(embedded.length, 3)
  assert.deepEqual(embedded[0]!.lines, ['-let x = 1;', '+let x = 2;', ' context'])
  assert.equal(patchChanges('no patch here'), undefined)
})
