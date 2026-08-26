import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from 'cordisx/react'
import { Button, Card, EmptyState, Heading, Stack, Text } from 'cordisx/ui'
import type { CordisXReactPageProps } from '../../contracts.js'
import type { HostServiceConfigDescriptor, HostServiceConfigMutation } from '../../launcher/service-config.js'
import type {
  ChannelManagerAccountProjection,
  ChannelManagerConnectionProjection,
  ChannelManagerLogProjection,
  ChannelManagerProjectionV1,
  CordisXChannelManager,
} from '../../renderer/channel-manager.js'
import { managerCopy } from '../../renderer/ui-copy.js'

const STYLES = `
.cxc-channel-react{display:grid;min-width:0;color:var(--cx-text)}
.cxc-channel-toolbar{display:flex;min-width:0;border:1px solid var(--cx-border);border-radius:10px;overflow:hidden;background:var(--cx-surface-raised)}
.cxc-channel-toolbar input,.cxc-channel-toolbar select{min-width:0;min-height:38px;border:0;background:transparent;color:var(--cx-text);font:inherit;outline:0}
.cxc-channel-toolbar input{flex:1;padding:8px 12px}
.cxc-channel-toolbar select{padding:8px 10px;border-inline-start:1px solid var(--cx-border)}
.cxc-channel-toolbar .cxr-ui-button{min-width:38px;min-height:38px;padding:0 11px;border:0;border-inline-start:1px solid var(--cx-border);border-radius:0}
.cxc-channel-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;margin-top:12px}
.cxc-channel-account{display:grid;grid-template-columns:42px minmax(0,1fr) auto;gap:11px;align-items:center;width:100%;padding:12px;border:1px solid var(--cx-border);border-radius:11px;background:var(--cx-surface-raised);color:var(--cx-text);text-align:start;cursor:pointer}
.cxc-channel-account:hover,.cxc-channel-account:focus-visible{border-color:var(--cx-primary);background:var(--cx-hover);outline:0}
.cxc-channel-avatar{display:grid;width:42px;height:42px;place-items:center;border-radius:10px;background:var(--cx-surface);font-weight:700;text-transform:uppercase}
.cxc-channel-account-copy{display:grid;gap:2px;min-width:0}.cxc-channel-account-copy span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cxc-channel-meta{color:var(--cx-muted);font-size:12px}
.cxc-channel-status{display:inline-flex;align-items:center;gap:6px;color:var(--cx-muted);font-size:12px}.cxc-channel-status::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--cx-muted)}.cxc-channel-status[data-state="ready"]::before{background:var(--cx-success)}.cxc-channel-status[data-state="retrying"],.cxc-channel-status[data-state="starting"]{color:var(--cx-warning)}.cxc-channel-status[data-state="unavailable"]{color:var(--cx-danger)}
.cxc-channel-form{display:grid;gap:16px}.cxc-channel-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 16px}.cxc-channel-field{display:grid;gap:6px;min-width:0}.cxc-channel-field>span{font-weight:600}.cxc-channel-field input,.cxc-channel-field select{width:100%;min-height:38px;padding:7px 10px;border:1px solid var(--cx-border);border-radius:8px;background:var(--cx-surface-raised);color:var(--cx-text);font:inherit}.cxc-channel-field small{color:var(--cx-muted)}
.cxc-channel-switch{display:flex;align-items:center;gap:9px;min-height:38px}.cxc-channel-switch input{width:18px;height:18px;margin:0;accent-color:var(--cx-primary)}
.cxc-channel-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px}.cxc-channel-actions .cxc-channel-note{margin-inline-end:auto}
.cxc-channel-note{color:var(--cx-muted);font-size:12px}
.cxc-channel-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.cxc-channel-stat{display:grid;gap:4px}.cxc-channel-stat strong{font-size:18px}.cxc-channel-stat span{color:var(--cx-muted);font-size:12px}
.cxc-channel-section{display:grid;gap:10px}.cxc-channel-section-head{display:grid;gap:3px}
.cxc-channel-data-list{display:grid;gap:8px}.cxc-channel-data-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;padding:11px 12px;border:1px solid var(--cx-border);border-radius:9px;background:var(--cx-surface-raised)}.cxc-channel-data-copy{display:grid;gap:2px;min-width:0}.cxc-channel-data-copy span,.cxc-channel-data-copy code{overflow-wrap:anywhere}
.cxc-channel-log-entry{display:grid;grid-template-columns:minmax(8rem,auto) minmax(0,1fr) auto;gap:10px;align-items:baseline;padding:9px 11px;border-bottom:1px solid var(--cx-border);font-size:12px}.cxc-channel-log-entry time,.cxc-channel-log-outcome{color:var(--cx-muted)}
.cxc-channel-log-pagination{display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:10px;color:var(--cx-muted);font-size:12px}
@media(max-width:700px){.cxc-channel-form-grid,.cxc-channel-cards{grid-template-columns:1fr}.cxc-channel-log-entry{grid-template-columns:1fr}.cxc-channel-actions{flex-wrap:wrap}}
`

