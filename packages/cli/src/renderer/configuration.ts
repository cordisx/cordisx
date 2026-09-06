import type {
  ConfigCandidate,
  ConfigMutationOperation,
  ConfigRecord,
  ConfigRendererMountHandle,
  ManagerPluginConfigSnapshot,
  SchemaNode,
} from './configuration/model.js'
import type {
  GenerationVisibilityCoordinator,
  PluginGenerationEffectIdentity,
  PluginGenerationView,
} from './generation-visibility.js'
import type {
  CordisXConfigApplies,
  CordisXConfigAppliesInput,
  CordisXConfigFieldController,
  CordisXConfigFieldSnapshot,
  CordisXConfigFormGroupSnapshot,
  CordisXConfigRendererMount,
  CordisXConfigRendererOptions,
  CordisXConfigRenderers,
  CordisXJsonScalar,
  CordisXLocalizedText,
  CordisXPluginIdentity,
  CordisXPluginSettings,
  CordisXStandardSchema,
} from '../contracts.js'
import {
  assertPath,
  hasOwnPath,
  immutable,
  isReservedConfigRole,
  jsonCompatible,
  pathStartsWith,
  removePaths,
  sensitiveNodes,
  setAtPath,
  validate,
  validateSchemaDefaults,
} from './configuration/values.js'
import type {
  ManagerContentPluginConfigDescriptorV3,
  ManagerContentPluginConfigFormPresentationV2,
} from '@cordisx/protocol/manager-content-navigation/v5'
import {
  actionIcons,
  fields,
  localizedText,
  managerContentFormPresentationV2,
} from './configuration/form-presentation.js'
import type {
  ManagerContentConfigMissingDefaultV1,
  ManagerContentPluginConfigDescriptorV2,
  ManagerContentPluginConfigFormFieldV1,
} from '@cordisx/protocol/manager-content-navigation/v4'
import type { Disposable } from '@deepseek-ai/cordis'
import { Context, Service } from '@deepseek-ai/cordis'
import { ownerFromContext } from './ownership.js'
import { assertLocalId } from './validation.js'
import type { PluginConsoleAspect } from './plugin-console.js'
import { generationVisibilityFromContext } from './generation-visibility.js'

const CONFIG_BINDING = '__cordisxConfigRequestV1'

