import { PlatformAuthorizationV2Broker } from './platform-authorization-v2.js'
import {
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V1,
  CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V1,
} from '../../contracts.js'
import type {
  CordisXCapabilityScope,
  CordisXPermissionAuthorizationDecisionV1,
  CordisXPermissionAuthorizationPlanV1,
  CordisXPermissionDecision,
  CordisXPermissionPolicy,
  CordisXPermissionPolicyRecordV1,
  CordisXPlatformCapability,
  CordisXPlatformResult,
  CordisXPluginIdentity,
} from '../../contracts.js'
import {
  createPermissionPolicyRecord,
  normalizePermissionScope,
  permissionRecordKey,
  permissionScopeFingerprint,
} from '../../permissions.js'
import type { PluginGenerationView } from '../generation-visibility.js'
import {
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
  CORDISX_PERMISSION_POLICY_SCHEMA_V3,
} from '../../permission-contracts.js'
import type {
  CordisXCapabilityDeclarationV2,
  CordisXPermissionAuthorizationDecisionV2,
  CordisXPermissionCapabilityV2,
  CordisXPermissionCapabilityV4,
  CordisXPermissionDecisionV2,
  CordisXPermissionPolicyV2,
} from '../../permission-contracts.js'
import { normalizePermissionScopeV2 } from '../../permission-model-v2.js'
import {
  domPermissionAuthorizationKeyV3,
  normalizePermissionPolicyRecordV3,
  permissionRecordKeyV3,
} from '../../permission-model-v3.js'
import {
  isPermissionPolicyRecordV2,
  isPermissionPolicyRecordV3,
  isPermissionPolicyRecordV4,
} from '../../permission-persistence.js'

import { declarationFingerprint, failure, object, platformIdentityKey } from './platform-manifest.js'
import { RequestedScope } from './platform-permission-store.js'
import {
  AuthorizationGrant,
  isoNow,
  Registration,
  requestedSnapshot,
  scopeAllows,
} from './platform-permission-types.js'
import { materializeValidatedRuntimeExactScope } from './platform-runtime-exact-scope.js'

export abstract class PlatformAuthorizationBroker extends PlatformAuthorizationV2Broker {
  policy(
    identity: CordisXPluginIdentity,
    capability: CordisXPlatformCapability,
    view?: PluginGenerationView,
  ): CordisXPermissionPolicy {
    const registration = this.registration(identity, view)
    const declaration = registration?.declarations.get(capability)
    if (registration === undefined || declaration === undefined) return 'ask'
    if (registration.manifest.schemaVersion === 1) {
      const record = this.policyRecords.get(permissionRecordKey(createPermissionPolicyRecord({
        profileId: this.profileId,
        identity,
        capability,
        scope: declaration.scope,
        policy: 'ask',
      })))
      return record !== undefined && !isPermissionPolicyRecordV2(record) && !isPermissionPolicyRecordV3(record)
          && !isPermissionPolicyRecordV4(record)
        ? record.policy
        : 'ask'
    }
    const policy = this.policyV2(identity, capability as CordisXPermissionCapabilityV2, view)
    return policy === 'allow-persistent' ? 'allow' : policy === 'deny-persistent' ? 'deny' : 'ask'
  }

  async setPolicy(
    identity: CordisXPluginIdentity,
    capability: CordisXPlatformCapability,
    policy: CordisXPermissionPolicy,
  ): Promise<void> {
    const registration = this.registration(identity)
    const declaration = registration?.declarations.get(capability)
    if (registration === undefined || declaration === undefined) {
      throw new Error(`plugin ${identity.id} does not declare ${capability}`)
    }
    if (registration.manifest.schemaVersion === 1) {
      const record = createPermissionPolicyRecord({
        profileId: this.profileId,
        identity,
        capability,
        scope: declaration.scope,
        policy,
      })
      const key = permissionRecordKey(record)
      const previous = this.policyRecords.get(key)
      this.policyRecords.set(key, record)
      this.changed()
      try {
        await this.store.write([record])
      } catch (error) {
        if (previous === undefined) this.policyRecords.delete(key)
        else this.policyRecords.set(key, previous)
        this.changed()
        throw error
      }
      this.onceV2.clearGeneration(this.generation, registration.generation.moduleGeneration)
      return
    }
    await this.setPolicyV2(
      identity,
      capability as CordisXPermissionCapabilityV2,
      policy === 'allow' ? 'allow-persistent' : policy === 'deny' ? 'deny-persistent' : 'ask',
    )
  }

