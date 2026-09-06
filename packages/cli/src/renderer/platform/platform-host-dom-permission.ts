import { PlatformDomPermissionBroker } from './platform-dom-permission.js'
import type { CordisXPluginIdentity } from '../../contracts.js'
import type { PluginGenerationView } from '../generation-visibility.js'
import {
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V4,
  CORDISX_PERMISSION_POLICY_SCHEMA_V4,
} from '../../permission-contracts.js'
import type {
  CordisXCertifiedPermissionProjectionV1,
  CordisXPermissionAuthorizationDecisionV4,
  CordisXPermissionAuthorizationKeyV4,
  CordisXPermissionAuthorizationPlanV4,
  CordisXPermissionDecisionV2,
  CordisXPermissionPolicyV2,
} from '../../permission-contracts.js'
import { buildHostDomPermissionAuthorizationPlanV4 } from '../../capability-risk-catalog.js'
import { sha256Hex } from '../../permission-model-v2.js'
import {
  hostDomPermissionAuthorizationKeyV4,
  normalizePermissionPolicyRecordV4,
  permissionRecordKeyV4,
} from '../../permission-model-v4.js'
import { isPermissionPolicyRecordV4 } from '../../permission-persistence.js'

import { platformIdentityKey } from './platform-manifest.js'
import {
  HostDomPermissionAccessDecision,
  HostDomPermissionLease,
  isoNow,
  Registration,
} from './platform-permission-types.js'

export abstract class PlatformHostDomPermissionBroker extends PlatformDomPermissionBroker {
  protected hostDomPlan(
    registration: Registration,
    capability: 'ui.host-dom.read' | 'ui.host-dom.modify',
    operationId: string,
  ): CordisXPermissionAuthorizationPlanV4 {
    const declaration = registration.declarationsV4.get(capability)
    if (declaration === undefined) throw new Error(`plugin ${registration.identity.id} does not declare ${capability}`)
    const certification = this.activeCertification(registration)
    return buildHostDomPermissionAuthorizationPlanV4({
      planId: operationId,
      profileId: this.profileId,
      identity: { source: registration.identity.source, pluginId: registration.identity.id },
      binding: this.binding(registration, operationId, operationId),
      declaration,
      policies: [...this.policyRecords.values()].filter(isPermissionPolicyRecordV4),
      ...(certification === undefined ? {} : { certification }),
    }, this.catalog)
  }

  protected hostDomLeaseKey(key: CordisXPermissionAuthorizationKeyV4): string {
    return permissionRecordKeyV4({
      $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V4,
      schemaVersion: 4,
      key,
      policy: 'ask',
    })
  }

  protected hostDomKey(
    registration: Registration,
    capability: 'ui.host-dom.read' | 'ui.host-dom.modify',
  ): CordisXPermissionAuthorizationKeyV4 {
    const declaration = registration.declarationsV4.get(capability)
    if (declaration === undefined) throw new Error(`plugin ${registration.identity.id} does not declare ${capability}`)
    return hostDomPermissionAuthorizationKeyV4({
      profileId: this.profileId,
      identity: { source: registration.identity.source, pluginId: registration.identity.id },
      declaration,
      catalogVersion: this.catalog.versionV4,
    })
  }

  hostDomPolicy(
    identity: CordisXPluginIdentity,
    capability: 'ui.host-dom.read' | 'ui.host-dom.modify',
    view?: PluginGenerationView,
  ): 'inherit' | 'allow' | 'deny' {
    const registration = this.registration(identity, view)
    if (registration?.declarationsV4.has(capability) !== true) return 'inherit'
    const record = this.policyRecords.get(this.hostDomLeaseKey(this.hostDomKey(registration, capability)))
    if (!isPermissionPolicyRecordV4(record)) return 'inherit'
    return record.policy === 'allow-persistent' ? 'allow' : record.policy === 'deny-persistent' ? 'deny' : 'inherit'
  }

  protected hostDomPolicyRevision(
    registration: Registration,
    capability: 'ui.host-dom.read' | 'ui.host-dom.modify',
  ): number {
    return this.hostDomPolicyRevisions.get(this.hostDomLeaseKey(this.hostDomKey(registration, capability))) ?? 0
  }

