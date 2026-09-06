import { StructuredSurfaceRendererBase } from './renderer-base.js'
import type { NativeSurfaceSeat } from './types.js'
import {
  create,
  currentSessionId,
  nativeMenuInsertionPoint,
  nativeMenuItemTemplate,
  nativeToolbarCornerRadius,
} from './dom.js'
import type { SurfaceContributionSnapshot } from '../surfaces.js'
import type {
  CordisXLocalizedText,
  CordisXNavigationAction,
  CordisXNavigationCollectionAction,
  CordisXNavigationCollectionLeadingVisual,
  CordisXRouteReference,
  CordisXStructuredAction,
  CordisXSurfaceInvocationContextV1,
} from '../../contracts.js'
import { CORDISX_SURFACE_INVOCATION_CONTEXT_SCHEMA_V1 } from '../../contracts.js'
import type { NativeActionPattern } from './dom.js'
import { createHostSurfaceIcon } from '../icons.js'
import type { HostTooltipPlacement } from '../tooltips.js'
import { evaluateWhen } from '../validation.js'
import { createSidebarItem } from '../host-ui/SidebarItem.js'
import type { HostNavigationCollectionAction } from '../host-ui/NavigationCollectionActions.js'
import { mountNavigationCollectionActions } from '../host-ui/NavigationCollectionActions.js'
import { rasterImageDataUrl } from '../raster-image.js'

export function partitionDirectActions<Item>(items: readonly Item[], directLimit: number): Readonly<{
  direct: readonly Item[]
  overflow: readonly Item[]
}> {
  const limit = Math.max(0, Math.floor(directLimit))
  return Object.freeze({ direct: items.slice(0, limit), overflow: items.slice(limit) })
}

abstract class StructuredSurfaceInteractions extends StructuredSurfaceRendererBase {
  protected placeRoot(seat: NativeSurfaceSeat, usedRoots: Set<string>): HTMLElement {
    const root = this.roots.get(seat.key) ?? create(this.document, 'div')
    this.roots.set(seat.key, root)
    usedRoots.add(seat.key)
    root.className = `cordisx-native-seat ${seat.className}`
    root.dataset.cordisxSurfaceHost = seat.key
    root.dataset.cordisxNoDrag = 'true'
    root.style.setProperty('-webkit-app-region', 'no-drag')
    if (root.parentElement !== seat.parent || root.nextSibling !== seat.before) {
      seat.parent.insertBefore(root, seat.before)
    }
    root.hidden = false
    return root
  }

  protected restoreToolbarSlot(): void {
    if (this.toolbarSlot === undefined) return
    this.toolbarSlot.element.style.width = this.toolbarSlot.width
    this.toolbarSlot.element.style.minWidth = this.toolbarSlot.minWidth
    this.toolbarSlot = undefined
  }

  protected reconcileToolbarSlot(control: HTMLButtonElement | undefined, usedRoots: Set<string>): void {
    const roots = ['toolbar.before', 'toolbar.after']
      .filter(key => usedRoots.has(key))
      .map(key => this.roots.get(key))
      .filter((root): root is HTMLElement => root !== undefined)
    const slot = control?.closest<HTMLElement>('[data-test-id="header-shell-slot"]')
    if (slot === null || slot === undefined || roots.length === 0) {
      this.restoreToolbarSlot()
      return
    }
    if (this.toolbarSlot?.element !== slot) {
      this.restoreToolbarSlot()
      this.toolbarSlot = { element: slot, width: slot.style.width, minWidth: slot.style.minWidth }
    }
    const originalWidth = Number.parseFloat(this.toolbarSlot.width) || 0
    const originalMinimum = Number.parseFloat(this.toolbarSlot.minWidth)
      || Number.parseFloat(this.document.defaultView?.getComputedStyle(slot).minWidth ?? '')
      || 0
    const contributionWidth = roots.reduce((total, root) => total + root.getBoundingClientRect().width, 0)
    slot.style.width = `${Math.ceil(Math.max(originalWidth, originalMinimum) + contributionWidth)}px`
  }

