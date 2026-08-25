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
  return stateFor(service).projection
}

const CHANNEL_MANAGER_STYLES = String.raw`
  .cxc-channel-manager { min-width: 0; color: var(--cx-text); }
  .cxc-channel-list-page { display: grid; grid-template-rows: minmax(0, 1fr); height: clamp(20rem, 62vh, 38rem); min-height: 0; }
  .cxc-channel-detail-head { display: grid; gap: 4px; }
  .cxc-channel-detail-head h2, .cxc-channel-section h3 { margin: 0; color: var(--cx-text); }
  .cxc-channel-detail-head h2 { font-size: 16px; }
  .cxc-channel-detail-head p, .cxc-channel-section p { margin: 0; color: var(--cx-muted); font-size: 11px; line-height: 1.5; }
  .cxc-channel-list-collection { display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-rows: auto minmax(0, 1fr); min-height: 0; column-gap: 8px; }
  .cxc-channel-list-collection > .cxc-search { grid-column: 1; grid-row: 1; }
  .cxc-channel-list-collection > .cxc-list { grid-column: 1 / -1; grid-row: 2; }
  .cxc-channel-list-collection .cxc-list { min-height: 0; max-height: none; overflow: auto; padding-right: 3px; align-content: start; scrollbar-gutter: stable; }
  .cxc-channel-create { display: grid; grid-column: 2; grid-row: 1; place-items: center; width: 38px; height: 38px; padding: 0; border: 1px solid var(--cx-border); border-radius: 9px; background: var(--cx-surface-raised); color: var(--cx-text); cursor: pointer; }
  .cxc-channel-create:hover, .cxc-channel-create:focus-visible { border-color: var(--cx-primary); background: var(--cx-hover); outline: 2px solid var(--cx-focus); outline-offset: 2px; }
  .cxc-channel-create .cxm-material-icon { width: 18px; height: 18px; }
  .cxc-channel-detail { display: grid; gap: 16px; min-width: 0; }
  .cxc-channel-detail-title-row { display: flex; align-items: flex-start; gap: 9px; min-width: 0; }
  .cxc-channel-back { display: grid; place-items: center; width: 28px; height: 28px; flex: none; margin-top: -3px; padding: 0; border: 0; border-radius: 7px; background: transparent; color: var(--cx-muted); cursor: pointer; }
  .cxc-channel-back:hover, .cxc-channel-back:focus-visible { background: var(--cx-hover); color: var(--cx-text); outline: none; }
  .cxc-channel-back:focus-visible { box-shadow: 0 0 0 2px var(--cx-focus); }
  .cxc-channel-detail-tools { display: flex; align-items: center; gap: 5px; }
  .cxc-channel-detail-tools > .cxm-tabs { flex: 1; margin: 0; }
  .cxc-channel-panel { min-width: 0; }
  .cxc-channel-config-form { inline-size: 100%; margin-inline: 0; }
  .cxc-channel-empty { display: flex; align-items: center; gap: 9px; min-height: 42px; padding: 11px 12px; border: 1px solid var(--cx-border); border-radius: 10px; background: var(--cx-surface-raised); color: var(--cx-muted); font-size: 12px; }
  .cxc-channel-empty .cordisx-host-icon, .cxc-channel-empty .cordisx-host-icon svg { width: 18px; height: 18px; flex: none; }
  .cxc-channel-create-actions { display: flex; justify-content: flex-end; }
  .cxc-channel-section { display: grid; gap: 7px; min-width: 0; }
  .cxc-channel-section-head { display: grid; gap: 2px; }
  .cxc-channel-section h3 { font-size: 12px; }
  .cxc-channel-manager .cordisx-host-icon, .cxc-channel-manager .cordisx-host-icon svg { width: 22px; height: 22px; }
  .cxc-channel-back .cordisx-host-icon, .cxc-channel-back .cordisx-host-icon svg { width: 18px; height: 18px; }
  @media (max-width: 520px) {
    .cxc-channel-list-page { height: clamp(18rem, 60vh, 34rem); }
    .cxc-channel-list-collection .cxc-list { grid-template-columns: minmax(0, 1fr); }
    .cxc-channel-create { width: 38px; }
  }
`

function compositeRef(ref: ChannelManagerConnectionProjection['ref']): string {
  return `${ref.adapterId}/${ref.accountId}/${ref.tenantId}`
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
  exactKeys(item, ['ref', 'adapterKind', 'enabled', 'transportMode', 'secretState'], label)
  if (typeof item.enabled !== 'boolean') throw new TypeError(`${label}.enabled is invalid`)
  return {
    ref: ref(item.ref, `${label}.ref`),
    adapterKind: boundedText(item.adapterKind, `${label}.adapterKind`),
    enabled: item.enabled,
    transportMode: boundedText(item.transportMode, `${label}.transportMode`),
    secretState: oneOf(item.secretState, ['missing', 'ready', 'unavailable'], `${label}.secretState`),
  }
}

