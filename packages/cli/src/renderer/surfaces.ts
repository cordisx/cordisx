import { Context, Service, type Effect } from '@deepseek-ai/cordis'
import {
  CORDISX_IMPLEMENTED_SURFACE_NAMES,
  CORDISX_SURFACE_NAMES,
  type CordisXCommandReference,
  type CordisXContributionHandle,
  type CordisXContributionOptions,
  type CordisXContributionPresentationOptions,
  type CordisXDisabledState,
  type CordisXExtensionPointCurrentContextState,
  type CordisXEnvironmentRow,
  type CordisXEnvironmentRowAction,
  type CordisXEnvironmentSection,
  type CordisXEnvironmentSectionAction,
  type CordisXIconToken,
  type CordisXNavigationItem,
  type CordisXManagerSettingsTabItem,
  type CordisXLocalizedText,
  type CordisXSlots,
  type CordisXStructuredAction,
  type CordisXSurfaceMap,
  type CordisXSurfaceName,
  type CordisXTabItem,
  type CordisXPresenterItem,
  type CordisXToolbarItem,
  type CordisXWhen,
} from '../contracts.js'
import { ownerFromContext, qualifyOwnedId } from './ownership.js'
import {
  generationVisibilityFromContext,
  type GenerationVisibilityCoordinator,
  type PluginGenerationEffectIdentity,
  type PluginGenerationView,
} from './generation-visibility.js'
import type { ExtensionPointAccessResolver } from './extension-points.js'
import type { PluginConsoleAspect } from './plugin-console.js'
import {
  HostContextStore,
  ICON_TOKEN_PATTERN,
  assertWhenExpression,
  assertLocalId,
  assertLocalizedText,
  assertReference,
  evaluateWhen,
  immutableSnapshot,
  whenContextKeys,
  type CordisXContextValues,
} from './validation.js'

export const CORDISX_HOST_ICON_TOKENS = [
  'host:analytics',
  'host:back',
  'host:close',
  'host:error',
  'host:files',
  'host:history',
  'host:info',
  'host:layers',
  'host:more',
  'host:open',
  'host:refresh',
  'host:review',
  'host:settings',
  'host:success',
  'host:warning',
] as const satisfies readonly CordisXIconToken[]

interface SurfaceRecord {
  readonly sequence: number
  readonly owner: string
  readonly qualifiedId: string
  readonly generation: PluginGenerationEffectIdentity
  readonly candidateView?: PluginGenerationView
  readonly renderToken: object
  options: CordisXContributionOptions
  item: unknown
  validationError?: string
  rendered: boolean
}

export interface SurfaceContributionSnapshot {
  readonly owner: string
  readonly id: string
  readonly qualifiedId: string
  readonly surface: string
  readonly group: string
  readonly order: number
  readonly item: unknown
  readonly visible: boolean
  readonly authorized: boolean
  readonly pointPolicy: 'inherit' | 'allow' | 'deny'
  readonly effectivePointPolicy: 'allow' | 'deny'
  readonly pointPolicyReason?: string
  readonly disabled: boolean
  readonly disabledReason?: CordisXLocalizedText
  readonly valid: boolean
  readonly pending: boolean
  readonly rendered: boolean
  readonly error?: string
  readonly availabilityCode?: string
  readonly availabilityDetail?: string
  readonly currentContext: CordisXExtensionPointCurrentContextState
}

export interface SurfaceAnchorCurrentContext {
  readonly id: string
  readonly placements: readonly ('before' | 'after' | 'menu')[]
  readonly state: CordisXExtensionPointCurrentContextState
  readonly code?: string
  readonly detail?: CordisXLocalizedText
}

export interface SurfaceCurrentContextSnapshot {
  readonly surface: string
  readonly state: CordisXExtensionPointCurrentContextState
  readonly code?: string
  readonly detail?: CordisXLocalizedText
  readonly anchors?: readonly SurfaceAnchorCurrentContext[]
}

/** @deprecated Runtime context replaced the overloaded availability axis. */
export type SurfaceAvailabilitySnapshot = SurfaceCurrentContextSnapshot

