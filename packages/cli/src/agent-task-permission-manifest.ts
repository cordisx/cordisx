import { normalizeUsageDeclaration, normalizeUsageManifestV11 } from './usage-permissions.js'
import type { PluginRuntimeManifestV12 } from '@cordisx/protocol/plugin-manifest/v12'
import type { PluginRuntimeManifestV11 } from '@cordisx/protocol/plugin-manifest/v11'
import type {
  AgentTaskAnswerCapabilityV1,
  AgentTaskRequestCapabilityV1,
} from '@cordisx/protocol/agent-task-permission/v1'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V10,
  type CordisXPluginManifestV10,
  normalizeVisualManifestV10,
} from './extension-point-interaction-permissions.js'
import { normalizePermissionRationaleV2, normalizePermissionSecurityV2 } from './permission-model-v2.js'

export const CORDISX_PLUGIN_MANIFEST_SCHEMA_V12 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v12.schema.json' as const
export const CORDISX_PLUGIN_MANIFEST_SCHEMA_V11 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v11.schema.json' as const
export type CordisXPluginManifestV12 =
  & Omit<PluginRuntimeManifestV12, 'services'>
  & Pick<CordisXPluginManifestV10, 'services'>
export type CordisXPluginManifestV11 =
  & Omit<PluginRuntimeManifestV11, 'services'>
  & Pick<CordisXPluginManifestV10, 'services'>

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected task permission object')
  }
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('Unknown task permission field')
}
const localId = /^[a-z0-9][a-z0-9._-]{0,95}$/u

function taskDeclaration(value: unknown): AgentTaskRequestCapabilityV1 | AgentTaskAnswerCapabilityV1 {
  const declaration = object(value)
  exact(declaration, ['name', 'required', 'rationale', 'security', 'scope'])
  if (declaration.required !== false || !['approvals.request', 'approvals.answer'].includes(String(declaration.name))) {
    throw new Error('Task approval permission must be optional')
  }
  const scope = object(declaration.scope)
  const request = declaration.name === 'approvals.request'
  const key = request ? 'task' : 'taskRequester'
  const oldKey = request ? 'sessionIds' : 'authorityRequester'
  exact(scope, [key, oldKey])
  const selector = object(scope[key])
  exact(selector, ['kind', 'commandId'])
  if (
    selector.kind !== 'agent-task-command' || typeof selector.commandId !== 'string'
    || !localId.test(selector.commandId)
  ) throw new Error('Invalid task command selector')
  const oldScope = scope[oldKey] === undefined ? {} : { [oldKey]: scope[oldKey] }
  // Use the existing normalizer for the optional independent route branch.
  const old = scope[oldKey] === undefined ? undefined : normalizeVisualManifestV10({
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V10,
    schemaVersion: 10,
    id: 'task-permission-check',
    services: [],
    capabilities: [{ ...declaration, scope: oldScope }],
  }, 'task-permission-check').capabilities[0]
  if (request && old !== undefined && (!('sessionIds' in old.scope) || Array.isArray(old.scope.sessionIds))) {
    throw new Error('Task branch permits only an independent Host route')
  }
  return Object.freeze({
    name: declaration.name,
    required: false,
    ...(declaration.rationale === undefined
      ? {}
      : { rationale: normalizePermissionRationaleV2(declaration.rationale, 'task.rationale') }),
    ...(declaration.security === undefined
      ? {}
      : { security: normalizePermissionSecurityV2(declaration.security, 'task.security') }),
    scope: Object.freeze({
      ...(old?.scope ?? {}),
      [key]: Object.freeze({ kind: 'agent-task-command', commandId: selector.commandId }),
    }),
  }) as AgentTaskRequestCapabilityV1 | AgentTaskAnswerCapabilityV1
}

/** Preserve earlier manifest branches while validating only the additive public declarations. */
export function normalizeTaskManifest(
  value: unknown,
  expectedId: string,
): CordisXPluginManifestV11 | CordisXPluginManifestV12 {
  const manifest = object(value)
  const version = manifest.schemaVersion
  if (version === 11) return normalizeUsageManifestV11(value, expectedId)
  if (
    (version !== 11 && version !== 12)
    || manifest.$schema !== (version === 12 ? CORDISX_PLUGIN_MANIFEST_SCHEMA_V12 : CORDISX_PLUGIN_MANIFEST_SCHEMA_V11)
    || !Array.isArray(manifest.capabilities) || manifest.capabilities.length > 37
  ) throw new Error('Unsupported task manifest')
  const names = new Set<string>()
  const additions:
    (AgentTaskRequestCapabilityV1 | AgentTaskAnswerCapabilityV1 | PluginRuntimeManifestV11['capabilities'][number])[] =
      []
  const baseCapabilities: unknown[] = []
  for (const value of manifest.capabilities) {
    const declaration = object(value)
    if (typeof declaration.name !== 'string' || names.has(declaration.name)) {
      throw new Error('Duplicate or invalid capability')
    }
    names.add(declaration.name)
    const scope = object(declaration.scope)
    if (version === 12 && ('task' in scope || 'taskRequester' in scope)) additions.push(taskDeclaration(value))
    else if (declaration.name === 'usage.read') {
      additions.push(normalizeUsageDeclaration(value))
    } else baseCapabilities.push(value)
  }
  const base = normalizeVisualManifestV10({
    ...manifest,
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V10,
    schemaVersion: 10,
    capabilities: baseCapabilities,
  }, expectedId)
  const normalized = [...base.capabilities, ...additions]
  const byName = new Map<string, typeof normalized[number]>(normalized.map(item => [item.name, item]))
  return Object.freeze({
    ...base,
    $schema: manifest.$schema,
    schemaVersion: version,
    capabilities: Object.freeze(manifest.capabilities.map(item => byName.get(object(item).name as string)!)),
  }) as CordisXPluginManifestV11 | CordisXPluginManifestV12
}
