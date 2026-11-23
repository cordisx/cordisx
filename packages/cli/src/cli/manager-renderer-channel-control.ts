import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { LocalChannelService } from '../launcher/channel-service.js'
import type { CordisXConfigPlugin } from '../launcher/config.js'
import type { HostServiceConfigMutation } from '../launcher/service-config.js'
import type { ServiceRendererLifecycle } from '../launcher/service-renderer-lifecycle.js'
import type { createConfiguredChannelOwner } from './configured-channel-owner.js'
import { fenceManagerOrigin } from './manager-origin-fence.js'
import type { ManagerRendererChannel, ManagerRendererSessions } from './manager-renderer-sessions.js'
import { channelConfigurationApi } from './renderer-channel-composition.js'
import type { ServiceRendererBootstrap } from './service-renderer-bootstrap.js'
import { compactChannelHandoff } from './service-renderer-configured-channel.js'
import type { ServiceRendererParticipants } from './service-renderer-participant.js'

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Add only owner-coordinated connection enablement to the existing read-only Channel bridge. */
export function createManagerRendererChannelControl(input: {
  readonly readOnly: ManagerRendererChannel
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
}): ManagerRendererChannel {
  const ownerToken = randomBytes(32).toString('hex')
  const seen = new WeakMap<AbortSignal, Set<string>>()
  return {
    prepare(payload, context) {
      if (typeof payload !== 'string' || Buffer.byteLength(payload) > 4096) {
        throw new Error('CHANNEL_CONTROL_UNAVAILABLE')
      }
      const request = object(JSON.parse(payload))
      if (request?.action === 'snapshot') return input.readOnly.prepare(payload, context)
      const ref = object(request?.ref)
      if (
        context.admitted !== true || context.signal.aborted || context.profileId !== input.profileId
        || context.ownerGeneration !== input.generation || !request
        || Object.keys(request).some(key =>
          !['version', 'token', 'requestId', 'action', 'ref', 'expectedRevision'].includes(key)
        )
        || request.version !== 1 || request.token !== 'renderer-binding-placeholder'
        || typeof request.requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/u.test(request.requestId)
        || request.action !== 'enable' && request.action !== 'disable'
        || !Number.isSafeInteger(request.expectedRevision) || (request.expectedRevision as number) < 0
        || !ref || Object.keys(ref).length !== 3
        || Object.keys(ref).some(key => !['adapterId', 'accountId', 'tenantId'].includes(key))
        || typeof ref.adapterId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(ref.adapterId)
        || typeof ref.accountId !== 'string' || !ref.accountId.trim() || ref.accountId.length > 512
        || typeof ref.tenantId !== 'string' || !ref.tenantId.trim() || ref.tenantId.length > 512
        || /[\u0000-\u001f\u007f]/u.test(ref.accountId + ref.tenantId)
      ) throw new Error('CHANNEL_CONTROL_UNAVAILABLE')
      const requestId = request.requestId
      const expectedRevision = request.expectedRevision as number
      const desired = request.action === 'enable'
      const target = { adapterId: ref.adapterId, accountId: ref.accountId, tenantId: ref.tenantId }
      return {
        mode: 'write',
        dispatch: async () => {
          const requests = seen.get(context.signal) ?? new Set<string>()
          if (context.signal.aborted || requests.has(requestId) || requests.size >= 4096) {
            throw new Error('CHANNEL_CONTROL_UNAVAILABLE')
          }
          requests.add(requestId)
          seen.set(context.signal, requests)
          const identity = await input.bootstrap.configuredChannelServiceIdentity(context)
          let origin: Awaited<ReturnType<typeof fenceManagerOrigin>>
          try {
            origin = await fenceManagerOrigin({
              sessions: input.sessions(),
              participants: input.participants,
              lifecycle: input.lifecycle,
              allowAdditionalManagers: true,
            })
          } catch {
            return { requestId, ok: true, value: { status: 'unavailable', code: 'PROFILE_COORDINATION_UNAVAILABLE' } }
          }
          let api: ReturnType<typeof channelConfigurationApi> | undefined
          try {
            const confirmed = await input.bootstrap.configuredChannelServiceIdentity(context, identity.alias)
            const serviceGeneration = input.service.generation()
            if (!origin.isCurrent() || confirmed.source !== identity.source || !serviceGeneration) {
              throw new Error('CHANNEL_CONTROL_UNAVAILABLE')
            }
            api = channelConfigurationApi({
              token: ownerToken,
              profileId: input.profileId,
              generation: input.generation,
              configPath: input.configPath,
              plugin: input.plugin,
              service: input.service,
              persistence: input.authority.persistence,
              expectedServiceGeneration: serviceGeneration,
            })
            const result = await input.bootstrap.mutateConfiguredChannel(origin, async () => {
              const value = await input.authority.withOwner(async () => {
                const descriptor = await api!.descriptor()
                const base = {
                  contract: 'cordisx.service-config-result/v1' as const,
                  schemaVersion: 1 as const,
                  identity: descriptor.identity,
                  scope: descriptor.scope,
                  revision: descriptor.revision,
                }
                if (descriptor.revision !== expectedRevision) {
                  return {
                    ...base,
                    status: 'conflict' as const,
                    error: { code: 'conflict' as const, message: 'Stale revision.' },
                  }
                }
                const configuration = object(descriptor.configuration)
                const connections = configuration?.connections
                if (!descriptor.writable || !Array.isArray(connections)) throw new Error('CHANNEL_CONTROL_UNAVAILABLE')
                const matches = connections.filter(item => isDeepStrictEqual(object(item)?.ref, target))
                const selected = object(matches[0])
                if (
                  matches.length !== 1 || !selected || typeof selected.enabled !== 'boolean'
                  || selected.enabled === desired
                ) {
                  return {
                    ...base,
                    status: 'rejected' as const,
                    error: { code: 'validation-failed' as const, message: 'Connection state changed.' },
                  }
                }
                if (!origin.isCurrent() || input.service.generation() !== serviceGeneration) {
                  throw new Error('CHANNEL_CONTROL_UNAVAILABLE')
                }
                return await api!.mutate({
                  contract: 'cordisx.service-config-mutation/v1',
                  schemaVersion: 1,
                  identity: descriptor.identity,
                  scope: descriptor.scope,
                  expectedRevision,
                  configuration: {
                    ...configuration,
                    connections: connections.map(item =>
                      item === matches[0] ? { ...selected, enabled: desired } : item
                    ),
                  } as HostServiceConfigMutation['configuration'],
                })
              })
              if (!value) throw new Error('CHANNEL_CONTROL_UNAVAILABLE')
              return value
            })
            const projection = result.status === 'applied'
              ? compactChannelHandoff(await input.bootstrap.configuredChannelProjection(context))
              : undefined
            if (projection && Buffer.byteLength(JSON.stringify(projection)) > 230 * 1024) {
              throw new Error('CHANNEL_CONTROL_RESULT_UNKNOWN')
            }
            if (!origin.release()) throw new Error('CHANNEL_CONTROL_RESULT_UNKNOWN')
            return {
              requestId,
              ok: true,
              value: result.status === 'applied'
                ? { status: 'applied', channelProjection: projection }
                : {
                  status: 'unavailable',
                  code: result.status === 'conflict' ? 'REVISION_CONFLICT' : 'CONNECTION_CONFIGURATION_UNAVAILABLE',
                },
            }
          } catch {
            origin.fence()
            throw new Error('CHANNEL_CONTROL_RESULT_UNKNOWN')
          } finally {
            api?.dispose()
          }
        },
      }
    },
  }
}
