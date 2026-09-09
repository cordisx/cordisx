import { resolveRouteLink } from './route-link-resolution.js'
import type { RouteLinkResolutionResult } from '@cordisx/protocol/route-link-resolution/v1'
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
import { assertKeys, pageChromeButton, STANDARD_PAGE_CLIP_PATH } from './navigation-pages.js'
import type { ManagerSettingsNavigationRouteResolution, ManagerSettingsRouteResolution } from './navigation-pages.js'

export class NavigationRegistryBase {
  protected readonly records = new Map<string, RouteRecord>()
  protected readonly states = new Map<string, OutletNavigationState>()
  protected readonly listeners = new Set<() => void>()
  readonly managerContent: ManagerContentNavigationRegistry
  /** Host-protected page mount lifecycle; no plugin receives this registry directly. */
  /** Host-protected page mount lifecycle; no plugin receives this registry directly. */
  readonly pageAdmissionBindings: PageAdmissionBindingRegistry
  protected pageComposerAdapterFactory: PageComposerAdapterFactory | undefined
  protected metadataProjectionSites = new Map<string, string>()
  protected presentationOrder: string[] = []
  protected managerSettingsMount: ManagedSettingsPageMountRecord | undefined
  protected managerContentMount: ManagedManagerPageMountRecord | undefined
  protected readonly unsubscribePages: () => void
  protected readonly unsubscribeOutlets: () => void
  protected readonly unsubscribeManagerContent: () => void
  protected readonly unsubscribeHistory: () => void
  protected operation = Promise.resolve()
  protected disposed = false
  protected historyProjectionStarted = false
  protected readonly disconnectVisibility: (() => void) | undefined

  constructor(
    protected readonly pages: PageRegistry,
    protected readonly outlets: OutletRegistry,
    protected readonly i18n: CordisXI18nService,
    protected readonly history: CodexRouteHistoryAdapter,
    readonly contexts: HostContextStore = new HostContextStore(),
    protected access?: ExtensionPointAccessResolver,
    protected readonly commands?: Pick<CordisXCommandService, 'hasFor' | 'executeFor' | 'subscribeInternal'>,
    pageAdmissionBindings: PageAdmissionBindingRegistry = new PageAdmissionBindingRegistry(),
  ) {
    this.pageAdmissionBindings = pageAdmissionBindings
    this.managerContent = new ManagerContentNavigationRegistry(pages.visibility)
    this.unsubscribePages = pages.subscribe(() => {
      void this.enqueue(() => this.reconcileDependencies())
    })
    this.unsubscribeOutlets = outlets.subscribe(() => {
      void this.enqueue(() => this.reconcileDependencies())
    })
    this.unsubscribeManagerContent = this.managerContent.subscribe(() => this.notify())
    this.unsubscribeHistory = history.subscribe(() => {
      if (this.historyProjectionStarted) void this.enqueue(() => this.applyHistorySnapshot(history.snapshot()))
    })
    this.disconnectVisibility = pages.visibility?.connect({
      notify: () => {
        void this.enqueue(() => this.reconcileGeneration())
      },
    })
  }

  /** Begin reverse projection only after Host outlets and plugin routes are registered. */

