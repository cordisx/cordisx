import {
  type PluginGenerationGraphLease,
  resourceRegistryInstallSource,
} from '../launcher/plugin-generation-artifact-server.js'
import { normalizePluginActivation, pluginAffectedClosure } from '../launcher/plugin-activation.js'
import type { PluginRuntimeMutation } from '../launcher/plugin-lifecycle-model.js'
import { loadStagedPluginPackage } from '../launcher/plugin-package.js'
import { attachmentEqual, attachmentRecord } from '../launcher/renderer-lifecycle-peer.js'

function ownerGraph(value: unknown): PluginGenerationGraphLease {
  const item = attachmentRecord(value)
  const fields = ['leaseId', 'pluginId', 'moduleGeneration', 'baseUrl', 'entryUrl', 'initialStyleUrls']
  if (
    Object.keys(item).length !== fields.length || Object.keys(item).some(key => !fields.includes(key))
    || typeof item.leaseId !== 'string' || !/^[a-f0-9]{64}$/u.test(item.leaseId)
    || typeof item.pluginId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(item.pluginId)
    || typeof item.moduleGeneration !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(item.moduleGeneration)
    || typeof item.baseUrl !== 'string' || item.baseUrl.length > 4096
    || typeof item.entryUrl !== 'string' || item.entryUrl.length > 4096
    || !Array.isArray(item.initialStyleUrls) || item.initialStyleUrls.length > 256
    || item.initialStyleUrls.some(value => typeof value !== 'string' || value.length > 4096)
  ) throw new Error('adapter-graph-invalid')
  const base = new URL(item.baseUrl)
  if (
    base.href !== item.baseUrl || base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || !base.port
    || base.username || base.password || base.search || base.hash
    || !new RegExp(`^/cordisx-plugin-artifacts/[a-f0-9]{64}/${item.leaseId}/$`, 'u').test(base.pathname)
  ) throw new Error('adapter-graph-invalid')
  const inGraph = (value: string) => {
    const url = new URL(value)
    return url.href === value && url.origin === base.origin && url.href.startsWith(base.href)
      && !url.username && !url.password && !url.search && !url.hash && url.pathname !== base.pathname
  }
  const styles = item.initialStyleUrls as string[]
  if (!inGraph(item.entryUrl) || styles.some(value => !inGraph(value)) || new Set(styles).size !== styles.length) {
    throw new Error('adapter-graph-invalid')
  }
  const registry = '__cordisxPluginGenerationResourcesV1'
  const leaseId = item.leaseId
  const stage = JSON.stringify({ id: leaseId, baseUrl: item.baseUrl, initialStyles: styles })
  const importSource =
    `(async () => { ${resourceRegistryInstallSource()}; const resources = globalThis.${registry}.stage(${stage}); try { await resources.ready; return await import(${
      JSON.stringify(item.entryUrl)
    }); } catch (error) { globalThis.${registry}.retire(${JSON.stringify(leaseId)}); throw error; } })()`
  return Object.freeze({
    leaseId,
    pluginId: item.pluginId,
    moduleGeneration: item.moduleGeneration,
    baseUrl: item.baseUrl,
    entryUrl: item.entryUrl,
    initialStyleUrls: Object.freeze([...styles]),
    importSource,
    publishSource: `(() => { const registry = globalThis.${registry}; if (registry === undefined || registry.publish(${
      JSON.stringify(leaseId)
    }) !== true) throw new Error('plugin generation resource publication failed'); return true })()`,
    retireSource: `(() => { const registry = globalThis.${registry}; if (registry === undefined || registry.retire(${
      JSON.stringify(leaseId)
    }) !== true) throw new Error('plugin generation resource retirement failed'); return true })()`,
    // The remote owner, not this adapter, owns the underlying artifact route.
    retire() {},
  })
}