  authorizationPlan(
    identity: CordisXPluginIdentity,
    operation: 'install' | 'update' | 'enable' = 'enable',
    view?: PluginGenerationView,
  ): CordisXPermissionAuthorizationPlanV1 {
    const registration = this.registration(identity, view)
    if (registration === undefined) throw new Error(`plugin ${identity.id} is not registered`)
    if (registration.manifest.schemaVersion === 1) {
      return Object.freeze({
        $schema: CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V1,
        schemaVersion: 1,
        planId: `${this.generation}:${identity.id}`,
        operation,
        profileId: this.profileId,
        identity: Object.freeze({ source: registration.identity.source, pluginId: registration.identity.id }),
        defaultDecision: 'allow',
        declarations: Object.freeze([...registration.declarations.values()].map(declaration => {
          const record = createPermissionPolicyRecord({
            profileId: this.profileId,
            identity,
            capability: declaration.name,
            scope: declaration.scope,
            policy: 'ask',
          })
          return Object.freeze({
            capability: declaration.name,
            required: declaration.required,
            reason: declaration.reason,
            scope: declaration.scope,
            policy: this.policy(identity, declaration.name, view),
            decisionRequired: !this.policyRecords.has(permissionRecordKey(record)),
          })
        })),
      })
    }
    const v2 = this.authorizationPlanV2(identity, operation, view)
    return Object.freeze({
      $schema: CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V1,
      schemaVersion: 1,
      planId: `${this.generation}:${identity.id}`,
      operation,
      profileId: this.profileId,
      identity: Object.freeze({ source: registration.identity.source, pluginId: registration.identity.id }),
      defaultDecision: 'allow',
      declarations: Object.freeze([...registration.declarations.values()].map(declaration => {
        const item = v2.declarations.find(candidate => candidate.capability === declaration.name)!
        return Object.freeze({
          capability: declaration.name,
          required: declaration.required,
          reason: declaration.reason,
          scope: declaration.scope,
          policy: item.policy === 'allow-persistent' ? 'allow' : item.policy === 'deny-persistent' ? 'deny' : 'ask',
          decisionRequired: item.decisionRequired,
        })
      })),
    })
  }

  async authorizeActivation(
    identity: CordisXPluginIdentity,
    authorization: CordisXPermissionAuthorizationDecisionV1,
    operation: 'install' | 'update' | 'enable' = 'enable',
    view?: PluginGenerationView,
  ): Promise<void> {
    const registration = this.registration(identity, view)
    if (registration === undefined) throw new Error(`plugin ${identity.id} is not registered`)
    if (registration.manifest.schemaVersion === 1) {
      await this.authorizeActivationLegacy(registration, authorization, operation)
      return
    }
    const plan = this.authorizationPlanV2(identity, operation, view)
    if (
      authorization === null || typeof authorization !== 'object'
      || authorization.$schema !== CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V1
      || authorization.schemaVersion !== 1
      || authorization.planId !== `${this.generation}:${identity.id}`
      || authorization.operation !== operation
      || authorization.profileId !== this.profileId
      || authorization.identity?.source !== identity.source
      || authorization.identity.pluginId !== identity.id
      || !Array.isArray(authorization.decisions)
    ) {
      throw new Error('authorization decision does not match the current plan')
    }
    const expected = new Set(plan.declarations.map(item => item.capability))
    const seen = new Set<CordisXPlatformCapability>()
    for (const item of authorization.decisions) {
      if (
        item === null || typeof item !== 'object'
        || (item.decision !== 'ask' && item.decision !== 'allow' && item.decision !== 'allow-once'
          && item.decision !== 'deny')
        || !expected.has(item.capability) || seen.has(item.capability)
        || JSON.stringify(normalizePermissionScopeV2(item.scope))
          !== JSON.stringify(plan.declarations.find(candidate => candidate.capability === item.capability)?.scope)
      ) {
        throw new Error('authorization decision does not match the current manifest')
      }
      seen.add(item.capability)
    }
    if (seen.size !== expected.size) throw new Error('authorization decision is incomplete')
    const decisionV2: CordisXPermissionAuthorizationDecisionV2 = {
      $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
      schemaVersion: 2,
      planId: plan.planId,
      operation: plan.operation,
      profileId: plan.profileId,
      identity: plan.identity,
      binding: plan.binding,
      decisions: authorization.decisions.map((item) => {
        const declaration = plan.declarations.find(candidate => candidate.capability === item.capability)!
        let decision: CordisXPermissionDecisionV2 = item.decision === 'allow-once'
          ? 'allow-once'
          : item.decision === 'allow'
          ? 'allow-persistent'
          : item.decision === 'deny'
          ? 'deny-persistent'
          : 'deny-once'
        if (!declaration.allowedDecisions.includes(decision)) {
          decision = item.decision === 'allow' ? 'allow-once' : 'deny-once'
        }
        return {
          capability: declaration.capability,
          scope: declaration.scope,
          securityFingerprint: declaration.securityFingerprint,
          decision,
        }
      }),
    }
    this.assertDecisionV2(plan, decisionV2)
    await this.commitDecisionV2(plan, decisionV2)
  }

