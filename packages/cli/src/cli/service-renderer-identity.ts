import { randomBytes } from 'node:crypto'
import {
  type CordisXPersistedPermissionPolicyRecord,
  isPermissionPolicyRecordV3,
  normalizePersistedPermissionPolicyRecord,
  persistedPermissionRecordKey,
} from '../permission-persistence.js'
import type { CordisXConfigPlugin } from '../launcher/config.js'
import type { ManagerRendererChannelContext } from './manager-renderer-sessions.js'
import { loadServiceConfiguredArchive } from './service-renderer-projection.js'

/**
 * Owner-private reverse mapping. Neither source nor staged paths are sent to a renderer.
 * The owner must invalidate `isCurrent` on graph, policy, configuration, or service changes.
 */
export class ServiceRendererIdentityProjection {
  private readonly aliases = new Map<string, { pluginId: string; source: string; digest: string }>()
  private readonly plugins = new Set<string>()
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
    this.plugins.add(captured.id)
    return alias
  }

  /** Resolve only inside the owner after authenticating this exact renderer session. */
  resolve(context: ManagerRendererChannelContext, alias: string, pluginId: string) {
    const value = this.current(context) ? this.aliases.get(alias) : undefined
    if (!value || value.pluginId !== pluginId) throw new Error('renderer-identity-unavailable')
    return { ...value }
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
