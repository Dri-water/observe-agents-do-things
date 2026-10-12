// Cut a release: bump the version everywhere it is published, commit, tag and push.
// The Release workflow (.github/workflows/release.yml) then publishes everything.
//
//   npm run release -- patch      0.1.0 → 0.1.1
//   npm run release -- minor      0.1.0 → 0.2.0
//   npm run release -- 1.0.0      an exact version
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const read = (path) => readFileSync(root + path, 'utf8')
const write = (path, text) => writeFileSync(root + path, text)

/** Every file that carries the published version. */
const MANIFESTS = ['package.json', 'packages/cli/package.json', 'apps/vscode/package.json']
const VERSION_CONSTANT = 'packages/server/src/server.ts'

const bump = process.argv[2]
if (!bump) fail('Say how to bump: patch, minor, major or an exact version like 1.2.3.')
if (git('status', '--porcelain')) fail('Commit or stash your changes first.')
if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') fail('Release from main.')

const current = JSON.parse(read('apps/vscode/package.json')).version
const next = nextVersion(current, bump)
if (git('tag', '--list', `v${next}`)) fail(`v${next} is already tagged.`)

for (const path of MANIFESTS) write(path, read(path).replace(/("version":\s*")[^"]+(")/, `$1${next}$2`))
write(VERSION_CONSTANT, read(VERSION_CONSTANT).replace(/export const VERSION = '[^']+'/, `export const VERSION = '${next}'`))

// The extension's changelog gets the commit subjects since the last release.
const last = git('describe', '--tags', '--abbrev=0', '--match', 'v*')
const subjects = git('log', `${last}..HEAD`, '--no-merges', '--format=- %s').split('\n').filter(Boolean)
const changelog = read('apps/vscode/CHANGELOG.md')
write('apps/vscode/CHANGELOG.md', changelog.replace('# Changelog\n', `# Changelog\n\n## ${next}\n\n${subjects.join('\n') || '- Maintenance.'}\n`))

execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
git('add', ...MANIFESTS, VERSION_CONSTANT, 'apps/vscode/CHANGELOG.md', 'package-lock.json')
git('commit', '-m', `Release v${next}`)
git('tag', '-a', `v${next}`, '-m', `v${next}`)
git('push', '--follow-tags')
console.log(`v${next} pushed. The Release workflow publishes it: https://github.com/Dri-water/observe-agents-do-things/actions/workflows/release.yml`)

function nextVersion(version, how) {
  if (/^\d+\.\d+\.\d+$/.test(how)) return how
  const [major, minor, patch] = version.split('.').map(Number)
  if (how === 'major') return `${major + 1}.0.0`
  if (how === 'minor') return `${major}.${minor + 1}.0`
  if (how === 'patch') return `${major}.${minor}.${patch + 1}`
  fail(`Unknown bump "${how}".`)
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
