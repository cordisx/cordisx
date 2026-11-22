import { expect, it } from 'vitest'
import { ManagerRendererCommandPeer } from '../packages/cli/src/cli/manager-renderer-peer.js'
import { ServiceRendererLifecycleProjection } from '../packages/cli/src/cli/service-renderer-lifecycle-projection.js'
import { RendererLifecycleFederation } from '../packages/cli/src/launcher/renderer-lifecycle-federation.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
} from '../packages/cli/src/plugin-lifecycle-contracts.js'

const plugin = {
  id: 'installed',
  version: '1.0.0',
  digest: `sha256:${'a'.repeat(64)}` as const,
  moduleGeneration: 'installed-1',
  enabled: true,
  dependencies: [],
  canonicalSource: 'https://example.test/source',
}
const nextPlugin = { ...plugin, enabled: false, moduleGeneration: 'installed-2' }
const previous: CordisXPluginActivationRecordV1 = {
  $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  schemaVersion: 1,
  recordKind: 'active',
  profileId: 'default',
  revision: 3,
  lastGoodRevision: 3,
  runtimeGeneration: 'owner',
  plugins: [plugin],
}
const candidate: CordisXPluginActivationRecordV1 = {
  ...previous,
  recordKind: 'candidate',
  transactionId: 'transaction',
  revision: 4,
  plugins: [nextPlugin],
}
const scope = { homeDigest: 'f'.repeat(64), ownerAppId: 'codex', profileId: 'default', generation: 'owner' }

function fleet() {
  const projections = new Map<string, ServiceRendererLifecycleProjection>()
  const rendered = new Map<
    string,
    { before: CordisXPluginActivationRecordV1; after: CordisXPluginActivationRecordV1 }
  >()
  const peers = ['1', '2'].map((digit, index) => {
    const rendererId = digit.repeat(64)
    const alias = `https://renderer.cordisx.invalid/plugin/${(index + 3).toString().repeat(64)}`
    const before = { ...previous, plugins: [{ ...plugin, canonicalSource: alias }] }
    const after = { ...candidate, plugins: [{ ...nextPlugin, canonicalSource: alias }] }
    const peer = new ManagerRendererCommandPeer({
      scope,
      identity: {
        appId: 'manager',
        adapterId: 'independent-manager',
        rendererId,
        pid: process.pid,
        processStartedAt: 'fixture',
      },
      sessionId: (index + 5).toString().repeat(64),
    })
    const projection = new ServiceRendererLifecycleProjection({
      owner: { active: previous, registryEpoch: 7 },
      renderer: { active: before, registryEpoch: 7 },
      rendererId,
      current: () => !peer.closed,
      resolve: (value, id) => {
        if (value !== alias || id !== plugin.id) throw new Error('unissued alias')
        return { source: plugin.canonicalSource, digest: plugin.digest }
      },
    })
    peer.bindOwnerProjection(projection.project)
    projections.set(rendererId, projection)
    rendered.set(rendererId, { before, after })
    return peer
  })
  const lifecycle = new RendererLifecycleFederation({
    scope,
    active: previous,
    registryEpoch: 7,
    projectMutation(mutation, identity) {
      const projection = projections.get(identity.rendererId)!
      const view = rendered.get(identity.rendererId)!
      if (mutation.transactionEpoch === 'transaction:preflight') {
        projection.offer({
          transactionId: mutation.transactionId,
          targetId: mutation.targetId,
          affectedPluginIds: mutation.affectedPluginIds,
          previous: mutation.previous,
          candidate: mutation.candidate,
          projectedCandidate: view.after,
        })
        return undefined
      }
      return {
        rendererId: identity.rendererId,
        transactionId: mutation.transactionId,
        transactionEpoch: mutation.transactionEpoch,
        expectedRegistryEpoch: mutation.expectedRegistryEpoch,
        afterRegistryEpoch: mutation.afterRegistryEpoch,
        operation: mutation.operation,
        previous: view.before,
        candidate: view.after,
        targetId: mutation.targetId,
        affectedPluginIds: mutation.affectedPluginIds,
        privateGraphs: [],
      }
    },
  })
  async function reply(method: string, result: (command: any, peer: ManagerRendererCommandPeer) => unknown) {
    const commands = await Promise.all(peers.map(async peer => await peer.next({ timeoutMs: 3_000 })))
    for (const [index, command] of commands.entries()) {
      expect(command?.method).toBe(method)
      expect(JSON.stringify(command?.payload)).not.toContain(plugin.canonicalSource)
      expect(peers[index]!.acknowledge({
        id: command!.id,
        sequence: command!.sequence,
        ok: true,
        value: result(command, peers[index]!),
      })).toBe(true)
    }
  }
  async function attachAndStage() {
    const attaching = Promise.all(peers.map(async peer => await lifecycle.attach(peer)))
    await reply('synchronize', command => command.payload)
    await attaching
    await lifecycle.preflight({
      transactionId: 'transaction',
      operation: 'disable',
      previous,
      candidate,
      targetId: plugin.id,
    })
    const fence = lifecycle.prepare('transaction')
    const stage = lifecycle.stage({
      transactionId: 'transaction',
      ...fence,
      afterRegistryEpoch: 8,
      operation: 'disable',
      previous,
      candidate,
      targetId: plugin.id,
      affectedPluginIds: [plugin.id],
    })
    await reply('prepare', command => command.payload)
    await reply('stage', command => ({
      transactionId: command.payload.transactionId,
      transactionEpoch: command.payload.transactionEpoch,
      expectedRegistryEpoch: command.payload.expectedRegistryEpoch,
      afterRegistryEpoch: command.payload.afterRegistryEpoch,
      affectedPluginIds: command.payload.affectedPluginIds,
      observation: command.payload.candidate,
    }))
    expect(await stage).toEqual({
      transactionId: 'transaction',
      ...fence,
      afterRegistryEpoch: 8,
      observation: candidate,
    })
    return fence
  }
  return { lifecycle, peers, reply, attachAndStage, rendered }
}

