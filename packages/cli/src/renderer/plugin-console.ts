import type { Context } from '@deepseek-ai/cordis'
import type {
  CordisXPluginConsoleConsumptionSummaryV1,
  CordisXPluginConsoleCoverage,
  CordisXPluginConsoleEntryV1,
  CordisXPluginConsoleFacade,
  CordisXPluginConsoleKind,
  CordisXPluginConsoleMethod,
  CordisXPluginConsolePageV1,
  CordisXPluginConsolePhase,
  CordisXPluginConsoleStatus,
  CordisXPluginConsoleValueSummaryV1,
  CordisXPluginIdentity,
  CordisXPlatformCapability,
} from '../contracts.js'

const MAX_MESSAGE = 4096
const MAX_PREVIEW = 2048
const MAX_STACK = 16384
const MAX_DEPTH = 4
const MAX_ITEMS = 64
const SENSITIVE_KEY = /(?:^|[_-])(prompt|message|content|secret|credential|password|token|authorization|url|path|cwd)(?:$|[_-])/i

declare const PRINCIPAL_TOKEN_BRAND: unique symbol
/** Private launcher-issued capability. Object identity, not renderer fields, is authoritative. */
export type PluginPrincipalToken = { readonly [PRINCIPAL_TOKEN_BRAND]: true }
export const CORDISX_PLUGIN_PRINCIPAL = Symbol('cordisx.pluginPrincipal')

export interface PluginPrincipalRecord {
  readonly identity: CordisXPluginIdentity
  readonly pluginGeneration: string
  readonly runtimeGeneration: string
}

interface MutablePrincipalRecord extends PluginPrincipalRecord { live: boolean }

function identityKey(identity: CordisXPluginIdentity): string {
  return `${identity.source}\u0000${identity.id}`
}

function clamp(value: string, max: number): { readonly value: string; readonly truncated: boolean } {
  return value.length <= max
    ? { value, truncated: false }
    : { value: `${value.slice(0, Math.max(0, max - 1))}…`, truncated: true }
}

function byteCount(value: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).byteLength
  let bytes = 0
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
  }
  return bytes
}

function safeTag(value: object): string {
  try { return Object.prototype.toString.call(value) } catch { return '[unavailable]' }
}

function errorText(error: unknown): string {
  try { return error instanceof Error ? error.message : String(error) } catch { return 'unavailable error' }
}

function primitiveSnapshot(value: undefined | null | boolean | number | string | bigint | symbol): CordisXPluginConsoleValueSummaryV1 {
  if (value === undefined) return { type: 'undefined', preview: 'undefined' }
  if (value === null) return { type: 'null', preview: 'null', value: null }
  if (typeof value === 'string') {
    const preview = clamp(value, MAX_PREVIEW)
    return { type: 'string', preview: preview.value, value: preview.value, byteCount: byteCount(value), ...(preview.truncated ? { truncated: true } : {}) }
  }
  if (typeof value === 'bigint') return { type: 'bigint', preview: `${value}n`, value: value.toString() }
  if (typeof value === 'symbol') {
    let preview = 'Symbol()'
    try { preview = String(value) } catch { /* safe fallback */ }
    return { type: 'symbol', preview }
  }
  const preview = String(value)
  return { type: typeof value, preview, value }
}

