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
import {
  activeById,
  appendRecord,
  type BundleCandidate,
  type BundleCandidateSource,
  bundlePolicy,
  type BundleRecord,
  type BundleState,
  claims,
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
  SAFE_DIR,
  SAFE_ICON,
  SAFE_README,
  sourceLabel,
  type StoredMember,
  type StoredPermission,
} from './plugin-bundle-model.js'

export class PluginBundleCoordinatorCore {
  protected readonly store: PluginBundleStore
  protected readonly ready: Promise<void>
  protected readonly now: () => Date

  constructor(readonly options: PluginBundleCoordinatorOptions) {
    this.store = new PluginBundleStore(
      path.join(options.homeDir, 'state', 'profiles', options.profileId, 'plugin-bundles'),
      options.profileId,
    )
    this.ready = this.store.open()
    this.now = options.now ?? (() => new Date())
  }

  async snapshot(operationsAvailable = true): Promise<CordisXPluginBundleManagerSnapshotV1> {
    await this.ready
    const [state, active] = await Promise.all([this.store.load(), this.options.pluginLifecycle.store.loadActive()])
    return {
      $schema: CORDISX_PLUGIN_BUNDLE_MANAGER_SNAPSHOT_SCHEMA_V1,
      schemaVersion: 1,
      profileId: this.options.profileId,
      revision: state.revision,
      pluginRevision: active.revision,
      runtimeGeneration: this.options.runtimeGeneration,
      operationsAvailable,
      bundles: Object.values(state.bundles).sort((left, right) => left.name.localeCompare(right.name)).map(bundle =>
        projectBundle(state, bundle, active)
      ),
    }
  }

  async bundleClaims(pluginId: string): Promise<readonly string[]> {
    await this.ready
    const state = await this.store.load()
    return Object.values(state.bundles).filter(bundle => bundle.members.some(member => member.pluginId === pluginId))
      .map(bundle => bundle.id).sort()
  }

  protected base(
    request: CordisXPluginBundleLifecycleRequestV1,
    state: BundleState,
    active: CordisXPluginActivationRecordV1,
  ) {
    return {
      $schema: CORDISX_PLUGIN_BUNDLE_LIFECYCLE_RESULT_SCHEMA_V1,
      schemaVersion: 1 as const,
      requestId: request.requestId,
      profileId: request.profileId,
      operation: request.operation.kind,
      revision: state.revision,
      pluginRevision: active.revision,
      runtimeGeneration: active.runtimeGeneration,
    }
  }

  protected failure(
    request: CordisXPluginBundleLifecycleRequestV1,
    state: BundleState,
    active: CordisXPluginActivationRecordV1,
    code: NonNullable<CordisXPluginBundleLifecycleResultV1['error']>['code'],
    message: string,
    outcome: CordisXPluginBundleLifecycleResultV1['outcome'],
  ): CordisXPluginBundleLifecycleResultV1 {
    return {
      ...this.base(request, state, active),
      outcome,
      affectedPluginIds: [],
      retainedPluginIds: [],
      removedPluginIds: [],
      error: { code, message },
    }
  }

