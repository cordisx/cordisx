import { Context, Service, type Disposable } from '@deepseek-ai/cordis'
import {
  CORDISX_PAGE_SCHEMA_V1,
  CORDISX_PAGE_SCHEMA_V2,
  CORDISX_PAGE_SCHEMA_V3,
  CORDISX_ROUTE_SCHEMA_V1,
  CORDISX_ROUTE_SCHEMA_V2,
} from '../contracts.js'
import type {
  CordisXJsonScalar,
  CordisXMessageDefinition,
  CordisXOutletName,
  CordisXPageHeaderAction,
  CordisXPageMetadata,
  CordisXPageMount,
  CordisXPageMountContext,
  CordisXPages,
  CordisXRouteDefinition,
  CordisXRouteReference,
  CordisXRoutes,
} from '../contracts.js'
import type { CordisXCommandService } from './commands.js'
import { CordisXI18nService, type LocalizationEffectOwner } from './i18n.js'
import type { ExtensionPointAccessResolver } from './extension-points.js'
import { createHostSurfaceIcon } from './icons.js'
import { ownerFromContext, qualifyOwnedId } from './ownership.js'
import {
  generationVisibilityFromContext,
  type GenerationVisibilityCoordinator,
  type PluginGenerationEffectIdentity,
  type PluginGenerationView,
} from './generation-visibility.js'
import { CORDISX_HOST_ICON_TOKENS } from './surfaces.js'
import { dismissHostTooltips, HostTooltipController } from './tooltips.js'
import type { PluginConsoleAspect } from './plugin-console.js'
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

function assertPageMetadataVersion(metadata: CordisXPageMetadata): void {
  const hasSchema = metadata.$schema !== undefined
  const hasVersion = metadata.schemaVersion !== undefined
  if (!hasSchema && !hasVersion) {
    if (metadata.description !== undefined) throw new Error('legacy page metadata cannot declare description; use page.v3')
    return
  }
  if (!hasSchema || !hasVersion) throw new Error('page metadata requires a complete $schema/schemaVersion tuple')
  if (metadata.schemaVersion === 1 && metadata.$schema === CORDISX_PAGE_SCHEMA_V1) {
    if (metadata.description !== undefined || metadata.chrome !== undefined) throw new Error('page.v1 cannot declare description or chrome')
    return
  }
  if (metadata.schemaVersion === 2 && metadata.$schema === CORDISX_PAGE_SCHEMA_V2) {
    if (metadata.description !== undefined) throw new Error('page.v2 cannot declare description')
    return
  }
  if (metadata.schemaVersion === 3 && metadata.$schema === CORDISX_PAGE_SCHEMA_V3) {
    if (metadata.description === undefined) throw new Error('page.v3 requires localized description metadata')
    if (metadata.localeNamespace !== undefined) throw new Error('page.v3 uses owner-default i18n and cannot declare localeNamespace')
    return
  }
  throw new Error('page metadata has an unsupported $schema/schemaVersion tuple')
}

function assertRouteDefinitionVersion(definition: CordisXRouteDefinition): void {
  const hasSchema = definition.$schema !== undefined
  const hasVersion = definition.schemaVersion !== undefined
  if (!hasSchema && !hasVersion) {
    if (definition.description !== undefined) throw new Error('legacy route definition cannot declare description; use route.v2')
    return
  }
  if (!hasSchema || !hasVersion) throw new Error('route definition requires a complete $schema/schemaVersion tuple')
  if (definition.schemaVersion === 1 && definition.$schema === CORDISX_ROUTE_SCHEMA_V1) {
    if (definition.description !== undefined) throw new Error('route.v1 cannot declare description')
    return
  }
  if (definition.schemaVersion === 2 && definition.$schema === CORDISX_ROUTE_SCHEMA_V2) {
    if (definition.title === undefined || definition.description === undefined) {
      throw new Error('route.v2 requires localized title and description metadata')
    }
    return
  }
  throw new Error('route definition has an unsupported $schema/schemaVersion tuple')
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
  readonly presentationGroup?: string
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
  readonly presentation: 'inactive' | 'presented' | 'suspended'
  readonly suspendedBy?: string
  readonly activeRoute?: string
  readonly error?: string
}

export class OutletRegistry {
  private readonly records = new Map<string, OutletRecord>()
  private readonly listeners = new Set<() => void>()
  private disposed = false

  declare(descriptor: OutletDescriptor, controller: OutletController, validatePath: (path: string) => boolean): () => void {
    if (this.disposed) throw new Error('CordisX outlet registry is disposed')
    assertKeys(descriptor, ['schemaVersion', 'id', 'authority', 'scope', 'preferredPlacement', 'contextPolicy', 'presentationGroup'], 'outlet descriptor')
    if (descriptor.schemaVersion !== 1) throw new Error(`unsupported outlet schema version: ${descriptor.schemaVersion}`)
    assertReference(descriptor.id, 'outlet id')
    if (descriptor.authority !== 'host-adapter') throw new Error('outlet authority must be host-adapter')
    assertLocalId(descriptor.scope, 'outlet scope')
    if (!['fixed', 'absolute', 'portal'].includes(descriptor.preferredPlacement)) throw new Error('invalid outlet placement')
    if (!['generation', 'semantic'].includes(descriptor.contextPolicy)) throw new Error('invalid outlet context policy')
    if (descriptor.presentationGroup !== undefined) assertLocalId(descriptor.presentationGroup, 'outlet presentation group')
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
  readonly generation: PluginGenerationEffectIdentity
  readonly candidateView?: PluginGenerationView
  readonly metadata: CordisXPageMetadata
  readonly mount: CordisXPageMount<any>
}

export interface PageSnapshot {
  readonly owner: string
  readonly id: string
  readonly qualifiedId: string
  readonly metadata: CordisXPageMetadata
}

export interface NavigationMetadataDiagnostic {
  readonly code: 'metadata.missing-title' | 'metadata.missing-description'
  readonly field: 'title' | 'description'
  readonly message: string
}

export interface NavigationProductMetadata {
  readonly title?: string
  readonly description?: string
  readonly diagnostics: readonly NavigationMetadataDiagnostic[]
}

export interface NavigationPageSnapshot extends PageSnapshot {
  readonly productMetadata: NavigationProductMetadata
}

export interface ManagerSettingsRouteResolution {
  readonly state: 'available' | 'pending' | 'invalid'
  readonly detail?: string
}

export interface ManagerSettingsNavigationResolvedRoute {
  readonly owner: string
  readonly qualifiedId: string
  readonly definition: CordisXRouteDefinition<'manager.content'>
  readonly page: PageSnapshot
}

export interface ManagerSettingsNavigationRouteResolution {
  readonly state: 'available' | 'pending' | 'invalid'
  readonly detail?: string
  readonly resolved?: ManagerSettingsNavigationResolvedRoute
}

export interface ManagedSettingsPageMount {
  readonly owner: string
  readonly contributionId: string
  readonly routeId: string
  readonly pageId: string
  readonly signal: AbortSignal
  abort(): void
  dispose(): Promise<void>
}

function assertHostIcon(icon: string | undefined, label: string): void {
  if (icon === undefined) return
  if (!ICON_TOKEN_PATTERN.test(icon) || !(CORDISX_HOST_ICON_TOKENS as readonly string[]).includes(icon)) {
    throw new Error(`${label} uses unknown host icon token ${icon}`)
  }
}

function assertPageHeaderAction(action: CordisXPageHeaderAction, label: string): void {
  assertKeys(action, ['id', 'label', 'ariaLabel', 'icon', 'command', 'when', 'disabled'], label)
  assertLocalId(action.id, `${label} id`)
  assertLocalizedText(action.label, `${label} label`)
  if (action.ariaLabel !== undefined) assertLocalizedText(action.ariaLabel, `${label} ariaLabel`)
  assertHostIcon(action.icon, label)
  if (action.command === null || typeof action.command !== 'object') throw new Error(`${label} requires a command reference`)
  assertKeys(action.command, ['id', 'arguments'], `${label} command`)
  assertReference(action.command.id, `${label} command id`)
  assertWhenExpression(action.when)
  if (action.disabled !== undefined) {
    assertKeys(action.disabled, ['value', 'reason'], `${label} disabled state`)
    if (typeof action.disabled.value !== 'boolean') throw new Error(`${label} disabled.value must be a boolean`)
    if (action.disabled.reason !== undefined) assertLocalizedText(action.disabled.reason, `${label} disabled reason`)
  }
}

function pageChromeButton(document: Document, ariaLabel: string, icon: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute('aria-label', ariaLabel)
  button.dataset.cordisxNoDrag = 'true'
  button.style.setProperty('-webkit-app-region', 'no-drag')
  const Button = document.defaultView?.HTMLButtonElement
  const template = [...document.querySelectorAll('header[data-app-shell-application-menu-bar] button')]
    .find((candidate): candidate is HTMLButtonElement => Button !== undefined
      && candidate instanceof Button
      && candidate.closest('[data-cordisx-page-outlet]') === null)
  if (template !== undefined) {
    button.className = template.className
  } else {
    Object.assign(button.style, {
      width: '30px', height: '30px', border: '1px solid transparent', borderRadius: '8px',
      background: 'transparent', color: 'inherit', cursor: 'pointer', padding: '5px',
    })
  }
  button.classList.add('cordisx-page-chrome-action')
  button.append(createHostSurfaceIcon(document, icon))
  return button
}

export class PageRegistry {
  private readonly records = new Map<string, PageRecord>()
  private readonly listeners = new Set<() => void>()
  private disposed = false
  private readonly disconnectVisibility: (() => void) | undefined