/** Snapshot hostile values without invoking getters. Capture must never affect plugin execution. */
export function snapshotConsoleValue(value: unknown, seen: WeakSet<object> = new WeakSet(), depth = 0): CordisXPluginConsoleValueSummaryV1 {
  try {
    if (value === null || ['undefined', 'boolean', 'number', 'string', 'bigint', 'symbol'].includes(typeof value)) {
      return primitiveSnapshot(value as undefined | null | boolean | number | string | bigint | symbol)
    }
    if (typeof value === 'function') {
      let name = 'anonymous'
      try { name = value.name || name } catch { /* safe fallback */ }
      return { type: 'function', preview: `[Function ${name}]`, name }
    }
    if (typeof value !== 'object') return { type: 'unavailable', preview: '[unavailable]' }
    if (seen.has(value)) return { type: 'circular', preview: '[Circular]' }
    seen.add(value)
    if (value instanceof Error) {
      const name = clamp(value.name || 'Error', 256).value
      const message = clamp(value.message || '', MAX_PREVIEW).value
      const stack = typeof value.stack === 'string' ? clamp(value.stack, MAX_STACK) : undefined
      return {
        type: 'error', name, preview: message === '' ? name : `${name}: ${message}`,
        ...(stack === undefined ? {} : { stack: stack.value, ...(stack.truncated ? { truncated: true } : {}) }),
      }
    }
    if (typeof Element !== 'undefined' && value instanceof Element) {
      let preview = '<element>'
      try {
        const id = value.id === '' ? '' : `#${value.id}`
        const classes = [...value.classList].slice(0, 3).map(item => `.${item}`).join('')
        preview = `<${value.tagName.toLocaleLowerCase()}${id}${classes}>`
      } catch { /* safe fallback */ }
      return { type: 'element', preview }
    }
    if (depth >= MAX_DEPTH) return { type: Array.isArray(value) ? 'array' : 'object', preview: safeTag(value), truncated: true }
    if (Array.isArray(value)) {
      const count = value.length
      const items: CordisXPluginConsoleValueSummaryV1[] = []
      for (let index = 0; index < Math.min(count, MAX_ITEMS); index += 1) {
        let descriptor: PropertyDescriptor | undefined
        try { descriptor = Object.getOwnPropertyDescriptor(value, String(index)) } catch { /* unavailable proxy */ }
        items.push(descriptor !== undefined && 'value' in descriptor
          ? snapshotConsoleValue(descriptor.value, seen, depth + 1)
          : { type: 'unavailable', preview: '[empty or accessor]' })
      }
      return { type: 'array', preview: `Array(${count})`, items, itemCount: count, ...(count > MAX_ITEMS ? { truncated: true } : {}) }
    }
    let descriptors: PropertyDescriptorMap
    try { descriptors = Object.getOwnPropertyDescriptors(value) } catch {
      return { type: 'unavailable', preview: '[unavailable proxy]' }
    }
    const keys = Object.keys(descriptors)
    const entries = keys.slice(0, MAX_ITEMS).map(key => {
      const descriptor = descriptors[key]
      if (descriptor === undefined || !('value' in descriptor)) {
        return { key: clamp(key, 512).value, value: { type: 'unavailable', preview: '[Getter/Setter]' } as CordisXPluginConsoleValueSummaryV1 }
      }
      return { key: clamp(key, 512).value, value: snapshotConsoleValue(descriptor.value, seen, depth + 1) }
    })
    return { type: 'object', preview: safeTag(value), entries, itemCount: keys.length, ...(keys.length > MAX_ITEMS ? { truncated: true } : {}) }
  } catch {
    return { type: 'unavailable', preview: '[unavailable]' }
  }
}

function formatToken(snapshot: CordisXPluginConsoleValueSummaryV1, token: string): string {
  if (token === '%o' || token === '%O' || token === '%j') return snapshot.preview
  if (token === '%d' || token === '%i' || token === '%f') {
    const number = Number(snapshot.value ?? snapshot.preview)
    return Number.isNaN(number) ? 'NaN' : token === '%f' ? String(number) : String(Math.trunc(number))
  }
  return String(snapshot.value ?? snapshot.preview)
}

export function formatConsoleMessage(args: readonly CordisXPluginConsoleValueSummaryV1[]): string {
  if (args.length === 0) return '(empty)'
  let used = 1
  let message = args[0]?.type === 'string' ? String(args[0].value ?? args[0].preview) : args[0]?.preview ?? '(empty)'
  if (args[0]?.type === 'string') {
    message = message.replace(/%[sdifoOj%]/g, token => {
      if (token === '%%') return '%'
      const value = args[used]
      if (value === undefined) return token
      used += 1
      return formatToken(value, token)
    })
  }
  if (used < args.length) message += `${message === '' ? '' : ' '}${args.slice(used).map(item => item.preview).join(' ')}`
  return clamp(message, MAX_MESSAGE).value
}