  protected projectProductMetadata(
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

  protected enqueue(action: () => void | Promise<void>): Promise<void> {
    const result = this.operation.then(async () => {
      if (this.disposed) throw new Error('CordisX navigation registry is disposed')
      await action()
    })
    this.operation = result.catch(() => {})
    return result
  }

  protected visibleRecords(view?: PluginGenerationView): RouteRecord[] {
    return [...this.records.values()].filter(record => this.pages.visibility?.visible(record.generation, view) ?? true)
  }

  protected findRecord(owner: string, id: string, view?: PluginGenerationView): RouteRecord | undefined {
    const qualifiedId = qualifyOwnedId(owner, id)
    return this.visibleRecords(view).find(record => record.qualifiedId === qualifiedId && record.owner === owner)
  }

  protected async reconcileGeneration(): Promise<void> {
    if (this.managerSettingsMount !== undefined) await this.unmountManagerSettings()
    if (this.managerContentMount !== undefined) await this.unmountManagerContent()
    if (this.historyProjectionStarted) await this.applyHistorySnapshot(this.history.snapshot())
  }

  protected routeError(record: RouteRecord): string | undefined {
    const history = this.history.snapshot()
    if (!history.available) return history.reason ?? 'Codex session history is unavailable'
    const view = record.candidateView
    const conflict = this.visibleRecords(view).find(other =>
      other !== record
      && other.definition.outlet === record.definition.outlet
      && other.definition.path === record.definition.path
    )
    if (conflict !== undefined) return `route path conflicts with ${conflict.qualifiedId}`
    if (this.outlets.get(record.definition.outlet) === undefined) {
      return `outlet ${record.definition.outlet} is not declared by the host adapter`
    }
    if (!this.outlets.get(record.definition.outlet)!.validatePath(record.definition.path)) {
      return `route path ${record.definition.path} is incompatible with outlet ${record.definition.outlet}`
    }
    const page = this.pages.get(record.owner, record.definition.page, view)
    if (page === undefined) return `page ${record.definition.page} is not registered by plugin ${record.owner}`
    if (page.presentation === 'agent-conversation' && record.definition.outlet !== 'main') {
      return `agent conversation page ${page.qualifiedId} requires the main outlet`
    }
    if (record.definition.outlet === 'manager.content') {
      if (
        record.definition.path === '/manager/extensions'
        || record.definition.path === '/manager/extensions/'
        || !record.definition.path.startsWith('/manager/extensions/')
      ) {
        return `route path ${record.definition.path} must be strictly below /manager/extensions/`
      }
      if (record.definition.page.includes(':')) return `page ${record.definition.page} must be a same-owner local page`
      if (
        record.definition.schemaVersion !== 2
        || record.definition.title === undefined
        || record.definition.description === undefined
      ) {
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
      page.presentation !== 'agent-conversation'
      && page.metadata.chrome === 'body-only'
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

  protected async applyHistorySnapshot(snapshot: CodexRouteHistorySnapshot, returnFocus?: HTMLElement): Promise<void> {
    const projected = snapshot.entry
    if (!snapshot.available || projected === undefined) {
      for (const [name, state] of this.states) {
        if (state.current !== undefined || state.mount !== undefined) await this.closeNow(name)
      }
      this.notify()
      return
    }
    const record = this.visibleRecords().find(candidate =>
      candidate.owner === projected.owner
      && candidate.qualifiedId === projected.routeId
    )
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
    if (
      this.routeError(record) !== undefined
      || routeAccess?.authorized === false
      || projected.outlet !== record.definition.outlet
      || projected.path !== path
    ) {
      this.history.replace()
      await this.applyHistorySnapshot(this.history.snapshot())
      return
    }
    for (const [name, state] of this.states) {
      if (name !== record.definition.outlet && (state.current !== undefined || state.mount !== undefined)) {
        await this.closeNow(name)
      }
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

  protected async goBackOrClear(name: string, restoreFocus: boolean): Promise<void> {
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

  async resolveLink(
    requestingOwner: string,
    reference: CordisXRouteReference,
    active: () => boolean = () => true,
  ): Promise<RouteLinkResolutionResult> {
    return resolveRouteLink(reference, {
      disposed: this.disposed,
      active,
      deepLink: () => this.deepLink(requestingOwner, reference),
    })
  }

  protected async navigateNow(
    requestingOwner: string,
    reference: CordisXRouteReference,
    returnFocus?: HTMLElement,
  ): Promise<void> {
    this.historyProjectionStarted = true
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
      throw new Error(
        routeAccess.reason ?? `extension point ${record.definition.outlet} is denied for plugin ${requestingOwner}`,
      )
    }
    const params = immutableSnapshot(reference.params ?? {})
    const path = buildPath(record, params)
    const historySnapshot = this.history.snapshot()
    if (!historySnapshot.available) throw new Error(historySnapshot.reason)
    const outletRecord = this.outlets.get(record.definition.outlet)!
    await outletRecord.controller.show()
    const host = outletRecord.controller.getSnapshot()
    if (!host.available || host.container === undefined || host.contextKey === undefined) {
      throw new Error(
        `outlet ${record.definition.outlet} is unavailable${host.error === undefined ? '' : `: ${host.error}`}`,
      )
    }
    if (record.definition.outlet === 'session.content' && String(params.sessionId) !== host.nativeSessionId) {
      throw new Error(
        `session route ${record.qualifiedId} does not match native session ${host.nativeSessionId ?? '<none>'}`,
      )
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

  protected async mountCurrent(name: string, state: OutletNavigationState): Promise<void> {
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
      state.error = pageAccess.reason
        ?? `extension point ${entry.record.definition.outlet} is denied for plugin ${entry.record.owner}`
      await this.closeNow(name)
      return
    }
    const content = host.container.ownerDocument.createElement('section')
    content.dataset.cordisxPage = page.qualifiedId
    content.dataset.cordisxRoute = entry.record.qualifiedId
    Object.assign(content.style, {
      position: 'absolute',
      inset: '0',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      background: 'var(--color-background-surface-under, #141414)',
      color: 'var(--color-text, #dfdfdf)',
      font: '13px/1.45 ui-sans-serif, system-ui, sans-serif',
      pointerEvents: 'auto',
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
    const pageAdmissionBinding = this.pageAdmissionBindings.mount({
      owner: page.owner,
      ...(entry.record.source === undefined ? {} : { source: entry.record.source }),
      moduleGeneration: page.generation.moduleGeneration ?? 'host',
      connectionGeneration: 'renderer',
      route: {
        outlet: name,
        routeDefinitionId: entry.record.definition.id,
        ...(typeof entry.params.roomId === 'string' ? { roomId: entry.params.roomId } : {}),
      },
      signal: abort.signal,
    })
    const pageComposer = this.pageComposerAdapterFactory?.create({
      owner: page.owner,
      ...(entry.record.source === undefined ? {} : { source: entry.record.source }),
      moduleGeneration: page.generation.moduleGeneration ?? 'host',
      binding: pageAdmissionBinding,
      route: {
        outlet: name,
        routeDefinitionId: entry.record.definition.id,
        ...(typeof entry.params.roomId === 'string' ? { roomId: entry.params.roomId } : {}),
      },
      signal: abort.signal,
    })
    const mount: MountedPage = {
      entry,
      contextKey: host.contextKey,
      content,
      abort,
      pageAdmissionBinding,
      effects,
    }
    state.mount = mount
    delete state.error
    try {
      // A future page-admission route claim must finish at this Host-only
      // activation boundary, before the page body mounts and before the
      // navigation promise that led here can resolve.
      await this.pageAdmissionBindings.activate(pageAdmissionBinding)
      const agentConversation = page.presentation === 'agent-conversation'
      const bodyOnly = page.metadata.chrome === 'body-only'
      content.dataset.cordisxPageChromePolicy = agentConversation
        ? 'agent-conversation'
        : bodyOnly
        ? 'body-only'
        : 'standard'
      if (!bodyOnly && !agentConversation) {
        // Keep native titlebar controls visible and reachable when the app outlet starts at x=0.
        content.style.clipPath = STANDARD_PAGE_CLIP_PATH
        const chrome = content.ownerDocument.createElement('header')
        chrome.dataset.cordisxPageChrome = 'true'
        chrome.dataset.cordisxDrag = 'true'
        Object.assign(chrome.style, {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          minHeight: '46px',
          padding: '0 12px',
          borderBottom: '1px solid var(--color-border, rgba(255,255,255,.084))',
          background: 'var(--color-background-surface, #181818)',
          flex: '0 0 auto',
        })
        chrome.style.paddingLeft = 'max(12px, var(--cordisx-page-chrome-safe-left, 0px))'
        chrome.style.setProperty('-webkit-app-region', 'drag')
        const leading = content.ownerDocument.createElement('div')
        leading.dataset.cordisxPageLeading = 'true'
        leading.style.cssText =
          'display:flex;width:28px;height:28px;flex:0 0 28px;align-items:center;justify-content:center'
        if ((this.history.snapshot().index ?? 0) > 0) {
          const back = pageChromeButton(content.ownerDocument, 'Back', 'host:back')
          back.addEventListener('click', () => {
            void this.back(page.owner, name as CordisXOutletName)
          })
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
            button.dataset.cordisxTooltip = action.disabled?.value === true && disabledReason !== undefined
              ? disabledReason
              : accessible
            return () => {
              this.i18n.clearDiagnosticSite(page.owner, labelSite)
              this.i18n.clearDiagnosticSite(page.owner, disabledSite)
            }
          })
          const refresh = (): void => {
            button.hidden = !evaluateWhen(action.when, this.contexts.getSnapshot())
            button.disabled = action.disabled?.value === true
              || !(this.commands?.hasFor(page.owner, action.command) ?? false)
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
          close.addEventListener('click', () => {
            void this.close(page.owner, name as CordisXOutletName)
          })
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
          tabs.style.cssText =
            'display:flex;gap:4px;padding:7px 12px;border-bottom:1px solid rgba(255,255,255,.08);flex:0 0 auto'
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
      } else if (bodyOnly && !agentConversation) {
        const titleSite = `page:${page.qualifiedId}:body.accessible-title`
        localization.effect(() => {
          content.setAttribute('aria-label', this.i18n.resolveFor(page.owner, page.metadata.title, titleSite).text)
          return () => this.i18n.clearDiagnosticSite(page.owner, titleSite)
        })
      }
      const body = content.ownerDocument.createElement('div')
      body.dataset.cordisxPageBody = 'true'
      body.style.cssText = `position:relative;flex:1;min-height:0;overflow:${
        agentConversation || bodyOnly ? 'hidden' : 'auto'
      }`
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
          resolveLink: reference =>
            this.resolveLink(page.owner, reference, () =>
              !abort.signal.aborted && !this.disposed
              && (this.pages.visibility?.visible(entry.record.generation) ?? true)),
          navigate: reference => this.navigate(page.owner, reference),
          back: outletName => this.back(page.owner, outletName),
          close: outletName => this.close(page.owner, outletName),
        },
        ...(pageComposer === undefined ? {} : { pageComposer }),
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

  protected async unmount(state: OutletNavigationState): Promise<void> {
    const mount = state.mount
    if (mount === undefined) return
    delete state.mount
    this.pageAdmissionBindings.release(mount.pageAdmissionBinding)
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

  protected async closeNow(name: string, restoreFocus = false): Promise<void> {
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

  protected currentOutletFor(owner: string): CordisXOutletName | undefined {
    return [...this.presentationOrder].reverse()
      .find(name => this.states.get(name)?.current?.record.owner === owner) as CordisXOutletName | undefined
  }

  protected async reconcileDependencies(): Promise<void> {
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
      if (
        current === undefined || resolution.state !== 'available'
        || this.pages.get(managed.owner, managed.page.metadata.id) === undefined
        || (retentionAccess !== undefined && !retentionAccess.authorized)
      ) {
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
      if (
        current === undefined || resolution.state !== 'available'
        || this.pages.get(managerContent.owner, managerContent.page.metadata.id) === undefined
        || (retentionAccess !== undefined && !retentionAccess.authorized)
      ) {
        await this.unmountManagerContent()
      }
    }
    if (this.historyProjectionStarted) await this.applyHistorySnapshot(this.history.snapshot())
    await this.reconcilePresentation()
    this.notify()
  }

  protected async reconcilePresentation(): Promise<void> {
    const active = new Set(
      [...this.states.entries()]
        .filter(([, state]) => state.mount !== undefined && state.current !== undefined)
        .map(([name]) => name),
    )
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
      if (
        focused instanceof state.mount.content.ownerDocument.defaultView!.HTMLElement
        && state.mount.content.contains(focused)
      ) focused.blur()
      state.mount.content.inert = true
      state.mount.content.setAttribute('aria-hidden', 'true')
      state.mount.content.dataset.cordisxPresentation = 'suspended'
      state.presentation = 'suspended'
      state.suspendedBy = winner
      await outlet.controller.hide()
    }
  }

  protected notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // One observer cannot split a published visibility epoch.
      }
    }
  }

  protected async disposeManagedSettingsMount(mount: ManagedSettingsPageMountRecord): Promise<void> {
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

  protected async unmountManagerSettings(): Promise<void> {
    const mount = this.managerSettingsMount
    if (mount === undefined) return
    await this.disposeManagedSettingsMount(mount)
  }

  protected async disposeManagedManagerMount(mount: ManagedManagerPageMountRecord): Promise<void> {
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

  protected async unmountManagerContent(): Promise<void> {
    const mount = this.managerContentMount
    if (mount === undefined) return
    await this.disposeManagedManagerMount(mount)
  }
}

export interface NavigationRegistryBase {
  deepLink(requestingOwner: string, reference: CordisXRouteReference): string
  managerSettingsRoute(
    requestingOwner: string,
    id: string,
    view?: PluginGenerationView,
  ): ManagerSettingsRouteResolution
  managerSettingsNavigationRoute(
    requestingOwner: string,
    id: string,
    view?: PluginGenerationView,
  ): ManagerSettingsNavigationRouteResolution
  navigate(requestingOwner: string, reference: CordisXRouteReference): Promise<void>
  back(requestingOwner: string, outlet?: CordisXOutletName): Promise<void>
  close(requestingOwner: string, outlet?: CordisXOutletName): Promise<void>
}