  protected bumpHostDomPolicyRevision(
    registration: Registration,
    capability: 'ui.host-dom.read' | 'ui.host-dom.modify',
  ): number {
    const key = this.hostDomLeaseKey(this.hostDomKey(registration, capability))
    const revision = (this.hostDomPolicyRevisions.get(key) ?? 0) + 1
    this.hostDomPolicyRevisions.set(key, revision)
    return revision
  }

  protected cancelHostDomPrompts(
    registration: Registration,
    capability: 'ui.host-dom.read' | 'ui.host-dom.modify',
  ): void {
    for (const [key, pending] of this.hostDomPromptPlans) {
      const plan = pending.plan
      if (
        plan.identity.source !== registration.identity.source || plan.identity.pluginId !== registration.identity.id
        || plan.binding.moduleGeneration !== registration.generation.moduleGeneration
        || plan.declarations[0]?.capability !== capability
      ) continue
      this.hostDomPromptPlans.delete(key)
      pending.cancel()
      this.promptV2?.cancelV4?.(plan.planId, plan.binding)
    }
  }

  async setHostDomPolicy(
    identity: CordisXPluginIdentity,
    capability: 'ui.host-dom.read' | 'ui.host-dom.modify',
    policy: CordisXPermissionPolicyV2,
    view?: PluginGenerationView,
  ): Promise<void> {
    const registration = this.registration(identity, view)
    if (registration?.declarationsV4.has(capability) !== true) {
      throw new Error(`plugin ${identity.id} does not declare ${capability}`)
    }
    if (capability === 'ui.host-dom.modify' && policy === 'allow-persistent') {
      throw new Error('ui.host-dom.modify does not permit persistent allow')
    }
    const plan = this.hostDomPlan(registration, capability, `policy-v4:${identity.id}:${capability}`)
    const item = plan.declarations[0]!
    const record = normalizePermissionPolicyRecordV4({
      $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V4,
      schemaVersion: 4,
      key: {
        profileId: plan.profileId,
        identity: plan.identity,
        capability,
        scope: item.scope,
        securityFingerprint: item.securityFingerprint,
      },
      policy,
    })
    const key = permissionRecordKeyV4(record)
    const previous = this.policyRecords.get(key)
    this.policyRecords.set(key, record)
    this.clearExactHostDomLease(registration, capability)
    this.bumpHostDomPolicyRevision(registration, capability)
    this.cancelHostDomPrompts(registration, capability)
    this.changed()
    try {
      await this.persistV4([record])
    } catch (error) {
      if (previous === undefined) this.policyRecords.delete(key)
      else this.policyRecords.set(key, previous)
      this.clearExactHostDomLease(registration, capability)
      this.bumpHostDomPolicyRevision(registration, capability)
      this.cancelHostDomPrompts(registration, capability)
      this.changed()
      throw error
    }
    this.onceV2.clearGeneration(this.generation, registration.generation.moduleGeneration)
  }

