import { Context, type Disposable, type Effect, Service } from '@deepseek-ai/cordis'
import IntlMessageFormat from 'intl-messageformat'
import type {
  CordisXI18n,
  CordisXLocaleCatalog,
  CordisXLocalizationDiagnostic,
  CordisXLocalizationSeat,
  CordisXLocalizationSnapshot,
  CordisXLocalizedProjection,
  CordisXLocalizedText,
  CordisXMessageDefinition,
  CordisXMessageParams,
} from '../contracts.js'
import { ownerFromContext } from './ownership.js'
import {
  type GenerationVisibilityCoordinator,
  generationVisibilityFromContext,
  type PluginGenerationEffectIdentity,
  type PluginGenerationView,
} from './generation-visibility.js'
import { LOCAL_ID_PATTERN, REFERENCE_PATTERN } from './validation.js'

export interface CordisXLocaleSource {
  getSnapshot(): CordisXLocalizationSnapshot
  subscribe(listener: () => void): () => void
}

export type LocalizationEffectOwner = (setup: () => Disposable<void>) => Disposable<void>

interface CatalogRecord {
  readonly sequence: number
  readonly owner: string
  readonly generation: PluginGenerationEffectIdentity
  readonly candidateView?: PluginGenerationView
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
  if (!LOCAL_ID_PATTERN.test(value)) throw new Error(`invalid ${label}: ${value}`)
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
  private snapshot: CordisXLocalizationSnapshot

  constructor(private readonly document: Document) {
    this.locale = this.readLocale()
    this.direction = normalizedDirection(document.documentElement.dir)
    this.snapshot = Object.freeze({ locale: this.locale, direction: this.direction, version: this.version })
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
    return this.snapshot
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
    this.snapshot = Object.freeze({ locale, direction, version: this.version })
    this.notify(this.listeners)
  }

  private notify(listeners: ReadonlySet<() => void>): void {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('CordisX locale subscriber failed', error)
      }
    }
  }
}

function messageFallback(namespace: string, message: CordisXLocalizedText): string {
  return message.fallback ?? `[[${namespace}:${message.key}]]`
}

interface NormalizedMessage {
  readonly valid: boolean
  readonly message: CordisXLocalizedText
}

function normalizeMessage(value: unknown): NormalizedMessage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, message: { key: 'invalid' } }
  }
  const raw = value as Record<string, unknown>
  let valid = Object.keys(raw).every(key => ['namespace', 'key', 'params', 'fallback'].includes(key))
  const key = typeof raw.key === 'string' && LOCAL_ID_PATTERN.test(raw.key) ? raw.key : 'invalid'
  if (key !== raw.key) valid = false
  const namespace = typeof raw.namespace === 'string' && REFERENCE_PATTERN.test(raw.namespace)
    ? raw.namespace
    : undefined
  if (raw.namespace !== undefined && namespace === undefined) valid = false
  const fallback = typeof raw.fallback === 'string' && raw.fallback.length > 0 && raw.fallback.length <= 4000
    ? raw.fallback
    : undefined
  if (raw.fallback !== undefined && fallback === undefined) valid = false

  let params: Record<string, string | number | boolean | null> | undefined
  if (raw.params !== undefined) {
    const prototype = raw.params === null || typeof raw.params !== 'object'
      ? undefined
      : Object.getPrototypeOf(raw.params)
    const constructor =
      prototype === null || prototype === undefined || !Object.prototype.hasOwnProperty.call(prototype, 'constructor')
        ? undefined
        : (prototype as { constructor?: unknown }).constructor
    if (
      raw.params === null || typeof raw.params !== 'object' || Array.isArray(raw.params)
      || Object.prototype.toString.call(raw.params) !== '[object Object]'
      || (constructor !== undefined && (typeof constructor !== 'function' || constructor.name !== 'Object'))
    ) {
      valid = false
    } else {
      const entries = Object.entries(raw.params as Record<string, unknown>)
      if (entries.length > 32) valid = false
      params = {}
      for (const [name, item] of entries.sort(([left], [right]) => left.localeCompare(right))) {
        if (
          !/^[a-z][a-zA-Z0-9]*$/.test(name)
          || (item !== null && !['string', 'number', 'boolean'].includes(typeof item))
          || (typeof item === 'number' && !Number.isFinite(item))
        ) {
          valid = false
          continue
        }
        params[name] = item as string | number | boolean | null
      }
    }
  }
  return {
    valid,
    message: Object.freeze({
      ...(namespace === undefined ? {} : { namespace }),
      key,
      ...(params === undefined ? {} : { params: Object.freeze(params) }),
      ...(fallback === undefined ? {} : { fallback }),
    }),
  }
}

