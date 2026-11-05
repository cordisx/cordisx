import type { StartupSnapshotV1 } from '@cordisx/protocol/startup/v1'
import type { StartupProviderAdmission } from './startup-provider-admission.js'
import type { StartupRequirementsResult } from '../cli/startup-requirements.js'
import { randomUUID } from 'node:crypto'
import type { NativeModelProviderCatalogEntry } from './native-model-provider-catalog.js'
import type { NativeManagedGatewayConnectionSession } from './managed-service-native-connection.js'
import { nativeSubmissionCredentialBroker } from './native-submission-credentials.js'
import type { NativeProviderCredentialBroker } from './native-provider-credential-broker.js'
import { nativeProviderConfig, type NativeProviderCredentialLease } from './native-submission-controller.js'
import { type ModelProviderDisplay, modelProviderDisplays } from '../model-provider-display.js'

export type TerminalProviderRequest =
  | { readonly kind: 'list' }
  | { readonly kind: 'cancel-wait'; readonly waiterId: string }
  | { readonly kind: 'wait'; readonly providerId?: string; readonly model?: string; readonly waiterId?: string }
  | {
    readonly kind: 'prepare'
    readonly providerId: string
    readonly model: string
    readonly client?: 'claude-code'
    readonly waiterId?: string
  }
  | { readonly kind: 'renew' | 'release'; readonly leaseId: string }
export type TerminalProviderResult =
  | { readonly kind: 'ready' | 'cancelled' }
  | { readonly kind: 'unavailable'; readonly startup: Exclude<StartupRequirementsResult, { status: 'ready' }> }
  | {
    readonly kind: 'list'
    readonly startup?: StartupSnapshotV1
    readonly providers: readonly {
      readonly providerId: string
      readonly title: string
      readonly managed: boolean
      readonly display?: ModelProviderDisplay
      readonly models: readonly { readonly id: string; readonly label: string }[]
    }[]
  }
  | {
    readonly kind: 'prepared'
    readonly leaseId: string
    readonly providerId: string
    readonly model: string
    readonly provider: Readonly<Record<string, unknown>>
    readonly anthropicBaseUrl?: string
  }
  | { readonly kind: 'renewed' | 'released' }

export function parseTerminalProviderRequest(value: unknown): TerminalProviderRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid terminal provider request')
  const item = value as Record<string, unknown>
  const text = (key: string) =>
    typeof item[key] === 'string' && (item[key] as string).length > 0
    && (item[key] as string).length <= 512 && !/[\u0000-\u001f\u007f]/u.test(item[key] as string)
  const keys = item.kind === 'cancel-wait'
    ? ['kind', 'waiterId']
    : item.kind === 'wait'
    ? ['kind', 'providerId', 'model', 'waiterId']
    : item.kind === 'list'
    ? ['kind']
    : item.kind === 'prepare'
    ? ['kind', 'providerId', 'model', 'client', 'waiterId']
    : ['kind', 'leaseId']
  if (Object.keys(item).some(key => !keys.includes(key))) throw new Error('Invalid terminal provider request fields')
  if (item.client !== undefined && item.client !== 'claude-code') throw new Error('Invalid terminal client')
  if (item.waiterId !== undefined && !text('waiterId')) throw new Error('Invalid terminal waiter')
  if (
    item.kind === 'wait' && (item.providerId === undefined || text('providerId'))
    && (item.model === undefined || text('model')) && (item.model === undefined || item.providerId !== undefined)
  ) {
    return item as unknown as TerminalProviderRequest
  }
  if (item.kind === 'cancel-wait' && text('waiterId')) return item as unknown as TerminalProviderRequest
  if (item.kind === 'list') return { kind: 'list' }
  if (item.kind === 'prepare' && text('providerId') && text('model')) return item as unknown as TerminalProviderRequest
  if ((item.kind === 'renew' || item.kind === 'release') && text('leaseId')) {
    return item as unknown as TerminalProviderRequest
  }
  throw new Error('Invalid terminal provider selection')
}

