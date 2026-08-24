import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { CordisXPluginActivationRecordV1 } from '../../plugin-lifecycle-contracts.js'
import {
  PluginActivationStore,
  pluginDependentClosure,
  topologicalPluginOrder,
} from '../plugin-activation.js'
import {
  loadStagedPluginPackage,
  removeStagedPluginPackage,
  stagedPluginModulePath,
} from '../plugin-package.js'
import type {
  HostPermissionReviewId,
  HostPermissionReviewToken,
  PackageActivationTuple,
  PackageCandidatePlan,
  PackageCandidateToken,
  PackageIdentity,
  PackageImpactToken,
  PackageResolutionBoundary,
  PackageRollbackToken,
  PackageRuntimeObservation,
} from './types.js'
import { PackageLifecycleError } from './types.js'

type Operation = 'install' | 'update' | 'enable' | 'disable' | 'uninstall'
type Status = 'permission-review' | 'ready' | 'activation-requested' | 'readiness-confirmed' | 'committed' | 'completed' | 'rollback-pending' | 'aborted' | 'recovered-aborted'

export interface CandidateAccess {
  readonly ownerId: string
  readonly profileId: string
  readonly candidateToken: PackageCandidateToken
  readonly permissionReviewToken?: HostPermissionReviewToken
}

export interface ImpactAccess {
  readonly ownerId: string
  readonly profileId: string
  readonly impactToken: PackageImpactToken
}

export interface RollbackAccess {
  readonly ownerId: string
  readonly profileId: string
  readonly rollbackToken: PackageRollbackToken
}

export interface HostPermissionReviewInput {
  readonly ownerId: string
  readonly profileId: string
  readonly transactionId: string
  readonly candidateFingerprint: string
  readonly packageIdentity: PackageIdentity
  readonly permissionPlanRevision: number
  readonly permissionPlanFingerprint: string
}

export interface HostPermissionReviewDecision {
  readonly planId: string
  readonly planRevision: number
  readonly decisionId: string
  readonly decisionFingerprint: string
  readonly requiredSatisfied: boolean
  readonly unresolvedRequired: readonly string[]
  readonly deniedRequired: readonly string[]
  readonly oneShotGrantIds: readonly string[]
}

export interface HostPermissionReviewReceipt extends HostPermissionReviewDecision {
  readonly inputFingerprint: string
}

export interface HostPermissionReviewAuthority {
  review(input: HostPermissionReviewInput): Promise<HostPermissionReviewReceipt>
  revokeOneShot(grantIds: readonly string[]): Promise<void>
}

const permissionReceipts = new WeakSet<object>()

export function createHostPermissionReviewAuthority(
  review: (input: HostPermissionReviewInput) => Promise<HostPermissionReviewDecision>,
  revokeOneShot: (grantIds: readonly string[]) => Promise<void> = async () => undefined,
): HostPermissionReviewAuthority {
  return {
    async review(input) {
      const decision = await review(deepFreeze(structuredClone(input)))
      const receipt = deepFreeze({ ...decision, inputFingerprint: fingerprint(input) })
      permissionReceipts.add(receipt)
      return receipt
    },
    revokeOneShot,
  }
}

export interface SharedRegistryReadinessReceipt {
  readonly transactionId: string
  readonly candidateFingerprint: string
  readonly expectedRegistryEpoch: number
  readonly candidateRegistryEpoch: number
  readonly observation: PackageRuntimeObservation
  readonly receiptFingerprint: string
}

export interface SharedRegistryRollbackReceipt {
  readonly transactionId: string
  readonly candidateFingerprint: string
  readonly restoredRegistryEpoch: number
  readonly active: PackageRuntimeObservation
  readonly disposedAfter: PackageRuntimeObservation
  readonly receiptFingerprint: string
}

export interface SharedRegistryCommitReceipt {
  readonly transactionId: string
  readonly candidateFingerprint: string
  readonly committedRegistryEpoch: number
  readonly active: PackageRuntimeObservation
  readonly disposedPrevious: PackageRuntimeObservation
  readonly receiptFingerprint: string
}

const readinessReceipts = new WeakSet<object>()
const rollbackReceipts = new WeakSet<object>()
const commitReceipts = new WeakSet<object>()

