type CordisXJsonScalar = string | number | boolean | null

export const CORDISX_HOST_EXTENSION_POINT_CONTROL_CATALOG_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/host-extension-point-control-catalog.v1.schema.json' as const
export const CORDISX_EXTENSION_POINT_CONTROL_DECLARATION_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/extension-point-control-declaration.v1.schema.json' as const
export const CORDISX_EXTENSION_POINT_CONTROL_AUTHORIZATION_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/extension-point-control-authorization.v1.schema.json' as const
export const CORDISX_EXTENSION_POINT_CONTROL_SNAPSHOT_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/extension-point-control-snapshot.v1.schema.json' as const
export const CORDISX_EXTENSION_POINT_CONTROL_ACCESS_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/extension-point-control-access.v1.schema.json' as const
export const CORDISX_EXTENSION_POINT_CONTROL_RESULT_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/extension-point-control-result.v1.schema.json' as const
export const CORDISX_EXTENSION_POINT_CONTROL_EVENT_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/extension-point-control-event.v1.schema.json' as const

export type CordisXExtensionPointControlMode = 'compose' | 'replace' | 'overlay' | 'proxy' | 'hide-native'
export type CordisXExtensionPointControlReason = string
export type CordisXExtensionPointControlValueType = 'string' | 'number' | 'integer' | 'boolean'

export interface CordisXExtensionPointControlIdentityV1 {
  readonly source: string
  readonly pluginId: string
  readonly pointId: string
}

export interface CordisXExtensionPointControlSafeValueSchemaV1 {
  readonly type: CordisXExtensionPointControlValueType
  readonly nullable?: boolean
  readonly enum?: readonly CordisXJsonScalar[]
}

export interface CordisXExtensionPointControlArgumentV1 {
  readonly id: string
  readonly schema: CordisXExtensionPointControlSafeValueSchemaV1
  readonly required: boolean
}

export interface CordisXHostExtensionPointControlCatalogV1 {
  readonly $schema: typeof CORDISX_HOST_EXTENSION_POINT_CONTROL_CATALOG_SCHEMA_V1
  readonly schemaVersion: 1
  readonly points: readonly CordisXHostExtensionPointControlPointV1[]
}

export interface CordisXHostExtensionPointControlPointV1 {
  readonly id: string
  readonly parentPointId?: string
  readonly modes: readonly {
    readonly id: CordisXExtensionPointControlMode
    readonly stacking: 'ordered' | 'exclusive'
    readonly exclusiveGroup?: string
    readonly coexistsWith: readonly CordisXExtensionPointControlMode[]
    readonly defaultAuthorization: 'allow' | 'deny'
  }[]
  readonly exclusiveGroups: readonly {
    readonly id: string
    readonly modes: readonly CordisXExtensionPointControlMode[]
    readonly cardinality: 'one'
    readonly selection: 'user' | 'host-priority'
    readonly nativeFallback: boolean
  }[]
  readonly safeProperties: readonly {
    readonly id: string
    readonly schema: CordisXExtensionPointControlSafeValueSchemaV1
    readonly visibility: 'renderer-safe'
    readonly mutable: false
  }[]
  readonly safeCommands: readonly {
    readonly id: string
    readonly dispatch: 'host-brokered'
    readonly arguments: readonly CordisXExtensionPointControlArgumentV1[]
  }[]
  readonly safeEvents: readonly {
    readonly id: string
    readonly delivery: 'host-projected'
    readonly payload: readonly CordisXExtensionPointControlArgumentV1[]
  }[]
  readonly ownership: {
    readonly scope: 'point' | 'subtree'
    readonly suppressesDescendantsWhenModes: readonly CordisXExtensionPointControlMode[]
  }
}

export interface CordisXExtensionPointControlRequestedBindingsV1 {
  readonly properties: readonly string[]
  readonly commands: readonly string[]
  readonly events: readonly string[]
}

export interface CordisXExtensionPointControlDeclarationV1 {
  readonly $schema: typeof CORDISX_EXTENSION_POINT_CONTROL_DECLARATION_SCHEMA_V1
  readonly schemaVersion: 1
  readonly principalHandle: string
  readonly origin: 'explicit' | 'legacy-structured'
  readonly identity: CordisXExtensionPointControlIdentityV1
  readonly claimId: string
  readonly contributionId: string
  readonly mode: CordisXExtensionPointControlMode
  readonly priority: number
  readonly legacyOrder?: number
  readonly requestedBindings: CordisXExtensionPointControlRequestedBindingsV1
}

