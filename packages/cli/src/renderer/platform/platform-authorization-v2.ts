import { PlatformHostDomPermissionBroker } from './platform-host-dom-permission.js'
import type {
  CordisXCapabilityDeclaration,
  CordisXPermissionPolicyRecordV1,
  CordisXPluginIdentity,
} from '../../contracts.js'
import { permissionRecordKey } from '../../permissions.js'
import type { PluginGenerationView } from '../generation-visibility.js'
import {
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
  CORDISX_PERMISSION_POLICY_SCHEMA_V2,
  CORDISX_PERMISSION_POLICY_SCHEMA_V4,
} from '../../permission-contracts.js'
import type {
  CordisXCapabilityDeclarationV2,
  CordisXPermissionAuthorizationBindingV2,
  CordisXPermissionAuthorizationDecisionV2,
  CordisXPermissionAuthorizationDecisionV4,
  CordisXPermissionAuthorizationKeyV2,
  CordisXPermissionAuthorizationPlanV2,
  CordisXPermissionAuthorizationPlanV4,
  CordisXPermissionCapabilityV2,
  CordisXPermissionPolicyRecordV2,
  CordisXPermissionPolicyV2,
} from '../../permission-contracts.js'
import {
  buildPermissionAuthorizationPlanResultV2,
  buildPermissionAuthorizationPlanV4,
} from '../../capability-risk-catalog.js'
import {
  assertPermissionAuthorizationDecisionV2,
  migratePermissionPolicyV1,
  normalizePermissionPolicyRecordV2,
  normalizePermissionScopeV2,
  permissionRecordKeyV2,
  permissionSecurityFingerprint,
} from '../../permission-model-v2.js'
import {
  assertPermissionAuthorizationDecisionV4,
  isHostDomPermissionCapability,
  normalizePermissionPolicyRecordV4,
} from '../../permission-model-v4.js'
import {
  isPermissionPolicyRecordV2,
  isPermissionPolicyRecordV3,
  isPermissionPolicyRecordV4,
  persistedPermissionRecordKey,
} from '../../permission-persistence.js'
import type { CordisXPersistedPermissionPolicyRecord } from '../../permission-persistence.js'
import {
  assertBundlePolicyDecision,
  assertDeferredPermissionDecision,
  type DeferredPermissionDecision,
  deferValidatedPermissionPlan,
  deferValidatedV2PermissionPlan,
  withBundlePolicyIntent,
} from '../../permission-deferral.js'

import { permissionPlanDeclarations, Registration } from './platform-permission-types.js'

export abstract class PlatformAuthorizationV2Broker extends PlatformHostDomPermissionBroker {
  private readonly localV2Reviews = new Map<string, {
    registration: Registration
    revision: bigint
    plan: CordisXPermissionAuthorizationPlanV2
  }>()
  private readonly localV4Reviews = new Map<string, {
    registration: Registration
    revision: bigint
    plan: CordisXPermissionAuthorizationPlanV4
    certificationRevision: number
    certificationAvailable: boolean
    certification: string | undefined
  }>()

  private localReviewId(): string {
    const random = globalThis.crypto.getRandomValues(new Uint8Array(16))
    return `local-review:${Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('')}`
  }

  /** Bind a renderer-owned review to its registration and process-local policy revision. */
  reviewAuthorizationPlanV2(
    identity: CordisXPluginIdentity,
    view?: PluginGenerationView,
  ): CordisXPermissionAuthorizationPlanV2 {
    const registration = this.registration(identity, view)
    if (registration === undefined) throw new Error(`plugin ${identity.id} is not registered`)
    const operationId = this.localReviewId()
    const plan = this.authorizationPlanV2(identity, 'enable', view, operationId)
    if (this.localV2Reviews.size >= 1024) this.localV2Reviews.delete(this.localV2Reviews.keys().next().value!)
    this.localV2Reviews.set(operationId, {
      registration,
      revision: this.policyRecords.revision,
      plan: structuredClone(plan),
    })
    return plan
  }