export interface SurfaceResolvers {
  command(owner: string, reference: CordisXCommandReference, view?: PluginGenerationView): boolean
  route(owner: string, id: string, view?: PluginGenerationView): boolean
  managerSettingsRoute?(owner: string, id: string, view?: PluginGenerationView): Readonly<{
    state: 'available' | 'pending' | 'invalid'
    detail?: string
  }>
}

function assertKeys(value: object, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find(key => !allowed.includes(key))
  if (unknown !== undefined) throw new Error(`${label} has unknown field ${unknown}`)
}

function assertIcon(icon: CordisXIconToken | undefined, label: string): void {
  if (icon === undefined) return
  if (!ICON_TOKEN_PATTERN.test(icon)) throw new Error(`${label} has an invalid host icon token`)
  if (!(CORDISX_HOST_ICON_TOKENS as readonly string[]).includes(icon)) throw new Error(`${label} uses unknown host icon token ${icon}`)
}

function assertCommand(reference: CordisXCommandReference, label: string): void {
  if (reference === null || typeof reference !== 'object') throw new Error(`${label} requires a command reference`)
  assertReference(reference.id, `${label} command id`)
  assertKeys(reference, ['id', 'arguments'], `${label} command`)
}

function assertRoute(reference: { readonly id: string; readonly params?: Readonly<Record<string, unknown>> }, label: string): void {
  if (reference === null || typeof reference !== 'object') throw new Error(`${label} requires a route reference`)
  assertReference(reference.id, `${label} route id`)
  assertKeys(reference, ['id', 'params'], `${label} route`)
}

function assertAction(action: CordisXStructuredAction, label: string): void {
  assertLocalizedText(action.label, `${label} label`)
  if (action.ariaLabel !== undefined) assertLocalizedText(action.ariaLabel, `${label} ariaLabel`)
  assertIcon(action.icon, label)
  if (action.command === undefined && action.route === undefined) throw new Error(`${label} requires a command or route reference`)
  if (action.command !== undefined) assertCommand(action.command, label)
  if (action.route !== undefined) assertRoute(action.route, label)
  if (action.routeBehavior !== undefined && !['navigate', 'toggle'].includes(action.routeBehavior)) {
    throw new Error(`${label} routeBehavior is invalid`)
  }
  if (action.routeBehavior !== undefined && action.route === undefined) {
    throw new Error(`${label} routeBehavior requires a route reference`)
  }
  if (action.routeBehavior === 'toggle' && action.command !== undefined) {
    throw new Error(`${label} route toggle cannot also reference a command`)
  }
}

function assertDisabled(disabled: CordisXDisabledState | undefined): void {
  if (disabled === undefined) return
  if (typeof disabled.value !== 'boolean') throw new Error('disabled.value must be a boolean')
  assertKeys(disabled, ['value', 'reason'], 'disabled')
  if (disabled.reason !== undefined) assertLocalizedText(disabled.reason, 'disabled reason')
}

function assertPresentationOptions(
  surface: CordisXSurfaceName,
  options: CordisXContributionPresentationOptions,
): void {
  assertKeys(options, ['group', 'order', 'when', 'disabled'], 'surface contribution presentation options')
  if (surface === 'manager.settings.tabs' && options.group !== undefined) {
    throw new Error('manager.settings.tabs does not accept a contribution group')
  }
  if (options.group !== undefined) assertLocalId(options.group, 'surface contribution group')
  if (options.order !== undefined && (!Number.isInteger(options.order) || options.order < -100000 || options.order > 100000)) {
    throw new Error('surface contribution order is invalid')
  }
  assertWhenExpression(options.when)
  assertDisabled(options.disabled)
}

