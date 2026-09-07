import { PlatformAgentRuntimeBroker } from './platform-agent-runtime.js'
import type { CordisXPluginIdentity } from '../../contracts.js'
import type { PluginGenerationView } from '../generation-visibility.js'
import {
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V3,
  CORDISX_PERMISSION_POLICY_SCHEMA_V3,
} from '../../permission-contracts.js'
import type {
  CordisXCertifiedPermissionProjectionV1,
  CordisXPermissionAuthorizationDecisionV3,
  CordisXPermissionAuthorizationKeyV3,
  CordisXPermissionAuthorizationPlanV3,
  CordisXPermissionDecisionV2,
} from '../../permission-contracts.js'
import { buildDomPermissionAuthorizationPlanV3 } from '../../capability-risk-catalog.js'
import { sha256Hex } from '../../permission-model-v2.js'
import {
  domPermissionAuthorizationKeyV3,
  normalizePermissionPolicyRecordV3,
  permissionRecordKeyV3,
} from '../../permission-model-v3.js'
import { normalizeCertifiedPermissionProjectionV1 } from '../../permission-model-v4.js'
import { isPermissionPolicyRecordV3 } from '../../permission-persistence.js'

import { certifiedArtifactKey, object, platformIdentityKey } from './platform-manifest.js'
import {
  DomPermissionAccessDecision,
  DomPermissionLease,
  DomPermissionPolicyEntry,
  isoNow,
  Registration,
} from './platform-permission-types.js'

export abstract class PlatformDomPermissionBroker extends PlatformAgentRuntimeBroker {
  protected abstract clearCertifiedHostDomLeases(registration: Registration): void

  /** Refreshes only the Host-owned trust projection for the already bound exact artifact. */
  protected refreshRegistrationDomCertification(
    key: string,
    registration: Registration,
    certification?: CordisXCertifiedPermissionProjectionV1,
  ): void {
    const artifact = registration.artifact
    if (artifact === undefined || this.registrations.get(key)?.token !== registration.token) return
    const normalized = normalizeCertifiedPermissionProjectionV1(
      certification,
      {
        source: registration.identity.source,
        pluginId: registration.identity.id,
      },
      artifact,
      this.now(),
    )
    const previous = artifact.certification
    if (previous?.fingerprint === normalized?.fingerprint && previous?.revision === normalized?.revision) {
      this.scheduleDomCertificationExpiry(key, registration)
      return
    }
    const next = Object.freeze({
      ...registration,
      artifact: Object.freeze({
        version: artifact.version,
        integrity: artifact.integrity,
        ...(normalized === undefined ? {} : { certification: normalized }),
      }),
    })
    this.registrations.set(key, next)
    this.scheduleDomCertificationExpiry(key, next)
    this.clearCertifiedDomLeases(registration)
    this.clearCertifiedHostDomLeases(registration)
    const auditPrefix = this.domAuditPrefix(
      platformIdentityKey(registration.identity),
      registration.generation.moduleGeneration,
    )
    for (const [key, audit] of this.audit) {
      if (!key.startsWith(auditPrefix)) continue
      if (audit.authorizationOrigin !== 'certified-implicit') continue
      delete audit.authorizationOrigin
      delete audit.authorizationReason
      delete audit.certification
    }
    this.changed()
  }

