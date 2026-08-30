import {
  CORDISX_PERMISSION_CAPABILITIES_V2,
  CORDISX_PERMISSION_CAPABILITIES_V3,
  CORDISX_PERMISSION_CAPABILITIES_V4,
  CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V2,
  CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V3,
  CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V4,
  type CordisXCertifiedPermissionProjectionV1,
  type CordisXCapabilityDeclarationV3,
  type CordisXCapabilityDeclarationV4,
  type CordisXPermissionCapabilityV2,
  type CordisXPermissionCapabilityV3,
  type CordisXPermissionCapabilityV4,
  type CordisXCapabilityDeclarationV2,
  type CordisXPermissionAuthorizationBindingV2,
  type CordisXPermissionDecisionV2,
  type CordisXPermissionHostPresentationV2,
  type CordisXPermissionAuthorizationPlanV2,
  type CordisXPermissionAuthorizationPlanV3,
  type CordisXPermissionAuthorizationPlanV4,
  type CordisXPermissionIdentityV2,
  type CordisXPermissionPolicyRecordV2,
  type CordisXPermissionPolicyRecordV3,
  type CordisXPermissionPolicyRecordV4,
  type CordisXPermissionPolicyV2,
  type CordisXPermissionScopeV2,
  type CordisXPermissionScopeV3,
  type CordisXPermissionScopeV4,
  type CordisXPermissionResourceClassV4,
  type CordisXPermissionSensitivity,
} from './permission-contracts.js'
import {
  normalizeCapabilityDeclarationV2,
  normalizePermissionAuthorizationBindingV2,
  normalizePermissionIdentityV2,
  normalizePermissionLocalIdV2,
  normalizePermissionOperationIdV2,
  normalizePermissionPolicyRecordV2,
  permissionRecordKeyV2,
  permissionSecurityFingerprint,
  reconcilePermissionPolicyV2,
} from './permission-model-v2.js'
import {
  normalizeDomCapabilityDeclarationV3,
  normalizePermissionPolicyRecordV3,
  permissionRecordKeyV3,
  permissionSecurityFingerprintV3,
} from './permission-model-v3.js'
import {
  normalizeCapabilityDeclarationV4,
  normalizePermissionPolicyRecordV4,
  permissionRecordKeyV4,
  permissionSecurityFingerprintV4,
} from './permission-model-v4.js'

// Extending the catalog with a disjoint DOM capability must not invalidate the
// exact fingerprints and durable policies of the original 22 non-DOM entries.
export const CORDISX_CAPABILITY_CATALOG_VERSION = '2026-08-24'
export const CORDISX_CAPABILITY_CATALOG_VERSION_V4 = '2026-08-30'

export type CordisXPermissionProviderFamily = 'platform' | 'agent' | 'channel' | 'ui'
export type CordisXPermissionScopeDimension = keyof CordisXPermissionScopeV4

export interface CordisXCapabilityRiskCatalogEntry {
  readonly capability: CordisXPermissionCapabilityV4
  readonly providerFamily: CordisXPermissionProviderFamily
  readonly resourceClass: CordisXPermissionResourceClassV4
  readonly certifiedImplicitApproval: boolean
  readonly sensitivity: CordisXPermissionSensitivity
  readonly recommendedPolicy: CordisXPermissionPolicyV2
  readonly persistentAllow: boolean
  readonly persistentDeny: boolean
  readonly maximumScope: Readonly<{
    allowedDimensions: readonly CordisXPermissionScopeDimension[]
    unscopedAllowed: boolean
  }>
  readonly scopeUpgrade: 'any-change' | 'strict-expansion'
  readonly installPrompt: 'batch-eligible' | 'explicit'
  readonly runtimePrompt: 'first-use' | 'dynamic-scope' | 'always'
  readonly presentation: CordisXPermissionHostPresentationV2
}

export interface PermissionDecisionContext {
  readonly operation: 'install' | 'update' | 'enable' | 'runtime'
  readonly providerKind: 'current-connection' | 'external-provider' | 'host-local'
  readonly providerTrust: 'native' | 'configured' | 'unverified'
  readonly scope: CordisXPermissionScopeV4
  readonly policy: CordisXPermissionPolicyV2
  readonly availability: 'supported' | 'degraded' | 'unavailable'
  readonly required: boolean
}

export interface PermissionDecisionRecommendation {
  readonly allowedDecisions: readonly CordisXPermissionDecisionV2[]
  readonly defaultDecision: CordisXPermissionDecisionV2
}

function text(capability: CordisXPermissionCapabilityV4, field: string, fallback: string) {
  return Object.freeze({ key: `${capability}.${field}`, fallback })
}

