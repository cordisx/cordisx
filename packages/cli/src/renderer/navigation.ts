import { Context, Service, type Disposable } from '@deepseek-ai/cordis'
import { cloneAgentAvatarRef, type AgentAvatarRef } from '@cordisx/protocol/agent-avatar/v1'
import type { AgentDefinitionIdentity } from '@cordisx/protocol/agents/v1'
import {
  CORDISX_PAGE_SCHEMA_V1,
  CORDISX_PAGE_SCHEMA_V2,
  CORDISX_PAGE_SCHEMA_V3,
  CORDISX_ROUTE_SCHEMA_V1,
  CORDISX_ROUTE_SCHEMA_V2,
  CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V1,
  CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V2,
  CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V3,
  CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V4,
  CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V5,
} from '../contracts.js'
import type {
  CordisXJsonScalar,
  CordisXIconToken,
  CordisXLocalizedText,
  CordisXManagerContentNavigation,
  CordisXManagerContentNavigationDeclarationV1,
  CordisXManagerContentNavigationDeclarationV2,
  CordisXManagerContentNavigationDeclarationV3,
  CordisXManagerContentNavigationDeclarationV4,
  CordisXManagerContentNavigationDeclarationV5,
  CordisXManagerContentRecordTitleV1,
  CordisXMessageDefinition,
  CordisXOutletName,
  CordisXPageHeaderAction,
  CordisXPageMetadata,
  CordisXPageMount,
  CordisXPageMountContext,
  CordisXPageNavigation,
  CordisXPages,
  CordisXRouteDefinition,
  CordisXRouteReference,
  CordisXRoutes,
  ManagerContentNavigationTabV2,
  ManagerContentRecordSummaryProjectionV2,
} from '../contracts.js'
import type {
  ManagerContentConfigBindingHandle,
} from './manager-content-config.js'
import { mountManagerContentConfigForm } from './manager-content-config-form.js'
import type { CordisXCommandService } from './commands.js'
import { CordisXI18nService, type LocalizationEffectOwner } from './i18n.js'
import type { ExtensionPointAccessResolver } from './extension-points.js'
import { createHostSurfaceIcon } from './icons.js'
import { ownerFromContext, qualifyOwnedId, sourceFromContext } from './ownership.js'
import {
  generationVisibilityFromContext,
  type GenerationVisibilityCoordinator,
  type PluginGenerationEffectIdentity,
  type PluginGenerationView,
} from './generation-visibility.js'
import { CORDISX_HOST_ICON_TOKENS } from './surfaces.js'
import { dismissHostTooltips, HostTooltipController } from './tooltips.js'
import { HostPageControls } from './page-controls.js'
import { mountManagerCollectionHost } from './manager/components/ManagerCollection.js'
import type { ManagerCollectionHostCopyKey } from './manager-collection.js'
import type { PluginConsoleAspect } from './plugin-console.js'
import type {
  CodexRouteHistoryAdapter,
  CodexRouteHistoryEntry,
  CodexRouteHistorySnapshot,
} from './codex-router-history.js'
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

const MANAGER_COLLECTION_HOST_COPY = {
  en: {
    cancel: 'Cancel',
    'clear-feedback': 'Dismiss message',
    'clear-search': 'Clear search',
    empty: 'Nothing here yet',
    'error-description': 'Try again later.',
    'error-title': 'This list could not be loaded',
    loading: 'Loading…',
    'more-actions': 'More actions',
    retry: 'Try again',
    views: 'Collection views',
  },
  zh: {
    cancel: '取消',
    'clear-feedback': '关闭提示',
    'clear-search': '清除搜索',
    empty: '暂无数据',
    'error-description': '请稍后重试。',
    'error-title': '无法加载此列表',
    loading: '正在加载…',
    'more-actions': '更多操作',
    retry: '重试',
    views: '集合视图',
  },
} as const satisfies Readonly<Record<'en' | 'zh', Readonly<Record<ManagerCollectionHostCopyKey, string>>>>

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

