import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V1,
  type CordisXPermissionAuthorizationDecisionV1,
} from '../platform-contracts.js'
import {
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V4,
  type CordisXPermissionAuthorizationDecisionV2,
  type CordisXPermissionAuthorizationDecisionV4,
  type CordisXPermissionAuthorizationItemV4,
  type CordisXPermissionDecisionV2,
} from '../permission-contracts.js'
import {
  CORDISX_PLUGIN_BUNDLE_LIFECYCLE_RESULT_SCHEMA_V1,
  CORDISX_PLUGIN_BUNDLE_MANAGER_SNAPSHOT_SCHEMA_V1,
  CORDISX_PLUGIN_BUNDLE_SCHEMA_V1,
  type CordisXPluginBundleLifecycleRequestV1,
  type CordisXPluginBundleLifecycleResultV1,
  type CordisXPluginBundleManagerItemV1,
  type CordisXPluginBundleManagerPermissionV1,
  type CordisXPluginBundleManagerSnapshotV1,
  type CordisXPluginBundleManifestV1,
  type CordisXPluginBundlePlanV1,
  type CordisXPluginBundlePolicy,
} from '../plugin-bundle-contracts.js'
import type { CordisXPluginActivationRecordV1, CordisXPluginLifecycleResultV1 } from '../plugin-lifecycle-contracts.js'
import { loadStagedPluginPackage, type StagedPluginPackage } from './plugin-package.js'
import type { PluginLifecycleCoordinator } from './plugin-lifecycle.js'
import { PluginPackageSourceSnapshotter } from './packages/integrity.js'
import { resolvePluginPackageSourceV1 } from './packages/source.js'

export const LOCAL_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/
export const SEMVER =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
export const SAFE_DIR = /^\.\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/
export const SAFE_README = /^\.\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(?:md|markdown)$/
export const SAFE_ICON = /^\.\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(?:png|webp|svg)$/

export interface StoredPermission {
  readonly permissionId: string
  readonly pluginId: string
  readonly capability: string
  readonly scope: unknown
  readonly scopeLabel: string
  readonly required: boolean
}

export interface StoredMember {
  readonly pluginId: string
  readonly name?: string
  readonly requestedVersion: string
  readonly digest: `sha256:${string}`
  readonly dependencies: readonly { readonly id: string; readonly version: string }[]
  readonly required: boolean
  readonly enabledByDefault: boolean
  readonly permissions: readonly StoredPermission[]
}

export interface BundleRecord {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly version: string
  readonly digest: `sha256:${string}`
  readonly authors: readonly string[]
  readonly sourceLabel: string
  readonly canonicalSource?: string
  readonly readme: string
  readonly installedAt: string
  readonly updatedAt: string
  readonly enabled: boolean
  readonly optionalEnabled: Readonly<Record<string, boolean>>
  readonly policies: Readonly<Record<string, CordisXPluginBundlePolicy>>
  readonly members: readonly StoredMember[]
  readonly records: readonly StoredRecord[]
}

export interface StoredRecord {
  readonly recordId: string
  readonly at: string
  readonly kind: CordisXPluginBundleLifecycleRequestV1['operation']['kind']
  readonly outcome: CordisXPluginBundleLifecycleResultV1['outcome']
  readonly message: string
  readonly pluginIds: readonly string[]
}

export interface BundleCandidate {
  readonly candidateId: string
  readonly createdAt: string
  readonly baseRevision: number
  readonly basePluginRevision: number
  readonly impactToken: string
  readonly record: BundleRecord
  readonly plan: CordisXPluginBundlePlanV1
}

export interface BundleState {
  readonly contract: 'cordisx.plugin-bundle-registry/v1'
  readonly profileId: string
  readonly revision: number
  readonly bundles: Readonly<Record<string, BundleRecord>>
  readonly candidates: Readonly<Record<string, BundleCandidate>>
  readonly directClaims: Readonly<Record<string, true>>
  readonly pluginOverrides: Readonly<Record<string, CordisXPluginBundlePolicy>>
  readonly permissionFloors: Readonly<Record<string, CordisXPluginBundlePolicy>>
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

export function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const accepted = new Set(allowed)
  const unknown = Object.keys(value).find(key => !accepted.has(key))
  if (unknown !== undefined) throw new Error(`${label}.${unknown} is unsupported`)
}

export function text(value: unknown, label: string, max = 512): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) {
    throw new Error(`${label} must be a bounded string`)
  }
  return value
}

