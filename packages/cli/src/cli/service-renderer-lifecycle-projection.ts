import type { CordisXPluginActivationItemV1, CordisXPluginActivationRecordV1 } from '../plugin-lifecycle-contracts.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V1 } from '../platform-contracts.js'
import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import type { ManagerRendererCommandMethod, OwnerCommandProjection } from './manager-renderer-peer.js'
import { isServiceRendererVisualManifest } from './service-renderer-visual-manifest.js'

type Snapshot = Readonly<{ active: CordisXPluginActivationRecordV1; registryEpoch: number }>
type Candidate = {
  readonly id: string
  readonly targetId: string
  readonly affected: readonly string[]
  readonly owner: CordisXPluginActivationRecordV1
  readonly renderer: CordisXPluginActivationRecordV1
  phase: 'offered' | 'prepared' | 'staged' | 'published' | 'completed' | 'rolled-back'
  epoch?: string
}

const aliasPattern = /^https:\/\/renderer\.cordisx\.invalid\/plugin\/[a-f0-9]{64}$/u
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const stageKeys = new Set([
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
  'ownerDocumentBindings',
  'privateGraphs',
])

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('renderer-identity-lifecycle-unavailable')
  }
  return value as Record<string, unknown>
}

function activated(candidate: CordisXPluginActivationRecordV1): CordisXPluginActivationRecordV1 {
  const { transactionId: _transactionId, ...rest } = candidate
  void _transactionId
  return { ...rest, recordKind: 'active', lastGoodRevision: candidate.revision }
}

/**
 * Maps a single authenticated Manager's lifecycle observations back to the
 * owner's identities. Candidate aliases must already be issued by the owner;
 * the browser never selects this mapping. A receipt advances the state only
 * after its complete projected value has been checked.
 */
export class ServiceRendererLifecycleProjection {
  private owner: Snapshot
  private renderer: Snapshot
  private candidate: Candidate | undefined
  private synchronized = false
  private awaiting = false

  constructor(
    private readonly input: {
      readonly owner: Snapshot
      readonly renderer: Snapshot
      readonly rendererId: string
      readonly current: () => boolean
      readonly resolve: (
        alias: string,
        pluginId: string,
        snapshotItem?: CordisXPluginActivationItemV1,
      ) => { readonly source: string; readonly digest: string }
    },
  ) {
    this.owner = structuredClone(input.owner)
    this.renderer = structuredClone(input.renderer)
    if (
      this.owner.active.recordKind !== 'active' || this.owner.registryEpoch !== this.renderer.registryEpoch
      || !identifier.test(input.rendererId)
    ) {
      throw new Error('renderer-identity-lifecycle-unavailable')
    }
    this.assertPair(this.owner.active, this.renderer.active)
  }

  private live(): void {
    if (!this.input.current()) throw new Error('renderer-identity-lifecycle-unavailable')
  }

  private assertPair(owner: CordisXPluginActivationRecordV1, renderer: CordisXPluginActivationRecordV1): void {
    this.live()
    const { plugins: original, ...ownerRecord } = owner
    const { plugins: projected, ...rendererRecord } = renderer
    if (
      !attachmentEqual(ownerRecord, rendererRecord) || original.length !== projected.length
      || new Set(original.map(item => item.id)).size !== original.length
    ) throw new Error('renderer-identity-lifecycle-unavailable')
    for (let index = 0; index < original.length; index++) {
      const snapshotItem = original[index]!
      const { canonicalSource: source, ...item } = snapshotItem
      const { canonicalSource: alias, ...other } = projected[index]!
      if (!attachmentEqual(item, other)) throw new Error('renderer-identity-lifecycle-unavailable')
      if (source === undefined) {
        if (alias !== undefined) throw new Error('renderer-identity-lifecycle-unavailable')
      } else {
        if (!alias || !aliasPattern.test(alias)) throw new Error('renderer-identity-lifecycle-unavailable')
        // The owner supplies the complete snapshot item only for pair
        // verification. Mutation targets are resolved without it.
        const resolved = this.input.resolve(alias, item.id, snapshotItem)
        if (resolved.source !== source || resolved.digest !== item.digest) {
          throw new Error('renderer-identity-lifecycle-unavailable')
        }
      }
    }
    this.live()
  }

