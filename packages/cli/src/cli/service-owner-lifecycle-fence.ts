import type { PluginRuntimePreflight } from '../launcher/plugin-lifecycle-model.js'
import type { OwnerRendererLifecycle } from './owner-renderer-lifecycle.js'
import type { ServiceRendererParticipants } from './service-renderer-participant.js'
import type { ServiceRendererBootstrap } from './service-renderer-bootstrap.js'
import type { createManagerManagedServiceUIBridge } from './manager-managed-service-ui.js'
import type { ProductionPluginManagementComposition } from './production-plugin-management.js'

export interface ServiceOwnerLifecycleFence {
  isCurrent(): boolean
  cancel(): boolean
  abort(): boolean
  finish(): Promise<boolean>
  fence(): void
}

/** Compose the Manager portion of one service-owner plugin lifecycle transaction. */
export async function reserveServiceOwnerLifecycle(input: {
  readonly mutation: PluginRuntimePreflight
  readonly management: NonNullable<ProductionPluginManagementComposition['lifecycleParticipants']>
  readonly bootstrap: ServiceRendererBootstrap
  readonly managedUI: ReturnType<typeof createManagerManagedServiceUIBridge>
  readonly lifecycle: OwnerRendererLifecycle
  readonly participants: ServiceRendererParticipants
}): Promise<ServiceOwnerLifecycleFence> {
  if (!input.participants.isBoundTo(input.lifecycle)) throw new Error('manager-lifecycle-fence-unavailable')
  const writes = await input.management.reserveWrites()
  let managed: Awaited<ReturnType<typeof input.managedUI.reserveTransition>>
  try {
    managed = await input.managedUI.reserveTransition()
  } catch {
    try {
      if (!writes.release()) writes.fence()
    } catch {
      writes.fence()
    }
    throw new Error('manager-lifecycle-fence-unavailable')
  }
  let handoff: Awaited<ReturnType<ServiceRendererBootstrap['reserveLifecycleHandoff']>>
  try {
    handoff = await input.bootstrap.reserveLifecycleHandoff({
      transactionId: input.mutation.transactionId,
      previous: input.mutation.previous,
      current: () => writes.isCurrent() && managed.isCurrent(),
      admitted: peer => input.management.admitted(peer),
    })
  } catch {
    let released = false
    try {
      released = managed.cancel() && writes.release()
    } catch { /* A failed acquisition is handled below. */ }
    if (!released) {
      managed.fence()
      writes.fence()
      input.participants.disconnectAll()
    }
    throw new Error('manager-lifecycle-fence-unavailable')
  }
  let ended = false
  const current = () => {
    try {
      return !ended && writes.isCurrent() && managed.isCurrent() && handoff.isCurrent()
    } catch {
      return false
    }
  }
  const fence = () => {
    if (ended) return
    ended = true
    for (const close of [handoff.fence, managed.fence, writes.fence, () => input.participants.disconnectAll()]) {
      try {
        close()
      } catch { /* Every remaining fence must still be applied. */ }
    }
  }
  const settle = (afterAbort: boolean): boolean => {
    try {
      if (current() && handoff.cancel() && (afterAbort ? managed.resume() : managed.cancel()) && writes.release()) {
        ended = true
        return true
      }
    } catch { /* Unconfirmed cleanup remains fenced. */ }
    fence()
    return false
  }
  return {
    isCurrent: current,
    cancel: () => settle(false),
    abort: () => settle(true),
    finish: async () => {
      if (!current()) {
        fence()
        return false
      }
      try {
        const adopted = await handoff.adopt(input.lifecycle.snapshot())
        if (adopted && current() && handoff.release() && managed.resume() && writes.release()) {
          ended = true
          return true
        }
      } catch { /* An unavailable owner snapshot cannot certify a handoff. */ }
      fence()
      return false
    },
    fence,
  }
}
