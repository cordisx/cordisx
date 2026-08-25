import { Context, Service, type Disposable } from '@deepseek-ai/cordis'
import { normalizeFormPresentation } from '@cordisx/schemastery-ui'
import type {
  CordisXConfigApplies,
  CordisXConfigAppliesInput,
  CordisXConfigFormActionIcons,
  CordisXConfigFormPresenter,
  CordisXConfigFormSchemaNode,
  CordisXConfigFormGroupSnapshot,
  CordisXConfigFormIcon,
  CordisXConfigFieldController,
  CordisXConfigFieldPath,
  CordisXConfigFieldSnapshot,
  CordisXConfigRendererMount,
  CordisXConfigRendererOptions,
  CordisXConfigRenderers,
  CordisXJsonValue,
  CordisXJsonScalar,
  CordisXPluginIdentity,
  CordisXPluginSettings,
  CordisXStandardSchema,
} from '../contracts.js'
import { ownerFromContext } from './ownership.js'
import {
  generationVisibilityFromContext,
  type GenerationVisibilityCoordinator,
  type PluginGenerationEffectIdentity,
  type PluginGenerationView,
} from './generation-visibility.js'
import { assertLocalId } from './validation.js'
import type { PluginConsoleAspect } from './plugin-console.js'

const CONFIG_BINDING = '__cordisxConfigRequestV1'
const CONFIG_RECEIVER = '__cordisxConfigReceiveV1'
const RESERVED_ROLES = new Set(['secret', 'credential', 'credential-ref', 'permission', 'capability'])

interface SchemaNode {
  readonly type?: string
  readonly dict?: Readonly<Record<string, SchemaNode>>
  readonly list?: readonly SchemaNode[]
  readonly inner?: SchemaNode
  readonly value?: unknown
  readonly meta?: {
    readonly role?: string
    readonly extra?: {
      readonly label?: string | Readonly<Record<string, string>>
      readonly cordisxForm?: {
        readonly icon?: string
        readonly group?: {
          readonly id?: string
          readonly title?: string | Readonly<Record<string, string>>
          readonly description?: string | Readonly<Record<string, string>>
          readonly icon?: string
        }
        readonly actions?: { readonly save?: string; readonly reset?: string }
        readonly presenter?: {
          readonly version?: number
          readonly kind?: string
          readonly options?: {
            readonly density?: string
            readonly maxInlineItems?: number
            readonly allowReorder?: boolean
          }
        }
      }
    }
    readonly description?: string | Readonly<Record<string, string>>
    readonly hidden?: boolean
    readonly disabled?: boolean
    readonly required?: boolean
    readonly default?: unknown
    readonly min?: number
    readonly max?: number
    readonly step?: number
  }
  readonly toJSON?: () => unknown
}

interface ConfigRecord {
  readonly identity: CordisXPluginIdentity
  readonly generation: PluginGenerationEffectIdentity
  readonly candidateView?: PluginGenerationView
  readonly namespace: string
  readonly schema?: CordisXStandardSchema & SchemaNode
  readonly applies: CordisXConfigApplies
  readonly writable: boolean
  revision: number
  activeRevision: number
  raw: unknown
  value: unknown
  candidate?: { readonly raw: unknown; readonly value: unknown }
  pendingAppRestart?: { readonly raw: unknown; readonly value: unknown }
  readonly secretPaths: readonly CordisXConfigFieldPath[]
  readonly watchers: Set<(value: unknown) => void>
}

export interface ConfigMutationOperation {
  readonly op: 'set' | 'unset'
  readonly path: CordisXConfigFieldPath
  readonly value?: CordisXJsonValue
}

export interface ManagerPluginConfigSnapshot {
  readonly namespace: string
  readonly schemaKind: 'schemastery' | 'standard' | 'none'
  readonly applies: CordisXConfigApplies
  readonly writable: boolean
  readonly revision: number
  readonly lastGoodRevision: number
  readonly value: unknown
  readonly fields: readonly CordisXConfigFieldSnapshot[]
  readonly secrets: readonly { readonly path: CordisXConfigFieldPath; readonly set: boolean }[]
  readonly actionIcons?: CordisXConfigFormActionIcons
}

export interface ConfigCandidate {
  readonly raw: unknown
  readonly value: unknown
}

export interface ConfigRendererMountHandle {
  readonly mounted: boolean
  dispose(): Promise<void>
}

function clone<T>(value: T): T {
  if (value === undefined) return value
  if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value)
  return JSON.parse(JSON.stringify(value)) as T
}

function freeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child, seen)
  return Object.freeze(value)
}

function immutable<T>(value: T): T {
  return freeze(clone(value))
}

function ownValue(value: unknown, path: CordisXConfigFieldPath): unknown {
  let current = value
  for (const segment of path) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) return undefined
    current = (current as Record<PropertyKey, unknown>)[segment]
  }
  return current
}