  /** Reserve only an owner-validated candidate, before the lifecycle sends prepare. */
  offer(input: {
    readonly transactionId: string
    readonly targetId: string
    readonly affectedPluginIds: readonly string[]
    readonly previous: CordisXPluginActivationRecordV1
    readonly candidate: CordisXPluginActivationRecordV1
    readonly projectedCandidate: CordisXPluginActivationRecordV1
  }): void {
    this.live()
    if (
      !this.synchronized || this.awaiting || this.candidate && this.candidate.phase !== 'offered'
      || !identifier.test(input.transactionId) || !attachmentEqual(input.previous, this.owner.active)
      || input.candidate.recordKind !== 'candidate' || input.candidate.transactionId !== input.transactionId
      || input.candidate.profileId !== input.previous.profileId
      || input.candidate.runtimeGeneration !== input.previous.runtimeGeneration
      || input.candidate.revision !== input.previous.revision + 1
      || input.candidate.lastGoodRevision !== input.previous.revision
    ) throw new Error('renderer-identity-lifecycle-unavailable')
    const before = new Map(input.previous.plugins.map(item => [item.id, item]))
    const after = new Map(input.candidate.plugins.map(item => [item.id, item]))
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter(id =>
      !attachmentEqual(before.get(id), after.get(id))
    )
    if (
      after.size !== input.candidate.plugins.length || input.affectedPluginIds.length !== changed.length
      || new Set(input.affectedPluginIds).size !== changed.length || !changed.includes(input.targetId)
      || changed.some(id => !input.affectedPluginIds.includes(id))
    ) throw new Error('renderer-identity-lifecycle-unavailable')
    this.assertPair(input.candidate, input.projectedCandidate)
    this.candidate = {
      id: input.transactionId,
      targetId: input.targetId,
      affected: [...input.affectedPluginIds],
      owner: structuredClone(input.candidate),
      renderer: structuredClone(input.projectedCandidate),
      phase: 'offered',
    }
  }

  /** A rejected preflight has not dispatched anything and can be discarded. */
  discard(transactionId: string): boolean {
    if (!this.candidate) return !this.awaiting
    if (this.candidate.id !== transactionId || this.candidate.phase !== 'offered' || this.awaiting) return false
    this.candidate = undefined
    return true
  }

  /** Available only after the owner has received the final or recovery acknowledgement. */
  confirmedSnapshot(): Snapshot | undefined {
    this.live()
    return this.synchronized && !this.awaiting && !this.candidate ? structuredClone(this.owner) : undefined
  }

  private confirmed(payload: unknown, expected: unknown, result: unknown, advance: () => void) {
    this.awaiting = true
    return {
      payload,
      receipt: (value: unknown) => {
        this.live()
        if (!this.awaiting || !attachmentEqual(value, expected)) {
          throw new Error('renderer-identity-receipt-invalid')
        }
        this.awaiting = false
        advance()
        return result
      },
    }
  }

