import type { CordisXPermissionPolicyRecordV2 } from '../permission-contracts.js'
import { persistedPermissionRecordKey } from '../permission-persistence.js'
import type { ManagerRendererChannelContext } from './manager-renderer-sessions.js'

type Grant = {
  readonly key: string
  readonly moduleGeneration: string
  readonly expires: number
  readonly current: () => boolean
}

/** Owner-side one-use grants for a specific admitted renderer and request. */
export class ServiceRendererRuntimeGrants {
  private readonly sessions = new WeakMap<AbortSignal, Map<string, Grant>>()

  issue(context: ManagerRendererChannelContext, input: {
    readonly requestId: string
    readonly record: CordisXPermissionPolicyRecordV2
    readonly moduleGeneration: string
    readonly current: () => boolean
  }): void {
    if (context.admitted !== true || context.signal.aborted || !input.current()) {
      throw new Error('renderer-runtime-grant-unavailable')
    }
    let grants = this.sessions.get(context.signal)
    if (!grants) {
      grants = new Map()
      this.sessions.set(context.signal, grants)
      context.signal.addEventListener('abort', () => grants!.clear(), { once: true })
    }
    const now = Date.now()
    for (const [id, grant] of grants) if (grant.expires < now) grants.delete(id)
    if (grants.size >= 4096 || grants.has(input.requestId)) throw new Error('renderer-runtime-grant-unavailable')
    grants.set(input.requestId, {
      key: persistedPermissionRecordKey(input.record),
      moduleGeneration: input.moduleGeneration,
      expires: now + 60_000,
      current: input.current,
    })
  }

  consume(context: ManagerRendererChannelContext, input: {
    readonly requestId: string
    readonly record: CordisXPermissionPolicyRecordV2
    readonly moduleGeneration: string
  }): boolean {
    const grants = this.sessions.get(context.signal)
    const grant = grants?.get(input.requestId)
    if (!grant) return false
    grants!.delete(input.requestId)
    try {
      return context.admitted === true && !context.signal.aborted && grant.expires >= Date.now()
        && grant.moduleGeneration === input.moduleGeneration
        && grant.key === persistedPermissionRecordKey(input.record) && grant.current()
    } catch {
      return false
    }
  }
}