function entry(
  capability: CordisXPermissionCapabilityV4,
  providerFamily: CordisXPermissionProviderFamily,
  sensitivity: CordisXPermissionSensitivity,
  dimensions: readonly CordisXPermissionScopeDimension[],
  unscopedAllowed: boolean,
  copy: readonly [name: string, description: string, risk: string, limitation: string],
  resource: Readonly<{
    resourceClass: CordisXPermissionResourceClassV4
    certifiedImplicitApproval: boolean
    recommendedPolicy?: CordisXPermissionPolicyV2
    persistentAllow?: boolean
    scopeUpgrade?: 'any-change' | 'strict-expansion'
    installPrompt?: 'batch-eligible' | 'explicit'
    runtimePrompt?: 'first-use' | 'dynamic-scope' | 'always'
  }> = Object.freeze({ resourceClass: 'non-dom', certifiedImplicitApproval: false }),
): CordisXCapabilityRiskCatalogEntry {
  const highRisk = sensitivity === 'high-risk'
  const explicit = sensitivity === 'sensitive' || highRisk
  return Object.freeze({
    capability,
    providerFamily,
    resourceClass: resource.resourceClass,
    certifiedImplicitApproval: resource.certifiedImplicitApproval,
    sensitivity,
    recommendedPolicy: resource.recommendedPolicy ?? (sensitivity === 'low' || sensitivity === 'general' ? 'allow-persistent' : 'ask'),
    persistentAllow: resource.persistentAllow ?? !highRisk,
    persistentDeny: true,
    maximumScope: Object.freeze({ allowedDimensions: Object.freeze([...dimensions]), unscopedAllowed }),
    scopeUpgrade: resource.scopeUpgrade ?? (highRisk ? 'any-change' : 'strict-expansion'),
    installPrompt: resource.installPrompt ?? (explicit ? 'explicit' : 'batch-eligible'),
    runtimePrompt: resource.runtimePrompt ?? (highRisk ? 'always' : explicit ? 'dynamic-scope' : 'first-use'),
    presentation: Object.freeze({
      name: text(capability, 'name', copy[0]),
      description: text(capability, 'description', copy[1]),
      risk: text(capability, 'risk', copy[2]),
      limitation: text(capability, 'limitation', copy[3]),
    }),
  })
}

