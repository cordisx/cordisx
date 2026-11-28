import type { CordisXPermissionPolicyRecordV2 } from '../permission-contracts.js'
import { persistedPermissionRecordKey } from '../permission-persistence.js'
import type { ManagerRendererChannelContext } from './manager-renderer-sessions.js'

type Grant = {
  readonly key: string
  readonly moduleGeneration: string
  readonly expires: number
  readonly current: () => boolean
}

type ActivationGrant = {
  readonly key: string
  readonly transactionId: string
  readonly moduleGeneration: string
  readonly digest: string
  readonly expires: number
  committed: boolean
  readonly consumedPeers: Set<string>
}

/** Owner-side one-use grants for a specific admitted renderer and request. */
export class ServiceRendererRuntimeGrants {
  private readonly sessions = new WeakMap<AbortSignal, Map<string, Grant>>()
  private readonly activations = new Map<string, ActivationGrant>()

  issue(context: ManagerRendererChannelContext, input: {
    readonly requestId: string
    readonly record: CordisXPermissionPolicyRecordV2
    readonly moduleGeneration: string
    readonly current: () => boolean
    readonly initial?: true
  }): void {
    if (context.admitted !== true && input.initial !== true || context.signal.aborted || !input.current()) {
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
    readonly initial?: true
  }): boolean {
    const grants = this.sessions.get(context.signal)
    const grant = grants?.get(input.requestId)
    if (!grant) return false
    grants!.delete(input.requestId)
    try {
      return (context.admitted === true || input.initial === true) && !context.signal.aborted
        && grant.expires >= Date.now()
        && grant.moduleGeneration === input.moduleGeneration
        && grant.key === persistedPermissionRecordKey(input.record) && grant.current()
    } catch {
      return false
    }
  }

  /** A reviewed install grants one model read to its exact candidate, even while staging. */
  issueActivation(input: {
    readonly transactionId: string
    readonly record: CordisXPermissionPolicyRecordV2
    readonly moduleGeneration: string
    readonly digest: string
  }): { finish(applied: boolean): void } {
    const now = Date.now()
    for (const [id, value] of this.activations) if (value.expires < now) this.activations.delete(id)
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.transactionId)
      || input.record.policy !== 'ask' || input.record.key.capability !== 'models.read'
      || !/^sha256:[a-f0-9]{64}$/u.test(input.digest) || this.activations.has(input.transactionId)
      || this.activations.size >= 256
    ) throw new Error('renderer-runtime-grant-unavailable')
    const grant: ActivationGrant = {
      key: persistedPermissionRecordKey(input.record),
      transactionId: input.transactionId,
      moduleGeneration: input.moduleGeneration,
      digest: input.digest,
      expires: now + 300_000,
      committed: false,
      consumedPeers: new Set(),
    }
    this.activations.set(input.transactionId, grant)
    let finished = false
    return {
      finish: applied => {
        if (finished) return
        finished = true
        if (!applied || grant.consumedPeers.size > 0) this.activations.delete(input.transactionId)
        else grant.committed = true
      },
    }
  }

  consumeActivation(input: {
    readonly transactionId?: string
    readonly record: CordisXPermissionPolicyRecordV2
    readonly moduleGeneration: string
    readonly digest: string
    readonly rendererId: string
  }): boolean {
    const key = persistedPermissionRecordKey(input.record)
    const match = [...this.activations.values()].find(grant =>
      grant.key === key && grant.moduleGeneration === input.moduleGeneration && grant.digest === input.digest
      && (input.transactionId === undefined ? grant.committed : grant.transactionId === input.transactionId)
    )
    if (
      !match || match.expires < Date.now() || !/^[a-f0-9]{64}$/u.test(input.rendererId)
      || match.consumedPeers.has(input.rendererId) || match.consumedPeers.size >= 16
    ) return false
    match.consumedPeers.add(input.rendererId)
    if (match.committed) this.activations.delete(match.transactionId)
    return true
  }
}
