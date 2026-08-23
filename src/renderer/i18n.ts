import { Context, Service, type Disposable, type Effect } from '@deepseek-ai/cordis'
import IntlMessageFormat from 'intl-messageformat'
import type {
  CordisXI18n,
  CordisXLocaleCatalog,
  CordisXLocalizedProjection,
  CordisXLocalizedText,
  CordisXLocalizationDiagnostic,
  CordisXLocalizationSeat,
  CordisXLocalizationSnapshot,
  CordisXMessageParams,
  CordisXMessageSchema,
} from '../contracts.js'
import { CORDISX_PLUGIN_ID } from './service.js'

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}$/

export interface CordisXLocaleSource {
  getSnapshot(): CordisXLocalizationSnapshot
  subscribe(listener: () => void): () => void
}

interface CatalogRecord {
  readonly sequence: number
  readonly owner: string
  readonly namespace: string
  readonly locale: string
  readonly default: boolean
  readonly messages: ReadonlyMap<string, IntlMessageFormat>
}

export interface LocaleCatalogSnapshot {
  readonly owner: string
  readonly namespace: string
  readonly locale: string
  readonly default: boolean
  readonly active: boolean
  readonly messageCount: number
}

function assertId(value: string, label: string): void {
  if (!ID_PATTERN.test(value)) throw new Error(`invalid ${label}: ${value}`)
}

export function canonicalLocale(value: string): string {
  const [canonical] = Intl.getCanonicalLocales(value)
  if (canonical === undefined) throw new Error(`invalid locale: ${value}`)
  return canonical
}

export function qualifyNamespace(owner: string, namespace: string): string {
  if (namespace === owner || namespace.includes(':')) return namespace
  return `${owner}:${namespace}`
}

function normalizedDirection(value: string): 'ltr' | 'rtl' | 'auto' {
  if (value === 'rtl' || value === 'auto') return value
  return 'ltr'
}

/** Read-only adapter whose authority is the upstream html lang/dir attributes. */
export class DocumentLocaleAdapter implements CordisXLocaleSource {
  private readonly listeners = new Set<() => void>()
  private readonly observer?: MutationObserver
  private locale: string
  private direction: 'ltr' | 'rtl' | 'auto'
  private version = 0

  constructor(private readonly document: Document) {
    this.locale = this.readLocale()
    this.direction = normalizedDirection(document.documentElement.dir)
    const Observer = document.defaultView?.MutationObserver
    if (Observer !== undefined) {
      this.observer = new Observer(() => this.refresh())
      this.observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['lang', 'dir'],
      })
    }
  }

  getSnapshot(): CordisXLocalizationSnapshot {
    return { locale: this.locale, direction: this.direction, version: this.version }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.observer?.disconnect()
    this.listeners.clear()
  }

  private readLocale(): string {
    const value = this.document.documentElement.lang.trim()
    if (value === '') return 'en'
    try {
      return canonicalLocale(value)
    } catch {
      return 'en'
    }
  }

  private refresh(): void {
    const locale = this.readLocale()
    const direction = normalizedDirection(this.document.documentElement.dir)
    if (locale === this.locale && direction === this.direction) return
    this.locale = locale
    this.direction = direction
    this.version += 1
    for (const listener of this.listeners) listener()
  }
}

function messageFallback(namespace: string, message: CordisXLocalizedText): string {
  return message.fallback ?? `[[${namespace}:${message.key}]]`
}

function validParams(params: CordisXMessageParams | undefined): boolean {
  if (params === undefined) return true
  return Object.values(params).every(value => value === null || ['string', 'number', 'boolean'].includes(typeof value))
}

/** Framework-independent dictionary registry and projection kernel. */
export class LocalizationRegistry {
  private readonly records = new Map<string, Map<string, CatalogRecord[]>>()
  private readonly listeners = new Set<() => void>()
  private readonly diagnosticRecords = new Map<string, CordisXLocalizationDiagnostic>()
  private readonly disposeSource: () => void
  private version = 0
  private nextSequence = 0
  private disposed = false
  private diagnosticScheduled = false

  constructor(private readonly source: CordisXLocaleSource) {
    this.disposeSource = source.subscribe(() => this.changed())
  }

