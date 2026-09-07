import type { CordisXPluginManifestV10 } from '../../extension-point-interaction-permissions.js'
import type { AgentRuntimeCapability } from '@cordisx/protocol/agents/v1'
import type {
  CordisXCapabilityDeclaration,
  CordisXCapabilityScope,
  CordisXLocalizedText,
  CordisXPermissionPolicy,
  CordisXPlatformCapability,
  CordisXPluginIdentity,
  CordisXPluginManifestV1,
} from '../../contracts.js'
import type { PluginGenerationEffectIdentity, PluginGenerationView } from '../generation-visibility.js'
import type {
  CordisXCapabilityDeclarationV2,
  CordisXCapabilityDeclarationV4,
  CordisXCertifiedPermissionProjectionV1,
  CordisXPermissionAuthorizationKeyV3,
  CordisXPermissionAuthorizationKeyV4,
  CordisXPermissionCapabilityV2,
  CordisXPermissionCapabilityV4,
  CordisXPermissionScopeV2,
  CordisXPermissionScopeV4,
  CordisXPluginManifestV4,
  CordisXPluginManifestV5,
  CordisXPluginManifestV6,
  CordisXPluginManifestV7,
  CordisXPluginManifestV8,
  CordisXPluginManifestV9,
} from '../../permission-contracts.js'
import { isHostDomPermissionCapability } from '../../permission-model-v4.js'

import { object } from './platform-manifest.js'
import { RequestedScope } from './platform-permission-store.js'

export interface AuditRecord {
  lastUsedAt?: string
  lastDeniedAt?: string
  lastRequested?: RequestedScope
  denialCount: number
  authorizationOrigin?: 'explicit-user' | 'certified-implicit'
  authorizationReason?: string
  certification?: CordisXCertifiedPermissionProjectionV1
}

export interface PlatformPermissionSnapshot {
  readonly identity: CordisXPluginIdentity
  readonly capability: CordisXPermissionCapabilityV4 | 'ui.extension-points.interact'
  readonly required: boolean
  readonly reason: CordisXLocalizedText
  readonly scope: CordisXPermissionScopeV4
  readonly fingerprint: string
  readonly policy: CordisXPermissionPolicy
  readonly lastRequested?: RequestedScope
  readonly lastUsedAt?: string
  readonly lastDeniedAt?: string
  readonly denialCount: number
  readonly blockedReason?: string
  readonly authorizationOrigin?: 'explicit-user' | 'certified-implicit'
  readonly authorizationReason?: string
  readonly certification?: CordisXCertifiedPermissionProjectionV1
}

export interface PermissionArtifactBindingV3 {
  readonly version: string
  readonly integrity: `sha256:${string}`
}

export interface RegistrationArtifactBinding extends PermissionArtifactBindingV3 {
  readonly certification?: CordisXCertifiedPermissionProjectionV1
}

export interface DomPermissionAccessDecision {
  readonly authorized: boolean
  readonly state: 'allowed' | 'denied' | 'pending'
  readonly reason: string
  readonly policy: 'inherit' | 'allow' | 'deny'
  readonly authorizationOrigin?: 'explicit-user' | 'certified-implicit'
}

export interface DomPermissionPolicyEntry {
  readonly identity: CordisXPluginIdentity
  readonly pointId: string
  readonly policy: 'inherit' | 'allow' | 'deny'
}

export interface Registration {
  readonly token: object
  readonly identity: CordisXPluginIdentity
  readonly manifest:
    | CordisXPluginManifestV1
    | CordisXPluginManifestV4
    | CordisXPluginManifestV5
    | CordisXPluginManifestV6
    | CordisXPluginManifestV7
    | CordisXPluginManifestV8
    | CordisXPluginManifestV9
    | CordisXPluginManifestV10
  readonly declarations: ReadonlyMap<CordisXPlatformCapability, CordisXCapabilityDeclaration>
  readonly declarationsV2: ReadonlyMap<CordisXPermissionCapabilityV2, CordisXCapabilityDeclarationV2>
  readonly declarationsV4: ReadonlyMap<'ui.host-dom.read' | 'ui.host-dom.modify', CordisXCapabilityDeclarationV4>
  readonly generation: PluginGenerationEffectIdentity
  readonly candidateView?: PluginGenerationView
  readonly artifact?: RegistrationArtifactBinding
}