function validateItem(surface: CordisXSurfaceName, item: unknown): unknown {
  const snapshot = immutableSnapshot(item)
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error(`surface ${surface} requires a structured object item`)
  }
  if (surface === 'sidebar.footer.before-control'
    || surface === 'sidebar.footer.after-control'
    || surface === 'sidebar.footer.menu'
    || surface === 'sidebar.account.menu'
    || surface === 'environment.panel.header-actions'
    || surface === 'sidebar.workspace.menu'
    || surface === 'sidebar.session.actions'
    || surface === 'sidebar.session.menu'
    || surface === 'session.header.actions'
    || surface === 'session.message.actions'
    || surface === 'session.tool.actions'
    || surface === 'composer.command-menu.items'
    || surface === 'panel.right.header-actions'
    || surface === 'panel.bottom.header-actions') {
    assertKeys(snapshot, ['label', 'ariaLabel', 'icon', 'command', 'route', 'routeBehavior'], surface)
    assertAction(snapshot as CordisXStructuredAction, surface)
  } else if (surface === 'sidebar.navigation.items') {
    const navigation = snapshot as CordisXNavigationItem
    assertKeys(snapshot, ['label', 'description', 'icon', 'command', 'route', 'actions'], 'navigation item')
    assertLocalizedText(navigation.label, 'navigation label')
    if (navigation.description !== undefined) assertLocalizedText(navigation.description, 'navigation description')
    assertIcon(navigation.icon, 'navigation item')
    if (navigation.command === undefined && navigation.route === undefined) {
      throw new Error('navigation item requires a command or route')
    }
    if (navigation.command !== undefined) assertCommand(navigation.command, 'navigation item')
    if (navigation.route !== undefined) {
      assertKeys(navigation.route, ['id', 'params'], 'navigation route')
      assertReference(navigation.route.id, 'navigation route id')
    }
    for (const action of navigation.actions ?? []) {
      assertKeys(action, ['id', 'label', 'ariaLabel', 'icon', 'command', 'when', 'disabled'], 'navigation action')
      assertLocalId(action.id, 'navigation action id')
      assertAction(action, 'navigation action')
      assertWhenExpression(action.when)
      assertDisabled(action.disabled)
    }
  } else if (surface === 'workspace.toolbar.items' || surface === 'composer.toolbar.items') {
    const toolbar = snapshot as CordisXToolbarItem
    assertKeys(snapshot, ['label', 'ariaLabel', 'icon', 'command', 'route', 'routeBehavior', 'anchor', 'placement'], 'toolbar item')
    assertAction(toolbar, 'toolbar item')
    if (surface === 'composer.toolbar.items') {
      if (!['leading', 'model', 'submit'].includes(toolbar.anchor)) throw new Error('composer toolbar anchor is invalid')
    } else assertLocalId(toolbar.anchor, 'toolbar anchor')
    if (!['before', 'after', 'menu'].includes(toolbar.placement)) throw new Error('toolbar placement is invalid')
  } else if (surface === 'session.tabs' || surface === 'panel.right.tabs' || surface === 'panel.bottom.tabs') {
    const tab = snapshot as CordisXTabItem
    assertKeys(snapshot, ['id', 'title', 'icon', 'route', 'badge', 'order', 'when'], 'tab item')
    assertLocalId(tab.id, 'tab id')
    assertLocalizedText(tab.title, 'tab title')
    assertIcon(tab.icon, 'tab item')
    assertRoute(tab.route, 'tab item')
    if (tab.badge !== undefined && typeof tab.badge === 'object') assertLocalizedText(tab.badge, 'tab badge')
    if (tab.order !== undefined && (!Number.isInteger(tab.order) || tab.order < -100000 || tab.order > 100000)) throw new Error('tab order is invalid')
    assertWhenExpression(tab.when)
  } else if (surface === 'session.banner.items'
    || surface === 'session.turn.footer'
    || surface === 'composer.dock.above'
    || surface === 'composer.dock.below') {
    const presenter = snapshot as CordisXPresenterItem
    assertKeys(snapshot, ['kind', 'text', 'detail', 'icon', 'tone', 'command', 'route', 'progress'], 'presenter item')
    if (!['banner', 'status', 'chip', 'progress'].includes(presenter.kind)) throw new Error('presenter kind is invalid')
    assertLocalizedText(presenter.text, 'presenter text')
    if (presenter.detail !== undefined) assertLocalizedText(presenter.detail, 'presenter detail')
    assertIcon(presenter.icon, 'presenter item')
    if (presenter.tone !== undefined && !['neutral', 'info', 'success', 'warning', 'error'].includes(presenter.tone)) throw new Error('presenter tone is invalid')
    if (presenter.command !== undefined) assertCommand(presenter.command, 'presenter item')
    if (presenter.route !== undefined) assertRoute(presenter.route, 'presenter item')
    if (presenter.kind === 'progress') {
      if (presenter.progress === undefined || !Number.isFinite(presenter.progress.current) || !Number.isFinite(presenter.progress.total)
        || presenter.progress.current < 0 || presenter.progress.total <= 0) throw new Error('progress presenter requires finite current/total values')
    } else if (presenter.progress !== undefined) throw new Error('progress values require a progress presenter')
  } else if (surface === 'manager.settings.tabs') {
    const tab = snapshot as CordisXManagerSettingsTabItem
    assertKeys(snapshot, ['title', 'icon', 'route'], 'manager settings tab')
    assertLocalizedText(tab.title, 'manager settings tab title')
    if (tab.icon === undefined) throw new Error('manager settings tab requires a host icon token')
    assertIcon(tab.icon, 'manager settings tab')
    if (tab.route === null || typeof tab.route !== 'object') throw new Error('manager settings tab requires a route reference')
    assertKeys(tab.route, ['id', 'params'], 'manager settings tab route')
    assertLocalId(tab.route.id, 'manager settings tab route id')
  } else if (surface === 'environment.panel.sections') {
    const section = snapshot as CordisXEnvironmentSection
    assertKeys(snapshot, ['sectionId', 'title', 'description', 'icon'], 'environment section')
    assertLocalId(section.sectionId, 'environment section id')
    assertLocalizedText(section.title, 'environment section title')
    if (section.description !== undefined) assertLocalizedText(section.description, 'environment section description')
    assertIcon(section.icon, 'environment section')
  } else if (surface === 'environment.section.actions') {
    const action = snapshot as CordisXEnvironmentSectionAction
    assertKeys(snapshot, ['sectionId', 'label', 'ariaLabel', 'icon', 'command'], 'environment section action')
    assertReference(action.sectionId, 'environment section target')
    assertAction(action, 'environment section action')
  } else if (surface === 'environment.section.rows') {
    const row = snapshot as CordisXEnvironmentRow
    assertKeys(snapshot, ['sectionId', 'rowId', 'label', 'value', 'description', 'status'], 'environment row')
    assertReference(row.sectionId, 'environment row section target')
    assertLocalId(row.rowId, 'environment row id')
    assertLocalizedText(row.label, 'environment row label')
    if (row.description !== undefined) assertLocalizedText(row.description, 'environment row description')
    if (row.value !== undefined && typeof row.value === 'object') assertLocalizedText(row.value, 'environment row value')
    assertIcon(row.status, 'environment row status')
  } else {
    const action = snapshot as CordisXEnvironmentRowAction
    assertKeys(snapshot, ['rowId', 'label', 'ariaLabel', 'icon', 'command'], 'environment row action')
    assertReference(action.rowId, 'environment row target')
    assertAction(action, 'environment row action')
  }
  return snapshot
}

