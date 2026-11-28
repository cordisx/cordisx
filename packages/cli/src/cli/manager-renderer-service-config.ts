import { randomBytes } from 'node:crypto'
import { parseServiceConfigBindingRequest } from '../launcher/service-config-rpc.js'
import type { HostServiceConfigMutation, HostServiceConfigMutationResult } from '../launcher/service-config.js'
import type { LocalChannelService } from '../launcher/channel-service.js'
import type { CordisXConfigPlugin } from '../launcher/config.js'
import type { ServiceRendererLifecycle } from '../launcher/service-renderer-lifecycle.js'
import type { ManagerRendererChannel } from './manager-renderer-sessions.js'
import type { ManagerRendererSessions } from './manager-renderer-sessions.js'
import type { ServiceRendererParticipants } from './service-renderer-participant.js'
import type { ServiceRendererBootstrap } from './service-renderer-bootstrap.js'
import type { createConfiguredChannelOwner } from './configured-channel-owner.js'
import { fenceManagerOrigin } from './manager-origin-fence.js'
import { channelConfigurationApi } from './renderer-channel-composition.js'
import { isManagerChannelFormMutation } from './manager-channel-config-scope.js'

const TOKEN = 'renderer-binding-placeholder'

function unavailable(request: HostServiceConfigMutation): HostServiceConfigMutationResult {
  return {
    contract: 'cordisx.service-config-result/v1',
    schemaVersion: 1,
    identity: request.identity,
    scope: request.scope,
    revision: request.expectedRevision,
    status: 'rejected',
    error: { code: 'stale-generation', message: 'Channel configuration is currently in use.' },
  }
}

/** Owner-only service configuration for the exact Channel and authenticated Manager. */
export function createManagerRendererServiceConfigChannel(input: {
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
  const seen = new WeakMap<AbortSignal, Set<string>>()
  const ownerToken = randomBytes(32).toString('hex')
  return {
    prepare(payload, context) {
      if (
        typeof payload !== 'string' || Buffer.byteLength(payload) > 200 * 1024 || context.admitted !== true
        || context.signal.aborted || context.profileId !== input.profileId
        || context.ownerGeneration !== input.generation
      ) throw new Error('SERVICE_CONFIG_UNAVAILABLE')
      const request = parseServiceConfigBindingRequest(JSON.parse(payload), TOKEN, input.profileId, input.generation)
      if (
        request.operation === 'list' && request.pluginId !== 'channel'
        || request.operation === 'mutate'
          && (request.mutation.identity.pluginId !== 'channel' || request.mutation.identity.serviceId !== 'runtime')
      ) throw new Error('SERVICE_CONFIG_UNAVAILABLE')
      return {
        mode: request.operation === 'list' ? 'read' : 'write',
        dispatch: async () => {
          const requests = seen.get(context.signal) ?? new Set<string>()
          if (context.signal.aborted || requests.has(request.requestId) || requests.size >= 4096) {
            throw new Error('SERVICE_CONFIG_UNAVAILABLE')
          }
          requests.add(request.requestId)
          seen.set(context.signal, requests)
          const alias = request.operation === 'mutate' ? request.mutation.identity.source : undefined
          const identity = await input.bootstrap.configuredChannelServiceIdentity(context, alias)
          if (request.operation === 'list') {
            const api = channelConfigurationApi({
              token: ownerToken,
              profileId: input.profileId,
              generation: input.generation,
              configPath: input.configPath,
              plugin: input.plugin,
              service: input.service,
              persistence: input.authority.persistence,
            })
            try {
              const descriptor = await input.authority.withOwner(async () => await api.descriptor())
              const confirmed = await input.bootstrap.configuredChannelServiceIdentity(context, identity.alias)
              if (
                !descriptor || confirmed.source !== identity.source || descriptor.identity.source !== identity.source
              ) {
                throw new Error('SERVICE_CONFIG_UNAVAILABLE')
              }
              return {
                requestId: request.requestId,
                ok: true,
                value: [{ ...descriptor, identity: { ...descriptor.identity, source: identity.alias } }],
              }
            } finally {
              api.dispose()
            }
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
            return { requestId: request.requestId, ok: true, value: unavailable(request.mutation) }
          }
          let api: ReturnType<typeof channelConfigurationApi> | undefined
          try {
            const confirmed = await input.bootstrap.configuredChannelServiceIdentity(context, identity.alias)
            const serviceGeneration = input.service.generation()
            if (!origin.isCurrent() || confirmed.source !== identity.source || !serviceGeneration) {
              throw new Error('SERVICE_CONFIG_UNAVAILABLE')
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
            const mutation = {
              ...request.mutation,
              identity: { ...request.mutation.identity, source: identity.source },
            }
            const result = await input.bootstrap.mutateConfiguredChannel(origin, async () => {
              const value = await input.authority.withOwner(async () => {
                const descriptor = await api!.descriptor()
                const base = {
                  contract: 'cordisx.service-config-result/v1' as const,
                  schemaVersion: 1 as const,
                  identity: mutation.identity,
                  scope: mutation.scope,
                  revision: descriptor.revision,
                }
                if (descriptor.revision !== mutation.expectedRevision) {
                  return {
                    ...base,
                    status: 'conflict' as const,
                    error: { code: 'conflict' as const, message: 'Channel configuration changed.' },
                  }
                }
                if (!isManagerChannelFormMutation(descriptor.configuration, mutation.configuration)) {
                  return {
                    ...base,
                    status: 'rejected' as const,
                    error: {
                      code: 'validation-failed' as const,
                      message: 'Channel configuration is outside this form.',
                    },
                  }
                }
                if (!origin.isCurrent() || input.service.generation() !== serviceGeneration) {
                  throw new Error('SERVICE_CONFIG_UNAVAILABLE')
                }
                return await api!.mutate(mutation)
              })
              if (!value) throw new Error('SERVICE_CONFIG_UNAVAILABLE')
              return value
            })
            if (!origin.release()) throw new Error('SERVICE_CONFIG_RESULT_UNKNOWN')
            const projected = {
              ...result,
              identity: { ...result.identity, source: identity.alias },
              ...(result.status === 'rejected' || result.status === 'conflict'
                ? { error: { code: result.error.code, message: 'Channel configuration could not be saved.' } }
                : {}),
            }
            return { requestId: request.requestId, ok: true, value: projected }
          } catch {
            origin.fence()
            throw new Error('SERVICE_CONFIG_RESULT_UNKNOWN')
          } finally {
            api?.dispose()
          }
        },
      }
    },
  }
}
