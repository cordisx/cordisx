import type {
  ManagedServiceApplyInputV1,
  ManagedServiceBoundClientV1,
  ManagedServiceDefinitionV1,
  ManagedServiceOwnerV1,
  ManagedServiceRegistrationHandleV1,
  ManagedServiceRegistryV1,
} from '@cordisx/protocol/managed-service-runtime/v1'
import { randomUUID } from 'node:crypto'
import type {
  ManagedServiceActivationAccess,
  ManagedServiceClientState,
  ManagedServiceRecord,
} from './managed-service-runtime-record.js'
import { managedHandle } from './managed-service-runtime-support.js'

export interface ManagedServiceActivationBinding extends ManagedServiceApplyInputV1 {
  readonly authority: ManagedServiceContextAuthorityV1
  readonly registry: ManagedServiceRegistryV1
  dispose(): Promise<void>
}

export interface ManagedServiceContextAuthorityV1 {
  readonly pluginId: string
  readonly pluginGeneration: string
  readonly serviceId: string
  readonly serviceGeneration: string
}

interface ManagedServiceRegistrationOperations {
  readonly inspect: () => ReturnType<ManagedServiceRegistrationHandleV1['inspect']>
  readonly authenticate: (
    action: Parameters<ManagedServiceRegistrationHandleV1['authenticate']>[0],
    signal?: AbortSignal,
  ) => ReturnType<ManagedServiceRegistrationHandleV1['authenticate']>
  readonly ensureReady: (
    options?: Parameters<ManagedServiceRegistrationHandleV1['ensureReady']>[0],
  ) => ReturnType<ManagedServiceRegistrationHandleV1['ensureReady']>
  readonly restart: (signal?: AbortSignal) => ReturnType<ManagedServiceRegistrationHandleV1['restart']>
  readonly publishNativeProvider: (
    input: Parameters<ManagedServiceRegistrationHandleV1['publishNativeProvider']>[0],
    signal?: AbortSignal,
  ) => ReturnType<ManagedServiceRegistrationHandleV1['publishNativeProvider']>
  readonly dispose: () => ReturnType<ManagedServiceRegistrationHandleV1['dispose']>
}

export function createManagedServiceRegistrationHandle(
  record: ManagedServiceRecord,
  operations: ManagedServiceRegistrationOperations,
): ManagedServiceRegistrationHandleV1 {
  const handle: ManagedServiceRegistrationHandleV1 = {
    get binding() {
      return record.binding
    },
    revision: record.revision,
    inspect: operations.inspect,
    authenticate: async (action, options) => await operations.authenticate(action, options?.signal),
    ensureReady: async options => await operations.ensureReady(options),
    restart: async options => await operations.restart(options?.signal),
    publishNativeProvider: async (input, options) => operations.publishNativeProvider(input, options?.signal),
    dispose: operations.dispose,
  }
  return Object.freeze(handle)
}

export function createManagedServiceActivationBinding(input: {
  readonly access: ManagedServiceActivationAccess
  readonly signal: AbortSignal
  readonly register: (
    access: ManagedServiceActivationAccess,
    serviceGeneration: string,
    definition: ManagedServiceDefinitionV1,
    revision: `sha256:${string}`,
  ) => Promise<ManagedServiceRecord>
  readonly registrationHandle: (record: ManagedServiceRecord) => ManagedServiceRegistrationHandleV1
  readonly boundClient: (state: ManagedServiceClientState) => ManagedServiceBoundClientV1
  readonly disposeRecord: (record: ManagedServiceRecord) => Promise<unknown>
  readonly disposeRecords: (records: Iterable<ManagedServiceRecord>) => Promise<void>
}): ManagedServiceActivationBinding {
  const authority = Object.freeze({
    pluginId: input.access.owner.pluginId,
    pluginGeneration: input.access.owner.pluginGeneration,
    serviceId: input.access.declaration.id,
    serviceGeneration: randomUUID(),
  })
  const clientState: ManagedServiceClientState = {
    key: managedHandle('msc'),
    pluginId: input.access.owner.pluginId,
    pluginGeneration: input.access.owner.pluginGeneration,
    active: true,
    leases: new Set(),
  }
  const owned = new Set<ManagedServiceRecord>()
  const pendingRegistrations = new Set<Promise<unknown>>()
  const registry: ManagedServiceRegistryV1 = Object.freeze({
    register: (
      definition: ManagedServiceDefinitionV1,
      options: { readonly revision: `sha256:${string}` },
    ) => {
      if (!clientState.active) return Promise.reject(new Error('managed service plugin binding is disposed'))
      const registration = (async () => {
        const record = await input.register(input.access, authority.serviceGeneration, definition, options.revision)
        if (!clientState.active) {
          await input.disposeRecord(record)
          throw new Error('managed service plugin binding was disposed during registration')
        }
        owned.add(record)
        return input.registrationHandle(record)
      })()
      pendingRegistrations.add(registration)
      registration.then(
        () => pendingRegistrations.delete(registration),
        () => pendingRegistrations.delete(registration),
      )
      return registration
    },
  })
  const client = input.boundClient(clientState)
  let disposal: Promise<void> | undefined
  return Object.freeze({
    owner: input.access.owner,
    authority,
    registry,
    client,
    signal: input.signal,
    dispose: () => {
      if (disposal !== undefined) return disposal
      client.dispose()
      disposal = (async () => {
        await Promise.allSettled([...pendingRegistrations])
        await input.disposeRecords(owned)
      })()
      return disposal
    },
  })
}