  getSnapshot(): CordisXLocalizationSnapshot {
    const source = this.source.getSnapshot()
    return { locale: source.locale, direction: source.direction, version: this.version }
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) throw new Error('CordisX localization registry is disposed')
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  define(owner: string, catalog: CordisXLocaleCatalog): () => void {
    if (this.disposed) throw new Error('CordisX localization registry is disposed')
    assertId(owner, 'localization owner')
    const namespace = qualifyNamespace(owner, catalog.namespace)
    const localNamespace = namespace.includes(':') ? namespace.split(':').at(-1) ?? '' : namespace
    assertId(localNamespace, 'locale namespace')
    if (namespace.includes(':') && !namespace.startsWith(`${owner}:`)) {
      throw new Error(`plugin ${owner} cannot define foreign locale namespace ${namespace}`)
    }
    const locale = canonicalLocale(catalog.locale)
    if (locale !== catalog.locale) throw new Error(`locale must use canonical serialization: ${locale}`)
    const defaults = this.records.get(namespace)
    if (catalog.default === true && defaults !== undefined) {
      for (const [otherLocale, stack] of defaults) {
        if (otherLocale === locale) continue
        if (stack.some(record => record.default)) {
          throw new Error(`locale namespace ${namespace} already has a live default dictionary`)
        }
      }
    }

    const messages = new Map<string, IntlMessageFormat>()
    for (const [key, value] of Object.entries(catalog.messages)) {
      assertId(key, 'locale message key')
      if (typeof value !== 'string') throw new Error(`locale message ${key} must be a string`)
      try {
        messages.set(key, new IntlMessageFormat(value, locale))
      } catch {
        throw new Error(`locale message ${namespace}:${key} is not valid ICU MessageFormat`)
      }
    }
    if (messages.size === 0) throw new Error(`locale dictionary ${namespace}/${locale} is empty`)

    const record: CatalogRecord = {
      sequence: this.nextSequence++,
      owner,
      namespace,
      locale,
      default: catalog.default === true,
      messages,
    }
    const localeMap = this.records.get(namespace) ?? new Map<string, CatalogRecord[]>()
    this.records.set(namespace, localeMap)
    const stack = localeMap.get(locale) ?? []
    localeMap.set(locale, stack)
    stack.push(record)
    this.changed()

    let active = true
    return () => {
      if (!active) return
      active = false
      const index = stack.indexOf(record)
      if (index >= 0) stack.splice(index, 1)
      if (stack.length === 0) localeMap.delete(locale)
      if (localeMap.size === 0) this.records.delete(namespace)
      this.changed()
    }
  }

  hasNamespace(owner: string, namespace: string): boolean {
    return this.records.has(qualifyNamespace(owner, namespace))
  }

  resolve(owner: string, message: CordisXLocalizedText): CordisXLocalizedProjection {
    const namespace = message.namespace === undefined ? owner : qualifyNamespace(owner, message.namespace)
    const diagnosticKey = `${owner}\u0000${namespace}\u0000${message.key}`
    if (!ID_PATTERN.test(message.key) || !validParams(message.params)) {
      return this.recordDiagnostic(diagnosticKey, owner, message, {
        text: messageFallback(namespace, message),
        namespace,
        key: message.key,
        diagnostic: 'invalid-message',
        detail: 'message key or params are invalid',
      })
    }

    const localeMap = this.records.get(namespace)
    if (localeMap === undefined) {
      return this.recordDiagnostic(diagnosticKey, owner, message, {
        text: messageFallback(namespace, message),
        namespace,
        key: message.key,
        diagnostic: 'missing-namespace',
        detail: `locale namespace ${namespace} is not registered`,
      })
    }

    const current = canonicalLocale(this.source.getSnapshot().locale)
    const language = new Intl.Locale(current).language
    const active = [...localeMap.values()].map(stack => stack.at(-1)).filter((item): item is CatalogRecord => item !== undefined)
    const defaultRecord = active.filter(record => record.default).sort((left, right) => right.sequence - left.sequence)[0]
    const candidates = [...new Set([current, language, defaultRecord?.locale].filter((item): item is string => item !== undefined))]
    let record: CatalogRecord | undefined
    let formatter: IntlMessageFormat | undefined
    for (const locale of candidates) {
      const candidate = localeMap.get(locale)?.at(-1)
      const candidateFormatter = candidate?.messages.get(message.key)
      if (candidate !== undefined && candidateFormatter !== undefined) {
        record = candidate
        formatter = candidateFormatter
        break
      }
    }
    if (record === undefined || formatter === undefined) {
      return this.recordDiagnostic(diagnosticKey, owner, message, {
        text: messageFallback(namespace, message),
        namespace,
        key: message.key,
        diagnostic: 'missing-key',
        detail: `message ${namespace}:${message.key} is not available for ${current}`,
      })
    }

    try {
      const text = String(formatter.format(message.params ?? {}))
      if (this.diagnosticRecords.delete(diagnosticKey)) this.scheduleDiagnosticNotification()
      return { text, namespace, key: message.key, locale: record.locale }
    } catch {
      return this.recordDiagnostic(diagnosticKey, owner, message, {
        text: messageFallback(namespace, message),
        namespace,
        key: message.key,
        locale: record.locale,
        diagnostic: 'missing-params',
        detail: `message ${namespace}:${message.key} is missing required params`,
      })
    }
  }