function consumptionSummary(value: unknown): CordisXPluginConsoleConsumptionSummaryV1 {
  try {
    if (value === undefined) return { type: 'undefined' }
    if (value === null) return { type: 'null' }
    if (typeof value === 'string') return { type: 'string', byteCount: byteCount(value) }
    if (Array.isArray(value)) return { type: 'array', itemCount: value.length }
    if (typeof value !== 'object') return { type: typeof value }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const ok = descriptors.ok !== undefined && 'value' in descriptors.ok ? descriptors.ok.value : undefined
    const projected = ok === true && descriptors.value !== undefined && 'value' in descriptors.value ? descriptors.value.value : value
    if (projected === null || typeof projected !== 'object') return { type: typeof projected }
    const projectedDescriptors = Object.getOwnPropertyDescriptors(projected)
    const collection = ['models', 'sessions', 'events', 'items', 'turns', 'cancelled', 'retained']
      .map(key => projectedDescriptors[key]).find(item => item !== undefined && 'value' in item && Array.isArray(item.value))
    const keys = Object.keys(projectedDescriptors).filter(key => !SENSITIVE_KEY.test(key))
    return {
      type: 'object',
      ...(collection === undefined || !('value' in collection) ? {} : { itemCount: (collection.value as unknown[]).length }),
      ...(keys.length === 0 ? {} : { preview: clamp(keys.slice(0, 12).join(', '), 512).value }),
    }
  } catch { return { type: 'unavailable' } }
}

function terminalFor(value: unknown): { readonly phase: 'success' | 'failure' | 'cancel'; readonly status: 'success' | 'failure' | 'cancelled'; readonly method: CordisXPluginConsoleMethod; readonly message: string } {
  if (value !== null && typeof value === 'object') {
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value)
      if (descriptors.ok !== undefined && 'value' in descriptors.ok && descriptors.ok.value === false) {
        const error = descriptors.error !== undefined && 'value' in descriptors.error ? descriptors.error.value : undefined
        const code = error !== null && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined
        if (code === 'interrupted') return { phase: 'cancel', status: 'cancelled', method: 'warn', message: 'Call cancelled' }
        return { phase: 'failure', status: 'failure', method: 'error', message: 'Call failed' }
      }
    } catch { /* success is based only on a real Host result */ }
  }
  return { phase: 'success', status: 'success', method: 'info', message: 'Call succeeded' }
}

export class PluginPrincipalRegistry {
  private readonly records = new WeakMap<object, MutablePrincipalRecord>()

  issue(identity: CordisXPluginIdentity, pluginGeneration: string, runtimeGeneration: string): PluginPrincipalToken {
    const token = Object.freeze(Object.create(null)) as PluginPrincipalToken
    this.records.set(token, { identity: Object.freeze({ source: identity.source, id: identity.id }), pluginGeneration, runtimeGeneration, live: true })
    return token
  }

  fromContext(ctx: Context): PluginPrincipalToken | undefined {
    return (ctx as Context & { [CORDISX_PLUGIN_PRINCIPAL]?: PluginPrincipalToken })[CORDISX_PLUGIN_PRINCIPAL]
  }

  require(token: PluginPrincipalToken | undefined, runtimeGeneration?: string): PluginPrincipalRecord {
    if (token === undefined) throw new Error('CordisX capability requires a Host-issued plugin principal')
    const record = this.records.get(token)
    if (record === undefined || !record.live || runtimeGeneration !== undefined && record.runtimeGeneration !== runtimeGeneration) {
      throw new Error('CordisX plugin principal is stale or invalid')
    }
    return record
  }

  revoke(token: PluginPrincipalToken): void {
    const record = this.records.get(token)
    if (record !== undefined) record.live = false
  }
}

export interface PluginConsoleInvocation { dispatch(message?: string): void; readonly correlationId: string }
export interface PluginConsolePendingInvocation {
  readonly correlationId: string
  permission(source: string, phase: 'ask' | 'allow' | 'deny', message: string): void
  dispatch(message?: string): void
  success(result?: unknown): void
  failure(error?: unknown): void
  cancel(reason?: unknown): void
}
export interface PluginConsolePermissionObserver {
  permission(identity: CordisXPluginIdentity, capability: CordisXPlatformCapability, phase: 'ask' | 'allow' | 'deny', message: string): void
}

