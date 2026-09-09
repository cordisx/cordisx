import { Context, type Disposable, Service } from '@deepseek-ai/cordis'
import { type AgentAvatarRef, cloneAgentAvatarRef } from '@cordisx/protocol/agent-avatar/v1'
import type { AgentDefinitionIdentity } from '@cordisx/protocol/agents/v1'
import type { AgentPageComposerCommandAdapter } from '@cordisx/protocol/agent-page-admission/v2'
import {
  CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V1,
  CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V2,
  CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V3,
  CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V4,
  CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V5,
  CORDISX_PAGE_SCHEMA_V1,
  CORDISX_PAGE_SCHEMA_V2,
  CORDISX_PAGE_SCHEMA_V3,
  CORDISX_ROUTE_SCHEMA_V1,
  CORDISX_ROUTE_SCHEMA_V2,
} from '../contracts.js'
import type {
  CordisXIconToken,
  CordisXJsonScalar,
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
import type { ManagerContentConfigBindingHandle } from './manager-content-config.js'
import { mountManagerContentConfigForm } from './manager-content-config-form.js'
import type { CordisXCommandService } from './commands.js'
import { CordisXI18nService, type LocalizationEffectOwner } from './i18n.js'
import type { ExtensionPointAccessResolver } from './extension-points.js'
import { createHostSurfaceIcon } from './icons.js'
import { isAgentConversationPageMount, markAgentConversationPageMount } from './agent-conversation-page.js'
import { ownerFromContext, qualifyOwnedId, sourceFromContext } from './ownership.js'
import {
  type GenerationVisibilityCoordinator,
  generationVisibilityFromContext,
  type PluginGenerationEffectIdentity,
  type PluginGenerationView,
} from './generation-visibility.js'
import {
  type PageAdmissionBinding,
  PageAdmissionBindingRegistry,
  type PageAdmissionRoute,
} from './page-admission-lifecycle.js'
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
  assertLocalId,
  assertLocalizedText,
  assertReference,
  assertWhenExpression,
  evaluateWhen,
  HostContextStore,
  ICON_TOKEN_PATTERN,
  immutableSnapshot,
  whenContextKeys,
} from './validation.js'

export const ROUTE_PATH_PATTERN = /^\/(?:[a-z0-9._~-]+|:[a-z][a-zA-Z0-9]*)(?:\/(?:[a-z0-9._~-]+|:[a-z][a-zA-Z0-9]*))*$/

