import type { CordisXPluginIdentity } from '../../platform-contracts.js'
import { USAGE_PERMISSION_DECISION_SCHEMA_V6, usagePermissionPlan } from '../../usage-authorization.js'
import { PlatformVisualPermissionBroker } from './platform-visual-permission.js'
import type { PlatformPermissionSnapshot, Registration } from './platform-permission-types.js'

interface UsageLease {
  registration: Registration
  state: 'pending' | 'allow' | 'deny'
  result: Promise<boolean>
  cancel(): void
}
function usageManifest(registration: Registration): boolean {
  return registration.manifest.schemaVersion === 11 || registration.manifest.schemaVersion === 12
    || registration.manifest.schemaVersion === 13
}
/** Usage leases never borrow message/history authority. */
export abstract class PlatformUsagePermissionBroker extends PlatformVisualPermissionBroker {
  private readonly usageLeases = new Map<object, UsageLease>()
  private usageSequence = 0
  private usageListening = false
  private readonly retireUsage = (): void => {
    for (const [token, lease] of this.usageLeases) {
      if (
        this.registration(lease.registration.identity) !== lease.registration || !this.isRegistered(lease.registration)
      ) {
        this.usageLeases.delete(token)
        lease.cancel()
      }
    }
  }
  usageFence(identity: CordisXPluginIdentity, generation: string): () => boolean {
    const current = this.registration(identity)
    return () =>
      current !== undefined && this.registration(identity) === current
      && this.isRegistered(current) && current.generation.moduleGeneration === generation
  }
  usageGeneration(identity: CordisXPluginIdentity, generation: string): boolean {
    const current = this.registration(identity)
    return current !== undefined && this.isRegistered(current) && current.generation.moduleGeneration === generation
  }
  usageDenied(identity: CordisXPluginIdentity): boolean {
    const current = this.registration(identity)
    return current !== undefined && this.usageLeases.get(current.token)?.state === 'deny'
  }
  usageAllowed(identity: CordisXPluginIdentity): boolean {
    const current = this.registration(identity)
    return current !== undefined && this.isRegistered(current) && this.usageLeases.get(current.token)?.state === 'allow'
  }
  async authorizeUsage(identity: CordisXPluginIdentity): Promise<boolean> {
    const current = this.registration(identity)
    if (current === undefined || !usageManifest(current) || !this.isRegistered(current)) return false
    const declaration = current.manifest.capabilities.find(item => item.name === 'usage.read')
    if (!declaration) return false
    const old = this.usageLeases.get(current.token)
    if (old) return old.state === 'pending' ? old.result : this.usageAllowed(identity)
    if (!this.usageListening) {
      this.listeners.add(this.retireUsage)
      this.usageListening = true
    }
    // Local development is trusted renderer code. Keep the lease generation-scoped,
    // retain explicit denial above, and never infer development from a file URL.
    if (this.developmentPermission(current, 'usage.read')) {
      this.usageLeases.set(current.token, {
        registration: current,
        state: 'allow',
        result: Promise.resolve(true),
        cancel() {},
      })
      this.changed()
      return this.usageAllowed(identity)
    }
    const operationId = `usage:${++this.usageSequence}`
    const plan = usagePermissionPlan({
      planId: operationId,
      operation: 'runtime',
      profileId: this.profileId,
      identity: { source: identity.source, pluginId: identity.id },
      catalogVersion: 'local-usage-v1',
      binding: this.binding(current, operationId, operationId),
    }, declaration)
    let cancel!: () => void
    const cancelled = new Promise<undefined>(resolve => {
      cancel = () => resolve(undefined)
    })
    const lease: UsageLease = {
      registration: current,
      state: 'pending',
      result: Promise.resolve(false),
      cancel: () => {
        cancel()
        this.promptV2?.cancelUsageV6?.(plan.planId, plan.binding)
      },
    }
    this.usageLeases.set(current.token, lease)
    lease.result = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await Promise.race([
          this.promptV2?.requestUsageV6?.(plan, identity) ?? Promise.resolve(undefined),
          cancelled,
          new Promise<undefined>(resolve => {
            timer = setTimeout(() => resolve(undefined), this.promptTimeoutMs)
          }),
        ])
        const item = result?.decisions[0], expected = plan.declarations[0]!
        const valid = this.registration(identity) === current && this.isRegistered(current)
          && this.usageLeases.get(current.token) === lease
          && result?.$schema === USAGE_PERMISSION_DECISION_SCHEMA_V6 && result.schemaVersion === 6
          && result.origin === 'explicit-user'
          && result.planId === plan.planId && result.profileId === plan.profileId && result.operation === plan.operation
          && JSON.stringify(result.identity) === JSON.stringify(plan.identity)
          && JSON.stringify(result.binding) === JSON.stringify(plan.binding)
          && result.decisions.length === 1 && item?.capability === 'usage.read'
          && item.securityFingerprint === expected.securityFingerprint
          && JSON.stringify(item.scope) === JSON.stringify(expected.scope)
        lease.state = valid && item?.decision === 'allow-once' ? 'allow' : 'deny'
      } catch {
        lease.state = 'deny'
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        this.promptV2?.cancelUsageV6?.(plan.planId, plan.binding)
        this.changed()
      }
      return this.usageAllowed(identity)
    })()
    return await lease.result
  }
  setUsagePolicy(identity: CordisXPluginIdentity, allow: boolean): void {
    const current = this.registration(identity)
    if (!current) return
    const lease = this.usageLeases.get(current.token)
    lease?.cancel()
    if (allow) this.usageLeases.delete(current.token)
    else {this.usageLeases.set(current.token, {
        registration: current,
        state: 'deny',
        result: Promise.resolve(false),
        cancel() {},
      })}
    this.changed()
  }
  protected disposeUsagePermissions(): void {
    for (const lease of this.usageLeases.values()) lease.cancel()
    this.usageLeases.clear()
    this.listeners.delete(this.retireUsage)
  }
  protected usagePermissionSnapshots(): readonly PlatformPermissionSnapshot[] {
    return [...this.registrations.values()].flatMap(current => {
      if (
        !usageManifest(current) || this.registration(current.identity) !== current
        || !this.isRegistered(current)
      ) return []
      const declaration = [...current.manifest.capabilities].find(item => item.name === 'usage.read')
      if (!declaration) return []
      const plan = usagePermissionPlan({
        planId: 'usage-snapshot',
        operation: 'runtime',
        profileId: this.profileId,
        identity: { source: current.identity.source, pluginId: current.identity.id },
        catalogVersion: 'local-usage-v1',
        binding: this.binding(current, 'usage-snapshot', 'usage-snapshot'),
      }, declaration)
      const item = plan.declarations[0]!, lease = this.usageLeases.get(current.token)
      return [{
        identity: current.identity,
        capability: 'usage.read',
        required: declaration.required,
        scope: item.scope,
        reason: item.presentation.description,
        fingerprint: item.securityFingerprint,
        policy: lease?.state === 'allow' ? 'allow' : lease?.state === 'deny' ? 'deny' : 'ask',
        denialCount: lease?.state === 'deny' ? 1 : 0,
      }]
    })
  }
}