  diagnostics(): readonly CordisXLocalizationDiagnostic[] {
    return [...this.diagnosticRecords.values()].sort((left, right) => {
      return left.owner.localeCompare(right.owner)
        || left.namespace.localeCompare(right.namespace)
        || left.key.localeCompare(right.key)
    })
  }

  catalogs(): readonly LocaleCatalogSnapshot[] {
    const result: LocaleCatalogSnapshot[] = []
    for (const [namespace, localeMap] of this.records) {
      for (const [locale, stack] of localeMap) {
        const winner = stack.at(-1)
        for (const record of stack) {
          result.push({
            owner: record.owner,
            namespace,
            locale,
            default: record.default,
            active: record === winner,
            messageCount: record.messages.size,
          })
        }
      }
    }
    return result.sort((left, right) => left.namespace.localeCompare(right.namespace) || left.locale.localeCompare(right.locale))
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disposeSource()
    this.records.clear()
    this.diagnosticRecords.clear()
    this.listeners.clear()
  }

  private recordDiagnostic(
    id: string,
    owner: string,
    message: CordisXLocalizedText,
    projection: CordisXLocalizedProjection,
  ): CordisXLocalizedProjection {
    const next = { owner, message, ...projection }
    const previous = this.diagnosticRecords.get(id)
    this.diagnosticRecords.set(id, next)
    if (JSON.stringify(previous) !== JSON.stringify(next)) this.scheduleDiagnosticNotification()
    return projection
  }

  private scheduleDiagnosticNotification(): void {
    if (this.diagnosticScheduled || this.disposed) return
    this.diagnosticScheduled = true
    queueMicrotask(() => {
      this.diagnosticScheduled = false
      if (this.disposed) return
      for (const listener of this.listeners) listener()
    })
  }

  private changed(): void {
    if (this.disposed) return
    this.version += 1
    this.diagnosticRecords.clear()
    for (const listener of this.listeners) listener()
  }
}

function pluginOwner(ctx: Context): string {
  return (ctx as Context & { [CORDISX_PLUGIN_ID]?: string })[CORDISX_PLUGIN_ID] ?? 'host'
}

/** Fiber-aware Cordis service over LocalizationRegistry. */
export class CordisXI18nService extends Service implements CordisXI18n {
  private readonly adapter: DocumentLocaleAdapter
  private readonly registry: LocalizationRegistry

  constructor(ctx: Context) {
    super(ctx, 'i18n')
    if (typeof document === 'undefined') throw new Error('CordisX localization requires a browser document')
    this.adapter = new DocumentLocaleAdapter(document)
    this.registry = new LocalizationRegistry(this.adapter)
    ctx.effect(() => () => {
      this.registry.dispose()
      this.adapter.dispose()
    }, 'cordisx: localization registry')
  }

  define<Messages extends CordisXMessageSchema>(
    catalog: CordisXLocaleCatalog<Messages>,
  ): ReturnType<CordisXI18n['define']> {
    const owner = pluginOwner(this.ctx)
    return this.ctx.effect(() => this.registry.define(owner, catalog), `i18n.define(${JSON.stringify(catalog.namespace)}, ${JSON.stringify(catalog.locale)})`)
  }

