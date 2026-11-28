import { createPublicKey, type JsonWebKey, type KeyObject, verify } from 'node:crypto'
import {
  type CordisXPersistedPermissionPolicyRecord,
  isPermissionPolicyRecordV2,
  isPermissionPolicyRecordV3,
  normalizePersistedPermissionPolicyRecord,
  persistedPermissionRecordKey,
} from '../permission-persistence.js'
import {
  normalizeStandaloneOncePermissionProofPayload,
  normalizeStandalonePermissionProofPayload,
  standaloneOncePermissionProofBytes,
  standalonePermissionProofBytes,
} from '../standalone-permission-proof.js'
import type { ManagerRendererChannelContext } from './manager-renderer-sessions.js'
import { nativeRuntimeOnceProofBytes, normalizeNativeRuntimeOnceProof } from '../native-runtime-once-proof.js'
import { normalizeRuntimePolicyProof, runtimePolicyProofBytes } from '../runtime-policy-proof.js'

type Entry = {
  readonly signal: AbortSignal
  readonly key: KeyObject
  readonly used: Set<string>
  readonly onAbort: () => void
}

function publicKey(value: unknown): KeyObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('permission-proof-key-invalid')
  const item = value as Record<string, unknown>
  if (
    Object.keys(item).length !== 4 || Object.keys(item).some(key => !['kty', 'crv', 'x', 'y'].includes(key))
    || item.kty !== 'EC' || item.crv !== 'P-256'
    || typeof item.x !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(item.x)
    || typeof item.y !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(item.y)
    || Buffer.from(item.x, 'base64url').length !== 32 || Buffer.from(item.y, 'base64url').length !== 32
  ) throw new Error('permission-proof-key-invalid')
  return createPublicKey({ key: item as JsonWebKey, format: 'jwk' })
}

/** Owner-private verifier for one pre-plugin key per authenticated Manager document. */
export class ManagerPermissionProofAuthority {
  private readonly entries = new Map<string, Entry>()
  private closed = false

  constructor(
    private readonly input: {
      readonly profileId: string
      readonly generation: string
      readonly isCurrent: (context: ManagerRendererChannelContext) => boolean
      readonly target?: 'standalone' | 'native'
      readonly now?: () => number
    },
  ) {}

  private current(context: ManagerRendererChannelContext): boolean {
    try {
      return !this.closed && !context.signal.aborted && context.profileId === this.input.profileId
        && context.ownerGeneration === this.input.generation && this.input.isCurrent(context) === true
    } catch {
      return false
    }
  }

  /** Registration is single-use and must finish before renderer admission. */
  register(context: ManagerRendererChannelContext, key: unknown): void {
    if (!this.current(context) || context.admitted === true || this.entries.has(context.rendererId)) {
      throw new Error('permission-proof-unavailable')
    }
    const parsed = publicKey(key)
    const onAbort = () => this.retire(context.rendererId, entry)
    const entry: Entry = { signal: context.signal, key: parsed, used: new Set(), onAbort }
    this.entries.set(context.rendererId, entry)
    context.signal.addEventListener('abort', onAbort, { once: true })
    if (!this.current(context)) {
      this.retire(context.rendererId, entry)
      throw new Error('permission-proof-unavailable')
    }
  }

