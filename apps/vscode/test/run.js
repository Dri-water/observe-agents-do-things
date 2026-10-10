// Downloads VS Code, loads the extension from this folder and runs test/suite.js inside it.
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { runTests } = require('@vscode/test-electron')

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oadt-vscode-'))
  const user = path.join(home, 'user')
  fs.mkdirSync(path.join(user, 'User'), { recursive: true })
  // A port nothing answers on, so the extension has to run its own observer.
  fs.writeFileSync(path.join(user, 'User', 'settings.json'), JSON.stringify({ 'observeAgents.serverUrl': 'http://127.0.0.1:4599' }))
  try {
    await runTests({
      extensionDevelopmentPath: path.resolve(__dirname, '..'),
      extensionTestsPath: path.resolve(__dirname, 'suite.js'),
      launchArgs: ['--disable-extensions', `--user-data-dir=${user}`, home],
    })
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
