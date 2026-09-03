import type {
  ManagerContentConfigBindingV1,
  ManagerContentConfigCommandV1,
  ManagerContentConfigResultV1,
  ManagerContentConfigSourceV1,
  ManagerContentConfigSubscriptionClosedV1,
  ManagerContentConfigSubscriptionPageV1,
  ManagerContentConfigSubscriptionV1,
  ManagerContentConfigUpdateV1,
  ManagerContentPluginConfigFormBodyV1,
  ManagerContentPluginConfigFormProjectionV1,
} from '@cordisx/protocol/manager-content-navigation/v4'
import type {
  ManagerContentConfigSourceV2,
  ManagerContentConfigSubscriptionPageV2,
  ManagerContentConfigSubscriptionV2,
  ManagerContentConfigUpdateV2,
  ManagerContentPluginConfigFormProjectionV2,
} from '@cordisx/protocol/manager-content-navigation/v5'
import type { CordisXLocalizedText } from '../contracts.js'
import {
  ConfigRevisionConflictError,
  type ConfigMutationOperation,
  type ManagerPluginConfigSnapshot,
  type PluginConfigurationRegistry,
} from './configuration.js'
import type { PluginGenerationView } from './generation-visibility.js'
import { immutableSnapshot } from './validation.js'

const COMMAND_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-content-config-command.v1.schema.json' as const
const RESULT_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-content-config-result.v1.schema.json' as const
const PAGE_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-content-config-subscription-page.v1.schema.json' as const
const PAGE_SCHEMA_V2 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-content-config-subscription-page.v2.schema.json' as const
const CLOSE_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-content-config-subscription-close.v1.schema.json' as const

type SourceUnavailableCode = 'owner-unavailable' | 'stale-generation' | 'binding-replaced' | 'disposed'
export type ManagerContentConfigDisposeReason = 'explicit' | 'declaration-replaced' | 'generation-replaced' | 'owner-disposed'
type CloseCode = ManagerContentConfigSubscriptionClosedV1['code']

function immutable<Value>(value: Value): Value {
  return immutableSnapshot(value)
}

function sameStructuredValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameStructuredValue(value, right[index]))
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).sort()
  const rightKeys = Object.keys(rightRecord).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && sameStructuredValue(leftRecord[key], rightRecord[key]))
}

