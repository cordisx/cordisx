import { createHash, randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import type {
  ActivationPackageProjection,
  HostPackageManifest,
  LocalPackageSource,
  PackageActivationPlan,
  PackageActivationPlugin,
  PackageActivationTuple,
  PackageCandidateAccess,
  PackageCandidatePlugin,
  PackageCandidateToken,
  PackageFenceEntry,
  PackageGenerationFence,
  PackageImpactAccess,
  PackageImpactPlan,
  PackageImpactToken,
  PackageLease,
  PackageManifestResolver,
  PackageObjectRecord,
  PackageOperation,
  PackagePermissionReview,
  PackageProfileState,
  PackageReadinessReceipt,
  PackageRecoveryDirective,
  PackageReloadLevel,
  PackageResolutionBoundary,
  PackageRuntimeObservation,
  PackageStoreState,
  PackageTransactionRecord,
  PluginPackageState,
  ResolvedPackageCandidate,
} from './types.js'
import { PackageLifecycleError } from './types.js'
import {
  affectedClosure,
  assertPackageCompatibility,
  resolvePackageGraph,
  selectedNodes,
  validateHostPackageManifest,
} from './graph.js'
import { ImmutablePackageObjects } from './integrity.js'
import { JsonPackageStore } from './store.js'

const PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const OWNER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const GENERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA256_INTEGRITY = /^sha256:[a-f0-9]{64}$/
const RELATIVE_ENTRY = /^\.\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/

export interface HostPermissionReviewInput {
  readonly transactionId: string
  readonly operation: 'install' | 'update' | 'enable'
  readonly profileId: string
  readonly identity: {
    readonly source: string
    readonly pluginId: string
    readonly version: string
    readonly integrity: string
  }
  readonly runtimeManifest: ResolvedPackageCandidate['runtime']['manifest']
  readonly manifestPermissionFingerprint: string
}

export interface HostPermissionReviewDecision {
  readonly planId: string
  readonly fingerprint: string
  readonly requiredSatisfied: boolean
  readonly unresolvedRequired: readonly string[]
  readonly deniedRequired: readonly string[]
}

const issuedPermissionReceipts = new WeakSet<object>()

export interface HostPermissionReviewReceipt extends HostPermissionReviewDecision {
  readonly inputFingerprint: string
}

export interface HostPermissionReviewAuthority {
  review(input: HostPermissionReviewInput): Promise<HostPermissionReviewReceipt>
}

/** Wrap the launcher Permission Broker. Renderer booleans cannot mint receipts. */
export function createHostPermissionReviewAuthority(
  review: (input: HostPermissionReviewInput) => Promise<HostPermissionReviewDecision>,
): HostPermissionReviewAuthority {
  return {
    review: async (input) => {
      const decision = await review(structuredClone(input))
      const receipt = Object.freeze({ ...structuredClone(decision), inputFingerprint: fingerprint(input) })
      issuedPermissionReceipts.add(receipt)
      return receipt
    },
  }
}

export interface PackageLifecycleHostOptions {
  readonly runtimeAbi: 1
  readonly protocolSchemas: readonly string[]
  readonly manifestResolver: PackageManifestResolver
  readonly permissionAuthority: HostPermissionReviewAuthority
  readonly now?: () => Date
}

export interface PreparePackageTransactionInput {
  readonly ownerId: string
  readonly operation: PackageOperation
  readonly profileId: string
  readonly expectedRevision: number
  readonly expected: PackageGenerationFence
  readonly proposedRuntimeGeneration: string
  readonly pluginId?: string
  readonly source?: LocalPackageSource
  readonly reloadLevel?: PackageReloadLevel
}

export interface PreparedPackageTransaction {
  readonly transaction: PackageTransactionRecord
  readonly candidateId: PackageCandidateToken
  readonly impactToken: PackageImpactToken
  readonly state: PackageStoreState
  readonly activationAvailable: boolean
}

export interface PackageLeaseProjection {
  readonly profileId: string
  readonly pluginId: string
  readonly installed?: PackageLease
  readonly active?: PackageLease
  readonly lastGood?: PackageLease
  readonly rollbackLeases: readonly PackageLease[]
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]))
  }
  return value
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function packageKey(pluginId: string, version: string, integrity: string): string {
  if (!SHA256_INTEGRITY.test(integrity)) throw new PackageLifecycleError('invalid-integrity', 'package integrity is invalid')
  return `${pluginId}@${version}#${integrity}`
}

function assertInputIdentity(ownerId: string, profileId: string, generation: string, label: string): void {
  if (!OWNER_ID.test(ownerId)) throw new PackageLifecycleError('invalid-owner', 'owner id is invalid')
  if (!PROFILE_ID.test(profileId)) throw new PackageLifecycleError('invalid-profile', `invalid profile id: ${profileId}`)
  if (!GENERATION_ID.test(generation)) throw new PackageLifecycleError('invalid-generation', `${label} is invalid`)
}

function stateProfile(state: PackageStoreState, profileId: string, expected: PackageGenerationFence): PackageProfileState {
  const existing = state.profiles[profileId]
  if (existing !== undefined) return existing
  if (Object.keys(expected.plugins).length !== 0) {
    throw new PackageLifecycleError('stale-package-fence', 'new package profile expected plugins must be empty')
  }
  return {
    revision: 0,
    lastGoodRevision: 0,
    runtimeGeneration: expected.runtimeGeneration,
    lastGoodRuntimeGeneration: expected.runtimeGeneration,
    plugins: {},
  }
}

