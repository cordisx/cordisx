import type {
  ManagedServiceAcquireResultV1,
  ManagedServiceBoundClientV1,
  ManagedServiceIdentityV1,
  ManagedServiceInvokeResultV1,
  ManagedServiceLeaseV1,
  ManagedServiceMaterializationRequestV1,
  ManagedServiceMaterializationResultV1,
  ManagedServiceSafeValueV1,
} from '@cordisx/protocol/managed-service-runtime/v1'
import type {
  ManagedServiceClientState,
  ManagedServiceLeaseState,
  ManagedServiceMaterializationState,
  ManagedServiceRecord,
} from './managed-service-runtime-record.js'
import { projectManagedServiceRecord } from './managed-service-runtime-record.js'
import {
  assertManagedMaterializationOverlap,
  assertManagedSafeValue,
  managedBindingCurrent,
  managedFailure,
  managedHandle,
  managedIdentityKey,
  managedPointerValue,
  readManagedResponseBody,
} from './managed-service-runtime-support.js'

const MAX_BODY_BYTES = 1024 * 1024

export class ManagedServiceRuntimeBroker {
  constructor(
    private readonly records: Map<string, ManagedServiceRecord>,
    private readonly registrations: Map<string, ManagedServiceRecord>,
    private readonly fetch: typeof globalThis.fetch,
  ) {}

  boundClient(state: ManagedServiceClientState): ManagedServiceBoundClientV1 {
    return Object.freeze({
      acquire: async (
        identity: ManagedServiceIdentityV1,
        options?: { readonly signal?: AbortSignal },
      ) => await this.acquire(state, identity, options?.signal),
      invoke: async (
        lease: ManagedServiceLeaseV1,
        operationId: string,
        value?: ManagedServiceSafeValueV1,
        options?: { readonly signal?: AbortSignal },
      ) => await this.invoke(state, lease, operationId, value, options?.signal),
      materialize: async (
        request: ManagedServiceMaterializationRequestV1,
        options?: { readonly signal?: AbortSignal },
      ) => await this.materialize(state, request, options?.signal),
      release: (lease: ManagedServiceLeaseV1) => this.release(state, lease),
      dispose: () => {
        if (!state.active) return
        state.active = false
        for (const leaseHandle of [...state.leases]) this.releaseHandle(state, leaseHandle)
      },
    })
  }

  private async acquire(
    client: ManagedServiceClientState,
    identity: ManagedServiceIdentityV1,
    signal?: AbortSignal,
  ): Promise<ManagedServiceAcquireResultV1> {
    if (!client.active) return managedFailure('stale-generation', 'stale-generation', false)
    if (signal?.aborted) return managedFailure('cancelled', 'cancelled', true)
    const record = this.records.get(managedIdentityKey(identity))
    if (record === undefined || record.disposed) return managedFailure('unavailable', 'stale-generation', true)
    if (record.state !== 'ready' || record.brokerHandle === undefined) {
      return managedFailure('unavailable', 'health-check-failed', true)
    }
    const grant = record.access.declaration.consumerGrants.find(item => item.pluginId === client.pluginId)
    if (grant === undefined) return managedFailure('unavailable', 'unsupported', false)
    const leaseHandle = managedHandle('msl') as `msl_${string}`
    const lease: ManagedServiceLeaseV1 = Object.freeze({
      leaseHandle,
      binding: record.binding,
      brokerHandle: record.brokerHandle,
      operations: Object.freeze([...grant.operations]),
    })
    record.leases.set(leaseHandle, { client, lease })
    client.leases.add(leaseHandle)
    return { status: 'ready', projection: projectManagedServiceRecord(record), lease }
  }

  private currentLease(
    client: ManagedServiceClientState,
    lease: ManagedServiceLeaseV1,
  ): { readonly record: ManagedServiceRecord; readonly state: ManagedServiceLeaseState } | undefined {
    const record = this.registrations.get(lease.binding.registrationHandle)
    const state = record?.leases.get(lease.leaseHandle)
    if (
      !client.active || record === undefined || state?.client !== client || !client.leases.has(lease.leaseHandle)
      || !managedBindingCurrent(lease.binding, record.binding, record.disposed)
      || !managedBindingCurrent(state.lease.binding, record.binding, record.disposed)
      || lease.brokerHandle !== state.lease.brokerHandle || state.lease.brokerHandle !== record.brokerHandle
    ) return undefined
    return { record, state }
  }

