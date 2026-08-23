import { Context, Service, type Disposable } from '@deepseek-ai/cordis'
import type {
  CordisXJsonScalar,
  CordisXMessageDefinition,
  CordisXOutletName,
  CordisXPageMetadata,
  CordisXPageMount,
  CordisXPageMountContext,
  CordisXPages,
  CordisXRouteDefinition,
  CordisXRouteReference,
  CordisXRoutes,
} from '../contracts.js'
import { CordisXI18nService, type LocalizationEffectOwner } from './i18n.js'
import type { ExtensionPointAccessResolver } from './extension-points.js'
import { ownerFromContext, qualifyOwnedId } from './ownership.js'
import { CORDISX_HOST_ICON_TOKENS } from './surfaces.js'
import {
  ICON_TOKEN_PATTERN,
  HostContextStore,
  assertLocalId,
  assertLocalizedText,
  assertReference,
  assertWhenExpression,
  evaluateWhen,
  immutableSnapshot,
  whenContextKeys,
} from './validation.js'

const ROUTE_PATH_PATTERN = /^\/(?:[a-z0-9._~-]+|:[a-z][a-zA-Z0-9]*)(?:\/(?:[a-z0-9._~-]+|:[a-z][a-zA-Z0-9]*))*$/

function assertKeys(value: object, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find(key => !allowed.includes(key))
  if (unknown !== undefined) throw new Error(`${label} has unknown field ${unknown}`)
}

export type OutletPlacement = 'fixed' | 'absolute' | 'portal'
export type OutletContextPolicy = 'generation' | 'semantic'

export interface OutletDescriptor {
  readonly schemaVersion: 1
  readonly id: string
  readonly authority: 'host-adapter'
  readonly scope: string
  readonly preferredPlacement: OutletPlacement
  readonly contextPolicy: OutletContextPolicy
}

export interface OutletHostSnapshot {
  readonly available: boolean
  readonly contextKey?: string
  readonly container?: HTMLElement
  readonly placement: OutletPlacement
  readonly nativeSessionId?: string
  readonly error?: string
}

/** Private host-adapter contract. Controllers may touch host DOM; plugins cannot receive them. */
export interface OutletController {
  getSnapshot(): OutletHostSnapshot
  subscribe(listener: () => void): () => void
  show(): void | Promise<void>
  hide(): void | Promise<void>
}

interface OutletRecord {
  readonly descriptor: OutletDescriptor
  readonly controller: OutletController
  readonly validatePath: (path: string) => boolean
  readonly unsubscribe: () => void
}

export interface OutletSnapshot extends OutletDescriptor, OutletHostSnapshot {
  readonly mounted: boolean
  readonly activeRoute?: string
  readonly error?: string
}

export class OutletRegistry {
  private readonly records = new Map<string, OutletRecord>()
  private readonly listeners = new Set<() => void>()
  private disposed = false

  declare(descriptor: OutletDescriptor, controller: OutletController, validatePath: (path: string) => boolean): () => void {
    if (this.disposed) throw new Error('CordisX outlet registry is disposed')
    assertKeys(descriptor, ['schemaVersion', 'id', 'authority', 'scope', 'preferredPlacement', 'contextPolicy'], 'outlet descriptor')
    if (descriptor.schemaVersion !== 1) throw new Error(`unsupported outlet schema version: ${descriptor.schemaVersion}`)
    assertReference(descriptor.id, 'outlet id')
    if (descriptor.authority !== 'host-adapter') throw new Error('outlet authority must be host-adapter')
    assertLocalId(descriptor.scope, 'outlet scope')
    if (!['fixed', 'absolute', 'portal'].includes(descriptor.preferredPlacement)) throw new Error('invalid outlet placement')
    if (!['generation', 'semantic'].includes(descriptor.contextPolicy)) throw new Error('invalid outlet context policy')
    if (typeof validatePath !== 'function') throw new Error('outlet requires a host path validator')
    if (this.records.has(descriptor.id)) throw new Error(`outlet ${descriptor.id} is already declared`)
    const frozen = immutableSnapshot(descriptor)
    const unsubscribe = controller.subscribe(() => this.notify())
    this.records.set(descriptor.id, { descriptor: frozen, controller, validatePath, unsubscribe })
    this.notify()
    let active = true
    return () => {
      if (!active) return
      active = false
      const record = this.records.get(descriptor.id)
      if (record === undefined) return
      record.unsubscribe()
      this.records.delete(descriptor.id)
      this.notify()
    }
  }

