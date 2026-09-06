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

import { SurfaceRegistry } from './surface-registry.js'
import {
  assertDisabled,
  assertIcon,
  assertKeys,
  assertRoute,
  cloneNavigationCollectionActions,
  cloneNavigationCollectionLeadingVisual,
  type NavigationCollectionGroupSnapshot,
  type SurfaceContributionSnapshot,
  type SurfaceResolvers,
} from './surface-validation.js'

export class CordisXSlotService extends Service implements CordisXSlots {
  readonly registry: SurfaceRegistry
  readonly contexts: HostContextStore
  private readonly console: PluginConsoleAspect | undefined
  private readonly navigationCollectionGroups = new Map<string, NavigationCollectionGroupSnapshot>()
  private readonly navigationCollectionLeadingVisuals = new Map<string, CordisXNavigationCollectionLeadingVisual>()
  private nextNavigationCollection = 1

  constructor(
    ctx: Context,
    input?: SurfaceRegistry | { readonly registry?: SurfaceRegistry; readonly console: PluginConsoleAspect },
  ) {
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
      throw new Error(
        `surface ${JSON.stringify(name)} is not declared; direct-DOM slots were removed in structured UI v1`,
      )
    }
    const token = this.console?.tokenFromContext(this.ctx)
    const scoped = token === undefined || this.console === undefined
      ? setup
      : () =>
        this.console!.runInPluginContext(
          token,
          { trigger: { kind: 'registration', registrationId: `surface:${name}` } },
          setup,
        ) as Effect
    const register = (): ReturnType<CordisXSlots['inject']> =>
      this.ctx.effect(scoped, `slots.inject(${JSON.stringify(name)})`)
    return token === undefined || this.console === undefined
      ? register()
      : this.console.runSync(token, 'slots.inject', { name }, register)
  }

  register<Name extends CordisXSurfaceName>(
    options: CordisXContributionOptions<Name>,
    item: CordisXSurfaceMap[Name],
  ): CordisXContributionHandle<CordisXSurfaceMap[Name]> {
    const token = this.console?.tokenFromContext(this.ctx)
    const register = (): CordisXContributionHandle<CordisXSurfaceMap[Name]> =>
      this.registry.register(this.ctx, options, item)
    const handle = token === undefined || this.console === undefined
      ? register()
      : this.console.runSync(token, 'slots.register', { options, item }, register)
    if (token === undefined || this.console === undefined) {
      this.ctx.effect(() => handle, `slots.register(${JSON.stringify(options.name)}, ${JSON.stringify(options.id)})`)
      return handle
    }
    const console = this.console
    const dispose = (() =>
      console.runCleanupSync(
        token,
        'slots.dispose',
        { name: options.name, id: options.id },
        handle.dispose,
      )) as CordisXContributionHandle<CordisXSurfaceMap[Name]>
    dispose.dispose = dispose
    dispose.update = next =>
      console.runSync(
        token,
        'slots.update',
        { name: options.name, id: options.id, item: next },
        () => handle.update(next),
      )
    dispose.updateOptions = next =>
      console.runSync(
        token,
        'slots.updateOptions',
        { name: options.name, id: options.id, options: next },
        () => handle.updateOptions(next),
      )
    if (handle.control !== undefined) {
      Object.defineProperty(dispose, 'control', { value: handle.control, enumerable: true })
    }
    this.ctx.effect(() => dispose, `slots.register(${JSON.stringify(options.name)}, ${JSON.stringify(options.id)})`)
    return dispose
  }

  registerCollection(
    options: CordisXNavigationCollectionOptionsV3,
    source: CordisXNavigationCollectionSourceV3,
  ): CordisXNavigationCollectionRegistration
  registerCollection(
    options: CordisXNavigationCollectionOptionsV2,
    source: CordisXNavigationCollectionSourceV2,
  ): CordisXNavigationCollectionRegistration
  registerCollection(
    options: CordisXNavigationCollectionOptions,
    source: CordisXNavigationCollectionSource,
  ): CordisXNavigationCollectionRegistration
  registerCollection(
    options:
      | CordisXNavigationCollectionOptions
      | CordisXNavigationCollectionOptionsV2
      | CordisXNavigationCollectionOptionsV3,
    source:
      | CordisXNavigationCollectionSource
      | CordisXNavigationCollectionSourceV2
      | CordisXNavigationCollectionSourceV3,
  ): CordisXNavigationCollectionRegistration {
    const contract = 'contract' in options ? options.contract : undefined
    const actionCapable = contract === 'cordisx.navigation-collection/v2'
      || contract === 'cordisx.navigation-collection/v3'
    const imageCapable = contract === 'cordisx.navigation-collection/v3'
    assertKeys(
      options,
      actionCapable ? ['contract', 'name', 'id', 'group'] : ['name', 'id', 'group'],
      'navigation collection options',
    )
    if (options.name !== 'sidebar.navigation.items') {
      throw new Error('navigation collection requires sidebar.navigation.items')
    }
    assertLocalId(options.id, 'navigation collection id')
    if (options.group === null || typeof options.group !== 'object' || Array.isArray(options.group)) {
      throw new Error('navigation collection group must be an object')
    }
    assertKeys(options.group, ['id', 'label', 'order'], 'navigation collection group')
    assertLocalId(options.group.id, 'navigation collection group id')
    assertLocalizedText(options.group.label, 'navigation collection group label')
    if (
      options.group.order !== undefined
      && (!Number.isInteger(options.group.order) || options.group.order < -100_000 || options.group.order > 100_000)
    ) {
      throw new Error('navigation collection group order is invalid')
    }
    if (source === null || typeof source !== 'object') throw new Error('navigation collection source must be an object')
    if (typeof source.snapshot !== 'function' || typeof source.subscribe !== 'function') {
      throw new Error('navigation collection source requires snapshot and subscribe functions')
    }

    const owner = ownerFromContext(this.ctx)
    const collectionSequence = this.nextNavigationCollection++
    const qualifiedId = qualifyOwnedId(owner, options.id)
    const surfaceGroup = `navcol.${collectionSequence}`
    const group: NavigationCollectionGroupSnapshot = Object.freeze({
      owner,
      id: options.group.id,
      qualifiedId: `${qualifiedId}:${options.group.id}`,
      label: immutableSnapshot(options.group.label),
      order: options.group.order ?? 0,
      surfaceGroup,
    })
    let active = true
    let current:
      | CordisXNavigationCollectionSnapshot
      | CordisXNavigationCollectionSnapshotV2
      | CordisXNavigationCollectionSnapshotV3
      | undefined
    let unsubscribe: (() => void) | undefined
    let nextItemSequence = 1
    const stableIds = new Map<string, string>()
    let handles: CordisXContributionHandle<CordisXNavigationItem>[] = []
    let leadingVisualIds = new Set<string>()

    const read = ():
      | CordisXNavigationCollectionSnapshot
      | CordisXNavigationCollectionSnapshotV2
      | CordisXNavigationCollectionSnapshotV3 =>
    {
      const input = source.snapshot()
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('navigation collection snapshot must be an object')
      }
      assertKeys(input, ['revision', 'items'], 'navigation collection snapshot')
      if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
        throw new Error('navigation collection snapshot revision is invalid')
      }
      if (!Array.isArray(input.items) || input.items.length > 500) {
        throw new Error('navigation collection snapshot items are invalid')
      }
      const ids = new Set<string>()
      const items = input.items.map(
        (
          candidate,
          index,
        ): CordisXNavigationCollectionItem | CordisXNavigationCollectionItemV2 | CordisXNavigationCollectionItemV3 => {
          if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
            throw new Error(`navigation collection item ${index} must be an object`)
          }
          assertKeys(
            candidate,
            imageCapable
              ? ['id', 'label', 'description', 'icon', 'leadingVisual', 'route', 'order', 'disabled', 'actions']
              : actionCapable
              ? ['id', 'label', 'description', 'icon', 'route', 'order', 'disabled', 'actions']
              : ['id', 'label', 'description', 'icon', 'route', 'order', 'disabled'],
            `navigation collection item ${index}`,
          )
          assertLocalId(candidate.id, `navigation collection item ${index} id`)
          if (ids.has(candidate.id)) throw new Error(`navigation collection has duplicate item ${candidate.id}`)
          ids.add(candidate.id)
          assertLocalizedText(candidate.label, `navigation collection item ${index} label`)
          if (candidate.description !== undefined) {
            assertLocalizedText(candidate.description, `navigation collection item ${index} description`)
          }
          assertIcon(candidate.icon, `navigation collection item ${index}`)
          const candidateVisual = imageCapable
            ? (candidate as CordisXNavigationCollectionItemV3).leadingVisual
            : undefined
          if (candidate.icon !== undefined && candidateVisual !== undefined) {
            throw new Error(`navigation collection item ${index} cannot combine icon and leadingVisual`)
          }
          const leadingVisual = cloneNavigationCollectionLeadingVisual(
            candidateVisual,
            `navigation collection item ${index} leadingVisual`,
          )
          assertRoute(candidate.route, `navigation collection item ${index}`)
          if (!Number.isInteger(candidate.order) || candidate.order < -100_000 || candidate.order > 100_000) {
            throw new Error(`navigation collection item ${index} order is invalid`)
          }
          assertDisabled(candidate.disabled)
          const actions = actionCapable
            ? cloneNavigationCollectionActions(
              (candidate as CordisXNavigationCollectionItemV2).actions,
              `navigation collection item ${index} actions`,
            )
            : undefined
          return immutableSnapshot({
            ...candidate,
            ...(leadingVisual === undefined ? {} : { leadingVisual }),
            ...(actions === undefined ? {} : { actions }),
          })
        },
      )
      return immutableSnapshot({ revision: input.revision, items })
    }

    const replace = (
      next:
        | CordisXNavigationCollectionSnapshot
        | CordisXNavigationCollectionSnapshotV2
        | CordisXNavigationCollectionSnapshotV3,
    ): void => {
      if (!active) return
      if (current !== undefined && next.revision < current.revision) {
        throw new Error('navigation collection snapshot revision moved backwards')
      }
      if (current?.revision === next.revision) {
        if (JSON.stringify(current) !== JSON.stringify(next)) {
          throw new Error('navigation collection changed without advancing revision')
        }
        return
      }
      const ordered = [...next.items].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
      const nextHandles: CordisXContributionHandle<CordisXNavigationItem>[] = []
      const nextLeadingVisuals = new Map<string, CordisXNavigationCollectionLeadingVisual>()
      this.registry.transaction(() => {
        for (const handle of handles) handle.dispose()
        for (const qualifiedItemId of leadingVisualIds) this.navigationCollectionLeadingVisuals.delete(qualifiedItemId)
        for (const item of ordered) {
          let syntheticId = stableIds.get(item.id)
          if (syntheticId === undefined) {
            syntheticId = `navcol.${collectionSequence}.${nextItemSequence++}`
            stableIds.set(item.id, syntheticId)
          }
          nextHandles.push(this.registry.register(this.ctx, {
            name: 'sidebar.navigation.items',
            id: syntheticId,
            group: surfaceGroup,
            order: item.order,
            ...(item.disabled === undefined ? {} : { disabled: item.disabled }),
          }, {
            label: item.label,
            ...(item.description === undefined ? {} : { description: item.description }),
            ...(item.icon === undefined ? {} : { icon: item.icon }),
            route: item.route,
            ...(!actionCapable || (item as CordisXNavigationCollectionItemV2).actions === undefined
              ? {}
              : { actions: (item as CordisXNavigationCollectionItemV2).actions }),
            ...(contract === undefined ? {} : { collectionContract: contract }),
          } as unknown as CordisXNavigationItem))
          const leadingVisual = imageCapable ? (item as CordisXNavigationCollectionItemV3).leadingVisual : undefined
          if (leadingVisual !== undefined) {
            nextLeadingVisuals.set(qualifyOwnedId(owner, syntheticId), leadingVisual)
          }
        }
        for (const [qualifiedItemId, leadingVisual] of nextLeadingVisuals) {
          this.navigationCollectionLeadingVisuals.set(qualifiedItemId, leadingVisual)
        }
        leadingVisualIds = new Set(nextLeadingVisuals.keys())
        handles = nextHandles
        current = next
      })
    }

    const disposeRegistration = (): void => {
      if (!active) return
      active = false
      unsubscribe?.()
      unsubscribe = undefined
      this.navigationCollectionGroups.delete(surfaceGroup)
      for (const qualifiedItemId of leadingVisualIds) this.navigationCollectionLeadingVisuals.delete(qualifiedItemId)
      leadingVisualIds.clear()
      this.registry.transaction(() => {
        for (const handle of handles) handle.dispose()
        handles = []
      })
      source.dispose?.()
    }

    let effectDispose: (() => void) | undefined
    try {
      this.navigationCollectionGroups.set(surfaceGroup, group)
      replace(read())
      unsubscribe = source.subscribe(() => {
        if (!active) return
        try {
          replace(read())
        } catch (error) {
          console.error('[cordisx] navigation collection update failed', error)
        }
      })
      if (typeof unsubscribe !== 'function') {
        throw new Error('navigation collection subscribe must return an unsubscribe function')
      }
      effectDispose = this.ctx.effect(
        () => disposeRegistration,
        `slots.registerCollection(${JSON.stringify(options.id)})`,
      )
    } catch (error) {
      disposeRegistration()
      throw error
    }
    return { dispose: () => effectDispose?.() }
  }

  navigationCollectionGroupsSnapshot(): readonly NavigationCollectionGroupSnapshot[] {
    return [...this.navigationCollectionGroups.values()]
      .sort((left, right) => left.order - right.order || left.qualifiedId.localeCompare(right.qualifiedId))
  }

  navigationCollectionLeadingVisual(qualifiedItemId: string): CordisXNavigationCollectionLeadingVisual | undefined {
    return this.navigationCollectionLeadingVisuals.get(qualifiedItemId)
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

  setControlCoordinator(controls: ControlledSurfaceCoordinator): void {
    this.registry.setControlCoordinator(controls)
  }

  controlGenerationVisible(generation: ControlledSurfaceGeneration, view?: PluginGenerationView): boolean {
    return this.registry.controlGenerationVisible(generation, view)
  }

  controlGenerationCallable(generation: ControlledSurfaceGeneration): boolean {
    return this.registry.controlGenerationCallable(generation)
  }

  controlManagerSnapshot(): ControlledSurfaceManagerSnapshot | undefined {
    return this.registry.controlCoordinator()?.managerSnapshot()
  }

  /** Read-only startup migration input; PermissionBroker owns all live authorization after migration. */
  controlLegacyAuthorizations(): readonly CordisXExtensionPointControlAuthorizationV1[] {
    return this.registry.controlCoordinator()?.legacyAuthorizations() ?? []
  }

  setControlAuthorization(
    expectedRevision: number,
    authorization: CordisXExtensionPointControlAuthorizationV1,
  ): number {
    const controls = this.registry.controlCoordinator()
    if (controls === undefined) throw new Error('controlled surface runtime is unavailable')
    return controls.setAuthorization(expectedRevision, authorization)
  }

  setControlGroupChoice(expectedRevision: number, choice: ControlledSurfaceGroupChoice): number {
    const controls = this.registry.controlCoordinator()
    if (controls === undefined) throw new Error('controlled surface runtime is unavailable')
    return controls.setGroupChoice(expectedRevision, choice)
  }

  invalidatePointPolicies(): void {
    this.registry.invalidatePointPolicies()
  }
}
