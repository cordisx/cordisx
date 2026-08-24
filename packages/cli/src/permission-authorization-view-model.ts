import type { CordisXLocalizedText } from './contracts.js'
import { CapabilityRiskCatalog } from './capability-risk-catalog.js'
import {
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
  type CordisXPermissionAuthorizationDecisionV2,
  type CordisXPermissionAuthorizationPlanV2,
  type CordisXPermissionCapabilityV2,
  type CordisXPermissionDecisionV2,
  type CordisXPermissionScopeV2,
} from './permission-contracts.js'
import { CORDISX_PERMISSION_NAMESPACE } from './permission-locales.js'

export type PermissionPluginTrust = 'native' | 'configured' | 'unverified'

export interface PermissionPluginPresentation {
  readonly name: string
  readonly source: string
  readonly trust: PermissionPluginTrust
  /** Host-resolved icon token. Plugin markup/CSS never reaches this model. */
  readonly icon?: string
}

export interface PermissionItemAvailabilityProjection {
  readonly status: 'supported' | 'degraded' | 'unavailable'
  readonly reason: CordisXLocalizedText
  readonly providerIds: readonly string[]
}

export interface PermissionAuthorizationProjectionInput {
  readonly plugin: PermissionPluginPresentation
  readonly availability: Readonly<Partial<Record<CordisXPermissionCapabilityV2, PermissionItemAvailabilityProjection>>>
  readonly resolve: (message: CordisXLocalizedText) => string
  readonly scope: (scope: CordisXPermissionScopeV2) => string
  readonly requestSource?: string
}

export interface PermissionAuthorizationOptionProjection {
  readonly value: CordisXPermissionDecisionV2
  readonly label: string
  readonly selected: boolean
}

export interface PermissionAuthorizationItemProjection {
  readonly capability: CordisXPermissionCapabilityV2
  readonly name: string
  readonly requirement: string
  readonly sensitivity: string
  readonly reviewMode: 'batch-eligible' | 'explicit'
  readonly reviewModeLabel: string
  readonly description: string
  readonly descriptionLabel: string
  readonly risk: string
  readonly limitation: string
  readonly limitationLabel: string
  readonly scope: string
  readonly scopeLabel: string
  readonly availability?: Readonly<{
    status: PermissionItemAvailabilityProjection['status']
    statusLabel: string
    reason: string
  }>
  readonly rationale?: Readonly<{
    label: string
    title: string
    description: string
    featureLabel: string
    feature: string
    deniedBehaviorLabel: string
    deniedBehavior: string
  }>
  readonly authorizationLabel: string
  readonly authorizationOptions: readonly PermissionAuthorizationOptionProjection[]
  readonly denialImpact: string
  readonly technical: Readonly<{
    label: string
    capabilityId: string
    capabilityIdLabel: string
    providers: readonly string[]
    providersLabel: string
    runtimeGeneration: string
    runtimeGenerationLabel: string
    moduleGeneration?: string
    moduleGenerationLabel: string
    requestSource?: string
    requestSourceLabel: string
  }>
}

export interface PermissionAuthorizationDialogProjection {
  readonly heading: string
  readonly plugin: Readonly<{
    name: string
    source: string
    sourceLabel: string
    trust: string
    trustLabel: string
    icon?: string
  }>
  readonly items: readonly PermissionAuthorizationItemProjection[]
  readonly actions: Readonly<{
    cancel: string
    confirm: string
    manage: string
  }>
}

export type PermissionAuthorizationDialogResult =
  | { readonly status: 'cancelled' }
  | { readonly status: 'manage-permissions' }
  | { readonly status: 'confirmed'; readonly decision: CordisXPermissionAuthorizationDecisionV2 }

