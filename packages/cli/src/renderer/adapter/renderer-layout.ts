import { projectSidebarDisclosure } from './sidebar-disclosure.js'
import {
  projectSidebarGroupAppearance,
  resolveSidebarCollectionsSeat,
  type SidebarCollectionsSeat,
} from './sidebar-collections.js'
import { projectSidebarAppearance } from './sidebar-appearance.js'
import { StructuredSurfaceInteractions } from './renderer-interactions.js'
import {
  currentSessionId,
  nativeButtons,
  nativeControlInsertionAnchor,
  nextNativeSibling,
  resolveAccountControl,
  resolveComposerSubmitSeat,
  resolveEnvironmentSeat,
  resolveOpenNativeMenu,
  resolveSessionHeaderSeat,
  resolveSidebarFooterControl,
  resolveSidebarNavigationParent,
  resolveToolbarControl,
  resolveToolbarMenuControl,
  strictlyVisible,
  uniqueVisible,
} from './dom.js'
import { REASONING_CONTROL_POINT, ReasoningIntensityProjection, resolveReasoningIntensityRange } from './reasoning.js'
import type {
  CordisXExtensionPointControlMode,
  CordisXReasoningIntensityPresentation,
  CordisXSessionBackdropPresentation,
} from '../../contracts.js'
import { SessionBackdropProjection } from './backdrop.js'