  private assertStageSafe(payload: Record<string, unknown>, candidate: Candidate): void {
    if (
      Object.keys(payload).some(key => !stageKeys.has(key)) || payload.rendererId !== this.input.rendererId
      || !Array.isArray(payload.privateGraphs)
      || !['install', 'update', 'enable', 'disable', 'uninstall'].includes(String(payload.operation))
    ) throw new Error('renderer-identity-lifecycle-unavailable')
    const { privateGraphs: _privateGraphs, ...projected } = payload
    void _privateGraphs
    const encoded = JSON.stringify(projected)
    if (
      encoded === undefined
      || [...this.owner.active.plugins, ...candidate.owner.plugins].some(item =>
        item.canonicalSource !== undefined && encoded.includes(item.canonicalSource)
      )
    ) throw new Error('renderer-identity-lifecycle-unavailable')
    const target = candidate.owner.plugins.find(item => item.id === candidate.targetId)
      ?? this.owner.active.plugins.find(item => item.id === candidate.targetId)
    if (!target) throw new Error('renderer-identity-lifecycle-unavailable')
    const aliasMatches = (value: unknown): value is string => {
      if (typeof value !== 'string' || !aliasPattern.test(value)) return false
      const resolved = this.input.resolve(value, candidate.targetId)
      return resolved.digest === target.digest
        && (target.canonicalSource === undefined || resolved.source === target.canonicalSource)
    }
    if (payload.ownerDocumentBindings !== undefined) {
      const bindings = payload.ownerDocumentBindings
      const enabled = candidate.affected.filter(id =>
        candidate.owner.plugins.some(item => item.id === id && item.enabled)
      )
      if (!Array.isArray(bindings) || bindings.length !== enabled.length) {
        throw new Error('renderer-identity-lifecycle-unavailable')
      }
      const seen = new Set<string>()
      for (const value of bindings) {
        const binding = record(value)
        const item = candidate.owner.plugins.find(plugin => plugin.id === binding.pluginId)
        const projectedItem = candidate.renderer.plugins.find(plugin => plugin.id === binding.pluginId)
        if (
          Object.keys(binding).length !== 4
          || Object.keys(binding).some(key => !['source', 'pluginId', 'moduleGeneration', 'token'].includes(key))
          || typeof binding.pluginId !== 'string' || seen.has(binding.pluginId) || !enabled.includes(binding.pluginId)
          || typeof binding.source !== 'string' || !aliasPattern.test(binding.source)
          || typeof binding.token !== 'string' || !/^[a-f0-9]{64}$/u.test(binding.token)
          || !item || binding.moduleGeneration !== item.moduleGeneration
          || projectedItem?.canonicalSource !== undefined && projectedItem.canonicalSource !== binding.source
          || this.input.resolve(binding.source, binding.pluginId).digest !== item.digest
        ) throw new Error('renderer-identity-lifecycle-unavailable')
        seen.add(binding.pluginId)
      }
    }
    if (payload.package !== undefined) {
      const pkg = record(payload.package)
      const manifest = record(pkg.manifest)
      const runtime = record(manifest.runtimeManifest)
      if (
        Object.keys(pkg).some(key => !['manifest', 'digest', 'artifactIntegrity', 'identitySource'].includes(key))
        || !aliasMatches(pkg.identitySource) || pkg.digest !== target.digest || manifest.id !== target.id
        || manifest.version !== target.version
        || !(runtime.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V1 && runtime.schemaVersion === 1
            && runtime.id === target.id && Array.isArray(runtime.capabilities) && runtime.capabilities.length === 0
          || isServiceRendererVisualManifest(runtime, target.id))
        || (target.canonicalSource === undefined
          ? manifest.canonicalSource !== undefined
          : manifest.canonicalSource !== pkg.identitySource)
      ) throw new Error('renderer-identity-lifecycle-unavailable')
    }
    if (payload.authorizationDecision !== undefined) {
      const decision = record(payload.authorizationDecision)
      const identity = record(decision.identity)
      const v7 = decision.schemaVersion === 7
      const binding = v7 ? record(decision.binding) : undefined
      if (
        (decision.schemaVersion !== 1 && !v7)
        || !Array.isArray(decision.decisions) || decision.decisions.length !== 0
        || identity.pluginId !== candidate.targetId || !aliasMatches(identity.source)
        || (v7 && (
          payload.package === undefined
          || decision.$schema
            !== 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-authorization-decision.v7.schema.json'
          || Object.keys(decision).some(key =>
            ![
              '$schema',
              'schemaVersion',
              'origin',
              'planId',
              'operation',
              'profileId',
              'identity',
              'binding',
              'decisions',
            ]
              .includes(key)
          )
          || Object.keys(identity).some(key => !['source', 'pluginId'].includes(key))
          || decision.origin !== 'host-no-decision' || decision.operation !== payload.operation
          || !['install', 'update', 'enable'].includes(String(decision.operation))
          || decision.profileId !== candidate.owner.profileId
          || decision.planId !== `${candidate.owner.runtimeGeneration}:${candidate.targetId}`
          || Object.keys(binding!).some(key =>
            !['operationId', 'runtimeGeneration', 'moduleGeneration', 'requestId'].includes(key)
          )
          || typeof binding!.operationId !== 'string' || !/^review:[a-f0-9]{64}$/u.test(binding!.operationId)
          || binding!.runtimeGeneration !== candidate.owner.runtimeGeneration
          || binding!.moduleGeneration !== target.moduleGeneration || binding!.requestId !== candidate.id
        ))
      ) throw new Error('renderer-identity-lifecycle-unavailable')
    }
    this.live()
  }