/** Host-owned standard Manager page mount for a B navigation contribution. */
export interface ManagedManagerPageMount {
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
  /** Host-authenticated launcher source; never projected through public navigation snapshots. */
  readonly source?: string
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

interface ManagedManagerPageMountRecord extends ManagedManagerPageMount {
  readonly route: RouteRecord
  readonly page: PageRecord
  readonly content: HTMLElement
  readonly effects: Disposable<void>[]
  readonly abortController: AbortController
  pageDispose?: Disposable<void>
  disposed: boolean
}

interface OutletNavigationState {
  current?: RouteEntry
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

/** Host-private coordinate joining Agent authority to one navigation owner. */
export interface AgentRuntimeNavigationOwner {
  readonly source: string
  readonly pluginId: string
  readonly moduleGeneration: string
}

/** Host-private route facts admitted to the Agent Session scope authority. */
export interface AgentRuntimeNavigationRoute {
  readonly id: string
  readonly path: string
  readonly schemaVersion?: 1 | 2
}

export interface ResolvedAgentRuntimeNavigationRoute extends AgentRuntimeNavigationRoute {
  readonly owner: AgentRuntimeNavigationOwner
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

/** Host-side, data-only registry for protocol manager-content-navigation.v1/v2. */
export interface ManagerContentDeclarationRecord {
  readonly owner: string
  readonly generation: PluginGenerationEffectIdentity
  readonly candidateView?: PluginGenerationView
  readonly declaration:
    | CordisXManagerContentNavigationDeclarationV1
    | CordisXManagerContentNavigationDeclarationV2
    | CordisXManagerContentNavigationDeclarationV3
    | CordisXManagerContentNavigationDeclarationV4
    | CordisXManagerContentNavigationDeclarationV5
  readonly config?: ManagerContentConfigBindingHandle
}

interface ManagerContentTitleRecord {
  readonly owner: string
  readonly id: string
  readonly generation: PluginGenerationEffectIdentity
  readonly candidateView?: PluginGenerationView
  readonly title: CordisXLocalizedText
}

function sameReference(left: CordisXRouteReference, right: CordisXRouteReference): boolean {
  return left.id === right.id && sameRouteParams(left.params ?? {}, right.params ?? {})
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

export interface ManagerContentPresentation {
  readonly title: string
  readonly description: string
  readonly icon?: CordisXIconToken
  readonly parent?: CordisXRouteReference
  readonly recordSummary?: Readonly<{
    readonly leadingVisual: Readonly<{ readonly kind: 'agent-avatar'; readonly avatar: AgentAvatarRef }>
    readonly title: string
    readonly description?: string
    /** Exact immutable protocol projection retained before Host localization. */
    readonly source: ManagerContentRecordSummaryProjectionV2
  }>
  /**
   * A Host semantic icon is projected from the exact same-owner page route.
   * The manager renders it; plugins never supply DOM or renderer callbacks.
   */
  /** Host activation of one projected sibling replaces the current Manager history entry. */
  readonly tabs: readonly Readonly<{
    readonly id: string
    readonly label: string
    readonly icon: CordisXIconToken
    readonly route: CordisXRouteReference
    readonly active: boolean
  }>[]
  /** Host-internal authority source. It is never projected into plugin ctx. */
  readonly config?: ManagerContentConfigBindingHandle
}

export interface ManagerContentAgentDefinitionTarget {
  readonly owner: string
  readonly generation: PluginGenerationEffectIdentity
  readonly identity: AgentDefinitionIdentity
  readonly route: CordisXRouteReference
  readonly parent?: CordisXRouteReference
}

export class ManagerContentNavigationRegistry {
  private readonly declarations = new Map<string, ManagerContentDeclarationRecord>()
  private readonly titles = new Map<string, ManagerContentTitleRecord>()
  private readonly projections = new Map<string, () => void>()
  private readonly listeners = new Set<() => void>()
  private readonly disconnectVisibility: (() => void) | undefined
  private notificationDepth = 0
  private notificationPending = false
  private configFactory: ((input: {
    readonly owner: string
    readonly declarationId: string
    readonly moduleGeneration: string
    readonly view?: PluginGenerationView
    readonly body: NonNullable<CordisXManagerContentNavigationDeclarationV4['body']>
    readonly contractVersion: 1 | 2
  }) => ManagerContentConfigBindingHandle) | undefined

  constructor(private readonly visibility?: GenerationVisibilityCoordinator) {
    this.disconnectVisibility = visibility?.connect({ notify: () => this.notify() })
  }

  setConfigFactory(factory: NonNullable<ManagerContentNavigationRegistry['configFactory']>): void {
    if (this.configFactory !== undefined) throw new Error('manager content config authority is already installed')
    this.configFactory = factory
  }

  register(
    ownerOrContext: string | Context,
    declaration:
      | CordisXManagerContentNavigationDeclarationV1
      | CordisXManagerContentNavigationDeclarationV2
      | CordisXManagerContentNavigationDeclarationV3
      | CordisXManagerContentNavigationDeclarationV4
      | CordisXManagerContentNavigationDeclarationV5,
  ): () => void {
    const owner = typeof ownerOrContext === 'string' ? ownerOrContext : ownerFromContext(ownerOrContext)
    const generation: PluginGenerationEffectIdentity = typeof ownerOrContext === 'string'
      ? Object.freeze({ pluginId: owner })
      : this.visibility?.effect(ownerOrContext) ?? Object.freeze({ pluginId: owner })
    const candidateView = typeof ownerOrContext === 'string' || generation.transactionId === undefined
      ? undefined
      : this.visibility?.view(ownerOrContext)
    assertKeys(declaration, declaration.schemaVersion >= 3
      ? ['$schema', 'schemaVersion', 'id', 'route', 'parentRoute', 'header', 'subject', 'recordSummary', 'tabs', ...(declaration.schemaVersion >= 4 ? ['body'] : [])]
      : ['$schema', 'schemaVersion', 'id', 'route', 'parentRoute', 'header', 'tabs'], 'manager content navigation declaration')
    const version = declaration.$schema === CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V1 && declaration.schemaVersion === 1
      ? 1
      : declaration.$schema === CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V2 && declaration.schemaVersion === 2
        ? 2
        : declaration.$schema === CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V3 && declaration.schemaVersion === 3
          ? 3
          : declaration.$schema === CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V4 && declaration.schemaVersion === 4
            ? 4
            : declaration.$schema === CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V5 && declaration.schemaVersion === 5
              ? 5
        : undefined
    if (version === undefined) {
      throw new Error('manager content navigation declaration has an unsupported schema tuple')
    }
    assertLocalId(declaration.id, 'manager content navigation declaration id')
    this.assertRouteReference(declaration.route, 'manager content navigation declaration route')
    if (declaration.parentRoute !== undefined) this.assertRouteReference(declaration.parentRoute, 'manager content navigation declaration parent route')
    assertKeys(declaration.header, ['title'], 'manager content navigation declaration header')
    const title = declaration.header.title
    if (title === null || typeof title !== 'object' || Array.isArray(title)) {
      throw new Error('manager content navigation header title is invalid')
    }
    if (title.kind === 'record') {
      assertKeys(title, ['kind', 'recordIdParam', 'fallback'], 'manager content navigation record header')
      if (!/^[a-z][a-zA-Z0-9]*$/u.test(title.recordIdParam)) {
        throw new Error('manager content navigation recordIdParam is invalid')
      }
      assertLocalizedText(title.fallback, 'manager content navigation record fallback')
      if (!Object.hasOwn(declaration.route.params ?? {}, title.recordIdParam)) {
        throw new Error('manager content navigation record header requires its current route parameter')
      }
    } else if (title.kind === 'route') {
      assertKeys(title, ['kind'], 'manager content navigation route header')
    } else {
      throw new Error('manager content navigation header title kind is invalid')
    }
    const ids = new Set<string>()
    for (const tab of declaration.tabs ?? []) {
      assertKeys(tab, version >= 2 ? ['id', 'route', 'label'] : ['id', 'route'], 'manager content navigation tab')
      assertLocalId(tab.id, 'manager content navigation tab id')
      if (ids.has(tab.id)) throw new Error(`manager content navigation declaration has duplicate tab ${tab.id}`)
      ids.add(tab.id)
      this.assertRouteReference(tab.route, 'manager content navigation tab route')
      if (version >= 2 && Object.hasOwn(tab, 'label')) {
        assertLocalizedText((tab as ManagerContentNavigationTabV2).label, 'manager content navigation tab label')
      }
    }
    if (version >= 3) this.assertV3(declaration as CordisXManagerContentNavigationDeclarationV3 | CordisXManagerContentNavigationDeclarationV4 | CordisXManagerContentNavigationDeclarationV5, candidateView)
    const key = `${owner}\u0000${declaration.id}\u0000${generation.moduleGeneration ?? 'host'}`
    if (this.declarations.has(key)) throw new Error(`manager content navigation declaration ${declaration.id} is already registered`)
    let config: ManagerContentConfigBindingHandle | undefined
    if (version >= 4 && (declaration as CordisXManagerContentNavigationDeclarationV4 | CordisXManagerContentNavigationDeclarationV5).body !== undefined) {
      const body = (declaration as CordisXManagerContentNavigationDeclarationV4 | CordisXManagerContentNavigationDeclarationV5).body!
      this.assertConfigBody(body)
      if (this.configFactory === undefined) throw new Error('manager content config authority is unavailable')
      const moduleGeneration = generation.moduleGeneration
      if (moduleGeneration === undefined) throw new Error('manager content config requires an exact plugin generation')
      config = this.configFactory({
        owner, declarationId: declaration.id, moduleGeneration, body, contractVersion: version === 5 ? 2 : 1,
        ...(candidateView === undefined ? {} : { view: candidateView }),
      })
    }
    this.declarations.set(key, {
      owner,
      generation,
      ...(candidateView === undefined ? {} : { candidateView }),
      declaration: immutableSnapshot(declaration),
      ...(config === undefined ? {} : { config }),
    })
    if (this.visibility?.visible(generation) !== false) this.notify()
    return () => {
      const record = this.declarations.get(key)
      if (record === undefined || !this.declarations.delete(key)) return
      record.config?.close(this.visibleDeclarations().some(candidate => candidate.owner === owner
        && candidate.declaration.id === declaration.id) ? 'generation-replaced' : 'declaration-replaced')
      if (this.visibility?.visible(generation) !== false) this.notify()
    }
  }

  registerRecordTitles(ownerOrContext: string | Context, records: readonly CordisXManagerContentRecordTitleV1[]): () => void {
    const owner = typeof ownerOrContext === 'string' ? ownerOrContext : ownerFromContext(ownerOrContext)
    const generation: PluginGenerationEffectIdentity = typeof ownerOrContext === 'string'
      ? Object.freeze({ pluginId: owner })
      : this.visibility?.effect(ownerOrContext) ?? Object.freeze({ pluginId: owner })
    const candidateView = typeof ownerOrContext === 'string' || generation.transactionId === undefined
      ? undefined
      : this.visibility?.view(ownerOrContext)
    const entries: string[] = []
    for (const record of records) {
      assertKeys(record, ['id', 'title'], 'manager content record title')
      if (typeof record.id !== 'string' || record.id.length < 1 || record.id.length > 512) throw new Error('manager content record title id is invalid')
      assertLocalizedText(record.title, 'manager content record title')
      const key = `${owner}\u0000${record.id}\u0000${generation.moduleGeneration ?? 'host'}`
      if (this.titles.has(key)) throw new Error(`manager content record title ${record.id} is already registered`)
      this.titles.set(key, {
        owner,
        id: record.id,
        generation,
        ...(candidateView === undefined ? {} : { candidateView }),
        title: immutableSnapshot(record.title),
      })
      entries.push(key)
    }
    this.notify()
    return () => {
      let changed = false
      for (const key of entries) changed = this.titles.delete(key) || changed
      if (changed) this.notify()
    }
  }

  /** Atomically replace an owner projection so route observers never see a partial catalog. */
  replaceProjection(
    ownerOrContext: string | Context,
    projection: Readonly<{
      readonly declarations: readonly (
        CordisXManagerContentNavigationDeclarationV1
        | CordisXManagerContentNavigationDeclarationV2
        | CordisXManagerContentNavigationDeclarationV3
        | CordisXManagerContentNavigationDeclarationV4
        | CordisXManagerContentNavigationDeclarationV5
      )[]
      readonly recordTitles: readonly CordisXManagerContentRecordTitleV1[]
    }>,
  ): () => void {
    const owner = typeof ownerOrContext === 'string' ? ownerOrContext : ownerFromContext(ownerOrContext)
    const generation: PluginGenerationEffectIdentity = typeof ownerOrContext === 'string'
      ? Object.freeze({ pluginId: owner })
      : this.visibility?.effect(ownerOrContext) ?? Object.freeze({ pluginId: owner })
    const projectionKey = `${owner}\u0000${generation.moduleGeneration ?? 'host'}`
    let dispose: () => void = () => {}
    this.transaction(() => {
      this.projections.get(projectionKey)?.()
      const declarations: (() => void)[] = []
      let titles: (() => void) | undefined
      try {
        for (const declaration of projection.declarations) declarations.push(this.register(ownerOrContext, declaration))
        titles = this.registerRecordTitles(ownerOrContext, projection.recordTitles)
      } catch (error) {
        titles?.()
        for (const unregister of declarations.reverse()) unregister()
        throw error
      }
      dispose = () => this.transaction(() => {
        titles?.()
        for (const unregister of declarations.reverse()) unregister()
      })
      this.projections.set(projectionKey, dispose)
    })
    return () => {
      if (this.projections.get(projectionKey) !== dispose) return
      this.projections.delete(projectionKey)
      dispose()
    }
  }

  resolve(owner: string, reference: CordisXRouteReference, view?: PluginGenerationView): ManagerContentDeclarationRecord | undefined {
    const matches = this.visibleDeclarations(view).filter(record => record.owner === owner && sameReference(record.declaration.route, reference))
    return matches.length === 1 ? matches[0] : undefined
  }

  declarationsFor(owner: string, view?: PluginGenerationView): readonly ManagerContentDeclarationRecord[] {
    return this.visibleDeclarations(view).filter(record => record.owner === owner)
  }

  title(owner: string, id: string, view?: PluginGenerationView): CordisXLocalizedText | undefined {
    const matches = [...this.titles.values()].filter(record => record.owner === owner && record.id === id
      && (this.visibility?.visible(record.generation, view) ?? true))
    return matches.length === 1 ? matches[0]?.title : undefined
  }

  resolveAgentDefinitionSubject(identity: AgentDefinitionIdentity): ManagerContentAgentDefinitionTarget | undefined {
    const matches = this.visibleDeclarations().filter(record => {
      const subject = record.declaration.schemaVersion >= 3
        ? (record.declaration as CordisXManagerContentNavigationDeclarationV3 | CordisXManagerContentNavigationDeclarationV4 | CordisXManagerContentNavigationDeclarationV5).subject
        : undefined
      return subject?.kind === 'agent-definition'
        && subject.identity.agentId === identity.agentId
        && subject.identity.revision === identity.revision
    })
    if (matches.length !== 1) return undefined
    const match = matches[0]!
    const subject = (match.declaration as CordisXManagerContentNavigationDeclarationV3 | CordisXManagerContentNavigationDeclarationV4 | CordisXManagerContentNavigationDeclarationV5).subject!
    return Object.freeze({
      owner: match.owner,
      generation: match.generation,
      identity: immutableSnapshot(subject.identity),
      route: immutableSnapshot(match.declaration.route),
      ...(match.declaration.parentRoute === undefined ? {} : { parent: immutableSnapshot(match.declaration.parentRoute) }),
    })
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.disconnectVisibility?.()
    this.projections.clear()
    for (const record of this.declarations.values()) record.config?.close('owner-disposed')
    this.declarations.clear()
    this.titles.clear()
    this.listeners.clear()
  }

  private visibleDeclarations(view?: PluginGenerationView): ManagerContentDeclarationRecord[] {
    return [...this.declarations.values()].filter(record => this.visibility?.visible(record.generation, view) ?? true)
  }

  private assertV3(declaration: CordisXManagerContentNavigationDeclarationV3 | CordisXManagerContentNavigationDeclarationV4 | CordisXManagerContentNavigationDeclarationV5, view?: PluginGenerationView): void {
    if (declaration.subject !== undefined) {
      assertKeys(declaration.subject, ['kind', 'identity'], 'manager content navigation subject')
      if (declaration.subject.kind !== 'agent-definition') throw new Error('manager content navigation subject kind is invalid')
      assertKeys(declaration.subject.identity, ['agentId', 'revision'], 'manager content navigation subject identity')
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(declaration.subject.identity.agentId)
        || typeof declaration.subject.identity.revision !== 'string'
        || declaration.subject.identity.revision.length < 1
        || declaration.subject.identity.revision.length > 512) {
        throw new Error('manager content navigation subject identity is invalid')
      }
      const duplicate = this.visibleDeclarations(view).find(record => {
        const subject = record.declaration.schemaVersion >= 3
          ? (record.declaration as CordisXManagerContentNavigationDeclarationV3 | CordisXManagerContentNavigationDeclarationV4 | CordisXManagerContentNavigationDeclarationV5).subject
          : undefined
        return subject?.kind === 'agent-definition'
          && subject.identity.agentId === declaration.subject!.identity.agentId
          && subject.identity.revision === declaration.subject!.identity.revision
      })
      if (duplicate !== undefined) throw new Error(`manager content navigation subject ${declaration.subject.identity.agentId}@${declaration.subject.identity.revision} is already claimed`)
    }
    if (declaration.recordSummary !== undefined) {
      assertKeys(declaration.recordSummary, ['leadingVisual', 'title', 'description'], 'manager content record summary')
      assertKeys(declaration.recordSummary.leadingVisual, ['kind', 'avatar'], 'manager content record summary leading visual')
      if (declaration.recordSummary.leadingVisual.kind !== 'agent-avatar') throw new Error('manager content record summary leading visual kind is invalid')
      cloneAgentAvatarRef(declaration.recordSummary.leadingVisual.avatar)
      assertLocalizedText(declaration.recordSummary.title, 'manager content record summary title')
      if (typeof declaration.recordSummary.title.fallback !== 'string' || declaration.recordSummary.title.fallback.trim() === '') {
        throw new Error('manager content record summary title fallback is invalid')
      }
      if (declaration.recordSummary.description !== undefined) {
        assertLocalizedText(declaration.recordSummary.description, 'manager content record summary description')
        if (typeof declaration.recordSummary.description.fallback !== 'string' || declaration.recordSummary.description.fallback.trim() === '') {
          throw new Error('manager content record summary description fallback is invalid')
        }
      }
    }
  }

  private assertConfigBody(body: NonNullable<CordisXManagerContentNavigationDeclarationV4['body']>): void {
    assertKeys(body, ['kind', 'namespace', 'defaultMaterialization'], 'manager content config body')
    if (body.kind !== 'plugin-config-form') throw new Error('manager content config body kind is invalid')
    assertLocalId(body.namespace, 'manager content config namespace')
    const defaults = body.defaultMaterialization
    if (defaults === undefined) return
    assertKeys(defaults, ['mode', 'fields'], 'manager content config default materialization')
    if (defaults.mode !== 'missing-only' || !Array.isArray(defaults.fields) || defaults.fields.length < 1 || defaults.fields.length > 16) {
      throw new Error('manager content config default materialization is invalid')
    }
    for (const field of defaults.fields) {
      assertKeys(field, ['path', 'value'], 'manager content config missing default')
      if (!Array.isArray(field.path) || field.path.length < 1 || field.path.length > 32
        || field.path.some((segment: unknown) => typeof segment !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(segment))) {
        throw new Error('manager content config default path is invalid')
      }
      if (!['string', 'number', 'boolean'].includes(typeof field.value) && field.value !== null) {
        throw new Error('manager content config default value is invalid')
      }
    }
  }

  private assertRouteReference(reference: CordisXRouteReference, label: string): void {
    assertKeys(reference, ['id', 'params'], label)
    assertLocalId(reference.id, `${label} id`)
    for (const [key, value] of Object.entries(reference.params ?? {})) {
      if (!/^[a-z][a-zA-Z0-9]*$/u.test(key)) throw new Error(`${label} param ${key} is invalid`)
      if (!['string', 'number', 'boolean'].includes(typeof value) && value !== null) throw new Error(`${label} param ${key} is not scalar`)
    }
  }

  private notify(): void {
    if (this.notificationDepth > 0) {
      this.notificationPending = true
      return
    }
    for (const listener of this.listeners) listener()
  }

  private transaction<Value>(work: () => Value): Value {
    this.notificationDepth += 1
    try {
      return work()
    } finally {
      this.notificationDepth -= 1
      if (this.notificationDepth === 0 && this.notificationPending) {
        this.notificationPending = false
        for (const listener of this.listeners) listener()
      }
    }
  }
}

export class NavigationRegistry {
  private readonly records = new Map<string, RouteRecord>()
  private readonly states = new Map<string, OutletNavigationState>()
  private readonly listeners = new Set<() => void>()
  readonly managerContent: ManagerContentNavigationRegistry
  private metadataProjectionSites = new Map<string, string>()
  private presentationOrder: string[] = []
  private managerSettingsMount: ManagedSettingsPageMountRecord | undefined
  private managerContentMount: ManagedManagerPageMountRecord | undefined
  private readonly unsubscribePages: () => void
  private readonly unsubscribeOutlets: () => void
  private readonly unsubscribeManagerContent: () => void
  private readonly unsubscribeHistory: () => void
  private operation = Promise.resolve()
  private disposed = false
  private historyProjectionStarted = false
  private readonly disconnectVisibility: (() => void) | undefined