  get(id: string): OutletRecord | undefined {
    return this.records.get(id)
  }

  descriptors(): readonly OutletDescriptor[] {
    return [...this.records.values()].map(record => record.descriptor).sort((a, b) => a.id.localeCompare(b.id))
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const record of this.records.values()) record.unsubscribe()
    this.records.clear()
    this.listeners.clear()
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        console.error('CordisX outlet subscriber failed', error)
      }
    }
  }
}

interface PageRecord {
  readonly owner: string
  readonly qualifiedId: string
  readonly metadata: CordisXPageMetadata
  readonly mount: CordisXPageMount<any>
}

export interface PageSnapshot {
  readonly owner: string
  readonly id: string
  readonly qualifiedId: string
  readonly metadata: CordisXPageMetadata
}

function assertHostIcon(icon: string | undefined, label: string): void {
  if (icon === undefined) return
  if (!ICON_TOKEN_PATTERN.test(icon) || !(CORDISX_HOST_ICON_TOKENS as readonly string[]).includes(icon)) {
    throw new Error(`${label} uses unknown host icon token ${icon}`)
  }
}

export class PageRegistry {
  private readonly records = new Map<string, PageRecord>()
  private readonly listeners = new Set<() => void>()
  private disposed = false

  register<Messages extends CordisXMessageDefinition<Messages>>(
    owner: string,
    metadata: CordisXPageMetadata,
    mount: CordisXPageMount<Messages>,
  ): () => void {
    if (this.disposed) throw new Error('CordisX page registry is disposed')
    assertLocalId(owner, 'page owner')
    assertKeys(metadata, ['id', 'title', 'icon', 'breadcrumbs', 'tabs', 'localeNamespace'], 'page metadata')
    assertLocalId(metadata.id, 'page id')
    assertLocalizedText(metadata.title, 'page title')
    assertHostIcon(metadata.icon, 'page')
    if (metadata.localeNamespace !== undefined) assertReference(metadata.localeNamespace, 'page locale namespace')
    for (const breadcrumb of metadata.breadcrumbs ?? []) assertLocalizedText(breadcrumb, 'page breadcrumb')
    const tabIds = new Set<string>()
    for (const tab of metadata.tabs ?? []) {
      assertKeys(tab, ['id', 'label', 'icon'], 'page tab')
      assertLocalId(tab.id, 'page tab id')
      if (tabIds.has(tab.id)) throw new Error(`page ${metadata.id} has duplicate tab ${tab.id}`)
      tabIds.add(tab.id)
      assertLocalizedText(tab.label, 'page tab label')
      assertHostIcon(tab.icon, 'page tab')
    }
    if (typeof mount !== 'function') throw new Error(`page ${metadata.id} requires a mount callback`)
    const qualifiedId = qualifyOwnedId(owner, metadata.id)
    if (this.records.has(qualifiedId)) throw new Error(`page ${qualifiedId} is already registered`)
    this.records.set(qualifiedId, { owner, qualifiedId, metadata: immutableSnapshot(metadata), mount })
    this.notify()
    let active = true
    return () => {
      if (!active) return
      active = false
      this.records.delete(qualifiedId)
      this.notify()
    }
  }

  get(requestingOwner: string, id: string): PageRecord | undefined {
    const record = this.records.get(qualifyOwnedId(requestingOwner, id))
    if (record?.owner !== requestingOwner) return undefined
    return record
  }