  constructor(readonly visibility?: GenerationVisibilityCoordinator) {
    this.disconnectVisibility = visibility?.connect({ notify: () => this.notify() })
  }

  register<Messages extends CordisXMessageDefinition<Messages>>(
    ownerOrContext: string | Context,
    metadata: CordisXPageMetadata,
    mount: CordisXPageMount<Messages>,
  ): () => void {
    if (this.disposed) throw new Error('CordisX page registry is disposed')
    const owner = typeof ownerOrContext === 'string' ? ownerOrContext : ownerFromContext(ownerOrContext)
    const generation: PluginGenerationEffectIdentity = typeof ownerOrContext === 'string'
      ? Object.freeze({ pluginId: owner })
      : this.visibility?.effect(ownerOrContext) ?? Object.freeze({ pluginId: owner })
    const candidateView = typeof ownerOrContext === 'string' || generation.transactionId === undefined
      ? undefined
      : this.visibility?.view(ownerOrContext)
    assertLocalId(owner, 'page owner')
    assertKeys(metadata, ['$schema', 'schemaVersion', 'id', 'title', 'description', 'icon', 'chrome', 'breadcrumbs', 'tabs', 'headerActions', 'localeNamespace'], 'page metadata')
    assertPageMetadataVersion(metadata)
    assertLocalId(metadata.id, 'page id')
    assertLocalizedText(metadata.title, 'page title')
    if (metadata.description !== undefined) assertLocalizedText(metadata.description, 'page description')
    assertHostIcon(metadata.icon, 'page')
    if (metadata.chrome !== undefined && !['standard', 'body-only'].includes(metadata.chrome)) {
      throw new Error(`page ${metadata.id} chrome policy is invalid`)
    }
    if (metadata.chrome === 'body-only'
      && (metadata.breadcrumbs !== undefined || metadata.tabs !== undefined || metadata.headerActions !== undefined)) {
      throw new Error(`body-only page ${metadata.id} cannot declare breadcrumbs, tabs, or header actions`)
    }
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
    const actionIds = new Set<string>()
    for (const action of metadata.headerActions ?? []) {
      assertPageHeaderAction(action, 'page header action')
      if (actionIds.has(action.id)) throw new Error(`page ${metadata.id} has duplicate header action ${action.id}`)
      actionIds.add(action.id)
    }
    if (typeof mount !== 'function') throw new Error(`page ${metadata.id} requires a mount callback`)
    const qualifiedId = qualifyOwnedId(owner, metadata.id)
    const physicalId = `${qualifiedId}\u0000${generation.moduleGeneration ?? 'host'}`
    if (this.records.has(physicalId)) throw new Error(`page ${qualifiedId} is already registered for this generation`)
    this.records.set(physicalId, {
      owner,
      qualifiedId,
      generation,
      ...(candidateView === undefined ? {} : { candidateView }),
      metadata: immutableSnapshot(metadata),
      mount,
    })
    if (this.visibility?.visible(generation) !== false) this.notify()
    let active = true
    return () => {
      if (!active) return
      active = false
      this.records.delete(physicalId)
      if (this.visibility?.visible(generation) !== false) this.notify()
    }
  }

  get(requestingOwner: string, id: string, view?: PluginGenerationView): PageRecord | undefined {
    const qualifiedId = qualifyOwnedId(requestingOwner, id)
    const record = [...this.records.values()].find(item => item.qualifiedId === qualifiedId
      && (this.visibility?.visible(item.generation, view) ?? true))
    if (record?.owner !== requestingOwner) return undefined
    return record
  }

  snapshot(view?: PluginGenerationView): readonly PageSnapshot[] {
    return [...this.records.values()]
      .filter(record => this.visibility?.visible(record.generation, view) ?? true)
      .map(record => ({
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
    this.disconnectVisibility?.()
    this.records.clear()
    this.listeners.clear()
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // One observer cannot split a published visibility epoch.
      }
    }
  }
}

interface RouteRecord {
  readonly owner: string
  readonly qualifiedId: string
  readonly generation: PluginGenerationEffectIdentity
  readonly candidateView?: PluginGenerationView
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

interface ManagedSettingsPageMountRecord extends ManagedSettingsPageMount {
  readonly route: RouteRecord
  readonly page: PageRecord
  readonly content: HTMLElement
  readonly effects: Disposable<void>[]
  readonly abortController: AbortController
  pageDispose?: Disposable<void>
  disposed: boolean
}

interface OutletNavigationState {
  stack: RouteEntry[]
  mount?: MountedPage
  contextKey?: string
  returnFocus?: HTMLElement
  error?: string
  presentation?: 'presented' | 'suspended'
  suspendedBy?: string
}

export interface RouteSnapshot {
  readonly owner: string
  readonly id: string
  readonly qualifiedId: string
  readonly definition: CordisXRouteDefinition
  readonly productMetadata: NavigationProductMetadata
  readonly valid: boolean
  readonly authorized: boolean
  readonly pointPolicy: 'inherit' | 'allow' | 'deny'
  readonly effectivePointPolicy: 'allow' | 'deny'
  readonly pointPolicyReason?: string
  readonly error?: string
}

export interface NavigationSnapshot {
  readonly routes: readonly RouteSnapshot[]
  readonly pages: readonly NavigationPageSnapshot[]
  readonly outlets: readonly OutletSnapshot[]
}

export interface RouteProjection {
  readonly active: boolean
  readonly presented: boolean
  readonly outlet?: CordisXOutletName
}

function sameRouteParams(
  left: Readonly<Record<string, CordisXJsonScalar>>,
  right: Readonly<Record<string, CordisXJsonScalar>>,
): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => Object.hasOwn(right, key) && Object.is(left[key], right[key]))
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
  private metadataProjectionSites = new Map<string, string>()
  private presentationOrder: string[] = []
  private managerSettingsMount: ManagedSettingsPageMountRecord | undefined
  private readonly unsubscribePages: () => void
  private readonly unsubscribeOutlets: () => void
  private operation = Promise.resolve()
  private disposed = false
  private readonly disconnectVisibility: (() => void) | undefined

