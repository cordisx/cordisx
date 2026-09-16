import type { PluginManifestManagedBackendServiceV14 } from '@cordisx/protocol/plugin-manifest/v14'
import type {
  ManagedServiceBindingV1,
  ManagedServiceControlResultV1,
  ManagedServiceDefinitionV1,
  ManagedServiceDiagnosticV1,
  ManagedServiceLeaseV1,
  ManagedServiceOwnerV1,
  ManagedServiceProjectionV1,
  ManagedServiceSafeValueV1,
} from '@cordisx/protocol/managed-service-runtime/v1'
import type { ChildProcess } from 'node:child_process'
import type { ManagedServiceSchemaRegistry } from './managed-service-schema.js'

export interface ManagedServiceActivationAccess {
  readonly owner: ManagedServiceOwnerV1
  readonly source: `https://${string}`
  readonly declaration: PluginManifestManagedBackendServiceV14
  readonly artifactDirectory: string
  readonly runtimeResources?: readonly {
    readonly path: `./${string}`
    readonly mode: 'executable' | 'data'
    readonly byteLength: number
    readonly digest: `sha256:${string}`
  }[]
}

export interface ManagedServiceClientState {
  readonly key: string
  readonly pluginId: string
  readonly pluginGeneration: string
  active: boolean
  readonly leases: Set<string>
}

export interface ManagedServiceLeaseState {
  readonly client: ManagedServiceClientState
  readonly lease: ManagedServiceLeaseV1
}

export interface ManagedServiceMaterializationState {
  readonly handle: `msm_${string}`
  readonly revision: `sha256:${string}`
  readonly values: readonly {
    readonly slot: string
    readonly pointer: `/${string}` | undefined
    readonly value: ManagedServiceSafeValueV1
    readonly safeLiteral: boolean
  }[]
  readonly sources: readonly { readonly source: string; readonly binding: ManagedServiceBindingV1 }[]
}

interface ManagedServiceInvocationState {
  readonly leaseHandle: string
  readonly value: ManagedServiceSafeValueV1
}

export interface ManagedServiceRecord {
  readonly access: ManagedServiceActivationAccess
  readonly serviceHome: string
  readonly revision: `sha256:${string}`
  readonly definition: ManagedServiceDefinitionV1
  readonly schemas: ManagedServiceSchemaRegistry
  readonly environment: NodeJS.ProcessEnv
  readonly registrationHandle: `msr_${string}`
  readonly ownerHandle: string
  readonly lifecycle: AbortController
  readonly operations: Set<Promise<unknown>>
  binding: ManagedServiceBindingV1
  state: ManagedServiceProjectionV1['state']
  health: ManagedServiceProjectionV1['health']
  processOwnership: ManagedServiceProjectionV1['processOwnership']
  diagnostic: ManagedServiceDiagnosticV1 | undefined
  child: ChildProcess | undefined
  origin: string | undefined
  brokerHandle: `msb_${string}` | undefined
  authenticationHandle: `msa_${string}` | undefined
  authorizationHandle: `msa_${string}` | undefined
  readonly secrets: Map<string, string>
  readonly leases: Map<string, ManagedServiceLeaseState>
  readonly materializations: Map<string, ManagedServiceMaterializationState>
  selectedMaterialization: ManagedServiceMaterializationState | undefined
  readonly invocations: Map<string, ManagedServiceInvocationState>
  assignedPort: number | undefined
  preparing: Promise<ManagedServiceControlResultV1> | undefined
  restarting: Promise<ManagedServiceControlResultV1> | undefined
  healthMonitor: AbortController | undefined
  disposal: Promise<ManagedServiceControlResultV1> | undefined
  disposed: boolean
}

export function projectManagedServiceRecord(record: ManagedServiceRecord): ManagedServiceProjectionV1 {
  const materialization = record.selectedMaterialization
  const configuration: ManagedServiceProjectionV1['configuration'] = record.definition.configuration === undefined
    ? { state: 'not-required' }
    : materialization === undefined
    ? { state: 'missing' }
    : {
      state: 'materialized',
      materializationHandle: materialization.handle,
      revision: materialization.revision,
    }
  const authentication: ManagedServiceProjectionV1['authentication'] = record.definition.authentication.mode === 'none'
    ? { state: 'not-required' }
    : record.authenticationHandle === undefined
    ? { state: 'missing' }
    : { state: 'configured', sessionHandle: record.authenticationHandle }
  const httpAuthorization: ManagedServiceProjectionV1['httpAuthorization'] =
    record.definition.httpAuthentication.mode === 'none'
      ? { state: 'not-required' }
      : record.authorizationHandle === undefined
      ? { state: 'missing' }
      : { state: 'configured', authorizationHandle: record.authorizationHandle }
  return Object.freeze({
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-projection.v1.schema.json',
    contract: 'cordisx.managed-service-projection/v1',
    schemaVersion: 1,
    binding: record.binding,
    state: record.state,
    health: record.health,
    processOwnership: record.processOwnership,
    configuration,
    authentication,
    httpAuthorization,
    ...(record.brokerHandle === undefined ? {} : { connection: { brokerHandle: record.brokerHandle } }),
    ...(record.diagnostic === undefined ? {} : { diagnostic: record.diagnostic }),
  })
}