function selectedPackageKeys(profile: PackageProfileState, enabledOnly: boolean): Record<string, string> {
  const selected: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [pluginId, plugin] of Object.entries(profile.plugins)) {
    if ((enabledOnly && !plugin.enabled) || plugin.installed === undefined || plugin.uninstalled === true) continue
    selected[pluginId] = plugin.installed.packageKey
  }
  return selected
}

function currentFence(state: PackageStoreState, profile: PackageProfileState): PackageGenerationFence {
  const plugins: Record<string, PackageFenceEntry> = Object.create(null) as Record<string, PackageFenceEntry>
  for (const [pluginId, plugin] of Object.entries(profile.plugins)) {
    if (plugin.active === undefined) continue
    const record = state.packages[plugin.active.packageKey]
    if (record === undefined) throw new PackageLifecycleError('missing-package-object', `missing active package ${plugin.active.packageKey}`)
    plugins[pluginId] = { moduleGeneration: plugin.active.moduleGeneration, identity: record.identity }
  }
  return { runtimeGeneration: profile.runtimeGeneration, plugins }
}

function assertExactFence(actual: PackageGenerationFence, expected: PackageGenerationFence): void {
  if (fingerprint(actual) !== fingerprint(expected)) {
    throw new PackageLifecycleError('stale-package-fence', 'runtime generation, module generation, or package identity is stale')
  }
}

function objectEntry(objectDirectory: string, relative: string): string {
  return path.resolve(objectDirectory, relative.slice(2))
}

async function validateResolvedCandidate(snapshotRoot: string, candidate: ResolvedPackageCandidate): Promise<void> {
  validateHostPackageManifest(candidate.packageManifest)
  if (candidate.runtime.manifest.id !== candidate.packageManifest.pluginId) {
    throw new PackageLifecycleError('package-identity-mismatch', 'runtime manifest id must match package manifest plugin id')
  }
  if (!SHA256_INTEGRITY.test(candidate.runtime.manifestIntegrity)
    || !candidate.packageManifest.compatibility.protocolSchemas.includes(candidate.runtime.manifest.$schema)) {
    throw new PackageLifecycleError('incompatible-runtime', 'runtime manifest digest/schema is not package-bound')
  }
  if (!RELATIVE_ENTRY.test(candidate.runtime.entry) || candidate.runtime.entry.includes('..')) {
    throw new PackageLifecycleError('invalid-package-entry', 'runtime entry must be a package-relative path')
  }
  const root = `${await realpath(snapshotRoot)}${path.sep}`
  const resolved = await realpath(objectEntry(snapshotRoot, candidate.runtime.entry)).catch(() => {
    throw new PackageLifecycleError('missing-package-entry', `package entry does not exist: ${candidate.runtime.entry}`)
  })
  if (!resolved.startsWith(root)) throw new PackageLifecycleError('package-entry-escape', 'runtime entry escapes immutable object')
  const metadata = await lstat(resolved)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new PackageLifecycleError('invalid-package-entry', 'runtime entry must be a regular file')
  }
}

function permissionSummary(receipt: HostPermissionReviewReceipt): PackagePermissionReview {
  if (!issuedPermissionReceipts.has(receipt)) {
    throw new PackageLifecycleError('untrusted-permission-review', 'permission review was not issued by the Host authority')
  }
  return {
    planId: receipt.planId,
    fingerprint: receipt.fingerprint,
    requiredSatisfied: receipt.requiredSatisfied,
    unresolvedRequired: [...receipt.unresolvedRequired],
    deniedRequired: [...receipt.deniedRequired],
  }
}

function isTerminal(status: PackageTransactionRecord['status']): boolean {
  return status === 'committed' || status === 'aborted' || status === 'recovered-aborted'
}

function exactReceiptPlugins(transaction: PackageTransactionRecord, state: PackageStoreState): Record<string, PackageFenceEntry> {
  const result: Record<string, PackageFenceEntry> = Object.create(null) as Record<string, PackageFenceEntry>
  for (const pluginId of transaction.affectedPluginIds) {
    const target = transaction.target[pluginId]
    const expected = transaction.expected.plugins[pluginId]
    const key = target?.packageKey
    const record = key === undefined
      ? (expected === undefined ? undefined : Object.values(state.packages)
        .find(candidate => fingerprint(candidate.identity) === fingerprint(expected.identity)))
      : state.packages[key]
    if (record === undefined || target === undefined) {
      throw new PackageLifecycleError('missing-package-fence', `transaction lacks package fence for ${pluginId}`)
    }
    result[pluginId] = { moduleGeneration: target.moduleGeneration, identity: record.identity }
  }
  return result
}

function assertReceipt(
  transaction: PackageTransactionRecord,
  state: PackageStoreState,
  access: PackageCandidateAccess,
  receipt: PackageReadinessReceipt,
): void {
  if (receipt.transactionId !== transaction.transactionId
    || receipt.candidateId !== access.candidateId
    || receipt.candidateFingerprint !== transaction.candidateFingerprint
    || receipt.runtimeGeneration !== transaction.proposedRuntimeGeneration
    || fingerprint(receipt.plugins) !== fingerprint(exactReceiptPlugins(transaction, state))) {
    throw new PackageLifecycleError('stale-readiness-receipt', 'readiness receipt failed runtime/module/package fence')
  }
}

