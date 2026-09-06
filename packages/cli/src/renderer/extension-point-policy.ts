import type {
  CordisXEffectivePointPolicy,
  CordisXExtensionPointAccessV2,
  CordisXExtensionPointAdapterSupport,
  CordisXExtensionPointAvailability,
  CordisXExtensionPointCurrentContextState,
  CordisXExtensionPointIdentity,
  CordisXExtensionPointKind,
  CordisXExtensionPointMaturity,
  CordisXExtensionPointPayloadFamily,
  CordisXExtensionPointPolicyRecordV1,
  CordisXExtensionPointRuntimeContextV1,
  CordisXExtensionPointStability,
  CordisXHostExtensionPointAnchorDescriptorV2,
  CordisXHostExtensionPointAnchorDescriptorV5,
  CordisXHostExtensionPointCatalogV1,
  CordisXHostExtensionPointCatalogV2,
  CordisXHostExtensionPointCatalogV3,
  CordisXHostExtensionPointCatalogV5,
  CordisXHostExtensionPointCatalogV6,
  CordisXHostExtensionPointCatalogV7,
  CordisXHostExtensionPointCatalogV8,
  CordisXHostExtensionPointDescriptor,
  CordisXHostExtensionPointDescriptorV3,
  CordisXHostExtensionPointDescriptorV5,
  CordisXLocaleCatalog,
  CordisXLocalizedProjection,
  CordisXLocalizedText,
  CordisXPluginIdentity,
  CordisXPointPolicy,
} from '../contracts.js'
import {
  CORDISX_EXTENSION_POINT_ACCESS_SCHEMA_V2,
  CORDISX_EXTENSION_POINT_POLICY_SCHEMA_V1,
  CORDISX_EXTENSION_POINT_RUNTIME_CONTEXT_SCHEMA_V1,
  CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V1,
  CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V2,
  CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V3,
  CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V5,
  CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V6,
  CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V7,
  CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V8,
} from '../contracts.js'
import type { CordisXI18nService } from './i18n.js'
import type { CommandSnapshot } from './commands.js'
import type { NavigationSnapshot, RouteSnapshot } from './navigation.js'
import type { SurfaceContributionSnapshot, SurfaceCurrentContextSnapshot } from './surfaces.js'
import { qualifyOwnedId } from './ownership.js'
import type {
  GenerationVisibilityCoordinator,
  PluginGenerationEffectIdentity,
  PluginGenerationView,
} from './generation-visibility.js'
import { assertLocalId, assertLocalizedText, ICON_TOKEN_PATTERN, immutableSnapshot } from './validation.js'

import { ExtensionPointDescriptorRegistry } from './extension-point-descriptors.js'
import {
  canonicalExtensionPointSource,
  type ExtensionPointAccessDecision,
  type ExtensionPointAccessDiagnostic,
  type ExtensionPointAccessFields,
  type ExtensionPointAccessResolver,
  type ExtensionPointAuthorizationAuthority,
  extensionPointIdentityKey,
  type ExtensionPointPolicyDiagnostic,
  type ExtensionPointPolicyStore,
  validStoredPolicy,
} from './extension-point-runtime-snapshot.js'

