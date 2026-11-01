import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { bundle } from '../dist/adapter.mjs'
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url)))
assert.equal(bundle.version, manifest.version)
assert.equal(bundle.apiVersion, 1)
assert.equal(bundle.relayContract, 1)
assert.equal(manifest.name, '@cordisx/codex-adapter')
assert.equal(manifest.dependencies, undefined)
assert.equal(manifest.optionalDependencies, undefined)
assert.equal(manifest.bin, undefined)
for (const name of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(manifest.scripts[name], undefined)
const [{ files }] = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    encoding: 'utf8',
    cwd: new URL('..', import.meta.url),
  }),
)
assert(files.some(f => f.path === 'dist/adapter.mjs'))
assert(files.some(f => f.path === 'src/index.ts'))
assert(files.some(f => f.path === 'tests/checks.mjs'))
assert(
  files.every(f =>
    /^(?:dist\/|src\/|tests\/|package\.json$|README\.md$|LICENSE$|THIRD_PARTY_NOTICES\.md$)/u.test(f.path)
  ),
)
assert(!files.some(f => /app\.asar|app-(?:initial|primary|shared)-|transformed|\.log$|\.tgz$/u.test(f.path)))
console.log(`Adapter ${bundle.version}: ${files.length} owned source, runtime, license and synthetic test entries`)