interface ChannelRecord {
  readonly id: string
  readonly connection: ChannelManagerConnectionProjection
  readonly account?: ChannelManagerAccountProjection
}

interface ChannelPageProps extends CordisXReactPageProps {
  readonly manager: CordisXChannelManager
  readonly locale: string
}

function compositeRef(ref: ChannelManagerConnectionProjection['ref']): string {
  return `${ref.adapterId}/${ref.accountId}/${ref.tenantId}`
}

function records(projection: ChannelManagerProjectionV1): readonly ChannelRecord[] {
  const configured = new Map(projection.connections.map(item => [compositeRef(item.ref), item]))
  const live = new Map(projection.accounts.map(item => [compositeRef(item.ref), item]))
  return [...new Set([...configured.keys(), ...live.keys()])].sort().map(id => {
    const account = live.get(id)
    return { id, connection: account ?? configured.get(id)!, ...(account === undefined ? {} : { account }) }
  })
}

function stateLabel(locale: string, state: ChannelManagerAccountProjection['connectionState']): string {
  const values: Record<ChannelManagerAccountProjection['connectionState'], readonly [string, string]> = {
    disabled: ['Disabled', '已停用'], starting: ['Starting', '启动中'], ready: ['Connected', '已连接'],
    retrying: ['Retrying', '重试中'], unavailable: ['Unavailable', '不可用'], stopped: ['Stopped', '已停止'],
  }
  return values[state][locale.startsWith('zh') ? 1 : 0]
}

function useProjection(manager: CordisXChannelManager): ChannelManagerProjectionV1 {
  return useSyncExternalStore(
    listener => manager.subscribe(listener),
    () => manager.snapshot(),
    () => manager.snapshot(),
  )
}

function Shell({ children, ...props }: ChannelPageProps & { readonly children: ReactNode }) {
  return <section className="cxc-channel-react" data-channel-manager="mounted" data-channel-status={props.manager.snapshot().status}>
    <style>{STYLES}</style>
    {children}
  </section>
}

