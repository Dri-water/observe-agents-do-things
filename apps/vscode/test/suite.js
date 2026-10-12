// Runs inside VS Code: the extension starts an observer and opens the dashboard tab.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vscode = require('vscode')

async function waitFor(check, ms = 15000) {
  const end = Date.now() + ms
  for (;;) {
    const value = await check().catch(() => undefined)
    if (value) return value
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 250))
  }
}

exports.run = async function run() {
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'observe-agents-do-things')
  assert.ok(ext, 'extension is installed')
  await ext.activate()

  // VS Code's own observer runs on a free port and is announced to other windows through a file.
  const url = await waitFor(async () => JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'oadt-vscode-observer.json'), 'utf8')).url)
  const info = await (await fetch(`${url}/api/info`)).json()
  assert.equal(info.protocol, 1, 'the observer VS Code started answers')
  assert.notEqual(new URL(url).port, '4599', 'it leaves the configured address free for the CLI or Docker')
  await assert.rejects(fetch('http://127.0.0.1:4599/api/info'), 'nothing squats on the configured address')

  const ui = await fetch(`${url}/`)
  assert.equal(ui.status, 200, 'the embedded observer serves the dashboard')
  assert.match(await ui.text(), /<div id="viz-root">/)

  await vscode.commands.executeCommand('observeAgents.open')
  const tab = await waitFor(async () => vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .find((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith('observeAgents')))
  assert.equal(tab.label, 'Agents', 'the dashboard opens in an editor tab')
  await vscode.commands.executeCommand('observeAgents.showSidebar')
  await vscode.commands.executeCommand('observeAgents.showPanel')
  console.log('vscode extension: observer started, dashboard tab open')

  // An older observer appearing on the configured address must not take over: its dashboard is out of date.
  const http = require('node:http')
  let streamed = 0
  const old = http.createServer((req, res) => {
    if (req.url.startsWith('/api/stream')) streamed++
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ protocol: 1, version: '0.0.1', seq: 0, sources: [] }))
  })
  await new Promise((r) => old.listen(4599, '127.0.0.1', r))
  try {
    // Longer than the extension's recheck interval, so it has looked at least once.
    await new Promise((r) => setTimeout(r, 12_500))
    assert.equal(streamed, 0, 'it does not connect to an observer older than itself')
    const still = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'oadt-vscode-observer.json'), 'utf8')).url
    assert.equal(still, url, 'it keeps its own up-to-date observer')
    console.log('vscode extension: skips an older observer on the configured address')
  } finally {
    old.close()
  }
  if (process.env.OADT_HOLD_MS) await new Promise((r) => setTimeout(r, Number(process.env.OADT_HOLD_MS)))
}
