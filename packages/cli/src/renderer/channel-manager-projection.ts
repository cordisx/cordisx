import type { RasterImageSnapshotV1 } from '@cordisx/protocol/raster-image/v1'
import type { ChannelManagerRuntimeProjection } from '../launcher/channel-manager-api.js'
import { cloneRasterImageSnapshot } from './raster-image.js'

export type ChannelProductStatus = 'implemented' | 'verified' | 'experimental' | 'unavailable' | 'planned'

export interface ChannelManagerConnectionProjection {
  readonly ref: { readonly adapterId: string; readonly accountId: string; readonly tenantId: string }
  /** Host-private projection only; empty tenantId represents no tenant and never reaches the Channel runtime. */
  readonly pendingTenant?: true
  /** Renderer-safe human label for this configured account. Never a credential or secret reference. */
  readonly displayName?: string
  readonly adapterKind: string
  readonly enabled: boolean
  readonly transportMode: string
  readonly secretState: 'missing' | 'ready' | 'unavailable'
}
export interface ChannelManagerRouteProjection {
  readonly id: string
  readonly connection: ChannelManagerConnectionProjection['ref']
  readonly enabled: boolean
  readonly workspaceAlias: string
  readonly provider: string
  readonly model: string
  readonly profile: string
  readonly notifications: readonly string[]
}

export interface ChannelManagerAccountProjection extends ChannelManagerConnectionProjection {
  readonly accountName?: string
  readonly accountAvatar?: RasterImageSnapshotV1
  readonly implementationStatus: ChannelProductStatus
  readonly connectionState: 'disabled' | 'starting' | 'ready' | 'retrying' | 'unavailable' | 'stopped'
  readonly generation: number
  readonly inbound: { readonly pending: number; readonly retrying: number; readonly deadLetter: number }
  readonly outbound: { readonly pending: number; readonly retrying: number; readonly deadLetter: number }
}

export interface ChannelManagerBindingProjection {
  readonly bindingId: string
  readonly channel: ChannelManagerConnectionProjection['ref'] & {
    readonly conversationId: string
    readonly threadId: string
  }
  readonly session: { readonly providerId: string; readonly remoteSessionId: string }
  readonly routeId: string
  readonly state: 'active' | 'archived' | 'unavailable'
}

export interface ChannelManagerDiagnosticProjection {
  readonly id: string
  readonly status: ChannelProductStatus
  readonly message: string
}

/** A bounded, content-free activity record emitted by the launcher runtime. */
export interface ChannelManagerLogProjection {
  readonly id: string
  readonly account: ChannelManagerConnectionProjection['ref']
  readonly recordedAt: string
  readonly action: string
  readonly outcome: string
}

/** Renderer-safe Host projection. It deliberately has no secretRef or credential value field. */
export interface ChannelManagerProjectionV1 {
  readonly contract: 'cordisx.channel-manager-projection/v1'
  readonly schemaVersion: 1
  readonly status: ChannelProductStatus
  readonly service: {
    readonly configurationKind: 'host'
    readonly configApplies: 'service-restart'
    readonly revision: number
    readonly lastGoodRevision: number
    readonly writable: boolean
  }
  readonly connections: readonly ChannelManagerConnectionProjection[]
  readonly routes: readonly ChannelManagerRouteProjection[]
  readonly accounts: readonly ChannelManagerAccountProjection[]
  readonly bindings: readonly ChannelManagerBindingProjection[]
  /** Operational metadata only. Message bodies, credentials, and raw errors never enter this projection. */
  readonly logs?: readonly ChannelManagerLogProjection[]
  readonly diagnostics: readonly ChannelManagerDiagnosticProjection[]
}

export const EMPTY_PROJECTION: ChannelManagerProjectionV1 = Object.freeze({
  contract: 'cordisx.channel-manager-projection/v1',
  schemaVersion: 1,
  status: 'unavailable',
  service: Object.freeze({
    configurationKind: 'host',
    configApplies: 'service-restart',
    revision: 0,
    lastGoodRevision: 0,
    writable: false,
  }),
  connections: Object.freeze([]),
  routes: Object.freeze([]),
  accounts: Object.freeze([]),
  bindings: Object.freeze([]),
  logs: Object.freeze([]),
  diagnostics: Object.freeze([
    Object.freeze({
      id: 'channel-runtime',
      status: 'unavailable',
      message: 'No launcher-owned Channel service is active for this profile.',
    }),
    Object.freeze({
      id: 'real-adapters',
      status: 'unavailable',
      message:
        'Feishu and WeCom adapters require a developer account, Host credential handle, and an official transport.',
    }),
  ]),
})

