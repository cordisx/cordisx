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

import type { OutletRegistry, OutletSnapshot } from './navigation-outlets.js'
import type {
  ManagedManagerPageMount,
  ManagedSettingsPageMount,
  NavigationMetadataDiagnostic,
  NavigationPageSnapshot,
  NavigationProductMetadata,
  PageComposerAdapterFactory,
  PageRegistry,
} from './navigation-pages.js'
import {
  type ManagerContentAgentDefinitionTarget,
  ManagerContentNavigationRegistry,
  type ManagerContentPresentation,
} from './manager-content-navigation.js'
import type {
  AgentRuntimeNavigationOwner,
  ManagedManagerPageMountRecord,
  ManagedSettingsPageMountRecord,
  MountedPage,
  NavigationSnapshot,
  OutletNavigationState,
  ResolvedAgentRuntimeNavigationRoute,
  RouteEntry,
  RouteProjection,
  RouteRecord,
  RouteSnapshot,
} from './navigation-model.js'
import { buildPath, matchPath, routeParameters, sameRouteParams } from './navigation-model.js'
import type { AgentRuntimeNavigationRoute } from './navigation-model.js'
import { sameReference, sameStructuredValue } from './manager-content-navigation.js'
import {
  assertKeys,
  assertRouteDefinitionVersion,
  type ManagerSettingsNavigationRouteResolution,
  type ManagerSettingsRouteResolution,
  ROUTE_PATH_PATTERN,
} from './navigation-pages.js'

import { NavigationRegistryBase } from './navigation-registry-base.js'

export abstract class NavigationRegistryRouting extends NavigationRegistryBase {
  startHistoryProjection(): Promise<void> {
    this.historyProjectionStarted = true
    return this.enqueue(() => this.applyHistorySnapshot(this.history.snapshot()))
  }

  /** Install once by the Host runtime after Agent admission services are ready. */
  setPageComposerAdapterFactory(factory: PageComposerAdapterFactory): void {
    if (this.pageComposerAdapterFactory !== undefined) {
      throw new Error('page composer adapter factory is already installed')
    }
    this.pageComposerAdapterFactory = factory
  }