  authorize(input: {
    readonly context: ManagerRendererChannelContext
    readonly requestId: string
    readonly records: readonly CordisXPersistedPermissionPolicyRecord[]
    readonly expected: readonly CordisXPersistedPermissionPolicyRecord[]
    readonly moduleGeneration: string
    readonly artifact: { readonly version: string; readonly integrity: `sha256:${string}` }
    readonly proof: unknown
  }): boolean {
    try {
      const { context } = input
      const entry = this.entries.get(context.rendererId)
      if (
        !entry || entry.signal !== context.signal || context.admitted !== true || !this.current(context)
        || input.records.length !== 1 || input.expected.length > 4096 || entry.used.size >= 4096
        || !input.proof || typeof input.proof !== 'object' || Array.isArray(input.proof)
      ) return false
      const proof = input.proof as Record<string, unknown>
      if (
        Object.keys(proof).length !== 2 || Object.keys(proof).some(key => !['payload', 'signature'].includes(key))
        || typeof proof.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/u.test(proof.signature)
      ) return false
      const signature = Buffer.from(proof.signature, 'base64url')
      if (signature.length !== 64 || signature.toString('base64url') !== proof.signature) return false
      const record = normalizePersistedPermissionPolicyRecord(input.records[0])
      const now = (this.input.now ?? Date.now)()
      if (isPermissionPolicyRecordV2(record)) {
        const target = this.input.target ?? 'standalone'
        const payload = normalizeRuntimePolicyProof(proof.payload, target)
        if (
          payload.rendererId !== context.rendererId || payload.profileId !== context.profileId
          || payload.ownerGeneration !== context.ownerGeneration || payload.moduleGeneration !== input.moduleGeneration
          || JSON.stringify(payload.artifact) !== JSON.stringify(input.artifact)
          || payload.requestId !== input.requestId
          || entry.used.has(payload.decisionId) || !Number.isSafeInteger(now)
          || payload.issuedAt > now + 5_000 || now - payload.issuedAt > 60_000
          || JSON.stringify(record) !== JSON.stringify(payload.record)
        ) return false
        const key = persistedPermissionRecordKey(payload.record)
        const prior = input.expected.filter(item =>
          isPermissionPolicyRecordV2(item) && persistedPermissionRecordKey(item) === key
        )
        if (prior.length > 1 || (prior[0]?.policy ?? 'ask') !== payload.observed) return false
        if (
          !verify('sha256', runtimePolicyProofBytes(payload, target), {
            key: entry.key,
            dsaEncoding: 'ieee-p1363',
          }, signature)
        ) return false
        if (!this.current(context) || this.entries.get(context.rendererId) !== entry) return false
        entry.used.add(payload.decisionId)
        return true
      }
      const payload = normalizeStandalonePermissionProofPayload(proof.payload, this.input.target)
      if (
        payload.rendererId !== context.rendererId || payload.profileId !== context.profileId
        || payload.ownerGeneration !== context.ownerGeneration || payload.moduleGeneration !== input.moduleGeneration
        || JSON.stringify(payload.artifact) !== JSON.stringify(input.artifact)
        || payload.requestId !== input.requestId || entry.used.has(payload.decisionId)
        || !Number.isSafeInteger(now) || payload.issuedAt > now + 5_000 || now - payload.issuedAt > 60_000
        || JSON.stringify(record) !== JSON.stringify(payload.record)
      ) return false
      const key = persistedPermissionRecordKey(payload.record)
      const prior = input.expected.filter(item =>
        isPermissionPolicyRecordV3(item) && persistedPermissionRecordKey(item) === key
      )
      if (prior.length > 1 || (prior[0]?.policy ?? 'ask') !== payload.observed) return false
      if (
        !verify(
          'sha256',
          standalonePermissionProofBytes(payload, this.input.target),
          { key: entry.key, dsaEncoding: 'ieee-p1363' },
          signature,
        )
      ) {
        return false
      }
      if (!this.current(context) || this.entries.get(context.rendererId) !== entry) return false
      entry.used.add(payload.decisionId)
      return true
    } catch {
      return false
    }
  }

