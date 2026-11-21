import { randomBytes } from 'node:crypto'
import type { LocalChannelService } from '../launcher/channel-service.js'
import type { CordisXConfigPlugin } from '../launcher/config.js'
import { MAX_CHANNEL_CREDENTIAL_REQUEST_BYTES } from '../launcher/channel-credential-rpc.js'
import {
  type ManagerChannelCredentialOperation,
  parseManagerChannelCredentialOperation,
} from '../launcher/manager-channel-credentials.js'
import type { ServiceRendererLifecycle } from '../launcher/service-renderer-lifecycle.js'
import type {
  ManagerRendererChannel,
  ManagerRendererChannelContext,
  ManagerRendererSessions,
} from './manager-renderer-sessions.js'
import type { ServiceRendererParticipants } from './service-renderer-participant.js'
import type { ServiceRendererBootstrap } from './service-renderer-bootstrap.js'
import type { createConfiguredChannelOwner } from './configured-channel-owner.js'
import { fenceManagerOrigin } from './manager-origin-fence.js'
import { channelConfigurationApi } from './renderer-channel-composition.js'

const TOKEN = 'renderer-binding-placeholder'
type SupportedOperation = Extract<ManagerChannelCredentialOperation, { action: 'capture' | 'commit' | 'discard' }>
type CredentialResult = {
  readonly status: 'applied' | 'conflict' | 'rejected' | 'unavailable'
  readonly code: string
  readonly draftId?: string
  readonly ref?: { readonly adapterId: string; readonly accountId: string; readonly tenantId: string }
  readonly expiresAt?: string
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Parse without including submitted values in errors. The browser never selects the owner session. */
function parse(payload: unknown, context: ManagerRendererChannelContext): {
  readonly requestId: string
  readonly operation: SupportedOperation
} {
  if (typeof payload !== 'string' || Buffer.byteLength(payload) > MAX_CHANNEL_CREDENTIAL_REQUEST_BYTES) {
    throw new Error('CHANNEL_CREDENTIAL_UNAVAILABLE')
  }
  let value: Record<string, unknown> | undefined
  try {
    value = object(JSON.parse(payload))
  } catch {
    throw new Error('CHANNEL_CREDENTIAL_UNAVAILABLE')
  }
  const action = value?.operation
  const common = ['version', 'token', 'requestId', 'operation', 'owner']
  const fields = action === 'capture'
    ? [...common, 'purpose', 'account', 'secret', 'expectedRevision']
    : action === 'commit'
    ? [...common, 'draftId', 'draft']
    : action === 'discard'
    ? [...common, 'draftId']
    : []
  if (
    !value || !fields.length || Object.keys(value).some(key => !fields.includes(key))
    || value.version !== 2 || value.token !== TOKEN || typeof value.requestId !== 'string'
    || !/^[A-Za-z0-9-]{1,96}$/u.test(value.requestId) || typeof value.owner !== 'string'
    || value.owner.length === 0 || value.owner.length > 2048
  ) throw new Error('CHANNEL_CREDENTIAL_UNAVAILABLE')
  const parsed = parseManagerChannelCredentialOperation({
    kind: 'manager-channel-credentials',
    sessionId: context.rendererId,
    action,
    ...(action === 'capture'
      ? {
        purpose: value.purpose,
        account: value.account,
        secret: value.secret,
        expectedRevision: value.expectedRevision,
        // Replaced with the current owner generation at dispatch.
        serviceGeneration: 'pending',
      }
      : {
        draftId: value.draftId,
        ...(action === 'commit' && value.draft !== undefined ? { draft: value.draft } : {}),
      }),
  })
  if (
    parsed.action !== 'capture' && parsed.action !== 'commit' && parsed.action !== 'discard'
    || parsed.action === 'capture' && (parsed.purpose !== 'rotate' || !parsed.account.tenantId)
  ) throw new Error('CHANNEL_CREDENTIAL_UNAVAILABLE')
  return { requestId: value.requestId, operation: parsed }
}

/** Project only bounded, value-free outcomes from the private credential authority. */
function project(value: unknown, operation: SupportedOperation): CredentialResult {
  const result = object(value)
  if (
    !result || !['applied', 'conflict', 'rejected', 'unavailable'].includes(String(result.status))
    || typeof result.code !== 'string' || !/^[A-Z0-9_]{1,80}$/u.test(result.code)
  ) throw new Error('CHANNEL_CREDENTIAL_RESULT_UNKNOWN')
  const status = result.status as CredentialResult['status']
  if (status !== 'applied') return { status, code: result.code }
  if (operation.action === 'capture') {
    const ref = object(result.ref)
    if (
      result.code !== 'CAPTURED' || typeof result.draftId !== 'string'
      || !/^[A-Za-z0-9_-]{43}$/u.test(result.draftId) || typeof result.expiresAt !== 'string'
      || !Number.isFinite(Date.parse(result.expiresAt)) || !ref
      || ref.adapterId !== operation.account.adapterId || ref.accountId !== operation.account.accountId
      || ref.tenantId !== operation.account.tenantId
    ) throw new Error('CHANNEL_CREDENTIAL_RESULT_UNKNOWN')
    return {
      status,
      code: result.code,
      draftId: result.draftId,
      ref: { ...operation.account },
      expiresAt: new Date(result.expiresAt).toISOString(),
    }
  }
  if (result.code !== (operation.action === 'commit' ? 'APPLIED' : 'DISCARDED')) {
    throw new Error('CHANNEL_CREDENTIAL_RESULT_UNKNOWN')
  }
  return { status, code: result.code }
}

/** Owner-bound private credential drafts and a coordinated one-page commit. */
export function createManagerRendererChannelCredentials(input: {
  readonly profileId: string
  readonly generation: string
  readonly configPath: string
  readonly plugin: CordisXConfigPlugin
  readonly service: LocalChannelService
  readonly authority: NonNullable<ReturnType<typeof createConfiguredChannelOwner>>
  readonly bootstrap: ServiceRendererBootstrap
  readonly participants: ServiceRendererParticipants
  readonly lifecycle: ServiceRendererLifecycle
  readonly sessions: () => ManagerRendererSessions
  readonly handle: (operation: ManagerChannelCredentialOperation) => Promise<unknown>
}): { readonly channel: ManagerRendererChannel; waitForRetirement(rendererId: string): Promise<boolean> } {
  const ownerToken = randomBytes(32).toString('hex')
  const seen = new WeakMap<AbortSignal, Set<string>>()
  const watched = new Map<string, { signal: AbortSignal; retirement?: Promise<boolean> }>()
  const watch = (context: ManagerRendererChannelContext) => {
    const existing = watched.get(context.rendererId)
    if (existing) {
      if (existing.signal !== context.signal) throw new Error('CHANNEL_CREDENTIAL_UNAVAILABLE')
      return
    }
    const state: { signal: AbortSignal; retirement?: Promise<boolean> } = { signal: context.signal }
    watched.set(context.rendererId, state)
    const retire = () => {
      state.retirement ??= Promise.resolve().then(async () => {
        const result = object(
          await input.handle({
            kind: 'manager-channel-credentials',
            action: 'retire',
            sessionId: context.rendererId,
          }),
        )
        return result?.status === 'retired'
      }).catch(() => false)
    }
    context.signal.addEventListener('abort', retire, { once: true })
    if (context.signal.aborted) retire()
  }
  const channel: ManagerRendererChannel = {
    prepare(payload, context) {
      if (
        context.admitted !== true || context.signal.aborted || context.profileId !== input.profileId
        || context.ownerGeneration !== input.generation
      ) throw new Error('CHANNEL_CREDENTIAL_UNAVAILABLE')
      const request = parse(payload, context)
      return {
        mode: 'write',
        dispatch: async () => {
          const requests = seen.get(context.signal) ?? new Set<string>()
          if (context.signal.aborted || requests.has(request.requestId) || requests.size >= 4096) {
            throw new Error('CHANNEL_CREDENTIAL_UNAVAILABLE')
          }
          requests.add(request.requestId)
          seen.set(context.signal, requests)
          watch(context)
          const identity = await input.bootstrap.configuredChannelServiceIdentity(context)
          const operation = request.operation
          if (operation.action !== 'commit') {
            const generation = input.service.generation()
            if (!generation) throw new Error('CHANNEL_CREDENTIAL_UNAVAILABLE')
            const dispatched = operation.action === 'capture'
              ? { ...operation, serviceGeneration: generation }
              : operation
            const result = project(await input.handle(dispatched), operation)
            if (operation.action === 'discard' && result.code === 'CREDENTIAL_CLEANUP_UNAVAILABLE') {
              throw new Error('CHANNEL_CREDENTIAL_RESULT_UNKNOWN')
            }
            const confirmed = await input.bootstrap.configuredChannelServiceIdentity(context, identity.alias)
            if (confirmed.source !== identity.source || context.signal.aborted) {
              throw new Error('CHANNEL_CREDENTIAL_RESULT_UNKNOWN')
            }
            return { requestId: request.requestId, ok: true, value: result }
          }
          let origin: Awaited<ReturnType<typeof fenceManagerOrigin>>
          try {
            origin = await fenceManagerOrigin({
              sessions: input.sessions(),
              participants: input.participants,
              lifecycle: input.lifecycle,
              allowAdditionalManagers: true,
            })
          } catch {
            return {
              requestId: request.requestId,
              ok: true,
              value: { status: 'unavailable', code: 'PROFILE_COORDINATION_UNAVAILABLE' },
            }
          }
          try {
            const confirmed = await input.bootstrap.configuredChannelServiceIdentity(context, identity.alias)
            if (!origin.isCurrent() || confirmed.source !== identity.source) {
              throw new Error('CHANNEL_CREDENTIAL_RESULT_UNKNOWN')
            }
            let outcome: CredentialResult | undefined
            await input.bootstrap.mutateConfiguredChannel(origin, async () => {
              outcome = project(await input.handle(operation), operation)
              const generation = input.service.generation()
              if (!generation) throw new Error('CHANNEL_CREDENTIAL_RESULT_UNKNOWN')
              const api = channelConfigurationApi({
                token: ownerToken,
                profileId: input.profileId,
                generation: input.generation,
                configPath: input.configPath,
                plugin: input.plugin,
                service: input.service,
                persistence: input.authority.persistence,
                expectedServiceGeneration: generation,
              })
              try {
                const descriptor = await input.authority.withOwner(async () => await api.descriptor())
                if (
                  !descriptor || descriptor.identity.source !== identity.source
                  || descriptor.revision !== descriptor.lastGoodRevision || !origin.isCurrent()
                ) throw new Error('CHANNEL_CREDENTIAL_RESULT_UNKNOWN')
                const base = {
                  contract: 'cordisx.service-config-result/v1' as const,
                  schemaVersion: 1 as const,
                  identity: descriptor.identity,
                  scope: descriptor.scope,
                  revision: descriptor.revision,
                }
                return outcome.status === 'applied'
                  ? {
                    ...base,
                    status: 'applied' as const,
                    configApplies: 'service-restart' as const,
                    serviceGeneration: generation,
                  }
                  : {
                    ...base,
                    status: 'rejected' as const,
                    error: { code: 'stale-generation' as const, message: 'Channel configuration was not changed.' },
                  }
              } finally {
                api.dispose()
              }
            })
            if (!outcome) throw new Error('CHANNEL_CREDENTIAL_RESULT_UNKNOWN')
            const projection = outcome.status === 'applied'
              ? await input.bootstrap.configuredChannelProjection(context)
              : undefined
            if (!origin.release()) throw new Error('CHANNEL_CREDENTIAL_RESULT_UNKNOWN')
            return {
              requestId: request.requestId,
              ok: true,
              value: { ...outcome, ...(projection === undefined ? {} : { projection }) },
            }
          } catch {
            origin.fence()
            throw new Error('CHANNEL_CREDENTIAL_RESULT_UNKNOWN')
          }
        },
      }
    },
  }
  return {
    channel,
    async waitForRetirement(rendererId) {
      const state = watched.get(rendererId)
      if (!state) return true
      if (!state.signal.aborted || !state.retirement) return false
      try {
        return await state.retirement
      } finally {
        watched.delete(rendererId)
      }
    },
  }
}