function referenceCounts(state: PackageStoreState): Record<string, number> {
  const counts: Record<string, number> = Object.create(null) as Record<string, number>
  const add = (lease: PackageLease | undefined): void => {
    if (lease !== undefined) counts[lease.packageKey] = (counts[lease.packageKey] ?? 0) + 1
  }
  for (const profile of Object.values(state.profiles)) {
    for (const plugin of Object.values(profile.plugins)) {
      add(plugin.installed)
      add(plugin.active)
      add(plugin.lastGood)
      for (const lease of plugin.rollbackLeases) add(lease)
    }
  }
  for (const transaction of Object.values(state.transactions)) {
    if (isTerminal(transaction.status)) continue
    for (const target of Object.values(transaction.target)) {
      if (target.packageKey !== undefined) counts[target.packageKey] = (counts[target.packageKey] ?? 0) + 1
    }
  }
  return counts
}

function boundaryAllows(boundary: PackageResolutionBoundary, status: PackageTransactionRecord['status']): boolean {
  if (boundary === 'plan') return status === 'ready'
  if (boundary === 'stage') return status === 'ready' || status === 'activation-requested'
  if (boundary === 'publish') return status === 'activation-requested'
  return status === 'activation-requested' || status === 'readiness-confirmed'
}

function freeze<Value>(value: Value): Readonly<Value> {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value)
    for (const entry of Object.values(value as Record<string, unknown>)) freeze(entry)
  }
  return value
}

export class PackageLifecycleHost {
  readonly #store: JsonPackageStore
  readonly #objects: ImmutablePackageObjects
  readonly #options: PackageLifecycleHostOptions

  constructor(store: JsonPackageStore, options: PackageLifecycleHostOptions) {
    this.#store = store
    this.#objects = new ImmutablePackageObjects(store.root)
    this.#options = options
  }

  snapshot(): PackageStoreState {
    return this.#store.snapshot()
  }

  leases(profileId: string): readonly PackageLeaseProjection[] {
    const profile = this.#store.snapshot().profiles[profileId]
    if (profile === undefined) return []
    return Object.entries(profile.plugins).sort(([left], [right]) => left.localeCompare(right)).map(([pluginId, plugin]) => ({
      profileId,
      pluginId,
      ...(plugin.installed === undefined ? {} : { installed: plugin.installed }),
      ...(plugin.active === undefined ? {} : { active: plugin.active }),
      ...(plugin.lastGood === undefined ? {} : { lastGood: plugin.lastGood }),
      rollbackLeases: [...plugin.rollbackLeases],
    }))
  }

