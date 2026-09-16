import type {
  ManagedNativeProviderCatalogV1,
  ManagedNativeProviderPublicationDiagnosticV1,
  ManagedNativeProviderPublicationInputV1,
  ManagedNativeProviderPublicationProjectionV1,
  ManagedNativeProviderPublicationResultV1,
} from '@cordisx/protocol/managed-service-runtime/v1'
import { createHash } from 'node:crypto'
import type { ManagedServiceRecord } from './managed-service-runtime-record.js'

interface PublicationState {
  readonly record: ManagedServiceRecord
  readonly projection: ManagedNativeProviderPublicationProjectionV1
  revokedProjection?: ManagedNativeProviderPublicationProjectionV1
  lifecycle: 'active' | 'disposed' | 'retired'
}

interface ValidatedPublicationInput {
  readonly providerId: string
  readonly compositionOrigin: string
  readonly catalog: ManagedNativeProviderCatalogV1
}

function diagnostic(
  code: ManagedNativeProviderPublicationDiagnosticV1['code'],
  retryable: boolean,
): ManagedNativeProviderPublicationDiagnosticV1 {
  return Object.freeze({ code, retryable })
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function catalogProjection(value: unknown): ManagedNativeProviderCatalogV1 | undefined {
  try {
    if (!exactObject(value, ['generation', 'digest', 'defaultAlias', 'routes'])) return undefined
    const { generation, digest, defaultAlias, routes } = value
    if (
      typeof generation !== 'string' || generation.length === 0
      || typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest)
      || typeof defaultAlias !== 'string' || defaultAlias.length === 0
      || !Array.isArray(routes) || routes.length === 0
    ) return undefined

    const aliases = new Set<string>()
    const gatewayModelIds = new Set<string>()
    const projectedRoutes: { alias: string; gatewayModelId: string }[] = []
    for (const route of routes) {
      if (!exactObject(route, ['alias', 'gatewayModelId'])) return undefined
      const { alias, gatewayModelId } = route
      if (
        typeof alias !== 'string' || alias.length === 0
        || typeof gatewayModelId !== 'string' || gatewayModelId.length === 0
        || aliases.has(alias) || gatewayModelIds.has(gatewayModelId)
      ) return undefined
      aliases.add(alias)
      gatewayModelIds.add(gatewayModelId)
      projectedRoutes.push({ alias, gatewayModelId })
    }
    if (!aliases.has(defaultAlias)) return undefined

    const canonicalRoutes = [...projectedRoutes].sort((left, right) =>
      Buffer.compare(
        Buffer.from(JSON.stringify([left.alias, left.gatewayModelId])),
        Buffer.from(JSON.stringify([right.alias, right.gatewayModelId])),
      )
    )
    const expectedDigest = `sha256:${
      createHash('sha256').update(
        JSON.stringify([
          generation,
          defaultAlias,
          canonicalRoutes.map(route => [route.alias, route.gatewayModelId]),
        ]),
      ).digest('hex')
    }`
    if (digest !== expectedDigest) return undefined

    return Object.freeze({
      generation,
      digest: digest as `sha256:${string}`,
      defaultAlias,
      routes: Object.freeze(projectedRoutes.map(route =>
        Object.freeze({
          alias: route.alias,
          gatewayModelId: route.gatewayModelId,
        })
      )),
    })
  } catch {
    return undefined
  }
}

function publicationInput(value: unknown): ValidatedPublicationInput | undefined {
  try {
    if (!exactObject(value, ['providerId', 'compositionOrigin', 'catalog'])) return undefined
    const { providerId, compositionOrigin } = value
    if (typeof providerId !== 'string' || providerId.length === 0 || typeof compositionOrigin !== 'string') {
      return undefined
    }
    const catalog = catalogProjection(value.catalog)
    if (catalog === undefined) return undefined
    return { providerId, compositionOrigin, catalog }
  } catch {
    return undefined
  }
}

export class ManagedNativeProviderPublications {
  private readonly providers = new Map<string, PublicationState>()
  private readonly records = new WeakMap<ManagedServiceRecord, Set<PublicationState>>()

  publish(
    record: ManagedServiceRecord,
    input: ManagedNativeProviderPublicationInputV1,
    signal?: AbortSignal,
  ): ManagedNativeProviderPublicationResultV1 {
    if (signal?.aborted) return { status: 'rejected', diagnostic: diagnostic('cancelled', true) }
    if (record.disposed) return { status: 'rejected', diagnostic: diagnostic('disposed', false) }
    if (record.state !== 'ready') return { status: 'rejected', diagnostic: diagnostic('not-ready', true) }
    const validated = publicationInput(input)
    if (validated === undefined) {
      return { status: 'rejected', diagnostic: diagnostic('invalid-catalog', false) }
    }
    const { providerId, compositionOrigin, catalog } = validated
    if (!record.definition.compositionOrigins?.some(origin => origin.id === compositionOrigin)) {
      return { status: 'rejected', diagnostic: diagnostic('undeclared-composition-origin', false) }
    }
    if (this.providers.has(providerId)) {
      return { status: 'rejected', diagnostic: diagnostic('duplicate-provider', false) }
    }
    const projection = Object.freeze({
      providerId,
      owner: Object.freeze({
        pluginId: record.access.owner.pluginId,
        hostGeneration: record.access.owner.hostGeneration,
        pluginGeneration: record.access.owner.pluginGeneration,
      }),
      service: Object.freeze({
        serviceId: record.definition.serviceId,
        serviceGeneration: record.binding.serviceGeneration,
      }),
      compositionOrigin,
      catalog,
      state: 'active' as const,
    })
    const state: PublicationState = { record, projection, lifecycle: 'active' }
    this.providers.set(providerId, state)
    const owned = this.records.get(record) ?? new Set<PublicationState>()
    owned.add(state)
    this.records.set(record, owned)
    return {
      status: 'accepted',
      publication: Object.freeze({
        publication: projection,
        dispose: async () => this.dispose(state),
      }),
    }
  }

  listProviderIds(): readonly string[] {
    return Object.freeze([...this.providers.keys()].sort())
  }

  resolve(providerId: string): {
    readonly record: ManagedServiceRecord
    readonly projection: ManagedNativeProviderPublicationProjectionV1
  } | undefined {
    const state = this.providers.get(providerId)
    return state === undefined || state.lifecycle !== 'active'
      ? undefined
      : Object.freeze({ record: state.record, projection: state.projection })
  }

  revoke(record: ManagedServiceRecord): void {
    for (const state of this.records.get(record) ?? []) this.revokeState(state)
    this.records.delete(record)
  }

  private dispose(state: PublicationState) {
    if (state.lifecycle === 'disposed') {
      return { status: 'disposed' as const, projection: state.revokedProjection! }
    }
    if (state.lifecycle === 'retired' || this.providers.get(state.projection.providerId) !== state) {
      return { status: 'stale' as const, diagnostic: diagnostic('stale-generation', false) }
    }
    state.revokedProjection = Object.freeze({ ...state.projection, state: 'revoked' as const })
    this.revokeState(state, 'disposed')
    return { status: 'disposed' as const, projection: state.revokedProjection }
  }

  private revokeState(state: PublicationState, lifecycle: 'disposed' | 'retired' = 'retired'): void {
    state.lifecycle = lifecycle
    if (this.providers.get(state.projection.providerId) === state) this.providers.delete(state.projection.providerId)
    this.records.get(state.record)?.delete(state)
  }
}