  authorizeOnce(input: {
    readonly context: ManagerRendererChannelContext
    readonly requestId: string
    readonly record: CordisXPersistedPermissionPolicyRecord
    readonly decision: 'allow-once' | 'deny-once'
    readonly expected: readonly CordisXPersistedPermissionPolicyRecord[]
    readonly moduleGeneration: string
    readonly artifact: { readonly version: string; readonly integrity: `sha256:${string}` }
    readonly proof: unknown
  }): boolean {
    try {
      const { context } = input
      const entry = this.entries.get(context.rendererId)
      if (
        !entry || entry.signal !== context.signal || context.admitted !== true || !this.current(context)
        || input.expected.length > 4096 || entry.used.size >= 4096
        || !input.proof || typeof input.proof !== 'object' || Array.isArray(input.proof)
      ) return false
      const proof = input.proof as Record<string, unknown>
      if (
        Object.keys(proof).length !== 2 || Object.keys(proof).some(key => !['payload', 'signature'].includes(key))
        || typeof proof.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/u.test(proof.signature)
      ) return false
      const signature = Buffer.from(proof.signature, 'base64url')
      if (signature.length !== 64 || signature.toString('base64url') !== proof.signature) return false
      const payload = normalizeStandaloneOncePermissionProofPayload(proof.payload, this.input.target)
      const record = normalizePersistedPermissionPolicyRecord(input.record)
      const now = (this.input.now ?? Date.now)()
      if (
        payload.rendererId !== context.rendererId || payload.profileId !== context.profileId
        || payload.ownerGeneration !== context.ownerGeneration || payload.moduleGeneration !== input.moduleGeneration
        || JSON.stringify(payload.artifact) !== JSON.stringify(input.artifact)
        || payload.requestId !== input.requestId || payload.decision !== input.decision
        || entry.used.has(payload.decisionId)
        || !Number.isSafeInteger(now) || payload.issuedAt > now + 5_000 || now - payload.issuedAt > 60_000
        || JSON.stringify(record) !== JSON.stringify(payload.record)
      ) return false
      const key = persistedPermissionRecordKey(payload.record)
      const prior = input.expected.filter(item =>
        isPermissionPolicyRecordV3(item) && persistedPermissionRecordKey(item) === key
      )
      if (prior.length > 1 || (prior[0]?.policy ?? 'ask') !== 'ask') return false
      if (
        !verify('sha256', standaloneOncePermissionProofBytes(payload, this.input.target), {
          key: entry.key,
          dsaEncoding: 'ieee-p1363',
        }, signature)
      ) return false
      if (!this.current(context) || this.entries.get(context.rendererId) !== entry) return false
      entry.used.add(payload.decisionId)
      return true
    } catch {
      return false
    }
  }

  authorizeRuntimeOnce(input: {
    readonly context: ManagerRendererChannelContext
    readonly requestId: string
    readonly record: CordisXPersistedPermissionPolicyRecord
    readonly decision: 'allow-once' | 'deny-once'
    readonly expected: readonly CordisXPersistedPermissionPolicyRecord[]
    readonly moduleGeneration: string
    readonly proof: unknown
  }): boolean {
    try {
      const { context } = input
      const entry = this.entries.get(context.rendererId)
      if (
        this.input.target !== 'native' || !entry || entry.signal !== context.signal || context.admitted !== true
        || !this.current(context) || input.expected.length > 4096 || entry.used.size >= 4096
        || !input.proof || typeof input.proof !== 'object' || Array.isArray(input.proof)
      ) return false
      const proof = input.proof as Record<string, unknown>
      if (
        Object.keys(proof).length !== 2 || Object.keys(proof).some(key => !['payload', 'signature'].includes(key))
        || typeof proof.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/u.test(proof.signature)
      ) return false
      const signature = Buffer.from(proof.signature, 'base64url')
      if (signature.length !== 64 || signature.toString('base64url') !== proof.signature) return false
      const payload = normalizeNativeRuntimeOnceProof(proof.payload)
      const record = normalizePersistedPermissionPolicyRecord(input.record)
      const now = (this.input.now ?? Date.now)()
      if (
        payload.rendererId !== context.rendererId || payload.profileId !== context.profileId
        || payload.ownerGeneration !== context.ownerGeneration || payload.moduleGeneration !== input.moduleGeneration
        || payload.requestId !== input.requestId || payload.decision !== input.decision
        || entry.used.has(payload.decisionId) || !Number.isSafeInteger(now)
        || payload.issuedAt > now + 5_000 || now - payload.issuedAt > 60_000
        || JSON.stringify(record) !== JSON.stringify(payload.record)
      ) return false
      const key = persistedPermissionRecordKey(payload.record)
      const prior = input.expected.filter(item =>
        isPermissionPolicyRecordV2(item) && persistedPermissionRecordKey(item) === key
      )
      if (prior.length > 1 || (prior[0]?.policy ?? 'ask') !== payload.observed) return false
      if (
        !verify(
          'sha256',
          nativeRuntimeOnceProofBytes(payload),
          { key: entry.key, dsaEncoding: 'ieee-p1363' },
          signature,
        )
      ) return false
      if (!this.current(context) || this.entries.get(context.rendererId) !== entry) return false
      entry.used.add(payload.decisionId)
      return true
    } catch {
      return false
    }
  }

  private retire(rendererId: string, entry: Entry): void {
    if (this.entries.get(rendererId) !== entry) return
    this.entries.delete(rendererId)
    entry.signal.removeEventListener('abort', entry.onAbort)
    entry.used.clear()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const [rendererId, entry] of this.entries) this.retire(rendererId, entry)
  }
}
