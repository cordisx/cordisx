import { describe, expect, it } from 'vitest'
import {
  hostModelServiceEnvironment,
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

  it('uses enabled Host variables for launch and discovery while removing disabled configured names', () => {
    const base = { MODEL_KEY: 'process-value', DISABLED_KEY: 'process-disabled', BASE_ONLY: 'base' }
    const planned = { MODEL_KEY: 'plan-value', PLAN_ONLY: 'plan' }
    const entries = [
      { name: 'MODEL_KEY', value: 'host-value', enabled: true },
      { name: 'DISABLED_KEY', value: 'disabled-value', enabled: false },
    ]
    expect(hostModelServiceEnvironment(base, entries, planned)).toEqual({
      MODEL_KEY: 'host-value',
      DISABLED_KEY: undefined,
      BASE_ONLY: 'base',
      PLAN_ONLY: 'plan',
    })
    expect(
      nativeSubmissionCatalogOptions('/home', 'default', {}, base, planned, undefined, entries)
        .nativeDiscoveryEnvironment,
    ).toEqual({
      MODEL_KEY: 'host-value',
      DISABLED_KEY: undefined,
      BASE_ONLY: 'base',
      PLAN_ONLY: 'plan',
    })
  })

  it('forwards one-shot legacy owner recovery only when explicitly supplied by the Host', () => {
    const recovery = { exitedPid: 1234, inode: 5678 }
    expect(nativeSubmissionCatalogOptions('/home', 'default', {}, {}, undefined, recovery).managedCatalog)
      .toEqual({ homeDir: '/home', profileId: 'default', recoverLegacyLock: recovery })
    expect(nativeSubmissionCatalogOptions('/home', 'default', {}, {}).managedCatalog)
      .toEqual({ homeDir: '/home', profileId: 'default' })
  })
})
