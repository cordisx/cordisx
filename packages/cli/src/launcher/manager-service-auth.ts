import { randomBytes, randomUUID } from 'node:crypto'
import type { ManagedServiceBindingV1, ManagedServiceSnapshotResultV1 } from '@cordisx/protocol/managed-service/v1'
import {
  type ManagedServiceUIBridgeHandler,
  type ManagedServiceUIOwner,
  parseManagedServiceUIBindingRequest,
} from './managed-service-ui-rpc.js'

type Target = { readonly pluginId: string; readonly serviceId: string }
export type ManagerServiceAuthOperation =
  | { readonly kind: 'manager-service-auth'; readonly action: 'list'; readonly sessionId: string }
  | ({ readonly kind: 'manager-service-auth'; readonly action: 'view'; readonly sessionId: string } & Target)
  | ({
    readonly kind: 'manager-service-auth'
    readonly action: 'prepare-login'
    readonly sessionId: string
    readonly pluginGeneration: string
    readonly bindingId: string
  } & Target)
  | {
    readonly kind: 'manager-service-auth'
    readonly action: 'login'
    readonly sessionId: string
    readonly leaseId: string
  }
  | { readonly kind: 'manager-service-auth'; readonly action: 'retire'; readonly sessionId: string }

export interface ManagerServiceAuthRoute {
  readonly owner: ManagedServiceUIOwner
  readonly handler: ManagedServiceUIBridgeHandler
}

interface Lease {
  readonly sessionId: string
  readonly pluginId: string
  readonly pluginGeneration: string
  readonly serviceId: string
  readonly binding: ManagedServiceBindingV1
  readonly sequence: number
  readonly gestureAt: string
  readonly expires: number
}

const SESSION = /^[a-f0-9]{64}$/u
const LOCAL_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/u
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const LEASE_ID = /^[a-f0-9]{64}$/u
const LEASE_MS = 30_000
const RETIRED_MS = 8 * 60 * 60_000
const MAX_RETIRED = 4_096

/** Parsed only on the local management socket, never on the renderer or sandbox mailbox. */
export function parseManagerServiceAuthOperation(value: unknown): ManagerServiceAuthOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_MANAGER_AUTH_REQUEST')
  const item = value as Record<string, unknown>
  const action = item.action
  const fields = action === 'view'
    ? ['kind', 'action', 'sessionId', 'pluginId', 'serviceId']
    : action === 'prepare-login'
    ? ['kind', 'action', 'sessionId', 'pluginId', 'serviceId', 'pluginGeneration', 'bindingId']
    : action === 'login'
    ? ['kind', 'action', 'sessionId', 'leaseId']
    : action === 'retire' || action === 'list'
    ? ['kind', 'action', 'sessionId']
    : []
  if (
    item.kind !== 'manager-service-auth' || fields.length === 0 || Object.keys(item).some(key => !fields.includes(key))
    || typeof item.sessionId !== 'string' || !SESSION.test(item.sessionId)
    || ((action === 'view' || action === 'prepare-login')
      && (typeof item.pluginId !== 'string' || !LOCAL_ID.test(item.pluginId)
        || typeof item.serviceId !== 'string' || !LOCAL_ID.test(item.serviceId)))
    || (action === 'prepare-login'
      && (typeof item.pluginGeneration !== 'string' || !OPAQUE_ID.test(item.pluginGeneration)
        || typeof item.bindingId !== 'string' || !OPAQUE_ID.test(item.bindingId)))
    || (action === 'login' && (typeof item.leaseId !== 'string' || !LEASE_ID.test(item.leaseId)))
  ) throw new Error('INVALID_MANAGER_AUTH_REQUEST')
  return item as unknown as ManagerServiceAuthOperation
}

const unavailable = (code: string) => ({ status: 'unavailable' as const, code })

/** Local-user-only gateway; plugin tokens, credentials and plugin errors never leave the Host. */
export class ManagerServiceAuth {
  private readonly leases = new Map<string, Lease>()
  private readonly retired = new Map<string, number>()
  private blockedUntil = 0
  private closed = false

