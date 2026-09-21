import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

describe('release scripts under native Node ESM', () => {
  const cwd = fileURLToPath(new URL('..', import.meta.url))

  it('links release modules without the Vitest module transformer', () => {
    const result = spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      `
      import assert from 'node:assert/strict'
      import { publishReleasePackages } from './scripts/release-publication.mjs'
      import { releaseRecoveryStages } from './scripts/release-recovery-state.mjs'
      import { RELEASE_PHASES } from './scripts/release-manifest.mjs'
      assert.equal(typeof publishReleasePackages, 'function')
      assert.deepEqual(RELEASE_PHASES, ['PUBLISHED', 'VISIBLE', 'VERIFIED', 'DISTRIBUTED'])
      assert.deepEqual(releaseRecoveryStages('VERIFIED'), ['VERIFIED', 'DISTRIBUTED'])
    `,
    ], { cwd, encoding: 'utf8', timeout: 10_000 })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
  })

  for (const script of ['release.mjs', 'check-registry-release.mjs']) {
    it(`${script} reaches argument validation in Node`, () => {
      // An invalid tag stops before any registry, package or publication operation.
      const result = spawnSync(process.execPath, [`scripts/${script}`, '--tag', 'invalid'], {
        cwd,
        encoding: 'utf8',
        timeout: 10_000,
      })
      assert.ifError(result.error)
      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, /release tag must be v<semver> without build metadata/)
      assert.doesNotMatch(result.stderr, /does not provide an export/)
    })
  }

  it('release-manifest.mjs reaches argument validation in Node', () => {
    const result = spawnSync(process.execPath, ['scripts/release-manifest.mjs'], {
      cwd,
      encoding: 'utf8',
      timeout: 10_000,
    })
    assert.ifError(result.error)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /usage: release-manifest\.mjs/)
  })
})
