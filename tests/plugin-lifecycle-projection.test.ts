import { describe, expect, it, vi } from 'vitest'
import { runPluginLifecycleRequestWithProjection } from '../packages/cli/src/launcher/plugin-lifecycle-projection.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
} from '../packages/cli/src/plugin-lifecycle-contracts.js'

const active: CordisXPluginActivationRecordV1 = {
  $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  schemaVersion: 1,
  recordKind: 'active',
  profileId: 'work',
  revision: 2,
  lastGoodRevision: 0,
  runtimeGeneration: 'runtime',
  plugins: [],
}

describe('plugin lifecycle projection settlement', () => {
  it('repairs live and future projections after a lifecycle rollback rejects its caller', async () => {
    const requestFailure = new Error('rolled back')
    const calls: string[] = []
    await expect(runPluginLifecycleRequestWithProjection(
      async () => {
        calls.push('request')
        throw requestFailure
      },
      true,
      {
        loadActive: async () => {
          calls.push('active')
          return active
        },
        refreshBrowserGraphBootstrap: async value => {
          expect(value).toBe(active)
          calls.push('bootstrap')
        },
        loadBundleSnapshot: async () => {
          calls.push('bundle')
          return { revision: 3 } as never
        },
        synchronizePluginBundles: async snapshot => {
          expect(snapshot).toEqual({ revision: 3 })
          calls.push('synchronize')
        },
        terminal: vi.fn(),
      },
    )).rejects.toBe(requestFailure)
    expect(calls).toEqual(['request', 'active', 'bootstrap', 'bundle', 'synchronize'])
  })

  it('preserves both the request and terminal reconciliation failures', async () => {
    const requestFailure = new Error('rolled back')
    const refreshFailure = new Error('future bootstrap failed')
    const bundleFailure = new Error('bundle projection failed')
    const terminal = vi.fn()
    let failure: unknown
    try {
      await runPluginLifecycleRequestWithProjection(
        async () => {
          throw requestFailure
        },
        true,
        {
          loadActive: async () => active,
          refreshBrowserGraphBootstrap: async () => {
            throw refreshFailure
          },
          loadBundleSnapshot: async () => ({ revision: 3 } as never),
          synchronizePluginBundles: async () => {
            throw bundleFailure
          },
          terminal,
        },
      )
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([
      requestFailure,
      expect.objectContaining({ errors: [refreshFailure, bundleFailure] }),
    ])
    expect(terminal).toHaveBeenCalledWith(expect.objectContaining({ errors: [refreshFailure, bundleFailure] }))
  })

  it('does not reconcile a read-only snapshot request', async () => {
    const settlement = {
      loadActive: vi.fn(async () => active),
      refreshBrowserGraphBootstrap: vi.fn(async () => undefined),
      terminal: vi.fn(),
    }
    await expect(runPluginLifecycleRequestWithProjection(async () => 'snapshot', false, settlement))
      .resolves.toBe('snapshot')
    expect(settlement.loadActive).not.toHaveBeenCalled()
  })
})
