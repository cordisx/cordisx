import { describe, expect, it } from 'vitest'
import {
  nativeDiscoveryEnvironment,
  nativeSubmissionCatalogOptions,
} from '../packages/cli/src/cli/native-submission-catalog-options.js'

describe('native submission catalog options', () => {
  it('uses plan overrides for both native completion paths without falling back to process.env', () => {
    const base = { API_KEY: 'base', BASE_ONLY: 'present' }
    const planned = { API_KEY: 'planned', PLAN_ONLY: 'present' }
    expect(nativeDiscoveryEnvironment(base, planned)).toEqual({
      API_KEY: 'planned',
      BASE_ONLY: 'present',
      PLAN_ONLY: 'present',
    })
    expect(nativeDiscoveryEnvironment(base)).toEqual(base)
    expect(nativeSubmissionCatalogOptions('/home', 'default', {}, base, planned).nativeDiscoveryEnvironment)
      .toEqual(nativeDiscoveryEnvironment(base, planned))
    expect(nativeSubmissionCatalogOptions('/home', 'default', { nativeModelDiscovery: false }, base))
      .toMatchObject({ nativeModelDiscovery: false })
  })
})