export const HOST_CAPABILITY_RISK_ENTRIES = Object.freeze([
  entry('models.read', 'platform', 'low', ['providers'], true, [
    'Read available models', 'List models exposed by an allowed provider.',
    'This reveals configured model availability.', 'It cannot read conversations or credentials.',
  ]),
  entry('tasks.catalog.read', 'platform', 'general', ['providers', 'cwdRoots'], true, [
    'List tasks', 'List task summaries for allowed providers and workspaces.',
    'Task titles and workspace metadata may be visible.', 'It cannot read task content.',
  ]),
  entry('tasks.content.read', 'platform', 'sensitive', ['sessions'], false, [
    'Read task content', 'Read messages and results from allowed tasks.',
    'Task content may contain private or sensitive text.', 'Only explicitly allowed task identities are readable.',
  ]),
  entry('tasks.create', 'platform', 'sensitive', ['providers', 'cwdRoots'], false, [
    'Create tasks', 'Create tasks and optionally submit their first message.',
    'The selected provider receives the initial task content.', 'Provider, model, and workspace remain Host validated.',
  ]),
  entry('tasks.control', 'platform', 'high-risk', ['sessions'], false, [
    'Control tasks', 'Continue, fork, archive, restore, or delete allowed tasks.',
    'Destructive actions can remove or replace task state.', 'Every target and action remains Host validated.',
  ]),
  entry('turns.submit', 'platform', 'sensitive', ['sessions'], false, [
    'Submit turns', 'Send a new message to an allowed task.',
    'Submitted content is sent to the selected provider.', 'Only allowed task identities can receive content.',
  ]),
  entry('turns.control', 'platform', 'high-risk', ['sessions'], false, [
    'Control active turns', 'Steer or interrupt an active turn.',
    'This can change or stop in-progress work.', 'Only the explicitly targeted turn is affected.',
  ]),
  entry('agent.events.read', 'agent', 'sensitive', ['sessionIds'], false, [
    'Read Agent events', 'Read structured events for allowed Agent sessions.',
    'Events can reveal task activity and tool metadata.', 'Raw bridge and filesystem access remain unavailable.',
  ]),
  entry('agent.history.read', 'agent', 'sensitive', ['sessionIds'], false, [
    'Read Agent history', 'Read redacted historical Agent projections.',
    'Historical activity may contain sensitive context.', 'The Host keeps paths and raw storage private.',
  ]),
  entry('agent.messages.append', 'agent', 'sensitive', ['sessionIds'], false, [
    'Append Agent messages', 'Append attributed content to an allowed Agent session.',
    'Added content can influence subsequent model input.', 'The Host preserves attribution and ordering.',
  ]),
  entry('agent.steps.reject', 'agent', 'high-risk', ['sessionIds'], false, [
    'Reject Agent steps', 'Reject an Agent step before it proceeds.',
    'This can stop or alter Agent execution.', 'Only the current allowed step may be rejected.',
  ]),
  entry('agent.messages.transform', 'agent', 'high-risk', ['sessionIds'], false, [
    'Transform Agent messages', 'Transform attributed messages before model use.',
    'This can materially change model input.', 'Original order and attribution remain Host controlled.',
  ]),
  entry('agent.prompt.section', 'agent', 'sensitive', ['sessionIds'], false, [
    'Add prompt sections', 'Add an attributed section to model input.',
    'Added text can influence model behavior.', 'The Host controls ordering and attribution.',
  ]),
  entry('agent.prompt.context', 'agent', 'sensitive', ['sessionIds'], false, [
    'Add prompt context', 'Add attributed context to model input.',
    'Added context can influence model behavior.', 'The Host controls ordering and attribution.',
  ]),
  entry('channel.accounts.read', 'channel', 'general', ['channelAccounts', 'channelTenants'], true, [
    'Read Channel accounts', 'List configured Channel account descriptors.',
    'Account identity and readiness may be visible.', 'Credentials and secret references remain private.',
  ]),
  entry('channel.accounts.connect', 'channel', 'sensitive', ['channelAccounts', 'channelTenants'], false, [
    'Connect Channel accounts', 'Start a Host-owned Channel account connection.',
    'The external account may begin receiving events.', 'Credentials and transport stay Host owned.',
  ]),
  entry('channel.events.receive', 'channel', 'sensitive', ['channelAccounts', 'channelTenants', 'channelConversations', 'channelUsers'], false, [
    'Receive Channel events', 'Receive sourced events from allowed Channel identities.',
    'Events can contain private external conversation content.', 'The Host enforces identity, tenant, and conversation scope.',
  ]),
  entry('channel.events.subscribe', 'channel', 'sensitive', ['channelAccounts', 'channelTenants', 'channelConversations', 'channelUsers'], false, [
    'Subscribe to Channel events', 'Keep a live subscription to allowed Channel events.',
    'A subscription can continuously expose external activity.', 'The Host owns cancellation and connection lifetime.',
  ]),
  entry('channel.messages.send', 'channel', 'high-risk', ['channelAccounts', 'channelTenants', 'channelConversations', 'channelUsers'], false, [
    'Send Channel messages', 'Send content to an external Channel conversation.',
    'This performs an external action as the connected account.', 'Every account and conversation remains explicitly scoped.',
  ]),
  entry('channel.bindings.read', 'channel', 'general', ['channelAccounts', 'channelTenants', 'channelConversations'], true, [
    'Read Channel bindings', 'Read mappings between Channel conversations and Platform sessions.',
    'Bindings reveal cross-system identity relationships.', 'Message content and credentials are not included.',
  ]),
  entry('channel.bindings.write', 'channel', 'high-risk', ['channelAccounts', 'channelTenants', 'channelConversations'], false, [
    'Change Channel bindings', 'Create or replace conversation-to-session mappings.',
    'Incorrect bindings can route future messages to the wrong session.', 'The Host validates both sides of every binding.',
  ]),
  entry('channel.attachments.read', 'channel', 'sensitive', ['channelAccounts', 'channelTenants', 'channelConversations', 'channelUsers'], false, [
    'Read Channel attachments', 'Read attachments from allowed Channel conversations.',
    'Attachments may contain private files or sensitive data.', 'Only Host-fetched content within declared scope is available.',
  ]),
  entry('ui.extension-points.render', 'ui', 'general', ['extensionPoints'], false, [
    'Render controlled interface contributions', 'Render structured contributions at allowed Host extension points.',
    'The contribution changes visible Host interface content.', 'Raw DOM selectors, nodes, scripts, styles, and bridges remain unavailable.',
  ], {
    resourceClass: 'dom-rendering', certifiedImplicitApproval: true, recommendedPolicy: 'ask',
    installPrompt: 'explicit', runtimePrompt: 'dynamic-scope',
  }),
  entry('ui.host-dom.read', 'ui', 'sensitive', ['rootIds', 'operations'], false, [
    'Read bounded Host interface state', 'Read bounded, redacted state from allowed Host interface roots.',
    'Visible user text and interface state may be exposed.', 'Only catalog roots, closed operations, bounded projections, and opaque node references are available.',
  ], { resourceClass: 'host-dom', certifiedImplicitApproval: true }),
  entry('ui.host-dom.modify', 'ui', 'high-risk', ['rootIds', 'operations'], false, [
    'Modify bounded Host interface state', 'Modify allowed Host interface roots through closed reversible operations.',
    'Visible content, safe attributes, owned children, or focus may change.', 'No raw HTML, selector, style, script, event handler, node, callback, or private bridge is available.',
  ], {
    resourceClass: 'host-dom', certifiedImplicitApproval: true, persistentAllow: false,
    scopeUpgrade: 'strict-expansion', installPrompt: 'explicit', runtimePrompt: 'always',
  }),
] satisfies readonly CordisXCapabilityRiskCatalogEntry[])