  async authorizeReviewedActivationV2(
    identity: CordisXPluginIdentity,
    authorization: CordisXPermissionAuthorizationDecisionV2,
    view?: PluginGenerationView,
  ): Promise<void> {
    const review = this.localV2Reviews.get(authorization.binding?.operationId)
    this.localV2Reviews.delete(authorization.binding?.operationId)
    const registration = this.registration(identity, view)
    if (
      review === undefined || registration !== review.registration
      || !this.isAuthorizationCurrent(registration, review.revision)
    ) {
      throw new Error('permission review was invalidated')
    }
    this.assertDecisionV2(review.plan, authorization)
    if (!this.isAuthorizationCurrent(registration, review.revision)) {
      throw new Error('permission review was invalidated')
    }
    await this.commitDecisionV2(
      review.plan,
      authorization,
      this.binding(registration, `${this.generation}:${identity.id}`),
      revision => this.isAuthorizationCurrent(registration, revision),
      review.revision,
    )
  }

  protected legacyAuthorizationKey(
    registration: Registration,
    declaration: CordisXCapabilityDeclaration,
  ): CordisXPermissionAuthorizationKeyV2 {
    const declarationV2 = registration.declarationsV2.get(declaration.name as CordisXPermissionCapabilityV2)!
    return Object.freeze({
      profileId: this.profileId,
      identity: Object.freeze({ source: registration.identity.source, pluginId: registration.identity.id }),
      capability: declarationV2.name,
      scope: declarationV2.scope,
      securityFingerprint: permissionSecurityFingerprint(this.catalog.version, declarationV2),
    })
  }

  protected planV2(
    registration: Registration,
    operation: CordisXPermissionAuthorizationPlanV2['operation'],
    binding: CordisXPermissionAuthorizationPlanV2['binding'],
    declarations: readonly CordisXCapabilityDeclarationV2[] = [...registration.declarationsV2.values()],
  ): CordisXPermissionAuthorizationPlanV2 {
    const built = buildPermissionAuthorizationPlanResultV2({
      planId: binding.operationId,
      operation,
      profileId: this.profileId,
      identity: { source: registration.identity.source, pluginId: registration.identity.id },
      binding,
      declarations,
      policies: [...this.policyRecords.values()].filter(isPermissionPolicyRecordV2),
      contextFor: declaration => {
        const family = this.catalog.get(declaration.name).providerFamily
        return {
          operation,
          providerKind: family === 'platform' ? 'current-connection' : 'host-local',
          providerTrust: 'configured',
          availability: 'supported',
        }
      },
    }, this.catalog)
    if (built.policyMigrations.length > 0) {
      const previous = built.policyMigrations.map(record => this.policyRecords.get(permissionRecordKeyV2(record)))
      for (const record of built.policyMigrations) this.policyRecords.set(permissionRecordKeyV2(record), record)
      const task = this.persistV2(built.policyMigrations).catch((error) => {
        built.policyMigrations.forEach((record, index) => {
          const key = permissionRecordKeyV2(record)
          const prior = previous[index]
          if (prior === undefined) this.policyRecords.delete(key)
          else this.policyRecords.set(key, prior)
        })
        this.changed()
        throw error
      })
      this.migrationTasks.push(task)
    }
    return built.plan
  }

  policyV2(
    identity: CordisXPluginIdentity,
    capability: CordisXPermissionCapabilityV2,
    view?: PluginGenerationView,
  ): CordisXPermissionPolicyV2 {
    const registration = this.registration(identity, view)
    const declaration = registration?.declarationsV2.get(capability)
    if (registration === undefined || declaration === undefined) return 'ask'
    const operationId = `policy:${identity.id}:${capability}`
    return this.planV2(registration, 'runtime', {
      operationId,
      runtimeGeneration: this.generation,
      ...(registration.generation.moduleGeneration === undefined ? {} : {
        moduleGeneration: registration.generation.moduleGeneration,
      }),
    }, [declaration]).declarations[0]!.policy
  }