export const MANAGER_COLLECTION_HOST_COPY = {
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

export function assertKeys(value: object, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find(key => !allowed.includes(key))
  if (unknown !== undefined) throw new Error(`${label} has unknown field ${unknown}`)
}

export function assertPageMetadataVersion(metadata: CordisXPageMetadata): void {
  const hasSchema = metadata.$schema !== undefined
  const hasVersion = metadata.schemaVersion !== undefined
  if (!hasSchema && !hasVersion) {
    if (metadata.description !== undefined) {
      throw new Error('legacy page metadata cannot declare description; use page.v3')
    }
    return
  }
  if (!hasSchema || !hasVersion) throw new Error('page metadata requires a complete $schema/schemaVersion tuple')
  if (metadata.schemaVersion === 1 && metadata.$schema === CORDISX_PAGE_SCHEMA_V1) {
    if (metadata.description !== undefined || metadata.chrome !== undefined) {
      throw new Error('page.v1 cannot declare description or chrome')
    }
    return
  }
  if (metadata.schemaVersion === 2 && metadata.$schema === CORDISX_PAGE_SCHEMA_V2) {
    if (metadata.description !== undefined) throw new Error('page.v2 cannot declare description')
    return
  }
  if (metadata.schemaVersion === 3 && metadata.$schema === CORDISX_PAGE_SCHEMA_V3) {
    if (metadata.description === undefined) throw new Error('page.v3 requires localized description metadata')
    if (metadata.localeNamespace !== undefined) {
      throw new Error('page.v3 uses owner-default i18n and cannot declare localeNamespace')
    }
    return
  }
  throw new Error('page metadata has an unsupported $schema/schemaVersion tuple')
}

export function assertRouteDefinitionVersion(definition: CordisXRouteDefinition): void {
  const hasSchema = definition.$schema !== undefined
  const hasVersion = definition.schemaVersion !== undefined
  if (!hasSchema && !hasVersion) {
    if (definition.description !== undefined) {
      throw new Error('legacy route definition cannot declare description; use route.v2')
    }
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

export interface PageRecord {
  readonly owner: string
  readonly qualifiedId: string
  readonly generation: PluginGenerationEffectIdentity
  readonly candidateView?: PluginGenerationView
  readonly metadata: CordisXPageMetadata
  readonly mount: CordisXPageMount<any>
  readonly presentation?: 'agent-conversation'
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

/** Host-private factory for a public adapter bound to one currently mounted page. */
export interface PageComposerAdapterFactory {
  create(input: {
    readonly owner: string
    readonly source?: string
    readonly moduleGeneration: string
    readonly binding: PageAdmissionBinding
    readonly route: PageAdmissionRoute
    readonly signal: AbortSignal
  }): AgentPageComposerCommandAdapter | undefined
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
  if (action.command === null || typeof action.command !== 'object') {
    throw new Error(`${label} requires a command reference`)
  }
  assertKeys(action.command, ['id', 'arguments'], `${label} command`)
  assertReference(action.command.id, `${label} command id`)
  assertWhenExpression(action.when)
  if (action.disabled !== undefined) {
    assertKeys(action.disabled, ['value', 'reason'], `${label} disabled state`)
    if (typeof action.disabled.value !== 'boolean') throw new Error(`${label} disabled.value must be a boolean`)
    if (action.disabled.reason !== undefined) assertLocalizedText(action.disabled.reason, `${label} disabled reason`)
  }
}

export function pageChromeButton(document: Document, ariaLabel: string, icon: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute('aria-label', ariaLabel)
  button.dataset.cordisxNoDrag = 'true'
  button.style.setProperty('-webkit-app-region', 'no-drag')
  const Button = document.defaultView?.HTMLButtonElement
  const template = [...document.querySelectorAll('header[data-app-shell-application-menu-bar] button')]
    .find((candidate): candidate is HTMLButtonElement =>
      Button !== undefined
      && candidate instanceof Button
      && candidate.closest('[data-cordisx-page-outlet]') === null
    )
  if (template !== undefined) {
    button.className = template.className
  } else {
    Object.assign(button.style, {
      width: '30px',
      height: '30px',
      border: '1px solid transparent',
      borderRadius: '8px',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
      padding: '5px',
    })
  }
  button.classList.add('cordisx-page-chrome-action')
  button.append(createHostSurfaceIcon(document, icon))
  return button
}

export const STANDARD_PAGE_CLIP_PATH =
  'polygon(var(--cordisx-page-chrome-safe-left, 0px) 0, 100% 0, 100% 100%, 0 100%, 0 46px, var(--cordisx-page-chrome-safe-left, 0px) 46px)'

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
    assertKeys(metadata, [
      '$schema',
      'schemaVersion',
      'id',
      'title',
      'description',
      'icon',
      'chrome',
      'breadcrumbs',
      'tabs',
      'headerActions',
      'localeNamespace',
    ], 'page metadata')
    assertPageMetadataVersion(metadata)
    assertLocalId(metadata.id, 'page id')
    assertLocalizedText(metadata.title, 'page title')
    if (metadata.description !== undefined) assertLocalizedText(metadata.description, 'page description')
    assertHostIcon(metadata.icon, 'page')
    if (metadata.chrome !== undefined && !['standard', 'body-only'].includes(metadata.chrome)) {
      throw new Error(`page ${metadata.id} chrome policy is invalid`)
    }
    if (
      metadata.chrome === 'body-only'
      && (metadata.breadcrumbs !== undefined || metadata.tabs !== undefined || metadata.headerActions !== undefined)
    ) {
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
    const agentConversation = isAgentConversationPageMount(mount)
    if (
      agentConversation
      && (metadata.breadcrumbs !== undefined || metadata.tabs !== undefined || metadata.headerActions !== undefined)
    ) {
      throw new Error(`agent conversation page ${metadata.id} cannot declare breadcrumbs, tabs, or header actions`)
    }
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
      ...(agentConversation ? { presentation: 'agent-conversation' as const } : {}),
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
    const record = [...this.records.values()].find(item =>
      item.qualifiedId === qualifiedId
      && (this.visibility?.visible(item.generation, view) ?? true)
    )
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