export function compositeRef(ref: ChannelManagerConnectionProjection['ref']): string {
  return `${ref.adapterId}/${ref.accountId}/${ref.tenantId}`
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const keys = new Set(allowed)
  const unknown = Object.keys(value).find(key => !keys.has(key))
  if (unknown !== undefined) throw new TypeError(`${label}.${unknown} is not renderer-safe`)
}

function boundedText(value: unknown, label: string, maximum = 512): string {
  if (
    typeof value !== 'string' || value.length < 1 || value.length > maximum
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)
  ) {
    throw new TypeError(`${label} is invalid`)
  }
  return value
}

function boundedInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_000_000_000) {
    throw new TypeError(`${label} is invalid`)
  }
  return value as number
}

function accountDisplayName(value: unknown, label: string): string {
  if (
    typeof value !== 'string' || Array.from(value).length < 1 || Array.from(value).length > 256
    || /[\u0000-\u001F\u007F]/u.test(value)
  ) throw new TypeError(`${label} is invalid`)
  return value
}

function array(value: unknown, label: string, maximum = 256): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError(`${label} is invalid`)
  return value
}

function oneOf<T extends string>(value: unknown, accepted: readonly T[], label: string): T {
  if (typeof value !== 'string' || !accepted.includes(value as T)) throw new TypeError(`${label} is invalid`)
  return value as T
}

function ref(value: unknown, label: string, pending = false): ChannelManagerConnectionProjection['ref'] {
  const item = object(value, label)
  exactKeys(item, ['adapterId', 'accountId', 'tenantId'], label)
  return {
    adapterId: boundedText(item.adapterId, `${label}.adapterId`),
    accountId: boundedText(item.accountId, `${label}.accountId`),
    tenantId: pending && item.tenantId === '' ? '' : boundedText(item.tenantId, `${label}.tenantId`),
  }
}

function connection(value: unknown, label: string): ChannelManagerConnectionProjection {
  const item = object(value, label)
  exactKeys(
    item,
    ['ref', 'pendingTenant', 'displayName', 'adapterKind', 'enabled', 'transportMode', 'secretState'],
    label,
  )
  if (typeof item.enabled !== 'boolean') throw new TypeError(`${label}.enabled is invalid`)
  if (item.pendingTenant !== undefined && item.pendingTenant !== true) {
    throw new TypeError(`${label}.pendingTenant is invalid`)
  }
  const identity = ref(item.ref, `${label}.ref`, item.pendingTenant === true)
  if (item.pendingTenant === true && (identity.tenantId !== '' || item.enabled)) {
    throw new TypeError(`${label} is invalid`)
  }
  return {
    ref: identity,
    ...(item.pendingTenant === true ? { pendingTenant: true as const } : {}),
    ...(item.displayName === undefined
      ? {}
      : { displayName: boundedText(item.displayName, `${label}.displayName`, 240) }),
    adapterKind: boundedText(item.adapterKind, `${label}.adapterKind`),
    enabled: item.enabled,
    transportMode: boundedText(item.transportMode, `${label}.transportMode`),
    secretState: oneOf(item.secretState, ['missing', 'ready', 'unavailable'], `${label}.secretState`),
  }
}