  constructor(
    private readonly pages: PageRegistry,
    private readonly outlets: OutletRegistry,
    private readonly i18n: CordisXI18nService,
    readonly contexts: HostContextStore = new HostContextStore(),
    private access?: ExtensionPointAccessResolver,
    private readonly commands?: Pick<CordisXCommandService, 'hasFor' | 'executeFor' | 'subscribeInternal'>,
  ) {
    this.unsubscribePages = pages.subscribe(() => { void this.enqueue(() => this.reconcileDependencies()) })
    this.unsubscribeOutlets = outlets.subscribe(() => { void this.enqueue(() => this.reconcileDependencies()) })
    this.disconnectVisibility = pages.visibility?.connect({ notify: () => {
      void this.enqueue(() => this.reconcileGeneration())
    } })
  }

  setAccessResolver(access: ExtensionPointAccessResolver): void {
    this.access = access
    void this.invalidatePointPolicies()
  }

  invalidatePointPolicies(): Promise<void> {
    return this.enqueue(() => this.reconcileDependencies())
  }

  register(ownerOrContext: string | Context, definition: CordisXRouteDefinition): () => void {
    if (this.disposed) throw new Error('CordisX route registry is disposed')
    const owner = typeof ownerOrContext === 'string' ? ownerOrContext : ownerFromContext(ownerOrContext)
    const generation: PluginGenerationEffectIdentity = typeof ownerOrContext === 'string'
      ? Object.freeze({ pluginId: owner })
      : this.pages.visibility?.effect(ownerOrContext) ?? Object.freeze({ pluginId: owner })
    const candidateView = typeof ownerOrContext === 'string' || generation.transactionId === undefined
      ? undefined
      : this.pages.visibility?.view(ownerOrContext)
    assertLocalId(owner, 'route owner')
    assertKeys(definition, ['$schema', 'schemaVersion', 'id', 'path', 'outlet', 'page', 'title', 'description', 'when'], 'route definition')
    assertRouteDefinitionVersion(definition)
    assertLocalId(definition.id, 'route id')
    if (definition.path.length > 512 || !ROUTE_PATH_PATTERN.test(definition.path)) throw new Error(`invalid route path: ${definition.path}`)
    assertReference(definition.outlet, 'route outlet')
    assertReference(definition.page, 'route page')
    if (definition.title !== undefined) assertLocalizedText(definition.title, 'route title')
    if (definition.description !== undefined) assertLocalizedText(definition.description, 'route description')
    assertWhenExpression(definition.when)
    const qualifiedId = qualifyOwnedId(owner, definition.id)
    const physicalId = `${qualifiedId}\u0000${generation.moduleGeneration ?? 'host'}`
    if (this.records.has(physicalId)) throw new Error(`route ${qualifiedId} is already registered for this generation`)
    const record: RouteRecord = {
      owner,
      qualifiedId,
      generation,
      ...(candidateView === undefined ? {} : { candidateView }),
      definition: immutableSnapshot(definition),
      parameters: routeParameters(definition.path),
    }
    this.records.set(physicalId, record)
    if (this.pages.visibility?.visible(generation) !== false) this.notify()
    let active = true
    return () => {
      if (!active) return
      active = false
      this.records.delete(physicalId)
      if (this.pages.visibility?.visible(generation) !== false) {
        void this.enqueue(() => this.reconcileDependencies())
        this.notify()
      }
    }
  }

  has(requestingOwner: string, id: string, view?: PluginGenerationView): boolean {
    const record = this.findRecord(requestingOwner, id, view)
    return record?.owner === requestingOwner && this.routeError(record) === undefined
  }

  managerSettingsRoute(requestingOwner: string, id: string, view?: PluginGenerationView): ManagerSettingsRouteResolution {
    const record = this.findRecord(requestingOwner, id, view)
    if (record === undefined || record.owner !== requestingOwner) {
      return { state: 'pending', detail: `route ${id} is not registered by plugin ${requestingOwner}` }
    }
    if (record.definition.outlet !== 'manager.settings.content') {
      return { state: 'invalid', detail: `route ${record.qualifiedId} must target manager.settings.content` }
    }
    if (record.definition.path === '/manager/settings' || !record.definition.path.startsWith('/manager/settings/')) {
      return { state: 'invalid', detail: `route ${record.qualifiedId} must be strictly below /manager/settings/` }
    }
    if (record.definition.page.includes(':')) {
      return { state: 'invalid', detail: `route ${record.qualifiedId} must reference a same-owner local page` }
    }
    if (this.outlets.get('manager.settings.content') === undefined) {
      return { state: 'pending', detail: 'outlet manager.settings.content is not declared by the host' }
    }
    if (!this.outlets.get('manager.settings.content')!.validatePath(record.definition.path)) {
      return { state: 'invalid', detail: `route path ${record.definition.path} is incompatible with manager.settings.content` }
    }
    const pathConflict = this.visibleRecords(view).find(candidate => (
      candidate.qualifiedId !== record.qualifiedId
      && candidate.definition.outlet === 'manager.settings.content'
      && candidate.definition.path === record.definition.path
    ))
    if (pathConflict !== undefined) {
      return {
        state: 'invalid',
        detail: `route path ${record.definition.path} conflicts with ${pathConflict.qualifiedId}`,
      }
    }
    const page = this.pages.get(record.owner, record.definition.page, view ?? record.candidateView)
    if (page === undefined) return { state: 'pending', detail: `page ${record.definition.page} is not registered by plugin ${record.owner}` }
    if (page.metadata.chrome !== 'body-only') {
      return { state: 'invalid', detail: `page ${page.qualifiedId} must use body-only chrome` }
    }
    const values = this.contexts.getSnapshot()
    const unknownKey = whenContextKeys(record.definition.when).find(key => !Object.hasOwn(values, key))
    if (unknownKey !== undefined) return { state: 'invalid', detail: `when context key ${unknownKey} is not declared by the host adapter` }
    if (!evaluateWhen(record.definition.when, values)) return { state: 'pending', detail: 'route when condition is not satisfied' }
    const outletAccess = this.access?.decision(record.owner, 'manager.settings.content', 'outlet', view ?? record.candidateView)
    if (outletAccess !== undefined && !outletAccess.authorized) {
      return { state: 'invalid', detail: outletAccess.reason ?? `extension point manager.settings.content is denied for plugin ${record.owner}` }
    }
    return { state: 'available' }
  }