function pathStartsWith(path: CordisXConfigFieldPath, prefix: CordisXConfigFieldPath): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment)
}

function assertPath(path: CordisXConfigFieldPath): void {
  if (!Array.isArray(path) || path.length === 0 || path.length > 32) throw new Error('config field path must contain 1 to 32 segments')
  for (const segment of path) {
    if (typeof segment !== 'string' || segment.length === 0 || segment.length > 128
      || ['__proto__', 'prototype', 'constructor'].includes(segment)) {
      throw new Error(`invalid config field path segment: ${segment}`)
    }
  }
}

function setAtPath(input: unknown, path: CordisXConfigFieldPath, value: unknown, unset: boolean): unknown {
  const root = clone(input)
  if (root === null || typeof root !== 'object') throw new Error('config mutation requires an object or array root')
  let current = root as Record<PropertyKey, unknown>
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]!
    const next = current[segment]
    if (next === null || typeof next !== 'object') current[segment] = {}
    current = current[segment] as Record<PropertyKey, unknown>
  }
  const last = path[path.length - 1]!
  if (unset) {
    delete current[last]
  } else {
    current[last] = clone(value)
  }
  return root
}

function localizedText(value: string | Readonly<Record<string, string>> | undefined, locale: string): string | undefined {
  if (typeof value === 'string') return value
  if (value === undefined) return undefined
  const candidates = [locale, locale.split('-')[0], '', 'en']
  for (const candidate of candidates) {
    if (candidate === undefined) continue
    const result = value[candidate]
    if (typeof result === 'string' && result.trim() !== '') return result
  }
  return Object.values(value).find(item => typeof item === 'string' && item.trim() !== '')
}

function sensitiveNodes(
  schema: SchemaNode | undefined,
  path: CordisXConfigFieldPath = [],
): { readonly path: CordisXConfigFieldPath; readonly node: SchemaNode }[] {
  if (schema === undefined) return []
  if (schema.meta?.role !== undefined && RESERVED_ROLES.has(schema.meta.role)) return [{ path, node: schema }]
  if (schema.type === 'lazy') {
    throw new Error(`cannot prove secret positions in unresolved lazy Schemastery field ${path.join('.') || '<root>'}`)
  }
  if (schema.type === 'object' && schema.dict !== undefined) {
    return Object.entries(schema.dict).flatMap(([key, child]) => sensitiveNodes(child, [...path, key]))
  }
  return [
    ...(schema.inner === undefined ? [] : sensitiveNodes(schema.inner, path)),
    ...(schema.list ?? []).flatMap(child => sensitiveNodes(child, path)),
  ]
}