/** Launch-scoped leases reuse the live Host; credentials never leave its existing broker. */
export function createTerminalProviderAuthority(options: {
  readonly startup?: StartupProviderAdmission
  readonly waitRequirements?: (
    providerId?: string,
    model?: string,
    signal?: AbortSignal,
  ) => Promise<StartupRequirementsResult>
  readonly catalog: () => Promise<readonly NativeModelProviderCatalogEntry[]>
  readonly display?: () => Promise<readonly ModelProviderDisplay[]>
  readonly owns: (providerId: string) => boolean
  readonly resolve: (
    providerId: string,
  ) => NativeManagedGatewayConnectionSession | Promise<NativeManagedGatewayConnectionSession>
  readonly credentials: NativeProviderCredentialBroker
  readonly now?: () => number
}) {
  const now = options.now ?? Date.now
  const ttlMs = 60_000
  const leases = new Map<string, {
    providerId: string
    model: string
    waiterId?: string
    credential: NativeProviderCredentialLease
    expires: number
  }>()
  let closed = false
  const lifetime = new AbortController()
  const waiters = new Map<string, AbortController>()
  const broker = nativeSubmissionCredentialBroker({
    credentials: options.credentials,
    resolveEndpoint: options.resolve,
  })
  const release = (id: string) => {
    const lease = leases.get(id)
    leases.delete(id)
    lease?.credential.dispose()
  }
  const sweep = () => {
    for (const [id, lease] of leases) if (lease.expires <= now()) release(id)
  }
  const timer = setInterval(sweep, 5_000)
  timer.unref()
  const validate = async (providerId: string, model: string, generation?: string) => {
    if (closed || !options.owns(providerId)) throw new Error('Terminal provider is unavailable in this Host')
    const catalog = await options.catalog()
    if (
      !catalog.some(provider => provider.providerId === providerId && provider.models.some(item => item.id === model))
    ) {
      throw new Error('Unknown or unavailable terminal model; use cordisx cli --list')
    }
    const connection = await options.resolve(providerId)
    try {
      if (
        !connection.value.models.aliases.some(item => item.gatewayModelId === model)
        || generation !== undefined && connection.value.service.generation !== generation
      ) {
        throw new Error('Terminal provider generation or model changed; start a new CLI session')
      }
    } finally {
      connection.dispose()
    }
    if (closed) throw new Error('Terminal provider authority retired')
  }
  return {
    async request(raw: TerminalProviderRequest): Promise<TerminalProviderResult> {
      const request = parseTerminalProviderRequest(raw)
      if (closed) throw new Error('Terminal provider authority retired')
      sweep()
      if (request.kind === 'cancel-wait') {
        waiters.get(request.waiterId)?.abort()
        for (const [id, lease] of leases) if (lease.waiterId === request.waiterId) release(id)
        return { kind: 'cancelled' }
      }
      if (request.kind === 'wait') {
        if (request.waiterId !== undefined && waiters.has(request.waiterId)) {
          throw new Error('Terminal waiter already exists')
        }
        const waiter = new AbortController()
        if (request.waiterId !== undefined) waiters.set(request.waiterId, waiter)
        const abort = () => waiter.abort()
        lifetime.signal.addEventListener('abort', abort, { once: true })
        try {
          const startup = await options.waitRequirements?.(request.providerId, request.model, waiter.signal)
          if (closed || waiter.signal.aborted) return { kind: 'unavailable', startup: { status: 'cancelled' } }
          return startup === undefined || startup.status === 'ready'
            ? { kind: 'ready' }
            : { kind: 'unavailable', startup }
        } finally {
          lifetime.signal.removeEventListener('abort', abort)
          if (request.waiterId !== undefined) waiters.delete(request.waiterId)
        }
      }
      if (request.kind === 'list') {
        const catalog = await options.catalog()
        const displays = modelProviderDisplays(await options.display?.().catch(() => []) ?? [])
        if (closed) throw new Error('Terminal provider authority retired')
        return {
          kind: 'list',
          ...(options.startup?.snapshot === undefined ? {} : { startup: await options.startup.snapshot() }),
          providers: catalog.map(provider => {
            const display = options.owns(provider.providerId)
              ? displays.find(display => display.providerId === provider.providerId)
                ?? modelProviderDisplays([provider.display]).find(display => display.providerId === provider.providerId)
              : undefined
            return {
              providerId: provider.providerId,
              title: display?.title ?? provider.title ?? provider.providerId,
              managed: options.owns(provider.providerId),
              ...(display === undefined ? {} : { display }),
              models: provider.models.map(model => ({ id: model.id, label: model.label })),
            }
          }),
        }
      }
      if (request.kind === 'prepare') {
        if (request.waiterId !== undefined && waiters.has(request.waiterId)) {
          throw new Error('Terminal waiter already exists')
        }
        const waiter = new AbortController()
        if (request.waiterId !== undefined) waiters.set(request.waiterId, waiter)
        const abort = () => waiter.abort()
        lifetime.signal.addEventListener('abort', abort, { once: true })
        try {
          const startup = await options.startup?.wait(request.providerId, request.model, waiter.signal)
          if (waiter.signal.aborted) return { kind: 'unavailable', startup: { status: 'cancelled' } }
          if (startup !== undefined && startup.status !== 'ready') return { kind: 'unavailable', startup }
          if (leases.size >= 64) throw new Error('Too many terminal provider sessions')
          await validate(request.providerId, request.model)
          if (closed || waiter.signal.aborted) return { kind: 'unavailable', startup: { status: 'cancelled' } }
          const credential = await broker.prepare(request.providerId)
          try {
            if (closed || waiter.signal.aborted) {
              credential.dispose()
              return { kind: 'unavailable', startup: { status: 'cancelled' } }
            }
            await validate(request.providerId, request.model, credential.serviceGeneration)
            if (closed || waiter.signal.aborted) {
              credential.dispose()
              return { kind: 'unavailable', startup: { status: 'cancelled' } }
            }
            if (leases.size >= 64) throw new Error('Too many terminal provider sessions')
            const provider = nativeProviderConfig(credential)
            // Claude Code can reuse an unauthenticated loopback gateway. Bearer
            // credentials retain the Codex command broker and are never exported.
            if (
              request.client === 'claude-code'
              && ('auth' in provider || !String(provider.base_url).startsWith('http://127.0.0.1:'))
            ) {
              throw new Error(
                'This managed gateway cannot supply Claude Code authentication; select an anthropic-messages shared service',
              )
            }
            const leaseId = randomUUID()
            leases.set(leaseId, { ...request, credential, expires: now() + ttlMs })
            return {
              kind: 'prepared',
              leaseId,
              providerId: request.providerId,
              model: request.model,
              provider,
              ...(request.client === 'claude-code'
                ? { anthropicBaseUrl: String(provider.base_url).replace(/\/v1\/?$/u, '') }
                : {}),
            }
          } catch (error) {
            credential.dispose()
            throw error
          }
        } finally {
          lifetime.signal.removeEventListener('abort', abort)
          if (request.waiterId !== undefined) waiters.delete(request.waiterId)
        }
      }
      if (request.kind === 'release') {
        release(request.leaseId)
        return { kind: 'released' }
      }
      const lease = leases.get(request.leaseId)
      if (!lease) throw new Error('Terminal provider lease expired')
      try {
        await validate(lease.providerId, lease.model, lease.credential.serviceGeneration)
        if (leases.get(request.leaseId) !== lease) throw new Error('Terminal provider lease retired')
        lease.expires = now() + ttlMs
        return { kind: 'renewed' }
      } catch (error) {
        release(request.leaseId)
        throw error
      }
    },
    close() {
      closed = true
      lifetime.abort()
      clearInterval(timer)
      for (const id of leases.keys()) release(id)
    },
  }
}
