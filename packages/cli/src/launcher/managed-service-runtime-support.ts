import type {
  ManagedServiceBindingV1,
  ManagedServiceControlResultV1,
  ManagedServiceDiagnosticV1,
  ManagedServiceIdentityV1,
  ManagedServiceSafeValueV1,
} from '@cordisx/protocol/managed-service-runtime/v1'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'

const FORBIDDEN_RESULT_KEYS = new Set([
  'authorization',
  'authority',
  'connection',
  'credential',
  'headers',
  'origin',
  'password',
  'port',
  'secret',
  'token',
])

export function managedHandle(prefix: string): `${string}_${string}` {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`
}

export function managedDiagnostic(
  code: ManagedServiceDiagnosticV1['code'],
  retryable: boolean,
): ManagedServiceDiagnosticV1 {
  return Object.freeze({ code, retryable })
}

type ManagedServiceFailure = Exclude<ManagedServiceControlResultV1, { readonly status: 'ready' | 'accepted' }>

export function managedFailure(
  status: Exclude<ManagedServiceControlResultV1['status'], 'ready' | 'accepted'>,
  code: ManagedServiceDiagnosticV1['code'],
  retryable: boolean,
): ManagedServiceFailure {
  return Object.freeze({ status, diagnostic: managedDiagnostic(code, retryable) })
}

export function managedIdentityKey(identity: ManagedServiceIdentityV1): string {
  return `${identity.source}\u0000${identity.pluginId}\u0000${identity.serviceId}`
}

export function managedBindingCurrent(
  expected: ManagedServiceBindingV1,
  actual: ManagedServiceBindingV1,
  disposed: boolean,
): boolean {
  return !disposed
    && actual.registrationHandle === expected.registrationHandle
    && actual.serviceHandle === expected.serviceHandle
    && actual.hostGeneration === expected.hostGeneration
    && actual.serviceGeneration === expected.serviceGeneration
}

export function assertManagedMaterializationOverlap(
  left: { readonly slot: string; readonly pointer: `/${string}` | undefined; readonly safeLiteral: boolean },
  right: { readonly slot: string; readonly pointer: `/${string}` | undefined; readonly safeLiteral: boolean },
): void {
  if (left.pointer === undefined || right.pointer === undefined) {
    if (left.slot === right.slot) throw new Error('duplicate environment materialization')
    return
  }
  const leftAncestor = right.pointer.startsWith(`${left.pointer}/`)
  const rightAncestor = left.pointer.startsWith(`${right.pointer}/`)
  if (left.pointer !== right.pointer && !leftAncestor && !rightAncestor) return
  const ancestor = leftAncestor ? left : rightAncestor ? right : undefined
  const descendant = leftAncestor ? right : rightAncestor ? left : undefined
  if (
    ancestor !== undefined && descendant !== undefined && ancestor.slot === descendant.slot
    && ancestor.safeLiteral && !descendant.safeLiteral
  ) return
  throw new Error('managed service materialization pointers overlap')
}

export function assertManagedSafeValue(
  value: unknown,
  seen = new Set<object>(),
): asserts value is ManagedServiceSafeValueV1 {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('managed service returned a non-finite number')
    return
  }
  if (typeof value !== 'object') throw new Error('managed service returned an unsafe value')
  if (seen.has(value)) throw new Error('managed service returned a cyclic value')
  seen.add(value)
  if (Array.isArray(value)) value.forEach(item => assertManagedSafeValue(item, seen))
  else {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_RESULT_KEYS.has(key.toLowerCase())) {
        throw new Error('managed service returned an authority-shaped field')
      }
      assertManagedSafeValue(item, seen)
    }
  }
  seen.delete(value)
}

export function managedPointerValue(
  value: ManagedServiceSafeValueV1,
  pointer: `/${string}`,
): ManagedServiceSafeValueV1 {
  let current: ManagedServiceSafeValueV1 = value
  for (const token of pointer.slice(1).split('/').map(item => item.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (Array.isArray(current)) {
      const index = Number(token)
      if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) {
        throw new Error('invalid invocation pointer')
      }
      current = current[index]!
    } else if (
      current !== null && typeof current === 'object' && !Array.isArray(current) && Object.hasOwn(current, token)
    ) {
      current = (current as { readonly [key: string]: ManagedServiceSafeValueV1 })[token]!
    } else throw new Error('invalid invocation pointer')
  }
  return structuredClone(current)
}

export function setManagedPointer(root: unknown, pointer: `/${string}`, value: ManagedServiceSafeValueV1): void {
  if (root === null || typeof root !== 'object') throw new Error('configuration template must be an object')
  const tokens = pointer.slice(1).split('/').map(item => item.replaceAll('~1', '/').replaceAll('~0', '~'))
  const isNumeric = (segment: string): boolean => /^\d+$/u.test(segment)
  let current: Record<string, unknown> | unknown[] = root as Record<string, unknown> | unknown[]
  for (const [index, token] of tokens.entries()) {
    const isLast = index === tokens.length - 1
    const nextToken = isLast ? undefined : tokens[index + 1]!
    if (Array.isArray(current)) {
      const item = Number(token)
      if (!Number.isSafeInteger(item) || item < 0 || item > current.length) {
        throw new Error('configuration pointer has an invalid array index')
      }
      const childToken = nextToken!
      if (isLast) {
        current[item] = structuredClone(value)
        return
      }
      const existing = current[item]
      if (existing === null || typeof existing !== 'object') {
        current[item] = isNumeric(childToken) ? [] : {}
      }
      current = current[item] as Record<string, unknown> | unknown[]
      continue
    }
    const childToken = nextToken!
    if (isLast) {
      ;(current as Record<string, unknown>)[token] = structuredClone(value)
      return
    }
    const existing = (current as Record<string, unknown>)[token]
    if (existing === null || typeof existing !== 'object') {
      ;(current as Record<string, unknown>)[token] = isNumeric(childToken) ? [] : {}
    }
    current = (current as Record<string, unknown>)[token] as Record<string, unknown> | unknown[]
  }
}

export async function managedContainedFile(root: string, relative: `./${string}`): Promise<string> {
  const stableRoot = path.resolve(root)
  const canonicalRoot = await realpath(root)
  const target = path.resolve(stableRoot, relative.slice(2))
  const relativeTarget = path.relative(stableRoot, target)
  if (
    relativeTarget === '' || relativeTarget === '..' || relativeTarget.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeTarget)
  ) throw new Error('managed service file escapes its package')
  let current = canonicalRoot
  for (const segment of relativeTarget.split(path.sep)) {
    current = path.join(current, segment)
    const metadata = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (metadata === undefined) break
    if (metadata.isSymbolicLink()) throw new Error('managed service file uses a symbolic link')
  }
  return target
}

export async function readManagedContainedFile(
  root: string,
  relative: `./${string}`,
  maxBytes: number,
): Promise<Buffer> {
  const canonicalRoot = await realpath(root)
  const target = path.resolve(canonicalRoot, relative.slice(2))
  const relativeTarget = path.relative(canonicalRoot, target)
  if (
    relativeTarget === '' || relativeTarget === '..' || relativeTarget.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeTarget)
  ) throw new Error('managed service file escapes its restricted root')
  const canonicalTarget = await realpath(target)
  if (canonicalTarget !== target) throw new Error('managed service restricted file uses a symbolic link')
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    return await readManagedBoundedFile(handle, maxBytes)
  } finally {
    await handle.close()
  }
}

export async function readManagedBoundedFile(
  handle: Pick<FileHandle, 'read' | 'stat'>,
  maxBytes: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('managed service file bound is invalid')
  const before = await handle.stat()
  if (!before.isFile() || before.size > maxBytes) {
    throw new Error('managed service restricted file is not a bounded regular file')
  }
  const buffer = Buffer.allocUnsafe(maxBytes + 1)
  let offset = 0
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  const after = await handle.stat()
  if (offset > maxBytes || after.size !== offset) {
    throw new Error('managed service restricted file changed during bounded readback')
  }
  return buffer.subarray(0, offset)
}

export async function readManagedResponseBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('managed service response bound is invalid')
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel('managed service response is too large')
        throw new Error('managed service response is too large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
