import { randomBytes } from 'node:crypto'
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
import { loadServiceConfiguredArchive, loadServiceRendererInitialPackage } from './service-renderer-projection.js'

/**
 * Owner-private reverse mapping. Neither source nor staged paths are sent to a renderer.
 * The owner must invalidate `isCurrent` on graph, policy, configuration, or service changes.
 */
export class ServiceRendererIdentityProjection {
  private readonly aliases = new Map<string, {
    pluginId: string
    source: string
    digest: string
    activation?: CordisXPluginActivationItemV1
  }>()
  private readonly plugins = new Map<string, string>()
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

  close(): void {
    if (this.closed) return
    this.closed = true
    this.context.signal.removeEventListener('abort', this.onAbort)
    this.aliases.clear()
    this.plugins.clear()
  }
}