  managerContentPresentation(
    owner: string,
    reference: CordisXRouteReference,
  ): ManagerContentPresentation | undefined {
    const declaration = this.managerContent.resolve(owner, reference)
    if (declaration === undefined) return undefined
    const record = this.findRecord(owner, reference.id)
    if (record === undefined || record.definition.outlet !== 'manager.content') return undefined
    try {
      buildPath(record, reference.params ?? {})
    } catch {
      return undefined
    }
    const page = this.pages.get(owner, record.definition.page, record.candidateView)
    if (page === undefined) return undefined
    const text = (value: CordisXLocalizedText, site: string): string => (
      this.i18n.resolveFor(owner, value, site).text ?? value.fallback ?? value.key
    )
    const header = declaration.declaration.header.title
    const title = header.kind === 'record'
      ? text(
        this.managerContent.title(owner, String(reference.params?.[header.recordIdParam]), declaration.candidateView)
          ?? header.fallback,
        `manager-content:${owner}:${declaration.declaration.id}:record`,
      )
      : text(page.metadata.title, `manager-content:${owner}:${declaration.declaration.id}:title`)
    const description = text(
      page.metadata.description ?? record.definition.description ?? record.definition.title ?? page.metadata.title,
      `manager-content:${owner}:${declaration.declaration.id}:description`,
    )
    const relatedDeclarations = this.managerContent.declarationsFor(owner, declaration.candidateView).filter(
      candidate => (
        sameReference(candidate.declaration.route, reference)
        || (declaration.declaration.tabs ?? []).some(tab => sameReference(tab.route, candidate.declaration.route))
        || (candidate.declaration.tabs ?? []).some(tab => sameReference(tab.route, reference))
      ),
    )
    const summarySources = relatedDeclarations.flatMap(candidate => (
      candidate.declaration.schemaVersion >= 3
        && (candidate.declaration as
            | CordisXManagerContentNavigationDeclarationV3
            | CordisXManagerContentNavigationDeclarationV4
            | CordisXManagerContentNavigationDeclarationV5).recordSummary !== undefined
        ? [
          (candidate.declaration as
            | CordisXManagerContentNavigationDeclarationV3
            | CordisXManagerContentNavigationDeclarationV4
            | CordisXManagerContentNavigationDeclarationV5).recordSummary!,
        ]
        : []
    ))
    if (summarySources.length > 1 && summarySources.some(summary => !sameStructuredValue(summarySources[0], summary))) {
      return undefined
    }
    const summarySource = summarySources[0] === undefined
      ? undefined
      : immutableSnapshot(summarySources[0]) as ManagerContentRecordSummaryProjectionV2
    const recordSummary = summarySource === undefined ? undefined : Object.freeze({
      leadingVisual: summarySource.leadingVisual,
      title: text(summarySource.title, `manager-content:${owner}:${declaration.declaration.id}:summary:title`),
      ...(summarySource.description === undefined ? {} : {
        description: text(
          summarySource.description,
          `manager-content:${owner}:${declaration.declaration.id}:summary:description`,
        ),
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
      if (
        targetTabs.length > 0 && targetTabs.filter(candidate => sameReference(candidate.route, tab.route)).length !== 1
      ) return []
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
        route: Object.freeze({
          id: tab.route.id,
          ...(tab.route.params === undefined ? {} : { params: immutableSnapshot(tab.route.params) }),
        }),
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

  managerContentAgentDefinitionTarget(
    identity: AgentDefinitionIdentity,
  ): ManagerContentAgentDefinitionTarget | undefined {
    const target = this.managerContent.resolveAgentDefinitionSubject(identity)
    if (target === undefined) return undefined
    if (this.managerContentRoute(target.owner, target.route).state !== 'available') return undefined
    if (target.parent !== undefined && this.managerContentRoute(target.owner, target.parent).state !== 'available') {
      return undefined
    }
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
    assertKeys(
      definition,
      ['$schema', 'schemaVersion', 'id', 'path', 'outlet', 'page', 'title', 'description', 'when'],
      'route definition',
    )
    assertRouteDefinitionVersion(definition)
    assertLocalId(definition.id, 'route id')
    if (definition.path.length > 512 || !ROUTE_PATH_PATTERN.test(definition.path)) {
      throw new Error(`invalid route path: ${definition.path}`)
    }
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
    return Object.freeze(
      this.visibleRecords(view)
        .filter(record =>
          record.owner === owner.pluginId
          && record.source === owner.source
          && record.generation.moduleGeneration === owner.moduleGeneration
        )
        .map(record =>
          Object.freeze({
            id: record.definition.id,
            path: record.definition.path,
            ...(record.definition.schemaVersion === undefined
              ? {}
              : { schemaVersion: record.definition.schemaVersion }),
          })
        ),
    )
  }

  /** Resolves a persisted Host history entry back to its exact source owner. */
  agentRuntimeRouteFromHistory(
    entry: CodexRouteHistoryEntry,
    view?: PluginGenerationView,
  ): ResolvedAgentRuntimeNavigationRoute | undefined {
    const matches = this.visibleRecords(view).filter(record => {
      if (
        record.owner !== entry.owner || record.qualifiedId !== entry.routeId
        || record.source === undefined || record.generation.moduleGeneration === undefined
      ) return false
      try {
        return buildPath(record, entry.params) === entry.path
      } catch {
        return false
      }
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

  managerSettingsRoute(
    requestingOwner: string,
    id: string,
    view?: PluginGenerationView,
  ): ManagerSettingsRouteResolution {
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
      return {
        state: 'invalid',
        detail: `route path ${record.definition.path} is incompatible with manager.settings.content`,
      }
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
    if (page === undefined) {
      return { state: 'pending', detail: `page ${record.definition.page} is not registered by plugin ${record.owner}` }
    }
    if (page.metadata.chrome !== 'body-only') {
      return { state: 'invalid', detail: `page ${page.qualifiedId} must use body-only chrome` }
    }
    const values = this.contexts.getSnapshot()
    const unknownKey = whenContextKeys(record.definition.when).find(key => !Object.hasOwn(values, key))
    if (unknownKey !== undefined) {
      return { state: 'invalid', detail: `when context key ${unknownKey} is not declared by the host adapter` }
    }
    if (!evaluateWhen(record.definition.when, values)) {
      return { state: 'pending', detail: 'route when condition is not satisfied' }
    }
    const outletAccess = this.access?.decision(
      record.owner,
      'manager.settings.content',
      'outlet',
      view ?? record.candidateView,
    )
    if (outletAccess !== undefined && !outletAccess.authorized) {
      return {
        state: 'invalid',
        detail: outletAccess.reason ?? `extension point manager.settings.content is denied for plugin ${record.owner}`,
      }
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
    if (
      record.definition.path === '/manager/extensions' || record.definition.path === '/manager/extensions/'
      || !record.definition.path.startsWith('/manager/extensions/')
    ) {
      return { state: 'invalid', detail: `route ${record.qualifiedId} must be strictly below /manager/extensions/` }
    }
    if (record.definition.page.includes(':')) {
      return { state: 'invalid', detail: `route ${record.qualifiedId} must reference a same-owner local page` }
    }
    if (
      record.definition.schemaVersion !== 2
      || record.definition.title === undefined
      || record.definition.description === undefined
    ) {
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
      return {
        state: 'invalid',
        detail: outletAccess.reason ?? `extension point manager.content is denied for plugin ${record.owner}`,
      }
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
      if (record === undefined || record.owner !== requestingOwner) {
        throw new Error(`route ${reference.id} is not available to plugin ${requestingOwner}`)
      }
      const resolution = this.managerSettingsRoute(requestingOwner, reference.id)
      if (resolution.state !== 'available') {
        throw new Error(resolution.detail ?? `route ${record.qualifiedId} is not available`)
      }
      const page = this.pages.get(record.owner, record.definition.page, record.candidateView)!
      const surfaceAccess = this.access?.authorizeSurfaceRoute(
        requestingOwner,
        'manager.settings.tabs',
        contributionId,
        record.qualifiedId,
      )
      if (surfaceAccess !== undefined && !surfaceAccess.authorized) {
        throw new Error(surfaceAccess.reason ?? 'manager.settings.tabs is denied')
      }
      const routeAccess = this.access?.authorizeOutletRoute(
        requestingOwner,
        'manager.settings.content',
        record.qualifiedId,
        page.qualifiedId,
      )
      if (routeAccess !== undefined && !routeAccess.authorized) {
        throw new Error(routeAccess.reason ?? 'manager.settings.content is denied')
      }
      const pageAccess = this.access?.authorizeOutletPage(
        requestingOwner,
        'manager.settings.content',
        record.qualifiedId,
        page.qualifiedId,
      )
      if (pageAccess !== undefined && !pageAccess.authorized) {
        throw new Error(pageAccess.reason ?? 'manager.settings.content is denied')
      }
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
}
