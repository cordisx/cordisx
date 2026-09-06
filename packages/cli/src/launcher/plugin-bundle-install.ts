import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V1,
  type CordisXPermissionAuthorizationDecisionV1,
} from '../platform-contracts.js'
import {
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V4,
  type CordisXPermissionAuthorizationDecisionV2,
  type CordisXPermissionAuthorizationDecisionV4,
  type CordisXPermissionAuthorizationItemV4,
  type CordisXPermissionDecisionV2,
} from '../permission-contracts.js'
import {
  CORDISX_PLUGIN_BUNDLE_LIFECYCLE_RESULT_SCHEMA_V1,
  CORDISX_PLUGIN_BUNDLE_MANAGER_SNAPSHOT_SCHEMA_V1,
  CORDISX_PLUGIN_BUNDLE_SCHEMA_V1,
  type CordisXPluginBundleLifecycleRequestV1,
  type CordisXPluginBundleLifecycleResultV1,
  type CordisXPluginBundleManagerItemV1,
  type CordisXPluginBundleManagerPermissionV1,
  type CordisXPluginBundleManagerSnapshotV1,
  type CordisXPluginBundleManifestV1,
  type CordisXPluginBundlePlanV1,
  type CordisXPluginBundlePolicy,
} from '../plugin-bundle-contracts.js'
import type { CordisXPluginActivationRecordV1, CordisXPluginLifecycleResultV1 } from '../plugin-lifecycle-contracts.js'
import { loadStagedPluginPackage, type StagedPluginPackage } from './plugin-package.js'
import type { PluginLifecycleCoordinator } from './plugin-lifecycle.js'
import { PluginPackageSourceSnapshotter } from './packages/integrity.js'
import { resolvePluginPackageSourceV1 } from './packages/source.js'
import { PluginBundleCoordinatorCore } from './plugin-bundle-core.js'
import {
  activeById,
  appendRecord,
  type BundleCandidate,
  type BundleCandidateSource,
  bundlePolicy,
  type BundleRecord,
  type BundleState,
  contained,
  effectivePermission,
  hash,
  overrideKey,
  parseManifest,
  permissions,
  type PluginBundleCoordinatorOptions,
  pluginBundlePermissionId,
  PluginBundleStore,
  pluginOrder,
  policyRank,
  projectBundle,
  sourceLabel,
  type StoredMember,
  type StoredPermission,
} from './plugin-bundle-model.js'