  async setPolicyV2(
    identity: CordisXPluginIdentity,
    capability: CordisXPermissionCapabilityV2,
    policy: CordisXPermissionPolicyV2,
  ): Promise<void> {
    const registration = this.registration(identity)
    const declaration = registration?.declarationsV2.get(capability)
    if (registration === undefined || declaration === undefined) {
      throw new Error(`plugin ${identity.id} does not declare ${capability}`)
    }
    const plan = this.planV2(registration, 'runtime', {
      operationId: `policy:${identity.id}:${capability}`,
      runtimeGeneration: this.generation,
      ...(registration.generation.moduleGeneration === undefined ? {} : {
        moduleGeneration: registration.generation.moduleGeneration,
      }),
    }, [declaration])
    const item = plan.declarations[0]!
    if (policy === 'allow-persistent' && !item.persistentAllow) {
      throw new Error(`${capability} does not permit persistent allow`)
    }
    if (policy === 'deny-persistent' && !item.persistentDeny) {
      throw new Error(`${capability} does not permit persistent deny`)
    }
    const record = normalizePermissionPolicyRecordV2({
      $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V2,
      schemaVersion: 2,
      key: {
        profileId: this.profileId,
        identity: plan.identity,
        capability,
        scope: item.scope,
        securityFingerprint: item.securityFingerprint,
      },
      policy,
    })
    const key = permissionRecordKeyV2(record)
    const previous = this.policyRecords.get(key)
    this.policyRecords.set(key, record)
    this.changed()
    try {
      await this.persistV2([record])
    } catch (error) {
      if (previous === undefined) this.policyRecords.delete(key)
      else this.policyRecords.set(key, previous)
      this.changed()
      throw error
    }
    this.onceV2.clearGeneration(this.generation, registration.generation.moduleGeneration)
  }

  authorizationPlanV2(
    identity: CordisXPluginIdentity,
    operation: 'install' | 'update' | 'enable' = 'enable',
    view?: PluginGenerationView,
    operationId = `${this.generation}:${identity.id}`,
  ): CordisXPermissionAuthorizationPlanV2 {
    const registration = this.registration(identity, view)
    if (registration === undefined) throw new Error(`plugin ${identity.id} is not registered`)
    return this.planV2(registration, operation, {
      operationId,
      runtimeGeneration: this.generation,
      ...(registration.generation.moduleGeneration === undefined ? {} : {
        moduleGeneration: registration.generation.moduleGeneration,
      }),
    })
  }

  async authorizeActivationV2(
    identity: CordisXPluginIdentity,
    authorization: CordisXPermissionAuthorizationDecisionV2,
    operation: 'install' | 'update' | 'enable' = 'enable',
    view?: PluginGenerationView,
  ): Promise<void> {
    const registration = this.registration(identity, view)
    if (registration === undefined) throw new Error(`plugin ${identity.id} is not registered`)
    const plan = this.planV2(registration, operation, authorization.binding)
    this.assertDecisionV2(plan, authorization)
    await this.commitDecisionV2(
      plan,
      authorization,
      this.binding(registration, `${this.generation}:${identity.id}`),
    )
  }

  authorizationPlanV4(
    identity: CordisXPluginIdentity,
    operation: 'install' | 'update' | 'enable' = 'enable',
    view?: PluginGenerationView,
    binding?: CordisXPermissionAuthorizationBindingV2,
  ): CordisXPermissionAuthorizationPlanV4 | undefined {
    const registration = this.registration(identity, view)
    if (registration === undefined) throw new Error(`plugin ${identity.id} is not registered`)
    if (
      registration.manifest.schemaVersion !== 5 && registration.manifest.schemaVersion !== 6
      && registration.manifest.schemaVersion !== 7 && registration.manifest.schemaVersion !== 8
      && registration.manifest.schemaVersion !== 9 && registration.manifest.schemaVersion !== 10
      && registration.manifest.schemaVersion !== 11 && registration.manifest.schemaVersion !== 12
      && registration.manifest.schemaVersion !== 13 && registration.manifest.schemaVersion !== 16
    ) return undefined
    const operationBinding = binding ?? this.binding(registration, `${this.generation}:${identity.id}`)
    const certification = this.activeCertification(registration)
    return buildPermissionAuthorizationPlanV4({
      planId: `${this.generation}:${identity.id}`,
      operation,
      profileId: this.profileId,
      identity: { source: identity.source, pluginId: identity.id },
      binding: operationBinding,
      declarations: permissionPlanDeclarations(registration.manifest),
      policiesV2: [...this.policyRecords.values()].filter(isPermissionPolicyRecordV2),
      policiesV4: [...this.policyRecords.values()].filter(isPermissionPolicyRecordV4),
      ...(certification === undefined ? {} : { certification }),
    }, this.catalog)
  }