interface EntryDraft {
  readonly coverage: CordisXPluginConsoleCoverage
  readonly kind: CordisXPluginConsoleKind
  readonly method: CordisXPluginConsoleMethod
  readonly source: string
  readonly message: string
  readonly phase?: CordisXPluginConsolePhase
  readonly status?: CordisXPluginConsoleStatus
  readonly correlationId?: string
  readonly sessionId?: string
  readonly context?: { readonly page?: string; readonly invocationKey?: string }
  readonly trigger?: CordisXPluginConsoleEntryV1['trigger']
  readonly durationMs?: number
  readonly args?: readonly CordisXPluginConsoleValueSummaryV1[]
  readonly request?: CordisXPluginConsoleConsumptionSummaryV1
  readonly result?: CordisXPluginConsoleConsumptionSummaryV1
  readonly stack?: string
  readonly effectiveOwner?: CordisXPluginConsoleEntryV1['effectiveOwner']
}

interface OwnerBuffer {
  readonly identity: CordisXPluginIdentity
  readonly entries: CordisXPluginConsoleEntryV1[]
  generation: string
  dropped: number
}

export interface PluginConsoleGenerationAuthority {
  activeModuleGeneration(pluginId: string): string | undefined
  callableGeneration(pluginId: string, moduleGeneration: string): boolean
}

interface ExecutionFrame {
  readonly token: PluginPrincipalToken
  readonly correlationId?: string
  readonly trigger?: CordisXPluginConsoleEntryV1['trigger']
}

/** Host-owned Console store and the one aspect used by public capability facades. */
export class PluginConsoleAspect implements PluginConsolePermissionObserver {
  readonly principals = new PluginPrincipalRegistry()
  private readonly owners = new Map<string, OwnerBuffer>()
  private readonly listeners = new Set<(pluginId: string) => void>()
  private readonly frames = new Map<string, ExecutionFrame[]>()
  private nextEntry = 0
  private nextCall = 0
  private unattributed = 0
  private readonly unattributedFingerprints = new Set<string>()
  private disposed = false

  constructor(
    readonly generation: string,
    private readonly maxEntriesPerPlugin = 2000,
    private readonly now: () => number = () => Date.now(),
    private readonly generationAuthority?: PluginConsoleGenerationAuthority,
  ) {}

  issue(identity: CordisXPluginIdentity, pluginGeneration: string): PluginPrincipalToken {
    this.assertLive()
    const token = this.principals.issue(identity, pluginGeneration, this.generation)
    const key = identityKey(identity)
    const owner = this.owners.get(key) ?? { identity: Object.freeze({ ...identity }), entries: [], generation: pluginGeneration, dropped: 0 }
    owner.generation = pluginGeneration
    this.owners.set(key, owner)
    return token
  }

  consoleFacade(token: PluginPrincipalToken): CordisXPluginConsoleFacade {
    this.principal(token)
    return Object.freeze({
      debug: (...args: unknown[]) => this.console(token, 'debug', args),
      log: (...args: unknown[]) => this.console(token, 'log', args),
      info: (...args: unknown[]) => this.console(token, 'info', args),
      warn: (...args: unknown[]) => this.console(token, 'warn', args),
      error: (...args: unknown[]) => this.console(token, 'error', args),
    })
  }

  lifecycle(token: PluginPrincipalToken, phase: 'activate' | 'dispose' | 'reload', message: string, method: CordisXPluginConsoleMethod = 'info'): void {
    const record = this.principals.require(token, this.generation)
    this.append(record, { coverage: 'host-mediated', kind: 'lifecycle', method, source: `plugin.${phase}`, message, phase, trigger: { kind: 'lifecycle' } })
  }

  diagnostic(token: PluginPrincipalToken, source: string, message: string, error?: unknown): void {
    const record = this.principals.require(token, this.generation)
    const snapshot = snapshotConsoleValue(error)
    this.append(record, {
      coverage: 'host-mediated', kind: 'diagnostic', method: 'error', source, message,
      ...(error === undefined ? {} : { args: [snapshot] }),
      ...(snapshot.stack === undefined ? {} : { stack: snapshot.stack }),
    })
  }