  async authorizeHostDom(
    identity: CordisXPluginIdentity,
    capability: 'ui.host-dom.read' | 'ui.host-dom.modify',
    rootId: string,
    operations: readonly string[],
    view?: PluginGenerationView,
  ): Promise<HostDomPermissionAccessDecision> {
    const registration = this.registration(identity, view)
    if (registration === undefined) {
      return Object.freeze({
        authorized: false,
        state: 'denied',
        reason: 'permission.identity-unavailable',
        policy: 'inherit',
      })
    }
    const declaration = registration.declarationsV4.get(capability)
    if (declaration === undefined) {
      return Object.freeze({
        authorized: false,
        state: 'denied',
        reason: 'permission.undeclared',
        policy: 'inherit',
      })
    }
    const roots = declaration.scope.rootIds ?? []
    const declaredOperations = declaration.scope.operations ?? []
    if (
      !roots.includes(rootId) || operations.length < 1 || new Set(operations).size !== operations.length
      || operations.some(operation => !declaredOperations.includes(operation as never))
    ) {
      this.recordHostDomAudit(
        registration,
        capability,
        false,
        'explicit-user',
        'Requested root or operation exceeds manifest scope',
      )
      return Object.freeze({ authorized: false, state: 'denied', reason: 'permission.scope-denied', policy: 'inherit' })
    }
    const policy = this.hostDomPolicy(identity, capability, view)
    if (policy === 'deny') {
      this.clearExactHostDomLease(registration, capability)
      this.recordHostDomAudit(registration, capability, false, 'explicit-user', 'Persistent user denial')
      return Object.freeze({
        authorized: false,
        state: 'denied',
        reason: 'permission.denied-persistent',
        policy: 'deny',
      })
    }
    const lease = this.validHostDomLease(registration, capability)
    if (lease !== undefined) {
      return Object.freeze({
        authorized: true,
        state: 'allowed',
        reason: lease.authorizationOrigin === 'certified-implicit'
          ? 'permission.certified-implicit'
          : 'permission.explicit-user',
        policy,
        authorizationOrigin: lease.authorizationOrigin,
        lease,
      })
    }
    const operationId = `host-dom:${
      sha256Hex([
        this.generation,
        registration.generation.moduleGeneration ?? 'host',
        identity.source,
        identity.id,
        capability,
        rootId,
        [...operations].sort().join(','),
        String(this.now().getTime()),
        String(++this.hostDomOperationSequence),
      ].join('\u0000')).slice(0, 48)
    }`
    const plan = this.hostDomPlan(registration, capability, operationId)
    const item = plan.declarations[0]!
    if (item.authorizationMode === 'persistent-policy' && item.policy === 'deny-persistent') {
      this.recordHostDomAudit(registration, capability, false, 'explicit-user', 'Persistent user denial')
      return Object.freeze({
        authorized: false,
        state: 'denied',
        reason: 'permission.denied-persistent',
        policy: 'deny',
      })
    }
    let origin: 'explicit-user' | 'certified-implicit'
    if (item.authorizationMode === 'certified-implicit') origin = 'certified-implicit'
    else if (item.authorizationMode === 'persistent-policy' && item.policy === 'allow-persistent') {
      origin = 'explicit-user'
    } else {
      let decision: CordisXPermissionAuthorizationDecisionV4 | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      const policyRevision = this.hostDomPolicyRevision(registration, capability)
      let cancelPrompt!: () => void
      const cancelled = new Promise<undefined>(resolve => {
        cancelPrompt = () => resolve(undefined)
      })
      this.hostDomPromptPlans.set(plan.planId, { plan, cancel: cancelPrompt })
      try {
        decision = await Promise.race([
          this.promptV2?.requestV4?.(plan, identity) ?? Promise.resolve(undefined),
          cancelled,
          new Promise<undefined>(resolve => {
            timer = setTimeout(() => resolve(undefined), this.promptTimeoutMs)
          }),
        ])
      } catch {
        decision = undefined
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        this.hostDomPromptPlans.delete(plan.planId)
        this.promptV2?.cancelV4?.(plan.planId, plan.binding)
      }
      if (!this.isRegistered(registration)) {
        return Object.freeze({
          authorized: false,
          state: 'denied',
          reason: 'permission.generation-invalidated',
          policy: 'inherit',
        })
      }
      const currentPolicy = this.hostDomPolicy(identity, capability, view)
      if (currentPolicy === 'deny') {
        this.recordHostDomAudit(registration, capability, false, 'explicit-user', 'Persistent user denial')
        return Object.freeze({
          authorized: false,
          state: 'denied',
          reason: 'permission.denied-persistent',
          policy: 'deny',
        })
      }
      if (this.hostDomPolicyRevision(registration, capability) !== policyRevision) {
        return Object.freeze({
          authorized: false,
          state: 'denied',
          reason: 'permission.policy-invalidated',
          policy: currentPolicy,
        })
      }
      if (decision === undefined) {
        this.recordHostDomAudit(
          registration,
          capability,
          false,
          'explicit-user',
          'Explicit review cancelled or timed out',
        )
        return Object.freeze({
          authorized: false,
          state: 'denied',
          reason: 'permission.review-cancelled',
          policy: 'inherit',
        })
      }
      const committed = await this.commitHostDomDecision(registration, plan, decision)
      const selected = committed.decision
      if (!this.isRegistered(registration)) {
        return Object.freeze({
          authorized: false,
          state: 'denied',
          reason: 'permission.generation-invalidated',
          policy: 'inherit',
        })
      }
      const committedPolicy = this.hostDomPolicy(identity, capability, view)
      if (
        this.hostDomPolicyRevision(registration, capability) !== committed.policyRevision
        || committedPolicy === 'deny' && selected !== 'deny-persistent'
      ) {
        this.clearExactHostDomLease(registration, capability)
        return Object.freeze({
          authorized: false,
          state: 'denied',
          reason: 'permission.policy-invalidated',
          policy: committedPolicy,
        })
      }
      if (selected === 'deny-once' || selected === 'deny-persistent') {
        this.recordHostDomAudit(registration, capability, false, 'explicit-user', 'Explicit user denial')
        return Object.freeze({
          authorized: false,
          state: 'denied',
          reason: 'permission.denied-explicit',
          policy: selected === 'deny-persistent' ? 'deny' : 'inherit',
        })
      }
      const key: CordisXPermissionAuthorizationKeyV4 = Object.freeze({
        profileId: plan.profileId,
        identity: plan.identity,
        capability: item.capability,
        scope: item.scope,
        securityFingerprint: item.securityFingerprint,
      })
      if (selected === 'allow-once') {
        this.onceV2.issue(key, plan.binding)
        if (!this.onceV2.consume(key, plan.binding)) {
          return Object.freeze({
            authorized: false,
            state: 'denied',
            reason: 'permission.once-invalid',
            policy: 'inherit',
          })
        }
      }
      origin = 'explicit-user'
    }
    const granted = this.grantHostDomAccess(registration, plan, item, origin)
    const activeLease = this.isRegistered(registration)
      ? this.validHostDomLease(registration, capability)
      : undefined
    return activeLease !== undefined && activeLease.leaseId === granted.lease?.leaseId
      ? granted
      : Object.freeze({
        authorized: false,
        state: 'denied',
        reason: 'permission.grant-invalidated',
        policy: 'inherit',
      })
  }

