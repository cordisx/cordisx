import { randomBytes } from 'node:crypto'
import { CORDISX_CAPABILITY_CATALOG_VERSION } from '../capability-risk-catalog.js'
import { domPermissionAuthorizationKeyV3 } from '../permission-model-v3.js'
import {
  type CordisXPersistedPermissionPolicyRecord,
  isPermissionPolicyRecordV3,
  normalizePersistedPermissionPolicyRecord,
  persistedPermissionRecordKey,
} from '../permission-persistence.js'
import type { CordisXConfigPlugin } from '../launcher/config.js'
import { stagedPluginModulePath } from '../launcher/plugin-package.js'
import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import type { CordisXPluginActivationItemV1, CordisXPluginActivationRecordV1 } from '../plugin-lifecycle-contracts.js'
import type { ManagerRendererChannelContext } from './manager-renderer-sessions.js'
import {
  loadServiceConfiguredArchive,
  loadServiceRendererInitialPackage,
  loadServiceRendererPackage,
} from './service-renderer-projection.js'

type IdentityBinding = {
  pluginId: string
  source: string
  digest: string
  activation?: CordisXPluginActivationItemV1
}
type CandidateIdentity = {
  readonly transactionId: string
  readonly candidate: CordisXPluginActivationRecordV1
  readonly aliases: ReadonlyMap<string, string>
  readonly bindings: ReadonlyMap<string, IdentityBinding>
}

/**
 * Owner-private reverse mapping. Neither source nor staged paths are sent to a renderer.
 * The owner must invalidate `isCurrent` on graph, policy, configuration, or service changes.
 */
export class ServiceRendererIdentityProjection {
  private readonly aliases = new Map<string, IdentityBinding>()
  private readonly plugins = new Map<string, string>()
  private candidate: CandidateIdentity | undefined
  private preparing: symbol | undefined
  private closed = false
  private readonly context: ManagerRendererChannelContext
  private readonly onAbort = () => this.close()

  constructor(
    private readonly input: {
      readonly homeDir: string
      readonly context: ManagerRendererChannelContext
      readonly isCurrent: (context: ManagerRendererChannelContext) => boolean
    },
  ) {
    this.context = Object.freeze({ ...input.context })
    if (!this.current(input.context)) throw new Error('renderer-identity-unavailable')
    this.context.signal.addEventListener('abort', this.onAbort, { once: true })
    if (!this.current(input.context)) {
      this.close()
      throw new Error('renderer-identity-unavailable')
    }
  }

  private current(context: ManagerRendererChannelContext): boolean {
    try {
      return !this.closed && !context.signal.aborted && context.signal === this.context.signal
        && context.rendererId === this.context.rendererId && context.profileId === this.context.profileId
        && context.ownerGeneration === this.context.ownerGeneration && this.input.isCurrent(context) === true
    } catch {
      return false
    }
  }

  /** Call only with the exact configured plugin selected by the owner. */
  async issue(context: ManagerRendererChannelContext, plugin: CordisXConfigPlugin): Promise<string> {
    if (!this.current(context) || this.aliases.size >= 256 || this.plugins.has(plugin.id)) {
      throw new Error('renderer-identity-unavailable')
    }
    const captured = structuredClone(plugin)
    const staged = await loadServiceConfiguredArchive(this.input.homeDir, captured)
    if (!this.current(context) || this.plugins.has(captured.id) || this.aliases.size >= 256) {
      throw new Error('renderer-identity-unavailable')
    }
    const alias = `https://renderer.cordisx.invalid/plugin/${randomBytes(32).toString('hex')}`
    if (this.aliases.has(alias)) throw new Error('renderer-identity-unavailable')
    this.aliases.set(alias, { pluginId: captured.id, source: staged.identitySource, digest: staged.digest })
    this.plugins.set(captured.id, alias)
    return alias
  }