  deactivate(token: PluginPrincipalToken, message = 'Plugin disposed'): void {
    const record = this.principals.require(token, this.generation)
    this.lifecycle(token, 'dispose', message)
    this.frames.delete(identityKey(record.identity))
    this.principals.revoke(token)
  }

  owner(token: PluginPrincipalToken): CordisXPluginIdentity { return this.principal(token).identity }
  tokenFromContext(ctx: Context): PluginPrincipalToken | undefined { return this.principals.fromContext(ctx) }

  async run<Value>(
    token: PluginPrincipalToken,
    source: string,
    request: unknown,
    operation: (invocation: PluginConsoleInvocation) => Value | Promise<Value>,
    context: {
      readonly sessionId?: string
      readonly invocationKey?: string
      readonly trigger?: CordisXPluginConsoleEntryV1['trigger']
      readonly effectiveOwner?: CordisXPluginIdentity
    } = {},
  ): Promise<Value> {
    const record = this.principal(token)
    const correlationId = `cxcall:${encodeURIComponent(this.generation)}:${this.nextCall++}`
    const started = this.now()
    let dispatched = false
    this.append(record, {
      coverage: 'host-mediated', kind: 'invocation', method: 'info', source, message: 'Call requested',
      phase: 'requested', status: 'pending', correlationId, request: consumptionSummary(request),
      trigger: context.trigger ?? { kind: 'capability' },
      ...(context.effectiveOwner === undefined ? {} : { effectiveOwner: { source: context.effectiveOwner.source, pluginId: context.effectiveOwner.id } }),
      ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
      ...(context.invocationKey === undefined ? {} : { context: { invocationKey: context.invocationKey } }),
    })
    const dispatch = (message = 'Dispatched to Host boundary'): void => {
      if (dispatched) return
      dispatched = true
      this.append(record, {
        coverage: 'host-mediated', kind: 'invocation', method: 'debug', source, message,
        phase: 'dispatch', status: 'pending', correlationId, trigger: context.trigger ?? { kind: 'capability' },
        ...(context.effectiveOwner === undefined ? {} : { effectiveOwner: { source: context.effectiveOwner.source, pluginId: context.effectiveOwner.id } }),
      })
    }
    return await this.runInPluginContext(token, { correlationId, trigger: context.trigger ?? { kind: 'capability' } }, async () => {
      try {
        const value = await operation({ correlationId, dispatch })
        if (!dispatched) dispatch('Dispatched to local Host service')
        const terminal = terminalFor(value)
        this.append(record, {
          coverage: 'host-mediated', kind: 'invocation', method: terminal.method, source, message: terminal.message,
          phase: terminal.phase, status: terminal.status, correlationId, durationMs: Math.max(0, this.now() - started),
          result: consumptionSummary(value), trigger: context.trigger ?? { kind: 'capability' },
          ...(context.effectiveOwner === undefined ? {} : { effectiveOwner: { source: context.effectiveOwner.source, pluginId: context.effectiveOwner.id } }),
        })
        return value
      } catch (error) {
        if (!dispatched) dispatch('Dispatched to local Host service')
        const cancelled = typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError'
        const snapshot = snapshotConsoleValue(error)
        this.append(record, {
          coverage: 'host-mediated', kind: 'invocation', method: cancelled ? 'warn' : 'error', source,
          message: cancelled ? 'Call cancelled' : `Call failed: ${errorText(error)}`,
          phase: cancelled ? 'cancel' : 'failure', status: cancelled ? 'cancelled' : 'failure', correlationId,
          durationMs: Math.max(0, this.now() - started), result: { type: cancelled ? 'cancelled' : 'error' },
          args: [snapshot], trigger: context.trigger ?? { kind: 'capability' },
          ...(snapshot.stack === undefined ? {} : { stack: snapshot.stack }),
          ...(context.effectiveOwner === undefined ? {} : { effectiveOwner: { source: context.effectiveOwner.source, pluginId: context.effectiveOwner.id } }),
        })
        throw error
      }
    })
  }

