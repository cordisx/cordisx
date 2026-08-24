import { createHash, randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import type {
  ActivationPackageProjection,
  HostPackageManifest,
  LocalPackageSource,
  PackageActivationCandidate,
  PackageCandidatePlugin,
  PackageFenceEntry,
  PackageGenerationFence,
  PackageLease,
  PackageManifestReader,
  PackageObjectRecord,
  PackageOperation,
  PackagePermissionReview,
  PackageProfileState,
  PackageReadinessReceipt,
  PackageReloadLevel,
  PackageRuntimeObservation,
  PackageStoreState,
  PackageTransactionRecord,
  PluginPackageState,
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
const GENERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA256_INTEGRITY = /^sha256:[a-f0-9]{64}$/

export interface HostPermissionReviewInput {
  readonly transactionId: string
  readonly operation: 'install' | 'enable'
  readonly profileId: string
  readonly identity: {
    readonly source: string
    readonly pluginId: string
    readonly version: string
    readonly integrity: string
  }
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

/**
 * Wrap the existing Host Permission Broker adapter. Receipts are accepted only
 * when issued by this launcher-local authority, never from renderer booleans.
 */
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
  readonly hostVersion: string
  readonly protocolVersion?: string
  readonly manifestReader: PackageManifestReader
  readonly permissionAuthority: HostPermissionReviewAuthority
  readonly now?: () => Date
}

export interface PreparePackageTransactionInput {
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

function packageKey(pluginId: string, version: string, integrity: string): string {
  if (!SHA256_INTEGRITY.test(integrity)) throw new PackageLifecycleError('invalid-integrity', 'package integrity is invalid')
  return `${pluginId}@${version}#${integrity}`
}

function assertProfileAndGeneration(profileId: string, generation: string, label: string): void {
  if (!PROFILE_ID.test(profileId)) throw new PackageLifecycleError('invalid-profile', `invalid profile id: ${profileId}`)
  if (!GENERATION_ID.test(generation)) throw new PackageLifecycleError('invalid-generation', `${label} is invalid`)
}

function stateProfile(state: PackageStoreState, profileId: string, expected: PackageGenerationFence): PackageProfileState {
  const existing = state.profiles[profileId]
  if (existing !== undefined) return existing
  if (Object.keys(expected.plugins).length !== 0) {
    throw new PackageLifecycleError('stale-package-fence', 'new package profile expected plugins must be empty')
  }
  return { runtimeGeneration: expected.runtimeGeneration, plugins: {} }
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
    plugins[pluginId] = { pluginGeneration: plugin.active.pluginGeneration, identity: record.identity }
  }
  return { runtimeGeneration: profile.runtimeGeneration, plugins }
}

function assertExactFence(actual: PackageGenerationFence, expected: PackageGenerationFence): void {
  if (fingerprint(actual) !== fingerprint(expected)) {
    throw new PackageLifecycleError('stale-package-fence', 'runtime generation, plugin generation, or package identity is stale')
  }
}

function objectEntry(objectDirectory: string, relative: string): string {
  return path.resolve(objectDirectory, relative.slice(2))
}

async function validateResolvedEntries(objectDirectory: string, manifest: HostPackageManifest): Promise<void> {
  const root = `${await realpath(objectDirectory)}${path.sep}`
  const entries = [manifest.entries.renderer, ...(manifest.entries.node ?? [])].filter((entry): entry is string => entry !== undefined)
  for (const entry of entries) {
    const resolved = await realpath(objectEntry(objectDirectory, entry)).catch(() => {
      throw new PackageLifecycleError('missing-package-entry', `package entry does not exist: ${entry}`)
    })
    if (!`${resolved}${path.sep}`.startsWith(root) && !resolved.startsWith(root)) {
      throw new PackageLifecycleError('package-entry-escape', `package entry escapes immutable object: ${entry}`)
    }
    const metadata = await lstat(resolved)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new PackageLifecycleError('invalid-package-entry', `package entry must be a regular file: ${entry}`)
    }
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

function exactReceiptPlugins(
  transaction: PackageTransactionRecord,
  state: PackageStoreState,
): Record<string, PackageFenceEntry> {
  const result: Record<string, PackageFenceEntry> = Object.create(null) as Record<string, PackageFenceEntry>
  for (const pluginId of transaction.affectedPluginIds) {
    const target = transaction.target[pluginId]
    const expected = transaction.expected.plugins[pluginId]
    const key = target?.packageKey
    const record = key === undefined ? (expected === undefined ? undefined : Object.values(state.packages)
      .find(candidate => fingerprint(candidate.identity) === fingerprint(expected.identity))) : state.packages[key]
    if (record === undefined || target === undefined) {
      throw new PackageLifecycleError('missing-package-fence', `transaction lacks package fence for ${pluginId}`)
    }
    result[pluginId] = { pluginGeneration: target.pluginGeneration, identity: record.identity }
  }
  return result
}

function assertReceipt(
  transaction: PackageTransactionRecord,
  state: PackageStoreState,
  receipt: PackageReadinessReceipt,
): void {
  if (receipt.transactionId !== transaction.transactionId
    || receipt.candidateFingerprint !== transaction.candidateFingerprint
    || receipt.runtimeGeneration !== transaction.proposedRuntimeGeneration
    || fingerprint(receipt.plugins) !== fingerprint(exactReceiptPlugins(transaction, state))) {
    throw new PackageLifecycleError('stale-readiness-receipt', 'readiness receipt failed runtime/plugin/package fence')
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
    assertProfileAndGeneration(input.profileId, input.expected.runtimeGeneration, 'expected runtime generation')
    assertProfileAndGeneration(input.profileId, input.proposedRuntimeGeneration, 'proposed runtime generation')
    const transactionId = randomUUID()
    const now = (this.#options.now?.() ?? new Date()).toISOString()
    let imported: PackageObjectRecord | undefined
    let permission: PackagePermissionReview | undefined

    if (input.operation === 'install' || input.operation === 'upgrade') {
      if (input.source === undefined) throw new PackageLifecycleError('missing-package-source', `${input.operation} requires a package source`)
      const staged = await this.#objects.snapshot(input.source, transactionId)
      try {
        const manifest = await this.#options.manifestReader.read(staged.payloadDirectory)
        validateHostPackageManifest(manifest)
        assertPackageCompatibility(manifest, this.#options)
        const identity = { pluginId: manifest.pluginId, version: manifest.version, integrity: staged.integrity }
        const key = packageKey(identity.pluginId, identity.version, identity.integrity)
        const objectDirectory = this.#objects.objectDirectory(staged.digest)
        await validateResolvedEntries(staged.payloadDirectory, manifest)
        const reviewInput: HostPermissionReviewInput = {
          transactionId,
          operation: 'install',
          profileId: input.profileId,
          identity: { source: staged.source.url, ...identity },
          manifestPermissionFingerprint: manifest.permissionFingerprint,
        }
        const receipt = await this.#options.permissionAuthority.review(reviewInput)
        if (!issuedPermissionReceipts.has(receipt) || receipt.inputFingerprint !== fingerprint(reviewInput)) {
          throw new PackageLifecycleError('untrusted-permission-review', 'permission review is stale or not Host-issued')
        }
        permission = permissionSummary(receipt)
        await this.#objects.publish(staged)
        imported = {
          key,
          identity,
          manifest,
          objectDirectory,
          sources: [staged.source],
          createdAt: now,
        }
      } catch (error) {
        await this.#objects.discard(staged)
        throw error
      }
    }

    const before = this.#store.snapshot()
    if (before.revision !== input.expectedRevision) {
      throw new PackageLifecycleError('stale-store-revision', `expected package store revision ${input.expectedRevision}; current ${before.revision}`)
    }
    const profile = stateProfile(before, input.profileId, input.expected)
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
    if (input.operation !== 'install' && input.operation !== 'upgrade' && existing?.installed === undefined) {
      throw new PackageLifecycleError('package-not-installed', `${pluginId} is not installed`)
    }
    if (input.operation === 'upgrade' && existing?.installed === undefined) {
      throw new PackageLifecycleError('package-not-installed', `${pluginId} cannot be upgraded before installation`)
    }

    const allPackages = { ...before.packages, ...(imported === undefined ? {} : { [imported.key]: imported }) }
    const currentSelected = selectedPackageKeys(profile, true)
    const candidateInstalled = selectedPackageKeys(profile, false)
    const enabled = new Set(Object.entries(profile.plugins).filter(([, item]) => item.enabled).map(([id]) => id))
    if (input.operation === 'install' || input.operation === 'upgrade') {
      candidateInstalled[pluginId] = imported!.key
      enabled.add(pluginId)
    } else if (input.operation === 'enable') {
      enabled.add(pluginId)
      permission = permissionSummary(await this.#options.permissionAuthority.review({
        transactionId,
        operation: 'enable',
        profileId: input.profileId,
        identity: {
          source: allPackages[existing!.installed!.packageKey]!.sources[0]!.url,
          ...allPackages[existing!.installed!.packageKey]!.identity,
        },
        manifestPermissionFingerprint: allPackages[existing!.installed!.packageKey]!.manifest.permissionFingerprint,
      }))
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
        pluginGeneration: affected.includes(id) ? randomUUID() : (current?.installed?.pluginGeneration ?? randomUUID()),
      }
    }
    if (input.operation === 'uninstall') {
      target[pluginId] = {
        enabled: false,
        packageKey: existing!.installed!.packageKey,
        pluginGeneration: randomUUID(),
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
      operation: input.operation,
      profileId: input.profileId,
      status: permission !== undefined && !permission.requiredSatisfied ? 'permission-review' : 'ready',
      createdAt: now,
      updatedAt: now,
      baseRevision: input.expectedRevision,
      expected: structuredClone(input.expected),
      proposedRuntimeGeneration: input.proposedRuntimeGeneration,
      target,
      affectedPluginIds: affected,
      activationOrder,
      drainOrder,
      reloadLevel: input.reloadLevel ?? 'plugin-generation',
      candidateFingerprint,
      ...(permission === undefined ? {} : { permission }),
    }

    const result = await this.#store.transaction(input.expectedRevision, (draft) => {
      const active = Object.values(draft.transactions).find(item => item.profileId === input.profileId && !isTerminal(item.status))
      if (active !== undefined) throw new PackageLifecycleError('transaction-in-progress', `profile already has candidate ${active.transactionId}`)
      if (imported !== undefined) {
        const previous = draft.packages[imported.key]
        if (previous === undefined) draft.packages[imported.key] = imported
        else {
          const { gcEligibleAt: _gcEligibleAt, ...retained } = previous
          draft.packages[imported.key] = {
            ...retained,
            sources: [...new Map([...previous.sources, ...imported.sources].map(source => [`${source.kind}:${source.url}`, source])).values()],
          }
        }
      }
      if (draft.profiles[input.profileId] === undefined) draft.profiles[input.profileId] = profile
      draft.transactions[transactionId] = transaction
      return transaction
    })
    return { transaction: result.value, state: result.state, activationAvailable: transaction.status === 'ready' }
  }

  async requestActivation(transactionId: string, expectedRevision: number): Promise<PackageActivationCandidate> {
    const result = await this.#store.transaction(expectedRevision, (draft) => {
      const transaction = draft.transactions[transactionId]
      if (transaction === undefined) throw new PackageLifecycleError('transaction-not-found', `unknown transaction: ${transactionId}`)
      if (transaction.status !== 'ready') {
        throw new PackageLifecycleError('transaction-not-ready', `transaction is ${transaction.status}`)
      }
      const updated = { ...transaction, status: 'activation-requested' as const, updatedAt: (this.#options.now?.() ?? new Date()).toISOString() }
      draft.transactions[transactionId] = updated
      return updated
    })
    return this.#activationCandidate(result.value, result.state)
  }

  async confirmReadiness(receipt: PackageReadinessReceipt): Promise<PackageStoreState> {
    const result = await this.#store.transaction(receipt.storeRevision, (draft) => {
      const transaction = draft.transactions[receipt.transactionId]
      if (transaction === undefined) throw new PackageLifecycleError('transaction-not-found', 'readiness transaction is unknown')
      if (transaction.status !== 'activation-requested') {
        throw new PackageLifecycleError('transaction-not-activating', `transaction is ${transaction.status}`)
      }
      assertReceipt(transaction, draft as unknown as PackageStoreState, receipt)
      draft.transactions[receipt.transactionId] = {
        ...transaction,
        status: 'readiness-confirmed',
        updatedAt: (this.#options.now?.() ?? new Date()).toISOString(),
      }
    })
    return result.state
  }

  async commit(receipt: PackageReadinessReceipt, expectedRevision: number): Promise<PackageStoreState> {
    const result = await this.#store.transaction(expectedRevision, (draft) => {
      const transaction = draft.transactions[receipt.transactionId]
      if (transaction === undefined) throw new PackageLifecycleError('transaction-not-found', 'commit transaction is unknown')
      if (transaction.status !== 'readiness-confirmed') {
        throw new PackageLifecycleError('transaction-not-ready-to-commit', `transaction is ${transaction.status}`)
      }
      assertReceipt(transaction, draft as unknown as PackageStoreState, receipt)
      this.#commitDraft(draft as unknown as {
        profiles: Record<string, PackageProfileState>
        packages: Record<string, PackageObjectRecord>
        transactions: Record<string, PackageTransactionRecord>
      }, transaction)
    })
    return result.state
  }

  async abort(transactionId: string, expectedRevision: number, failureCode: string): Promise<PackageStoreState> {
    const result = await this.#store.transaction(expectedRevision, (draft) => {
      const transaction = draft.transactions[transactionId]
      if (transaction === undefined) throw new PackageLifecycleError('transaction-not-found', `unknown transaction: ${transactionId}`)
      if (isTerminal(transaction.status)) return
      draft.transactions[transactionId] = {
        ...transaction,
        status: 'aborted',
        failureCode,
        updatedAt: (this.#options.now?.() ?? new Date()).toISOString(),
      }
      this.#markGcEligibility(draft as unknown as PackageStoreState)
    })
    return result.state
  }

  async recover(
    expectedRevision: number,
    observations: Readonly<Record<string, PackageRuntimeObservation>>,
  ): Promise<PackageStoreState> {
    const result = await this.#store.transaction(expectedRevision, (draft) => {
      const now = (this.#options.now?.() ?? new Date()).toISOString()
      for (const [transactionId, transaction] of Object.entries(draft.transactions)) {
        if (isTerminal(transaction.status)) continue
        const observation = observations[transaction.profileId]
        const expectedPlugins = exactReceiptPlugins(transaction, draft as unknown as PackageStoreState)
        const canCommit = (transaction.status === 'activation-requested' || transaction.status === 'readiness-confirmed')
          && observation !== undefined
          && observation.runtimeGeneration === transaction.proposedRuntimeGeneration
          && fingerprint(observation.plugins) === fingerprint(expectedPlugins)
        if (canCommit) {
          this.#commitDraft(draft as unknown as {
            profiles: Record<string, PackageProfileState>
            packages: Record<string, PackageObjectRecord>
            transactions: Record<string, PackageTransactionRecord>
          }, transaction)
        } else {
          draft.transactions[transactionId] = {
            ...transaction,
            status: 'recovered-aborted',
            failureCode: 'interrupted-or-stale-generation',
            updatedAt: now,
          }
        }
      }
      this.#markGcEligibility(draft as unknown as PackageStoreState)
    })
    return result.state
  }

  async releaseLastGood(
    profileId: string,
    pluginId: string,
    expectedRevision: number,
    expectedLease: PackageLease,
  ): Promise<PackageStoreState> {
    const result = await this.#store.transaction(expectedRevision, (draft) => {
      const profile = draft.profiles[profileId]
      const plugin = profile?.plugins[pluginId]
      if (profile === undefined || plugin === undefined || fingerprint(plugin.lastGood) !== fingerprint(expectedLease)) {
        throw new PackageLifecycleError('stale-package-lease', 'last-good lease is stale')
      }
      const { lastGood: _lastGood, ...withoutLastGood } = plugin
      const plugins = { ...profile.plugins, [pluginId]: withoutLastGood }
      draft.profiles[profileId] = { ...profile, plugins }
      this.#markGcEligibility(draft as unknown as PackageStoreState)
    })
    return result.state
  }

  async releaseRollbackLease(
    profileId: string,
    pluginId: string,
    expectedRevision: number,
    expectedLease: PackageLease,
  ): Promise<PackageStoreState> {
    const result = await this.#store.transaction(expectedRevision, (draft) => {
      const profile = draft.profiles[profileId]
      const plugin = profile?.plugins[pluginId]
      if (profile === undefined || plugin === undefined) throw new PackageLifecycleError('package-not-installed', `${pluginId} is unknown`)
      const index = plugin.rollbackLeases.findIndex(lease => fingerprint(lease) === fingerprint(expectedLease))
      if (index < 0) throw new PackageLifecycleError('stale-package-lease', 'rollback lease is stale')
      const rollbackLeases = plugin.rollbackLeases.filter((_, itemIndex) => itemIndex !== index)
      const updated: PluginPackageState = { ...plugin, rollbackLeases }
      const plugins = { ...profile.plugins, [pluginId]: updated }
      draft.profiles[profileId] = { ...profile, plugins }
      this.#markGcEligibility(draft as unknown as PackageStoreState)
    })
    return result.state
  }

  async collectGarbage(expectedRevision: number, graceMs: number, now = this.#options.now?.() ?? new Date()): Promise<{
    readonly removed: readonly string[]
    readonly state: PackageStoreState
  }> {
    if (!Number.isFinite(graceMs) || graceMs < 0) throw new Error('graceMs must be a non-negative number')
    const removed: PackageObjectRecord[] = []
    const result = await this.#store.transaction(expectedRevision, (draft) => {
      this.#markGcEligibility(draft as unknown as PackageStoreState, now)
      const counts = referenceCounts(draft as unknown as PackageStoreState)
      for (const [key, record] of Object.entries(draft.packages)) {
        if ((counts[key] ?? 0) !== 0 || record.gcEligibleAt === undefined) continue
        if (now.getTime() - Date.parse(record.gcEligibleAt) < graceMs) continue
        removed.push(record)
        delete draft.packages[key]
      }
    })
    for (const record of removed) {
      const digest = record.identity.integrity.slice('sha256:'.length)
      await this.#objects.removeObject(digest)
    }
    return { removed: removed.map(record => record.key), state: result.state }
  }

  #activationCandidate(transaction: PackageTransactionRecord, state: PackageStoreState): PackageActivationCandidate {
    const profile = state.profiles[transaction.profileId]
    if (profile === undefined) throw new PackageLifecycleError('profile-not-found', `missing profile ${transaction.profileId}`)
    const plugins: Record<string, PackageActivationCandidate['plugins'][string]> = Object.create(null) as Record<string, PackageActivationCandidate['plugins'][string]>
    for (const pluginId of transaction.affectedPluginIds) {
      const target = transaction.target[pluginId]
      if (target === undefined) throw new PackageLifecycleError('invalid-transaction', `missing target for ${pluginId}`)
      const fallback = profile.plugins[pluginId]?.installed?.packageKey
      const packageRecord = state.packages[target.packageKey ?? fallback ?? '']
      plugins[pluginId] = {
        enabled: target.enabled,
        pluginGeneration: target.pluginGeneration,
        ...(packageRecord === undefined ? {} : { package: this.#packageProjection(packageRecord) }),
      }
    }
    return {
      transactionId: transaction.transactionId,
      storeRevision: state.revision,
      profileId: transaction.profileId,
      expected: transaction.expected,
      proposedRuntimeGeneration: transaction.proposedRuntimeGeneration,
      candidateFingerprint: transaction.candidateFingerprint,
      affectedPluginIds: transaction.affectedPluginIds,
      activationOrder: transaction.activationOrder,
      drainOrder: transaction.drainOrder,
      plugins,
    }
  }

  #packageProjection(record: PackageObjectRecord): ActivationPackageProjection {
    return {
      identity: record.identity,
      objectDirectory: record.objectDirectory,
      ...(record.manifest.entries.renderer === undefined ? {} : {
        rendererEntry: objectEntry(record.objectDirectory, record.manifest.entries.renderer),
      }),
      nodeEntries: (record.manifest.entries.node ?? []).map(entry => objectEntry(record.objectDirectory, entry)),
      dependencies: record.manifest.dependencies,
    }
  }

  #commitDraft(
    draft: {
      profiles: Record<string, PackageProfileState>
      packages: Record<string, PackageObjectRecord>
      transactions: Record<string, PackageTransactionRecord>
    },
    transaction: PackageTransactionRecord,
  ): void {
    const profile = draft.profiles[transaction.profileId] ?? {
      runtimeGeneration: transaction.expected.runtimeGeneration,
      plugins: {},
    }
    const plugins: Record<string, PluginPackageState> = { ...profile.plugins }
    for (const pluginId of transaction.affectedPluginIds) {
      const previous = plugins[pluginId] ?? { enabled: false, rollbackLeases: [] }
      const target = transaction.target[pluginId]!
      if (target.remove === true) {
        const lastGood = previous.active ?? previous.installed ?? previous.lastGood
        const rollbackLeases = [...previous.rollbackLeases, ...[previous.active].filter((lease): lease is PackageLease => lease !== undefined)]
        plugins[pluginId] = {
          enabled: false,
          ...(lastGood === undefined ? {} : { lastGood }),
          rollbackLeases,
          uninstalled: true,
        }
        continue
      }
      if (target.packageKey === undefined) {
        throw new PackageLifecycleError('invalid-transaction', `target package is missing for ${pluginId}`)
      }
      const installed = { packageKey: target.packageKey, pluginGeneration: target.pluginGeneration }
      const changed = previous.active !== undefined && fingerprint(previous.active) !== fingerprint(installed)
      const retiringActive = !target.enabled ? previous.active : (changed ? previous.active : undefined)
      const lastGood = retiringActive ?? previous.lastGood
      const rollbackLeases = retiringActive !== undefined
        ? [...previous.rollbackLeases, retiringActive]
        : previous.rollbackLeases
      plugins[pluginId] = {
        enabled: target.enabled,
        installed,
        ...(target.enabled ? { active: installed } : {}),
        ...(lastGood === undefined ? {} : { lastGood }),
        rollbackLeases,
      }
    }
    draft.profiles[transaction.profileId] = {
      runtimeGeneration: transaction.proposedRuntimeGeneration,
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
      if ((counts[key] ?? 0) === 0 && record.gcEligibleAt === undefined) {
        packages[key] = { ...record, gcEligibleAt: now.toISOString() }
      } else if ((counts[key] ?? 0) > 0 && record.gcEligibleAt !== undefined) {
        const { gcEligibleAt: _gcEligibleAt, ...retained } = record
        packages[key] = retained
      }
    }
  }
}