function normalizeProjection(value: unknown): ChannelManagerProjectionV1 {
  const projection = object(value, 'Channel Manager projection')
  exactKeys(projection, ['contract', 'schemaVersion', 'status', 'service', 'connections', 'routes', 'accounts', 'bindings', 'diagnostics'], 'Channel Manager projection')
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
      'ref', 'adapterKind', 'enabled', 'transportMode', 'secretState', 'implementationStatus', 'connectionState',
      'generation', 'inbound', 'outbound',
    ], label)
    const base = connection(Object.fromEntries(
      ['ref', 'adapterKind', 'enabled', 'transportMode', 'secretState'].map(key => [key, item[key]]),
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

type ChannelDetailTab = 'configuration' | 'logs' | 'sessions'

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
  const accountId = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'local'
  const ref = { adapterId: 'simulator', accountId, tenantId: 'local' }
  return {
    id: compositeRef(ref),
    connection: {
      ref, adapterKind: 'simulator', enabled: true, transportMode: 'simulator', secretState: 'unavailable',
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
  return {
    id,
    title: connection.ref.accountId,
    description: connection.adapterKind,
    machineId: id,
    searchText: [connection.ref.adapterId, connection.ref.tenantId, connection.adapterKind, connection.transportMode, state],
    icon: () => createHostSurfaceIcon(document, state === 'ready' ? 'host:success' : 'host:layers'),
    avatar: {
      label: connection.ref.accountId,
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
  mount(context: CordisXPageMountContext): Disposable<void>
}

export interface ChannelManagerServiceConfigApi {
  list(): Promise<readonly HostServiceConfigDescriptor[]>
  mutate(mutation: HostServiceConfigMutation): Promise<HostServiceConfigMutationResult>
}

export interface ChannelManagerServiceInput {
  readonly projection?: ChannelManagerProjectionV1
  readonly serviceConfig?: ChannelManagerServiceConfigApi
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
    }))
  }

  snapshot(): ChannelManagerProjectionV1 {
    return cloneProjection(projectionFor(this))
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
    let selectedId: string | undefined
    let activeTab: ChannelDetailTab = 'configuration'
    let listQuery = ''
    let creating = false
    const committedRecords: ChannelRecord[] = []
    let candidateName = ''
    let disposeCurrent = (): void => {}

    const records = (): readonly ChannelRecord[] => [...channelRecords(projection), ...committedRecords]

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
            selectedId = item.id
            activeTab = 'configuration'
            render()
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
      create.addEventListener('click', () => { creating = true; render() })
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
      const head = document.createElement('header')
      head.className = 'cxc-channel-detail-head'
      const titleRow = document.createElement('div')
      titleRow.className = 'cxc-channel-detail-title-row'
      const back = document.createElement('button')
      back.className = 'cxc-channel-back'
      back.type = 'button'
      back.dataset.channelCreateBack = 'true'
      back.setAttribute('aria-label', managerCopy(locale, 'channel.back'))
      back.append(createHostSurfaceIcon(document, 'host:back'))
      back.addEventListener('click', () => { creating = false; render() })
      const titleCopy = document.createElement('div')
      const title = document.createElement('h2')
      title.textContent = managerCopy(locale, 'channel.create')
      const description = document.createElement('p')
      description.textContent = managerCopy(locale, 'channel.create.description')
      titleCopy.append(title, description)
      titleRow.append(back, titleCopy)
      head.append(titleRow)
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
        const record = localSimulatorRecord(name)
        submit.disabled = true
        status.textContent = managerCopy(locale, 'form.saving')
        void serviceConfig.list().then(descriptors => {
          const descriptor = descriptors.find(item => item.identity.pluginId === 'channel' && item.identity.serviceId === 'runtime')
          const raw = descriptor?.configuration
          if (descriptor === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Channel service configuration is unavailable')
          const configuration = structuredClone(raw) as { connections?: Array<Record<string, unknown>>; routes?: Array<Record<string, unknown>> }
          const existing = configuration.connections?.some(item => compositeRef(item.ref as ChannelManagerConnectionProjection['ref']) === record.id) === true
          if (existing) throw new Error('A local simulator channel with this name already exists')
          const routeId = `${record.connection.ref.accountId}-default`
          configuration.connections = [...(configuration.connections ?? []), {
            ref: record.connection.ref, adapterKind: 'simulator', enabled: true,
            transport: { mode: 'simulator' },
          }]
          configuration.routes = [...(configuration.routes ?? []), {
            id: routeId, connection: record.connection.ref, enabled: true,
            policy: { conversationKinds: ['direct'] },
            task: {
              provider: { useDefault: true }, model: { useDefault: true }, profile: { useDefault: true }, workspaceAlias: 'cordisx',
            },
            notifications: ['completion', 'failure', 'approval-required'],
          }]
          return serviceConfig.mutate({
            contract: 'cordisx.service-config-mutation/v1', schemaVersion: 1,
            identity: descriptor.identity, scope: descriptor.scope, expectedRevision: descriptor.revision,
            configuration: configuration as HostServiceConfigMutation['configuration'],
          })
        }).then(result => {
          if (!form.isConnected) return
          submit.disabled = false
          if (result.status !== 'applied') {
            status.textContent = result.status === 'conflict' ? managerCopy(locale, 'form.conflict-retained') : managerCopy(locale, 'channel.create.unavailable')
            return
          }
          committedRecords.push(record)
          selectedId = undefined
          activeTab = 'configuration'
          candidateName = ''
          listQuery = ''
          creating = false
          render()
        }).catch(() => {
          if (!form.isConnected) return
          submit.disabled = false
          status.textContent = managerCopy(locale, 'channel.create.unavailable')
        })
      })
      page.append(head, form)
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
        const source = structuredClone(raw) as { connections?: Array<Record<string, unknown>> }
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
        actions.append(status, submit)
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

    const renderLogs = (panel: HTMLElement): (() => void) => {
      panel.append(conciseEmpty(document, managerCopy(locale, 'channel.logs.unavailable'), 'channelLogs'))
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
      panel.append(routes.root, bindings.root)
      return () => { bindingCollection.dispose(); routeCollection.dispose() }
    }

    const renderDetail = (record: ChannelRecord): void => {
      disposeCurrent()
      const page = document.createElement('section')
      page.className = 'cxc-channel-detail'
      page.dataset.channelPage = 'detail'
      page.dataset.channelDetail = record.id
      const toolbar = document.createElement('div')
      toolbar.className = 'cxc-channel-detail-tools'
      const back = document.createElement('button')
      back.className = 'cxc-channel-back'
      back.type = 'button'
      back.dataset.channelBack = 'true'
      back.setAttribute('aria-label', managerCopy(locale, 'channel.back'))
      back.append(createHostSurfaceIcon(document, 'host:back'))
      back.addEventListener('click', () => { selectedId = undefined; render() })
      const tabs = document.createElement('div')
      tabs.className = 'cxm-tabs cxc-channel-tabs'
      tabs.setAttribute('role', 'tablist')
      tabs.setAttribute('aria-orientation', 'horizontal')
      const panel = document.createElement('div')
      panel.className = 'cxc-channel-panel'
      panel.setAttribute('role', 'tabpanel')
      panel.dataset.channelDetailPanel = activeTab
      const tabEntries: readonly { readonly id: ChannelDetailTab; readonly label: string; readonly icon: 'configuration' | 'diagnostics' | 'outlets' }[] = [
        { id: 'configuration', label: managerCopy(locale, 'channel.configuration'), icon: 'configuration' },
        { id: 'logs', label: managerCopy(locale, 'channel.logs'), icon: 'diagnostics' },
        { id: 'sessions', label: managerCopy(locale, 'channel.sessions'), icon: 'outlets' },
      ]
      const activateTab = (tab: ChannelDetailTab): void => {
        activeTab = tab
        render()
        page.querySelector<HTMLButtonElement>(`[data-channel-detail-tab="${tab}"]`)?.focus()
      }
      for (const [index, entry] of tabEntries.entries()) {
        const tab = document.createElement('button')
        tab.type = 'button'
        tab.className = 'cxm-tab cxc-channel-tab'
        tab.dataset.channelDetailTab = entry.id
        tab.id = `channel-tab-${entry.id}`
        tab.setAttribute('role', 'tab')
        tab.setAttribute('aria-controls', `channel-panel-${entry.id}`)
        tab.setAttribute('aria-selected', String(entry.id === activeTab))
        tab.tabIndex = entry.id === activeTab ? 0 : -1
        const tabContent = document.createElement('span')
        tabContent.className = 'cxm-tab-content'
        tabContent.append(createManagerIcon(document, entry.icon, 'cxm-tab-icon'), document.createTextNode(entry.label))
        tab.append(tabContent)
        tab.addEventListener('click', () => activateTab(entry.id))
        tab.addEventListener('keydown', (event) => {
          let nextIndex: number | undefined
          if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabEntries.length
          if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabEntries.length) % tabEntries.length
          if (event.key === 'Home') nextIndex = 0
          if (event.key === 'End') nextIndex = tabEntries.length - 1
          if (nextIndex === undefined) return
          event.preventDefault()
          activateTab(tabEntries[nextIndex]!.id)
        })
        tabs.append(tab)
      }
      panel.id = `channel-panel-${activeTab}`
      panel.setAttribute('aria-labelledby', `channel-tab-${activeTab}`)
      let disposePanel = (): void => {}
      if (activeTab === 'configuration') renderConfiguration(record, panel)
      else if (activeTab === 'logs') disposePanel = renderLogs(panel)
      else disposePanel = renderSessions(record, panel)
      toolbar.append(back, tabs)
      page.append(toolbar, panel)
      content.replaceChildren(page)
      disposeCurrent = disposePanel
    }

    const render = (): void => {
      const selected = selectedId === undefined ? undefined : records().find(record => record.id === selectedId)
      if (creating) renderCreate()
      else if (selected === undefined) renderList()
      else renderDetail(selected)
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
