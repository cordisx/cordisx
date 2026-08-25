import { Service, type Context, type Disposable } from '@deepseek-ai/cordis'
import type { CordisXConfigFieldSnapshot, CordisXPageMountContext } from '../contracts.js'
import { createHostCollection, type HostCollectionItem } from './host-collection.js'
import { HostFormAdapter } from './host-form.js'
import { HostThemeProjection } from './host-theme.js'
import { createHostSurfaceIcon, createManagerIcon } from './icons.js'
import { managerCopy } from './ui-copy.js'
import type {
  HostServiceConfigDescriptor,
  HostServiceConfigMutation,
  HostServiceConfigMutationResult,
} from '../launcher/service-config.js'

export type ChannelProductStatus = 'implemented' | 'verified' | 'experimental' | 'unavailable' | 'planned'

export interface ChannelManagerConnectionProjection {
  readonly ref: { readonly adapterId: string; readonly accountId: string; readonly tenantId: string }
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

const EMPTY_PROJECTION: ChannelManagerProjectionV1 = Object.freeze({
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
      message: 'Feishu and WeCom adapters require a developer account, Host credential handle, and an official transport.',
    }),
  ]),
})

const CORDIS_ORIGINAL = Symbol.for('cordis.original')
interface ChannelManagerState {
  readonly projection: ChannelManagerProjectionV1
  readonly serviceConfig?: ChannelManagerServiceConfigApi
  readonly captureCredential?: ChannelManagerServiceInput['captureCredential']
  readonly localConnections: ChannelManagerConnectionProjection[]
  readonly listeners: Set<() => void>
}

const projections = new WeakMap<object, ChannelManagerState>()

function stateFor(service: object): ChannelManagerState {
  const original = (service as { [CORDIS_ORIGINAL]?: object })[CORDIS_ORIGINAL]
  if (original !== undefined) {
    const state = projections.get(original)
    if (state !== undefined) return state
  }
  let candidate: object | null = service
  while (candidate !== null) {
    const state = projections.get(candidate)
    if (state !== undefined) return state
    candidate = Object.getPrototypeOf(candidate) as object | null
  }
  throw new Error('CordisX Channel Manager is detached from its Host projection')
}

function projectionFor(service: object): ChannelManagerProjectionV1 {
  const state = stateFor(service)
  if (state.localConnections.length === 0) return state.projection
  return normalizeProjection({
    ...state.projection,
    connections: [...state.projection.connections, ...state.localConnections],
  })
}

const CHANNEL_MANAGER_STYLES = String.raw`
  .cxc-channel-manager { min-width: 0; color: var(--cx-text); }
  .cxc-channel-list-page { display: grid; grid-template-rows: minmax(0, 1fr); height: clamp(20rem, 62vh, 38rem); min-height: 0; }
  .cxc-channel-list-collection { display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-rows: auto minmax(0, 1fr); min-height: 0; column-gap: 8px; }
  .cxc-channel-list-collection > .cxc-search { grid-column: 1; grid-row: 1; }
  .cxc-channel-list-collection > .cxc-list { grid-column: 1 / -1; grid-row: 2; }
  .cxc-channel-list-collection .cxc-list { min-height: 0; max-height: none; overflow: auto; padding-right: 3px; align-content: start; scrollbar-gutter: stable; }
  .cxc-channel-create { display: grid; grid-column: 2; grid-row: 1; place-items: center; width: 38px; height: 38px; padding: 0; border: 1px solid var(--cx-border); border-radius: 9px; background: var(--cx-surface-raised); color: var(--cx-text); cursor: pointer; }
  .cxc-channel-create:hover, .cxc-channel-create:focus-visible { border-color: var(--cx-primary); background: var(--cx-hover); outline: 2px solid var(--cx-focus); outline-offset: 2px; }
  .cxc-channel-create .cxm-material-icon { width: 18px; height: 18px; }
  .cxc-channel-detail { display: grid; gap: 16px; min-width: 0; }
  .cxc-channel-panel { min-width: 0; }
  .cxc-channel-config-form { inline-size: 100%; margin-inline: 0; }
  .cxc-channel-empty { display: flex; align-items: center; gap: 9px; min-height: 42px; padding: 11px 12px; border: 1px solid var(--cx-border); border-radius: 10px; background: var(--cx-surface-raised); color: var(--cx-muted); font-size: 12px; }
  .cxc-channel-empty .cordisx-host-icon, .cxc-channel-empty .cordisx-host-icon svg { width: 18px; height: 18px; flex: none; }
  .cxc-channel-create-actions { display: flex; justify-content: flex-end; }
  .cxc-channel-log-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-block-end: 10px; }
  .cxc-channel-log-toolbar input, .cxc-channel-log-toolbar select { min-height: 32px; min-width: min(100%, 12rem); padding-inline: 9px; border: 1px solid var(--cx-border); border-radius: 8px; background: var(--cx-surface-raised); color: var(--cx-text); font: inherit; }
  .cxc-channel-log-toolbar input { flex: 1 1 14rem; }
  .cxc-channel-log-export, .cxc-channel-log-page { min-height: 32px; padding-inline: 10px; border: 1px solid var(--cx-border); border-radius: 8px; background: var(--cx-surface-raised); color: var(--cx-text); font: inherit; cursor: pointer; }
  .cxc-channel-log-list { display: grid; gap: 6px; }
  .cxc-channel-log-entry { display: grid; grid-template-columns: minmax(8rem, auto) minmax(0, 1fr) auto; gap: 8px; align-items: baseline; padding: 9px 10px; border: 1px solid var(--cx-border); border-radius: 9px; background: var(--cx-surface-raised); font-size: 12px; }
  .cxc-channel-log-entry time { color: var(--cx-muted); font-variant-numeric: tabular-nums; }
  .cxc-channel-log-outcome { color: var(--cx-muted); }
  .cxc-channel-log-pagination { display: flex; justify-content: flex-end; gap: 6px; align-items: center; margin-block-start: 10px; color: var(--cx-muted); font-size: 12px; }
  .cxc-channel-section { display: grid; gap: 7px; min-width: 0; }
  .cxc-channel-section-head { display: grid; gap: 2px; }
  .cxc-channel-section h3 { font-size: 12px; }
  .cxc-channel-status-cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-block-end: 12px; }
  .cxc-channel-status-card { display: grid; gap: 3px; min-width: 0; padding: 10px; border: 1px solid var(--cx-border); border-radius: 9px; background: var(--cx-surface-raised); }
  .cxc-channel-status-card strong { font-size: 13px; overflow-wrap: anywhere; }
  .cxc-channel-status-card span { color: var(--cx-muted); font-size: 11px; }
  .cxc-channel-operation-note { margin-inline-end: auto; color: var(--cx-muted); font-size: 12px; }
  .cxc-channel-manager .cordisx-host-icon, .cxc-channel-manager .cordisx-host-icon svg { width: 22px; height: 22px; }
  @media (max-width: 520px) {
    .cxc-channel-list-page { height: clamp(18rem, 60vh, 34rem); }
    .cxc-channel-list-collection .cxc-list { grid-template-columns: minmax(0, 1fr); }
    .cxc-channel-create { width: 38px; }
  }
`