  snapshot(): readonly PageSnapshot[] {
    return [...this.records.values()].map(record => ({
      owner: record.owner,
      id: record.metadata.id,
      qualifiedId: record.qualifiedId,
      metadata: record.metadata,
    })).sort((left, right) => left.qualifiedId.localeCompare(right.qualifiedId))
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.records.clear()
    this.listeners.clear()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

interface RouteRecord {
  readonly owner: string
  readonly qualifiedId: string
  readonly definition: CordisXRouteDefinition
  readonly parameters: readonly string[]
}

interface RouteEntry {
  readonly record: RouteRecord
  readonly params: Readonly<Record<string, CordisXJsonScalar>>
  readonly path: string
}

interface MountedPage {
  readonly entry: RouteEntry
  readonly contextKey: string
  readonly content: HTMLElement
  readonly abort: AbortController
  readonly effects: Disposable<void>[]
  dispose?: Disposable<void>
  error?: string
}

interface OutletNavigationState {
  stack: RouteEntry[]
  mount?: MountedPage
  contextKey?: string
  error?: string
}

export interface RouteSnapshot {
  readonly owner: string
  readonly id: string
  readonly qualifiedId: string
  readonly definition: CordisXRouteDefinition
  readonly valid: boolean
  readonly authorized: boolean
  readonly pointPolicy: 'inherit' | 'allow' | 'deny'
  readonly effectivePointPolicy: 'allow' | 'deny'
  readonly pointPolicyReason?: string
  readonly error?: string
}

export interface NavigationSnapshot {
  readonly routes: readonly RouteSnapshot[]
  readonly pages: readonly PageSnapshot[]
  readonly outlets: readonly OutletSnapshot[]
}

function routeParameters(path: string): readonly string[] {
  const names = path.split('/').filter(segment => segment.startsWith(':')).map(segment => segment.slice(1))
  if (new Set(names).size !== names.length) throw new Error(`route path ${path} repeats a parameter`)
  return names
}

function buildPath(record: RouteRecord, params: Readonly<Record<string, CordisXJsonScalar>>): string {
  const expected = new Set(record.parameters)
  const actual = Object.keys(params)
  const missing = record.parameters.find(name => !Object.hasOwn(params, name))
  if (missing !== undefined) throw new Error(`route ${record.qualifiedId} is missing parameter ${missing}`)
  const extra = actual.find(name => !expected.has(name))
  if (extra !== undefined) throw new Error(`route ${record.qualifiedId} has unknown parameter ${extra}`)
  return record.definition.path.split('/').map((segment) => {
    if (!segment.startsWith(':')) return segment
    const value = params[segment.slice(1)]
    if (value === null) throw new Error(`route ${record.qualifiedId} parameter ${segment.slice(1)} cannot be null`)
    return encodeURIComponent(String(value))
  }).join('/')
}

function matchPath(record: RouteRecord, path: string): Readonly<Record<string, string>> | undefined {
  const expected = record.definition.path.split('/')
  const actual = path.split('/')
  if (expected.length !== actual.length) return undefined
  const params: Record<string, string> = {}
  for (let index = 0; index < expected.length; index += 1) {
    const pattern = expected[index]!
    const value = actual[index]!
    if (!pattern.startsWith(':')) {
      if (pattern !== value) return undefined
      continue
    }
    try {
      params[pattern.slice(1)] = decodeURIComponent(value)
    } catch {
      return undefined
    }
  }
  return Object.freeze(params)
}

export class NavigationRegistry {
  private readonly records = new Map<string, RouteRecord>()
  private readonly states = new Map<string, OutletNavigationState>()
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribePages: () => void
  private readonly unsubscribeOutlets: () => void
  private operation = Promise.resolve()
  private disposed = false

  constructor(
    private readonly pages: PageRegistry,
    private readonly outlets: OutletRegistry,
    private readonly i18n: CordisXI18nService,
    readonly contexts: HostContextStore = new HostContextStore(),
    private access?: ExtensionPointAccessResolver,
  ) {
    this.unsubscribePages = pages.subscribe(() => { void this.enqueue(() => this.reconcileDependencies()) })
    this.unsubscribeOutlets = outlets.subscribe(() => { void this.enqueue(() => this.reconcileDependencies()) })
  }

  setAccessResolver(access: ExtensionPointAccessResolver): void {
    this.access = access
    void this.invalidatePointPolicies()
  }

  invalidatePointPolicies(): Promise<void> {
    return this.enqueue(() => this.reconcileDependencies())
  }

  register(owner: string, definition: CordisXRouteDefinition): () => void {
    if (this.disposed) throw new Error('CordisX route registry is disposed')
    assertLocalId(owner, 'route owner')
    assertKeys(definition, ['id', 'path', 'outlet', 'page', 'title', 'when'], 'route definition')
    assertLocalId(definition.id, 'route id')
    if (definition.path.length > 512 || !ROUTE_PATH_PATTERN.test(definition.path)) throw new Error(`invalid route path: ${definition.path}`)
    assertReference(definition.outlet, 'route outlet')
    assertReference(definition.page, 'route page')
    if (definition.title !== undefined) assertLocalizedText(definition.title, 'route title')
    assertWhenExpression(definition.when)
    const qualifiedId = qualifyOwnedId(owner, definition.id)
    if (this.records.has(qualifiedId)) throw new Error(`route ${qualifiedId} is already registered`)
    const record: RouteRecord = {
      owner,
      qualifiedId,
      definition: immutableSnapshot(definition),
      parameters: routeParameters(definition.path),
    }
    this.records.set(qualifiedId, record)
    this.notify()
    let active = true
    return () => {
      if (!active) return
      active = false
      this.records.delete(qualifiedId)
      void this.enqueue(() => this.reconcileDependencies())
      this.notify()
    }
  }

  has(requestingOwner: string, id: string): boolean {
    const record = this.records.get(qualifyOwnedId(requestingOwner, id))
    return record?.owner === requestingOwner && this.routeError(record) === undefined
  }

  navigate(requestingOwner: string, reference: CordisXRouteReference): Promise<void> {
    return this.enqueue(() => this.navigateNow(requestingOwner, reference))
  }

  back(requestingOwner: string, outlet?: CordisXOutletName): Promise<void> {
    return this.enqueue(async () => {
      const name = outlet ?? this.currentOutletFor(requestingOwner)
      if (name === undefined) throw new Error(`plugin ${requestingOwner} has no open route`)
      const state = this.states.get(name)
      if (state === undefined || state.stack.length < 2) {
        await this.closeNow(name)
        return
      }
      await this.unmount(state)
      state.stack.pop()
      await this.mountCurrent(name, state)
      this.notify()
    })
  }

  close(requestingOwner: string, outlet?: CordisXOutletName): Promise<void> {
    return this.enqueue(async () => {
      const name = outlet ?? this.currentOutletFor(requestingOwner)
      if (name === undefined) return
      await this.closeNow(name)
      this.notify()
    })
  }

  match(outlet: string, path: string): { readonly routeId: string; readonly params: Readonly<Record<string, string>> } | undefined {
    const matches = [...this.records.values()]
      .filter(record => record.definition.outlet === outlet
        && this.routeError(record) === undefined
        && (this.access?.decision(record.owner, outlet, 'outlet').authorized ?? true))
      .map(record => ({ record, params: matchPath(record, path) }))
      .filter((item): item is { record: RouteRecord; params: Readonly<Record<string, string>> } => item.params !== undefined)
    if (matches.length !== 1) return undefined
    return { routeId: matches[0]!.record.qualifiedId, params: matches[0]!.params }
  }

  snapshot(): NavigationSnapshot {
    const routes = [...this.records.values()].map((record): RouteSnapshot => {
      const error = this.routeError(record)
      const pointAccess = this.access?.decision(record.owner, record.definition.outlet, 'outlet')
        ?? { policy: 'inherit' as const, effectivePolicy: 'allow' as const, authorized: true }
      return {
        owner: record.owner,
        id: record.definition.id,
        qualifiedId: record.qualifiedId,
        definition: record.definition,
        valid: error === undefined,
        authorized: pointAccess.authorized,
        pointPolicy: pointAccess.policy,
        effectivePointPolicy: pointAccess.effectivePolicy,
        ...(pointAccess.reason === undefined ? {} : { pointPolicyReason: pointAccess.reason }),
        ...(error === undefined ? {} : { error }),
      }
    }).sort((left, right) => left.qualifiedId.localeCompare(right.qualifiedId))
    const outlets = this.outlets.descriptors().map((descriptor): OutletSnapshot => {
      const host = this.outlets.get(descriptor.id)!.controller.getSnapshot()
      const state = this.states.get(descriptor.id)
      return {
        ...descriptor,
        ...host,
        mounted: state?.mount !== undefined,
        ...(state?.stack.at(-1) === undefined ? {} : { activeRoute: state.stack.at(-1)!.record.qualifiedId }),
        ...(state?.error === undefined ? {} : { error: state.error }),
      }
    })
    return { routes, pages: this.pages.snapshot(), outlets }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  settled(): Promise<void> {
    return this.operation
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribePages()
    this.unsubscribeOutlets()
    await this.operation.catch(() => {})
    for (const [name] of this.states) await this.closeNow(name)
    this.records.clear()
    this.states.clear()
    this.listeners.clear()
  }

  private enqueue(action: () => void | Promise<void>): Promise<void> {
    const result = this.operation.then(async () => {
      if (this.disposed) throw new Error('CordisX navigation registry is disposed')
      await action()
    })
    this.operation = result.catch(() => {})
    return result
  }

  private routeError(record: RouteRecord): string | undefined {
    const conflict = [...this.records.values()].find(other => other !== record
      && other.definition.outlet === record.definition.outlet
      && other.definition.path === record.definition.path)
    if (conflict !== undefined) return `route path conflicts with ${conflict.qualifiedId}`
    if (this.outlets.get(record.definition.outlet) === undefined) return `outlet ${record.definition.outlet} is not declared by the host adapter`
    if (!this.outlets.get(record.definition.outlet)!.validatePath(record.definition.path)) {
      return `route path ${record.definition.path} is incompatible with outlet ${record.definition.outlet}`
    }
    if (this.pages.get(record.owner, record.definition.page) === undefined) return `page ${record.definition.page} is not registered by plugin ${record.owner}`
    const values = this.contexts.getSnapshot()
    const unknownKey = whenContextKeys(record.definition.when).find(key => !Object.hasOwn(values, key))
    if (unknownKey !== undefined) return `when context key ${unknownKey} is not declared by the host adapter`
    if (!evaluateWhen(record.definition.when, values)) return 'route when condition is not satisfied'
  }

  private async navigateNow(requestingOwner: string, reference: CordisXRouteReference): Promise<void> {
    assertKeys(reference, ['id', 'params'], 'route reference')
    assertReference(reference.id, 'route reference')
    const record = this.records.get(qualifyOwnedId(requestingOwner, reference.id))
    if (record === undefined || record.owner !== requestingOwner) throw new Error(`route ${reference.id} is not available to plugin ${requestingOwner}`)
    const error = this.routeError(record)
    if (error !== undefined) throw new Error(`route ${record.qualifiedId} is invalid: ${error}`)
    const routeAccess = this.access?.authorizeOutletRoute(
      requestingOwner,
      record.definition.outlet,
      record.qualifiedId,
      qualifyOwnedId(record.owner, record.definition.page),
    )
    if (routeAccess !== undefined && !routeAccess.authorized) {
      throw new Error(routeAccess.reason ?? `extension point ${record.definition.outlet} is denied for plugin ${requestingOwner}`)
    }
    const params = immutableSnapshot(reference.params ?? {})
    const path = buildPath(record, params)
    const outletRecord = this.outlets.get(record.definition.outlet)!
    await outletRecord.controller.show()
    const host = outletRecord.controller.getSnapshot()
    if (!host.available || host.container === undefined || host.contextKey === undefined) {
      throw new Error(`outlet ${record.definition.outlet} is unavailable${host.error === undefined ? '' : `: ${host.error}`}`)
    }
    if (record.definition.outlet === 'session.content' && String(params.sessionId) !== host.nativeSessionId) {
      throw new Error(`session route ${record.qualifiedId} does not match native session ${host.nativeSessionId ?? '<none>'}`)
    }
    const state = this.states.get(record.definition.outlet) ?? { stack: [] }
    this.states.set(record.definition.outlet, state)
    if (state.contextKey !== undefined && state.contextKey !== host.contextKey) {
      await this.unmount(state)
      state.stack = []
    }
    state.contextKey = host.contextKey
    await this.unmount(state)
    state.stack.push({ record, params, path })
    await this.mountCurrent(record.definition.outlet, state)
    this.notify()
  }

  private async mountCurrent(name: string, state: OutletNavigationState): Promise<void> {
    const entry = state.stack.at(-1)
    if (entry === undefined) return
    const outlet = this.outlets.get(name)
    const page = this.pages.get(entry.record.owner, entry.record.definition.page)
    if (outlet === undefined || page === undefined) return
    const host = outlet.controller.getSnapshot()
    if (!host.available || host.container === undefined || host.contextKey === undefined) return
    const pageAccess = this.access?.authorizeOutletPage(
      entry.record.owner,
      entry.record.definition.outlet,
      entry.record.qualifiedId,
      page.qualifiedId,
    )
    if (pageAccess !== undefined && !pageAccess.authorized) {
      state.error = pageAccess.reason ?? `extension point ${entry.record.definition.outlet} is denied for plugin ${entry.record.owner}`
      await this.closeNow(name)
      return
    }
    const content = host.container.ownerDocument.createElement('section')
    content.dataset.cordisxPage = page.qualifiedId
    content.dataset.cordisxRoute = entry.record.qualifiedId
    Object.assign(content.style, {
      position: 'absolute', inset: '0', display: 'flex', flexDirection: 'column', overflow: 'hidden',
      background: '#10131a', color: '#eef0f5', font: '13px/1.45 ui-sans-serif, system-ui, sans-serif',
    })
    content.dataset.cordisxNoDrag = 'true'
    content.style.setProperty('-webkit-app-region', 'no-drag')
    host.container.append(content)
    const abort = new AbortController()
    const effects: Disposable<void>[] = []
    const own: LocalizationEffectOwner = (setup) => {
      const cleanup = setup()
      let active = true
      const dispose = (() => {
        if (!active) return
        active = false
        const index = effects.indexOf(dispose)
        if (index >= 0) effects.splice(index, 1)
        cleanup()
      }) as Disposable<void>
      effects.push(dispose)
      return dispose
    }
    const namespace = page.metadata.localeNamespace ?? page.owner
    const localization = this.i18n.seatFor(page.owner, namespace, own)
    const mount: MountedPage = { entry, contextKey: host.contextKey, content, abort, effects }
    state.mount = mount
    delete state.error
    try {
      const chrome = content.ownerDocument.createElement('header')
      chrome.dataset.cordisxPageChrome = 'true'
      chrome.dataset.cordisxDrag = 'true'
      Object.assign(chrome.style, {
        display: 'flex', alignItems: 'center', gap: '8px', minHeight: '46px', padding: '0 12px',
        borderBottom: '1px solid rgba(255,255,255,.1)', background: '#161a23', flex: '0 0 auto',
      })
      chrome.style.paddingLeft = 'max(12px, var(--cordisx-page-chrome-safe-left, 0px))'
      chrome.style.setProperty('-webkit-app-region', 'drag')
      const back = content.ownerDocument.createElement('button')
      back.type = 'button'
      back.textContent = '←'
      back.setAttribute('aria-label', 'Back')
      back.dataset.cordisxNoDrag = 'true'
      back.disabled = state.stack.length < 2
      back.addEventListener('click', () => { void this.back(page.owner, name as CordisXOutletName) })
      const title = content.ownerDocument.createElement('strong')
      title.style.flex = '1'
      const titleMessage = entry.record.definition.title ?? page.metadata.title
      const titleSite = `page:${page.qualifiedId}:chrome.title`
      localization.effect(() => {
        title.textContent = this.i18n.resolveFor(page.owner, titleMessage, titleSite).text
        return () => this.i18n.clearDiagnosticSite(page.owner, titleSite)
      })
      const close = content.ownerDocument.createElement('button')
      close.type = 'button'
      close.textContent = '×'
      close.setAttribute('aria-label', 'Close')
      close.dataset.cordisxNoDrag = 'true'
      close.addEventListener('click', () => { void this.close(page.owner, name as CordisXOutletName) })
      for (const button of [back, close]) Object.assign(button.style, {
        width: '30px', height: '30px', border: '1px solid rgba(255,255,255,.14)', borderRadius: '8px',
        background: 'rgba(255,255,255,.06)', color: 'inherit', cursor: 'pointer',
      })
      for (const button of [back, close]) button.style.setProperty('-webkit-app-region', 'no-drag')
      chrome.append(back, title, close)
      content.append(chrome)
      if ((page.metadata.breadcrumbs?.length ?? 0) > 0) {
        const breadcrumbs = content.ownerDocument.createElement('nav')
        breadcrumbs.setAttribute('aria-label', 'Breadcrumb')
        breadcrumbs.style.cssText = 'display:flex;gap:5px;padding:7px 14px;color:#9aa3b5;flex:0 0 auto'
        for (const [index, item] of page.metadata.breadcrumbs!.entries()) {
          const label = content.ownerDocument.createElement('span')
          const site = `page:${page.qualifiedId}:chrome.breadcrumbs.${index}`
          localization.effect(() => {
            label.textContent = this.i18n.resolveFor(page.owner, item, site).text
            return () => this.i18n.clearDiagnosticSite(page.owner, site)
          })
          breadcrumbs.append(label)
        }
        content.append(breadcrumbs)
      }
      if ((page.metadata.tabs?.length ?? 0) > 0) {
        const tabs = content.ownerDocument.createElement('div')
        tabs.setAttribute('role', 'tablist')
        tabs.dataset.cordisxNoDrag = 'true'
        tabs.style.cssText = 'display:flex;gap:4px;padding:7px 12px;border-bottom:1px solid rgba(255,255,255,.08);flex:0 0 auto'
        tabs.style.setProperty('-webkit-app-region', 'no-drag')
        for (const [index, tab] of page.metadata.tabs!.entries()) {
          const button = content.ownerDocument.createElement('button')
          button.type = 'button'
          button.setAttribute('role', 'tab')
          button.setAttribute('aria-selected', String(index === 0))
          button.dataset.tabId = tab.id
          button.dataset.cordisxNoDrag = 'true'
          button.style.setProperty('-webkit-app-region', 'no-drag')
          const site = `page:${page.qualifiedId}:chrome.tabs.${tab.id}`
          localization.effect(() => {
            button.textContent = this.i18n.resolveFor(page.owner, tab.label, site).text
            return () => this.i18n.clearDiagnosticSite(page.owner, site)
          })
          tabs.append(button)
        }
        content.append(tabs)
      }
      const body = content.ownerDocument.createElement('div')
      body.dataset.cordisxPageBody = 'true'
      body.style.cssText = 'position:relative;flex:1;min-height:0;overflow:auto'
      content.append(body)
      const context: CordisXPageMountContext = {
        container: body,
        document: content.ownerDocument,
        signal: abort.signal,
        routeId: entry.record.qualifiedId,
        outlet: name as CordisXOutletName,
        params: entry.params,
        navigation: {
          navigate: reference => this.navigate(page.owner, reference),
          back: outletName => this.back(page.owner, outletName),
          close: outletName => this.close(page.owner, outletName),
        },
        localeNamespace: localization.namespace,
        t: localization.t,
        localization,
      }
      const disposer = page.mount(context)
      if (typeof disposer === 'function') mount.dispose = disposer
    } catch (error) {
      mount.error = error instanceof Error ? error.message : String(error)
      state.error = mount.error
      await this.unmount(state)
      throw error
    }
  }

  private async unmount(state: OutletNavigationState): Promise<void> {
    const mount = state.mount
    if (mount === undefined) return
    delete state.mount
    mount.abort.abort()
    try {
      await mount.dispose?.()
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error)
    }
    for (const dispose of [...mount.effects].reverse()) {
      try {
        await dispose()
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error)
      }
    }
    mount.content.remove()
  }

  private async closeNow(name: string): Promise<void> {
    const state = this.states.get(name)
    if (state !== undefined) {
      await this.unmount(state)
      state.stack = []
      delete state.contextKey
    }
    await this.outlets.get(name)?.controller.hide()
  }

  private currentOutletFor(owner: string): CordisXOutletName | undefined {
    const entry = [...this.states.entries()].find(([, state]) => state.stack.at(-1)?.record.owner === owner)
    return entry?.[0] as CordisXOutletName | undefined
  }

  private async reconcileDependencies(): Promise<void> {
    for (const [name, state] of this.states) {
      const current = state.stack.at(-1)
      const outlet = this.outlets.get(name)
      if (current === undefined) continue
      if (outlet === undefined || this.routeError(current.record) !== undefined) {
        await this.closeNow(name)
        continue
      }
      const retentionAccess = this.access?.authorizeOutletPage(
        current.record.owner,
        name,
        current.record.qualifiedId,
        qualifyOwnedId(current.record.owner, current.record.definition.page),
      )
      if (retentionAccess !== undefined && !retentionAccess.authorized) {
        await this.closeNow(name)
        continue
      }
      const host = outlet.controller.getSnapshot()
      if (!host.available || host.container === undefined || host.contextKey === undefined
        || (state.contextKey !== undefined && state.contextKey !== host.contextKey)
        || (name === 'session.content' && String(current.params.sessionId) !== host.nativeSessionId)) {
        await this.closeNow(name)
        continue
      }
      if (state.mount !== undefined && state.mount.content.parentElement !== host.container) {
        host.container.append(state.mount.content)
      }
    }
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

export class CordisXPageService extends Service implements CordisXPages {
  readonly registry = new PageRegistry()

  constructor(ctx: Context) {
    super(ctx, 'pages')
    ctx.effect(() => () => this.registry.dispose(), 'cordisx: page registry')
  }

  register<Messages extends CordisXMessageDefinition<Messages>>(
    metadata: CordisXPageMetadata,
    mount: CordisXPageMount<Messages>,
  ): ReturnType<CordisXPages['register']> {
    return this.ctx.effect(
      () => this.registry.register(ownerFromContext(this.ctx), metadata, mount),
      `pages.register(${JSON.stringify(metadata.id)})`,
    )
  }

  snapshot(): readonly PageSnapshot[] {
    return this.registry.snapshot()
  }
}

export class CordisXRouteService extends Service implements CordisXRoutes {
  static readonly inject = ['pages', 'i18n']
  readonly outlets = new OutletRegistry()
  readonly registry: NavigationRegistry
  readonly contexts = new HostContextStore()

  constructor(ctx: Context) {
    super(ctx, 'routes')
    const pages = ctx.pages as CordisXPageService
    const i18n = ctx.i18n as CordisXI18nService
    if (pages?.registry === undefined || i18n === undefined) throw new Error('CordisX routes require pages and i18n services')
    this.registry = new NavigationRegistry(pages.registry, this.outlets, i18n, this.contexts)
    ctx.effect(() => async () => {
      await this.registry.dispose()
      this.outlets.dispose()
      this.contexts.dispose()
    }, 'cordisx: route and outlet registries')
  }

  register(definition: CordisXRouteDefinition): ReturnType<CordisXRoutes['register']> {
    return this.ctx.effect(
      () => this.registry.register(ownerFromContext(this.ctx), definition),
      `routes.register(${JSON.stringify(definition.id)})`,
    )
  }

  navigate(reference: CordisXRouteReference): Promise<void> {
    return this.registry.navigate(ownerFromContext(this.ctx), reference)
  }

  back(outlet?: CordisXOutletName): Promise<void> {
    return this.registry.back(ownerFromContext(this.ctx), outlet)
  }

  close(outlet?: CordisXOutletName): Promise<void> {
    return this.registry.close(ownerFromContext(this.ctx), outlet)
  }

  hasFor(owner: string, id: string): boolean {
    return this.registry.has(owner, id)
  }

  navigateFor(owner: string, reference: CordisXRouteReference): Promise<void> {
    return this.registry.navigate(owner, reference)
  }

  snapshot(): NavigationSnapshot {
    return this.registry.snapshot()
  }

  subscribeInternal(listener: () => void): () => void {
    return this.registry.subscribe(listener)
  }

  setAccessResolver(access: ExtensionPointAccessResolver): void {
    this.registry.setAccessResolver(access)
  }

  invalidatePointPolicies(): Promise<void> {
    return this.registry.invalidatePointPolicies()
  }

  settled(): Promise<void> {
    return this.registry.settled()
  }
}