function ChannelList(props: ChannelPageProps) {
  const projection = useProjection(props.manager)
  const [query, setQuery] = useState('')
  const visible = useMemo(() => records(projection).filter(record => {
    const text = [record.connection.displayName, record.id, record.connection.adapterKind, record.connection.transportMode, record.account?.connectionState]
      .filter(Boolean).join(' ').toLowerCase()
    return text.includes(query.trim().toLowerCase())
  }), [projection, query])
  return <Shell {...props}>
    <div data-channel-page="list">
      <div className="cxc-channel-toolbar" role="toolbar" aria-label={managerCopy(props.locale, 'channel.accounts')}>
        <input data-collection-search="channel-list" type="search" value={query} onChange={event => setQuery(event.currentTarget.value)}
          aria-label={managerCopy(props.locale, 'channel.search.label')} placeholder={managerCopy(props.locale, 'channel.search.placeholder')} />
        <Button data-channel-create="true" aria-label={managerCopy(props.locale, 'channel.create.icon-label')}
          title={managerCopy(props.locale, 'channel.create.icon-label')} onClick={() => void props.navigation.navigate({ id: 'create' })}>＋</Button>
      </div>
      {visible.length === 0 ? <EmptyState data-host-collection="channel-list"
        title={query.trim() === '' ? managerCopy(props.locale, 'channel.accounts.empty') : managerCopy(props.locale, 'channel.search.empty')}
        description={managerCopy(props.locale, 'channel.create.description')}
        action={<Button variant="primary" onClick={() => void props.navigation.navigate({ id: 'create' })}>{managerCopy(props.locale, 'channel.create')}</Button>} />
        : <div className="cxc-channel-list" data-host-collection="channel-list">{visible.map(record => {
          const state = record.account?.connectionState ?? (record.connection.enabled ? 'unavailable' : 'disabled')
          const title = record.account?.displayName ?? record.connection.displayName ?? record.connection.ref.accountId
          return <button key={record.id} type="button" className="cxc-channel-account" data-collection-item={record.id}
            onClick={() => void props.navigation.navigate({ id: 'configuration', params: { accountId: record.id } })}>
            <span className="cxc-channel-avatar cxc-avatar">{title.slice(0, 2)}</span>
            <span className="cxc-channel-account-copy"><strong>{title}</strong><span className="cxc-channel-meta">{record.connection.adapterKind} · {record.id}</span></span>
            <span className="cxc-channel-status" data-state={state}>{stateLabel(props.locale, state)}</span>
          </button>
        })}</div>}
    </div>
  </Shell>
}

function Field(props: { readonly label: string; readonly help?: string; readonly children: ReactNode }) {
  return <label className="cxc-channel-field"><span>{props.label}</span>{props.children}{props.help === undefined ? null : <small>{props.help}</small>}</label>
}

function cloneConfiguration(descriptor: HostServiceConfigDescriptor): { connections?: Array<Record<string, unknown>>; routes?: Array<Record<string, unknown>> } {
  const value = typeof globalThis.structuredClone === 'function'
    ? globalThis.structuredClone(descriptor.configuration)
    : JSON.parse(JSON.stringify(descriptor.configuration)) as unknown
  return value as { connections?: Array<Record<string, unknown>>; routes?: Array<Record<string, unknown>> }
}

function mutation(descriptor: HostServiceConfigDescriptor, configuration: ReturnType<typeof cloneConfiguration>): HostServiceConfigMutation {
  return {
    contract: 'cordisx.service-config-mutation/v1', schemaVersion: 1,
    identity: descriptor.identity, scope: descriptor.scope, expectedRevision: descriptor.revision,
    configuration: configuration as HostServiceConfigMutation['configuration'],
  }
}