export interface DomPermissionLease {
  readonly key: CordisXPermissionAuthorizationKeyV3
  readonly runtimeGeneration: string
  readonly moduleGeneration?: string
  readonly authorizationOrigin: 'explicit-user' | 'certified-implicit'
  readonly certificationFingerprint?: `sha256:${string}`
  readonly certificationRevision?: string
}

export interface HostDomPermissionLease {
  readonly leaseId: string
  readonly key: CordisXPermissionAuthorizationKeyV4
  readonly runtimeGeneration: string
  readonly moduleGeneration?: string
  readonly authorizationOrigin: 'explicit-user' | 'certified-implicit'
  readonly certificationFingerprint?: `sha256:${string}`
  readonly certificationRevision?: string
}

export interface HostDomPermissionAccessDecision extends DomPermissionAccessDecision {
  readonly lease?: HostDomPermissionLease
}

export function manifestDeclarationsV2(
  manifest:
    | CordisXPluginManifestV1
    | CordisXPluginManifestV4
    | CordisXPluginManifestV5
    | CordisXPluginManifestV6
    | CordisXPluginManifestV7
    | CordisXPluginManifestV8
    | CordisXPluginManifestV9
    | CordisXPluginManifestV10,
): readonly CordisXCapabilityDeclarationV2[] {
  if (manifest.schemaVersion === 4) return manifest.capabilities
  if (
    manifest.schemaVersion === 5 || manifest.schemaVersion === 6 || manifest.schemaVersion === 7
    || manifest.schemaVersion === 8 || manifest.schemaVersion === 9 || manifest.schemaVersion === 10
  ) {
    return manifest.capabilities.filter(item => (
      !isHostDomPermissionCapability(item.name) && !isAgentRuntimePermission(item.name)
      && item.name !== 'ui.extension-points.interact' && item.name !== 'ui.extension-points.render'
    )) as readonly CordisXCapabilityDeclarationV2[]
  }
  return Object.freeze(manifest.capabilities.map(declaration =>
    Object.freeze({
      name: declaration.name as CordisXPermissionCapabilityV2,
      required: declaration.required,
      scope: declaration.scope as CordisXPermissionScopeV2,
    })
  ))
}

export function manifestHostDomDeclarationsV4(
  manifest:
    | CordisXPluginManifestV1
    | CordisXPluginManifestV4
    | CordisXPluginManifestV5
    | CordisXPluginManifestV6
    | CordisXPluginManifestV7
    | CordisXPluginManifestV8
    | CordisXPluginManifestV9
    | CordisXPluginManifestV10,
): readonly CordisXCapabilityDeclarationV4[] {
  return manifest.schemaVersion === 5 || manifest.schemaVersion === 6 || manifest.schemaVersion === 7
      || manifest.schemaVersion === 8 || manifest.schemaVersion === 9 || manifest.schemaVersion === 10
    ? manifest.capabilities.filter(item =>
      isHostDomPermissionCapability(item.name)
    ) as readonly CordisXCapabilityDeclarationV4[]
    : Object.freeze([])
}

export function isAgentRuntimePermission(value: string): value is AgentRuntimeCapability {
  return value.startsWith('agents.') || value.startsWith('sessions.') || value.startsWith('approvals.')
}

export /** The legacy v4 review UI has no Agent/Session vocabulary; those declarations
 * are evaluated by the Host-private exact Session lease authority instead. */
function permissionPlanDeclarations(
  manifest:
    | CordisXPluginManifestV1
    | CordisXPluginManifestV4
    | CordisXPluginManifestV5
    | CordisXPluginManifestV6
    | CordisXPluginManifestV7
    | CordisXPluginManifestV8
    | CordisXPluginManifestV9
    | CordisXPluginManifestV10,
): readonly CordisXCapabilityDeclarationV4[] {
  return (manifest.schemaVersion === 5 || manifest.schemaVersion === 6 || manifest.schemaVersion === 7
      || manifest.schemaVersion === 8 || manifest.schemaVersion === 9 || manifest.schemaVersion === 10
    ? manifest.capabilities.filter(item =>
      !isAgentRuntimePermission(item.name)
      && item.name !== 'ui.extension-points.interact' && item.name !== 'ui.extension-points.render'
    )
    : manifest.capabilities) as readonly CordisXCapabilityDeclarationV4[]
}