  managerSettingsNavigationRoute(
    requestingOwner: string,
    id: string,
    view?: PluginGenerationView,
  ): ManagerSettingsNavigationRouteResolution {
    const record = this.findRecord(requestingOwner, id, view)
    if (record === undefined || record.owner !== requestingOwner) {
      return { state: 'pending', detail: `route ${id} is not registered by plugin ${requestingOwner}` }
    }
    if (record.definition.outlet !== 'manager.content') {
      return { state: 'invalid', detail: `route ${record.qualifiedId} must target manager.content` }
    }
    if (record.definition.path === '/manager/extensions' || record.definition.path === '/manager/extensions/'
      || !record.definition.path.startsWith('/manager/extensions/')) {
      return { state: 'invalid', detail: `route ${record.qualifiedId} must be strictly below /manager/extensions/` }
    }
    if (record.definition.page.includes(':')) {
      return { state: 'invalid', detail: `route ${record.qualifiedId} must reference a same-owner local page` }
    }
    if (record.definition.schemaVersion !== 2
      || record.definition.title === undefined
      || record.definition.description === undefined) {
      return { state: 'invalid', detail: `route ${record.qualifiedId} requires route-v2 title and description` }
    }
    const outlet = this.outlets.get('manager.content')
    if (outlet === undefined) return { state: 'pending', detail: 'outlet manager.content is not declared by the host' }
    if (!outlet.validatePath(record.definition.path)) {
      return { state: 'invalid', detail: `route path ${record.definition.path} is incompatible with manager.content` }
    }
    const pathConflict = this.visibleRecords(view).find(candidate => (
      candidate.qualifiedId !== record.qualifiedId
      && candidate.definition.outlet === 'manager.content'
      && candidate.definition.path === record.definition.path
    ))
    if (pathConflict !== undefined) {
      return {
        state: 'invalid',
        detail: `route path ${record.definition.path} conflicts with ${pathConflict.qualifiedId}`,
      }
    }
    const page = this.pages.get(record.owner, record.definition.page, view ?? record.candidateView)
    if (page === undefined) {
      return { state: 'pending', detail: `page ${record.definition.page} is not registered by plugin ${record.owner}` }
    }
    if (page.metadata.schemaVersion !== 3 || page.metadata.description === undefined) {
      return { state: 'invalid', detail: `page ${page.qualifiedId} requires page-v3 title and description` }
    }
    if (page.metadata.chrome === 'body-only') {
      return { state: 'invalid', detail: `page ${page.qualifiedId} must use standard chrome` }
    }
    if (page.metadata.icon === undefined) {
      return { state: 'invalid', detail: `page ${page.qualifiedId} requires a host icon token` }
    }
    const values = this.contexts.getSnapshot()
    const unknownKey = whenContextKeys(record.definition.when).find(key => !Object.hasOwn(values, key))
    if (unknownKey !== undefined) {
      return { state: 'invalid', detail: `when context key ${unknownKey} is not declared by the host adapter` }
    }
    if (!evaluateWhen(record.definition.when, values)) {
      return { state: 'pending', detail: 'route when condition is not satisfied' }
    }
    const outletAccess = this.access?.decision(record.owner, 'manager.content', 'outlet', view ?? record.candidateView)
    if (outletAccess !== undefined && !outletAccess.authorized) {
      return { state: 'invalid', detail: outletAccess.reason ?? `extension point manager.content is denied for plugin ${record.owner}` }
    }
    return {
      state: 'available',
      resolved: {
        owner: record.owner,
        qualifiedId: record.qualifiedId,
        definition: record.definition as CordisXRouteDefinition<'manager.content'>,
        page: {
          owner: page.owner,
          id: page.metadata.id,
          qualifiedId: page.qualifiedId,
          metadata: page.metadata,
        },
      },
    }
  }

  mountManagerSettings(
    requestingOwner: string,
    reference: CordisXRouteReference,
    contributionId: string,
    panelBody: HTMLElement,
  ): Promise<ManagedSettingsPageMount> {
    let result: ManagedSettingsPageMount | undefined
    return this.enqueue(async () => {
      assertKeys(reference, ['id', 'params'], 'manager settings route reference')
      assertLocalId(reference.id, 'manager settings route reference')
      const record = this.findRecord(requestingOwner, reference.id)
      if (record === undefined || record.owner !== requestingOwner) throw new Error(`route ${reference.id} is not available to plugin ${requestingOwner}`)
      const resolution = this.managerSettingsRoute(requestingOwner, reference.id)
      if (resolution.state !== 'available') throw new Error(resolution.detail ?? `route ${record.qualifiedId} is not available`)
      const page = this.pages.get(record.owner, record.definition.page, record.candidateView)!
      const surfaceAccess = this.access?.authorizeSurfaceRoute(requestingOwner, 'manager.settings.tabs', contributionId, record.qualifiedId)
      if (surfaceAccess !== undefined && !surfaceAccess.authorized) throw new Error(surfaceAccess.reason ?? 'manager.settings.tabs is denied')
      const routeAccess = this.access?.authorizeOutletRoute(requestingOwner, 'manager.settings.content', record.qualifiedId, page.qualifiedId)
      if (routeAccess !== undefined && !routeAccess.authorized) throw new Error(routeAccess.reason ?? 'manager.settings.content is denied')
      const pageAccess = this.access?.authorizeOutletPage(requestingOwner, 'manager.settings.content', record.qualifiedId, page.qualifiedId)
      if (pageAccess !== undefined && !pageAccess.authorized) throw new Error(pageAccess.reason ?? 'manager.settings.content is denied')
      const params = immutableSnapshot(reference.params ?? {})
      buildPath(record, params)
      await this.unmountManagerSettings()

      const content = panelBody.ownerDocument.createElement('div')
      content.dataset.cordisxSettingsPage = page.qualifiedId
      content.dataset.cordisxRoute = record.qualifiedId
      content.dataset.cordisxNoDrag = 'true'
      content.style.cssText = 'min-width:0;min-height:100%;box-sizing:border-box'
      content.style.setProperty('-webkit-app-region', 'no-drag')
      panelBody.append(content)
      const abortController = new AbortController()
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
      const localization = this.i18n.seatFor(page.owner, page.metadata.localeNamespace ?? page.owner, own)
      const mount = {} as ManagedSettingsPageMountRecord
      Object.assign(mount, {
        owner: page.owner,
        contributionId,
        routeId: record.qualifiedId,
        pageId: page.qualifiedId,
        signal: abortController.signal,
        route: record,
        page,
        content,
        effects,
        abortController,
        disposed: false,
        abort: () => abortController.abort(),
        dispose: () => this.disposeManagedSettingsMount(mount),
      })
      this.managerSettingsMount = mount
      try {
        const pageDispose = page.mount({
          container: content,
          document: content.ownerDocument,
          signal: abortController.signal,
          routeId: record.qualifiedId,
          outlet: 'manager.settings.content',
          params,
          navigation: {
            navigate: next => this.navigate(page.owner, next),
            back: outlet => this.back(page.owner, outlet),
            close: outlet => this.close(page.owner, outlet),
          },
          localeNamespace: localization.namespace,
          t: localization.t,
          localization,
        })
        if (typeof pageDispose === 'function') mount.pageDispose = pageDispose
        result = mount
        this.notify()
      } catch (error) {
        await this.disposeManagedSettingsMount(mount)
        throw error
      }
    }).then(() => result!)
  }

  closeManagerSettings(): Promise<void> {
    return this.enqueue(async () => {
      await this.unmountManagerSettings()
      this.notify()
    })
  }

  navigate(requestingOwner: string, reference: CordisXRouteReference): Promise<void> {
    return this.enqueue(() => this.navigateNow(requestingOwner, reference))
  }

  navigateFromSurface(
    requestingOwner: string,
    reference: CordisXRouteReference,
    pointId: string,
    contributionId: string,
    returnFocus?: HTMLElement,
  ): Promise<void> {
    const routeId = qualifyOwnedId(requestingOwner, reference.id)
    const decision = this.access?.authorizeSurfaceRoute(requestingOwner, pointId, contributionId, routeId)
    if (decision !== undefined && !decision.authorized) {
      return Promise.reject(new Error(decision.reason ?? `extension point ${pointId} is denied for plugin ${requestingOwner}`))
    }
    return this.enqueue(() => this.navigateNow(requestingOwner, reference, returnFocus))
  }

