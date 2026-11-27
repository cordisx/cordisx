import { expect, it } from 'vitest'
import { ServiceRendererLifecycle } from '../packages/cli/src/launcher/service-renderer-lifecycle.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
} from '../packages/cli/src/plugin-lifecycle-contracts.js'

it('does not adopt an unrelated activation during startup recovery', async () => {
  const scope = { homeDigest: 'a'.repeat(64), ownerAppId: 'codex', profileId: 'work', generation: 'new-runtime' }
  const lifecycle = new ServiceRendererLifecycle({ scope })
  const target = { profileId: 'work', revision: 2, lastGoodRevision: 2, runtimeGeneration: 'old-runtime', plugins: [] }
  const plan = {
    transactionId: 'transaction',
    transactionEpoch: 'epoch',
    rollbackToken: 'rollback:fixture',
    candidateFingerprint: 'a'.repeat(64),
    expectedRegistryEpoch: 4,
    rollbackRegistryEpoch: 5,
    rollbackTarget: target,
    expectedPublished: { ...target, revision: 3 },
  }
  const active: CordisXPluginActivationRecordV1 = {
    ...target,
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1,
    recordKind: 'active',
  }
  try {
    await lifecycle.recoverRollback(plan as never)
    for (
      const stale of [
        { ...active, runtimeGeneration: 'unrelated-runtime' },
        { ...active, revision: 7 },
        { ...active, profileId: 'other' },
      ]
    ) {
      await expect(lifecycle.adoptRecoveredActivation(stale, 5)).rejects.toThrow(
        'service renderer recovery adoption is unavailable',
      )
    }
    await lifecycle.adoptRecoveredActivation(active, 5)
    lifecycle.initialize({ ...active, runtimeGeneration: scope.generation })
    expect(lifecycle.snapshot().active).toMatchObject({ runtimeGeneration: scope.generation, revision: 2 })
  } finally {
    await lifecycle.close()
  }
})
