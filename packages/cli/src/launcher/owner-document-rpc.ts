import { createHmac, timingSafeEqual } from 'node:crypto'

import type { CordisXJsonValue } from '../contracts.js'
import type { CordisXOwnerDocumentLoadResultV1, CordisXOwnerDocumentReplaceResultV1 } from '../durable-document-contracts.js'
import { OwnerDocumentStore, type OwnerDocumentIdentity } from './owner-document-store.js'

export const OWNER_DOCUMENT_BINDING = '__cordisxOwnerDocumentRequestV1'
export const OWNER_DOCUMENT_RECEIVER = '__cordisxOwnerDocumentReceiveV1'
export const MAX_OWNER_DOCUMENT_REQUEST_BYTES = 1_048_576
export const MAX_OWNER_DOCUMENT_REQUESTS = 64

export interface OwnerDocumentPrincipal {
  readonly profileId: string
  readonly generation: string
  readonly moduleGeneration: string
  readonly identity: OwnerDocumentIdentity
}

export interface OwnerDocumentPrincipalBinding extends OwnerDocumentIdentity {
  readonly moduleGeneration: string
  readonly token: string
}

export interface OwnerDocumentLease extends OwnerDocumentIdentity { readonly moduleGeneration: string }

/** Host lifecycle fence. Stable launcher plugins and package activation leases are distinct. */
export class OwnerDocumentLeaseRegistry {
  private readonly stable = new Map<string, string>()
  private current = new Map<string, OwnerDocumentLease>()
  private readonly previous = new Map<string, Map<string, OwnerDocumentLease>>()

  constructor(input: { readonly stable?: readonly OwnerDocumentIdentity[]; readonly active?: readonly OwnerDocumentLease[] } = {}) {
    for (const identity of input.stable ?? []) this.stable.set(identity.pluginId, identity.source)
    this.current = new Map((input.active ?? []).map(lease => [lease.pluginId, lease]))
  }

  allowed(principal: OwnerDocumentPrincipal): boolean {
    if (this.stable.get(principal.identity.pluginId) === principal.identity.source) return true
    const lease = this.current.get(principal.identity.pluginId)
    return lease?.source === principal.identity.source && lease.moduleGeneration === principal.moduleGeneration
  }

  source(pluginId: string): string | undefined { return this.current.get(pluginId)?.source ?? this.stable.get(pluginId) }

  stage(transactionId: string, leases: readonly OwnerDocumentLease[]): void {
    if (this.previous.has(transactionId)) throw new Error('owner document lease transaction already exists')
    this.previous.set(transactionId, new Map(this.current))
    this.current = new Map(leases.map(lease => [lease.pluginId, lease]))
  }

  commit(transactionId: string): void { this.previous.delete(transactionId) }
  abort(transactionId: string): void {
    const previous = this.previous.get(transactionId); if (previous === undefined) return
    this.current = previous; this.previous.delete(transactionId)
  }
}

interface RequestBase {
  readonly version: 1
  readonly requestId: string
  readonly token: string
  readonly operation: 'load' | 'replace'
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
  } finally { seen.delete(value) }
}

function principalPayload(principal: OwnerDocumentPrincipal): string {
  return Buffer.from(JSON.stringify({
    v: 1, profileId: principal.profileId, generation: principal.generation,
    moduleGeneration: principal.moduleGeneration, source: principal.identity.source, pluginId: principal.identity.pluginId,
  }), 'utf8').toString('base64url')
}

export function issueOwnerDocumentPrincipalToken(secret: string, principal: OwnerDocumentPrincipal): string {
  const payload = principalPayload(principal)
  const signature = createHmac('sha256', secret).update('cordisx.owner-documents.principal/v1\0').update(payload).digest('base64url')
  return `${payload}.${signature}`
}