  runSync<Value>(token: PluginPrincipalToken, source: string, request: unknown, operation: () => Value): Value {
    const record = this.principal(token)
    return this.runSyncRecord(record, token, source, request, operation)
  }

  /** Host-only disposal boundary; a retiring principal may clean up but cannot invoke capabilities. */
  runCleanupSync<Value>(token: PluginPrincipalToken, source: string, request: unknown, operation: () => Value): Value {
    const record = this.principals.require(token, this.generation)
    return this.runSyncRecord(record, token, source, request, operation, true)
  }

  private runSyncRecord<Value>(
    record: PluginPrincipalRecord,
    token: PluginPrincipalToken,
    source: string,
    request: unknown,
    operation: () => Value,
    retiring = false,
  ): Value {
    const correlationId = `cxcall:${encodeURIComponent(this.generation)}:${this.nextCall++}`
    const started = this.now()
    this.append(record, {
      coverage: 'host-mediated', kind: 'invocation', method: 'info', source, message: 'Call requested',
      phase: 'requested', status: 'pending', correlationId, request: consumptionSummary(request), trigger: { kind: 'capability' },
    })
    this.append(record, {
      coverage: 'host-mediated', kind: 'invocation', method: 'debug', source, message: 'Dispatched to local Host service',
      phase: 'dispatch', status: 'pending', correlationId, trigger: { kind: 'capability' },
    })
    try {
      const value = retiring
        ? operation()
        : this.runInPluginContext(token, { correlationId, trigger: { kind: 'capability' } }, operation)
      if (value !== null && typeof value === 'object' && typeof (value as PromiseLike<unknown>).then === 'function') {
        throw new Error('CordisX synchronous capability returned a Promise')
      }
      this.append(record, {
        coverage: 'host-mediated', kind: 'invocation', method: 'info', source, message: 'Call succeeded',
        phase: 'success', status: 'success', correlationId, durationMs: Math.max(0, this.now() - started),
        result: consumptionSummary(value), trigger: { kind: 'capability' },
      })
      return value as Value
    } catch (error) {
      const snapshot = snapshotConsoleValue(error)
      this.append(record, {
        coverage: 'host-mediated', kind: 'invocation', method: 'error', source, message: `Call failed: ${errorText(error)}`,
        phase: 'failure', status: 'failure', correlationId, durationMs: Math.max(0, this.now() - started),
        result: { type: 'error' }, args: [snapshot], trigger: { kind: 'capability' },
        ...(snapshot.stack === undefined ? {} : { stack: snapshot.stack }),
      })
      throw error
    }
  }

  beginPending(
    token: PluginPrincipalToken,
    source: string,
    request: unknown,
    context: { readonly sessionId?: string; readonly trigger?: CordisXPluginConsoleEntryV1['trigger'] } = {},
  ): PluginConsolePendingInvocation {
    const record = this.principal(token)
    const correlationId = `cxcall:${encodeURIComponent(this.generation)}:${this.nextCall++}`
    const started = this.now()
    let dispatched = false
    let terminal = false
    const trigger = context.trigger ?? { kind: 'capability' as const }
    this.append(record, {
      coverage: 'host-mediated', kind: 'invocation', method: 'info', source, message: 'Call requested',
      phase: 'requested', status: 'pending', correlationId, request: consumptionSummary(request), trigger,
      ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
    })
    const finish = (phase: 'success' | 'failure' | 'cancel', value?: unknown): void => {
      if (terminal) return
      terminal = true
      const snapshot = phase === 'success' ? undefined : snapshotConsoleValue(value)
      this.append(record, {
        coverage: 'host-mediated', kind: 'invocation', method: phase === 'success' ? 'info' : phase === 'cancel' ? 'warn' : 'error',
        source, message: phase === 'success' ? 'Call succeeded' : phase === 'cancel' ? 'Call cancelled' : 'Call failed',
        phase, status: phase === 'success' ? 'success' : phase === 'cancel' ? 'cancelled' : 'failure', correlationId,
        durationMs: Math.max(0, this.now() - started), result: consumptionSummary(value), trigger,
        ...(snapshot === undefined ? {} : { args: [snapshot], ...(snapshot.stack === undefined ? {} : { stack: snapshot.stack }) }),
      })
    }
    return Object.freeze({
      correlationId,
      permission: (permissionSource: string, phase: 'ask' | 'allow' | 'deny', message: string) => {
        if (terminal) return
        this.append(record, {
          coverage: 'host-mediated', kind: 'permission', method: phase === 'deny' ? 'warn' : 'info', source: permissionSource,
          message, phase, status: phase === 'deny' ? 'denied' : 'pending', correlationId, trigger,
        })
      },
      dispatch: (message = 'Dispatched to Host boundary') => {
        if (terminal || dispatched) return
        dispatched = true
        this.append(record, {
          coverage: 'host-mediated', kind: 'invocation', method: 'debug', source, message,
          phase: 'dispatch', status: 'pending', correlationId, trigger,
        })
      },
      success: (value?: unknown) => finish('success', value),
      failure: (error?: unknown) => finish('failure', error),
      cancel: (reason?: unknown) => finish('cancel', reason),
    })
  }