  readonly project: OwnerCommandProjection = (method: ManagerRendererCommandMethod, value: unknown) => {
    this.live()
    if (this.awaiting) throw new Error('renderer-identity-lifecycle-unavailable')
    if (
      method === 'quiesce' || method === 'channel-configuration' || method === 'managed-service-state'
      || method === 'managed-service-accounts'
      || method === 'desktop-package-configuration' || method === 'permission-policy'
    ) {
      return { payload: value }
    }
    if (method === 'synchronize') return this.synchronize(value)
    const candidate = this.candidate
    if (!this.synchronized || !candidate) throw new Error('renderer-identity-lifecycle-unavailable')
    const payload = record(value)
    if (method === 'prepare') {
      if (
        candidate.phase !== 'offered' || Object.keys(payload).length !== 3
        || payload.transactionId !== candidate.id || typeof payload.transactionEpoch !== 'string'
        || !identifier.test(payload.transactionEpoch) || payload.expectedRegistryEpoch !== this.owner.registryEpoch
      ) throw new Error('renderer-identity-lifecycle-unavailable')
      return this.confirmed(payload, payload, payload, () => {
        candidate.epoch = payload.transactionEpoch as string
        candidate.phase = 'prepared'
      })
    }
    if (method === 'stage') {
      if (
        candidate.phase !== 'prepared' || payload.transactionId !== candidate.id
        || payload.transactionEpoch !== candidate.epoch || payload.expectedRegistryEpoch !== this.owner.registryEpoch
        || payload.afterRegistryEpoch !== this.owner.registryEpoch + 1 || payload.targetId !== candidate.targetId
        || !attachmentEqual(payload.affectedPluginIds, candidate.affected)
        || !attachmentEqual(payload.previous, this.renderer.active)
        || !attachmentEqual(payload.candidate, candidate.renderer)
      ) throw new Error('renderer-identity-lifecycle-unavailable')
      this.assertStageSafe(payload, candidate)
      const receipt = {
        transactionId: candidate.id,
        transactionEpoch: candidate.epoch,
        expectedRegistryEpoch: this.owner.registryEpoch,
        afterRegistryEpoch: this.owner.registryEpoch + 1,
        affectedPluginIds: candidate.affected,
        observation: candidate.renderer,
      }
      return this.confirmed(payload, receipt, { ...receipt, observation: candidate.owner }, () => {
        candidate.phase = 'staged'
      })
    }
    if (method === 'rollback') return this.rollback(payload, candidate)
    if (Object.keys(payload).length !== 1 || payload.transactionId !== candidate.id) {
      throw new Error('renderer-identity-lifecycle-unavailable')
    }
    if (method === 'publish' && candidate.phase === 'staged') {
      const receipt = {
        transactionId: candidate.id,
        transactionEpoch: candidate.epoch,
        registryEpoch: this.owner.registryEpoch + 1,
        active: candidate.renderer,
        retiring: this.renderer.active,
        notificationErrors: [],
      }
      return this.confirmed(payload, receipt, {
        ...receipt,
        active: candidate.owner,
        retiring: this.owner.active,
      }, () => candidate.phase = 'published')
    }
    if (method === 'complete' && candidate.phase === 'published') {
      const receipt = {
        transactionId: candidate.id,
        transactionEpoch: candidate.epoch,
        registryEpoch: this.owner.registryEpoch + 1,
        active: candidate.renderer,
        disposedAfter: this.renderer.active,
      }
      return this.confirmed(payload, receipt, {
        ...receipt,
        active: candidate.owner,
        disposedAfter: this.owner.active,
      }, () => candidate.phase = 'completed')
    }
    if (method === 'finalize' && candidate.phase === 'completed') {
      return this.confirmed(payload, payload, payload, () => {
        this.owner = { active: activated(candidate.owner), registryEpoch: this.owner.registryEpoch + 1 }
        this.renderer = { active: activated(candidate.renderer), registryEpoch: this.renderer.registryEpoch + 1 }
        this.candidate = undefined
      })
    }
    throw new Error('renderer-identity-lifecycle-unavailable')
  }