export interface HostRegistryReceiptAuthority {
  issueReadiness(input: Omit<SharedRegistryReadinessReceipt, 'receiptFingerprint'>): SharedRegistryReadinessReceipt
  issueRollback(input: Omit<SharedRegistryRollbackReceipt, 'receiptFingerprint'>): SharedRegistryRollbackReceipt
  issueCommit(input: Omit<SharedRegistryCommitReceipt, 'receiptFingerprint'>): SharedRegistryCommitReceipt
}

/** Factory lives in Launcher code; ordinary renderer input cannot brand receipts. */
export function createHostRegistryReceiptAuthority(): HostRegistryReceiptAuthority {
  return {
    issueReadiness(input) {
      const receipt = deepFreeze({ ...structuredClone(input), receiptFingerprint: fingerprint(input) })
      readinessReceipts.add(receipt)
      return receipt
    },
    issueRollback(input) {
      const receipt = deepFreeze({ ...structuredClone(input), receiptFingerprint: fingerprint(input) })
      rollbackReceipts.add(receipt)
      return receipt
    },
    issueCommit(input) {
      const receipt = deepFreeze({ ...structuredClone(input), receiptFingerprint: fingerprint(input) })
      commitReceipts.add(receipt)
      return receipt
    },
  }
}

export interface PreparedCandidate {
  readonly transactionId: string
  readonly candidateToken: PackageCandidateToken
  readonly impactToken: PackageImpactToken
  readonly permissionReviewId: HostPermissionReviewId
  readonly permissionReviewToken: HostPermissionReviewToken
  readonly plan: PackageCandidatePlan
}

export interface RuntimeModuleAccess {
  readonly packageIdentity: PackageIdentity
  readonly artifactDirectory: string
  readonly runtimeEntry: './module.js'
}

export interface RollbackPlan {
  readonly transactionId: string
  readonly rollbackToken: PackageRollbackToken
  readonly candidateFingerprint: string
  readonly expectedPublished: PackageActivationTuple
  readonly rollbackTarget: PackageActivationTuple
  readonly expectedRegistryEpoch: number
  readonly rollbackRegistryEpoch: number
}

export interface RecoveryDirective {
  readonly transactionId: string
  readonly action: 'discard-staged' | 'rollback-published'
  readonly rollbackToken?: PackageRollbackToken
}

interface JournalPermission {
  readonly reviewId: string
  readonly reviewTokenHash: string
  readonly planId: string
  readonly planRevision: number
  readonly decisionId: string
  readonly decisionFingerprint: string
  readonly requiredSatisfied: boolean
  readonly unresolvedRequired: readonly string[]
  readonly deniedRequired: readonly string[]
  readonly oneShotGrantIds: readonly string[]
}

interface JournalTransaction {
  readonly transactionId: string
  readonly ownerId: string
  readonly profileId: string
  readonly operation: Operation
  readonly status: Status
  readonly candidateTokenHash: string
  readonly impactTokenHash: string
  readonly rollbackTokenHash?: string
  readonly candidateFingerprint: string
  readonly expected: CordisXPluginActivationRecordV1
  readonly after: CordisXPluginActivationRecordV1
  readonly affectedPluginIds: readonly string[]
  readonly activationOrder: readonly string[]
  readonly drainOrder: readonly string[]
  readonly expectedRegistryEpoch: number
  readonly afterRegistryEpoch: number
  readonly permission: JournalPermission
  readonly failureCode?: string
}

interface JournalState {
  readonly contract: 'cordisx.launcher-package-authority/v1'
  readonly revision: number
  readonly transactions: Readonly<Record<string, JournalTransaction>>
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex')
}

function tokenHash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

function tuple(record: CordisXPluginActivationRecordV1): PackageActivationTuple {
  return deepFreeze({
    profileId: record.profileId,
    revision: record.revision,
    lastGoodRevision: record.lastGoodRevision,
    runtimeGeneration: record.runtimeGeneration,
    plugins: structuredClone(record.plugins),
  })
}

function observation(record: CordisXPluginActivationRecordV1, registryEpoch: number): PackageRuntimeObservation {
  return {
    profileActivationRevision: record.revision,
    registryEpoch,
    runtimeGeneration: record.runtimeGeneration,
    plugins: Object.fromEntries(record.plugins.map(plugin => [plugin.id, {
      version: plugin.version,
      digest: plugin.digest,
      moduleGeneration: plugin.moduleGeneration,
      dependencies: plugin.dependencies,
    }])),
  }
}

