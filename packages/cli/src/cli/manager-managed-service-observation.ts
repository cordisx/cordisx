import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { ManagedServiceBindingV1 } from '@cordisx/protocol/managed-service/v1'
import type { ManagedServiceUIBindingRequest } from '../launcher/managed-service-ui-rpc.js'
import type { ManagerRendererChannelContext } from './manager-renderer-sessions.js'
import type { ManagerManagedServiceUICapability } from './manager-managed-service-ui.js'
import { awaitObservationOrAbort } from './manager-observation-abort.js'

export type ManagerManagedServiceObservationRequest = Extract<
  ManagedServiceUIBindingRequest,
  { readonly operation: 'subscribe' | 'next' | 'pull' | 'closed' | 'unsubscribe' }
>
type Request = ManagerManagedServiceObservationRequest
interface Alias {
  readonly public: ManagerManagedServiceUICapability
  readonly ownerToken: string
}
type OpenResult =
  | { readonly state: 'active'; readonly response: Record<string, unknown>; readonly ownerId: string }
  | { readonly state: 'none'; readonly response: Record<string, unknown> }
  | { readonly state: 'unknown'; readonly ownerId?: string }
type CloseResult = { readonly confirmed: boolean; readonly receipt?: Record<string, unknown> }
interface Stream {
  readonly key: string
  readonly publicId: string
  readonly alias: Alias
  readonly serviceId: string
  readonly binding: ManagedServiceBindingV1
  readonly afterSequence: number
  readonly opening: Promise<OpenResult>
  closing?: Promise<CloseResult>
  nextPending: boolean
  closedPending: boolean
}
interface ClosedStream {
  readonly serviceId: string
  readonly binding: ManagedServiceBindingV1
  readonly receipt: Record<string, unknown>
}

const opaqueId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const pageSchema =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-subscription-page.v1.schema.json'
const closeSchema =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-subscription-close.v1.schema.json'

function unavailable(): Error {
  return new Error('MANAGED_SERVICE_UI_UNAVAILABLE')
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable()
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key))
}
function sequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}
function containsOwnerId(value: unknown, ownerId: string): boolean {
  const pending = [value]
  while (pending.length > 0) {
    const current = pending.pop()
    if (typeof current === 'string') {
      if (current === ownerId || ownerId.length >= 16 && current.includes(ownerId)) return true
    } else if (current && typeof current === 'object') {
      for (const [key, item] of Object.entries(current)) {
        if (key === ownerId || ownerId.length >= 16 && key.includes(ownerId)) return true
        pending.push(item)
      }
    }
  }
  return false
}

/** Per-renderer subscriptions; owner-assigned identifiers never cross the Manager boundary. */
export class ManagerManagedServiceObservation {
  private readonly streams = new Map<string, Stream>()
  private readonly closedStreams = new Map<string, ClosedStream>()
  private closed = false
  private retirement: Promise<boolean> | undefined

  constructor(
    private readonly input: {
      readonly context: ManagerRendererChannelContext
      readonly runtimeGeneration: string
      readonly allocateId: () => string
      readonly assertCurrent: (parkable?: boolean) => void
      readonly invoke: (value: string, signal?: AbortSignal) => Promise<Record<string, unknown>>
      readonly sanitize: (value: unknown, requestId: string) => Record<string, unknown>
    },
  ) {}

  private async call(alias: Alias, request: Request, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const envelope = {
      version: 1,
      token: alias.ownerToken,
      scope: {
        profileId: this.input.context.profileId,
        runtimeGeneration: this.input.runtimeGeneration,
        pluginGeneration: alias.public.pluginGeneration,
      },
      ...request,
    }
    try {
      const invocation = this.input.invoke(JSON.stringify(envelope), signal)
      const result = request.operation === 'next' || request.operation === 'pull' || request.operation === 'closed'
        ? await awaitObservationOrAbort(invocation, signal)
        : await invocation
      return this.input.sanitize(result, request.requestId)
    } catch {
      throw unavailable()
    }
  }

  private key(alias: Alias, subscriptionId: string): string {
    return alias.public.token + '\u0000' + subscriptionId
  }

  private descriptor(value: unknown, stream: Stream, ownerId?: string): Record<string, unknown> {
    const descriptor = object(value)
    if (
      !exact(descriptor, ['subscriptionId', 'binding', 'afterSequence', 'snapshotSequence'])
      || typeof descriptor.subscriptionId !== 'string' || !opaqueId.test(descriptor.subscriptionId)
      || ownerId !== undefined && descriptor.subscriptionId !== ownerId
      || descriptor.subscriptionId === stream.publicId || !isDeepStrictEqual(descriptor.binding, stream.binding)
      || descriptor.afterSequence !== stream.afterSequence || !sequence(descriptor.snapshotSequence)
    ) throw unavailable()
    return { ...descriptor, subscriptionId: stream.publicId }
  }

