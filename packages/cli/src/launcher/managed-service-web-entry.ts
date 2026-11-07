import type { ManagedServiceWebEntryUnavailableCodeV1 } from '@cordisx/protocol/managed-service-web-entry/v1'
import type {
  ManagedServiceWebEntryProofV1,
  ManagedServiceWebEntrySourceResultV1,
  ManagedServiceWebEntrySourceV1,
} from '@cordisx/protocol/managed-service-web-entry-runtime/v1'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { ManagedServiceRecord } from './managed-service-runtime-record.js'
import { managedBindingCurrent } from './managed-service-runtime-support.js'
import {
  createManagedServiceConsoleBroker,
  type ManagedServiceConsoleBroker,
} from './managed-service-console-broker.js'
import { readWebEntryJSON } from './managed-service-web-entry-http.js'

const SCHEMAS = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/'
const SOURCE_RESULT = `${SCHEMAS}managed-service-web-entry-source-result.v1.schema.json`
const CHALLENGE = `${SCHEMAS}managed-service-web-entry-challenge.v1.schema.json`
const PROOF = `${SCHEMAS}managed-service-web-entry-proof.v1.schema.json`
const LOCAL_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/u

export type ManagedServiceWebEntryValue =
  | { readonly status: 'available'; readonly origin: `http://${string}` | `https://${string}` }
  | { readonly status: 'unavailable'; readonly code: ManagedServiceWebEntryUnavailableCodeV1 }

/** Host-private source authority; never passed into a plugin or renderer. */
export interface ManagedServiceWebEntryReader {
  readonly serviceGeneration: string
  readonly timeoutMs: number
  readonly authenticatedConsole?: ManagedServiceConsoleBroker
  read(serviceGeneration: string, signal: AbortSignal): Promise<ManagedServiceWebEntryValue>
}

function exact(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (
    value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !fields.includes(key))
  ) throw new Error('invalid web entry declaration')
}

/** URL syntax is necessary but never establishes endpoint ownership. */
export function canonicalManagedServiceWebOrigin(value: unknown): `http://${string}` | `https://${string}` {
  if (
    typeof value !== 'string' || value.length > 128
    || !/^https?:\/\/(?:127\.0\.0\.1|\[::1\])(?::[1-9][0-9]{0,4})?$/u.test(value)
  ) {
    throw new Error('invalid web entry origin')
  }
  const url = new URL(value)
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  if (url.origin !== value || port < 1 || port > 65535) throw new Error('invalid web entry origin')
  return value as `http://${string}` | `https://${string}`
}

function admittedSource(record: ManagedServiceRecord, value: unknown): ManagedServiceWebEntrySourceV1 {
  exact(value, ['contract', 'serviceId', 'operationId', 'verification'])
  if (
    value.contract !== 'cordisx.managed-service-web-entry-source/v1'
    || value.serviceId !== record.definition.serviceId
    || typeof value.operationId !== 'string' || !LOCAL_ID.test(value.operationId)
  ) {
    throw new Error('invalid web entry declaration')
  }
  if (value.verification !== undefined) {
    exact(value.verification, ['kind', 'path'])
    if (
      value.verification.kind !== 'shared-instance-hmac-sha256'
      || typeof value.verification.path !== 'string' || value.verification.path.length > 256
      || !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/u.test(value.verification.path)
    ) {
      throw new Error('invalid web entry verification')
    }
  }
  const operation = record.definition.operations.find(item => item.operationId === value.operationId)
  if (
    !operation || operation.method !== 'GET' || operation.requestEncoding !== 'query'
    || operation.responseSchema !== SOURCE_RESULT
    || (operation.requestSchema !== undefined && operation.requestSchema !== CHALLENGE)
    || (operation.httpAuthentication ?? record.definition.httpAuthentication).mode !== 'authorization-header'
  ) {
    throw new Error('web entry requires a declared authenticated query operation')
  }
  // Copy once: mutation of an imported module's export cannot change its admitted authority.
  return Object.freeze({
    contract: 'cordisx.managed-service-web-entry-source/v1',
    serviceId: record.definition.serviceId,
    operationId: operation.operationId,
    ...(value.verification === undefined ? {} : {
      verification: Object.freeze({
        kind: 'shared-instance-hmac-sha256' as const,
        path: (value.verification as { path: `/${string}` }).path,
      }),
    }),
  })
}

