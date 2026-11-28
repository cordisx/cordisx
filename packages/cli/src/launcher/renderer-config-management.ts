import type { ConfigMutationOperation, ManagerPluginConfigSnapshot } from '../renderer/configuration/model.js'
import type { CordisXPluginActivationRecordV1 } from '../plugin-lifecycle-contracts.js'
import type {
  HostServiceConfigDescriptor,
  HostServiceConfigMutation,
  HostServiceConfigMutationResult,
} from './service-config.js'
import { type CdpSession, evaluateRuntimeOperation } from './cdp-session.js'

/** Host-private RPC. Plugin schema and service authority remain in the admitted renderer. */
export type RendererConfigOperation =
  | { readonly kind: 'plugin-configuration'; readonly action: 'list' }
  | { readonly kind: 'plugin-configuration'; readonly action: 'read' | 'services'; readonly pluginId: string }
  | {
    readonly kind: 'plugin-configuration'
    readonly action: 'update'
    readonly pluginId: string
    readonly expectedRevision: number
    readonly operations: readonly ConfigMutationOperation[]
  }
  | {
    readonly kind: 'plugin-configuration'
    readonly action: 'update-service'
    readonly pluginId: string
    readonly mutation: HostServiceConfigMutation
  }

export type RendererConfigResult =
  | {
    readonly status: 'ok'
    readonly plugins: readonly {
      readonly id: string
      readonly name: string
      readonly status: string
      readonly writable: boolean
    }[]
  }
  | { readonly status: 'ok'; readonly configuration: ManagerPluginConfigSnapshot }
  | { readonly status: 'ok'; readonly services: readonly HostServiceConfigDescriptor[] }
  | { readonly status: 'ok'; readonly result: HostServiceConfigMutationResult }
  | { readonly status: 'rejected' | 'unavailable' | 'unknown'; readonly reason: string }

/** Private Desktop-owner readback; never published as a renderer capability. */
export interface DesktopManagerConfigProof {
  readonly snapshot: { readonly active: CordisXPluginActivationRecordV1; readonly registryEpoch: number }
  readonly plugin: {
    readonly id: string
    readonly source: string
    readonly package?: {
      readonly version: string
      readonly digest: string
      readonly moduleGeneration: string
      readonly dependencies: readonly string[]
      readonly canonicalSource?: string
    }
    readonly configured?: {
      readonly version: string
      readonly integrity: string
      readonly moduleGeneration: string
    }
    readonly configuration: ManagerPluginConfigSnapshot
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid plugin configuration request')
  }
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('invalid plugin configuration request')
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,95}$/u.test(value)
}

/** The existing Desktop runtime supplies its redacted schema projection and exact generation. */
export function desktopManagerConfigProofExpression(pluginId: string): string {
  if (!identifier(pluginId)) throw new Error('invalid plugin configuration request')
  return `(() => {
    const runtime = globalThis.__cordisxRuntime;
    if (!runtime?.activePluginGeneration || !runtime?.pluginRegistryEpoch || !runtime?.snapshot) return { ok: true };
    const plugin = runtime.snapshot().plugins.find(item => item.id === ${JSON.stringify(pluginId)});
    if (!plugin?.configuration) return { ok: true };
    const configured = plugin.package ? undefined : runtime.configuredPluginProvenance?.(plugin.id);
    if (!plugin.package && !configured) return { ok: true };
    return { ok: true, result: {
      snapshot: { active: runtime.activePluginGeneration(), registryEpoch: runtime.pluginRegistryEpoch() },
      plugin: { id: plugin.id, source: plugin.source, package: plugin.package, configured, configuration: plugin.configuration }
    } };
  })()`
}

function revision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

