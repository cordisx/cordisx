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

const LOCAL_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const SAFE_DIR = /^\.\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/
const SAFE_README = /^\.\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(?:md|markdown)$/
const SAFE_ICON = /^\.\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(?:png|webp|svg)$/

interface StoredPermission {
  readonly permissionId: string
  readonly pluginId: string
  readonly capability: string
  readonly scope: unknown
  readonly scopeLabel: string
  readonly required: boolean
}

interface StoredMember {
  readonly pluginId: string
  readonly name?: string
  readonly requestedVersion: string
  readonly digest: `sha256:${string}`
  readonly dependencies: readonly { readonly id: string; readonly version: string }[]
  readonly required: boolean
  readonly enabledByDefault: boolean
  readonly permissions: readonly StoredPermission[]
}

interface BundleRecord {
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

interface StoredRecord {
  readonly recordId: string
  readonly at: string
  readonly kind: CordisXPluginBundleLifecycleRequestV1['operation']['kind']
  readonly outcome: CordisXPluginBundleLifecycleResultV1['outcome']
  readonly message: string
  readonly pluginIds: readonly string[]
}

interface BundleCandidate {
  readonly candidateId: string
  readonly createdAt: string
  readonly baseRevision: number
  readonly basePluginRevision: number
  readonly impactToken: string
  readonly record: BundleRecord
  readonly plan: CordisXPluginBundlePlanV1
}

interface BundleState {
  readonly contract: 'cordisx.plugin-bundle-registry/v1'
  readonly profileId: string
  readonly revision: number
  readonly bundles: Readonly<Record<string, BundleRecord>>
  readonly candidates: Readonly<Record<string, BundleCandidate>>
  readonly directClaims: Readonly<Record<string, true>>
  readonly pluginOverrides: Readonly<Record<string, CordisXPluginBundlePolicy>>
  readonly permissionFloors: Readonly<Record<string, CordisXPluginBundlePolicy>>
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const accepted = new Set(allowed)
  const unknown = Object.keys(value).find(key => !accepted.has(key))
  if (unknown !== undefined) throw new Error(`${label}.${unknown} is unsupported`)
}

function text(value: unknown, label: string, max = 512): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) throw new Error(`${label} must be a bounded string`)
  return value
}

async function contained(root: string, relative: string, pattern: RegExp, label: string): Promise<string> {
  if (!pattern.test(relative) || relative.includes('..')) throw new Error(`${label} must be bundle-relative`)
  const canonicalRoot = `${await realpath(root)}${path.sep}`
  const target = await realpath(path.resolve(root, relative.slice(2))).catch(() => { throw new Error(`${label} does not exist`) })
  if (!target.startsWith(canonicalRoot)) throw new Error(`${label} escapes the bundle root`)
  return target
}

