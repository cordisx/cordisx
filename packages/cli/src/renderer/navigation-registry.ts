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
import { assertKeys, MANAGER_COLLECTION_HOST_COPY } from './navigation-pages.js'

import { NavigationRegistryRouting } from './navigation-registry-routing.js'

export class NavigationRegistry extends NavigationRegistryRouting {
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
      if (record === undefined || record.owner !== requestingOwner) {
        throw new Error(`route ${reference.id} is not available to plugin ${requestingOwner}`)
      }
      const resolution = this.managerContentRoute(requestingOwner, reference)
      if (resolution.state !== 'available') {
        throw new Error(resolution.detail ?? `route ${record.qualifiedId} is not available`)
      }
      const managerDeclaration = this.managerContent.resolve(requestingOwner, reference, record.candidateView)
      const page = this.pages.get(record.owner, record.definition.page, record.candidateView)!
      const surfaceAccess = this.access?.authorizeSurfaceRoute(
        requestingOwner,
        'manager.settings.navigation-items',
        contributionId,
        record.qualifiedId,
      )
      if (surfaceAccess !== undefined && !surfaceAccess.authorized) {
        throw new Error(surfaceAccess.reason ?? 'manager.settings.navigation-items is denied')
      }
      const routeAccess = this.access?.authorizeOutletRoute(
        requestingOwner,
        'manager.content',
        record.qualifiedId,
        page.qualifiedId,
      )
      if (routeAccess !== undefined && !routeAccess.authorized) {
        throw new Error(routeAccess.reason ?? 'manager.content is denied')
      }
      const pageAccess = this.access?.authorizeOutletPage(
        requestingOwner,
        'manager.content',
        record.qualifiedId,
        page.qualifiedId,
      )
      if (pageAccess !== undefined && !pageAccess.authorized) {
        throw new Error(pageAccess.reason ?? 'manager.content is denied')
      }
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
          if (target === undefined || target.owner !== page.owner) {
            throw new Error(`route ${next.id} is not available to plugin ${page.owner}`)
          }
          const targetResolution = this.managerContentRoute(page.owner, next)
          if (targetResolution.state !== 'available' || targetResolution.resolved === undefined) {
            throw new Error(targetResolution.detail ?? `route ${target.qualifiedId} is not available`)
          }
          const routeDecision = this.access?.authorizeOutletRoute(
            page.owner,
            'manager.content',
            target.qualifiedId,
            targetResolution.resolved.page.qualifiedId,
          )
          const pageDecision = this.access?.authorizeOutletPage(
            page.owner,
            'manager.content',
            target.qualifiedId,
            targetResolution.resolved.page.qualifiedId,
          )
          if (routeDecision !== undefined && !routeDecision.authorized) {
            throw new Error(routeDecision.reason ?? `route ${target.qualifiedId} is denied`)
          }
          if (pageDecision !== undefined && !pageDecision.authorized) {
            throw new Error(pageDecision.reason ?? `page ${targetResolution.resolved.page.qualifiedId} is denied`)
          }
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
          if (target === undefined || target.owner !== page.owner) {
            throw new Error(`route ${next.id} is not available to plugin ${page.owner}`)
          }
          const targetResolution = this.managerContentRoute(page.owner, next)
          if (targetResolution.state !== 'available' || targetResolution.resolved === undefined) {
            throw new Error(targetResolution.detail ?? `route ${target.qualifiedId} is not available`)
          }
          const routeDecision = this.access?.authorizeOutletRoute(
            page.owner,
            'manager.content',
            target.qualifiedId,
            targetResolution.resolved.page.qualifiedId,
          )
          const pageDecision = this.access?.authorizeOutletPage(
            page.owner,
            'manager.content',
            target.qualifiedId,
            targetResolution.resolved.page.qualifiedId,
          )
          if (routeDecision !== undefined && !routeDecision.authorized) {
            throw new Error(routeDecision.reason ?? `route ${target.qualifiedId} is denied`)
          }
          if (pageDecision !== undefined && !pageDecision.authorized) {
            throw new Error(pageDecision.reason ?? `page ${targetResolution.resolved.page.qualifiedId} is denied`)
          }
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
          if (decision !== undefined && !decision.authorized) {
            throw new Error(decision.reason ?? `manager collection command ${command.id} is denied`)
          }
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
        reference: structuredClone(reference),
        ready: false,
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
        mount.ready = true
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

