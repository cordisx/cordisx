export { normalizePluginManifest, platformIdentityKey } from './platform/platform-manifest.js'
export {
  BrowserPermissionAuthorizationPromptV2,
  BrowserPermissionPolicyStore,
  BrowserPermissionPrompt,
  type LegacyStoredPolicy,
  MemoryPermissionPolicyStore,
  type PermissionAuthorizationProjectionFactoryV2,
  type PermissionAuthorizationPromptV2,
  type PermissionPolicyStore,
  type PermissionPrompt,
  type PermissionPromptRequest,
  type RequestedScope,
} from './platform/platform-permission-store.js'
export {
  type AgentRuntimeAuthorization,
  type AgentRuntimeConnection,
  type AgentRuntimeLease,
  type AgentRuntimePermissionFence,
  type AgentRuntimeRouteScope,
  type AgentRuntimeScopeSource,
  type DevelopmentAgentRuntimePolicySeedAuthority,
  type DomPermissionAccessDecision,
  type DomPermissionPolicyEntry,
  type HostDomPermissionAccessDecision,
  type HostDomPermissionLease,
  type PermissionArtifactBindingV3,
  type PlatformPermissionSnapshot,
  type PlaygroundScenarioAgentRuntimeRouteAuthority,
} from './platform/platform-permission-types.js'
export { PermissionBroker } from './platform/platform-permission-broker.js'
export {
  type CordisXExactProviderAdapter,
  type CordisXPlatformAdapter,
  type CordisXPlatformProjection,
  type CordisXPlatformProjectionSource,
  CordisXPlatformService,
  type CordisXPlatformServiceOptions,
  ProjectionPlatformAdapter,
  UnavailablePlatformAdapter,
} from './platform/platform-service.js'