  runInPluginContext<Value>(
    token: PluginPrincipalToken,
    context: { readonly correlationId?: string; readonly trigger?: CordisXPluginConsoleEntryV1['trigger'] },
    callback: () => Value | Promise<Value>,
  ): Value | Promise<Value> {
    const record = this.principal(token)
    const key = identityKey(record.identity)
    const frame: ExecutionFrame = { token, ...context }
    const frames = this.frames.get(key) ?? []
    frames.push(frame)
    this.frames.set(key, frames)
    const release = (): void => {
      const index = frames.lastIndexOf(frame)
      if (index >= 0) frames.splice(index, 1)
      if (frames.length === 0) this.frames.delete(key)
    }
    try {
      const value = callback()
      if (value !== null && typeof value === 'object' && typeof (value as PromiseLike<unknown>).then === 'function') {
        return Promise.resolve(value).finally(release) as Promise<Value>
      }
      release()
      return value
    } catch (error) { release(); throw error }
  }

  wrapCallback<Args extends readonly unknown[], Value>(token: PluginPrincipalToken, registrationId: string, callback: (...args: Args) => Value | Promise<Value>): (...args: Args) => Value | Promise<Value> {
    return (...args) => this.runInPluginContext(token, { trigger: { kind: 'registration', registrationId } }, () => callback(...args))
  }

  permission(identity: CordisXPluginIdentity, capability: CordisXPlatformCapability, phase: 'ask' | 'allow' | 'deny', message: string): void {
    const frame = this.current(identity)
    if (frame?.correlationId === undefined) return
    let record: PluginPrincipalRecord
    try { record = this.principal(frame.token) } catch { return }
    this.append(record, {
      coverage: 'host-mediated', kind: 'permission', method: phase === 'deny' ? 'warn' : 'info', source: capability,
      message, phase, status: phase === 'deny' ? 'denied' : 'pending', correlationId: frame.correlationId,
      trigger: frame.trigger ?? { kind: 'capability' },
    })
  }

  query(identity: CordisXPluginIdentity): CordisXPluginConsolePageV1 {
    const owner = this.owners.get(identityKey(identity))
    const activeGeneration = this.generationAuthority?.activeModuleGeneration(identity.id)
    const entries = owner?.entries.filter(entry => activeGeneration === undefined || entry.generation === activeGeneration) ?? []
    return Object.freeze({
      contract: 'cordisx.plugin-console-page/v1', schemaVersion: 1,
      plugin: Object.freeze({ source: identity.source, pluginId: identity.id }),
      generation: activeGeneration ?? owner?.generation ?? this.generation, generatedAt: this.now(), partialObservability: true,
      ...(owner === undefined || owner.dropped === 0 ? {} : { droppedEntries: owner.dropped }),
      ...(this.unattributed === 0 ? {} : { unattributedEntries: this.unattributed }),
      entries: Object.freeze([...entries]),
    })
  }