  protected async inspect(
    request: CordisXPluginBundleLifecycleRequestV1 & {
      readonly operation: {
        readonly kind: 'inspect-source'
        readonly source: Parameters<typeof resolvePluginPackageSourceV1>[0]
      }
    },
    state: BundleState,
    active: CordisXPluginActivationRecordV1,
  ): Promise<CordisXPluginBundleLifecycleResultV1> {
    const snapshotter = new PluginPackageSourceSnapshotter(
      path.join(this.options.homeDir, 'bundles', '.source-staging'),
    )
    const snapshot = await snapshotter.snapshot(
      resolvePluginPackageSourceV1(request.operation.source),
      `bundle-${randomUUID()}`,
    )
    try {
      let manifestFile: string
      try {
        manifestFile = await contained(
          snapshot.payloadDirectory,
          './cordisx-bundle.json',
          /^\.\/cordisx-bundle\.json$/,
          'bundle manifest',
        )
      } catch (error) {
        if (error instanceof Error && error.message === 'bundle manifest does not exist') {
          return this.failure(
            request,
            state,
            active,
            'invalid-bundle',
            'The local source does not contain cordisx-bundle.json.',
            'rejected',
          )
        }
        throw error
      }
      const manifest = parseManifest(JSON.parse(await readFile(manifestFile, 'utf8')))
      const readmeFile = await contained(snapshot.payloadDirectory, manifest.readme, SAFE_README, 'bundle readme')
      const readme = await readFile(readmeFile, 'utf8')
      if (readme.length > 262_144) throw new Error('bundle README exceeds 256 KiB')
      if (manifest.icon !== undefined) {
        await contained(snapshot.payloadDirectory, manifest.icon, SAFE_ICON, 'bundle icon')
      }
      const members: StoredMember[] = []
      for (const declared of manifest.members) {
        const memberDirectory = await contained(
          snapshot.payloadDirectory,
          declared.path,
          SAFE_DIR,
          `member ${declared.id}`,
        )
        const staged = await this.options.pluginLifecycle.stagePackageSource({
          kind: 'local-directory',
          location: pathToFileURL(memberDirectory).href,
        })
        if (staged.manifest.id !== declared.id || staged.manifest.version !== declared.version) {
          throw new Error(`member ${declared.id} package identity differs from the bundle declaration`)
        }
        members.push({
          pluginId: declared.id,
          ...(staged.manifest.runtimeManifest.name === undefined ? {} : { name: staged.manifest.runtimeManifest.name }),
          requestedVersion: declared.version,
          digest: staged.digest,
          dependencies: staged.manifest.dependencies,
          required: declared.required,
          enabledByDefault: declared.enabledByDefault,
          permissions: permissions(staged),
        })
      }
      pluginOrder(members)
      const activeMap = activeById(active)
      for (const member of members) {
        for (const dependency of member.dependencies) {
          const bundled = members.find(candidate => candidate.pluginId === dependency.id)
          const installed = activeMap.get(dependency.id)
          if (
            (bundled === undefined || bundled.requestedVersion !== dependency.version)
            && (installed === undefined || installed.version !== dependency.version)
          ) {
            throw new Error(
              `member ${member.pluginId} requires missing exact dependency ${dependency.id}@${dependency.version}`,
            )
          }
        }
      }
      const existingBundle = state.bundles[manifest.id]
      const memberActions: CordisXPluginBundlePlanV1['memberActions'][number][] = []
      const conflicts: CordisXPluginBundlePlanV1['conflicts'][number][] = []
      const existingMemberIds = new Set(existingBundle?.members.map(member => member.pluginId) ?? [])
      const externalClaims = (pluginId: string) =>
        claims(state, active, pluginId).filter(claim => (
          (claim.kind === 'bundle' && claim.claimantId !== existingBundle?.id)
          || claim.kind === 'direct'
          || (claim.kind === 'runtime-dependency' && !existingMemberIds.has(claim.claimantId))
        ))
      for (const member of members) {
        const installed = activeMap.get(member.pluginId)
        if (installed === undefined) {
          memberActions.push({
            pluginId: member.pluginId,
            version: member.requestedVersion,
            action: 'install',
            reason: member.required ? 'bundle-required' : 'bundle-optional',
          })
        } else if (installed.version !== member.requestedVersion || installed.digest !== member.digest) {
          if (
            existingBundle?.members.some(previous => previous.pluginId === member.pluginId)
            && externalClaims(member.pluginId).length === 0
          ) {
            memberActions.push({
              pluginId: member.pluginId,
              version: member.requestedVersion,
              action: 'update',
              reason: member.required ? 'bundle-required' : 'bundle-optional',
            })
          } else if (installed.version !== member.requestedVersion) {
            conflicts.push({
              pluginId: member.pluginId,
              code: 'version-mismatch',
              message: `Installed ${installed.version}; bundle requires ${member.requestedVersion}.`,
            })
          } else {conflicts.push({
              pluginId: member.pluginId,
              code: 'digest-mismatch',
              message:
                `The same version is installed with digest ${installed.digest}; the bundle requires ${member.digest}.`,
            })}
        } else {
          const memberClaims = claims(state, active, member.pluginId)
          const reason = state.directClaims[member.pluginId]
            ? 'direct-claim'
            : memberClaims.some(claim => claim.kind === 'bundle')
            ? 'other-bundle-claim'
            : 'existing-exact'
          memberActions.push({ pluginId: member.pluginId, version: member.requestedVersion, action: 'share', reason })
        }
      }
      const nextMemberIds = new Set(members.map(member => member.pluginId))
      const removedMembers = existingBundle?.members.filter(member => !nextMemberIds.has(member.pluginId)) ?? []
      for (const member of removedMembers) {
        const external = externalClaims(member.pluginId)
        const futureRuntimeDependency = members.some(candidate =>
          candidate.dependencies.some(dependency => dependency.id === member.pluginId)
        )
        const retained = external.length > 0 || futureRuntimeDependency
        const reason = state.directClaims[member.pluginId]
          ? 'direct-claim'
          : external.some(claim => claim.kind === 'bundle')
          ? 'other-bundle-claim'
          : retained
          ? 'runtime-dependency'
          : 'orphaned'
        memberActions.push({
          pluginId: member.pluginId,
          version: member.requestedVersion,
          action: retained ? 'retain' : 'remove',
          reason,
        })
      }
      const now = this.now().toISOString()
      const record: BundleRecord = {
        id: manifest.id,
        name: manifest.name,
        ...(manifest.description === undefined ? {} : { description: manifest.description }),
        version: manifest.version,
        digest: snapshot.integrity,
        authors: manifest.authors,
        sourceLabel: sourceLabel(snapshot.source),
        ...(manifest.canonicalSource === undefined ? {} : { canonicalSource: manifest.canonicalSource }),
        readme,
        installedAt: existingBundle?.installedAt ?? now,
        updatedAt: now,
        enabled: true,
        optionalEnabled: Object.fromEntries(
          members.filter(member => !member.required).map(member => [member.pluginId, member.enabledByDefault]),
        ),
        policies: existingBundle?.policies ?? {},
        members,
        records: existingBundle?.records ?? [],
      }
      const plan: CordisXPluginBundlePlanV1 = {
        bundle: {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          digest: snapshot.integrity,
          authors: manifest.authors,
        },
        memberActions,
        permissionRequests: members.flatMap(member =>
          member.permissions.map(permission => ({
            permissionId: permission.permissionId,
            pluginId: permission.pluginId,
            capability: permission.capability,
            scopeLabel: permission.scopeLabel,
            required: permission.required,
            defaultPolicy: 'ask' as const,
          }))
        ),
        conflicts,
      }
      const candidateId = `bundle-${randomUUID()}`
      const impactToken = `bundle-impact-${hash([state.revision, active.revision, record.id, record.digest, plan])}`
      const candidate: BundleCandidate = {
        candidateId,
        createdAt: now,
        baseRevision: state.revision,
        basePluginRevision: active.revision,
        impactToken,
        record,
        plan,
      }
      const next = await this.store.update(draft => {
        draft.candidates[candidateId] = candidate
      })
      return {
        ...this.base(request, next, active),
        outcome: conflicts.length === 0 ? 'planned' : 'conflict',
        bundleId: manifest.id,
        candidateId,
        impactToken,
        affectedPluginIds: memberActions.filter(action => !['share', 'retain'].includes(action.action)).map(action =>
          action.pluginId
        ),
        retainedPluginIds: memberActions.filter(action => action.action === 'share' || action.action === 'retain').map(
          action => action.pluginId,
        ),
        removedPluginIds: memberActions.filter(action => action.action === 'remove').map(action => action.pluginId),
        plan,
        ...(conflicts.length === 0
          ? {}
          : {
            error: {
              code: 'version-conflict' as const,
              message: 'One or more bundle members conflict with the active profile.',
            },
          }),
      }
    } finally {
      await snapshotter.discard(snapshot)
    }
  }