export interface AuthorizationGrant {
  readonly declaration: CordisXCapabilityDeclaration
}

export function normalizedPath(value: string): string {
  const slashed = value.replaceAll('\\', '/')
  const prefix = /^[a-zA-Z]:\//.test(slashed) ? slashed.slice(0, 2).toLowerCase() : ''
  const body = prefix === '' ? slashed : slashed.slice(2)
  const parts = body.split('/').filter(part => part !== '' && part !== '.')
  const result: string[] = []
  for (const part of parts) part === '..' ? result.pop() : result.push(part)
  return `${prefix}${body.startsWith('/') ? '/' : ''}${result.join('/')}`.replace(/\/$/, '') || '/'
}

export function pathInside(value: string, root: string): boolean {
  const target = normalizedPath(value)
  const base = normalizedPath(root)
  const insensitive = /^[a-z]:\//.test(target) || /^[a-z]:\//.test(base)
  const left = insensitive ? target.toLowerCase() : target
  const right = insensitive ? base.toLowerCase() : base
  return left === right || left.startsWith(right === '/' ? '/' : `${right}/`)
}

export function scopeAllows(scope: CordisXCapabilityScope, requested: RequestedScope): boolean {
  if (
    requested.providerId !== undefined && scope.providers !== undefined
    && !scope.providers.includes(requested.providerId)
  ) return false
  if (
    requested.providerIds !== undefined && scope.providers !== undefined
    && requested.providerIds.some(id => !scope.providers?.includes(id))
  ) return false
  if (
    requested.model !== undefined && scope.providers !== undefined
    && !scope.providers.includes(requested.model.providerId)
  ) return false
  if (
    requested.session !== undefined && scope.sessions !== undefined && !scope.sessions.some(ref => {
      return ref.providerId === requested.session?.providerId
        && ref.remoteSessionId === requested.session.remoteSessionId
    })
  ) return false
  if (
    requested.cwd !== undefined && scope.cwdRoots !== undefined
    && !scope.cwdRoots.some(root => pathInside(requested.cwd as string, root))
  ) return false
  if (
    requested.agentSessionId !== undefined && scope.sessionIds !== undefined
    && !scope.sessionIds.includes(requested.agentSessionId)
  ) return false
  if (requested.allAgentSessions === true && scope.sessionIds !== undefined) return false
  return true
}

export function requestedSnapshot(requested: RequestedScope): RequestedScope {
  return Object.freeze({
    ...(requested.providerId === undefined ? {} : { providerId: requested.providerId }),
    ...(requested.providerIds === undefined ? {} : { providerIds: Object.freeze([...requested.providerIds]) }),
    ...(requested.cwd === undefined ? {} : { cwd: requested.cwd }),
    ...(requested.model === undefined ? {} : { model: Object.freeze({ ...requested.model }) }),
    ...(requested.session === undefined ? {} : { session: Object.freeze({ ...requested.session }) }),
    ...(requested.adapterGeneration === undefined ? {} : { adapterGeneration: requested.adapterGeneration }),
    ...(requested.agentSessionId === undefined ? {} : { agentSessionId: requested.agentSessionId }),
    ...(requested.allAgentSessions === true ? { allAgentSessions: true as const } : {}),
  })
}

export function isoNow(now: () => Date): string {
  return now().toISOString()
}

/** Host-only Agent/Session authorization inputs. They are never projected to plugins. */
export type AgentRuntimeConnection = Readonly<{ connectionId: string; generation: number }>

export type AgentRuntimeRouteScope = Readonly<{
  kind: 'host-route'
  active: true
  owner: { source: string; pluginId: string }
  routeId: string
  routeInstanceId: string
  path: string
  params: Readonly<{ sessionId: string }>
}>

