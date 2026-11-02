import type {
  StartupActionAvailabilityV1,
  StartupActionReasonV1,
  StartupCapabilityRefV1,
  StartupModeV1,
} from '@cordisx/protocol/startup/v1'

/** Read/wait port of the sole managed-service startup authority. Never prepares services. */
export interface StartupRequirementsAuthority {
  targets(mode: StartupModeV1, explicit?: StartupCapabilityRefV1): readonly StartupCapabilityRefV1[]
  availability(ref: StartupCapabilityRefV1, modelId?: string): StartupActionAvailabilityV1
  wait(
    ref: StartupCapabilityRefV1,
    options: { readonly modelId?: string; readonly signal?: AbortSignal; readonly timeoutMs?: number },
  ): Promise<StartupActionAvailabilityV1>
}

export type StartupRequirementsResult =
  | { readonly status: 'ready' }
  | {
    readonly status: 'unavailable'
    readonly target: StartupCapabilityRefV1
    readonly reason: StartupActionReasonV1
  }
  | { readonly status: 'cancelled' | 'timed-out' }

const terminalReasons = new Set<StartupActionReasonV1>([
  'unknown-target',
  'authentication-required',
  'catalog-empty',
  'model-unavailable',
  'failed',
  'stopped',
  'revoked',
  'permission-denied',
  'unsupported',
  'stale-generation',
  'binding-unavailable',
])
const sameTarget = (a: StartupCapabilityRefV1, b: StartupCapabilityRefV1) =>
  a.pluginId === b.pluginId && a.capabilityId === b.capabilityId

/**
 * Caller requirements are separate from workspace readiness and shared preparation.
 * This object owns only waiters. It cannot stop a Host, retry a service, or acquire
 * credentials. A caller may acquire its own lease only after a ready result.
 */
export class StartupRequirementsCoordinator {
  constructor(private readonly authority: StartupRequirementsAuthority) {}

  async wait(input: {
    readonly mode: StartupModeV1
    readonly explicit?: { readonly target: StartupCapabilityRefV1; readonly modelId?: string }
    readonly signal?: AbortSignal
    readonly timeoutMs: number
  }): Promise<StartupRequirementsResult> {
    if (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 0) {
      throw new Error('startup requirements timeout is invalid')
    }
    if (input.signal?.aborted) return { status: 'cancelled' }
    const deadline = Date.now() + input.timeoutMs
    // Always requirements apply in both ordinary and explicit invocations.
    const targets = [...this.authority.targets(input.mode)]
    if (input.explicit !== undefined) {
      for (const target of this.authority.targets(input.mode, input.explicit.target)) {
        if (!targets.some(item => sameTarget(item, target))) targets.push(target)
      }
    }
    const modelFor = (target: StartupCapabilityRefV1) =>
      input.explicit !== undefined && sameTarget(input.explicit.target, target) ? input.explicit.modelId : undefined
    for (const target of targets) {
      const available = this.authority.availability(target, modelFor(target))
      if (!available.available && terminalReasons.has(available.reason)) {
        return { status: 'unavailable', target, reason: available.reason }
      }
    }
    if (targets.every(target => this.authority.availability(target, modelFor(target)).available)) {
      return { status: 'ready' }
    }
    if (input.timeoutMs === 0) return { status: 'timed-out' }
    const waiter = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined
    const interrupted = new Promise<StartupRequirementsResult>(resolve => {
      abort = () => {
        resolve({ status: 'cancelled' })
        waiter.abort()
      }
      input.signal?.addEventListener('abort', abort, { once: true })
      if (input.signal?.aborted) abort()
      timer = setTimeout(() => {
        resolve({ status: 'timed-out' })
        waiter.abort()
      }, Math.max(0, deadline - Date.now()))
    })
    // Fail fast even when another required capability remains pending. All waits
    // start concurrently and consume the same finite caller budget.
    const required = new Promise<StartupRequirementsResult>((resolve, reject) => {
      let remaining = targets.length
      for (const target of targets) {
        void this.authority.wait(target, {
          ...(modelFor(target) === undefined ? {} : { modelId: modelFor(target)! }),
          signal: waiter.signal,
          timeoutMs: Math.max(0, deadline - Date.now()),
        }).then(available => {
          if (!available.available) resolve({ status: 'unavailable', target, reason: available.reason })
          else if (--remaining === 0) resolve({ status: 'ready' })
        }, error => {
          if (waiter.signal.aborted) return
          // Preserve an authority terminal reason that raced a timeout/rejection.
          const available = this.authority.availability(target, modelFor(target))
          if (!available.available && terminalReasons.has(available.reason)) {
            resolve({ status: 'unavailable', target, reason: available.reason })
          } else if (Date.now() >= deadline) resolve({ status: 'timed-out' })
          else reject(error)
        })
      }
    })
    try {
      return await Promise.race([interrupted, required])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (abort !== undefined) input.signal?.removeEventListener('abort', abort)
      // Cancels only this call's remaining authority waiters, never preparation.
      waiter.abort()
    }
  }
}