function ChannelCreate(props: ChannelPageProps) {
  const projection = useProjection(props.manager)
  const [name, setName] = useState('')
  const [platform, setPlatform] = useState<'simulator' | 'feishu'>('simulator')
  const [appId, setAppId] = useState('')
  const [tenant, setTenant] = useState('local')
  const [provider, setProvider] = useState('default')
  const [model, setModel] = useState('default')
  const [profile, setProfile] = useState('default')
  const [workspace, setWorkspace] = useState('cordisx')
  const [notifications, setNotifications] = useState(true)
  const [secret, setSecret] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const displayName = name.trim()
    if (displayName === '') { setStatus(managerCopy(props.locale, 'form.required')); return }
    if (!projection.service.writable) { setStatus(managerCopy(props.locale, 'channel.create.unavailable')); return }
    const accountId = platform === 'feishu' ? appId.trim() : displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'local'
    if (accountId === '' || (platform === 'feishu' && secret === '')) { setStatus(managerCopy(props.locale, 'form.required')); return }
    setBusy(true); setStatus(managerCopy(props.locale, 'form.saving'))
    try {
      const descriptor = await props.manager.serviceConfiguration()
      if (descriptor === undefined) throw new Error('channel-service-configuration-unavailable')
      const configuration = cloneConfiguration(descriptor)
      const ref = { adapterId: platform, accountId, tenantId: tenant.trim() || (platform === 'simulator' ? 'local' : 'default') }
      if (configuration.connections?.some(item => compositeRef(item.ref as ChannelManagerConnectionProjection['ref']) === compositeRef(ref))) {
        throw new Error('channel-connection-already-exists')
      }
      configuration.connections = [...(configuration.connections ?? []), {
        ref, adapterKind: platform, enabled: platform === 'simulator', transport: { mode: platform === 'feishu' ? 'websocket' : 'simulator' },
      }]
      configuration.routes = [...(configuration.routes ?? []), {
        id: `${accountId}-default`, connection: ref, enabled: true, policy: { conversationKinds: ['direct'] },
        task: {
          provider: provider === 'default' ? { useDefault: true } : { id: provider },
          model: model === 'default' ? { useDefault: true } : { id: model },
          profile: profile === 'default' ? { useDefault: true } : { id: profile },
          workspaceAlias: workspace.trim() || 'cordisx',
        },
        notifications: notifications ? ['completion', 'failure', 'approval-required'] : [],
      }]
      const request = mutation(descriptor, configuration)
      const result = platform === 'feishu'
        ? await props.manager.createConnection({ account: ref, secret, mutation: request })
        : await props.manager.mutateServiceConfiguration(request)
      setSecret('')
      if (result.status !== 'applied') {
        setStatus(result.status === 'conflict' ? managerCopy(props.locale, 'form.conflict-retained') : managerCopy(props.locale, 'channel.create.unavailable'))
        return
      }
      props.manager.rememberLocalCandidate({
        ref, displayName, adapterKind: platform, enabled: platform === 'simulator',
        transportMode: platform === 'feishu' ? 'websocket' : 'simulator', secretState: platform === 'feishu' ? 'ready' : 'unavailable',
      })
      await props.navigation.navigate({ id: 'settings' })
    } catch {
      setStatus(managerCopy(props.locale, 'channel.create.unavailable'))
    } finally { setBusy(false) }
  }

  return <Shell {...props}><form className="cxc-channel-form" data-channel-page="create" data-channel-create-form="true" onSubmit={event => void submit(event)}>
    <Card><Stack gap="medium"><div><Heading level={3}>{managerCopy(props.locale, 'channel.configuration')}</Heading><Text tone="muted">{managerCopy(props.locale, 'channel.create.local-only')}</Text></div>
      <div className="cxc-channel-form-grid">
        <Field label={managerCopy(props.locale, 'channel.create.name')}><input id="channel-create-name" required value={name} onChange={event => setName(event.currentTarget.value)} /></Field>
        <Field label={managerCopy(props.locale, 'channel.create.platform')}><select id="channel-create-platform" value={platform} onChange={event => {
          const next = event.currentTarget.value === 'feishu' ? 'feishu' : 'simulator'
          setPlatform(next); setTenant(next === 'feishu' ? 'default' : 'local')
        }}><option value="simulator">{managerCopy(props.locale, 'channel.create.simulator')}</option><option value="feishu">{managerCopy(props.locale, 'channel.create.feishu')}</option></select></Field>
        {platform === 'feishu' ? <><Field label={managerCopy(props.locale, 'channel.create.app-id')}><input id="channel-create-app-id" required value={appId} onChange={event => setAppId(event.currentTarget.value)} /></Field>
          <Field label={managerCopy(props.locale, 'channel.field.credentials')} help={managerCopy(props.locale, 'channel.credentials.help')}><input id="channel-create-credential" data-channel-credential-capture="true" type="password" autoComplete="new-password" required value={secret} onChange={event => setSecret(event.currentTarget.value)} /></Field></> : null}
        <Field label={managerCopy(props.locale, 'channel.create.tenant')}><input id="channel-create-tenant" value={tenant} onChange={event => setTenant(event.currentTarget.value)} /></Field>
        <Field label={managerCopy(props.locale, 'channel.create.provider')}><input id="channel-create-provider" value={provider} onChange={event => setProvider(event.currentTarget.value)} /></Field>
        <Field label={managerCopy(props.locale, 'channel.create.model')}><input id="channel-create-model" value={model} onChange={event => setModel(event.currentTarget.value)} /></Field>
        <Field label={managerCopy(props.locale, 'channel.create.profile')}><input id="channel-create-profile" value={profile} onChange={event => setProfile(event.currentTarget.value)} /></Field>
        <Field label={managerCopy(props.locale, 'channel.create.workspace')}><input id="channel-create-workspace" value={workspace} onChange={event => setWorkspace(event.currentTarget.value)} /></Field>
        <Field label={managerCopy(props.locale, 'channel.create.notifications')}><span className="cxc-channel-switch"><input id="channel-create-notifications" type="checkbox" checked={notifications} onChange={event => setNotifications(event.currentTarget.checked)} />{notifications ? managerCopy(props.locale, 'form.switch-on') : managerCopy(props.locale, 'form.switch-off')}</span></Field>
      </div></Stack></Card>
    <div className="cxc-channel-actions"><span className="cxc-channel-note" data-channel-create-status="true" role="status">{status}</span><Button variant="primary" data-channel-create-submit="true" type="submit" disabled={busy}>{managerCopy(props.locale, 'channel.create.save')}</Button></div>
  </form></Shell>
}