  private managerNavigator: ((owner: string, reference: CordisXRouteReference) => void) | undefined
  setManagerNavigator(navigate: (owner: string, reference: CordisXRouteReference) => void): void {
    this.managerNavigator = navigate
  }
  navigate(requestingOwner: string, reference: CordisXRouteReference): Promise<void> {
    try {
      if (this.disposed) throw new Error('Navigation registry is disposed')
      assertKeys(reference, ['id', 'params'], 'route reference')
      assertReference(reference.id, 'route reference')
    } catch (error) {
      return Promise.reject(error)
    }
    const record = this.findRecord(requestingOwner, reference.id)
    if (record?.owner === requestingOwner && record.definition.outlet === 'manager.content' && this.managerNavigator) {
      const resolution = this.managerContentRoute(requestingOwner, reference)
      if (resolution.state !== 'available') {
        return Promise.reject(new Error(resolution.detail ?? 'Manager route unavailable'))
      }
      // Manager mounting uses the registry queue; wait outside it to avoid deadlock.
      return new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer)
          unsubscribe()
          error ? reject(error) : resolve()
        }
        const check = () => {
          const mount = this.managerContentMount
          if (
            mount?.ready && !mount.disposed && mount.route === record && mount.content.isConnected
            && sameRouteParams(mount.reference.params ?? {}, reference.params ?? {})
          ) finish()
          else if (this.disposed || this.findRecord(requestingOwner, reference.id) !== record) {
            finish(new Error('Manager navigation was retired'))
          }
        }
        const unsubscribe = this.subscribe(check)
        const timer = setTimeout(() => finish(new Error('Manager content did not become ready')), 5_000)
        try {
          this.managerNavigator!(requestingOwner, reference)
          check()
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
        }
      })
    }

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
      throw new Error(
        routeAccess.reason ?? `extension point ${record.definition.outlet} is denied for plugin ${requestingOwner}`,
      )
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
      return Promise.reject(
        new Error(decision.reason ?? `extension point ${pointId} is denied for plugin ${requestingOwner}`),
      )
    }
    return this.enqueue(() => this.navigateNow(requestingOwner, reference, returnFocus))
  }

  routeProjection(requestingOwner: string, reference: CordisXRouteReference): RouteProjection {
    const record = this.findRecord(requestingOwner, reference.id)
    if (record === undefined || record.owner !== requestingOwner || this.routeError(record) !== undefined) {
      return { active: false, presented: false }
    }
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
      if (state?.current?.record.owner !== requestingOwner) {
        throw new Error(`plugin ${requestingOwner} has no open route`)
      }
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

  match(
    outlet: string,
    path: string,
  ): { readonly routeId: string; readonly params: Readonly<Record<string, string>> } | undefined {
    const matches = this.visibleRecords()
      .filter(record =>
        record.definition.outlet === outlet
        && this.routeError(record) === undefined
        && (this.access?.decision(record.owner, outlet, 'outlet').authorized ?? true)
      )
      .map(record => ({ record, params: matchPath(record, path) }))
      .filter((item): item is { record: RouteRecord; params: Readonly<Record<string, string>> } =>
        item.params !== undefined
      )
    if (matches.length !== 1) return undefined
    return { routeId: matches[0]!.record.qualifiedId, params: matches[0]!.params }
  }

  snapshot(view?: PluginGenerationView): NavigationSnapshot {
    const nextMetadataProjectionSites = new Map<string, string>()
    const routes = this.visibleRecords(view).map((record): RouteSnapshot => {
      const error = this.routeError(record)
      const pointAccess =
        this.access?.decision(record.owner, record.definition.outlet, 'outlet', view ?? record.candidateView)
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
        : descriptor.id === 'manager.content'
        ? this.managerContentMount
        : undefined
      return {
        ...descriptor,
        ...host,
        ...(managerMount === undefined ? {} : { available: true }),
        mounted: state?.mount !== undefined || managerMount !== undefined,
        presentation: state?.mount === undefined && managerMount === undefined
          ? 'inactive'
          : state?.presentation ?? 'presented',
        ...(state?.suspendedBy === undefined ? {} : { suspendedBy: state.suspendedBy }),
        ...(managerMount !== undefined
          ? { activeRoute: managerMount.routeId }
          : state?.current === undefined
          ? {}
          : { activeRoute: state.current.record.qualifiedId }),
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
    this.pageAdmissionBindings.dispose()
    this.states.clear()
    this.presentationOrder = []
    this.listeners.clear()
    this.disconnectVisibility?.()
    this.history.dispose()
    for (const [site, owner] of this.metadataProjectionSites) this.i18n.clearDiagnosticSite(owner, site)
    this.metadataProjectionSites.clear()
  }
}