export class SurfaceRegistry {
  private readonly records = new Map<string, SurfaceRecord>()
  private readonly listeners = new Set<() => void>()
  private readonly declared = new Set<string>(CORDISX_IMPLEMENTED_SURFACE_NAMES)
  private readonly surfaceAnchors = new Map<string, Map<string, ReadonlySet<string>>>()
  private readonly currentContext = new Map<string, SurfaceCurrentContextSnapshot>()
  private nextSequence = 0
  private disposed = false
  private readonly disconnectVisibility: (() => void) | undefined
  private resolvers: SurfaceResolvers = { command: () => false, route: () => false }
  private access: ExtensionPointAccessResolver | undefined

  constructor(
    private readonly contexts: HostContextStore,
    private readonly visibility?: GenerationVisibilityCoordinator,
  ) {
    this.disconnectVisibility = visibility?.connect({ notify: () => this.notify() })
  }

  setResolvers(resolvers: SurfaceResolvers): void {
    this.resolvers = resolvers
    this.notify()
  }

  setAccessResolver(access: ExtensionPointAccessResolver): void {
    this.access = access
    this.notify()
  }

  invalidatePointPolicies(): void {
    this.notify()
  }

  declareSurface(name: string): () => void {
    if (this.declared.has(name)) throw new Error(`surface ${name} is already declared`)
    this.declared.add(name)
    this.notify()
    return () => {
      this.declared.delete(name)
      this.notify()
    }
  }