function useSelectedRecord(props: ChannelPageProps): ChannelRecord | undefined {
  const projection = useProjection(props.manager)
  return records(projection).find(item => item.id === props.params.accountId)
}

function ChannelConfiguration(props: ChannelPageProps) {
  const record = useSelectedRecord(props)
  const [descriptor, setDescriptor] = useState<HostServiceConfigDescriptor>()
  const [enabled, setEnabled] = useState(record?.connection.enabled ?? false)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { void props.manager.serviceConfiguration().then(next => {
    setDescriptor(next)
    const configuration = next === undefined ? undefined : cloneConfiguration(next)
    const connection = configuration?.connections?.find(item => compositeRef(item.ref as ChannelManagerConnectionProjection['ref']) === record?.id)
    if (typeof connection?.enabled === 'boolean') setEnabled(connection.enabled)
  }) }, [props.manager, record?.id])
  if (record === undefined) return <Shell {...props}><EmptyState data-channel-missing-account="true" title={managerCopy(props.locale, 'channel.accounts.empty')} /></Shell>
  const save = async (reconnect: boolean) => {
    if (descriptor === undefined) { setStatus(managerCopy(props.locale, 'channel.configuration.unavailable')); return }
    setBusy(true); setStatus(reconnect ? managerCopy(props.locale, 'channel.reconnecting') : managerCopy(props.locale, 'form.saving'))
    try {
      if (reconnect && props.manager.actionsAvailable()) {
        const result = await props.manager.runAction('reconnect', { ref: record.connection.ref })
        setStatus(result.status === 'applied' ? managerCopy(props.locale, 'channel.reconnected') : managerCopy(props.locale, 'channel.runtime.unavailable'))
        return
      }
      const configuration = cloneConfiguration(descriptor)
      const target = configuration.connections?.find(item => compositeRef(item.ref as ChannelManagerConnectionProjection['ref']) === record.id)
      if (target === undefined) throw new Error('channel-connection-not-found')
      target.enabled = enabled
      const result = await props.manager.mutateServiceConfiguration(mutation(descriptor, configuration))
      if (result.status === 'applied') {
        setDescriptor(await props.manager.serviceConfiguration())
        setStatus(reconnect ? managerCopy(props.locale, 'channel.reconnected') : managerCopy(props.locale, 'form.apply-service-restart'))
      } else setStatus(result.status === 'conflict' ? managerCopy(props.locale, 'form.conflict-retained') : managerCopy(props.locale, 'channel.configuration.unavailable'))
    } catch { setStatus(managerCopy(props.locale, 'channel.configuration.unavailable')) } finally { setBusy(false) }
  }
  return <Shell {...props}><div className="cxc-channel-form" data-channel-page="detail" data-channel-detail={record.id}><Card data-channel-configuration={record.id}>
    <Stack gap="medium"><div><Heading level={3}>{managerCopy(props.locale, 'channel.configuration')}</Heading><Text tone="muted">{managerCopy(props.locale, 'channel.configuration.description')}</Text></div>
      <label className="cxc-channel-switch"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.currentTarget.checked)} />{managerCopy(props.locale, 'channel.field.enabled')}</label>
      <div className="cxc-channel-actions"><span className="cxc-channel-note" data-channel-configuration-status="true">{status}</span><Button data-channel-reconnect={record.id} disabled={busy || descriptor === undefined} onClick={() => void save(true)}>{managerCopy(props.locale, 'channel.reconnect')}</Button><Button variant="primary" data-channel-configuration-save={record.id} disabled={busy || descriptor === undefined} onClick={() => void save(false)}>{managerCopy(props.locale, 'form.save-configuration')}</Button></div>
    </Stack></Card></div></Shell>
}