export function createManagedServiceWebEntryReader(input: {
  readonly record: ManagedServiceRecord
  readonly declaration: unknown
  readonly consoleDeclaration?: unknown
  readonly signal: AbortSignal
  readonly current: () => boolean
  readonly endpointOwned: (origin: string) => boolean
  readonly subscribe: (listener: () => void) => () => void
  readonly fetch: typeof globalThis.fetch
}): ManagedServiceWebEntryReader {
  const { record } = input
  const source = admittedSource(record, input.declaration)
  const operation = record.definition.operations.find(item => item.operationId === source.operationId)!
  const entry: ManagedServiceWebEntryReader = {
    get serviceGeneration() {
      return record.binding.serviceGeneration
    },
    timeoutMs: operation.timeoutMs,
    async read(serviceGeneration: string, signal: AbortSignal) {
      const binding = record.binding
      const origin = record.origin
      const brokerHandle = record.brokerHandle
      const processOwnership = record.processOwnership
      const child = record.child
      const unavailable = (code: ManagedServiceWebEntryUnavailableCodeV1): ManagedServiceWebEntryValue => ({
        status: 'unavailable',
        code,
      })
      const invalid = (): ManagedServiceWebEntryUnavailableCodeV1 | undefined => {
        if (record.disposed || record.lifecycle.signal.aborted) return 'disposed'
        if (input.signal.aborted || !input.current()) return 'owner-unavailable'
        if (
          binding.serviceGeneration !== serviceGeneration
          || !managedBindingCurrent(binding, record.binding, record.disposed)
        ) return 'stale-generation'
        if (
          (record.state !== 'ready' && record.state !== 'authentication-required')
          || record.health === 'unhealthy' || record.health === 'stopped'
          || origin === undefined || brokerHandle === undefined
          || record.origin !== origin || record.brokerHandle !== brokerHandle
        ) return 'service-unavailable'
        if (
          !input.endpointOwned(origin) || record.processOwnership !== processOwnership
          || (processOwnership !== 'host-owned' && processOwnership !== 'borrowed')
        ) return 'ownership-unverified'
        if (
          record.child !== child || (processOwnership === 'host-owned'
            && (!child || child.exitCode !== null || child.signalCode !== null))
        ) return 'service-unavailable'
        return undefined
      }
      const initial = invalid()
      if (initial) return unavailable(initial)
      if (signal.aborted) return unavailable('cancelled')
      const lifecycle = new AbortController()
      let timedOut = false
      const timeout = setTimeout(() => {
        timedOut = true
        lifecycle.abort()
      }, operation.timeoutMs)
      const active = AbortSignal.any([signal, input.signal, record.lifecycle.signal, lifecycle.signal])
      const stop = input.subscribe(() => {
        if (invalid()) lifecycle.abort()
      })
      const check = () => {
        active.throwIfAborted()
        if (invalid()) throw new Error('web entry authority changed')
      }
      let failureCode: ManagedServiceWebEntryUnavailableCodeV1 = 'invalid-source'
      const perform = async (): Promise<ManagedServiceWebEntryValue> => {
        check()
        const challenge = { challenge: randomBytes(32).toString('hex') }
        if (operation.requestSchema) {
          await record.schemas.validate(operation.requestSchema, challenge)
          check()
        }
        const authentication = operation.httpAuthentication ?? record.definition.httpAuthentication
        if (authentication.mode !== 'authorization-header') return unavailable('invalid-source')
        const secret = record.secrets.get(authentication.slot)
        if (secret === undefined) return unavailable('service-unavailable')
        const url = new URL(operation.path, origin)
        if (url.origin !== origin || url.search !== '' || url.hash !== '') return unavailable('invalid-source')
        url.searchParams.set('challenge', challenge.challenge)
        const parsed = await readWebEntryJSON(input.fetch, url, active, {
          Authorization: `${authentication.scheme} ${secret}`,
        })
        check()
        await record.schemas.validate(SOURCE_RESULT, parsed)
        check()
        const result = parsed as ManagedServiceWebEntrySourceResultV1
        if (result.status === 'unavailable') return unavailable('service-unavailable')
        const candidate = canonicalManagedServiceWebOrigin(result.origin)
        if (candidate === origin) return { status: 'available', origin: candidate }
        failureCode = 'ownership-unverified'
        if (!source.verification || !result.verification) return unavailable('ownership-unverified')
        const proofURL = new URL(source.verification.path, candidate)
        proofURL.searchParams.set('challenge', challenge.challenge)
        const proofValue = await readWebEntryJSON(input.fetch, proofURL, active)
        check()
        await record.schemas.validate(PROOF, proofValue)
        check()
        const proof = proofValue as ManagedServiceWebEntryProofV1
        if (
          proof.instance !== result.verification.instance
          || !timingSafeEqual(Buffer.from(proof.proof, 'hex'), Buffer.from(result.verification.proof, 'hex'))
        ) {
          return unavailable('ownership-unverified')
        }
        return { status: 'available', origin: candidate }
      }
      try {
        // Cancellation/deadline also bounds a misbehaving fetch or schema adapter.
        const value = await new Promise<ManagedServiceWebEntryValue>((resolve, reject) => {
          const abort = () => reject(new Error('web entry cancelled'))
          active.addEventListener('abort', abort, { once: true })
          void perform().then(resolve, reject).finally(() => active.removeEventListener('abort', abort))
          if (active.aborted) abort()
        })
        check()
        return value
      } catch {
        return unavailable(
          invalid() ?? (signal.aborted ? 'cancelled' : timedOut
            ? 'timeout'
            : failureCode),
        )
      } finally {
        clearTimeout(timeout)
        stop()
        lifecycle.abort()
      }
    },
  }
  if (input.consoleDeclaration === undefined) return Object.freeze(entry)
  const authenticatedConsole = createManagedServiceConsoleBroker({
    ...input,
    declaration: input.consoleDeclaration,
    ownerSignal: input.signal,
    entry,
  })
  return Object.freeze({
    get serviceGeneration() {
      return entry.serviceGeneration
    },
    timeoutMs: entry.timeoutMs,
    read: entry.read,
    authenticatedConsole,
  })
}
