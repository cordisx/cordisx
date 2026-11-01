import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export function adapterReleaseFromTag(tag) {
  const match = /^codex-adapter-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-beta\.(?:0|[1-9]\d*))?)$/u.exec(tag)
  if (!match) throw new Error('Expected codex-adapter-v<major.minor.patch[-beta.N]>')
  return { version: match[1], distTag: match[1].includes('-') ? 'beta' : 'latest' }
}
export function validateNativeAdapterEvidence(value, { sourceCommit, version, integrity }) {
  assert.equal(value.schema, 1, 'native evidence schema')
  assert.equal(value.sourceCommit, sourceCommit, 'native evidence must name the exact release commit')
  assert.equal(value.adapterVersion, version, 'native evidence version')
  assert.equal(value.integrity, integrity, 'native evidence must name the exact adapter artifact')
  assert(Array.isArray(value.clients) && value.clients.length > 0, 'native evidence needs tested client builds')
  for (const client of value.clients) {
    assert(typeof client.version === 'string' && client.version.length > 0)
    assert(typeof client.build === 'string' && client.build.length > 0)
  }
  for (
    const check of [
      'model-menu',
      'first-turn-send',
      'existing-thread-send',
      'account-reader',
      'task-creation',
      'owned-cleanup',
    ]
  ) {
    assert.equal(value.checks?.[check], 'passed', `native gate missing: ${check}`)
  }
  // Evidence is a maintainer-reviewed summary, never an uploaded native resource/log bundle.
  assert.deepEqual(
    Object.keys(value).sort(),
    ['adapterVersion', 'checks', 'clients', 'integrity', 'schema', 'sourceCommit'].sort(),
  )
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [tag, archive, evidence] = process.argv.slice(2)
  const release = adapterReleaseFromTag(tag)
  const manifest = JSON.parse(await readFile(new URL('../packages/codex-adapter/package.json', import.meta.url)))
  assert.equal(manifest.name, '@cordisx/codex-adapter')
  assert.equal(manifest.version, release.version)
  if (archive || evidence) {
    assert(archive && evidence, 'provide both archive and native evidence')
    const integrity = `sha512-${createHash('sha512').update(await readFile(archive)).digest('base64')}`
    validateNativeAdapterEvidence(JSON.parse(await readFile(evidence, 'utf8')), {
      sourceCommit: process.env.GITHUB_SHA,
      version: release.version,
      integrity,
    })
  }
  console.log(JSON.stringify(release))
}