  setToolbarAnchors(anchors: readonly string[]): void {
    this.setSurfaceAnchors('workspace.toolbar.items', anchors.map(id => ({ id, placements: ['before', 'after', 'menu'] as const })))
  }

  setSurfaceAnchors(surface: string, anchors: readonly { id: string; placements: readonly ('before' | 'after' | 'menu')[] }[]): void {
    const next = new Map(anchors.map(anchor => [anchor.id, new Set(anchor.placements) as ReadonlySet<string>]))
    const previous = this.surfaceAnchors.get(surface)
    if (previous?.size === next.size && [...next].every(([id, placements]) => {
      const existing = previous.get(id)
      return existing?.size === placements.size && [...placements].every(placement => existing.has(placement))
    })) return
    this.surfaceAnchors.set(surface, next)
    this.notify()
  }

  setCurrentContext(items: readonly SurfaceCurrentContextSnapshot[]): void {
    const next = new Map(items.map(item => [item.surface, immutableSnapshot(item)]))
    if (JSON.stringify([...this.currentContext]) === JSON.stringify([...next])) return
    this.currentContext.clear()
    for (const [surface, item] of next) this.currentContext.set(surface, item)
    this.notify()
  }

  /** @deprecated Use setCurrentContext. */
  setAvailability(items: readonly SurfaceCurrentContextSnapshot[]): void { this.setCurrentContext(items) }

  currentContextSnapshot(): readonly SurfaceCurrentContextSnapshot[] {
    return [...this.currentContext.values()].sort((left, right) => left.surface < right.surface ? -1 : left.surface > right.surface ? 1 : 0)
  }

  /** @deprecated Use currentContextSnapshot. */
  availabilitySnapshot(): readonly SurfaceCurrentContextSnapshot[] { return this.currentContextSnapshot() }

  isDeclared(name: string): boolean {
    return this.declared.has(name)
  }

  register<Name extends CordisXSurfaceName>(
    ownerOrContext: string | Context,
    options: CordisXContributionOptions<Name>,
    item: CordisXSurfaceMap[Name],
  ): CordisXContributionHandle<CordisXSurfaceMap[Name]> {
    if (this.disposed) throw new Error('CordisX surface registry is disposed')
    const owner = typeof ownerOrContext === 'string' ? ownerOrContext : ownerFromContext(ownerOrContext)
    const generation: PluginGenerationEffectIdentity = typeof ownerOrContext === 'string'
      ? Object.freeze({ pluginId: owner })
      : this.visibility?.effect(ownerOrContext) ?? Object.freeze({ pluginId: owner })
    const candidateView = typeof ownerOrContext === 'string' || generation.transactionId === undefined
      ? undefined
      : this.visibility?.view(ownerOrContext)
    assertLocalId(owner, 'surface owner')
    assertKeys(options, ['name', 'id', 'group', 'order', 'when', 'disabled'], 'surface contribution options')
    assertLocalId(options.id, 'surface contribution id')
    assertPresentationOptions(options.name, {
      ...(options.group === undefined ? {} : { group: options.group }),
      ...(options.order === undefined ? {} : { order: options.order }),
      ...(options.when === undefined ? {} : { when: options.when }),
      ...(options.disabled === undefined ? {} : { disabled: options.disabled }),
    })
    const qualifiedId = qualifyOwnedId(owner, options.id)
    const key = `${options.name}\u0000${qualifiedId}\u0000${generation.moduleGeneration ?? 'host'}`
    if (this.records.has(key)) throw new Error(`surface contribution ${options.name}/${qualifiedId} is already registered for this generation`)
    let snapshot: unknown
    let validationError: string | undefined
    try {
      snapshot = validateItem(options.name, item)
    } catch (error) {
      snapshot = undefined
      validationError = error instanceof Error ? error.message : String(error)
    }
    const record: SurfaceRecord = {
      sequence: this.nextSequence++,
      owner,
      qualifiedId,
      generation,
      ...(candidateView === undefined ? {} : { candidateView }),
      renderToken: Object.freeze({}),
      options: immutableSnapshot(options),
      item: snapshot,
      ...(validationError === undefined ? {} : { validationError }),
      rendered: false,
    }
    this.records.set(key, record)
    if (this.visibility?.visible(generation) !== false) this.notify()
    let active = true
    const dispose = (): void => {
      if (!active) return
      active = false
      this.records.delete(key)
      if (this.visibility?.visible(generation) !== false) this.notify()
    }
    const handle = dispose as CordisXContributionHandle<CordisXSurfaceMap[Name]>
    handle.dispose = dispose
    handle.update = (next): void => {
      if (!active) throw new Error(`surface contribution ${qualifiedId} is disposed`)
      this.visibility?.assertCallable(generation, candidateView)
      try {
        record.item = validateItem(options.name, next)
        delete record.validationError
      } catch (error) {
        record.item = undefined
        record.validationError = error instanceof Error ? error.message : String(error)
      }
      if (this.visibility?.visible(generation) !== false) this.notify()
    }
    handle.updateOptions = (next): void => {
      if (!active) throw new Error(`surface contribution ${qualifiedId} is disposed`)
      this.visibility?.assertCallable(generation, candidateView)
      assertPresentationOptions(options.name, next)
      record.options = immutableSnapshot({ name: options.name, id: options.id, ...next })
      if (this.visibility?.visible(generation) !== false) this.notify()
    }
    return handle
  }