class StructuredSurfaceRenderer extends StructuredSurfaceInteractions {
  protected render(rebuild: boolean): void {
    const nextSites = new Set<string>()
    if (!rebuild) { for (const site of this.sites) nextSites.add(site) }
    const usedRoots = new Set<string>()
    const availableSurfaces = new Set<string>()
    const playground = this.adapterIdentity.mode === 'playground'
    const managerOverlay = [...this.document.querySelectorAll<HTMLElement>('[data-cordisx-manager-modal]')]
      .some(element => !element.hidden)
    const sidebar = managerOverlay || playground
      ? undefined
      : uniqueVisible(this.document, '[data-app-action-sidebar-scroll]')
    const toolbar = managerOverlay || playground
      ? undefined
      : uniqueVisible(this.document, 'header[data-app-shell-application-menu-bar]')
    const environmentCandidates = managerOverlay || playground ? [] : [
      ...this.document.querySelectorAll<HTMLElement>(
        '[data-pip-home-surface="thread-summary-panel"][data-pip-obstacle="thread-summary-panel"][aria-hidden="true"]',
      ),
    ].filter(strictlyVisible)
    const environmentSeat = managerOverlay || playground ? undefined : resolveEnvironmentSeat(this.document)
    this.reconcileEnvironmentRetry(environmentCandidates.length > 0 && environmentSeat === undefined)
    const sidebarNavigation = managerOverlay ? undefined : playground
      ? this.playgroundSurface('sidebar.navigation.items')
      : sidebar === undefined
      ? undefined
      : resolveSidebarNavigationParent(this.document, sidebar)
    const sidebarFooterControl = managerOverlay ? undefined : playground
      ? this.playgroundTemplate('sidebar.footer')
      : sidebar === undefined
      ? undefined
      : resolveSidebarFooterControl(this.document, sidebar)
    const accountControl = sidebar === undefined ? undefined : resolveAccountControl(sidebar)
    const toolbarControl = managerOverlay ? undefined : playground
      ? this.playgroundTemplate('workspace.toolbar')
      : toolbar === undefined
      ? undefined
      : resolveToolbarControl(toolbar)
    const toolbarMenuControl = playground || toolbar === undefined ? undefined : resolveToolbarMenuControl(toolbar)
    const fixtureSessionId = this.document.querySelector<HTMLElement>('[data-cordisx-playground-session-id]')?.dataset
      .cordisxPlaygroundSessionId
    const sessionId = managerOverlay ? undefined : playground ? fixtureSessionId : currentSessionId(this.document)
    const sessionHeaderSeat = playground
      ? sessionId === undefined
        ? undefined
        : this.playgroundActionSeat(
          'session.header.actions',
          'session.header',
          'session.header.actions',
          'cordisx-session-header-actions',
        )
      : resolveSessionHeaderSeat(this.document, sessionId)
    const composerSubmitSeat = playground
      ? sessionId === undefined
        ? undefined
        : this.playgroundActionSeat(
          'composer.toolbar.items',
          'composer.toolbar',
          'composer.submit.before',
          'cordisx-composer-submit-before',
        )
      : resolveComposerSubmitSeat(this.document, sessionId)
    const reasoningRange = managerOverlay ? undefined : playground
      ? sessionId === undefined
        ? undefined
        : this.document.querySelector<HTMLInputElement>('input[data-cordisx-playground-reasoning]') ?? undefined
      : resolveReasoningIntensityRange(this.document, sessionId)
    const transientCanvasAvailable = this.transientCanvas?.available() === true
    this.controlBindingUpdate = true
    try {
      this.reasoningControl.update(reasoningRange)
      this.transientCanvas?.updateSubmitButton(transientCanvasAvailable ? composerSubmitSeat?.template : undefined)
    } finally {
      this.controlBindingUpdate = false
    }
    const contextValues = {
      'sidebar.visible': sidebarNavigation !== undefined || sidebarFooterControl !== undefined,
      'toolbar.visible': toolbarControl !== undefined,
      'environment.visible': environmentSeat !== undefined,
      ...(sessionId === undefined ? {} : { 'session.active': sessionId }),
    }
    this.slots.contexts.replace(contextValues)
    this.routes.contexts.replace(contextValues)
    this.slots.registry.setToolbarAnchors(toolbarControl === undefined ? [] : ['workspace.primary'])
    this.slots.registry.setSurfaceAnchors(
      'composer.toolbar.items',
      composerSubmitSeat === undefined ? [] : [{ id: 'submit', placements: ['before'] }],
    )
    const contextDetail = (key: string, fallback: string) => ({ key: `runtime-context.${key}`, fallback })
    const sessionContextState = sessionId === undefined ? 'not-mounted' as const : 'inactive' as const
    const shellContextState = managerOverlay ? 'not-mounted' as const : 'inactive' as const
    const shellContextCode = managerOverlay ? 'context.not-mounted' : 'anchor.unresolved'
    const shellDetail = (key: string, label: string) =>
      managerOverlay
        ? contextDetail(`${key}.not-mounted`, `The ${label} context is not mounted while CordisX Manager is open.`)
        : contextDetail(`${key}.unresolved`, `The ${label} anchor could not be resolved uniquely.`)
    const environmentState = environmentSeat !== undefined
      ? 'active' as const
      : environmentCandidates.length > 0
      ? 'inactive' as const
      : 'not-mounted' as const
    this.slots.registry.setCurrentContext([
      {
        surface: 'sidebar.navigation.items',
        state: sidebarNavigation === undefined ? shellContextState : 'active',
        ...(sidebarNavigation === undefined
          ? { code: shellContextCode, detail: shellDetail('sidebar-navigation', 'sidebar navigation') }
          : {}),
      },
      {
        surface: 'sidebar.footer.before-control',
        state: sidebarFooterControl === undefined ? shellContextState : 'active',
        ...(sidebarFooterControl === undefined
          ? { code: shellContextCode, detail: shellDetail('sidebar-footer', 'sidebar footer') }
          : {}),
      },
      {
        surface: 'sidebar.footer.after-control',
        state: sidebarFooterControl === undefined ? shellContextState : 'active',
        ...(sidebarFooterControl === undefined
          ? { code: shellContextCode, detail: shellDetail('sidebar-footer', 'sidebar footer') }
          : {}),
      },
      {
        surface: 'sidebar.footer.menu',
        state: sidebarFooterControl === undefined ? shellContextState : 'active',
        ...(sidebarFooterControl === undefined
          ? { code: shellContextCode, detail: shellDetail('sidebar-footer-menu', 'sidebar footer menu') }
          : {}),
      },
      {
        surface: 'sidebar.account.menu',
        state: accountControl === undefined ? shellContextState : 'active',
        ...(accountControl === undefined
          ? { code: shellContextCode, detail: shellDetail('account-menu', 'account menu') }
          : {}),
      },
      {
        surface: 'workspace.toolbar.items',
        state: toolbarControl === undefined ? shellContextState : 'active',
        ...(toolbarControl === undefined
          ? { code: shellContextCode, detail: shellDetail('workspace-toolbar', 'workspace toolbar') }
          : {}),
      },
      {
        surface: 'session.header.actions',
        state: sessionHeaderSeat === undefined ? sessionContextState : 'active',
        ...(sessionHeaderSeat === undefined
          ? {
            code: sessionId === undefined ? 'session.not-mounted' : 'anchor.unresolved',
            detail: contextDetail(
              sessionId === undefined ? 'session-header.not-mounted' : 'session-header.unresolved',
              sessionId === undefined
                ? 'The session header is not mounted in the current page.'
                : 'The active session header anchor could not be resolved uniquely.',
            ),
          }
          : {}),
      },
      {
        surface: 'composer.toolbar.items',
        state: composerSubmitSeat === undefined ? sessionContextState : 'active',
        ...(composerSubmitSeat === undefined
          ? {
            code: sessionId === undefined ? 'session.not-mounted' : 'anchor.unresolved',
            detail: contextDetail(
              sessionId === undefined ? 'composer.not-mounted' : 'composer.unresolved',
              sessionId === undefined
                ? 'The composer is not mounted in the current page.'
                : 'The active session composer anchor could not be resolved uniquely.',
            ),
          }
          : {}),
        anchors: [
          {
            id: 'submit',
            placements: ['before'],
            state: composerSubmitSeat === undefined ? sessionContextState : 'active',
            ...(composerSubmitSeat === undefined
              ? {
                code: sessionId === undefined ? 'session.not-mounted' : 'anchor.unresolved',
                detail: contextDetail(
                  sessionId === undefined ? 'composer-submit.not-mounted' : 'composer-submit.unresolved',
                  sessionId === undefined
                    ? 'The native submit control is not mounted in the current context.'
                    : 'The native submit anchor could not be resolved uniquely.',
                ),
              }
              : {}),
          },
          {
            id: 'leading',
            placements: ['before', 'after'],
            state: 'not-mounted',
            code: 'anchor.not-mounted',
            detail: contextDetail('composer-leading.not-mounted', 'The leading anchor is not mounted by this adapter.'),
          },
          {
            id: 'model',
            placements: ['before', 'after', 'menu'],
            state: 'not-mounted',
            code: 'anchor.not-mounted',
            detail: contextDetail('composer-model.not-mounted', 'The model anchor is not mounted by this adapter.'),
          },
        ],
      },
      {
        surface: 'composer.reasoning-intensity',
        state: reasoningRange === undefined ? sessionContextState : 'active',
        ...(reasoningRange === undefined
          ? {
            code: sessionId === undefined ? 'session.not-mounted' : 'anchor.unresolved',
            detail: contextDetail(
              sessionId === undefined ? 'reasoning-intensity.not-mounted' : 'reasoning-intensity.unresolved',
              sessionId === undefined
                ? 'The native reasoning control is not mounted in the current page.'
                : 'The native reasoning range could not be resolved uniquely.',
            ),
          }
          : {}),
      },
      {
        surface: 'composer.submit.effects',
        state: !transientCanvasAvailable
          ? 'inactive'
          : composerSubmitSeat === undefined
          ? sessionContextState
          : 'active',
        ...(!transientCanvasAvailable
          ? {
            code: 'canvas.unsupported',
            detail: contextDetail(
              'composer-effects.unsupported',
              'Isolated OffscreenCanvas presentation is unavailable in this renderer.',
            ),
          }
          : composerSubmitSeat === undefined
          ? {
            code: sessionId === undefined ? 'session.not-mounted' : 'anchor.unresolved',
            detail: contextDetail(
              sessionId === undefined ? 'composer-effects.not-mounted' : 'composer-effects.unresolved',
              sessionId === undefined
                ? 'The composer is not mounted in the current page.'
                : 'The native submit control could not be resolved uniquely.',
            ),
          }
          : {}),
      },
      {
        surface: 'session.backdrop',
        state: sessionId === undefined ? 'not-mounted' : 'active',
        ...(sessionId === undefined
          ? {
            code: 'session.not-mounted',
            detail: contextDetail(
              'session-backdrop.not-mounted',
              'The session backdrop is not mounted without an active session.',
            ),
          }
          : {}),
      },
      ...([
        'environment.panel.header-actions',
        'environment.panel.sections',
        'environment.section.actions',
        'environment.section.rows',
        'environment.row.trailing-actions',
      ] as const)
        .map(surface => ({
          surface,
          state: environmentState,
          ...(environmentSeat === undefined
            ? environmentCandidates.length > 0
              ? {
                code: 'anchor.unresolved',
                detail: contextDetail(
                  'environment.unresolved',
                  'The environment panel anchor could not be resolved uniquely.',
                ),
              }
              : {
                code: 'context.not-mounted',
                detail: contextDetail('environment.not-mounted', 'The environment panel context is not mounted.'),
              }
            : {}),
        })),
    ])

    const snapshots = this.slots.snapshot()

    const active = snapshots.filter(item => item.visible && item.authorized && item.valid && !item.pending)
    let renderedReasoningId: string | undefined
    let renderedBackdropId: string | undefined
    const navigationItems = active.filter(item => item.surface === 'sidebar.navigation.items')
    const collectionGroups = new Set(this.slots.navigationCollectionGroupsSnapshot().map(group => group.surfaceGroup))
    const recentTasks = playground ? this.document.querySelector<HTMLElement>('[data-playground-recent-tasks]') : null
    const collectionsSeat: SidebarCollectionsSeat | undefined = managerOverlay ? undefined : playground
      ? sidebarNavigation?.parentElement === null || sidebarNavigation === undefined ? undefined : {
        key: 'sidebar.collections',
        parent: recentTasks?.parentElement ?? sidebarNavigation.parentElement!,
        before: recentTasks ?? nextNativeSibling(sidebarNavigation),
        className: 'cordisx-sidebar-navigation cordisx-sidebar-collections',
      }
      : sidebar === undefined
      ? undefined
      : resolveSidebarCollectionsSeat(this.document, sidebar)
    const renderedNavigationIds = new Set(
      navigationItems.filter(item =>
        collectionGroups.has(item.group) ? collectionsSeat !== undefined : sidebarNavigation !== undefined
      ).map(item => item.qualifiedId),
    )
    if (navigationItems.length > 0 && (sidebarNavigation !== undefined || collectionsSeat !== undefined)) {
      availableSurfaces.add('sidebar.navigation.items')
      const root = sidebarNavigation === undefined ? undefined : this.placeRoot({
        key: 'sidebar.navigation',
        parent: sidebarNavigation,
        before: null,
        className: 'cordisx-sidebar-navigation',
      }, usedRoots)
      const collectionRoot = collectionsSeat === undefined || !navigationItems.some(item =>
          collectionGroups.has(item.group)
        )
        ? undefined
        : this.placeRoot(collectionsSeat, usedRoots)
      if (root !== undefined) projectSidebarAppearance(root, this.adapterIdentity, nativeButtons(sidebarNavigation!)[0])
      if (collectionRoot !== undefined && collectionsSeat !== undefined) {
        projectSidebarAppearance(collectionRoot, this.adapterIdentity, collectionsSeat.row)
        if (!playground) projectSidebarGroupAppearance(collectionRoot, collectionsSeat)
      }
      const signature = JSON.stringify([
        root !== undefined,
        collectionRoot !== undefined,
        this.navigationContentSignature(navigationItems),
      ])
      if (
        rebuild || root?.childElementCount === 0 || collectionRoot?.childElementCount === 0
        || signature !== this.navigationRenderSignature
      ) {
        this.renderNavigation(root, navigationItems, nextSites, collectionRoot)
        this.navigationRenderSignature = signature
      }
      if (collectionRoot !== undefined && !playground) {
        projectSidebarDisclosure(collectionRoot, collectionsSeat?.heading)
      }
    }
    if (sidebarFooterControl?.parentElement !== null && sidebarFooterControl?.parentElement !== undefined) {
      const parent = sidebarFooterControl.parentElement
      availableSurfaces.add('sidebar.footer.before-control')
      availableSurfaces.add('sidebar.footer.after-control')
      availableSurfaces.add('sidebar.footer.menu')
      const beforeItems = active.filter(item => item.surface === 'sidebar.footer.before-control')
      if (beforeItems.length > 0) {
        const root = this.placeRoot({
          key: 'sidebar.footer.before',
          parent,
          before: sidebarFooterControl,
          className: 'cordisx-sidebar-footer-before',
        }, usedRoots)
        if (rebuild || root.childElementCount === 0) {
          this.renderActions(root, beforeItems, nextSites, 'action', sidebarFooterControl)
        }
      }
      const afterItems = active.filter(item => item.surface === 'sidebar.footer.after-control')
      if (afterItems.length > 0) {
        const root = this.placeRoot({
          key: 'sidebar.footer.after',
          parent,
          before: nextNativeSibling(sidebarFooterControl),
          className: 'cordisx-sidebar-footer-after',
        }, usedRoots)
        if (rebuild || root.childElementCount === 0) {
          this.renderActions(root, afterItems, nextSites, 'action', sidebarFooterControl)
        }
      }
      const menuItems = active.filter(item => item.surface === 'sidebar.footer.menu')
      const menu = resolveOpenNativeMenu(this.document, sidebarFooterControl)
      if (menuItems.length > 0 && menu !== undefined) {
        this.projectNativeMenu(
          'sidebar.footer.menu',
          menu,
          sidebarFooterControl,
          menuItems,
          nextSites,
          usedRoots,
          rebuild,
        )
      }
    }
    if (accountControl !== undefined) {
      availableSurfaces.add('sidebar.account.menu')
      const menuItems = active.filter(item => item.surface === 'sidebar.account.menu')
      const menu = resolveOpenNativeMenu(this.document, accountControl)
      if (menuItems.length > 0 && menu !== undefined) {
        this.projectNativeMenu('sidebar.account.menu', menu, accountControl, menuItems, nextSites, usedRoots, rebuild)
      }
    }
    if (toolbarControl?.parentElement !== null && toolbarControl?.parentElement !== undefined) {
      const toolbarAnchor = nativeControlInsertionAnchor(this.document, toolbarControl)
      const parent = toolbarAnchor.parentElement
      if (parent === null) return
      availableSurfaces.add('workspace.toolbar.items')
      const beforeItems = active.filter(item =>
        item.surface === 'workspace.toolbar.items'
        && (playground || (item.item as { placement: string }).placement === 'before')
      )
      if (beforeItems.length > 0) {
        const root = this.placeRoot({
          key: 'toolbar.before',
          parent,
          before: toolbarAnchor,
          className: 'cordisx-toolbar-before',
        }, usedRoots)
        this.configureToolbarIconControlVariant(root, toolbarControl)
        if (rebuild || root.childElementCount === 0) {
          this.renderActions(root, beforeItems, nextSites, 'before', toolbarControl)
        }
      }
      const afterItems = playground
        ? []
        : active.filter(item =>
          item.surface === 'workspace.toolbar.items' && (item.item as { placement: string }).placement === 'after'
        )
      if (afterItems.length > 0) {
        const root = this.placeRoot({
          key: 'toolbar.after',
          parent,
          before: nextNativeSibling(toolbarAnchor),
          className: 'cordisx-toolbar-after',
        }, usedRoots)
        this.configureToolbarIconControlVariant(root, toolbarControl)
        if (rebuild || root.childElementCount === 0) {
          this.renderActions(root, afterItems, nextSites, 'after', toolbarControl)
        }
      }
      const menuItems = playground
        ? []
        : active.filter(item =>
          item.surface === 'workspace.toolbar.items' && (item.item as { placement: string }).placement === 'menu'
        )
      const menu = resolveOpenNativeMenu(this.document, toolbarMenuControl)
      if (menuItems.length > 0 && menu !== undefined && toolbarMenuControl !== undefined) {
        this.projectNativeMenu('toolbar.menu', menu, toolbarMenuControl, menuItems, nextSites, usedRoots, rebuild)
      }
    }
    this.reconcileToolbarSlot(toolbarControl, usedRoots)
    if (sessionHeaderSeat !== undefined) {
      availableSurfaces.add('session.header.actions')
      const items = active.filter(item => item.surface === 'session.header.actions')
      if (items.length > 0) {
        const root = this.placeRoot(sessionHeaderSeat, usedRoots)
        this.configureToolbarIconControlVariant(root, sessionHeaderSeat.template)
        if (rebuild || root.childElementCount === 0) {
          this.renderActions(root, items, nextSites, 'header', sessionHeaderSeat.template, 'toolbar', 3)
        }
      }
    }
    if (composerSubmitSeat !== undefined) {
      availableSurfaces.add('composer.toolbar.items')
      const items = active.filter(item =>
        item.surface === 'composer.toolbar.items'
        && item.control?.mode !== 'proxy'
        && (item.item as { anchor: string; placement: string }).anchor === 'submit'
        && (item.item as { anchor: string; placement: string }).placement === 'before'
      )
      if (items.length > 0) {
        const root = this.placeRoot(composerSubmitSeat, usedRoots)
        if (rebuild || root.childElementCount === 0) {
          this.renderActions(root, items, nextSites, 'submit.before', composerSubmitSeat.template, 'composer', 2, false)
        }
      }
    }
    if (reasoningRange !== undefined) {
      availableSurfaces.add('composer.reasoning-intensity')
      const reasoningItems = active.filter(item => item.surface === REASONING_CONTROL_POINT)
      const hideNative = reasoningItems.find(item => item.control?.mode === 'hide-native')
      const snapshot = reasoningItems.find(item => {
        const mode: CordisXExtensionPointControlMode = item.control?.mode ?? 'compose'
        return mode === 'compose' || mode === 'replace' || mode === 'overlay'
      })
      if (snapshot !== undefined) {
        const presentation = snapshot.item as CordisXReasoningIntensityPresentation
        const title = this.text(snapshot, presentation.title, 'title', nextSites)
        const labels = presentation.stages.map((stage, index) =>
          this.text(snapshot, stage.label, `stages.${index}.label`, nextSites)
        )
        this.reasoningProjection ??= new ReasoningIntensityProjection(this.document)
        this.reasoningNativeVisibility.update(undefined, false)
        this.reasoningProjection.update(
          reasoningRange,
          presentation,
          title,
          labels,
          snapshot.control?.mode !== 'overlay',
        )
        renderedReasoningId = snapshot.qualifiedId
      } else if (hideNative !== undefined) {
        this.reasoningProjection?.dispose()
        this.reasoningProjection = undefined
        this.reasoningNativeVisibility.update(reasoningRange, true)
        renderedReasoningId = hideNative.qualifiedId
      } else {
        this.reasoningProjection?.dispose()
        this.reasoningProjection = undefined
        this.reasoningNativeVisibility.update(reasoningRange, false)
      }
    } else {
      this.reasoningProjection?.dispose()
      this.reasoningProjection = undefined
      this.reasoningNativeVisibility.update(undefined, false)
    }
    if (sessionId !== undefined) {
      availableSurfaces.add('session.backdrop')
      const snapshot = active.find(item => item.surface === 'session.backdrop')
      if (snapshot !== undefined) {
        const presentation = snapshot.item as CordisXSessionBackdropPresentation
        const portraitLabels = presentation.stages.map((stage, index) =>
          this.text(snapshot, stage.portrait.alt, `stages.${index}.portrait.alt`, nextSites)
        )
        this.sessionBackdropProjection ??= new SessionBackdropProjection(this.document)
        this.sessionBackdropProjection.update(sessionId, reasoningRange, presentation, portraitLabels)
        renderedBackdropId = snapshot.qualifiedId
      } else {
        this.sessionBackdropProjection?.dispose()
        this.sessionBackdropProjection = undefined
      }
    } else {
      this.sessionBackdropProjection?.dispose()
      this.sessionBackdropProjection = undefined
    }
    if (environmentSeat !== undefined) {
      for (
        const surface of [
          'environment.panel.header-actions',
          'environment.panel.sections',
          'environment.section.actions',
          'environment.section.rows',
          'environment.row.trailing-actions',
        ] as const
      ) availableSurfaces.add(surface)
      const items = active.filter(item => item.surface.startsWith('environment.'))
      if (items.length > 0) {
        const root = this.placeRoot(environmentSeat, usedRoots)
        if (rebuild || root.childElementCount === 0) this.renderEnvironment(root, items, nextSites)
      }
    }
    for (const [key, root] of this.roots) {
      if (!usedRoots.has(key)) root.remove()
    }
    for (const [button, project] of this.routeProjectors) {
      if (!button.isConnected) {
        this.routeProjectors.delete(button)
        continue
      }
      project()
    }
    this.publishSelectedNavigationActions()
    if (!usedRoots.has('sidebar.navigation') && !usedRoots.has('sidebar.collections')) {
      this.disposeNavigationLeadingVisuals()
      this.disposeNavigationActions()
      this.navigationRenderSignature = undefined
    }
    for (const snapshot of snapshots) {
      const rendered = snapshot.visible && snapshot.authorized && snapshot.valid && !snapshot.pending
        && availableSurfaces.has(snapshot.surface)
        && (snapshot.surface !== 'sidebar.navigation.items' || renderedNavigationIds.has(snapshot.qualifiedId))
        && (snapshot.surface !== 'composer.reasoning-intensity' || snapshot.qualifiedId === renderedReasoningId)
        && (snapshot.surface !== 'session.backdrop' || snapshot.qualifiedId === renderedBackdropId)
      const renderToken = this.slots.registry.renderToken(snapshot.surface, snapshot.qualifiedId)
      if (renderToken !== undefined) {
        this.slots.registry.markRendered(snapshot.surface, snapshot.qualifiedId, renderToken, rendered)
      }
    }
    for (const site of this.sites) {
      if (nextSites.has(site)) continue
      const [owner, ...rest] = site.split('\u0000')
      this.i18n.clearDiagnosticSite(owner!, rest.join('\u0000'))
    }
    this.sites.clear()
    for (const site of nextSites) this.sites.add(site)
  }
}

export { StructuredSurfaceRenderer }
