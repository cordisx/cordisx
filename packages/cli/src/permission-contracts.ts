import type { CordisXLocalizedText } from './contracts.js'
import type { CordisXPlatformSessionRef } from './platform-contracts.js'

export const CORDISX_PLUGIN_MANIFEST_SCHEMA_V4 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v4.schema.json'
export const CORDISX_PLUGIN_PACKAGE_SCHEMA_V3 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-package.v3.schema.json'
export const CORDISX_PERMISSION_POLICY_SCHEMA_V2 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-policy.v2.schema.json'
export const CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V2 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-authorization-plan.v2.schema.json'
export const CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-authorization-decision.v2.schema.json'
export const CORDISX_PERMISSION_CAPABILITY_CATALOG_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-capability-catalog.v1.schema.json'

export const CORDISX_PERMISSION_CAPABILITIES_V2 = [
  'models.read',
  'tasks.catalog.read',
  'tasks.content.read',
  'tasks.create',
  'tasks.control',
  'turns.submit',
  'turns.control',
  'agent.events.read',
  'agent.history.read',
  'agent.messages.append',
  'agent.steps.reject',
  'agent.messages.transform',
  'agent.prompt.section',
  'agent.prompt.context',
  'channel.accounts.read',
  'channel.accounts.connect',
  'channel.events.receive',
  'channel.events.subscribe',
  'channel.messages.send',
  'channel.bindings.read',
  'channel.bindings.write',
  'channel.attachments.read',
] as const

export type CordisXPermissionCapabilityV2 = typeof CORDISX_PERMISSION_CAPABILITIES_V2[number]
export type CordisXPermissionSensitivity = 'low' | 'general' | 'sensitive' | 'high-risk'
export type CordisXPermissionPolicyV2 = 'ask' | 'allow-persistent' | 'deny-persistent'
export type CordisXPermissionDecisionV2 =
  | 'allow-once'
  | 'allow-persistent'
  | 'deny-once'
  | 'deny-persistent'

export interface CordisXChannelAccountRef {
  readonly adapterId: string
  readonly accountId: string
}

export interface CordisXChannelTenantRef extends CordisXChannelAccountRef {
  readonly tenantId: string
}

export interface CordisXChannelConversationRef extends CordisXChannelTenantRef {
  readonly conversationId: string
  readonly kind: 'direct' | 'group' | 'broadcast'
}

export interface CordisXChannelUserRef extends CordisXChannelTenantRef {
  readonly userId: string
}

export interface CordisXPermissionScopeV2 {
  readonly providers?: readonly string[]
  readonly cwdRoots?: readonly string[]
  readonly sessions?: readonly CordisXPlatformSessionRef[]
  readonly sessionIds?: readonly string[]
  readonly channelAccounts?: readonly CordisXChannelAccountRef[]
  readonly channelTenants?: readonly CordisXChannelTenantRef[]
  readonly channelConversations?: readonly CordisXChannelConversationRef[]
  readonly channelUsers?: readonly CordisXChannelUserRef[]
}

export interface CordisXPermissionRationaleV2 {
  readonly title: CordisXLocalizedText
  readonly description: CordisXLocalizedText
  readonly feature: CordisXLocalizedText
  readonly deniedBehavior: CordisXLocalizedText
}

export interface CordisXPermissionSecurityDeclarationV2 {
  readonly dataUse: 'ephemeral' | 'profile-persistent' | 'external-service'
  readonly retention: 'none' | 'runtime' | 'profile'
  readonly externalTransfer: boolean
}

export interface CordisXCapabilityDeclarationV2 {
  readonly name: CordisXPermissionCapabilityV2
  readonly required: boolean
  readonly rationale?: CordisXPermissionRationaleV2
  readonly security?: CordisXPermissionSecurityDeclarationV2
  readonly scope: CordisXPermissionScopeV2
}

export type CordisXPluginServiceConfigurationV4 =
  | { readonly kind: 'none' }
  | {
    readonly kind: 'host'
    readonly schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/channel-service-config.v1.schema.json'
    readonly configApplies: 'restart'
  }