  /**
   * Atomically replace the Launcher-owned exact projection snapshot. This is
   * the single runtime trust input: it neither parses feeds nor accepts
   * Official, policies, scopes, grants, or plugin-supplied assertions.
   */
  replaceCertifiedPermissionSnapshot(
    snapshot: Readonly<{
      revision: number
      projections: readonly CordisXCertifiedPermissionProjectionV1[]
    }>,
  ): void {
    if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
      throw new Error('Certified permission snapshot revision is invalid')
    }
    const next = new Map<string, CordisXCertifiedPermissionProjectionV1>()
    for (const projection of snapshot.projections) {
      const normalized = normalizeCertifiedPermissionProjectionV1(
        projection,
        { source: projection.source, pluginId: projection.pluginId },
        { version: projection.version, integrity: projection.integrity },
        this.now(),
      )
      if (normalized === undefined) throw new Error('Certified permission snapshot contains an invalid projection')
      const key = certifiedArtifactKey(
        { source: normalized.source, pluginId: normalized.pluginId },
        normalized,
      )
      if (next.has(key)) throw new Error('Certified permission snapshot contains a duplicate exact artifact')
      next.set(key, normalized)
    }
    const digest = JSON.stringify([...next.values()])
    if (snapshot.revision < this.certifiedProjectionRevision) {
      throw new Error('Certified permission snapshot revision regressed')
    }
    if (
      snapshot.revision === this.certifiedProjectionRevision
      && this.certifiedProjectionDigest !== '' && digest !== this.certifiedProjectionDigest
    ) {
      throw new Error('Certified permission snapshot equivocated at one revision')
    }
    if (
      snapshot.revision === this.certifiedProjectionRevision
      && digest === this.certifiedProjectionDigest && this.certifiedProjectionAvailable
    ) return
    this.certifiedProjectionRevision = snapshot.revision
    this.certifiedProjectionDigest = digest
    this.certifiedProjectionAvailable = true
    this.applyCertifiedProjectionMap(next)
  }

  /** Channel loss clears grants without resetting the monotonic replay fence. */
  clearCertifiedPermissionSnapshot(): void {
    if (!this.certifiedProjectionAvailable && this.certifiedProjections.size === 0) return
    this.certifiedProjectionAvailable = false
    this.applyCertifiedProjectionMap(new Map())
  }

  protected applyCertifiedProjectionMap(
    next: ReadonlyMap<string, CordisXCertifiedPermissionProjectionV1>,
  ): void {
    this.batchChanges(() => {
      this.certifiedProjections.clear()
      for (const [key, projection] of next) this.certifiedProjections.set(key, projection)
      for (const [registrationKey, registration] of [...this.registrations.entries()]) {
        const artifact = registration.artifact
        if (artifact === undefined) continue
        this.refreshRegistrationDomCertification(
          registrationKey,
          registration,
          this.certifiedProjections.get(certifiedArtifactKey(
            { source: registration.identity.source, pluginId: registration.identity.id },
            artifact,
          )),
        )
      }
    })
  }

  protected clearDomCertificationTimer(key: string): void {
    const timer = this.domCertificationTimers.get(key)
    if (timer !== undefined) clearTimeout(timer)
    this.domCertificationTimers.delete(key)
  }

  protected scheduleDomCertificationExpiry(key: string, registration: Registration): void {
    this.clearDomCertificationTimer(key)
    const certification = registration.artifact?.certification
    if (certification === undefined) return
    const remaining = Date.parse(certification.expiresAt) - this.now().getTime()
    if (!Number.isFinite(remaining) || remaining <= 0) {
      queueMicrotask(() => this.expireDomCertification(key, registration.token))
      return
    }
    const timer = setTimeout(
      () => this.expireDomCertification(key, registration.token),
      Math.min(remaining, 2_147_483_647),
    )
    ;(timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.()
    this.domCertificationTimers.set(key, timer)
  }

  protected expireDomCertification(key: string, token: object): void {
    this.domCertificationTimers.delete(key)
    const registration = this.registrations.get(key)
    const artifact = registration?.artifact
    const certification = artifact?.certification
    if (
      registration === undefined || registration.token !== token || artifact === undefined
      || certification === undefined
    ) return
    if (this.now().getTime() < Date.parse(certification.expiresAt)) {
      this.scheduleDomCertificationExpiry(key, registration)
      return
    }
    const next = Object.freeze({
      ...registration,
      artifact: Object.freeze({ version: artifact.version, integrity: artifact.integrity }),
    })
    this.registrations.set(key, next)
    this.clearCertifiedDomLeases(registration)
    this.clearCertifiedHostDomLeases(registration)
    const auditPrefix = this.domAuditPrefix(
      platformIdentityKey(registration.identity),
      registration.generation.moduleGeneration,
    )
    for (const [auditKey, audit] of this.audit) {
      if (!auditKey.startsWith(auditPrefix)) continue
      if (audit.authorizationOrigin !== 'certified-implicit') continue
      delete audit.authorizationOrigin
      delete audit.authorizationReason
      delete audit.certification
    }
    this.changed()
  }

  protected domPointKey(identity: CordisXPluginIdentity, pointId: string, moduleGeneration?: string): string {
    return `${this.domGenerationPrefix(identity, moduleGeneration)}${pointId}`
  }

  protected domGenerationPrefix(identity: CordisXPluginIdentity, moduleGeneration?: string): string {
    return `${platformIdentityKey(identity)}\u0000${moduleGeneration ?? 'host'}\u0000`
  }

  protected domPendingReviewKey(identity: CordisXPluginIdentity, moduleGeneration?: string): string {
    return `${platformIdentityKey(identity)}\u0000${moduleGeneration ?? 'host'}`
  }

  protected activeCertification(registration: Registration): CordisXCertifiedPermissionProjectionV1 | undefined {
    const artifact = registration.artifact
    return artifact === undefined
      ? undefined
      : normalizeCertifiedPermissionProjectionV1(
        artifact.certification,
        {
          source: registration.identity.source,
          pluginId: registration.identity.id,
        },
        artifact,
        this.now(),
      )
  }

  protected domPlan(
    registration: Registration,
    pointId: string,
    operationId: string,
  ): CordisXPermissionAuthorizationPlanV3 {
    const certification = this.activeCertification(registration)
    return buildDomPermissionAuthorizationPlanV3({
      planId: operationId,
      profileId: this.profileId,
      identity: { source: registration.identity.source, pluginId: registration.identity.id },
      binding: this.binding(registration, operationId, operationId),
      declaration: {
        name: 'ui.extension-points.render',
        required: (registration.manifest.schemaVersion === 10 || registration.manifest.schemaVersion === 11)
          && registration.manifest.capabilities.some(item =>
            item.name === 'ui.extension-points.render' && item.required && item.scope.extensionPoints.includes(pointId)
          ),
        scope: { extensionPoints: [pointId] },
      },
      policies: [...this.policyRecords.values()].filter(isPermissionPolicyRecordV3),
      ...(certification === undefined ? {} : { certification }),
    }, this.catalog)
  }

  protected domLeaseKey(key: CordisXPermissionAuthorizationKeyV3): string {
    return permissionRecordKeyV3({
      $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V3,
      schemaVersion: 3,
      key,
      policy: 'ask',
    })
  }

  protected validDomLease(registration: Registration, pointId: string): DomPermissionLease | undefined {
    const key = domPermissionAuthorizationKeyV3({
      profileId: this.profileId,
      identity: { source: registration.identity.source, pluginId: registration.identity.id },
      pointId,
      catalogVersion: this.catalog.version,
    })
    const leaseKey = this.domLeaseKey(key)
    const lease = this.domLeases.get(leaseKey)
    if (lease === undefined) return undefined
    const certification = this.activeCertification(registration)
    const valid = lease.runtimeGeneration === this.generation
      && lease.moduleGeneration === registration.generation.moduleGeneration
      && (lease.authorizationOrigin !== 'certified-implicit' || (
        certification !== undefined
        && lease.certificationFingerprint === certification.fingerprint
        && lease.certificationRevision === certification.revision
      ))
    if (valid) return lease
    this.domLeases.delete(leaseKey)
    return undefined
  }

  domPolicy(identity: CordisXPluginIdentity, pointId: string): 'inherit' | 'allow' | 'deny' {
    const key = domPermissionAuthorizationKeyV3({
      profileId: this.profileId,
      identity: { source: identity.source, pluginId: identity.id },
      pointId,
      catalogVersion: this.catalog.version,
    })
    const record = this.policyRecords.get(this.domLeaseKey(key))
    if (record === undefined || !isPermissionPolicyRecordV3(record)) return 'inherit'
    return record.policy === 'allow-persistent' ? 'allow' : record.policy === 'deny-persistent' ? 'deny' : 'inherit'
  }

  hasDomPolicy(identity: CordisXPluginIdentity, pointId: string): boolean {
    const key = domPermissionAuthorizationKeyV3({
      profileId: this.profileId,
      identity: { source: identity.source, pluginId: identity.id },
      pointId,
      catalogVersion: this.catalog.version,
    })
    return isPermissionPolicyRecordV3(this.policyRecords.get(this.domLeaseKey(key)))
  }

  domPolicies(): readonly DomPermissionPolicyEntry[] {
    return Object.freeze(
      [...this.policyRecords.values()].flatMap(record => {
        if (!isPermissionPolicyRecordV3(record) || record.key.profileId !== this.profileId) return []
        const pointId = record.key.scope.extensionPoints?.[0]
        if (pointId === undefined || record.key.scope.extensionPoints?.length !== 1) return []
        return [Object.freeze({
          identity: Object.freeze({ source: record.key.identity.source, id: record.key.identity.pluginId }),
          pointId,
          policy: record.policy === 'allow-persistent'
            ? 'allow' as const
            : record.policy === 'deny-persistent'
            ? 'deny' as const
            : 'inherit' as const,
        })]
      }).sort((left, right) =>
        `${left.identity.source}\u0000${left.identity.id}\u0000${left.pointId}`.localeCompare(
          `${right.identity.source}\u0000${right.identity.id}\u0000${right.pointId}`,
        )
      ),
    )
  }

  domAccess(
    identity: CordisXPluginIdentity,
    pointId: string,
    view?: PluginGenerationView,
  ): DomPermissionAccessDecision {
    const registration = this.registration(identity, view)
    const policy = this.domPolicy(identity, pointId)
    if (registration === undefined) {
      return Object.freeze({ authorized: false, state: 'denied', reason: 'permission.identity-unavailable', policy })
    }
    const pointKey = this.domPointKey(identity, pointId, registration.generation.moduleGeneration)
    this.domPoints.set(
      pointKey,
      Object.freeze({
        identity: registration.identity,
        pointId,
        ...(registration.generation.moduleGeneration === undefined
          ? {}
          : { moduleGeneration: registration.generation.moduleGeneration }),
      }),
    )
    const lease = this.validDomLease(registration, pointId)
    if (lease !== undefined) {
      return Object.freeze({
        authorized: true,
        state: 'allowed',
        reason: lease.authorizationOrigin === 'certified-implicit'
          ? 'permission.certified-implicit'
          : 'permission.explicit-user',
        policy,
        authorizationOrigin: lease.authorizationOrigin,
      })
    }
    const request = this.domRequests.get(pointKey)
    if (request !== undefined) {
      return Object.freeze({ authorized: false, state: 'pending', reason: 'permission.review-pending', policy })
    }
    if (policy === 'deny') {
      return Object.freeze({ authorized: false, state: 'denied', reason: 'permission.denied-persistent', policy })
    }
    if (policy === 'allow' || this.activeCertification(registration) !== undefined) {
      const operationId = `dom:auto:${
        sha256Hex([
          this.generation,
          registration.generation.moduleGeneration ?? 'host',
          identity.source,
          identity.id,
          pointId,
        ].join('\u0000')).slice(0, 48)
      }`
      const plan = this.domPlan(registration, pointId, operationId)
      const item = plan.declarations[0]!
      if (item.authorizationMode === 'certified-implicit') {
        return this.grantDomAccess(registration, pointId, plan, item, 'certified-implicit', true)
      }
      if (item.authorizationMode === 'persistent-policy' && item.policy === 'allow-persistent') {
        return this.grantDomAccess(registration, pointId, plan, item, 'explicit-user', true)
      }
    }
    this.pendingDomReviews.set(
      this.domPendingReviewKey(identity, registration.generation.moduleGeneration),
      Object.freeze({
        identity: registration.identity,
        pointId,
        ...(registration.generation.moduleGeneration === undefined ? {} : {
          moduleGeneration: registration.generation.moduleGeneration,
        }),
        ...(view === undefined ? {} : { view }),
      }),
    )
    return Object.freeze({ authorized: false, state: 'pending', reason: 'permission.review-pending', policy })
  }

  requestDomAccess(
    identity: CordisXPluginIdentity,
    pointId: string,
    view?: PluginGenerationView,
  ): Promise<DomPermissionAccessDecision> {
    const registration = this.registration(identity, view)
    if (registration === undefined) {
      return Promise.resolve(Object.freeze({
        authorized: false,
        state: 'denied',
        reason: 'permission.identity-unavailable',
        policy: this.domPolicy(identity, pointId),
      }))
    }
    const pointKey = this.domPointKey(identity, pointId, registration.generation.moduleGeneration)
    const pendingKey = this.domPendingReviewKey(identity, registration.generation.moduleGeneration)
    if (this.pendingDomReviews.get(pendingKey)?.pointId === pointId) this.pendingDomReviews.delete(pendingKey)
    this.domPoints.set(
      pointKey,
      Object.freeze({
        identity: registration.identity,
        pointId,
        ...(registration.generation.moduleGeneration === undefined
          ? {}
          : { moduleGeneration: registration.generation.moduleGeneration }),
      }),
    )
    const existing = this.domRequests.get(pointKey)
    if (existing !== undefined) return existing
    const task = this.resolveDomAccess(registration, pointId).finally(() => {
      if (this.domRequests.get(pointKey) === task) this.domRequests.delete(pointKey)
      this.changed()
    })
    this.domRequests.set(pointKey, task)
    this.changed()
    return task
  }

  /** Starts or waits for only the exact plugin scope touched by an explicit Host interaction. */
  async reviewPendingDomAccess(
    identity: CordisXPluginIdentity,
    moduleGeneration?: string,
    view?: PluginGenerationView,
  ): Promise<readonly DomPermissionAccessDecision[]> {
    const registration = this.registration(identity, view)
    if (registration === undefined || registration.generation.moduleGeneration !== moduleGeneration) {
      return Object.freeze([])
    }
    const prefix = this.domGenerationPrefix(identity, moduleGeneration)
    const requests = [...this.domRequests.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, request]) => request)
    if (requests.length > 0) return Object.freeze(await Promise.all(requests))
    const key = this.domPendingReviewKey(identity, moduleGeneration)
    const pending = this.pendingDomReviews.get(key)
    if (pending === undefined) return Object.freeze([])
    this.pendingDomReviews.delete(key)
    return Object.freeze([await this.requestDomAccess(pending.identity, pending.pointId, pending.view)])
  }

  protected async resolveDomAccess(registration: Registration, pointId: string): Promise<DomPermissionAccessDecision> {
    const identity = registration.identity
    const operationId = `dom:${
      sha256Hex(JSON.stringify([
        this.generation,
        registration.generation.moduleGeneration ?? 'host',
        identity.source,
        identity.id,
        pointId,
      ]))
    }`
    const plan = this.domPlan(registration, pointId, operationId)
    const item = plan.declarations[0]!
    const key: CordisXPermissionAuthorizationKeyV3 = Object.freeze({
      profileId: plan.profileId,
      identity: plan.identity,
      capability: item.capability,
      scope: item.scope,
      securityFingerprint: item.securityFingerprint,
    })
    if (item.authorizationMode === 'persistent-policy' && item.policy === 'deny-persistent') {
      this.recordDomAudit(registration, pointId, false, 'explicit-user', 'Persistent user denial')
      return Object.freeze({
        authorized: false,
        state: 'denied',
        reason: 'permission.denied-persistent',
        policy: 'deny',
      })
    }
    let origin: 'explicit-user' | 'certified-implicit'
    if (item.authorizationMode === 'certified-implicit') {
      origin = 'certified-implicit'
    } else if (item.authorizationMode === 'persistent-policy') {
      origin = 'explicit-user'
    } else {
      let decision: CordisXPermissionAuthorizationDecisionV3 | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      const promptKey = this.domPointKey(identity, pointId, registration.generation.moduleGeneration)
      this.domPromptPlans.set(promptKey, plan)
      try {
        decision = await Promise.race([
          this.promptV2?.requestV3?.(plan, identity) ?? Promise.resolve(undefined),
          new Promise<undefined>(resolve => {
            timer = setTimeout(() => resolve(undefined), this.promptTimeoutMs)
          }),
        ])
      } catch {
        decision = undefined
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        if (this.domPromptPlans.get(promptKey) === plan) this.domPromptPlans.delete(promptKey)
        this.promptV2?.cancelV3?.(plan.planId, plan.binding)
      }
      if (!this.isRegistered(registration)) {
        return Object.freeze({
          authorized: false,
          state: 'denied',
          reason: 'permission.generation-invalidated',
          policy: 'inherit',
        })
      }
      if (decision === undefined) {
        this.recordDomAudit(registration, pointId, false, 'explicit-user', 'Explicit review cancelled or timed out')
        return Object.freeze({
          authorized: false,
          state: 'denied',
          reason: 'permission.review-cancelled',
          policy: 'inherit',
        })
      }
      const selected = await this.commitDomDecision(plan, decision)
      if (!this.isRegistered(registration)) {
        return Object.freeze({
          authorized: false,
          state: 'denied',
          reason: 'permission.generation-invalidated',
          policy: 'inherit',
        })
      }
      if (selected === 'deny-once' || selected === 'deny-persistent') {
        this.recordDomAudit(registration, pointId, false, 'explicit-user', 'Explicit user denial')
        return Object.freeze({
          authorized: false,
          state: 'denied',
          reason: 'permission.denied-explicit',
          policy: selected === 'deny-persistent' ? 'deny' : 'inherit',
        })
      }
      if (selected === 'allow-once') {
        this.onceV2.issue(key, plan.binding)
        if (!this.onceV2.consume(key, plan.binding)) {
          this.recordDomAudit(
            registration,
            pointId,
            false,
            'explicit-user',
            'Exact one-time grant could not be consumed',
          )
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
    const granted = this.grantDomAccess(registration, pointId, plan, item, origin)
    return this.isRegistered(registration)
      ? granted
      : Object.freeze({
        authorized: false,
        state: 'denied',
        reason: 'permission.generation-invalidated',
        policy: 'inherit',
      })
  }

  protected grantDomAccess(
    registration: Registration,
    pointId: string,
    plan: CordisXPermissionAuthorizationPlanV3,
    item: CordisXPermissionAuthorizationPlanV3['declarations'][number],
    origin: 'explicit-user' | 'certified-implicit',
    deferAuditNotification = false,
  ): DomPermissionAccessDecision {
    const key: CordisXPermissionAuthorizationKeyV3 = Object.freeze({
      profileId: plan.profileId,
      identity: plan.identity,
      capability: item.capability,
      scope: item.scope,
      securityFingerprint: item.securityFingerprint,
    })
    const certification = origin === 'certified-implicit' ? item.certification : undefined
    this.domLeases.set(
      this.domLeaseKey(key),
      Object.freeze({
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
      }),
    )
    this.recordDomAudit(
      registration,
      pointId,
      true,
      origin,
      origin === 'certified-implicit'
        ? 'Exact Certified artifact auto-approved by the Host catalog'
        : 'Explicit user approval',
      certification,
      deferAuditNotification,
    )
    return Object.freeze({
      authorized: true,
      state: 'allowed',
      reason: origin === 'certified-implicit' ? 'permission.certified-implicit' : 'permission.explicit-user',
      policy: item.policy === 'allow-persistent' ? 'allow' : 'inherit',
      authorizationOrigin: origin,
    })
  }

  protected async commitDomDecision(
    plan: CordisXPermissionAuthorizationPlanV3,
    decision: CordisXPermissionAuthorizationDecisionV3,
  ): Promise<CordisXPermissionDecisionV2> {
    if (
      decision.$schema !== CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V3
      || decision.schemaVersion !== 3 || decision.origin !== 'explicit-user'
      || decision.planId !== plan.planId || decision.operation !== plan.operation
      || decision.profileId !== plan.profileId || JSON.stringify(decision.identity) !== JSON.stringify(plan.identity)
      || JSON.stringify(decision.binding) !== JSON.stringify(plan.binding)
      || decision.decisions.length !== 1
    ) throw new Error('DOM permission decision does not match the Host plan')
    const item = plan.declarations[0]!
    const selected = decision.decisions[0]!
    if (
      selected.capability !== item.capability
      || JSON.stringify(selected.scope) !== JSON.stringify(item.scope)
      || selected.securityFingerprint !== item.securityFingerprint
      || !item.allowedDecisions.includes(selected.decision)
    ) throw new Error('DOM permission decision is invalid')
    if (selected.decision === 'allow-persistent' || selected.decision === 'deny-persistent') {
      const record = normalizePermissionPolicyRecordV3({
        $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V3,
        schemaVersion: 3,
        key: {
          profileId: plan.profileId,
          identity: plan.identity,
          capability: item.capability,
          scope: item.scope,
          securityFingerprint: item.securityFingerprint,
        },
        policy: selected.decision,
      })
      const key = permissionRecordKeyV3(record)
      await this.commitDomPolicyRecords([record], () => {
        this.policyRecords.set(key, record)
      })
    }
    return selected.decision
  }

  protected recordDomAudit(
    registration: Registration,
    pointId: string,
    allowed: boolean,
    authorizationOrigin: 'explicit-user' | 'certified-implicit',
    authorizationReason: string,
    certification?: CordisXCertifiedPermissionProjectionV1,
    deferNotification = false,
  ): void {
    const key = this.domAuditKey(
      platformIdentityKey(registration.identity),
      pointId,
      registration.generation.moduleGeneration,
    )
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
    const notify = (): void => {
      this.consoleObserver?.permission(
        registration.identity,
        'ui.extension-points.render',
        allowed ? 'allow' : 'deny',
        `${pointId}: ${authorizationReason}`,
      )
      this.changed()
    }
    if (deferNotification) queueMicrotask(notify)
    else notify()
  }

  protected clearDomGeneration(moduleGeneration?: string, identity?: CordisXPluginIdentity): void {
    this.clearDomLeases(moduleGeneration, identity)
    const identityKey = identity === undefined ? undefined : platformIdentityKey(identity)
    for (const [key, plan] of this.domPromptPlans) {
      if (
        (moduleGeneration === undefined || plan.binding.moduleGeneration === moduleGeneration)
        && (identity === undefined || (
          plan.identity.source === identity.source && plan.identity.pluginId === identity.id
        ))
      ) {
        this.domPromptPlans.delete(key)
        this.promptV2?.cancelV3?.(plan.planId, plan.binding)
      }
    }
    for (const [key, point] of this.domPoints) {
      if (
        (moduleGeneration === undefined || point.moduleGeneration === moduleGeneration)
        && (identityKey === undefined || platformIdentityKey(point.identity) === identityKey)
      ) this.domPoints.delete(key)
    }
    for (const [key, pending] of this.pendingDomReviews) {
      if (
        (moduleGeneration === undefined || pending.moduleGeneration === moduleGeneration)
        && (identityKey === undefined || platformIdentityKey(pending.identity) === identityKey)
      ) this.pendingDomReviews.delete(key)
    }
    const requestPrefix = identity === undefined ? undefined : this.domGenerationPrefix(identity, moduleGeneration)
    for (const key of [...this.domRequests.keys()]) {
      if (
        requestPrefix !== undefined
          ? key.startsWith(requestPrefix)
          : moduleGeneration === undefined || key.includes(`\u0000${moduleGeneration}\u0000`)
      ) this.domRequests.delete(key)
    }
    if (identityKey !== undefined) {
      const auditPrefix = moduleGeneration === undefined
        ? `${identityKey}\u0000ui.extension-points.render\u0000`
        : this.domAuditPrefix(identityKey, moduleGeneration)
      for (const key of [...this.audit.keys()]) if (key.startsWith(auditPrefix)) this.audit.delete(key)
    }
  }

  protected clearDomLeases(moduleGeneration?: string, identity?: CordisXPluginIdentity): void {
    for (const [key, lease] of this.domLeases) {
      if (
        lease.runtimeGeneration === this.generation
        && (moduleGeneration === undefined || lease.moduleGeneration === moduleGeneration)
        && (identity === undefined || (
          lease.key.identity.source === identity.source && lease.key.identity.pluginId === identity.id
        ))
      ) this.domLeases.delete(key)
    }
  }

  protected clearCertifiedDomLeases(registration: Registration): void {
    for (const [key, lease] of this.domLeases) {
      if (
        lease.runtimeGeneration !== this.generation
        || lease.moduleGeneration !== registration.generation.moduleGeneration
        || lease.authorizationOrigin !== 'certified-implicit'
        || lease.key.identity.source !== registration.identity.source
        || lease.key.identity.pluginId !== registration.identity.id
      ) continue
      this.domLeases.delete(key)
    }
  }

  protected clearExactDomLease(registration: Registration, pointId: string): void {
    for (const [key, lease] of this.domLeases) {
      if (
        lease.runtimeGeneration !== this.generation
        || lease.moduleGeneration !== registration.generation.moduleGeneration
        || lease.key.identity.source !== registration.identity.source
        || lease.key.identity.pluginId !== registration.identity.id
        || lease.key.scope.extensionPoints?.length !== 1
        || lease.key.scope.extensionPoints[0] !== pointId
      ) continue
      this.domLeases.delete(key)
    }
  }

  protected domAuditPrefix(identityKey: string, moduleGeneration?: string): string {
    return `${identityKey}\u0000ui.extension-points.render\u0000${moduleGeneration ?? 'host'}\u0000`
  }

  protected domAuditKey(identityKey: string, pointId: string, moduleGeneration?: string): string {
    return `${this.domAuditPrefix(identityKey, moduleGeneration)}${pointId}`
  }
}
