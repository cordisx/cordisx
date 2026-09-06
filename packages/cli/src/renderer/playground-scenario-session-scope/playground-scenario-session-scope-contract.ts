import type { AgentRuntimeCapability } from '@cordisx/protocol/agents/v1'
import type { PluginOwnerIdentity } from '@cordisx/protocol/sessions/v1'
import type { AgentCommandOrigin } from '@cordisx/protocol/agent-admission/v2'
import type { AgentBootstrapCommandOrigin } from '@cordisx/protocol/agent-admission/v4'
import type { AgentAdmissionBootstrapRoomTargetReceipt } from '@cordisx/protocol/agent-admission/v5'
import type {
  AgentAdmissionBootstrapRouteBinding,
  AgentAdmissionBootstrapRouteClaimReceipt,
  AgentAdmissionBootstrapRouteClaimRequest,
  AgentAdmissionBootstrapRouteClaimResult,
  AgentAdmissionBootstrapRouteContinuation,
  AgentAdmissionBootstrapRouteTarget,
} from '@cordisx/protocol/agent-admission/v6'
import type {
  AgentPageAdmissionRouteClaimReceipt,
  AgentPageAdmissionRouteTarget,
  AgentPageAdmissionTarget,
  AgentPageComposerOrigin,
} from '@cordisx/protocol/agent-page-admission/v2'
import type { AgentRuntimeRouteScope } from '../platform.js'

export type PlaygroundScenarioSessionScopeClosedCode =
  | 'completed'
  | 'route-replaced'
  | 'plugin-generation-replaced'
  | 'permission-revoked'
  | 'connection-replaced'
  | 'authorization-unavailable'
  | 'disposed'

export interface PlaygroundScenarioSessionScopeHandle {
  readonly runId: string
  readonly sessionId: string
  readonly routeInstanceId: string
  readonly closed: Promise<Readonly<{ readonly code: PlaygroundScenarioSessionScopeClosedCode }>>
  active(): boolean
  close(): void
}

export type PlaygroundScenarioSessionScopeActivationResult =
  | Readonly<{ status: 'available'; handle: PlaygroundScenarioSessionScopeHandle }>
  | Readonly<{
    status: 'unavailable'
    code:
      | 'invalid-request'
      | 'source-route-unavailable'
      | 'session-unavailable'
      | 'owner-mismatch'
      | 'activation-conflict'
      | 'route-unavailable'
      | 'authorization-unavailable'
      | 'stale'
      | 'disposed'
    message: string
  }>

export interface PlaygroundScenarioSessionScopeClient {
  activate(
    input: Readonly<{
      runId: string
      sourceMessageId: string
      sourceSessionId: string
      targetSessionId: string
    }>,
  ): Promise<PlaygroundScenarioSessionScopeActivationResult>
  release(input: Readonly<{ sourceMessageId: string; sourceSessionId: string; runId: string }>): void
}

export interface PlaygroundScenarioConversationOrigin {
  /** Full Host-recorded plugin identity; plugin id alone never spans generations. */
  readonly owner: PluginOwnerIdentity
  readonly bindingId: string
  readonly ownerGeneration: string
  readonly snapshotGeneration: string
  /** Undefined only for a Shell v9 new-Room bootstrap command. */
  readonly roomId?: string
  readonly routeId: string
  readonly runs: readonly Readonly<{
    readonly runId: string
    readonly sessionId: string
    readonly participantId?: string
    readonly memberId?: string
  }>[]
  readonly active: () => boolean
  /** Present only for Shell v8: capability created by Host command admission. */
  readonly admissionOrigin?: AgentCommandOrigin
  /** Present only for Shell v9: Host capability minted before any Room run exists. */
  readonly bootstrapOrigin?: AgentBootstrapCommandOrigin
}

/** Host Shell only; never projected through plugin context. */
export interface PlaygroundScenarioConversationSourceAuthority {
  execute<Value>(origin: PlaygroundScenarioConversationOrigin, operation: () => Promise<Value>): Promise<Value>
  fenceBinding(bindingId: string, code: PlaygroundScenarioSessionScopeClosedCode): void
  /** Host-only v6 transfer at a matching Room route mount; never exposed to plugins. */
  claimBootstrapRoute(input: PlaygroundScenarioBootstrapRouteActivation): void
}

/** Host-generated route binding presented only by the Shell mount lifecycle. */
export interface PlaygroundScenarioBootstrapRouteActivation {
  readonly owner: PluginOwnerIdentity
  readonly binding: AgentAdmissionBootstrapRouteBinding
  readonly active: () => boolean
}

export interface PlaygroundScenarioSubmissionCapture {
  /** True only while the exact command/owner/connection source authority remains live. */
  active(): boolean
  commit(): void
  close(): void
}