function jsonCompatible(value: unknown, label: string, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`)
    return
  }
  if (typeof value !== 'object') throw new Error(`${label} must be JSON-compatible`)
  if (seen.has(value)) throw new Error(`${label} must not contain circular references`)
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => jsonCompatible(entry, `${label}[${index}]`, seen))
      return
    }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      jsonCompatible(entry, `${label}.${key}`, seen)
    }
  } finally {
    seen.delete(value)
  }
}

function removePaths(value: unknown, paths: readonly CordisXConfigFieldPath[]): unknown {
  let result = clone(value)
  for (const path of paths) {
    if (path.length === 0) return undefined
    if (result === null || typeof result !== 'object') continue
    let current = result as Record<PropertyKey, unknown>
    for (let index = 0; index < path.length - 1; index += 1) {
      const next = current[path[index]!]
      if (next === null || typeof next !== 'object') {
        current = Object.create(null) as Record<PropertyKey, unknown>
        break
      }
      current = next as Record<PropertyKey, unknown>
    }
    const last = path[path.length - 1]
    if (last !== undefined) delete current[last]
  }
  return result
}

function validate(schema: CordisXStandardSchema | undefined, raw: unknown): unknown {
  if (schema === undefined) return immutable(raw)
  const result = schema['~standard'].validate(clone(raw))
  if (result instanceof Promise) throw new Error('CordisX plugin Config validators must be synchronous')
  if (result.issues !== undefined && result.issues.length > 0) {
    throw new Error(result.issues.map(issue => issue.message).join('; '))
  }
  if (!Object.hasOwn(result, 'value')) throw new Error('Standard Schema returned neither value nor issues')
  return immutable(result.value)
}

function choices(schema: SchemaNode): readonly { readonly label: string; readonly value: CordisXJsonScalar }[] | undefined {
  if (schema.type !== 'union' || schema.list === undefined) return undefined
  const result: { label: string; value: CordisXJsonScalar }[] = []
  for (const item of schema.list) {
    if (item.type !== 'const' || !['string', 'number', 'boolean'].includes(typeof item.value) && item.value !== null) return undefined
    result.push({ label: String(item.value), value: item.value as CordisXJsonScalar })
  }
  return result
}

function arrayChoices(schema: SchemaNode | undefined, locale: string): readonly { readonly label: string; readonly value: CordisXJsonScalar }[] | undefined {
  const literalChoices = schema === undefined ? undefined : choices(schema)
  if (literalChoices !== undefined) return literalChoices
  if (schema?.type !== 'boolean') return undefined
  const zh = locale.toLowerCase().startsWith('zh')
  return [
    { label: zh ? '开启' : 'Enabled', value: true },
    { label: zh ? '关闭' : 'Disabled', value: false },
  ]
}

const FORM_ICONS = new Set<CordisXConfigFormIcon>([
  'host:calendar', 'host:clock', 'host:palette', 'host:tags', 'host:folder',
  'host:key', 'host:settings', 'host:info', 'host:files', 'host:save', 'host:reset',
])

function formIcon(value: unknown): CordisXConfigFormIcon | undefined {
  return typeof value === 'string' && FORM_ICONS.has(value as CordisXConfigFormIcon)
    ? value as CordisXConfigFormIcon
    : undefined
}

function formGroup(schema: SchemaNode, locale: string): CordisXConfigFormGroupSnapshot | undefined {
  const group = schema.meta?.extra?.cordisxForm?.group
  if (group?.id === undefined || !/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(group.id)) return undefined
  const title = localizedText(group.title, locale)
  const description = localizedText(group.description, locale)
  const icon = formIcon(group.icon)
  return {
    id: group.id,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(icon === undefined ? {} : { icon }),
  }
}

function actionIcons(schema: SchemaNode | undefined): CordisXConfigFormActionIcons | undefined {
  const actions = schema?.meta?.extra?.cordisxForm?.actions
  const save = formIcon(actions?.save)
  const reset = formIcon(actions?.reset)
  return save === undefined && reset === undefined ? undefined : {
    ...(save === undefined ? {} : { save }),
    ...(reset === undefined ? {} : { reset }),
  }
}

function formPresenter(schema: SchemaNode): CordisXConfigFormPresenter | undefined {
  const normalized = normalizeFormPresentation(schema.meta?.extra?.cordisxForm?.presenter)
  return normalized as CordisXConfigFormPresenter | undefined
}

function formSchemaNode(schema: SchemaNode, locale: string): CordisXConfigFormSchemaNode {
  const role = schema.meta?.role
  const label = localizedText(schema.meta?.extra?.label, locale)
  const description = localizedText(schema.meta?.description, locale)
  const fieldChoices = choices(schema)
  const nestedArrayChoices = schema.type === 'array' ? arrayChoices(schema.inner, locale) : undefined
  const nodeChoices = fieldChoices ?? nestedArrayChoices
  const arrayItemType = schema.type === 'array' && ['string', 'number', 'natural', 'boolean'].includes(schema.inner?.type ?? '')
    ? schema.inner?.type as 'string' | 'number' | 'natural' | 'boolean' : undefined
  const nested = schema.type === 'object' && schema.dict !== undefined
    ? Object.entries(schema.dict).map(([key, child]) => ({ key, schema: formSchemaNode(child, locale) })) : undefined
  const item = schema.type === 'array' && schema.inner !== undefined ? formSchemaNode(schema.inner, locale) : undefined
  const presenter = formPresenter(schema)
  return {
    type: schema.type ?? 'unknown',
    ...(role === undefined ? {} : { role }),
    ...(label === undefined ? {} : { label }),
    ...(description === undefined ? {} : { description }),
    disabled: schema.meta?.disabled === true,
    required: schema.meta?.required === true,
    ...(schema.meta?.min === undefined ? {} : { min: schema.meta.min }),
    ...(schema.meta?.max === undefined ? {} : { max: schema.meta.max }),
    ...(schema.meta?.step === undefined ? {} : { step: schema.meta.step }),
    ...(nodeChoices === undefined ? {} : { choices: nodeChoices }),
    ...(arrayItemType === undefined ? {} : { arrayItemType }),
    ...(presenter === undefined ? {} : { presenter }),
    ...(nested === undefined ? {} : { fields: nested }),
    ...(item === undefined ? {} : { item }),
  }
}

function fields(
  schema: SchemaNode | undefined,
  raw: unknown,
  resolved: unknown,
  namespace: string,
  locale: string,
  path: CordisXConfigFieldPath = [],
): CordisXConfigFieldSnapshot[] {
  if (schema === undefined || schema.meta?.hidden === true) return []
  if (schema.type === 'object' && schema.dict !== undefined) {
    return Object.entries(schema.dict).flatMap(([key, child]) => fields(child, raw, resolved, namespace, locale, [...path, key]))
  }
  if (path.length === 0) return []
  const role = schema.meta?.role
  const sensitive = role !== undefined && RESERVED_ROLES.has(role)
  const label = localizedText(schema.meta?.extra?.label, locale)
  const description = localizedText(schema.meta?.description, locale)
  const fieldChoices = choices(schema)
  const nestedArrayChoices = schema.type === 'array' ? arrayChoices(schema.inner, locale) : undefined
  const fieldOptions = fieldChoices ?? nestedArrayChoices
  const arrayItemType = schema.type === 'array' && ['string', 'number', 'natural', 'boolean'].includes(schema.inner?.type ?? '')
    ? schema.inner?.type as 'string' | 'number' | 'natural' | 'boolean'
    : undefined
  const icon = formIcon(schema.meta?.extra?.cordisxForm?.icon)
  const group = formGroup(schema, locale)
  const presenter = formPresenter(schema)
  const arrayItemSchema = schema.type === 'array' && schema.inner?.type === 'object' ? formSchemaNode(schema.inner, locale) : undefined
  const hasDefault = Object.hasOwn(schema.meta ?? {}, 'default')
  const defaultValue = hasDefault && !sensitive ? immutable(ownValue(resolved, path)) : undefined
  return [{
    namespace,
    path,
    type: schema.type ?? 'unknown',
    ...(role === undefined ? {} : { role }),
    ...(label === undefined ? {} : { label }),
    ...(description === undefined ? {} : { description }),
    value: sensitive ? undefined : immutable(hasOwnPath(raw, path) ? ownValue(raw, path) : ownValue(resolved, path)),
    ...(hasDefault ? { hasDefault: true } : {}),
    ...(hasDefault && !sensitive ? { defaultValue } : {}),
    disabled: schema.meta?.disabled === true || sensitive,
    required: schema.meta?.required === true,
    ...(schema.meta?.min === undefined ? {} : { min: schema.meta.min }),
    ...(schema.meta?.max === undefined ? {} : { max: schema.meta.max }),
    ...(schema.meta?.step === undefined ? {} : { step: schema.meta.step }),
    ...(fieldOptions === undefined ? {} : { choices: fieldOptions }),
    ...(arrayItemType === undefined ? {} : { arrayItemType }),
    ...(presenter === undefined ? {} : { presenter }),
    ...(arrayItemSchema === undefined ? {} : { arrayItemSchema }),
    ...(icon === undefined ? {} : { icon }),
    ...(group === undefined ? {} : { group }),
  }]
}

function hasOwnPath(value: unknown, path: CordisXConfigFieldPath): boolean {
  let current = value
  for (const segment of path) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) return false
    current = (current as Record<PropertyKey, unknown>)[segment]
  }
  return true
}

export class PluginConfigurationRegistry {
  private readonly records = new Map<string, ConfigRecord>()
  private readonly listeners = new Set<() => void>()
  private readonly disconnectVisibility: (() => void) | undefined
  private disposed = false

  constructor(private readonly visibility?: GenerationVisibilityCoordinator) {
    this.disconnectVisibility = visibility?.connect({ notify: () => this.notify() })
  }

  register(input: {
    readonly identity: CordisXPluginIdentity
    readonly schema?: CordisXStandardSchema
    readonly applies: CordisXConfigApplies
    readonly raw: unknown
    readonly revision: number
    readonly writable: boolean
    readonly moduleGeneration?: string
    readonly candidateView?: PluginGenerationView
  }): void {
    if (this.disposed) throw new Error('plugin configuration registry is disposed')
    const schema = input.schema as (CordisXStandardSchema & SchemaNode) | undefined
    const sensitive = sensitiveNodes(schema)
    const secrets = [...new Map(sensitive.map(item => [JSON.stringify(item.path), item.path])).values()]
    for (const item of sensitive) {
      if (item.node.meta !== undefined && Object.hasOwn(item.node.meta, 'default')) {
        throw new Error(`secret config field ${item.path.join('.')} must not declare a JSON default`)
      }
    }
    const raw = removePaths(input.raw, secrets)
    const value = validate(schema, raw)
    const generation: PluginGenerationEffectIdentity = Object.freeze({
      pluginId: input.identity.id,
      ...(input.moduleGeneration === undefined ? {} : { moduleGeneration: input.moduleGeneration }),
      ...(input.candidateView?.transactionId === undefined ? {} : {
        transactionId: input.candidateView.transactionId,
        transactionEpoch: input.candidateView.transactionEpoch,
      }),
    })
    const physicalId = `${input.identity.id}\u0000${input.moduleGeneration ?? 'host'}`
    if (this.records.has(physicalId)) throw new Error(`plugin configuration generation is already registered: ${input.identity.id}`)
    this.records.set(physicalId, {
      identity: input.identity,
      generation,
      ...(input.candidateView === undefined ? {} : { candidateView: input.candidateView }),
      namespace: input.identity.id,
      ...(schema === undefined ? {} : { schema }),
      applies: input.applies,
      writable: input.writable,
      revision: input.revision,
      activeRevision: input.revision,
      raw: immutable(raw),
      value,
      secretPaths: secrets,
      watchers: new Set(),
    })
  }

  unregister(owner: string, moduleGeneration?: string): void {
    if (this.disposed) return
    const record = moduleGeneration === undefined
      ? [...this.records.values()].find(item => item.identity.id === owner
        && (this.visibility?.projected(item.generation) ?? true))
      : this.records.get(`${owner}\u0000${moduleGeneration}`)
    if (record === undefined) return
    record.watchers.clear()
    this.records.delete(`${owner}\u0000${record.generation.moduleGeneration ?? 'host'}`)
    if (this.visibility?.visible(record.generation) !== false) this.notify()
  }

  get(owner: string, view?: PluginGenerationView): unknown {
    const record = this.require(owner, view)
    return record.candidate?.value ?? record.value
  }

  watch(owner: string, listener: (value: unknown) => void, view?: PluginGenerationView): () => void {
    const record = this.require(owner, view)
    record.watchers.add(listener)
    return () => record.watchers.delete(listener)
  }

  stage(owner: string, expectedRevision: number, operations: readonly ConfigMutationOperation[]): ConfigCandidate {
    const record = this.require(owner)
    if (!record.writable) throw new Error('plugin configuration is read-only in this launcher mode')
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new Error('expectedRevision must be a non-negative integer')
    if (record.revision !== expectedRevision) throw new ConfigRevisionConflictError(record.revision)
    if (record.candidate !== undefined) throw new Error('plugin configuration already has a candidate')
    if (!Array.isArray(operations) || operations.length === 0 || operations.length > 100) {
      throw new Error('plugin configuration mutation must contain 1 to 100 operations')
    }
    let raw = record.pendingAppRestart?.raw ?? record.raw
    for (const operation of operations) {
      if (operation === null || typeof operation !== 'object' || (operation.op !== 'set' && operation.op !== 'unset')) {
        throw new Error('config operation must be set or unset')
      }
      const allowed = operation.op === 'set' ? ['op', 'path', 'value'] : ['op', 'path']
      const unknown = Object.keys(operation).find(key => !allowed.includes(key))
      if (unknown !== undefined) throw new Error(`config operation field ${unknown} is not supported`)
      assertPath(operation.path)
      if (record.secretPaths.some(path => pathStartsWith(operation.path, path) || pathStartsWith(path, operation.path))) {
        throw new Error(`secret-path: ${operation.path.join('.')}`)
      }
      if (operation.op === 'set' && !Object.hasOwn(operation, 'value')) throw new Error('set config operation requires a value')
      raw = setAtPath(raw, operation.path, operation.value, operation.op === 'unset')
    }
    raw = removePaths(raw, record.secretPaths)
    jsonCompatible(raw, 'plugin configuration candidate')
    return { raw: immutable(raw), value: validate(record.schema, raw) }
  }

  begin(owner: string, candidate: ConfigCandidate): void {
    this.require(owner).candidate = candidate
  }

  abort(owner: string): void {
    delete this.require(owner).candidate
  }

  commit(owner: string, revision: number, candidate: ConfigCandidate): void {
    const record = this.require(owner)
    record.raw = candidate.raw
    record.value = candidate.value
    record.revision = revision
    record.activeRevision = revision
    delete record.candidate
    delete record.pendingAppRestart
    for (const watcher of [...record.watchers]) watcher(record.value)
    this.notify()
  }

  /** Persist an application-restart candidate without mutating the active process snapshot. */
  commitForAppRestart(owner: string, revision: number, candidate: ConfigCandidate): void {
    const record = this.require(owner)
    record.revision = revision
    record.pendingAppRestart = candidate
    delete record.candidate
    this.notify()
  }

  descriptor(owner: string, locale: string): ManagerPluginConfigSnapshot {
    const record = this.require(owner)
    const schemastery = record.schema !== undefined
      && record.schema['~standard'].vendor === 'schemastery'
      && typeof record.schema.toJSON === 'function'
    const descriptorActionIcons = actionIcons(record.schema)
    return {
      namespace: record.namespace,
      schemaKind: record.schema === undefined ? 'none' : schemastery ? 'schemastery' : 'standard',
      applies: record.applies,
      writable: record.writable,
      revision: record.revision,
      lastGoodRevision: record.activeRevision,
      value: immutable(removePaths(record.pendingAppRestart?.raw ?? record.raw, record.secretPaths)),
      fields: schemastery ? fields(
        record.schema,
        record.pendingAppRestart?.raw ?? record.raw,
        record.pendingAppRestart?.value ?? record.value,
        record.namespace,
        locale,
      ) : [],
      secrets: record.secretPaths.map(path => ({ path, set: false })),
      ...(descriptorActionIcons === undefined ? {} : { actionIcons: descriptorActionIcons }),
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disconnectVisibility?.()
    this.records.clear()
    this.listeners.clear()
  }

  private require(owner: string, view?: PluginGenerationView): ConfigRecord {
    if (this.disposed) throw new Error('plugin configuration registry is disposed')
    const record = [...this.records.values()].find(item => item.identity.id === owner
      && (this.visibility?.projected(item.generation, view) ?? true))
    if (record === undefined) throw new Error(`plugin configuration is not registered: ${owner}`)
    return record
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // Registry publication is authoritative; observer failures are isolated.
      }
    }
  }
}

export class ConfigRevisionConflictError extends Error {
  constructor(readonly actualRevision: number) {
    super(`plugin configuration revision conflict; actual revision is ${actualRevision}`)
  }
}

interface RendererRecord {
  readonly owner: string
  readonly generation: PluginGenerationEffectIdentity
  readonly candidateView?: PluginGenerationView
  readonly options: CordisXConfigRendererOptions
  readonly mount: CordisXConfigRendererMount
  readonly sequence: number
  readonly active: Set<{ readonly abort: AbortController; cleanup?: Disposable<void>; disposed: boolean }>
}

export class ConfigRendererRegistry {
  private readonly records: RendererRecord[] = []
  private sequence = 0
  private disposed = false
  private readonly disconnectVisibility: (() => void) | undefined

  constructor(private readonly visibility?: GenerationVisibilityCoordinator) {
    this.disconnectVisibility = visibility?.connect({ notify: () => {
      for (const record of this.records) {
        if (visibility.visible(record.generation)) continue
        for (const mount of record.active) {
          mount.disposed = true
          mount.abort.abort()
          void disposeEffect(mount.cleanup)
        }
        record.active.clear()
      }
    } })
  }

  register(ownerOrContext: string | Context, options: CordisXConfigRendererOptions, mount: CordisXConfigRendererMount): () => void {
    if (this.disposed) throw new Error('config renderer registry is disposed')
    const owner = typeof ownerOrContext === 'string' ? ownerOrContext : ownerFromContext(ownerOrContext)
    const generation: PluginGenerationEffectIdentity = typeof ownerOrContext === 'string'
      ? Object.freeze({ pluginId: owner })
      : this.visibility?.effect(ownerOrContext) ?? Object.freeze({ pluginId: owner })
    const candidateView = typeof ownerOrContext === 'string' || generation.transactionId === undefined
      ? undefined
      : this.visibility?.view(ownerOrContext)
    assertLocalId(owner, 'config renderer owner')
    assertLocalId(options.id, 'config renderer id')
    if (typeof mount !== 'function') throw new Error('config renderer requires a mount function')
    const unknownOption = Object.keys(options).find(key => !['id', 'selector', 'order'].includes(key))
    if (unknownOption !== undefined) throw new Error(`config renderer option ${unknownOption} is not supported`)
    if (options.selector === null || typeof options.selector !== 'object') throw new Error('config renderer selector must be an object')
    const selectors = ['role', 'path', 'namespace'].filter(key => Object.hasOwn(options.selector, key))
    if (selectors.length !== 1) throw new Error('config renderer requires exactly one selector')
    const unknownSelector = Object.keys(options.selector).find(key => !['role', 'path', 'namespace'].includes(key))
    if (unknownSelector !== undefined) throw new Error(`config renderer selector ${unknownSelector} is not supported`)
    if ('role' in options.selector && !/^[a-z][a-z0-9-]{0,63}$/.test(options.selector.role)) throw new Error('config renderer role is invalid')
    if ('role' in options.selector && RESERVED_ROLES.has(options.selector.role)) throw new Error(`config renderer cannot select Host-reserved role ${options.selector.role}`)
    if ('path' in options.selector) assertPath(options.selector.path)
    if ('namespace' in options.selector
      && options.selector.namespace !== owner
      && !options.selector.namespace.startsWith(`${owner}.`)) {
      throw new Error(`config renderer namespace ${options.selector.namespace} is outside owner ${owner}`)
    }
    if ('namespace' in options.selector) assertLocalId(options.selector.namespace, 'config renderer namespace')
    const order = options.order ?? 0
    if (!Number.isInteger(order) || order < -100_000 || order > 100_000) throw new Error('config renderer order is invalid')
    if (this.records.some(record => record.owner === owner
      && record.options.id === options.id
      && record.generation.moduleGeneration === generation.moduleGeneration)) {
      throw new Error(`config renderer ${owner}:${options.id} is already registered for this generation`)
    }
    if (this.records.filter(record => record.owner === owner).length >= 100) throw new Error(`config renderer owner ${owner} reached the registration limit`)
    const record: RendererRecord = {
      owner,
      generation,
      ...(candidateView === undefined ? {} : { candidateView }),
      options: immutable({ ...options, order }),
      mount,
      sequence: this.sequence++,
      active: new Set(),
    }
    this.records.push(record)
    let active = true
    return () => {
      if (!active) return
      active = false
      const index = this.records.indexOf(record)
      if (index >= 0) this.records.splice(index, 1)
      for (const mount of record.active) {
        mount.disposed = true
        mount.abort.abort()
        void disposeEffect(mount.cleanup)
      }
      record.active.clear()
    }
  }

  async mount(
    owner: string,
    field: CordisXConfigFieldSnapshot,
    container: HTMLElement,
    setDraft: (value: unknown) => void,
  ): Promise<ConfigRendererMountHandle> {
    if (this.disposed || field.role !== undefined && RESERVED_ROLES.has(field.role)) return { mounted: false, dispose: async () => {} }
    const record = this.records
      .filter(item => item.owner === owner
        && (this.visibility?.visible(item.generation) ?? true)
        && rendererMatches(item.options, field))
      .sort((left, right) => rendererPriority(right.options) - rendererPriority(left.options)
        || (left.options.order ?? 0) - (right.options.order ?? 0)
        || left.sequence - right.sequence)[0]
    if (record === undefined) return { mounted: false, dispose: async () => {} }
    const abort = new AbortController()
    const active: { abort: AbortController; cleanup?: Disposable<void>; disposed: boolean } = { abort, disposed: false }
    record.active.add(active)
    try {
      const cleanup = await record.mount(container, Object.freeze({ ...field, signal: abort.signal, setDraft }) as CordisXConfigFieldController)
      if (cleanup !== undefined) {
        if (active.disposed) await cleanup()
        else active.cleanup = cleanup
      }
    } catch (error) {
      abort.abort()
      record.active.delete(active)
      console.error(`[cordisx] config renderer ${record.owner}:${record.options.id} failed`, error)
      return { mounted: false, dispose: async () => {} }
    }
    let mounted = true
    return {
      mounted: true,
      dispose: async () => {
        if (!mounted || active.disposed) return
        mounted = false
        active.disposed = true
        abort.abort()
        record.active.delete(active)
        await disposeEffect(active.cleanup)
      },
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disconnectVisibility?.()
    for (const record of [...this.records]) {
      for (const mount of record.active) {
        mount.disposed = true
        mount.abort.abort()
        void disposeEffect(mount.cleanup)
      }
      record.active.clear()
    }
    this.records.length = 0
  }
}

function rendererPriority(options: CordisXConfigRendererOptions): number {
  return 'path' in options.selector ? 3 : 'role' in options.selector ? 2 : 1
}

function rendererMatches(options: CordisXConfigRendererOptions, field: CordisXConfigFieldSnapshot): boolean {
  if ('path' in options.selector) return options.selector.path.length === field.path.length
    && options.selector.path.every((segment, index) => field.path[index] === segment)
  if ('role' in options.selector) return options.selector.role === field.role
  return options.selector.namespace === field.namespace || field.namespace.startsWith(`${options.selector.namespace}.`)
}

async function disposeEffect(effect: Disposable<void> | undefined): Promise<void> {
  await effect?.()
}

export class CordisXPluginSettingsService extends Service implements CordisXPluginSettings {
  private readonly registry: PluginConfigurationRegistry
  private readonly console: PluginConsoleAspect | undefined

  constructor(ctx: Context, input: PluginConfigurationRegistry | { readonly registry: PluginConfigurationRegistry; readonly console?: PluginConsoleAspect }) {
    super(ctx, 'settings')
    this.registry = input instanceof PluginConfigurationRegistry ? input : input.registry
    this.console = input instanceof PluginConfigurationRegistry ? undefined : input.console
  }

  get<T = unknown>(): T {
    const token = this.console?.tokenFromContext(this.ctx)
    const read = (): T => this.registry.get(
      ownerFromContext(this.ctx),
      generationVisibilityFromContext(this.ctx)?.view(this.ctx),
    ) as T
    return token === undefined || this.console === undefined ? read() : this.console.runSync(token, 'settings.get', {}, read)
  }

  watch<T = unknown>(listener: (value: T) => void): Disposable<void> {
    const owner = ownerFromContext(this.ctx)
    const token = this.console?.tokenFromContext(this.ctx)
    const view = generationVisibilityFromContext(this.ctx)?.view(this.ctx)
    const scoped = token === undefined || this.console === undefined
      ? listener
      : this.console.wrapCallback(token, `settings.watch:${owner}`, listener)
    const register = (): Disposable<void> => this.ctx.effect(
      () => this.registry.watch(owner, scoped as (value: unknown) => void, view),
      `settings.watch(${JSON.stringify(owner)})`,
    )
    return token === undefined || this.console === undefined ? register() : this.console.runSync(token, 'settings.watch', {}, register)
  }
}

export class CordisXConfigRendererService extends Service implements CordisXConfigRenderers {
  private readonly registry: ConfigRendererRegistry
  private readonly console: PluginConsoleAspect | undefined

  constructor(ctx: Context, input: ConfigRendererRegistry | { readonly registry: ConfigRendererRegistry; readonly console?: PluginConsoleAspect }) {
    super(ctx, 'configRenderers')
    this.registry = input instanceof ConfigRendererRegistry ? input : input.registry
    this.console = input instanceof ConfigRendererRegistry ? undefined : input.console
  }

  register(options: CordisXConfigRendererOptions, mount: CordisXConfigRendererMount): Disposable<void> {
    const owner = ownerFromContext(this.ctx)
    const token = this.console?.tokenFromContext(this.ctx)
    const scopedMount = token === undefined || this.console === undefined
      ? mount
      : this.console.wrapCallback(token, `configRenderer:${owner}:${options.id}`, mount)
    const register = (): Disposable<void> => this.ctx.effect(
      () => this.registry.register(this.ctx, options, scopedMount),
      `configRenderers.register(${JSON.stringify(options.id)})`,
    )
    return token === undefined || this.console === undefined ? register() : this.console.runSync(token, 'configRenderers.register', options, register)
  }
}

interface BridgeResponse {
  readonly requestId: string
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: string
  readonly code?: string
  readonly actualRevision?: number
}

declare global {
  interface Window {
    [CONFIG_BINDING]?: (payload: string) => void
    [CONFIG_RECEIVER]?: (payload: string) => void
  }
}

export class BrowserConfigBridge {
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  private disposed = false

  constructor(
    private readonly token: string,
    private readonly profileId: string,
    private readonly generation: string,
  ) {
    window[CONFIG_RECEIVER] = payload => this.receive(payload)
  }

  stage(identity: CordisXPluginIdentity, expectedRevision: number, config: unknown): Promise<{ candidateRevision: number }> {
    return this.request('stage', identity, { expectedRevision, config }) as Promise<{ candidateRevision: number }>
  }

  commit(identity: CordisXPluginIdentity, candidateRevision: number): Promise<{ revision: number }> {
    return this.request('commit', identity, { candidateRevision }) as Promise<{ revision: number }>
  }

  abort(identity: CordisXPluginIdentity, candidateRevision: number): Promise<void> {
    return this.request('abort', identity, { candidateRevision }) as Promise<void>
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (window[CONFIG_RECEIVER] !== undefined) delete window[CONFIG_RECEIVER]
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('plugin configuration bridge is disposed'))
    }
    this.pending.clear()
  }

  private request(operation: string, identity: CordisXPluginIdentity, fields: Record<string, unknown>): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error('plugin configuration bridge is disposed'))
    const binding = window[CONFIG_BINDING]
    if (typeof binding !== 'function') return Promise.reject(new Error('plugin configuration writer is unavailable'))
    const requestId = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('plugin configuration request timed out'))
      }, 10_000)
      this.pending.set(requestId, { resolve, reject, timer })
      try {
        binding(JSON.stringify({
          version: 1,
          operation,
          requestId,
          token: this.token,
          identity: { source: identity.source, pluginId: identity.id },
          scope: { profileId: this.profileId, generation: this.generation },
          ...fields,
        }))
      } catch (error) {
        this.pending.delete(requestId)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private receive(payload: string): void {
    let response: BridgeResponse
    try {
      response = JSON.parse(payload) as BridgeResponse
    } catch {
      return
    }
    const pending = this.pending.get(response.requestId)
    if (pending === undefined) return
    this.pending.delete(response.requestId)
    clearTimeout(pending.timer)
    if (response.ok) pending.resolve(response.value)
    else if (response.code === 'conflict') pending.reject(new ConfigRevisionConflictError(response.actualRevision ?? -1))
    else pending.reject(new Error(response.error ?? 'plugin configuration request failed'))
  }
}

export function moduleConfigSchema(module: { readonly Config?: CordisXStandardSchema; readonly default?: unknown } | undefined): CordisXStandardSchema | undefined {
  if (module?.Config !== undefined) return module.Config
  const fallback = module?.default
  if (fallback !== null && typeof fallback === 'object') return (fallback as { readonly Config?: CordisXStandardSchema }).Config
  return undefined
}

export function moduleConfigApplies(module: {
  readonly configApplies?: CordisXConfigAppliesInput
  readonly default?: unknown
} | undefined): CordisXConfigApplies {
  const fallback = module?.default
  const value = module?.configApplies ?? (fallback !== null && typeof fallback === 'object'
    ? (fallback as { readonly configApplies?: CordisXConfigAppliesInput }).configApplies
    : undefined)
  if (value === undefined || value === 'restart') return 'plugin-restart'
  if (!['live', 'plugin-restart', 'service-restart', 'app-restart'].includes(value)) {
    throw new Error('plugin configApplies must be live, plugin-restart, service-restart, or app-restart')
  }
  return value
}