export type AgentRuntimeScopeSource =
  | Readonly<
    {
      kind: 'host-route'
      routeInstanceId: string
      routeId: string
      path: string
      params: Readonly<{ sessionId: string }>
    }
  >
  | Readonly<{ kind: 'host-create'; reservedSessionId: string }>
  | Readonly<{ kind: 'host-exact'; exactSessionId: string }>

export type AgentRuntimePermissionFence = Readonly<{
  identity: CordisXPluginIdentity
  sessionId: string
  code: 'route-replaced' | 'plugin-generation-replaced' | 'permission-revoked' | 'connection-replaced'
}>

export type AgentRuntimeLease = Readonly<{ leaseId: string; sessionId: string }>

export type DevelopmentAgentRuntimePolicySeedAuthority = object

export type DevelopmentAgentRuntimeAuthorizationAuthority = object

export type PlaygroundScenarioAgentRuntimeRouteAuthority = object

export type AgentRuntimeAuthorization = Readonly<{
  authorized: boolean
  lease?: AgentRuntimeLease
}>

export interface AgentRuntimeLeaseRecord {
  readonly lease: AgentRuntimeLease
  readonly identity: CordisXPluginIdentity
  readonly capability: AgentRuntimeCapability
  readonly connection: AgentRuntimeConnection
  readonly routeInstanceId?: string
  /** The requester route may be distinct from a v8-approved authority Session. */
  readonly routeSessionId?: string
  readonly moduleGeneration?: string
}

export function validAgentRuntimeOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
}

export function validAgentRuntimeSessionId(value: unknown): value is string {
  return validAgentRuntimeOpaqueId(value) && !value.includes('*')
}

export function validAgentRuntimeConnection(value: AgentRuntimeConnection): boolean {
  return validAgentRuntimeOpaqueId(value.connectionId) && Number.isSafeInteger(value.generation)
    && value.generation >= 0
}

export function validAgentRuntimeRoute(value: AgentRuntimeRouteScope): boolean {
  return value.kind === 'host-route' && value.active === true
    && validAgentRuntimeOpaqueId(value.owner.source) && validAgentRuntimeOpaqueId(value.owner.pluginId)
    && validAgentRuntimeOpaqueId(value.routeId) && validAgentRuntimeOpaqueId(value.routeInstanceId)
    && validAgentRuntimeOpaqueId(value.path) && validAgentRuntimeSessionId(value.params.sessionId)
}

export function agentRuntimeIdentityKey(value: Readonly<{ source: string; pluginId: string }>): string {
  return `${value.source}\u0000${value.pluginId}`
}

export function sameAgentRuntimeConnection(
  left: AgentRuntimeConnection | undefined,
  right: AgentRuntimeConnection | undefined,
): boolean {
  return left?.connectionId === right?.connectionId && left?.generation === right?.generation
}

export function sameAgentRuntimeRoute(left: AgentRuntimeRouteScope, right: AgentRuntimeRouteScope): boolean {
  return left.owner.source === right.owner.source && left.owner.pluginId === right.owner.pluginId
    && left.routeId === right.routeId && left.routeInstanceId === right.routeInstanceId
    && left.path === right.path && left.params.sessionId === right.params.sessionId
}

export function isHostRouteSessionScopeBinding(
  value: unknown,
): value is Readonly<{ kind: 'host-route-param'; routeId: string; param: 'sessionId' }> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => key === 'kind' || key === 'routeId' || key === 'param')
    && (value as { kind?: unknown }).kind === 'host-route-param'
    && typeof (value as { routeId?: unknown }).routeId === 'string'
    && (value as { param?: unknown }).param === 'sessionId'
}

export /** The v8 answer declaration binds a distinct authority only to its requester route. */
function isApprovalAuthorityRequesterRouteScope(value: unknown): value is Readonly<{
  kind: 'approval-authority-requester-route'
  requester: Readonly<{ kind: 'host-route-param'; routeId: string; param: 'sessionId' }>
}> {
  if (
    value === null || typeof value !== 'object' || Array.isArray(value)
    || !Object.keys(value).every(key => key === 'kind' || key === 'requester')
    || (value as { kind?: unknown }).kind !== 'approval-authority-requester-route'
  ) return false
  const requester = (value as { requester?: unknown }).requester
  return isHostRouteSessionScopeBinding(requester)
}