const UI_FALLBACKS = Object.freeze({
  'dialog.install-title': 'Review permissions before installing',
  'dialog.update-title': 'Review permission changes',
  'dialog.enable-title': 'Review permissions before enabling',
  'dialog.runtime-title': 'Permission request',
  'dialog.required': 'Required',
  'dialog.optional': 'Optional',
  'dialog.sensitivity.low': 'Low risk',
  'dialog.sensitivity.general': 'General access',
  'dialog.sensitivity.sensitive': 'Sensitive',
  'dialog.sensitivity.high-risk': 'High risk',
  'dialog.review-mode.batch-eligible': 'Batch review',
  'dialog.review-mode.explicit': 'Explicit review',
  'dialog.plugin-rationale': 'Plugin-provided explanation',
  'dialog.plugin-feature': 'Feature',
  'dialog.plugin-denied-behavior': 'If denied',
  'dialog.can-do': 'What it can do',
  'dialog.cannot-do': 'What it cannot do',
  'dialog.scope': 'Scope',
  'dialog.availability.supported': 'Available',
  'dialog.availability.degraded': 'Degraded',
  'dialog.availability.unavailable': 'Unavailable now',
  'dialog.authorization-method': 'Authorization method',
  'dialog.decision.allow-once': 'Allow only this time',
  'dialog.decision.allow-persistent': 'Always allow',
  'dialog.decision.deny-once': 'Do not allow this time',
  'dialog.decision.deny-persistent': 'Always deny',
  'dialog.required-denied': 'The plugin will be blocked because this permission is required.',
  'dialog.optional-denied': 'The related feature will remain unavailable; the plugin can continue.',
  'dialog.technical-details': 'Technical details',
  'dialog.capability-id': 'Capability ID',
  'dialog.provider': 'Provider',
  'dialog.runtime-generation': 'Runtime generation',
  'dialog.module-generation': 'Plugin generation',
  'dialog.request-source': 'Request source',
  'dialog.plugin-source': 'Source',
  'dialog.plugin-trust': 'Trust',
  'dialog.cancel': 'Cancel',
  'dialog.confirm': 'Confirm',
  'dialog.manage-permissions': 'Manage plugin permissions',
  'dialog.trust.native': 'Built into the Host',
  'dialog.trust.configured': 'Configured source',
  'dialog.trust.unverified': 'Unverified source',
} as const)

function ui(key: keyof typeof UI_FALLBACKS): CordisXLocalizedText {
  return Object.freeze({ namespace: CORDISX_PERMISSION_NAMESPACE, key, fallback: UI_FALLBACKS[key] })
}

const CAPABILITY_CATALOG = new CapabilityRiskCatalog()

/** Stateful decision model; locale/theme reprojection never reconstructs the request. */
export class PermissionAuthorizationViewModel {
  readonly #selected = new Map<CordisXPermissionCapabilityV2, CordisXPermissionDecisionV2>()
  #settled = false

  constructor(readonly plan: CordisXPermissionAuthorizationPlanV2) {
    const seen = new Set<CordisXPermissionCapabilityV2>()
    for (const item of plan.declarations) {
      if (seen.has(item.capability)) throw new Error(`permission plan contains duplicate capability: ${item.capability}`)
      if (!item.allowedDecisions.includes(item.defaultDecision)) {
        throw new Error(`permission plan default is not allowed: ${item.capability}`)
      }
      if (!item.persistentAllow && item.allowedDecisions.includes('allow-persistent')) {
        throw new Error(`permission plan exposes forbidden persistent allow: ${item.capability}`)
      }
      if (!item.persistentDeny && item.allowedDecisions.includes('deny-persistent')) {
        throw new Error(`permission plan exposes forbidden persistent deny: ${item.capability}`)
      }
      seen.add(item.capability)
      this.#selected.set(item.capability, item.defaultDecision)
    }
  }

  select(capability: CordisXPermissionCapabilityV2, decision: CordisXPermissionDecisionV2): void {
    this.assertOpen()
    const item = this.plan.declarations.find(candidate => candidate.capability === capability)
    if (item === undefined || !item.allowedDecisions.includes(decision)) {
      throw new Error(`permission decision is not allowed: ${capability}/${decision}`)
    }
    this.#selected.set(capability, decision)
  }

  selection(capability: CordisXPermissionCapabilityV2): CordisXPermissionDecisionV2 | undefined {
    return this.#selected.get(capability)
  }