function ChannelRuntime(props: ChannelPageProps) {
  const record = useSelectedRecord(props)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  if (record?.account === undefined) return <Shell {...props}><EmptyState data-channel-runtime-unavailable="true" title={managerCopy(props.locale, 'channel.runtime.unavailable')} /></Shell>
  const account = record.account
  const run = async (action: 'enable' | 'disable' | 'reconnect') => {
    setBusy(true); setStatus(action === 'reconnect' ? managerCopy(props.locale, 'channel.reconnecting') : managerCopy(props.locale, 'form.saving'))
    try {
      const result = await props.manager.runAction(action, { ref: record.connection.ref })
      setStatus(result.status === 'applied' ? (action === 'reconnect' ? managerCopy(props.locale, 'channel.reconnected') : managerCopy(props.locale, 'form.apply-service-restart')) : managerCopy(props.locale, 'channel.runtime.unavailable'))
    } catch { setStatus(managerCopy(props.locale, 'channel.runtime.unavailable')) } finally { setBusy(false) }
  }
  const stats = [[managerCopy(props.locale, 'channel.field.status'), stateLabel(props.locale, account.connectionState)], [managerCopy(props.locale, 'channel.status.inbound'), String(account.inbound.pending + account.inbound.retrying)], [managerCopy(props.locale, 'channel.status.outbound'), String(account.outbound.pending + account.outbound.retrying)], [managerCopy(props.locale, 'channel.status.generation'), String(account.generation)]]
  return <Shell {...props}><Stack gap="medium" data-channel-page="detail" data-channel-detail={record.id}><div className="cxc-channel-cards" data-channel-runtime-status={record.id}>{stats.map(([label, value]) => <Card key={label} className="cxc-channel-stat"><strong>{value}</strong><span>{label}</span></Card>)}</div>
    <div className="cxc-channel-actions"><span className="cxc-channel-note" data-channel-runtime-action-status={record.id}>{status}</span>{(['enable', 'disable', 'reconnect'] as const).map(action => <Button key={action} data-channel-runtime-action={action} data-channel-runtime-action-account={record.id} disabled={busy || !props.manager.actionsAvailable()} onClick={() => void run(action)}>{managerCopy(props.locale, `channel.${action}`)}</Button>)}</div>
  </Stack></Shell>
}

