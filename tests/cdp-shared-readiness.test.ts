import { describe, expect, it } from 'vitest'
import { assertSharedCdpReadiness } from '../packages/cli/src/launcher/cdp-shared-admission.js'
import type {
  PluginRuntimeMutation,
  RuntimeReadinessObservation,
} from '../packages/cli/src/launcher/plugin-lifecycle-model.js'

const mutation = {
  transactionId: 'transaction',
  transactionEpoch: 'epoch',
  expectedRegistryEpoch: 4,
  afterRegistryEpoch: 5,
  affectedPluginIds: ['dependent', 'base'],
} as PluginRuntimeMutation
const receipt = {
  transactionId: 'transaction',
  transactionEpoch: 'epoch',
  expectedRegistryEpoch: 4,
  afterRegistryEpoch: 5,
  affectedPluginIds: ['base', 'dependent'],
} as RuntimeReadinessObservation

describe('shared CDP readiness', () => {
  it('accepts different order for the same unique plugin closure in every receipt', () => {
    expect(() => assertSharedCdpReadiness([receipt, { ...receipt }], mutation)).not.toThrow()
  })

  it.each([
    ['duplicate', ['base', 'base']],
    ['missing', ['base']],
    ['unexpected', ['base', 'other']],
    ['non-string', ['base', 1]],
    ['non-array', 'base'],
    ['absent', undefined],
  ])('rejects a %s plugin closure in any CDP document', (_label, affectedPluginIds) => {
    const invalid = { ...receipt, affectedPluginIds }
    expect(() => assertSharedCdpReadiness([receipt, invalid], mutation)).toThrow('readiness disagrees')
  })

  it.each(['transactionId', 'transactionEpoch', 'expectedRegistryEpoch', 'afterRegistryEpoch'] as const)(
    'rejects a mismatched %s in any CDP document',
    key => {
      const invalid = { ...receipt, [key]: 'mismatch' }
      expect(() => assertSharedCdpReadiness([receipt, invalid], mutation)).toThrow('readiness disagrees')
    },
  )

  it('rejects a duplicate authority closure and missing receipts', () => {
    expect(() => assertSharedCdpReadiness([receipt], { ...mutation, affectedPluginIds: ['base', 'base'] }))
      .toThrow('readiness disagrees')
    expect(() => assertSharedCdpReadiness([], mutation)).toThrow('readiness disagrees')
  })
})