  private closedReceipt(value: unknown, stream: Stream, ownerId: string): Record<string, unknown> {
    const receipt = object(value)
    if (
      !exact(receipt, ['$schema', 'contract', 'schemaVersion', 'subscription', 'closedAt', 'reason'])
      || receipt.$schema !== closeSchema || receipt.contract !== 'cordisx.managed-service-subscription-close/v1'
      || receipt.schemaVersion !== 1 || typeof receipt.closedAt !== 'string'
      || !Number.isFinite(Date.parse(receipt.closedAt))
      || !['explicit', 'binding-replaced', 'generation-replaced', 'owner-disposed', 'service-disposed'].includes(
        String(receipt.reason),
      )
    ) throw unavailable()
    const projected = { ...receipt, subscription: this.descriptor(receipt.subscription, stream, ownerId) }
    if (containsOwnerId(projected, ownerId)) throw unavailable()
    return projected
  }

  private page(value: unknown, stream: Stream, ownerId: string): Record<string, unknown> {
    const page = object(value)
    if (
      !exact(page, [
        '$schema',
        'contract',
        'schemaVersion',
        'subscription',
        'phase',
        'updates',
        'nextAfterSequence',
        'hasMore',
      ])
      || page.$schema !== pageSchema || page.contract !== 'cordisx.managed-service-subscription-page/v1'
      || page.schemaVersion !== 1 || !['replay', 'live'].includes(String(page.phase))
      || !Array.isArray(page.updates) || !sequence(page.nextAfterSequence) || typeof page.hasMore !== 'boolean'
    ) throw unavailable()
    const projected = { ...page, subscription: this.descriptor(page.subscription, stream, ownerId) }
    if (containsOwnerId(projected, ownerId)) throw unavailable()
    return projected
  }

  private remember(stream: Stream, receipt: Record<string, unknown>): void {
    this.streams.delete(stream.key)
    this.closedStreams.set(stream.key, { serviceId: stream.serviceId, binding: stream.binding, receipt })
    while (this.closedStreams.size > 512) this.closedStreams.delete(this.closedStreams.keys().next().value!)
  }

  private closeStream(stream: Stream): Promise<CloseResult> {
    if (stream.closing) return stream.closing
    stream.closing = (async () => {
      const opening = await stream.opening
      if (opening.state === 'none') {
        this.streams.delete(stream.key)
        return { confirmed: true }
      }
      const ownerId = opening.ownerId
      if (!ownerId) return { confirmed: false }
      const prior = this.closedStreams.get(stream.key)
      if (prior) return { confirmed: true, receipt: prior.receipt }
      try {
        const response = await this.call(stream.alias, {
          requestId: 'cleanup-' + randomBytes(16).toString('hex'),
          operation: 'unsubscribe',
          serviceId: stream.serviceId,
          binding: stream.binding,
          subscriptionId: ownerId,
        })
        if (response.ok !== true) return { confirmed: false }
        const receipt = this.closedReceipt(response.value, stream, ownerId)
        this.remember(stream, receipt)
        return { confirmed: true, receipt }
      } catch {
        return { confirmed: false }
      }
    })().catch(() => ({ confirmed: false }))
    return stream.closing
  }