/** Reconstruct only the owner-selected mutation and immutable graph leases in the native client. */
export async function loadOwnerAdapterMutation(input: {
  readonly value: unknown
  readonly homeDir: string
  readonly profileId: string
  readonly generation: string
  readonly rendererId: string
}): Promise<PluginRuntimeMutation> {
  const value = attachmentRecord(input.value)
  const previous = normalizePluginActivation(value.previous)
  const candidate = normalizePluginActivation(value.candidate)
  const fields = [
    'rendererId',
    'transactionId',
    'transactionEpoch',
    'expectedRegistryEpoch',
    'afterRegistryEpoch',
    'operation',
    'previous',
    'candidate',
    'targetId',
    'affectedPluginIds',
    'package',
    'authorizationDecision',
    'privateGraphs',
  ]
  if (
    Object.keys(value).some(key => !fields.includes(key)) || value.rendererId !== input.rendererId
    || previous.recordKind !== 'active' || candidate.recordKind !== 'candidate'
    || previous.profileId !== input.profileId || candidate.profileId !== input.profileId
    || previous.runtimeGeneration !== input.generation || candidate.runtimeGeneration !== input.generation
    || candidate.revision !== previous.revision + 1 || candidate.lastGoodRevision !== previous.revision
    || typeof value.transactionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.transactionId)
    || candidate.transactionId !== value.transactionId
    || typeof value.transactionEpoch !== 'string' || !value.transactionEpoch.startsWith(`${value.transactionId}:`)
    || !Number.isSafeInteger(value.expectedRegistryEpoch) || (value.expectedRegistryEpoch as number) < 0
    || value.afterRegistryEpoch !== (value.expectedRegistryEpoch as number) + 1
    || !['install', 'update', 'enable', 'disable', 'uninstall'].includes(String(value.operation))
    || typeof value.targetId !== 'string' || !Array.isArray(value.affectedPluginIds)
    || !value.affectedPluginIds.includes(value.targetId) || value.affectedPluginIds.length > 4096
    || value.affectedPluginIds.some(id => typeof id !== 'string')
    || new Set(value.affectedPluginIds).size !== value.affectedPluginIds.length
    || !Array.isArray(value.privateGraphs) || value.privateGraphs.length > 256
  ) throw new Error('adapter-mutation-invalid')
  const expected = pluginAffectedClosure(previous.plugins, candidate.plugins)
  if (
    expected.length !== value.affectedPluginIds.length
    || expected.some(id => !(value.affectedPluginIds as string[]).includes(id))
    || attachmentEqual(
      previous.plugins.find(plugin => plugin.id === value.targetId),
      candidate.plugins.find(plugin => plugin.id === value.targetId),
    )
  ) throw new Error('adapter-mutation-invalid')
  const leases = value.privateGraphs.map(ownerGraph)
  if (
    new Set(leases.map(lease => lease.pluginId)).size !== leases.length
    || leases.some(lease => {
      const item = candidate.plugins.find(plugin => plugin.id === lease.pluginId)
      return !value.affectedPluginIds || !(value.affectedPluginIds as string[]).includes(lease.pluginId)
        || !item?.enabled || item.moduleGeneration !== lease.moduleGeneration
    })
  ) throw new Error('adapter-mutation-invalid')
  let staged: Awaited<ReturnType<typeof loadStagedPluginPackage>> | undefined
  const targetEnabled = candidate.plugins.some(plugin => plugin.id === value.targetId && plugin.enabled)
  if (targetEnabled !== (value.package !== undefined)) throw new Error('adapter-mutation-invalid')
  if (value.package !== undefined) {
    const projected = attachmentRecord(value.package)
    const item = candidate.plugins.find(plugin => plugin.id === value.targetId && plugin.enabled)
    if (!item) throw new Error('adapter-mutation-invalid')
    staged = await loadStagedPluginPackage(input.homeDir, item.digest)
    if (
      projected.digest !== staged.digest || projected.identitySource !== staged.identitySource
      || !attachmentEqual(projected.manifest, staged.manifest)
      || projected.artifactIntegrity !== staged.artifactIntegrity
    ) throw new Error('adapter-mutation-invalid')
  }
  return {
    transactionId: value.transactionId,
    transactionEpoch: value.transactionEpoch,
    expectedRegistryEpoch: value.expectedRegistryEpoch as number,
    afterRegistryEpoch: value.afterRegistryEpoch as number,
    operation: value.operation as PluginRuntimeMutation['operation'],
    previous,
    candidate,
    targetId: value.targetId,
    affectedPluginIds: [...value.affectedPluginIds] as string[],
    ...(staged === undefined ? {} : { package: staged }),
    ...(value.authorizationDecision === undefined
      ? {}
      : {
        authorizationDecision: value.authorizationDecision as NonNullable<
          PluginRuntimeMutation['authorizationDecision']
        >,
      }),
    runtimeArtifactLeases: leases,
  }
}
