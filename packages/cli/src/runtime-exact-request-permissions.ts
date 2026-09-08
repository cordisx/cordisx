import type {
  PluginManifestRuntimeExactCapabilityDeclarationV13,
  PluginManifestRuntimeExactCapabilityNameV13,
  PluginRuntimeManifestV13,
} from '@cordisx/protocol/plugin-manifest/v13'
import type { PluginRuntimeManifestV12 } from '@cordisx/protocol/plugin-manifest/v12'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V11,
  type CordisXPluginManifestV11,
  normalizeUsageManifestV11,
} from './usage-permissions.js'
import { normalizePermissionRationaleV2, normalizePermissionSecurityV2 } from './permission-model-v2.js'

export const CORDISX_PLUGIN_MANIFEST_SCHEMA_V12 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v12.schema.json' as const
export const CORDISX_PLUGIN_MANIFEST_SCHEMA_V13 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v13.schema.json' as const
export type CordisXPluginManifestV12 = Omit<PluginRuntimeManifestV12, 'services'> & {
  readonly services: CordisXPluginManifestV11['services']
}
export type CordisXPluginManifestV13 = Omit<PluginRuntimeManifestV13, 'services'> & {
  readonly services: CordisXPluginManifestV11['services']
}

const RUNTIME_EXACT = new Set<PluginManifestRuntimeExactCapabilityNameV13>([
  'tasks.content.read',
  'tasks.create',
  'tasks.control',
  'turns.submit',
  'turns.control',
])

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}

export function isRuntimeExactRequestDeclaration(
  value: unknown,
): value is PluginManifestRuntimeExactCapabilityDeclarationV13 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const declaration = value as Record<string, unknown>
  if (
    Object.keys(declaration).some(key => !['name', 'required', 'scope'].includes(key))
    || typeof declaration.name !== 'string'
    || !RUNTIME_EXACT.has(declaration.name as PluginManifestRuntimeExactCapabilityNameV13)
    || declaration.required !== false
    || declaration.scope === null || typeof declaration.scope !== 'object' || Array.isArray(declaration.scope)
  ) return false
  const scope = declaration.scope as Record<string, unknown>
  return Object.keys(scope).length === 1 && scope.runtime === 'exact-request'
}

function hostRouteBinding(value: Record<string, unknown>): boolean {
  return Object.keys(value).length === 3 && value.kind === 'host-route-param' && value.param === 'sessionId'
    && typeof value.routeId === 'string' && /^[a-z0-9][a-z0-9._-]{0,95}$/u.test(value.routeId)
}

function agentTaskDeclaration(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const declaration = value as Record<string, unknown>
  if (
    !['approvals.request', 'approvals.answer'].includes(String(declaration.name))
    || declaration.required !== false
    || Object.keys(declaration).some(key => !['name', 'required', 'scope', 'rationale', 'security'].includes(key))
    || declaration.scope === null || typeof declaration.scope !== 'object' || Array.isArray(declaration.scope)
  ) return false
  const scope = declaration.scope as Record<string, unknown>
  const field = declaration.name === 'approvals.request' ? 'task' : 'taskRequester'
  const optional = declaration.name === 'approvals.request' ? 'sessionIds' : 'authorityRequester'
  const marker = scope[field]
  if (marker === null || typeof marker !== 'object' || Array.isArray(marker)) return false
  const command = marker as Record<string, unknown>
  if (
    !(Object.keys(scope).every(key => key === field || key === optional)
      && Object.keys(command).length === 2 && command.kind === 'agent-task-command'
      && typeof command.commandId === 'string' && /^[a-z0-9][a-z0-9._-]{0,95}$/u.test(command.commandId))
  ) return false
  try {
    if (declaration.rationale !== undefined) normalizePermissionRationaleV2(declaration.rationale)
    if (declaration.security !== undefined) normalizePermissionSecurityV2(declaration.security)
  } catch {
    return false
  }
  const binding = scope[optional]
  if (binding === undefined) return true
  if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) return false
  const candidate = binding as Record<string, unknown>
  if (declaration.name === 'approvals.request') return hostRouteBinding(candidate)
  if (Object.keys(candidate).length !== 2 || candidate.kind !== 'approval-authority-requester-route') return false
  const requester = candidate.requester
  return requester !== null && typeof requester === 'object' && !Array.isArray(requester)
    && hostRouteBinding(requester as Record<string, unknown>)
}