export class PluginBundleCoordinatorInstall extends PluginBundleCoordinatorCore {
  protected async install(
    request: CordisXPluginBundleLifecycleRequestV1 & {
      readonly operation: Extract<
        CordisXPluginBundleLifecycleRequestV1['operation'],
        { readonly kind: 'install' | 'update' }
      >
    },
    state: BundleState,
    active: CordisXPluginActivationRecordV1,
  ): Promise<CordisXPluginBundleLifecycleResultV1> {
    const candidate = state.candidates[request.operation.candidateId]
    if (
      candidate === undefined || candidate.impactToken !== request.operation.impactToken
      || candidate.baseRevision !== state.revision - 1 || candidate.basePluginRevision !== active.revision
    ) {
      return this.failure(request, state, active, 'impact-changed', 'The bundle install plan is stale.', 'conflict')
    }
    const existingBundle = state.bundles[candidate.record.id]
    const expectedOperation = existingBundle === undefined ? 'install' : 'update'
    if (request.operation.kind !== expectedOperation) {
      return this.failure(
        request,
        state,
        active,
        'operation-unavailable',
        `This candidate requires ${expectedOperation}.`,
        'rejected',
      )
    }
    if (candidate.plan.conflicts.length > 0) {
      return this.failure(
        request,
        state,
        active,
        'version-conflict',
        'The bundle has unresolved member conflicts.',
        'conflict',
      )
    }
    const candidatePermissions = new Map(
      candidate.record.members.flatMap(member => member.permissions).map(
        permission => [permission.permissionId, permission],
      ),
    )
    const bundlePermissionIds = request.operation.bundlePermissions.map(item => item.permissionId)
    const overrideKeys = request.operation.pluginOverrides.map(item => overrideKey(item.pluginId, item.permissionId))
    if (
      new Set(bundlePermissionIds).size !== bundlePermissionIds.length
      || new Set(overrideKeys).size !== overrideKeys.length
      || request.operation.bundlePermissions.some(item =>
        !candidatePermissions.has(item.permissionId) || !bundlePolicy(item.policy)
      )
      || request.operation.pluginOverrides.some(item =>
        candidatePermissions.get(item.permissionId)?.pluginId !== item.pluginId || !bundlePolicy(item.policy)
      )
    ) {
      return this.failure(
        request,
        state,
        active,
        'permission-review-required',
        'A bundle permission choice is invalid, duplicated, or stale.',
        'rejected',
      )
    }
    const policies = Object.fromEntries(
      request.operation.bundlePermissions.map(item => [item.permissionId, item.policy]),
    )
    const overrides = Object.fromEntries(
      request.operation.pluginOverrides.map(item => [overrideKey(item.pluginId, item.permissionId), item.policy]),
    )
    const record: BundleRecord = { ...candidate.record, policies }
    const previewState: BundleState = { ...state, pluginOverrides: { ...state.pluginOverrides, ...overrides } }
    const unresolved = record.members.flatMap(member => member.permissions).filter(permission =>
      permission.required && this.policyFor(record, previewState, permission) !== 'allow'
    )
    if (unresolved.length > 0) {
      return this.failure(
        request,
        state,
        active,
        'permission-review-required',
        'Every required member permission must be explicitly allowed before installation.',
        'rejected',
      )
    }
    const applied: { readonly pluginId: string; readonly previousDigest?: `sha256:${string}` }[] = []
    const removedMembers: StoredMember[] = []
    const activeAtStart = activeById(active)
    try {
      for (const member of pluginOrder(record.members)) {
        if (!member.required && !(record.optionalEnabled[member.pluginId] ?? member.enabledByDefault)) continue
        const current = (await this.options.pluginLifecycle.store.loadActive()).plugins.find(plugin =>
          plugin.id === member.pluginId
        )
        if (current?.digest === member.digest) continue
        const staged = await loadStagedPluginPackage(this.options.homeDir, member.digest)
        const result = await this.applyStaged(staged, record, previewState)
        if (result.outcome !== 'applied') throw new Error(result.error?.message ?? `failed to apply ${member.pluginId}`)
        applied.push({
          pluginId: member.pluginId,
          ...(activeAtStart.get(member.pluginId) === undefined
            ? {}
            : { previousDigest: activeAtStart.get(member.pluginId)!.digest }),
        })
      }
      const removals = new Set(
        candidate.plan.memberActions.filter(action => action.action === 'remove').map(action => action.pluginId),
      )
      for (
        const member of [...pluginOrder(existingBundle?.members ?? [])].reverse().filter(item =>
          removals.has(item.pluginId)
        )
      ) {
        const result = await this.removeInstalledPlugin(member.pluginId)
        if (result.outcome !== 'applied') {
          throw new Error(result.error?.message ?? `failed to remove ${member.pluginId}`)
        }
        removedMembers.push(member)
      }
    } catch (error) {
      let rollbackFailed = !(await this.rollbackApplied(applied, existingBundle ?? record, state))
      try {
        for (const member of pluginOrder(removedMembers)) {
          const result = await this.applyStaged(
            await loadStagedPluginPackage(this.options.homeDir, member.digest),
            existingBundle ?? record,
            state,
          )
          if (result.outcome !== 'applied') rollbackFailed = true
        }
      } catch {
        rollbackFailed = true
      }
      const latest = await this.options.pluginLifecycle.store.loadActive()
      return this.failure(
        request,
        state,
        latest,
        rollbackFailed ? 'rollback-failed' : 'apply-failed',
        error instanceof Error ? error.message : String(error),
        rollbackFailed ? 'rollback-failed' : 'rolled-back',
      )
    }
    const latestActive = await this.options.pluginLifecycle.store.loadActive()
    const now = this.now().toISOString()
    const next = await this.store.update(draft => {
      for (const action of candidate.plan.memberActions) {
        if (
          action.action === 'share'
          && !Object.values(draft.bundles).some(bundle =>
            bundle.members.some(member => member.pluginId === action.pluginId)
          )
        ) draft.directClaims[action.pluginId] = true
      }
      Object.assign(draft.pluginOverrides, overrides)
      draft.bundles[record.id] = {
        ...record,
        records: [...record.records, {
          recordId: `bundle-record-${randomUUID()}`,
          at: now,
          kind: request.operation.kind,
          outcome: 'applied',
          message: `Applied ${record.name}.`,
          pluginIds: record.members.map(member => member.pluginId),
        }],
      }
      delete draft.candidates[candidate.candidateId]
    })
    return {
      ...this.base(request, next, latestActive),
      outcome: 'applied',
      bundleId: record.id,
      affectedPluginIds: candidate.plan.memberActions.filter(action => !['share', 'retain'].includes(action.action))
        .map(action => action.pluginId),
      retainedPluginIds: candidate.plan.memberActions.filter(action =>
        action.action === 'share' || action.action === 'retain'
      ).map(action => action.pluginId),
      removedPluginIds: removedMembers.map(member => member.pluginId),
      plan: candidate.plan,
    }
  }

