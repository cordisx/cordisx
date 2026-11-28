import type { PluginRuntimePreflight } from '../launcher/plugin-lifecycle-model.js'
import { isDeepStrictEqual } from 'node:util'
import { pluginDependentClosure } from '../launcher/plugin-activation.js'
import type { ManagedServiceClientReservation } from '../launcher/managed-service-client-reservation.js'
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

/** Include changed packages and their dependents in both activation graphs. */
export function lifecycleAffectedPlugins(mutation: PluginRuntimePreflight): readonly string[] {
  const before = new Map(mutation.previous.plugins.map(plugin => [plugin.id, plugin]))
  const after = new Map(mutation.candidate.plugins.map(plugin => [plugin.id, plugin]))
  const changed = new Set([mutation.targetId])
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    if (!isDeepStrictEqual(before.get(id), after.get(id))) changed.add(id)
  }
  const affected = new Set(changed)
  for (const id of changed) {
    for (const dependent of pluginDependentClosure(mutation.previous.plugins, id)) affected.add(dependent)
    for (const dependent of pluginDependentClosure(mutation.candidate.plugins, id)) affected.add(dependent)
  }
  return [...affected]
}

/** Keep client admission closed until the Manager handoff has settled. */
export function includeClientLifecycleFence(
  client: ManagedServiceClientReservation,
  manager?: ServiceOwnerLifecycleFence,
): ServiceOwnerLifecycleFence {
  let ended = false
  const current = () => {
    try {
      return !ended && client.isCurrent() && (manager?.isCurrent() ?? true)
    } catch {
      return false
    }
  }
  const fence = () => {
    if (ended) return
    ended = true
    for (const close of [() => manager?.fence(), () => client.fence()]) {
      try {
        close()
      } catch { /* Continue fencing the other participant. */ }
    }
  }
  const settle = (action: 'cancel' | 'abort') => {
    try {
      if (current() && (manager?.[action]() ?? true) && client.isCurrent() && client.release()) {
        ended = true
        return true
      }
    } catch { /* Unconfirmed release must remain fenced. */ }
    fence()
    return false
  }
  return {
    isCurrent: current,
    cancel: () => settle('cancel'),
    abort: () => settle('abort'),
    finish: async () => {
      try {
        if (
          current() && (manager === undefined || await manager.finish()) && client.isCurrent()
          && client.release()
        ) {
          ended = true
          return true
        }
      } catch { /* Unconfirmed release must remain fenced. */ }
      fence()
      return false
    },
    fence,
  }
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