function diagnosticIdentity(owner: string, namespace: string, message: CordisXLocalizedText): string {
  return `message:${JSON.stringify([owner, namespace, message.key, message.params ?? {}, message.fallback ?? ''])}`
}

/** Framework-independent dictionary registry and projection kernel. */
export class LocalizationRegistry {
  private readonly records = new Map<string, Map<string, CatalogRecord[]>>()
  private readonly listeners = new Set<() => void>()
  private readonly diagnosticListeners = new Set<() => void>()
  private readonly diagnosticRecords = new Map<string, CordisXLocalizationDiagnostic>()
  private readonly disposeSource: () => void
  private version = 0
  private nextSequence = 0
  private disposed = false
  private diagnosticScheduled = false
  private snapshot: CordisXLocalizationSnapshot
  private readonly disconnectVisibility: (() => void) | undefined

  constructor(
    private readonly source: CordisXLocaleSource,
    private readonly visibility?: GenerationVisibilityCoordinator,
  ) {
    const initial = source.getSnapshot()
    this.snapshot = Object.freeze({ locale: initial.locale, direction: initial.direction, version: this.version })
    this.disposeSource = source.subscribe(() => this.changed())
    this.disconnectVisibility = visibility?.connect({ notify: () => this.changed() })
  }

  getSnapshot(): CordisXLocalizationSnapshot {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) throw new Error('CordisX localization registry is disposed')
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeDiagnostics(listener: () => void): () => void {
    if (this.disposed) throw new Error('CordisX localization registry is disposed')
    this.diagnosticListeners.add(listener)
    return () => this.diagnosticListeners.delete(listener)
  }