function verifyPrincipalToken(secret: string, token: string): OwnerDocumentPrincipal | undefined {
  const parts = token.split('.')
  if (parts.length !== 2) return undefined
  const [payload, signature] = parts as [string, string]
  const expected = createHmac('sha256', secret).update('cordisx.owner-documents.principal/v1\0').update(payload).digest()
  let actual: Buffer
  try { actual = Buffer.from(signature, 'base64url') } catch { return undefined }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined
  try {
    const value = record(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')), 'owner document principal')
    exactKeys(value, ['v', 'profileId', 'generation', 'moduleGeneration', 'source', 'pluginId'], 'owner document principal')
    if (value.v !== 1 || typeof value.profileId !== 'string' || typeof value.generation !== 'string'
      || typeof value.moduleGeneration !== 'string' || typeof value.source !== 'string' || typeof value.pluginId !== 'string') return undefined
    return { profileId: value.profileId, generation: value.generation, moduleGeneration: value.moduleGeneration, identity: { source: value.source, pluginId: value.pluginId } }
  } catch { return undefined }
}

export function parseOwnerDocumentBindingRequest(value: unknown): OwnerDocumentBindingRequest {
  const request = record(value, 'owner document request')
  exactKeys(request, ['version', 'requestId', 'token', 'operation', 'documentId', 'expectedRevision', 'schemaVersion', 'value'], 'owner document request')
  if (request.version !== 1) throw new Error('owner document request version is invalid')
  if (typeof request.token !== 'string' || request.token.length < 32 || request.token.length > 8192) throw new Error('owner document request token is invalid')
  if (request.operation !== 'load' && request.operation !== 'replace') throw new Error('owner document operation is invalid')
  if (typeof request.requestId !== 'string' || !/^[A-Za-z0-9-]{1,96}$/u.test(request.requestId)) throw new Error('owner document requestId is invalid')
  if (typeof request.documentId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(request.documentId)) throw new Error('owner document documentId is invalid')
  const base: RequestBase = { version: 1, requestId: request.requestId, token: request.token, operation: request.operation, documentId: request.documentId }
  if (request.operation === 'load') return base
  if (!Number.isSafeInteger(request.expectedRevision) || (request.expectedRevision as number) < 0) throw new Error('owner document expectedRevision is invalid')
  if (!Number.isSafeInteger(request.schemaVersion) || (request.schemaVersion as number) < 1) throw new Error('owner document schemaVersion is invalid')
  if (!Object.hasOwn(request, 'value')) throw new Error('owner document replacement requires value')
  return { ...base, expectedRevision: request.expectedRevision as number, schemaVersion: request.schemaVersion as number, value: jsonValue(request.value, 'owner document value') }
}

export interface OwnerDocumentBridgeHandler {
  issue(identity: OwnerDocumentIdentity, moduleGeneration: string): OwnerDocumentPrincipalBinding
  load(request: OwnerDocumentBindingRequest): Promise<CordisXOwnerDocumentLoadResultV1>
  replace(request: OwnerDocumentBindingRequest): Promise<CordisXOwnerDocumentReplaceResultV1>
}

export function createOwnerDocumentBridgeHandler(input: {
  readonly secret: string
  readonly profileId: string
  readonly generation: string
  readonly store: OwnerDocumentStore
  /** Synchronous Host principal lease check, repeated at commit. */
  readonly principalAllowed: (principal: OwnerDocumentPrincipal) => boolean
}): OwnerDocumentBridgeHandler {
  let activeRequests = 0
  const bounded = async <Value>(operation: () => Promise<Value>): Promise<Value> => {
    if (activeRequests >= MAX_OWNER_DOCUMENT_REQUESTS) throw new Error('owner document authority request limit reached')
    activeRequests += 1
    try { return await operation() } finally { activeRequests -= 1 }
  }
  const resolve = (request: OwnerDocumentBindingRequest): OwnerDocumentPrincipal | undefined => {
    const principal = verifyPrincipalToken(input.secret, request.token)
    if (principal === undefined || principal.profileId !== input.profileId || principal.generation !== input.generation) return undefined
    if (!input.principalAllowed(principal)) return undefined
    return principal
  }
  return {
    issue(identity, moduleGeneration) {
      const principal = { profileId: input.profileId, generation: input.generation, moduleGeneration, identity }
      return { ...identity, moduleGeneration, token: issueOwnerDocumentPrincipalToken(input.secret, principal) }
    },
    async load(request) {
      return await bounded(async () => {
        const principal = resolve(request)
        if (principal === undefined) return stale()
        return await input.store.load({ profileId: principal.profileId, identity: principal.identity }, request.documentId)
      })
    },
    async replace(request) {
      return await bounded(async () => {
        const principal = resolve(request)
        if (principal === undefined) return stale()
        return await input.store.replace({
          scope: { profileId: principal.profileId, identity: principal.identity }, documentId: request.documentId,
          expectedRevision: request.expectedRevision!, schemaVersion: request.schemaVersion!, value: request.value,
          commitAllowed: () => resolve(request) !== undefined,
        })
      })
    },
  }
}

function stale(): Extract<CordisXOwnerDocumentLoadResultV1, { readonly status: 'unavailable' }> {
  return { status: 'unavailable', code: 'stale-generation', diagnostic: 'plugin owner is stale', recoverable: true }
}

export function ownerDocumentBridgeError(): Extract<CordisXOwnerDocumentLoadResultV1, { readonly status: 'unavailable' }> {
  return { status: 'unavailable', code: 'host-unavailable', diagnostic: 'owner document request was rejected', recoverable: true }
}
