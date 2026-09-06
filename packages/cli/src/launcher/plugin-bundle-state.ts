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
import { PluginBundleCoordinatorInstall } from './plugin-bundle-install.js'
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

export class PluginBundleCoordinator extends PluginBundleCoordinatorInstall {
  async handle(request: CordisXPluginBundleLifecycleRequestV1): Promise<CordisXPluginBundleLifecycleResultV1> {
    await this.ready
    const [state, active] = await Promise.all([this.store.load(), this.options.pluginLifecycle.store.loadActive()])
    if (request.profileId !== this.options.profileId || request.runtimeGeneration !== this.options.runtimeGeneration) {
      return this.failure(
        request,
        state,
        active,
        'stale-generation',
        'The bundle runtime generation is stale.',
        'conflict',
      )
    }
    if (request.expectedRevision !== state.revision || request.expectedPluginRevision !== active.revision) {
      return this.failure(
        request,
        state,
        active,
        'stale-revision',
        'The bundle or plugin registry revision is stale.',
        'conflict',
      )
    }
    try {
      const operation = request.operation
      if (operation.kind === 'inspect-source') return await this.inspect({ ...request, operation }, state, active)
      if (operation.kind === 'install' || operation.kind === 'update') {
        return await this.install({ ...request, operation }, state, active)
      }
      if (operation.kind === 'set-permissions') {
        return await this.setPermissions({ ...request, operation }, state, active)
      }
      if (operation.kind === 'set-optional-member') {
        return await this.setOptionalMember({ ...request, operation }, state, active)
      }
      if (operation.kind === 'adopt-member') return await this.adoptMember({ ...request, operation }, state, active)
      if (operation.kind === 'enable' || operation.kind === 'disable' || operation.kind === 'uninstall') {
        return await this.changeBundleState({ ...request, operation }, state, active)
      }
      throw new Error('plugin bundle operation is unsupported')
    } catch (error) {
      return this.failure(
        request,
        await this.store.load(),
        await this.options.pluginLifecycle.store.loadActive(),
        'apply-failed',
        error instanceof Error ? error.message : String(error),
        'rejected',
      )
    }
  }
  protected async changeBundleState(
    request: CordisXPluginBundleLifecycleRequestV1 & {
      readonly operation: Extract<
        CordisXPluginBundleLifecycleRequestV1['operation'],
        { readonly kind: 'enable' | 'disable' | 'uninstall' }
      >
    },
    state: BundleState,
    active: CordisXPluginActivationRecordV1,
  ): Promise<CordisXPluginBundleLifecycleResultV1> {
    const bundle = state.bundles[request.operation.bundleId]
    if (bundle === undefined) {
      return this.failure(request, state, active, 'operation-unavailable', 'The bundle is not installed.', 'rejected')
    }
    if (request.operation.kind === 'enable') {
      const desired = bundle.members.filter(member =>
        member.required || (bundle.optionalEnabled[member.pluginId] ?? member.enabledByDefault)
      )
      const activeMap = activeById(active)
      const affected = desired.filter(member => activeMap.get(member.pluginId)?.enabled !== true).map(member =>
        member.pluginId
      )
      const retained = desired.filter(member => activeMap.get(member.pluginId)?.enabled === true).map(member =>
        member.pluginId
      )
      const token = `bundle-impact-${hash([state.revision, active.revision, bundle.id, 'enable', affected, retained])}`
      const plan: CordisXPluginBundlePlanV1 = {
        bundle: {
          id: bundle.id,
          name: bundle.name,
          version: bundle.version,
          digest: bundle.digest,
          authors: bundle.authors,
        },
        memberActions: desired.map(member => ({
          pluginId: member.pluginId,
          version: member.requestedVersion,
          action: affected.includes(member.pluginId) ? 'enable' : 'retain',
          reason: member.required ? 'bundle-required' : 'bundle-optional',
        })),
        permissionRequests: desired.flatMap(member =>
          member.permissions.map(permission => ({
            permissionId: permission.permissionId,
            pluginId: permission.pluginId,
            capability: permission.capability,
            scopeLabel: permission.scopeLabel,
            required: permission.required,
            defaultPolicy: 'ask' as const,
          }))
        ),
        conflicts: [],
      }
      if (request.operation.impactToken === '') {
        return {
          ...this.base(request, state, active),
          outcome: 'planned',
          bundleId: bundle.id,
          impactToken: token,
          affectedPluginIds: affected,
          retainedPluginIds: retained,
          removedPluginIds: [],
          plan,
        }
      }
      if (request.operation.impactToken !== token) {
        return this.failure(
          request,
          state,
          active,
          'impact-changed',
          'The bundle enable impact changed; review it again.',
          'conflict',
        )
      }
      if (
        desired.flatMap(member => member.permissions).some(permission =>
          permission.required && this.policyFor(bundle, state, permission) !== 'allow'
        )
      ) {
        return this.failure(
          request,
          state,
          active,
          'permission-review-required',
          'Required member permissions must be allowed before enabling the bundle.',
          'rejected',
        )
      }
      for (const member of pluginOrder(desired)) {
        const current = (await this.options.pluginLifecycle.store.loadActive()).plugins.find(plugin =>
          plugin.id === member.pluginId
        )
        if (current?.enabled === true) continue
        const result = await this.enablePlugin(
          await loadStagedPluginPackage(this.options.homeDir, member.digest),
          bundle,
          state,
        )
        if (result.outcome !== 'applied') {
          throw new Error(result.error?.message ?? `could not enable ${member.pluginId}`)
        }
      }
      const latest = await this.options.pluginLifecycle.store.loadActive()
      const now = this.now().toISOString()
      const next = await this.store.update(draft => {
        draft.bundles[bundle.id] = appendRecord(
          { ...bundle, enabled: true },
          now,
          'enable',
          `Enabled ${bundle.name}.`,
          affected,
        )
      })
      return {
        ...this.base(request, next, latest),
        outcome: 'applied',
        bundleId: bundle.id,
        affectedPluginIds: affected,
        retainedPluginIds: retained,
        removedPluginIds: [],
        plan,
      }
    }
    const impact = this.operationImpact(state, active, bundle, request.operation.kind)
    const plan: CordisXPluginBundlePlanV1 = {
      bundle: {
        id: bundle.id,
        name: bundle.name,
        version: bundle.version,
        digest: bundle.digest,
        authors: bundle.authors,
      },
      memberActions: bundle.members.map(member => ({
        pluginId: member.pluginId,
        version: member.requestedVersion,
        action: impact.retained.includes(member.pluginId)
          ? 'retain'
          : request.operation.kind === 'uninstall'
          ? 'remove'
          : request.operation.kind === 'disable'
          ? 'disable'
          : 'enable',
        reason: impact.retained.includes(member.pluginId)
          ? (state.directClaims[member.pluginId] ? 'direct-claim' : 'other-bundle-claim')
          : 'orphaned',
      })),
      permissionRequests: bundle.members.flatMap(member =>
        member.permissions.map(permission => ({
          permissionId: permission.permissionId,
          pluginId: permission.pluginId,
          capability: permission.capability,
          scopeLabel: permission.scopeLabel,
          required: permission.required,
          defaultPolicy: 'ask' as const,
        }))
      ),
      conflicts: [],
    }
    if (request.operation.impactToken === '') {
      return {
        ...this.base(request, state, active),
        outcome: 'planned',
        bundleId: bundle.id,
        impactToken: impact.token,
        affectedPluginIds: impact.affected,
        retainedPluginIds: impact.retained,
        removedPluginIds: request.operation.kind === 'uninstall' ? impact.affected : [],
        plan,
      }
    }
    if (request.operation.impactToken !== impact.token) {
      return this.failure(
        request,
        state,
        active,
        'impact-changed',
        'The bundle impact changed; review it again.',
        'conflict',
      )
    }
    const removed: string[] = []
    for (
      const pluginId of [...pluginOrder(bundle.members)].reverse().map(member => member.pluginId).filter(pluginId =>
        impact.affected.includes(pluginId)
      )
    ) {
      const current = await this.options.pluginLifecycle.store.loadActive()
      const plugin = current.plugins.find(item => item.id === pluginId)
      if (plugin === undefined) continue
      const kind = request.operation.kind === 'uninstall' ? 'uninstall' as const : 'disable' as const
      const preview = await this.options.pluginLifecycle.handleBundleOperation({
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-lifecycle-operation.v1.schema.json',
        schemaVersion: 1,
        requestId: `bundle-${kind}-plan-${randomUUID()}`,
        profileId: this.options.profileId,
        expectedRevision: current.revision,
        runtimeGeneration: this.options.runtimeGeneration,
        operation: { kind, pluginId, impactToken: '' },
      })
      if (preview.outcome !== 'planned' || preview.impactToken === undefined) {
        throw new Error(preview.error?.message ?? `could not plan ${kind} for ${pluginId}`)
      }
      const latest = await this.options.pluginLifecycle.store.loadActive()
      const applied = await this.options.pluginLifecycle.handleBundleOperation({
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-lifecycle-operation.v1.schema.json',
        schemaVersion: 1,
        requestId: `bundle-${kind}-${randomUUID()}`,
        profileId: this.options.profileId,
        expectedRevision: latest.revision,
        runtimeGeneration: this.options.runtimeGeneration,
        operation: { kind, pluginId, impactToken: preview.impactToken },
      })
      if (applied.outcome !== 'applied') throw new Error(applied.error?.message ?? `could not ${kind} ${pluginId}`)
      if (kind === 'uninstall') removed.push(pluginId)
    }
    const latest = await this.options.pluginLifecycle.store.loadActive()
    const now = this.now().toISOString()
    const floors = this.restrictiveFloorsForTransition(state, bundle, request.operation.kind)
    const next = await this.store.update(draft => {
      Object.assign(draft.permissionFloors, floors)
      if (request.operation.kind === 'uninstall') delete draft.bundles[bundle.id]
      else {draft.bundles[bundle.id] = appendRecord(
          { ...bundle, enabled: false },
          now,
          'disable',
          `Disabled ${bundle.name}.`,
          impact.affected,
        )}
    })
    return {
      ...this.base(request, next, latest),
      outcome: 'applied',
      bundleId: bundle.id,
      affectedPluginIds: impact.affected,
      retainedPluginIds: impact.retained,
      removedPluginIds: removed,
      plan,
    }
  }