export interface PlaygroundScenarioSessionScopeAuthorityOptions {
  readonly hostGeneration: string
  readonly connectionGeneration: () => number
  /** Legacy exact route fallback for non-Shell Host callers. */
  readonly currentRoute: () => AgentRuntimeRouteScope | undefined
  /** The exact live Agent owner for source and target Sessions. */
  readonly ownerForSession: (sessionId: string) => PluginOwnerIdentity | undefined
  /** Host-only authenticated mapping; never derive source coordinates from an opaque owner string. */
  readonly routeOwner: (owner: PluginOwnerIdentity) => AgentRuntimeRouteScope['owner'] | undefined
  /** Resolves only the installed dynamic declaration owned by this plugin. */
  readonly permissionRoute: (owner: PluginOwnerIdentity, capability: AgentRuntimeCapability) =>
    | Readonly<{
      readonly routeId: string
      readonly path: string
    }>
    | undefined
  readonly authorize: (
    owner: PluginOwnerIdentity,
    capability: AgentRuntimeCapability,
    sessionId: string,
  ) => Promise<boolean>
  /** Mounts a supplemental exact route in the existing PermissionBroker. */
  readonly mountRoute: (route: AgentRuntimeRouteScope) => () => void
  /** Reconcile the single normal permission/route authority after a change. */
  readonly changed: (active: boolean) => void
  /** Validates one exact same-owner registered Room route before v6 declaration. */
  readonly bootstrapRouteRegistered?: (
    owner: PluginOwnerIdentity,
    target: AgentAdmissionBootstrapRouteTarget,
  ) => boolean
  /** Calls the Host-only v6 continuation claim; plugins never receive this seam. */
  readonly claimBootstrapRoute?: (
    owner: PluginOwnerIdentity,
    request: AgentAdmissionBootstrapRouteClaimRequest,
  ) => AgentAdmissionBootstrapRouteClaimResult
}

export interface ConversationOriginRecord extends PlaygroundScenarioConversationOrigin {
  readonly token: object
}

export interface CapturedSourceRecord {
  readonly kind: 'conversation'
  readonly key: string
  readonly origin: ConversationOriginRecord
  readonly owner: PluginOwnerIdentity
  readonly sourceMessageId: string
  readonly sourceSessionId: string
  readonly roomRunId: string
  readonly permissionRoute: Readonly<{ readonly routeId: string; readonly path: string }>
  readonly connectionGeneration: number
  /** V5 is retained only for this current binding; it never enables a route transfer. */
  readonly bootstrapRoomReceipt?: AgentAdmissionBootstrapRoomTargetReceipt
  active: boolean
  committed: boolean
  routeContinuation?: {
    readonly continuation: AgentAdmissionBootstrapRouteContinuation
    readonly target: AgentAdmissionBootstrapRouteTarget
    readonly origin: AgentBootstrapCommandOrigin
    state: 'captured' | 'pending-route-claim' | 'claimed'
    receipt?: AgentAdmissionBootstrapRouteClaimReceipt
    rebound?: PlaygroundScenarioBootstrapRouteActivation
  }
  scenarioRunId?: string
}

export /**
 * Host-only page-composer source. It is separate from Shell command origins:
 * a plugin can never invoke a claim or supply this liveness callback.
 */
interface PageCapturedSourceRecord {
  readonly kind: 'page'
  readonly key: string
  readonly owner: PluginOwnerIdentity
  readonly origin: AgentPageComposerOrigin
  readonly target: AgentPageAdmissionTarget | AgentPageAdmissionRouteTarget
  /** Mount liveness after the command settles; distinct from pre-submit command liveness. */
  readonly originActive: () => boolean
  readonly commandActive: () => boolean
  readonly sourceMessageId: string
  readonly sourceSessionId: string
  readonly roomRunId: string
  readonly permissionRoute: Readonly<{ readonly routeId: string; readonly path: string }>
  readonly connectionGeneration: number
  readonly fresh: boolean
  claimed?: {
    readonly receipt: AgentPageAdmissionRouteClaimReceipt
    readonly active: () => boolean
  }
  active: boolean
  committed: boolean
  scenarioRunId?: string
}

export type CapturedScenarioSource = CapturedSourceRecord | PageCapturedSourceRecord

export interface ActivationRecord {
  readonly runId: string
  readonly source: CapturedScenarioSource | undefined
  readonly sourceSessionId: string
  readonly targetSessionId: string
  readonly route: AgentRuntimeRouteScope
  readonly handle: PlaygroundScenarioSessionScopeHandle
  readonly disposeRoute: () => void
  readonly settle: (value: Readonly<{ readonly code: PlaygroundScenarioSessionScopeClosedCode }>) => void
  active: boolean
}

export function opaque(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && value !== '*'
}

export function sameOwner(left: PluginOwnerIdentity | undefined, right: PluginOwnerIdentity): boolean {
  return left !== undefined && left.pluginId === right.pluginId && left.generation === right.generation
}

export function sourceKey(sessionId: string, messageId: string): string {
  return `${sessionId}\u0000${messageId}`
}
