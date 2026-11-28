import { isDeepStrictEqual } from 'node:util'
import type { ManagedServiceClientBorrowPolicy } from '../launcher/managed-service-client-reservation.js'
import type { ManagedServiceSafeValueV1 } from '@cordisx/protocol/managed-service-runtime/v1'

const operationId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const prohibitedKey =
  /^(?:secret|secrets|password|credential|credentials|cookie|cookies|token|accessToken|refreshToken|apiKey|authorization|privateKey)$/iu

/** Convert one owner-provided, side-effect-free action plan into an exact borrowed-client policy. */
export function managedAccountToggleBorrowPolicy(
  input: unknown,
  isCurrent: () => boolean,
): ManagedServiceClientBorrowPolicy {
  const invalid = (): never => {
    throw new Error('managed-account-toggle-plan-unavailable')
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid()
  const record = input as Record<string, unknown>
  if (Object.keys(record).join(',') !== 'operations' || !Array.isArray(record.operations)) return invalid()
  if (record.operations.length === 0 || record.operations.length > 32) return invalid()
  const operations = new Map<
    string,
    { readonly value: ManagedServiceSafeValueV1 | undefined; readonly limit: number }
  >()
  let total = 0
  for (const item of record.operations) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return invalid()
    const entry = item as Record<string, unknown>
    if (
      Object.keys(entry).some(key => !['operationId', 'value', 'maxInvocations'].includes(key))
      || typeof entry.operationId !== 'string' || !operationId.test(entry.operationId)
      || operations.has(entry.operationId) || !Number.isSafeInteger(entry.maxInvocations)
      || (entry.maxInvocations as number) < 1 || (entry.maxInvocations as number) > 32
    ) return invalid()
    const pending: unknown[] = entry.value === undefined ? [] : [entry.value]
    const seen = new WeakSet<object>()
    let count = 0
    while (pending.length) {
      if (++count > 4_096) return invalid()
      const current = pending.pop()
      if (current === null || typeof current === 'string' || typeof current === 'boolean') continue
      if (typeof current === 'number' && Number.isFinite(current)) continue
      if (!current || typeof current !== 'object') return invalid()
      if (seen.has(current)) return invalid()
      seen.add(current)
      if (Array.isArray(current)) {
        if (Object.keys(current).length !== current.length) return invalid()
        pending.push(...current)
        continue
      }
      if (Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) {
        return invalid()
      }
      for (const [key, child] of Object.entries(current)) {
        if (prohibitedKey.test(key)) return invalid()
        pending.push(child)
      }
    }
    let encoded: string | undefined
    try {
      encoded = entry.value === undefined ? undefined : JSON.stringify(entry.value)
    } catch {
      return invalid()
    }
    if (entry.value !== undefined && (encoded === undefined || Buffer.byteLength(encoded) > 64 * 1024)) return invalid()
    let value: ManagedServiceSafeValueV1 | undefined
    try {
      value = encoded === undefined ? undefined : JSON.parse(encoded) as ManagedServiceSafeValueV1
    } catch {
      return invalid()
    }
    const limit = entry.maxInvocations as number
    total += limit
    if (total > 32) return invalid()
    operations.set(entry.operationId, { value, limit })
  }
  return {
    operations: [...operations.keys()],
    limits: Object.fromEntries([...operations].map(([key, value]) => [key, value.limit])),
    allows: (operation, value) =>
      operations.has(operation) && isDeepStrictEqual(operations.get(operation)!.value, value),
    isCurrent,
  }
}
