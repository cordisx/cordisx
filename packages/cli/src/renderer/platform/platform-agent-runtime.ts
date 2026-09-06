import { PlatformPermissionBrokerBase } from './platform-permission-broker-base.js'
import type { AgentRuntimeCapability } from '@cordisx/protocol/agents/v1'
import type {
  CordisXCapabilityDeclaration,
  CordisXPermissionDecision,
  CordisXPlatformCapability,
  CordisXPluginIdentity,
} from '../../contracts.js'
import type { PluginGenerationView } from '../generation-visibility.js'
import { CORDISX_PERMISSION_POLICY_SCHEMA_V4 } from '../../permission-contracts.js'
import type { CordisXPermissionPolicyRecordV4, CordisXPermissionPolicyV2 } from '../../permission-contracts.js'
import { sha256Hex } from '../../permission-model-v2.js'
import { normalizePermissionPolicyRecordV4, permissionRecordKeyV4 } from '../../permission-model-v4.js'
import { isPermissionPolicyRecordV4 } from '../../permission-persistence.js'

import { object } from './platform-manifest.js'
import {
  AgentRuntimeAuthorization,
  AgentRuntimeConnection,
  agentRuntimeIdentityKey,
  AgentRuntimePermissionFence,
  AgentRuntimeRouteScope,
  AgentRuntimeScopeSource,
  DevelopmentAgentRuntimeAuthorizationAuthority,
  DevelopmentAgentRuntimePolicySeedAuthority,
  isAgentRuntimePermission,
  isApprovalAuthorityRequesterRouteScope,
  isHostRouteSessionScopeBinding,
  PlaygroundScenarioAgentRuntimeRouteAuthority,
  Registration,
  sameAgentRuntimeConnection,
  sameAgentRuntimeRoute,
  validAgentRuntimeConnection,
  validAgentRuntimeOpaqueId,
  validAgentRuntimeRoute,
  validAgentRuntimeSessionId,
} from './platform-permission-types.js'

export abstract class PlatformAgentRuntimeBroker extends PlatformPermissionBrokerBase {
  /** Installs the current opaque transport generation. Replacing it fences every lease. */
  replaceAgentRuntimeConnection(connection: AgentRuntimeConnection): void {
    if (!validAgentRuntimeConnection(connection)) throw new Error('Agent Session runtime connection is invalid')
    if (sameAgentRuntimeConnection(this.agentRuntimeConnection, connection)) return
    this.agentRuntimeConnection = Object.freeze({ ...connection })
    this.fenceAgentRuntime(undefined, 'connection-replaced')
    this.playgroundScenarioAgentRuntimeRoutes.clear()
  }

  clearAgentRuntimeConnection(): void {
    if (this.agentRuntimeConnection === undefined) return
    this.agentRuntimeConnection = undefined
    this.fenceAgentRuntime(undefined, 'connection-replaced')
    this.playgroundScenarioAgentRuntimeRoutes.clear()
  }

  /** Host Router only: records the active same-plugin route projection. */
  replaceAgentRuntimeRouteScope(scope: AgentRuntimeRouteScope): void {
    if (!validAgentRuntimeRoute(scope)) throw new Error('Agent Session runtime route scope is invalid')
    const key = agentRuntimeIdentityKey(scope.owner)
    const previous = this.agentRuntimeRoutes.get(key)
    const next = Object.freeze({
      ...scope,
      owner: Object.freeze({ ...scope.owner }),
      params: Object.freeze({ ...scope.params }),
    })
    if (previous !== undefined && !sameAgentRuntimeRoute(previous, next)) {
      this.agentRuntimeRoutes.set(key, next)
      this.clearPlaygroundScenarioAgentRuntimeRoutes(previous.routeInstanceId)
      this.fenceAgentRuntime({ source: previous.owner.source, id: previous.owner.pluginId }, 'route-replaced')
      return
    }
    this.agentRuntimeRoutes.set(key, next)
  }

  revokeAgentRuntimeRoute(routeInstanceId: string): void {
    if (!validAgentRuntimeOpaqueId(routeInstanceId)) return
    for (const [key, route] of this.agentRuntimeRoutes) {
      if (route.routeInstanceId !== routeInstanceId) continue
      this.agentRuntimeRoutes.delete(key)
      this.clearPlaygroundScenarioAgentRuntimeRoutes(route.routeInstanceId)
      this.fenceAgentRuntime({ source: route.owner.source, id: route.owner.pluginId }, 'route-replaced')
    }
  }