  renderToken(surface: string, qualifiedId: string): object | undefined {
    return [...this.records.values()].find(record => record.options.name === surface
      && record.qualifiedId === qualifiedId
      && (this.visibility?.visible(record.generation) ?? true))?.renderToken
  }

  markRendered(surface: string, qualifiedId: string, renderToken: object, rendered: boolean): void {
    const record = [...this.records.values()].find(item => item.options.name === surface
      && item.qualifiedId === qualifiedId
      && item.renderToken === renderToken
      && (this.visibility?.visible(item.generation) ?? true))
    if (record === undefined || record.rendered === rendered) return
    record.rendered = rendered
    this.notify()
  }

  snapshot(view?: PluginGenerationView): readonly SurfaceContributionSnapshot[] {
    const contexts = this.contexts.getSnapshot()
    const knownKeys = new Set(Object.keys(contexts))
    const sections = new Set<string>()
    const rows = new Set<string>()
    const records = [...this.records.values()].filter(record => this.visibility?.visible(record.generation, view) ?? true)
    for (const record of records) {
      if (record.options.name === 'environment.panel.sections' && record.item !== undefined) {
        sections.add(qualifyOwnedId(record.owner, (record.item as CordisXEnvironmentSection).sectionId))
      }
      if (record.options.name === 'environment.section.rows' && record.item !== undefined) {
        rows.add(qualifyOwnedId(record.owner, (record.item as CordisXEnvironmentRow).rowId))
      }
    }
    return records
      .sort((left, right) => {
        return (left.options.group ?? 'default').localeCompare(right.options.group ?? 'default')
          || (left.options.order ?? 0) - (right.options.order ?? 0)
          || left.qualifiedId.localeCompare(right.qualifiedId)
          || left.sequence - right.sequence
      })
      .map((record) => {
        let error = record.validationError
        let pending = false
        const item = record.item as Record<string, unknown> | undefined
        const pointAccess = this.access?.decision(record.owner, record.options.name, 'surface', view ?? record.candidateView)
          ?? { policy: 'inherit' as const, effectivePolicy: 'allow' as const, authorized: true }
        const toolbarItem = item as unknown as CordisXToolbarItem | undefined
        const anchorSupport = toolbarItem !== undefined && (record.options.name === 'workspace.toolbar.items' || record.options.name === 'composer.toolbar.items')
          ? this.access?.surfaceAnchorSupport(record.options.name, toolbarItem.anchor)
          : undefined
        if (error === undefined && !this.declared.has(record.options.name)) error = `surface ${record.options.name} is not declared by the host`
        const unknownWhen = whenContextKeys(record.options.when).find(key => !knownKeys.has(key))
        if (error === undefined && unknownWhen !== undefined) error = `when context key ${unknownWhen} is not declared by the host`
        if (error === undefined && item !== undefined) {
          const command = item.command as CordisXCommandReference | undefined
          const route = item.route as { id: string } | undefined
          const resolutionView = view ?? record.candidateView
          if (command !== undefined && !this.resolvers.command(record.owner, command, resolutionView)) error = `command ${command.id} is not available`
          else if (command === undefined && route !== undefined && record.options.name === 'manager.settings.tabs') {
            const resolution = this.resolvers.managerSettingsRoute?.(record.owner, route.id, resolutionView)
              ?? (this.resolvers.route(record.owner, route.id, resolutionView)
                ? { state: 'available' as const }
                : { state: 'pending' as const, detail: `route ${route.id} is not available` })
            if (resolution.state === 'pending') pending = true
            if (resolution.state === 'invalid') error = resolution.detail ?? `route ${route.id} is incompatible with manager settings`
          } else if (command === undefined && route !== undefined && !this.resolvers.route(record.owner, route.id, resolutionView)) error = `route ${route.id} is not available`
          const actions = item.actions as readonly { command: CordisXCommandReference }[] | undefined
          const missingAction = actions?.find(action => !this.resolvers.command(record.owner, action.command, resolutionView))
          if (error === undefined && missingAction !== undefined) error = `command ${missingAction.command.id} is not available`
          const actionWithUnknownWhen = (item.actions as readonly { when?: CordisXWhen }[] | undefined)
            ?.find(action => whenContextKeys(action.when).some(key => !knownKeys.has(key)))
          const unknownActionKey = actionWithUnknownWhen === undefined
            ? undefined
            : whenContextKeys(actionWithUnknownWhen.when).find(key => !knownKeys.has(key))
          if (error === undefined && unknownActionKey !== undefined) error = `when context key ${unknownActionKey} is not declared by the host`
          if (record.options.name === 'workspace.toolbar.items' || record.options.name === 'composer.toolbar.items') {
            const anchored = item as unknown as CordisXToolbarItem
            if (!this.surfaceAnchors.get(record.options.name)?.get(anchored.anchor)?.has(anchored.placement)) pending = true
          }
          if (record.options.name === 'environment.section.actions' || record.options.name === 'environment.section.rows') {
            const target = qualifyOwnedId(record.owner, String(item.sectionId))
            if (!sections.has(target)) pending = true
          }
          if (record.options.name === 'environment.row.trailing-actions') {
            const target = qualifyOwnedId(record.owner, String(item.rowId))
            if (!rows.has(target)) pending = true
          }
        }
        const currentContext = this.currentContext.get(record.options.name)
        const currentAnchor = toolbarItem === undefined ? undefined : currentContext?.anchors?.find(anchor => anchor.id === toolbarItem.anchor)
        if (this.access !== undefined && currentContext !== undefined && currentContext.state !== 'active') pending = true
        if (currentAnchor !== undefined && currentAnchor.state !== 'active') pending = true
        const authorized = pointAccess.authorized && anchorSupport?.supported !== false
        const contextDetail = currentAnchor?.detail ?? currentContext?.detail
        const contextCode = currentAnchor?.code ?? currentContext?.code
        const accessReason = anchorSupport?.reason ?? pointAccess.reason
        return {
          owner: record.owner,
          id: record.options.id,
          qualifiedId: record.qualifiedId,
          surface: record.options.name,
          group: record.options.group ?? 'default',
          order: record.options.order ?? 0,
          item: record.item,
          visible: error === undefined && evaluateWhen(record.options.when, contexts),
          authorized,
          pointPolicy: pointAccess.policy,
          effectivePointPolicy: pointAccess.effectivePolicy,
          ...(accessReason === undefined ? {} : { pointPolicyReason: accessReason }),
          disabled: record.options.disabled?.value ?? false,
          ...(record.options.disabled?.reason === undefined ? {} : { disabledReason: record.options.disabled.reason }),
          valid: error === undefined,
          pending,
          currentContext: currentAnchor?.state ?? currentContext?.state ?? 'not-mounted',
          rendered: record.rendered,
          ...(error === undefined ? {} : { error }),
          ...(contextCode === undefined ? {} : { availabilityCode: contextCode }),
          ...(contextDetail === undefined ? {} : { availabilityDetail: contextDetail.fallback ?? contextDetail.key }),
        }
      })
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
    this.declared.clear()
    this.surfaceAnchors.clear()
    this.currentContext.clear()
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

export class CordisXSlotService extends Service implements CordisXSlots {
  readonly registry: SurfaceRegistry
  readonly contexts: HostContextStore
  private readonly console: PluginConsoleAspect | undefined

  constructor(ctx: Context, input?: SurfaceRegistry | { readonly registry?: SurfaceRegistry; readonly console: PluginConsoleAspect }) {
    super(ctx, 'slots')
    const registry = input instanceof SurfaceRegistry ? input : input?.registry
    this.console = input instanceof SurfaceRegistry ? undefined : input?.console
    this.contexts = new HostContextStore()
    this.registry = registry ?? new SurfaceRegistry(this.contexts, generationVisibilityFromContext(ctx))
    ctx.effect(() => () => {
      this.registry.dispose()
      this.contexts.dispose()
    }, 'cordisx: structured surface registry')
  }

  inject<Name extends CordisXSurfaceName>(name: Name, setup: () => Effect): ReturnType<CordisXSlots['inject']> {
    if (!this.registry.isDeclared(name)) {
      throw new Error(`surface ${JSON.stringify(name)} is not declared; direct-DOM slots were removed in structured UI v1`)
    }
    const token = this.console?.tokenFromContext(this.ctx)
    const scoped = token === undefined || this.console === undefined
      ? setup
      : () => this.console!.runInPluginContext(
          token,
          { trigger: { kind: 'registration', registrationId: `surface:${name}` } },
          setup,
        ) as Effect
    const register = (): ReturnType<CordisXSlots['inject']> => this.ctx.effect(scoped, `slots.inject(${JSON.stringify(name)})`)
    return token === undefined || this.console === undefined ? register() : this.console.runSync(token, 'slots.inject', { name }, register)
  }

  register<Name extends CordisXSurfaceName>(
    options: CordisXContributionOptions<Name>,
    item: CordisXSurfaceMap[Name],
  ): CordisXContributionHandle<CordisXSurfaceMap[Name]> {
    const token = this.console?.tokenFromContext(this.ctx)
    const register = (): CordisXContributionHandle<CordisXSurfaceMap[Name]> => this.registry.register(this.ctx, options, item)
    const handle = token === undefined || this.console === undefined
      ? register()
      : this.console.runSync(token, 'slots.register', { options, item }, register)
    if (token === undefined || this.console === undefined) {
      this.ctx.effect(() => handle, `slots.register(${JSON.stringify(options.name)}, ${JSON.stringify(options.id)})`)
      return handle
    }
    const console = this.console
    const dispose = (() => console.runCleanupSync(token, 'slots.dispose', { name: options.name, id: options.id }, handle.dispose)) as CordisXContributionHandle<CordisXSurfaceMap[Name]>
    dispose.dispose = dispose
    dispose.update = next => console.runSync(token, 'slots.update', { name: options.name, id: options.id, item: next }, () => handle.update(next))
    dispose.updateOptions = next => console.runSync(token, 'slots.updateOptions', { name: options.name, id: options.id, options: next }, () => handle.updateOptions(next))
    this.ctx.effect(() => dispose, `slots.register(${JSON.stringify(options.name)}, ${JSON.stringify(options.id)})`)
    return dispose
  }

  snapshot(): readonly SurfaceContributionSnapshot[] {
    const visibility = generationVisibilityFromContext(this.ctx)
    return this.registry.snapshot(visibility?.view(this.ctx))
  }

  subscribeInternal(listener: () => void): () => void {
    return this.registry.subscribe(listener)
  }

  setResolvers(resolvers: SurfaceResolvers): void {
    this.registry.setResolvers(resolvers)
  }

  setAccessResolver(access: ExtensionPointAccessResolver): void {
    this.registry.setAccessResolver(access)
  }

  invalidatePointPolicies(): void {
    this.registry.invalidatePointPolicies()
  }
}