  constructor(
    private readonly input: {
      readonly profileId: string
      readonly generation: string
      readonly withRoute: <T>(
        pluginId: string,
        callback: (route: ManagerServiceAuthRoute | undefined) => Promise<T>,
      ) => Promise<T>
      readonly targets: () => Promise<readonly Target[] | undefined>
      readonly now?: () => number
    },
  ) {}

  private now(): number {
    return this.input.now?.() ?? Date.now()
  }

  private collect(): void {
    const now = this.now()
    for (const [id, lease] of this.leases) if (lease.expires <= now) this.leases.delete(id)
    for (const [session, until] of this.retired) if (until <= now) this.retired.delete(session)
  }

  private blocked(sessionId: string): boolean {
    return this.closed || this.blockedUntil > this.now() || this.retired.has(sessionId)
  }

  private async invoke(route: ManagerServiceAuthRoute, operation: Record<string, unknown>): Promise<unknown> {
    const envelope = {
      version: 1,
      token: route.handler.token,
      requestId: randomUUID(),
      scope: {
        profileId: this.input.profileId,
        runtimeGeneration: this.input.generation,
        pluginGeneration: route.owner.pluginGeneration,
      },
      ...operation,
    }
    const parsed = parseManagedServiceUIBindingRequest(envelope, route.handler, route.owner, this.now())
    return await route.handler.handle(route.owner, parsed)
  }

  private async read(route: ManagerServiceAuthRoute, serviceId: string) {
    const result = await this.invoke(route, { operation: 'get', serviceId }) as {
      status?: unknown
      service?: { binding?: ManagedServiceBindingV1 }
    }
    const binding = result.status === 'available' ? result.service?.binding : undefined
    if (!binding) return undefined
    const snapshot = await this.invoke(route, {
      operation: 'snapshot',
      serviceId,
      binding,
    }) as ManagedServiceSnapshotResultV1
    if (snapshot.status !== 'available') return undefined
    const projection = snapshot.projection
    if (
      projection.binding.bindingId !== binding.bindingId || !Number.isSafeInteger(projection.sequence)
      || projection.sequence < 0 || typeof projection.capabilities.explicitLogin !== 'boolean'
      || typeof projection.userAction.available !== 'boolean'
      || !['missing', 'authenticating', 'authenticated', 'expired', 'failed', 'logged-out'].includes(
        projection.auth.state,
      )
      || !['starting', 'ready', 'degraded', 'stopping', 'stopped', 'failed'].includes(projection.readiness)
    ) return undefined
    return { binding, projection }
  }