export class CapabilityRiskCatalog {
  readonly version = CORDISX_CAPABILITY_CATALOG_VERSION
  readonly versionV4 = CORDISX_CAPABILITY_CATALOG_VERSION_V4
  readonly #entries = new Map<CordisXPermissionCapabilityV4, CordisXCapabilityRiskCatalogEntry>()

  constructor(
    entries: readonly CordisXCapabilityRiskCatalogEntry[] = HOST_CAPABILITY_RISK_ENTRIES,
    accepted: readonly CordisXPermissionCapabilityV4[] = CORDISX_PERMISSION_CAPABILITIES_V4,
  ) {
    for (const item of entries) {
      if (this.#entries.has(item.capability)) throw new Error(`duplicate capability catalog entry: ${item.capability}`)
      if (item.maximumScope.allowedDimensions.length !== new Set(item.maximumScope.allowedDimensions).size) {
        throw new Error(`duplicate maximum scope dimension: ${item.capability}`)
      }
      if (item.sensitivity === 'high-risk' && item.persistentAllow) {
        throw new Error(`high-risk capability cannot allow persistent grants: ${item.capability}`)
      }
      if (item.capability === 'ui.extension-points.render') {
        if (item.providerFamily !== 'ui' || item.resourceClass !== 'dom-rendering' || !item.certifiedImplicitApproval) {
          throw new Error('ui.extension-points.render must be the catalog-owned certified DOM capability')
        }
      } else if (item.capability === 'ui.host-dom.read' || item.capability === 'ui.host-dom.modify') {
        if (item.providerFamily !== 'ui' || item.resourceClass !== 'host-dom' || !item.certifiedImplicitApproval
          || item.maximumScope.allowedDimensions.join(',') !== 'rootIds,operations' || item.maximumScope.unscopedAllowed) {
          throw new Error(`${item.capability} must be the catalog-owned bounded Host DOM capability`)
        }
        if (item.capability === 'ui.host-dom.read' && item.sensitivity !== 'sensitive') {
          throw new Error('ui.host-dom.read must remain sensitive')
        }
        if (item.capability === 'ui.host-dom.modify' && (item.sensitivity !== 'high-risk' || item.persistentAllow)) {
          throw new Error('ui.host-dom.modify must remain high-risk without persistent allow')
        }
      } else if (item.resourceClass !== 'non-dom' || item.certifiedImplicitApproval) {
        throw new Error(`non-DOM capability cannot use certified implicit approval: ${item.capability}`)
      }
      this.#entries.set(item.capability, Object.freeze(item))
    }
    for (const capability of accepted) {
      if (!this.#entries.has(capability)) throw new Error(`capability catalog metadata missing: ${capability}`)
    }
    for (const capability of this.#entries.keys()) {
      if (!accepted.includes(capability)) throw new Error(`capability catalog contains unsupported entry: ${capability}`)
    }
  }

  get(capability: CordisXPermissionCapabilityV4): CordisXCapabilityRiskCatalogEntry {
    const item = this.#entries.get(capability)
    if (item === undefined) throw new Error(`capability catalog metadata missing: ${capability}`)
    return item
  }

  snapshot(): readonly CordisXCapabilityRiskCatalogEntry[] {
    return Object.freeze(CORDISX_PERMISSION_CAPABILITIES_V4.map(capability => this.get(capability)))
  }

  assertScope(capability: CordisXPermissionCapabilityV4, scope: CordisXPermissionScopeV4): void {
    const item = this.get(capability)
    const dimensions = Object.entries(scope).filter(([, value]) => value !== undefined).map(([key]) => key)
    const unknown = dimensions.find(key => !item.maximumScope.allowedDimensions.includes(key as CordisXPermissionScopeDimension))
    if (unknown !== undefined) throw new Error(`${capability} scope dimension ${unknown} exceeds the Host catalog maximum`)
    if (!item.maximumScope.unscopedAllowed && dimensions.length === 0) {
      throw new Error(`${capability} requires an explicit scope`)
    }
  }
}

export class PermissionDecisionEngine {
  constructor(private readonly catalog: CapabilityRiskCatalog = new CapabilityRiskCatalog()) {}

  recommend(
    capability: CordisXPermissionCapabilityV4,
    context: PermissionDecisionContext,
  ): PermissionDecisionRecommendation {
    const item = this.catalog.get(capability)
    this.catalog.assertScope(capability, context.scope)
    const allowed: CordisXPermissionDecisionV2[] = ['allow-once', 'deny-once']
    if (item.persistentAllow) allowed.push('allow-persistent')
    if (item.persistentDeny) allowed.push('deny-persistent')

    let decision: CordisXPermissionDecisionV2
    if (context.policy === 'deny-persistent' && item.persistentDeny) decision = 'deny-persistent'
    else if (context.policy === 'allow-persistent' && item.persistentAllow) decision = 'allow-persistent'
    else if (item.sensitivity === 'high-risk') {
      decision = context.providerTrust === 'unverified' || context.operation === 'install'
        ? 'deny-once'
        : 'allow-once'
    } else if (item.sensitivity === 'sensitive') decision = 'allow-once'
    else decision = item.persistentAllow ? 'allow-persistent' : 'allow-once'

    if (decision === 'allow-persistent' && (
      context.policy === 'ask'
      && context.providerKind === 'external-provider'
      && context.providerTrust !== 'configured'
    )) decision = 'allow-once'

    return Object.freeze({
      allowedDecisions: Object.freeze(allowed),
      defaultDecision: decision,
    })
  }
}

export interface PermissionAuthorizationPlanInput {
  readonly planId: string
  readonly operation: CordisXPermissionAuthorizationPlanV2['operation']
  readonly profileId: string
  readonly identity: CordisXPermissionIdentityV2
  readonly binding: CordisXPermissionAuthorizationBindingV2
  readonly declarations: readonly CordisXCapabilityDeclarationV2[]
  readonly policies: readonly CordisXPermissionPolicyRecordV2[]
  readonly contextFor: (declaration: CordisXCapabilityDeclarationV2) => Omit<PermissionDecisionContext, 'policy' | 'scope' | 'required'>
}

export interface PermissionReviewGroups {
  readonly batchEligible: readonly CordisXPermissionAuthorizationPlanV2['declarations'][number][]
  readonly explicit: readonly CordisXPermissionAuthorizationPlanV2['declarations'][number][]
}

export interface PermissionAuthorizationPlanBuildResult {
  readonly plan: CordisXPermissionAuthorizationPlanV2
  readonly policyMigrations: readonly CordisXPermissionPolicyRecordV2[]
}

export function buildPermissionAuthorizationPlanResultV2(
  input: PermissionAuthorizationPlanInput,
  catalog = new CapabilityRiskCatalog(),
  engine = new PermissionDecisionEngine(catalog),
): PermissionAuthorizationPlanBuildResult {
  const planId = normalizePermissionOperationIdV2(input.planId, 'permission plan id')
  const profileId = normalizePermissionLocalIdV2(input.profileId, 'permission plan profile id')
  const identity = normalizePermissionIdentityV2(input.identity, 'permission plan identity')
  const policies = input.policies.map(item => normalizePermissionPolicyRecordV2(item))
  const policyMigrations: CordisXPermissionPolicyRecordV2[] = []
  const seen = new Set<CordisXPermissionCapabilityV2>()
  const declarations = input.declarations.map((candidate, index) => {
    const declaration = normalizeCapabilityDeclarationV2(candidate, `capabilities[${index}]`)
    if (seen.has(declaration.name)) throw new Error(`duplicate capability declaration: ${declaration.name}`)
    seen.add(declaration.name)
    catalog.assertScope(declaration.name, declaration.scope)
    const fingerprint = permissionSecurityFingerprint(catalog.version, declaration)
    const metadata = catalog.get(declaration.name)
    const reconciliation = reconcilePermissionPolicyV2({
      profileId,
      identity,
      catalogVersion: catalog.version,
      declaration,
      records: policies,
      persistentAllow: metadata.persistentAllow,
      persistentDeny: metadata.persistentDeny,
    })
    const policy = reconciliation.policy
    if (reconciliation.migration !== undefined) policyMigrations.push(reconciliation.migration)
    const recommendation = engine.recommend(declaration.name, {
      ...input.contextFor(declaration),
      policy,
      scope: declaration.scope,
      required: declaration.required,
    })
    return Object.freeze({
      capability: declaration.name,
      required: declaration.required,
      ...(declaration.rationale === undefined ? {} : { rationale: declaration.rationale }),
      ...(declaration.security === undefined ? {} : { security: declaration.security }),
      scope: declaration.scope,
      securityFingerprint: fingerprint,
      policy,
      decisionRequired: policy === 'ask',
      sensitivity: metadata.sensitivity,
      persistentAllow: metadata.persistentAllow,
      persistentDeny: metadata.persistentDeny,
      allowedDecisions: recommendation.allowedDecisions,
      defaultDecision: recommendation.defaultDecision,
      presentation: metadata.presentation,
    })
  })
  const plan = Object.freeze({
    $schema: CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V2,
    schemaVersion: 2,
    planId,
    operation: input.operation,
    profileId,
    identity,
    catalogVersion: catalog.version,
    binding: normalizePermissionAuthorizationBindingV2(input.binding),
    declarations: Object.freeze(declarations),
  })
  return Object.freeze({ plan, policyMigrations: Object.freeze(policyMigrations) })
}

export function buildPermissionAuthorizationPlanV2(
  input: PermissionAuthorizationPlanInput,
  catalog = new CapabilityRiskCatalog(),
  engine = new PermissionDecisionEngine(catalog),
): CordisXPermissionAuthorizationPlanV2 {
  return buildPermissionAuthorizationPlanResultV2(input, catalog, engine).plan
}

export interface DomPermissionAuthorizationPlanInputV3 {
  readonly planId: string
  readonly profileId: string
  readonly identity: CordisXPermissionIdentityV2
  readonly binding: CordisXPermissionAuthorizationBindingV2
  readonly declaration: CordisXCapabilityDeclarationV3
  readonly policies: readonly CordisXPermissionPolicyRecordV3[]
  readonly certification?: CordisXCertifiedPermissionProjectionV1
}

/** Builds a runtime controlled-render plan through the same catalog and policy engine as v2. */
export function buildDomPermissionAuthorizationPlanV3(
  input: DomPermissionAuthorizationPlanInputV3,
  catalog = new CapabilityRiskCatalog(),
  engine = new PermissionDecisionEngine(catalog),
): CordisXPermissionAuthorizationPlanV3 {
  const planId = normalizePermissionOperationIdV2(input.planId, 'DOM permission plan id')
  const profileId = normalizePermissionLocalIdV2(input.profileId, 'DOM permission profile id')
  const identity = normalizePermissionIdentityV2(input.identity, 'DOM permission identity')
  const binding = normalizePermissionAuthorizationBindingV2(input.binding)
  const declaration = normalizeDomCapabilityDeclarationV3(input.declaration)
  catalog.assertScope(declaration.name, declaration.scope)
  const metadata = catalog.get(declaration.name)
  const securityFingerprint = permissionSecurityFingerprintV3(catalog.version, declaration)
  const target = normalizePermissionPolicyRecordV3({
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-policy.v3.schema.json',
    schemaVersion: 3,
    key: { profileId, identity, capability: declaration.name, scope: declaration.scope, securityFingerprint },
    policy: 'ask',
  })
  const exactKey = permissionRecordKeyV3(target)
  const policy = input.policies.map(item => normalizePermissionPolicyRecordV3(item))
    .find(item => permissionRecordKeyV3(item) === exactKey)?.policy ?? 'ask'
  const certification = input.certification !== undefined
    && input.certification.source === identity.source
    && input.certification.pluginId === identity.pluginId
    ? input.certification
    : undefined
  const certifiedImplicitEligible = metadata.resourceClass === 'dom-rendering'
    && metadata.certifiedImplicitApproval
  const authorizationMode = policy === 'ask'
    ? certification === undefined || !certifiedImplicitEligible ? 'explicit-user' as const : 'certified-implicit' as const
    : 'persistent-policy' as const
  const recommendation = engine.recommend(declaration.name, {
    operation: 'runtime',
    providerKind: 'host-local',
    providerTrust: 'configured',
    scope: declaration.scope,
    policy,
    availability: 'supported',
    required: declaration.required,
  })
  return Object.freeze({
    $schema: CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V3,
    schemaVersion: 3,
    planId,
    operation: 'runtime',
    profileId,
    identity,
    catalogVersion: catalog.version,
    binding,
    declarations: Object.freeze([Object.freeze({
      capability: declaration.name,
      required: declaration.required,
      scope: declaration.scope,
      securityFingerprint,
      policy,
      decisionRequired: authorizationMode === 'explicit-user',
      authorizationMode,
      resourceClass: 'dom-rendering' as const,
      certifiedImplicitApproval: metadata.certifiedImplicitApproval,
      ...(authorizationMode === 'certified-implicit' && certification !== undefined ? { certification } : {}),
      sensitivity: metadata.sensitivity,
      persistentAllow: metadata.persistentAllow,
      persistentDeny: metadata.persistentDeny,
      allowedDecisions: recommendation.allowedDecisions,
      defaultDecision: recommendation.defaultDecision,
      presentation: metadata.presentation,
    })]),
  })
}

export interface HostDomPermissionAuthorizationPlanInputV4 {
  readonly planId: string
  readonly profileId: string
  readonly identity: CordisXPermissionIdentityV2
  readonly binding: CordisXPermissionAuthorizationBindingV2
  readonly declaration: CordisXCapabilityDeclarationV4
  readonly policies: readonly CordisXPermissionPolicyRecordV4[]
  readonly certification?: CordisXCertifiedPermissionProjectionV1
}

/** Builds one bounded Host DOM plan through the same catalog and policy engine as every other permission. */
export function buildHostDomPermissionAuthorizationPlanV4(
  input: HostDomPermissionAuthorizationPlanInputV4,
  catalog = new CapabilityRiskCatalog(),
  engine = new PermissionDecisionEngine(catalog),
): CordisXPermissionAuthorizationPlanV4 {
  const planId = normalizePermissionOperationIdV2(input.planId, 'Host DOM permission plan id')
  const profileId = normalizePermissionLocalIdV2(input.profileId, 'Host DOM permission profile id')
  const identity = normalizePermissionIdentityV2(input.identity, 'Host DOM permission identity')
  const binding = normalizePermissionAuthorizationBindingV2(input.binding)
  const declaration = normalizeCapabilityDeclarationV4(input.declaration)
  if (declaration.name !== 'ui.host-dom.read' && declaration.name !== 'ui.host-dom.modify') {
    throw new Error('Host DOM permission plan requires a Host DOM capability')
  }
  catalog.assertScope(declaration.name, declaration.scope)
  const metadata = catalog.get(declaration.name)
  const securityFingerprint = permissionSecurityFingerprintV4(catalog.versionV4, declaration)
  const target = normalizePermissionPolicyRecordV4({
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-policy.v4.schema.json',
    schemaVersion: 4,
    key: { profileId, identity, capability: declaration.name, scope: declaration.scope, securityFingerprint },
    policy: 'ask',
  })
  const exactKey = permissionRecordKeyV4(target)
  const policy = input.policies.map(item => normalizePermissionPolicyRecordV4(item))
    .find(item => permissionRecordKeyV4(item) === exactKey)?.policy ?? 'ask'
  const certification = input.certification !== undefined
    && input.certification.source === identity.source
    && input.certification.pluginId === identity.pluginId
    ? input.certification
    : undefined
  const certifiedImplicitEligible = metadata.resourceClass === 'host-dom' && metadata.certifiedImplicitApproval
  const authorizationMode = policy === 'ask'
    ? certification === undefined || !certifiedImplicitEligible ? 'explicit-user' as const : 'certified-implicit' as const
    : 'persistent-policy' as const
  const recommendation = engine.recommend(declaration.name, {
    operation: 'runtime',
    providerKind: 'host-local',
    providerTrust: 'configured',
    scope: declaration.scope,
    policy,
    availability: 'supported',
    required: declaration.required,
  })
  return Object.freeze({
    $schema: CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V4,
    schemaVersion: 4,
    planId,
    operation: 'runtime',
    profileId,
    identity,
    catalogVersion: catalog.versionV4,
    binding,
    declarations: Object.freeze([Object.freeze({
      capability: declaration.name,
      required: declaration.required,
      ...(declaration.rationale === undefined ? {} : { rationale: declaration.rationale }),
      ...(declaration.security === undefined ? {} : { security: declaration.security }),
      scope: declaration.scope,
      securityFingerprint,
      policy,
      decisionRequired: authorizationMode === 'explicit-user',
      authorizationMode,
      resourceClass: metadata.resourceClass,
      certifiedImplicitApproval: metadata.certifiedImplicitApproval,
      ...(authorizationMode === 'certified-implicit' && certification !== undefined ? { certification } : {}),
      sensitivity: metadata.sensitivity,
      persistentAllow: metadata.persistentAllow,
      persistentDeny: metadata.persistentDeny,
      allowedDecisions: recommendation.allowedDecisions,
      defaultDecision: recommendation.defaultDecision,
      presentation: metadata.presentation,
    })]),
  })
}

export interface PermissionAuthorizationPlanInputV4 {
  readonly planId: string
  readonly operation: CordisXPermissionAuthorizationPlanV4['operation']
  readonly profileId: string
  readonly identity: CordisXPermissionIdentityV2
  readonly binding: CordisXPermissionAuthorizationBindingV2
  readonly declarations: readonly CordisXCapabilityDeclarationV4[]
  readonly policiesV2: readonly CordisXPermissionPolicyRecordV2[]
  readonly policiesV4: readonly CordisXPermissionPolicyRecordV4[]
  readonly certification?: CordisXCertifiedPermissionProjectionV1
}

/** Builds one manifest-v5 review while retaining v2 ledger keys for the original 22 capabilities. */
export function buildPermissionAuthorizationPlanV4(
  input: PermissionAuthorizationPlanInputV4,
  catalog = new CapabilityRiskCatalog(),
  engine = new PermissionDecisionEngine(catalog),
): CordisXPermissionAuthorizationPlanV4 {
  const planId = normalizePermissionOperationIdV2(input.planId, 'permission v4 plan id')
  const profileId = normalizePermissionLocalIdV2(input.profileId, 'permission v4 profile id')
  const identity = normalizePermissionIdentityV2(input.identity, 'permission v4 identity')
  const binding = normalizePermissionAuthorizationBindingV2(input.binding)
  const certification = input.certification !== undefined
    && input.certification.source === identity.source && input.certification.pluginId === identity.pluginId
    ? input.certification
    : undefined
  const seen = new Set<CordisXPermissionCapabilityV4>()
  const declarations = input.declarations.map((candidate, index) => {
    const declaration = normalizeCapabilityDeclarationV4(candidate, `capabilities[${index}]`)
    if (seen.has(declaration.name)) throw new Error(`duplicate capability declaration: ${declaration.name}`)
    seen.add(declaration.name)
    catalog.assertScope(declaration.name, declaration.scope)
    const metadata = catalog.get(declaration.name)
    const hostDom = declaration.name === 'ui.host-dom.read' || declaration.name === 'ui.host-dom.modify'
    let securityFingerprint: `sha256:${string}`
    let policy: CordisXPermissionPolicyV2
    if (hostDom) {
      securityFingerprint = permissionSecurityFingerprintV4(catalog.versionV4, declaration)
      const target = normalizePermissionPolicyRecordV4({
        $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-policy.v4.schema.json',
        schemaVersion: 4,
        key: { profileId, identity, capability: declaration.name, scope: declaration.scope, securityFingerprint },
        policy: 'ask',
      })
      const key = permissionRecordKeyV4(target)
      policy = input.policiesV4.map(record => normalizePermissionPolicyRecordV4(record))
        .find(record => permissionRecordKeyV4(record) === key)?.policy ?? 'ask'
    } else {
      const legacy = normalizeCapabilityDeclarationV2(declaration)
      securityFingerprint = permissionSecurityFingerprint(catalog.version, legacy)
      const target = normalizePermissionPolicyRecordV2({
        $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-policy.v2.schema.json',
        schemaVersion: 2,
        key: { profileId, identity, capability: legacy.name, scope: legacy.scope, securityFingerprint },
        policy: 'ask',
      })
      const key = permissionRecordKeyV2(target)
      policy = input.policiesV2.map(record => normalizePermissionPolicyRecordV2(record))
        .find(record => permissionRecordKeyV2(record) === key)?.policy ?? 'ask'
    }
    const certified = hostDom && metadata.resourceClass === 'host-dom' && metadata.certifiedImplicitApproval
      ? certification
      : undefined
    const authorizationMode = policy === 'ask'
      ? certified === undefined ? 'explicit-user' as const : 'certified-implicit' as const
      : 'persistent-policy' as const
    const recommendation = engine.recommend(declaration.name, {
      operation: input.operation,
      providerKind: metadata.providerFamily === 'platform' ? 'current-connection' : 'host-local',
      providerTrust: 'configured',
      scope: declaration.scope,
      policy,
      availability: 'supported',
      required: declaration.required,
    })
    return Object.freeze({
      capability: declaration.name,
      required: declaration.required,
      ...(declaration.rationale === undefined ? {} : { rationale: declaration.rationale }),
      ...(declaration.security === undefined ? {} : { security: declaration.security }),
      scope: declaration.scope,
      securityFingerprint,
      policy,
      decisionRequired: authorizationMode === 'explicit-user',
      authorizationMode,
      resourceClass: metadata.resourceClass,
      certifiedImplicitApproval: metadata.certifiedImplicitApproval,
      ...(authorizationMode === 'certified-implicit' && certified !== undefined ? { certification: certified } : {}),
      sensitivity: metadata.sensitivity,
      persistentAllow: metadata.persistentAllow,
      persistentDeny: metadata.persistentDeny,
      allowedDecisions: recommendation.allowedDecisions,
      defaultDecision: recommendation.defaultDecision,
      presentation: metadata.presentation,
    })
  })
  return Object.freeze({
    $schema: CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V4,
    schemaVersion: 4,
    planId,
    operation: input.operation,
    profileId,
    identity,
    catalogVersion: catalog.versionV4,
    binding,
    declarations: Object.freeze(declarations),
  })
}

export function partitionPermissionReviewPlan(
  plan: CordisXPermissionAuthorizationPlanV2,
  catalog = new CapabilityRiskCatalog(),
): PermissionReviewGroups {
  const batchEligible = plan.declarations.filter(item => catalog.get(item.capability).installPrompt === 'batch-eligible')
  const explicit = plan.declarations.filter(item => catalog.get(item.capability).installPrompt === 'explicit')
  return Object.freeze({ batchEligible: Object.freeze(batchEligible), explicit: Object.freeze(explicit) })
}