export function parseRendererConfigOperation(value: unknown, profileId: string): RendererConfigOperation {
  const input = record(value)
  if (input.kind !== 'plugin-configuration') {
    throw new Error('invalid plugin configuration request')
  }
  if (input.action === 'list') {
    exact(input, ['kind', 'action'])
    return input as unknown as RendererConfigOperation
  }
  if (!identifier(input.pluginId)) throw new Error('invalid plugin configuration request')
  if (input.action === 'read' || input.action === 'services') {
    exact(input, ['kind', 'action', 'pluginId'])
  } else if (input.action === 'update') {
    exact(input, ['kind', 'action', 'pluginId', 'expectedRevision', 'operations'])
    if (
      !revision(input.expectedRevision) || !Array.isArray(input.operations)
      || input.operations.length === 0 || input.operations.length > 100
    ) {
      throw new Error('invalid plugin configuration mutation')
    }
    for (const item of input.operations) {
      const operation = record(item)
      if (operation.op !== 'set' && operation.op !== 'unset') throw new Error('invalid plugin configuration mutation')
      exact(operation, operation.op === 'set' ? ['op', 'path', 'value'] : ['op', 'path'])
      if (
        !Array.isArray(operation.path) || operation.path.length === 0 || operation.path.length > 32
        || operation.path.some(part =>
          typeof part !== 'string' || part.length === 0 || part.length > 128
          || ['__proto__', 'prototype', 'constructor'].includes(part)
        )
        || operation.op === 'set' && !Object.hasOwn(operation, 'value')
      ) {
        throw new Error('invalid plugin configuration mutation')
      }
    }
  } else if (input.action === 'update-service') {
    exact(input, ['kind', 'action', 'pluginId', 'mutation'])
    const mutation = record(input.mutation)
    exact(mutation, ['contract', 'schemaVersion', 'identity', 'scope', 'expectedRevision', 'configuration'])
    const identity = record(mutation.identity)
    const scope = record(mutation.scope)
    exact(identity, ['source', 'pluginId', 'serviceId'])
    exact(scope, ['profileId', 'generation'])
    if (
      mutation.contract !== 'cordisx.service-config-mutation/v1' || mutation.schemaVersion !== 1
      || identity.pluginId !== input.pluginId || !identifier(identity.serviceId)
      || typeof identity.source !== 'string' || identity.source.length === 0 || identity.source.length > 4096
      || scope.profileId !== profileId || typeof scope.generation !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(scope.generation)
      || !revision(mutation.expectedRevision) || !Object.hasOwn(mutation, 'configuration')
    ) {
      throw new Error('invalid service configuration mutation')
    }
  } else throw new Error('invalid plugin configuration action')
  return input as unknown as RendererConfigOperation
}

/** Data is decoded as JSON, never interpolated as executable JavaScript. */
export function rendererConfigExpression(operation: RendererConfigOperation): string {
  const encoded = JSON.stringify(JSON.stringify(operation)).replaceAll('\u2028', '\\u2028').replaceAll(
    '\u2029',
    '\\u2029',
  )
  return `(async () => {
    const request = JSON.parse(${encoded});
    const runtime = globalThis.__cordisxRuntime;
    if (!runtime) return { ok: true, result: { status: 'unavailable', reason: 'renderer-unavailable' } };
    try {
      if (request.action === 'list') return { ok: true, result: { status: 'ok', plugins: runtime.snapshot().plugins.map(item => ({ id: item.id, name: item.name, status: item.status, writable: item.configuration.writable })) } };
      const plugin = runtime.snapshot().plugins.find(item => item.id === request.pluginId);
      if (!plugin) return { ok: true, result: { status: 'rejected', reason: 'plugin-unavailable' } };
      if (request.action === 'read') return { ok: true, result: { status: 'ok', configuration: plugin.configuration } };
      if (request.action === 'services') return { ok: true, result: { status: 'ok', services: await runtime.listServiceConfigs(request.pluginId) } };
      if (request.action === 'update-service') {
        const result = await runtime.updateServiceConfig(request.mutation);
        return { ok: true, result: { status: 'ok', result } };
      }
      if (!plugin.configuration.writable) return { ok: true, result: { status: 'rejected', reason: 'configuration-read-only' } };
      if (plugin.configuration.revision !== request.expectedRevision) return { ok: true, result: { status: 'rejected', reason: 'revision-conflict' } };
      await runtime.updatePluginConfig(request.pluginId, request.expectedRevision, request.operations);
      const current = runtime.snapshot().plugins.find(item => item.id === request.pluginId);
      if (!current) return { ok: true, result: { status: 'unknown', reason: 'plugin-disappeared' } };
      return { ok: true, result: { status: 'ok', configuration: current.configuration } };
    } catch {
      return { ok: true, result: { status: request.action === 'read' || request.action === 'services' || request.action === 'list' ? 'unavailable' : 'unknown', reason: 'renderer-operation-failed' } };
    }
  })()`
}

export async function evaluateRendererConfig(
  session: CdpSession,
  operation: RendererConfigOperation,
): Promise<RendererConfigResult> {
  return await evaluateRuntimeOperation<RendererConfigResult>(session, rendererConfigExpression(operation), 30_000)
}