export async function contained(root: string, relative: string, pattern: RegExp, label: string): Promise<string> {
  if (!pattern.test(relative) || relative.includes('..')) throw new Error(`${label} must be bundle-relative`)
  const canonicalRoot = `${await realpath(root)}${path.sep}`
  const target = await realpath(path.resolve(root, relative.slice(2))).catch(() => {
    throw new Error(`${label} does not exist`)
  })
  if (!target.startsWith(canonicalRoot)) throw new Error(`${label} escapes the bundle root`)
  return target
}

export function parseManifest(value: unknown): CordisXPluginBundleManifestV1 {
  const manifest = object(value, 'bundle manifest')
  exactKeys(manifest, [
    '$schema',
    'schemaVersion',
    'id',
    'name',
    'description',
    'version',
    'authors',
    'readme',
    'icon',
    'canonicalSource',
    'distribution',
    'members',
  ], 'bundle manifest')
  if (manifest.$schema !== CORDISX_PLUGIN_BUNDLE_SCHEMA_V1 || manifest.schemaVersion !== 1) {
    throw new Error('bundle manifest schema is unsupported')
  }
  const id = text(manifest.id, 'bundle id', 96)
  const name = text(manifest.name, 'bundle name', 128)
  const version = text(manifest.version, 'bundle version', 64)
  if (!LOCAL_ID.test(id) || !SEMVER.test(version)) throw new Error('bundle identity is invalid')
  if (!Array.isArray(manifest.authors) || manifest.authors.length < 1 || manifest.authors.length > 16) {
    throw new Error('bundle authors are invalid')
  }
  const authors = manifest.authors.map((author, index) => text(author, `authors[${index}]`, 128))
  if (new Set(authors).size !== authors.length) throw new Error('bundle authors are duplicated')
  const distribution = object(manifest.distribution, 'bundle distribution')
  exactKeys(distribution, ['mode', 'signature'], 'bundle distribution')
  if (distribution.mode !== 'explicit-local-v1' || distribution.signature !== 'unsupported') {
    throw new Error('bundle distribution is unsupported')
  }
  if (!Array.isArray(manifest.members) || manifest.members.length < 1 || manifest.members.length > 64) {
    throw new Error('bundle members are invalid')
  }
  const memberIds = new Set<string>()
  const memberPaths = new Set<string>()
  const members = manifest.members.map((entry, index) => {
    const item = object(entry, `members[${index}]`)
    exactKeys(item, ['id', 'version', 'path', 'required', 'enabledByDefault'], `members[${index}]`)
    const memberId = text(item.id, `members[${index}].id`, 96)
    const memberVersion = text(item.version, `members[${index}].version`, 64)
    const memberPath = text(item.path, `members[${index}].path`, 512)
    if (
      !LOCAL_ID.test(memberId) || !SEMVER.test(memberVersion) || !SAFE_DIR.test(memberPath)
      || memberIds.has(memberId) || memberPaths.has(memberPath)
    ) throw new Error(`members[${index}] identity/path is invalid or duplicated`)
    if (
      typeof item.required !== 'boolean' || typeof item.enabledByDefault !== 'boolean'
      || (item.required && !item.enabledByDefault)
    ) {
      throw new Error(`members[${index}] enable policy is invalid`)
    }
    memberIds.add(memberId)
    memberPaths.add(memberPath)
    return {
      id: memberId,
      version: memberVersion,
      path: memberPath,
      required: item.required,
      enabledByDefault: item.enabledByDefault,
    }
  })
  const readme = text(manifest.readme, 'bundle readme', 512)
  if (!SAFE_README.test(readme)) throw new Error('bundle readme path is invalid')
  const icon = manifest.icon === undefined ? undefined : text(manifest.icon, 'bundle icon', 512)
  if (icon !== undefined && !SAFE_ICON.test(icon)) throw new Error('bundle icon path is invalid')
  const canonicalSource = manifest.canonicalSource === undefined
    ? undefined
    : text(manifest.canonicalSource, 'canonical source', 2048)
  if (canonicalSource !== undefined && !/^https:\/\/[^?#]+$/.test(canonicalSource)) {
    throw new Error('canonical source must be public HTTPS without query or fragment')
  }
  return {
    $schema: CORDISX_PLUGIN_BUNDLE_SCHEMA_V1,
    schemaVersion: 1,
    id,
    name,
    ...(manifest.description === undefined
      ? {}
      : { description: text(manifest.description, 'bundle description', 512) }),
    version,
    authors,
    readme,
    ...(icon === undefined ? {} : { icon }),
    ...(canonicalSource === undefined ? {} : { canonicalSource }),
    distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
    members,
  }
}

export function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex')
}

