import {
  CORDISX_PLUGIN_LIFECYCLE_OPERATION_SCHEMA_V1,
  type CordisXPluginLifecycleRequestV1,
  type CordisXPluginLifecycleResultV1,
} from '../plugin-lifecycle-contracts.js'
import type { PluginLifecycleCoordinator } from './plugin-lifecycle.js'
import type {
  HostPermissionLifecycleApplyV2Request,
  HostPermissionLifecycleApplyV4Request,
  HostPermissionLifecycleReviewV2Request,
  HostPermissionLifecycleReviewV4Request,
} from './plugin-lifecycle.js'
import type {
  CordisXPermissionAuthorizationPlanV2,
  CordisXPermissionAuthorizationPlanV4,
} from '../permission-contracts.js'
import {
  CORDISX_PLUGIN_BUNDLE_LIFECYCLE_OPERATION_SCHEMA_V1,
  type CordisXPluginBundleLifecycleRequestV1,
  type CordisXPluginBundleLifecycleResultV1,
  type CordisXPluginBundleManagerSnapshotV1,
} from '../plugin-bundle-contracts.js'
import type { PluginBundleCoordinator } from './plugin-bundle.js'

export const PLUGIN_LIFECYCLE_BINDING = '__cordisxPluginLifecycleRequestV1'
export const PLUGIN_LIFECYCLE_RECEIVER = '__cordisxPluginLifecycleReceiveV1'
export const MAX_PLUGIN_LIFECYCLE_REQUEST_BYTES = 256 * 1024