function parseManifest(value: unknown): CordisXPluginBundleManifestV1 {
  const manifest = object(value, 'bundle manifest')
  exactKeys(manifest, ['$schema', 'schemaVersion', 'id', 'name', 'description', 'version', 'authors', 'readme', 'icon', 'canonicalSource', 'distribution', 'members'], 'bundle manifest')
  if (manifest.$schema !== CORDISX_PLUGIN_BUNDLE_SCHEMA_V1 || manifest.schemaVersion !== 1) throw new Error('bundle manifest schema is unsupported')
  const id = text(manifest.id, 'bundle id', 96)
  const name = text(manifest.name, 'bundle name', 128)
  const version = text(manifest.version, 'bundle version', 64)
  if (!LOCAL_ID.test(id) || !SEMVER.test(version)) throw new Error('bundle identity is invalid')
  if (!Array.isArray(manifest.authors) || manifest.authors.length < 1 || manifest.authors.length > 16) throw new Error('bundle authors are invalid')
  const authors = manifest.authors.map((author, index) => text(author, `authors[${index}]`, 128))
  if (new Set(authors).size !== authors.length) throw new Error('bundle authors are duplicated')
  const distribution = object(manifest.distribution, 'bundle distribution')
  exactKeys(distribution, ['mode', 'signature'], 'bundle distribution')
  if (distribution.mode !== 'explicit-local-v1' || distribution.signature !== 'unsupported') throw new Error('bundle distribution is unsupported')
  if (!Array.isArray(manifest.members) || manifest.members.length < 1 || manifest.members.length > 64) throw new Error('bundle members are invalid')
  const memberIds = new Set<string>()
  const memberPaths = new Set<string>()
  const members = manifest.members.map((entry, index) => {
    const item = object(entry, `members[${index}]`)
    exactKeys(item, ['id', 'version', 'path', 'required', 'enabledByDefault'], `members[${index}]`)
    const memberId = text(item.id, `members[${index}].id`, 96)
    const memberVersion = text(item.version, `members[${index}].version`, 64)
    const memberPath = text(item.path, `members[${index}].path`, 512)
    if (!LOCAL_ID.test(memberId) || !SEMVER.test(memberVersion) || !SAFE_DIR.test(memberPath)
      || memberIds.has(memberId) || memberPaths.has(memberPath)) throw new Error(`members[${index}] identity/path is invalid or duplicated`)
    if (typeof item.required !== 'boolean' || typeof item.enabledByDefault !== 'boolean' || (item.required && !item.enabledByDefault)) {
      throw new Error(`members[${index}] enable policy is invalid`)
    }
    memberIds.add(memberId)
    memberPaths.add(memberPath)
    return { id: memberId, version: memberVersion, path: memberPath, required: item.required, enabledByDefault: item.enabledByDefault }
  })
  const readme = text(manifest.readme, 'bundle readme', 512)
  if (!SAFE_README.test(readme)) throw new Error('bundle readme path is invalid')
  const icon = manifest.icon === undefined ? undefined : text(manifest.icon, 'bundle icon', 512)
  if (icon !== undefined && !SAFE_ICON.test(icon)) throw new Error('bundle icon path is invalid')
  const canonicalSource = manifest.canonicalSource === undefined ? undefined : text(manifest.canonicalSource, 'canonical source', 2048)
  if (canonicalSource !== undefined && !/^https:\/\/[^?#]+$/.test(canonicalSource)) throw new Error('canonical source must be public HTTPS without query or fragment')
  return {
    $schema: CORDISX_PLUGIN_BUNDLE_SCHEMA_V1,
    schemaVersion: 1,
    id,
    name,
    ...(manifest.description === undefined ? {} : { description: text(manifest.description, 'bundle description', 512) }),
    version,
    authors,
    readme,
    ...(icon === undefined ? {} : { icon }),
    ...(canonicalSource === undefined ? {} : { canonicalSource }),
    distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
    members,
  }
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex')
}

function appendRecord(
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

function permissions(staged: StagedPluginPackage): readonly StoredPermission[] {
  return staged.manifest.runtimeManifest.capabilities.flatMap((raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return []
    const item = raw as unknown as Record<string, unknown>
    if (typeof item.name !== 'string' || typeof item.required !== 'boolean' || item.scope === undefined) return []
    if (item.name.startsWith('agents.') || item.name.startsWith('sessions.') || item.name.startsWith('approvals.')) return []
    const scopeLabel = JSON.stringify(item.scope)
    return [{
      permissionId: pluginBundlePermissionId({ pluginId: staged.manifest.id, digest: staged.digest, capability: item.name, scope: item.scope }),
      pluginId: staged.manifest.id,
      capability: item.name,
      scope: structuredClone(item.scope),
      scopeLabel: scopeLabel.length > 512 ? `${scopeLabel.slice(0, 509)}...` : scopeLabel,
      required: item.required,
    }]
  })
}

function sourceLabel(source: BundleCandidateSource): string {
  if (source.downloadedFrom !== undefined) {
    const url = new URL(source.downloadedFrom)
    return `${url.host}${url.pathname}`.slice(0, 512)
  }
  return path.basename(new URL(source.url).pathname).slice(0, 512) || 'local bundle'
}

interface BundleCandidateSource { readonly url: string; readonly downloadedFrom?: string }

function activeById(active: CordisXPluginActivationRecordV1) {
  return new Map(active.plugins.map(plugin => [plugin.id, plugin]))
}

function pluginOrder(members: readonly StoredMember[]): readonly StoredMember[] {
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

function emptyState(profileId: string): BundleState {
  return { contract: 'cordisx.plugin-bundle-registry/v1', profileId, revision: 0, bundles: {}, candidates: {}, directClaims: {}, pluginOverrides: {}, permissionFloors: {} }
}

class PluginBundleStore {
  readonly #file: string
  #tail: Promise<void> = Promise.resolve()

  constructor(readonly root: string, readonly profileId: string) {
    this.#file = path.join(root, 'registry.v1.json')
  }

  async open(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') await chmod(this.root, 0o700)
    try { await this.load() } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await this.write(emptyState(this.profileId))
    }
  }

  async load(): Promise<BundleState> {
    const metadata = await lstat(this.#file)
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('plugin bundle registry must be a regular file')
    const value = JSON.parse(await readFile(this.#file, 'utf8')) as BundleState
    if (value.contract !== 'cordisx.plugin-bundle-registry/v1' || value.profileId !== this.profileId || !Number.isInteger(value.revision)) {
      throw new Error('plugin bundle registry is invalid')
    }
    return { ...value, permissionFloors: value.permissionFloors ?? {} }
  }

  async update(mutate: (draft: {
    revision: number
    bundles: Record<string, BundleRecord>
    candidates: Record<string, BundleCandidate>
    directClaims: Record<string, true>
    pluginOverrides: Record<string, CordisXPluginBundlePolicy>
    permissionFloors: Record<string, CordisXPluginBundlePolicy>
  }) => void): Promise<BundleState> {
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

function overrideKey(pluginId: string, permissionId: string): string {
  return `${pluginId}\u0000${permissionId}`
}

const policyRank: Readonly<Record<CordisXPluginBundlePolicy, number>> = { allow: 0, ask: 1, deny: 2 }

function bundlePolicy(value: unknown): value is CordisXPluginBundlePolicy {
  return value === 'allow' || value === 'ask' || value === 'deny'
}

function effectivePermission(state: BundleState, member: StoredMember, permission: StoredPermission): Omit<CordisXPluginBundleManagerPermissionV1, 'bundlePolicy'> & { readonly policies: ReadonlyMap<string, CordisXPluginBundlePolicy> } {
  const policies = new Map<string, CordisXPluginBundlePolicy>()
  for (const bundle of Object.values(state.bundles)) {
    if (!bundle.enabled || !bundle.members.some(candidate => candidate.pluginId === member.pluginId && candidate.digest === member.digest)) continue
    policies.set(bundle.id, bundle.policies[permission.permissionId] ?? 'ask')
  }
  const affectedBundleIds = [...policies.keys()].sort()
  const merged = policies.size === 0 ? 'ask' : [...policies.values()].reduce<CordisXPluginBundlePolicy>((current, next) => policyRank[next] > policyRank[current] ? next : current, 'allow')
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
    effectiveSource: pluginOverride !== undefined ? 'plugin-override' : floorApplies ? 'safety-floor' : policies.size > 1 ? 'shared-bundle-merge' : 'bundle',
    affectedBundleIds,
    policies,
  }
}

function claims(state: BundleState, active: CordisXPluginActivationRecordV1, pluginId: string) {
  const output: { pluginId: string; kind: 'bundle' | 'direct' | 'runtime-dependency'; claimantId: string }[] = []
  for (const bundle of Object.values(state.bundles)) if (bundle.members.some(member => member.pluginId === pluginId)) output.push({ pluginId, kind: 'bundle', claimantId: bundle.id })
  if (state.directClaims[pluginId]) output.push({ pluginId, kind: 'direct', claimantId: pluginId })
  for (const plugin of active.plugins) if (plugin.dependencies.some(dependency => dependency.id === pluginId)) output.push({ pluginId, kind: 'runtime-dependency', claimantId: plugin.id })
  return output
}

function projectBundle(state: BundleState, bundle: BundleRecord, active: CordisXPluginActivationRecordV1): CordisXPluginBundleManagerItemV1 {
  const activeMap = activeById(active)
  const members: CordisXPluginBundleManagerItemV1['members'] = bundle.members.map(member => {
    const installed = activeMap.get(member.pluginId)
    const memberClaims = claims(state, active, member.pluginId)
    const bundleIds = memberClaims.filter(claim => claim.kind === 'bundle').map(claim => claim.claimantId).sort()
    const directClaim = memberClaims.some(claim => claim.kind === 'direct')
    const runtimeDependentIds = memberClaims.filter(claim => claim.kind === 'runtime-dependency').map(claim => claim.claimantId).sort()
    const conflict = installed === undefined || installed.version === member.requestedVersion
      ? installed !== undefined && installed.digest !== member.digest
        ? { code: 'digest-mismatch' as const, message: 'The installed digest differs from the bundle member digest.' }
        : undefined
      : { code: 'version-mismatch' as const, message: `Installed ${installed.version}; bundle requires ${member.requestedVersion}.` }
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
        ? installed === undefined ? 'not-installed'
          : !installed.enabled ? 'disabled'
            : shared ? 'shared'
              : !intended ? 'disabled' : 'active'
        : 'version-conflict',
      installedViaBundle: bundleIds.length > 0,
      bundleIds,
      directClaim,
      runtimeDependentIds,
      ...(conflict === undefined ? {} : { conflict }),
    }
  })
  const projectedPermissions = bundle.members.flatMap(member => member.permissions.map(permission => {
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
  }))
  const hasConflict = members.some(member => member.state === 'version-conflict')
  const missingRequired = members.some(member => member.required && (member.state === 'not-installed' || member.state === 'disabled'))
  const permissionBlocked = projectedPermissions.some(permission => permission.required && permission.effectivePolicy !== 'allow')
  const status: CordisXPluginBundleManagerItemV1['status'] = !bundle.enabled ? 'disabled' : hasConflict ? 'version-conflict' : permissionBlocked ? 'permission-blocked' : missingRequired ? 'partial' : 'active'
  const allClaims = bundle.members.flatMap(member => claims(state, active, member.pluginId))
  const dependencies = bundle.members.flatMap(member => member.dependencies.map(dependency => ({ pluginId: member.pluginId, dependencyId: dependency.id, version: dependency.version })))
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

export class PluginBundleCoordinator {
  readonly #store: PluginBundleStore
  readonly #ready: Promise<void>
  readonly #now: () => Date

  constructor(readonly options: PluginBundleCoordinatorOptions) {
    this.#store = new PluginBundleStore(path.join(options.homeDir, 'state', 'profiles', options.profileId, 'plugin-bundles'), options.profileId)
    this.#ready = this.#store.open()
    this.#now = options.now ?? (() => new Date())
  }

  async snapshot(operationsAvailable = true): Promise<CordisXPluginBundleManagerSnapshotV1> {
    await this.#ready
    const [state, active] = await Promise.all([this.#store.load(), this.options.pluginLifecycle.store.loadActive()])
    return {
      $schema: CORDISX_PLUGIN_BUNDLE_MANAGER_SNAPSHOT_SCHEMA_V1,
      schemaVersion: 1,
      profileId: this.options.profileId,
      revision: state.revision,
      pluginRevision: active.revision,
      runtimeGeneration: this.options.runtimeGeneration,
      operationsAvailable,
      bundles: Object.values(state.bundles).sort((left, right) => left.name.localeCompare(right.name)).map(bundle => projectBundle(state, bundle, active)),
    }
  }

  async bundleClaims(pluginId: string): Promise<readonly string[]> {
    await this.#ready
    const state = await this.#store.load()
    return Object.values(state.bundles).filter(bundle => bundle.members.some(member => member.pluginId === pluginId)).map(bundle => bundle.id).sort()
  }

  async handle(request: CordisXPluginBundleLifecycleRequestV1): Promise<CordisXPluginBundleLifecycleResultV1> {
    await this.#ready
    const [state, active] = await Promise.all([this.#store.load(), this.options.pluginLifecycle.store.loadActive()])
    if (request.profileId !== this.options.profileId || request.runtimeGeneration !== this.options.runtimeGeneration) return this.failure(request, state, active, 'stale-generation', 'The bundle runtime generation is stale.', 'conflict')
    if (request.expectedRevision !== state.revision || request.expectedPluginRevision !== active.revision) return this.failure(request, state, active, 'stale-revision', 'The bundle or plugin registry revision is stale.', 'conflict')
    try {
      const operation = request.operation
      if (operation.kind === 'inspect-source') return await this.inspect({ ...request, operation }, state, active)
      if (operation.kind === 'install' || operation.kind === 'update') return await this.install({ ...request, operation }, state, active)
      if (operation.kind === 'set-permissions') return await this.setPermissions({ ...request, operation }, state, active)
      if (operation.kind === 'set-optional-member') return await this.setOptionalMember({ ...request, operation }, state, active)
      if (operation.kind === 'adopt-member') return await this.adoptMember({ ...request, operation }, state, active)
      if (operation.kind === 'enable' || operation.kind === 'disable' || operation.kind === 'uninstall') {
        return await this.changeBundleState({ ...request, operation }, state, active)
      }
      throw new Error('plugin bundle operation is unsupported')
    } catch (error) {
      return this.failure(request, await this.#store.load(), await this.options.pluginLifecycle.store.loadActive(), 'apply-failed', error instanceof Error ? error.message : String(error), 'rejected')
    }
  }

  private base(request: CordisXPluginBundleLifecycleRequestV1, state: BundleState, active: CordisXPluginActivationRecordV1) {
    return {
      $schema: CORDISX_PLUGIN_BUNDLE_LIFECYCLE_RESULT_SCHEMA_V1,
      schemaVersion: 1 as const,
      requestId: request.requestId,
      profileId: request.profileId,
      operation: request.operation.kind,
      revision: state.revision,
      pluginRevision: active.revision,
      runtimeGeneration: active.runtimeGeneration,
    }
  }

  private failure(
    request: CordisXPluginBundleLifecycleRequestV1,
    state: BundleState,
    active: CordisXPluginActivationRecordV1,
    code: NonNullable<CordisXPluginBundleLifecycleResultV1['error']>['code'],
    message: string,
    outcome: CordisXPluginBundleLifecycleResultV1['outcome'],
  ): CordisXPluginBundleLifecycleResultV1 {
    return { ...this.base(request, state, active), outcome, affectedPluginIds: [], retainedPluginIds: [], removedPluginIds: [], error: { code, message } }
  }

  private async inspect(
    request: CordisXPluginBundleLifecycleRequestV1 & { readonly operation: { readonly kind: 'inspect-source'; readonly source: Parameters<typeof resolvePluginPackageSourceV1>[0] } },
    state: BundleState,
    active: CordisXPluginActivationRecordV1,
  ): Promise<CordisXPluginBundleLifecycleResultV1> {
    const snapshotter = new PluginPackageSourceSnapshotter(path.join(this.options.homeDir, 'bundles', '.source-staging'))
    const snapshot = await snapshotter.snapshot(resolvePluginPackageSourceV1(request.operation.source), `bundle-${randomUUID()}`)
    try {
      const manifestFile = await contained(snapshot.payloadDirectory, './cordisx-bundle.json', /^\.\/cordisx-bundle\.json$/, 'bundle manifest')
      const manifest = parseManifest(JSON.parse(await readFile(manifestFile, 'utf8')))
      const readmeFile = await contained(snapshot.payloadDirectory, manifest.readme, SAFE_README, 'bundle readme')
      const readme = await readFile(readmeFile, 'utf8')
      if (readme.length > 262_144) throw new Error('bundle README exceeds 256 KiB')
      if (manifest.icon !== undefined) await contained(snapshot.payloadDirectory, manifest.icon, SAFE_ICON, 'bundle icon')
      const members: StoredMember[] = []
      for (const declared of manifest.members) {
        const memberDirectory = await contained(snapshot.payloadDirectory, declared.path, SAFE_DIR, `member ${declared.id}`)
        const staged = await this.options.pluginLifecycle.stagePackageSource({ kind: 'local-directory', location: pathToFileURL(memberDirectory).href })
        if (staged.manifest.id !== declared.id || staged.manifest.version !== declared.version) throw new Error(`member ${declared.id} package identity differs from the bundle declaration`)
        members.push({
          pluginId: declared.id,
          ...(staged.manifest.runtimeManifest.name === undefined ? {} : { name: staged.manifest.runtimeManifest.name }),
          requestedVersion: declared.version,
          digest: staged.digest,
          dependencies: staged.manifest.dependencies,
          required: declared.required,
          enabledByDefault: declared.enabledByDefault,
          permissions: permissions(staged),
        })
      }
      pluginOrder(members)
      const activeMap = activeById(active)
      for (const member of members) {
        for (const dependency of member.dependencies) {
          const bundled = members.find(candidate => candidate.pluginId === dependency.id)
          const installed = activeMap.get(dependency.id)
          if ((bundled === undefined || bundled.requestedVersion !== dependency.version)
            && (installed === undefined || installed.version !== dependency.version)) {
            throw new Error(`member ${member.pluginId} requires missing exact dependency ${dependency.id}@${dependency.version}`)
          }
        }
      }
      const existingBundle = state.bundles[manifest.id]
      const memberActions: CordisXPluginBundlePlanV1['memberActions'][number][] = []
      const conflicts: CordisXPluginBundlePlanV1['conflicts'][number][] = []
      const existingMemberIds = new Set(existingBundle?.members.map(member => member.pluginId) ?? [])
      const externalClaims = (pluginId: string) => claims(state, active, pluginId).filter(claim => (
        (claim.kind === 'bundle' && claim.claimantId !== existingBundle?.id)
        || claim.kind === 'direct'
        || (claim.kind === 'runtime-dependency' && !existingMemberIds.has(claim.claimantId))
      ))
      for (const member of members) {
        const installed = activeMap.get(member.pluginId)
        if (installed === undefined) memberActions.push({ pluginId: member.pluginId, version: member.requestedVersion, action: 'install', reason: member.required ? 'bundle-required' : 'bundle-optional' })
        else if (installed.version !== member.requestedVersion || installed.digest !== member.digest) {
          if (existingBundle?.members.some(previous => previous.pluginId === member.pluginId) && externalClaims(member.pluginId).length === 0) {
            memberActions.push({ pluginId: member.pluginId, version: member.requestedVersion, action: 'update', reason: member.required ? 'bundle-required' : 'bundle-optional' })
          } else if (installed.version !== member.requestedVersion) conflicts.push({ pluginId: member.pluginId, code: 'version-mismatch', message: `Installed ${installed.version}; bundle requires ${member.requestedVersion}.` })
          else conflicts.push({ pluginId: member.pluginId, code: 'digest-mismatch', message: `The same version is installed with digest ${installed.digest}; the bundle requires ${member.digest}.` })
        }
        else {
          const memberClaims = claims(state, active, member.pluginId)
          const reason = state.directClaims[member.pluginId] ? 'direct-claim'
            : memberClaims.some(claim => claim.kind === 'bundle') ? 'other-bundle-claim' : 'existing-exact'
          memberActions.push({ pluginId: member.pluginId, version: member.requestedVersion, action: 'share', reason })
        }
      }
      const nextMemberIds = new Set(members.map(member => member.pluginId))
      const removedMembers = existingBundle?.members.filter(member => !nextMemberIds.has(member.pluginId)) ?? []
      for (const member of removedMembers) {
        const external = externalClaims(member.pluginId)
        const futureRuntimeDependency = members.some(candidate => candidate.dependencies.some(dependency => dependency.id === member.pluginId))
        const retained = external.length > 0 || futureRuntimeDependency
        const reason = state.directClaims[member.pluginId] ? 'direct-claim'
          : external.some(claim => claim.kind === 'bundle') ? 'other-bundle-claim'
            : retained ? 'runtime-dependency' : 'orphaned'
        memberActions.push({ pluginId: member.pluginId, version: member.requestedVersion, action: retained ? 'retain' : 'remove', reason })
      }
      const now = this.#now().toISOString()
      const record: BundleRecord = {
        id: manifest.id,
        name: manifest.name,
        ...(manifest.description === undefined ? {} : { description: manifest.description }),
        version: manifest.version,
        digest: snapshot.integrity,
        authors: manifest.authors,
        sourceLabel: sourceLabel(snapshot.source),
        ...(manifest.canonicalSource === undefined ? {} : { canonicalSource: manifest.canonicalSource }),
        readme,
        installedAt: existingBundle?.installedAt ?? now,
        updatedAt: now,
        enabled: true,
        optionalEnabled: Object.fromEntries(members.filter(member => !member.required).map(member => [member.pluginId, member.enabledByDefault])),
        policies: existingBundle?.policies ?? {},
        members,
        records: existingBundle?.records ?? [],
      }
      const plan: CordisXPluginBundlePlanV1 = {
        bundle: { id: manifest.id, name: manifest.name, version: manifest.version, digest: snapshot.integrity, authors: manifest.authors },
        memberActions,
        permissionRequests: members.flatMap(member => member.permissions.map(permission => ({
          permissionId: permission.permissionId,
          pluginId: permission.pluginId,
          capability: permission.capability,
          scopeLabel: permission.scopeLabel,
          required: permission.required,
          defaultPolicy: 'ask' as const,
        }))),
        conflicts,
      }
      const candidateId = `bundle-${randomUUID()}`
      const impactToken = `bundle-impact-${hash([state.revision, active.revision, record.id, record.digest, plan])}`
      const candidate: BundleCandidate = { candidateId, createdAt: now, baseRevision: state.revision, basePluginRevision: active.revision, impactToken, record, plan }
      const next = await this.#store.update(draft => { draft.candidates[candidateId] = candidate })
      return {
        ...this.base(request, next, active),
        outcome: conflicts.length === 0 ? 'planned' : 'conflict',
        bundleId: manifest.id,
        candidateId,
        impactToken,
        affectedPluginIds: memberActions.filter(action => !['share', 'retain'].includes(action.action)).map(action => action.pluginId),
        retainedPluginIds: memberActions.filter(action => action.action === 'share' || action.action === 'retain').map(action => action.pluginId),
        removedPluginIds: memberActions.filter(action => action.action === 'remove').map(action => action.pluginId),
        plan,
        ...(conflicts.length === 0 ? {} : { error: { code: 'version-conflict' as const, message: 'One or more bundle members conflict with the active profile.' } }),
      }
    } finally {
      await snapshotter.discard(snapshot)
    }
  }

  private policyFor(record: BundleRecord, state: BundleState, permission: StoredPermission): CordisXPluginBundlePolicy {
    const key = overrideKey(permission.pluginId, permission.permissionId)
    const override = state.pluginOverrides[key]
    if (override !== undefined) return override
    const policies = Object.values(state.bundles)
      .filter(bundle => bundle.enabled && bundle.members.some(member => member.pluginId === permission.pluginId && member.permissions.some(item => item.permissionId === permission.permissionId)))
      .map(bundle => bundle.id === record.id ? record.policies[permission.permissionId] ?? 'ask' : bundle.policies[permission.permissionId] ?? 'ask')
    if (!state.bundles[record.id]?.enabled) policies.push(record.policies[permission.permissionId] ?? 'ask')
    const merged = policies.reduce<CordisXPluginBundlePolicy>((current, next) => policyRank[next] > policyRank[current] ? next : current, 'allow')
    const floor = state.permissionFloors[key]
    return floor !== undefined && policyRank[floor] > policyRank[merged] ? floor : merged
  }

  private async applyStaged(
    staged: StagedPluginPackage,
    record: BundleRecord,
    state: BundleState,
  ): Promise<CordisXPluginLifecycleResultV1> {
    const planned = await this.options.pluginLifecycle.inspectStagedPackage(staged)
    if (planned.outcome !== 'planned' || planned.candidateId === undefined) throw new Error(planned.error?.message ?? `could not plan ${staged.manifest.id}`)
    const active = await this.options.pluginLifecycle.store.loadActive()
    const common = { profileId: this.options.profileId, runtimeGeneration: this.options.runtimeGeneration, expectedRevision: active.revision }
    const policy = (capability: string, scope: unknown): CordisXPluginBundlePolicy => {
      const id = pluginBundlePermissionId({ pluginId: staged.manifest.id, digest: staged.digest, capability, scope })
      const permission = record.members.flatMap(member => member.permissions).find(item => item.permissionId === id)
      return permission === undefined ? 'ask' : this.policyFor(record, state, permission)
    }
    if (planned.authorizationPlan !== undefined) {
      const plan = planned.authorizationPlan
      const decision: CordisXPermissionAuthorizationDecisionV1 = {
        $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V1,
        schemaVersion: 1,
        planId: plan.planId,
        operation: plan.operation,
        profileId: plan.profileId,
        identity: plan.identity,
        decisions: plan.declarations.map(item => ({ capability: item.capability, scope: item.scope, decision: policy(item.capability, item.scope) === 'allow' ? 'allow' : 'deny' })),
      }
      return await this.options.pluginLifecycle.handleBundleOperation({
        $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-lifecycle-operation.v1.schema.json',
        schemaVersion: 1,
        requestId: `bundle-apply-${randomUUID()}`,
        ...common,
        operation: { kind: planned.operation as 'install' | 'update', candidateId: planned.candidateId, authorizationDecision: decision },
      })
    }
    if (staged.manifest.runtimeManifest.schemaVersion === 4) {
      const plan = await this.options.pluginLifecycle.permissionReviewPlanV2({
        requestId: `bundle-plan-${randomUUID()}`, ...common, target: { kind: 'candidate', candidateId: planned.candidateId },
      })
      if (plan === undefined) throw new Error('manifest-v4 permission plan is unavailable')
      const decision: CordisXPermissionAuthorizationDecisionV2 = {
        $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
        schemaVersion: 2,
        planId: plan.planId,
        operation: plan.operation,
        profileId: plan.profileId,
        identity: plan.identity,
        binding: plan.binding,
        decisions: plan.declarations.filter(item => item.decisionRequired).map(item => ({
          capability: item.capability,
          scope: item.scope,
          securityFingerprint: item.securityFingerprint,
          decision: this.decisionV2(item, policy(item.capability, item.scope)),
        })),
      }
      return await this.options.pluginLifecycle.applyPermissionReviewV2({ requestId: `bundle-apply-${randomUUID()}`, ...common, decision })
    }
    if (staged.manifest.runtimeManifest.schemaVersion !== 5 && staged.manifest.runtimeManifest.schemaVersion !== 6) {
      throw new Error('bundle members must use runtime manifest v1, v4, v5, or v6')
    }
    const plan = await this.options.pluginLifecycle.permissionReviewPlanV4({
      requestId: `bundle-plan-${randomUUID()}`, ...common, target: { kind: 'candidate', candidateId: planned.candidateId },
    })
    if (plan === undefined) throw new Error('manifest-v5/v6 permission plan is unavailable')
    const decision: CordisXPermissionAuthorizationDecisionV4 = {
      $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V4,
      schemaVersion: 4,
      origin: 'explicit-user',
      planId: plan.planId,
      operation: plan.operation,
      profileId: plan.profileId,
      identity: plan.identity,
      binding: plan.binding,
      decisions: plan.declarations.filter(item => item.decisionRequired).map(item => ({
        capability: item.capability,
        scope: item.scope,
        securityFingerprint: item.securityFingerprint,
        decision: this.decisionV2(item, policy(item.capability, item.scope)),
      })),
    }
    return await this.options.pluginLifecycle.applyPermissionReviewV4({ requestId: `bundle-apply-${randomUUID()}`, ...common, decision })
  }

  private async enablePlugin(staged: StagedPluginPackage, record: BundleRecord, state: BundleState): Promise<CordisXPluginLifecycleResultV1> {
    const active = await this.options.pluginLifecycle.store.loadActive()
    const current = active.plugins.find(plugin => plugin.id === staged.manifest.id)
    if (current === undefined) return await this.applyStaged(staged, record, state)
    if (current.enabled) throw new Error(`${current.id} is already enabled`)
    if (current.digest !== staged.digest) throw new Error(`${current.id} no longer matches the bundle digest`)
    const common = { profileId: this.options.profileId, runtimeGeneration: this.options.runtimeGeneration, expectedRevision: active.revision }
    if (staged.manifest.runtimeManifest.schemaVersion === 1) {
      const preview = await this.options.pluginLifecycle.handleBundleOperation({
        $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-lifecycle-operation.v1.schema.json', schemaVersion: 1,
        requestId: `bundle-enable-plan-${randomUUID()}`, ...common, operation: { kind: 'enable', pluginId: staged.manifest.id },
      })
      if (preview.outcome !== 'planned' || preview.authorizationPlan === undefined) throw new Error(preview.error?.message ?? `could not plan enable for ${staged.manifest.id}`)
      const decision: CordisXPermissionAuthorizationDecisionV1 = {
        $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V1,
        schemaVersion: 1,
        planId: preview.authorizationPlan.planId,
        operation: preview.authorizationPlan.operation,
        profileId: preview.authorizationPlan.profileId,
        identity: preview.authorizationPlan.identity,
        decisions: preview.authorizationPlan.declarations.map(item => {
          const permission = record.members.flatMap(member => member.permissions).find(candidate => candidate.permissionId === pluginBundlePermissionId({ pluginId: staged.manifest.id, digest: staged.digest, capability: item.capability, scope: item.scope }))
          return { capability: item.capability, scope: item.scope, decision: permission !== undefined && this.policyFor(record, state, permission) === 'allow' ? 'allow' as const : 'deny' as const }
        }),
      }
      const latest = await this.options.pluginLifecycle.store.loadActive()
      return await this.options.pluginLifecycle.handleBundleOperation({
        $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-lifecycle-operation.v1.schema.json', schemaVersion: 1,
        requestId: `bundle-enable-${randomUUID()}`, profileId: this.options.profileId, runtimeGeneration: this.options.runtimeGeneration,
        expectedRevision: latest.revision, operation: { kind: 'enable', pluginId: staged.manifest.id, authorizationDecision: decision },
      })
    }
    if (staged.manifest.runtimeManifest.schemaVersion === 4) {
      const plan = await this.options.pluginLifecycle.permissionReviewPlanV2({ requestId: `bundle-enable-plan-${randomUUID()}`, ...common, target: { kind: 'enable', pluginId: staged.manifest.id } })
      if (plan === undefined) throw new Error('manifest-v4 enable permission plan is unavailable')
      const decision: CordisXPermissionAuthorizationDecisionV2 = {
        $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2, schemaVersion: 2,
        planId: plan.planId, operation: plan.operation, profileId: plan.profileId, identity: plan.identity, binding: plan.binding,
        decisions: plan.declarations.filter(item => item.decisionRequired).map(item => ({
          capability: item.capability, scope: item.scope, securityFingerprint: item.securityFingerprint,
          decision: this.decisionV2(item, this.permissionPolicy(record, state, staged, item.capability, item.scope)),
        })),
      }
      return await this.options.pluginLifecycle.applyPermissionReviewV2({ requestId: `bundle-enable-${randomUUID()}`, ...common, decision })
    }
    if (staged.manifest.runtimeManifest.schemaVersion !== 5 && staged.manifest.runtimeManifest.schemaVersion !== 6) {
      throw new Error('bundle members must use runtime manifest v1, v4, v5, or v6')
    }
    const plan = await this.options.pluginLifecycle.permissionReviewPlanV4({ requestId: `bundle-enable-plan-${randomUUID()}`, ...common, target: { kind: 'enable', pluginId: staged.manifest.id } })
    if (plan === undefined) throw new Error('manifest-v5/v6 enable permission plan is unavailable')
    const decision: CordisXPermissionAuthorizationDecisionV4 = {
      $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V4, schemaVersion: 4, origin: 'explicit-user',
      planId: plan.planId, operation: plan.operation, profileId: plan.profileId, identity: plan.identity, binding: plan.binding,
      decisions: plan.declarations.filter(item => item.decisionRequired).map(item => ({
        capability: item.capability, scope: item.scope, securityFingerprint: item.securityFingerprint,
        decision: this.decisionV2(item, this.permissionPolicy(record, state, staged, item.capability, item.scope)),
      })),
    }
    return await this.options.pluginLifecycle.applyPermissionReviewV4({ requestId: `bundle-enable-${randomUUID()}`, ...common, decision })
  }

  private permissionPolicy(record: BundleRecord, state: BundleState, staged: StagedPluginPackage, capability: string, scope: unknown): CordisXPluginBundlePolicy {
    const permissionId = pluginBundlePermissionId({ pluginId: staged.manifest.id, digest: staged.digest, capability, scope })
    const permission = record.members.flatMap(member => member.permissions).find(item => item.permissionId === permissionId)
    return permission === undefined ? 'ask' : this.policyFor(record, state, permission)
  }

  private decisionV2(item: Pick<CordisXPermissionAuthorizationItemV4, 'allowedDecisions' | 'defaultDecision'>, policy: CordisXPluginBundlePolicy): CordisXPermissionDecisionV2 {
    const preferred = policy === 'allow' ? ['allow-persistent', 'allow-once'] as const : ['deny-persistent', 'deny-once'] as const
    return preferred.find(decision => item.allowedDecisions.includes(decision)) ?? item.defaultDecision
  }

  private async install(
    request: CordisXPluginBundleLifecycleRequestV1 & { readonly operation: Extract<CordisXPluginBundleLifecycleRequestV1['operation'], { readonly kind: 'install' | 'update' }> },
    state: BundleState,
    active: CordisXPluginActivationRecordV1,
  ): Promise<CordisXPluginBundleLifecycleResultV1> {
    const candidate = state.candidates[request.operation.candidateId]
    if (candidate === undefined || candidate.impactToken !== request.operation.impactToken
      || candidate.baseRevision !== state.revision - 1 || candidate.basePluginRevision !== active.revision) {
      return this.failure(request, state, active, 'impact-changed', 'The bundle install plan is stale.', 'conflict')
    }
    const existingBundle = state.bundles[candidate.record.id]
    const expectedOperation = existingBundle === undefined ? 'install' : 'update'
    if (request.operation.kind !== expectedOperation) return this.failure(request, state, active, 'operation-unavailable', `This candidate requires ${expectedOperation}.`, 'rejected')
    if (candidate.plan.conflicts.length > 0) return this.failure(request, state, active, 'version-conflict', 'The bundle has unresolved member conflicts.', 'conflict')
    const candidatePermissions = new Map(candidate.record.members.flatMap(member => member.permissions).map(permission => [permission.permissionId, permission]))
    const bundlePermissionIds = request.operation.bundlePermissions.map(item => item.permissionId)
    const overrideKeys = request.operation.pluginOverrides.map(item => overrideKey(item.pluginId, item.permissionId))
    if (new Set(bundlePermissionIds).size !== bundlePermissionIds.length
      || new Set(overrideKeys).size !== overrideKeys.length
      || request.operation.bundlePermissions.some(item => !candidatePermissions.has(item.permissionId) || !bundlePolicy(item.policy))
      || request.operation.pluginOverrides.some(item => candidatePermissions.get(item.permissionId)?.pluginId !== item.pluginId || !bundlePolicy(item.policy))) {
      return this.failure(request, state, active, 'permission-review-required', 'A bundle permission choice is invalid, duplicated, or stale.', 'rejected')
    }
    const policies = Object.fromEntries(request.operation.bundlePermissions.map(item => [item.permissionId, item.policy]))
    const overrides = Object.fromEntries(request.operation.pluginOverrides.map(item => [overrideKey(item.pluginId, item.permissionId), item.policy]))
    const record: BundleRecord = { ...candidate.record, policies }
    const previewState: BundleState = { ...state, pluginOverrides: { ...state.pluginOverrides, ...overrides } }
    const unresolved = record.members.flatMap(member => member.permissions).filter(permission => permission.required && this.policyFor(record, previewState, permission) !== 'allow')
    if (unresolved.length > 0) return this.failure(request, state, active, 'permission-review-required', 'Every required member permission must be explicitly allowed before installation.', 'rejected')
    const applied: { readonly pluginId: string; readonly previousDigest?: `sha256:${string}` }[] = []
    const removedMembers: StoredMember[] = []
    const activeAtStart = activeById(active)
    try {
      for (const member of pluginOrder(record.members)) {
        if (!member.required && !(record.optionalEnabled[member.pluginId] ?? member.enabledByDefault)) continue
        const current = (await this.options.pluginLifecycle.store.loadActive()).plugins.find(plugin => plugin.id === member.pluginId)
        if (current?.digest === member.digest) continue
        const staged = await loadStagedPluginPackage(this.options.homeDir, member.digest)
        const result = await this.applyStaged(staged, record, previewState)
        if (result.outcome !== 'applied') throw new Error(result.error?.message ?? `failed to apply ${member.pluginId}`)
        applied.push({ pluginId: member.pluginId, ...(activeAtStart.get(member.pluginId) === undefined ? {} : { previousDigest: activeAtStart.get(member.pluginId)!.digest }) })
      }
      const removals = new Set(candidate.plan.memberActions.filter(action => action.action === 'remove').map(action => action.pluginId))
      for (const member of [...pluginOrder(existingBundle?.members ?? [])].reverse().filter(item => removals.has(item.pluginId))) {
        const result = await this.removeInstalledPlugin(member.pluginId)
        if (result.outcome !== 'applied') throw new Error(result.error?.message ?? `failed to remove ${member.pluginId}`)
        removedMembers.push(member)
      }
    } catch (error) {
      let rollbackFailed = !(await this.rollbackApplied(applied, existingBundle ?? record, state))
      try {
        for (const member of pluginOrder(removedMembers)) {
          const result = await this.applyStaged(await loadStagedPluginPackage(this.options.homeDir, member.digest), existingBundle ?? record, state)
          if (result.outcome !== 'applied') rollbackFailed = true
        }
      } catch { rollbackFailed = true }
      const latest = await this.options.pluginLifecycle.store.loadActive()
      return this.failure(request, state, latest, rollbackFailed ? 'rollback-failed' : 'apply-failed', error instanceof Error ? error.message : String(error), rollbackFailed ? 'rollback-failed' : 'rolled-back')
    }
    const latestActive = await this.options.pluginLifecycle.store.loadActive()
    const now = this.#now().toISOString()
    const next = await this.#store.update(draft => {
      for (const action of candidate.plan.memberActions) {
        if (action.action === 'share' && !Object.values(draft.bundles).some(bundle => bundle.members.some(member => member.pluginId === action.pluginId))) draft.directClaims[action.pluginId] = true
      }
      Object.assign(draft.pluginOverrides, overrides)
      draft.bundles[record.id] = {
        ...record,
        records: [...record.records, { recordId: `bundle-record-${randomUUID()}`, at: now, kind: request.operation.kind, outcome: 'applied', message: `Applied ${record.name}.`, pluginIds: record.members.map(member => member.pluginId) }],
      }
      delete draft.candidates[candidate.candidateId]
    })
    return {
      ...this.base(request, next, latestActive),
      outcome: 'applied',
      bundleId: record.id,
      affectedPluginIds: candidate.plan.memberActions.filter(action => !['share', 'retain'].includes(action.action)).map(action => action.pluginId),
      retainedPluginIds: candidate.plan.memberActions.filter(action => action.action === 'share' || action.action === 'retain').map(action => action.pluginId),
      removedPluginIds: removedMembers.map(member => member.pluginId),
      plan: candidate.plan,
    }
  }

  private async removeInstalledPlugin(pluginId: string): Promise<CordisXPluginLifecycleResultV1> {
    const active = await this.options.pluginLifecycle.store.loadActive()
    const preview = await this.options.pluginLifecycle.handleBundleOperation({
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-lifecycle-operation.v1.schema.json', schemaVersion: 1,
      requestId: `bundle-uninstall-plan-${randomUUID()}`, profileId: this.options.profileId, expectedRevision: active.revision,
      runtimeGeneration: this.options.runtimeGeneration, operation: { kind: 'uninstall', pluginId, impactToken: '' },
    })
    if (preview.outcome !== 'planned' || preview.impactToken === undefined) return preview
    const latest = await this.options.pluginLifecycle.store.loadActive()
    return await this.options.pluginLifecycle.handleBundleOperation({
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-lifecycle-operation.v1.schema.json', schemaVersion: 1,
      requestId: `bundle-uninstall-${randomUUID()}`, profileId: this.options.profileId, expectedRevision: latest.revision,
      runtimeGeneration: this.options.runtimeGeneration, operation: { kind: 'uninstall', pluginId, impactToken: preview.impactToken },
    })
  }

  private async rollbackApplied(applied: readonly { readonly pluginId: string; readonly previousDigest?: `sha256:${string}` }[], record: BundleRecord, state: BundleState): Promise<boolean> {
    try {
      for (const item of [...applied].reverse()) {
        if (item.previousDigest !== undefined) {
          await this.applyStaged(await loadStagedPluginPackage(this.options.homeDir, item.previousDigest), record, state)
          continue
        }
        const active = await this.options.pluginLifecycle.store.loadActive()
        const preview = await this.options.pluginLifecycle.handleBundleOperation({
          $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-lifecycle-operation.v1.schema.json', schemaVersion: 1,
          requestId: `bundle-rollback-plan-${randomUUID()}`, profileId: this.options.profileId, expectedRevision: active.revision,
          runtimeGeneration: this.options.runtimeGeneration, operation: { kind: 'uninstall', pluginId: item.pluginId, impactToken: '' },
        })
        if (preview.outcome !== 'planned' || preview.impactToken === undefined) return false
        const current = await this.options.pluginLifecycle.store.loadActive()
        const removed = await this.options.pluginLifecycle.handleBundleOperation({
          $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-lifecycle-operation.v1.schema.json', schemaVersion: 1,
          requestId: `bundle-rollback-${randomUUID()}`, profileId: this.options.profileId, expectedRevision: current.revision,
          runtimeGeneration: this.options.runtimeGeneration, operation: { kind: 'uninstall', pluginId: item.pluginId, impactToken: preview.impactToken },
        })
        if (removed.outcome !== 'applied') return false
      }
      return true
    } catch { return false }
  }

  private operationImpact(state: BundleState, active: CordisXPluginActivationRecordV1, bundle: BundleRecord, operation: string) {
    const otherBundles = Object.values(state.bundles).filter(candidate => candidate.id !== bundle.id)
    const retained: string[] = []
    const affected: string[] = []
    for (const member of bundle.members) {
      const otherBundleClaim = otherBundles.some(candidate => candidate.members.some(item => item.pluginId === member.pluginId))
      const otherActiveIntent = otherBundles.some(candidate => candidate.enabled && candidate.members.some(item => item.pluginId === member.pluginId
        && (item.required || (candidate.optionalEnabled[item.pluginId] ?? item.enabledByDefault))))
      const runtimeDependency = active.plugins.some(plugin => plugin.id !== member.pluginId
        && (operation !== 'disable' || plugin.enabled)
        && plugin.dependencies.some(dependency => dependency.id === member.pluginId))
      const shared = state.directClaims[member.pluginId]
        || (operation === 'disable' ? otherActiveIntent : otherBundleClaim)
        || runtimeDependency
      ;(shared ? retained : affected).push(member.pluginId)
    }
    return { retained, affected, token: `bundle-impact-${hash([state.revision, active.revision, bundle.id, operation, retained, affected])}` }
  }

  private restrictiveFloorsForTransition(state: BundleState, bundle: BundleRecord, operation: 'disable' | 'uninstall'): Readonly<Record<string, CordisXPluginBundlePolicy>> {
    const bundles = { ...state.bundles }
    if (operation === 'uninstall') delete bundles[bundle.id]
    else bundles[bundle.id] = { ...bundle, enabled: false }
    const afterState: BundleState = { ...state, bundles }
    const floors: Record<string, CordisXPluginBundlePolicy> = {}
    for (const member of bundle.members) {
      for (const permission of member.permissions) {
        const key = overrideKey(member.pluginId, permission.permissionId)
        if (state.pluginOverrides[key] !== undefined) continue
        const before = effectivePermission(state, member, permission).effectivePolicy
        const after = effectivePermission(afterState, member, permission).effectivePolicy
        if (policyRank[before] > policyRank[after]) floors[key] = before
      }
    }
    return floors
  }

  private async changeBundleState(
    request: CordisXPluginBundleLifecycleRequestV1 & { readonly operation: Extract<CordisXPluginBundleLifecycleRequestV1['operation'], { readonly kind: 'enable' | 'disable' | 'uninstall' }> },
    state: BundleState,
    active: CordisXPluginActivationRecordV1,
  ): Promise<CordisXPluginBundleLifecycleResultV1> {
    const bundle = state.bundles[request.operation.bundleId]
    if (bundle === undefined) return this.failure(request, state, active, 'operation-unavailable', 'The bundle is not installed.', 'rejected')
    if (request.operation.kind === 'enable') {
      const desired = bundle.members.filter(member => member.required || (bundle.optionalEnabled[member.pluginId] ?? member.enabledByDefault))
      const activeMap = activeById(active)
      const affected = desired.filter(member => activeMap.get(member.pluginId)?.enabled !== true).map(member => member.pluginId)
      const retained = desired.filter(member => activeMap.get(member.pluginId)?.enabled === true).map(member => member.pluginId)
      const token = `bundle-impact-${hash([state.revision, active.revision, bundle.id, 'enable', affected, retained])}`
      const plan: CordisXPluginBundlePlanV1 = {
        bundle: { id: bundle.id, name: bundle.name, version: bundle.version, digest: bundle.digest, authors: bundle.authors },
        memberActions: desired.map(member => ({ pluginId: member.pluginId, version: member.requestedVersion, action: affected.includes(member.pluginId) ? 'enable' : 'retain', reason: member.required ? 'bundle-required' : 'bundle-optional' })),
        permissionRequests: desired.flatMap(member => member.permissions.map(permission => ({ permissionId: permission.permissionId, pluginId: permission.pluginId, capability: permission.capability, scopeLabel: permission.scopeLabel, required: permission.required, defaultPolicy: 'ask' as const }))),
        conflicts: [],
      }
      if (request.operation.impactToken === '') return { ...this.base(request, state, active), outcome: 'planned', bundleId: bundle.id, impactToken: token, affectedPluginIds: affected, retainedPluginIds: retained, removedPluginIds: [], plan }
      if (request.operation.impactToken !== token) return this.failure(request, state, active, 'impact-changed', 'The bundle enable impact changed; review it again.', 'conflict')
      if (desired.flatMap(member => member.permissions).some(permission => permission.required && this.policyFor(bundle, state, permission) !== 'allow')) {
        return this.failure(request, state, active, 'permission-review-required', 'Required member permissions must be allowed before enabling the bundle.', 'rejected')
      }
      for (const member of pluginOrder(desired)) {
        const current = (await this.options.pluginLifecycle.store.loadActive()).plugins.find(plugin => plugin.id === member.pluginId)
        if (current?.enabled === true) continue
        const result = await this.enablePlugin(await loadStagedPluginPackage(this.options.homeDir, member.digest), bundle, state)
        if (result.outcome !== 'applied') throw new Error(result.error?.message ?? `could not enable ${member.pluginId}`)
      }
      const latest = await this.options.pluginLifecycle.store.loadActive()
      const now = this.#now().toISOString()
      const next = await this.#store.update(draft => {
        draft.bundles[bundle.id] = appendRecord({ ...bundle, enabled: true }, now, 'enable', `Enabled ${bundle.name}.`, affected)
      })
      return { ...this.base(request, next, latest), outcome: 'applied', bundleId: bundle.id, affectedPluginIds: affected, retainedPluginIds: retained, removedPluginIds: [], plan }
    }
    const impact = this.operationImpact(state, active, bundle, request.operation.kind)
    const plan: CordisXPluginBundlePlanV1 = {
      bundle: { id: bundle.id, name: bundle.name, version: bundle.version, digest: bundle.digest, authors: bundle.authors },
      memberActions: bundle.members.map(member => ({
        pluginId: member.pluginId,
        version: member.requestedVersion,
        action: impact.retained.includes(member.pluginId) ? 'retain' : request.operation.kind === 'uninstall' ? 'remove' : request.operation.kind === 'disable' ? 'disable' : 'enable',
        reason: impact.retained.includes(member.pluginId) ? (state.directClaims[member.pluginId] ? 'direct-claim' : 'other-bundle-claim') : 'orphaned',
      })),
      permissionRequests: bundle.members.flatMap(member => member.permissions.map(permission => ({
        permissionId: permission.permissionId,
        pluginId: permission.pluginId,
        capability: permission.capability,
        scopeLabel: permission.scopeLabel,
        required: permission.required,
        defaultPolicy: 'ask' as const,
      }))),
      conflicts: [],
    }
    if (request.operation.impactToken === '') return {
      ...this.base(request, state, active), outcome: 'planned', bundleId: bundle.id, impactToken: impact.token,
      affectedPluginIds: impact.affected, retainedPluginIds: impact.retained, removedPluginIds: request.operation.kind === 'uninstall' ? impact.affected : [], plan,
    }
    if (request.operation.impactToken !== impact.token) return this.failure(request, state, active, 'impact-changed', 'The bundle impact changed; review it again.', 'conflict')
    const removed: string[] = []
    for (const pluginId of [...pluginOrder(bundle.members)].reverse().map(member => member.pluginId).filter(pluginId => impact.affected.includes(pluginId))) {
      const current = await this.options.pluginLifecycle.store.loadActive()
      const plugin = current.plugins.find(item => item.id === pluginId)
      if (plugin === undefined) continue
      const kind = request.operation.kind === 'uninstall' ? 'uninstall' as const : 'disable' as const
      const preview = await this.options.pluginLifecycle.handleBundleOperation({
        $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-lifecycle-operation.v1.schema.json', schemaVersion: 1,
        requestId: `bundle-${kind}-plan-${randomUUID()}`, profileId: this.options.profileId, expectedRevision: current.revision,
        runtimeGeneration: this.options.runtimeGeneration, operation: { kind, pluginId, impactToken: '' },
      })
      if (preview.outcome !== 'planned' || preview.impactToken === undefined) throw new Error(preview.error?.message ?? `could not plan ${kind} for ${pluginId}`)
      const latest = await this.options.pluginLifecycle.store.loadActive()
      const applied = await this.options.pluginLifecycle.handleBundleOperation({
        $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-lifecycle-operation.v1.schema.json', schemaVersion: 1,
        requestId: `bundle-${kind}-${randomUUID()}`, profileId: this.options.profileId, expectedRevision: latest.revision,
        runtimeGeneration: this.options.runtimeGeneration, operation: { kind, pluginId, impactToken: preview.impactToken },
      })
      if (applied.outcome !== 'applied') throw new Error(applied.error?.message ?? `could not ${kind} ${pluginId}`)
      if (kind === 'uninstall') removed.push(pluginId)
    }
    const latest = await this.options.pluginLifecycle.store.loadActive()
    const now = this.#now().toISOString()
    const floors = this.restrictiveFloorsForTransition(state, bundle, request.operation.kind)
    const next = await this.#store.update(draft => {
      Object.assign(draft.permissionFloors, floors)
      if (request.operation.kind === 'uninstall') delete draft.bundles[bundle.id]
      else draft.bundles[bundle.id] = appendRecord({ ...bundle, enabled: false }, now, 'disable', `Disabled ${bundle.name}.`, impact.affected)
    })
    return { ...this.base(request, next, latest), outcome: 'applied', bundleId: bundle.id, affectedPluginIds: impact.affected, retainedPluginIds: impact.retained, removedPluginIds: removed, plan }
  }

  private async setPermissions(
    request: CordisXPluginBundleLifecycleRequestV1 & { readonly operation: Extract<CordisXPluginBundleLifecycleRequestV1['operation'], { readonly kind: 'set-permissions' }> },
    state: BundleState,
    active: CordisXPluginActivationRecordV1,
  ): Promise<CordisXPluginBundleLifecycleResultV1> {
    const bundle = state.bundles[request.operation.bundleId]
    if (bundle === undefined) return this.failure(request, state, active, 'operation-unavailable', 'The bundle is not installed.', 'rejected')
    const permissionIds = new Set(bundle.members.flatMap(member => member.permissions.map(permission => permission.permissionId)))
    const overrideKeys = request.operation.pluginOverrides.map(item => overrideKey(item.pluginId, item.permissionId))
    const clearKeys = request.operation.clearPluginOverrides.map(item => overrideKey(item.pluginId, item.permissionId))
    const validReference = (pluginId: string, permissionId: string) => bundle.members.some(member => member.pluginId === pluginId && member.permissions.some(permission => permission.permissionId === permissionId))
    if (request.operation.bundlePermissions.length !== permissionIds.size
      || new Set(request.operation.bundlePermissions.map(item => item.permissionId)).size !== request.operation.bundlePermissions.length
      || request.operation.bundlePermissions.some(item => !permissionIds.has(item.permissionId) || !bundlePolicy(item.policy))
      || new Set(overrideKeys).size !== overrideKeys.length || new Set(clearKeys).size !== clearKeys.length
      || overrideKeys.some(key => clearKeys.includes(key))
      || request.operation.pluginOverrides.some(item => !validReference(item.pluginId, item.permissionId) || !bundlePolicy(item.policy))
      || request.operation.clearPluginOverrides.some(item => !validReference(item.pluginId, item.permissionId))) {
      return this.failure(request, state, active, 'permission-review-required', 'A permission assignment is stale or outside this bundle.', 'conflict')
    }
    const token = `bundle-impact-${hash([state.revision, active.revision, bundle.id, request.operation.bundlePermissions, request.operation.pluginOverrides, request.operation.clearPluginOverrides])}`
    if (request.operation.impactToken === '') return { ...this.base(request, state, active), outcome: 'planned', bundleId: bundle.id, impactToken: token, affectedPluginIds: bundle.members.map(member => member.pluginId), retainedPluginIds: [], removedPluginIds: [] }
    if (request.operation.impactToken !== token) return this.failure(request, state, active, 'impact-changed', 'The permission impact changed; review it again.', 'conflict')
    const now = this.#now().toISOString()
    const next = await this.#store.update(draft => {
      draft.bundles[bundle.id] = appendRecord({ ...bundle, policies: Object.fromEntries(request.operation.bundlePermissions.map(item => [item.permissionId, item.policy])) }, now, 'set-permissions', `Updated permissions for ${bundle.name}.`, bundle.members.map(member => member.pluginId))
      for (const item of request.operation.pluginOverrides) draft.pluginOverrides[overrideKey(item.pluginId, item.permissionId)] = item.policy
      for (const item of request.operation.clearPluginOverrides) delete draft.pluginOverrides[overrideKey(item.pluginId, item.permissionId)]
      for (const permissionId of permissionIds) {
        const member = bundle.members.find(item => item.permissions.some(permission => permission.permissionId === permissionId))!
        delete draft.permissionFloors[overrideKey(member.pluginId, permissionId)]
      }
    })
    return { ...this.base(request, next, active), outcome: 'applied', bundleId: bundle.id, affectedPluginIds: bundle.members.map(member => member.pluginId), retainedPluginIds: [], removedPluginIds: [] }
  }

  private async setOptionalMember(
    request: CordisXPluginBundleLifecycleRequestV1 & { readonly operation: Extract<CordisXPluginBundleLifecycleRequestV1['operation'], { readonly kind: 'set-optional-member' }> },
    state: BundleState,
    active: CordisXPluginActivationRecordV1,
  ): Promise<CordisXPluginBundleLifecycleResultV1> {
    const bundle = state.bundles[request.operation.bundleId]
    const member = bundle?.members.find(item => item.pluginId === request.operation.pluginId)
    if (bundle === undefined || member === undefined || member.required) return this.failure(request, state, active, 'operation-unavailable', 'The target is not an optional member.', 'rejected')
    const token = `bundle-impact-${hash([state.revision, active.revision, bundle.id, member.pluginId, request.operation.enabled])}`
    if (request.operation.impactToken === '') return { ...this.base(request, state, active), outcome: 'planned', bundleId: bundle.id, impactToken: token, affectedPluginIds: [member.pluginId], retainedPluginIds: [], removedPluginIds: [] }
    if (request.operation.impactToken !== token) return this.failure(request, state, active, 'impact-changed', 'The optional-member impact changed.', 'conflict')
    const installed = active.plugins.find(plugin => plugin.id === member.pluginId)
    if (request.operation.enabled && installed?.enabled !== true) {
      if (member.permissions.some(permission => permission.required && this.policyFor(bundle, state, permission) !== 'allow')) {
        return this.failure(request, state, active, 'permission-review-required', 'Required member permissions must be allowed before enabling this member.', 'rejected')
      }
      const result = await this.enablePlugin(await loadStagedPluginPackage(this.options.homeDir, member.digest), bundle, state)
      if (result.outcome !== 'applied') throw new Error(result.error?.message ?? `could not enable ${member.pluginId}`)
    }
    if (!request.operation.enabled && installed?.enabled === true) {
      const retained = state.directClaims[member.pluginId]
        || Object.values(state.bundles).some(owner => owner.id !== bundle.id && owner.enabled && owner.members.some(candidate => candidate.pluginId === member.pluginId && (candidate.required || (owner.optionalEnabled[candidate.pluginId] ?? candidate.enabledByDefault))))
        || active.plugins.some(plugin => plugin.id !== member.pluginId && plugin.enabled && plugin.dependencies.some(dependency => dependency.id === member.pluginId))
      if (!retained) {
        const preview = await this.options.pluginLifecycle.handleBundleOperation({
          $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-lifecycle-operation.v1.schema.json', schemaVersion: 1,
          requestId: `bundle-optional-disable-plan-${randomUUID()}`, profileId: this.options.profileId, expectedRevision: active.revision,
          runtimeGeneration: this.options.runtimeGeneration, operation: { kind: 'disable', pluginId: member.pluginId, impactToken: '' },
        })
        if (preview.outcome !== 'planned' || preview.impactToken === undefined) throw new Error(preview.error?.message ?? `could not plan disable for ${member.pluginId}`)
        const latest = await this.options.pluginLifecycle.store.loadActive()
        const result = await this.options.pluginLifecycle.handleBundleOperation({
          $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-lifecycle-operation.v1.schema.json', schemaVersion: 1,
          requestId: `bundle-optional-disable-${randomUUID()}`, profileId: this.options.profileId, expectedRevision: latest.revision,
          runtimeGeneration: this.options.runtimeGeneration, operation: { kind: 'disable', pluginId: member.pluginId, impactToken: preview.impactToken },
        })
        if (result.outcome !== 'applied') throw new Error(result.error?.message ?? `could not disable ${member.pluginId}`)
      }
    }
    const latest = await this.options.pluginLifecycle.store.loadActive()
    const now = this.#now().toISOString()
    const next = await this.#store.update(draft => {
      draft.bundles[bundle.id] = appendRecord(
        { ...bundle, optionalEnabled: { ...bundle.optionalEnabled, [member.pluginId]: request.operation.enabled } },
        now,
        'set-optional-member',
        `${request.operation.enabled ? 'Enabled' : 'Disabled'} optional member ${member.pluginId}.`,
        [member.pluginId],
      )
    })
    return { ...this.base(request, next, latest), outcome: 'applied', bundleId: bundle.id, affectedPluginIds: [member.pluginId], retainedPluginIds: [], removedPluginIds: [] }
  }

  private async adoptMember(
    request: CordisXPluginBundleLifecycleRequestV1 & { readonly operation: Extract<CordisXPluginBundleLifecycleRequestV1['operation'], { readonly kind: 'adopt-member' }> },
    state: BundleState,
    active: CordisXPluginActivationRecordV1,
  ): Promise<CordisXPluginBundleLifecycleResultV1> {
    const bundle = state.bundles[request.operation.bundleId]
    if (bundle === undefined || !bundle.members.some(member => member.pluginId === request.operation.pluginId) || !active.plugins.some(plugin => plugin.id === request.operation.pluginId)) {
      return this.failure(request, state, active, 'operation-unavailable', 'Only an installed bundle member can be adopted.', 'rejected')
    }
    const token = `bundle-impact-${hash([state.revision, active.revision, bundle.id, request.operation.pluginId, 'adopt'])}`
    if (request.operation.impactToken === '') return { ...this.base(request, state, active), outcome: 'planned', bundleId: bundle.id, impactToken: token, affectedPluginIds: [request.operation.pluginId], retainedPluginIds: [request.operation.pluginId], removedPluginIds: [] }
    if (request.operation.impactToken !== token) return this.failure(request, state, active, 'impact-changed', 'The adoption impact changed.', 'conflict')
    const now = this.#now().toISOString()
    const next = await this.#store.update(draft => {
      draft.directClaims[request.operation.pluginId] = true
      draft.bundles[bundle.id] = appendRecord(bundle, now, 'adopt-member', `Adopted ${request.operation.pluginId} as a direct installation.`, [request.operation.pluginId])
    })
    return { ...this.base(request, next, active), outcome: 'applied', bundleId: bundle.id, affectedPluginIds: [request.operation.pluginId], retainedPluginIds: [request.operation.pluginId], removedPluginIds: [] }
  }
}