  constructor(
    private readonly pages: PageRegistry,
    private readonly outlets: OutletRegistry,
    private readonly i18n: CordisXI18nService,
    private readonly history: CodexRouteHistoryAdapter,
    readonly contexts: HostContextStore = new HostContextStore(),
    private access?: ExtensionPointAccessResolver,
    private readonly commands?: Pick<CordisXCommandService, 'hasFor' | 'executeFor' | 'subscribeInternal'>,
  ) {
    this.managerContent = new ManagerContentNavigationRegistry(pages.visibility)
    this.unsubscribePages = pages.subscribe(() => { void this.enqueue(() => this.reconcileDependencies()) })
    this.unsubscribeOutlets = outlets.subscribe(() => { void this.enqueue(() => this.reconcileDependencies()) })
    this.unsubscribeManagerContent = this.managerContent.subscribe(() => this.notify())
    this.unsubscribeHistory = history.subscribe(() => {
      if (this.historyProjectionStarted) void this.enqueue(() => this.applyHistorySnapshot(history.snapshot()))
    })
    this.disconnectVisibility = pages.visibility?.connect({ notify: () => {
      void this.enqueue(() => this.reconcileGeneration())
    } })
  }

  /** Begin reverse projection only after Host outlets and plugin routes are registered. */
  startHistoryProjection(): Promise<void> {
    this.historyProjectionStarted = true
    return this.enqueue(() => this.applyHistorySnapshot(this.history.snapshot()))
  }