  /** Returns an exact revocable lease only after a registered v5/v6 declaration and exact policy match. */
  async authorizeAgentRuntime(
    input: Readonly<{
      identity: CordisXPluginIdentity
      capability: AgentRuntimeCapability
      sessionId: string
      scopeSource: AgentRuntimeScopeSource
      connection: AgentRuntimeConnection
      view?: PluginGenerationView
    }>,
  ): Promise<AgentRuntimeAuthorization> {
    return await this.authorizeAgentRuntimeInternal(input, false)
  }

  /** Host development composition only: applies a normal exact policy without opening interactive UI. */
  async authorizeDevelopmentAgentRuntime(
    authority: DevelopmentAgentRuntimeAuthorizationAuthority,
    input: Readonly<{
      identity: CordisXPluginIdentity
      capability: AgentRuntimeCapability
      sessionId: string
      scopeSource: AgentRuntimeScopeSource
      connection: AgentRuntimeConnection
      view?: PluginGenerationView
    }>,
  ): Promise<AgentRuntimeAuthorization> {
    if (!this.developmentAgentRuntimeAuthorizations.has(authority)) {
      throw new Error('Agent Session development authorization authority is invalid')
    }
    return await this.authorizeAgentRuntimeInternal(input, true)
  }

  protected async authorizeAgentRuntimeInternal(
    input: Readonly<{
      identity: CordisXPluginIdentity
      capability: AgentRuntimeCapability
      sessionId: string
      scopeSource: AgentRuntimeScopeSource
      connection: AgentRuntimeConnection
      view?: PluginGenerationView
    }>,
    developmentAutoApprove: boolean,
  ): Promise<AgentRuntimeAuthorization> {
    const registration = this.registration(input.identity, input.view)
    if (
      registration === undefined || !validAgentRuntimeSessionId(input.sessionId)
      || !sameAgentRuntimeConnection(this.agentRuntimeConnection, input.connection)
      || (registration.manifest.schemaVersion !== 5 && registration.manifest.schemaVersion !== 6
        && registration.manifest.schemaVersion !== 7 && registration.manifest.schemaVersion !== 8)
    ) return Object.freeze({ authorized: false })
    const declaration = registration.manifest.capabilities.find((
      item,
    ): item is Extract<typeof item, { readonly name: AgentRuntimeCapability }> => (
      item.name === input.capability && isAgentRuntimePermission(item.name)
    ))
    if (declaration === undefined) return Object.freeze({ authorized: false })
    const declaredSessionIds = 'sessionIds' in declaration.scope ? declaration.scope.sessionIds : undefined
    const authorityRequester = 'authorityRequester' in declaration.scope
      ? declaration.scope.authorityRequester
      : undefined
    const rationale = 'rationale' in declaration ? declaration.rationale : undefined
    if (!this.validAgentRuntimeScopeSource(registration, input, declaredSessionIds, authorityRequester)) {
      return Object.freeze({ authorized: false })
    }
    const policyKey = this.agentRuntimePolicyKey(registration, input.capability, input.sessionId)
    const policy = this.policyRecords.get(policyKey)
    if (!developmentAutoApprove && isPermissionPolicyRecordV4(policy) && policy.policy === 'deny-persistent') {
      return Object.freeze({ authorized: false })
    }
    if (developmentAutoApprove && (!isPermissionPolicyRecordV4(policy) || policy.policy !== 'allow-persistent')) {
      const record = this.agentRuntimePolicyRecord(registration, input.capability, input.sessionId, 'allow-persistent')
      try {
        await this.persistV4([record])
      } catch {
        return Object.freeze({ authorized: false })
      }
      if (
        !this.isRegistered(registration) || !sameAgentRuntimeConnection(this.agentRuntimeConnection, input.connection)
        || !this.validAgentRuntimeScopeSource(registration, input, declaredSessionIds, authorityRequester)
      ) {
        return Object.freeze({ authorized: false })
      }
      this.policyRecords.set(permissionRecordKeyV4(record), record)
      this.changed()
    } else if (!isPermissionPolicyRecordV4(policy) || policy.policy !== 'allow-persistent') {
      const promptDeclaration: CordisXCapabilityDeclaration = Object.freeze({
        name: input.capability as CordisXPlatformCapability,
        required: declaration.required,
        reason: rationale?.description ?? Object.freeze({
          namespace: 'permission',
          key: `agent-runtime.${input.capability}`,
          fallback: `${input.capability} for one exact Agent Session`,
        }),
        scope: Object.freeze({ sessionIds: Object.freeze([input.sessionId]) }),
      })
      let decision: Exclude<CordisXPermissionDecision, 'ask'> | 'timeout' | 'cancelled'
      let timer: ReturnType<typeof setTimeout> | undefined
      const abort = new AbortController()
      const pending = Object.freeze({ identity: registration.identity, registrationToken: registration.token, abort })
      this.pendingAgentRuntimePrompts.add(pending)
      try {
        decision = await Promise.race([
          this.prompt.request({
            identity: input.identity,
            declaration: promptDeclaration,
            requested: Object.freeze({ agentSessionId: input.sessionId }),
            signal: abort.signal,
          }),
          new Promise<'timeout'>(resolve => {
            timer = setTimeout(() => resolve('timeout'), this.promptTimeoutMs)
          }),
          new Promise<'cancelled'>(resolve =>
            abort.signal.addEventListener('abort', () => resolve('cancelled'), { once: true })
          ),
        ])
      } catch {
        decision = 'deny'
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        this.pendingAgentRuntimePrompts.delete(pending)
        abort.abort()
      }
      if (decision !== 'allow' && decision !== 'allow-once') return Object.freeze({ authorized: false })
      if (
        !this.isRegistered(registration) || !sameAgentRuntimeConnection(this.agentRuntimeConnection, input.connection)
        || !this.validAgentRuntimeScopeSource(registration, input, declaredSessionIds, authorityRequester)
      ) {
        return Object.freeze({ authorized: false })
      }
      if (decision === 'allow') {
        const record = this.agentRuntimePolicyRecord(
          registration,
          input.capability,
          input.sessionId,
          'allow-persistent',
        )
        try {
          await this.persistV4([record])
        } catch {
          return Object.freeze({ authorized: false })
        }
        if (
          !this.isRegistered(registration) || !sameAgentRuntimeConnection(this.agentRuntimeConnection, input.connection)
          || !this.validAgentRuntimeScopeSource(registration, input, declaredSessionIds, authorityRequester)
        ) {
          return Object.freeze({ authorized: false })
        }
        this.policyRecords.set(permissionRecordKeyV4(record), record)
        this.changed()
      }
    }
    const existing = [...this.agentRuntimeLeases.values()].find(item => (
      item.identity.source === input.identity.source && item.identity.id === input.identity.id
      && item.capability === input.capability && item.lease.sessionId === input.sessionId
      && sameAgentRuntimeConnection(item.connection, input.connection)
      && item.routeInstanceId
        === (input.scopeSource.kind === 'host-route' ? input.scopeSource.routeInstanceId : undefined)
      && item.moduleGeneration === registration.generation.moduleGeneration
    ))
    if (existing !== undefined) return Object.freeze({ authorized: true, lease: existing.lease })
    const lease = Object.freeze({ leaseId: crypto.randomUUID(), sessionId: input.sessionId })
    this.agentRuntimeLeases.set(
      lease.leaseId,
      Object.freeze({
        lease,
        identity: Object.freeze({ ...input.identity }),
        capability: input.capability,
        connection: Object.freeze({ ...input.connection }),
        ...(input.scopeSource.kind === 'host-route'
          ? { routeInstanceId: input.scopeSource.routeInstanceId, routeSessionId: input.scopeSource.params.sessionId }
          : {}),
        ...(registration.generation.moduleGeneration === undefined
          ? {}
          : { moduleGeneration: registration.generation.moduleGeneration }),
      }),
    )
    return Object.freeze({ authorized: true, lease })
  }