  prepare(request: Request, alias: Alias): {
    readonly mode: 'read'
    readonly channelConfigurationIndependent: true
    readonly longLivedRead?: true
    dispatch(): Promise<unknown>
  } {
    if (this.closed) throw unavailable()
    const current = () => {
      if (this.closed) throw unavailable()
      this.input.assertCurrent(
        request.operation === 'next' || request.operation === 'pull' || request.operation === 'closed',
      )
    }
    if (request.operation === 'subscribe') {
      return {
        mode: 'read',
        channelConfigurationIndependent: true,
        dispatch: async () => {
          current()
          if (this.streams.size >= 128) throw unavailable()
          const publicId = this.input.allocateId()
          const key = this.key(alias, publicId)
          let finishOpening!: (result: OpenResult) => void
          const opening = new Promise<OpenResult>(resolve => finishOpening = resolve)
          const stream: Stream = {
            key,
            publicId,
            alias,
            serviceId: request.serviceId,
            binding: request.binding,
            afterSequence: request.afterSequence,
            opening,
            nextPending: false,
            closedPending: false,
          }
          this.streams.set(key, stream)
          void this.call(alias, request, this.input.context.signal).then(response => {
            if (response.ok !== true) return { state: 'unknown' as const }
            const value = object(response.value)
            if (value.status === 'unavailable' && exact(value, ['status', 'code'])) {
              return { state: 'none' as const, response }
            }
            if (value.status !== 'subscribed' || !exact(value, ['status', 'subscription'])) {
              return { state: 'unknown' as const }
            }
            const descriptor = object(value.subscription)
            const ownerId = typeof descriptor.subscriptionId === 'string' && opaqueId.test(descriptor.subscriptionId)
                && isDeepStrictEqual(descriptor.binding, request.binding)
              ? descriptor.subscriptionId
              : undefined
            if (!ownerId) return { state: 'unknown' as const }
            try {
              this.descriptor(descriptor, stream, ownerId)
              return { state: 'active' as const, response, ownerId }
            } catch {
              return { state: 'unknown' as const, ownerId }
            }
          }).catch(() => ({ state: 'unknown' as const })).then(finishOpening)
          const result = await opening
          try {
            current()
            if (result.state === 'none') {
              this.streams.delete(key)
              return result.response
            }
            if (result.state !== 'active') throw unavailable()
            const value = object(result.response.value)
            return {
              requestId: request.requestId,
              ok: true,
              value: {
                status: 'subscribed',
                subscription: this.descriptor(value.subscription, stream, result.ownerId),
              },
            }
          } catch {
            void this.closeStream(stream)
            throw unavailable()
          }
        },
      }
    }
    return {
      mode: 'read',
      channelConfigurationIndependent: true,
      ...(request.operation === 'next' || request.operation === 'pull' || request.operation === 'closed'
        ? { longLivedRead: true as const }
        : {}),
      dispatch: async () => {
        current()
        const key = this.key(alias, request.subscriptionId)
        const stream = this.streams.get(key)
        if (!stream) {
          const prior = this.closedStreams.get(key)
          if (
            prior && prior.serviceId === request.serviceId && isDeepStrictEqual(prior.binding, request.binding)
            && (request.operation === 'closed' || request.operation === 'unsubscribe')
          ) return { requestId: request.requestId, ok: true, value: prior.receipt }
          throw unavailable()
        }
        if (
          stream.serviceId !== request.serviceId || !isDeepStrictEqual(stream.binding, request.binding)
          || stream.closing
        ) throw unavailable()
        const opening = await stream.opening
        if (opening.state !== 'active') throw unavailable()
        current()
        if (request.operation === 'unsubscribe') {
          const result = await this.closeStream(stream)
          current()
          if (!result.confirmed || !result.receipt) throw unavailable()
          return { requestId: request.requestId, ok: true, value: result.receipt }
        }
        const isClosed = request.operation === 'closed'
        if (isClosed ? stream.closedPending : stream.nextPending) throw unavailable()
        if (isClosed) stream.closedPending = true
        else stream.nextPending = true
        try {
          const response = await this.call(
            alias,
            { ...request, subscriptionId: opening.ownerId },
            this.input.context.signal,
          )
          current()
          if (response.ok !== true) {
            void this.closeStream(stream)
            return response
          }
          if (isClosed) {
            const receipt = this.closedReceipt(response.value, stream, opening.ownerId)
            this.remember(stream, receipt)
            return { requestId: request.requestId, ok: true, value: receipt }
          }
          const value = object(response.value)
          if (value.status === 'page' && exact(value, ['status', 'page'])) {
            return {
              requestId: request.requestId,
              ok: true,
              value: { status: 'page', page: this.page(value.page, stream, opening.ownerId) },
            }
          }
          if (value.status === 'closed' && exact(value, ['status', 'closed'])) {
            const receipt = this.closedReceipt(value.closed, stream, opening.ownerId)
            this.remember(stream, receipt)
            return { requestId: request.requestId, ok: true, value: { status: 'closed', closed: receipt } }
          }
          throw unavailable()
        } catch {
          void this.closeStream(stream)
          throw unavailable()
        } finally {
          if (isClosed) stream.closedPending = false
          else stream.nextPending = false
        }
      },
    }
  }

  /** Every upstream subscription must close before renderer retirement is acknowledged. */
  retire(): Promise<boolean> {
    if (this.retirement) return this.retirement
    this.closed = true
    const cleanup = Promise.all([...this.streams.values()].map(async stream => await this.closeStream(stream)))
      .then(results => results.every(result => result.confirmed))
      .catch(() => false)
    this.retirement = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          cleanup,
          new Promise<boolean>(resolve => timer = setTimeout(() => resolve(false), 5_000)),
        ])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    })()
    return this.retirement
  }
}