  project(input: PermissionAuthorizationProjectionInput): PermissionAuthorizationDialogProjection {
    const resolve = input.resolve
    const items = this.plan.declarations.map(item => {
      const availability = input.availability[item.capability]
      const selected = this.#selected.get(item.capability)
      const providers = availability?.providerIds ?? item.scope.providers ?? []
      const reviewMode = CAPABILITY_CATALOG.get(item.capability).installPrompt
      return Object.freeze({
        capability: item.capability,
        name: resolve(item.presentation.name),
        requirement: resolve(ui(item.required ? 'dialog.required' : 'dialog.optional')),
        sensitivity: resolve(ui(`dialog.sensitivity.${item.sensitivity}`)),
        reviewMode,
        reviewModeLabel: resolve(ui(`dialog.review-mode.${reviewMode}`)),
        description: resolve(item.presentation.description),
        descriptionLabel: resolve(ui('dialog.can-do')),
        risk: resolve(item.presentation.risk),
        limitation: resolve(item.presentation.limitation),
        limitationLabel: resolve(ui('dialog.cannot-do')),
        scope: input.scope(item.scope),
        scopeLabel: resolve(ui('dialog.scope')),
        ...(availability === undefined ? {} : {
          availability: Object.freeze({
            status: availability.status,
            statusLabel: resolve(ui(`dialog.availability.${availability.status}`)),
            reason: resolve(availability.reason),
          }),
        }),
        ...(item.rationale === undefined ? {} : {
          rationale: Object.freeze({
            label: resolve(ui('dialog.plugin-rationale')),
            title: resolve(item.rationale.title),
            description: resolve(item.rationale.description),
            featureLabel: resolve(ui('dialog.plugin-feature')),
            feature: resolve(item.rationale.feature),
            deniedBehaviorLabel: resolve(ui('dialog.plugin-denied-behavior')),
            deniedBehavior: resolve(item.rationale.deniedBehavior),
          }),
        }),
        authorizationLabel: resolve(ui('dialog.authorization-method')),
        authorizationOptions: Object.freeze(item.allowedDecisions.map(decision => Object.freeze({
          value: decision,
          label: resolve(ui(`dialog.decision.${decision}`)),
          selected: selected === decision,
        }))),
        denialImpact: resolve(ui(item.required ? 'dialog.required-denied' : 'dialog.optional-denied')),
        technical: Object.freeze({
          label: resolve(ui('dialog.technical-details')),
          capabilityId: item.capability,
          capabilityIdLabel: resolve(ui('dialog.capability-id')),
          providers: Object.freeze([...providers]),
          providersLabel: resolve(ui('dialog.provider')),
          runtimeGeneration: this.plan.binding.runtimeGeneration,
          runtimeGenerationLabel: resolve(ui('dialog.runtime-generation')),
          moduleGenerationLabel: resolve(ui('dialog.module-generation')),
          requestSourceLabel: resolve(ui('dialog.request-source')),
          ...(this.plan.binding.moduleGeneration === undefined ? {} : {
            moduleGeneration: this.plan.binding.moduleGeneration,
          }),
          ...(input.requestSource === undefined ? {} : { requestSource: input.requestSource }),
        }),
      })
    })
    const title = `dialog.${this.plan.operation}-title` as keyof typeof UI_FALLBACKS
    return Object.freeze({
      heading: resolve(ui(title)),
      plugin: Object.freeze({
        name: input.plugin.name,
        source: input.plugin.source,
        sourceLabel: resolve(ui('dialog.plugin-source')),
        trust: resolve(ui(`dialog.trust.${input.plugin.trust}`)),
        trustLabel: resolve(ui('dialog.plugin-trust')),
        ...(input.plugin.icon === undefined ? {} : { icon: input.plugin.icon }),
      }),
      items: Object.freeze(items),
      actions: Object.freeze({
        cancel: resolve(ui('dialog.cancel')),
        confirm: resolve(ui('dialog.confirm')),
        manage: resolve(ui('dialog.manage-permissions')),
      }),
    })
  }

  cancel(): PermissionAuthorizationDialogResult {
    this.assertOpen()
    this.#settled = true
    return Object.freeze({ status: 'cancelled' })
  }

  managePermissions(): PermissionAuthorizationDialogResult {
    this.assertOpen()
    this.#settled = true
    return Object.freeze({ status: 'manage-permissions' })
  }

  confirm(): PermissionAuthorizationDialogResult {
    this.assertOpen()
    this.#settled = true
    return Object.freeze({
      status: 'confirmed',
      decision: Object.freeze({
        $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
        schemaVersion: 2,
        planId: this.plan.planId,
        operation: this.plan.operation,
        profileId: this.plan.profileId,
        identity: this.plan.identity,
        binding: this.plan.binding,
        decisions: Object.freeze(this.plan.declarations.map(item => Object.freeze({
          capability: item.capability,
          scope: item.scope,
          securityFingerprint: item.securityFingerprint,
          decision: this.#selected.get(item.capability)!,
        }))),
      }),
    })
  }

  private assertOpen(): void {
    if (this.#settled) throw new Error('permission authorization request is already settled')
  }
}