  protected configureToolbarIconControlVariant(root: HTMLElement, template: HTMLButtonElement): void {
    root.dataset.cordisxIconControlVariant = 'toolbar'
    root.style.setProperty('--cordisx-toolbar-action-corner-radius', nativeToolbarCornerRadius(template))
  }

  protected text(
    snapshot: SurfaceContributionSnapshot,
    value: CordisXLocalizedText,
    path: string,
    nextSites: Set<string>,
  ): string {
    const site = `surface:${snapshot.surface}:${snapshot.qualifiedId}:${path}`
    nextSites.add(`${snapshot.owner}\u0000${site}`)
    return this.i18n.resolveFor(snapshot.owner, value, site).text
  }

  protected navigationGroupText(
    owner: string,
    qualifiedId: string,
    value: CordisXLocalizedText,
    nextSites: Set<string>,
  ): string {
    const site = `surface:sidebar.navigation.items:${qualifiedId}:group.label`
    nextSites.add(`${owner}\u0000${site}`)
    return this.i18n.resolveFor(owner, value, site).text
  }

  protected invocationContext(
    snapshot: SurfaceContributionSnapshot,
    action: CordisXStructuredAction,
  ): CordisXSurfaceInvocationContextV1 | undefined {
    if (action.command === undefined) return undefined
    const commandId = action.command.id.includes(':') ? action.command.id : `${snapshot.owner}:${action.command.id}`
    const sessionKey = currentSessionId(this.document)
    if (
      (snapshot.surface === 'session.header.actions' || snapshot.surface === 'composer.toolbar.items')
      && sessionKey === undefined
    ) return undefined
    return {
      $schema: CORDISX_SURFACE_INVOCATION_CONTEXT_SCHEMA_V1,
      schemaVersion: 1,
      generation: this.adapterIdentity.generation,
      contextRef: `context-${this.adapterIdentity.generation}-${++this.nextContext}`,
      pointId: snapshot.surface,
      contributionId: snapshot.qualifiedId,
      commandId,
      provenance: 'observed',
      source: {
        kind: 'adapter',
        adapterId: 'codex',
        adapterVersion: this.adapterIdentity.adapterVersion,
        hostId: this.adapterIdentity.hostId,
      },
      identity: sessionKey === undefined ? {} : { agent: { sessionKey } },
    }
  }

  protected contextualRouteReference(
    snapshot: SurfaceContributionSnapshot,
    action: CordisXStructuredAction,
  ): CordisXRouteReference | undefined {
    if (action.route === undefined) return undefined
    const qualifiedId = action.route.id.includes(':') ? action.route.id : `${snapshot.owner}:${action.route.id}`
    const route = this.routes.snapshot().routes.find(candidate => candidate.qualifiedId === qualifiedId)
    const params = { ...(action.route.params ?? {}) }
    if (snapshot.surface === 'session.header.actions' && route?.definition.path.split('/').includes(':sessionId')) {
      const sessionId = currentSessionId(this.document)
      if (sessionId === undefined) return undefined
      params.sessionId = sessionId
    }
    return { id: action.route.id, ...(Object.keys(params).length === 0 ? {} : { params }) }
  }