  isHostDomLeaseActive(
    identity: CordisXPluginIdentity,
    leaseId: string,
    view?: PluginGenerationView,
  ): boolean {
    const registration = this.registration(identity, view)
    if (registration === undefined) return false
    const lease = [...this.hostDomLeases.values()].find(candidate => candidate.leaseId === leaseId)
    return lease !== undefined
      && this.validHostDomLease(registration, lease.key.capability as 'ui.host-dom.read' | 'ui.host-dom.modify')
          ?.leaseId === leaseId
  }

  protected validHostDomLease(
    registration: Registration,
    capability: 'ui.host-dom.read' | 'ui.host-dom.modify',
  ): HostDomPermissionLease | undefined {
    if (!registration.declarationsV4.has(capability)) return undefined
    const key = this.hostDomKey(registration, capability)
    const leaseKey = this.hostDomLeaseKey(key)
    const lease = this.hostDomLeases.get(leaseKey)
    if (lease === undefined) return undefined
    const policy = this.policyRecords.get(leaseKey)
    if (isPermissionPolicyRecordV4(policy) && policy.policy === 'deny-persistent') {
      this.hostDomLeases.delete(leaseKey)
      return undefined
    }
    const certification = this.activeCertification(registration)
    const valid = lease.runtimeGeneration === this.generation
      && lease.moduleGeneration === registration.generation.moduleGeneration
      && lease.key.securityFingerprint === key.securityFingerprint
      && (lease.authorizationOrigin !== 'certified-implicit' || (
        certification !== undefined
        && lease.certificationFingerprint === certification.fingerprint
        && lease.certificationRevision === certification.revision
      ))
    if (valid) return lease
    this.hostDomLeases.delete(leaseKey)
    return undefined
  }