export interface CordisXExtensionPointControlAuthorizationV1 {
  readonly $schema: typeof CORDISX_EXTENSION_POINT_CONTROL_AUTHORIZATION_SCHEMA_V1
  readonly schemaVersion: 1
  readonly principalHandle: string
  readonly identity: CordisXExtensionPointControlIdentityV1
  readonly claimId: string
  readonly mode: CordisXExtensionPointControlMode
  readonly policy: 'inherit' | 'allow' | 'deny'
}

export interface CordisXExtensionPointControlClaimReferenceV1 {
  readonly principalHandle: string
  readonly identity: CordisXExtensionPointControlIdentityV1
  readonly claimId: string
  readonly mode: CordisXExtensionPointControlMode
}

export interface CordisXExtensionPointControlBindingsProjectionV1 {
  readonly properties: readonly { readonly id: string; readonly value: CordisXJsonScalar }[]
  readonly commands: readonly { readonly id: string; readonly available: boolean; readonly reason?: string }[]
  readonly events: readonly { readonly id: string; readonly available: boolean; readonly reason?: string }[]
}

export interface CordisXExtensionPointControlCandidateSnapshotV1 {
  readonly principalHandle: string
  readonly origin: 'explicit' | 'legacy-structured'
  readonly identity: CordisXExtensionPointControlIdentityV1
  readonly claimId: string
  readonly contributionId: string
  readonly mode: CordisXExtensionPointControlMode
  readonly priority: number
  readonly authorization: 'allowed' | 'denied'
  readonly state: 'selected' | 'eligible' | 'denied' | 'conflicted' | 'suppressed' | 'pending'
  readonly reason: string
  readonly selection?: {
    readonly authority: 'host-policy' | 'user'
    readonly hostGeneration: string
    readonly exclusiveGroup?: string
    readonly rank?: number
    readonly reason: string
  }
  readonly bindings?: CordisXExtensionPointControlBindingsProjectionV1
}

export interface CordisXExtensionPointControlPointSnapshotV1 {
  readonly id: string
  readonly state: 'active' | 'inactive' | 'not-mounted' | 'suppressed' | 'pending'
  readonly reason: string
  readonly candidates: readonly CordisXExtensionPointControlCandidateSnapshotV1[]
  readonly groupDecisions: readonly {
    readonly groupId: string
    readonly outcome: 'selected' | 'native' | 'none'
    readonly selectedClaim?: CordisXExtensionPointControlClaimReferenceV1
    readonly authority: 'host-policy' | 'user'
    readonly hostGeneration: string
    readonly reason: string
  }[]
  readonly suppression?: {
    readonly kind: 'ancestor-ownership'
    readonly ancestorPointId: string
    readonly ancestorClaim: CordisXExtensionPointControlClaimReferenceV1
    readonly path: readonly string[]
    readonly hostGeneration: string
    readonly reason: string
  }
}

export interface CordisXExtensionPointControlSnapshotV1 {
  readonly $schema: typeof CORDISX_EXTENSION_POINT_CONTROL_SNAPSHOT_SCHEMA_V1
  readonly schemaVersion: 1
  readonly authority: 'host'
  readonly hostGeneration: string
  readonly revision: number
  readonly points: readonly CordisXExtensionPointControlPointSnapshotV1[]
}

export interface CordisXExtensionPointControlAccessV1 {
  readonly $schema: typeof CORDISX_EXTENSION_POINT_CONTROL_ACCESS_SCHEMA_V1
  readonly schemaVersion: 1
  readonly principalHandle: string
  readonly invocationId: string
  readonly hostGeneration: string
  readonly operation: 'point.host-command.invoke'
  readonly identity: CordisXExtensionPointControlIdentityV1
  readonly claimId: string
  readonly contributionId: string
  readonly mode: CordisXExtensionPointControlMode
  readonly commandId: string
  readonly arguments: Readonly<Record<string, CordisXJsonScalar>>
}

export interface CordisXExtensionPointControlResultV1 {
  readonly $schema: typeof CORDISX_EXTENSION_POINT_CONTROL_RESULT_SCHEMA_V1
  readonly schemaVersion: 1
  readonly authority: 'host'
  readonly invocationId: string
  readonly hostGeneration: string
  readonly revision: number
  readonly outcome: 'accepted' | 'rejected'
  readonly reason: string
}

export interface CordisXExtensionPointControlEventV1 {
  readonly $schema: typeof CORDISX_EXTENSION_POINT_CONTROL_EVENT_SCHEMA_V1
  readonly schemaVersion: 1
  readonly authority: 'host'
  readonly principalHandle: string
  readonly hostGeneration: string
  readonly sequence: number
  readonly identity: CordisXExtensionPointControlIdentityV1
  readonly claimId: string
  readonly contributionId: string
  readonly mode: CordisXExtensionPointControlMode
  readonly eventId: string
  readonly payload: Readonly<Record<string, CordisXJsonScalar>>
}