function changedIds(expected: CordisXPluginActivationRecordV1, after: CordisXPluginActivationRecordV1): readonly string[] {
  const prior = new Map(expected.plugins.map(plugin => [plugin.id, plugin]))
  const next = new Map(after.plugins.map(plugin => [plugin.id, plugin]))
  return [...new Set([...prior.keys(), ...next.keys()])].filter((id) => {
    const left = prior.get(id)
    const right = next.get(id)
    return fingerprint(left) !== fingerprint(right)
  }).sort()
}

function computeImpact(expected: CordisXPluginActivationRecordV1, after: CordisXPluginActivationRecordV1): {
  readonly affected: readonly string[]
  readonly activationOrder: readonly string[]
  readonly drainOrder: readonly string[]
} {
  const changed = changedIds(expected, after)
  const affected = [...new Set(changed.flatMap(id => [
    ...pluginDependentClosure(expected.plugins, id),
    ...pluginDependentClosure(after.plugins, id),
  ]))].sort()
  return {
    affected,
    activationOrder: topologicalPluginOrder(after.plugins).filter(id => affected.includes(id)),
    drainOrder: topologicalPluginOrder(expected.plugins).filter(id => affected.includes(id)).reverse(),
  }
}

function targetIdentity(expected: CordisXPluginActivationRecordV1, after: CordisXPluginActivationRecordV1): PackageIdentity {
  const id = changedIds(expected, after)[0]
  const item = after.plugins.find(plugin => plugin.id === id) ?? expected.plugins.find(plugin => plugin.id === id)
  if (id === undefined || item === undefined) throw new PackageLifecycleError('empty-candidate', 'candidate changes no plugin package')
  return { pluginId: item.id, version: item.version, integrity: item.digest }
}

function terminal(status: Status): boolean {
  return status === 'completed' || status === 'aborted' || status === 'recovered-aborted'
}

class AuthorityJournal {
  readonly #file: string
  #tail: Promise<void> = Promise.resolve()

  constructor(readonly root: string) {
    this.#file = path.join(root, 'journal.v1.json')
  }

  async open(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') await chmod(this.root, 0o700)
    try {
      await this.read()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await this.write({ contract: 'cordisx.launcher-package-authority/v1', revision: 0, transactions: {} })
    }
  }

