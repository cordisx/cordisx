import type { ManagedServiceConsoleUnavailableV1 } from '@cordisx/protocol/managed-service-console/v1'
import type {
  ManagedServiceBrowserConsoleRequestV1,
  ManagedServiceBrowserConsoleResultV1,
} from '@cordisx/protocol/managed-service-console-runtime/v1'
import { randomBytes } from 'node:crypto'
import type { ManagedServiceRecord } from './managed-service-runtime-record.js'
import { managedBindingCurrent } from './managed-service-runtime-support.js'
import { waitForStartupOperation } from './managed-service-startup-operation.js'
import { readWebEntryJSON } from './managed-service-web-entry-http.js'
import type { ManagedServiceWebEntryReader } from './managed-service-web-entry.js'

const SCHEMAS = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/'
const REQUEST = SCHEMAS + 'managed-service-browser-console-request.v1.schema.json'
export const MANAGED_BROWSER_CONSOLE_RESULT_SCHEMA = SCHEMAS + 'managed-service-browser-console-result.v1.schema.json'
const FIXED_PATH = /^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/u
const TICKET = /^[A-Za-z0-9_-]{32}$/u

export interface ManagedBrowserConsoleRoute {
  readonly origin: `http://${string}` | `https://${string}`
  dispose(): void
}

export interface ManagedBrowserConsoleBoundary {
  open(input: {
    readonly service: string
    readonly generation: string
    readonly upstream: string
    readonly redeemPath: string
    readonly signal: AbortSignal
    readonly verify: (signal: AbortSignal) => Promise<boolean>
  }): ManagedBrowserConsoleRoute | undefined
}

export interface ManagedServiceBrowserConsoleBroker {
  read(
    serviceGeneration: string,
    signal: AbortSignal,
    boundary: ManagedBrowserConsoleBoundary,
  ): Promise<
    | ManagedServiceConsoleUnavailableV1
    | { readonly status: 'available'; readonly route: ManagedBrowserConsoleRoute; readonly url: string }
  >
}

const unavailable = (reason: ManagedServiceConsoleUnavailableV1['reason']): ManagedServiceConsoleUnavailableV1 => ({
  status: 'unavailable',
  reason,
})

/** Only the admitted managed service may mint a ticket. The renderer never selects the destination or transport. */
export function createManagedServiceBrowserConsoleBroker(input: {
  readonly record: ManagedServiceRecord
  readonly declaration: unknown
  readonly entry: ManagedServiceWebEntryReader
  readonly ownerSignal: AbortSignal
  readonly current: () => boolean
  readonly endpointOwned: (origin: string) => boolean
  readonly fetch: typeof globalThis.fetch
}): ManagedServiceBrowserConsoleBroker {
  const { record } = input
  const source = input.declaration
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('Invalid managed browser console declaration')
  }
  const { contract, serviceId, operationId, redeemPath } = source as Record<string, unknown>
  const operation = record.definition.operations.find(item => item.operationId === operationId)
  const authentication = operation?.httpAuthentication ?? record.definition.httpAuthentication
  if (
    Object.keys(source).length !== 4 || contract !== 'cordisx.managed-service-browser-console-source/v1'
    || serviceId !== record.definition.serviceId || typeof redeemPath !== 'string' || redeemPath.length > 256
    || !FIXED_PATH.test(redeemPath) || !operation || operation.method !== 'POST'
    || operation.requestEncoding === 'query'
    || operation.requestSchema !== REQUEST || operation.responseSchema !== MANAGED_BROWSER_CONSOLE_RESULT_SCHEMA
    || authentication.mode !== 'authorization-header'
  ) throw new Error('Invalid managed browser console declaration')

  return Object.freeze({
    async read(serviceGeneration: string, signal: AbortSignal, boundary: ManagedBrowserConsoleBoundary) {
      const binding = record.binding
      const backend = record.origin
      const child = record.child
      const brokerHandle = record.brokerHandle
      const secret = record.secrets.get(authentication.slot)
      const lifetime = AbortSignal.any([signal, input.ownerSignal, record.lifecycle.signal])
      const invalid = () => {
        if (signal.aborted) return 'cancelled'
        if (input.ownerSignal.aborted || !input.current()) return 'owner-unavailable'
        if (
          binding.serviceGeneration !== serviceGeneration
          || !managedBindingCurrent(binding, record.binding, record.disposed)
        ) {
          return 'stale-generation'
        }
        if (
          lifetime.aborted || !backend || !child || record.child !== child || child.exitCode !== null
          || child.signalCode !== null
          || record.processOwnership !== 'host-owned' || record.origin !== backend || !brokerHandle
          || record.brokerHandle !== brokerHandle
          || (record.state !== 'ready' && record.state !== 'authentication-required')
          || record.health === 'unhealthy' || record.health === 'stopped' || !input.endpointOwned(backend)
        ) return 'failed'
        return undefined
      }
      const initial = invalid()
      if (initial) return unavailable(initial)
      if (secret === undefined) return unavailable('failed')
      const destination = new URL(operation.path, backend)
      if (destination.origin !== backend || destination.search || destination.hash) return unavailable('failed')

      const active = AbortSignal.any([lifetime, AbortSignal.timeout(operation.timeoutMs)])
      let route: ManagedBrowserConsoleRoute | undefined
      let handedOff = false
      const check = () => {
        active.throwIfAborted()
        if (invalid()) throw new Error('Managed browser console authority changed')
      }
      try {
        const web = await input.entry.read(serviceGeneration, active)
        check()
        if (web.status !== 'available') return unavailable('failed')
        route = boundary.open({
          service: JSON.stringify([binding.identity.source, binding.identity.pluginId, binding.identity.serviceId]),
          generation: serviceGeneration,
          upstream: web.origin,
          redeemPath,
          signal: lifetime,
          verify: async requestSignal => {
            if (invalid()) return false
            const proof = await input.entry.read(serviceGeneration, AbortSignal.any([lifetime, requestSignal]))
            return proof.status === 'available' && proof.origin === web.origin && !invalid()
          },
        })
        if (!route) return unavailable('unsupported')
        const url = new URL(redeemPath, route.origin)
        if (url.origin !== route.origin || url.search || url.hash) return unavailable('failed')
        const payload: ManagedServiceBrowserConsoleRequestV1 = {
          binding: randomBytes(32).toString('hex'),
          origin: web.origin,
        }
        await waitForStartupOperation(record.schemas.validate(REQUEST, payload), active)
        check()
        const value = await readWebEntryJSON(input.fetch, destination, active, {
          Authorization: authentication.scheme + ' ' + secret,
          'Content-Type': 'application/json',
        }, payload)
        check()
        await waitForStartupOperation(record.schemas.validate(MANAGED_BROWSER_CONSOLE_RESULT_SCHEMA, value), active)
        check()
        const result = value as ManagedServiceBrowserConsoleResultV1
        if (result.status === 'sign-in-required') return unavailable('sign-in-required')
        if (result.status !== 'issued' || !TICKET.test(result.ticket)) return unavailable('failed')
        url.searchParams.set('ticket', result.ticket)
        handedOff = true
        return { status: 'available', route, url: url.href } as const
      } catch {
        return unavailable(invalid() ?? 'failed')
      } finally {
        if (!handedOff) route?.dispose()
      }
    },
  })
}