  protected grantHostDomAccess(
    registration: Registration,
    plan: CordisXPermissionAuthorizationPlanV4,
    item: CordisXPermissionAuthorizationPlanV4['declarations'][number],
    origin: 'explicit-user' | 'certified-implicit',
  ): HostDomPermissionAccessDecision {
    const key: CordisXPermissionAuthorizationKeyV4 = Object.freeze({
      profileId: plan.profileId,
      identity: plan.identity,
      capability: item.capability,
      scope: item.scope,
      securityFingerprint: item.securityFingerprint,
    })
    const certification = origin === 'certified-implicit' ? item.certification : undefined
    const lease: HostDomPermissionLease = Object.freeze({
      leaseId: `hdl_${
        sha256Hex([plan.planId, item.capability, item.securityFingerprint, this.now().toISOString()].join('\u0000'))
          .slice(0, 48)
      }`,
      key,
      runtimeGeneration: this.generation,
      ...(registration.generation.moduleGeneration === undefined
        ? {}
        : { moduleGeneration: registration.generation.moduleGeneration }),
      authorizationOrigin: origin,
      ...(certification === undefined ? {} : {
        certificationFingerprint: certification.fingerprint,
        certificationRevision: certification.revision,
      }),
    })
    this.hostDomLeases.set(this.hostDomLeaseKey(key), lease)
    this.recordHostDomAudit(
      registration,
      item.capability as 'ui.host-dom.read' | 'ui.host-dom.modify',
      true,
      origin,
      origin === 'certified-implicit'
        ? 'Exact Certified artifact auto-approved by the Host catalog'
        : 'Explicit user approval',
      certification,
    )
    return Object.freeze({
      authorized: true,
      state: 'allowed',
      reason: origin === 'certified-implicit' ? 'permission.certified-implicit' : 'permission.explicit-user',
      policy: item.policy === 'allow-persistent' ? 'allow' : 'inherit',
      authorizationOrigin: origin,
      lease,
    })
  }

  protected async commitHostDomDecision(
    registration: Registration,
    plan: CordisXPermissionAuthorizationPlanV4,
    decision: CordisXPermissionAuthorizationDecisionV4,
  ): Promise<Readonly<{ decision: CordisXPermissionDecisionV2; policyRevision: number }>> {
    const item = plan.declarations[0]!
    const selected = decision.decisions[0]
    if (
      decision.$schema !== CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V4
      || decision.schemaVersion !== 4 || decision.origin !== 'explicit-user'
      || decision.planId !== plan.planId || decision.operation !== plan.operation
      || decision.profileId !== plan.profileId || JSON.stringify(decision.identity) !== JSON.stringify(plan.identity)
      || JSON.stringify(decision.binding) !== JSON.stringify(plan.binding)
      || decision.decisions.length !== 1 || selected === undefined
      || selected.capability !== item.capability || JSON.stringify(selected.scope) !== JSON.stringify(item.scope)
      || selected.securityFingerprint !== item.securityFingerprint || !item.allowedDecisions.includes(selected.decision)
    ) {
      throw new Error('Host DOM permission decision does not match the exact Host plan')
    }
    let policyRevision = this.hostDomPolicyRevision(
      registration,
      item.capability as 'ui.host-dom.read' | 'ui.host-dom.modify',
    )
    if (selected.decision === 'allow-persistent' || selected.decision === 'deny-persistent') {
      const record = normalizePermissionPolicyRecordV4({
        $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V4,
        schemaVersion: 4,
        key: {
          profileId: plan.profileId,
          identity: plan.identity,
          capability: item.capability,
          scope: item.scope,
          securityFingerprint: item.securityFingerprint,
        },
        policy: selected.decision,
      })
      const key = permissionRecordKeyV4(record)
      const previous = this.policyRecords.get(key)
      this.policyRecords.set(key, record)
      this.clearExactHostDomLease(registration, item.capability as 'ui.host-dom.read' | 'ui.host-dom.modify')
      policyRevision = this.bumpHostDomPolicyRevision(
        registration,
        item.capability as 'ui.host-dom.read' | 'ui.host-dom.modify',
      )
      this.cancelHostDomPrompts(registration, item.capability as 'ui.host-dom.read' | 'ui.host-dom.modify')
      this.changed()
      try {
        await this.persistV4([record])
      } catch (error) {
        if (previous === undefined) this.policyRecords.delete(key)
        else this.policyRecords.set(key, previous)
        this.clearExactHostDomLease(registration, item.capability as 'ui.host-dom.read' | 'ui.host-dom.modify')
        this.bumpHostDomPolicyRevision(registration, item.capability as 'ui.host-dom.read' | 'ui.host-dom.modify')
        this.cancelHostDomPrompts(registration, item.capability as 'ui.host-dom.read' | 'ui.host-dom.modify')
        this.changed()
        throw error
      }
    }
    return Object.freeze({ decision: selected.decision, policyRevision })
  }