  protected async authorizeActivationLegacy(
    registration: Registration,
    authorization: CordisXPermissionAuthorizationDecisionV1,
    operation: 'install' | 'update' | 'enable',
  ): Promise<void> {
    const identity = registration.identity
    if (
      authorization === null || typeof authorization !== 'object'
      || authorization.$schema !== CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V1
      || authorization.schemaVersion !== 1
      || authorization.planId !== `${this.generation}:${identity.id}`
      || authorization.operation !== operation
      || authorization.profileId !== this.profileId
      || authorization.identity?.source !== identity.source
      || authorization.identity.pluginId !== identity.id
      || !Array.isArray(authorization.decisions)
    ) {
      throw new Error('authorization decision does not match the current plan')
    }
    const expected = new Set(registration.declarations.keys())
    const seen = new Set<CordisXPlatformCapability>()
    for (const item of authorization.decisions) {
      if (
        item === null || typeof item !== 'object'
        || (item.decision !== 'ask' && item.decision !== 'allow' && item.decision !== 'allow-once'
          && item.decision !== 'deny')
        || !expected.has(item.capability) || seen.has(item.capability)
        || permissionScopeFingerprint(item.capability, normalizePermissionScope(item.scope))
          !== declarationFingerprint(registration.declarations.get(item.capability)!)
      ) {
        throw new Error('authorization decision does not match the current manifest')
      }
      seen.add(item.capability)
    }
    if (seen.size !== expected.size) throw new Error('authorization decision is incomplete')
    const records = authorization.decisions.flatMap((item): CordisXPermissionPolicyRecordV1[] => (
      item.decision === 'allow-once' ? [] : [createPermissionPolicyRecord({
        profileId: this.profileId,
        identity,
        capability: item.capability,
        scope: registration.declarations.get(item.capability)!.scope,
        policy: item.decision,
      })]
    ))
    if (records.length > 0) {
      await this.store.write(records)
      for (const record of records) this.policyRecords.set(permissionRecordKey(record), record)
    }
    const binding = this.binding(registration, `${this.generation}:${identity.id}`)
    this.onceV2.clearOperation(binding.operationId)
    for (const item of authorization.decisions) {
      if (item.decision !== 'allow-once') continue
      const declaration = registration.declarations.get(item.capability)!
      this.onceV2.issue(this.legacyAuthorizationKey(registration, declaration), binding)
    }
    this.changed()
  }

  clearOnce(identity: CordisXPluginIdentity): void {
    const registration = this.registration(identity)
    this.onceV2.clearOperation(`${this.generation}:${identity.id}`)
    this.onceV2.clearGeneration(this.generation, registration?.generation.moduleGeneration)
    this.clearDomGeneration(registration?.generation.moduleGeneration, identity)
    this.clearHostDomGeneration(registration?.generation.moduleGeneration, identity)
    this.changed()
  }

  async setDomPolicy(
    identity: CordisXPluginIdentity,
    pointId: string,
    policy: CordisXPermissionPolicyV2,
  ): Promise<void> {
    await this.setDomPolicies(identity, [{ pointId, policy }])
  }