  managerContentPresentation(
    owner: string,
    reference: CordisXRouteReference,
  ): ManagerContentPresentation | undefined {
    const declaration = this.managerContent.resolve(owner, reference)
    if (declaration === undefined) return undefined
    const record = this.findRecord(owner, reference.id)
    if (record === undefined || record.definition.outlet !== 'manager.content') return undefined
    try { buildPath(record, reference.params ?? {}) } catch { return undefined }
    const page = this.pages.get(owner, record.definition.page, record.candidateView)
    if (page === undefined) return undefined
    const text = (value: CordisXLocalizedText, site: string): string => (
      this.i18n.resolveFor(owner, value, site).text ?? value.fallback ?? value.key
    )
    const header = declaration.declaration.header.title
    const title = header.kind === 'record'
      ? text(this.managerContent.title(owner, String(reference.params?.[header.recordIdParam]), declaration.candidateView) ?? header.fallback, `manager-content:${owner}:${declaration.declaration.id}:record`)
      : text(page.metadata.title, `manager-content:${owner}:${declaration.declaration.id}:title`)
    const description = text(page.metadata.description ?? record.definition.description ?? record.definition.title ?? page.metadata.title, `manager-content:${owner}:${declaration.declaration.id}:description`)
    const relatedDeclarations = this.managerContent.declarationsFor(owner, declaration.candidateView).filter(candidate => (
      sameReference(candidate.declaration.route, reference)
      || (declaration.declaration.tabs ?? []).some(tab => sameReference(tab.route, candidate.declaration.route))
      || (candidate.declaration.tabs ?? []).some(tab => sameReference(tab.route, reference))
    ))
    const summarySources = relatedDeclarations.flatMap(candidate => (
      candidate.declaration.schemaVersion >= 3
        && (candidate.declaration as CordisXManagerContentNavigationDeclarationV3 | CordisXManagerContentNavigationDeclarationV4 | CordisXManagerContentNavigationDeclarationV5).recordSummary !== undefined
        ? [(candidate.declaration as CordisXManagerContentNavigationDeclarationV3 | CordisXManagerContentNavigationDeclarationV4 | CordisXManagerContentNavigationDeclarationV5).recordSummary!]
        : []
    ))
    if (summarySources.length > 1 && summarySources.some(summary => !sameStructuredValue(summarySources[0], summary))) return undefined
    const summarySource = summarySources[0] === undefined
      ? undefined
      : immutableSnapshot(summarySources[0]) as ManagerContentRecordSummaryProjectionV2
    const recordSummary = summarySource === undefined ? undefined : Object.freeze({
      leadingVisual: summarySource.leadingVisual,
      title: text(summarySource.title, `manager-content:${owner}:${declaration.declaration.id}:summary:title`),
      ...(summarySource.description === undefined ? {} : {
        description: text(summarySource.description, `manager-content:${owner}:${declaration.declaration.id}:summary:description`),
      }),
      source: summarySource,
    })
    const tabs = (declaration.declaration.tabs ?? []).flatMap(tab => {
      // A tab may only point at a concrete declaration owned by this plugin.
      // Dropping an unresolved projection keeps the Host renderer from exposing
      // a navigation target that cannot be mounted by the same owner.
      const targetDeclaration = this.managerContent.resolve(owner, tab.route, declaration.candidateView)
      if (targetDeclaration === undefined) return []
      const targetTabs = targetDeclaration.declaration.tabs ?? []
      if (targetTabs.length > 0 && targetTabs.filter(candidate => sameReference(candidate.route, tab.route)).length !== 1) return []
      const resolution = this.managerContentRoute(owner, tab.route, record.candidateView)
      if (resolution.state !== 'available' || resolution.resolved === undefined) return []
      const icon = resolution.resolved.page.metadata.icon
      if (icon === undefined) return []
      const tabText = declaration.declaration.schemaVersion >= 2
        ? (Object.hasOwn(tab, 'label')
            ? (tab as ManagerContentNavigationTabV2).label
            : resolution.resolved.definition.title)
        : resolution.resolved.page.metadata.title
      if (tabText === undefined) return []
      return [Object.freeze({
        id: tab.id,
        label: text(tabText, `manager-content:${owner}:${declaration.declaration.id}:tab:${tab.id}`),
        icon,
        route: Object.freeze({ id: tab.route.id, ...(tab.route.params === undefined ? {} : { params: immutableSnapshot(tab.route.params) }) }),
        active: sameReference(tab.route, reference),
      })]
    })
    // A declared tabset is all-or-nothing: the current exact route must be a
    // single renderable member. Otherwise publishing the projection would let
    // the renderer create an ARIA tablist with no selected tab.
    if ((declaration.declaration.tabs?.length ?? 0) > 0 && tabs.filter(tab => tab.active).length !== 1) return undefined
    return Object.freeze({
      title,
      description,
      ...(page.metadata.icon === undefined ? {} : { icon: page.metadata.icon }),
      ...(declaration.declaration.parentRoute === undefined ? {} : { parent: declaration.declaration.parentRoute }),
      ...(recordSummary === undefined ? {} : { recordSummary }),
      ...(declaration.config === undefined ? {} : { config: declaration.config }),
      tabs: Object.freeze(tabs),
    })
  }