  protected hostDomAuditKey(registration: Registration, capability: 'ui.host-dom.read' | 'ui.host-dom.modify'): string {
    return `${platformIdentityKey(registration.identity)}\u0000${capability}\u0000${
      registration.generation.moduleGeneration ?? 'host'
    }`
  }

  protected recordHostDomAudit(
    registration: Registration,
    capability: 'ui.host-dom.read' | 'ui.host-dom.modify',
    allowed: boolean,
    authorizationOrigin: 'explicit-user' | 'certified-implicit',
    authorizationReason: string,
    certification?: CordisXCertifiedPermissionProjectionV1,
  ): void {
    const key = this.hostDomAuditKey(registration, capability)
    const audit = this.audit.get(key) ?? { denialCount: 0 }
    if (allowed) audit.lastUsedAt = isoNow(this.now)
    else {
      audit.lastDeniedAt = isoNow(this.now)
      audit.denialCount += 1
    }
    audit.authorizationOrigin = authorizationOrigin
    audit.authorizationReason = authorizationReason
    if (certification === undefined) delete audit.certification
    else audit.certification = certification
    this.audit.set(key, audit)
    this.consoleObserver?.permission(registration.identity, capability, allowed ? 'allow' : 'deny', authorizationReason)
    this.changed()
  }

  protected clearExactHostDomLease(
    registration: Registration,
    capability: 'ui.host-dom.read' | 'ui.host-dom.modify',
  ): void {
    if (!registration.declarationsV4.has(capability)) return
    this.hostDomLeases.delete(this.hostDomLeaseKey(this.hostDomKey(registration, capability)))
  }

  protected clearCertifiedHostDomLeases(registration: Registration): void {
    for (const [key, lease] of this.hostDomLeases) {
      if (
        lease.runtimeGeneration === this.generation
        && lease.moduleGeneration === registration.generation.moduleGeneration
        && lease.authorizationOrigin === 'certified-implicit'
        && lease.key.identity.source === registration.identity.source
        && lease.key.identity.pluginId === registration.identity.id
      ) this.hostDomLeases.delete(key)
    }
    for (const capability of registration.declarationsV4.keys()) {
      const audit = this.audit.get(this.hostDomAuditKey(registration, capability))
      if (audit?.authorizationOrigin !== 'certified-implicit') continue
      delete audit.authorizationOrigin
      delete audit.authorizationReason
      delete audit.certification
    }
  }

  protected clearHostDomGeneration(moduleGeneration?: string, identity?: CordisXPluginIdentity): void {
    for (const [key, lease] of this.hostDomLeases) {
      if (
        lease.runtimeGeneration === this.generation
        && (moduleGeneration === undefined || lease.moduleGeneration === moduleGeneration)
        && (identity === undefined || (
          lease.key.identity.source === identity.source && lease.key.identity.pluginId === identity.id
        ))
      ) this.hostDomLeases.delete(key)
    }
    for (const [key, pending] of this.hostDomPromptPlans) {
      const plan = pending.plan
      if (
        (moduleGeneration === undefined || plan.binding.moduleGeneration === moduleGeneration)
        && (identity === undefined
          || (plan.identity.source === identity.source && plan.identity.pluginId === identity.id))
      ) {
        this.hostDomPromptPlans.delete(key)
        pending.cancel()
        this.promptV2?.cancelV4?.(plan.planId, plan.binding)
      }
    }
    if (identity !== undefined) {
      const prefix = `${platformIdentityKey(identity)}\u0000ui.host-dom.`
      const generationSuffix = moduleGeneration === undefined ? undefined : `\u0000${moduleGeneration}`
      for (const key of [...this.audit.keys()]) {
        if (key.startsWith(prefix) && (generationSuffix === undefined || key.endsWith(generationSuffix))) {
          this.audit.delete(key)
        }
      }
    }
  }
}
