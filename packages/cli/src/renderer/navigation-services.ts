import type { RouteLinkResolutionResult } from '@cordisx/protocol/route-link-resolution/v1'
import { publicNavigationCallerActive } from './public-navigation-caller.js'
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
import {
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

import { OutletRegistry, type OutletSnapshot } from './navigation-outlets.js'
import {
  type ManagedManagerPageMount,
  type ManagedSettingsPageMount,
  type NavigationMetadataDiagnostic,
  type NavigationPageSnapshot,
  type NavigationProductMetadata,
  type PageComposerAdapterFactory,
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
import type {
  ManagerSettingsNavigationRouteResolution,
  ManagerSettingsRouteResolution,
  PageSnapshot,
} from './navigation-pages.js'

import { NavigationRegistry } from './navigation-registry.js'
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
      : context =>
        this.console!.runInPluginContext(
          token,
          { trigger: { kind: 'registration', registrationId: `page:${owner}:${metadata.id}` } },
          () => mount(context),
        ) as ReturnType<CordisXPageMount<Messages>>
    const register = (): ReturnType<CordisXPages['register']> =>
      this.ctx.effect(
        () => this.registry.register(this.ctx, metadata, scopedMount),
        `pages.register(${JSON.stringify(metadata.id)})`,
      )
    return token === undefined || this.console === undefined
      ? register()
      : this.console.runSync(token, 'pages.register', metadata, register)
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

  constructor(
    ctx: Context,
    options: {
      readonly history: CodexRouteHistoryAdapter
      readonly console?: PluginConsoleAspect
      readonly pageAdmissionBindings?: PageAdmissionBindingRegistry
    },
  ) {
    super(ctx, 'routes')
    this.console = options.console
    const pages = ctx.pages as CordisXPageService
    const i18n = ctx.i18n as CordisXI18nService
    const commands = ctx.commands as CordisXCommandService
    if (pages?.registry === undefined || i18n === undefined || commands === undefined) {
      throw new Error('CordisX routes require pages, i18n, and commands services')
    }
    this.registry = new NavigationRegistry(
      pages.registry,
      this.outlets,
      i18n,
      options.history,
      this.contexts,
      undefined,
      commands,
      options.pageAdmissionBindings,
    )
    ctx.effect(() => async () => {
      await this.registry.dispose()
      this.outlets.dispose()
      this.contexts.dispose()
    }, 'cordisx: route and outlet registries')
  }

  register(definition: CordisXRouteDefinition): ReturnType<CordisXRoutes['register']> {
    const token = this.console?.tokenFromContext(this.ctx)
    const register = (): ReturnType<CordisXRoutes['register']> =>
      this.ctx.effect(
        () => this.registry.register(this.ctx, definition),
        `routes.register(${JSON.stringify(definition.id)})`,
      )
    return token === undefined || this.console === undefined
      ? register()
      : this.console.runSync(token, 'routes.register', definition, register)
  }

  navigate(reference: CordisXRouteReference): Promise<void> {
    const token = this.console?.tokenFromContext(this.ctx)
    if (token === undefined || this.console === undefined) {
      return this.registry.navigate(ownerFromContext(this.ctx), reference)
    }
    const owner = this.console.owner(token)
    return this.console.run(token, 'routes.navigate', reference, async invocation => {
      invocation.dispatch('Dispatched to Host navigation registry')
      await this.registry.navigate(owner.id, reference)
    })
  }

  async resolveLink(reference: CordisXRouteReference): Promise<RouteLinkResolutionResult> {
    return this.registry.resolveLink(
      ownerFromContext(this.ctx),
      reference,
      () => publicNavigationCallerActive(this.ctx, this.console),
    )
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

  managerContentPresentationFor(
    owner: string,
    reference: CordisXRouteReference,
  ): ManagerContentPresentation | undefined {
    return this.registry.managerContentPresentation(owner, reference)
  }

  managerContentAgentDefinitionTarget(
    identity: AgentDefinitionIdentity,
  ): ManagerContentAgentDefinitionTarget | undefined {
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

  registerRecordTitles(
    records: readonly CordisXManagerContentRecordTitleV1[],
  ): ReturnType<CordisXManagerContentNavigation['registerRecordTitles']> {
    const routes = this.ctx.routes as CordisXRouteService
    return this.ctx.effect(
      () => routes.registry.managerContent.registerRecordTitles(this.ctx, records),
      'managerContent.registerRecordTitles',
    )
  }

  replaceProjection(
    projection: import('../contracts.js').CordisXManagerContentNavigationProjectionV1,
  ): ReturnType<CordisXManagerContentNavigation['replaceProjection']>
  replaceProjection(
    projection: import('../contracts.js').CordisXManagerContentNavigationCatalogProjectionV2,
  ): ReturnType<CordisXManagerContentNavigation['replaceProjection']>
  replaceProjection(
    projection: import('../contracts.js').CordisXManagerContentNavigationCatalogProjectionV3,
  ): ReturnType<CordisXManagerContentNavigation['replaceProjection']>
  replaceProjection(
    projection: import('../contracts.js').CordisXManagerContentNavigationCatalogProjectionV4,
  ): ReturnType<CordisXManagerContentNavigation['replaceProjection']>
  replaceProjection(
    projection:
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