  routeProjection(requestingOwner: string, reference: CordisXRouteReference): RouteProjection {
    const record = this.findRecord(requestingOwner, reference.id)
    if (record === undefined || record.owner !== requestingOwner || this.routeError(record) !== undefined) return { active: false, presented: false }
    const params = reference.params ?? {}
    try {
      buildPath(record, params)
    } catch {
      return { active: false, presented: false, outlet: record.definition.outlet }
    }
    const state = this.states.get(record.definition.outlet)
    const current = state?.stack.at(-1)
    const active = current?.record === record && sameRouteParams(current.params, params) && state?.mount !== undefined
    return {
      active,
      presented: active && state?.presentation === 'presented',
      outlet: record.definition.outlet,
    }
  }

  toggleFromSurface(
    requestingOwner: string,
    reference: CordisXRouteReference,
    pointId: string,
    contributionId: string,
    returnFocus?: HTMLElement,
  ): Promise<void> {
    return this.enqueue(async () => {
      const routeId = qualifyOwnedId(requestingOwner, reference.id)
      const decision = this.access?.authorizeSurfaceRoute(requestingOwner, pointId, contributionId, routeId)
      if (decision !== undefined && !decision.authorized) {
        throw new Error(decision.reason ?? `extension point ${pointId} is denied for plugin ${requestingOwner}`)
      }
      if (this.routeProjection(requestingOwner, reference).active) {
        const record = this.visibleRecords().find(item => item.qualifiedId === routeId)
        if (record !== undefined) await this.closeNow(record.definition.outlet, true)
        this.notify()
        return
      }
      await this.navigateNow(requestingOwner, reference, returnFocus)
    })
  }

  back(requestingOwner: string, outlet?: CordisXOutletName): Promise<void> {
    return this.enqueue(async () => {
      const name = outlet ?? this.currentOutletFor(requestingOwner)
      if (name === undefined) throw new Error(`plugin ${requestingOwner} has no open route`)
      const state = this.states.get(name)
      if (state === undefined || state.stack.length < 2) {
        await this.closeNow(name, true)
        return
      }
      await this.unmount(state)
      state.stack.pop()
      await this.mountCurrent(name, state)
      await this.reconcilePresentation()
      this.notify()
    })
  }

  close(requestingOwner: string, outlet?: CordisXOutletName): Promise<void> {
    return this.enqueue(async () => {
      const name = outlet ?? this.currentOutletFor(requestingOwner)
      if (name === undefined) return
      await this.closeNow(name, true)
      this.notify()
    })
  }

  match(outlet: string, path: string): { readonly routeId: string; readonly params: Readonly<Record<string, string>> } | undefined {
    const matches = this.visibleRecords()
      .filter(record => record.definition.outlet === outlet
        && this.routeError(record) === undefined
        && (this.access?.decision(record.owner, outlet, 'outlet').authorized ?? true))
      .map(record => ({ record, params: matchPath(record, path) }))
      .filter((item): item is { record: RouteRecord; params: Readonly<Record<string, string>> } => item.params !== undefined)
    if (matches.length !== 1) return undefined
    return { routeId: matches[0]!.record.qualifiedId, params: matches[0]!.params }
  }

  snapshot(view?: PluginGenerationView): NavigationSnapshot {
    const nextMetadataProjectionSites = new Map<string, string>()
    const routes = this.visibleRecords(view).map((record): RouteSnapshot => {
      const error = this.routeError(record)
      const pointAccess = this.access?.decision(record.owner, record.definition.outlet, 'outlet', view ?? record.candidateView)
        ?? { policy: 'inherit' as const, effectivePolicy: 'allow' as const, authorized: true }
      return {
        owner: record.owner,
        id: record.definition.id,
        qualifiedId: record.qualifiedId,
        definition: record.definition,
        productMetadata: this.projectProductMetadata(
          'route',
          record.owner,
          record.qualifiedId,
          record.definition.title,
          record.definition.description,
          nextMetadataProjectionSites,
        ),
        valid: error === undefined,
        authorized: pointAccess.authorized,
        pointPolicy: pointAccess.policy,
        effectivePointPolicy: pointAccess.effectivePolicy,
        ...(pointAccess.reason === undefined ? {} : { pointPolicyReason: pointAccess.reason }),
        ...(error === undefined ? {} : { error }),
      }
    }).sort((left, right) => left.qualifiedId.localeCompare(right.qualifiedId))
    const pages = this.pages.snapshot(view).map((page): NavigationPageSnapshot => ({
      ...page,
      productMetadata: this.projectProductMetadata(
        'page',
        page.owner,
        page.qualifiedId,
        page.metadata.title,
        page.metadata.description,
        nextMetadataProjectionSites,
      ),
    }))
    for (const [site, owner] of this.metadataProjectionSites) {
      if (!nextMetadataProjectionSites.has(site)) this.i18n.clearDiagnosticSite(owner, site)
    }
    this.metadataProjectionSites = nextMetadataProjectionSites
    const outlets = this.outlets.descriptors().map((descriptor): OutletSnapshot => {
      const host = this.outlets.get(descriptor.id)!.controller.getSnapshot()
      const state = this.states.get(descriptor.id)
      const managerMount = descriptor.id === 'manager.settings.content' ? this.managerSettingsMount : undefined
      return {
        ...descriptor,
        ...host,
        mounted: state?.mount !== undefined || managerMount !== undefined,
        presentation: state?.mount === undefined && managerMount === undefined ? 'inactive' : state?.presentation ?? 'presented',
        ...(state?.suspendedBy === undefined ? {} : { suspendedBy: state.suspendedBy }),
        ...(managerMount !== undefined
          ? { activeRoute: managerMount.routeId }
          : state?.stack.at(-1) === undefined ? {} : { activeRoute: state.stack.at(-1)!.record.qualifiedId }),
        ...(state?.error === undefined ? {} : { error: state.error }),
      }
    })
    return { routes, pages, outlets }
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
    await this.unmountManagerSettings()
    for (const [name] of this.states) await this.closeNow(name)
    this.records.clear()
    this.states.clear()
    this.presentationOrder = []
    this.listeners.clear()
    this.disconnectVisibility?.()
    for (const [site, owner] of this.metadataProjectionSites) this.i18n.clearDiagnosticSite(owner, site)
    this.metadataProjectionSites.clear()
  }

  private projectProductMetadata(
    kind: 'route' | 'page',
    owner: string,
    qualifiedId: string,
    title: CordisXPageMetadata['title'] | undefined,
    description: CordisXPageMetadata['description'] | undefined,
    sites: Map<string, string>,
  ): NavigationProductMetadata {
    const diagnostics: NavigationMetadataDiagnostic[] = []
    const project = (
      field: 'title' | 'description',
      value: CordisXPageMetadata['title'] | undefined,
    ): string | undefined => {
      if (value === undefined) {
        diagnostics.push(Object.freeze({
          code: `metadata.missing-${field}`,
          field,
          message: `${kind} ${qualifiedId} should declare localized ${field} metadata`,
        }) as NavigationMetadataDiagnostic)
        return undefined
      }
      const site = `navigation:${kind}:${qualifiedId}:${field}`
      sites.set(site, owner)
      return this.i18n.resolveFor(owner, value, site).text
    }
    const projectedTitle = project('title', title)
    const projectedDescription = project('description', description)
    return Object.freeze({
      ...(projectedTitle === undefined ? {} : { title: projectedTitle }),
      ...(projectedDescription === undefined ? {} : { description: projectedDescription }),
      diagnostics: Object.freeze(diagnostics),
    })
  }