function exportLogs(record: ChannelRecord, items: readonly ChannelManagerLogProjection[]) {
  const payload = items.map(({ id, recordedAt, action, outcome }) => ({ id, recordedAt, action, outcome }))
  const href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }))
  const anchor = document.createElement('a'); anchor.href = href; anchor.download = `cordisx-channel-${record.connection.ref.accountId}-logs.json`; anchor.hidden = true
  document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(href), 0)
}

function ChannelLogs(props: ChannelPageProps) {
  const projection = useProjection(props.manager)
  const record = records(projection).find(item => item.id === props.params.accountId)
  const [query, setQuery] = useState('')
  const [outcome, setOutcome] = useState<'all' | 'success' | 'failure'>('all')
  const [page, setPage] = useState(0)
  if (record === undefined) return <Shell {...props}><EmptyState title={managerCopy(props.locale, 'channel.accounts.empty')} /></Shell>
  const all = (projection.logs ?? []).filter(entry => compositeRef(entry.account) === record.id)
  const filtered = all.filter(entry => {
    const text = `${entry.action} ${entry.outcome} ${entry.recordedAt}`.toLowerCase()
    return (query === '' || text.includes(query.toLowerCase())) && (outcome === 'all' || (outcome === 'success' ? /success|allow|complete|applied|ready/iu : /fail|deny|error|dead|unavailable|reject/iu).test(entry.outcome))
  }).sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))
  const pageSize = 25, totalPages = Math.max(1, Math.ceil(filtered.length / pageSize)), currentPage = Math.min(page, totalPages - 1)
  const windowed = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize)
  return <Shell {...props}><section data-channel-page="detail" data-channel-detail={record.id} data-channel-detail-panel="logs" data-channel-logs="true">
    <div className="cxc-channel-toolbar"><input data-channel-log-query="true" type="search" value={query} onChange={event => { setQuery(event.currentTarget.value.trim()); setPage(0) }} placeholder={managerCopy(props.locale, 'channel.logs.search')} aria-label={managerCopy(props.locale, 'channel.logs.search')} /><select data-channel-log-outcome="true" value={outcome} onChange={event => { setOutcome(event.currentTarget.value as typeof outcome); setPage(0) }}><option value="all">{managerCopy(props.locale, 'channel.logs.all')}</option><option value="success">{managerCopy(props.locale, 'channel.logs.success')}</option><option value="failure">{managerCopy(props.locale, 'channel.logs.failure')}</option></select><Button data-channel-log-export="json" disabled={filtered.length === 0} onClick={() => exportLogs(record, filtered)}>{managerCopy(props.locale, 'channel.logs.export')}</Button></div>
    <div className="cxc-channel-data-list cxc-channel-log-list">{windowed.length === 0 ? <EmptyState data-channel-logs-empty="true" title={managerCopy(props.locale, all.length === 0 ? 'channel.logs.unavailable' : 'channel.search.empty')} /> : windowed.map(entry => <article key={entry.id} className="cxc-channel-log-entry" data-channel-log-entry={entry.id}><time dateTime={entry.recordedAt}>{new Date(entry.recordedAt).toLocaleString(props.locale)}</time><span>{entry.action}</span><span className="cxc-channel-log-outcome">{entry.outcome}</span></article>)}</div>
    <div className="cxc-channel-log-pagination" data-channel-log-pagination="true"><Button className="cxc-channel-log-page" disabled={currentPage === 0} onClick={() => setPage(value => value - 1)}>‹</Button><span>{managerCopy(props.locale, 'channel.logs.page')} {currentPage + 1}/{totalPages}</span><Button className="cxc-channel-log-page" disabled={currentPage + 1 >= totalPages} onClick={() => setPage(value => value + 1)}>›</Button></div>
  </section></Shell>
}