  protected async setPermissions(
    request: CordisXPluginBundleLifecycleRequestV1 & {
      readonly operation: Extract<
        CordisXPluginBundleLifecycleRequestV1['operation'],
        { readonly kind: 'set-permissions' }
      >
    },
    state: BundleState,
    active: CordisXPluginActivationRecordV1,
  ): Promise<CordisXPluginBundleLifecycleResultV1> {
    const bundle = state.bundles[request.operation.bundleId]
    if (bundle === undefined) {
      return this.failure(request, state, active, 'operation-unavailable', 'The bundle is not installed.', 'rejected')
    }
    const permissionIds = new Set(
      bundle.members.flatMap(member => member.permissions.map(permission => permission.permissionId)),
    )
    const overrideKeys = request.operation.pluginOverrides.map(item => overrideKey(item.pluginId, item.permissionId))
    const clearKeys = request.operation.clearPluginOverrides.map(item => overrideKey(item.pluginId, item.permissionId))
    const validReference = (pluginId: string, permissionId: string) =>
      bundle.members.some(member =>
        member.pluginId === pluginId && member.permissions.some(permission => permission.permissionId === permissionId)
      )
    if (
      request.operation.bundlePermissions.length !== permissionIds.size
      || new Set(request.operation.bundlePermissions.map(item => item.permissionId)).size
        !== request.operation.bundlePermissions.length
      || request.operation.bundlePermissions.some(item =>
        !permissionIds.has(item.permissionId) || !bundlePolicy(item.policy)
      )
      || new Set(overrideKeys).size !== overrideKeys.length || new Set(clearKeys).size !== clearKeys.length
      || overrideKeys.some(key => clearKeys.includes(key))
      || request.operation.pluginOverrides.some(item =>
        !validReference(item.pluginId, item.permissionId) || !bundlePolicy(item.policy)
      )
      || request.operation.clearPluginOverrides.some(item => !validReference(item.pluginId, item.permissionId))
    ) {
      return this.failure(
        request,
        state,
        active,
        'permission-review-required',
        'A permission assignment is stale or outside this bundle.',
        'conflict',
      )
    }
    const token = `bundle-impact-${
      hash([
        state.revision,
        active.revision,
        bundle.id,
        request.operation.bundlePermissions,
        request.operation.pluginOverrides,
        request.operation.clearPluginOverrides,
      ])
    }`
    if (request.operation.impactToken === '') {
      return {
        ...this.base(request, state, active),
        outcome: 'planned',
        bundleId: bundle.id,
        impactToken: token,
        affectedPluginIds: bundle.members.map(member => member.pluginId),
        retainedPluginIds: [],
        removedPluginIds: [],
      }
    }
    if (request.operation.impactToken !== token) {
      return this.failure(
        request,
        state,
        active,
        'impact-changed',
        'The permission impact changed; review it again.',
        'conflict',
      )
    }
    const now = this.now().toISOString()
    const next = await this.store.update(draft => {
      draft.bundles[bundle.id] = appendRecord(
        {
          ...bundle,
          policies: Object.fromEntries(
            request.operation.bundlePermissions.map(item => [item.permissionId, item.policy]),
          ),
        },
        now,
        'set-permissions',
        `Updated permissions for ${bundle.name}.`,
        bundle.members.map(member => member.pluginId),
      )
      for (const item of request.operation.pluginOverrides) {
        draft.pluginOverrides[overrideKey(item.pluginId, item.permissionId)] = item.policy
      }
      for (const item of request.operation.clearPluginOverrides) {
        delete draft.pluginOverrides[overrideKey(item.pluginId, item.permissionId)]
      }
      for (const permissionId of permissionIds) {
        const member = bundle.members.find(item =>
          item.permissions.some(permission => permission.permissionId === permissionId)
        )!
        delete draft.permissionFloors[overrideKey(member.pluginId, permissionId)]
      }
    })
    return {
      ...this.base(request, next, active),
      outcome: 'applied',
      bundleId: bundle.id,
      affectedPluginIds: bundle.members.map(member => member.pluginId),
      retainedPluginIds: [],
      removedPluginIds: [],
    }
  }