export function appendRecord(
  bundle: BundleRecord,
  at: string,
  kind: StoredRecord['kind'],
  message: string,
  pluginIds: readonly string[],
): BundleRecord {
  return {
    ...bundle,
    updatedAt: at,
    records: [...bundle.records.slice(-511), {
      recordId: `bundle-record-${randomUUID()}`,
      at,
      kind,
      outcome: 'applied',
      message,
      pluginIds,
    }],
  }
}

export function pluginBundlePermissionId(input: {
  readonly pluginId: string
  readonly digest: string
  readonly capability: string
  readonly scope: unknown
}): string {
  return `permission:${hash([input.pluginId, input.digest, input.capability, input.scope])}`
}

export function permissions(staged: StagedPluginPackage): readonly StoredPermission[] {
  return staged.manifest.runtimeManifest.capabilities.flatMap((raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return []
    const item = raw as unknown as Record<string, unknown>
    if (typeof item.name !== 'string' || typeof item.required !== 'boolean' || item.scope === undefined) return []
    if (item.name.startsWith('agents.') || item.name.startsWith('sessions.') || item.name.startsWith('approvals.')) {
      return []
    }
    const scopeLabel = JSON.stringify(item.scope)
    return [{
      permissionId: pluginBundlePermissionId({
        pluginId: staged.manifest.id,
        digest: staged.digest,
        capability: item.name,
        scope: item.scope,
      }),
      pluginId: staged.manifest.id,
      capability: item.name,
      scope: structuredClone(item.scope),
      scopeLabel: scopeLabel.length > 512 ? `${scopeLabel.slice(0, 509)}...` : scopeLabel,
      required: item.required,
    }]
  })
}

export function sourceLabel(source: BundleCandidateSource): string {
  if (source.downloadedFrom !== undefined) {
    const url = new URL(source.downloadedFrom)
    return `${url.host}${url.pathname}`.slice(0, 512)
  }
  return path.basename(new URL(source.url).pathname).slice(0, 512) || 'local bundle'
}

export interface BundleCandidateSource {
  readonly url: string
  readonly downloadedFrom?: string
}

export function activeById(active: CordisXPluginActivationRecordV1) {
  return new Map(active.plugins.map(plugin => [plugin.id, plugin]))
}

export function pluginOrder(members: readonly StoredMember[]): readonly StoredMember[] {
  const byId = new Map(members.map(member => [member.pluginId, member]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const result: StoredMember[] = []
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`bundle member dependency cycle at ${id}`)
    if (visited.has(id)) return
    visiting.add(id)
    const member = byId.get(id)!
    for (const dependency of member.dependencies) if (byId.has(dependency.id)) visit(dependency.id)
    visiting.delete(id)
    visited.add(id)
    result.push(member)
  }
  for (const member of members) visit(member.pluginId)
  return result
}

export function emptyState(profileId: string): BundleState {
  return {
    contract: 'cordisx.plugin-bundle-registry/v1',
    profileId,
    revision: 0,
    bundles: {},
    candidates: {},
    directClaims: {},
    pluginOverrides: {},
    permissionFloors: {},
  }
}

export class PluginBundleStore {
  readonly #file: string
  #tail: Promise<void> = Promise.resolve()

  constructor(readonly root: string, readonly profileId: string) {
    this.#file = path.join(root, 'registry.v1.json')
  }

  async open(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') await chmod(this.root, 0o700)
    try {
      await this.load()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await this.write(emptyState(this.profileId))
    }
  }

  async load(): Promise<BundleState> {
    const metadata = await lstat(this.#file)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error('plugin bundle registry must be a regular file')
    }
    const value = JSON.parse(await readFile(this.#file, 'utf8')) as BundleState
    if (
      value.contract !== 'cordisx.plugin-bundle-registry/v1' || value.profileId !== this.profileId
      || !Number.isInteger(value.revision)
    ) {
      throw new Error('plugin bundle registry is invalid')
    }
    return { ...value, permissionFloors: value.permissionFloors ?? {} }
  }

  async update(
    mutate: (draft: {
      revision: number
      bundles: Record<string, BundleRecord>
      candidates: Record<string, BundleCandidate>
      directClaims: Record<string, true>
      pluginOverrides: Record<string, CordisXPluginBundlePolicy>
      permissionFloors: Record<string, CordisXPluginBundlePolicy>
    }) => void,
  ): Promise<BundleState> {
    let result!: BundleState
    const operation = this.#tail.catch(() => undefined).then(async () => {
      const current = await this.load()
      const draft = structuredClone(current) as unknown as Parameters<typeof mutate>[0]
      mutate(draft)
      draft.revision = current.revision + 1
      result = { contract: current.contract, profileId: current.profileId, ...draft }
      await this.write(result)
    })
    this.#tail = operation.then(() => undefined, () => undefined)
    await operation
    return result
  }

