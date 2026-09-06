import { PlatformAuthorizationBroker } from './platform-authorization.js'
import type { CordisXPlatformCapability } from '../../contracts.js'
import {
  createPermissionPolicyRecord,
  normalizePermissionScope,
  permissionRecordKey,
  permissionScopeFingerprint,
} from '../../permissions.js'
import type { CordisXPermissionCapabilityV2, CordisXPermissionScopeV4 } from '../../permission-contracts.js'
import { migratePermissionPolicyV1, permissionRecordKeyV2 } from '../../permission-model-v2.js'
import { domPermissionAuthorizationKeyV3 } from '../../permission-model-v3.js'
import { isPermissionPolicyRecordV3, isPermissionPolicyRecordV4 } from '../../permission-persistence.js'

import { declarationFingerprint, object, platformIdentityKey } from './platform-manifest.js'
import { PlatformPermissionSnapshot, Registration } from './platform-permission-types.js'

export class PermissionBroker extends PlatformAuthorizationBroker {
  snapshots(): readonly PlatformPermissionSnapshot[] {
    const platform = [...this.registrations.values()]
      .filter(registration => this.visibility?.visible(registration.generation) ?? true)
      .flatMap<PlatformPermissionSnapshot>(registration => {
        const identityKey = platformIdentityKey(registration.identity)
        if (registration.manifest.schemaVersion === 1) {
          return [...registration.declarations.values()].map(declaration => {
            const audit = this.audit.get(this.auditKey(identityKey, declaration.name)) ?? { denialCount: 0 }
            return {
              identity: registration.identity,
              capability: declaration.name,
              required: declaration.required,
              reason: declaration.reason,
              scope: declaration.scope,
              fingerprint: declarationFingerprint(declaration),
              policy: this.policy(registration.identity, declaration.name),
              ...(audit.lastRequested === undefined ? {} : { lastRequested: audit.lastRequested }),
              ...(audit.lastUsedAt === undefined ? {} : { lastUsedAt: audit.lastUsedAt }),
              ...(audit.lastDeniedAt === undefined ? {} : { lastDeniedAt: audit.lastDeniedAt }),
              denialCount: audit.denialCount,
              ...(this.requiredDenied(registration.identity).includes(declaration.name)
                ? { blockedReason: `Required capability ${declaration.name} is denied` }
                : {}),
            }
          })
        }
        const operationId = `snapshot:${this.generation}:${
          registration.generation.moduleGeneration ?? 'host'
        }:${registration.identity.id}`
        const plan = this.planV2(registration, 'enable', this.binding(registration, operationId))
        const denied = new Set(this.requiredDenied(registration.identity))
        return plan.declarations.map(item => {
          const declaration = registration.declarationsV2.get(item.capability)!
          const audit = this.audit.get(this.auditKey(identityKey, item.capability as CordisXPlatformCapability))
            ?? { denialCount: 0 }
          return {
            identity: registration.identity,
            capability: item.capability,
            required: item.required,
            reason: declaration.rationale?.description ?? item.presentation.description,
            scope: item.scope,
            fingerprint: item.securityFingerprint,
            policy: item.policy === 'allow-persistent'
              ? 'allow' as const
              : item.policy === 'deny-persistent'
              ? 'deny' as const
              : 'ask' as const,
            ...(audit.lastRequested === undefined ? {} : { lastRequested: audit.lastRequested }),
            ...(audit.lastUsedAt === undefined ? {} : { lastUsedAt: audit.lastUsedAt }),
            ...(audit.lastDeniedAt === undefined ? {} : { lastDeniedAt: audit.lastDeniedAt }),
            denialCount: audit.denialCount,
            ...(denied.has(item.capability)
              ? { blockedReason: `Required capability ${item.capability} is not authorized` }
              : {}),
          }
        })
      })
    const dom = [...this.domPoints.values()].flatMap(point => {
      const registration = [...this.registrations.values()].find(item => (
        platformIdentityKey(item.identity) === platformIdentityKey(point.identity)
        && item.generation.moduleGeneration === point.moduleGeneration
        && (this.visibility?.visible(item.generation) ?? true)
      ))
      if (registration === undefined) return []
      const key = domPermissionAuthorizationKeyV3({
        profileId: this.profileId,
        identity: { source: point.identity.source, pluginId: point.identity.id },
        pointId: point.pointId,
        catalogVersion: this.catalog.version,
      })
      const record = this.policyRecords.get(this.domLeaseKey(key))
      const policy = record !== undefined && isPermissionPolicyRecordV3(record)
        ? record.policy === 'allow-persistent'
          ? 'allow' as const
          : record.policy === 'deny-persistent'
          ? 'deny' as const
          : 'ask' as const
        : 'ask' as const
      const audit = this.audit.get(this.domAuditKey(
        platformIdentityKey(point.identity),
        point.pointId,
        point.moduleGeneration,
      )) ?? { denialCount: 0 }
      return [Object.freeze({
        identity: point.identity,
        capability: 'ui.extension-points.render' as const,
        required: false,
        reason: Object.freeze({
          namespace: 'permission',
          ...this.catalog.get('ui.extension-points.render').presentation.description,
        }),
        scope: key.scope,
        fingerprint: key.securityFingerprint,
        policy,
        ...(audit.lastUsedAt === undefined ? {} : { lastUsedAt: audit.lastUsedAt }),
        ...(audit.lastDeniedAt === undefined ? {} : { lastDeniedAt: audit.lastDeniedAt }),
        denialCount: audit.denialCount,
        ...(audit.authorizationOrigin === undefined ? {} : { authorizationOrigin: audit.authorizationOrigin }),
        ...(audit.authorizationReason === undefined ? {} : { authorizationReason: audit.authorizationReason }),
        ...(audit.certification === undefined ? {} : { certification: audit.certification }),
      })]
    })
    const hostDom = [...this.registrations.values()].flatMap(registration => {
      if (this.visibility?.visible(registration.generation) === false) return []
      return [...registration.declarationsV4.values()].map(declaration => {
        const capability = declaration.name as 'ui.host-dom.read' | 'ui.host-dom.modify'
        const key = this.hostDomKey(registration, capability)
        const record = this.policyRecords.get(this.hostDomLeaseKey(key))
        const policy = isPermissionPolicyRecordV4(record)
          ? record.policy === 'allow-persistent'
            ? 'allow' as const
            : record.policy === 'deny-persistent'
            ? 'deny' as const
            : 'ask' as const
          : 'ask' as const
        const audit = this.audit.get(this.hostDomAuditKey(registration, capability)) ?? { denialCount: 0 }
        return Object.freeze({
          identity: registration.identity,
          capability,
          required: declaration.required,
          reason: declaration.rationale?.description ?? Object.freeze({
            namespace: 'permission',
            ...this.catalog.get(capability).presentation.description,
          }),
          scope: key.scope as CordisXPermissionScopeV4,
          fingerprint: key.securityFingerprint,
          policy,
          ...(audit.lastUsedAt === undefined ? {} : { lastUsedAt: audit.lastUsedAt }),
          ...(audit.lastDeniedAt === undefined ? {} : { lastDeniedAt: audit.lastDeniedAt }),
          denialCount: audit.denialCount,
          ...(audit.authorizationOrigin === undefined ? {} : { authorizationOrigin: audit.authorizationOrigin }),
          ...(audit.authorizationReason === undefined ? {} : { authorizationReason: audit.authorizationReason }),
          ...(audit.certification === undefined ? {} : { certification: audit.certification }),
          ...(declaration.required && policy === 'deny'
            ? { blockedReason: `Required capability ${capability} is denied` }
            : {}),
        })
      })
    })
    return Object.freeze([...platform, ...dom, ...hostDom])
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.clearAgentRuntimeConnection()
    this.registrations.clear()
    this.certifiedProjections.clear()
    this.certifiedProjectionRevision = -1
    this.certifiedProjectionDigest = ''
    this.certifiedProjectionAvailable = false
    this.audit.clear()
    this.onceV2.dispose()
    this.domLeases.clear()
    this.domRequests.clear()
    this.domPromptPlans.clear()
    this.domPoints.clear()
    this.hostDomLeases.clear()
    for (const pending of this.hostDomPromptPlans.values()) {
      pending.cancel()
      this.promptV2?.cancelV4?.(pending.plan.planId, pending.plan.binding)
    }
    this.hostDomPromptPlans.clear()
    this.hostDomPolicyRevisions.clear()
    this.agentRuntimeRoutes.clear()
    this.playgroundScenarioAgentRuntimeRoutes.clear()
    this.agentRuntimeLeases.clear()
    this.agentRuntimeFenceListeners.clear()
    this.pendingDomReviews.clear()
    for (const timer of this.domCertificationTimers.values()) clearTimeout(timer)
    this.domCertificationTimers.clear()
    this.promptV2?.dispose?.()
    this.listeners.clear()
  }