  protected async setOptionalMember(
    request: CordisXPluginBundleLifecycleRequestV1 & {
      readonly operation: Extract<
        CordisXPluginBundleLifecycleRequestV1['operation'],
        { readonly kind: 'set-optional-member' }
      >
    },
    state: BundleState,
    active: CordisXPluginActivationRecordV1,
  ): Promise<CordisXPluginBundleLifecycleResultV1> {
    const bundle = state.bundles[request.operation.bundleId]
    const member = bundle?.members.find(item => item.pluginId === request.operation.pluginId)
    if (bundle === undefined || member === undefined || member.required) {
      return this.failure(
        request,
        state,
        active,
        'operation-unavailable',
        'The target is not an optional member.',
        'rejected',
      )
    }
    const token = `bundle-impact-${
      hash([state.revision, active.revision, bundle.id, member.pluginId, request.operation.enabled])
    }`
    if (request.operation.impactToken === '') {
      return {
        ...this.base(request, state, active),
        outcome: 'planned',
        bundleId: bundle.id,
        impactToken: token,
        affectedPluginIds: [member.pluginId],
        retainedPluginIds: [],
        removedPluginIds: [],
      }
    }
    if (request.operation.impactToken !== token) {
      return this.failure(request, state, active, 'impact-changed', 'The optional-member impact changed.', 'conflict')
    }
    const installed = active.plugins.find(plugin => plugin.id === member.pluginId)
    if (request.operation.enabled && installed?.enabled !== true) {
      if (
        member.permissions.some(permission =>
          permission.required && this.policyFor(bundle, state, permission) !== 'allow'
        )
      ) {
        return this.failure(
          request,
          state,
          active,
          'permission-review-required',
          'Required member permissions must be allowed before enabling this member.',
          'rejected',
        )
      }
      const result = await this.enablePlugin(
        await loadStagedPluginPackage(this.options.homeDir, member.digest),
        bundle,
        state,
      )
      if (result.outcome !== 'applied') throw new Error(result.error?.message ?? `could not enable ${member.pluginId}`)
    }
    if (!request.operation.enabled && installed?.enabled === true) {
      const retained = state.directClaims[member.pluginId]
        || Object.values(state.bundles).some(owner =>
          owner.id !== bundle.id && owner.enabled
          && owner.members.some(candidate =>
            candidate.pluginId === member.pluginId
            && (candidate.required || (owner.optionalEnabled[candidate.pluginId] ?? candidate.enabledByDefault))
          )
        )
        || active.plugins.some(plugin =>
          plugin.id !== member.pluginId && plugin.enabled
          && plugin.dependencies.some(dependency => dependency.id === member.pluginId)
        )
      if (!retained) {
        const preview = await this.options.pluginLifecycle.handleBundleOperation({
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-lifecycle-operation.v1.schema.json',
          schemaVersion: 1,
          requestId: `bundle-optional-disable-plan-${randomUUID()}`,
          profileId: this.options.profileId,
          expectedRevision: active.revision,
          runtimeGeneration: this.options.runtimeGeneration,
          operation: { kind: 'disable', pluginId: member.pluginId, impactToken: '' },
        })
        if (preview.outcome !== 'planned' || preview.impactToken === undefined) {
          throw new Error(preview.error?.message ?? `could not plan disable for ${member.pluginId}`)
        }
        const latest = await this.options.pluginLifecycle.store.loadActive()
        const result = await this.options.pluginLifecycle.handleBundleOperation({
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-lifecycle-operation.v1.schema.json',
          schemaVersion: 1,
          requestId: `bundle-optional-disable-${randomUUID()}`,
          profileId: this.options.profileId,
          expectedRevision: latest.revision,
          runtimeGeneration: this.options.runtimeGeneration,
          operation: { kind: 'disable', pluginId: member.pluginId, impactToken: preview.impactToken },
        })
        if (result.outcome !== 'applied') {
          throw new Error(result.error?.message ?? `could not disable ${member.pluginId}`)
        }
      }
    }
    const latest = await this.options.pluginLifecycle.store.loadActive()
    const now = this.now().toISOString()
    const next = await this.store.update(draft => {
      draft.bundles[bundle.id] = appendRecord(
        { ...bundle, optionalEnabled: { ...bundle.optionalEnabled, [member.pluginId]: request.operation.enabled } },
        now,
        'set-optional-member',
        `${request.operation.enabled ? 'Enabled' : 'Disabled'} optional member ${member.pluginId}.`,
        [member.pluginId],
      )
    })
    return {
      ...this.base(request, next, latest),
      outcome: 'applied',
      bundleId: bundle.id,
      affectedPluginIds: [member.pluginId],
      retainedPluginIds: [],
      removedPluginIds: [],
    }
  }

