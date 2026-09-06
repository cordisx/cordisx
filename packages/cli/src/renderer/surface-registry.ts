import { Context, type Effect, Service } from '@deepseek-ai/cordis'
import {
  CORDISX_IMPLEMENTED_SURFACE_NAMES,
  CORDISX_SURFACE_NAMES,
  type CordisXCommandReference,
  type CordisXContributionHandle,
  type CordisXContributionOptions,
  type CordisXContributionPresentationOptions,
  type CordisXDisabledState,
  type CordisXEnvironmentRow,
  type CordisXEnvironmentRowAction,
  type CordisXEnvironmentSection,
  type CordisXEnvironmentSectionAction,
  type CordisXExtensionPointControlAuthorizationV1,
  type CordisXExtensionPointControlCandidateSnapshotV1,
  type CordisXExtensionPointControlClaimOptions,
  type CordisXExtensionPointControlDeclarationV1,
  type CordisXExtensionPointControlLease,
  type CordisXExtensionPointCurrentContextState,
  type CordisXIconToken,
  type CordisXLocalizedText,
  type CordisXManagerSettingsContentTabItem,
  type CordisXManagerSettingsNavigationItem,
  type CordisXNavigationAction,
  type CordisXNavigationCollectionAction,
  type CordisXNavigationCollectionItem,
  type CordisXNavigationCollectionItemV2,
  type CordisXNavigationCollectionItemV3,
  type CordisXNavigationCollectionLeadingVisual,
  type CordisXNavigationCollectionOptions,
  type CordisXNavigationCollectionOptionsV2,
  type CordisXNavigationCollectionOptionsV3,
  type CordisXNavigationCollectionRegistration,
  type CordisXNavigationCollectionSnapshot,
  type CordisXNavigationCollectionSnapshotV2,
  type CordisXNavigationCollectionSnapshotV3,
  type CordisXNavigationCollectionSource,
  type CordisXNavigationCollectionSourceV2,
  type CordisXNavigationCollectionSourceV3,
  type CordisXNavigationItem,
  type CordisXPresenterItem,
  type CordisXReasoningIntensityPresentation,
  type CordisXSessionBackdropPresentation,
  type CordisXSlots,
  type CordisXStructuredAction,
  type CordisXSurfaceMap,
  type CordisXSurfaceName,
  type CordisXTabItem,
  type CordisXToolbarItem,
  type CordisXTransientCanvasPresentation,
  type CordisXWhen,
} from '../contracts.js'
import { cloneRasterImageSnapshot } from './raster-image.js'
import { generationFromContext, ownerFromContext, qualifyOwnedId, sourceFromContext } from './ownership.js'
import {
  ControlledSurfaceCoordinator,
  type ControlledSurfaceGeneration,
  type ControlledSurfaceGroupChoice,
  type ControlledSurfaceManagerSnapshot,
  type ControlledSurfaceRegistrationHandle,
  normalizeControlledSurfaceDeclaration,
} from './controlled-surfaces.js'
import {
  type GenerationVisibilityCoordinator,
  generationVisibilityFromContext,
  type PluginGenerationEffectIdentity,
  type PluginGenerationParticipantTransition,
  type PluginGenerationView,
} from './generation-visibility.js'
import type { ExtensionPointAccessResolver } from './extension-points.js'
import type { PluginConsoleAspect } from './plugin-console.js'
import {
  assertLocalId,
  assertLocalizedText,
  assertReference,
  assertWhenExpression,
  type CordisXContextValues,
  evaluateWhen,
  HostContextStore,
  ICON_TOKEN_PATTERN,
  immutableSnapshot,
  whenContextKeys,
} from './validation.js'

import {
  assertControlOptions,
  assertKeys,
  assertPresentationOptions,
  type SurfaceContributionSnapshot,
  type SurfaceCurrentContextSnapshot,
  type SurfaceRecord,
  type SurfaceResolvers,
  validateItem,
} from './surface-validation.js'