  protected migrateLegacy(registration: Registration): void {
    for (const legacy of this.store.legacy?.() ?? []) {
      if (legacy.identityKey !== platformIdentityKey(registration.identity)) continue
      const declaration = registration.declarations.get(legacy.capability)
      if (declaration === undefined) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(legacy.fingerprint) as unknown
      } catch {
        continue
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      const fingerprint = parsed as { name?: unknown; scope?: unknown }
      if (fingerprint.name !== declaration.name) continue
      let legacyFingerprint: string
      try {
        legacyFingerprint = permissionScopeFingerprint(declaration.name, normalizePermissionScope(fingerprint.scope))
      } catch {
        continue
      }
      if (legacyFingerprint !== declarationFingerprint(declaration)) continue
      if (registration.manifest.schemaVersion === 1) {
        const record = createPermissionPolicyRecord({
          profileId: this.profileId,
          identity: registration.identity,
          capability: declaration.name,
          scope: declaration.scope,
          policy: legacy.policy,
        })
        const key = permissionRecordKey(record)
        if (this.policyRecords.has(key)) continue
        this.policyRecords.set(key, record)
        const task = Promise.resolve(this.store.write([record])).then(async () => {
          await this.store.retireLegacy?.(legacy)
        }).catch(() => {
          if (this.policyRecords.get(key) === record) this.policyRecords.delete(key)
          this.changed()
        })
        this.migrationTasks.push(task)
        continue
      }
      const declarationV2 = registration.declarationsV2.get(declaration.name as CordisXPermissionCapabilityV2)
      if (declarationV2 === undefined) continue
      const plan = this.planV2(registration, 'runtime', {
        operationId: `legacy-migration:${registration.identity.id}:${declaration.name}`,
        runtimeGeneration: this.generation,
        ...(registration.generation.moduleGeneration === undefined ? {} : {
          moduleGeneration: registration.generation.moduleGeneration,
        }),
      }, [declarationV2])
      const item = plan.declarations[0]!
      const record = migratePermissionPolicyV1(legacy.policy, {
        key: this.authorizationKey(plan, item.capability),
        persistentAllow: item.persistentAllow,
        persistentDeny: item.persistentDeny,
      })
      const key = permissionRecordKeyV2(record)
      if (this.policyRecords.has(key)) continue
      this.policyRecords.set(key, record)
      const task = this.persistV2([record]).then(async () => {
        await this.store.retireLegacy?.(legacy)
      }).catch(() => {
        if (this.policyRecords.get(key) === record) this.policyRecords.delete(key)
        this.changed()
      })
      this.migrationTasks.push(task)
    }
  }
}