const CONFIG_RECEIVER = '__cordisxConfigReceiveV1'

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
    validateSchemaDefaults(schema)
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
    if (this.records.has(physicalId)) {
      throw new Error(`plugin configuration generation is already registered: ${input.identity.id}`)
    }
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
      ? [...this.records.values()].find(item =>
        item.identity.id === owner
        && (this.visibility?.projected(item.generation) ?? true)
      )
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
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error('expectedRevision must be a non-negative integer')
    }
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
      if (
        record.secretPaths.some(path => pathStartsWith(operation.path, path) || pathStartsWith(path, operation.path))
      ) {
        throw new Error(`secret-path: ${operation.path.join('.')}`)
      }
      if (operation.op === 'set' && !Object.hasOwn(operation, 'value')) {
        throw new Error('set config operation requires a value')
      }
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

  descriptor(owner: string, locale: string, view?: PluginGenerationView): ManagerPluginConfigSnapshot {
    return this.descriptorForRecord(this.require(owner, view), locale)
  }

  private descriptorForRecord(
    record: ConfigRecord,
    locale: string,
    localizedForm?: Readonly<{
      readonly presentation: ManagerContentPluginConfigFormPresentationV2
      readonly resolveText: (message: CordisXLocalizedText, site: string) => string
    }>,
  ): ManagerPluginConfigSnapshot {
    const schemastery = record.schema !== undefined
      && record.schema['~standard'].vendor === 'schemastery'
      && typeof record.schema.toJSON === 'function'
    const descriptorActionIcons = localizedForm?.presentation.actions ?? actionIcons(record.schema)
    const projectedFields = schemastery
      ? fields(
        record.schema,
        record.pendingAppRestart?.raw ?? record.raw,
        record.pendingAppRestart?.value ?? record.value,
        record.namespace,
        locale,
      ).map(field => {
        const presentation = localizedForm?.presentation.fields.find(candidate => (
          candidate.path.length === field.path.length
          && candidate.path.every((segment, index) => segment === field.path[index])
        ))
        if (presentation === undefined) return field
        const groupTitle = presentation.group?.title === undefined
          ? undefined
          : localizedText(presentation.group.title, locale)
        const groupDescription = presentation.group?.description === undefined
          ? undefined
          : localizedText(presentation.group.description, locale)
        const group: CordisXConfigFormGroupSnapshot | undefined = presentation.group === undefined ? field.group : {
          id: presentation.group.id,
          ...(groupTitle === undefined ? {} : { title: groupTitle }),
          ...(groupDescription === undefined ? {} : { description: groupDescription }),
          ...(presentation.group.icon === undefined ? {} : { icon: presentation.group.icon }),
        }
        const choiceLabels = presentation.choices?.map((choice, index) => ({
          value: choice.value as CordisXJsonScalar,
          label: localizedForm!.resolveText(
            choice.label,
            `manager-config:${record.identity.id}:${field.path.join('.')}:choice:${index}`,
          ),
        }))
        return immutable({
          ...field,
          ...(presentation.icon === undefined ? {} : { icon: presentation.icon }),
          ...(group === undefined ? {} : { group }),
          ...(presentation.presenter === undefined ? {} : { presenter: presentation.presenter }),
          ...(choiceLabels === undefined ? {} : { choices: choiceLabels }),
        })
      })
      : []
    return {
      namespace: record.namespace,
      schemaKind: record.schema === undefined ? 'none' : schemastery ? 'schemastery' : 'standard',
      applies: record.applies,
      writable: record.writable,
      revision: record.revision,
      lastGoodRevision: record.activeRevision,
      value: immutable(removePaths(record.pendingAppRestart?.raw ?? record.raw, record.secretPaths)),
      fields: projectedFields,
      secrets: record.secretPaths.map(path => ({ path, set: false })),
      ...(descriptorActionIcons === undefined ? {} : { actionIcons: descriptorActionIcons }),
    }
  }

  managerContentHostDescriptor(
    owner: string,
    locale: string,
    resolveText: (message: CordisXLocalizedText, site: string) => string,
    view?: PluginGenerationView,
  ): ManagerPluginConfigSnapshot {
    const record = this.require(owner, view)
    const presentation = managerContentFormPresentationV2(record.schema)
    return this.descriptorForRecord(
      record,
      locale,
      presentation === undefined ? undefined : { presentation, resolveText },
    )
  }

  /** Host-internal Protocol v4/v5 projection; plugins never receive this writer-facing descriptor. */
  managerContentDescriptor(
    owner: string,
    profileId: string,
    runtimeGeneration: string,
    locale: string,
    view?: PluginGenerationView,
    contractVersion: 1 | 2 = 1,
  ): ManagerContentPluginConfigDescriptorV2 | ManagerContentPluginConfigDescriptorV3 {
    const record = this.require(owner, view)
    const current = this.descriptorForRecord(record, locale)
    const schemastery = record.schema !== undefined
      && record.schema['~standard'].vendor === 'schemastery'
      && typeof record.schema.toJSON === 'function'
    let envelope:
      | Readonly<
        Record<string, import('@cordisx/protocol/manager-content-navigation/v4').ManagerContentConfigJsonValue>
      >
      | undefined
    if (schemastery) {
      const projected = record.schema!.toJSON!()
      jsonCompatible(projected, 'plugin configuration schema projection')
      if (projected === null || typeof projected !== 'object' || Array.isArray(projected)) {
        throw new Error('Schemastery configuration projection must be an object')
      }
      envelope = immutable(projected) as typeof envelope
    }
    const formFields: ManagerContentPluginConfigFormFieldV1[] = current.fields.map(field => {
      if (field.path.length === 0) throw new Error('plugin configuration form field path must not be empty')
      return {
        path: field.path as ManagerContentPluginConfigFormFieldV1['path'],
        ...(field.icon === undefined ? {} : { icon: field.icon }),
        ...(field.group === undefined ? {} : { group: field.group }),
        ...(field.presenter === undefined ? {} : { presenter: field.presenter }),
      }
    })
    const formV1 = formFields.length === 0 && current.actionIcons === undefined ? undefined : {
      version: 1 as const,
      fields: formFields,
      ...(current.actionIcons === undefined ? {} : { actions: current.actionIcons }),
    }
    const formV2 = contractVersion === 2 ? managerContentFormPresentationV2(record.schema) : undefined
    const user = immutable(removePaths(record.pendingAppRestart?.raw ?? record.raw, record.secretPaths))
    const value = immutable(removePaths(record.pendingAppRestart?.value ?? record.value, record.secretPaths))
    jsonCompatible(user, 'plugin configuration user projection')
    jsonCompatible(value, 'plugin configuration value projection')
    const common = {
      identity: { source: record.identity.source, pluginId: record.identity.id },
      scope: { profileId, generation: record.generation.moduleGeneration ?? runtimeGeneration },
      namespace: record.namespace,
      value: value as import('@cordisx/protocol/manager-content-navigation/v4').ManagerContentConfigJsonValue,
      ...(user === undefined
        ? {}
        : { user: user as import('@cordisx/protocol/manager-content-navigation/v4').ManagerContentConfigJsonValue }),
      revision: record.revision,
      lastGoodRevision: record.activeRevision,
      applies: record.applies,
      writable: record.writable,
      secrets: record.secretPaths.map(path => ({
        path: path as import('@cordisx/protocol/manager-content-navigation/v4').ManagerContentConfigFieldPath,
        set: false,
      })),
    }
    if (contractVersion === 2) {
      return immutable({
        ...common,
        version: 3 as const,
        schema: schemastery
          ? { kind: 'schemastery' as const, envelope: envelope!, ...(formV2 === undefined ? {} : { form: formV2 }) }
          : { kind: 'standard' as const, renderable: false as const },
      })
    }
    return immutable({
      ...common,
      version: 2 as const,
      schema: schemastery
        ? { kind: 'schemastery' as const, envelope: envelope!, ...(formV1 === undefined ? {} : { form: formV1 }) }
        : { kind: 'standard' as const, renderable: false as const },
    })
  }

  /** Validate declared missing-only defaults against the exact Schemastery source record. */
  managerContentMissingDefaults(
    owner: string,
    fields: readonly ManagerContentConfigMissingDefaultV1[],
    view?: PluginGenerationView,
  ): { readonly operations: readonly ConfigMutationOperation[]; readonly allPresent: boolean } {
    const record = this.require(owner, view)
    if (record.schema === undefined || record.schema['~standard'].vendor !== 'schemastery') {
      throw new Error('default-schema-mismatch: configuration is not Schemastery')
    }
    const seen = new Set<string>()
    const operations: ConfigMutationOperation[] = []
    const raw = record.pendingAppRestart?.raw ?? record.raw
    for (const field of fields) {
      assertPath(field.path)
      const key = JSON.stringify(field.path)
      if (seen.has(key)) throw new Error(`default-not-declared: duplicate path ${field.path.join('.')}`)
      seen.add(key)
      if (record.secretPaths.some(path => pathStartsWith(field.path, path) || pathStartsWith(path, field.path))) {
        throw new Error(`secret-path: ${field.path.join('.')}`)
      }
      let node: SchemaNode | undefined = record.schema
      for (const segment of field.path) {
        if (node?.type !== 'object' || node.dict === undefined || !Object.hasOwn(node.dict, segment)) {
          node = undefined
          break
        }
        node = node.dict[segment]
      }
      if (node === undefined || !Object.hasOwn(node.meta ?? {}, 'default')) {
        throw new Error(`default-not-declared: ${field.path.join('.')}`)
      }
      const declared = node.meta?.default
      jsonCompatible(declared, `config schema default ${field.path.join('.')}`)
      if (!Object.is(declared, field.value)) {
        throw new Error(`default-schema-mismatch: ${field.path.join('.')}`)
      }
      if (!hasOwnPath(raw, field.path)) operations.push({ op: 'set', path: field.path, value: field.value })
    }
    return Object.freeze({ operations: Object.freeze(operations), allPresent: operations.length === 0 })
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
    const record = [...this.records.values()].find(item =>
      item.identity.id === owner
      && (this.visibility?.projected(item.generation, view) ?? true)
    )
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
    this.disconnectVisibility = visibility?.connect({
      notify: () => {
        for (const record of this.records) {
          if (visibility.visible(record.generation)) continue
          for (const mount of record.active) {
            mount.disposed = true
            mount.abort.abort()
            void disposeEffect(mount.cleanup)
          }
          record.active.clear()
        }
      },
    })
  }

  register(
    ownerOrContext: string | Context,
    options: CordisXConfigRendererOptions,
    mount: CordisXConfigRendererMount,
  ): () => void {
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
    if (options.selector === null || typeof options.selector !== 'object') {
      throw new Error('config renderer selector must be an object')
    }
    const selectors = ['role', 'path', 'namespace'].filter(key => Object.hasOwn(options.selector, key))
    if (selectors.length !== 1) throw new Error('config renderer requires exactly one selector')
    const unknownSelector = Object.keys(options.selector).find(key => !['role', 'path', 'namespace'].includes(key))
    if (unknownSelector !== undefined) throw new Error(`config renderer selector ${unknownSelector} is not supported`)
    if ('role' in options.selector && !/^[a-z][a-z0-9-]{0,63}$/.test(options.selector.role)) {
      throw new Error('config renderer role is invalid')
    }
    if ('role' in options.selector && isReservedConfigRole(options.selector.role)) {
      throw new Error(`config renderer cannot select Host-reserved role ${options.selector.role}`)
    }
    if ('path' in options.selector) assertPath(options.selector.path)
    if (
      'namespace' in options.selector
      && options.selector.namespace !== owner
      && !options.selector.namespace.startsWith(`${owner}.`)
    ) {
      throw new Error(`config renderer namespace ${options.selector.namespace} is outside owner ${owner}`)
    }
    if ('namespace' in options.selector) assertLocalId(options.selector.namespace, 'config renderer namespace')
    const order = options.order ?? 0
    if (!Number.isInteger(order) || order < -100_000 || order > 100_000) {
      throw new Error('config renderer order is invalid')
    }
    if (
      this.records.some(record =>
        record.owner === owner
        && record.options.id === options.id
        && record.generation.moduleGeneration === generation.moduleGeneration
      )
    ) {
      throw new Error(`config renderer ${owner}:${options.id} is already registered for this generation`)
    }
    if (this.records.filter(record => record.owner === owner).length >= 100) {
      throw new Error(`config renderer owner ${owner} reached the registration limit`)
    }
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
    if (this.disposed || field.role !== undefined && isReservedConfigRole(field.role)) {
      return { mounted: false, dispose: async () => {} }
    }
    const record = this.records
      .filter(item =>
        item.owner === owner
        && (this.visibility?.visible(item.generation) ?? true)
        && rendererMatches(item.options, field)
      )
      .sort((left, right) =>
        rendererPriority(right.options) - rendererPriority(left.options)
        || (left.options.order ?? 0) - (right.options.order ?? 0)
        || left.sequence - right.sequence
      )[0]
    if (record === undefined) return { mounted: false, dispose: async () => {} }
    const abort = new AbortController()
    const active: { abort: AbortController; cleanup?: Disposable<void>; disposed: boolean } = { abort, disposed: false }
    record.active.add(active)
    try {
      const cleanup = await record.mount(
        container,
        Object.freeze({ ...field, signal: abort.signal, setDraft }) as CordisXConfigFieldController,
      )
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
  if ('path' in options.selector) {
    return options.selector.path.length === field.path.length
      && options.selector.path.every((segment, index) => field.path[index] === segment)
  }
  if ('role' in options.selector) return options.selector.role === field.role
  return options.selector.namespace === field.namespace || field.namespace.startsWith(`${options.selector.namespace}.`)
}

async function disposeEffect(effect: Disposable<void> | undefined): Promise<void> {
  await effect?.()
}

export class CordisXPluginSettingsService extends Service implements CordisXPluginSettings {
  private readonly registry: PluginConfigurationRegistry
  private readonly console: PluginConsoleAspect | undefined

  constructor(
    ctx: Context,
    input: PluginConfigurationRegistry | {
      readonly registry: PluginConfigurationRegistry
      readonly console?: PluginConsoleAspect
    },
  ) {
    super(ctx, 'settings')
    this.registry = input instanceof PluginConfigurationRegistry ? input : input.registry
    this.console = input instanceof PluginConfigurationRegistry ? undefined : input.console
  }

  get<T = unknown>(): T {
    const token = this.console?.tokenFromContext(this.ctx)
    const read = (): T =>
      this.registry.get(
        ownerFromContext(this.ctx),
        generationVisibilityFromContext(this.ctx)?.view(this.ctx),
      ) as T
    return token === undefined || this.console === undefined
      ? read()
      : this.console.runSync(token, 'settings.get', {}, read)
  }

  watch<T = unknown>(listener: (value: T) => void): Disposable<void> {
    const owner = ownerFromContext(this.ctx)
    const token = this.console?.tokenFromContext(this.ctx)
    const view = generationVisibilityFromContext(this.ctx)?.view(this.ctx)
    const scoped = token === undefined || this.console === undefined
      ? listener
      : this.console.wrapCallback(token, `settings.watch:${owner}`, listener)
    const register = (): Disposable<void> =>
      this.ctx.effect(
        () => this.registry.watch(owner, scoped as (value: unknown) => void, view),
        `settings.watch(${JSON.stringify(owner)})`,
      )
    return token === undefined || this.console === undefined
      ? register()
      : this.console.runSync(token, 'settings.watch', {}, register)
  }
}

export class CordisXConfigRendererService extends Service implements CordisXConfigRenderers {
  private readonly registry: ConfigRendererRegistry
  private readonly console: PluginConsoleAspect | undefined

  constructor(
    ctx: Context,
    input: ConfigRendererRegistry | {
      readonly registry: ConfigRendererRegistry
      readonly console?: PluginConsoleAspect
    },
  ) {
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
    const register = (): Disposable<void> =>
      this.ctx.effect(
        () => this.registry.register(this.ctx, options, scopedMount),
        `configRenderers.register(${JSON.stringify(options.id)})`,
      )
    return token === undefined || this.console === undefined
      ? register()
      : this.console.runSync(token, 'configRenderers.register', options, register)
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

  stage(
    identity: CordisXPluginIdentity,
    expectedRevision: number,
    config: unknown,
  ): Promise<{ candidateRevision: number }> {
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

  private request(
    operation: string,
    identity: CordisXPluginIdentity,
    fields: Record<string, unknown>,
  ): Promise<unknown> {
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
    else if (response.code === 'conflict') {
      pending.reject(new ConfigRevisionConflictError(response.actualRevision ?? -1))
    } else pending.reject(new Error(response.error ?? 'plugin configuration request failed'))
  }
}

export function moduleConfigSchema(
  module: { readonly Config?: CordisXStandardSchema; readonly default?: unknown } | undefined,
): CordisXStandardSchema | undefined {
  if (module?.Config !== undefined) return module.Config
  const fallback = module?.default
  if (fallback !== null && typeof fallback === 'object') {
    return (fallback as { readonly Config?: CordisXStandardSchema }).Config
  }
  return undefined
}

export function moduleConfigApplies(
  module: {
    readonly configApplies?: CordisXConfigAppliesInput
    readonly default?: unknown
  } | undefined,
): CordisXConfigApplies {
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

export type { ConfigMutationOperation } from './configuration/model.js'

export type { ManagerPluginConfigSnapshot } from './configuration/model.js'

export type { ConfigCandidate } from './configuration/model.js'

export type { ConfigRendererMountHandle } from './configuration/model.js'
