import { PlatformHostDomPermissionBroker } from './platform-host-dom-permission.js'
import type {
  CordisXCapabilityDeclaration,
  CordisXPermissionPolicyRecordV1,
  CordisXPluginIdentity,
} from '../../contracts.js'
import { permissionRecordKey } from '../../permissions.js'
import type { PluginGenerationView } from '../generation-visibility.js'
import { CORDISX_PERMISSION_POLICY_SCHEMA_V2, CORDISX_PERMISSION_POLICY_SCHEMA_V4 } from '../../permission-contracts.js'
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

import { permissionPlanDeclarations, Registration } from './platform-permission-types.js'

export abstract class PlatformAuthorizationV2Broker extends PlatformHostDomPermissionBroker {
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
        && registration.manifest.schemaVersion !== 11 && registration.manifest.schemaVersion !== 12)
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
    const oneShotBinding = this.binding(registration, `${this.generation}:${identity.id}`)
    const persistent: CordisXPersistedPermissionPolicyRecord[] = []
    for (const selected of authorization.decisions) {
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
    for (const record of persistent) this.policyRecords.set(persistedPermissionRecordKey(record), record)
    try {
      await this.persistMixed(persistent)
    } catch (error) {
      persistent.forEach((record, index) => {
        const key = persistedPermissionRecordKey(record)
        const prior = previous[index]
        if (prior === undefined) this.policyRecords.delete(key)
        else this.policyRecords.set(key, prior)
      })
      this.changed()
      throw error
    }
    this.onceV2.clearOperation(plan.binding.operationId)
    for (const selected of authorization.decisions) {
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
      const selected = authorization.decisions.find(candidate => candidate.capability === item.capability)?.decision
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
    for (const record of persistent) this.policyRecords.set(permissionRecordKeyV2(record), record)
    try {
      if (persistent.length > 0) await this.persistV2(persistent)
    } catch (error) {
      persistent.forEach((record, index) => {
        const key = permissionRecordKeyV2(record)
        const prior = previous[index]
        if (prior === undefined) this.policyRecords.delete(key)
        else this.policyRecords.set(key, prior)
      })
      this.changed()
      throw error
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
