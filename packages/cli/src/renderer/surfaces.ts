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
  'host:hierarchy',
  'host:history',
  'host:info',
  'host:layers',
  'host:link',
  'host:marketplace',
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

interface SurfaceRecord {
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

function assertKeys(value: object, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find(key => !allowed.includes(key))
  if (unknown !== undefined) throw new Error(`${label} has unknown field ${unknown}`)
}

function assertIcon(icon: CordisXIconToken | undefined, label: string): void {
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

function assertRoute(
  reference: { readonly id: string; readonly params?: Readonly<Record<string, unknown>> },
  label: string,
): void {
  if (reference === null || typeof reference !== 'object') throw new Error(`${label} requires a route reference`)
  assertReference(reference.id, `${label} route id`)
  assertKeys(reference, ['id', 'params'], `${label} route`)
}

function cloneNavigationCollectionLeadingVisual(
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

function assertDisabled(disabled: CordisXDisabledState | undefined): void {
  if (disabled === undefined) return
  if (typeof disabled.value !== 'boolean') throw new Error('disabled.value must be a boolean')
  assertKeys(disabled, ['value', 'reason'], 'disabled')
  if (disabled.reason !== undefined) assertLocalizedText(disabled.reason, 'disabled reason')
}

function cloneNavigationCollectionActions(
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

function assertPresentationOptions(
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

function assertControlOptions(control: CordisXExtensionPointControlClaimOptions | undefined): void {
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

function validateItem(surface: CordisXSurfaceName, item: unknown): unknown {
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
    assertKeys(snapshot, ['route'], 'manager settings navigation item')
    if (navigation.route === null || typeof navigation.route !== 'object') {
      throw new Error('manager settings navigation item requires a route reference')
    }
    assertKeys(navigation.route, ['id', 'params'], 'manager settings navigation item route')
    assertLocalId(navigation.route.id, 'manager settings navigation item route id')
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