  protected policyFor(
    record: BundleRecord,
    state: BundleState,
    permission: StoredPermission,
  ): CordisXPluginBundlePolicy {
    const key = overrideKey(permission.pluginId, permission.permissionId)
    const override = state.pluginOverrides[key]
    if (override !== undefined) return override
    const policies = Object.values(state.bundles)
      .filter(bundle =>
        bundle.enabled
        && bundle.members.some(member =>
          member.pluginId === permission.pluginId
          && member.permissions.some(item => item.permissionId === permission.permissionId)
        )
      )
      .map(bundle =>
        bundle.id === record.id
          ? record.policies[permission.permissionId] ?? 'ask'
          : bundle.policies[permission.permissionId] ?? 'ask'
      )
    if (!state.bundles[record.id]?.enabled) policies.push(record.policies[permission.permissionId] ?? 'ask')
    const merged = policies.reduce<CordisXPluginBundlePolicy>(
      (current, next) => policyRank[next] > policyRank[current] ? next : current,
      'allow',
    )
    const floor = state.permissionFloors[key]
    return floor !== undefined && policyRank[floor] > policyRank[merged] ? floor : merged
  }

  protected async applyStaged(
    staged: StagedPluginPackage,
    record: BundleRecord,
    state: BundleState,
  ): Promise<CordisXPluginLifecycleResultV1> {
    const planned = await this.options.pluginLifecycle.inspectStagedPackage(staged)
    if (planned.outcome !== 'planned' || planned.candidateId === undefined) {
      throw new Error(planned.error?.message ?? `could not plan ${staged.manifest.id}`)
    }
    const active = await this.options.pluginLifecycle.store.loadActive()
    const common = {
      profileId: this.options.profileId,
      runtimeGeneration: this.options.runtimeGeneration,
      expectedRevision: active.revision,
    }
    const policy = (capability: string, scope: unknown): CordisXPluginBundlePolicy => {
      const id = pluginBundlePermissionId({ pluginId: staged.manifest.id, digest: staged.digest, capability, scope })
      const permission = record.members.flatMap(member => member.permissions).find(item => item.permissionId === id)
      return permission === undefined ? 'ask' : this.policyFor(record, state, permission)
    }
    if (planned.authorizationPlan !== undefined) {
      const plan = planned.authorizationPlan
      const decision: CordisXPermissionAuthorizationDecisionV1 = {
        $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V1,
        schemaVersion: 1,
        planId: plan.planId,
        operation: plan.operation,
        profileId: plan.profileId,
        identity: plan.identity,
        decisions: plan.declarations.map(item => ({
          capability: item.capability,
          scope: item.scope,
          decision: policy(item.capability, item.scope) === 'allow' ? 'allow' : 'deny',
        })),
      }
      return await this.options.pluginLifecycle.handleBundleOperation({
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-lifecycle-operation.v1.schema.json',
        schemaVersion: 1,
        requestId: `bundle-apply-${randomUUID()}`,
        ...common,
        operation: {
          kind: planned.operation as 'install' | 'update',
          candidateId: planned.candidateId,
          authorizationDecision: decision,
        },
      })
    }
    if (staged.manifest.runtimeManifest.schemaVersion === 4) {
      const plan = await this.options.pluginLifecycle.permissionReviewPlanV2({
        requestId: `bundle-plan-${randomUUID()}`,
        ...common,
        target: { kind: 'candidate', candidateId: planned.candidateId },
      })
      if (plan === undefined) throw new Error('manifest-v4 permission plan is unavailable')
      const decision: CordisXPermissionAuthorizationDecisionV2 = {
        $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
        schemaVersion: 2,
        planId: plan.planId,
        operation: plan.operation,
        profileId: plan.profileId,
        identity: plan.identity,
        binding: plan.binding,
        decisions: plan.declarations.filter(item => item.decisionRequired).map(item => ({
          capability: item.capability,
          scope: item.scope,
          securityFingerprint: item.securityFingerprint,
          decision: this.decisionV2(item, policy(item.capability, item.scope)),
        })),
      }
      return await this.options.pluginLifecycle.applyPermissionReviewV2({
        requestId: `bundle-apply-${randomUUID()}`,
        ...common,
        decision,
      })
    }
    if (
      staged.manifest.runtimeManifest.schemaVersion !== 5 && staged.manifest.runtimeManifest.schemaVersion !== 6
      && staged.manifest.runtimeManifest.schemaVersion !== 7 && staged.manifest.runtimeManifest.schemaVersion !== 8
    ) {
      throw new Error('bundle members must use runtime manifest v1, v4, v5, v6, v7, or v8')
    }
    const plan = await this.options.pluginLifecycle.permissionReviewPlanV4({
      requestId: `bundle-plan-${randomUUID()}`,
      ...common,
      target: { kind: 'candidate', candidateId: planned.candidateId },
    })
    if (plan === undefined) throw new Error('manifest-v5/v6/v7/v8 permission plan is unavailable')
    const decision: CordisXPermissionAuthorizationDecisionV4 = {
      $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V4,
      schemaVersion: 4,
      origin: 'explicit-user',
      planId: plan.planId,
      operation: plan.operation,
      profileId: plan.profileId,
      identity: plan.identity,
      binding: plan.binding,
      decisions: plan.declarations.filter(item => item.decisionRequired).map(item => ({
        capability: item.capability,
        scope: item.scope,
        securityFingerprint: item.securityFingerprint,
        decision: this.decisionV2(item, policy(item.capability, item.scope)),
      })),
    }
    return await this.options.pluginLifecycle.applyPermissionReviewV4({
      requestId: `bundle-apply-${randomUUID()}`,
      ...common,
      decision,
    })
  }