export interface PluginLifecycleBridgeHandler {
  readonly token: string
  readonly profileId: string
  readonly generation: string
  readonly coordinator: PluginLifecycleCoordinator
  readonly bundleCoordinator?: PluginBundleCoordinator
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

function requireKeys(value: Record<string, unknown>, required: readonly string[], label: string): void {
  const missing = required.find(key => !(key in value))
  if (missing !== undefined) throw new Error(`${label}.${missing} is required`)
}

export type PluginLifecycleBindingRequest =
  | { readonly kind: 'protocol-v1'; readonly requestId: string; readonly request: CordisXPluginLifecycleRequestV1 }
  | {
    readonly kind: 'permission-review-plan-v2'
    readonly requestId: string
    readonly request: HostPermissionLifecycleReviewV2Request
  }
  | {
    readonly kind: 'permission-review-apply-v2'
    readonly requestId: string
    readonly request: HostPermissionLifecycleApplyV2Request
  }
  | {
    readonly kind: 'permission-review-plan-v4'
    readonly requestId: string
    readonly request: HostPermissionLifecycleReviewV4Request
  }
  | {
    readonly kind: 'permission-review-apply-v4'
    readonly requestId: string
    readonly request: HostPermissionLifecycleApplyV4Request
  }
  | { readonly kind: 'bundle-snapshot-v1'; readonly requestId: string }
  | {
    readonly kind: 'bundle-operation-v1'
    readonly requestId: string
    readonly request: CordisXPluginBundleLifecycleRequestV1
  }

function parseBundleRequest(
  value: unknown,
  handler: PluginLifecycleBridgeHandler,
): CordisXPluginBundleLifecycleRequestV1 {
  const request = object(value, 'plugin bundle lifecycle request')
  exactKeys(request, [
    '$schema',
    'schemaVersion',
    'requestId',
    'profileId',
    'expectedRevision',
    'expectedPluginRevision',
    'runtimeGeneration',
    'operation',
  ], 'plugin bundle lifecycle request')
  if (
    request.$schema !== CORDISX_PLUGIN_BUNDLE_LIFECYCLE_OPERATION_SCHEMA_V1 || request.schemaVersion !== 1
    || request.profileId !== handler.profileId || request.runtimeGeneration !== handler.generation
    || typeof request.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.requestId)
    || !Number.isInteger(request.expectedRevision) || (request.expectedRevision as number) < 0
    || !Number.isInteger(request.expectedPluginRevision) || (request.expectedPluginRevision as number) < 0
  ) {
    throw new Error('plugin bundle lifecycle request scope is invalid')
  }
  const operation = object(request.operation, 'plugin bundle lifecycle operation')
  if (
    ![
      'inspect-source',
      'install',
      'update',
      'enable',
      'disable',
      'uninstall',
      'set-permissions',
      'set-optional-member',
      'adopt-member',
    ].includes(String(operation.kind))
  ) {
    throw new Error('plugin bundle lifecycle operation is unsupported')
  }
  const allowed = operation.kind === 'inspect-source'
    ? ['kind', 'source']
    : operation.kind === 'install' || operation.kind === 'update'
    ? ['kind', 'candidateId', 'impactToken', 'bundlePermissions', 'pluginOverrides']
    : operation.kind === 'set-permissions'
    ? ['kind', 'bundleId', 'bundlePermissions', 'pluginOverrides', 'clearPluginOverrides', 'impactToken']
    : operation.kind === 'set-optional-member'
    ? ['kind', 'bundleId', 'pluginId', 'enabled', 'impactToken']
    : operation.kind === 'adopt-member'
    ? ['kind', 'bundleId', 'pluginId', 'impactToken']
    : ['kind', 'bundleId', 'impactToken']
  exactKeys(operation, allowed, 'plugin bundle lifecycle operation')
  requireKeys(operation, allowed, 'plugin bundle lifecycle operation')
  if (operation.kind === 'inspect-source') object(operation.source, 'plugin bundle source')
  if (
    (operation.kind === 'install' || operation.kind === 'update')
    && (typeof operation.candidateId !== 'string' || typeof operation.impactToken !== 'string'
      || !Array.isArray(operation.bundlePermissions) || !Array.isArray(operation.pluginOverrides))
  ) {
    throw new Error('plugin bundle install operation is invalid')
  }
  if (
    operation.kind === 'set-permissions'
    && (typeof operation.bundleId !== 'string' || typeof operation.impactToken !== 'string'
      || !Array.isArray(operation.bundlePermissions) || !Array.isArray(operation.pluginOverrides)
      || !Array.isArray(operation.clearPluginOverrides))
  ) {
    throw new Error('plugin bundle permission operation is invalid')
  }
  if (
    (operation.kind === 'enable' || operation.kind === 'disable' || operation.kind === 'uninstall'
      || operation.kind === 'adopt-member')
    && (typeof operation.bundleId !== 'string' || typeof operation.impactToken !== 'string')
  ) {
    throw new Error('plugin bundle state operation is invalid')
  }
  if (
    operation.kind === 'set-optional-member'
    && (typeof operation.bundleId !== 'string' || typeof operation.pluginId !== 'string'
      || typeof operation.enabled !== 'boolean' || typeof operation.impactToken !== 'string')
  ) {
    throw new Error('plugin bundle optional-member operation is invalid')
  }
  return request as unknown as CordisXPluginBundleLifecycleRequestV1
}

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
    if (request.kind === 'bundle-snapshot-v1') {
      exactKeys(request, ['kind', 'requestId', 'profileId', 'runtimeGeneration'], 'Host-private plugin bundle request')
      if (
        handler.bundleCoordinator === undefined || typeof request.requestId !== 'string'
        || request.profileId !== handler.profileId || request.runtimeGeneration !== handler.generation
      ) throw new Error('plugin bundle snapshot request is unavailable or stale')
      return { kind: 'bundle-snapshot-v1', requestId: request.requestId }
    }
    if (request.kind === 'bundle-operation-v1') {
      exactKeys(
        request,
        ['kind', 'requestId', 'profileId', 'runtimeGeneration', 'request'],
        'Host-private plugin bundle request',
      )
      if (
        handler.bundleCoordinator === undefined || typeof request.requestId !== 'string'
        || request.profileId !== handler.profileId || request.runtimeGeneration !== handler.generation
      ) throw new Error('plugin bundle lifecycle request is unavailable or stale')
      const bundleRequest = parseBundleRequest(request.request, handler)
      if (bundleRequest.requestId !== request.requestId) {
        throw new Error('plugin bundle request id is not bound to its envelope')
      }
      return { kind: 'bundle-operation-v1', requestId: request.requestId, request: bundleRequest }
    }
    const scope = requestScope(request, handler)
    if (request.kind === 'permission-review-plan-v2' || request.kind === 'permission-review-plan-v4') {
      exactKeys(
        request,
        ['kind', 'requestId', 'profileId', 'runtimeGeneration', 'expectedRevision', 'target'],
        'Host-private permission lifecycle request',
      )
      const target = object(request.target, 'Host-private permission lifecycle target')
      if (
        target.kind === 'candidate' && typeof target.candidateId === 'string'
        && /^[A-Za-z0-9._:-]{1,160}$/.test(target.candidateId)
      ) {
        exactKeys(target, ['kind', 'candidateId'], 'Host-private permission lifecycle target')
        return {
          kind: request.kind,
          requestId: scope.requestId,
          request: { ...scope, target: { kind: 'candidate', candidateId: target.candidateId } },
        }
      }
      if (
        target.kind === 'enable' && typeof target.pluginId === 'string'
        && /^[a-z0-9][a-z0-9._-]{0,95}$/.test(target.pluginId)
      ) {
        exactKeys(target, ['kind', 'pluginId'], 'Host-private permission lifecycle target')
        return {
          kind: request.kind,
          requestId: scope.requestId,
          request: { ...scope, target: { kind: 'enable', pluginId: target.pluginId } },
        }
      }
      throw new Error('Host-private permission lifecycle target is invalid')
    }
    if (request.kind === 'permission-review-apply-v2') {
      exactKeys(
        request,
        ['kind', 'requestId', 'profileId', 'runtimeGeneration', 'expectedRevision', 'decision'],
        'Host-private permission lifecycle request',
      )
      return {
        kind: request.kind,
        requestId: scope.requestId,
        request: { ...scope, decision: request.decision as HostPermissionLifecycleApplyV2Request['decision'] },
      }
    }
    if (request.kind === 'permission-review-apply-v4') {
      exactKeys(
        request,
        ['kind', 'requestId', 'profileId', 'runtimeGeneration', 'expectedRevision', 'decision'],
        'Host-private permission lifecycle request',
      )
      return {
        kind: request.kind,
        requestId: scope.requestId,
        request: { ...scope, decision: request.decision as HostPermissionLifecycleApplyV4Request['decision'] },
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
  if (
    !['inspect-local', 'install', 'update', 'enable', 'reload', 'disable', 'uninstall'].includes(String(operation.kind))
  ) {
    throw new Error('plugin lifecycle operation is unsupported')
  }
  return {
    kind: 'protocol-v1',
    requestId: scope.requestId,
    request: request as unknown as CordisXPluginLifecycleRequestV1,
  }
}

export async function handlePluginLifecycleBindingRequest(
  handler: PluginLifecycleBridgeHandler,
  input: PluginLifecycleBindingRequest,
): Promise<
  | CordisXPluginLifecycleResultV1
  | CordisXPermissionAuthorizationPlanV2
  | CordisXPermissionAuthorizationPlanV4
  | CordisXPluginBundleLifecycleResultV1
  | CordisXPluginBundleManagerSnapshotV1
  | undefined
> {
  if (input.kind === 'bundle-snapshot-v1') return await handler.bundleCoordinator!.snapshot()
  if (input.kind === 'bundle-operation-v1') return await handler.bundleCoordinator!.handle(input.request)
  if (input.kind === 'protocol-v1') return await handler.coordinator.handle(input.request)
  if (input.kind === 'permission-review-plan-v2') return await handler.coordinator.permissionReviewPlanV2(input.request)
  if (input.kind === 'permission-review-plan-v4') return await handler.coordinator.permissionReviewPlanV4(input.request)
  if (input.kind === 'permission-review-apply-v2') {
    return await handler.coordinator.applyPermissionReviewV2(input.request)
  }
  return await handler.coordinator.applyPermissionReviewV4(input.request)
}