  reviewAuthorizationPlanV4(
    identity: CordisXPluginIdentity,
    view?: PluginGenerationView,
  ): CordisXPermissionAuthorizationPlanV4 | undefined {
    const registration = this.registration(identity, view)
    if (registration === undefined) throw new Error(`plugin ${identity.id} is not registered`)
    const plan = this.authorizationPlanV4(identity, 'enable', view, this.binding(registration, this.localReviewId()))
    if (plan === undefined) return undefined
    if (this.localV4Reviews.size >= 1024) this.localV4Reviews.delete(this.localV4Reviews.keys().next().value!)
    this.localV4Reviews.set(plan.binding.operationId, {
      registration,
      revision: this.policyRecords.revision,
      plan: structuredClone(plan),
      certificationRevision: this.certifiedProjectionRevision,
      certificationAvailable: this.certifiedProjectionAvailable,
      certification: JSON.stringify(this.activeCertification(registration)),
    })
    return plan
  }

  async authorizeReviewedActivationV4(
    identity: CordisXPluginIdentity,
    authorization: CordisXPermissionAuthorizationDecisionV4,
    view?: PluginGenerationView,
  ): Promise<void> {
    const review = this.localV4Reviews.get(authorization.binding?.operationId)
    this.localV4Reviews.delete(authorization.binding?.operationId)
    const registration = this.registration(identity, view)
    if (!review || registration !== review.registration) throw new Error('permission review was invalidated')
    const current = (revision: bigint) =>
      this.isAuthorizationCurrent(registration, revision)
      && this.registration(identity, view) === registration
      && this.certifiedProjectionRevision === review.certificationRevision
      && this.certifiedProjectionAvailable === review.certificationAvailable
      && JSON.stringify(this.activeCertification(registration)) === review.certification
    if (!current(review.revision)) throw new Error('permission review was invalidated')
    assertPermissionAuthorizationDecisionV4(review.plan, authorization)
    if (
      review.plan.declarations.some(item =>
        item.required && item.authorizationMode === 'persistent-policy'
        && item.policy === 'deny-persistent'
      ) || authorization.decisions.some(selected =>
        review.plan.declarations.some(item =>
          item.capability === selected.capability && item.required
          && selected.decision.startsWith('deny')
        )
      )
    ) throw new Error(`plugin ${identity.id} denies a required permission v4 capability`)
    await this.commitActivationV4(
      registration,
      review.plan,
      authorization.decisions,
      new Set(),
      current,
      review.revision,
    )
  }

  async authorizeActivationV4(
    identity: CordisXPluginIdentity,
    authorization: CordisXPermissionAuthorizationDecisionV4,
    operation: 'install' | 'update' | 'enable' = 'enable',
    view?: PluginGenerationView,
  ): Promise<void> {
    const registration = this.registration(identity, view)
    if (
      registration === undefined
      || (registration.manifest.schemaVersion !== 5 && registration.manifest.schemaVersion !== 6
        && registration.manifest.schemaVersion !== 7 && registration.manifest.schemaVersion !== 8
        && registration.manifest.schemaVersion !== 9 && registration.manifest.schemaVersion !== 10
        && registration.manifest.schemaVersion !== 11 && registration.manifest.schemaVersion !== 12
        && registration.manifest.schemaVersion !== 13 && registration.manifest.schemaVersion !== 16)
    ) {
      throw new Error(`plugin ${identity.id} does not use permission v4`)
    }
    const plan = this.authorizationPlanV4(identity, operation, view, authorization.binding)!
    assertPermissionAuthorizationDecisionV4(plan, authorization)
    if (
      plan.declarations.some(item =>
        item.required
        && item.authorizationMode === 'persistent-policy'
        && item.policy === 'deny-persistent'
      )
      || authorization.decisions.some(selected =>
        plan.declarations.some(item => (
          item.capability === selected.capability && item.required && selected.decision.startsWith('deny')
        ))
      )
    ) {
      throw new Error(`plugin ${identity.id} denies a required permission v4 capability`)
    }
    await this.commitActivationV4(registration, plan, authorization.decisions, new Set())
  }

