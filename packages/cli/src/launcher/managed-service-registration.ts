import type { ManagedServiceDefinitionV1, ManagedServiceOwnerV1 } from '@cordisx/protocol/managed-service-runtime/v1'
import { managedServiceResourceMatchesTarget } from './managed-service-package-resources.js'
import { managedServiceEnvironment, managedServiceHome } from './managed-service-process.js'
import type { ManagedServiceSchemaRegistry } from './managed-service-schema.js'
import type { ManagedServiceActivationAccess, ManagedServiceRecord } from './managed-service-runtime-record.js'
import { managedHandle, managedIdentityKey } from './managed-service-runtime-support.js'

export async function registerManagedService(input: {
  readonly access: ManagedServiceActivationAccess
  readonly serviceGeneration: string
  readonly definition: ManagedServiceDefinitionV1
  readonly revision: `sha256:${string}`
  readonly schemas: ManagedServiceSchemaRegistry
  readonly homeDir: string
  readonly environment?: NodeJS.ProcessEnv
  readonly projectEnvironment?: (input: {
    readonly owner: ManagedServiceOwnerV1
    readonly serviceId: string
    readonly serviceHome: string
  }) => Promise<NodeJS.ProcessEnv>
  readonly records: Map<string, ManagedServiceRecord>
  readonly registrations: Map<string, ManagedServiceRecord>
  readonly pendingRegistrations: Map<string, Promise<ManagedServiceRecord>>
  readonly disposeRecord: (record: ManagedServiceRecord) => Promise<unknown>
}): Promise<ManagedServiceRecord> {
  const { access, definition, revision } = input
  await input.schemas.validateDefinition(definition)
  if (definition.serviceId !== access.declaration.id) throw new Error('managed service definition id mismatch')
  if (!/^sha256:[a-f0-9]{64}$/.test(revision)) throw new Error('managed service revision is invalid')
  if (!access.owner.sourceDigest.startsWith('sha256:')) throw new Error('managed service source digest is invalid')
  if (!access.owner.pluginId || !access.owner.pluginGeneration || !access.owner.hostGeneration) {
    throw new Error('managed service owner authority is incomplete')
  }
  const assignedDeliveries = definition.launch.arguments.filter(
    argument => typeof argument !== 'string' && argument.kind === 'host-assigned-loopback',
  ).length + definition.protectedBindings.filter(binding => binding.source === 'host-assigned-loopback').length
  if (
    (definition.discovery.kind === 'host-assigned-loopback' && assignedDeliveries !== 1)
    || (definition.discovery.kind !== 'host-assigned-loopback' && assignedDeliveries !== 0)
  ) throw new Error('managed service must declare exactly one Host-assigned loopback delivery')
  const identity = Object.freeze({
    source: access.source,
    pluginId: access.owner.pluginId,
    serviceId: definition.serviceId,
  })
  const key = managedIdentityKey(identity)
  while (true) {
    const pending = input.pendingRegistrations.get(key)
    if (pending !== undefined) {
      const record = await pending
      if (
        record.access.owner.pluginGeneration === access.owner.pluginGeneration
        && record.revision === revision
        && !record.disposed
      ) return record
      continue
    }
    const registration = (async (): Promise<ManagedServiceRecord> => {
      const prior = input.records.get(key)
      if (prior !== undefined) {
        if (
          prior.access.owner.pluginGeneration === access.owner.pluginGeneration
          && prior.revision === revision && !prior.disposed
        ) return prior
        await input.disposeRecord(prior)
      }
      const operations = new Set(definition.operations.map(operation => operation.operationId))
      if (operations.size !== definition.operations.length) {
        throw new Error('managed service operation ids must be unique')
      }
      for (const grant of access.declaration.consumerGrants) {
        if (grant.operations.some(operation => !operations.has(operation))) {
          throw new Error('managed service grant references an undeclared operation')
        }
      }
      for (const operation of definition.operations) {
        const authentication = operation.httpAuthentication
        if (authentication?.mode !== 'authorization-header') continue
        const binding = definition.protectedBindings.find(item => item.slot === authentication.slot)
        if (binding === undefined || binding.source === 'composition') {
          throw new Error('managed service operation authorization references an invalid secret slot')
        }
      }
      const registrationHandle = managedHandle('msr') as `msr_${string}`
      const serviceHome = managedServiceHome(input.homeDir, access.owner.pluginId, definition.serviceId)
      const projectedEnvironment = await input.projectEnvironment?.({
        owner: access.owner,
        serviceId: definition.serviceId,
        serviceHome,
      })
      const runtimeResources = access.runtimeResources
        ?? access.declaration.runtimeResources.filter(resource => managedServiceResourceMatchesTarget(resource))
      const packageSchemas = runtimeResources
        ?.filter(resource => resource.path.startsWith('./schemas/'))
        .map(({ path, byteLength, digest }) => ({ path, byteLength, digest }))
      const record: ManagedServiceRecord = {
        access,
        serviceHome,
        revision,
        definition: structuredClone(definition),
        schemas: packageSchemas === undefined || packageSchemas.length === 0
          ? input.schemas
          : input.schemas.forPackage({
            source: access.source,
            artifactDirectory: access.artifactDirectory,
            resources: packageSchemas,
          }),
        environment: managedServiceEnvironment(serviceHome, input.environment ?? process.env, projectedEnvironment),
        registrationHandle,
        ownerHandle: access.owner.ownerHandle,
        lifecycle: new AbortController(),
        operations: new Set(),
        binding: Object.freeze({
          registrationHandle,
          serviceHandle: managedHandle('mss') as `mss_${string}`,
          identity,
          hostGeneration: access.owner.hostGeneration,
          serviceGeneration: input.serviceGeneration,
        }),
        state: 'registered',
        health: 'stopped',
        processOwnership: 'host-owned',
        diagnostic: undefined,
        child: undefined,
        origin: undefined,
        brokerHandle: undefined,
        authenticationHandle: undefined,
        authorizationHandle: undefined,
        secrets: new Map(),
        leases: new Map(),
        materializations: new Map(),
        invocations: new Map(),
        selectedMaterialization: undefined,
        assignedPort: undefined,
        preparing: undefined,
        restarting: undefined,
        healthMonitor: undefined,
        disposal: undefined,
        disposed: false,
      }
      input.records.set(key, record)
      input.registrations.set(registrationHandle, record)
      return record
    })()
    input.pendingRegistrations.set(key, registration)
    registration.then(
      () => {
        if (input.pendingRegistrations.get(key) === registration) input.pendingRegistrations.delete(key)
      },
      () => {
        if (input.pendingRegistrations.get(key) === registration) input.pendingRegistrations.delete(key)
      },
    )
    return await registration
  }
}