  async read(): Promise<JournalState> {
    const metadata = await lstat(this.#file)
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new PackageLifecycleError('invalid-journal', 'authority journal must be a regular file')
    const state = JSON.parse(await readFile(this.#file, 'utf8')) as JournalState
    if (state.contract !== 'cordisx.launcher-package-authority/v1' || !Number.isInteger(state.revision)) {
      throw new PackageLifecycleError('invalid-journal', 'authority journal contract is invalid')
    }
    return state
  }

  async update(mutate: (draft: { revision: number; transactions: Record<string, JournalTransaction> }) => void): Promise<JournalState> {
    let result!: JournalState
    const previous = this.#tail.catch(() => undefined)
    const operation = previous.then(async () => {
      const current = await this.read()
      const draft = structuredClone(current) as unknown as { revision: number; transactions: Record<string, JournalTransaction> }
      mutate(draft)
      draft.revision = current.revision + 1
      result = { contract: current.contract, revision: draft.revision, transactions: draft.transactions }
      await this.write(result)
    })
    this.#tail = operation.then(() => undefined, () => undefined)
    await operation
    return result
  }

  async write(state: JournalState): Promise<void> {
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

export interface PackageLifecycleAuthorityOptions {
  readonly homeDir: string
  readonly profileId: string
  readonly runtimeGeneration: string
  readonly permissionAuthority: HostPermissionReviewAuthority
}

/** Host-private authority layered on the single #73 activation/package stores. */
export class PackageLifecycleAuthority {
  readonly activation: PluginActivationStore
  readonly #journal: AuthorityJournal

  private constructor(readonly options: PackageLifecycleAuthorityOptions, journal: AuthorityJournal) {
    this.activation = new PluginActivationStore(options.homeDir, options.profileId, options.runtimeGeneration)
    this.#journal = journal
  }

  static async open(options: PackageLifecycleAuthorityOptions): Promise<PackageLifecycleAuthority> {
    const journal = new AuthorityJournal(path.join(options.homeDir, 'state', 'profiles', options.profileId, 'package-authority'))
    await journal.open()
    return new PackageLifecycleAuthority(options, journal)
  }

  async prepare(input: {
    readonly ownerId: string
    readonly operation: Operation
    readonly candidateId: string
    readonly expectedRegistryEpoch: number
    readonly permissionPlanRevision: number
    readonly permissionPlanFingerprint: string
  }): Promise<PreparedCandidate> {
    const state = await this.#journal.read()
    if (Object.values(state.transactions).some(item => item.status === 'rollback-pending')) {
      throw new PackageLifecycleError('rollback-pending', 'a rollback must complete before starting another package transaction')
    }
    const [expected, after] = await Promise.all([
      this.activation.loadActive(),
      this.activation.loadCandidate(input.candidateId),
    ])
    if (after.lastGoodRevision !== expected.revision || after.runtimeGeneration !== expected.runtimeGeneration) {
      throw new PackageLifecycleError('stale-candidate', 'candidate activation fence is stale')
    }
    const impact = computeImpact(expected, after)
    const candidateFingerprint = fingerprint({ expected, after, impact })
    const identity = targetIdentity(expected, after)
    const candidateToken = `candidate:${randomUUID()}` as PackageCandidateToken
    const impactToken = `impact:${randomUUID()}` as PackageImpactToken
    const permissionReviewId = `review:${randomUUID()}` as HostPermissionReviewId
    const permissionReviewToken = `permission:${randomUUID()}` as HostPermissionReviewToken
    const reviewInput: HostPermissionReviewInput = {
      ownerId: input.ownerId,
      profileId: this.options.profileId,
      transactionId: input.candidateId,
      candidateFingerprint,
      packageIdentity: identity,
      permissionPlanRevision: input.permissionPlanRevision,
      permissionPlanFingerprint: input.permissionPlanFingerprint,
    }
    const receipt = await this.options.permissionAuthority.review(reviewInput)
    if (!permissionReceipts.has(receipt) || receipt.inputFingerprint !== fingerprint(reviewInput)
      || receipt.planRevision !== input.permissionPlanRevision) {
      throw new PackageLifecycleError('untrusted-permission-review', 'permission review was not issued for this candidate fence')
    }
    const transaction: JournalTransaction = {
      transactionId: input.candidateId,
      ownerId: input.ownerId,
      profileId: this.options.profileId,
      operation: input.operation,
      status: receipt.requiredSatisfied ? 'ready' : 'permission-review',
      candidateTokenHash: tokenHash(candidateToken),
      impactTokenHash: tokenHash(impactToken),
      candidateFingerprint,
      expected,
      after,
      affectedPluginIds: impact.affected,
      activationOrder: impact.activationOrder,
      drainOrder: impact.drainOrder,
      expectedRegistryEpoch: input.expectedRegistryEpoch,
      afterRegistryEpoch: input.expectedRegistryEpoch + 1,
      permission: {
        reviewId: permissionReviewId,
        reviewTokenHash: tokenHash(permissionReviewToken),
        planId: receipt.planId,
        planRevision: receipt.planRevision,
        decisionId: receipt.decisionId,
        decisionFingerprint: receipt.decisionFingerprint,
        requiredSatisfied: receipt.requiredSatisfied,
        unresolvedRequired: receipt.unresolvedRequired,
        deniedRequired: receipt.deniedRequired,
        oneShotGrantIds: receipt.oneShotGrantIds,
      },
    }
    await this.#journal.update(draft => { draft.transactions[input.candidateId] = transaction })
    return {
      transactionId: input.candidateId,
      candidateToken,
      impactToken,
      permissionReviewId,
      permissionReviewToken,
      plan: this.#plan(transaction, expected, 'plan'),
    }
  }

  async resolveCandidate(access: CandidateAccess, boundary: PackageResolutionBoundary): Promise<PackageCandidatePlan> {
    const transaction = await this.#candidate(access)
    const current = await this.activation.loadActive()
    this.#validate(transaction, current, boundary)
    return this.#plan(transaction, current, boundary)
  }

  async resolveImpact(access: ImpactAccess, boundary: PackageResolutionBoundary): Promise<Pick<PackageCandidatePlan,
  'transactionId' | 'boundary' | 'affectedPluginIds' | 'activationOrder' | 'drainOrder'>> {
    const state = await this.#journal.read()
    const transaction = Object.values(state.transactions).find(item => item.impactTokenHash === tokenHash(access.impactToken))
    if (transaction === undefined) throw new PackageLifecycleError('impact-token-invalid', 'impact token is invalid')
    this.#access(transaction, access.ownerId, access.profileId)
    const current = await this.activation.loadActive()
    this.#validate(transaction, current, boundary)
    return {
      transactionId: transaction.transactionId,
      boundary,
      affectedPluginIds: transaction.affectedPluginIds,
      activationOrder: transaction.activationOrder,
      drainOrder: transaction.drainOrder,
    }
  }

  async resolveRuntimeModule(access: CandidateAccess, boundary: PackageResolutionBoundary, pluginId: string): Promise<RuntimeModuleAccess> {
    const plan = await this.resolveCandidate(access, boundary)
    if (!plan.affectedPluginIds.includes(pluginId)) throw new PackageLifecycleError('plugin-outside-closure', `${pluginId} is outside the Host closure`)
    const item = plan.after.plugins.find(plugin => plugin.id === pluginId)
    if (item === undefined) throw new PackageLifecycleError('package-removed', `${pluginId} has no candidate artifact`)
    await loadStagedPluginPackage(this.options.homeDir, item.digest)
    const modulePath = stagedPluginModulePath(this.options.homeDir, item.digest)
    return {
      packageIdentity: { pluginId: item.id, version: item.version, integrity: item.digest },
      artifactDirectory: path.dirname(modulePath),
      runtimeEntry: './module.js',
    }
  }

  async requestActivation(access: CandidateAccess): Promise<PackageCandidatePlan> {
    const transaction = await this.#candidate(access)
    const current = await this.activation.loadActive()
    this.#validate(transaction, current, 'stage')
    if (transaction.status !== 'ready') throw new PackageLifecycleError('permission-review-required', 'required permissions are unresolved or denied')
    await this.#setStatus(transaction.transactionId, 'activation-requested')
    return this.#plan({ ...transaction, status: 'activation-requested' }, current, 'stage')
  }

  async confirmReadiness(access: CandidateAccess, receipt: SharedRegistryReadinessReceipt): Promise<void> {
    const transaction = await this.#candidate(access)
    const current = await this.activation.loadActive()
    this.#validate(transaction, current, 'publish')
    if (transaction.status !== 'activation-requested' || !readinessReceipts.has(receipt)
      || receipt.receiptFingerprint !== fingerprint({
        transactionId: receipt.transactionId,
        candidateFingerprint: receipt.candidateFingerprint,
        expectedRegistryEpoch: receipt.expectedRegistryEpoch,
        candidateRegistryEpoch: receipt.candidateRegistryEpoch,
        observation: receipt.observation,
      })
      || receipt.transactionId !== transaction.transactionId
      || receipt.candidateFingerprint !== transaction.candidateFingerprint
      || receipt.expectedRegistryEpoch !== transaction.expectedRegistryEpoch
      || receipt.candidateRegistryEpoch !== transaction.afterRegistryEpoch
      || fingerprint(receipt.observation) !== fingerprint(observation(transaction.after, transaction.afterRegistryEpoch))) {
      throw new PackageLifecycleError('stale-readiness-receipt', 'shared registry readiness receipt is forged or stale')
    }
    await this.#setStatus(transaction.transactionId, 'readiness-confirmed')
  }

  async commit(access: CandidateAccess): Promise<CordisXPluginActivationRecordV1> {
    const transaction = await this.#candidate(access)
    const current = await this.activation.loadActive()
    this.#validate(transaction, current, 'publish')
    if (transaction.status !== 'readiness-confirmed') throw new PackageLifecycleError('readiness-required', 'closure readiness is not confirmed')
    const committed = await this.activation.commitCandidate(transaction.transactionId)
    await this.#setStatus(transaction.transactionId, 'committed')
    return committed
  }

  async completeCommit(access: CandidateAccess, receipt: SharedRegistryCommitReceipt): Promise<void> {
    const transaction = await this.#candidate(access)
    if (transaction.status !== 'committed') throw new PackageLifecycleError('commit-not-pending', `transaction is ${transaction.status}`)
    const expectedInput = {
      transactionId: receipt.transactionId,
      candidateFingerprint: receipt.candidateFingerprint,
      committedRegistryEpoch: receipt.committedRegistryEpoch,
      active: receipt.active,
      disposedPrevious: receipt.disposedPrevious,
    }
    if (!commitReceipts.has(receipt) || receipt.receiptFingerprint !== fingerprint(expectedInput)
      || receipt.transactionId !== transaction.transactionId
      || receipt.candidateFingerprint !== transaction.candidateFingerprint
      || receipt.committedRegistryEpoch !== transaction.afterRegistryEpoch
      || fingerprint(receipt.active) !== fingerprint(observation(transaction.after, transaction.afterRegistryEpoch))
      || fingerprint(receipt.disposedPrevious) !== fingerprint(observation(transaction.expected, transaction.expectedRegistryEpoch))) {
      throw new PackageLifecycleError('stale-commit-receipt', 'commit-last-good receipt is forged or stale')
    }
    const active = await this.activation.loadActive()
    if (fingerprint(active.plugins) !== fingerprint(transaction.after.plugins)) {
      throw new PackageLifecycleError('commit-active-mismatch', 'durable active closure differs from committed registry closure')
    }
    const journal = await this.#journal.read()
    const retiredGrantIds = Object.values(journal.transactions)
      .filter(item => item.transactionId !== transaction.transactionId && item.status === 'completed'
        && item.after.plugins.some(plugin => transaction.affectedPluginIds.includes(plugin.id)))
      .flatMap(item => item.permission.oneShotGrantIds)
    await this.activation.releaseLastGood(transaction.expected.revision)
    await this.#setStatus(transaction.transactionId, 'completed')
    await this.options.permissionAuthority.revokeOneShot(retiredGrantIds)
  }

  async abort(access: CandidateAccess, failureCode: string): Promise<void> {
    const transaction = await this.#candidate(access)
    if (transaction.status === 'activation-requested' || transaction.status === 'readiness-confirmed'
      || transaction.status === 'committed' || transaction.status === 'rollback-pending') {
      throw new PackageLifecycleError('rollback-required', 'published or potentially published closure requires rollback')
    }
    await this.activation.abortCandidate(transaction.transactionId)
    await this.#setStatus(transaction.transactionId, 'aborted', failureCode)
    await this.options.permissionAuthority.revokeOneShot(transaction.permission.oneShotGrantIds)
  }

  async beginRollback(access: CandidateAccess, failureCode: string): Promise<RollbackPlan> {
    const transaction = await this.#candidate(access)
    if (transaction.status !== 'activation-requested' && transaction.status !== 'readiness-confirmed' && transaction.status !== 'committed') {
      throw new PackageLifecycleError('rollback-not-required', `transaction is ${transaction.status}`)
    }
    const rollbackToken = `rollback:${randomUUID()}` as PackageRollbackToken
    await this.#journal.update(draft => {
      const current = draft.transactions[transaction.transactionId]!
      draft.transactions[transaction.transactionId] = {
        ...current,
        status: 'rollback-pending',
        rollbackTokenHash: tokenHash(rollbackToken),
        failureCode,
      }
    })
    return this.#rollbackPlan(transaction, rollbackToken)
  }

  async completeRollback(access: RollbackAccess, receipt: SharedRegistryRollbackReceipt): Promise<CordisXPluginActivationRecordV1> {
    const state = await this.#journal.read()
    const transaction = Object.values(state.transactions).find(item => item.rollbackTokenHash === tokenHash(access.rollbackToken))
    if (transaction === undefined || transaction.status !== 'rollback-pending') throw new PackageLifecycleError('rollback-token-invalid', 'rollback token is invalid')
    this.#access(transaction, access.ownerId, access.profileId)
    const expectedInput = {
      transactionId: receipt.transactionId,
      candidateFingerprint: receipt.candidateFingerprint,
      restoredRegistryEpoch: receipt.restoredRegistryEpoch,
      active: receipt.active,
      disposedAfter: receipt.disposedAfter,
    }
    if (!rollbackReceipts.has(receipt) || receipt.receiptFingerprint !== fingerprint(expectedInput)
      || receipt.transactionId !== transaction.transactionId
      || receipt.candidateFingerprint !== transaction.candidateFingerprint
      || receipt.restoredRegistryEpoch !== transaction.afterRegistryEpoch + 1
      || fingerprint(receipt.active) !== fingerprint(observation(transaction.expected, receipt.restoredRegistryEpoch))
      || fingerprint(receipt.disposedAfter) !== fingerprint(observation(transaction.after, transaction.afterRegistryEpoch))) {
      throw new PackageLifecycleError('stale-rollback-receipt', 'rollback completion receipt is forged or stale')
    }
    const current = await this.activation.loadActive()
    const restored = current.revision === transaction.after.revision
      ? await this.activation.restoreLastGood(transaction.after.revision, transaction.expected)
      : current
    if (fingerprint(restored.plugins) !== fingerprint(transaction.expected.plugins)) {
      throw new PackageLifecycleError('rollback-active-mismatch', 'durable active closure does not match last-good')
    }
    await this.#setStatus(transaction.transactionId, 'aborted', transaction.failureCode)
    await this.options.permissionAuthority.revokeOneShot(transaction.permission.oneShotGrantIds)
    return restored
  }

  async recover(): Promise<{ readonly directives: readonly RecoveryDirective[] }> {
    const state = await this.#journal.read()
    const directives: RecoveryDirective[] = []
    for (const transaction of Object.values(state.transactions)) {
      if (terminal(transaction.status)) continue
      if (transaction.status === 'activation-requested' || transaction.status === 'readiness-confirmed'
        || transaction.status === 'committed' || transaction.status === 'rollback-pending') {
        const rollbackToken = `rollback:${randomUUID()}` as PackageRollbackToken
        directives.push({ transactionId: transaction.transactionId, action: 'rollback-published', rollbackToken })
        await this.#journal.update(draft => {
          draft.transactions[transaction.transactionId] = {
            ...draft.transactions[transaction.transactionId]!,
            status: 'rollback-pending',
            rollbackTokenHash: tokenHash(rollbackToken),
            failureCode: 'interrupted-after-or-during-publish',
          }
        })
      } else {
        directives.push({ transactionId: transaction.transactionId, action: 'discard-staged' })
        await this.activation.abortCandidate(transaction.transactionId)
        await this.#setStatus(transaction.transactionId, 'recovered-aborted', 'interrupted-before-publish')
        await this.options.permissionAuthority.revokeOneShot(transaction.permission.oneShotGrantIds)
      }
    }
    return { directives }
  }

  async releaseLastGood(revision: number): Promise<void> {
    const state = await this.#journal.read()
    if (Object.values(state.transactions).some(item => item.status === 'rollback-pending' && item.expected.revision === revision)) {
      throw new PackageLifecycleError('rollback-lease-active', 'last-good is pinned by rollback-pending')
    }
    await this.activation.releaseLastGood(revision)
  }

  async collectGarbage(graceMs: number, now = Date.now()): Promise<readonly `sha256:${string}`[]> {
    if (graceMs < 0 || !Number.isFinite(graceMs)) throw new Error('graceMs must be non-negative')
    const journal = await this.#journal.read()
    if (Object.values(journal.transactions).some(item => item.status === 'rollback-pending')) return []
    const [active, candidates, histories] = await Promise.all([
      this.activation.loadActive(),
      this.activation.listCandidates(),
      this.activation.listLastGood(),
    ])
    const referenced = new Set([...active.plugins, ...candidates.flatMap(item => item.plugins), ...histories.flatMap(item => item.plugins)].map(item => item.digest))
    for (const item of Object.values(journal.transactions)) {
      if (!terminal(item.status)) for (const plugin of [...item.expected.plugins, ...item.after.plugins]) referenced.add(plugin.digest)
    }
    const root = path.join(this.options.homeDir, 'packages', 'sha256')
    const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    const removed: `sha256:${string}`[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue
      const digest = `sha256:${entry.name}` as const
      if (referenced.has(digest)) continue
      const metadata = await lstat(path.join(root, entry.name))
      if (now - metadata.mtimeMs < graceMs) continue
      await removeStagedPluginPackage(this.options.homeDir, digest)
      removed.push(digest)
    }
    return removed.sort()
  }

  #plan(transaction: JournalTransaction, current: CordisXPluginActivationRecordV1, boundary: PackageResolutionBoundary): PackageCandidatePlan {
    return deepFreeze({
      transactionId: transaction.transactionId,
      boundary,
      profileActivationRevision: transaction.expected.revision,
      expectedRegistryEpoch: transaction.expectedRegistryEpoch,
      afterRegistryEpoch: transaction.afterRegistryEpoch,
      expected: tuple(transaction.expected),
      current: tuple(current),
      after: tuple(transaction.after),
      lastGood: tuple(transaction.expected),
      affectedPluginIds: transaction.affectedPluginIds,
      activationOrder: transaction.activationOrder,
      drainOrder: transaction.drainOrder,
    })
  }

