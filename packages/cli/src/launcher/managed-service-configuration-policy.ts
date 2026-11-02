import type { StartupManagedServiceConfigurationV1 } from '@cordisx/protocol/startup-runtime/v1'
import { isDeepStrictEqual, types } from 'node:util'
import type { SchemaNode } from '../renderer/configuration/model.js'
import {
  isReservedConfigRole,
  removePaths,
  sensitiveNodes,
  validateSchemaDefaults,
} from '../renderer/configuration/values.js'
import {
  cloneManagedServiceConfigurationValue,
  snapshotSelectedManagedServiceConfiguration,
} from './managed-service-instance-configuration.js'

const INVALID = 'managed service Config cannot establish complete nonsecret configuration'
function invalid(): never {
  throw new Error(INVALID)
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}

/** Closed, inline Node projection. Renderer envelopes and uid/refs are not this contract. */
function projection(value: unknown): SchemaNode {
  const node = record(value)
  if (Object.keys(node).some(key => !['type', 'dict', 'inner', 'meta'].includes(key))) invalid()
  const meta = node.meta === undefined ? {} : record(node.meta)
  if (Object.keys(meta).some(key => !['role', 'default'].includes(key))) invalid()
  if (meta.role !== undefined && typeof meta.role !== 'string') invalid()
  const type = node.type
  const childKeys = ['dict', 'inner'].filter(key => Object.hasOwn(node, key))
  const expected = type === 'object' ? ['dict'] : type === 'array'
    ? ['inner']
    : []
  if (childKeys.length !== expected.length || expected.some(key => !childKeys.includes(key))) invalid()
  if (type === 'object') {
    for (const child of Object.values(record(node.dict))) projection(child)
  } else if (type === 'array') {
    projection(node.inner)
  } else if (!['string', 'number', 'boolean'].includes(String(type))) invalid()
  return node as SchemaNode
}

/** Validate every supplied/default/validator-output key against declared structure. */
function matches(value: unknown, node: SchemaNode): boolean {
  if (node.meta?.role !== undefined && isReservedConfigRole(node.meta.role)) return true
  if (node.type === 'object') {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      && Object.entries(value).every(([key, item]) => Object.hasOwn(node.dict!, key) && matches(item, node.dict![key]!))
  }
  if (node.type === 'array') return Array.isArray(value) && value.every(item => matches(item, node.inner!))
  return typeof value === node.type
}

function checkDefaults(node: SchemaNode): void {
  if (Object.hasOwn(node.meta ?? {}, 'default') && !matches(node.meta!.default, node)) invalid()
  for (const child of Object.values(node.dict ?? {})) checkDefaults(child)
  if (node.inner !== undefined) checkDefaults(node.inner)
}

/** Only the exact admitted Node module supplies Config; never accept a renderer validator. */
export function resolveManagedServiceConfiguration(
  selected: unknown,
  Config: unknown,
): StartupManagedServiceConfigurationV1 | undefined {
  const raw = snapshotSelectedManagedServiceConfiguration(selected)
  const empty = raw === undefined || Object.keys(raw).length === 0
  if (empty && Config === undefined) return undefined
  try {
    if (Config === null || !['object', 'function'].includes(typeof Config) || types.isProxy(Config)) invalid()
    const source = Config as { readonly type?: unknown; readonly '~standard'?: unknown; toJSON?: unknown }
    if (source.type !== 'object') invalid()
    const standard = record(source['~standard'])
    if (
      standard.version !== 1 || typeof standard.vendor !== 'string' || typeof standard.validate !== 'function'
      || typeof source.toJSON !== 'function'
    ) invalid()
    const schema = projection(cloneManagedServiceConfigurationValue(source.toJSON()))
    if (schema.type !== 'object') invalid()
    validateSchemaDefaults(schema)
    checkDefaults(schema)
    if (!matches(raw ?? {}, schema)) invalid()
    const paths = sensitiveNodes(schema).map(item => item.path)
    const redacted = removePaths(raw ?? {}, paths)
    const result = (standard.validate as (value: unknown) => unknown)(redacted)
    if (types.isPromise(result)) {
      void Promise.prototype.then.call(result, () => undefined, () => undefined)
      invalid()
    }
    const output = record(cloneManagedServiceConfigurationValue(result))
    if (
      'then' in output || !Object.hasOwn(output, 'value')
      || (output.issues !== undefined && (!Array.isArray(output.issues) || output.issues.length > 0))
    ) invalid()
    const validated = snapshotSelectedManagedServiceConfiguration(output.value)
    if (validated === undefined || !matches(validated, schema)) invalid()
    const value = snapshotSelectedManagedServiceConfiguration(removePaths(validated, paths))
    if (value === undefined || !isDeepStrictEqual(value, validated)) invalid()
    if (empty) return undefined
    return Object.freeze({ contract: 'cordisx.managed-service-instance-configuration/v1', value })
  } catch {
    // Validators and defaults can include private values in their errors. Keep diagnostics bounded.
    throw new Error(INVALID)
  }
}