  private rollback(payload: Record<string, unknown>, candidate: Candidate) {
    if (
      !['staged', 'published', 'completed'].includes(candidate.phase) || Object.keys(payload).length !== 2
      || payload.transactionId !== candidate.id
    ) throw new Error('renderer-identity-lifecycle-unavailable')
    const owner = {
      transactionId: candidate.id,
      transactionEpoch: candidate.epoch,
      registryEpoch: this.owner.registryEpoch + 2,
      active: this.owner.active,
      disposedAfter: candidate.owner,
    }
    if (!attachmentEqual(payload.expected, owner)) throw new Error('renderer-identity-lifecycle-unavailable')
    const renderer = { ...owner, active: this.renderer.active, disposedAfter: candidate.renderer }
    return this.confirmed({ transactionId: candidate.id, expected: renderer }, renderer, owner, () => {
      candidate.phase = 'rolled-back'
    })
  }

  private synchronize(value: unknown) {
    const candidate = this.candidate
    if (!candidate || candidate.phase === 'offered') {
      if (!attachmentEqual(value, this.owner)) throw new Error('renderer-identity-lifecycle-unavailable')
      return this.confirmed(this.renderer, this.renderer, this.owner, () => this.synchronized = true)
    }
    if (candidate.phase !== 'rolled-back') throw new Error('renderer-identity-lifecycle-unavailable')
    const target = record(value)
    const active = record(target.active)
    const revision = active.revision
    if (
      Object.keys(target).length !== 2 || target.registryEpoch !== this.owner.registryEpoch + 2
      || (revision !== this.owner.active.revision && revision !== candidate.owner.revision + 1)
    ) throw new Error('renderer-identity-lifecycle-unavailable')
    const expected = revision === this.owner.active.revision
      ? this.owner.active
      : { ...this.owner.active, revision, lastGoodRevision: this.owner.active.revision }
    if (!attachmentEqual(active, expected)) throw new Error('renderer-identity-lifecycle-unavailable')
    const projected = {
      active: { ...expected, plugins: this.renderer.active.plugins },
      registryEpoch: target.registryEpoch as number,
    }
    this.assertPair(expected as CordisXPluginActivationRecordV1, projected.active as CordisXPluginActivationRecordV1)
    return this.confirmed(projected, projected, value, () => {
      this.owner = structuredClone(value as Snapshot)
      this.renderer = structuredClone(projected as Snapshot)
      this.candidate = undefined
    })
  }
}