  private enqueue(action: () => void | Promise<void>): Promise<void> {
    const result = this.operation.then(async () => {
      if (this.disposed) throw new Error('CordisX navigation registry is disposed')
      await action()
    })
    this.operation = result.catch(() => {})
    return result
  }

  private visibleRecords(view?: PluginGenerationView): RouteRecord[] {
    return [...this.records.values()].filter(record => this.pages.visibility?.visible(record.generation, view) ?? true)
  }

  private findRecord(owner: string, id: string, view?: PluginGenerationView): RouteRecord | undefined {
    const qualifiedId = qualifyOwnedId(owner, id)
    return this.visibleRecords(view).find(record => record.qualifiedId === qualifiedId && record.owner === owner)
  }

  private async reconcileGeneration(): Promise<void> {
    if (this.managerSettingsMount !== undefined) await this.unmountManagerSettings()
    for (const [name, state] of this.states) {
      let changed = false
      const replacement: RouteEntry[] = []
      for (const entry of state.stack) {
        const active = this.findRecord(entry.record.owner, entry.record.definition.id)
        if (active === undefined) continue
        changed ||= active !== entry.record
        replacement.push({ ...entry, record: active })
      }
      if (replacement.length !== state.stack.length) changed = true
      if (!changed) continue
      await this.unmount(state)
      state.stack = replacement
      if (replacement.length === 0) {
        await this.closeNow(name)
      } else {
        await this.mountCurrent(name, state)
      }
    }
    await this.reconcilePresentation()
    this.notify()
  }

  private routeError(record: RouteRecord): string | undefined {
    const view = record.candidateView
    const conflict = this.visibleRecords(view).find(other => other !== record
      && other.definition.outlet === record.definition.outlet
      && other.definition.path === record.definition.path)
    if (conflict !== undefined) return `route path conflicts with ${conflict.qualifiedId}`
    if (this.outlets.get(record.definition.outlet) === undefined) return `outlet ${record.definition.outlet} is not declared by the host adapter`
    if (!this.outlets.get(record.definition.outlet)!.validatePath(record.definition.path)) {
      return `route path ${record.definition.path} is incompatible with outlet ${record.definition.outlet}`
    }
    const page = this.pages.get(record.owner, record.definition.page, view)
    if (page === undefined) return `page ${record.definition.page} is not registered by plugin ${record.owner}`
    if (record.definition.outlet === 'manager.content') {
      if (record.definition.path === '/manager/extensions'
        || record.definition.path === '/manager/extensions/'
        || !record.definition.path.startsWith('/manager/extensions/')) {
        return `route path ${record.definition.path} must be strictly below /manager/extensions/`
      }
      if (record.definition.page.includes(':')) return `page ${record.definition.page} must be a same-owner local page`
      if (record.definition.schemaVersion !== 2
        || record.definition.title === undefined
        || record.definition.description === undefined) {
        return 'manager.content routes require route-v2 title and description'
      }
      if (page.metadata.schemaVersion !== 3 || page.metadata.description === undefined) {
        return `page ${page.qualifiedId} requires page-v3 title and description`
      }
      if (page.metadata.chrome === 'body-only') {
        return `page ${page.qualifiedId} must use standard chrome for manager.content`
      }
      if (page.metadata.icon === undefined) return `page ${page.qualifiedId} requires a host icon token`
    }
    if (record.definition.outlet === 'manager.settings.content' && page.metadata.chrome !== 'body-only') {
      return `page ${page.qualifiedId} must use body-only chrome for manager.settings.content`
    }
    if (
      page.metadata.chrome === 'body-only'
      && record.definition.outlet !== 'session.content'
      && record.definition.outlet !== 'manager.settings.content'
    ) {
      return `body-only page ${record.definition.page} requires an outlet with persistent external chrome`
    }
    const values = this.contexts.getSnapshot()
    const unknownKey = whenContextKeys(record.definition.when).find(key => !Object.hasOwn(values, key))
    if (unknownKey !== undefined) return `when context key ${unknownKey} is not declared by the host adapter`
    if (!evaluateWhen(record.definition.when, values)) return 'route when condition is not satisfied'
  }

  private async navigateNow(requestingOwner: string, reference: CordisXRouteReference, returnFocus?: HTMLElement): Promise<void> {
    assertKeys(reference, ['id', 'params'], 'route reference')
    assertReference(reference.id, 'route reference')
    const record = this.findRecord(requestingOwner, reference.id)
    if (record === undefined || record.owner !== requestingOwner) throw new Error(`route ${reference.id} is not available to plugin ${requestingOwner}`)
    const error = this.routeError(record)
    if (error !== undefined) throw new Error(`route ${record.qualifiedId} is invalid: ${error}`)
    const routeAccess = this.access?.authorizeOutletRoute(
      requestingOwner,
      record.definition.outlet,
      record.qualifiedId,
      qualifyOwnedId(record.owner, record.definition.page),
      record.candidateView,
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
      delete state.returnFocus
    }
    state.contextKey = host.contextKey
    if (returnFocus !== undefined) state.returnFocus = returnFocus
    await this.unmount(state)
    state.stack.push({ record, params, path })
    await this.mountCurrent(record.definition.outlet, state)
    this.presentationOrder = this.presentationOrder.filter(name => name !== record.definition.outlet)
    this.presentationOrder.push(record.definition.outlet)
    await this.reconcilePresentation()
    this.notify()
  }