  async prepare(input: PreparePackageTransactionInput): Promise<PreparedPackageTransaction> {
    assertInputIdentity(input.ownerId, input.profileId, input.expected.runtimeGeneration, 'expected runtime generation')
    assertInputIdentity(input.ownerId, input.profileId, input.proposedRuntimeGeneration, 'proposed runtime generation')
    const transactionId = randomUUID()
    const candidateId = `candidate:${randomUUID()}` as PackageCandidateToken
    const impactToken = `impact:${randomUUID()}` as PackageImpactToken
    const now = (this.#options.now?.() ?? new Date()).toISOString()
    let imported: PackageObjectRecord | undefined
    let permission: PackagePermissionReview | undefined

    if (input.operation === 'install' || input.operation === 'update') {
      if (input.source === undefined) throw new PackageLifecycleError('missing-package-source', `${input.operation} requires a package source`)
      const staged = await this.#objects.snapshot(input.source, transactionId)
      try {
        const resolved = await this.#options.manifestResolver.resolve(staged.payloadDirectory)
        await validateResolvedCandidate(staged.payloadDirectory, resolved)
        assertPackageCompatibility(resolved.packageManifest, this.#options)
        const identity = {
          pluginId: resolved.packageManifest.pluginId,
          version: resolved.packageManifest.version,
          integrity: staged.integrity,
        }
        const reviewInput: HostPermissionReviewInput = {
          transactionId,
          operation: input.operation,
          profileId: input.profileId,
          identity: { source: staged.source.url, ...identity },
          runtimeManifest: resolved.runtime.manifest,
          manifestPermissionFingerprint: resolved.packageManifest.permissionFingerprint,
        }
        const receipt = await this.#options.permissionAuthority.review(reviewInput)
        if (!issuedPermissionReceipts.has(receipt) || receipt.inputFingerprint !== fingerprint(reviewInput)) {
          throw new PackageLifecycleError('untrusted-permission-review', 'permission review is stale or not Host-issued')
        }
        permission = permissionSummary(receipt)
        await this.#objects.publish(staged)
        const key = packageKey(identity.pluginId, identity.version, identity.integrity)
        imported = {
          key,
          identity,
          manifest: resolved.packageManifest,
          runtime: resolved.runtime,
          objectDirectory: this.#objects.objectDirectory(staged.digest),
          sources: [staged.source],
          createdAt: now,
        }
      } catch (error) {
        await this.#objects.discard(staged)
        throw error
      }
    }

    const before = await this.#store.refresh()
    const profile = stateProfile(before, input.profileId, input.expected)
    if (profile.revision !== input.expectedRevision) {
      throw new PackageLifecycleError(
        'stale-activation-revision',
        `expected profile activation revision ${input.expectedRevision}; current ${profile.revision}`,
      )
    }
    assertExactFence(currentFence(before, profile), input.expected)
    const pluginId = imported?.identity.pluginId ?? input.pluginId
    if (pluginId === undefined) throw new PackageLifecycleError('missing-plugin-id', `${input.operation} requires a plugin id`)
    if (input.pluginId !== undefined && input.pluginId !== pluginId) {
      throw new PackageLifecycleError('package-identity-mismatch', `requested ${input.pluginId}; package is ${pluginId}`)
    }
    const existing = profile.plugins[pluginId]
    if (input.operation === 'install' && existing?.installed !== undefined && existing.uninstalled !== true) {
      throw new PackageLifecycleError('package-already-installed', `${pluginId} is already installed`)
    }
    if (input.operation !== 'install' && input.operation !== 'update' && existing?.installed === undefined) {
      throw new PackageLifecycleError('package-not-installed', `${pluginId} is not installed`)
    }
    if (input.operation === 'update' && existing?.installed === undefined) {
      throw new PackageLifecycleError('package-not-installed', `${pluginId} cannot be updated before installation`)
    }

    const allPackages = { ...before.packages, ...(imported === undefined ? {} : { [imported.key]: imported }) }
    const currentSelected = selectedPackageKeys(profile, true)
    const candidateInstalled = selectedPackageKeys(profile, false)
    const enabled = new Set(Object.entries(profile.plugins).filter(([, item]) => item.enabled).map(([id]) => id))
    if (input.operation === 'install' || input.operation === 'update') {
      candidateInstalled[pluginId] = imported!.key
      enabled.add(pluginId)
    } else if (input.operation === 'enable') {
      enabled.add(pluginId)
      const record = allPackages[existing!.installed!.packageKey]!
      const reviewInput: HostPermissionReviewInput = {
        transactionId,
        operation: 'enable',
        profileId: input.profileId,
        identity: { source: record.sources[0]!.url, ...record.identity },
        runtimeManifest: record.runtime.manifest,
        manifestPermissionFingerprint: record.manifest.permissionFingerprint,
      }
      const receipt = await this.#options.permissionAuthority.review(reviewInput)
      if (!issuedPermissionReceipts.has(receipt) || receipt.inputFingerprint !== fingerprint(reviewInput)) {
        throw new PackageLifecycleError('untrusted-permission-review', 'permission review is stale or not Host-issued')
      }
      permission = permissionSummary(receipt)
    } else if (input.operation === 'disable') {
      enabled.delete(pluginId)
    } else {
      enabled.delete(pluginId)
      delete candidateInstalled[pluginId]
    }

    const currentGraph = resolvePackageGraph(selectedNodes(allPackages, currentSelected))
    const candidateEnabled = Object.fromEntries(Object.entries(candidateInstalled).filter(([id]) => enabled.has(id)))
    let candidateGraph
    try {
      candidateGraph = resolvePackageGraph(selectedNodes(allPackages, candidateEnabled))
    } catch (error) {
      if ((input.operation === 'disable' || input.operation === 'uninstall')
        && error instanceof PackageLifecycleError && error.code === 'missing-dependency') {
        throw new PackageLifecycleError('package-in-use', `${pluginId} is required by an enabled dependent`)
      }
      throw error
    }
    const currentAffected = affectedClosure([pluginId], currentGraph)
    if ((input.operation === 'disable' || input.operation === 'uninstall') && currentAffected.some(id => id !== pluginId)) {
      throw new PackageLifecycleError('package-in-use', `${pluginId} is required by ${currentAffected.filter(id => id !== pluginId).join(', ')}`)
    }
    const affected = [...new Set([
      ...currentAffected,
      ...affectedClosure([pluginId], candidateGraph),
    ])].sort()
    const target: Record<string, PackageCandidatePlugin> = Object.create(null) as Record<string, PackageCandidatePlugin>
    for (const [id, key] of Object.entries(candidateInstalled)) {
      const current = profile.plugins[id]
      target[id] = {
        enabled: enabled.has(id),
        packageKey: key,
        moduleGeneration: affected.includes(id) ? randomUUID() : (current?.installed?.moduleGeneration ?? randomUUID()),
      }
    }
    if (input.operation === 'uninstall') {
      target[pluginId] = {
        enabled: false,
        packageKey: existing!.installed!.packageKey,
        moduleGeneration: randomUUID(),
        remove: true,
      }
    }
    const activationOrder = candidateGraph.activationOrder.filter(id => affected.includes(id))
    const drainOrder = currentGraph.drainOrder.filter(id => affected.includes(id))
    const candidateFingerprint = fingerprint({
      transactionId,
      operation: input.operation,
      profileId: input.profileId,
      expected: input.expected,
      proposedRuntimeGeneration: input.proposedRuntimeGeneration,
      target,
      affected,
      activationOrder,
      drainOrder,
    })
    const transaction: PackageTransactionRecord = {
      transactionId,
      ownerId: input.ownerId,
      operation: input.operation,
      profileId: input.profileId,
      status: permission !== undefined && !permission.requiredSatisfied ? 'permission-review' : 'ready',
      createdAt: now,
      updatedAt: now,
      baseRevision: input.expectedRevision,
      expected: structuredClone(input.expected),
      proposedRuntimeGeneration: input.proposedRuntimeGeneration,
      target,
      changedPluginIds: [pluginId],
      affectedPluginIds: affected,
      activationOrder,
      drainOrder,
      reloadLevel: input.reloadLevel ?? 'plugin-generation',
      candidateFingerprint,
      candidateTokenHash: tokenHash(candidateId),
      impactTokenHash: tokenHash(impactToken),
      ...(permission === undefined ? {} : { permission }),
    }

    const result = await this.#store.transaction(before.revision, (draft) => {
      const active = Object.values(draft.transactions).find(item => item.profileId === input.profileId && !isTerminal(item.status))
      if (active !== undefined) throw new PackageLifecycleError('transaction-in-progress', `profile already has candidate ${active.transactionId}`)
      if (imported !== undefined) {
        const previous = draft.packages[imported.key]
        if (previous === undefined) draft.packages[imported.key] = imported
        else {
          const { gcEligibleAt: _gcEligibleAt, ...retained } = previous
          draft.packages[imported.key] = {
            ...retained,
            sources: [...new Map([...previous.sources, ...imported.sources]
              .map(source => [`${source.kind}:${source.url}`, source])).values()],
          }
        }
      }
      if (draft.profiles[input.profileId] === undefined) draft.profiles[input.profileId] = profile
      draft.transactions[transactionId] = transaction
      return transaction
    })
    return {
      transaction: result.value,
      candidateId,
      impactToken,
      state: result.state,
      activationAvailable: transaction.status === 'ready',
    }
  }

