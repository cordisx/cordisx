import type { CordisXCertifiedPermissionProjectionV1 } from '../permission-contracts.js'
import { normalizeCertifiedPermissionProjectionV1 } from '../permission-model-v4.js'

export const CERTIFIED_PERMISSION_CHANNEL_CONTRACT = 'cordisx.launcher-certified-permission-channel/v1'

const TOKEN = /^[a-f0-9]{64}$/u
const EPOCH = /^[A-Za-z0-9_-]{16,128}$/u
const MAX_ENVELOPE_BYTES = 512 * 1024
const MAX_PROJECTIONS = 1024
const INITIAL_HANDSHAKE_TIMEOUT_MS = 5_000
const HEARTBEAT_TIMEOUT_MS = 15_000

interface CertifiedPermissionSnapshotV1 {
  readonly revision: number
  readonly projections: readonly CordisXCertifiedPermissionProjectionV1[]
}

interface CertifiedPermissionDeliveryEnvelopeV1 {
  readonly contract: typeof CERTIFIED_PERMISSION_CHANNEL_CONTRACT
  readonly profileId: string
  readonly runtimeGeneration: string
  readonly documentEpoch: string
  readonly deliverySequence: number
  readonly authorityRevision: number
  readonly snapshot: CertifiedPermissionSnapshotV1
}

export interface CertifiedPermissionDocumentChannel {
  readonly documentEpoch: string
  readonly ready: Promise<void>
  dispose(): void
}

interface CertifiedPermissionSnapshotSink {
  replaceCertifiedPermissionSnapshot(snapshot: CertifiedPermissionSnapshotV1): void
  clearCertifiedPermissionSnapshot(): void
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key))
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function snapshotKey(projection: CordisXCertifiedPermissionProjectionV1): string {
  return [projection.source, projection.pluginId, projection.version, projection.integrity].join('\u0000')
}

function parseProjection(value: unknown, now: Date): CordisXCertifiedPermissionProjectionV1 | undefined {
  const candidate = object(value)
  if (
    candidate === undefined || typeof candidate.source !== 'string' || typeof candidate.pluginId !== 'string'
    || typeof candidate.version !== 'string' || typeof candidate.integrity !== 'string'
    || !/^sha256:[a-f0-9]{64}$/u.test(candidate.integrity)
  ) return undefined
  return normalizeCertifiedPermissionProjectionV1(
    value,
    { source: candidate.source, pluginId: candidate.pluginId },
    { version: candidate.version, integrity: candidate.integrity as `sha256:${string}` },
    now,
  )
}

function parseEnvelope(
  value: unknown,
  expected: Readonly<{ profileId: string; runtimeGeneration: string; documentEpoch: string }>,
  now: Date,
): CertifiedPermissionDeliveryEnvelopeV1 | undefined {
  const envelope = object(value)
  if (
    envelope === undefined || !exact(envelope, [
      'contract',
      'profileId',
      'runtimeGeneration',
      'documentEpoch',
      'deliverySequence',
      'authorityRevision',
      'snapshot',
    ]) || envelope.contract !== CERTIFIED_PERMISSION_CHANNEL_CONTRACT
    || envelope.profileId !== expected.profileId
    || envelope.runtimeGeneration !== expected.runtimeGeneration
    || envelope.documentEpoch !== expected.documentEpoch
    || !Number.isSafeInteger(envelope.deliverySequence) || (envelope.deliverySequence as number) < 1
    || !Number.isSafeInteger(envelope.authorityRevision) || (envelope.authorityRevision as number) < 0
  ) return undefined
  const snapshot = object(envelope.snapshot)
  if (
    snapshot === undefined || !exact(snapshot, ['revision', 'projections'])
    || snapshot.revision !== envelope.authorityRevision
    || !Array.isArray(snapshot.projections) || snapshot.projections.length > MAX_PROJECTIONS
  ) return undefined
  const projections: CordisXCertifiedPermissionProjectionV1[] = []
  for (const candidate of snapshot.projections) {
    const projection = parseProjection(candidate, now)
    if (projection === undefined) return undefined
    projections.push(projection)
  }
  const keys = projections.map(snapshotKey)
  if (new Set(keys).size !== keys.length || keys.some((key, index) => index > 0 && (keys[index - 1] ?? '') > key)) {
    return undefined
  }
  return Object.freeze({
    contract: CERTIFIED_PERMISSION_CHANNEL_CONTRACT,
    profileId: expected.profileId,
    runtimeGeneration: expected.runtimeGeneration,
    documentEpoch: expected.documentEpoch,
    deliverySequence: envelope.deliverySequence as number,
    authorityRevision: envelope.authorityRevision as number,
    snapshot: Object.freeze({
      revision: snapshot.revision as number,
      projections: Object.freeze(projections),
    }),
  })
}

export function certifiedPermissionEndpointTakeKey(token: string): string {
  if (!TOKEN.test(token)) throw new Error('Certified permission channel token is invalid')
  return `__cordisxCertifiedPermissionEndpointTakeV1_${token}`
}

/**
 * Create a one-document bootstrap endpoint before any plugin activation. The
 * one-shot take function is removed atomically when CDP acquires the endpoint;
 * later deliveries use only the debugger-held RemoteObject objectId.
 */