export interface CordisXPluginServiceDeclarationV4 {
  readonly id: string
  readonly kind: 'channel-adapter'
  readonly entry: string
  readonly configuration: CordisXPluginServiceConfigurationV4
}

export interface CordisXPluginManifestV4 {
  readonly $schema: typeof CORDISX_PLUGIN_MANIFEST_SCHEMA_V4
  readonly schemaVersion: 4
  readonly id: string
  readonly name?: string
  readonly capabilities: readonly CordisXCapabilityDeclarationV2[]
  readonly services: readonly CordisXPluginServiceDeclarationV4[]
}

export interface CordisXPermissionIdentityV2 {
  readonly source: string
  readonly pluginId: string
}

export interface CordisXPermissionAuthorizationKeyV2 {
  readonly profileId: string
  readonly identity: CordisXPermissionIdentityV2
  readonly capability: CordisXPermissionCapabilityV2
  readonly scope: CordisXPermissionScopeV2
  readonly securityFingerprint: `sha256:${string}`
}

export interface CordisXPermissionPolicyRecordV2 {
  readonly $schema: typeof CORDISX_PERMISSION_POLICY_SCHEMA_V2
  readonly schemaVersion: 2
  readonly key: CordisXPermissionAuthorizationKeyV2
  readonly policy: CordisXPermissionPolicyV2
}

export interface CordisXPermissionAuthorizationBindingV2 {
  readonly operationId: string
  readonly runtimeGeneration: string
  readonly moduleGeneration?: string
  readonly requestId?: string
}

export interface CordisXPermissionHostPresentationV2 {
  readonly name: CordisXLocalizedText
  readonly description: CordisXLocalizedText
  readonly risk: CordisXLocalizedText
  readonly limitation: CordisXLocalizedText
}

export interface CordisXPermissionAuthorizationItemV2 {
  readonly capability: CordisXPermissionCapabilityV2
  readonly required: boolean
  readonly rationale?: CordisXPermissionRationaleV2
  readonly security?: CordisXPermissionSecurityDeclarationV2
  readonly scope: CordisXPermissionScopeV2
  readonly securityFingerprint: `sha256:${string}`
  readonly policy: CordisXPermissionPolicyV2
  readonly decisionRequired: boolean
  readonly sensitivity: CordisXPermissionSensitivity
  readonly persistentAllow: boolean
  readonly persistentDeny: boolean
  readonly allowedDecisions: readonly CordisXPermissionDecisionV2[]
  readonly defaultDecision: CordisXPermissionDecisionV2
  readonly presentation: CordisXPermissionHostPresentationV2
}

export interface CordisXPermissionAuthorizationPlanV2 {
  readonly $schema: typeof CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V2
  readonly schemaVersion: 2
  readonly planId: string
  readonly operation: 'install' | 'update' | 'enable' | 'runtime'
  readonly profileId: string
  readonly identity: CordisXPermissionIdentityV2
  readonly catalogVersion: string
  readonly binding: CordisXPermissionAuthorizationBindingV2
  readonly declarations: readonly CordisXPermissionAuthorizationItemV2[]
}

export interface CordisXPermissionAuthorizationDecisionItemV2 {
  readonly capability: CordisXPermissionCapabilityV2
  readonly scope: CordisXPermissionScopeV2
  readonly securityFingerprint: `sha256:${string}`
  readonly decision: CordisXPermissionDecisionV2
}

export interface CordisXPermissionAuthorizationDecisionV2 {
  readonly $schema: typeof CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2
  readonly schemaVersion: 2
  readonly planId: string
  readonly operation: CordisXPermissionAuthorizationPlanV2['operation']
  readonly profileId: string
  readonly identity: CordisXPermissionIdentityV2
  readonly binding: CordisXPermissionAuthorizationBindingV2
  readonly decisions: readonly CordisXPermissionAuthorizationDecisionItemV2[]
}