  define(ownerOrContext: string | Context, catalog: CordisXLocaleCatalog): () => void {
    if (this.disposed) throw new Error('CordisX localization registry is disposed')
    const owner = typeof ownerOrContext === 'string' ? ownerOrContext : ownerFromContext(ownerOrContext)
    const generation: PluginGenerationEffectIdentity = typeof ownerOrContext === 'string'
      ? Object.freeze({ pluginId: owner })
      : this.visibility?.effect(ownerOrContext) ?? Object.freeze({ pluginId: owner })
    const candidateView = typeof ownerOrContext === 'string' || generation.transactionId === undefined
      ? undefined
      : this.visibility?.view(ownerOrContext)
    assertId(owner, 'localization owner')
    assertId(catalog.namespace, 'locale namespace')
    const namespace = qualifyNamespace(owner, catalog.namespace)
    const locale = canonicalLocale(catalog.locale)
    if (locale !== catalog.locale) throw new Error(`locale must use canonical serialization: ${locale}`)
    const defaults = this.records.get(namespace)
    if (catalog.default === true && defaults !== undefined) {
      for (const [otherLocale, stack] of defaults) {
        if (otherLocale === locale) continue
        if (
          stack.some(record => record.default && (this.visibility?.visible(record.generation, candidateView) ?? true))
        ) {
          throw new Error(`locale namespace ${namespace} already has a live default dictionary`)
        }
      }
    }

    const messages = new Map<string, IntlMessageFormat>()
    for (const [key, value] of Object.entries(catalog.messages)) {
      assertId(key, 'locale message key')
      if (typeof value !== 'string') throw new Error(`locale message ${key} must be a string`)
      try {
        messages.set(key, new IntlMessageFormat(value, locale, undefined, { ignoreTag: true }))
      } catch {
        throw new Error(`locale message ${namespace}:${key} is not valid ICU MessageFormat`)
      }
    }
    if (messages.size === 0) throw new Error(`locale dictionary ${namespace}/${locale} is empty`)

    const record: CatalogRecord = {
      sequence: this.nextSequence++,
      owner,
      generation,
      ...(candidateView === undefined ? {} : { candidateView }),
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
    if (this.visibility?.visible(generation) !== false) this.changed()

    let active = true
    return () => {
      if (!active) return
      active = false
      const index = stack.indexOf(record)
      if (index >= 0) stack.splice(index, 1)
      if (stack.length === 0) localeMap.delete(locale)
      if (localeMap.size === 0) this.records.delete(namespace)
      if (this.visibility?.visible(generation) !== false) this.changed()
    }
  }

  hasNamespace(owner: string, namespace: string, view?: PluginGenerationView): boolean {
    const catalogs = this.records.get(qualifyNamespace(owner, namespace))
    return catalogs !== undefined && [...catalogs.values()].some(stack =>
      stack.some(record => (
        this.visibility?.visible(record.generation, view) ?? true
      ))
    )
  }

  resolve(
    owner: string,
    message: CordisXLocalizedText,
    diagnosticSite?: string,
    view?: PluginGenerationView,
  ): CordisXLocalizedProjection {
    if (this.disposed) throw new Error('CordisX localization registry is disposed')
    const normalized = normalizeMessage(message)
    const safeMessage = normalized.message
    const namespace = safeMessage.namespace === undefined ? owner : qualifyNamespace(owner, safeMessage.namespace)
    const diagnosticKey = diagnosticSite === undefined
      ? diagnosticIdentity(owner, namespace, safeMessage)
      : `site:${JSON.stringify([owner, diagnosticSite])}`
    const diagnostic = (projection: CordisXLocalizedProjection): CordisXLocalizedProjection => (
      view?.transactionId === undefined
        ? this.recordDiagnostic(diagnosticKey, owner, safeMessage, diagnosticSite, projection)
        : projection
    )
    if (!normalized.valid) {
      return diagnostic({
        text: messageFallback(namespace, safeMessage),
        namespace,
        key: safeMessage.key,
        diagnostic: 'invalid-message',
        detail: 'message key or params are invalid',
      })
    }

    const localeMap = this.records.get(namespace)
    if (localeMap === undefined) {
      return diagnostic({
        text: messageFallback(namespace, safeMessage),
        namespace,
        key: safeMessage.key,
        diagnostic: 'missing-namespace',
        detail: `locale namespace ${namespace} is not registered`,
      })
    }

    const current = canonicalLocale(this.source.getSnapshot().locale)
    const language = new Intl.Locale(current).language
    const active = [...localeMap.values()]
      .map(stack => [...stack].reverse().find(record => this.visibility?.visible(record.generation, view) ?? true))
      .filter((item): item is CatalogRecord => item !== undefined)
    const defaultRecord =
      active.filter(record => record.default).sort((left, right) => right.sequence - left.sequence)[0]
    const candidates = [
      ...new Set([current, language, defaultRecord?.locale].filter((item): item is string => item !== undefined)),
    ]
    let record: CatalogRecord | undefined
    let formatter: IntlMessageFormat | undefined
    for (const locale of candidates) {
      const candidate = [...(localeMap.get(locale) ?? [])].reverse()
        .find(item => this.visibility?.visible(item.generation, view) ?? true)
      const candidateFormatter = candidate?.messages.get(safeMessage.key)
      if (candidate !== undefined && candidateFormatter !== undefined) {
        record = candidate
        formatter = candidateFormatter
        break
      }
    }
    if (record === undefined || formatter === undefined) {
      return diagnostic({
        text: messageFallback(namespace, safeMessage),
        namespace,
        key: safeMessage.key,
        diagnostic: 'missing-key',
        detail: `message ${namespace}:${safeMessage.key} is not available for ${current}`,
      })
    }

    try {
      const text = String(formatter.format(safeMessage.params ?? {}))
      if (view?.transactionId === undefined && this.diagnosticRecords.delete(diagnosticKey)) {
        this.scheduleDiagnosticNotification()
      }
      return { text, namespace, key: safeMessage.key, locale: record.locale }
    } catch {
      return diagnostic({
        text: messageFallback(namespace, safeMessage),
        namespace,
        key: safeMessage.key,
        locale: record.locale,
        diagnostic: 'missing-params',
        detail: `message ${namespace}:${safeMessage.key} is missing required params`,
      })
    }
  }

  diagnostics(): readonly CordisXLocalizationDiagnostic[] {
    return [...this.diagnosticRecords.values()].sort((left, right) => {
      return left.owner.localeCompare(right.owner)
        || left.namespace.localeCompare(right.namespace)
        || left.key.localeCompare(right.key)
        || JSON.stringify(left.message.params ?? {}).localeCompare(JSON.stringify(right.message.params ?? {}))
        || (left.message.fallback ?? '').localeCompare(right.message.fallback ?? '')
    })
  }

  catalogs(): readonly LocaleCatalogSnapshot[] {
    const result: LocaleCatalogSnapshot[] = []
    for (const [namespace, localeMap] of this.records) {
      for (const [locale, stack] of localeMap) {
        const visible = stack.filter(record => this.visibility?.visible(record.generation) ?? true)
        const winner = visible.at(-1)
        for (const record of visible) {
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
    return result.sort((left, right) =>
      left.namespace.localeCompare(right.namespace) || left.locale.localeCompare(right.locale)
    )
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disposeSource()
    this.disconnectVisibility?.()
    this.records.clear()
    this.diagnosticRecords.clear()
    this.listeners.clear()
    this.diagnosticListeners.clear()
  }

  private recordDiagnostic(
    id: string,
    owner: string,
    message: CordisXLocalizedText,
    site: string | undefined,
    projection: CordisXLocalizedProjection,
  ): CordisXLocalizedProjection {
    const next = { owner, message, ...(site === undefined ? {} : { site }), ...projection }
    const previous = this.diagnosticRecords.get(id)
    this.diagnosticRecords.set(id, next)
    if (site === undefined && this.diagnosticRecords.size > 512) {
      const oldest = [...this.diagnosticRecords.keys()].find(key => key.startsWith('message:'))
      if (oldest !== undefined && oldest !== id) this.diagnosticRecords.delete(oldest)
    }
    if (JSON.stringify(previous) !== JSON.stringify(next)) this.scheduleDiagnosticNotification()
    return projection
  }

  private scheduleDiagnosticNotification(): void {
    if (this.diagnosticScheduled || this.disposed) return
    this.diagnosticScheduled = true
    queueMicrotask(() => {
      this.diagnosticScheduled = false
      if (this.disposed) return
      this.notify(this.diagnosticListeners, 'diagnostic')
    })
  }

  clearDiagnosticSite(owner: string, site: string): void {
    if (this.diagnosticRecords.delete(`site:${JSON.stringify([owner, site])}`)) this.scheduleDiagnosticNotification()
  }

  private changed(): void {
    if (this.disposed) return
    this.version += 1
    const source = this.source.getSnapshot()
    this.snapshot = Object.freeze({ locale: source.locale, direction: source.direction, version: this.version })
    this.diagnosticRecords.clear()
    this.notify(this.listeners, 'projection')
    this.notify(this.diagnosticListeners, 'diagnostic')
  }

  private notify(listeners: ReadonlySet<() => void>, kind: string): void {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        console.error(`CordisX localization ${kind} subscriber failed`, error)
      }
    }
  }
}

/** Fiber-aware Cordis service over LocalizationRegistry. */
export class CordisXI18nService extends Service implements CordisXI18n {
  private readonly adapter: DocumentLocaleAdapter
  private readonly registry: LocalizationRegistry

  constructor(ctx: Context) {
    super(ctx, 'i18n')
    if (typeof document === 'undefined') throw new Error('CordisX localization requires a browser document')
    this.adapter = new DocumentLocaleAdapter(document)
    this.registry = new LocalizationRegistry(this.adapter, generationVisibilityFromContext(ctx))
    ctx.effect(() => () => {
      this.registry.dispose()
      this.adapter.dispose()
    }, 'cordisx: localization registry')
  }

  define<Messages extends CordisXMessageDefinition<Messages>>(
    catalog: CordisXLocaleCatalog<Messages>,
  ): ReturnType<CordisXI18n['define']> {
    return this.ctx.effect(
      () => this.registry.define(this.ctx, catalog),
      `i18n.define(${JSON.stringify(catalog.namespace)}, ${JSON.stringify(catalog.locale)})`,
    )
  }

  inject<Messages extends CordisXMessageDefinition<Messages>>(
    namespace: string,
    setup: (seat: CordisXLocalizationSeat<Messages>) => Effect,
  ): ReturnType<CordisXI18n['inject']> {
    const owner = ownerFromContext(this.ctx)
    const view = generationVisibilityFromContext(this.ctx)?.view(this.ctx)
    if (!this.registry.hasNamespace(owner, namespace, view)) {
      throw new Error(`locale namespace ${qualifyNamespace(owner, namespace)} is not declared`)
    }
    const seat = this.createSeat<Messages>(owner, namespace, undefined, view)
    return this.ctx.effect(() => setup(seat), `i18n.inject(${JSON.stringify(namespace)})`)
  }

  seat<Messages extends CordisXMessageDefinition<Messages>>(namespace?: string): CordisXLocalizationSeat<Messages> {
    const owner = ownerFromContext(this.ctx)
    return this.createSeat<Messages>(
      owner,
      namespace ?? owner,
      undefined,
      generationVisibilityFromContext(this.ctx)?.view(this.ctx),
    )
  }

  resolve(message: CordisXLocalizedText): CordisXLocalizedProjection {
    return this.registry.resolve(
      ownerFromContext(this.ctx),
      message,
      undefined,
      generationVisibilityFromContext(this.ctx)?.view(this.ctx),
    )
  }

  resolveFor(owner: string, message: CordisXLocalizedText, diagnosticSite?: string): CordisXLocalizedProjection {
    return this.registry.resolve(owner, message, diagnosticSite)
  }

  clearDiagnosticSite(owner: string, site: string): void {
    this.registry.clearDiagnosticSite(owner, site)
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
    let scheduled = false
    let active = true
    const coalesced = (): void => {
      if (scheduled || !active) return
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        if (active) listener()
      })
    }
    const unsubscribeProjection = this.registry.subscribe(coalesced)
    const unsubscribeDiagnostics = this.registry.subscribeDiagnostics(coalesced)
    return () => {
      active = false
      unsubscribeProjection()
      unsubscribeDiagnostics()
    }
  }