export class ExtensionPointPolicyBroker implements ExtensionPointAccessResolver {
  private readonly identities = new Map<string, {
    readonly identity: CordisXPluginIdentity
    readonly generation: PluginGenerationEffectIdentity
    readonly candidateView?: PluginGenerationView
  }>()
  private readonly policies = new Map<string, CordisXExtensionPointPolicyRecordV1>()
  private readonly duplicatePolicyKeys = new Set<string>()
  private readonly duplicatePolicyIdentities = new Map<string, CordisXExtensionPointIdentity>()
  private readonly accesses: ExtensionPointAccessDiagnostic[] = []
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly descriptors: ExtensionPointDescriptorRegistry,
    private readonly store: ExtensionPointPolicyStore,
    private readonly generation = 'generation-legacy',
    private readonly visibility?: GenerationVisibilityCoordinator,
    private readonly authorization?: ExtensionPointAuthorizationAuthority,
  ) {
    for (const record of store.read()) {
      if (!validStoredPolicy(record)) continue
      const key = extensionPointIdentityKey(record.identity)
      if (this.policies.has(key) || this.duplicatePolicyKeys.has(key)) {
        this.policies.delete(key)
        this.duplicatePolicyKeys.add(key)
        this.duplicatePolicyIdentities.set(key, immutableSnapshot(record.identity))
        continue
      }
      this.policies.set(key, immutableSnapshot(record))
    }
    visibility?.connect({ notify: () => this.changed() })
  }

  register(
    identity: CordisXPluginIdentity,
    generation: PluginGenerationEffectIdentity = Object.freeze({ pluginId: identity.id }),
    candidateView?: PluginGenerationView,
  ): () => void {
    assertLocalId(identity.id, 'extension point plugin id')
    const source = canonicalExtensionPointSource(identity.source)
    if (source !== identity.source) throw new Error(`plugin ${identity.id} source must use canonical serialization`)
    const frozen = Object.freeze({ ...identity })
    const physicalId = `${identity.id}\u0000${generation.moduleGeneration ?? 'host'}`
    if (this.identities.has(physicalId)) throw new Error(`plugin id ${identity.id} generation is already bound`)
    const registration = { identity: frozen, generation, ...(candidateView === undefined ? {} : { candidateView }) }
    this.identities.set(physicalId, registration)
    if (this.visibility?.visible(generation) !== false) this.changed()
    return () => {
      if (this.identities.get(physicalId) !== registration) return
      this.identities.delete(physicalId)
      if (this.visibility?.visible(generation) !== false) this.changed()
    }
  }

  private identity(owner: string, view?: PluginGenerationView): CordisXPluginIdentity | undefined {
    return [...this.identities.values()].find(item =>
      item.identity.id === owner
      && (this.visibility?.visible(item.generation, view) ?? true)
    )?.identity
  }

  pointPolicy(identity: CordisXExtensionPointIdentity): CordisXPointPolicy {
    if (this.authorization !== undefined) {
      return this.authorization.policy({ source: identity.source, id: identity.pluginId }, identity.pointId)
    }
    const key = extensionPointIdentityKey(identity)
    if (this.duplicatePolicyKeys.has(key)) return 'inherit'
    return this.policies.get(key)?.policy ?? 'inherit'
  }

  surfaceAnchorSupport(pointId: string, anchorId: string): Readonly<{ supported: boolean; reason?: string }> {
    const descriptor = this.descriptors.descriptor(pointId)
    const anchor = descriptor?.anchors?.find(item => item.id === anchorId)
    if (descriptor === undefined) return { supported: false, reason: `unknown extension point: ${pointId}` }
    if (anchor === undefined) {
      return { supported: false, reason: `unknown extension point anchor: ${pointId}/${anchorId}` }
    }
    return anchor.adapterSupport === 'supported'
      ? { supported: true }
      : {
        supported: false,
        reason: `extension point anchor ${pointId}/${anchorId} adapter support is ${anchor.adapterSupport}`,
      }
  }

  setPolicy(identity: CordisXPluginIdentity, pointId: string, policy: CordisXPointPolicy): void {
    if (this.authorization !== undefined) throw new Error('PermissionBroker owns extension point authorization policy')
    const bound = this.identity(identity.id)
    if (bound === undefined || bound.source !== identity.source) {
      throw new Error(`plugin ${identity.id} is not bound to source ${identity.source}`)
    }
    if (this.descriptors.descriptor(pointId) === undefined) throw new Error(`unknown extension point: ${pointId}`)
    if (!['inherit', 'allow', 'deny'].includes(policy)) {
      throw new Error(`unknown extension point policy: ${String(policy)}`)
    }
    const pointIdentity = Object.freeze({ source: identity.source, pluginId: identity.id, pointId })
    const record = Object.freeze({
      $schema: CORDISX_EXTENSION_POINT_POLICY_SCHEMA_V1,
      schemaVersion: 1,
      identity: pointIdentity,
      policy,
    }) satisfies CordisXExtensionPointPolicyRecordV1
    const key = extensionPointIdentityKey(pointIdentity)
    this.duplicatePolicyKeys.delete(key)
    this.duplicatePolicyIdentities.delete(key)
    this.policies.set(key, record)
    this.store.write(
      [...this.policies.values()].sort((left, right) =>
        extensionPointIdentityKey(left.identity).localeCompare(extensionPointIdentityKey(right.identity))
      ),
    )
    this.changed()
  }

  decision(
    owner: string,
    pointId: string,
    expectedKind: CordisXExtensionPointKind,
    view?: PluginGenerationView,
  ): ExtensionPointAccessDecision {
    const plugin = this.identity(owner, view)
    const descriptor = this.descriptors.descriptor(pointId)
    if (plugin === undefined) {
      return {
        policy: 'inherit',
        effectivePolicy: 'deny',
        authorized: false,
        reason: `plugin ${owner} has no launcher-bound source identity`,
      }
    }
    const identity = { source: plugin.source, pluginId: plugin.id, pointId }
    if (descriptor === undefined) {
      return {
        identity,
        policy: this.pointPolicy(identity),
        effectivePolicy: 'deny',
        authorized: false,
        reason: `unknown extension point: ${pointId}`,
      }
    }
    if (descriptor.kind !== expectedKind) {
      return {
        identity,
        policy: this.pointPolicy(identity),
        effectivePolicy: 'deny',
        authorized: false,
        reason: `extension point ${pointId} is ${descriptor.kind}, expected ${expectedKind}`,
      }
    }
    // Authorization and adapter availability are independent dimensions. Let
    // the owning authority record or resolve the exact scope even when the
    // current Host adapter cannot render it; the final access decision still
    // requires both dimensions.
    const access = this.authorization?.access(plugin, pointId, view)
    if (descriptor.adapterSupport !== 'supported') {
      return {
        identity,
        policy: access?.policy ?? this.pointPolicy(identity),
        effectivePolicy: 'deny',
        authorized: false,
        reason: `extension point ${pointId} adapter support is ${descriptor.adapterSupport}`,
      }
    }
    if (access !== undefined) {
      return {
        identity,
        policy: access.policy,
        effectivePolicy: access.authorized ? 'allow' : 'deny',
        authorized: access.authorized,
        ...(access.reason === '' ? {} : { reason: access.reason }),
      }
    }
    if (this.duplicatePolicyKeys.has(extensionPointIdentityKey(identity))) {
      return {
        identity,
        policy: 'inherit',
        effectivePolicy: 'deny',
        authorized: false,
        reason: `duplicate point policy identity: ${extensionPointIdentityKey(identity)}`,
      }
    }
    const policy = this.pointPolicy(identity)
    const effectivePolicy: CordisXEffectivePointPolicy = policy === 'deny' ? 'deny' : 'allow'
    return { identity, policy, effectivePolicy, authorized: effectivePolicy === 'allow' }
  }

  authorizeSurfaceCommand(
    owner: string,
    pointId: string,
    contributionId: string,
    commandId: string,
    view?: PluginGenerationView,
  ): ExtensionPointAccessDecision {
    const decision = this.decision(owner, pointId, 'surface', view)
    return this.recordAccess(decision, {
      operation: 'surface.command.invoke',
      contributionId,
      commandId,
    })
  }

  authorizeSurfaceRoute(
    owner: string,
    pointId: string,
    contributionId: string,
    routeId: string,
    view?: PluginGenerationView,
  ): ExtensionPointAccessDecision {
    const decision = this.decision(owner, pointId, 'surface', view)
    return this.recordAccess(decision, { operation: 'surface.route.navigate', contributionId, routeId })
  }

  authorizeOutletRoute(
    owner: string,
    pointId: string,
    routeId: string,
    pageId: string,
    view?: PluginGenerationView,
  ): ExtensionPointAccessDecision {
    const decision = this.decision(owner, pointId, 'outlet', view)
    return this.recordAccess(decision, { operation: 'outlet.route.navigate', routeId, pageId })
  }

  authorizeOutletPage(
    owner: string,
    pointId: string,
    routeId: string,
    pageId: string,
    view?: PluginGenerationView,
  ): ExtensionPointAccessDecision {
    const decision = this.decision(owner, pointId, 'outlet', view)
    return this.recordAccess(decision, { operation: 'outlet.page.mount', routeId, pageId })
  }

  authorizeOutletPageCommand(
    owner: string,
    pointId: string,
    routeId: string,
    pageId: string,
    actionId: string,
    commandId: string,
    view?: PluginGenerationView,
  ): ExtensionPointAccessDecision {
    const decision = this.decision(owner, pointId, 'outlet', view)
    return this.recordAccess(decision, {
      operation: 'outlet.page.command.invoke',
      routeId,
      pageId,
      actionId,
      commandId,
    })
  }

  policiesSnapshot(): readonly CordisXExtensionPointPolicyRecordV1[] {
    if (this.authorization !== undefined) {
      return this.authorization.policies().map(entry =>
        Object.freeze({
          $schema: CORDISX_EXTENSION_POINT_POLICY_SCHEMA_V1,
          schemaVersion: 1,
          identity: Object.freeze({
            source: entry.identity.source,
            pluginId: entry.identity.id,
            pointId: entry.pointId,
          }),
          policy: entry.policy,
        })
      )
    }
    return [...this.policies.values()]
      .filter(record => this.descriptors.descriptor(record.identity.pointId) !== undefined)
      .sort((left, right) =>
        extensionPointIdentityKey(left.identity).localeCompare(extensionPointIdentityKey(right.identity))
      )
  }

  policyDiagnostics(): readonly ExtensionPointPolicyDiagnostic[] {
    if (this.authorization !== undefined) return []
    const duplicates = [...this.duplicatePolicyIdentities.values()].map(identity => ({
      code: 'duplicate-policy' as const,
      message: `duplicate point policy identity: ${extensionPointIdentityKey(identity)}`,
      identity,
    }))
    const unknown = [...this.policies.values()]
      .filter(record => this.descriptors.descriptor(record.identity.pointId) === undefined)
      .map(record => ({
        code: 'unknown-point' as const,
        message: `point policy references unknown point: ${record.identity.pointId}`,
        identity: record.identity,
      }))
    return [...duplicates, ...unknown].sort((left, right) =>
      extensionPointIdentityKey(left.identity).localeCompare(extensionPointIdentityKey(right.identity))
    )
  }

  accessDiagnostics(): readonly ExtensionPointAccessDiagnostic[] {
    return [...this.accesses]
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.identities.clear()
    this.policies.clear()
    this.duplicatePolicyKeys.clear()
    this.duplicatePolicyIdentities.clear()
    this.accesses.length = 0
    this.listeners.clear()
  }

  private recordAccess(
    decision: ExtensionPointAccessDecision,
    operation: ExtensionPointAccessFields,
  ): ExtensionPointAccessDecision {
    if (decision.identity === undefined) return decision
    const request = Object.freeze({
      $schema: CORDISX_EXTENSION_POINT_ACCESS_SCHEMA_V2,
      schemaVersion: 2,
      generation: this.generation,
      identity: decision.identity,
      ...operation,
    }) as CordisXExtensionPointAccessV2
    this.accesses.push(Object.freeze({
      request,
      authorized: decision.authorized,
      effectivePolicy: decision.effectivePolicy,
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    }))
    if (this.accesses.length > 256) this.accesses.shift()
    return decision
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }
}