function opaqueId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`
}

function bindingEquals(left: ManagerContentConfigBindingV1, right: ManagerContentConfigBindingV1): boolean {
  return sameStructuredValue(left, right)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type ConfigSource = ManagerContentConfigSourceV1 | ManagerContentConfigSourceV2
type ConfigProjection = ManagerContentPluginConfigFormProjectionV1 | ManagerContentPluginConfigFormProjectionV2
type ConfigUpdate = ManagerContentConfigUpdateV1 | ManagerContentConfigUpdateV2
type ConfigPage = ManagerContentConfigSubscriptionPageV1 | ManagerContentConfigSubscriptionPageV2
type ConfigSubscription = ManagerContentConfigSubscriptionV1 | ManagerContentConfigSubscriptionV2

class AsyncPageQueue implements AsyncIterable<ConfigPage> {
  private readonly pages: ConfigPage[] = []
  private readonly waiters: ((result: IteratorResult<ConfigPage>) => void)[] = []
  private ended = false

  push(page: ConfigPage): void {
    if (this.ended) return
    const waiter = this.waiters.shift()
    if (waiter === undefined) this.pages.push(page)
    else waiter({ done: false, value: page })
  }

  close(): void {
    if (this.ended) return
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined })
  }

  [Symbol.asyncIterator](): AsyncIterator<ConfigPage> {
    return {
      next: () => {
        const page = this.pages.shift()
        if (page !== undefined) return Promise.resolve({ done: false, value: page })
        if (this.ended) return Promise.resolve({ done: true, value: undefined })
        return new Promise(resolve => this.waiters.push(resolve))
      },
    }
  }
}

interface SubscriptionRecord {
  readonly descriptor: ConfigSubscription['descriptor']
  readonly queue: AsyncPageQueue
  readonly closed: Promise<ManagerContentConfigSubscriptionClosedV1>
  readonly resolveClosed: (value: ManagerContentConfigSubscriptionClosedV1) => void
  settled: boolean
  result?: ManagerContentConfigSubscriptionClosedV1
}

export interface ManagerContentConfigBindingHandle {
  readonly owner: string
  readonly declarationId: string
  readonly moduleGeneration: string
  readonly contractVersion: 1 | 2
  readonly body: ManagerContentPluginConfigFormBodyV1
  readonly source: ConfigSource
  snapshotForHost(): ManagerPluginConfigSnapshot
  close(reason: ManagerContentConfigDisposeReason): void
}

export interface ManagerContentConfigAuthorityOptions {
  readonly configuration: PluginConfigurationRegistry
  readonly profileId: string
  readonly runtimeGeneration: string
  readonly locale: () => string
  readonly resolveText?: (owner: string, message: CordisXLocalizedText, site: string) => string
  readonly update: (
    owner: string,
    expectedRevision: number,
    operations: readonly ConfigMutationOperation[],
  ) => Promise<void>
}

/** One Host-owned authority over Manager config projections and the existing config ledger. */
export class ManagerContentConfigAuthority {
  private readonly handles = new Set<ManagerContentConfigBindingHandleImpl>()
  private disposed = false

  constructor(private readonly options: ManagerContentConfigAuthorityOptions) {}

  bind(input: {
    readonly owner: string
    readonly declarationId: string
    readonly moduleGeneration: string
    readonly contractVersion?: 1 | 2
    readonly view?: PluginGenerationView
    readonly body: ManagerContentPluginConfigFormBodyV1
  }): ManagerContentConfigBindingHandle {
    if (this.disposed) throw new Error('manager content config authority is disposed')
    const handle = new ManagerContentConfigBindingHandleImpl(this.options, input, () => this.handles.delete(handle))
    this.handles.add(handle)
    return handle
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const handle of [...this.handles]) handle.close('owner-disposed')
    this.handles.clear()
  }
}

class ManagerContentConfigBindingHandleImpl implements ManagerContentConfigBindingHandle {
  readonly owner: string
  readonly declarationId: string
  readonly moduleGeneration: string
  readonly contractVersion: 1 | 2
  readonly body: ManagerContentPluginConfigFormBodyV1
  readonly binding: ManagerContentConfigBindingV1
  readonly source: ConfigSource
  private readonly subscriptions = new Set<SubscriptionRecord>()
  private readonly commands = new Map<string, { readonly command: ManagerContentConfigCommandV1; readonly result: ManagerContentConfigResultV1 }>()
  private readonly materializations = new Set<string>()
  private readonly unsubscribeConfiguration: () => void
  private sequence = 0
  private lastBody: ConfigProjection
  private unavailable: SourceUnavailableCode | undefined
  private operation = Promise.resolve()
  private readonly view: PluginGenerationView | undefined

  constructor(
    private readonly options: ManagerContentConfigAuthorityOptions,
    input: {
      readonly owner: string
      readonly declarationId: string
      readonly moduleGeneration: string
      readonly contractVersion?: 1 | 2
      readonly view?: PluginGenerationView
      readonly body: ManagerContentPluginConfigFormBodyV1
    },
    private readonly onClose: () => void,
  ) {
    this.owner = input.owner
    this.declarationId = input.declarationId
    this.moduleGeneration = input.moduleGeneration
    this.contractVersion = input.contractVersion ?? 1
    this.view = input.view
    this.body = immutable(input.body)
    const descriptor = this.descriptor()
    if (descriptor.identity.pluginId !== input.owner) throw new Error('manager content config owner identity does not match the configuration registry')
    if (descriptor.scope.generation !== input.moduleGeneration) {
      throw new Error('manager content config declaration has a stale plugin generation')
    }
    if (descriptor.namespace !== input.body.namespace) {
      throw new Error('manager content config namespace does not match the declaring owner')
    }
    if (input.body.defaultMaterialization !== undefined) {
      if (input.body.defaultMaterialization.mode !== 'missing-only') throw new Error('manager content config default mode is unsupported')
      this.options.configuration.managerContentMissingDefaults(this.owner, input.body.defaultMaterialization.fields, this.view)
    }
    this.binding = immutable({
      bindingId: opaqueId('cx-manager-config'),
      identity: descriptor.identity,
      scope: descriptor.scope,
      declarationId: input.declarationId,
      namespace: input.body.namespace,
    })
    this.lastBody = this.project(descriptor)
    this.unsubscribeConfiguration = this.options.configuration.subscribe(() => this.configurationChanged())
    this.source = Object.freeze({
      binding: this.binding,
      snapshot: () => Promise.resolve(this.snapshot()),
      execute: (command: ManagerContentConfigCommandV1) => this.enqueue(() => this.executeNow(command)),
      subscribe: (afterSequence: number) => Promise.resolve(this.subscribeNow(afterSequence)),
    }) as unknown as ConfigSource
  }

  snapshotForHost(): ManagerPluginConfigSnapshot {
    this.assertAvailable()
    return this.contractVersion === 2
      ? this.options.configuration.managerContentHostDescriptor(
          this.owner,
          this.options.locale(),
          (message, site) => this.options.resolveText?.(this.owner, message, site) ?? message.fallback ?? message.key,
          this.view,
        )
      : this.options.configuration.descriptor(this.owner, this.options.locale(), this.view)
  }

  close(reason: ManagerContentConfigDisposeReason): void {
    if (this.unavailable !== undefined) return
    this.unavailable = reason === 'generation-replaced' ? 'stale-generation'
      : reason === 'declaration-replaced' ? 'binding-replaced'
        : 'disposed'
    this.unsubscribeConfiguration()
    this.sequence += 1
    const update = immutable<ConfigUpdate>({ kind: 'disposed', sequence: this.sequence, reason })
    for (const subscription of [...this.subscriptions]) {
      this.push(subscription, update, 'live')
      this.settle(subscription, reason)
    }
    this.commands.clear()
    this.onClose()
  }

  private enqueue<Value>(work: () => Promise<Value> | Value): Promise<Value> {
    const task = this.operation.then(work)
    this.operation = task.then(() => undefined, () => undefined)
    return task
  }

  private descriptor() {
    return this.options.configuration.managerContentDescriptor(
      this.owner,
      this.options.profileId,
      this.options.runtimeGeneration,
      this.options.locale(),
      this.view,
      this.contractVersion,
    )
  }

  private project(descriptor = this.descriptor()): ConfigProjection {
    const projection = {
      kind: 'plugin-config-form' as const,
      binding: this.binding ?? ({
        bindingId: 'cx-manager-config:pending',
        identity: descriptor.identity,
        scope: descriptor.scope,
        declarationId: this.declarationId,
        namespace: this.body.namespace,
      } satisfies ManagerContentConfigBindingV1),
      sequence: this.sequence,
      configuration: descriptor,
      draft: {
        baseRevision: descriptor.revision,
        dirty: false,
        value: descriptor.value,
        validation: { state: 'unvalidated' as const },
      },
    }
    return this.contractVersion === 2
      ? immutable({ ...projection, configuration: descriptor as ManagerContentPluginConfigFormProjectionV2['configuration'] })
      : immutable({ ...projection, configuration: descriptor as ManagerContentPluginConfigFormProjectionV1['configuration'] })
  }

  private availability(): SourceUnavailableCode | undefined {
    if (this.unavailable !== undefined) return this.unavailable
    try {
      const descriptor = this.descriptor()
      if (descriptor.scope.generation !== this.moduleGeneration) return 'stale-generation'
      if (!bindingEquals(this.binding, {
        ...this.binding,
        identity: descriptor.identity,
        scope: descriptor.scope,
        namespace: descriptor.namespace,
      })) return 'binding-replaced'
      return undefined
    } catch {
      return 'owner-unavailable'
    }
  }

  private assertAvailable(): void {
    const unavailable = this.availability()
    if (unavailable !== undefined) throw new Error(unavailable)
  }

  private snapshot() {
    const unavailable = this.availability()
    return unavailable === undefined
      ? immutable({ status: 'available' as const, body: this.lastBody })
      : immutable({ status: 'unavailable' as const, code: unavailable })
  }

  private commandFence(command: ManagerContentConfigCommandV1) {
    return {
      $schema: RESULT_SCHEMA,
      contract: 'cordisx.manager-content-config-result/v1' as const,
      schemaVersion: 1 as const,
      commandId: command.commandId,
      binding: this.binding,
      expectedRevision: command.expectedRevision,
      operation: command.operation,
    }
  }

  private currentRevision(): number {
    try { return this.descriptor().revision } catch { return this.lastBody.configuration.revision }
  }

  private unavailableResult(command: ManagerContentConfigCommandV1, code:
    'not-writable' | 'owner-unavailable' | 'stale-generation' | 'binding-replaced' | 'disposed' | 'persistence-failed' | 'plugin-restart-failed' | 'service-restart-failed' | 'rollback-failed'): ManagerContentConfigResultV1 {
    return immutable({ ...this.commandFence(command), status: 'unavailable', code, revision: this.currentRevision() })
  }

  private validateCommand(command: ManagerContentConfigCommandV1): ManagerContentConfigResultV1 | undefined {
    if (command === null || typeof command !== 'object'
      || command.$schema !== COMMAND_SCHEMA
      || command.contract !== 'cordisx.manager-content-config-command/v1'
      || command.schemaVersion !== 1
      || typeof command.commandId !== 'string'
      || command.commandId.length < 1
      || command.commandId.length > 256
      || !Number.isInteger(command.expectedRevision)
      || command.expectedRevision < 0
      || !bindingEquals(command.binding, this.binding)) {
      return this.unavailableResult(command, 'binding-replaced')
    }
    const unavailable = this.availability()
    if (unavailable !== undefined) return this.unavailableResult(command, unavailable)
    const descriptor = this.descriptor()
    if (!descriptor.writable) return this.unavailableResult(command, 'not-writable')
    if (command.expectedRevision !== descriptor.revision) {
      return immutable({
        ...this.commandFence(command), status: 'conflict', code: 'revision-conflict',
        revision: descriptor.revision, currentRevision: descriptor.revision,
      })
    }
    return undefined
  }

  private async executeNow(command: ManagerContentConfigCommandV1): Promise<ManagerContentConfigResultV1> {
    const previous = this.commands.get(command.commandId)
    if (previous !== undefined) {
      if (sameStructuredValue(previous.command, command)) return previous.result
      return immutable({
        ...this.commandFence(command), status: 'conflict', code: 'command-conflict',
        revision: this.currentRevision(), currentRevision: this.currentRevision(),
      })
    }
    const rejected = this.validateCommand(command)
    if (rejected !== undefined) return rejected
    let result: ManagerContentConfigResultV1
    if (command.operation === 'draft.validate') result = this.validateDraft(command)
    else if (command.operation === 'draft.save') result = await this.save(command, command.operations, 'saved')
    else result = await this.materialize(command)
    this.commands.set(command.commandId, { command: immutable(command), result })
    return result
  }

  private validateDraft(command: Extract<ManagerContentConfigCommandV1, { operation: 'draft.validate' }>): ManagerContentConfigResultV1 {
    try {
      this.options.configuration.stage(this.owner, command.expectedRevision, command.operations as readonly ConfigMutationOperation[])
      return immutable({ ...this.commandFence(command), status: 'validated', code: 'valid', revision: command.expectedRevision, validation: { state: 'valid' } })
    } catch (error) {
      if (error instanceof ConfigRevisionConflictError) {
        return immutable({ ...this.commandFence(command), status: 'conflict', code: 'revision-conflict', revision: error.actualRevision, currentRevision: error.actualRevision })
      }
      const message = errorMessage(error)
      if (message.startsWith('secret-path:')) return immutable({ ...this.commandFence(command), status: 'rejected', code: 'secret-path', revision: this.currentRevision() })
      return immutable({
        ...this.commandFence(command), status: 'rejected', code: 'validation-failed', revision: this.currentRevision(),
        validation: { state: 'invalid', issues: [{ code: 'invalid', message: { key: 'manager.config.invalid', fallback: message } }] },
      })
    }
  }

  private async save(
    command: ManagerContentConfigCommandV1,
    operations: readonly ConfigMutationOperation[],
    code: 'saved' | 'defaults-materialized',
  ): Promise<ManagerContentConfigResultV1> {
    try {
      await this.options.update(this.owner, command.expectedRevision, operations)
      const descriptor = this.descriptor()
      if (descriptor.applies === 'app-restart') {
        return immutable({ ...this.commandFence(command), status: 'staged', code, revision: descriptor.revision, applies: 'app-restart' })
      }
      return immutable({
        ...this.commandFence(command), status: 'applied', code, revision: descriptor.revision,
        applies: descriptor.applies, resultingGeneration: descriptor.scope.generation,
      })
    } catch (error) {
      if (error instanceof ConfigRevisionConflictError || /revision conflict/iu.test(errorMessage(error))) {
        const revision = error instanceof ConfigRevisionConflictError ? error.actualRevision : this.currentRevision()
        return immutable({ ...this.commandFence(command), status: 'conflict', code: 'revision-conflict', revision, currentRevision: revision })
      }
      const message = errorMessage(error)
      if (message.startsWith('secret-path:')) return immutable({ ...this.commandFence(command), status: 'rejected', code: 'secret-path', revision: this.currentRevision() })
      if (/validation|invalid|required|must /iu.test(message)) {
        return immutable({
          ...this.commandFence(command), status: 'rejected', code: 'validation-failed', revision: this.currentRevision(),
          validation: { state: 'invalid', issues: [{ code: 'invalid', message: { key: 'manager.config.invalid', fallback: message } }] },
        })
      }
      const unavailable = /service-restart/iu.test(message) ? 'service-restart-failed'
        : /plugin restart/iu.test(message) ? 'plugin-restart-failed'
          : /rollback/iu.test(message) ? 'rollback-failed'
            : /writable|read-only/iu.test(message) ? 'not-writable'
              : 'persistence-failed'
      return this.unavailableResult(command, unavailable)
    }
  }

  private async materialize(command: Extract<ManagerContentConfigCommandV1, { operation: 'defaults.materialize' }>): Promise<ManagerContentConfigResultV1> {
    const declaration = this.body.defaultMaterialization
    if (declaration === undefined) {
      return immutable({ ...this.commandFence(command), status: 'rejected', code: 'default-not-declared', revision: this.currentRevision() })
    }
    try {
      const prepared = this.options.configuration.managerContentMissingDefaults(this.owner, declaration.fields, this.view)
      if (prepared.allPresent) {
        const already = this.materializations.has(command.materializationId)
        this.materializations.add(command.materializationId)
        return immutable({
          ...this.commandFence(command), status: 'preserved', code: already ? 'already-materialized' : 'values-present',
          revision: this.currentRevision(),
        })
      }
      const result = await this.save(command, prepared.operations, 'defaults-materialized')
      if (result.status === 'applied' || result.status === 'staged') this.materializations.add(command.materializationId)
      return result
    } catch (error) {
      const message = errorMessage(error)
      const code = message.startsWith('secret-path:') ? 'secret-path'
        : message.startsWith('default-not-declared:') ? 'default-not-declared'
          : 'default-schema-mismatch'
      return immutable({ ...this.commandFence(command), status: 'rejected', code, revision: this.currentRevision() })
    }
  }

  private configurationChanged(): void {
    if (this.unavailable !== undefined) return
    let next: ConfigProjection
    try {
      const descriptor = this.descriptor()
      if (descriptor.scope.generation !== this.moduleGeneration) {
        this.close('generation-replaced')
        return
      }
      next = this.project(descriptor)
    } catch {
      this.close('owner-disposed')
      return
    }
    if (sameStructuredValue(next.configuration, this.lastBody.configuration)) return
    this.sequence += 1
    next = immutable({ ...next, sequence: this.sequence })
    this.lastBody = next
    const update: ConfigUpdate = this.contractVersion === 2
      ? immutable({ kind: 'snapshot-replaced', sequence: this.sequence, body: next as ManagerContentPluginConfigFormProjectionV2 })
      : immutable({ kind: 'snapshot-replaced', sequence: this.sequence, body: next as ManagerContentPluginConfigFormProjectionV1 })
    for (const subscription of this.subscriptions) this.push(subscription, update, 'live')
  }

  private subscribeNow(afterSequence: number) {
    const unavailable = this.availability()
    if (unavailable !== undefined) return immutable({ status: 'unavailable' as const, code: unavailable })
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || afterSequence > this.sequence) {
      return immutable({ status: 'unavailable' as const, code: 'binding-replaced' as const })
    }
    const queue = new AsyncPageQueue()
    let resolveClosed!: (value: ManagerContentConfigSubscriptionClosedV1) => void
    const descriptor = immutable({
      subscriptionId: opaqueId('cx-manager-config-sub'),
      binding: this.binding,
      afterSequence,
      replayThrough: this.sequence,
    })
    const record: SubscriptionRecord = {
      descriptor,
      queue,
      closed: new Promise(resolve => { resolveClosed = resolve }),
      resolveClosed,
      settled: false,
    }
    this.subscriptions.add(record)
    if (afterSequence < this.sequence) {
      const update: ConfigUpdate = this.contractVersion === 2
        ? immutable({ kind: 'snapshot-replaced', sequence: this.sequence, body: this.lastBody as ManagerContentPluginConfigFormProjectionV2 })
        : immutable({ kind: 'snapshot-replaced', sequence: this.sequence, body: this.lastBody as ManagerContentPluginConfigFormProjectionV1 })
      this.push(record, update, 'replay')
    }
    const subscription = Object.freeze({
      descriptor,
      pages: queue,
      closed: record.closed,
      unsubscribe: () => Promise.resolve(this.settle(record, 'unsubscribed')),
    }) as unknown as ConfigSubscription
    return Object.freeze({ status: 'subscribed' as const, subscription })
  }

  private push(record: SubscriptionRecord, update: ConfigUpdate, phase: 'replay' | 'live'): void {
    if (record.settled || update.sequence <= record.descriptor.afterSequence) return
    if (this.contractVersion === 2) {
      record.queue.push(immutable({
        $schema: PAGE_SCHEMA_V2,
        contract: 'cordisx.manager-content-config-subscription-page/v2',
        schemaVersion: 2,
        subscription: record.descriptor,
        phase,
        updates: [update as ManagerContentConfigUpdateV2],
        nextAfterSequence: update.sequence,
        hasMore: false,
      }))
      return
    }
    record.queue.push(immutable({
      $schema: PAGE_SCHEMA,
      contract: 'cordisx.manager-content-config-subscription-page/v1',
      schemaVersion: 1,
      subscription: record.descriptor,
      phase,
      updates: [update as ManagerContentConfigUpdateV1],
      nextAfterSequence: update.sequence,
      hasMore: false,
    }))
  }

  private settle(record: SubscriptionRecord, code: CloseCode | ManagerContentConfigDisposeReason): ManagerContentConfigSubscriptionClosedV1 {
    if (record.result !== undefined) return record.result
    const result = immutable<ManagerContentConfigSubscriptionClosedV1>({
      $schema: CLOSE_SCHEMA,
      contract: 'cordisx.manager-content-config-subscription-close/v1',
      schemaVersion: 1,
      subscriptionId: record.descriptor.subscriptionId,
      binding: this.binding,
      status: 'closed',
      code,
    })
    record.settled = true
    record.result = result
    this.subscriptions.delete(record)
    record.queue.close()
    record.resolveClosed(result)
    return result
  }
}