  async resolveCandidate(
    access: PackageCandidateAccess,
    boundary: PackageResolutionBoundary,
  ): Promise<PackageActivationPlan> {
    const state = await this.#store.refresh()
    const transaction = this.#transactionForCandidate(state, access)
    return this.#activationPlan(transaction, state, access.candidateId, boundary)
  }

  async resolveImpact(access: PackageImpactAccess, boundary: PackageResolutionBoundary): Promise<PackageImpactPlan> {
    const state = await this.#store.refresh()
    const transaction = this.#transactionForImpact(state, access)
    this.#assertResolvable(transaction, state, boundary)
    const impact = this.#recomputeImpact(transaction, state)
    return freeze({
      transactionId: transaction.transactionId,
      impactToken: access.impactToken,
      boundary,
      profileId: transaction.profileId,
      changedPluginIds: [...transaction.changedPluginIds],
      ...impact,
    }) as PackageImpactPlan
  }

  async requestActivation(access: PackageCandidateAccess): Promise<PackageActivationPlan> {
    const before = await this.#store.refresh()
    const transaction = this.#transactionForCandidate(before, access)
    this.#assertResolvable(transaction, before, 'stage')
    if (transaction.status !== 'ready') throw new PackageLifecycleError('transaction-not-ready', `transaction is ${transaction.status}`)
    const result = await this.#store.transaction(before.revision, (draft) => {
      const current = draft.transactions[transaction.transactionId]!
      draft.transactions[transaction.transactionId] = {
        ...current,
        status: 'activation-requested',
        updatedAt: (this.#options.now?.() ?? new Date()).toISOString(),
      }
      return draft.transactions[transaction.transactionId]!
    })
    return this.#activationPlan(result.value, result.state, access.candidateId, 'publish')
  }

  async confirmReadiness(access: PackageCandidateAccess, receipt: PackageReadinessReceipt): Promise<PackageStoreState> {
    const before = await this.#store.refresh()
    const transaction = this.#transactionForCandidate(before, access)
    this.#assertResolvable(transaction, before, 'publish')
    const result = await this.#store.transaction(before.revision, (draft) => {
      const current = draft.transactions[transaction.transactionId]!
      if (current.status !== 'activation-requested') {
        throw new PackageLifecycleError('transaction-not-activating', `transaction is ${current.status}`)
      }
      assertReceipt(current, draft as unknown as PackageStoreState, access, receipt)
      draft.transactions[current.transactionId] = {
        ...current,
        status: 'readiness-confirmed',
        updatedAt: (this.#options.now?.() ?? new Date()).toISOString(),
      }
    })
    return result.state
  }

  async commit(access: PackageCandidateAccess, receipt: PackageReadinessReceipt): Promise<PackageStoreState> {
    const before = await this.#store.refresh()
    const transaction = this.#transactionForCandidate(before, access)
    this.#assertResolvable(transaction, before, 'rollback')
    const result = await this.#store.transaction(before.revision, (draft) => {
      const current = draft.transactions[transaction.transactionId]!
      if (current.status !== 'readiness-confirmed') {
        throw new PackageLifecycleError('transaction-not-ready-to-commit', `transaction is ${current.status}`)
      }
      assertReceipt(current, draft as unknown as PackageStoreState, access, receipt)
      this.#commitDraft(draft as unknown as MutableStoreDraft, current)
    })
    return result.state
  }

  async abort(access: PackageCandidateAccess, failureCode: string): Promise<PackageStoreState> {
    const before = await this.#store.refresh()
    const transaction = this.#transactionForCandidate(before, access)
    const result = await this.#store.transaction(before.revision, (draft) => {
      const current = draft.transactions[transaction.transactionId]!
      if (isTerminal(current.status)) return
      draft.transactions[current.transactionId] = {
        ...current,
        status: 'aborted',
        failureCode,
        updatedAt: (this.#options.now?.() ?? new Date()).toISOString(),
      }
      this.#markGcEligibility(draft as unknown as PackageStoreState)
    })
    return result.state
  }

  /** Launcher-start recovery is privileged and therefore does not require lost in-memory raw tokens. */
  async recover(observations: Readonly<Record<string, PackageRuntimeObservation>>): Promise<{
    readonly state: PackageStoreState
    readonly directives: readonly PackageRecoveryDirective[]
  }> {
    const before = await this.#store.refresh()
    const directives: PackageRecoveryDirective[] = []
    const result = await this.#store.transaction(before.revision, (draft) => {
      const now = (this.#options.now?.() ?? new Date()).toISOString()
      for (const [transactionId, transaction] of Object.entries(draft.transactions)) {
        if (isTerminal(transaction.status)) continue
        const profile = stateProfile(draft as unknown as PackageStoreState, transaction.profileId, transaction.expected)
        assertExactFence(currentFence(draft as unknown as PackageStoreState, profile), transaction.expected)
        this.#recomputeImpact(transaction, draft as unknown as PackageStoreState)
        const observation = observations[transaction.profileId]
        const expectedPlugins = exactReceiptPlugins(transaction, draft as unknown as PackageStoreState)
        const wasPublished = (transaction.status === 'activation-requested' || transaction.status === 'readiness-confirmed')
          && observation !== undefined
          && observation.runtimeGeneration === transaction.proposedRuntimeGeneration
          && fingerprint(observation.plugins) === fingerprint(expectedPlugins)
        directives.push({
          transactionId,
          profileId: transaction.profileId,
          action: wasPublished ? 'rollback-published' : 'discard-staged',
          expectedPublished: this.#afterTuple(draft as unknown as PackageStoreState, transaction, profile),
          rollbackTarget: this.#activeTuple(draft as unknown as PackageStoreState, transaction.profileId, profile),
        })
        draft.transactions[transactionId] = {
          ...transaction,
          status: 'recovered-aborted',
          failureCode: wasPublished ? 'interrupted-after-publish' : 'interrupted-before-publish',
          updatedAt: now,
        }
      }
      this.#markGcEligibility(draft as unknown as PackageStoreState)
    })
    return { state: result.state, directives: freeze(directives) as readonly PackageRecoveryDirective[] }
  }

  async releaseLastGood(profileId: string, pluginId: string, expectedLease: PackageLease): Promise<PackageStoreState> {
    const before = await this.#store.refresh()
    const result = await this.#store.transaction(before.revision, (draft) => {
      const profile = draft.profiles[profileId]
      const plugin = profile?.plugins[pluginId]
      if (profile === undefined || plugin === undefined || fingerprint(plugin.lastGood) !== fingerprint(expectedLease)) {
        throw new PackageLifecycleError('stale-package-lease', 'last-good lease is stale')
      }
      const { lastGood: _lastGood, ...withoutLastGood } = plugin
      draft.profiles[profileId] = { ...profile, plugins: { ...profile.plugins, [pluginId]: withoutLastGood } }
      this.#markGcEligibility(draft as unknown as PackageStoreState)
    })
    return result.state
  }

  async releaseRollbackLease(profileId: string, pluginId: string, expectedLease: PackageLease): Promise<PackageStoreState> {
    const before = await this.#store.refresh()
    const result = await this.#store.transaction(before.revision, (draft) => {
      const profile = draft.profiles[profileId]
      const plugin = profile?.plugins[pluginId]
      if (profile === undefined || plugin === undefined) throw new PackageLifecycleError('package-not-installed', `${pluginId} is unknown`)
      const index = plugin.rollbackLeases.findIndex(lease => fingerprint(lease) === fingerprint(expectedLease))
      if (index < 0) throw new PackageLifecycleError('stale-package-lease', 'rollback lease is stale')
      const updated: PluginPackageState = {
        ...plugin,
        rollbackLeases: plugin.rollbackLeases.filter((_, itemIndex) => itemIndex !== index),
      }
      draft.profiles[profileId] = { ...profile, plugins: { ...profile.plugins, [pluginId]: updated } }
      this.#markGcEligibility(draft as unknown as PackageStoreState)
    })
    return result.state
  }

  async collectGarbage(graceMs: number, now = this.#options.now?.() ?? new Date()): Promise<{
    readonly removed: readonly string[]
    readonly state: PackageStoreState
  }> {
    if (!Number.isFinite(graceMs) || graceMs < 0) throw new Error('graceMs must be a non-negative number')
    const before = await this.#store.refresh()
    const removed: PackageObjectRecord[] = []
    const result = await this.#store.transaction(before.revision, (draft) => {
      this.#markGcEligibility(draft as unknown as PackageStoreState, now)
      const counts = referenceCounts(draft as unknown as PackageStoreState)
      for (const [key, record] of Object.entries(draft.packages)) {
        if ((counts[key] ?? 0) !== 0 || record.gcEligibleAt === undefined) continue
        if (now.getTime() - Date.parse(record.gcEligibleAt) < graceMs) continue
        removed.push(record)
        delete draft.packages[key]
      }
    })
    for (const record of removed) await this.#objects.removeObject(record.identity.integrity.slice('sha256:'.length))
    return { removed: removed.map(record => record.key), state: result.state }
  }

  #transactionForCandidate(state: PackageStoreState, access: PackageCandidateAccess): PackageTransactionRecord {
    assertInputIdentity(access.ownerId, access.profileId, 'access', 'access generation marker')
    const transaction = Object.values(state.transactions).find(item => item.candidateTokenHash === tokenHash(access.candidateId))
    if (transaction === undefined) throw new PackageLifecycleError('candidate-token-invalid', 'candidate token is invalid')
    this.#assertAccess(transaction, access.ownerId, access.profileId)
    return transaction
  }

  #transactionForImpact(state: PackageStoreState, access: PackageImpactAccess): PackageTransactionRecord {
    assertInputIdentity(access.ownerId, access.profileId, 'access', 'access generation marker')
    const transaction = Object.values(state.transactions).find(item => item.impactTokenHash === tokenHash(access.impactToken))
    if (transaction === undefined) throw new PackageLifecycleError('impact-token-invalid', 'impact token is invalid')
    this.#assertAccess(transaction, access.ownerId, access.profileId)
    return transaction
  }

  #assertAccess(transaction: PackageTransactionRecord, ownerId: string, profileId: string): void {
    if (transaction.ownerId !== ownerId) throw new PackageLifecycleError('candidate-owner-mismatch', 'token owner is invalid')
    if (transaction.profileId !== profileId) throw new PackageLifecycleError('candidate-profile-mismatch', 'token profile is invalid')
  }

  #assertResolvable(transaction: PackageTransactionRecord, state: PackageStoreState, boundary: PackageResolutionBoundary): void {
    if (transaction.permission !== undefined && !transaction.permission.requiredSatisfied) {
      throw new PackageLifecycleError('permission-review-required', 'required permissions are unresolved or denied')
    }
    if (!boundaryAllows(boundary, transaction.status)) {
      throw new PackageLifecycleError('candidate-boundary-invalid', `${boundary} cannot resolve transaction ${transaction.status}`)
    }
    const profile = stateProfile(state, transaction.profileId, transaction.expected)
    if (profile.revision !== transaction.baseRevision) {
      throw new PackageLifecycleError('stale-activation-revision', 'profile activation revision changed')
    }
    assertExactFence(currentFence(state, profile), transaction.expected)
    this.#recomputeImpact(transaction, state)
  }

  #recomputeImpact(transaction: PackageTransactionRecord, state: PackageStoreState): {
    readonly affectedPluginIds: readonly string[]
    readonly activationOrder: readonly string[]
    readonly drainOrder: readonly string[]
  } {
    const profile = stateProfile(state, transaction.profileId, transaction.expected)
    const currentGraph = resolvePackageGraph(selectedNodes(state.packages, selectedPackageKeys(profile, true)))
    const candidateSelected = Object.fromEntries(Object.entries(transaction.target)
      .filter(([, target]) => target.enabled && target.remove !== true && target.packageKey !== undefined)
      .map(([id, target]) => [id, target.packageKey!]))
    const candidateGraph = resolvePackageGraph(selectedNodes(state.packages, candidateSelected))
    const affectedPluginIds = [...new Set([
      ...affectedClosure(transaction.changedPluginIds, currentGraph),
      ...affectedClosure(transaction.changedPluginIds, candidateGraph),
    ])].sort()
    const activationOrder = candidateGraph.activationOrder.filter(id => affectedPluginIds.includes(id))
    const drainOrder = currentGraph.drainOrder.filter(id => affectedPluginIds.includes(id))
    if (fingerprint({ affectedPluginIds, activationOrder, drainOrder }) !== fingerprint({
      affectedPluginIds: transaction.affectedPluginIds,
      activationOrder: transaction.activationOrder,
      drainOrder: transaction.drainOrder,
    })) {
      throw new PackageLifecycleError('stale-impact-token', 'Host-recomputed dependency closure differs from journal')
    }
    return { affectedPluginIds, activationOrder, drainOrder }
  }

  #activationPlan(
    transaction: PackageTransactionRecord,
    state: PackageStoreState,
    candidateId: PackageCandidateToken,
    boundary: PackageResolutionBoundary,
  ): PackageActivationPlan {
    this.#assertResolvable(transaction, state, boundary)
    const profile = stateProfile(state, transaction.profileId, transaction.expected)
    const current = this.#activeTuple(state, transaction.profileId, profile)
    const after = this.#afterTuple(state, transaction, profile)
    return freeze({
      transactionId: transaction.transactionId,
      candidateId,
      boundary,
      profileId: transaction.profileId,
      profileActivationRevision: profile.revision,
      candidateFingerprint: transaction.candidateFingerprint,
      expected: structuredClone(current),
      current,
      after,
      lastGood: structuredClone(current),
      affectedPluginIds: [...transaction.affectedPluginIds],
      activationOrder: [...transaction.activationOrder],
      drainOrder: [...transaction.drainOrder],
    }) as PackageActivationPlan
  }

  #activeTuple(state: PackageStoreState, profileId: string, profile: PackageProfileState): PackageActivationTuple {
    const plugins: Record<string, PackageActivationPlugin> = Object.create(null) as Record<string, PackageActivationPlugin>
    for (const [pluginId, plugin] of Object.entries(profile.plugins)) {
      const lease = plugin.active
      if (lease === undefined) continue
      const record = state.packages[lease.packageKey]
      if (record === undefined) throw new PackageLifecycleError('missing-package-object', `missing active package ${lease.packageKey}`)
      plugins[pluginId] = { enabled: plugin.enabled, moduleGeneration: lease.moduleGeneration, package: this.#packageProjection(record) }
    }
    return { profileId, revision: profile.revision, runtimeGeneration: profile.runtimeGeneration, plugins }
  }

  #afterTuple(state: PackageStoreState, transaction: PackageTransactionRecord, profile: PackageProfileState): PackageActivationTuple {
    const plugins: Record<string, PackageActivationPlugin> = Object.create(null) as Record<string, PackageActivationPlugin>
    for (const [pluginId, target] of Object.entries(transaction.target)) {
      if (target.remove === true || target.packageKey === undefined) continue
      const record = state.packages[target.packageKey]
      if (record === undefined) throw new PackageLifecycleError('missing-package-object', `missing candidate package ${target.packageKey}`)
      plugins[pluginId] = {
        enabled: target.enabled,
        moduleGeneration: target.moduleGeneration,
        package: this.#packageProjection(record),
      }
    }
    return {
      profileId: transaction.profileId,
      revision: profile.revision + 1,
      runtimeGeneration: transaction.proposedRuntimeGeneration,
      plugins,
    }
  }

  #packageProjection(record: PackageObjectRecord): ActivationPackageProjection {
    return {
      identity: record.identity,
      artifactDirectory: record.objectDirectory,
      runtimeEntry: objectEntry(record.objectDirectory, record.runtime.entry),
      runtimeManifestIntegrity: record.runtime.manifestIntegrity,
      runtimeManifest: record.runtime.manifest,
      dependencies: record.manifest.dependencies,
    }
  }

  #commitDraft(draft: MutableStoreDraft, transaction: PackageTransactionRecord): void {
    const profile = draft.profiles[transaction.profileId] ?? stateProfile(
      draft as unknown as PackageStoreState,
      transaction.profileId,
      transaction.expected,
    )
    const plugins: Record<string, PluginPackageState> = { ...profile.plugins }
    for (const pluginId of transaction.affectedPluginIds) {
      const previous = plugins[pluginId] ?? { enabled: false, rollbackLeases: [] }
      const target = transaction.target[pluginId]!
      if (target.remove === true) {
        const lastGood = previous.active ?? previous.installed ?? previous.lastGood
        const rollbackLeases = previous.active === undefined
          ? previous.rollbackLeases
          : [...previous.rollbackLeases, previous.active]
        plugins[pluginId] = {
          enabled: false,
          ...(lastGood === undefined ? {} : { lastGood }),
          rollbackLeases,
          uninstalled: true,
        }
        continue
      }
      if (target.packageKey === undefined) throw new PackageLifecycleError('invalid-transaction', `target package is missing for ${pluginId}`)
      const installed = { packageKey: target.packageKey, moduleGeneration: target.moduleGeneration }
      const changed = previous.active !== undefined && fingerprint(previous.active) !== fingerprint(installed)
      const retiringActive = !target.enabled ? previous.active : (changed ? previous.active : undefined)
      const lastGood = retiringActive ?? previous.lastGood
      const rollbackLeases = retiringActive === undefined
        ? previous.rollbackLeases
        : [...previous.rollbackLeases, retiringActive]
      plugins[pluginId] = {
        enabled: target.enabled,
        installed,
        ...(target.enabled ? { active: installed } : {}),
        ...(lastGood === undefined ? {} : { lastGood }),
        rollbackLeases,
      }
    }
    draft.profiles[transaction.profileId] = {
      revision: profile.revision + 1,
      lastGoodRevision: profile.revision,
      runtimeGeneration: transaction.proposedRuntimeGeneration,
      lastGoodRuntimeGeneration: profile.runtimeGeneration,
      plugins,
    }
    draft.transactions[transaction.transactionId] = {
      ...transaction,
      status: 'committed',
      updatedAt: (this.#options.now?.() ?? new Date()).toISOString(),
    }
    this.#markGcEligibility(draft as unknown as PackageStoreState)
  }

  #markGcEligibility(state: PackageStoreState, now = this.#options.now?.() ?? new Date()): void {
    const counts = referenceCounts(state)
    const packages = state.packages as Record<string, PackageObjectRecord>
    for (const [key, record] of Object.entries(packages)) {
      if ((counts[key] ?? 0) === 0 && record.gcEligibleAt === undefined) packages[key] = { ...record, gcEligibleAt: now.toISOString() }
      else if ((counts[key] ?? 0) > 0 && record.gcEligibleAt !== undefined) {
        const { gcEligibleAt: _gcEligibleAt, ...retained } = record
        packages[key] = retained
      }
    }
  }
}

interface MutableStoreDraft {
  profiles: Record<string, PackageProfileState>
  packages: Record<string, PackageObjectRecord>
  transactions: Record<string, PackageTransactionRecord>
}