export class SurfaceRegistry {
  private readonly records = new Map<string, SurfaceRecord>()
  private readonly listeners = new Set<() => void>()
  private readonly declared = new Set<string>(CORDISX_IMPLEMENTED_SURFACE_NAMES)
  private readonly surfaceAnchors = new Map<string, Map<string, ReadonlySet<string>>>()
  private readonly currentContext = new Map<string, SurfaceCurrentContextSnapshot>()
  private nextSequence = 0
  private notificationDepth = 0
  private notificationPending = false
  private disposed = false
  private readonly disconnectVisibility: (() => void) | undefined
  private resolvers: SurfaceResolvers = { command: () => false, route: () => false }
  private access: ExtensionPointAccessResolver | undefined
  private controls: ControlledSurfaceCoordinator | undefined
  private disconnectControls: (() => void) | undefined
  private readonly committedControlTransactions = new Map<
    string,
    Readonly<{ moduleGeneration: string; transactionId: string; transactionEpoch: string }>
  >()
  private preparedControlTransition:
    | Readonly<{
      transactionId: string
      transactionEpoch: string
      affectedPluginIds: readonly string[]
      after: PluginGenerationParticipantTransition['after']
      previous: ReadonlyMap<
        string,
        Readonly<{ moduleGeneration: string; transactionId: string; transactionEpoch: string }>
      >
      published: boolean
    }>
    | undefined

  constructor(
    private readonly contexts: HostContextStore,
    private readonly visibility?: GenerationVisibilityCoordinator,
  ) {
    this.disconnectVisibility = visibility?.connect({
      prepare: transition => {
        this.preparedControlTransition = Object.freeze({
          transactionId: transition.transactionId,
          transactionEpoch: transition.transactionEpoch,
          affectedPluginIds: transition.affectedPluginIds,
          after: transition.after,
          previous: new Map(this.committedControlTransactions),
          published: false,
        })
      },
      notify: () => {
        const prepared = this.preparedControlTransition
        const activeTransactionId = visibility.snapshot().transactionId
        if (prepared !== undefined && activeTransactionId === prepared.transactionId) {
          for (const pluginId of prepared.affectedPluginIds) {
            const plugin = prepared.after.plugins.find(item => item.id === pluginId)
            if (plugin === undefined) this.committedControlTransactions.delete(pluginId)
            else {this.committedControlTransactions.set(
                pluginId,
                Object.freeze({
                  moduleGeneration: plugin.moduleGeneration,
                  transactionId: prepared.transactionId,
                  transactionEpoch: prepared.transactionEpoch,
                }),
              )}
          }
          this.preparedControlTransition = Object.freeze({ ...prepared, published: true })
        } else if (prepared?.published === true) {
          this.committedControlTransactions.clear()
          for (const [pluginId, transaction] of prepared.previous) {
            this.committedControlTransactions.set(pluginId, transaction)
          }
          this.preparedControlTransition = undefined
        }
        this.controls?.invalidate()
        this.notify()
      },
    })
  }

  setResolvers(resolvers: SurfaceResolvers): void {
    this.resolvers = resolvers
    this.notify()
  }

  setAccessResolver(access: ExtensionPointAccessResolver): void {
    this.access = access
    if (this.controls === undefined) this.notify()
    else this.controls.invalidate()
  }

  setControlCoordinator(controls: ControlledSurfaceCoordinator): void {
    if (this.controls !== undefined) throw new Error('controlled surface coordinator is already installed')
    if (this.records.size > 0) {
      throw new Error('controlled surface coordinator must be installed before plugin registration')
    }
    this.controls = controls
    this.disconnectControls = controls.subscribe(() => this.notify())
    this.notify()
  }

  controlCoordinator(): ControlledSurfaceCoordinator | undefined {
    return this.controls
  }

  invalidatePointPolicies(): void {
    if (this.controls === undefined) this.notify()
    else this.controls.invalidate()
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
    this.setSurfaceAnchors(
      'workspace.toolbar.items',
      anchors.map(id => ({ id, placements: ['before', 'after', 'menu'] as const })),
    )
  }