  async authorizeActivationV7(
    identity: CordisXPluginIdentity,
    authorization: DeferredPermissionDecision,
    operation: 'install' | 'update' | 'enable' = 'enable',
    view?: PluginGenerationView,
    bundlePolicySelections?: Readonly<Record<string, 'allow' | 'deny'>>,
  ): Promise<void> {
    const registration = this.registration(identity, view)
    if (registration === undefined) throw new Error(`plugin ${identity.id} is not registered`)
    if (registration.manifest.schemaVersion === 4) {
      const planV2 = this.planV2(registration, operation, authorization.binding)
      const projected = deferValidatedV2PermissionPlan(planV2)
      if (bundlePolicySelections === undefined) assertDeferredPermissionDecision(projected, authorization)
      else {assertBundlePolicyDecision(
          withBundlePolicyIntent(projected, new Set(Object.keys(bundlePolicySelections))),
          authorization,
          bundlePolicySelections,
        )}
      const decisions = authorization.decisions.map(item => {
        const declaration = planV2.declarations.find(candidate => candidate.capability === item.capability)
        if (declaration === undefined) throw new Error('permission v7 decision has an unknown v2 capability')
        return { ...item, capability: declaration.capability, scope: declaration.scope }
      })
      await this.commitDecisionV2(planV2, {
        $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
        schemaVersion: 2,
        planId: planV2.planId,
        operation: planV2.operation,
        profileId: planV2.profileId,
        identity: planV2.identity,
        binding: planV2.binding,
        decisions,
      }, this.binding(registration, `${this.generation}:${identity.id}`))
      return
    }
    const plan = this.authorizationPlanV4(identity, operation, view, authorization.binding)
    if (plan === undefined) throw new Error(`plugin ${identity.id} does not support permission v7`)
    const original = deferValidatedPermissionPlan(plan)
    const deferred = bundlePolicySelections === undefined
      ? original
      : withBundlePolicyIntent(original, new Set(Object.keys(bundlePolicySelections)))
    if (bundlePolicySelections === undefined) assertDeferredPermissionDecision(deferred, authorization)
    else assertBundlePolicyDecision(deferred, authorization, bundlePolicySelections)
    await this.commitActivationV4(
      registration,
      plan,
      authorization.decisions,
      new Set(deferred.declarations.filter(item => item.authorizationMode === 'deferred').map(item => item.capability)),
    )
  }

