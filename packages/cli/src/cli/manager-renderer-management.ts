import {
  handlePluginManagementRpcRequest,
  MAX_MANAGEMENT_REQUEST_BYTES,
  parsePluginManagementRpcRequest,
} from '../launcher/management-rpc.js'
import type { PluginManagementService } from '../management/service.js'
import type { ManagerRendererChannel } from './manager-renderer-sessions.js'

/**
 * Project only the existing management operations. Mutations require this
 * exact renderer to have joined the owner's live lifecycle federation.
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
      // The outer authenticated session, not a renderer-controlled token, is
      // the authority. Normalize the legacy binding token only for its parser.
      const parserToken = 'owner-internal-parser-sentinel'
      const request = parsePluginManagementRpcRequest({ ...item, token: parserToken }, {
        token: parserToken,
        profileId: context.profileId,
      })
      const kind = request.operation.kind
      const reads = ['query', 'query-catalog', 'plugin-info']
      const writes = ['refresh-catalog', 'plan', 'execute', 'migrate-legacy-sources']
      const keys: Readonly<Record<string, readonly string[]>> = {
        query: ['kind'],
        'query-catalog': ['kind', 'query'],
        'plugin-info': ['kind', 'query'],
        'refresh-catalog': ['kind', 'sourceUrl'],
        plan: ['kind', 'request'],
        execute: ['kind', 'request', 'expectedRevision'],
        'migrate-legacy-sources': ['kind', 'input'],
      }
      if (
        !reads.includes(kind) && !writes.includes(kind) || writes.includes(kind) && context.admitted !== true
        || Object.keys(request.operation).some(key => !keys[kind]?.includes(key))
      ) {
        throw new Error('MANAGER_RENDERER_UNAVAILABLE')
      }
      return {
        mode: writes.includes(kind) ? 'write' : 'read',
        dispatch: async () => ({
          requestId: request.requestId,
          ok: true,
          value: await handlePluginManagementRpcRequest(service, request),
        }),
      }
    },
  }
}
