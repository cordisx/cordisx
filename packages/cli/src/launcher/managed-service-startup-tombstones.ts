import type { ManagedServiceUIOwner } from './managed-service-ui-rpc.js'

/** Bounded receipts for previously issued tokens, never an alternate authorization registry. */
export class ManagedServiceStartupTombstones {
  private readonly retired = new Map<
    string,
    { readonly owner: ManagedServiceUIOwner; readonly reason: 'scope-revoked' | 'host-replaced' }
  >()

  constructor(
    private readonly profileId: string,
    private readonly runtimeGeneration: string,
    private readonly limit = 256,
  ) {}

  retire(token: string, owner: ManagedServiceUIOwner, reason: 'scope-revoked' | 'host-replaced'): void {
    this.retired.delete(token)
    this.retired.set(token, { owner, reason })
    while (this.retired.size > this.limit) this.retired.delete(this.retired.keys().next().value!)
  }

  contains(token: string): boolean {
    return this.retired.has(token)
  }

  result(
    envelope: Record<string, unknown>,
  ): { readonly status: 'startup-terminated'; readonly reason: 'scope-revoked' | 'host-replaced' } | undefined {
    if (
      envelope.version !== 1 || typeof envelope.token !== 'string'
      || typeof envelope.requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(envelope.requestId)
      || !['startupRead', 'startupSubscribe', 'startupNext', 'startupClose'].includes(String(envelope.operation))
    ) return undefined
    const retired = this.retired.get(envelope.token)
    if (retired === undefined) return undefined
    const scope = envelope.scope
    if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) return undefined
    const value = scope as Record<string, unknown>
    if (
      Object.keys(value).sort().join(',') !== 'pluginGeneration,profileId,runtimeGeneration'
      || value.profileId !== this.profileId || value.runtimeGeneration !== this.runtimeGeneration
      || value.pluginGeneration !== retired.owner.pluginGeneration
    ) return undefined
    return { status: 'startup-terminated', reason: retired.reason }
  }
}