function compositeRef(ref: ChannelManagerConnectionProjection['ref']): string {
  return `${ref.adapterId}/${ref.accountId}/${ref.tenantId}`
}

function cloneJson<Value>(value: Value): Value {
  return typeof globalThis.structuredClone === 'function'
    ? globalThis.structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as Value
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const keys = new Set(allowed)
  const unknown = Object.keys(value).find(key => !keys.has(key))
  if (unknown !== undefined) throw new TypeError(`${label}.${unknown} is not renderer-safe`)
}

function boundedText(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) {
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

function array(value: unknown, label: string, maximum = 256): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError(`${label} is invalid`)
  return value
}

function oneOf<T extends string>(value: unknown, accepted: readonly T[], label: string): T {
  if (typeof value !== 'string' || !accepted.includes(value as T)) throw new TypeError(`${label} is invalid`)
  return value as T
}

function ref(value: unknown, label: string): ChannelManagerConnectionProjection['ref'] {
  const item = object(value, label)
  exactKeys(item, ['adapterId', 'accountId', 'tenantId'], label)
  return {
    adapterId: boundedText(item.adapterId, `${label}.adapterId`),
    accountId: boundedText(item.accountId, `${label}.accountId`),
    tenantId: boundedText(item.tenantId, `${label}.tenantId`),
  }
}

function connection(value: unknown, label: string): ChannelManagerConnectionProjection {
  const item = object(value, label)
  exactKeys(item, ['ref', 'displayName', 'adapterKind', 'enabled', 'transportMode', 'secretState'], label)
  if (typeof item.enabled !== 'boolean') throw new TypeError(`${label}.enabled is invalid`)
  return {
    ref: ref(item.ref, `${label}.ref`),
    ...(item.displayName === undefined ? {} : { displayName: boundedText(item.displayName, `${label}.displayName`, 160) }),
    adapterKind: boundedText(item.adapterKind, `${label}.adapterKind`),
    enabled: item.enabled,
    transportMode: boundedText(item.transportMode, `${label}.transportMode`),
    secretState: oneOf(item.secretState, ['missing', 'ready', 'unavailable'], `${label}.secretState`),
  }
}