  /** Persist one plugin's point-policy replacement as one profile-ledger write. */
  async setDomPolicies(
    identity: CordisXPluginIdentity,
    policies: readonly { readonly pointId: string; readonly policy: CordisXPermissionPolicyV2 }[],
  ): Promise<void> {
    const registration = this.registration(identity)
    if (registration === undefined) throw new Error(`plugin ${identity.id} is not registered`)
    const pointIds = new Set<string>()
    const replacements = policies.map(({ pointId, policy }) => {
      if (pointIds.has(pointId)) throw new Error(`duplicate extension point policy: ${pointId}`)
      pointIds.add(pointId)
      const key = domPermissionAuthorizationKeyV3({
        profileId: this.profileId,
        identity: { source: identity.source, pluginId: identity.id },
        pointId,
        catalogVersion: this.catalog.version,
      })
      const record = normalizePermissionPolicyRecordV3({
        $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V3,
        schemaVersion: 3,
        key,
        policy,
      })
      const recordKey = permissionRecordKeyV3(record)
      return { pointId, record, recordKey }
    })
    await this.commitDomPolicyRecords(replacements.map(replacement => replacement.record), () => {
      for (const replacement of replacements) {
        this.policyRecords.set(replacement.recordKey, replacement.record)
        this.clearExactDomLease(registration, replacement.pointId)
      }
    })
  }

  async settled(): Promise<void> {
    await Promise.all(this.migrationTasks)
  }

  authorize(
    identity: CordisXPluginIdentity,
    capability: CordisXPlatformCapability,
    requested: RequestedScope,
    view?: PluginGenerationView,
  ): Promise<CordisXPlatformResult<AuthorizationGrant>> {
    const currentRegistration = this.registration(identity, view)
    const staticDeclaration = currentRegistration?.declarationsV2.get(capability as CordisXPermissionCapabilityV2)
    const exactScope = currentRegistration?.runtimeExactCapabilities.has(capability)
      ? materializeValidatedRuntimeExactScope(capability, requested)
      : undefined
    const declarationV2 = exactScope === undefined
      ? staticDeclaration
      : {
        name: capability as CordisXPermissionCapabilityV2,
        required: false,
        scope: normalizePermissionScopeV2(exactScope, `${capability} runtime exact-request scope`),
      }
    if (currentRegistration === undefined || declarationV2 === undefined) {
      this.consoleObserver?.permission(identity, capability, 'deny', `${capability} is not declared`)
      this.denied(platformIdentityKey(identity), capability, requested)
      return Promise.resolve(failure('permission-undeclared', `Plugin ${identity.id} does not declare ${capability}`))
    }
    if (currentRegistration.manifest.schemaVersion === 1) {
      return this.authorizeCallLegacy(currentRegistration, capability, requested, view)
    }
    return this.authorizeCallV2(currentRegistration, declarationV2, capability, requested)
  }

