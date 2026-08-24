import { valid } from 'semver'
import type {
  HostPackageManifest,
  PackageObjectRecord,
} from './types.js'
import { PackageLifecycleError } from './types.js'

export interface ResolvedPackageNode {
  readonly pluginId: string
  readonly packageKey: string
  readonly manifest: HostPackageManifest
}

export interface ResolvedPackageGraph {
  readonly activationOrder: readonly string[]
  readonly drainOrder: readonly string[]
  readonly reverseDependencies: Readonly<Record<string, readonly string[]>>
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort()
}

export function validateHostPackageManifest(manifest: HostPackageManifest, label = 'package manifest'): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,95}$/.test(manifest.pluginId)) {
    throw new PackageLifecycleError('invalid-package-manifest', `${label}.pluginId is invalid`)
  }
  if (valid(manifest.version) === null) {
    throw new PackageLifecycleError('invalid-package-version', `${label}.version must be a valid semantic version`)
  }
  if (manifest.compatibility.runtimeAbi !== 1 || manifest.compatibility.protocol !== 1) {
    throw new PackageLifecycleError('incompatible-runtime', `${label} requires unsupported runtime ABI or protocol`)
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.permissionFingerprint)) {
    throw new PackageLifecycleError('invalid-permission-fingerprint', `${label}.permissionFingerprint must be lowercase SHA-256`)
  }
  const seen = new Set<string>()
  for (const dependency of manifest.dependencies) {
    if (!/^[a-z0-9][a-z0-9._-]{0,95}$/.test(dependency.id)) {
      throw new PackageLifecycleError('invalid-dependency', `${label} dependency id is invalid: ${dependency.id}`)
    }
    if (dependency.id === manifest.pluginId) {
      throw new PackageLifecycleError('dependency-cycle', `${manifest.pluginId} cannot depend on itself`)
    }
    if (seen.has(dependency.id)) {
      throw new PackageLifecycleError('duplicate-dependency', `${manifest.pluginId} repeats dependency ${dependency.id}`)
    }
    seen.add(dependency.id)
    if (valid(dependency.version) === null) {
      throw new PackageLifecycleError('invalid-dependency-version', `${manifest.pluginId} dependency version is invalid: ${dependency.version}`)
    }
  }
}

export function assertPackageCompatibility(
  manifest: HostPackageManifest,
  versions: { readonly runtimeAbi: 1; readonly protocolVersion: 1 },
): void {
  if (manifest.compatibility.runtimeAbi !== versions.runtimeAbi) {
    throw new PackageLifecycleError(
      'host-incompatible',
      `${manifest.pluginId}@${manifest.version} requires runtime ABI ${manifest.compatibility.runtimeAbi}`,
    )
  }
  if (manifest.compatibility.protocol !== versions.protocolVersion) {
    throw new PackageLifecycleError(
      'protocol-incompatible',
      `${manifest.pluginId}@${manifest.version} requires protocol ${manifest.compatibility.protocol}`,
    )
  }
}

export function resolvePackageGraph(nodes: Readonly<Record<string, ResolvedPackageNode>>): ResolvedPackageGraph {
  const reverse: Record<string, string[]> = Object.create(null) as Record<string, string[]>
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const activationOrder: string[] = []

  for (const id of Object.keys(nodes)) reverse[id] = []

  const visit = (pluginId: string, trail: readonly string[]): void => {
    if (visited.has(pluginId)) return
    if (visiting.has(pluginId)) {
      throw new PackageLifecycleError('dependency-cycle', `dependency cycle: ${[...trail, pluginId].join(' -> ')}`)
    }
    const node = nodes[pluginId]
    if (node === undefined) throw new PackageLifecycleError('missing-dependency', `missing package for ${pluginId}`)
    visiting.add(pluginId)
    for (const dependency of [...node.manifest.dependencies].sort((a, b) => a.id.localeCompare(b.id))) {
      const provider = nodes[dependency.id]
      if (provider === undefined) {
        throw new PackageLifecycleError(
          'missing-dependency',
          `${pluginId} requires missing dependency ${dependency.id}@${dependency.version}`,
        )
      }
      if (provider.manifest.version !== dependency.version) {
        throw new PackageLifecycleError(
          'dependency-conflict',
          `${pluginId} requires ${dependency.id}@${dependency.version}; selected ${provider.manifest.version}`,
        )
      }
      reverse[dependency.id]!.push(pluginId)
      visit(dependency.id, [...trail, pluginId])
    }
    visiting.delete(pluginId)
    visited.add(pluginId)
    activationOrder.push(pluginId)
  }

  for (const pluginId of Object.keys(nodes).sort()) visit(pluginId, [])
  const reverseDependencies: Record<string, readonly string[]> = Object.create(null) as Record<string, readonly string[]>
  for (const [pluginId, dependents] of Object.entries(reverse)) reverseDependencies[pluginId] = sortedUnique(dependents)
  return { activationOrder, drainOrder: [...activationOrder].reverse(), reverseDependencies }
}

export function affectedClosure(
  changedPluginIds: readonly string[],
  graph: Pick<ResolvedPackageGraph, 'reverseDependencies'>,
): readonly string[] {
  const affected = new Set<string>()
  const queue = [...changedPluginIds].sort()
  while (queue.length > 0) {
    const pluginId = queue.shift()!
    if (affected.has(pluginId)) continue
    affected.add(pluginId)
    queue.push(...(graph.reverseDependencies[pluginId] ?? []))
    queue.sort()
  }
  return sortedUnique(affected)
}

export function selectedNodes(
  packages: Readonly<Record<string, PackageObjectRecord>>,
  selected: Readonly<Record<string, string>>,
): Readonly<Record<string, ResolvedPackageNode>> {
  const nodes: Record<string, ResolvedPackageNode> = Object.create(null) as Record<string, ResolvedPackageNode>
  for (const [pluginId, packageKey] of Object.entries(selected)) {
    const record = packages[packageKey]
    if (record === undefined) throw new PackageLifecycleError('missing-package-object', `missing package object: ${packageKey}`)
    if (record.identity.pluginId !== pluginId) {
      throw new PackageLifecycleError('package-identity-mismatch', `${packageKey} does not belong to ${pluginId}`)
    }
    nodes[pluginId] = { pluginId, packageKey, manifest: record.manifest }
  }
  return nodes
}