  private async invoke(
    client: ManagedServiceClientState,
    lease: ManagedServiceLeaseV1,
    operationId: string,
    value?: ManagedServiceSafeValueV1,
    signal?: AbortSignal,
  ): Promise<ManagedServiceInvokeResultV1> {
    const acquired = this.currentLease(client, lease)
    if (acquired === undefined) return managedFailure('stale-generation', 'stale-generation', false)
    const { record, state } = acquired
    if (!state.lease.operations.includes(operationId)) return managedFailure('unavailable', 'unsupported', false)
    const operation = record.definition.operations.find(item => item.operationId === operationId)
    if (operation === undefined || record.origin === undefined) {
      return managedFailure('unavailable', 'unsupported', false)
    }
    try {
      if (operation.requestSchema !== undefined) await record.schemas.validate(operation.requestSchema, value)
      if (this.currentLease(client, lease)?.state !== state) {
        return managedFailure('stale-generation', 'stale-generation', false)
      }
      const timeout = AbortSignal.timeout(operation.timeoutMs)
      const operationSignal = signal === undefined
        ? record.lifecycle.signal
        : AbortSignal.any([record.lifecycle.signal, signal])
      const url = new URL(operation.path, record.origin)
      if (value !== undefined && operation.requestEncoding === 'query') {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('managed service query operation requires an object')
        }
        for (const [key, item] of Object.entries(value)) {
          if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
            url.searchParams.set(key, String(item))
          } else {
            throw new Error('managed service query values must be scalar')
          }
        }
      }
      const useBody = value !== undefined && operation.requestEncoding !== 'query'
      const response = await this.fetch(url, {
        method: operation.method,
        headers: {
          ...this.authorizationHeaders(record, operation.httpAuthentication),
          ...(useBody ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(useBody ? { body: JSON.stringify(value) } : {}),
        signal: AbortSignal.any([operationSignal, timeout]),
      })
      if (!response.ok) throw new Error('managed service operation failed')
      const bytes = await readManagedResponseBody(response, MAX_BODY_BYTES)
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown
      assertManagedSafeValue(parsed)
      await record.schemas.validate(operation.responseSchema, parsed)
      if (this.currentLease(client, lease)?.state !== state) {
        return managedFailure('stale-generation', 'stale-generation', false)
      }
      const invocationHandle = managedHandle('msi') as `msi_${string}`
      const safe = structuredClone(parsed)
      record.invocations.set(invocationHandle, { leaseHandle: lease.leaseHandle, value: safe })
      return Object.freeze({
        status: 'accepted',
        invocationHandle,
        operationId,
        responseSchema: operation.responseSchema,
        value: safe,
      })
    } catch {
      if (record.disposed) return managedFailure('stale-generation', 'disposed', false)
      return managedFailure(
        signal?.aborted ? 'cancelled' : 'failed',
        signal?.aborted ? 'cancelled' : 'health-check-failed',
        true,
      )
    }
  }

  private authorizationHeaders(
    record: ManagedServiceRecord,
    authentication = record.definition.httpAuthentication,
  ): Record<string, string> {
    if (authentication.mode === 'none') return {}
    const value = record.secrets.get(authentication.slot)
    if (value === undefined) throw new Error('managed service authorization is unavailable')
    return { Authorization: `${authentication.scheme} ${value}` }
  }

