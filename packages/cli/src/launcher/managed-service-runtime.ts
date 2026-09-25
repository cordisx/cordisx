import type {
  ManagedNativeProviderPublicationInputV1,
  ManagedServiceApplyInputV1,
  ManagedServiceBoundClientV1,
  ManagedServiceControlResultV1,
  ManagedServiceDefinitionV1,
  ManagedServiceIdentityV1,
  ManagedServiceOwnerV1,
  ManagedServiceRegistrationHandleV1,
  ManagedServiceRegistryV1,
} from '@cordisx/protocol/managed-service-runtime/v1'
import { randomBytes, randomUUID } from 'node:crypto'
import { spawn as nodeSpawn } from 'node:child_process'
import { findFreeLoopbackPort } from './process.js'
import { ManagedServiceSchemaRegistry } from './managed-service-schema.js'
import type {
  NativeManagedGatewayConnectionRequest,
  NativeManagedGatewayConnectionSession,
} from './managed-service-native-connection.js'
import { createNativeManagedGatewayConnection } from './managed-service-native-connection.js'
import { ManagedNativeProviderPublications } from './managed-service-native-publications.js'
import { ManagedServiceRuntimeBroker } from './managed-service-runtime-broker.js'
import { managedServiceResourceMatchesTarget } from './managed-service-package-resources.js'
import {
  assertManagedServiceEnvironmentBindings,
  resolveManagedServiceEnvironment,
} from './managed-service-runtime-files.js'
import {
  type ManagedServiceActivationAccess,
  type ManagedServiceClientState,
  type ManagedServiceRecord,
  projectManagedServiceRecord,
} from './managed-service-runtime-record.js'
import {
  managedServiceEnvironment,
  managedServiceHome,
  runManagedServiceChildAction,
  terminateManagedServiceChild,
} from './managed-service-process.js'
import type { ManagedServiceChildTerminationTimeouts } from './managed-service-process.js'
import { ManagedServiceRuntimeProcess } from './managed-service-runtime-process.js'
import {
  managedBindingCurrent,
  managedDiagnostic,
  managedFailure,
  managedHandle,
  managedIdentityKey,
} from './managed-service-runtime-support.js'

export type { ManagedServiceActivationAccess } from './managed-service-runtime-record.js'

export interface ManagedServiceRuntimeOptions {
  readonly homeDir: string
  readonly schemas?: ManagedServiceSchemaRegistry
  readonly resolveSecret?: (input: {
    readonly owner: ManagedServiceOwnerV1
    readonly serviceId: string
    readonly slot: string
  }) => Promise<string | undefined>
  readonly fetch?: typeof globalThis.fetch
  readonly spawn?: typeof nodeSpawn
  readonly findFreePort?: () => Promise<number>
  readonly environment?: NodeJS.ProcessEnv
  readonly projectEnvironment?: (input: {
    readonly owner: ManagedServiceOwnerV1
    readonly serviceId: string
    readonly serviceHome: string
  }) => Promise<NodeJS.ProcessEnv>
  readonly childTerminationTimeouts?: ManagedServiceChildTerminationTimeouts
  readonly failuresBeforeUnhealthy?: number
}

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

class BorrowedServiceUnavailableError extends Error {
  constructor() {
    super('managed service borrowed takeover is unavailable')
  }
}

export class ManagedServiceRuntime {
  private readonly schemas: ManagedServiceSchemaRegistry
  private readonly fetch: typeof globalThis.fetch
  private readonly spawn: typeof nodeSpawn
  private readonly findFreePort: () => Promise<number>
  private readonly failuresBeforeUnhealthy: number
  private readonly records = new Map<string, ManagedServiceRecord>()
  private readonly registrations = new Map<string, ManagedServiceRecord>()
  private readonly pendingRegistrations = new Map<string, Promise<ManagedServiceRecord>>()
  private readonly nativeAuthorities = new Map<string, ManagedServiceRecord>()
  private readonly nativePublications = new ManagedNativeProviderPublications()
  private readonly broker: ManagedServiceRuntimeBroker
  private readonly process: ManagedServiceRuntimeProcess

