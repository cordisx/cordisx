import { randomBytes } from 'node:crypto'
import type { ManagedServiceRecord } from './managed-service-runtime-record.js'
import { readWebEntryJSON } from './managed-service-web-entry-http.js'
import type { ManagedServiceWebEntryReader } from './managed-service-web-entry.js'

const SCHEMAS = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/'
const REQUEST = SCHEMAS + 'managed-service-console-request.v1.schema.json'
export const MANAGED_CONSOLE_RESULT_SCHEMA = SCHEMAS + 'managed-service-console-result.v1.schema.json'

interface ConsoleCookie {
  readonly name: string
  readonly value: string
  readonly expirationDate: number
}

export type ManagedConsolePreparation =
  | { readonly status: 'sign-in-required' | 'unavailable' }
  | {
    readonly status: 'prepared'
    readonly origin: string
    readonly url: string
    readonly cookie: ConsoleCookie
    readonly lifetime: AbortSignal
    revoke(): Promise<void>
  }

export interface ManagedServiceConsoleBroker {
  prepare(serviceGeneration: string, signal: AbortSignal): Promise<ManagedConsolePreparation>
}

/** Never bridge this broker or its result to the renderer. */
export function createManagedServiceConsoleBroker(input: {
  readonly record: ManagedServiceRecord
  readonly declaration: unknown
  readonly entry: ManagedServiceWebEntryReader
  readonly ownerSignal: AbortSignal
  readonly current: () => boolean
  readonly endpointOwned: (origin: string) => boolean
  readonly fetch: typeof globalThis.fetch
  readonly subscribe: (listener: () => void) => () => void
}): ManagedServiceConsoleBroker {
  const { record, entry } = input
  const declaration = input.declaration
  if (declaration === null || typeof declaration !== 'object' || Array.isArray(declaration)) {
    throw new Error('Invalid managed console declaration')
  }
  const { contract, serviceId, operationId, landingPath } = declaration as Record<string, unknown>
  const operation = record.definition.operations.find(item => item.operationId === operationId)
  const authentication = operation?.httpAuthentication ?? record.definition.httpAuthentication
  if (
    Object.keys(declaration).length !== 4 || contract !== 'cordisx.managed-service-console-source/v1'
    || serviceId !== record.definition.serviceId || typeof landingPath !== 'string' || landingPath.length > 256
    || !/^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/u.test(landingPath)
    || !operation || operation.method !== 'POST' || operation.requestEncoding === 'query'
    || operation.requestSchema !== REQUEST || operation.responseSchema !== MANAGED_CONSOLE_RESULT_SCHEMA
    || authentication.mode !== 'authorization-header'
  ) throw new Error('Invalid managed console declaration')

  return Object.freeze({
    async prepare(serviceGeneration: string, signal: AbortSignal): Promise<ManagedConsolePreparation> {
      const backend = record.origin
      const backendChild = record.child
      const brokerHandle = record.brokerHandle
      const secret = record.secrets.get(authentication.slot)
      const current = () =>
        !!backend && !!backendChild && record.processOwnership === 'host-owned' && record.child === backendChild
        && backendChild.exitCode === null && backendChild.signalCode === null && record.origin === backend
        && !!brokerHandle && record.brokerHandle === brokerHandle
        && (record.state === 'ready' || record.state === 'authentication-required')
        && record.health !== 'unhealthy' && record.health !== 'stopped'
        && !record.disposed && record.binding.serviceGeneration === serviceGeneration && input.current()
        && input.endpointOwned(backend)
      if (!backend || !secret || !current() || signal.aborted || input.ownerSignal.aborted) {
        return { status: 'unavailable' }
      }
      const active = AbortSignal.any([
        signal,
        input.ownerSignal,
        record.lifecycle.signal,
        AbortSignal.timeout(operation.timeoutMs),
      ])
      const binding = randomBytes(32).toString('hex')
      const destination = new URL(operation.path, backend)
      if (destination.origin !== backend || destination.search !== '' || destination.hash !== '') {
        return { status: 'unavailable' }
      }
      const web = await entry.read(serviceGeneration, active)
      if (web.status !== 'available' || !current() || active.aborted) return { status: 'unavailable' }
      const origin = web.origin
      const call = async (action: 'prepare' | 'revoke', operationSignal: AbortSignal) => {
        const body = { contract: 'cordisx.managed-service-console-request/v1', action, binding, origin }
        await record.schemas.validate(REQUEST, body)
        operationSignal.throwIfAborted()
        if (!current()) throw new Error('Managed console generation changed')
        const value = await readWebEntryJSON(
          input.fetch,
          destination,
          operationSignal,
          { Authorization: authentication.scheme + ' ' + secret, 'Content-Type': 'application/json' },
          body,
        )
        await record.schemas.validate(MANAGED_CONSOLE_RESULT_SCHEMA, value)
        operationSignal.throwIfAborted()
        if (!current()) throw new Error('Managed console generation changed')
        return value as { status: unknown; cookie?: { name: string; value: string; maxAgeSeconds: number } }
      }
      let revoked = false
      let stopWatching: (() => void) | undefined
      const revoke = async () => {
        if (revoked) return
        revoked = true
        stopWatching?.()
        if (current()) await call('revoke', AbortSignal.timeout(operation.timeoutMs)).catch(() => undefined)
      }
      try {
        const started = Date.now()
        const result = await call('prepare', active)
        if (result.status === 'sign-in-required') return { status: 'sign-in-required' }
        const cookie = result.cookie
        if (
          result.status !== 'prepared' || !cookie || !/^__Host-[A-Za-z0-9_-]{1,80}$/u.test(cookie.name)
          || !/^[A-Za-z0-9_-]{32,128}$/u.test(cookie.value) || !Number.isInteger(cookie.maxAgeSeconds)
          || cookie.maxAgeSeconds < 1 || cookie.maxAgeSeconds > 28_800
        ) {
          await revoke()
          return { status: 'unavailable' }
        }
        const invalidated = new AbortController()
        stopWatching = input.subscribe(() => {
          if (!current()) invalidated.abort()
        })
        const expirationDate = started / 1000 + cookie.maxAgeSeconds
        const lifetime = AbortSignal.any([
          signal,
          input.ownerSignal,
          record.lifecycle.signal,
          invalidated.signal,
          AbortSignal.timeout(Math.max(0, Math.floor(expirationDate * 1000 - Date.now()))),
        ])
        return {
          status: 'prepared',
          lifetime,
          origin,
          url: new URL(landingPath, origin).href,
          cookie: {
            name: cookie.name,
            value: cookie.value,
            expirationDate,
          },
          revoke,
        }
      } catch {
        await revoke()
        return { status: 'unavailable' }
      }
    },
  })
}