  async handle(value: unknown): Promise<unknown> {
    try {
      const operation = parseManagerServiceAuthOperation(value)
      this.collect()
      if (this.closed) return unavailable('OWNER_UNAVAILABLE')
      if (operation.action === 'retire') {
        if (
          this.blockedUntil > this.now() || !this.retired.has(operation.sessionId) && this.retired.size >= MAX_RETIRED
        ) {
          // Never evict a live tombstone. Reject every session until the longest
          // possible old browser session has expired instead.
          this.blockedUntil = this.now() + RETIRED_MS
          this.leases.clear()
        } else this.retired.set(operation.sessionId, this.now() + RETIRED_MS)
        for (const [id, lease] of this.leases) if (lease.sessionId === operation.sessionId) this.leases.delete(id)
        return { status: 'retired' }
      }
      if (this.blockedUntil > this.now()) return unavailable('SESSION_CAPACITY')
      if (this.retired.has(operation.sessionId)) return unavailable('SESSION_RETIRED')
      if (operation.action === 'list') {
        const targets = await this.input.targets()
        if (!targets) return unavailable('SERVICE_UNAVAILABLE')
        const services = []
        for (const target of targets.slice(0, 128)) {
          if (!LOCAL_ID.test(target.pluginId) || !LOCAL_ID.test(target.serviceId)) continue
          const view = await this.handle({
            kind: 'manager-service-auth',
            action: 'view',
            sessionId: operation.sessionId,
            ...target,
          }) as {
            status: string
          }
          services.push({ ...target, ...view })
        }
        if (this.blocked(operation.sessionId)) return unavailable('SESSION_RETIRED')
        return { status: 'available', services }
      }
      if (operation.action === 'login') {
        const lease = this.leases.get(operation.leaseId)
        // Consume before awaiting the lifecycle, including a wrong-session attempt.
        this.leases.delete(operation.leaseId)
        if (!lease || lease.sessionId !== operation.sessionId || lease.expires <= this.now()) {
          return unavailable('LEASE_UNAVAILABLE')
        }
        const started = await this.input.withRoute(lease.pluginId, async route => {
          if (
            this.blocked(operation.sessionId) || lease.expires <= this.now() || !route
            || route.owner.pluginGeneration !== lease.pluginGeneration
          ) return unavailable('STALE_GENERATION')
          // Start against the selected route while publication is fenced, but do not
          // block lifecycle shutdown or plugin updates on an interactive login.
          return {
            pending: this.invoke(route, {
              operation: 'authenticate',
              serviceId: lease.serviceId,
              binding: lease.binding,
              request: {
                $schema:
                  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-login-request.v1.schema.json',
                contract: 'cordisx.managed-service-login-request/v1',
                schemaVersion: 1,
                requestId: randomUUID(),
                binding: lease.binding,
                action: 'login',
                expectedSequence: lease.sequence,
                userGesture: { kind: 'explicit-click', at: lease.gestureAt },
              },
            }),
          }
        })
        if (!('pending' in started)) return started
        try {
          const response = await started.pending as { status?: unknown; error?: { code?: unknown } }
          if (response.status === 'accepted') return { status: 'accepted' }
          if (response.status === 'denied' && response.error?.code === 'stale-revision') {
            return { status: 'denied', code: 'STALE_REVISION' }
          }
          if (response.status === 'denied' || response.status === 'failed' || response.status === 'unavailable') {
            return { status: response.status, code: 'LOGIN_NOT_ACCEPTED' }
          }
          return { status: 'unknown', code: 'LOGIN_RESULT_UNKNOWN' }
        } catch {
          // The plugin may have completed before its response was lost.
          return { status: 'unknown', code: 'LOGIN_RESULT_UNKNOWN' }
        }
      }
      return await this.input.withRoute(operation.pluginId, async route => {
        if (!route || this.blocked(operation.sessionId)) return unavailable('SERVICE_UNAVAILABLE')
        const current = await this.read(route, operation.serviceId)
        if (!current || this.blocked(operation.sessionId)) return unavailable('SERVICE_UNAVAILABLE')
        const { binding, projection } = current
        if (operation.action === 'view') {
          return {
            status: 'available',
            pluginGeneration: route.owner.pluginGeneration,
            bindingId: binding.bindingId,
            sequence: projection.sequence,
            authState: projection.auth.state,
            readiness: projection.readiness,
            explicitLogin: projection.capabilities.explicitLogin,
            canLogin: projection.capabilities.explicitLogin && projection.userAction.available,
          }
        }
        if (route.owner.pluginGeneration !== operation.pluginGeneration || binding.bindingId !== operation.bindingId) {
          return unavailable('STALE_GENERATION')
        }
        if (!projection.capabilities.explicitLogin || !projection.userAction.available) {
          return unavailable('LOGIN_UNAVAILABLE')
        }
        if (
          this.leases.size >= 64
          || [...this.leases.values()].filter(lease => lease.sessionId === operation.sessionId).length >= 8
        ) {
          return unavailable('LEASE_LIMIT')
        }
        const now = this.now()
        const leaseId = randomBytes(32).toString('hex')
        this.leases.set(leaseId, {
          sessionId: operation.sessionId,
          pluginId: operation.pluginId,
          pluginGeneration: route.owner.pluginGeneration,
          serviceId: operation.serviceId,
          binding,
          sequence: projection.sequence,
          gestureAt: new Date(now).toISOString(),
          expires: now + LEASE_MS,
        })
        return { status: 'prepared', leaseId, expiresAt: new Date(now + LEASE_MS).toISOString() }
      })
    } catch {
      return unavailable('MANAGER_AUTH_FAILED')
    }
  }

  close(): void {
    this.closed = true
    this.leases.clear()
    this.retired.clear()
  }
}