  private async mountCurrent(name: string, state: OutletNavigationState): Promise<void> {
    const entry = state.stack.at(-1)
    if (entry === undefined) return
    const outlet = this.outlets.get(name)
    const page = this.pages.get(entry.record.owner, entry.record.definition.page, entry.record.candidateView)
    if (outlet === undefined || page === undefined) return
    const host = outlet.controller.getSnapshot()
    if (!host.available || host.container === undefined || host.contextKey === undefined) return
    const pageAccess = this.access?.authorizeOutletPage(
      entry.record.owner,
      entry.record.definition.outlet,
      entry.record.qualifiedId,
      page.qualifiedId,
      entry.record.candidateView,
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
      background: 'var(--color-background-surface-under, #141414)',
      color: 'var(--color-text, #dfdfdf)', font: '13px/1.45 ui-sans-serif, system-ui, sans-serif',
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
    const tooltips = new HostTooltipController(content.ownerDocument)
    effects.push(() => tooltips.dispose())
    const mount: MountedPage = { entry, contextKey: host.contextKey, content, abort, effects }
    state.mount = mount
    delete state.error
    try {
      const bodyOnly = page.metadata.chrome === 'body-only'
      content.dataset.cordisxPageChromePolicy = bodyOnly ? 'body-only' : 'standard'
      if (!bodyOnly) {
      const chrome = content.ownerDocument.createElement('header')
      chrome.dataset.cordisxPageChrome = 'true'
      chrome.dataset.cordisxDrag = 'true'
      Object.assign(chrome.style, {
        display: 'flex', alignItems: 'center', gap: '8px', minHeight: '46px', padding: '0 12px',
        borderBottom: '1px solid var(--color-border, rgba(255,255,255,.084))',
        background: 'var(--color-background-surface, #181818)', flex: '0 0 auto',
      })
      chrome.style.paddingLeft = 'max(12px, var(--cordisx-page-chrome-safe-left, 0px))'
      chrome.style.setProperty('-webkit-app-region', 'drag')
      const leading = content.ownerDocument.createElement('div')
      leading.dataset.cordisxPageLeading = 'true'
      leading.style.cssText = 'display:flex;width:28px;height:28px;flex:0 0 28px;align-items:center;justify-content:center'
      if (state.stack.length >= 2) {
        const back = pageChromeButton(content.ownerDocument, 'Back', 'host:back')
        back.addEventListener('click', () => { void this.back(page.owner, name as CordisXOutletName) })
        leading.append(back)
      } else if (page.metadata.icon !== undefined) {
        leading.append(createHostSurfaceIcon(content.ownerDocument, page.metadata.icon))
      }
      const titleGroup = content.ownerDocument.createElement('div')
      titleGroup.dataset.cordisxPageTitle = 'true'
      titleGroup.style.cssText = 'display:flex;align-items:center;gap:8px;min-width:0;flex:1'
      const title = content.ownerDocument.createElement('strong')
      title.style.cssText = 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
      const titleMessage = entry.record.definition.title ?? page.metadata.title
      const titleSite = `page:${page.qualifiedId}:chrome.title`
      localization.effect(() => {
        title.textContent = this.i18n.resolveFor(page.owner, titleMessage, titleSite).text
        return () => this.i18n.clearDiagnosticSite(page.owner, titleSite)
      })
      titleGroup.append(title)
      const close = pageChromeButton(content.ownerDocument, 'Close', 'host:close')
      close.addEventListener('click', () => { void this.close(page.owner, name as CordisXOutletName) })
      chrome.append(leading, titleGroup)
      for (const action of page.metadata.headerActions ?? []) {
        const button = pageChromeButton(content.ownerDocument, action.id, action.icon ?? 'host:more')
        button.dataset.cordisxPageHeaderAction = action.id
        const labelSite = `page:${page.qualifiedId}:chrome.actions.${action.id}.label`
        const disabledSite = `page:${page.qualifiedId}:chrome.actions.${action.id}.disabled`
        localization.effect(() => {
          const accessible = this.i18n.resolveFor(page.owner, action.ariaLabel ?? action.label, labelSite).text
          button.setAttribute('aria-label', accessible)
          const disabledReason = action.disabled?.reason === undefined
            ? undefined
            : this.i18n.resolveFor(page.owner, action.disabled.reason, disabledSite).text
          button.dataset.cordisxTooltip = action.disabled?.value === true && disabledReason !== undefined ? disabledReason : accessible
          return () => {
            this.i18n.clearDiagnosticSite(page.owner, labelSite)
            this.i18n.clearDiagnosticSite(page.owner, disabledSite)
          }
        })
        const refresh = (): void => {
          button.hidden = !evaluateWhen(action.when, this.contexts.getSnapshot())
          button.disabled = action.disabled?.value === true || !(this.commands?.hasFor(page.owner, action.command) ?? false)
        }
        refresh()
        effects.push(tooltips.attach(button, () => button.dataset.cordisxTooltip, 'bottom'))
        effects.push(this.contexts.subscribe(refresh))
        if (this.commands !== undefined) effects.push(this.commands.subscribeInternal(refresh))
        button.addEventListener('click', () => {
          if (button.disabled || button.hidden || this.commands === undefined) return
          const commandId = qualifyOwnedId(page.owner, action.command.id)
          const decision = this.access?.authorizeOutletPageCommand(
            page.owner,
            name,
            entry.record.qualifiedId,
            page.qualifiedId,
            action.id,
            commandId,
          )
          if (decision !== undefined && !decision.authorized) {
            state.error = decision.reason ?? `extension point ${name} is denied for plugin ${page.owner}`
            this.notify()
            return
          }
          void this.commands.executeFor(
            page.owner,
            action.command,
            `page:${page.qualifiedId}:header:${action.id}`,
          ).catch((error: unknown) => {
            state.error = error instanceof Error ? error.message : String(error)
            this.notify()
          })
        })
        chrome.append(button)
      }
      chrome.append(close)
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
          if (tab.icon !== undefined) button.append(createHostSurfaceIcon(content.ownerDocument, tab.icon))
          const label = content.ownerDocument.createElement('span')
          button.append(label)
          const site = `page:${page.qualifiedId}:chrome.tabs.${tab.id}`
          localization.effect(() => {
            label.textContent = this.i18n.resolveFor(page.owner, tab.label, site).text
            return () => this.i18n.clearDiagnosticSite(page.owner, site)
          })
          tabs.append(button)
        }
        content.append(tabs)
      }
      } else {
        const titleSite = `page:${page.qualifiedId}:body.accessible-title`
        localization.effect(() => {
          content.setAttribute('aria-label', this.i18n.resolveFor(page.owner, page.metadata.title, titleSite).text)
          return () => this.i18n.clearDiagnosticSite(page.owner, titleSite)
        })
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
      const onEscape = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape' || event.defaultPrevented) return
        event.preventDefault()
        event.stopPropagation()
        void this.close(page.owner, name as CordisXOutletName)
      }
      content.addEventListener('keydown', onEscape)
      effects.push(() => content.removeEventListener('keydown', onEscape))
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

  private async closeNow(name: string, restoreFocus = false): Promise<void> {
    const state = this.states.get(name)
    const returnFocus = restoreFocus ? state?.returnFocus : undefined
    if (state !== undefined) {
      await this.unmount(state)
      state.stack = []
      delete state.contextKey
      delete state.returnFocus
      delete state.presentation
      delete state.suspendedBy
    }
    this.presentationOrder = this.presentationOrder.filter(candidate => candidate !== name)
    await this.outlets.get(name)?.controller.hide()
    await this.reconcilePresentation()
    if (returnFocus?.isConnected === true && !returnFocus.matches(':disabled')) returnFocus.focus()
  }

  private currentOutletFor(owner: string): CordisXOutletName | undefined {
    return [...this.presentationOrder].reverse()
      .find(name => this.states.get(name)?.stack.at(-1)?.record.owner === owner) as CordisXOutletName | undefined
  }

  private async reconcileDependencies(): Promise<void> {
    const managed = this.managerSettingsMount
    if (managed !== undefined) {
      const current = this.visibleRecords().find(record => record.qualifiedId === managed.routeId)
      const resolution = current === undefined
        ? { state: 'pending' as const }
        : this.managerSettingsRoute(managed.owner, current.definition.id)
      const retentionAccess = this.access?.authorizeOutletPage(
        managed.owner,
        'manager.settings.content',
        managed.routeId,
        managed.pageId,
      )
      if (current === undefined || resolution.state !== 'available'
        || this.pages.get(managed.owner, managed.page.metadata.id) === undefined
        || (retentionAccess !== undefined && !retentionAccess.authorized)) {
        await this.unmountManagerSettings()
      }
    }
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
    await this.reconcilePresentation()
    this.notify()
  }

  private async reconcilePresentation(): Promise<void> {
    const active = new Set([...this.states.entries()]
      .filter(([, state]) => state.mount !== undefined && state.stack.length > 0)
      .map(([name]) => name))
    this.presentationOrder = this.presentationOrder.filter(name => active.has(name))
    for (const name of active) if (!this.presentationOrder.includes(name)) this.presentationOrder.push(name)
    const winners = new Map<string, string>()
    for (const name of this.presentationOrder) {
      const descriptor = this.outlets.get(name)?.descriptor
      if (descriptor === undefined || !active.has(name)) continue
      winners.set(descriptor.presentationGroup ?? descriptor.id, name)
    }
    for (const [name, state] of this.states) {
      if (!active.has(name) || state.mount === undefined) continue
      const outlet = this.outlets.get(name)
      if (outlet === undefined) continue
      const group = outlet.descriptor.presentationGroup ?? outlet.descriptor.id
      const winner = winners.get(group)
      if (winner === undefined || winner === name) {
        await outlet.controller.show()
        state.presentation = 'presented'
        delete state.suspendedBy
        state.mount.content.inert = false
        state.mount.content.removeAttribute('aria-hidden')
        state.mount.content.dataset.cordisxPresentation = 'presented'
        continue
      }
      dismissHostTooltips(state.mount.content.ownerDocument)
      const focused = state.mount.content.ownerDocument.activeElement
      if (focused instanceof state.mount.content.ownerDocument.defaultView!.HTMLElement
        && state.mount.content.contains(focused)) focused.blur()
      state.mount.content.inert = true
      state.mount.content.setAttribute('aria-hidden', 'true')
      state.mount.content.dataset.cordisxPresentation = 'suspended'
      state.presentation = 'suspended'
      state.suspendedBy = winner
      await outlet.controller.hide()
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // One observer cannot split a published visibility epoch.
      }
    }
  }