  /** Only the owner's exact activation and staged package can receive an alias. */
  async issueInstalled(
    context: ManagerRendererChannelContext,
    plugin: CordisXConfigPlugin,
    item: CordisXPluginActivationItemV1,
  ): Promise<string> {
    if (!this.current(context) || this.aliases.size >= 256 || this.plugins.has(item.id)) {
      throw new Error('renderer-identity-unavailable')
    }
    const captured = structuredClone(item)
    const staged = await loadServiceRendererInitialPackage(this.input.homeDir, captured)
    if (
      !this.current(context) || this.plugins.has(captured.id) || this.aliases.size >= 256
      || plugin.id !== captured.id || plugin.enabled !== captured.enabled || !plugin.package
      || plugin.entry !== stagedPluginModulePath(this.input.homeDir, captured.digest)
      || plugin.source !== staged.identitySource || !attachmentEqual(plugin.manifest, staged.manifest.runtimeManifest)
      || plugin.package.version !== captured.version || plugin.package.digest !== captured.digest
      || plugin.package.moduleGeneration !== captured.moduleGeneration
      || plugin.package.canonicalSource !== captured.canonicalSource
      || plugin.package.artifactIntegrity !== staged.artifactIntegrity
      || !attachmentEqual(plugin.package.dependencies, captured.dependencies)
    ) throw new Error('renderer-identity-unavailable')
    const alias = `https://renderer.cordisx.invalid/plugin/${randomBytes(32).toString('hex')}`
    if (this.aliases.has(alias)) throw new Error('renderer-identity-unavailable')
    this.aliases.set(alias, {
      pluginId: captured.id,
      source: staged.identitySource,
      digest: staged.digest,
      activation: captured,
    })
    this.plugins.set(captured.id, alias)
    return alias
  }

  /** Map the complete owner snapshot, retaining every non-identity field verbatim. */
  projectActivation(
    context: ManagerRendererChannelContext,
    active: CordisXPluginActivationRecordV1,
  ): CordisXPluginActivationRecordV1 {
    if (
      !this.current(context) || active.recordKind !== 'active' || active.profileId !== context.profileId
      || active.runtimeGeneration !== context.ownerGeneration || active.plugins.length !== this.plugins.size
    ) throw new Error('renderer-identity-unavailable')
    const plugins = active.plugins.map(item => {
      const alias = this.plugins.get(item.id)
      const original = alias === undefined ? undefined : this.aliases.get(alias)
      if (!alias || !original?.activation || !attachmentEqual(original.activation, item)) {
        throw new Error('renderer-identity-unavailable')
      }
      return { ...item, ...(item.canonicalSource === undefined ? {} : { canonicalSource: alias }) }
    })
    if (!this.current(context)) throw new Error('renderer-identity-unavailable')
    return { ...active, plugins }
  }

