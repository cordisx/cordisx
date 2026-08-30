import type { CordisXJsonValue } from '../contracts.js'
import type { CordisXOwnerDocumentLoadResultV1, CordisXOwnerDocumentReplaceResultV1 } from '../durable-document-contracts.js'
import { OwnerDocumentStore, type OwnerDocumentIdentity } from './owner-document-store.js'

export const OWNER_DOCUMENT_BINDING = '__cordisxOwnerDocumentRequestV1'
export const OWNER_DOCUMENT_RECEIVER = '__cordisxOwnerDocumentReceiveV1'
export const MAX_OWNER_DOCUMENT_REQUEST_BYTES = 1_048_576
export const MAX_OWNER_DOCUMENT_REQUESTS = 16

interface RequestBase {
  readonly version: 1
  readonly requestId: string
  readonly token: string
  readonly operation: 'load' | 'replace'
  readonly identity: OwnerDocumentIdentity
  readonly scope: { readonly profileId: string; readonly generation: string }
  readonly documentId: string
}

export type OwnerDocumentBindingRequest = RequestBase & {
  readonly expectedRevision?: number
  readonly schemaVersion?: number
  readonly value?: CordisXJsonValue
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extra = Object.keys(value).find(key => !allowed.includes(key))
  if (extra !== undefined) throw new Error(`${label}.${extra} is not supported`)
}

function jsonValue(value: unknown, label: string, seen = new Set<object>()): CordisXJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object') throw new Error(`${label} must be JSON-compatible`)
  if (seen.has(value)) throw new Error(`${label} must not be circular`)
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${label}[${index}]`, seen))
    const output: Record<string, CordisXJsonValue> = Object.create(null) as Record<string, CordisXJsonValue>
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error(`${label} contains a reserved key`)
      output[key] = jsonValue(item, `${label}.${key}`, seen)
    }
    return output
  } finally {
    seen.delete(value)
  }
}

export function parseOwnerDocumentBindingRequest(
  value: unknown,
  token: string,
  profileId: string,
  generation: string,
): OwnerDocumentBindingRequest {
  const request = record(value, 'owner document request')
  exactKeys(request, [
    'version', 'requestId', 'token', 'operation', 'identity', 'scope', 'documentId',
    'expectedRevision', 'schemaVersion', 'value',
  ], 'owner document request')
  if (request.version !== 1) throw new Error('owner document request version is invalid')
  if (request.token !== token) throw new Error('owner document request token is invalid')
  if (request.operation !== 'load' && request.operation !== 'replace') throw new Error('owner document operation is invalid')
  if (typeof request.requestId !== 'string' || !/^[A-Za-z0-9-]{1,96}$/u.test(request.requestId)) throw new Error('owner document requestId is invalid')
  if (typeof request.documentId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(request.documentId)) throw new Error('owner document documentId is invalid')
  const identity = record(request.identity, 'owner document identity')
  exactKeys(identity, ['source', 'pluginId'], 'owner document identity')
  if (typeof identity.source !== 'string' || identity.source.length === 0 || Buffer.byteLength(identity.source) > 4096) throw new Error('owner document source is invalid')
  if (typeof identity.pluginId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(identity.pluginId)) throw new Error('owner document pluginId is invalid')
  const scope = record(request.scope, 'owner document scope')
  exactKeys(scope, ['profileId', 'generation'], 'owner document scope')
  if (scope.profileId !== profileId) throw new Error('owner document profile is stale or spoofed')
  if (scope.generation !== generation) throw new Error('owner document generation is stale or spoofed')
  const base: RequestBase = {
    version: 1,
    requestId: request.requestId,
    token,
    operation: request.operation,
    identity: { source: identity.source, pluginId: identity.pluginId },
    scope: { profileId, generation },
    documentId: request.documentId,
  }
  if (request.operation === 'load') return base
  if (!Number.isSafeInteger(request.expectedRevision) || (request.expectedRevision as number) < 0) throw new Error('owner document expectedRevision is invalid')
  if (!Number.isSafeInteger(request.schemaVersion) || (request.schemaVersion as number) < 1) throw new Error('owner document schemaVersion is invalid')
  if (!Object.hasOwn(request, 'value')) throw new Error('owner document replacement requires value')
  return {
    ...base,
    expectedRevision: request.expectedRevision as number,
    schemaVersion: request.schemaVersion as number,
    value: jsonValue(request.value, 'owner document value'),
  }
}

export interface OwnerDocumentBridgeHandler {
  readonly token: string
  readonly profileId: string
  readonly generation: string
  load(request: OwnerDocumentBindingRequest): Promise<CordisXOwnerDocumentLoadResultV1>
  replace(request: OwnerDocumentBindingRequest): Promise<CordisXOwnerDocumentReplaceResultV1>
}

export function createOwnerDocumentBridgeHandler(input: {
  readonly token: string
  readonly profileId: string
  readonly generation: string
  readonly store: OwnerDocumentStore
  readonly identityAllowed: (identity: OwnerDocumentIdentity) => boolean | Promise<boolean>
}): OwnerDocumentBridgeHandler {
  const authorize = async (request: OwnerDocumentBindingRequest): Promise<boolean> => await input.identityAllowed(request.identity)
  return {
    token: input.token,
    profileId: input.profileId,
    generation: input.generation,
    async load(request) {
      if (!await authorize(request)) return { status: 'unavailable', code: 'stale-generation', diagnostic: 'plugin owner is stale', recoverable: true }
      return await input.store.load({ profileId: input.profileId, identity: request.identity }, request.documentId)
    },
    async replace(request) {
      if (!await authorize(request)) return { status: 'unavailable', code: 'stale-generation', diagnostic: 'plugin owner is stale', recoverable: true }
      return await input.store.replace({
        scope: { profileId: input.profileId, identity: request.identity },
        documentId: request.documentId,
        expectedRevision: request.expectedRevision!,
        schemaVersion: request.schemaVersion!,
        value: request.value,
      })
    },
  }
}

export function ownerDocumentBridgeError(): Extract<CordisXOwnerDocumentLoadResultV1, { readonly status: 'unavailable' }> {
  return { status: 'unavailable', code: 'host-unavailable', diagnostic: 'owner document request was rejected', recoverable: true }
}
