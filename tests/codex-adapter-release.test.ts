import { describe, expect, it } from 'vitest'
import { adapterReleaseFromTag, validateNativeAdapterEvidence } from '../scripts/adapter-release.mjs'
describe('independent adapter release gates', () => {
  it('separates adapter tags/channels from Host and Creator releases', () => {
    expect(adapterReleaseFromTag('codex-adapter-v1.2.3-beta.4')).toEqual({ version: '1.2.3-beta.4', distTag: 'beta' })
    expect(adapterReleaseFromTag('codex-adapter-v1.2.3')).toEqual({ version: '1.2.3', distTag: 'latest' })
    expect(() => adapterReleaseFromTag('v0.1.0-beta.38')).toThrow('codex-adapter')
  })
  it('requires exact-source/artifact native evidence with every initial native seam and cleanup', () => {
    const expected = { sourceCommit: 'a'.repeat(40), version: '0.1.0-beta.1', integrity: 'sha512-test' }
    const checks = Object.fromEntries(
      ['model-menu', 'first-turn-send', 'existing-thread-send', 'account-reader', 'task-creation', 'owned-cleanup'].map(
        k => [k, 'passed'],
      ),
    )
    const evidence = {
      schema: 1,
      sourceCommit: expected.sourceCommit,
      adapterVersion: expected.version,
      integrity: expected.integrity,
      clients: [{ version: 'future', build: 'unbounded' }],
      checks,
    }
    expect(() => validateNativeAdapterEvidence(evidence, expected)).not.toThrow()
    expect(() => validateNativeAdapterEvidence({ ...evidence, sourceCommit: 'other' }, expected)).toThrow(
      'exact release commit',
    )
    expect(() =>
      validateNativeAdapterEvidence({ ...evidence, checks: { ...checks, 'task-creation': 'skipped' } }, expected)
    ).toThrow('task-creation')
    expect(() => validateNativeAdapterEvidence({ ...evidence, logs: 'private' }, expected)).toThrow()
  })
})
