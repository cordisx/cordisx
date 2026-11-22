import { randomBytes } from 'node:crypto'
import type { StartupUIRequest } from '../launcher/startup-ui-rpc.js'
import type { ManagerRendererChannelContext } from './manager-renderer-sessions.js'
import type { ManagerManagedServiceUICapability } from './manager-managed-service-ui.js'
import { awaitObservationOrAbort } from './manager-observation-abort.js'

interface Alias {
  readonly public: ManagerManagedServiceUICapability
  readonly ownerToken: string
}
type OpenResult = { readonly response: Record<string, unknown>; readonly state: 'active' | 'none' | 'unknown' }
interface Stream {
  readonly key: string
  readonly publicId: string
  readonly ownerId: string
  readonly alias: Alias
  readonly opening: Promise<OpenResult>
  closing?: Promise<boolean>
  nextPending: boolean
}

function unavailable(): Error {
  return new Error('MANAGED_SERVICE_UI_UNAVAILABLE')
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable()
  return value as Record<string, unknown>
}
function terminated(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return item.status === 'startup-terminated' && (item.reason === 'scope-revoked' || item.reason === 'host-replaced')
}

/** One renderer's observation streams; upstream IDs and tokens remain owner-private. */
export class ManagerStartupObservation {
  private readonly streams = new Map<string, Stream>()
  private closed = false
  private retirement: Promise<boolean> | undefined

  constructor(
    private readonly input: {
      readonly context: ManagerRendererChannelContext
      readonly runtimeGeneration: string
      readonly allocateId: () => string
      readonly assertCurrent: () => void
      readonly invoke: (value: string, signal?: AbortSignal) => Promise<Record<string, unknown>>
      /** Validate and redact the owner's response before it leaves this process. */
      readonly sanitize: (value: unknown, requestId: string) => Record<string, unknown>
    },
  ) {}

  private async call(
    alias: Alias,
    request: StartupUIRequest,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
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
      const result = request.operation === 'startupNext'
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

  private closeStream(stream: Stream): Promise<boolean> {
    if (stream.closing) return stream.closing
    stream.closing = (async () => {
      const opening = await stream.opening
      if (opening.state === 'none') {
        this.streams.delete(stream.key)
        return true
      }
      try {
        const response = await this.call(stream.alias, {
          requestId: 'cleanup-' + randomBytes(16).toString('hex'),
          operation: 'startupClose',
          subscriptionId: stream.ownerId,
        })
        const confirmed = response.ok === true && (response.value === null || terminated(response.value))
        if (confirmed) this.streams.delete(stream.key)
        return confirmed
      } catch {
        return false
      }
    })().catch(() => false)
    return stream.closing
  }

  prepare(request: StartupUIRequest, alias: Alias): {
    readonly mode: 'read'
    readonly channelConfigurationIndependent: true
    readonly longLivedRead?: true
    dispatch(): Promise<unknown>
  } {
    if (!alias.public.startup || this.closed) throw unavailable()
    const current = () => {
      if (this.closed) throw unavailable()
      this.input.assertCurrent()
    }
    if (request.operation === 'startupRead') {
      return {
        mode: 'read',
        channelConfigurationIndependent: true,
        dispatch: async () => {
          current()
          const response = await this.call(alias, request, this.input.context.signal)
          current()
          return response
        },
      }
    }
    if (request.operation === 'startupSubscribe') {
      return {
        mode: 'read',
        channelConfigurationIndependent: true,
        dispatch: async () => {
          current()
          const key = this.key(alias, request.subscriptionId)
          if (this.streams.has(key) || this.streams.size >= 128) throw unavailable()
          const ownerId = this.input.allocateId()
          let finishOpening!: (result: OpenResult) => void
          const opening = new Promise<OpenResult>(resolve => finishOpening = resolve)
          const stream: Stream = { key, publicId: request.subscriptionId, ownerId, alias, opening, nextPending: false }
          // Retirement must see the stream before the owner can start opening it.
          this.streams.set(key, stream)
          void this.call(alias, { ...request, subscriptionId: ownerId }, this.input.context.signal)
            .then(response => {
              if (response.ok === false || terminated(response.value)) return { response, state: 'none' as const }
              const value = object(response.value)
              return { response, state: value.subscriptionId === ownerId ? 'active' as const : 'unknown' as const }
            }).catch(() => ({ response: {}, state: 'unknown' as const })).then(finishOpening)
          const result = await opening
          try {
            current()
            if (result.state === 'none') {
              this.streams.delete(key)
              return result.response
            }
            if (result.state !== 'active') throw unavailable()
            const value = object(result.response.value)
            if (
              Object.keys(value).some(field => field !== 'subscriptionId' && field !== 'initial')
              || JSON.stringify(value.initial)?.includes(ownerId)
            ) throw unavailable()
            return {
              requestId: request.requestId,
              ok: true,
              value: {
                subscriptionId: stream.publicId,
                ...(value.initial === undefined ? {} : { initial: value.initial }),
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
      ...(request.operation === 'startupNext' ? { longLivedRead: true as const } : {}),
      dispatch: async () => {
        current()
        const stream = this.streams.get(this.key(alias, request.subscriptionId))
        if (!stream || stream.closing || (await stream.opening).state !== 'active') throw unavailable()
        current()
        if (request.operation === 'startupClose') {
          const confirmed = await this.closeStream(stream)
          current()
          if (!confirmed) throw unavailable()
          return { requestId: request.requestId, ok: true, value: null }
        }
        if (stream.nextPending) throw unavailable()
        stream.nextPending = true
        try {
          const response = await this.call(
            alias,
            { ...request, subscriptionId: stream.ownerId },
            this.input.context.signal,
          )
          current()
          if (JSON.stringify(response.value)?.includes(stream.ownerId)) throw unavailable()
          return response
        } finally {
          stream.nextPending = false
        }
      },
    }
  }

  /** Finish or fence every upstream subscription before acknowledging retirement. */
  retire(): Promise<boolean> {
    if (this.retirement) return this.retirement
    this.closed = true
    const cleanup = Promise.all([...this.streams.values()].map(async stream => await this.closeStream(stream)))
      .then(results => results.every(Boolean))
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
