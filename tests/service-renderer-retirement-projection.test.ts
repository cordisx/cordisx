import { expect, it, vi } from 'vitest'
import { createServiceRendererProjector } from '../packages/cli/src/cli/service-renderer-projection.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'

vi.mock('../packages/cli/src/cli/service-renderer-profile-inputs.js', () => ({
  readSettledPackageInputs: vi.fn(async () => new Map()),
}))

it('does not send owner-only authorization decisions when retiring a plugin', async () => {
  const plugin = {
    id: 'fixture',
    version: '1.0.0',
    digest: `sha256:${'a'.repeat(64)}`,
    moduleGeneration: 'fixture-1',
    enabled: true,
    dependencies: [],
  }
  const previous = {
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1,
    recordKind: 'active',
    profileId: 'default',
    revision: 1,
    lastGoodRevision: 1,
    runtimeGeneration: 'generation',
    plugins: [plugin],
  }
  const identity = {
    appId: 'manager',
    adapterId: 'independent-manager',
    rendererId: 'a'.repeat(64),
    pid: 1,
    processStartedAt: 'test',
  }
  const project = createServiceRendererProjector({
    homeDir: '/fixture',
    profileId: 'default',
    generation: 'generation',
    isLive: () => true,
    canMutate: () => true,
  })
  for (const operation of ['disable', 'uninstall'] as const) {
    const candidate = {
      ...previous,
      recordKind: 'candidate',
      transactionId: 'transaction',
      revision: 2,
      plugins: operation === 'disable' ? [{ ...plugin, enabled: false, moduleGeneration: 'fixture-2' }] : [],
    }
    const result = await project({
      transactionId: 'transaction',
      transactionEpoch: 'transaction:epoch',
      expectedRegistryEpoch: 1,
      afterRegistryEpoch: 2,
      operation,
      previous,
      candidate,
      targetId: plugin.id,
      affectedPluginIds: [plugin.id],
      authorizationDecision: { schemaVersion: 4, decisions: [{ decision: 'allow-persistent' }] },
    } as never, identity)
    expect(result).toMatchObject({ operation, previous, candidate, privateGraphs: [] })
    expect(result).not.toHaveProperty('authorizationDecision')
  }
})