  isAgentRuntimeLeaseActive(identity: CordisXPluginIdentity, leaseId: string, view?: PluginGenerationView): boolean {
    const lease = this.agentRuntimeLeases.get(leaseId)
    const registration = this.registration(identity, view)
    return lease !== undefined && registration !== undefined
      && lease.identity.source === identity.source && lease.identity.id === identity.id
      && lease.moduleGeneration === registration.generation.moduleGeneration
      && sameAgentRuntimeConnection(lease.connection, this.agentRuntimeConnection)
      && (lease.routeInstanceId === undefined || this.agentRuntimeRouteValues().some(route => (
        route.routeInstanceId === lease.routeInstanceId
        && route.params.sessionId === (lease.routeSessionId ?? lease.lease.sessionId)
        && route.owner.source === identity.source && route.owner.pluginId === identity.id
      )))
  }

  subscribeAgentRuntimePermissionFences(listener: (fence: AgentRuntimePermissionFence) => void): () => void {
    this.agentRuntimeFenceListeners.add(listener)
    return () => this.agentRuntimeFenceListeners.delete(listener)
  }

  /** Development composition receives this opaque authority; production does not create one. */
  createDevelopmentAgentRuntimePolicySeedAuthority(): DevelopmentAgentRuntimePolicySeedAuthority {
    const authority = Object.freeze({})
    this.developmentAgentRuntimeSeeds.add(authority)
    return authority
  }