export function createCertifiedPermissionDocumentChannel(
  options: Readonly<{
    token: string
    profileId: string
    runtimeGeneration: string
    sink: CertifiedPermissionSnapshotSink
    now?: () => Date
    initialHandshakeTimeoutMs?: number
    heartbeatTimeoutMs?: number
  }>,
): CertifiedPermissionDocumentChannel {
  if (
    !TOKEN.test(options.token) || options.profileId.length < 1 || options.profileId.length > 64
    || options.runtimeGeneration.length < 1 || options.runtimeGeneration.length > 200
  ) {
    throw new Error('Certified permission document channel scope is invalid')
  }
  const now = options.now ?? (() => new Date())
  const initialTimeout = options.initialHandshakeTimeoutMs ?? INITIAL_HANDSHAKE_TIMEOUT_MS
  const heartbeatTimeout = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS
  if (
    !Number.isSafeInteger(initialTimeout) || initialTimeout < 1 || initialTimeout > 60_000
    || !Number.isSafeInteger(heartbeatTimeout) || heartbeatTimeout < 1 || heartbeatTimeout > 120_000
  ) {
    throw new Error('Certified permission document channel timeout is invalid')
  }
  const documentEpoch = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID().replaceAll('-', '')
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
  if (!EPOCH.test(documentEpoch)) throw new Error('Certified permission document epoch is invalid')
  const takeKey = certifiedPermissionEndpointTakeKey(options.token)
  const globals = globalThis as typeof globalThis & Record<string, unknown>
  if (Object.hasOwn(globals, takeKey)) throw new Error('Certified permission endpoint take key already exists')
  let disposed = false
  let taken = false
  let lastSequence = 0
  let lastAuthorityRevision = -1
  let lastSnapshotDigest = ''
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined
  let initialTimer: ReturnType<typeof setTimeout> | undefined
  let resolveReady!: () => void
  const ready = new Promise<void>(resolve => {
    resolveReady = resolve
  })
  const clear = (): void => options.sink.clearCertifiedPermissionSnapshot()
  const clearHeartbeat = (): void => {
    if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer)
    heartbeatTimer = undefined
  }
  const removeTake = (): void => {
    const descriptor = Object.getOwnPropertyDescriptor(globals, takeKey)
    if (descriptor?.value === take) Reflect.deleteProperty(globals, takeKey)
  }
  const settleReady = (): void => {
    if (initialTimer !== undefined) clearTimeout(initialTimer)
    initialTimer = undefined
    resolveReady()
  }
  const failClosed = (): void => {
    clearHeartbeat()
    clear()
  }
  const endpoint = Object.freeze({
    describe: (): Readonly<{
      contract: typeof CERTIFIED_PERMISSION_CHANNEL_CONTRACT
      profileId: string
      runtimeGeneration: string
      documentEpoch: string
    }> =>
      Object.freeze({
        contract: CERTIFIED_PERMISSION_CHANNEL_CONTRACT,
        profileId: options.profileId,
        runtimeGeneration: options.runtimeGeneration,
        documentEpoch,
      }),
    deliver: (payload: unknown): Readonly<{
      documentEpoch: string
      deliverySequence: number
      authorityRevision: number
    }> => {
      try {
        if (
          disposed || typeof payload !== 'string'
          || new TextEncoder().encode(payload).byteLength > MAX_ENVELOPE_BYTES
        ) {
          throw new Error('Certified permission delivery was rejected')
        }
        const parsed = parseEnvelope(JSON.parse(payload) as unknown, {
          profileId: options.profileId,
          runtimeGeneration: options.runtimeGeneration,
          documentEpoch,
        }, now())
        if (
          parsed === undefined || parsed.deliverySequence <= lastSequence
          || parsed.authorityRevision < lastAuthorityRevision
        ) {
          throw new Error('Certified permission delivery is stale or invalid')
        }
        const digest = JSON.stringify(parsed.snapshot.projections)
        if (
          parsed.authorityRevision === lastAuthorityRevision && lastSnapshotDigest !== ''
          && digest !== lastSnapshotDigest
        ) {
          throw new Error('Certified permission delivery equivocated at one authority revision')
        }
        options.sink.replaceCertifiedPermissionSnapshot(parsed.snapshot)
        lastSequence = parsed.deliverySequence
        lastAuthorityRevision = parsed.authorityRevision
        lastSnapshotDigest = digest
        clearHeartbeat()
        heartbeatTimer = setTimeout(failClosed, heartbeatTimeout)
        ;(heartbeatTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.()
        settleReady()
        return Object.freeze({
          documentEpoch,
          deliverySequence: lastSequence,
          authorityRevision: lastAuthorityRevision,
        })
      } catch (error) {
        failClosed()
        throw error
      }
    },
    close: (): boolean => {
      if (!disposed) {
        disposed = true
        failClosed()
        removeTake()
        settleReady()
      }
      return true
    },
  })
  const take = (): typeof endpoint | undefined => {
    if (disposed || taken) return undefined
    taken = true
    removeTake()
    return endpoint
  }
  Object.defineProperty(globals, takeKey, {
    value: take,
    configurable: true,
    enumerable: false,
    writable: false,
  })
  initialTimer = setTimeout(() => {
    if (lastSequence === 0) {
      disposed = true
      removeTake()
      failClosed()
      settleReady()
    }
  }, initialTimeout)
  ;(initialTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.()
  return Object.freeze({
    documentEpoch,
    ready,
    dispose: () => {
      endpoint.close()
    },
  })
}
