import type { JsonValue } from '../config/home-config.js'
import type {
  ChannelManagerActionResult,
  ChannelManagerApi,
  ChannelManagerConnectionActionInput,
} from './channel-manager-api.js'
import type { LocalChannelService } from './channel-service.js'
import type { HostServiceConfigNarrowApi } from './service-config.js'

/** Enable/disable are saved preferences; reconnect affects only the current transport. */
export function configuredChannelManager(input: {
  readonly service: LocalChannelService
  /** The returned API must fence its restart to this exact owning runtime generation. */
  readonly configuration?: (generation: string) => HostServiceConfigNarrowApi
}): ChannelManagerApi {
  const result = (status: ChannelManagerActionResult['status'], code?: string): ChannelManagerActionResult => {
    const generation = input.service.generation(), projection = input.service.manager.snapshot()
    return {
      status,
      ...(code === undefined ? {} : { code }),
      ...(generation === undefined ? {} : { generation }),
      ...(projection === undefined ? {} : { projection }),
    }
  }
  const setEnabled = async (
    request: ChannelManagerConnectionActionInput,
    enabled: boolean,
  ): Promise<ChannelManagerActionResult> => {
    const generation = input.service.generation()
    if (generation === undefined || request.generation !== undefined && request.generation !== generation) {
      return result('unavailable', 'STALE_GENERATION')
    }
    if (input.configuration === undefined) return result('unavailable', 'CONNECTION_CONFIGURATION_UNAVAILABLE')
    const configuration = input.configuration(generation)
    try {
      const descriptor = await configuration.descriptor()
      if (input.service.generation() !== generation) return result('unavailable', 'STALE_GENERATION')
      if (!descriptor.writable) return result('unavailable', 'PERMISSION_DENIED')
      if (
        request.expectedRevision !== undefined && (!Number.isSafeInteger(request.expectedRevision)
          || request.expectedRevision < 0 || request.expectedRevision !== descriptor.revision)
      ) {
        return result('unavailable', 'REVISION_CONFLICT')
      }
      const stored = descriptor.configuration as { connections: Array<Record<string, JsonValue>> }
      const index = stored.connections.findIndex(connection => {
        const ref = connection.ref as Record<string, JsonValue>
        return ref.adapterId === request.ref.adapterId && ref.accountId === request.ref.accountId
          && ref.tenantId === request.ref.tenantId
      })
      if (index < 0) return result('not-found')
      const mutation = await configuration.mutate({
        contract: 'cordisx.service-config-mutation/v1',
        schemaVersion: 1,
        identity: descriptor.identity,
        scope: descriptor.scope,
        expectedRevision: request.expectedRevision ?? descriptor.revision,
        configuration: {
          ...stored,
          connections: stored.connections.map((connection, candidate) =>
            candidate === index ? { ...connection, enabled } : connection
          ),
        },
      })
      if (mutation.status === 'applied') return result('applied')
      return result(
        'unavailable',
        mutation.status === 'conflict'
          ? 'REVISION_CONFLICT'
          : mutation.status === 'staged'
          ? 'CONNECTION_CONFIGURATION_FAILED'
          : mutation.error.code.toUpperCase().replaceAll('-', '_'),
      )
    } catch {
      return result('unavailable', 'CONNECTION_CONFIGURATION_FAILED')
    } finally {
      configuration.dispose()
    }
  }
  return Object.freeze({
    ...input.service.manager,
    connections: Object.freeze({
      enable: (request: ChannelManagerConnectionActionInput) => setEnabled(request, true),
      disable: (request: ChannelManagerConnectionActionInput) => setEnabled(request, false),
      reconnect: input.service.manager.connections.reconnect,
    }),
  })
}
