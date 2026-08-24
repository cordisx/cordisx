import {
  CORDISX_PLUGIN_LIFECYCLE_OPERATION_SCHEMA_V1,
  type CordisXPluginLifecycleRequestV1,
  type CordisXPluginLifecycleResultV1,
} from '../plugin-lifecycle-contracts.js'
import type { PluginLifecycleCoordinator } from './plugin-lifecycle.js'
import type {
  HostPermissionLifecycleApplyV2Request,
  HostPermissionLifecycleReviewV2Request,
} from './plugin-lifecycle.js'
import type { CordisXPermissionAuthorizationPlanV2 } from '../permission-contracts.js'

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

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const accepted = new Set(allowed)
  const unknown = Object.keys(value).find(key => !accepted.has(key))
  if (unknown !== undefined) throw new Error(`${label}.${unknown} is unsupported`)
}

export type PluginLifecycleBindingRequest =
  | { readonly kind: 'protocol-v1'; readonly requestId: string; readonly request: CordisXPluginLifecycleRequestV1 }
  | { readonly kind: 'permission-review-plan-v2'; readonly requestId: string; readonly request: HostPermissionLifecycleReviewV2Request }
  | { readonly kind: 'permission-review-apply-v2'; readonly requestId: string; readonly request: HostPermissionLifecycleApplyV2Request }

function requestScope(
  request: Record<string, unknown>,
  handler: PluginLifecycleBridgeHandler,
): Pick<HostPermissionLifecycleReviewV2Request, 'requestId' | 'profileId' | 'runtimeGeneration' | 'expectedRevision'> {
  if (typeof request.requestId !== 'string' || !/^[a-z0-9-]{1,96}$/i.test(request.requestId)) {
    throw new Error('plugin lifecycle request id is invalid')
  }
  if (request.profileId !== handler.profileId || request.runtimeGeneration !== handler.generation) {
    throw new Error('plugin lifecycle request scope is stale')
  }
  if (!Number.isInteger(request.expectedRevision) || (request.expectedRevision as number) < 0) {
    throw new Error('plugin lifecycle expectedRevision is invalid')
  }
  return {
    requestId: request.requestId,
    profileId: handler.profileId,
    runtimeGeneration: handler.generation,
    expectedRevision: request.expectedRevision as number,
  }
}

/** Validate the Host-only envelope before passing a protocol request to the coordinator. */
export function parsePluginLifecycleBindingRequest(
  value: unknown,
  handler: PluginLifecycleBridgeHandler,
): PluginLifecycleBindingRequest {
  const envelope = object(value, 'plugin lifecycle bridge request')
  exactKeys(envelope, ['token', 'request', 'privateRequest'], 'plugin lifecycle bridge request')
  if (envelope.token !== handler.token) throw new Error('plugin lifecycle bridge token mismatch')
  if ((envelope.request === undefined) === (envelope.privateRequest === undefined)) {
    throw new Error('plugin lifecycle bridge request must select exactly one operation plane')
  }
  if (envelope.privateRequest !== undefined) {
    const request = object(envelope.privateRequest, 'Host-private permission lifecycle request')
    const scope = requestScope(request, handler)
    if (request.kind === 'permission-review-plan-v2') {
      exactKeys(request, ['kind', 'requestId', 'profileId', 'runtimeGeneration', 'expectedRevision', 'target'], 'Host-private permission lifecycle request')
      const target = object(request.target, 'Host-private permission lifecycle target')
      if (target.kind === 'candidate' && typeof target.candidateId === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(target.candidateId)) {
        exactKeys(target, ['kind', 'candidateId'], 'Host-private permission lifecycle target')
        return { kind: request.kind, requestId: scope.requestId, request: { ...scope, target: { kind: 'candidate', candidateId: target.candidateId } } }
      }
      if (target.kind === 'enable' && typeof target.pluginId === 'string' && /^[a-z0-9][a-z0-9._-]{0,95}$/.test(target.pluginId)) {
        exactKeys(target, ['kind', 'pluginId'], 'Host-private permission lifecycle target')
        return { kind: request.kind, requestId: scope.requestId, request: { ...scope, target: { kind: 'enable', pluginId: target.pluginId } } }
      }
      throw new Error('Host-private permission lifecycle target is invalid')
    }
    if (request.kind === 'permission-review-apply-v2') {
      exactKeys(request, ['kind', 'requestId', 'profileId', 'runtimeGeneration', 'expectedRevision', 'decision'], 'Host-private permission lifecycle request')
      return {
        kind: request.kind,
        requestId: scope.requestId,
        request: { ...scope, decision: request.decision as HostPermissionLifecycleApplyV2Request['decision'] },
      }
    }
    throw new Error('Host-private permission lifecycle request is unsupported')
  }
  const request = object(envelope.request, 'plugin lifecycle request')
  if (request.$schema !== CORDISX_PLUGIN_LIFECYCLE_OPERATION_SCHEMA_V1 || request.schemaVersion !== 1) {
    throw new Error('plugin lifecycle request schema is unsupported')
  }
  const scope = requestScope(request, handler)
  const operation = object(request.operation, 'plugin lifecycle operation')
  if (!['inspect-local', 'install', 'update', 'enable', 'reload', 'disable', 'uninstall'].includes(String(operation.kind))) {
    throw new Error('plugin lifecycle operation is unsupported')
  }
  return { kind: 'protocol-v1', requestId: scope.requestId, request: request as unknown as CordisXPluginLifecycleRequestV1 }
}

export async function handlePluginLifecycleBindingRequest(
  handler: PluginLifecycleBridgeHandler,
  input: PluginLifecycleBindingRequest,
): Promise<CordisXPluginLifecycleResultV1 | CordisXPermissionAuthorizationPlanV2 | undefined> {
  if (input.kind === 'protocol-v1') return await handler.coordinator.handle(input.request)
  if (input.kind === 'permission-review-plan-v2') return await handler.coordinator.permissionReviewPlanV2(input.request)
  return await handler.coordinator.applyPermissionReviewV2(input.request)
}