  /** Created only by a Host development composition and never projected into plugin context. */
  createDevelopmentAgentRuntimeAuthorizationAuthority(): DevelopmentAgentRuntimeAuthorizationAuthority {
    const authority = Object.freeze({})
    this.developmentAgentRuntimeAuthorizations.add(authority)
    return authority
  }

  /** Host Playground only: mint authority for an exact scenario route beside the visible Room route. */
  createPlaygroundScenarioAgentRuntimeRouteAuthority(): PlaygroundScenarioAgentRuntimeRouteAuthority {
    const authority = Object.freeze({})
    this.playgroundScenarioAgentRuntimeRouteAuthorities.add(authority)
    return authority
  }

  /**
   * Add one temporary exact route to this broker without replacing the visible
   * Room route. Cleanup is idempotent and fences only leases from this route.
   */
  activatePlaygroundScenarioAgentRuntimeRoute(
    authority: PlaygroundScenarioAgentRuntimeRouteAuthority,
    baseRouteInstanceId: string,
    scope: AgentRuntimeRouteScope,
  ): () => void {
    if (!this.playgroundScenarioAgentRuntimeRouteAuthorities.has(authority)) {
      throw new Error('Playground scenario Agent Session route authority is invalid')
    }
    if (!validAgentRuntimeOpaqueId(baseRouteInstanceId) || !validAgentRuntimeRoute(scope)) {
      throw new Error('Playground scenario Agent Session route scope is invalid')
    }
    const primary = this.agentRuntimeRoutes.get(agentRuntimeIdentityKey(scope.owner))
    if (
      primary === undefined || primary.routeInstanceId !== baseRouteInstanceId
      || primary.owner.source !== scope.owner.source || primary.owner.pluginId !== scope.owner.pluginId
      || primary.routeId !== scope.routeId || primary.path !== scope.path
      || scope.routeInstanceId === baseRouteInstanceId
    ) {
      throw new Error('Playground scenario Agent Session route does not match the active Room route')
    }
    if (this.playgroundScenarioAgentRuntimeRoutes.has(scope.routeInstanceId)) {
      throw new Error('Playground scenario Agent Session route instance is already active')
    }
    const record = Object.freeze({
      route: Object.freeze({
        ...scope,
        owner: Object.freeze({ ...scope.owner }),
        params: Object.freeze({ ...scope.params }),
      }),
      baseRouteInstanceId,
    })
    this.playgroundScenarioAgentRuntimeRoutes.set(scope.routeInstanceId, record)
    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.playgroundScenarioAgentRuntimeRoutes.get(scope.routeInstanceId) !== record) return
      this.playgroundScenarioAgentRuntimeRoutes.delete(scope.routeInstanceId)
      this.fenceAgentRuntimeRouteInstance(scope.routeInstanceId, 'route-replaced')
    }
  }

  /** Host Playground Shell only: mount an exact route from a captured Room binding. */
  activateCapturedPlaygroundScenarioAgentRuntimeRoute(
    authority: PlaygroundScenarioAgentRuntimeRouteAuthority,
    scope: AgentRuntimeRouteScope,
  ): () => void {
    if (!this.playgroundScenarioAgentRuntimeRouteAuthorities.has(authority)) {
      throw new Error('Playground scenario Agent Session route authority is invalid')
    }
    if (!validAgentRuntimeRoute(scope) || this.playgroundScenarioAgentRuntimeRoutes.has(scope.routeInstanceId)) {
      throw new Error('Playground scenario captured Agent Session route scope is invalid')
    }
    const record = Object.freeze({
      route: Object.freeze({
        ...scope,
        owner: Object.freeze({ ...scope.owner }),
        params: Object.freeze({ ...scope.params }),
      }),
      baseRouteInstanceId: scope.routeInstanceId,
    })
    this.playgroundScenarioAgentRuntimeRoutes.set(scope.routeInstanceId, record)
    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.playgroundScenarioAgentRuntimeRoutes.get(scope.routeInstanceId) !== record) return
      this.playgroundScenarioAgentRuntimeRoutes.delete(scope.routeInstanceId)
      this.fenceAgentRuntimeRouteInstance(scope.routeInstanceId, 'route-replaced')
    }
  }

  async seedAgentRuntimePolicies(
    authority: DevelopmentAgentRuntimePolicySeedAuthority,
    identity: CordisXPluginIdentity,
    entries: readonly Readonly<
      {
        capability: AgentRuntimeCapability
        sessionIds: readonly [string, ...string[]]
        policy: CordisXPermissionPolicyV2
      }
    >[],
  ): Promise<void> {
    if (!this.developmentAgentRuntimeSeeds.has(authority)) {
      throw new Error('Agent Session policy seed authority is invalid')
    }
    const records = entries.map(entry => {
      if (entry.sessionIds.length !== 1 || !validAgentRuntimeSessionId(entry.sessionIds[0])) {
        throw new Error('Agent Session seed requires one exact SessionId')
      }
      if (!isAgentRuntimePermission(entry.capability)) throw new Error('Agent Session seed capability is unsupported')
      return this.agentRuntimePolicyRecordForIdentity(identity, entry.capability, entry.sessionIds[0]!, entry.policy)
    })
    for (const record of records) this.policyRecords.set(permissionRecordKeyV4(record), record)
    this.fenceAgentRuntime(identity, 'permission-revoked')
    this.changed()
    await this.persistV4(records)
  }

  protected validAgentRuntimeScopeSource(
    registration: Registration,
    input: Readonly<{ sessionId: string; capability: AgentRuntimeCapability; scopeSource: AgentRuntimeScopeSource }>,
    declaredScope: unknown,
    authorityRequester: unknown,
  ): boolean {
    if (input.scopeSource.kind === 'host-create') {
      return input.capability === 'agents.create'
        && input.scopeSource.reservedSessionId === input.sessionId
        && declaredScope === undefined && authorityRequester === undefined
    }
    if (input.scopeSource.kind === 'host-exact') {
      return input.scopeSource.exactSessionId === input.sessionId
        && authorityRequester === undefined
        && (declaredScope === undefined || (Array.isArray(declaredScope) && declaredScope.includes(input.sessionId)))
    }
    if (Array.isArray(declaredScope)) {
      return authorityRequester === undefined
        && declaredScope.length === 1 && declaredScope[0] === input.sessionId
    }
    const source = input.scopeSource
    const route = this.agentRuntimeRouteValues().find(candidate => (
      candidate.owner.source === registration.identity.source
      && candidate.owner.pluginId === registration.identity.id
      && candidate.routeInstanceId === source.routeInstanceId
    ))
    if (
      route === undefined
      || route.routeInstanceId !== source.routeInstanceId
      || route.routeId !== source.routeId
      || route.path !== source.path
      || route.params.sessionId !== source.params.sessionId
    ) return false
    if (isHostRouteSessionScopeBinding(declaredScope)) {
      return authorityRequester === undefined
        && route.params.sessionId === input.sessionId
        && declaredScope.routeId === route.routeId
        && declaredScope.param === 'sessionId'
    }
    return declaredScope === undefined
      && registration.manifest.schemaVersion === 8
      && input.capability === 'approvals.answer'
      && input.sessionId !== route.params.sessionId
      && isApprovalAuthorityRequesterRouteScope(authorityRequester)
      && authorityRequester.requester.routeId === route.routeId
      && authorityRequester.requester.param === 'sessionId'
  }

  protected agentRuntimePolicyRecord(
    registration: Registration,
    capability: AgentRuntimeCapability,
    sessionId: string,
    policy: CordisXPermissionPolicyV2,
  ): CordisXPermissionPolicyRecordV4 {
    return this.agentRuntimePolicyRecordForIdentity(registration.identity, capability, sessionId, policy)
  }

  protected agentRuntimePolicyRecordForIdentity(
    identity: CordisXPluginIdentity,
    capability: AgentRuntimeCapability,
    sessionId: string,
    policy: CordisXPermissionPolicyV2,
  ): CordisXPermissionPolicyRecordV4 {
    return normalizePermissionPolicyRecordV4({
      $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V4,
      schemaVersion: 4,
      key: {
        profileId: this.profileId,
        identity: { source: identity.source, pluginId: identity.id },
        capability,
        scope: { sessionIds: [sessionId] },
        securityFingerprint: `sha256:${sha256Hex(JSON.stringify({ capability, sessionId }))}`,
      },
      policy,
    })
  }

  protected agentRuntimePolicyKey(
    registration: Registration,
    capability: AgentRuntimeCapability,
    sessionId: string,
  ): string {
    return permissionRecordKeyV4(this.agentRuntimePolicyRecord(registration, capability, sessionId, 'ask'))
  }

  protected fenceAgentRuntime(
    identity: CordisXPluginIdentity | undefined,
    code: AgentRuntimePermissionFence['code'],
    registrationToken?: object,
  ): void {
    if (code === 'plugin-generation-replaced' && identity !== undefined) {
      for (const [routeInstanceId, record] of this.playgroundScenarioAgentRuntimeRoutes) {
        if (record.route.owner.source === identity.source && record.route.owner.pluginId === identity.id) {
          this.playgroundScenarioAgentRuntimeRoutes.delete(routeInstanceId)
        }
      }
    }
    for (const pending of this.pendingAgentRuntimePrompts) {
      if (
        identity !== undefined && (pending.identity.source !== identity.source || pending.identity.id !== identity.id)
      ) continue
      if (registrationToken !== undefined && pending.registrationToken !== registrationToken) continue
      pending.abort.abort()
      this.pendingAgentRuntimePrompts.delete(pending)
    }
    for (const [leaseId, lease] of this.agentRuntimeLeases) {
      if (identity !== undefined && (lease.identity.source !== identity.source || lease.identity.id !== identity.id)) {
        continue
      }
      this.agentRuntimeLeases.delete(leaseId)
      const fence = Object.freeze({ identity: lease.identity, sessionId: lease.lease.sessionId, code })
      for (const listener of this.agentRuntimeFenceListeners) {
        try {
          listener(fence)
        } catch { /* fences are authoritative; observers are isolated */ }
      }
    }
  }

  protected agentRuntimeRouteValues(): readonly AgentRuntimeRouteScope[] {
    return [
      ...this.agentRuntimeRoutes.values(),
      ...[...this.playgroundScenarioAgentRuntimeRoutes.values()].map(record => record.route),
    ]
  }

  protected fenceAgentRuntimeRouteInstance(routeInstanceId: string, code: AgentRuntimePermissionFence['code']): void {
    for (const [leaseId, lease] of this.agentRuntimeLeases) {
      if (lease.routeInstanceId !== routeInstanceId) continue
      this.agentRuntimeLeases.delete(leaseId)
      const fence = Object.freeze({ identity: lease.identity, sessionId: lease.lease.sessionId, code })
      for (const listener of this.agentRuntimeFenceListeners) {
        try {
          listener(fence)
        } catch { /* fences are authoritative; observers are isolated */ }
      }
    }
  }

  protected clearPlaygroundScenarioAgentRuntimeRoutes(baseRouteInstanceId: string): void {
    for (const [routeInstanceId, record] of this.playgroundScenarioAgentRuntimeRoutes) {
      if (record.baseRouteInstanceId !== baseRouteInstanceId) continue
      this.playgroundScenarioAgentRuntimeRoutes.delete(routeInstanceId)
      this.fenceAgentRuntimeRouteInstance(routeInstanceId, 'route-replaced')
    }
  }
}