  protected async adoptMember(
    request: CordisXPluginBundleLifecycleRequestV1 & {
      readonly operation: Extract<CordisXPluginBundleLifecycleRequestV1['operation'], { readonly kind: 'adopt-member' }>
    },
    state: BundleState,
    active: CordisXPluginActivationRecordV1,
  ): Promise<CordisXPluginBundleLifecycleResultV1> {
    const bundle = state.bundles[request.operation.bundleId]
    if (
      bundle === undefined || !bundle.members.some(member => member.pluginId === request.operation.pluginId)
      || !active.plugins.some(plugin => plugin.id === request.operation.pluginId)
    ) {
      return this.failure(
        request,
        state,
        active,
        'operation-unavailable',
        'Only an installed bundle member can be adopted.',
        'rejected',
      )
    }
    const token = `bundle-impact-${
      hash([state.revision, active.revision, bundle.id, request.operation.pluginId, 'adopt'])
    }`
    if (request.operation.impactToken === '') {
      return {
        ...this.base(request, state, active),
        outcome: 'planned',
        bundleId: bundle.id,
        impactToken: token,
        affectedPluginIds: [request.operation.pluginId],
        retainedPluginIds: [request.operation.pluginId],
        removedPluginIds: [],
      }
    }
    if (request.operation.impactToken !== token) {
      return this.failure(request, state, active, 'impact-changed', 'The adoption impact changed.', 'conflict')
    }
    const now = this.now().toISOString()
    const next = await this.store.update(draft => {
      draft.directClaims[request.operation.pluginId] = true
      draft.bundles[bundle.id] = appendRecord(
        bundle,
        now,
        'adopt-member',
        `Adopted ${request.operation.pluginId} as a direct installation.`,
        [request.operation.pluginId],
      )
    })
    return {
      ...this.base(request, next, active),
      outcome: 'applied',
      bundleId: bundle.id,
      affectedPluginIds: [request.operation.pluginId],
      retainedPluginIds: [request.operation.pluginId],
      removedPluginIds: [],
    }
  }
}