  protected button(
    snapshot: SurfaceContributionSnapshot,
    action: CordisXStructuredAction,
    path: string,
    nextSites: Set<string>,
    nativePattern?: NativeActionPattern,
    nativeTemplate?: HTMLButtonElement,
    afterActivate?: () => void,
    reduceGlyph = true,
  ): HTMLButtonElement {
    const button = this.document.createElement('button')
    button.type = 'button'
    const nativeClasses = nativePattern === 'composer' || nativePattern === 'toolbar'
      ? ''
      : nativeTemplate?.className ?? ''
    button.draggable = false
    button.className = nativePattern === undefined
      ? 'cordisx-action'
      : `${nativeClasses} cordisx-action${
        reduceGlyph ? ' cordisx-icon-only-control' : ''
      } cordisx-native-icon-action cordisx-${nativePattern}-action`.trim()
    if (nativePattern !== undefined) button.dataset.cordisxIconControlVariant = nativePattern
    button.dataset.cordisxOwner = snapshot.owner
    button.dataset.cordisxSurface = snapshot.surface
    button.dataset.cordisxContributionId = snapshot.qualifiedId
    button.dataset.cordisxNoDrag = 'true'
    button.style.setProperty('-webkit-app-region', 'no-drag')
    const label = this.text(snapshot, action.label, `${path}.label`, nextSites)
    if (nativePattern === undefined) {
      if (action.icon !== undefined) button.append(createHostSurfaceIcon(this.document, action.icon))
      const copy = create(this.document, 'span', 'cordisx-action-label')
      copy.textContent = label
      button.append(copy)
    } else {
      button.append(createHostSurfaceIcon(this.document, action.icon))
      button.dataset.cordisxTooltip = label
      const placement: HostTooltipPlacement = nativePattern === 'toolbar' ? 'bottom' : 'top'
      this.tooltips.attach(button, () => button.dataset.cordisxTooltip, placement)
    }
    button.setAttribute(
      'aria-label',
      action.ariaLabel === undefined
        ? label
        : this.text(snapshot, action.ariaLabel, `${path}.ariaLabel`, nextSites),
    )
    const commandId = action.command?.id
    const command = commandId === undefined
      ? undefined
      : this.commands.snapshot().find(item =>
        item.qualifiedId === (commandId.includes(':') ? commandId : `${snapshot.owner}:${commandId}`)
      )
    const actionState = action as CordisXStructuredAction & {
      when?: Parameters<typeof evaluateWhen>[0]
      disabled?: { value: boolean; reason?: CordisXLocalizedText }
    }
    button.hidden = !evaluateWhen(actionState.when, this.slots.contexts.getSnapshot())
    button.disabled = snapshot.disabled || actionState.disabled?.value === true || (command?.running ?? 0) > 0
    const reason = actionState.disabled?.reason
    if (button.disabled && reason !== undefined) {
      button.dataset.cordisxTooltip = this.text(snapshot, reason, `${path}.disabled`, nextSites)
    }
    if (action.route !== undefined && action.routeBehavior === 'toggle') {
      const project = (): void => {
        const reference = this.contextualRouteReference(snapshot, action)
        const projection = reference === undefined
          ? { active: false, presented: false }
          : this.routes.routeProjection(snapshot.owner, reference)
        button.setAttribute('aria-pressed', String(projection.presented))
        button.dataset.cordisxRouteState = projection.presented
          ? 'presented'
          : projection.active
          ? 'active'
          : 'inactive'
      }
      this.routeProjectors.set(button, project)
      project()
    }
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      afterActivate?.()
      const context = this.invocationContext(snapshot, action)
      const operation = action.command !== undefined
        ? (context === undefined
            && (snapshot.surface === 'session.header.actions' || snapshot.surface === 'composer.toolbar.items'))
          ? Promise.reject(new Error('active session identity is unavailable'))
          : this.commands.executeFor(
            snapshot.owner,
            action.command,
            `${snapshot.surface}:${snapshot.qualifiedId}:${path}`,
            {
              pointId: snapshot.surface,
              contributionId: snapshot.qualifiedId,
              ...(context === undefined ? {} : { context }),
            },
          )
        : action.route !== undefined
        ? (() => {
          const reference = this.contextualRouteReference(snapshot, action)
          if (reference === undefined) return Promise.reject(new Error('active session identity is unavailable'))
          return action.routeBehavior === 'toggle'
            ? this.routes.toggleFromSurface(snapshot.owner, reference, snapshot.surface, snapshot.qualifiedId, button)
            : this.routes.navigateFromSurface(snapshot.owner, reference, snapshot.surface, snapshot.qualifiedId, button)
        })()
        : Promise.reject(new Error('surface action has no activation'))
      void operation.catch(error => {
        button.dataset.error = error instanceof Error ? error.message : String(error)
        this.schedule(true)
      })
    })
    return button
  }

  protected renderNavigation(
    root: HTMLElement,
    snapshots: readonly SurfaceContributionSnapshot[],
    sites: Set<string>,
    _nativeTemplate?: HTMLButtonElement,
  ): void {
    this.disposeNavigationActions()
    const usedLeadingVisuals = new Set<string>()
    const navigation = create(this.document, 'div', 'cordisx-navigation')
    const groups = this.slots.navigationCollectionGroupsSnapshot()
    const collectionGroupIds = new Set(groups.map(group => group.surfaceGroup))
    const renderRows = (items: readonly SurfaceContributionSnapshot[], parent: HTMLElement): void => {
      for (const snapshot of items) {
        const item = snapshot.item as {
          label: CordisXLocalizedText
          description?: CordisXLocalizedText
          icon?: string
          command?: { id: string; arguments?: never }
          route?: CordisXRouteReference
          collectionContract?: 'cordisx.navigation-collection/v2' | 'cordisx.navigation-collection/v3'
          actions?: readonly (CordisXNavigationAction | CordisXNavigationCollectionAction)[]
        }
        const label = this.text(snapshot, item.label, 'label', sites)
        const description = item.description === undefined
          ? undefined
          : this.text(snapshot, item.description, 'description', sites)
        const leadingVisual = this.slots.navigationCollectionLeadingVisual(snapshot.qualifiedId)
        let iconElement: HTMLElement | undefined
        if (leadingVisual !== undefined) {
          iconElement = this.navigationLeadingVisualElement(snapshot.qualifiedId, leadingVisual)
          usedLeadingVisuals.add(snapshot.qualifiedId)
        }
        const activate = (): void => {
          const operation = item.command !== undefined
            ? this.commands.executeFor(snapshot.owner, item.command, `nav:${snapshot.qualifiedId}`, {
              pointId: snapshot.surface,
              contributionId: snapshot.qualifiedId,
            })
            : item.route === undefined
            ? Promise.reject(new Error('navigation item has no activation'))
            : this.routes.navigateFromSurface(snapshot.owner, item.route, snapshot.surface, snapshot.qualifiedId)
          void operation.catch(error => {
            control.element.dataset.error = error instanceof Error ? error.message : String(error)
            this.schedule(true)
          })
        }
        const control = createSidebarItem(this.document, {
          id: snapshot.qualifiedId,
          label,
          ...(description === undefined ? {} : { secondary: description }),
          ...(description === undefined ? {} : { ariaLabel: `${label}：${description}` }),
          ...(iconElement === undefined ? {} : { iconElement }),
          ...(item.icon === undefined ? {} : { icon: item.icon }),
          onActivate: activate,
        })
        const { element: row, primary } = control
        let actionCandidate: import('./renderer-base.js').NavigationActionCandidate | undefined
        if (description !== undefined) primary.dataset.cordisxTooltip = description
        if (item.route !== undefined) {
          const project = (): void => {
            const projection = this.routes.routeProjection(snapshot.owner, item.route!)
            const presentation = projection.presented ? 'presented' : projection.active ? 'active' : 'inactive'
            row.dataset.cordisxRouteState = presentation
            control.setSelected(presentation === 'presented', true)
            if (actionCandidate !== undefined) actionCandidate.presented = presentation === 'presented'
          }
          this.routeProjectors.set(primary, project)
          project()
        }
        const actions = control.actions
        if (
          item.collectionContract !== 'cordisx.navigation-collection/v2'
          && item.collectionContract !== 'cordisx.navigation-collection/v3'
        ) {
          for (
            const [index, action] of ((item.actions as readonly CordisXNavigationAction[] | undefined) ?? []).entries()
          ) {
            actions.append(this.button(snapshot, action, `actions.${index}`, sites, 'shortcut'))
          }
        } else {
          const actionViews = ((item.actions as readonly CordisXNavigationCollectionAction[] | undefined) ?? []).map(
            (action, index): HostNavigationCollectionAction => {
              const path = `actions.${index}`
              const command = action.kind !== 'command' ? undefined : this.commands.snapshot().find(candidate => (
                candidate.qualifiedId
                  === (action.command.id.includes(':') ? action.command.id : `${snapshot.owner}:${action.command.id}`)
              ))
              const disabledReason = action.disabled.reason === undefined
                ? undefined
                : this.text(snapshot, action.disabled.reason as CordisXLocalizedText, `${path}.disabled.reason`, sites)
              const confirmation = action.kind !== 'command' || action.confirmation === undefined
                ? undefined
                : {
                  title: this.text(
                    snapshot,
                    action.confirmation.title as CordisXLocalizedText,
                    `${path}.confirmation.title`,
                    sites,
                  ),
                  description: this.text(
                    snapshot,
                    action.confirmation.description as CordisXLocalizedText,
                    `${path}.confirmation.description`,
                    sites,
                  ),
                  confirmLabel: this.text(
                    snapshot,
                    action.confirmation.confirmLabel as CordisXLocalizedText,
                    `${path}.confirmation.confirmLabel`,
                    sites,
                  ),
                }
              return {
                id: action.id,
                label: this.text(snapshot, action.label as CordisXLocalizedText, `${path}.label`, sites),
                ariaLabel: this.text(
                  snapshot,
                  (action.ariaLabel ?? action.label) as CordisXLocalizedText,
                  `${path}.ariaLabel`,
                  sites,
                ),
                ...(action.icon === undefined ? {} : { icon: action.icon }),
                placement: action.placement,
                tone: action.tone,
                pressed: action.pressed,
                disabled: snapshot.disabled || action.disabled.value || (command?.running ?? 0) > 0,
                ...(disabledReason === undefined ? {} : { disabledReason }),
                success: this.text(
                  snapshot,
                  action.feedback.success as CordisXLocalizedText,
                  `${path}.feedback.success`,
                  sites,
                ),
                failure: this.text(
                  snapshot,
                  action.feedback.failure as CordisXLocalizedText,
                  `${path}.feedback.failure`,
                  sites,
                ),
                ...(confirmation === undefined ? {} : { confirmation }),
                invoke: async () => {
                  if (action.kind === 'command') {
                    await this.commands.executeFor(
                      snapshot.owner,
                      action.command,
                      `nav-action:${snapshot.qualifiedId}:${action.id}`,
                      {
                        pointId: snapshot.surface,
                        contributionId: snapshot.qualifiedId,
                      },
                    )
                    return
                  }
                  const value = action.kind === 'copy-route-link'
                    ? this.routes.deepLinkFor(snapshot.owner, item.route!)
                    : action.text.value
                  const clipboard = this.document.defaultView?.navigator.clipboard
                  if (clipboard === undefined) throw new Error('clipboard is unavailable')
                  await clipboard.writeText(value)
                },
              }
            },
          )
          if (item.route !== undefined) {
            actionCandidate = {
              owner: snapshot.owner,
              itemId: snapshot.qualifiedId,
              route: item.route,
              actions: actionViews,
              actionContainer: actions,
              presented: false,
            }
            this.navigationActionCandidates.push(actionCandidate)
          }
          if (actionViews.length > 0) {
            this.navigationActionDisposers.push(mountNavigationCollectionActions(this.document, actions, actionViews))
          }
        }
        parent.append(row)
      }
    }
    renderRows(snapshots.filter(snapshot => !collectionGroupIds.has(snapshot.group)), navigation)
    for (const group of groups) {
      const items = snapshots.filter(snapshot => snapshot.group === group.surfaceGroup)
      if (items.length === 0) continue
      const section = create(this.document, 'section', 'cordisx-navigation-group')
      section.dataset.navigationGroup = group.qualifiedId
      const heading = create(this.document, 'div', 'cordisx-navigation-group-heading')
      heading.setAttribute('role', 'heading')
      heading.setAttribute('aria-level', '2')
      heading.textContent = this.navigationGroupText(group.owner, group.qualifiedId, group.label, sites)
      section.append(heading)
      renderRows(items, section)
      navigation.append(section)
    }
    root.replaceChildren(navigation)
    this.disposeUnusedNavigationLeadingVisuals(usedLeadingVisuals)
  }

  protected disposeNavigationLeadingVisuals(): void {
    for (const mount of this.navigationLeadingVisualMounts.values()) {
      mount.dispose()
      mount.element.remove()
    }
    this.navigationLeadingVisualMounts.clear()
  }

  protected disposeUnusedNavigationLeadingVisuals(used: ReadonlySet<string>): void {
    for (const [qualifiedItemId, mount] of this.navigationLeadingVisualMounts) {
      if (used.has(qualifiedItemId)) continue
      mount.dispose()
      mount.element.remove()
      this.navigationLeadingVisualMounts.delete(qualifiedItemId)
    }
  }

  protected navigationLeadingVisualElement(
    qualifiedItemId: string,
    visual: CordisXNavigationCollectionLeadingVisual,
  ): HTMLElement {
    const semanticKey = `${visual.image.width}x${visual.image.height}:${visual.image.data}`
    const current = this.navigationLeadingVisualMounts.get(qualifiedItemId)
    if (current?.semanticKey === semanticKey) return current.element
    if (current !== undefined) {
      current.dispose()
      current.element.remove()
    }
    const element = this.document.createElement('span')
    element.className = 'cordisx-navigation-image-seat'
    const image = this.document.createElement('img')
    image.alt = ''
    image.setAttribute('aria-hidden', 'true')
    image.draggable = false
    image.width = visual.image.width
    image.height = visual.image.height
    image.src = rasterImageDataUrl(visual.image)
    element.append(image)
    this.navigationLeadingVisualMounts.set(qualifiedItemId, {
      element,
      semanticKey,
      dispose: () => {
        image.removeAttribute('src')
        image.remove()
      },
    })
    return element
  }

  protected navigationContentSignature(snapshots: readonly SurfaceContributionSnapshot[]): string {
    return JSON.stringify({
      groups: this.slots.navigationCollectionGroupsSnapshot(),
      localization: this.i18n.getSnapshot(),
      commands: this.commands.snapshot().map(command => ({
        qualifiedId: command.qualifiedId,
        running: command.running,
      })),
      items: snapshots.map(snapshot => ({
        owner: snapshot.owner,
        id: snapshot.id,
        qualifiedId: snapshot.qualifiedId,
        group: snapshot.group,
        order: snapshot.order,
        item: snapshot.item,
        visible: snapshot.visible,
        authorized: snapshot.authorized,
        disabled: snapshot.disabled,
        valid: snapshot.valid,
        pending: snapshot.pending,
        leadingVisual: this.slots.navigationCollectionLeadingVisual(snapshot.qualifiedId),
      })),
    })
  }

  protected disposeNavigationActions(): void {
    for (const dispose of this.navigationActionDisposers.splice(0)) dispose()
    this.navigationActionCandidates = []
    this.selectedNavigationActions?.replace([])
  }

  protected publishSelectedNavigationActions(): void {
    const presented = this.navigationActionCandidates.filter(candidate => candidate.presented)
    this.selectedNavigationActions?.replace(presented)
    for (const candidate of this.navigationActionCandidates) {
      candidate.actionContainer.hidden = this.selectedNavigationActions?.isSelected(
        candidate.owner,
        candidate.itemId,
        candidate.route,
      ) === true
    }
  }

  protected renderActions(
    root: HTMLElement,
    snapshots: readonly SurfaceContributionSnapshot[],
    sites: Set<string>,
    path: string,
    template: HTMLButtonElement,
    preferredPattern?: NativeActionPattern,
    directLimit = Number.POSITIVE_INFINITY,
    reduceGlyph = true,
  ): void {
    root.replaceChildren()
    const pattern = preferredPattern
      ?? (template.closest('header[data-app-shell-application-menu-bar]') === null ? 'footer' : 'toolbar')
    const partition = partitionDirectActions(snapshots, directLimit)
    for (const snapshot of partition.direct) {
      root.append(
        this.button(
          snapshot,
          snapshot.item as CordisXStructuredAction,
          path,
          sites,
          pattern,
          template,
          undefined,
          reduceGlyph,
        ),
      )
    }
    if (partition.overflow.length === 0) return
    const overflow = this.document.createElement('details')
    overflow.className = 'cordisx-surface-overflow'
    overflow.dataset.cordisxNoDrag = 'true'
    const summary = this.document.createElement('summary')
    if (reduceGlyph) summary.className = 'cordisx-icon-only-control'
    summary.setAttribute('aria-label', 'More actions')
    summary.dataset.cordisxTooltip = 'More actions'
    summary.append(createHostSurfaceIcon(this.document, 'host:more'))
    this.tooltips.attach(summary, () => summary.dataset.cordisxTooltip, pattern === 'toolbar' ? 'bottom' : 'top')
    const menu = create(this.document, 'div', 'cordisx-surface-overflow-menu')
    menu.setAttribute('role', 'menu')
    for (const snapshot of partition.overflow) {
      const action = this.button(
        snapshot,
        snapshot.item as CordisXStructuredAction,
        `${path}.overflow`,
        sites,
        undefined,
        undefined,
        () => {
          overflow.open = false
        },
      )
      action.setAttribute('role', 'menuitem')
      menu.append(action)
    }
    overflow.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      overflow.open = false
      summary.focus()
    })
    overflow.append(summary, menu)
    root.append(overflow)
  }

  protected projectNativeMenu(
    key: string,
    menu: HTMLElement,
    control: HTMLButtonElement,
    snapshots: readonly SurfaceContributionSnapshot[],
    sites: Set<string>,
    usedRoots: Set<string>,
    rebuild: boolean,
  ): void {
    const root = this.placeRoot({
      key,
      parent: menu,
      before: nativeMenuInsertionPoint(menu),
      className: 'cordisx-native-menu-root',
    }, usedRoots)
    if (!rebuild && root.childElementCount > 0) return
    root.replaceChildren()
    const template = nativeMenuItemTemplate(menu)
    for (const snapshot of snapshots) {
      const action = snapshot.item as CordisXStructuredAction
      const item = create(this.document, 'div', `cordisx-native-menu-item ${template?.className ?? ''}`.trim())
      item.setAttribute('role', 'menuitem')
      item.tabIndex = -1
      item.dataset.cordisxNoDrag = 'true'
      item.style.setProperty('-webkit-app-region', 'no-drag')
      const row = create(this.document, 'div', 'cordisx-native-menu-row')
      row.append(createHostSurfaceIcon(this.document, action.icon))
      const label = create(this.document, 'span', 'cordisx-native-menu-label')
      label.textContent = this.text(snapshot, action.label, 'menu.label', sites)
      row.append(label)
      item.append(row)
      item.addEventListener('pointermove', () => item.focus())
      const activate = (): void => {
        control.click()
        const context = this.invocationContext(snapshot, action)
        const operation = action.command !== undefined
          ? this.commands.executeFor(
            snapshot.owner,
            action.command,
            `${snapshot.surface}:${snapshot.qualifiedId}:menu`,
            {
              pointId: snapshot.surface,
              contributionId: snapshot.qualifiedId,
              ...(context === undefined ? {} : { context }),
            },
          )
          : action.route !== undefined
          ? this.routes.navigateFromSurface(snapshot.owner, action.route, snapshot.surface, snapshot.qualifiedId)
          : Promise.reject(new Error('surface menu item has no activation'))
        void operation.catch(error => {
          item.dataset.error = error instanceof Error ? error.message : String(error)
          this.schedule(true)
        })
      }
      item.addEventListener('click', event => {
        event.stopPropagation()
        activate()
      })
      item.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        event.stopPropagation()
        activate()
      })
      root.append(item)
    }
  }

  protected renderEnvironment(
    root: HTMLElement,
    snapshots: readonly SurfaceContributionSnapshot[],
    sites: Set<string>,
  ): void {
    root.replaceChildren()
    const panelActions = snapshots.filter(item => item.surface === 'environment.panel.header-actions')
    const sections = snapshots.filter(item => item.surface === 'environment.panel.sections')
    const appendHeader = (
      panel: HTMLElement,
      titleText: string,
      actions: readonly { snapshot: SurfaceContributionSnapshot; path: string }[],
    ): void => {
      const header = create(this.document, 'header', 'cordisx-env-header')
      const title = create(this.document, 'span', 'cordisx-env-title')
      title.textContent = titleText
      header.append(title)
      if (actions.length > 0) {
        const actionGroup = create(this.document, 'div', 'cordisx-env-header-actions')
        for (const { snapshot, path } of actions) {
          actionGroup.append(this.button(snapshot, snapshot.item as CordisXStructuredAction, path, sites, 'shortcut'))
        }
        header.append(actionGroup)
      }
      panel.append(header)
    }
    if (sections.length === 0 && panelActions.length > 0) {
      const panel = create(this.document, 'section', 'cordisx-env-section')
      panel.setAttribute('role', 'presentation')
      appendHeader(panel, 'CordisX', panelActions.map(snapshot => ({ snapshot, path: 'header' })))
      root.append(panel)
      return
    }
    for (const [sectionIndex, sectionSnapshot] of sections.entries()) {
      const section = sectionSnapshot.item as {
        sectionId: string
        title: CordisXLocalizedText
        description?: CordisXLocalizedText
      }
      const panel = create(this.document, 'section', 'cordisx-env-section')
      panel.setAttribute('role', 'presentation')
      const sectionActions = snapshots.filter(item =>
        item.surface === 'environment.section.actions'
        && (item.item as { sectionId: string }).sectionId === section.sectionId
      )
      appendHeader(panel, this.text(sectionSnapshot, section.title, 'title', sites), [
        ...(sectionIndex === 0 ? panelActions.map(snapshot => ({ snapshot, path: 'header' })) : []),
        ...sectionActions.map(snapshot => ({ snapshot, path: 'section-action' })),
      ])
      const content = create(this.document, 'div', 'cordisx-env-content')
      if (section.description !== undefined) {
        const description = create(this.document, 'p', 'cordisx-env-description')
        description.textContent = this.text(sectionSnapshot, section.description, 'description', sites)
        content.append(description)
      }
      for (
        const rowSnapshot of snapshots.filter(item =>
          item.surface === 'environment.section.rows'
          && (item.item as { sectionId: string }).sectionId === section.sectionId
        )
      ) {
        const rowData = rowSnapshot.item as {
          rowId: string
          label: CordisXLocalizedText
          value?: CordisXLocalizedText | string | number | boolean | null
          status?: string
        }
        const row = create(this.document, 'div', 'cordisx-env-row')
        if (rowData.status !== undefined) {
          const leading = create(this.document, 'span', 'cordisx-env-row-leading')
          leading.append(createHostSurfaceIcon(this.document, rowData.status))
          row.append(leading)
        }
        const label = create(this.document, 'span', 'cordisx-env-row-label')
        const labelCopy = create(this.document, 'span', 'cordisx-env-row-copy')
        labelCopy.textContent = this.text(rowSnapshot, rowData.label, 'label', sites)
        label.append(labelCopy)
        row.append(label)
        if (rowData.value !== undefined) {
          const value = create(this.document, 'span', 'cordisx-env-row-value')
          value.textContent = typeof rowData.value === 'object' && rowData.value !== null
            ? this.text(rowSnapshot, rowData.value, 'value', sites)
            : String(rowData.value)
          row.append(value)
        }
        const rowActions = snapshots.filter(item =>
          item.surface === 'environment.row.trailing-actions'
          && (item.item as { rowId: string }).rowId === rowData.rowId
        )
        if (rowActions.length > 0) {
          const actionGroup = create(this.document, 'div', 'cordisx-env-row-actions')
          for (const actionSnapshot of rowActions) {
            actionGroup.append(
              this.button(
                actionSnapshot,
                actionSnapshot.item as CordisXStructuredAction,
                'trailing',
                sites,
                'shortcut',
              ),
            )
          }
          row.append(actionGroup)
        }
        content.append(row)
      }
      panel.append(content)
      root.append(panel)
    }
  }
}

export { StructuredSurfaceInteractions }