  clear(identity: CordisXPluginIdentity): void {
    const owner = this.owners.get(identityKey(identity))
    if (owner === undefined) return
    const activeGeneration = this.generationAuthority?.activeModuleGeneration(identity.id)
    if (activeGeneration === undefined) owner.entries.length = 0
    else owner.entries.splice(0, owner.entries.length, ...owner.entries.filter(entry => entry.generation !== activeGeneration))
    owner.dropped = 0
    this.notify(identity.id)
  }

  subscribe(listener: (pluginId: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  visibilityChanged(pluginIds: readonly string[]): void {
    for (const pluginId of new Set(pluginIds)) this.notify(pluginId)
  }

  recordUnattributedError(fingerprint = 'unknown'): void {
    if (this.disposed) return
    if (this.unattributedFingerprints.has(fingerprint)) return
    this.unattributedFingerprints.add(fingerprint)
    this.unattributed += 1
    for (const owner of this.owners.values()) this.notify(owner.identity.id)
  }

  /** Project an error boundary only after the Host has one unique bundle/source owner match. */
  recordBestEffortError(token: PluginPrincipalToken, source: string, error: unknown): void {
    if (this.disposed) return
    let record: PluginPrincipalRecord
    try { record = this.principal(token) } catch { return }
    const snapshot = snapshotConsoleValue(error)
    this.append(record, {
      coverage: 'best-effort', kind: 'diagnostic', method: 'error', source,
      message: errorText(error), args: [snapshot], trigger: { kind: 'error-boundary' },
      ...(snapshot.stack === undefined ? {} : { stack: snapshot.stack }),
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.frames.clear()
    this.listeners.clear()
    this.unattributedFingerprints.clear()
  }

  private console(token: PluginPrincipalToken, method: CordisXPluginConsoleMethod, rawArgs: readonly unknown[]): void {
    let record: PluginPrincipalRecord
    try { record = this.principal(token) } catch { return }
    const args = rawArgs.map(item => snapshotConsoleValue(item))
    const frame = this.current(record.identity)
    const error = args.find(item => item.type === 'error')
    this.append(record, {
      coverage: 'scoped-console', kind: 'console', method, source: `console.${method}`,
      message: formatConsoleMessage(args), args,
      ...(frame?.correlationId === undefined ? {} : { correlationId: frame.correlationId }),
      ...(frame?.trigger === undefined ? {} : { trigger: frame.trigger }),
      ...(error?.stack === undefined ? {} : { stack: error.stack }),
    })
  }

  private append(record: PluginPrincipalRecord, draft: EntryDraft): void {
    if (this.disposed) return
    const owner = this.owners.get(identityKey(record.identity))
    if (owner === undefined) return
    const seq = this.nextEntry++
    owner.entries.push(Object.freeze({
      contract: 'cordisx.plugin-console-entry/v1', schemaVersion: 1,
      entryId: `cxconsole:${encodeURIComponent(this.generation)}:${seq}`, seq, time: this.now(),
      plugin: Object.freeze({ source: record.identity.source, pluginId: record.identity.id }),
      generation: record.pluginGeneration, args: Object.freeze([...(draft.args ?? [])]), ...draft,
    }) as CordisXPluginConsoleEntryV1)
    while (owner.entries.length > this.maxEntriesPerPlugin) { owner.entries.shift(); owner.dropped += 1 }
    if (this.generationAuthority?.activeModuleGeneration(record.identity.id) === record.pluginGeneration
      || this.generationAuthority === undefined) this.notify(record.identity.id)
  }

  private current(identity: CordisXPluginIdentity): ExecutionFrame | undefined {
    const frames = this.frames.get(identityKey(identity)) ?? []
    return frames.length === 1 ? frames[0] : undefined
  }

  private principal(token: PluginPrincipalToken | undefined): PluginPrincipalRecord {
    const record = this.principals.require(token, this.generation)
    if (this.generationAuthority !== undefined
      && !this.generationAuthority.callableGeneration(record.identity.id, record.pluginGeneration)) {
      throw new Error('CordisX plugin principal generation is stale')
    }
    return record
  }

  private notify(pluginId: string): void { for (const listener of this.listeners) listener(pluginId) }
  private assertLive(): void { if (this.disposed) throw new Error('Plugin Console aspect is disposed') }
}
