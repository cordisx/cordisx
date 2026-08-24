import {
  CORDISX_PLUGIN_LIFECYCLE_OPERATION_SCHEMA_V1,
  type CordisXPluginLifecycleRequestV1,
  type CordisXPluginLifecycleResultV1,
} from '../plugin-lifecycle-contracts.js'
import type { PluginLifecycleCoordinator } from './plugin-lifecycle.js'

export const PLUGIN_LIFECYCLE_BINDING = '__cordisxPluginLifecycleRequestV1'
export const PLUGIN_LIFECYCLE_RECEIVER = '__cordisxPluginLifecycleReceiveV1'
export const MAX_PLUGIN_LIFECYCLE_REQUEST_BYTES = 256 * 1024

export interface PluginLifecycleBridgeHandler {
  readonly token: string
  readonly profileId: string
  readonly generation: string
  readonly coordinator: PluginLifecycleCoordinator
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

/** Validate the Host-only envelope before passing a protocol request to the coordinator. */
export function parsePluginLifecycleBindingRequest(
  value: unknown,
  handler: PluginLifecycleBridgeHandler,
): CordisXPluginLifecycleRequestV1 {
  const envelope = object(value, 'plugin lifecycle bridge request')
  if (envelope.token !== handler.token) throw new Error('plugin lifecycle bridge token mismatch')
  const request = object(envelope.request, 'plugin lifecycle request')
  if (request.$schema !== CORDISX_PLUGIN_LIFECYCLE_OPERATION_SCHEMA_V1 || request.schemaVersion !== 1) {
    throw new Error('plugin lifecycle request schema is unsupported')
  }
  if (typeof request.requestId !== 'string' || !/^[a-z0-9-]{1,96}$/i.test(request.requestId)) {
    throw new Error('plugin lifecycle request id is invalid')
  }
  if (request.profileId !== handler.profileId || request.runtimeGeneration !== handler.generation) {
    throw new Error('plugin lifecycle request scope is stale')
  }
  if (!Number.isInteger(request.expectedRevision) || (request.expectedRevision as number) < 0) {
    throw new Error('plugin lifecycle expectedRevision is invalid')
  }
  const operation = object(request.operation, 'plugin lifecycle operation')
  if (!['inspect-local', 'install', 'update', 'enable', 'reload', 'disable', 'uninstall'].includes(String(operation.kind))) {
    throw new Error('plugin lifecycle operation is unsupported')
  }
  return request as unknown as CordisXPluginLifecycleRequestV1
}

export async function handlePluginLifecycleBindingRequest(
  handler: PluginLifecycleBridgeHandler,
  request: CordisXPluginLifecycleRequestV1,
): Promise<CordisXPluginLifecycleResultV1> {
  return await handler.coordinator.handle(request)
}