  constructor(private readonly options: ManagedServiceRuntimeOptions) {
    this.schemas = options.schemas ?? new ManagedServiceSchemaRegistry()
    this.fetch = options.fetch ?? globalThis.fetch
    this.spawn = options.spawn ?? nodeSpawn
    this.findFreePort = options.findFreePort ?? findFreeLoopbackPort
    this.process = new ManagedServiceRuntimeProcess({
      fetch: this.fetch,
      spawn: this.spawn,
      ...(options.childTerminationTimeouts === undefined
        ? {}
        : { childTerminationTimeouts: options.childTerminationTimeouts }),
      invalidateExitedChild: (record, child) => this.invalidateExitedChild(record, child),
    })
    const failuresBeforeUnhealthy = options.failuresBeforeUnhealthy ?? 3
    if (!Number.isSafeInteger(failuresBeforeUnhealthy) || failuresBeforeUnhealthy < 1) {
      throw new Error('managed service health failure threshold is invalid')
    }
    this.failuresBeforeUnhealthy = failuresBeforeUnhealthy
    this.broker = new ManagedServiceRuntimeBroker(this.records, this.registrations, this.fetch)
  }

  bind(access: ManagedServiceActivationAccess, signal: AbortSignal): ManagedServiceActivationBinding {
    const authority = Object.freeze({
      pluginId: access.owner.pluginId,
      pluginGeneration: access.owner.pluginGeneration,
      serviceId: access.declaration.id,
      serviceGeneration: randomUUID(),
    })
    const clientState: ManagedServiceClientState = {
      key: managedHandle('msc'),
      pluginId: access.owner.pluginId,
      pluginGeneration: access.owner.pluginGeneration,
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
          const record = await this.register(access, authority.serviceGeneration, definition, options.revision)
          if (!clientState.active) {
            await this.disposeRecord(record)
            throw new Error('managed service plugin binding was disposed during registration')
          }
          owned.add(record)
          return this.registrationHandle(record)
        })()
        pendingRegistrations.add(registration)
        registration.then(
          () => pendingRegistrations.delete(registration),
          () => pendingRegistrations.delete(registration),
        )
        return registration
      },
    })
    const client = this.boundClient(clientState)
    let disposal: Promise<void> | undefined
    return Object.freeze({
      owner: access.owner,
      authority,
      registry,
      client,
      signal,
      dispose: () => {
        if (disposal !== undefined) return disposal
        client.dispose()
        disposal = (async () => {
          await Promise.allSettled([...pendingRegistrations])
          await this.disposeRecords(owned)
        })()
        return disposal
      },
    })
  }

  prepareNativeConnection(
    request: NativeManagedGatewayConnectionRequest,
  ): NativeManagedGatewayConnectionSession {
    const record = this.registrations.get(request.binding.registrationHandle)
    if (
      record === undefined || !managedBindingCurrent(request.binding, record.binding, record.disposed)
      || record.state !== 'ready'
      || record.origin === undefined
    ) throw new Error('selected managed service connection is unavailable or stale')
    const declaredOrigin = record.definition.compositionOrigins?.find(origin => origin.id === request.compositionOrigin)
    const authentication = record.definition.httpAuthentication
    const token = authentication.mode === 'authorization-header' ? record.secrets.get(authentication.slot) : undefined
    if (declaredOrigin === undefined || (authentication.mode === 'authorization-header' && token === undefined)) {
      throw new Error('selected managed service connection is incomplete')
    }
    const authorityId = managedHandle('msn')
    this.nativeAuthorities.set(authorityId, record)
    return createNativeManagedGatewayConnection({
      pluginId: record.binding.identity.pluginId,
      serviceId: record.binding.identity.serviceId,
      serviceGeneration: record.binding.serviceGeneration,
      origin: record.origin,
      apiPath: declaredOrigin.path,
      ...(token === undefined ? {} : { token }),
      models: request.models,
      authorityId,
      dispose: () => {
        if (this.nativeAuthorities.get(authorityId) === record) this.nativeAuthorities.delete(authorityId)
      },
    })
  }

  listNativeProviderIds(): readonly string[] {
    return this.nativePublications.listProviderIds()
  }

  subscribeNativeProviders(listener: () => void): () => void {
    return this.nativePublications.subscribe(listener)
  }

  preparePublishedNativeConnection(providerId: string): NativeManagedGatewayConnectionSession {
    const published = this.nativePublications.resolve(providerId)
    if (published === undefined) throw new Error('native managed gateway provider is unavailable')
    return this.prepareNativeConnection({
      binding: published.record.binding,
      compositionOrigin: published.projection.compositionOrigin,
      models: {
        generation: published.projection.catalog.generation,
        defaultAlias: published.projection.catalog.defaultAlias,
        aliases: published.projection.catalog.routes.map(route => ({
          alias: route.alias,
          gatewayModelId: route.gatewayModelId,
        })),
      },
    })
  }

  getRegistrationHandle(identity: ManagedServiceIdentityV1): ManagedServiceRegistrationHandleV1 | undefined {
    const record = this.records.get(managedIdentityKey(identity))
    if (record === undefined) return undefined
    return this.registrationHandle(record)
  }

  listRegistrationIdentities(): readonly ManagedServiceIdentityV1[] {
    const identities: ManagedServiceIdentityV1[] = []
    for (const record of this.records.values()) {
      if (record.disposed) continue
      identities.push(record.binding.identity)
    }
    return identities
  }

  getHealthIntervalMs(identity: ManagedServiceIdentityV1): number | undefined {
    const record = this.records.get(managedIdentityKey(identity))
    return record?.definition.health.intervalMs
  }

  getAuthenticationMode(identity: ManagedServiceIdentityV1): 'none' | 'host-secret' | 'cli' | undefined {
    const record = this.records.get(managedIdentityKey(identity))
    return record?.definition.authentication.mode
  }

  getLoginTimeoutMs(identity: ManagedServiceIdentityV1): number | undefined {
    const authentication = this.records.get(managedIdentityKey(identity))?.definition.authentication
    return authentication?.mode === 'cli' ? authentication.login.timeoutMs : undefined
  }

  supportsLogout(identity: ManagedServiceIdentityV1): boolean {
    const authentication = this.records.get(managedIdentityKey(identity))?.definition.authentication
    return authentication?.mode === 'cli' && authentication.logout !== undefined
  }

  private async register(
    access: ManagedServiceActivationAccess,
    serviceGeneration: string,
    definition: ManagedServiceDefinitionV1,
    revision: `sha256:${string}`,
  ): Promise<ManagedServiceRecord> {
    await this.schemas.validateDefinition(definition)
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
    const identity: ManagedServiceIdentityV1 = {
      source: access.source,
      pluginId: access.owner.pluginId,
      serviceId: definition.serviceId,
    }
    const key = managedIdentityKey(identity)
    while (true) {
      const pending = this.pendingRegistrations.get(key)
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
        const prior = this.records.get(key)
        if (prior !== undefined) {
          if (
            prior.access.owner.pluginGeneration === access.owner.pluginGeneration
            && prior.revision === revision && !prior.disposed
          ) return prior
          await this.disposeRecord(prior)
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
        const serviceHome = managedServiceHome(this.options.homeDir, access.owner.pluginId, definition.serviceId)
        const projectedEnvironment = await this.options.projectEnvironment?.({
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
            ? this.schemas
            : this.schemas.forPackage({
              source: access.source,
              artifactDirectory: access.artifactDirectory,
              resources: packageSchemas,
            }),
          environment: managedServiceEnvironment(
            serviceHome,
            this.options.environment ?? process.env,
            projectedEnvironment,
          ),
          registrationHandle,
          ownerHandle: access.owner.ownerHandle,
          lifecycle: new AbortController(),
          operations: new Set(),
          binding: Object.freeze({
            registrationHandle,
            serviceHandle: managedHandle('mss') as `mss_${string}`,
            identity: Object.freeze(identity),
            hostGeneration: access.owner.hostGeneration,
            serviceGeneration,
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
        this.records.set(key, record)
        this.registrations.set(registrationHandle, record)
        return record
      })()
      this.pendingRegistrations.set(key, registration)
      registration.then(
        () => {
          if (this.pendingRegistrations.get(key) === registration) this.pendingRegistrations.delete(key)
        },
        () => {
          if (this.pendingRegistrations.get(key) === registration) this.pendingRegistrations.delete(key)
        },
      )
      return await registration
    }
  }

  private registrationHandle(record: ManagedServiceRecord): ManagedServiceRegistrationHandleV1 {
    const runtime = this
    return Object.freeze({
      get binding() {
        return record.binding
      },
      revision: record.revision,
      inspect: async () => runtime.projection(record),
      authenticate: async (
        action: 'login' | 'refresh' | 'logout',
        options?: { readonly signal?: AbortSignal },
      ) => await runtime.authenticate(record, action, options?.signal),
      ensureReady: async (options?: {
        readonly materialization?: {
          readonly materializationHandle: `msm_${string}`
          readonly revision: `sha256:${string}`
        }
        readonly signal?: AbortSignal
      }) => await runtime.ensureReady(record, options),
      restart: async (options?: { readonly signal?: AbortSignal }) => await runtime.restart(record, options?.signal),
      publishNativeProvider: async (
        input: ManagedNativeProviderPublicationInputV1,
        options?: { readonly signal?: AbortSignal },
      ) => runtime.nativePublications.publish(record, input, options?.signal),
      dispose: () => runtime.disposeRecord(record),
    })
  }

  private boundClient(state: ManagedServiceClientState): ManagedServiceBoundClientV1 {
    return this.broker.boundClient(state)
  }

  private projection(record: ManagedServiceRecord) {
    return projectManagedServiceRecord(record)
  }

  private operationSignal(record: ManagedServiceRecord, signal?: AbortSignal): AbortSignal {
    return signal === undefined ? record.lifecycle.signal : AbortSignal.any([record.lifecycle.signal, signal])
  }

  private assertOperationActive(record: ManagedServiceRecord, signal: AbortSignal): void {
    if (record.disposed) throw new Error('managed service is disposed')
    if (signal.aborted) throw signal.reason ?? new Error('cancelled')
  }

  private trackOperation<T>(record: ManagedServiceRecord, operation: Promise<T>): Promise<T> {
    record.operations.add(operation)
    operation.then(
      () => record.operations.delete(operation),
      () => record.operations.delete(operation),
    )
    return operation
  }

  private async settleOperations(operations: Iterable<Promise<unknown>>, message: string): Promise<void> {
    const failures = (await Promise.allSettled([...operations]))
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason)
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, message)
  }

  private async disposeRecords(records: Iterable<ManagedServiceRecord>): Promise<void> {
    await this.settleOperations(
      [...records].map(record => this.disposeRecord(record)),
      'managed service cleanup failed',
    )
  }

  private materializationMatchesSelected(
    record: ManagedServiceRecord,
    materialization: ManagedServiceRecord['selectedMaterialization'],
  ): boolean {
    if (materialization === undefined) return record.selectedMaterialization === undefined
    if (record.selectedMaterialization === undefined) return false
    if (record.selectedMaterialization.handle !== materialization.handle) return false
    if (record.selectedMaterialization.revision !== materialization.revision) return false
    // compare composed sources (stable sorted by source key)
    const sourcesKey = (item: { readonly source: string; readonly binding: unknown }) => item.source
    const leftSources = [...record.selectedMaterialization.sources].sort((a, b) =>
      sourcesKey(a).localeCompare(sourcesKey(b))
    )
    const rightSources = [...materialization.sources].sort((a, b) => sourcesKey(a).localeCompare(sourcesKey(b)))
    if (JSON.stringify(leftSources) !== JSON.stringify(rightSources)) return false
    const valuesKey = (item: { readonly slot: string; readonly pointer: string | undefined }) =>
      `${item.slot}${item.pointer ?? ''}`
    const left = [...record.selectedMaterialization.values].sort((a, b) => valuesKey(a).localeCompare(valuesKey(b)))
    const right = [...materialization.values].sort((a, b) => valuesKey(a).localeCompare(valuesKey(b)))
    return JSON.stringify(left) === JSON.stringify(right)
  }

  private async ensureReady(
    record: ManagedServiceRecord,
    options: {
      readonly materialization?: {
        readonly materializationHandle: `msm_${string}`
        readonly revision: `sha256:${string}`
      }
      readonly signal?: AbortSignal
    } = {},
  ): Promise<ManagedServiceControlResultV1> {
    if (record.disposed) return managedFailure('stale-generation', 'disposed', false)
    const materialization = options.materialization === undefined
      ? undefined
      : record.materializations.get(options.materialization.materializationHandle)
    if (
      options.materialization !== undefined
      && (materialization === undefined || materialization.revision !== options.materialization.revision)
    ) return managedFailure('stale-catalog', 'stale-catalog', true)
    // If the record is already ready but a new materialization was supplied that differs
    // from the currently selected one, trigger a restart to apply the new configuration.
    // The registrationHandle remains stable; only serviceHandle/serviceGeneration rotate,
    // which invalidates any outstanding leases so clients must re-acquire.
    if (record.state === 'ready') {
      if (this.materializationMatchesSelected(record, materialization)) {
        return { status: 'ready', projection: this.projection(record) }
      }
      if (record.processOwnership === 'borrowed') {
        return managedFailure('unavailable', 'borrowed-service', false)
      }
      return await this.restart(record, options.signal, materialization)
    }
    if (record.preparing !== undefined) {
      // A new ensureReady call arrived while preparation was already in flight.
      // Wait for it to settle; do not mutate selectedMaterialization here because
      // resolveBindings/writeConfiguration may have already consumed the prior
      // selection. Once settled, re-run ensureReady which will compare the
      // requested materialization against what was actually applied and trigger
      // a restart if they differ.
      await record.preparing
      if (record.disposed) return managedFailure('stale-generation', 'disposed', false)
      return await this.ensureReady(record, options)
    }
    record.selectedMaterialization = materialization
    const preparation = this.trackOperation(record, this.prepare(record, this.operationSignal(record, options.signal)))
    record.preparing = preparation
    preparation.then(
      () => {
        if (record.preparing === preparation) record.preparing = undefined
      },
      () => {
        if (record.preparing === preparation) record.preparing = undefined
      },
    )
    return await preparation
  }

  private async prepare(record: ManagedServiceRecord, signal: AbortSignal): Promise<ManagedServiceControlResultV1> {
    record.state = 'preparing'
    record.health = 'starting'
    record.diagnostic = undefined
    const takeoverBlocked = record.processOwnership === 'borrowed'
    try {
      this.assertOperationActive(record, signal)
      await this.process.ensureServiceHome(record)
      this.assertOperationActive(record, signal)
      await resolveManagedServiceEnvironment(record)
      this.assertOperationActive(record, signal)
      const authentication = await this.checkAuthentication(record, signal)
      this.assertOperationActive(record, signal)
      if (authentication !== undefined) return authentication
      await this.resolveBindings(record)
      this.assertOperationActive(record, signal)
      record.assignedPort = record.definition.discovery.kind === 'host-assigned-loopback'
        ? await this.findFreePort()
        : undefined
      this.assertOperationActive(record, signal)
      const configurationPath = await this.process.writeConfiguration(record)
      this.assertOperationActive(record, signal)
      const discovered = await this.process.discoverExisting(record, signal)
      this.assertOperationActive(record, signal)
      if (discovered !== undefined) {
        record.processOwnership = 'borrowed'
        record.origin = discovered
      } else if (takeoverBlocked) {
        throw new BorrowedServiceUnavailableError()
      } else {
        record.processOwnership = 'host-owned'
        record.origin = await this.process.launch(record, configurationPath, signal)
      }
      this.assertOperationActive(record, signal)
      if (record.state !== 'preparing') throw new Error('managed service readiness was revoked')
      record.brokerHandle = managedHandle('msb') as `msb_${string}`
      record.state = 'ready'
      record.health = 'ready'
      this.startHealthMonitoring(record)
      return { status: 'ready', projection: this.projection(record) }
    } catch (error) {
      await Promise.allSettled([this.stopOwned(record), this.process.removeGenerationDirectory(record)])
      this.revokeRuntimeState(record)
      if (record.disposed) return managedFailure('stale-generation', 'disposed', false)
      const cancelled = signal.aborted
      const borrowedUnavailable = error instanceof BorrowedServiceUnavailableError
      record.state = 'failed'
      record.health = 'unhealthy'
      record.diagnostic = managedDiagnostic(
        cancelled ? 'cancelled' : borrowedUnavailable ? 'borrowed-service' : 'launch-failed',
        !cancelled && !borrowedUnavailable,
      )
      return managedFailure(
        cancelled ? 'cancelled' : borrowedUnavailable ? 'unavailable' : 'failed',
        cancelled ? 'cancelled' : borrowedUnavailable ? 'borrowed-service' : 'launch-failed',
        !cancelled && !borrowedUnavailable,
      )
    }
  }

  private async resolveBindings(record: ManagedServiceRecord): Promise<void> {
    for (const binding of record.definition.protectedBindings) {
      if (binding.source === 'composition') {
        const values = record.selectedMaterialization?.values.filter(value => value.slot === binding.slot) ?? []
        if (values.length === 0) throw new Error('managed service composition is missing')
        if (binding.target === 'environment') {
          const value = values.find(item => item.pointer === undefined)?.value
          if (typeof value !== 'string') throw new Error('managed service environment binding must be a string')
          record.secrets.set(binding.slot, value)
        }
        continue
      }
      if (binding.source === 'host-assigned-loopback') continue
      if (binding.source === 'generated-local-key') {
        if (!record.secrets.has(binding.slot)) record.secrets.set(binding.slot, randomBytes(32).toString('base64url'))
        continue
      }
      const value = await this.options.resolveSecret?.({
        owner: record.access.owner,
        serviceId: record.definition.serviceId,
        slot: binding.slot,
      })
      if (value === undefined || value.length === 0 || value.length > 16 * 1024 || /[\r\n\u0000]/u.test(value)) {
        throw new Error('managed service secret is unavailable')
      }
      record.secrets.set(binding.slot, value)
    }
    if (record.definition.httpAuthentication.mode === 'authorization-header') {
      if (!record.secrets.has(record.definition.httpAuthentication.slot)) {
        throw new Error('managed service HTTP authorization is unavailable')
      }
      record.authorizationHandle ??= managedHandle('msa') as `msa_${string}`
    }
  }

  private async checkAuthentication(
    record: ManagedServiceRecord,
    signal: AbortSignal,
  ): Promise<ManagedServiceControlResultV1 | undefined> {
    if (record.definition.authentication.mode === 'none') return
    if (record.definition.authentication.mode === 'host-secret') {
      const value = await this.options.resolveSecret?.({
        owner: record.access.owner,
        serviceId: record.definition.serviceId,
        slot: record.definition.authentication.slot,
      })
      this.assertOperationActive(record, signal)
      if (value === undefined) {
        record.state = 'authentication-required'
        return managedFailure('authentication-required', 'authentication-required', true)
      }
      record.secrets.set(record.definition.authentication.slot, value)
      record.authenticationHandle ??= managedHandle('msa') as `msa_${string}`
      return
    }
    const outcome = await this.runAuthenticationAction(record, record.definition.authentication.status, signal)
    this.assertOperationActive(record, signal)
    if (outcome !== 'authenticated') {
      record.state = 'authentication-required'
      return managedFailure('authentication-required', 'authentication-required', true)
    }
    record.authenticationHandle ??= managedHandle('msa') as `msa_${string}`
  }

  private async authenticate(
    record: ManagedServiceRecord,
    action: 'login' | 'refresh' | 'logout',
    signal?: AbortSignal,
  ): Promise<ManagedServiceControlResultV1> {
    if (record.disposed) return managedFailure('stale-generation', 'disposed', false)
    if (record.definition.authentication.mode !== 'cli') return managedFailure('unavailable', 'unsupported', false)
    const selected = action === 'login'
      ? record.definition.authentication.login
      : action === 'logout'
      ? record.definition.authentication.logout
      : record.definition.authentication.refresh
    if (selected === undefined) return managedFailure('unavailable', 'unsupported', false)
    const operationSignal = this.operationSignal(record, signal)
    return await this.trackOperation(
      record,
      (async () => {
        try {
          const outcome = await this.runAuthenticationAction(record, selected, operationSignal)
          this.assertOperationActive(record, operationSignal)
          if (action === 'logout') {
            if (outcome !== 'authentication-required') {
              return managedFailure('failed', 'authentication-failed', outcome !== 'failed')
            }
            await this.revokeAfterLogout(record, operationSignal)
            return { status: 'accepted', projection: this.projection(record) }
          }
          if (outcome !== 'authenticated') {
            return managedFailure('failed', 'authentication-failed', outcome !== 'failed')
          }
          record.authenticationHandle ??= managedHandle('msa') as `msa_${string}`
          if (record.state === 'authentication-required') {
            record.state = 'registered'
            record.diagnostic = undefined
          }
          return { status: 'accepted', projection: this.projection(record) }
        } catch {
          if (record.disposed) return managedFailure('stale-generation', 'disposed', false)
          if (operationSignal.aborted) return managedFailure('cancelled', 'cancelled', true)
          return managedFailure('failed', 'authentication-failed', false)
        }
      })(),
    )
  }

  private async revokeAfterLogout(record: ManagedServiceRecord, signal: AbortSignal): Promise<void> {
    const failures: unknown[] = []
    try {
      await this.stopOwned(record)
    } catch (error) {
      failures.push(error)
    }
    try {
      await this.process.removeGenerationDirectory(record)
    } catch (error) {
      failures.push(error)
    }
    this.revokeRuntimeState(record)
    record.authenticationHandle = undefined
    record.secrets.clear()
    record.binding = Object.freeze({
      ...record.binding,
      serviceHandle: managedHandle('mss') as `mss_${string}`,
      serviceGeneration: randomUUID(),
    })
    record.state = 'authentication-required'
    record.health = 'stopped'
    record.diagnostic = undefined
    this.assertOperationActive(record, signal)
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'managed service logout cleanup failed')
  }

  private async runAuthenticationAction(
    record: ManagedServiceRecord,
    action: Extract<ManagedServiceDefinitionV1['authentication'], { mode: 'cli' }>['status'],
    signal: AbortSignal,
  ): Promise<'authenticated' | 'authentication-required' | 'failed'> {
    this.assertOperationActive(record, signal)
    assertManagedServiceEnvironmentBindings(record)
    await this.process.ensureServiceHome(record)
    this.assertOperationActive(record, signal)
    const executable = await this.process.resolveExecutable(record, action.executable)
    this.assertOperationActive(record, signal)
    const exitCode = await runManagedServiceChildAction({
      spawn: this.spawn,
      executable,
      arguments: action.arguments,
      cwd: record.access.artifactDirectory,
      environment: record.environment,
      timeoutMs: action.timeoutMs,
      signal,
      ...(this.options.childTerminationTimeouts === undefined
        ? {}
        : { terminationTimeouts: this.options.childTerminationTimeouts }),
    })
    return action.outcomes.find(outcome => outcome.exitCode === exitCode)?.state ?? 'failed'
  }

  private invalidateExitedChild(
    record: ManagedServiceRecord,
    child: NonNullable<ManagedServiceRecord['child']>,
  ): void {
    if (record.child !== child || record.disposed) return
    const preparing = record.state === 'preparing'
    record.child = undefined
    this.revokeRuntimeState(record)
    record.state = 'failed'
    record.health = 'unhealthy'
    record.diagnostic = managedDiagnostic(preparing ? 'launch-failed' : 'health-check-failed', true)
  }

  private startHealthMonitoring(record: ManagedServiceRecord): void {
    this.stopHealthMonitoring(record)
    if (record.origin === undefined) return
    const controller = new AbortController()
    const generation = record.binding.serviceGeneration
    const origin = record.origin
    record.healthMonitor = controller
    const monitor = this.trackOperation(
      record,
      this.monitorHealth(record, generation, origin, AbortSignal.any([record.lifecycle.signal, controller.signal])),
    )
    void monitor.finally(() => {
      if (record.healthMonitor === controller) record.healthMonitor = undefined
    }).catch(() => undefined)
  }

  private stopHealthMonitoring(record: ManagedServiceRecord): void {
    record.healthMonitor?.abort(new Error('managed service health monitor stopped'))
    record.healthMonitor = undefined
  }

  private async monitorHealth(
    record: ManagedServiceRecord,
    generation: string,
    origin: string,
    signal: AbortSignal,
  ): Promise<void> {
    let failures = 0
    while (!signal.aborted) {
      await this.waitForHealthInterval(record.definition.health.intervalMs, signal)
      if (
        signal.aborted || record.disposed || record.binding.serviceGeneration !== generation || record.state !== 'ready'
      ) {
        return
      }
      const healthy = await this.process.healthy(record, origin, signal).catch(() => false)
      if (
        signal.aborted || record.disposed || record.binding.serviceGeneration !== generation || record.state !== 'ready'
      ) {
        return
      }
      if (healthy) {
        failures = 0
        record.health = 'ready'
        continue
      }
      failures += 1
      if (failures < this.failuresBeforeUnhealthy) {
        record.health = 'degraded'
        continue
      }
      record.health = 'unhealthy'
      record.state = 'failed'
      record.diagnostic = managedDiagnostic('health-check-failed', true)
      this.revokeRuntimeState(record)
      await this.stopOwned(record).catch(() => undefined)
      return
    }
  }

  private async waitForHealthInterval(intervalMs: number, signal: AbortSignal): Promise<void> {
    await new Promise<void>(resolve => {
      const finish = (): void => {
        clearTimeout(timeout)
        signal.removeEventListener('abort', finish)
        resolve()
      }
      const timeout = setTimeout(finish, intervalMs)
      signal.addEventListener('abort', finish, { once: true })
      if (signal.aborted) finish()
    })
  }

  private async restart(
    record: ManagedServiceRecord,
    signal?: AbortSignal,
    nextMaterialization?: ManagedServiceRecord['selectedMaterialization'],
  ): Promise<ManagedServiceControlResultV1> {
    if (record.disposed) return managedFailure('stale-generation', 'disposed', false)
    if (record.restarting !== undefined) return await record.restarting
    if (record.processOwnership === 'borrowed') {
      return managedFailure('unavailable', 'borrowed-service', false)
    }
    const operation = this.trackOperation(
      record,
      this.restartRecord(record, this.operationSignal(record, signal), nextMaterialization),
    )
    record.restarting = operation
    operation.then(
      () => {
        if (record.restarting === operation) record.restarting = undefined
      },
      () => {
        if (record.restarting === operation) record.restarting = undefined
      },
    )
    return await operation
  }

  private async restartRecord(
    record: ManagedServiceRecord,
    signal: AbortSignal,
    nextMaterialization?: ManagedServiceRecord['selectedMaterialization'],
  ): Promise<ManagedServiceControlResultV1> {
    await this.stopOwned(record)
    this.assertOperationActive(record, signal)
    await this.process.removeGenerationDirectory(record)
    this.assertOperationActive(record, signal)
    this.revokeRuntimeState(record)
    record.binding = Object.freeze({
      ...record.binding,
      serviceHandle: managedHandle('mss') as `mss_${string}`,
      serviceGeneration: randomUUID(),
    })
    record.state = 'registered'
    record.health = 'stopped'
    // Keep the new materialization selected when restarting so the relaunched
    // process picks up the updated configuration. The registrationHandle stays
    // stable across restarts; only serviceHandle/serviceGeneration are rotated,
    // which invalidates any outstanding leases.
    record.selectedMaterialization = nextMaterialization
    return await this.ensureReady(
      record,
      nextMaterialization === undefined
        ? { signal }
        : {
          signal,
          materialization: {
            materializationHandle: nextMaterialization.handle,
            revision: nextMaterialization.revision,
          },
        },
    )
  }

  private revokeRuntimeState(record: ManagedServiceRecord): void {
    this.stopHealthMonitoring(record)
    this.nativePublications.revoke(record)
    for (const [leaseHandle, lease] of record.leases) lease.client.leases.delete(leaseHandle)
    record.leases.clear()
    record.invocations.clear()
    record.brokerHandle = undefined
    record.origin = undefined
    record.authorizationHandle = undefined
    record.assignedPort = undefined
    for (const [authorityId, owner] of this.nativeAuthorities) {
      if (owner === record) this.nativeAuthorities.delete(authorityId)
    }
  }

  private async stopOwned(record: ManagedServiceRecord): Promise<void> {
    const child = record.child
    record.child = undefined
    if (child === undefined || record.processOwnership !== 'host-owned') return
    await terminateManagedServiceChild(child, this.options.childTerminationTimeouts)
  }

  private disposeRecord(record: ManagedServiceRecord): Promise<ManagedServiceControlResultV1> {
    if (record.disposal !== undefined) return record.disposal
    record.disposed = true
    record.lifecycle.abort(new Error('managed service disposed'))
    const disposal = this.disposeRecordNow(record)
    record.disposal = disposal
    return disposal
  }

  private async disposeRecordNow(record: ManagedServiceRecord): Promise<ManagedServiceControlResultV1> {
    const failures: unknown[] = []
    const pending = await Promise.allSettled([...record.operations])
    failures.push(
      ...pending.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(
        result => result.reason,
      ),
    )
    try {
      await this.stopOwned(record)
    } catch (error) {
      failures.push(error)
    }
    this.revokeRuntimeState(record)
    record.authenticationHandle = undefined
    record.secrets.clear()
    record.selectedMaterialization = undefined
    record.materializations.clear()
    record.state = 'disposed'
    record.health = 'stopped'
    record.diagnostic = managedDiagnostic('disposed', false)
    if (this.records.get(managedIdentityKey(record.binding.identity)) === record) {
      this.records.delete(managedIdentityKey(record.binding.identity))
    }
    if (this.registrations.get(record.registrationHandle) === record) {
      this.registrations.delete(record.registrationHandle)
    }
    try {
      await this.process.removeGenerationDirectory(record)
    } catch (error) {
      failures.push(error)
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'managed service disposal failed')
    return { status: 'accepted', projection: this.projection(record) }
  }
}