  setSurfaceAnchors(
    surface: string,
    anchors: readonly { id: string; placements: readonly ('before' | 'after' | 'menu')[] }[],
  ): void {
    const next = new Map(anchors.map(anchor => [anchor.id, new Set(anchor.placements) as ReadonlySet<string>]))
    const previous = this.surfaceAnchors.get(surface)
    if (
      previous?.size === next.size && [...next].every(([id, placements]) => {
        const existing = previous.get(id)
        return existing?.size === placements.size && [...placements].every(placement => existing.has(placement))
      })
    ) return
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
  setAvailability(items: readonly SurfaceCurrentContextSnapshot[]): void {
    this.setCurrentContext(items)
  }

  currentContextSnapshot(): readonly SurfaceCurrentContextSnapshot[] {
    return [...this.currentContext.values()].sort((left, right) =>
      left.surface < right.surface ? -1 : left.surface > right.surface ? 1 : 0
    )
  }

  /** @deprecated Use currentContextSnapshot. */
  availabilitySnapshot(): readonly SurfaceCurrentContextSnapshot[] {
    return this.currentContextSnapshot()
  }

  isDeclared(name: string): boolean {
    return this.declared.has(name)
  }

  register<Name extends CordisXSurfaceName>(
    ownerOrContext: string | Context,
    options: CordisXContributionOptions<Name>,
    item: CordisXSurfaceMap[Name],
    isolatedBinding?: Readonly<{
      generation: PluginGenerationEffectIdentity
      candidateView?: PluginGenerationView
      source: string
      moduleGeneration: string
    }>,
  ): CordisXContributionHandle<CordisXSurfaceMap[Name]> {
    if (this.disposed) throw new Error('CordisX surface registry is disposed')
    const owner = typeof ownerOrContext === 'string' ? ownerOrContext : ownerFromContext(ownerOrContext)
    const generation: PluginGenerationEffectIdentity = isolatedBinding?.generation
      ?? (typeof ownerOrContext === 'string'
        ? Object.freeze({ pluginId: owner })
        : this.visibility?.effect(ownerOrContext) ?? Object.freeze({ pluginId: owner }))
    const candidateView = isolatedBinding?.candidateView
      ?? (typeof ownerOrContext === 'string' || generation.transactionId === undefined
        ? undefined
        : this.visibility?.view(ownerOrContext))
    assertLocalId(owner, 'surface owner')
    assertKeys(options, ['name', 'id', 'group', 'order', 'when', 'disabled', 'control'], 'surface contribution options')
    assertLocalId(options.id, 'surface contribution id')
    assertPresentationOptions(options.name, {
      ...(options.group === undefined ? {} : { group: options.group }),
      ...(options.order === undefined ? {} : { order: options.order }),
      ...(options.when === undefined ? {} : { when: options.when }),
      ...(options.disabled === undefined ? {} : { disabled: options.disabled }),
    })
    assertControlOptions(options.control)
    if (options.control !== undefined && (this.controls === undefined || !this.controls.hasPoint(options.name))) {
      throw new Error(`controlled surface runtime is unavailable for ${options.name}`)
    }
    const qualifiedId = qualifyOwnedId(owner, options.id)
    const key = `${options.name}\u0000${qualifiedId}\u0000${generation.moduleGeneration ?? 'host'}\u0000${
      generation.transactionId ?? ''
    }\u0000${generation.transactionEpoch ?? ''}`
    if (this.records.has(key)) {
      throw new Error(`surface contribution ${options.name}/${qualifiedId} is already registered for this generation`)
    }
    let snapshot: unknown
    let validationError: string | undefined
    try {
      snapshot = validateItem(options.name, item)
    } catch (error) {
      snapshot = undefined
      validationError = error instanceof Error ? error.message : String(error)
    }
    const source = isolatedBinding?.source
      ?? (typeof ownerOrContext === 'string' ? undefined : sourceFromContext(ownerOrContext))
    const controlOrigin = options.control === undefined ? 'legacy-structured' as const : 'explicit' as const
    const controlledPoint = this.controls?.hasPoint(options.name) === true
    const principalHandle = source === undefined || !controlledPoint
      ? undefined
      : this.controlPrincipal(source, owner, controlOrigin)
    const controlDeclaration = this.controls === undefined || source === undefined || !controlledPoint
      ? undefined
      : normalizeControlledSurfaceDeclaration({
        principalHandle: principalHandle!,
        source,
        pluginId: owner,
        pointId: options.name,
        contributionId: options.id,
        ...(options.order === undefined ? {} : { order: options.order }),
        ...(options.control === undefined ? {} : { control: options.control }),
      })
    const moduleGeneration = isolatedBinding?.moduleGeneration
      ?? (typeof ownerOrContext === 'string' ? undefined : generationFromContext(ownerOrContext))
    const controlGeneration: ControlledSurfaceGeneration | undefined = controlDeclaration === undefined
      ? undefined
      : Object.freeze({
        principalHandle: principalHandle!,
        principalOrigin: controlOrigin,
        source: source!,
        pluginId: owner,
        ...(moduleGeneration === undefined ? {} : { moduleGeneration }),
        ...(generation.transactionId === undefined
          ? {}
          : { transactionId: generation.transactionId, transactionEpoch: generation.transactionEpoch }),
        ...(candidateView === undefined ? {} : { visibilityView: candidateView }),
      })
    const controlHandle = controlDeclaration === undefined ? undefined : this.controls!.register({
      declaration: controlDeclaration,
      generation: controlGeneration!,
      presenter: snapshot,
      hostAccess: () => {
        const decision = this.access?.decision(owner, options.name, 'surface', candidateView)
        return decision === undefined
          ? Object.freeze({ authorized: true })
          : Object.freeze({
            authorized: decision.authorized,
            policy: decision.policy,
            ...(decision.reason === undefined ? {} : { reason: decision.reason }),
          })
      },
    })
    const controlLease = controlDeclaration === undefined || options.control === undefined
      ? undefined
      : this.controls!.createLease(controlDeclaration, controlGeneration!)
    const record: SurfaceRecord = {
      sequence: this.nextSequence++,
      owner,
      qualifiedId,
      generation,
      ...(candidateView === undefined ? {} : { candidateView }),
      renderToken: Object.freeze({}),
      ...(controlDeclaration === undefined ? {} : { controlDeclaration }),
      ...(controlGeneration === undefined ? {} : { controlGeneration }),
      ...(controlHandle === undefined ? {} : { controlHandle }),
      ...(controlLease === undefined ? {} : { controlLease }),
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
      record.controlHandle?.dispose()
      record.controlLease?.dispose()
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
        record.controlHandle?.updatePresenter(record.item)
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
      record.options = immutableSnapshot({
        name: options.name,
        id: options.id,
        ...(options.control === undefined ? {} : { control: options.control }),
        ...next,
      })
      if (this.visibility?.visible(generation) !== false) this.notify()
    }
    if (controlLease !== undefined) Object.defineProperty(handle, 'control', { value: controlLease, enumerable: true })
    return handle
  }

  renderToken(surface: string, qualifiedId: string): object | undefined {
    return [...this.records.values()].find(record =>
      record.options.name === surface
      && record.qualifiedId === qualifiedId
      && this.recordVisible(record)
    )?.renderToken
  }

  markRendered(surface: string, qualifiedId: string, renderToken: object, rendered: boolean): void {
    const record = [...this.records.values()].find(item =>
      item.options.name === surface
      && item.qualifiedId === qualifiedId
      && item.renderToken === renderToken
      && this.recordVisible(item)
    )
    if (record === undefined || record.rendered === rendered) return
    record.rendered = rendered
    this.notify()
  }

  snapshot(view?: PluginGenerationView): readonly SurfaceContributionSnapshot[] {
    const contexts = this.contexts.getSnapshot()
    const knownKeys = new Set(Object.keys(contexts))
    const sections = new Set<string>()
    const rows = new Set<string>()
    const records = [...this.records.values()].filter(record => this.recordVisible(record, view))
    const controlSnapshot = this.controls?.snapshot(view)
    const managerNavigationRoutes = new Map<string, string[]>()
    for (const record of records) {
      if (record.options.name === 'environment.panel.sections' && record.item !== undefined) {
        sections.add(qualifyOwnedId(record.owner, (record.item as CordisXEnvironmentSection).sectionId))
      }
      if (record.options.name === 'environment.section.rows' && record.item !== undefined) {
        rows.add(qualifyOwnedId(record.owner, (record.item as CordisXEnvironmentRow).rowId))
      }
      if (
        record.options.name === 'manager.settings.navigation-items'
        && record.validationError === undefined
        && record.item !== undefined
      ) {
        const routeId = (record.item as CordisXManagerSettingsNavigationItem).route.id
        const key = `${record.owner}\u0000${routeId}`
        const contributions = managerNavigationRoutes.get(key) ?? []
        contributions.push(record.qualifiedId)
        managerNavigationRoutes.set(key, contributions)
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
        if (error === undefined && record.options.name === 'manager.settings.navigation-items' && item !== undefined) {
          const routeId = (item as unknown as CordisXManagerSettingsNavigationItem).route.id
          const conflicts = managerNavigationRoutes.get(`${record.owner}\u0000${routeId}`)
          if (conflicts !== undefined && conflicts.length > 1) {
            const ids = [...conflicts].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
            error = `manager settings navigation route ${
              qualifyOwnedId(record.owner, routeId)
            } is referenced by multiple contributions: ${ids.join(', ')}`
          }
        }
        const pointAccess =
          this.access?.decision(record.owner, record.options.name, 'surface', view ?? record.candidateView)
            ?? { policy: 'inherit' as const, effectivePolicy: 'allow' as const, authorized: true }
        const control = record.controlDeclaration === undefined ? undefined : controlSnapshot?.points
          .find(point => point.id === record.controlDeclaration!.identity.pointId)?.candidates
          .find(candidate =>
            candidate.identity.source === record.controlDeclaration!.identity.source
            && candidate.identity.pluginId === record.controlDeclaration!.identity.pluginId
            && candidate.claimId === record.controlDeclaration!.claimId
            && candidate.mode === record.controlDeclaration!.mode
          )
        const toolbarItem = item as unknown as CordisXToolbarItem | undefined
        const anchorSupport = toolbarItem !== undefined
            && (record.options.name === 'workspace.toolbar.items' || record.options.name === 'composer.toolbar.items')
          ? this.access?.surfaceAnchorSupport(record.options.name, toolbarItem.anchor)
          : undefined
        if (error === undefined && !this.declared.has(record.options.name)) {
          error = `surface ${record.options.name} is not declared by the host`
        }
        const unknownWhen = whenContextKeys(record.options.when).find(key => !knownKeys.has(key))
        if (error === undefined && unknownWhen !== undefined) {
          error = `when context key ${unknownWhen} is not declared by the host`
        }
        if (error === undefined && item !== undefined) {
          const command = item.command as CordisXCommandReference | undefined
          const route = item.route as { id: string } | undefined
          const resolutionView = view ?? record.candidateView
          if (command !== undefined && !this.resolvers.command(record.owner, command, resolutionView)) {
            error = `command ${command.id} is not available`
          } else if (command === undefined && route !== undefined && record.options.name === 'manager.settings.tabs') {
            const resolution = this.resolvers.managerSettingsRoute?.(record.owner, route.id, resolutionView)
              ?? (this.resolvers.route(record.owner, route.id, resolutionView)
                ? { state: 'available' as const }
                : { state: 'pending' as const, detail: `route ${route.id} is not available` })
            if (resolution.state === 'pending') pending = true
            if (resolution.state === 'invalid') {
              error = resolution.detail ?? `route ${route.id} is incompatible with manager settings`
            }
          } else if (
            command === undefined && route !== undefined && record.options.name === 'manager.settings.navigation-items'
          ) {
            const resolution = this.resolvers.managerSettingsNavigationRoute?.(record.owner, route.id, resolutionView)
              ?? (this.resolvers.route(record.owner, route.id, resolutionView)
                ? { state: 'available' as const }
                : { state: 'pending' as const, detail: `route ${route.id} is not available` })
            if (resolution.state === 'pending') pending = true
            if (resolution.state === 'invalid') {
              error = resolution.detail ?? `route ${route.id} is incompatible with manager settings navigation`
            }
          } else if (
            command === undefined && route !== undefined
            && !this.resolvers.route(record.owner, route.id, resolutionView)
          ) error = `route ${route.id} is not available`
          const actions = item.actions as readonly { command?: CordisXCommandReference }[] | undefined
          const missingAction = actions?.find(action =>
            action.command !== undefined
            && !this.resolvers.command(record.owner, action.command, resolutionView)
          )
          if (error === undefined && missingAction?.command !== undefined) {
            error = `command ${missingAction.command.id} is not available`
          }
          const actionWithUnknownWhen = (item.actions as readonly { when?: CordisXWhen }[] | undefined)
            ?.find(action => whenContextKeys(action.when).some(key => !knownKeys.has(key)))
          const unknownActionKey = actionWithUnknownWhen === undefined
            ? undefined
            : whenContextKeys(actionWithUnknownWhen.when).find(key => !knownKeys.has(key))
          if (error === undefined && unknownActionKey !== undefined) {
            error = `when context key ${unknownActionKey} is not declared by the host`
          }
          if (record.options.name === 'workspace.toolbar.items' || record.options.name === 'composer.toolbar.items') {
            const anchored = item as unknown as CordisXToolbarItem
            if (!this.surfaceAnchors.get(record.options.name)?.get(anchored.anchor)?.has(anchored.placement)) {
              pending = true
            }
          }
          if (
            record.options.name === 'environment.section.actions' || record.options.name === 'environment.section.rows'
          ) {
            const target = qualifyOwnedId(record.owner, String(item.sectionId))
            if (!sections.has(target)) pending = true
          }
          if (record.options.name === 'environment.row.trailing-actions') {
            const target = qualifyOwnedId(record.owner, String(item.rowId))
            if (!rows.has(target)) pending = true
          }
        }
        const currentContext = this.currentContext.get(record.options.name)
        const currentAnchor = toolbarItem === undefined
          ? undefined
          : currentContext?.anchors?.find(anchor => anchor.id === toolbarItem.anchor)
        if (this.access !== undefined && currentContext !== undefined && currentContext.state !== 'active') {
          pending = true
        }
        if (currentAnchor !== undefined && currentAnchor.state !== 'active') pending = true
        const authorized = pointAccess.authorized && anchorSupport?.supported !== false
          && (control === undefined || control.state === 'selected')
        if (control?.state === 'pending' || control?.state === 'suppressed') pending = true
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
          ...(control === undefined ? {} : { control }),
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

  /** Publish a collection replacement as one observable surface epoch. */
  transaction<Value>(work: () => Value): Value {
    this.notificationDepth += 1
    try {
      return work()
    } finally {
      this.notificationDepth -= 1
      if (this.notificationDepth === 0 && this.notificationPending) {
        this.notificationPending = false
        this.notify()
      }
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disconnectVisibility?.()
    this.disconnectControls?.()
    for (const record of this.records.values()) {
      record.controlHandle?.dispose()
      record.controlLease?.dispose()
    }
    this.controls?.dispose()
    this.records.clear()
    this.listeners.clear()
    this.declared.clear()
    this.surfaceAnchors.clear()
    this.currentContext.clear()
  }

  private notify(): void {
    if (this.notificationDepth > 0) {
      this.notificationPending = true
      return
    }
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // One observer cannot split a published visibility epoch.
      }
    }
  }

  private controlPrincipal(source: string, pluginId: string, origin: 'explicit' | 'legacy-structured'): string {
    if (this.controls === undefined) throw new Error('controlled surface runtime is unavailable')
    return this.controls.policies.principalHandle(source, pluginId, origin)
  }

  private recordVisible(record: SurfaceRecord, view?: PluginGenerationView): boolean {
    return record.controlGeneration === undefined
      ? this.visibility?.visible(record.generation, view) ?? true
      : this.controlGenerationVisible(record.controlGeneration, view)
  }

  controlGenerationVisible(generation: ControlledSurfaceGeneration, view?: PluginGenerationView): boolean {
    if (this.visibility === undefined) return true
    if (view?.pluginId === generation.pluginId && view.transactionId !== undefined) {
      return generation.transactionId === view.transactionId
        && generation.transactionEpoch === view.transactionEpoch
        && this.visibility.visible(generation, view)
    }
    const committed = this.committedControlTransactions.get(generation.pluginId)
    if (generation.transactionId !== undefined) {
      return committed !== undefined
        && committed.moduleGeneration === generation.moduleGeneration
        && committed.transactionId === generation.transactionId
        && committed.transactionEpoch === generation.transactionEpoch
        && this.visibility.visible(generation)
    }
    if (committed?.moduleGeneration === generation.moduleGeneration) return false
    return this.visibility.visible(generation, view)
  }

  controlGenerationCallable(generation: ControlledSurfaceGeneration): boolean {
    if (this.visibility === undefined) return true
    if (!this.controlGenerationVisible(generation)) return false
    try {
      this.visibility.assertCallable(generation, generation.visibilityView)
      return true
    } catch {
      return false
    }
  }
}