  /**
   * Reserve a per-renderer identity for an owner-selected v1 package change.
   * Existing managed plugins may remain in the snapshot but cannot be part of
   * this restricted mutation. The caller still owns the lifecycle and profile
   * barriers; creating aliases does not grant admission or a permission.
   */
  async prepareCandidate(
    context: ManagerRendererChannelContext,
    input: {
      readonly transactionId: string
      readonly targetId: string
      readonly affectedPluginIds: readonly string[]
      readonly previous: CordisXPluginActivationRecordV1
      readonly candidate: CordisXPluginActivationRecordV1
    },
  ): Promise<{ previous: CordisXPluginActivationRecordV1; candidate: CordisXPluginActivationRecordV1 }> {
    if (!this.current(context) || this.preparing || this.candidate) throw new Error('renderer-identity-unavailable')
    const captured = structuredClone(input)
    const previous = this.projectActivation(context, captured.previous)
    const next = captured.candidate
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(captured.transactionId)
      || next.recordKind !== 'candidate' || next.transactionId !== captured.transactionId
      || next.profileId !== context.profileId || next.runtimeGeneration !== context.ownerGeneration
      || next.revision !== captured.previous.revision + 1 || next.lastGoodRevision !== captured.previous.revision
      || next.plugins.length > 256
    ) throw new Error('renderer-identity-unavailable')
    const before = new Map(captured.previous.plugins.map(item => [item.id, item]))
    const after = new Map(next.plugins.map(item => [item.id, item]))
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter(id =>
      !attachmentEqual(before.get(id), after.get(id))
    )
    if (
      after.size !== next.plugins.length || changed.length !== captured.affectedPluginIds.length
      || new Set(captured.affectedPluginIds).size !== changed.length || !changed.includes(captured.targetId)
      || changed.some(id => !captured.affectedPluginIds.includes(id))
    ) throw new Error('renderer-identity-unavailable')
    const reservation = Symbol('renderer-candidate-identity')
    this.preparing = reservation
    try {
      // Validate both the retiring and candidate generations. Disabling or
      // removing a managed package is not admitted by this v1-only path.
      const packages = new Map<string, Awaited<ReturnType<typeof loadServiceRendererPackage>>>()
      for (const id of changed) {
        for (const item of [before.get(id), after.get(id)]) {
          if (!item) continue
          packages.set(item.digest, await loadServiceRendererPackage(this.input.homeDir, item))
        }
      }
      if (
        !this.current(context) || this.preparing !== reservation || this.candidate
        || !attachmentEqual(this.projectActivation(context, captured.previous), previous)
      ) throw new Error('renderer-identity-unavailable')
      const aliases = new Map<string, string>()
      const bindings = new Map<string, IdentityBinding>()
      for (const item of next.plugins) {
        const prior = before.get(item.id)
        const priorAlias = this.plugins.get(item.id)
        const priorBinding = priorAlias === undefined ? undefined : this.aliases.get(priorAlias)
        let alias: string
        let binding: IdentityBinding
        if (
          prior && priorAlias && priorBinding && prior.digest === item.digest
          && prior.canonicalSource === item.canonicalSource
        ) {
          alias = priorAlias
          binding = { ...priorBinding, activation: item }
        } else {
          const staged = packages.get(item.digest)
          if (!staged) throw new Error('renderer-identity-unavailable')
          do alias = `https://renderer.cordisx.invalid/plugin/${randomBytes(32).toString('hex')}`
          while (this.aliases.has(alias) || bindings.has(alias))
          binding = { pluginId: item.id, source: staged.identitySource, digest: staged.digest, activation: item }
        }
        if (bindings.has(alias)) throw new Error('renderer-identity-unavailable')
        aliases.set(item.id, alias)
        bindings.set(alias, binding)
      }
      const candidate = {
        ...next,
        plugins: next.plugins.map(item => ({
          ...item,
          ...(item.canonicalSource === undefined ? {} : { canonicalSource: aliases.get(item.id)! }),
        })),
      }
      this.candidate = { transactionId: captured.transactionId, candidate: next, aliases, bindings }
      return structuredClone({ previous, candidate })
    } finally {
      if (this.preparing === reservation) this.preparing = undefined
    }
  }

  /** The lifecycle may validate a provisional alias; ordinary reads cannot resolve it. */
  resolveLifecycle(context: ManagerRendererChannelContext, alias: string, pluginId: string) {
    const value = this.current(context) ? this.candidate?.bindings.get(alias) ?? this.aliases.get(alias) : undefined
    if (!value || value.pluginId !== pluginId) throw new Error('renderer-identity-unavailable')
    return { pluginId: value.pluginId, source: value.source, digest: value.digest }
  }

  candidateAlias(context: ManagerRendererChannelContext, transactionId: string, pluginId: string): string {
    const candidate = this.current(context) ? this.candidate : undefined
    const alias = candidate?.transactionId === transactionId ? candidate.aliases.get(pluginId) : undefined
    if (!alias) throw new Error('renderer-identity-unavailable')
    return alias
  }

  currentAlias(context: ManagerRendererChannelContext, pluginId: string): string {
    const alias = this.current(context) ? this.plugins.get(pluginId) : undefined
    if (!alias) throw new Error('renderer-identity-unavailable')
    return alias
  }

  /** Promote only the exact durable activation after all renderer receipts. */
  commitCandidate(
    context: ManagerRendererChannelContext,
    transactionId: string,
    active: CordisXPluginActivationRecordV1,
  ): void {
    const candidate = this.candidate
    if (!this.current(context) || !candidate || candidate.transactionId !== transactionId) {
      throw new Error('renderer-identity-unavailable')
    }
    const { transactionId: _transactionId, ...record } = candidate.candidate
    void _transactionId
    if (!attachmentEqual(active, { ...record, recordKind: 'active', lastGoodRevision: record.revision })) {
      throw new Error('renderer-identity-unavailable')
    }
    const bindings = active.plugins.map(item => {
      const alias = candidate.aliases.get(item.id)
      const binding = alias === undefined ? undefined : candidate.bindings.get(alias)
      if (!alias || !binding || !attachmentEqual(binding.activation, item)) {
        throw new Error('renderer-identity-unavailable')
      }
      return { alias, binding, item }
    })
    this.aliases.clear()
    this.plugins.clear()
    for (const { alias, binding, item } of bindings) {
      this.aliases.set(alias, { ...binding, activation: structuredClone(item) })
      this.plugins.set(item.id, alias)
    }
    this.candidate = undefined
  }

  /** A rejected or rolled-back candidate never becomes an ordinary identity. */
  cancelCandidate(context: ManagerRendererChannelContext, transactionId: string): void {
    if (!this.current(context)) throw new Error('renderer-identity-unavailable')
    if (this.candidate?.transactionId === transactionId) this.candidate = undefined
  }

  /** Resolve only inside the owner after authenticating this exact renderer session. */
  resolve(context: ManagerRendererChannelContext, alias: string, pluginId: string) {
    const value = this.current(context) ? this.aliases.get(alias) : undefined
    if (!value || value.pluginId !== pluginId) throw new Error('renderer-identity-unavailable')
    return { pluginId: value.pluginId, source: value.source, digest: value.digest }
  }

  /** Project only existing owner-approved Manager UI policies; this never creates a grant. */
  projectManagerPolicies(
    context: ManagerRendererChannelContext,
    alias: string,
    pluginId: string,
    records: readonly CordisXPersistedPermissionPolicyRecord[],
  ): readonly CordisXPersistedPermissionPolicyRecord[] {
    const original = this.resolve(context, alias, pluginId)
    if (records.length > 4096) throw new Error('renderer-identity-unavailable')
    const projected: CordisXPersistedPermissionPolicyRecord[] = []
    const keys = new Set<string>()
    for (const raw of records) {
      const record = normalizePersistedPermissionPolicyRecord(raw)
      if (
        !isPermissionPolicyRecordV3(record) || record.key.profileId !== context.profileId
        || record.key.identity.pluginId !== pluginId || record.key.identity.source !== original.source
        || record.key.capability !== 'ui.extension-points.render' || record.key.scope.extensionPoints?.length !== 1
        || !['manager.settings.navigation-items', 'manager.content'].includes(record.key.scope.extensionPoints[0]!)
      ) continue
      const value = normalizePersistedPermissionPolicyRecord({
        ...record,
        key: { ...record.key, identity: { ...record.key.identity, source: alias } },
      })
      const key = persistedPermissionRecordKey(value)
      if (keys.has(key)) throw new Error('renderer-identity-unavailable')
      keys.add(key)
      projected.push(value)
    }
    if (!this.current(context)) throw new Error('renderer-identity-unavailable')
    return projected
  }

  /** Resolve a renderer-local Manager UI policy to the owner-selected source.
   * This only resolves identity; the caller must separately authorize and
   * coordinate the exact write across every policy consumer.
   */
  resolveManagerPolicies(
    context: ManagerRendererChannelContext,
    alias: string,
    pluginId: string,
    records: readonly unknown[],
  ): readonly CordisXPersistedPermissionPolicyRecord[] {
    if (context.admitted !== true || !Array.isArray(records) || records.length < 1 || records.length > 2) {
      throw new Error('renderer-identity-unavailable')
    }
    const original = this.resolve(context, alias, pluginId)
    const resolved: CordisXPersistedPermissionPolicyRecord[] = []
    const keys = new Set<string>()
    for (const raw of records) {
      const record = normalizePersistedPermissionPolicyRecord(raw)
      if (
        !isPermissionPolicyRecordV3(record) || record.key.profileId !== context.profileId
        || record.key.identity.pluginId !== pluginId || record.key.identity.source !== alias
        || record.key.capability !== 'ui.extension-points.render' || record.key.scope.extensionPoints?.length !== 1
        || !['manager.settings.navigation-items', 'manager.content'].includes(record.key.scope.extensionPoints[0]!)
      ) throw new Error('renderer-identity-unavailable')
      const expected = domPermissionAuthorizationKeyV3({
        profileId: context.profileId,
        identity: { source: alias, pluginId },
        pointId: record.key.scope.extensionPoints[0]!,
        catalogVersion: CORDISX_CAPABILITY_CATALOG_VERSION,
      })
      if (record.key.securityFingerprint !== expected.securityFingerprint) {
        throw new Error('renderer-identity-unavailable')
      }
      const value = normalizePersistedPermissionPolicyRecord({
        ...record,
        key: { ...record.key, identity: { ...record.key.identity, source: original.source } },
      })
      const key = persistedPermissionRecordKey(value)
      if (keys.has(key)) throw new Error('renderer-identity-unavailable')
      keys.add(key)
      resolved.push(value)
    }
    if (!this.current(context)) throw new Error('renderer-identity-unavailable')
    return resolved
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.context.signal.removeEventListener('abort', this.onAbort)
    this.preparing = undefined
    this.candidate = undefined
    this.aliases.clear()
    this.plugins.clear()
  }
}