  private async materialize(
    client: ManagedServiceClientState,
    request: ManagedServiceMaterializationRequestV1,
    signal?: AbortSignal,
  ): Promise<ManagedServiceMaterializationResultV1> {
    if (!client.active) return managedFailure('stale-generation', 'stale-generation', false)
    if (signal?.aborted) return managedFailure('cancelled', 'cancelled', true)
    const target = this.registrations.get(request.target.registrationHandle)
    if (
      target === undefined || !managedBindingCurrent(request.target, target.binding, target.disposed)
      || target.access.owner.pluginId !== client.pluginId
      || target.access.owner.pluginGeneration !== client.pluginGeneration
    ) return managedFailure('stale-generation', 'stale-generation', false)
    const sourceLeases = new Map<string, { record: ManagedServiceRecord; lease: ManagedServiceLeaseState }>()
    for (const source of request.sources) {
      if (sourceLeases.has(source.source)) return managedFailure('failed', 'materialization-failed', false)
      const record = this.registrations.get(source.lease.binding.registrationHandle)
      const lease = record?.leases.get(source.lease.leaseHandle)
      if (
        record === undefined || !managedBindingCurrent(source.lease.binding, record.binding, record.disposed)
        || lease?.client !== client || !managedBindingCurrent(lease.lease.binding, record.binding, record.disposed)
      ) return managedFailure('stale-generation', 'stale-generation', false)
      sourceLeases.set(source.source, { record, lease })
    }
    try {
      const values: ManagedServiceMaterializationState['values'][number][] = []
      for (const binding of request.bindings) {
        const targetBinding = target.definition.protectedBindings.find(item => item.slot === binding.targetSlot)
        if (targetBinding === undefined || targetBinding.source !== 'composition') {
          throw new Error('invalid target slot')
        }
        if (targetBinding.target === 'environment' && binding.targetPointer !== undefined) {
          throw new Error('invalid target pointer')
        }
        const pointer = targetBinding.target === 'configuration'
          ? `${targetBinding.pointer}${binding.targetPointer ?? ''}` as `/${string}`
          : undefined
        let value: ManagedServiceSafeValueV1
        if (binding.source.kind === 'safe-literal') value = structuredClone(binding.source.value)
        else {
          const source = sourceLeases.get(binding.source.source)
          if (source === undefined) throw new Error('unknown materialization source')
          if (binding.source.kind === 'source-origin') {
            if (source.record.origin === undefined) throw new Error('source is not ready')
            const originId = binding.source.origin
            const declared = source.record.definition.compositionOrigins?.find(
              origin => origin.id === originId,
            )
            if (declared === undefined) throw new Error('source composition origin is not declared')
            value = new URL(declared.path, source.record.origin).href.replace(/\/$/u, '')
          } else if (binding.source.kind === 'source-authorization') {
            if (source.record.definition.httpAuthentication.mode === 'none') {
              throw new Error('source has no authorization')
            }
            const secret = source.record.secrets.get(source.record.definition.httpAuthentication.slot)
            if (secret === undefined) throw new Error('source authorization is unavailable')
            value = secret
          } else {
            const invocation = source.record.invocations.get(binding.source.invocationHandle)
            if (invocation === undefined || invocation.leaseHandle !== source.lease.lease.leaseHandle) {
              throw new Error('invocation is not owned by source lease')
            }
            value = managedPointerValue(invocation.value, binding.source.pointer)
          }
        }
        assertManagedSafeValue(value)
        if (binding.source.kind === 'safe-literal' && targetBinding.valueSchema !== undefined) {
          await target.schemas.validate(targetBinding.valueSchema, value)
        }
        const candidate: ManagedServiceMaterializationState['values'][number] = {
          slot: binding.targetSlot,
          pointer,
          value: structuredClone(value),
          safeLiteral: binding.source.kind === 'safe-literal',
        }
        for (const existing of values) assertManagedMaterializationOverlap(existing, candidate)
        values.push(candidate)
      }
      if (!this.materializationCurrent(client, target, request, sourceLeases)) {
        return managedFailure('stale-generation', 'stale-generation', false)
      }
      values.sort((left, right) => (left.pointer?.split('/').length ?? 0) - (right.pointer?.split('/').length ?? 0))
      const materialization: ManagedServiceMaterializationState = Object.freeze({
        handle: managedHandle('msm') as `msm_${string}`,
        revision: request.revision,
        values: Object.freeze(values.map(value => Object.freeze(value))),
        sources: Object.freeze(
          [...sourceLeases.entries()].map(([source, item]) => Object.freeze({ source, binding: item.record.binding })),
        ),
      })
      target.materializations.set(materialization.handle, materialization)
      return Object.freeze({
        status: 'accepted',
        materializationHandle: materialization.handle,
        target: target.binding,
        revision: materialization.revision,
        sources: materialization.sources,
      })
    } catch {
      return managedFailure('failed', 'materialization-failed', false)
    }
  }

  private materializationCurrent(
    client: ManagedServiceClientState,
    target: ManagedServiceRecord,
    request: ManagedServiceMaterializationRequestV1,
    sources: ReadonlyMap<string, { readonly record: ManagedServiceRecord; readonly lease: ManagedServiceLeaseState }>,
  ): boolean {
    return client.active
      && managedBindingCurrent(request.target, target.binding, target.disposed)
      && target.access.owner.pluginId === client.pluginId
      && target.access.owner.pluginGeneration === client.pluginGeneration
      && [...sources.values()].every(({ record, lease }) =>
        record.leases.get(lease.lease.leaseHandle) === lease
        && managedBindingCurrent(lease.lease.binding, record.binding, record.disposed)
      )
  }

  private release(client: ManagedServiceClientState, lease: ManagedServiceLeaseV1): void {
    const record = this.registrations.get(lease.binding.registrationHandle)
    if (record?.leases.get(lease.leaseHandle)?.client !== client) return
    this.releaseHandle(client, lease.leaseHandle)
  }

  private releaseHandle(client: ManagedServiceClientState, leaseHandle: string): void {
    client.leases.delete(leaseHandle)
    for (const record of this.records.values()) {
      if (record.leases.get(leaseHandle)?.client !== client) continue
      record.leases.delete(leaseHandle)
      for (const [invocationHandle, invocation] of record.invocations) {
        if (invocation.leaseHandle === leaseHandle) record.invocations.delete(invocationHandle)
      }
      break
    }
  }
}