  managerContentAgentDefinitionTarget(identity: AgentDefinitionIdentity): ManagerContentAgentDefinitionTarget | undefined {
    const target = this.managerContent.resolveAgentDefinitionSubject(identity)
    if (target === undefined) return undefined
    if (this.managerContentRoute(target.owner, target.route).state !== 'available') return undefined
    if (target.parent !== undefined && this.managerContentRoute(target.owner, target.parent).state !== 'available') return undefined
    return target
  }

  setManagerContentConfigFactory(factory: Parameters<ManagerContentNavigationRegistry['setConfigFactory']>[0]): void {
    this.managerContent.setConfigFactory(factory)
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
    const source = typeof ownerOrContext === 'string' ? undefined : sourceFromContext(ownerOrContext)
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
      ...(source === undefined ? {} : { source }),
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

  /**
   * Resolves only routes registered by one exact launcher-authenticated plugin
   * source and module generation. The public local owner id is never treated as
   * sufficient authority by itself.
   */
  agentRuntimeRoutesForOwner(
    owner: AgentRuntimeNavigationOwner,
    view?: PluginGenerationView,
  ): readonly AgentRuntimeNavigationRoute[] {
    return Object.freeze(this.visibleRecords(view)
      .filter(record => record.owner === owner.pluginId
        && record.source === owner.source
        && record.generation.moduleGeneration === owner.moduleGeneration)
      .map(record => Object.freeze({
        id: record.definition.id,
        path: record.definition.path,
        ...(record.definition.schemaVersion === undefined ? {} : { schemaVersion: record.definition.schemaVersion }),
      })))
  }

  /** Resolves a persisted Host history entry back to its exact source owner. */
  agentRuntimeRouteFromHistory(
    entry: CodexRouteHistoryEntry,
    view?: PluginGenerationView,
  ): ResolvedAgentRuntimeNavigationRoute | undefined {
    const matches = this.visibleRecords(view).filter(record => {
      if (record.owner !== entry.owner || record.qualifiedId !== entry.routeId
        || record.source === undefined || record.generation.moduleGeneration === undefined) return false
      try { return buildPath(record, entry.params) === entry.path } catch { return false }
    })
    if (matches.length !== 1) return undefined
    const record = matches[0]!
    return Object.freeze({
      owner: Object.freeze({
        source: record.source!,
        pluginId: record.owner,
        moduleGeneration: record.generation.moduleGeneration!,
      }),
      id: record.definition.id,
      path: record.definition.path,
      ...(record.definition.schemaVersion === undefined ? {} : { schemaVersion: record.definition.schemaVersion }),
    })
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

  managerContentRoute(
    requestingOwner: string,
    reference: CordisXRouteReference,
    view?: PluginGenerationView,
  ): ManagerSettingsNavigationRouteResolution {
    const resolution = this.managerSettingsNavigationRoute(requestingOwner, reference.id, view)
    if (resolution.state !== 'available' || resolution.resolved === undefined) return resolution
    try {
      const record = this.findRecord(requestingOwner, reference.id, view)
      if (record === undefined) return { state: 'pending', detail: `route ${reference.id} is not registered` }
      buildPath(record, reference.params ?? {})
    } catch (error) {
      return { state: 'invalid', detail: error instanceof Error ? error.message : String(error) }
    }
    return resolution
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
      const controls = new HostPageControls(content.ownerDocument, content)
      effects.push(() => controls.dispose())
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
          controls,
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

  mountManagerContent(
    requestingOwner: string,
    reference: CordisXRouteReference,
    contributionId: string,
    container: HTMLElement,
    managerNavigation?: CordisXPageNavigation,
  ): Promise<ManagedManagerPageMount> {
    let result: ManagedManagerPageMount | undefined
    return this.enqueue(async () => {
      assertKeys(reference, ['id', 'params'], 'manager content route reference')
      assertLocalId(reference.id, 'manager content route reference')
      const record = this.findRecord(requestingOwner, reference.id)
      if (record === undefined || record.owner !== requestingOwner) throw new Error(`route ${reference.id} is not available to plugin ${requestingOwner}`)
      const resolution = this.managerContentRoute(requestingOwner, reference)
      if (resolution.state !== 'available') throw new Error(resolution.detail ?? `route ${record.qualifiedId} is not available`)
      const managerDeclaration = this.managerContent.resolve(requestingOwner, reference, record.candidateView)
      const page = this.pages.get(record.owner, record.definition.page, record.candidateView)!
      const surfaceAccess = this.access?.authorizeSurfaceRoute(requestingOwner, 'manager.settings.navigation-items', contributionId, record.qualifiedId)
      if (surfaceAccess !== undefined && !surfaceAccess.authorized) throw new Error(surfaceAccess.reason ?? 'manager.settings.navigation-items is denied')
      const routeAccess = this.access?.authorizeOutletRoute(requestingOwner, 'manager.content', record.qualifiedId, page.qualifiedId)
      if (routeAccess !== undefined && !routeAccess.authorized) throw new Error(routeAccess.reason ?? 'manager.content is denied')
      const pageAccess = this.access?.authorizeOutletPage(requestingOwner, 'manager.content', record.qualifiedId, page.qualifiedId)
      if (pageAccess !== undefined && !pageAccess.authorized) throw new Error(pageAccess.reason ?? 'manager.content is denied')
      const params = immutableSnapshot(reference.params ?? {})
      buildPath(record, params)
      await this.unmountManagerContent()

      const content = container.ownerDocument.createElement('div')
      content.dataset.cordisxManagerPage = page.qualifiedId
      content.dataset.cordisxRoute = record.qualifiedId
      content.dataset.cxmSettingsPlacement = 'page'
      content.dataset.cordisxNoDrag = 'true'
      content.style.cssText = 'min-width:0;min-height:100%;box-sizing:border-box'
      content.style.setProperty('-webkit-app-region', 'no-drag')
      container.append(content)
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
      const collectionRoot = content.ownerDocument.createElement('div')
      collectionRoot.dataset.cordisxManagerCollectionRoot = 'true'
      const pageBody = content.ownerDocument.createElement('div')
      pageBody.dataset.cordisxManagerPageBody = 'true'
      content.append(collectionRoot, pageBody)
      const controls = new HostPageControls(content.ownerDocument, pageBody)
      effects.push(() => controls.dispose())
      const collection = mountManagerCollectionHost(collectionRoot, {
        document: content.ownerDocument,
        owner: page.owner,
        routeId: record.qualifiedId,
        pageId: page.qualifiedId,
        resolveText: (value, site) => this.i18n.resolveFor(page.owner, value, site).text,
        clearTextSite: site => this.i18n.clearDiagnosticSite(page.owner, site),
        navigate: async next => {
          assertKeys(next, ['id', 'params'], 'manager collection route reference')
          assertLocalId(next.id, 'manager collection route reference')
          const target = this.findRecord(page.owner, next.id)
          if (target === undefined || target.owner !== page.owner) throw new Error(`route ${next.id} is not available to plugin ${page.owner}`)
          const targetResolution = this.managerContentRoute(page.owner, next)
          if (targetResolution.state !== 'available' || targetResolution.resolved === undefined) throw new Error(targetResolution.detail ?? `route ${target.qualifiedId} is not available`)
          const routeDecision = this.access?.authorizeOutletRoute(page.owner, 'manager.content', target.qualifiedId, targetResolution.resolved.page.qualifiedId)
          const pageDecision = this.access?.authorizeOutletPage(page.owner, 'manager.content', target.qualifiedId, targetResolution.resolved.page.qualifiedId)
          if (routeDecision !== undefined && !routeDecision.authorized) throw new Error(routeDecision.reason ?? `route ${target.qualifiedId} is denied`)
          if (pageDecision !== undefined && !pageDecision.authorized) throw new Error(pageDecision.reason ?? `page ${targetResolution.resolved.page.qualifiedId} is denied`)
          await (managerNavigation ?? {
            navigate: candidate => this.navigate(page.owner, candidate),
            back: outlet => this.back(page.owner, outlet),
            close: outlet => this.close(page.owner, outlet),
          }).navigate(next)
        },
        deepLink: next => {
          assertKeys(next, ['id', 'params'], 'manager collection route reference')
          assertLocalId(next.id, 'manager collection route reference')
          const target = this.findRecord(page.owner, next.id)
          if (target === undefined || target.owner !== page.owner) throw new Error(`route ${next.id} is not available to plugin ${page.owner}`)
          const targetResolution = this.managerContentRoute(page.owner, next)
          if (targetResolution.state !== 'available' || targetResolution.resolved === undefined) throw new Error(targetResolution.detail ?? `route ${target.qualifiedId} is not available`)
          const routeDecision = this.access?.authorizeOutletRoute(page.owner, 'manager.content', target.qualifiedId, targetResolution.resolved.page.qualifiedId)
          const pageDecision = this.access?.authorizeOutletPage(page.owner, 'manager.content', target.qualifiedId, targetResolution.resolved.page.qualifiedId)
          if (routeDecision !== undefined && !routeDecision.authorized) throw new Error(routeDecision.reason ?? `route ${target.qualifiedId} is denied`)
          if (pageDecision !== undefined && !pageDecision.authorized) throw new Error(pageDecision.reason ?? `page ${targetResolution.resolved.page.qualifiedId} is denied`)
          const path = buildPath(target, next.params ?? {})
          return new URL(path, content.ownerDocument.location.href).href
        },
        executeCommand: async (actionId, command, invocationKey) => {
          if (this.commands === undefined || !this.commands.hasFor(page.owner, command, record.candidateView)) {
            throw new Error(`manager collection command ${command.id} is unavailable`)
          }
          const decision = this.access?.authorizeOutletPageCommand(
            page.owner,
            'manager.content',
            record.qualifiedId,
            page.qualifiedId,
            actionId,
            qualifyOwnedId(page.owner, command.id),
          )
          if (decision !== undefined && !decision.authorized) throw new Error(decision.reason ?? `manager collection command ${command.id} is denied`)
          return this.commands.executeFor(page.owner, command, invocationKey)
        },
        writeClipboard: async value => {
          const clipboard = content.ownerDocument.defaultView?.navigator.clipboard
          if (clipboard === undefined) throw new Error('clipboard is unavailable')
          await clipboard.writeText(value)
        },
        hostCopy: key => {
          const locale = this.i18n.getSnapshot().locale.toLowerCase().startsWith('zh') ? 'zh' : 'en'
          return MANAGER_COLLECTION_HOST_COPY[locale][key]
        },
      })
      effects.push(() => collection.dispose())
      effects.push(this.i18n.subscribeInternal(() => collection.registry.localeChanged()))
      const mount = {} as ManagedManagerPageMountRecord
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
        dispose: () => this.disposeManagedManagerMount(mount),
      })
      this.managerContentMount = mount
      try {
        const pageDispose = managerDeclaration?.config === undefined
          ? page.mount({
              container: pageBody,
              document: content.ownerDocument,
              signal: abortController.signal,
              routeId: record.qualifiedId,
              outlet: 'manager.content',
              params,
              navigation: managerNavigation ?? {
                navigate: next => this.navigate(page.owner, next),
                back: outlet => this.back(page.owner, outlet),
                close: outlet => this.close(page.owner, outlet),
              },
              controls,
              managerCollection: collection.registry,
              localeNamespace: localization.namespace,
              t: localization.t,
              localization,
            })
          : mountManagerContentConfigForm(
              pageBody,
              managerDeclaration.config,
              () => this.i18n.getSnapshot().locale,
              listener => this.i18n.subscribeInternal(listener),
            )
        if (typeof pageDispose === 'function') mount.pageDispose = pageDispose
        result = mount
        this.notify()
      } catch (error) {
        await this.disposeManagedManagerMount(mount)
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

  closeManagerContent(): Promise<void> {
    return this.enqueue(async () => {
      await this.unmountManagerContent()
      this.notify()
    })
  }

  navigate(requestingOwner: string, reference: CordisXRouteReference): Promise<void> {
    return this.enqueue(() => this.navigateNow(requestingOwner, reference))
  }

  deepLink(requestingOwner: string, reference: CordisXRouteReference): string {
    assertKeys(reference, ['id', 'params'], 'route reference')
    assertReference(reference.id, 'route reference')
    const record = this.findRecord(requestingOwner, reference.id)
    if (record === undefined || record.owner !== requestingOwner) {
      throw new Error(`route ${reference.id} is not available to plugin ${requestingOwner}`)
    }
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
    return this.history.deepLink(Object.freeze({
      schemaVersion: 1,
      owner: record.owner,
      routeId: record.qualifiedId,
      outlet: record.definition.outlet,
      path,
      params,
    }))
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
    const current = state?.current
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
        if (record !== undefined) await this.goBackOrClear(record.definition.outlet, true)
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
      if (state?.current?.record.owner !== requestingOwner) throw new Error(`plugin ${requestingOwner} has no open route`)
      await this.goBackOrClear(name, true)
      this.notify()
    })
  }

  close(requestingOwner: string, outlet?: CordisXOutletName): Promise<void> {
    return this.enqueue(async () => {
      const name = outlet ?? this.currentOutletFor(requestingOwner)
      if (name === undefined) return
      const state = this.states.get(name)
      if (state?.current?.record.owner !== requestingOwner) return
      await this.goBackOrClear(name, true)
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
      const managerMount = descriptor.id === 'manager.settings.content'
        ? this.managerSettingsMount
        : descriptor.id === 'manager.content' ? this.managerContentMount : undefined
      return {
        ...descriptor,
        ...host,
        ...(managerMount === undefined ? {} : { available: true }),
        mounted: state?.mount !== undefined || managerMount !== undefined,
        presentation: state?.mount === undefined && managerMount === undefined ? 'inactive' : state?.presentation ?? 'presented',
        ...(state?.suspendedBy === undefined ? {} : { suspendedBy: state.suspendedBy }),
        ...(managerMount !== undefined
          ? { activeRoute: managerMount.routeId }
          : state?.current === undefined ? {} : { activeRoute: state.current.record.qualifiedId }),
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
    this.unsubscribeManagerContent()
    this.unsubscribeHistory()
    await this.operation.catch(() => {})
    await this.unmountManagerSettings()
    await this.unmountManagerContent()
    for (const [name] of this.states) await this.closeNow(name)
    this.records.clear()
    this.managerContent.dispose()
    this.states.clear()
    this.presentationOrder = []
    this.listeners.clear()
    this.disconnectVisibility?.()
    this.history.dispose()
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
    if (this.managerContentMount !== undefined) await this.unmountManagerContent()
    if (this.historyProjectionStarted) await this.applyHistorySnapshot(this.history.snapshot())
  }

  private routeError(record: RouteRecord): string | undefined {
    const history = this.history.snapshot()
    if (!history.available) return history.reason ?? 'Codex session history is unavailable'
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
      && record.definition.outlet !== 'main'
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

  private async applyHistorySnapshot(snapshot: CodexRouteHistorySnapshot, returnFocus?: HTMLElement): Promise<void> {
    const projected = snapshot.entry
    if (!snapshot.available || projected === undefined) {
      for (const [name, state] of this.states) {
        if (state.current !== undefined || state.mount !== undefined) await this.closeNow(name)
      }
      this.notify()
      return
    }
    const record = this.visibleRecords().find(candidate => candidate.owner === projected.owner
      && candidate.qualifiedId === projected.routeId)
    if (record === undefined) {
      this.history.replace()
      await this.applyHistorySnapshot(this.history.snapshot())
      return
    }
    let path: string
    try {
      path = buildPath(record, projected.params)
    } catch {
      this.history.replace()
      await this.applyHistorySnapshot(this.history.snapshot())
      return
    }
    const routeAccess = this.access?.authorizeOutletRoute(
      record.owner,
      record.definition.outlet,
      record.qualifiedId,
      qualifyOwnedId(record.owner, record.definition.page),
      record.candidateView,
    )
    // A reload can restore an exact Host route before the explicit Playground
    // review authorization has settled. A pending review is not a grant: keep
    // the exact entry, mount nothing, and let the Host-owned policy
    // invalidation re-project it after the current owner/point policy settles.
    // All terminal denials remain fail-closed below.
    if (routeAccess?.authorized === false && routeAccess.reason === 'permission.review-pending') {
      const state = this.states.get(record.definition.outlet)
      if (state?.current !== undefined || state?.mount !== undefined) await this.closeNow(record.definition.outlet)
      this.notify()
      return
    }
    if (this.routeError(record) !== undefined
      || routeAccess?.authorized === false
      || projected.outlet !== record.definition.outlet
      || projected.path !== path) {
      this.history.replace()
      await this.applyHistorySnapshot(this.history.snapshot())
      return
    }
    for (const [name, state] of this.states) {
      if (name !== record.definition.outlet && (state.current !== undefined || state.mount !== undefined)) await this.closeNow(name)
    }
    const outlet = this.outlets.get(record.definition.outlet)!
    await outlet.controller.show()
    const host = outlet.controller.getSnapshot()
    const state = this.states.get(record.definition.outlet) ?? {}
    this.states.set(record.definition.outlet, state)
    const entry: RouteEntry = { record, params: projected.params, path }
    if (returnFocus !== undefined) state.returnFocus = returnFocus
    if (!host.available || host.container === undefined || host.contextKey === undefined) {
      await this.unmount(state)
      state.current = entry
      delete state.contextKey
      this.presentationOrder = this.presentationOrder.filter(name => name !== record.definition.outlet)
      this.notify()
      return
    }
    if (state.contextKey !== undefined && state.contextKey !== host.contextKey) {
      this.history.replace()
      await this.applyHistorySnapshot(this.history.snapshot())
      return
    }
    if (record.definition.outlet === 'session.content' && String(projected.params.sessionId) !== host.nativeSessionId) {
      this.history.replace()
      await this.applyHistorySnapshot(this.history.snapshot())
      return
    }
    const sameEntry = state.current?.record === record
      && state.current.path === path
      && sameRouteParams(state.current.params, projected.params)
    const sameMount = sameEntry
      && state.mount !== undefined
      && state.mount.contextKey === host.contextKey
    if (sameMount && state.mount!.content.parentElement !== host.container) host.container.append(state.mount!.content)
    state.current = entry
    state.contextKey = host.contextKey
    if (!sameMount) {
      await this.unmount(state)
      await this.mountCurrent(record.definition.outlet, state)
    }
    this.presentationOrder = this.presentationOrder.filter(name => name !== record.definition.outlet)
    this.presentationOrder.push(record.definition.outlet)
    await this.reconcilePresentation()
    this.notify()
  }

  private async goBackOrClear(name: string, restoreFocus: boolean): Promise<void> {
    const snapshot = this.history.snapshot()
    if (!snapshot.available) throw new Error(snapshot.reason)
    const focus = restoreFocus ? this.states.get(name)?.returnFocus : undefined
    if ((snapshot.index ?? 0) > 0) {
      const next = await this.history.go(-1)
      await this.applyHistorySnapshot(next)
      if (next.entry === undefined && focus?.isConnected === true && !focus.matches(':disabled')) focus.focus()
      return
    }
    const next = this.history.replace()
    await this.applyHistorySnapshot(next)
    if (focus?.isConnected === true && !focus.matches(':disabled')) focus.focus()
  }

  private async navigateNow(requestingOwner: string, reference: CordisXRouteReference, returnFocus?: HTMLElement): Promise<void> {
    this.historyProjectionStarted = true
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
    const historySnapshot = this.history.snapshot()
    if (!historySnapshot.available) throw new Error(historySnapshot.reason)
    const outletRecord = this.outlets.get(record.definition.outlet)!
    await outletRecord.controller.show()
    const host = outletRecord.controller.getSnapshot()
    if (!host.available || host.container === undefined || host.contextKey === undefined) {
      throw new Error(`outlet ${record.definition.outlet} is unavailable${host.error === undefined ? '' : `: ${host.error}`}`)
    }
    if (record.definition.outlet === 'session.content' && String(params.sessionId) !== host.nativeSessionId) {
      throw new Error(`session route ${record.qualifiedId} does not match native session ${host.nativeSessionId ?? '<none>'}`)
    }
    const next = this.history.push(Object.freeze({
      schemaVersion: 1,
      owner: record.owner,
      routeId: record.qualifiedId,
      outlet: record.definition.outlet,
      path,
      params,
    }))
    await this.applyHistorySnapshot(next, returnFocus)
  }

  private async mountCurrent(name: string, state: OutletNavigationState): Promise<void> {
    const entry = state.current
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
      if ((this.history.snapshot().index ?? 0) > 0) {
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
      // Manager owns the modal close affordance. A manager.content page may expose
      // Back in its Host shell, but must not create a second adjacent close button.
      if (name !== 'manager.content') {
        const close = pageChromeButton(content.ownerDocument, 'Close', 'host:close')
        close.addEventListener('click', () => { void this.close(page.owner, name as CordisXOutletName) })
        chrome.append(close)
      }
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
      } else if (bodyOnly) {
        const titleSite = `page:${page.qualifiedId}:body.accessible-title`
        localization.effect(() => {
          content.setAttribute('aria-label', this.i18n.resolveFor(page.owner, page.metadata.title, titleSite).text)
          return () => this.i18n.clearDiagnosticSite(page.owner, titleSite)
        })
      }
      const body = content.ownerDocument.createElement('div')
      body.dataset.cordisxPageBody = 'true'
      body.style.cssText = `position:relative;flex:1;min-height:0;overflow:${bodyOnly ? 'hidden' : 'auto'}`
      content.append(body)
      const controls = new HostPageControls(content.ownerDocument, content)
      effects.push(() => controls.dispose())
      const context: CordisXPageMountContext = {
        container: body,
        document: content.ownerDocument,
        signal: abort.signal,
        routeId: entry.record.qualifiedId,
        routeDefinitionId: entry.record.definition.id,
        outlet: name as CordisXOutletName,
        params: entry.params,
        navigation: {
          navigate: reference => this.navigate(page.owner, reference),
          back: outletName => this.back(page.owner, outletName),
          close: outletName => this.close(page.owner, outletName),
        },
        controls,
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
      delete state.current
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
      .find(name => this.states.get(name)?.current?.record.owner === owner) as CordisXOutletName | undefined
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
    const managerContent = this.managerContentMount
    if (managerContent !== undefined) {
      const current = this.visibleRecords().find(record => record.qualifiedId === managerContent.routeId)
      const resolution = current === undefined
        ? { state: 'pending' as const }
        : this.managerSettingsNavigationRoute(managerContent.owner, current.definition.id)
      const retentionAccess = this.access?.authorizeOutletPage(
        managerContent.owner,
        'manager.content',
        managerContent.routeId,
        managerContent.pageId,
      )
      if (current === undefined || resolution.state !== 'available'
        || this.pages.get(managerContent.owner, managerContent.page.metadata.id) === undefined
        || (retentionAccess !== undefined && !retentionAccess.authorized)) {
        await this.unmountManagerContent()
      }
    }
    if (this.historyProjectionStarted) await this.applyHistorySnapshot(this.history.snapshot())
    await this.reconcilePresentation()
    this.notify()
  }

  private async reconcilePresentation(): Promise<void> {
    const active = new Set([...this.states.entries()]
      .filter(([, state]) => state.mount !== undefined && state.current !== undefined)
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

  private async disposeManagedManagerMount(mount: ManagedManagerPageMountRecord): Promise<void> {
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
    if (this.managerContentMount === mount) this.managerContentMount = undefined
    if (failure !== undefined) throw failure
  }

  private async unmountManagerContent(): Promise<void> {
    const mount = this.managerContentMount
    if (mount === undefined) return
    await this.disposeManagedManagerMount(mount)
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

  constructor(ctx: Context, options: { readonly history: CodexRouteHistoryAdapter; readonly console?: PluginConsoleAspect }) {
    super(ctx, 'routes')
    this.console = options.console
    const pages = ctx.pages as CordisXPageService
    const i18n = ctx.i18n as CordisXI18nService
    const commands = ctx.commands as CordisXCommandService
    if (pages?.registry === undefined || i18n === undefined || commands === undefined) {
      throw new Error('CordisX routes require pages, i18n, and commands services')
    }
    this.registry = new NavigationRegistry(pages.registry, this.outlets, i18n, options.history, this.contexts, undefined, commands)
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

  /** Host-internal projection used by structured navigation collection actions. */
  deepLinkFor(owner: string, reference: CordisXRouteReference): string {
    return this.registry.deepLink(owner, reference)
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

  managerContentPresentationFor(owner: string, reference: CordisXRouteReference): ManagerContentPresentation | undefined {
    return this.registry.managerContentPresentation(owner, reference)
  }

  managerContentAgentDefinitionTarget(identity: AgentDefinitionIdentity): ManagerContentAgentDefinitionTarget | undefined {
    return this.registry.managerContentAgentDefinitionTarget(identity)
  }

  setManagerContentConfigFactory(factory: Parameters<NavigationRegistry['setManagerContentConfigFactory']>[0]): void {
    this.registry.setManagerContentConfigFactory(factory)
  }

  mountManagerSettingsFor(
    owner: string,
    reference: CordisXRouteReference,
    contributionId: string,
    panelBody: HTMLElement,
  ): Promise<ManagedSettingsPageMount> {
    return this.registry.mountManagerSettings(owner, reference, contributionId, panelBody)
  }

  mountManagerContentFor(
    owner: string,
    reference: CordisXRouteReference,
    contributionId: string,
    container: HTMLElement,
    managerNavigation?: CordisXPageNavigation,
  ): Promise<ManagedManagerPageMount> {
    return this.registry.mountManagerContent(owner, reference, contributionId, container, managerNavigation)
  }

  closeManagerSettings(): Promise<void> {
    return this.registry.closeManagerSettings()
  }

  closeManagerContent(): Promise<void> {
    return this.registry.closeManagerContent()
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

  /** Host-only exact owner lookup for Agent Session permission admission. */
  agentRuntimeRoutesForOwner(
    owner: AgentRuntimeNavigationOwner,
    view?: PluginGenerationView,
  ): readonly AgentRuntimeNavigationRoute[] {
    return this.registry.agentRuntimeRoutesForOwner(owner, view)
  }

  /** Host-only history-to-owner resolution; no source identity is plugin-controlled. */
  agentRuntimeRouteFromHistory(entry: CodexRouteHistoryEntry): ResolvedAgentRuntimeNavigationRoute | undefined {
    return this.registry.agentRuntimeRouteFromHistory(entry)
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

/** Exposes only versioned Manager-content data declarations to plugin fibers. */
export class CordisXManagerContentNavigationService extends Service implements CordisXManagerContentNavigation {
  static readonly inject = ['routes']

  constructor(ctx: Context) {
    super(ctx, 'managerContent')
    if ((ctx.routes as CordisXRouteService | undefined)?.registry === undefined) {
      throw new Error('CordisX manager content navigation requires the route service')
    }
  }

  register(declaration: CordisXManagerContentNavigationDeclarationV1): Disposable<void | Promise<void>>
  register(declaration: CordisXManagerContentNavigationDeclarationV2): Disposable<void | Promise<void>>
  register(declaration: CordisXManagerContentNavigationDeclarationV3): Disposable<void | Promise<void>>
  register(declaration: CordisXManagerContentNavigationDeclarationV4): Disposable<void | Promise<void>>
  register(declaration: CordisXManagerContentNavigationDeclarationV5): Disposable<void | Promise<void>>
  register(
    declaration:
      | CordisXManagerContentNavigationDeclarationV1
      | CordisXManagerContentNavigationDeclarationV2
      | CordisXManagerContentNavigationDeclarationV3
      | CordisXManagerContentNavigationDeclarationV4
      | CordisXManagerContentNavigationDeclarationV5,
  ): Disposable<void | Promise<void>> {
    const routes = this.ctx.routes as CordisXRouteService
    return this.ctx.effect(
      () => routes.registry.managerContent.register(this.ctx, declaration),
      `managerContent.register(${JSON.stringify(declaration.id)})`,
    )
  }

  registerRecordTitles(records: readonly CordisXManagerContentRecordTitleV1[]): ReturnType<CordisXManagerContentNavigation['registerRecordTitles']> {
    const routes = this.ctx.routes as CordisXRouteService
    return this.ctx.effect(
      () => routes.registry.managerContent.registerRecordTitles(this.ctx, records),
      'managerContent.registerRecordTitles',
    )
  }

  replaceProjection(projection: import('../contracts.js').CordisXManagerContentNavigationProjectionV1): ReturnType<CordisXManagerContentNavigation['replaceProjection']>
  replaceProjection(projection: import('../contracts.js').CordisXManagerContentNavigationCatalogProjectionV2): ReturnType<CordisXManagerContentNavigation['replaceProjection']>
  replaceProjection(projection: import('../contracts.js').CordisXManagerContentNavigationCatalogProjectionV3): ReturnType<CordisXManagerContentNavigation['replaceProjection']>
  replaceProjection(projection: import('../contracts.js').CordisXManagerContentNavigationCatalogProjectionV4): ReturnType<CordisXManagerContentNavigation['replaceProjection']>
  replaceProjection(projection:
    | import('../contracts.js').CordisXManagerContentNavigationProjectionV1
    | import('../contracts.js').CordisXManagerContentNavigationCatalogProjectionV2
    | import('../contracts.js').CordisXManagerContentNavigationCatalogProjectionV3
    | import('../contracts.js').CordisXManagerContentNavigationCatalogProjectionV4,
  ): ReturnType<CordisXManagerContentNavigation['replaceProjection']> {
    const routes = this.ctx.routes as CordisXRouteService
    return this.ctx.effect(
      () => routes.registry.managerContent.replaceProjection(this.ctx, projection),
      'managerContent.replaceProjection',
    )
  }
}