  inject<Messages extends CordisXMessageSchema>(
    namespace: string,
    setup: (seat: CordisXLocalizationSeat<Messages>) => Effect,
  ): ReturnType<CordisXI18n['inject']> {
    const owner = pluginOwner(this.ctx)
    if (!this.registry.hasNamespace(owner, namespace)) {
      throw new Error(`locale namespace ${qualifyNamespace(owner, namespace)} is not declared`)
    }
    const seat = this.createSeat<Messages>(owner, namespace)
    return this.ctx.effect(() => setup(seat), `i18n.inject(${JSON.stringify(namespace)})`)
  }

  seat<Messages extends CordisXMessageSchema>(namespace?: string): CordisXLocalizationSeat<Messages> {
    const owner = pluginOwner(this.ctx)
    return this.createSeat<Messages>(owner, namespace ?? owner)
  }

  resolve(message: CordisXLocalizedText): CordisXLocalizedProjection {
    return this.registry.resolve(pluginOwner(this.ctx), message)
  }

  resolveFor(owner: string, message: CordisXLocalizedText): CordisXLocalizedProjection {
    return this.registry.resolve(owner, message)
  }

  getSnapshot(): CordisXLocalizationSnapshot {
    return this.registry.getSnapshot()
  }

  diagnostics(): readonly CordisXLocalizationDiagnostic[] {
    return this.registry.diagnostics()
  }

  catalogs(): readonly LocaleCatalogSnapshot[] {
    return this.registry.catalogs()
  }

  subscribeInternal(listener: () => void): () => void {
    return this.registry.subscribe(listener)
  }

  seatFor<Messages extends CordisXMessageSchema>(owner: string, namespace?: string): CordisXLocalizationSeat<Messages> {
    return this.createSeat(owner, namespace ?? owner)
  }

  private createSeat<Messages extends CordisXMessageSchema>(
    owner: string,
    namespace: string,
  ): CordisXLocalizationSeat<Messages> {
    const qualified = qualifyNamespace(owner, namespace)
    const messageNamespace = qualified === owner ? undefined : qualified
    const own = (setup: () => Disposable<void>): Disposable<void> => {
      return this.ctx.effect(setup, `i18n seat ${qualified}`) as Disposable<void>
    }
    const messageFor = <Key extends Extract<keyof Messages, string>>(
      key: Key,
      ...args: Messages[Key] extends CordisXMessageParams ? [params: Messages[Key]] : [params?: undefined]
    ): CordisXLocalizedText<Messages[Key] extends CordisXMessageParams ? Messages[Key] : CordisXMessageParams> => {
      const message = {
        ...(messageNamespace === undefined ? {} : { namespace: messageNamespace }),
        key,
        ...(args[0] === undefined ? {} : { params: args[0] }),
      }
      return message as unknown as CordisXLocalizedText<
        Messages[Key] extends CordisXMessageParams ? Messages[Key] : CordisXMessageParams
      >
    }
    const seat: CordisXLocalizationSeat<Messages> = {
      namespace: qualified,
      t: (key, ...args) => this.registry.resolve(owner, {
        ...(messageNamespace === undefined ? {} : { namespace: messageNamespace }),
        key,
        ...(args[0] === undefined ? {} : { params: args[0] }),
      }).text,
      message: messageFor,
      getSnapshot: () => this.registry.getSnapshot(),
      subscribe: listener => own(() => this.registry.subscribe(listener)),
      effect: setup => own(() => {
        let cleanup: (() => void) | undefined
        const project = (): void => {
          cleanup?.()
          const result = setup(this.registry.getSnapshot())
          cleanup = typeof result === 'function' ? result : undefined
        }
        project()
        const unsubscribe = this.registry.subscribe(project)
        return () => {
          unsubscribe()
          cleanup?.()
        }
      }),
      bindText: (node, message) => seat.effect(() => {
        node.textContent = this.registry.resolve(owner, message).text
        return () => {}
      }),
      bindAttribute: (element, name, message) => seat.effect(() => {
        element.setAttribute(name, this.registry.resolve(owner, message).text)
        return () => {}
      }),
    }
    return seat
  }
}