  protected async authorizeCallLegacy(
    registration: Registration,
    capability: CordisXPlatformCapability,
    requested: RequestedScope,
    view?: PluginGenerationView,
  ): Promise<CordisXPlatformResult<AuthorizationGrant>> {
    const identity = registration.identity
    const identityKey = platformIdentityKey(identity)
    const declaration = registration.declarations.get(capability)!
    if (!scopeAllows(declaration.scope, requested)) {
      this.consoleObserver?.permission(identity, capability, 'deny', `${capability} is outside the declared scope`)
      this.denied(identityKey, capability, requested)
      return failure('permission-scope-denied', `Requested parameters are outside the declared ${capability} scope`)
    }
    const activationBinding = this.binding(registration, `${this.generation}:${identity.id}`)
    const key = this.legacyAuthorizationKey(registration, declaration)
    const activationTicket = this.onceV2.consume(key, activationBinding)
    const policy = this.policy(identity, capability, view)
    if (policy === 'deny' && !activationTicket) {
      this.consoleObserver?.permission(identity, capability, 'deny', `${capability} is denied by policy`)
      this.denied(identityKey, capability, requested)
      return failure('permission-denied', `${capability} is denied for plugin ${identity.id}`)
    }
    if (policy === 'ask' && !activationTicket) {
      this.consoleObserver?.permission(identity, capability, 'ask', `${capability} requires a decision`)
      let decision: Exclude<CordisXPermissionDecision, 'ask'> | 'timeout'
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        decision = await Promise.race([
          this.prompt.request({ identity, declaration, requested }),
          new Promise<'timeout'>(resolve => {
            timer = setTimeout(() => resolve('timeout'), this.promptTimeoutMs)
          }),
        ])
      } catch {
        decision = 'deny'
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
      if (decision === 'timeout') {
        this.consoleObserver?.permission(identity, capability, 'deny', `${capability} permission request timed out`)
        this.denied(identityKey, capability, requested)
        return failure('timeout', `${capability} permission request timed out`)
      }
      if (decision === 'deny') {
        this.consoleObserver?.permission(identity, capability, 'deny', `${capability} was denied for this call`)
        this.denied(identityKey, capability, requested)
        return failure('permission-denied', `${capability} was denied for this call`)
      }
      if (decision === 'allow') {
        try {
          await this.setPolicy(identity, capability, 'allow')
        } catch {
          this.consoleObserver?.permission(
            identity,
            capability,
            'deny',
            `${capability} allow decision could not be persisted`,
          )
          this.denied(identityKey, capability, requested)
          return failure('adapter-failure', `${capability} permission policy could not be persisted`)
        }
      } else {
        const requestId = typeof globalThis.crypto?.randomUUID === 'function'
          ? globalThis.crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`
        const binding = this.binding(registration, requestId, requestId)
        this.onceV2.issue(key, binding)
        if (!this.onceV2.consume(key, binding)) {
          this.denied(identityKey, capability, requested)
          return failure('permission-denied', `${capability} one-time authorization was not bound to this request`)
        }
      }
    }
    const auditKey = this.auditKey(identityKey, capability)
    const audit = this.audit.get(auditKey) ?? { denialCount: 0 }
    audit.lastUsedAt = isoNow(this.now)
    audit.lastRequested = requestedSnapshot(requested)
    this.audit.set(auditKey, audit)
    this.consoleObserver?.permission(identity, capability, 'allow', `${capability} allowed`)
    this.changed()
    return { ok: true, value: { declaration } }
  }

  protected async authorizeCallV2(
    registration: Registration,
    declaration: CordisXCapabilityDeclarationV2,
    capability: CordisXPlatformCapability,
    requested: RequestedScope,
  ): Promise<CordisXPlatformResult<AuthorizationGrant>> {
    const identity = registration.identity
    const identityKey = platformIdentityKey(identity)
    const legacyDeclaration = registration.declarations.get(capability)
      ?? (registration.runtimeExactCapabilities.has(capability)
        ? {
          name: capability,
          required: false,
          reason: {
            namespace: 'permission',
            key: `permission.${capability}.runtime-exact`,
            fallback: this.catalog.get(capability as CordisXPermissionCapabilityV4).presentation.description.fallback
              ?? `${capability} for one exact runtime request`,
          },
          scope: declaration.scope as CordisXCapabilityScope,
        }
        : undefined)
    if (legacyDeclaration === undefined) {
      this.consoleObserver?.permission(identity, capability, 'deny', `${capability} is not declared`)
      this.denied(identityKey, capability, requested)
      return failure('permission-undeclared', `Plugin ${identity.id} does not declare ${capability}`)
    }
    if (!scopeAllows(declaration.scope as CordisXCapabilityScope, requested)) {
      this.consoleObserver?.permission(identity, capability, 'deny', `${capability} is outside the declared scope`)
      this.denied(identityKey, capability, requested)
      return failure('permission-scope-denied', `Requested parameters are outside the declared ${capability} scope`)
    }
    const requestId = typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const binding = {
      operationId: requestId,
      runtimeGeneration: this.generation,
      ...(registration.generation.moduleGeneration === undefined ? {} : {
        moduleGeneration: registration.generation.moduleGeneration,
      }),
      requestId,
    }
    const plan = this.planV2(registration, 'runtime', binding, [declaration])
    const item = plan.declarations[0]!
    const activationBinding = this.binding(registration, `${this.generation}:${identity.id}`)
    const activationTicket = this.onceV2.consume(this.authorizationKey(plan, item.capability), activationBinding)
    if (item.policy === 'deny-persistent' && !activationTicket) {
      this.consoleObserver?.permission(identity, capability, 'deny', `${capability} is denied by persistent policy`)
      this.denied(identityKey, capability, requested)
      return failure('permission-denied', `${capability} is denied for plugin ${identity.id}`)
    }
    let allowed = activationTicket || (item.policy === 'allow-persistent' && item.sensitivity !== 'high-risk')
    if (!allowed) {
      this.consoleObserver?.permission(identity, capability, 'ask', `${capability} requires a decision`)
      let decision: CordisXPermissionAuthorizationDecisionV2 | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        decision = await Promise.race([
          this.promptV2?.request(plan, identity) ?? Promise.resolve(undefined),
          new Promise<undefined>(resolve => {
            timer = setTimeout(() => resolve(undefined), this.promptTimeoutMs)
          }),
        ])
      } catch {
        decision = undefined
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
      if (decision === undefined) {
        this.onceV2.clearOperation(binding.operationId)
        this.consoleObserver?.permission(
          identity,
          capability,
          'deny',
          `${capability} permission request was cancelled or timed out`,
        )
        this.denied(identityKey, capability, requested)
        return failure('permission-denied', `${capability} was not authorized for this call`)
      }
      try {
        this.assertDecisionV2(plan, decision)
        await this.commitDecisionV2(plan, decision)
      } catch {
        this.onceV2.clearOperation(binding.operationId)
        this.consoleObserver?.permission(identity, capability, 'deny', `${capability} decision was invalid`)
        this.denied(identityKey, capability, requested)
        return failure('permission-denied', `${capability} authorization was invalid`)
      }
      const selected = decision.decisions[0]!.decision
      if (selected === 'deny-once' || selected === 'deny-persistent') {
        this.onceV2.clearOperation(binding.operationId)
        this.consoleObserver?.permission(identity, capability, 'deny', `${capability} was denied`)
        this.denied(identityKey, capability, requested)
        return failure('permission-denied', `${capability} was denied for this call`)
      }
      if (selected === 'allow-once') {
        const key = {
          profileId: this.profileId,
          identity: plan.identity,
          capability: item.capability,
          scope: item.scope,
          securityFingerprint: item.securityFingerprint,
        }
        allowed = this.onceV2.consume(key, binding)
      } else {
        allowed = true
      }
    }
    this.onceV2.clearOperation(binding.operationId)
    if (!allowed) {
      this.denied(identityKey, capability, requested)
      return failure('permission-denied', `${capability} one-time authorization was not bound to this request`)
    }
    const auditKey = this.auditKey(identityKey, capability)
    const audit = this.audit.get(auditKey) ?? { denialCount: 0 }
    audit.lastUsedAt = isoNow(this.now)
    audit.lastRequested = requestedSnapshot(requested)
    this.audit.set(auditKey, audit)
    this.consoleObserver?.permission(identity, capability, 'allow', `${capability} allowed`)
    this.changed()
    return { ok: true, value: { declaration: legacyDeclaration } }
  }

  requiredDenied(
    identity: CordisXPluginIdentity,
    view?: PluginGenerationView,
  ): readonly CordisXPermissionCapabilityV4[] {
    const registration = this.registration(identity, view)
    if (registration === undefined) return []
    if (registration.manifest.schemaVersion === 1) {
      const binding = this.binding(registration, `${this.generation}:${identity.id}`)
      return [...registration.declarations.values()]
        .filter(item =>
          item.required && this.policy(identity, item.name, view) === 'deny'
          && !this.onceV2.has(this.legacyAuthorizationKey(registration, item), binding)
        )
        .map(item => item.name)
    }
    const plan = this.authorizationPlanV2(identity, 'enable', view)
    const denied: CordisXPermissionCapabilityV4[] = plan.declarations.filter(item =>
      item.required
      && item.policy !== 'allow-persistent'
      && !this.onceV2.has(this.authorizationKey(plan, item.capability), plan.binding)
    )
      .map(item => item.capability)
    if (registration.manifest.schemaVersion === 5 || registration.manifest.schemaVersion === 6) {
      for (const declaration of registration.declarationsV4.values()) {
        if (!declaration.required) continue
        const capability = declaration.name as 'ui.host-dom.read' | 'ui.host-dom.modify'
        const policy = this.hostDomPolicy(identity, capability, view)
        if (
          policy === 'deny' || (policy !== 'allow'
            && this.validHostDomLease(registration, capability) === undefined
            && this.activeCertification(registration) === undefined)
        ) denied.push(capability)
      }
    }
    return Object.freeze(denied)
  }

  recordScopeDenial(
    identity: CordisXPluginIdentity,
    capability: CordisXPlatformCapability,
    requested: RequestedScope,
  ): void {
    this.denied(platformIdentityKey(identity), capability, requested)
  }
}