  #rollbackPlan(transaction: JournalTransaction, rollbackToken: PackageRollbackToken): RollbackPlan {
    return {
      transactionId: transaction.transactionId,
      rollbackToken,
      candidateFingerprint: transaction.candidateFingerprint,
      expectedPublished: tuple(transaction.after),
      rollbackTarget: tuple(transaction.expected),
      expectedRegistryEpoch: transaction.afterRegistryEpoch,
      rollbackRegistryEpoch: transaction.afterRegistryEpoch + 1,
    }
  }

  async #candidate(access: CandidateAccess): Promise<JournalTransaction> {
    const state = await this.#journal.read()
    const transaction = Object.values(state.transactions).find(item => item.candidateTokenHash === tokenHash(access.candidateToken))
    if (transaction === undefined) throw new PackageLifecycleError('candidate-token-invalid', 'candidate token is invalid')
    this.#access(transaction, access.ownerId, access.profileId)
    if (transaction.permission.reviewTokenHash !== tokenHash(access.permissionReviewToken ?? '')) {
      throw new PackageLifecycleError('permission-review-token-invalid', 'permission review token is missing or stale')
    }
    return transaction
  }

  #access(transaction: JournalTransaction, ownerId: string, profileId: string): void {
    if (transaction.ownerId !== ownerId || transaction.profileId !== profileId) {
      throw new PackageLifecycleError('token-scope-mismatch', 'token owner/profile scope is invalid')
    }
  }

  #validate(transaction: JournalTransaction, current: CordisXPluginActivationRecordV1, boundary: PackageResolutionBoundary): void {
    if (!transaction.permission.requiredSatisfied) throw new PackageLifecycleError('permission-review-required', 'required permissions are unresolved or denied')
    const allowed: Record<PackageResolutionBoundary, readonly Status[]> = {
      plan: ['ready', 'permission-review'],
      stage: ['ready', 'activation-requested'],
      publish: ['activation-requested', 'readiness-confirmed'],
      rollback: ['activation-requested', 'readiness-confirmed', 'committed', 'rollback-pending'],
    }
    if (!allowed[boundary].includes(transaction.status)) throw new PackageLifecycleError('invalid-boundary', `${boundary} cannot resolve ${transaction.status}`)
    const currentMatchesExpected = fingerprint(current) === fingerprint(transaction.expected)
    const currentMatchesAfter = fingerprint(current.plugins) === fingerprint(transaction.after.plugins)
      && current.runtimeGeneration === transaction.after.runtimeGeneration
    if (boundary !== 'rollback' && !currentMatchesExpected) throw new PackageLifecycleError('stale-generation-fence', 'activation revision/runtime/module/package tuple changed')
    if (boundary === 'rollback' && !currentMatchesExpected && !currentMatchesAfter) throw new PackageLifecycleError('stale-generation-fence', 'rollback active tuple is stale')
    const impact = computeImpact(transaction.expected, transaction.after)
    if (fingerprint(impact) !== fingerprint({
      affected: transaction.affectedPluginIds,
      activationOrder: transaction.activationOrder,
      drainOrder: transaction.drainOrder,
    })) throw new PackageLifecycleError('stale-impact', 'Host-computed dependency closure changed')
  }

  async #setStatus(transactionId: string, status: Status, failureCode?: string): Promise<void> {
    await this.#journal.update(draft => {
      const transaction = draft.transactions[transactionId]
      if (transaction === undefined) throw new PackageLifecycleError('transaction-missing', 'package transaction is missing')
      draft.transactions[transactionId] = { ...transaction, status, ...(failureCode === undefined ? {} : { failureCode }) }
    })
  }
}