export function normalizeProjection(value: unknown): ChannelManagerProjectionV1 {
  const projection = object(value, 'Channel Manager projection')
  exactKeys(projection, [
    'contract',
    'schemaVersion',
    'status',
    'service',
    'connections',
    'routes',
    'accounts',
    'bindings',
    'logs',
    'diagnostics',
  ], 'Channel Manager projection')
  if (projection.contract !== 'cordisx.channel-manager-projection/v1' || projection.schemaVersion !== 1) {
    throw new TypeError('Channel Manager projection contract is unsupported')
  }
  const service = object(projection.service, 'Channel Manager projection.service')
  exactKeys(
    service,
    ['configurationKind', 'configApplies', 'revision', 'lastGoodRevision', 'writable'],
    'Channel Manager projection.service',
  )
  if (
    service.configurationKind !== 'host' || service.configApplies !== 'service-restart'
    || typeof service.writable !== 'boolean'
  ) {
    throw new TypeError('Channel Manager service projection is invalid')
  }
  const connections = array(projection.connections, 'Channel Manager projection.connections').map((item, index) => (
    connection(item, `Channel Manager projection.connections[${index}]`)
  ))
  const routes = array(projection.routes, 'Channel Manager projection.routes').map(
    (value, index): ChannelManagerRouteProjection => {
      const item = object(value, `Channel Manager projection.routes[${index}]`)
      const label = `Channel Manager projection.routes[${index}]`
      exactKeys(item, [
        'id',
        'connection',
        'enabled',
        'workspaceAlias',
        'provider',
        'model',
        'profile',
        'notifications',
      ], label)
      if (typeof item.enabled !== 'boolean') throw new TypeError(`${label}.enabled is invalid`)
      return {
        id: boundedText(item.id, `${label}.id`),
        connection: ref(item.connection, `${label}.connection`),
        enabled: item.enabled,
        workspaceAlias: boundedText(item.workspaceAlias, `${label}.workspaceAlias`),
        provider: boundedText(item.provider, `${label}.provider`),
        model: boundedText(item.model, `${label}.model`),
        profile: boundedText(item.profile, `${label}.profile`),
        notifications: array(item.notifications, `${label}.notifications`, 32).map((entry, notificationIndex) => (
          boundedText(entry, `${label}.notifications[${notificationIndex}]`)
        )),
      }
    },
  )
  const accounts = array(projection.accounts, 'Channel Manager projection.accounts').map(
    (value, index): ChannelManagerAccountProjection => {
      const item = object(value, `Channel Manager projection.accounts[${index}]`)
      const label = `Channel Manager projection.accounts[${index}]`
      exactKeys(item, [
        'ref',
        'pendingTenant',
        'displayName',
        'accountName',
        'accountAvatar',
        'adapterKind',
        'enabled',
        'transportMode',
        'secretState',
        'implementationStatus',
        'connectionState',
        'generation',
        'inbound',
        'outbound',
      ], label)
      const base = connection(
        Object.fromEntries(
          ['ref', 'pendingTenant', 'displayName', 'adapterKind', 'enabled', 'transportMode', 'secretState']
            .filter(key => item[key] !== undefined).map(key => [key, item[key]]),
        ),
        label,
      )
      const counts = (raw: unknown, countLabel: string) => {
        const count = object(raw, countLabel)
        exactKeys(count, ['pending', 'retrying', 'deadLetter'], countLabel)
        return {
          pending: boundedInteger(count.pending, `${countLabel}.pending`),
          retrying: boundedInteger(count.retrying, `${countLabel}.retrying`),
          deadLetter: boundedInteger(count.deadLetter, `${countLabel}.deadLetter`),
        }
      }
      return {
        ...base,
        ...(item.accountName === undefined
          ? {}
          : { accountName: accountDisplayName(item.accountName, `${label}.accountName`) }),
        ...(item.accountAvatar === undefined
          ? {}
          : { accountAvatar: cloneRasterImageSnapshot(item.accountAvatar as RasterImageSnapshotV1) }),
        implementationStatus: oneOf(item.implementationStatus, [
          'implemented',
          'verified',
          'experimental',
          'unavailable',
          'planned',
        ], `${label}.implementationStatus`),
        connectionState: oneOf(item.connectionState, [
          'disabled',
          'starting',
          'ready',
          'retrying',
          'unavailable',
          'stopped',
        ], `${label}.connectionState`),
        generation: boundedInteger(item.generation, `${label}.generation`),
        inbound: counts(item.inbound, `${label}.inbound`),
        outbound: counts(item.outbound, `${label}.outbound`),
      }
    },
  )
  const bindings = array(projection.bindings, 'Channel Manager projection.bindings', Number.POSITIVE_INFINITY).map(
    (value, index): ChannelManagerBindingProjection => {
      const item = object(value, `Channel Manager projection.bindings[${index}]`)
      const label = `Channel Manager projection.bindings[${index}]`
      exactKeys(item, ['bindingId', 'channel', 'session', 'routeId', 'state'], label)
      const channel = object(item.channel, `${label}.channel`)
      exactKeys(channel, ['adapterId', 'accountId', 'tenantId', 'conversationId', 'threadId'], `${label}.channel`)
      const session = object(item.session, `${label}.session`)
      exactKeys(session, ['providerId', 'remoteSessionId'], `${label}.session`)
      return {
        bindingId: boundedText(item.bindingId, `${label}.bindingId`),
        channel: {
          ...ref(
            { adapterId: channel.adapterId, accountId: channel.accountId, tenantId: channel.tenantId },
            `${label}.channel`,
          ),
          conversationId: boundedText(channel.conversationId, `${label}.channel.conversationId`),
          threadId: boundedText(channel.threadId, `${label}.channel.threadId`),
        },
        session: {
          providerId: boundedText(session.providerId, `${label}.session.providerId`),
          remoteSessionId: boundedText(session.remoteSessionId, `${label}.session.remoteSessionId`),
        },
        routeId: boundedText(item.routeId, `${label}.routeId`),
        state: oneOf(item.state, ['active', 'archived', 'unavailable'], `${label}.state`),
      }
    },
  )
  const logs = (projection.logs === undefined ? [] : array(projection.logs, 'Channel Manager projection.logs', 2_000))
    .map((value, index): ChannelManagerLogProjection => {
      const item = object(value, `Channel Manager projection.logs[${index}]`)
      const label = `Channel Manager projection.logs[${index}]`
      exactKeys(item, ['id', 'account', 'recordedAt', 'action', 'outcome'], label)
      const recordedAt = boundedText(item.recordedAt, `${label}.recordedAt`, 64)
      if (Number.isNaN(Date.parse(recordedAt))) throw new TypeError(`${label}.recordedAt is invalid`)
      return {
        id: boundedText(item.id, `${label}.id`, 256),
        account: ref(item.account, `${label}.account`),
        recordedAt,
        action: boundedText(item.action, `${label}.action`, 160),
        outcome: boundedText(item.outcome, `${label}.outcome`, 160),
      }
    })
  const diagnostics = array(projection.diagnostics, 'Channel Manager projection.diagnostics', 128).map(
    (value, index): ChannelManagerDiagnosticProjection => {
      const item = object(value, `Channel Manager projection.diagnostics[${index}]`)
      const label = `Channel Manager projection.diagnostics[${index}]`
      exactKeys(item, ['id', 'status', 'message'], label)
      return {
        id: boundedText(item.id, `${label}.id`),
        status: oneOf(
          item.status,
          ['implemented', 'verified', 'experimental', 'unavailable', 'planned'],
          `${label}.status`,
        ),
        message: boundedText(item.message, `${label}.message`, 4096),
      }
    },
  )
  return {
    contract: 'cordisx.channel-manager-projection/v1',
    schemaVersion: 1,
    status: oneOf(
      projection.status,
      ['implemented', 'verified', 'experimental', 'unavailable', 'planned'],
      'Channel Manager projection.status',
    ),
    service: {
      configurationKind: 'host',
      configApplies: 'service-restart',
      revision: boundedInteger(service.revision, 'Channel Manager projection.service.revision'),
      lastGoodRevision: boundedInteger(service.lastGoodRevision, 'Channel Manager projection.service.lastGoodRevision'),
      writable: service.writable,
    },
    connections,
    routes,
    accounts,
    bindings,
    logs,
    diagnostics,
  }
}

/** Merge a launcher action response into the existing renderer-safe product view. */
export function withRuntimeProjection(
  base: ChannelManagerProjectionV1,
  runtime: ChannelManagerRuntimeProjection | undefined,
): ChannelManagerProjectionV1 {
  if (runtime === undefined) return base
  const accountKey = (item: { readonly ref: ChannelManagerConnectionProjection['ref'] }) => compositeRef(item.ref)
  const updates = new Map(runtime.accounts.map(item => [accountKey(item), item]))
  return normalizeProjection({
    ...base,
    accounts: base.accounts.map(account => {
      const update = updates.get(accountKey(account))
      const { accountName: _name, accountAvatar: _avatar, ...prior } = account
      return update === undefined ? prior : {
        ...prior,
        ...(update.accountName === undefined ? {} : { accountName: update.accountName }),
        ...(update.accountAvatar === undefined ? {} : { accountAvatar: update.accountAvatar }),
        adapterKind: update.adapterKind,
        implementationStatus: update.implementationStatus,
        connectionState: update.connectionState,
        secretState: update.secretState,
        generation: update.generation,
        inbound: update.inbound,
        outbound: update.outbound,
      }
    }),
    bindings: runtime.bindings,
  })
}