  private async disposeManagedSettingsMount(mount: ManagedSettingsPageMountRecord): Promise<void> {
    if (mount.disposed) return
    mount.disposed = true
    mount.abortController.abort()
    let failure: unknown
    try {
      await mount.pageDispose?.()
    } catch (error) {
      failure = error
    }
    for (const dispose of [...mount.effects].reverse()) {
      try {
        await dispose()
      } catch (error) {
        failure ??= error
      }
    }
    mount.content.remove()
    if (this.managerSettingsMount === mount) this.managerSettingsMount = undefined
    if (failure !== undefined) throw failure
  }

  private async unmountManagerSettings(): Promise<void> {
    const mount = this.managerSettingsMount
    if (mount === undefined) return
    await this.disposeManagedSettingsMount(mount)
  }
}

export class CordisXPageService extends Service implements CordisXPages {
  readonly registry: PageRegistry
  private readonly console: PluginConsoleAspect | undefined

  constructor(ctx: Context, console?: PluginConsoleAspect) {
    super(ctx, 'pages')
    this.console = console
    this.registry = new PageRegistry(generationVisibilityFromContext(ctx))
    ctx.effect(() => () => this.registry.dispose(), 'cordisx: page registry')
  }

  register<Messages extends CordisXMessageDefinition<Messages>>(
    metadata: CordisXPageMetadata,
    mount: CordisXPageMount<Messages>,
  ): ReturnType<CordisXPages['register']> {
    const owner = ownerFromContext(this.ctx)
    const token = this.console?.tokenFromContext(this.ctx)
    const scopedMount: CordisXPageMount<Messages> = token === undefined || this.console === undefined
      ? mount
      : context => this.console!.runInPluginContext(
          token,
          { trigger: { kind: 'registration', registrationId: `page:${owner}:${metadata.id}` } },
          () => mount(context),
        ) as ReturnType<CordisXPageMount<Messages>>
    const register = (): ReturnType<CordisXPages['register']> => this.ctx.effect(
      () => this.registry.register(this.ctx, metadata, scopedMount),
      `pages.register(${JSON.stringify(metadata.id)})`,
    )
    return token === undefined || this.console === undefined ? register() : this.console.runSync(token, 'pages.register', metadata, register)
  }

  snapshot(): readonly PageSnapshot[] {
    const visibility = generationVisibilityFromContext(this.ctx)
    return this.registry.snapshot(visibility?.view(this.ctx))
  }
}

export class CordisXRouteService extends Service implements CordisXRoutes {
  static readonly inject = ['pages', 'i18n', 'commands']
  readonly outlets = new OutletRegistry()
  readonly registry: NavigationRegistry
  readonly contexts = new HostContextStore()
  private readonly console: PluginConsoleAspect | undefined

  constructor(ctx: Context, console?: PluginConsoleAspect) {
    super(ctx, 'routes')
    this.console = console
    const pages = ctx.pages as CordisXPageService
    const i18n = ctx.i18n as CordisXI18nService
    const commands = ctx.commands as CordisXCommandService
    if (pages?.registry === undefined || i18n === undefined || commands === undefined) {
      throw new Error('CordisX routes require pages, i18n, and commands services')
    }
    this.registry = new NavigationRegistry(pages.registry, this.outlets, i18n, this.contexts, undefined, commands)
    ctx.effect(() => async () => {
      await this.registry.dispose()
      this.outlets.dispose()
      this.contexts.dispose()
    }, 'cordisx: route and outlet registries')
  }

  register(definition: CordisXRouteDefinition): ReturnType<CordisXRoutes['register']> {
    const token = this.console?.tokenFromContext(this.ctx)
    const register = (): ReturnType<CordisXRoutes['register']> => this.ctx.effect(
      () => this.registry.register(this.ctx, definition),
      `routes.register(${JSON.stringify(definition.id)})`,
    )
    return token === undefined || this.console === undefined ? register() : this.console.runSync(token, 'routes.register', definition, register)
  }

  navigate(reference: CordisXRouteReference): Promise<void> {
    const token = this.console?.tokenFromContext(this.ctx)
    if (token === undefined || this.console === undefined) return this.registry.navigate(ownerFromContext(this.ctx), reference)
    const owner = this.console.owner(token)
    return this.console.run(token, 'routes.navigate', reference, async invocation => {
      invocation.dispatch('Dispatched to Host navigation registry')
      await this.registry.navigate(owner.id, reference)
    })
  }

  back(outlet?: CordisXOutletName): Promise<void> {
    return this.registry.back(ownerFromContext(this.ctx), outlet)
  }

  close(outlet?: CordisXOutletName): Promise<void> {
    return this.registry.close(ownerFromContext(this.ctx), outlet)
  }

  hasFor(owner: string, id: string, view?: PluginGenerationView): boolean {
    return this.registry.has(owner, id, view)
  }

  managerSettingsRouteFor(owner: string, id: string, view?: PluginGenerationView): ManagerSettingsRouteResolution {
    return this.registry.managerSettingsRoute(owner, id, view)
  }

  managerSettingsNavigationRouteFor(
    owner: string,
    id: string,
    view?: PluginGenerationView,
  ): ManagerSettingsNavigationRouteResolution {
    return this.registry.managerSettingsNavigationRoute(owner, id, view)
  }

  mountManagerSettingsFor(
    owner: string,
    reference: CordisXRouteReference,
    contributionId: string,
    panelBody: HTMLElement,
  ): Promise<ManagedSettingsPageMount> {
    return this.registry.mountManagerSettings(owner, reference, contributionId, panelBody)
  }

  closeManagerSettings(): Promise<void> {
    return this.registry.closeManagerSettings()
  }

  navigateFor(owner: string, reference: CordisXRouteReference): Promise<void> {
    return this.registry.navigate(owner, reference)
  }

  navigateFromSurface(
    owner: string,
    reference: CordisXRouteReference,
    pointId: string,
    contributionId: string,
    returnFocus?: HTMLElement,
  ): Promise<void> {
    return this.registry.navigateFromSurface(owner, reference, pointId, contributionId, returnFocus)
  }

  toggleFromSurface(
    owner: string,
    reference: CordisXRouteReference,
    pointId: string,
    contributionId: string,
    returnFocus?: HTMLElement,
  ): Promise<void> {
    return this.registry.toggleFromSurface(owner, reference, pointId, contributionId, returnFocus)
  }

  routeProjection(owner: string, reference: CordisXRouteReference): RouteProjection {
    return this.registry.routeProjection(owner, reference)
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