  seatFor<Messages extends CordisXMessageDefinition<Messages>>(
    owner: string,
    namespace: string | undefined,
    own: LocalizationEffectOwner,
  ): CordisXLocalizationSeat<Messages> {
    return this.createSeat(owner, namespace ?? owner, own)
  }

  private createSeat<Messages extends CordisXMessageDefinition<Messages>>(
    owner: string,
    namespace: string,
    effectOwner?: LocalizationEffectOwner,
    view?: PluginGenerationView,
  ): CordisXLocalizationSeat<Messages> {
    const qualified = qualifyNamespace(owner, namespace)
    const messageNamespace = qualified === owner ? undefined : qualified
    const own = effectOwner ?? ((setup: () => Disposable<void>): Disposable<void> => {
      return this.ctx.effect(setup, `i18n seat ${qualified}`) as Disposable<void>
    })
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
      t: (key, ...args) =>
        this.registry.resolve(
          owner,
          {
            ...(messageNamespace === undefined ? {} : { namespace: messageNamespace }),
            key,
            ...(args[0] === undefined ? {} : { params: args[0] }),
          },
          undefined,
          view,
        ).text,
      message: messageFor,
      getSnapshot: () => this.registry.getSnapshot(),
      subscribe: listener => own(() => this.registry.subscribe(listener)),
      effect: setup =>
        own(() => {
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
      bindText: (node, message) =>
        seat.effect(() => {
          const previous = node.textContent
          node.textContent = this.registry.resolve(owner, message, undefined, view).text
          return () => {
            node.textContent = previous
          }
        }),
      bindAttribute: (element, name, message) =>
        seat.effect(() => {
          const present = element.hasAttribute(name)
          const previous = element.getAttribute(name)
          element.setAttribute(name, this.registry.resolve(owner, message, undefined, view).text)
          return () => {
            if (present) element.setAttribute(name, previous ?? '')
            else element.removeAttribute(name)
          }
        }),
    }
    return seat
  }
}
