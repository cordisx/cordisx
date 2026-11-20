import {
  handlePluginManagementRpcRequest,
  MAX_MANAGEMENT_REQUEST_BYTES,
  parsePluginManagementRpcRequest,
} from '../launcher/management-rpc.js'
import type { PluginManagementService } from '../management/service.js'
import type { ManagerRendererChannel } from './manager-renderer-sessions.js'

/**
 * A complete, deliberately read-only projection of the existing management
 * binding. Lifecycle/configuration writes require an attached renderer and its
 * coordinator participation, and are not admitted by this channel.
 */
export function createManagerRendererManagementChannel(service: PluginManagementService): ManagerRendererChannel {
  return {
    prepare(payload, context) {
      if (typeof payload !== 'string' || Buffer.byteLength(payload) > MAX_MANAGEMENT_REQUEST_BYTES) {
        throw new Error('MANAGER_RENDERER_INVALID')
      }
      const value = JSON.parse(payload) as unknown
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('MANAGER_RENDERER_INVALID')
      }
      const item = value as Record<string, unknown>
      if (
        Object.keys(item).length !== 5
        || Object.keys(item).some(key => !['version', 'requestId', 'token', 'profileId', 'operation'].includes(key))
        || item.profileId !== context.profileId || typeof item.token !== 'string' || item.token.length > 256
      ) {
        throw new Error('MANAGER_RENDERER_INVALID')
      }
      const operation = item.operation
      if (
        operation === null || typeof operation !== 'object' || Array.isArray(operation)
        || Object.keys(operation).length !== 1 || (operation as Record<string, unknown>).kind !== 'query'
      ) {
        throw new Error('MANAGER_RENDERER_UNAVAILABLE')
      }
      // The outer authenticated session, not a renderer-controlled token, is
      // the authority. Normalize the legacy binding token only for its parser.
      const parserToken = 'owner-internal-parser-sentinel'
      const request = parsePluginManagementRpcRequest({ ...item, token: parserToken }, {
        token: parserToken,
        profileId: context.profileId,
      })
      return {
        mode: 'read',
        dispatch: async () => ({
          requestId: request.requestId,
          ok: true,
          value: await handlePluginManagementRpcRequest(service, request),
        }),
      }
    },
  }
}