export function normalizePluginManifestV12(value: unknown, expectedId: string): CordisXPluginManifestV12 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid manifest v12')
  const manifest = value as Record<string, unknown>
  if (
    manifest.$schema !== CORDISX_PLUGIN_MANIFEST_SCHEMA_V12 || manifest.schemaVersion !== 12
    || !Array.isArray(manifest.capabilities) || manifest.capabilities.length > 37
  ) throw new Error('Unsupported manifest v12')
  if (
    manifest.capabilities.some(candidate =>
      (candidate as { readonly scope?: { readonly runtime?: unknown } })?.scope?.runtime !== undefined
    )
  ) throw new Error('manifest v12 must not declare runtime exact-request scope')
  const task = manifest.capabilities.filter(candidate => {
    const scope = (candidate as { scope?: Record<string, unknown> })?.scope
    return scope?.task !== undefined || scope?.taskRequester !== undefined
  })
  if (task.some(candidate => !agentTaskDeclaration(candidate))) throw new Error('Invalid agent-task declaration')
  const base = normalizeUsageManifestV11({
    ...manifest,
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V11,
    schemaVersion: 11,
    capabilities: manifest.capabilities.filter(candidate => !task.includes(candidate)),
  }, expectedId)
  return Object.freeze({
    ...base,
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V12,
    schemaVersion: 12,
    capabilities: Object.freeze([
      ...base.capabilities,
      ...task.map(candidate => deepFreeze(structuredClone(candidate))),
    ]),
  }) as CordisXPluginManifestV12
}

export function normalizePluginManifestV13(value: unknown, expectedId: string): CordisXPluginManifestV13 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid manifest v13')
  const manifest = value as Record<string, unknown>
  if (
    manifest.$schema !== CORDISX_PLUGIN_MANIFEST_SCHEMA_V13 || manifest.schemaVersion !== 13
    || !Array.isArray(manifest.capabilities) || manifest.capabilities.length > 37
  ) throw new Error('Unsupported manifest v13')
  const exact = manifest.capabilities.filter(candidate => isRuntimeExactRequestDeclaration(candidate))
  const invalidExact = manifest.capabilities.find(candidate =>
    typeof (candidate as { name?: unknown })?.name === 'string'
    && RUNTIME_EXACT.has((candidate as { name: PluginManifestRuntimeExactCapabilityNameV13 }).name)
    && (candidate as { scope?: { runtime?: unknown } }).scope?.runtime !== undefined
    && !isRuntimeExactRequestDeclaration(candidate)
  )
  if (invalidExact !== undefined) throw new Error('Invalid runtime exact-request declaration')
  const base = normalizePluginManifestV12({
    ...manifest,
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V12,
    schemaVersion: 12,
    capabilities: manifest.capabilities.filter(candidate => !isRuntimeExactRequestDeclaration(candidate)),
  }, expectedId)
  return Object.freeze({
    ...base,
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V13,
    schemaVersion: 13,
    capabilities: Object.freeze([
      ...base.capabilities,
      ...exact.map(candidate =>
        Object.freeze({
          name: candidate.name,
          required: false as const,
          scope: Object.freeze({ runtime: 'exact-request' as const }),
        })
      ),
    ]),
  }) as CordisXPluginManifestV13
}

export function runtimeExactCapabilities(
  manifest: CordisXPluginManifestV13,
): ReadonlySet<PluginManifestRuntimeExactCapabilityNameV13> {
  return new Set(manifest.capabilities.filter(isRuntimeExactRequestDeclaration).map(item => item.name))
}