function normalizeProjection(value: unknown): ChannelManagerProjectionV1 {
  const projection = object(value, 'Channel Manager projection')
  exactKeys(projection, ['contract', 'schemaVersion', 'status', 'service', 'connections', 'routes', 'accounts', 'bindings', 'logs', 'diagnostics'], 'Channel Manager projection')
  if (projection.contract !== 'cordisx.channel-manager-projection/v1' || projection.schemaVersion !== 1) {
    throw new TypeError('Channel Manager projection contract is unsupported')
  }
  const service = object(projection.service, 'Channel Manager projection.service')
  exactKeys(service, ['configurationKind', 'configApplies', 'revision', 'lastGoodRevision', 'writable'], 'Channel Manager projection.service')
  if (service.configurationKind !== 'host' || service.configApplies !== 'service-restart' || typeof service.writable !== 'boolean') {
    throw new TypeError('Channel Manager service projection is invalid')
  }
  const connections = array(projection.connections, 'Channel Manager projection.connections').map((item, index) => (
    connection(item, `Channel Manager projection.connections[${index}]`)
  ))
  const routes = array(projection.routes, 'Channel Manager projection.routes').map((value, index): ChannelManagerRouteProjection => {
    const item = object(value, `Channel Manager projection.routes[${index}]`)
    const label = `Channel Manager projection.routes[${index}]`
    exactKeys(item, ['id', 'connection', 'enabled', 'workspaceAlias', 'provider', 'model', 'profile', 'notifications'], label)
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
  })
  const accounts = array(projection.accounts, 'Channel Manager projection.accounts').map((value, index): ChannelManagerAccountProjection => {
    const item = object(value, `Channel Manager projection.accounts[${index}]`)
    const label = `Channel Manager projection.accounts[${index}]`
    exactKeys(item, [
      'ref', 'displayName', 'adapterKind', 'enabled', 'transportMode', 'secretState', 'implementationStatus', 'connectionState',
      'generation', 'inbound', 'outbound',
    ], label)
    const base = connection(Object.fromEntries(
      ['ref', 'displayName', 'adapterKind', 'enabled', 'transportMode', 'secretState'].map(key => [key, item[key]]),
    ), label)
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
      implementationStatus: oneOf(item.implementationStatus, ['implemented', 'verified', 'experimental', 'unavailable', 'planned'], `${label}.implementationStatus`),
      connectionState: oneOf(item.connectionState, ['disabled', 'starting', 'ready', 'retrying', 'unavailable', 'stopped'], `${label}.connectionState`),
      generation: boundedInteger(item.generation, `${label}.generation`),
      inbound: counts(item.inbound, `${label}.inbound`),
      outbound: counts(item.outbound, `${label}.outbound`),
    }
  })
  const bindings = array(projection.bindings, 'Channel Manager projection.bindings').map((value, index): ChannelManagerBindingProjection => {
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
        ...ref({ adapterId: channel.adapterId, accountId: channel.accountId, tenantId: channel.tenantId }, `${label}.channel`),
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
  })
  const logs = (projection.logs === undefined ? [] : array(projection.logs, 'Channel Manager projection.logs', 2_000)).map((value, index): ChannelManagerLogProjection => {
    const item = object(value, `Channel Manager projection.logs[${index}]`)
    const label = `Channel Manager projection.logs[${index}]`
    exactKeys(item, ['id', 'account', 'recordedAt', 'action', 'outcome'], label)
    const recordedAt = boundedText(item.recordedAt, `${label}.recordedAt`, 64)
    if (Number.isNaN(Date.parse(recordedAt))) throw new TypeError(`${label}.recordedAt is invalid`)
    return {
      id: boundedText(item.id, `${label}.id`, 256), account: ref(item.account, `${label}.account`), recordedAt,
      action: boundedText(item.action, `${label}.action`, 160), outcome: boundedText(item.outcome, `${label}.outcome`, 160),
    }
  })
  const diagnostics = array(projection.diagnostics, 'Channel Manager projection.diagnostics', 128).map((value, index): ChannelManagerDiagnosticProjection => {
    const item = object(value, `Channel Manager projection.diagnostics[${index}]`)
    const label = `Channel Manager projection.diagnostics[${index}]`
    exactKeys(item, ['id', 'status', 'message'], label)
    return {
      id: boundedText(item.id, `${label}.id`),
      status: oneOf(item.status, ['implemented', 'verified', 'experimental', 'unavailable', 'planned'], `${label}.status`),
      message: boundedText(item.message, `${label}.message`, 4096),
    }
  })
  return {
    contract: 'cordisx.channel-manager-projection/v1',
    schemaVersion: 1,
    status: oneOf(projection.status, ['implemented', 'verified', 'experimental', 'unavailable', 'planned'], 'Channel Manager projection.status'),
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

function cloneProjection(projection: ChannelManagerProjectionV1): ChannelManagerProjectionV1 {
  return normalizeProjection(JSON.parse(JSON.stringify(projection)) as unknown)
}

function selector(value: string): string {
  return value === 'default' ? 'default' : value
}

function statusTone(status: ChannelProductStatus | ChannelManagerAccountProjection['connectionState']) {
  if (status === 'implemented' || status === 'verified' || status === 'ready') return 'success' as const
  if (status === 'experimental' || status === 'starting' || status === 'retrying') return 'progress' as const
  if (status === 'unavailable') return 'danger' as const
  if (status === 'planned') return 'warning' as const
  return 'neutral' as const
}

function section(document: Document, title: string, description: string): { readonly root: HTMLElement; readonly body: HTMLElement } {
  const root = document.createElement('section')
  root.className = 'cxc-channel-section'
  const head = document.createElement('div')
  head.className = 'cxc-channel-section-head'
  const heading = document.createElement('h3')
  heading.textContent = title
  const copy = document.createElement('p')
  copy.textContent = description
  const body = document.createElement('div')
  head.append(heading, copy)
  root.append(head, body)
  return { root, body }
}

interface ChannelRecord {
  readonly id: string
  readonly connection: ChannelManagerConnectionProjection
  readonly account?: ChannelManagerAccountProjection
}

type ChannelDetailTab = 'configuration' | 'runtime' | 'logs' | 'sessions'

function channelRecords(projection: ChannelManagerProjectionV1): readonly ChannelRecord[] {
  const configured = new Map(projection.connections.map(item => [compositeRef(item.ref), item]))
  const live = new Map(projection.accounts.map(item => [compositeRef(item.ref), item]))
  return [...new Set([...configured.keys(), ...live.keys()])].sort().map(id => {
    const account = live.get(id)
    const connection = account ?? configured.get(id)!
    return { id, connection, ...(account === undefined ? {} : { account }) }
  })
}

function localSimulatorRecord(name: string): ChannelRecord {
  const displayName = name.trim()
  const accountId = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'local'
  const ref = { adapterId: 'simulator', accountId, tenantId: 'local' }
  return {
    id: compositeRef(ref),
    connection: {
      ref, displayName, adapterKind: 'simulator', enabled: true, transportMode: 'simulator', secretState: 'unavailable',
    },
  }
}

function channelState(record: ChannelRecord): ChannelManagerAccountProjection['connectionState'] {
  return record.account?.connectionState ?? (record.connection.enabled ? 'unavailable' : 'disabled')
}

function channelStateLabel(locale: string, state: ChannelManagerAccountProjection['connectionState']): string {
  const values: Record<ChannelManagerAccountProjection['connectionState'], readonly [string, string]> = {
    disabled: ['Disabled', '已停用'], starting: ['Starting', '启动中'], ready: ['Connected', '已连接'],
    retrying: ['Retrying', '重试中'], unavailable: ['Unavailable', '不可用'], stopped: ['Stopped', '已停止'],
  }
  return values[state][locale.startsWith('zh') ? 1 : 0]
}

function conciseEmpty(document: Document, label: string, attribute: string): HTMLElement {
  const root = document.createElement('div')
  root.className = 'cxc-channel-empty'
  root.dataset[attribute] = 'true'
  root.append(createHostSurfaceIcon(document, 'host:info'), document.createTextNode(label))
  return root
}

function accountItems(
  document: Document,
  projection: ChannelManagerProjectionV1,
  onOpen?: (record: ChannelRecord) => void,
): readonly HostCollectionItem[] {
  return channelRecords(projection).map(record => channelItem(document, record, onOpen))
}

function channelItem(
  document: Document,
  record: ChannelRecord,
  onOpen?: (record: ChannelRecord) => void,
): HostCollectionItem {
  const { id, connection, account } = record
  const state = account?.connectionState ?? (connection.enabled ? 'unavailable' : 'disabled')
  const displayName = account?.displayName ?? connection.displayName ?? connection.ref.accountId
  return {
    id,
    title: displayName,
    description: connection.adapterKind,
    machineId: id,
    searchText: [displayName, connection.ref.adapterId, connection.ref.tenantId, connection.adapterKind, connection.transportMode, state],
    icon: () => createHostSurfaceIcon(document, state === 'ready' ? 'host:success' : 'host:layers'),
    avatar: {
      label: displayName,
      badge: () => createHostSurfaceIcon(document, connection.adapterKind === 'feishu' ? 'host:layers' : 'host:info'),
    },
    statusPosition: 'card',
    status: {
      label: channelStateLabel(document.documentElement.lang || 'en', state),
      tone: statusTone(state),
    },
    ...(onOpen === undefined ? {} : { openLabel: 'Open channel details', onOpen: () => onOpen(record) }),
  }
}

function routeItems(document: Document, projection: ChannelManagerProjectionV1): readonly HostCollectionItem[] {
  return projection.routes.map(route => ({
    id: route.id,
    title: route.id,
    description: `${selector(route.provider)} · ${selector(route.model)} · ${route.workspaceAlias}`,
    machineId: `${compositeRef(route.connection)} → ${route.profile}`,
    searchText: [...route.notifications, route.enabled ? 'enabled' : 'disabled'],
    icon: () => createHostSurfaceIcon(document, 'host:open'),
    status: {
      label: route.enabled ? 'enabled' : 'disabled',
      tone: route.enabled ? 'success' : 'neutral',
      detail: `${route.notifications.length} notification event types`,
    },
  }))
}

function bindingItems(document: Document, projection: ChannelManagerProjectionV1): readonly HostCollectionItem[] {
  return projection.bindings.map(binding => ({
    id: binding.bindingId,
    title: binding.channel.conversationId,
    description: `${binding.session.providerId} · ${binding.session.remoteSessionId}`,
    machineId: `${compositeRef(binding.channel)}/${binding.channel.threadId}`,
    searchText: [binding.routeId, binding.state, binding.session.providerId, binding.session.remoteSessionId],
    icon: () => createHostSurfaceIcon(document, 'host:layers'),
    status: {
      label: binding.state,
      tone: binding.state === 'active' ? 'success' : binding.state === 'unavailable' ? 'danger' : 'neutral',
      detail: `route ${binding.routeId}`,
    },
  }))
}

export interface CordisXChannelManager {
  snapshot(): ChannelManagerProjectionV1
  subscribe(listener: () => void): Disposable<void>
  rememberLocalCandidate(connection: ChannelManagerConnectionProjection): void
  mount(context: CordisXPageMountContext): Disposable<void>
}

export interface ChannelManagerServiceConfigApi {
  list(): Promise<readonly HostServiceConfigDescriptor[]>
  mutate(mutation: HostServiceConfigMutation): Promise<HostServiceConfigMutationResult>
}

export interface ChannelManagerServiceInput {
  readonly projection?: ChannelManagerProjectionV1
  readonly serviceConfig?: ChannelManagerServiceConfigApi
  /**
   * A Host-private capture seam. The typed request is the only permitted path
   * for a newly typed credential; its return value is an opaque reference and
   * neither value is admitted to the renderer projection or service config.
   */
  readonly captureCredential?: (input: {
    readonly account: ChannelManagerConnectionProjection['ref']
    readonly secret: string
  }) => Promise<{ readonly secretRef: string }>
}

/** Host-owned Channel settings renderer. Plugins can request the seat but never receive its DOM internals. */
export class CordisXChannelManagerService extends Service implements CordisXChannelManager {
  constructor(ctx: Context, input: ChannelManagerProjectionV1 | ChannelManagerServiceInput = EMPTY_PROJECTION) {
    super(ctx, 'channelManager')
    const wrapped = 'projection' in input || 'serviceConfig' in input
      ? input as ChannelManagerServiceInput
      : { projection: input as ChannelManagerProjectionV1 }
    projections.set(this, Object.freeze({
      projection: normalizeProjection(wrapped.projection ?? EMPTY_PROJECTION),
      ...(wrapped.serviceConfig === undefined ? {} : { serviceConfig: wrapped.serviceConfig }),
      ...(wrapped.captureCredential === undefined ? {} : { captureCredential: wrapped.captureCredential }),
      localConnections: [],
      listeners: new Set<() => void>(),
    }))
  }

  snapshot(): ChannelManagerProjectionV1 {
    return cloneProjection(projectionFor(this))
  }

  subscribe(listener: () => void): Disposable<void> {
    const listeners = stateFor(this).listeners
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  rememberLocalCandidate(connection: ChannelManagerConnectionProjection): void {
    const state = stateFor(this)
    const normalized = normalizeProjection({ ...state.projection, connections: [connection] }).connections[0]!
    const id = compositeRef(normalized.ref)
    if ([...state.projection.connections, ...state.localConnections].some(item => compositeRef(item.ref) === id)) return
    state.localConnections.push(normalized)
    for (const listener of state.listeners) listener()
  }

  mount(context: CordisXPageMountContext): Disposable<void> {
    const { document } = context
    const state = stateFor(this)
    const projection = state.projection
    const serviceConfig = state.serviceConfig
    const locale = document.documentElement.lang || 'en'
    const theme = new HostThemeProjection(document)
    const root = document.createElement('div')
    root.className = 'cxc-channel-manager'
    root.dataset.channelManager = 'mounted'
    root.dataset.channelStatus = projection.status
    const detachTheme = theme.attach(root)
    const style = document.createElement('style')
    style.dataset.channelManagerStyles = 'true'
    // `manager.content` is mounted inside the Host-owned Manager, which has
    // already installed the shared collection and form foundations. Repeating
    // those global selectors here would place `.cxf-scope { font: inherit }`
    // after the Manager modal rule and reset the whole dialog to the browser
    // default font size when the Channel page opens.
    style.textContent = CHANNEL_MANAGER_STYLES
    const content = document.createElement('div')
    content.dataset.channelManagerContent = 'true'
    const forms = new HostFormAdapter(document, root, () => locale)
    let listQuery = ''
    let candidateName = ''
    let candidatePlatform: 'simulator' | 'feishu' = 'simulator'
    let candidateAppId = ''
    let candidateTenant = 'default'
    let candidateTransport: 'simulator' | 'websocket' = 'simulator'
    let candidateProvider = 'default'
    let candidateModel = 'default'
    let candidateProfile = 'default'
    let candidateWorkspace = 'cordisx'
    let candidateNotifications = true
    let candidateSecret = ''
    let disposeCurrent = (): void => {}

    const records = (): readonly ChannelRecord[] => channelRecords(projectionFor(this))

    const renderList = (): void => {
      disposeCurrent()
      const page = document.createElement('section')
      page.className = 'cxc-channel-list-page'
      page.dataset.channelPage = 'list'
      const collection = createHostCollection(document, {
        id: 'channel-list',
        label: managerCopy(locale, 'channel.accounts'),
        items: records().map(record => channelItem(document, record)).map(item => ({
          ...item,
          onOpen: () => {
            void context.navigation?.navigate({ id: 'configuration', params: { accountId: item.id } })
          },
          openLabel: managerCopy(locale, 'channel.open'),
        })),
        search: {
          label: managerCopy(locale, 'channel.search.label'), placeholder: managerCopy(locale, 'channel.search.placeholder'),
          clearLabel: managerCopy(locale, 'channel.search.clear'), query: listQuery,
          icon: () => createHostSurfaceIcon(document, 'host:info'),
          onQueryChange: query => { listQuery = query },
        },
        emptyLabel: managerCopy(locale, 'channel.accounts.empty'),
        noMatchesLabel: managerCopy(locale, 'channel.search.empty'),
      })
      collection.element.classList.add('cxc-channel-list-collection')
      const create = document.createElement('button')
      create.type = 'button'
      create.classList.add('cxc-channel-create')
      create.dataset.channelCreate = 'true'
      create.setAttribute('aria-label', managerCopy(locale, 'channel.create.icon-label'))
      create.title = managerCopy(locale, 'channel.create.icon-label')
      create.append(createManagerIcon(document, 'marketplace-source-add'))
      create.addEventListener('click', () => { void context.navigation?.navigate({ id: 'create' }) })
      collection.element.append(create)
      page.append(collection.element)
      content.replaceChildren(page)
      disposeCurrent = collection.dispose
    }

    const renderCreate = (): void => {
      disposeCurrent()
      const page = document.createElement('section')
      page.className = 'cxc-channel-detail'
      page.dataset.channelPage = 'create'
      const form = forms.form('channel-create')
      form.classList.add('cxc-channel-config-form')
      form.dataset.channelCreateForm = 'true'
      const configuration = forms.section(managerCopy(locale, 'channel.configuration'), managerCopy(locale, 'channel.create.local-only'))
      const nameItem = forms.item({ id: 'channel-create-name', label: managerCopy(locale, 'channel.create.name'), required: true, fullWidth: true })
      const nameControl = forms.control({
        namespace: 'channel-manager', path: ['candidate', 'name'], type: 'string', value: candidateName,
        disabled: false, required: true,
      }, 'channel-create-name', value => {
        candidateName = typeof value === 'string' ? value : ''
        nameItem.setError(candidateName.trim() === '' ? managerCopy(locale, 'form.required') : undefined)
      })
      forms.connect(nameItem, nameControl)
      nameItem.control.append(nameControl.root)
      configuration.content.append(nameItem.root)
      const platformItem = forms.item({ id: 'channel-create-platform', label: managerCopy(locale, 'channel.create.platform'), required: true, fullWidth: true })
      const platformControl = forms.control({
        namespace: 'channel-manager', path: ['candidate', 'platform'], type: 'string', value: candidatePlatform, disabled: false, required: true,
        choices: [{ value: 'simulator', label: managerCopy(locale, 'channel.create.simulator') }, { value: 'feishu', label: managerCopy(locale, 'channel.create.feishu') }],
      }, 'channel-create-platform', value => {
        candidatePlatform = value === 'feishu' ? 'feishu' : 'simulator'
        candidateTransport = candidatePlatform === 'feishu' ? 'websocket' : 'simulator'
      })
      forms.connect(platformItem, platformControl); platformItem.control.append(platformControl.root); configuration.content.append(platformItem.root)
      const addText = (id: string, label: string, value: () => string, set: (next: string) => void, required = false): void => {
        const item = forms.item({ id, label, required, fullWidth: true })
        const control = forms.control({ namespace: 'channel-manager', path: ['candidate', id], type: 'string', value: value(), disabled: false, required }, id, next => set(typeof next === 'string' ? next : ''))
        forms.connect(item, control); item.control.append(control.root); configuration.content.append(item.root)
      }
      addText('channel-create-app-id', managerCopy(locale, 'channel.create.app-id'), () => candidateAppId, value => { candidateAppId = value })
      addText('channel-create-tenant', managerCopy(locale, 'channel.create.tenant'), () => candidateTenant, value => { candidateTenant = value })
      addText('channel-create-transport', managerCopy(locale, 'channel.field.transport'), () => candidateTransport, value => { candidateTransport = value === 'websocket' ? 'websocket' : 'simulator' })
      addText('channel-create-provider', managerCopy(locale, 'channel.create.provider'), () => candidateProvider, value => { candidateProvider = value })
      addText('channel-create-model', managerCopy(locale, 'channel.create.model'), () => candidateModel, value => { candidateModel = value })
      addText('channel-create-profile', managerCopy(locale, 'channel.create.profile'), () => candidateProfile, value => { candidateProfile = value })
      addText('channel-create-workspace', managerCopy(locale, 'channel.create.workspace'), () => candidateWorkspace, value => { candidateWorkspace = value })
      const notificationItem = forms.item({ id: 'channel-create-notifications', label: managerCopy(locale, 'channel.create.notifications'), fullWidth: true })
      const notificationControl = forms.control({ namespace: 'channel-manager', path: ['candidate', 'notifications'], type: 'boolean', role: 'switch', value: candidateNotifications, disabled: false, required: false }, 'channel-create-notifications', value => { candidateNotifications = value === true })
      forms.connect(notificationItem, notificationControl); notificationItem.control.append(notificationControl.root); configuration.content.append(notificationItem.root)
      const credentialItem = forms.item({ id: 'channel-create-credential', label: managerCopy(locale, 'channel.field.credentials'), help: managerCopy(locale, 'channel.credentials.help'), fullWidth: true })
      const credential = document.createElement('input')
      credential.id = 'channel-create-credential'; credential.type = 'password'; credential.autocomplete = 'new-password'; credential.dataset.channelCredentialCapture = 'true'
      credential.addEventListener('input', () => { candidateSecret = credential.value })
      credentialItem.control.append(credential); configuration.content.append(credentialItem.root)
      const actions = document.createElement('div')
      actions.className = 'cxc-channel-create-actions'
      const status = forms.note('')
      status.dataset.channelCreateStatus = 'true'
      const submit = forms.button(managerCopy(locale, 'channel.create.save'), { type: 'submit', variant: 'primary' })
      submit.dataset.channelCreateSubmit = 'true'
      actions.append(status, submit)
      form.append(configuration.root, actions)
      form.addEventListener('submit', event => {
        event.preventDefault()
        const name = candidateName.trim()
        if (name === '') { nameItem.setError(managerCopy(locale, 'form.required')); return }
        if (!projection.service.writable || serviceConfig === undefined) {
          status.textContent = managerCopy(locale, 'channel.create.unavailable')
          return
        }
        const accountId = candidatePlatform === 'feishu' ? candidateAppId.trim() : undefined
        if (candidatePlatform === 'feishu' && accountId === '') { status.textContent = managerCopy(locale, 'form.required'); return }
        const record = candidatePlatform === 'simulator'
          ? localSimulatorRecord(name)
          : {
              id: compositeRef({ adapterId: 'feishu', accountId: accountId!, tenantId: candidateTenant.trim() || 'default' }),
              connection: {
                ref: { adapterId: 'feishu', accountId: accountId!, tenantId: candidateTenant.trim() || 'default' }, displayName: name,
                adapterKind: 'feishu', enabled: false, transportMode: 'websocket', secretState: 'missing' as const,
              },
            }
        submit.disabled = true
        status.textContent = managerCopy(locale, 'form.saving')
        void (async () => {
          const capture = state.captureCredential
          const captured = candidatePlatform === 'feishu'
            ? (candidateSecret === '' || capture === undefined ? undefined : await capture({ account: record.connection.ref, secret: candidateSecret }))
            : undefined
          candidateSecret = ''
          credential.value = ''
          if (candidatePlatform === 'feishu' && captured === undefined) throw new Error('Host credential capture is unavailable')
          return await serviceConfig.list().then(descriptors => {
          const descriptor = descriptors.find(item => item.identity.pluginId === 'channel' && item.identity.serviceId === 'runtime')
          const raw = descriptor?.configuration
          if (descriptor === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Channel service configuration is unavailable')
          const configuration = cloneJson(raw) as { connections?: Array<Record<string, unknown>>; routes?: Array<Record<string, unknown>> }
          const existing = configuration.connections?.some(item => compositeRef(item.ref as ChannelManagerConnectionProjection['ref']) === record.id) === true
          if (existing) throw new Error('A local simulator channel with this name already exists')
          const routeId = `${record.connection.ref.accountId}-default`
          configuration.connections = [...(configuration.connections ?? []), {
            ref: record.connection.ref, adapterKind: candidatePlatform, enabled: candidatePlatform === 'simulator',
            transport: { mode: candidateTransport },
            ...(captured === undefined ? {} : { secretRef: captured.secretRef }),
          }]
          configuration.routes = [...(configuration.routes ?? []), {
            id: routeId, connection: record.connection.ref, enabled: true,
            policy: { conversationKinds: ['direct'] },
            task: {
              provider: candidateProvider === 'default' ? { useDefault: true } : { id: candidateProvider },
              model: candidateModel === 'default' ? { useDefault: true } : { id: candidateModel },
              profile: candidateProfile === 'default' ? { useDefault: true } : { id: candidateProfile }, workspaceAlias: candidateWorkspace.trim() || 'cordisx',
            },
            notifications: candidateNotifications ? ['completion', 'failure', 'approval-required'] : [],
          }]
          return serviceConfig.mutate({
            contract: 'cordisx.service-config-mutation/v1', schemaVersion: 1,
            identity: descriptor.identity, scope: descriptor.scope, expectedRevision: descriptor.revision,
            configuration: configuration as HostServiceConfigMutation['configuration'],
          })
          })
        })().then(result => {
          if (!form.isConnected) return
          submit.disabled = false
          if (result.status !== 'applied') {
            status.textContent = result.status === 'conflict' ? managerCopy(locale, 'form.conflict-retained') : managerCopy(locale, 'channel.create.unavailable')
            return
          }
          this.rememberLocalCandidate(record.connection)
          candidateName = ''
          listQuery = ''
          void context.navigation?.navigate({ id: 'settings' })
        }).catch(() => {
          if (!form.isConnected) return
          submit.disabled = false
          status.textContent = managerCopy(locale, 'channel.create.unavailable')
        })
      })
      page.append(form)
      content.replaceChildren(page)
      disposeCurrent = (): void => {}
    }

    const renderConfiguration = (record: ChannelRecord, panel: HTMLElement): void => {
      const configuration = document.createElement('section')
      configuration.dataset.channelConfiguration = record.id
      if (!projection.service.writable || serviceConfig === undefined) {
        configuration.append(conciseEmpty(document, managerCopy(locale, 'channel.configuration.unavailable'), 'channelConfigurationUnavailable'))
        panel.append(configuration)
        return
      }
      configuration.append(conciseEmpty(document, managerCopy(locale, 'form.saving'), 'channelConfigurationLoading'))
      panel.append(configuration)
      void serviceConfig.list().then(descriptors => {
        if (!configuration.isConnected) return
        const descriptor = descriptors.find(item => item.identity.pluginId === 'channel' && item.identity.serviceId === 'runtime')
        const raw = descriptor?.configuration
        if (descriptor === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
          configuration.replaceChildren(conciseEmpty(document, managerCopy(locale, 'channel.configuration.unavailable'), 'channelConfigurationUnavailable'))
          return
        }
        const source = cloneJson(raw) as { connections?: Array<Record<string, unknown>> }
        const connection = source.connections?.find(item => compositeRef(item.ref as ChannelManagerConnectionProjection['ref']) === record.id)
        if (connection === undefined || typeof connection.enabled !== 'boolean') {
          configuration.replaceChildren(conciseEmpty(document, managerCopy(locale, 'channel.configuration.unavailable'), 'channelConfigurationUnavailable'))
          return
        }
        let enabled = connection.enabled
        const form = forms.form(`channel-config-${record.id}`)
        form.dataset.channelConfigurationForm = record.id
        const grid = forms.grid()
        const item = forms.item({ id: `channel-enabled-${record.id}`, label: managerCopy(locale, 'channel.field.status'), fullWidth: true })
        const control = forms.control({
          namespace: 'channel-manager', path: ['connections', record.id, 'enabled'], type: 'boolean', role: 'switch',
          value: enabled, disabled: false, required: false,
        }, `channel-enabled-${record.id}`, value => { enabled = value === true })
        forms.connect(item, control)
        item.control.append(control.root)
        grid.append(item.root)
        const actions = document.createElement('div')
        actions.className = 'cxc-channel-create-actions'
        const status = forms.note('')
        status.dataset.channelConfigurationStatus = 'true'
        const submit = forms.button(managerCopy(locale, 'form.save-configuration'), { type: 'submit', variant: 'primary' })
        submit.dataset.channelConfigurationSave = record.id
        const reconnect = forms.button(managerCopy(locale, 'channel.reconnect'), { type: 'button' })
        reconnect.dataset.channelReconnect = record.id
        reconnect.addEventListener('click', () => form.requestSubmit())
        actions.append(status, reconnect, submit)
        form.append(grid, actions)
        form.addEventListener('submit', event => {
          event.preventDefault()
          const candidate = structuredClone(source) as { connections?: Array<Record<string, unknown>> }
          const target = candidate.connections?.find(item => compositeRef(item.ref as ChannelManagerConnectionProjection['ref']) === record.id)
          if (target === undefined) return
          target.enabled = enabled
          submit.disabled = true
          status.textContent = managerCopy(locale, 'form.saving')
          const mutation: HostServiceConfigMutation = {
            contract: 'cordisx.service-config-mutation/v1', schemaVersion: 1,
            identity: descriptor.identity, scope: descriptor.scope, expectedRevision: descriptor.revision,
            configuration: candidate as HostServiceConfigMutation['configuration'],
          }
          void serviceConfig.mutate(mutation).then(result => {
            if (!configuration.isConnected) return
            submit.disabled = false
            status.textContent = result.status === 'applied' ? managerCopy(locale, 'form.apply-service-restart') : result.status === 'conflict'
              ? managerCopy(locale, 'form.conflict-retained') : managerCopy(locale, 'channel.configuration.unavailable')
          }).catch(() => {
            if (!configuration.isConnected) return
            submit.disabled = false
            status.textContent = managerCopy(locale, 'channel.configuration.unavailable')
          })
        })
        configuration.replaceChildren(form)
      }).catch(() => {
        if (configuration.isConnected) configuration.replaceChildren(conciseEmpty(document, managerCopy(locale, 'channel.configuration.unavailable'), 'channelConfigurationUnavailable'))
      })
    }

    const renderRuntime = (record: ChannelRecord, panel: HTMLElement): (() => void) => {
      const account = record.account
      if (account === undefined) {
        panel.append(conciseEmpty(document, managerCopy(locale, 'channel.runtime.unavailable'), 'channelRuntimeUnavailable'))
        return () => {}
      }
      const cards = document.createElement('section'); cards.className = 'cxc-channel-status-cards'; cards.dataset.channelRuntimeStatus = record.id
      for (const [label, value] of [
        [managerCopy(locale, 'channel.field.status'), channelStateLabel(locale, account.connectionState)],
        [managerCopy(locale, 'channel.status.inbound'), String(account.inbound.pending + account.inbound.retrying)],
        [managerCopy(locale, 'channel.status.outbound'), String(account.outbound.pending + account.outbound.retrying)],
        [managerCopy(locale, 'channel.status.generation'), String(account.generation)],
      ]) {
        const card = document.createElement('div'); card.className = 'cxc-channel-status-card'
        const strong = document.createElement('strong'); strong.textContent = value ?? ''
        const caption = document.createElement('span'); caption.textContent = label ?? ''
        card.append(strong, caption); cards.append(card)
      }
      panel.append(cards)
      return () => {}
    }

    const renderLogs = (record: ChannelRecord, panel: HTMLElement): (() => void) => {
      const all = (projection.logs ?? []).filter(entry => compositeRef(entry.account) === record.id)
      const root = document.createElement('section')
      root.dataset.channelLogs = 'true'
      if (all.length === 0) {
        root.append(conciseEmpty(document, managerCopy(locale, 'channel.logs.unavailable'), 'channelLogsEmpty'))
        panel.append(root)
        return () => {}
      }
      let query = ''
      let outcome: 'all' | 'success' | 'failure' = 'all'
      let page = 0
      const pageSize = 25
      const toolbar = document.createElement('div')
      toolbar.className = 'cxc-channel-log-toolbar'
      const search = document.createElement('input')
      search.type = 'search'
      search.dataset.channelLogQuery = 'true'
      search.placeholder = managerCopy(locale, 'channel.logs.search')
      search.setAttribute('aria-label', managerCopy(locale, 'channel.logs.search'))
      const filter = forms.select<'all' | 'success' | 'failure'>(managerCopy(locale, 'channel.logs.all'), [
        { value: 'all', label: managerCopy(locale, 'channel.logs.all') },
        { value: 'success', label: managerCopy(locale, 'channel.logs.success') },
        { value: 'failure', label: managerCopy(locale, 'channel.logs.failure') },
      ], outcome, next => { outcome = next ?? 'all'; page = 0; draw() }, { id: 'channel-log-outcome' })
      filter.dataset.channelLogOutcome = 'true'
      const exportButton = document.createElement('button')
      exportButton.type = 'button'; exportButton.className = 'cxc-channel-log-export'; exportButton.dataset.channelLogExport = 'json'
      exportButton.textContent = managerCopy(locale, 'channel.logs.export')
      const list = document.createElement('div'); list.className = 'cxc-channel-log-list'; list.dataset.channelLogList = 'true'
      const pagination = document.createElement('div'); pagination.className = 'cxc-channel-log-pagination'; pagination.dataset.channelLogPagination = 'true'
      const filtered = (): readonly ChannelManagerLogProjection[] => all.filter(entry => {
        const text = `${entry.action} ${entry.outcome} ${entry.recordedAt}`.toLowerCase()
        const matchesQuery = query === '' || text.includes(query.toLowerCase())
        const matchesOutcome = outcome === 'all' || (outcome === 'success' ? /success|allow|complete|applied|ready/iu : /fail|deny|error|dead|unavailable|reject/iu).test(entry.outcome)
        return matchesQuery && matchesOutcome
      }).sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))
      const draw = (): void => {
        const items = filtered()
        const totalPages = Math.max(1, Math.ceil(items.length / pageSize))
        page = Math.min(page, totalPages - 1)
        const windowed = items.slice(page * pageSize, (page + 1) * pageSize)
        list.replaceChildren(...windowed.map(entry => {
          const item = document.createElement('article'); item.className = 'cxc-channel-log-entry'; item.dataset.channelLogEntry = entry.id
          const time = document.createElement('time'); time.dateTime = entry.recordedAt; time.textContent = new Date(entry.recordedAt).toLocaleString(locale)
          const action = document.createElement('span'); action.textContent = entry.action
          const result = document.createElement('span'); result.className = 'cxc-channel-log-outcome'; result.textContent = entry.outcome
          item.append(time, action, result); return item
        }))
        if (windowed.length === 0) list.replaceChildren(conciseEmpty(document, managerCopy(locale, 'channel.search.empty'), 'channelLogsNoMatches'))
        const previous = document.createElement('button'); previous.type = 'button'; previous.className = 'cxc-channel-log-page'; previous.textContent = '‹'; previous.disabled = page === 0
        previous.addEventListener('click', () => { page -= 1; draw() })
        const label = document.createElement('span'); label.textContent = `${managerCopy(locale, 'channel.logs.page')} ${page + 1}/${totalPages}`
        const next = document.createElement('button'); next.type = 'button'; next.className = 'cxc-channel-log-page'; next.textContent = '›'; next.disabled = page + 1 >= totalPages
        next.addEventListener('click', () => { page += 1; draw() })
        pagination.replaceChildren(previous, label, next)
      }
      search.addEventListener('input', () => { query = search.value.trim(); page = 0; draw() })
      exportButton.addEventListener('click', () => {
        const view = document.defaultView
        const createObjectURL = view?.URL?.createObjectURL
        if (createObjectURL === undefined) return
        const payload = filtered().map(({ id, recordedAt, action, outcome }) => ({ id, recordedAt, action, outcome }))
        const href = createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }))
        const download = document.createElement('a'); download.href = href; download.download = `cordisx-channel-${record.connection.ref.accountId}-logs.json`; download.hidden = true
        root.append(download); download.click(); download.remove(); view?.setTimeout(() => view.URL.revokeObjectURL(href), 0)
      })
      toolbar.append(search, filter, exportButton)
      root.append(toolbar, list, pagination); panel.append(root); draw()
      return () => {}
    }

    const renderSessions = (record: ChannelRecord, panel: HTMLElement): (() => void) => {
      const matchingRoutes = projection.routes.filter(route => compositeRef(route.connection) === record.id)
      const matchingBindings = projection.bindings.filter(binding => compositeRef(binding.channel) === record.id)
      if (matchingRoutes.length === 0 && matchingBindings.length === 0) {
        panel.append(conciseEmpty(document, managerCopy(locale, 'channel.sessions.unavailable'), 'channelSessionActions'))
        return () => {}
      }
      const routes = section(document, managerCopy(locale, 'channel.routes'), managerCopy(locale, 'channel.routes.description'))
      const routeCollection = createHostCollection(document, {
        id: 'channel-routes', label: managerCopy(locale, 'channel.routes'), items: routeItems(document, { ...projection, routes: matchingRoutes }),
        search: { enabled: false, reason: 'This detail view only presents the selected channel.' }, emptyLabel: managerCopy(locale, 'channel.routes.empty'),
      })
      routes.body.append(routeCollection.element)
      const bindings = section(document, managerCopy(locale, 'channel.bindings'), managerCopy(locale, 'channel.bindings.description'))
      const bindingCollection = createHostCollection(document, {
        id: 'channel-bindings', label: managerCopy(locale, 'channel.bindings'), items: bindingItems(document, { ...projection, bindings: matchingBindings }),
        search: { enabled: false, reason: 'This detail view only presents the selected channel.' }, emptyLabel: managerCopy(locale, 'channel.bindings.empty'),
      })
      bindings.body.append(bindingCollection.element)
      const unavailableOperations = document.createElement('div')
      unavailableOperations.className = 'cxc-channel-create-actions'
      const note = document.createElement('span'); note.className = 'cxc-channel-operation-note'; note.textContent = managerCopy(locale, 'channel.binding-operations.unavailable')
      for (const [action, label] of [['archive', 'channel.binding.archive'], ['restore', 'channel.binding.restore'], ['unbind', 'channel.binding.unbind']] as const) {
        const button = forms.button(managerCopy(locale, label), { type: 'button' }); button.disabled = true; button.dataset.channelBindingOperation = action; button.title = managerCopy(locale, 'channel.binding-operations.unavailable'); unavailableOperations.append(button)
      }
      unavailableOperations.prepend(note); bindings.body.append(unavailableOperations)
      panel.append(routes.root, bindings.root)
      return () => { bindingCollection.dispose(); routeCollection.dispose() }
    }

    const renderDetail = (record: ChannelRecord, tab: ChannelDetailTab): void => {
      disposeCurrent()
      const page = document.createElement('section')
      page.className = 'cxc-channel-detail'
      page.dataset.channelPage = 'detail'
      page.dataset.channelDetail = record.id
      const panel = document.createElement('div')
      panel.className = 'cxc-channel-panel'
      panel.setAttribute('role', 'tabpanel')
      panel.dataset.channelDetailPanel = tab
      let disposePanel = (): void => {}
      if (tab === 'configuration') renderConfiguration(record, panel)
      else if (tab === 'runtime') disposePanel = renderRuntime(record, panel)
      else if (tab === 'logs') disposePanel = renderLogs(record, panel)
      else disposePanel = renderSessions(record, panel)
      page.append(panel)
      content.replaceChildren(page)
      disposeCurrent = disposePanel
    }

    const render = (): void => {
      const routeId = context.routeId ?? 'channel:settings'
      if (routeId.endsWith(':settings')) { renderList(); return }
      if (routeId.endsWith(':create')) { renderCreate(); return }
      const accountId = context.params?.accountId
      const selected = typeof accountId === 'string' ? records().find(record => record.id === accountId) : undefined
      if (selected === undefined) {
        disposeCurrent()
        content.replaceChildren(conciseEmpty(document, managerCopy(locale, 'channel.accounts.empty'), 'channelMissingAccount'))
        return
      }
      const tab: ChannelDetailTab = routeId.endsWith(':runtime') ? 'runtime'
        : routeId.endsWith(':logs') ? 'logs'
        : routeId.endsWith(':sessions') ? 'sessions' : 'configuration'
      renderDetail(selected, tab)
    }

    render()
    root.append(style, content)
    context.container.append(root)
    const abort = () => root.dataset.channelManagerAborted = 'true'
    context.signal.addEventListener('abort', abort, { once: true })
    return () => {
      context.signal.removeEventListener('abort', abort)
      disposeCurrent()
      detachTheme()
      theme.dispose()
      root.remove()
    }
  }
}