  private async commitActivationV4(
    registration: Registration,
    plan: CordisXPermissionAuthorizationPlanV4,
    decisions: CordisXPermissionAuthorizationDecisionV4['decisions'],
    deferred: ReadonlySet<string>,
    isCurrent?: (revision: bigint) => boolean,
    revision?: bigint,
  ): Promise<void> {
    const oneShotBinding = this.binding(registration, `${this.generation}:${registration.identity.id}`)
    const persistent: CordisXPersistedPermissionPolicyRecord[] = []
    for (const selected of decisions) {
      if (selected.decision !== 'allow-persistent' && selected.decision !== 'deny-persistent') continue
      if (isHostDomPermissionCapability(selected.capability)) {
        persistent.push(normalizePermissionPolicyRecordV4({
          $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V4,
          schemaVersion: 4,
          key: {
            profileId: plan.profileId,
            identity: plan.identity,
            capability: selected.capability,
            scope: selected.scope,
            securityFingerprint: selected.securityFingerprint,
          },
          policy: selected.decision,
        }))
        continue
      }
      persistent.push(normalizePermissionPolicyRecordV2({
        $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V2,
        schemaVersion: 2,
        key: {
          profileId: plan.profileId,
          identity: plan.identity,
          capability: selected.capability,
          scope: selected.scope,
          securityFingerprint: selected.securityFingerprint,
        },
        policy: selected.decision,
      }))
    }
    const previous = persistent.map(record => this.policyRecords.get(persistedPermissionRecordKey(record)))
    if (isCurrent && (revision === undefined || !isCurrent(revision))) {
      throw new Error('permission review was invalidated')
    }
    this.localV2Reviews.clear()
    this.localV4Reviews.clear()
    for (const record of persistent) this.policyRecords.set(persistedPermissionRecordKey(record), record)
    try {
      await this.persistMixed(persistent)
    } catch (error) {
      persistent.forEach((record, index) => {
        const key = persistedPermissionRecordKey(record)
        if (this.policyRecords.get(key) !== record) return
        const prior = previous[index]
        if (prior === undefined) this.policyRecords.delete(key)
        else this.policyRecords.set(key, prior)
      })
      this.changed()
      throw error
    }
    if (isCurrent && (revision === undefined || !isCurrent(revision + BigInt(persistent.length)))) {
      this.changed()
      throw new Error('permission review was invalidated')
    }
    this.onceV2.clearOperation(plan.binding.operationId)
    if (oneShotBinding.operationId !== plan.binding.operationId) this.onceV2.clearOperation(oneShotBinding.operationId)
    if (oneShotBinding.operationId !== plan.binding.operationId) this.onceV2.clearOperation(oneShotBinding.operationId)
    for (const selected of decisions) {
      if (selected.decision !== 'allow-once') continue
      this.onceV2.issue({
        profileId: plan.profileId,
        identity: plan.identity,
        capability: selected.capability,
        scope: selected.scope,
        securityFingerprint: selected.securityFingerprint,
      }, oneShotBinding)
    }
    for (const item of plan.declarations) {
      if (!isHostDomPermissionCapability(item.capability)) continue
      if (deferred.has(item.capability)) {
        this.clearExactHostDomLease(registration, item.capability)
        continue
      }
      const selected = decisions.find(candidate => candidate.capability === item.capability)?.decision
      const allowed = item.authorizationMode === 'certified-implicit'
        || (item.authorizationMode === 'persistent-policy' && item.policy === 'allow-persistent')
        || selected === 'allow-persistent'
        || (selected === 'allow-once' && this.onceV2.consume({
          profileId: plan.profileId,
          identity: plan.identity,
          capability: item.capability,
          scope: item.scope,
          securityFingerprint: item.securityFingerprint,
        }, oneShotBinding))
      if (!allowed) {
        this.clearExactHostDomLease(registration, item.capability)
        continue
      }
      this.grantHostDomAccess(
        registration,
        plan,
        item,
        item.authorizationMode === 'certified-implicit' ? 'certified-implicit' : 'explicit-user',
      )
    }
    this.changed()
  }

  protected assertDecisionV2(
    plan: CordisXPermissionAuthorizationPlanV2,
    decision: CordisXPermissionAuthorizationDecisionV2,
  ): void {
    assertPermissionAuthorizationDecisionV2(plan, decision)
  }

  protected authorizationKey(
    plan: CordisXPermissionAuthorizationPlanV2,
    capability: CordisXPermissionCapabilityV2,
  ): CordisXPermissionAuthorizationKeyV2 {
    const item = plan.declarations.find(candidate => candidate.capability === capability)
    if (item === undefined) throw new Error(`permission plan does not declare ${capability}`)
    return Object.freeze({
      profileId: plan.profileId,
      identity: plan.identity,
      capability,
      scope: item.scope,
      securityFingerprint: item.securityFingerprint,
    })
  }

