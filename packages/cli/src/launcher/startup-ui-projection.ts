import type { StartupEventV1, StartupSnapshotV1 } from '@cordisx/protocol/startup/v1'

// Explicit wire allowlist. Runtime authority must never accidentally serialize its handles/diagnostics.
type Shape = 'id' | 'number' | 'boolean' | readonly Shape[] | { readonly [key: string]: Shape }
const availability: Shape = { available: 'boolean', reason: 'id' }
const cursor: Shape = { scopeId: 'id', hostGeneration: 'id', epoch: 'id', sequence: 'number' }
const snapshot: Shape = {
  contract: 'id',
  cursor,
  entries: [{
    identity: { pluginId: 'id', capabilityId: 'id', serviceId: 'id', providerId: 'id' },
    generation: { host: 'id', plugin: 'id', service: 'id' },
    state: 'id',
    service: 'id',
    process: 'id',
    health: 'id',
    authentication: 'id',
    catalog: { state: 'id', generation: 'id', modelIds: ['id'] },
    provider: 'id',
    milestones: [{ milestoneId: 'id', state: 'id' }],
    actions: { execute: availability, authenticate: availability, retry: availability },
  }],
  pages: [{ pluginId: 'id', pageId: 'id', actions: [{ actionId: 'id', availability }] }],
}
function safe(value: unknown, shape: Shape): unknown {
  if (value === null) return null
  if (typeof shape === 'string') {
    if (
      shape === 'id' && typeof value === 'string' && value.length > 0 && value.length <= 512
      && !/[\u0000-\u001f]/u.test(value) && !/https?:\/\//iu.test(value)
    ) return value
    if (shape === 'number' && Number.isSafeInteger(value) && (value as number) >= 0) return value
    if (shape === 'boolean' && typeof value === 'boolean') return value
    throw new Error('startup projection contains an invalid safe value')
  }
  if (Array.isArray(shape)) {
    if (!Array.isArray(value) || value.length > 10_000) throw new Error('startup projection array is invalid')
    return value.map(item => safe(item, shape[0]!))
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('startup projection object is invalid')
  }
  const fields = shape as Readonly<Record<string, Shape>>
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const field = Object.hasOwn(fields, key) ? fields[key] : undefined
    if (field === undefined) throw new Error('startup projection contains a private or unsupported field')
    result[key] = safe(item, field)
  }
  return result
}
export function safeStartupSnapshot(value: StartupSnapshotV1): StartupSnapshotV1 {
  return safe(value, snapshot) as StartupSnapshotV1
}
export function safeStartupEvent(value: StartupEventV1): StartupEventV1 {
  if (value.kind === 'connection') {
    return safe(value, { kind: 'id', connection: { state: 'id', reason: 'id' } }) as StartupEventV1
  }
  return safe(
    value,
    value.kind === 'snapshot'
      ? { kind: 'id', reason: 'id', snapshot }
      : { kind: 'id', reason: 'id', cursor },
  ) as StartupEventV1
}
