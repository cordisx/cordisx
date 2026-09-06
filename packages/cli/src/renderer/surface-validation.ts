import { Context, type Effect, Service } from '@deepseek-ai/cordis'
import type { ManagerSettingsNavigationSurfaceProvenanceV2 } from '@cordisx/protocol/manager-settings-navigation/v2'
import {
  CORDISX_IMPLEMENTED_SURFACE_NAMES,
  CORDISX_SURFACE_CONTRIBUTION_SCHEMA_V9,
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

export const CORDISX_HOST_ICON_TOKENS = [
  'host:analytics',
  'host:archive',
  'host:back',
  'host:chat',
  'host:close',
  'host:copy',
  'host:delete',
  'host:error',
  'host:files',
  'host:fit',
  'host:hierarchy',
  'host:history',
  'host:info',
  'host:layers',
  'host:link',
  'host:marketplace',
  'host:people',
  'host:more',
  'host:open',
  'host:pin',
  'host:pinned',
  'host:people-search',
  'host:refresh',
  'host:review',
  'host:restore',
  'host:settings',
  'host:success',
  'host:warning',
] as const satisfies readonly CordisXIconToken[]

export interface SurfaceRecord {
  readonly sequence: number
  readonly owner: string
  readonly qualifiedId: string
  readonly generation: PluginGenerationEffectIdentity
  readonly candidateView?: PluginGenerationView
  readonly renderToken: object
  readonly controlDeclaration?: CordisXExtensionPointControlDeclarationV1
  readonly controlGeneration?: ControlledSurfaceGeneration
  readonly controlHandle?: ControlledSurfaceRegistrationHandle
  readonly controlLease?: CordisXExtensionPointControlLease & { dispose(): void }
  options: CordisXContributionOptions
  item: unknown
  readonly managerSettingsNavigationSurfaceProvenance?: ManagerSettingsNavigationSurfaceProvenanceV2
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
  readonly managerSettingsNavigationSurfaceProvenance?: ManagerSettingsNavigationSurfaceProvenanceV2
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
  readonly control?: CordisXExtensionPointControlCandidateSnapshotV1
}

export interface NavigationCollectionGroupSnapshot {
  readonly owner: string
  readonly id: string
  readonly qualifiedId: string
  readonly label: CordisXLocalizedText
  readonly order: number
  readonly surfaceGroup: string
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
  managerSettingsNavigationRoute?(owner: string, id: string, view?: PluginGenerationView): Readonly<{
    state: 'available' | 'pending' | 'invalid'
    detail?: string
  }>
}

export function assertKeys(value: object, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find(key => !allowed.includes(key))
  if (unknown !== undefined) throw new Error(`${label} has unknown field ${unknown}`)
}

export function assertIcon(icon: CordisXIconToken | undefined, label: string): void {
  if (icon === undefined) return
  if (!ICON_TOKEN_PATTERN.test(icon)) throw new Error(`${label} has an invalid host icon token`)
  if (!(CORDISX_HOST_ICON_TOKENS as readonly string[]).includes(icon)) {
    throw new Error(`${label} uses unknown host icon token ${icon}`)
  }
}

function assertCommand(reference: CordisXCommandReference, label: string): void {
  if (reference === null || typeof reference !== 'object') throw new Error(`${label} requires a command reference`)
  assertReference(reference.id, `${label} command id`)
  assertKeys(reference, ['id', 'arguments'], `${label} command`)
}

export function assertRoute(
  reference: { readonly id: string; readonly params?: Readonly<Record<string, unknown>> },
  label: string,
): void {
  if (reference === null || typeof reference !== 'object') throw new Error(`${label} requires a route reference`)
  assertReference(reference.id, `${label} route id`)
  assertKeys(reference, ['id', 'params'], `${label} route`)
}

export function cloneNavigationCollectionLeadingVisual(
  input: CordisXNavigationCollectionLeadingVisual | undefined,
  label: string,
): CordisXNavigationCollectionLeadingVisual | undefined {
  if (input === undefined) return undefined
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${label} must be an object`)
  }
  assertKeys(input, ['kind', 'image'], label)
  if (input.kind !== 'image') throw new Error(`${label}.kind is invalid`)
  return Object.freeze({ kind: 'image', image: cloneRasterImageSnapshot(input.image, `${label}.image`) })
}

function assertAction(action: CordisXStructuredAction, label: string): void {
  assertLocalizedText(action.label, `${label} label`)
  if (action.ariaLabel !== undefined) assertLocalizedText(action.ariaLabel, `${label} ariaLabel`)
  assertIcon(action.icon, label)
  if (action.command === undefined && action.route === undefined) {
    throw new Error(`${label} requires a command or route reference`)
  }
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

export function assertDisabled(disabled: CordisXDisabledState | undefined): void {
  if (disabled === undefined) return
  if (typeof disabled.value !== 'boolean') throw new Error('disabled.value must be a boolean')
  assertKeys(disabled, ['value', 'reason'], 'disabled')
  if (disabled.reason !== undefined) assertLocalizedText(disabled.reason, 'disabled reason')
}

export function cloneNavigationCollectionActions(
  input: readonly CordisXNavigationCollectionAction[] | undefined,
  label: string,
): readonly CordisXNavigationCollectionAction[] | undefined {
  if (input === undefined) return undefined
  if (!Array.isArray(input) || input.length > 8) throw new Error(`${label} must contain at most eight actions`)
  const ids = new Set<string>()
  return Object.freeze(input.map((action, index) => {
    const actionLabel = `${label}[${index}]`
    if (action === null || typeof action !== 'object' || Array.isArray(action)) {
      throw new Error(`${actionLabel} must be an object`)
    }
    const common = ['kind', 'id', 'label', 'ariaLabel', 'icon', 'placement', 'tone', 'pressed', 'disabled', 'feedback']
    assertKeys(
      action,
      action.kind === 'command'
        ? [...common, 'command', 'confirmation']
        : action.kind === 'copy-text'
        ? [...common, 'text']
        : common,
      actionLabel,
    )
    assertLocalId(action.id, `${actionLabel} id`)
    if (ids.has(action.id)) throw new Error(`${label} has duplicate action ${action.id}`)
    ids.add(action.id)
    if (!['command', 'copy-route-link', 'copy-text'].includes(action.kind)) {
      throw new Error(`${actionLabel}.kind is invalid`)
    }
    assertLocalizedText(action.label, `${actionLabel} label`)
    if (action.ariaLabel !== undefined) assertLocalizedText(action.ariaLabel, `${actionLabel} ariaLabel`)
    assertIcon(action.icon as CordisXIconToken | undefined, actionLabel)
    if (!['direct', 'overflow'].includes(action.placement)) throw new Error(`${actionLabel}.placement is invalid`)
    if (!['neutral', 'danger'].includes(action.tone)) throw new Error(`${actionLabel}.tone is invalid`)
    if (typeof action.pressed !== 'boolean') throw new Error(`${actionLabel}.pressed must be a boolean`)
    if (action.disabled === null || typeof action.disabled !== 'object' || Array.isArray(action.disabled)) {
      throw new Error(`${actionLabel}.disabled must be an object`)
    }
    assertDisabled(action.disabled as CordisXDisabledState)
    if (action.feedback === null || typeof action.feedback !== 'object' || Array.isArray(action.feedback)) {
      throw new Error(`${actionLabel}.feedback must be an object`)
    }
    assertKeys(action.feedback, ['success', 'failure'], `${actionLabel}.feedback`)
    assertLocalizedText(action.feedback.success, `${actionLabel}.feedback.success`)
    assertLocalizedText(action.feedback.failure, `${actionLabel}.feedback.failure`)
    if (action.kind === 'command') {
      assertCommand(action.command as CordisXCommandReference, actionLabel)
      if (action.confirmation !== undefined) {
        if (
          action.confirmation === null || typeof action.confirmation !== 'object' || Array.isArray(action.confirmation)
        ) {
          throw new Error(`${actionLabel}.confirmation must be an object`)
        }
        assertKeys(action.confirmation, ['title', 'description', 'confirmLabel'], `${actionLabel}.confirmation`)
        assertLocalizedText(action.confirmation.title, `${actionLabel}.confirmation.title`)
        assertLocalizedText(action.confirmation.description, `${actionLabel}.confirmation.description`)
        assertLocalizedText(action.confirmation.confirmLabel, `${actionLabel}.confirmation.confirmLabel`)
      }
    } else if (action.kind === 'copy-text') {
      if (action.text === null || typeof action.text !== 'object' || Array.isArray(action.text)) {
        throw new Error(`${actionLabel}.text must be an object`)
      }
      assertKeys(action.text, ['value'], `${actionLabel}.text`)
      const length = typeof action.text.value === 'string' ? [...action.text.value].length : 0
      if (length < 1 || length > 4096 || action.text.value.includes('\0')) {
        throw new Error(`${actionLabel}.text.value is invalid`)
      }
    }
    return immutableSnapshot(action)
  }))
}

export function assertPresentationOptions(
  surface: CordisXSurfaceName,
  options: CordisXContributionPresentationOptions,
): void {
  assertKeys(options, ['group', 'order', 'when', 'disabled'], 'surface contribution presentation options')
  if (
    (surface === 'manager.settings.tabs' || surface === 'composer.reasoning-intensity' || surface === 'session.backdrop'
      || surface === 'composer.submit.effects') && options.group !== undefined
  ) {
    throw new Error(`${surface} does not accept a contribution group`)
  }
  if (
    surface === 'manager.settings.navigation-items'
    && options.group !== 'before-settings'
    && options.group !== 'after-settings'
  ) {
    throw new Error('manager.settings.navigation-items requires group before-settings or after-settings')
  }
  if (options.group !== undefined) assertLocalId(options.group, 'surface contribution group')
  if (
    options.order !== undefined
    && (!Number.isInteger(options.order) || options.order < -100000 || options.order > 100000)
  ) {
    throw new Error('surface contribution order is invalid')
  }
  assertWhenExpression(options.when)
  assertDisabled(options.disabled)
}

export function assertControlOptions(control: CordisXExtensionPointControlClaimOptions | undefined): void {
  if (control === undefined) return
  assertKeys(control, ['claimId', 'mode', 'priority', 'requestedBindings'], 'surface control claim')
  assertLocalId(control.claimId, 'surface control claim id')
  if (!['compose', 'replace', 'overlay', 'proxy', 'hide-native'].includes(control.mode)) {
    throw new Error('surface control mode is invalid')
  }
  if (
    control.priority !== undefined
    && (!Number.isInteger(control.priority) || control.priority < -100000 || control.priority > 100000)
  ) throw new Error('surface control priority is invalid')
  if (control.requestedBindings !== undefined) {
    assertKeys(control.requestedBindings, ['properties', 'commands', 'events'], 'surface control requested bindings')
    for (const [kind, values] of Object.entries(control.requestedBindings)) {
      if (
        !Array.isArray(values) || values.some(value => typeof value !== 'string')
        || new Set(values).size !== values.length
      ) {
        throw new Error(`surface control ${kind} bindings are invalid`)
      }
    }
  }
}

export function managerSettingsNavigationSurfaceProvenance(
  options: Readonly<{
    readonly name: CordisXSurfaceName
    readonly $schema?: unknown
    readonly schemaVersion?: unknown
  }>,
  item: unknown,
): ManagerSettingsNavigationSurfaceProvenanceV2 | undefined {
  if (options.name !== 'manager.settings.navigation-items') return undefined
  const hasSchema = options.$schema !== undefined
  const hasVersion = options.schemaVersion !== undefined
  if (hasSchema !== hasVersion) {
    throw new Error('manager.settings.navigation-items requires $schema and schemaVersion together')
  }
  const navigationGroup = item !== null && typeof item === 'object' && !Array.isArray(item)
    ? (item as { readonly navigationGroup?: unknown }).navigationGroup
    : undefined
  if (!hasSchema) {
    if (navigationGroup !== undefined) {
      throw new Error('manager settings navigationGroup requires the exact surface-contribution.v9 identity')
    }
    return Object.freeze({ kind: 'legacy-unversioned' })
  }
  if (options.$schema !== CORDISX_SURFACE_CONTRIBUTION_SCHEMA_V9 || options.schemaVersion !== 9) {
    throw new Error('manager.settings.navigation-items requires the exact surface-contribution.v9 identity')
  }
  return Object.freeze({
    kind: 'versioned',
    $schema: CORDISX_SURFACE_CONTRIBUTION_SCHEMA_V9,
    schemaVersion: 9,
  })
}

export function validateItem(surface: CordisXSurfaceName, item: unknown): unknown {
  const snapshot = immutableSnapshot(item)
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error(`surface ${surface} requires a structured object item`)
  }
  if (
    surface === 'sidebar.footer.before-control'
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
    || surface === 'panel.bottom.header-actions'
  ) {
    assertKeys(snapshot, ['label', 'ariaLabel', 'icon', 'command', 'route', 'routeBehavior'], surface)
    assertAction(snapshot as CordisXStructuredAction, surface)
  } else if (surface === 'sidebar.navigation.items') {
    const navigation = snapshot as Omit<CordisXNavigationItem, 'actions'> & {
      readonly collectionContract?: 'cordisx.navigation-collection/v2' | 'cordisx.navigation-collection/v3'
      readonly actions?: readonly (CordisXNavigationCollectionAction | CordisXNavigationAction)[]
    }
    assertKeys(
      snapshot,
      ['label', 'description', 'icon', 'command', 'route', 'actions', 'collectionContract'],
      'navigation item',
    )
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
    if (
      navigation.collectionContract === 'cordisx.navigation-collection/v2'
      || navigation.collectionContract === 'cordisx.navigation-collection/v3'
    ) {
      cloneNavigationCollectionActions(
        navigation.actions as readonly CordisXNavigationCollectionAction[] | undefined,
        'navigation collection actions',
      )
    } else {
      for (const action of navigation.actions ?? []) {
        const legacyAction = action as CordisXNavigationAction
        assertKeys(
          legacyAction,
          ['id', 'label', 'ariaLabel', 'icon', 'command', 'when', 'disabled'],
          'navigation action',
        )
        assertLocalId(legacyAction.id, 'navigation action id')
        assertAction(legacyAction, 'navigation action')
        assertWhenExpression(legacyAction.when)
        assertDisabled(legacyAction.disabled)
      }
    }
  } else if (surface === 'workspace.toolbar.items' || surface === 'composer.toolbar.items') {
    const toolbar = snapshot as CordisXToolbarItem
    assertKeys(
      snapshot,
      ['label', 'ariaLabel', 'icon', 'command', 'route', 'routeBehavior', 'anchor', 'placement'],
      'toolbar item',
    )
    assertAction(toolbar, 'toolbar item')
    if (surface === 'composer.toolbar.items') {
      if (!['leading', 'model', 'submit'].includes(toolbar.anchor)) {
        throw new Error('composer toolbar anchor is invalid')
      }
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
    if (tab.order !== undefined && (!Number.isInteger(tab.order) || tab.order < -100000 || tab.order > 100000)) {
      throw new Error('tab order is invalid')
    }
    assertWhenExpression(tab.when)
  } else if (surface === 'composer.reasoning-intensity') {
    const presentation = snapshot as CordisXReasoningIntensityPresentation
    assertKeys(snapshot, ['variant', 'title', 'motion', 'stages'], 'reasoning intensity presentation')
    if (presentation.variant !== 'imperium') throw new Error('reasoning intensity variant is invalid')
    assertLocalizedText(presentation.title, 'reasoning intensity title')
    if (presentation.motion !== undefined && !['smooth', 'ascension'].includes(presentation.motion)) {
      throw new Error('reasoning intensity motion is invalid')
    }
    if (!Array.isArray(presentation.stages) || presentation.stages.length < 2 || presentation.stages.length > 8) {
      throw new Error('reasoning intensity requires between two and eight stages')
    }
    for (const [index, stage] of presentation.stages.entries()) {
      if (stage === null || typeof stage !== 'object' || Array.isArray(stage)) {
        throw new Error(`reasoning intensity stage ${index} must be an object`)
      }
      assertKeys(stage, ['label', 'material'], `reasoning intensity stage ${index}`)
      assertLocalizedText(stage.label, `reasoning intensity stage ${index} label`)
      if (!['plastic', 'bronze', 'steel', 'silver', 'gold'].includes(stage.material)) {
        throw new Error(`reasoning intensity stage ${index} material is invalid`)
      }
    }
  } else if (surface === 'session.backdrop') {
    const presentation = snapshot as CordisXSessionBackdropPresentation
    assertKeys(snapshot, ['variant', 'driver', 'motion', 'layers', 'stages'], 'session backdrop presentation')
    if (presentation.variant !== 'imperium') throw new Error('session backdrop variant is invalid')
    if (presentation.driver !== 'reasoning-intensity') throw new Error('session backdrop driver is invalid')
    if (presentation.motion !== undefined && !['smooth', 'ascension'].includes(presentation.motion)) {
      throw new Error('session backdrop motion is invalid')
    }
    if (presentation.layers !== undefined) {
      if (
        presentation.layers === null || typeof presentation.layers !== 'object' || Array.isArray(presentation.layers)
      ) {
        throw new Error('session backdrop layers must be an object')
      }
      assertKeys(presentation.layers, ['portrait', 'effects'], 'session backdrop layers')
      if (presentation.layers.portrait !== undefined && typeof presentation.layers.portrait !== 'boolean') {
        throw new Error('session backdrop portrait layer is invalid')
      }
      if (presentation.layers.effects !== undefined && typeof presentation.layers.effects !== 'boolean') {
        throw new Error('session backdrop effects layer is invalid')
      }
    }
    if (!Array.isArray(presentation.stages) || presentation.stages.length < 2 || presentation.stages.length > 8) {
      throw new Error('session backdrop requires between two and eight stages')
    }
    for (const [index, stage] of presentation.stages.entries()) {
      if (stage === null || typeof stage !== 'object' || Array.isArray(stage)) {
        throw new Error(`session backdrop stage ${index} must be an object`)
      }
      assertKeys(stage, ['material', 'ambience', 'portrait'], `session backdrop stage ${index}`)
      if (!['plastic', 'bronze', 'steel', 'silver', 'gold'].includes(stage.material)) {
        throw new Error(`session backdrop stage ${index} material is invalid`)
      }
      if (!['dormant', 'ember', 'forged', 'luminous', 'imperial'].includes(stage.ambience)) {
        throw new Error(`session backdrop stage ${index} ambience is invalid`)
      }
      const portrait = stage.portrait
      if (portrait === null || typeof portrait !== 'object' || Array.isArray(portrait)) {
        throw new Error(`session backdrop stage ${index} portrait must be an object`)
      }
      assertKeys(portrait, ['mediaType', 'data', 'alt'], `session backdrop stage ${index} portrait`)
      if (portrait.mediaType !== 'image/png') {
        throw new Error(`session backdrop stage ${index} portrait mediaType is invalid`)
      }
      if (
        typeof portrait.data !== 'string' || portrait.data.length < 32 || portrait.data.length > 1_200_000
        || !/^[A-Za-z0-9+/]+={0,2}$/u.test(portrait.data)
      ) throw new Error(`session backdrop stage ${index} portrait data is invalid`)
      assertLocalizedText(portrait.alt, `session backdrop stage ${index} portrait alt`)
    }
  } else if (surface === 'composer.submit.effects') {
    const canvas = snapshot as CordisXTransientCanvasPresentation
    assertKeys(snapshot, ['kind', 'durationMs', 'reducedMotion'], 'transient canvas presentation')
    if (canvas.kind !== 'isolated-canvas') throw new Error('transient canvas presentation kind is invalid')
    if (!Number.isInteger(canvas.durationMs) || canvas.durationMs < 100 || canvas.durationMs > 5000) {
      throw new Error('transient canvas presentation durationMs must be an integer from 100 to 5000')
    }
    if (canvas.reducedMotion !== 'skip' && canvas.reducedMotion !== 'static') {
      throw new Error('transient canvas presentation reducedMotion is invalid')
    }
  } else if (
    surface === 'session.banner.items'
    || surface === 'session.turn.footer'
    || surface === 'composer.dock.above'
    || surface === 'composer.dock.below'
  ) {
    const presenter = snapshot as CordisXPresenterItem
    assertKeys(snapshot, ['kind', 'text', 'detail', 'icon', 'tone', 'command', 'route', 'progress'], 'presenter item')
    if (!['banner', 'status', 'chip', 'progress'].includes(presenter.kind)) throw new Error('presenter kind is invalid')
    assertLocalizedText(presenter.text, 'presenter text')
    if (presenter.detail !== undefined) assertLocalizedText(presenter.detail, 'presenter detail')
    assertIcon(presenter.icon, 'presenter item')
    if (presenter.tone !== undefined && !['neutral', 'info', 'success', 'warning', 'error'].includes(presenter.tone)) {
      throw new Error('presenter tone is invalid')
    }
    if (presenter.command !== undefined) assertCommand(presenter.command, 'presenter item')
    if (presenter.route !== undefined) assertRoute(presenter.route, 'presenter item')
    if (presenter.kind === 'progress') {
      if (
        presenter.progress === undefined || !Number.isFinite(presenter.progress.current)
        || !Number.isFinite(presenter.progress.total)
        || presenter.progress.current < 0 || presenter.progress.total <= 0
      ) throw new Error('progress presenter requires finite current/total values')
    } else if (presenter.progress !== undefined) throw new Error('progress values require a progress presenter')
  } else if (surface === 'manager.settings.tabs') {
    const tab = snapshot as CordisXManagerSettingsContentTabItem
    assertKeys(snapshot, ['title', 'icon', 'route'], 'manager settings content tab')
    assertLocalizedText(tab.title, 'manager settings content tab title')
    if (tab.icon === undefined) throw new Error('manager settings content tab requires a host icon token')
    assertIcon(tab.icon, 'manager settings content tab')
    if (tab.route === null || typeof tab.route !== 'object') {
      throw new Error('manager settings content tab requires a route reference')
    }
    assertKeys(tab.route, ['id', 'params'], 'manager settings content tab route')
    assertLocalId(tab.route.id, 'manager settings content tab route id')
  } else if (surface === 'manager.settings.navigation-items') {
    const navigation = snapshot as CordisXManagerSettingsNavigationItem
    assertKeys(snapshot, ['route', 'navigationGroup'], 'manager settings navigation item')
    if (navigation.route === null || typeof navigation.route !== 'object') {
      throw new Error('manager settings navigation item requires a route reference')
    }
    assertKeys(navigation.route, ['id', 'params'], 'manager settings navigation item route')
    assertLocalId(navigation.route.id, 'manager settings navigation item route id')
    if (navigation.navigationGroup !== undefined) {
      if (
        navigation.navigationGroup === null || typeof navigation.navigationGroup !== 'object'
        || Array.isArray(navigation.navigationGroup)
      ) throw new Error('manager settings navigationGroup must be an object')
      assertKeys(navigation.navigationGroup, ['id'], 'manager settings navigationGroup')
      if (!['resources', 'development', 'collaboration', 'other'].includes(navigation.navigationGroup.id)) {
        throw new Error(`manager settings navigationGroup ${String(navigation.navigationGroup.id)} is unknown`)
      }
    }
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
    if (row.value !== undefined && typeof row.value === 'object') {
      assertLocalizedText(row.value, 'environment row value')
    }
    assertIcon(row.status, 'environment row status')
  } else {
    const action = snapshot as CordisXEnvironmentRowAction
    assertKeys(snapshot, ['rowId', 'label', 'ariaLabel', 'icon', 'command'], 'environment row action')
    assertReference(action.rowId, 'environment row target')
    assertAction(action, 'environment row action')
  }
  return snapshot
}