  protected async removeInstalledPlugin(pluginId: string): Promise<CordisXPluginLifecycleResultV1> {
    const active = await this.options.pluginLifecycle.store.loadActive()
    const preview = await this.options.pluginLifecycle.handleBundleOperation({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-lifecycle-operation.v1.schema.json',
      schemaVersion: 1,
      requestId: `bundle-uninstall-plan-${randomUUID()}`,
      profileId: this.options.profileId,
      expectedRevision: active.revision,
      runtimeGeneration: this.options.runtimeGeneration,
      operation: { kind: 'uninstall', pluginId, impactToken: '' },
    })
    if (preview.outcome !== 'planned' || preview.impactToken === undefined) return preview
    const latest = await this.options.pluginLifecycle.store.loadActive()
    return await this.options.pluginLifecycle.handleBundleOperation({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-lifecycle-operation.v1.schema.json',
      schemaVersion: 1,
      requestId: `bundle-uninstall-${randomUUID()}`,
      profileId: this.options.profileId,
      expectedRevision: latest.revision,
      runtimeGeneration: this.options.runtimeGeneration,
      operation: { kind: 'uninstall', pluginId, impactToken: preview.impactToken },
    })
  }

  protected async rollbackApplied(
    applied: readonly { readonly pluginId: string; readonly previousDigest?: `sha256:${string}` }[],
    record: BundleRecord,
    state: BundleState,
  ): Promise<boolean> {
    try {
      for (const item of [...applied].reverse()) {
        if (item.previousDigest !== undefined) {
          await this.applyStaged(
            await loadStagedPluginPackage(this.options.homeDir, item.previousDigest),
            record,
            state,
          )
          continue
        }
        const active = await this.options.pluginLifecycle.store.loadActive()
        const preview = await this.options.pluginLifecycle.handleBundleOperation({
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-lifecycle-operation.v1.schema.json',
          schemaVersion: 1,
          requestId: `bundle-rollback-plan-${randomUUID()}`,
          profileId: this.options.profileId,
          expectedRevision: active.revision,
          runtimeGeneration: this.options.runtimeGeneration,
          operation: { kind: 'uninstall', pluginId: item.pluginId, impactToken: '' },
        })
        if (preview.outcome !== 'planned' || preview.impactToken === undefined) return false
        const current = await this.options.pluginLifecycle.store.loadActive()
        const removed = await this.options.pluginLifecycle.handleBundleOperation({
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-lifecycle-operation.v1.schema.json',
          schemaVersion: 1,
          requestId: `bundle-rollback-${randomUUID()}`,
          profileId: this.options.profileId,
          expectedRevision: current.revision,
          runtimeGeneration: this.options.runtimeGeneration,
          operation: { kind: 'uninstall', pluginId: item.pluginId, impactToken: preview.impactToken },
        })
        if (removed.outcome !== 'applied') return false
      }
      return true
    } catch {
      return false
    }
  }

  protected operationImpact(
    state: BundleState,
    active: CordisXPluginActivationRecordV1,
    bundle: BundleRecord,
    operation: string,
  ) {
    const otherBundles = Object.values(state.bundles).filter(candidate => candidate.id !== bundle.id)
    const retained: string[] = []
    const affected: string[] = []
    for (const member of bundle.members) {
      const otherBundleClaim = otherBundles.some(candidate =>
        candidate.members.some(item => item.pluginId === member.pluginId)
      )
      const otherActiveIntent = otherBundles.some(candidate =>
        candidate.enabled && candidate.members.some(item =>
          item.pluginId === member.pluginId
          && (item.required || (candidate.optionalEnabled[item.pluginId] ?? item.enabledByDefault))
        )
      )
      const runtimeDependency = active.plugins.some(plugin =>
        plugin.id !== member.pluginId
        && (operation !== 'disable' || plugin.enabled)
        && plugin.dependencies.some(dependency => dependency.id === member.pluginId)
      )
      const shared = state.directClaims[member.pluginId]
        || (operation === 'disable' ? otherActiveIntent : otherBundleClaim)
        || runtimeDependency
      ;(shared ? retained : affected).push(member.pluginId)
    }
    return {
      retained,
      affected,
      token: `bundle-impact-${hash([state.revision, active.revision, bundle.id, operation, retained, affected])}`,
    }
  }

  protected restrictiveFloorsForTransition(
    state: BundleState,
    bundle: BundleRecord,
    operation: 'disable' | 'uninstall',
  ): Readonly<Record<string, CordisXPluginBundlePolicy>> {
    const bundles = { ...state.bundles }
    if (operation === 'uninstall') delete bundles[bundle.id]
    else bundles[bundle.id] = { ...bundle, enabled: false }
    const afterState: BundleState = { ...state, bundles }
    const floors: Record<string, CordisXPluginBundlePolicy> = {}
    for (const member of bundle.members) {
      for (const permission of member.permissions) {
        const key = overrideKey(member.pluginId, permission.permissionId)
        if (state.pluginOverrides[key] !== undefined) continue
        const before = effectivePermission(state, member, permission).effectivePolicy
        const after = effectivePermission(afterState, member, permission).effectivePolicy
        if (policyRank[before] > policyRank[after]) floors[key] = before
      }
    }
    return floors
  }
}