  private async write(state: BundleState): Promise<void> {
    const temporary = `${this.#file}.${process.pid}.${randomUUID()}.tmp`
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`)
      await handle.sync()
      await handle.close()
      await rename(temporary, this.#file)
    } finally {
      await handle.close().catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
    }
  }
}

export function overrideKey(pluginId: string, permissionId: string): string {
  return `${pluginId}\u0000${permissionId}`
}

export const policyRank: Readonly<Record<CordisXPluginBundlePolicy, number>> = { allow: 0, ask: 1, deny: 2 }

export function bundlePolicy(value: unknown): value is CordisXPluginBundlePolicy {
  return value === 'allow' || value === 'ask' || value === 'deny'
}

export function effectivePermission(
  state: BundleState,
  member: StoredMember,
  permission: StoredPermission,
): Omit<CordisXPluginBundleManagerPermissionV1, 'bundlePolicy'> & {
  readonly policies: ReadonlyMap<string, CordisXPluginBundlePolicy>
} {
  const policies = new Map<string, CordisXPluginBundlePolicy>()
  for (const bundle of Object.values(state.bundles)) {
    if (
      !bundle.enabled
      || !bundle.members.some(candidate => candidate.pluginId === member.pluginId && candidate.digest === member.digest)
    ) continue
    policies.set(bundle.id, bundle.policies[permission.permissionId] ?? 'ask')
  }
  const affectedBundleIds = [...policies.keys()].sort()
  const merged = policies.size === 0
    ? 'ask'
    : [...policies.values()].reduce<CordisXPluginBundlePolicy>(
      (current, next) => policyRank[next] > policyRank[current] ? next : current,
      'allow',
    )
  const key = overrideKey(member.pluginId, permission.permissionId)
  const pluginOverride = state.pluginOverrides[key]
  const floor = state.permissionFloors[key]
  const floorApplies = pluginOverride === undefined && floor !== undefined && policyRank[floor] > policyRank[merged]
  return {
    permissionId: permission.permissionId,
    pluginId: permission.pluginId,
    capability: permission.capability,
    scopeLabel: permission.scopeLabel,
    required: permission.required,
    ...(pluginOverride === undefined ? {} : { pluginOverride }),
    effectivePolicy: pluginOverride ?? (floorApplies ? floor : merged),
    effectiveSource: pluginOverride !== undefined
      ? 'plugin-override'
      : floorApplies
      ? 'safety-floor'
      : policies.size > 1
      ? 'shared-bundle-merge'
      : 'bundle',
    affectedBundleIds,
    policies,
  }
}

export function claims(state: BundleState, active: CordisXPluginActivationRecordV1, pluginId: string) {
  const output: { pluginId: string; kind: 'bundle' | 'direct' | 'runtime-dependency'; claimantId: string }[] = []
  for (const bundle of Object.values(state.bundles)) {
    if (bundle.members.some(member => member.pluginId === pluginId)) {
      output.push({ pluginId, kind: 'bundle', claimantId: bundle.id })
    }
  }
  if (state.directClaims[pluginId]) output.push({ pluginId, kind: 'direct', claimantId: pluginId })
  for (const plugin of active.plugins) {
    if (plugin.dependencies.some(dependency => dependency.id === pluginId)) {
      output.push({ pluginId, kind: 'runtime-dependency', claimantId: plugin.id })
    }
  }
  return output
}

export function projectBundle(
  state: BundleState,
  bundle: BundleRecord,
  active: CordisXPluginActivationRecordV1,
): CordisXPluginBundleManagerItemV1 {
  const activeMap = activeById(active)
  const members: CordisXPluginBundleManagerItemV1['members'] = bundle.members.map(member => {
    const installed = activeMap.get(member.pluginId)
    const memberClaims = claims(state, active, member.pluginId)
    const bundleIds = memberClaims.filter(claim => claim.kind === 'bundle').map(claim => claim.claimantId).sort()
    const directClaim = memberClaims.some(claim => claim.kind === 'direct')
    const runtimeDependentIds = memberClaims.filter(claim => claim.kind === 'runtime-dependency').map(claim =>
      claim.claimantId
    ).sort()
    const conflict = installed === undefined || installed.version === member.requestedVersion
      ? installed !== undefined && installed.digest !== member.digest
        ? { code: 'digest-mismatch' as const, message: 'The installed digest differs from the bundle member digest.' }
        : undefined
      : {
        code: 'version-mismatch' as const,
        message: `Installed ${installed.version}; bundle requires ${member.requestedVersion}.`,
      }
    const shared = bundleIds.length > 1 || directClaim || runtimeDependentIds.length > 0
    const intended = member.required || (bundle.optionalEnabled[member.pluginId] ?? member.enabledByDefault)
    return {
      pluginId: member.pluginId,
      ...(member.name === undefined ? {} : { name: member.name }),
      requestedVersion: member.requestedVersion,
      ...(installed === undefined ? {} : { installedVersion: installed.version, installedDigest: installed.digest }),
      required: member.required,
      enabledByDefault: member.enabledByDefault,
      enabled: installed?.enabled === true,
      state: conflict === undefined
        ? installed === undefined
          ? 'not-installed'
          : !installed.enabled
          ? 'disabled'
          : shared
          ? 'shared'
          : !intended
          ? 'disabled'
          : 'active'
        : 'version-conflict',
      installedViaBundle: bundleIds.length > 0,
      bundleIds,
      directClaim,
      runtimeDependentIds,
      ...(conflict === undefined ? {} : { conflict }),
    }
  })
  const projectedPermissions = bundle.members.flatMap(member =>
    member.permissions.map(permission => {
      const effective = effectivePermission(state, member, permission)
      return {
        permissionId: effective.permissionId,
        pluginId: effective.pluginId,
        capability: effective.capability,
        scopeLabel: effective.scopeLabel,
        required: effective.required,
        bundlePolicy: bundle.policies[permission.permissionId] ?? 'ask',
        ...(effective.pluginOverride === undefined ? {} : { pluginOverride: effective.pluginOverride }),
        effectivePolicy: effective.effectivePolicy,
        effectiveSource: effective.effectiveSource,
        affectedBundleIds: effective.affectedBundleIds,
      }
    })
  )
  const hasConflict = members.some(member => member.state === 'version-conflict')
  const missingRequired = members.some(member =>
    member.required && (member.state === 'not-installed' || member.state === 'disabled')
  )
  const permissionBlocked = projectedPermissions.some(permission =>
    permission.required && permission.effectivePolicy !== 'allow'
  )
  const status: CordisXPluginBundleManagerItemV1['status'] = !bundle.enabled
    ? 'disabled'
    : hasConflict
    ? 'version-conflict'
    : permissionBlocked
    ? 'permission-blocked'
    : missingRequired
    ? 'partial'
    : 'active'
  const allClaims = bundle.members.flatMap(member => claims(state, active, member.pluginId))
  const dependencies = bundle.members.flatMap(member =>
    member.dependencies.map(dependency => ({
      pluginId: member.pluginId,
      dependencyId: dependency.id,
      version: dependency.version,
    }))
  )
  return {
    id: bundle.id,
    name: bundle.name,
    ...(bundle.description === undefined ? {} : { description: bundle.description }),
    version: bundle.version,
    digest: bundle.digest,
    authors: bundle.authors,
    sourceLabel: bundle.sourceLabel,
    ...(bundle.canonicalSource === undefined ? {} : { canonicalSource: bundle.canonicalSource }),
    installedAt: bundle.installedAt,
    updatedAt: bundle.updatedAt,
    status,
    enabled: bundle.enabled,
    readme: bundle.readme,
    availableOperations: [
      'update',
      bundle.enabled ? 'disable' : 'enable',
      ...(status === 'partial' ? ['repair' as const] : []),
      'uninstall',
    ],
    members,
    permissions: projectedPermissions,
    claims: allClaims,
    dependencies,
    records: bundle.records.slice(-512).reverse(),
  }
}

export interface PluginBundleCoordinatorOptions {
  readonly homeDir: string
  readonly profileId: string
  readonly runtimeGeneration: string
  readonly pluginLifecycle: PluginLifecycleCoordinator
  readonly now?: () => Date
}