it('confirms distinct renderer identities through the actual owner federation', async () => {
  const f = fleet()
  try {
    const fence = await f.attachAndStage()
    const publishing = f.lifecycle.publish('transaction')
    await f.reply('publish', (_command, peer) => {
      const view = f.rendered.get(peer.identity.rendererId)!
      return {
        transactionId: 'transaction',
        transactionEpoch: fence.transactionEpoch,
        registryEpoch: 8,
        active: view.after,
        retiring: view.before,
        notificationErrors: [],
      }
    })
    expect(await publishing).toEqual({
      transactionId: 'transaction',
      transactionEpoch: fence.transactionEpoch,
      registryEpoch: 8,
      active: candidate,
    })
    const completing = f.lifecycle.complete('transaction')
    await f.reply('complete', (_command, peer) => {
      const view = f.rendered.get(peer.identity.rendererId)!
      return {
        transactionId: 'transaction',
        transactionEpoch: fence.transactionEpoch,
        registryEpoch: 8,
        active: view.after,
        disposedAfter: view.before,
      }
    })
    expect(await completing).toEqual({
      transactionId: 'transaction',
      transactionEpoch: fence.transactionEpoch,
      registryEpoch: 8,
      active: candidate,
      disposedAfter: previous,
    })
    const finalizing = f.lifecycle.finalize('transaction')
    await f.reply('finalize', command => command.payload)
    await finalizing
    const { transactionId: _transactionId, ...active } = candidate
    void _transactionId
    expect(f.lifecycle.snapshot()).toEqual({
      active: { ...active, recordKind: 'active', lastGoodRevision: 4 },
      registryEpoch: 8,
    })
  } finally {
    for (const peer of f.peers) peer.close()
  }
})

it('confirms rollback and adoption with independent aliases in the owner federation', async () => {
  const f = fleet()
  try {
    const fence = await f.attachAndStage()
    const rollingBack = f.lifecycle.rollback('transaction')
    await f.reply('rollback', command => command.payload.expected)
    expect(await rollingBack).toEqual({
      transactionId: 'transaction',
      transactionEpoch: fence.transactionEpoch,
      registryEpoch: 9,
      active: previous,
      disposedAfter: candidate,
    })
    const recovered = { ...previous, revision: 5, lastGoodRevision: 3 }
    const adopting = f.lifecycle.adoptRecoveredActivation(recovered, 9)
    await f.reply('synchronize', command => command.payload)
    await adopting
    expect(f.lifecycle.snapshot()).toEqual({ active: recovered, registryEpoch: 9 })
  } finally {
    for (const peer of f.peers) peer.close()
  }
})