  protected async commitDecisionV2(
    plan: CordisXPermissionAuthorizationPlanV2,
    decision: CordisXPermissionAuthorizationDecisionV2,
    oneShotBinding: CordisXPermissionAuthorizationBindingV2 = plan.binding,
    isCurrent?: (revision: bigint) => boolean,
    revision?: bigint,
  ): Promise<void> {
    const persistent = decision.decisions.flatMap((item): CordisXPermissionPolicyRecordV2[] => {
      if (item.decision !== 'allow-persistent' && item.decision !== 'deny-persistent') return []
      return [normalizePermissionPolicyRecordV2({
        $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V2,
        schemaVersion: 2,
        key: this.authorizationKey(plan, item.capability),
        policy: item.decision,
      })]
    })
    const previous = persistent.map(record => this.policyRecords.get(permissionRecordKeyV2(record)))
    if (isCurrent && (revision === undefined || !isCurrent(revision))) {
      throw new Error('permission review was invalidated')
    }
    this.localV2Reviews.clear()
    this.localV4Reviews.clear()
    for (const record of persistent) this.policyRecords.set(permissionRecordKeyV2(record), record)
    try {
      if (persistent.length > 0) await this.persistV2(persistent)
    } catch (error) {
      persistent.forEach((record, index) => {
        const key = permissionRecordKeyV2(record)
        if (this.policyRecords.get(key) !== record) return
        const prior = previous[index]
        if (prior === undefined) this.policyRecords.delete(key)
        else this.policyRecords.set(key, prior)
      })
      this.changed()
      throw error
    }
    if (isCurrent && (revision === undefined || !isCurrent(revision + BigInt(persistent.length)))) {
      // Persistence may already have succeeded. Notify observers but never issue
      // a one-shot grant from the invalidated decision. The profile owner must
      // reconcile concurrent persistent writes separately.
      this.changed()
      throw new Error('permission review was invalidated')
    }
    this.onceV2.clearOperation(plan.binding.operationId)
    for (const item of decision.decisions) {
      if (item.decision === 'allow-once') {
        this.onceV2.issue(this.authorizationKey(plan, item.capability), oneShotBinding)
      }
    }
    this.changed()
  }

  protected migratePolicyRecordsV1(registration: Registration): void {
    if (
      registration.manifest.schemaVersion !== 4 && registration.manifest.schemaVersion !== 5
      && registration.manifest.schemaVersion !== 6
    ) return
    const legacy = [...this.policyRecords.values()].filter((record): record is CordisXPermissionPolicyRecordV1 => (
      !isPermissionPolicyRecordV2(record)
      && !isPermissionPolicyRecordV3(record)
      && record.key.profileId === this.profileId
      && record.key.identity.source === registration.identity.source
      && record.key.identity.pluginId === registration.identity.id
    ))
    for (const record of legacy) {
      const declaration = registration.declarationsV2.get(record.key.capability as CordisXPermissionCapabilityV2)
      if (
        declaration === undefined
        || JSON.stringify(normalizePermissionScopeV2(record.key.scope)) !== JSON.stringify(declaration.scope)
      ) continue
      const plan = this.planV2(registration, 'runtime', {
        operationId: `migration:${registration.identity.id}:${record.key.capability}`,
        runtimeGeneration: this.generation,
        ...(registration.generation.moduleGeneration === undefined ? {} : {
          moduleGeneration: registration.generation.moduleGeneration,
        }),
      }, [declaration])
      const item = plan.declarations[0]!
      const migrated = migratePermissionPolicyV1(record.policy, {
        key: this.authorizationKey(plan, item.capability),
        persistentAllow: item.persistentAllow,
        persistentDeny: item.persistentDeny,
      })
      const migratedKey = permissionRecordKeyV2(migrated)
      if (this.policyRecords.has(migratedKey)) continue
      this.policyRecords.set(migratedKey, migrated)
      const legacyKey = permissionRecordKey(record)
      const task = this.persistV2([migrated]).then(() => {
        this.policyRecords.delete(legacyKey)
      }).catch((error) => {
        if (this.policyRecords.get(migratedKey) === migrated) this.policyRecords.delete(migratedKey)
        this.changed()
        throw error
      })
      this.migrationTasks.push(task)
    }
  }
}