function ChannelSessions(props: ChannelPageProps) {
  const projection = useProjection(props.manager)
  const record = records(projection).find(item => item.id === props.params.accountId)
  const [busy, setBusy] = useState(false)
  if (record === undefined) return <Shell {...props}><EmptyState title={managerCopy(props.locale, 'channel.accounts.empty')} /></Shell>
  const routes = projection.routes.filter(route => compositeRef(route.connection) === record.id)
  const bindings = projection.bindings.filter(binding => compositeRef(binding.channel) === record.id)
  if (routes.length === 0 && bindings.length === 0) return <Shell {...props}><EmptyState data-channel-session-actions="true" title={managerCopy(props.locale, 'channel.sessions.unavailable')} /></Shell>
  const target = bindings[0]
  const run = async (action: 'archive' | 'restore' | 'unbind') => {
    if (target === undefined) return
    setBusy(true); try { await props.manager.runAction(action, { bindingId: target.bindingId }) } finally { setBusy(false) }
  }
  return <Shell {...props}><Stack gap="large" data-channel-page="detail" data-channel-detail={record.id}><section className="cxc-channel-section"><div className="cxc-channel-section-head"><Heading level={3}>{managerCopy(props.locale, 'channel.routes')}</Heading><Text tone="muted">{managerCopy(props.locale, 'channel.routes.description')}</Text></div><div className="cxc-channel-data-list" data-host-collection="channel-routes">{routes.map(route => <Card key={route.id} className="cxc-channel-data-row" data-collection-item={route.id}><span className="cxc-channel-data-copy"><strong>{route.id}</strong><span className="cxc-channel-meta">{route.provider} · {route.model} · {route.workspaceAlias}</span></span><span className="cxc-channel-status" data-state={route.enabled ? 'ready' : 'disabled'}>{managerCopy(props.locale, route.enabled ? 'form.switch-on' : 'form.switch-off')}</span></Card>)}</div></section>
    <section className="cxc-channel-section"><div className="cxc-channel-section-head"><Heading level={3}>{managerCopy(props.locale, 'channel.bindings')}</Heading><Text tone="muted">{managerCopy(props.locale, 'channel.bindings.description')}</Text></div><div className="cxc-channel-data-list" data-host-collection="channel-bindings">{bindings.map(binding => <Card key={binding.bindingId} className="cxc-channel-data-row" data-collection-item={binding.bindingId}><span className="cxc-channel-data-copy"><strong>{binding.channel.conversationId}</strong><span className="cxc-channel-meta">{binding.session.providerId} · {binding.session.remoteSessionId}</span></span><span className="cxc-channel-status" data-state={binding.state === 'active' ? 'ready' : 'disabled'}>{binding.state}</span></Card>)}</div><div className="cxc-channel-actions">{(['archive', 'restore', 'unbind'] as const).map(action => <Button key={action} data-channel-binding-operation={action} data-channel-binding-id={target?.bindingId} disabled={busy || target === undefined || !props.manager.actionsAvailable()} onClick={() => void run(action)}>{managerCopy(props.locale, `channel.binding.${action}`)}</Button>)}</div></section>
  </Stack></Shell>
}

/** React page body factory. The manager is a renderer-safe model/command service, never a DOM renderer. */
export function createChannelPage(manager: CordisXChannelManager) {
  return function ChannelPage(props: CordisXReactPageProps) {
    const shared = { ...props, manager, locale: props.localization.getSnapshot().locale }
    if (props.routeId.endsWith(':settings')) return <ChannelList {...shared} />
    if (props.routeId.endsWith(':create')) return <ChannelCreate {...shared} />
    if (props.routeId.endsWith(':runtime')) return <ChannelRuntime {...shared} />
    if (props.routeId.endsWith(':logs')) return <ChannelLogs {...shared} />
    if (props.routeId.endsWith(':sessions')) return <ChannelSessions {...shared} />
    return <ChannelConfiguration {...shared} />
  }
}
