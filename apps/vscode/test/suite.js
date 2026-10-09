// Runs inside VS Code: the extension starts an observer and opens the dashboard tab.
const assert = require('node:assert/strict')
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

  const info = await waitFor(async () => {
    const res = await fetch('http://127.0.0.1:4599/api/info')
    return res.ok ? res.json() : undefined
  })
  assert.equal(info.protocol, 1, 'an embedded observer answers on the configured address')

  const ui = await fetch('http://127.0.0.1:4599/')
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
  if (process.env.OADT_HOLD_MS) await new Promise((r) => setTimeout(r, Number(process.env.OADT_HOLD_MS)))
}
