import type { ManagedServiceSafeValueV1 } from '@cordisx/protocol/managed-service-runtime/v1'
import { isDeepStrictEqual, types } from 'node:util'
import type { ManagedBackendRuntimeServiceModuleAccess } from './packages/authority-access.js'

/** Validate data shape without invoking accessors, serialization hooks or proxy traps.
 * This does not classify string contents as secrets or grant access to named paths.
 */
export function cloneManagedServiceConfigurationValue(
  value: unknown,
  ancestors = new Set<object>(),
): ManagedServiceSafeValueV1 {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object' || value === null || types.isProxy(value)) {
    throw new Error('managed service configuration must contain only safe JSON values')
  }
  const array = Array.isArray(value)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) {
    throw new Error('managed service configuration must contain only plain JSON objects')
  }
  if (ancestors.has(value)) throw new Error('managed service configuration is cyclic')
  ancestors.add(value)
  try {
    const output: Record<string, ManagedServiceSafeValueV1> | ManagedServiceSafeValueV1[] = array
      ? []
      : Object.create(null) as Record<string, ManagedServiceSafeValueV1>
    const keys = Reflect.ownKeys(value)
    for (const key of keys) {
      if (array && key === 'length') continue
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!
      if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new Error('managed service configuration must contain only enumerable JSON data')
      }
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) {
        throw new Error('managed service configuration array has non-JSON properties')
      }
      Object.defineProperty(output, key, {
        value: cloneManagedServiceConfigurationValue(descriptor.value, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    if (array && keys.length !== value.length + 1) throw new Error('managed service configuration array is sparse')
    return Object.freeze(output)
  } finally {
    ancestors.delete(value)
  }
}

/** This is raw Host-selected data, not yet a safe callback input. */
export function snapshotSelectedManagedServiceConfiguration(
  value: unknown,
): Readonly<Record<string, ManagedServiceSafeValueV1>> | undefined {
  if (value === undefined) return undefined
  const cloned = cloneManagedServiceConfigurationValue(value)
  if (cloned === null || typeof cloned !== 'object' || Array.isArray(cloned)) {
    throw new Error('managed service instance configuration must be an object')
  }
  return cloned as Readonly<Record<string, ManagedServiceSafeValueV1>>
}

/** Snapshot before queued replacement or imports; never share mutable profile data. */
export function snapshotManagedServiceConfigurations(
  accesses: readonly ManagedBackendRuntimeServiceModuleAccess[],
): readonly ManagedBackendRuntimeServiceModuleAccess[] {
  const owners = new Map<string, unknown>()
  return accesses.map(access => {
    if (access.startup === undefined) return access
    const selectedConfiguration = snapshotSelectedManagedServiceConfiguration(access.selectedConfiguration)
    const key = JSON.stringify([
      access.pluginIdentity.source,
      access.pluginIdentity.pluginId,
      access.pluginIdentity.generation,
    ])
    if (owners.has(key) && !isDeepStrictEqual(owners.get(key), selectedConfiguration)) {
      throw new Error('managed service instance configuration differs within one plugin generation')
    }
    if (!owners.has(key)) owners.set(key, selectedConfiguration)
    return { ...access, selectedConfiguration: owners.get(key) }
  })
}