  protected async enablePlugin(
    staged: StagedPluginPackage,
    record: BundleRecord,
    state: BundleState,
  ): Promise<CordisXPluginLifecycleResultV1> {
    const active = await this.options.pluginLifecycle.store.loadActive()
    const current = active.plugins.find(plugin => plugin.id === staged.manifest.id)
    if (current === undefined) return await this.applyStaged(staged, record, state)
    if (current.enabled) throw new Error(`${current.id} is already enabled`)
    if (current.digest !== staged.digest) throw new Error(`${current.id} no longer matches the bundle digest`)
    const common = {
      profileId: this.options.profileId,
      runtimeGeneration: this.options.runtimeGeneration,
      expectedRevision: active.revision,
    }
    if (staged.manifest.runtimeManifest.schemaVersion === 1) {
      const preview = await this.options.pluginLifecycle.handleBundleOperation({
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-lifecycle-operation.v1.schema.json',
        schemaVersion: 1,
        requestId: `bundle-enable-plan-${randomUUID()}`,
        ...common,
        operation: { kind: 'enable', pluginId: staged.manifest.id },
      })
      if (preview.outcome !== 'planned' || preview.authorizationPlan === undefined) {
        throw new Error(preview.error?.message ?? `could not plan enable for ${staged.manifest.id}`)
      }
      const decision: CordisXPermissionAuthorizationDecisionV1 = {
        $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V1,
        schemaVersion: 1,
        planId: preview.authorizationPlan.planId,
        operation: preview.authorizationPlan.operation,
        profileId: preview.authorizationPlan.profileId,
        identity: preview.authorizationPlan.identity,
        decisions: preview.authorizationPlan.declarations.map(item => {
          const permission = record.members.flatMap(member => member.permissions).find(candidate =>
            candidate.permissionId
              === pluginBundlePermissionId({
                pluginId: staged.manifest.id,
                digest: staged.digest,
                capability: item.capability,
                scope: item.scope,
              })
          )
          return {
            capability: item.capability,
            scope: item.scope,
            decision: permission !== undefined && this.policyFor(record, state, permission) === 'allow'
              ? 'allow' as const
              : 'deny' as const,
          }
        }),
      }
      const latest = await this.options.pluginLifecycle.store.loadActive()
      return await this.options.pluginLifecycle.handleBundleOperation({
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-lifecycle-operation.v1.schema.json',
        schemaVersion: 1,
        requestId: `bundle-enable-${randomUUID()}`,
        profileId: this.options.profileId,
        runtimeGeneration: this.options.runtimeGeneration,
        expectedRevision: latest.revision,
        operation: { kind: 'enable', pluginId: staged.manifest.id, authorizationDecision: decision },
      })
    }
    if (staged.manifest.runtimeManifest.schemaVersion === 4) {
      const plan = await this.options.pluginLifecycle.permissionReviewPlanV2({
        requestId: `bundle-enable-plan-${randomUUID()}`,
        ...common,
        target: { kind: 'enable', pluginId: staged.manifest.id },
      })
      if (plan === undefined) throw new Error('manifest-v4 enable permission plan is unavailable')
      const decision: CordisXPermissionAuthorizationDecisionV2 = {
        $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
        schemaVersion: 2,
        planId: plan.planId,
        operation: plan.operation,
        profileId: plan.profileId,
        identity: plan.identity,
        binding: plan.binding,
        decisions: plan.declarations.filter(item => item.decisionRequired).map(item => ({
          capability: item.capability,
          scope: item.scope,
          securityFingerprint: item.securityFingerprint,
          decision: this.decisionV2(item, this.permissionPolicy(record, state, staged, item.capability, item.scope)),
        })),
      }
      return await this.options.pluginLifecycle.applyPermissionReviewV2({
        requestId: `bundle-enable-${randomUUID()}`,
        ...common,
        decision,
      })
    }
    if (
      staged.manifest.runtimeManifest.schemaVersion !== 5 && staged.manifest.runtimeManifest.schemaVersion !== 6
      && staged.manifest.runtimeManifest.schemaVersion !== 7 && staged.manifest.runtimeManifest.schemaVersion !== 8
    ) {
      throw new Error('bundle members must use runtime manifest v1, v4, v5, v6, v7, or v8')
    }
    const plan = await this.options.pluginLifecycle.permissionReviewPlanV4({
      requestId: `bundle-enable-plan-${randomUUID()}`,
      ...common,
      target: { kind: 'enable', pluginId: staged.manifest.id },
    })
    if (plan === undefined) throw new Error('manifest-v5/v6/v7/v8 enable permission plan is unavailable')
    const decision: CordisXPermissionAuthorizationDecisionV4 = {
      $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V4,
      schemaVersion: 4,
      origin: 'explicit-user',
      planId: plan.planId,
      operation: plan.operation,
      profileId: plan.profileId,
      identity: plan.identity,
      binding: plan.binding,
      decisions: plan.declarations.filter(item => item.decisionRequired).map(item => ({
        capability: item.capability,
        scope: item.scope,
        securityFingerprint: item.securityFingerprint,
        decision: this.decisionV2(item, this.permissionPolicy(record, state, staged, item.capability, item.scope)),
      })),
    }
    return await this.options.pluginLifecycle.applyPermissionReviewV4({
      requestId: `bundle-enable-${randomUUID()}`,
      ...common,
      decision,
    })
  }

  protected permissionPolicy(
    record: BundleRecord,
    state: BundleState,
    staged: StagedPluginPackage,
    capability: string,
    scope: unknown,
  ): CordisXPluginBundlePolicy {
    const permissionId = pluginBundlePermissionId({
      pluginId: staged.manifest.id,
      digest: staged.digest,
      capability,
      scope,
    })
    const permission = record.members.flatMap(member => member.permissions).find(item =>
      item.permissionId === permissionId
    )
    return permission === undefined ? 'ask' : this.policyFor(record, state, permission)
  }

  protected decisionV2(
    item: Pick<CordisXPermissionAuthorizationItemV4, 'allowedDecisions' | 'defaultDecision'>,
    policy: CordisXPluginBundlePolicy,
  ): CordisXPermissionDecisionV2 {
    const preferred = policy === 'allow'
      ? ['allow-persistent', 'allow-once'] as const
      : ['deny-persistent', 'deny-once'] as const
    return preferred.find(decision => item.allowedDecisions.includes(decision)) ?? item.defaultDecision
  }
}
