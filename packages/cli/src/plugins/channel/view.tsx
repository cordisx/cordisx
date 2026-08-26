import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from 'cordisx/react'
import { Button, Card, EmptyState, Heading, Icon, Select, Stack, Text } from 'cordisx/ui'
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
import cordisxMarkDark from '../../../assets/brand/cordisx-mark-dark.svg'
import cordisxMarkLight from '../../../assets/brand/cordisx-mark-light.svg'
import feishuAppIcon from '../../../assets/apps/feishu.svg'

const STYLES = `
.cxc-channel-react{display:grid;min-width:0;min-height:100%;color:var(--cx-text)}
.cxc-channel-toolbar{display:flex;min-width:0;border:1px solid var(--cx-border);border-radius:10px;overflow:hidden;background:var(--cx-surface-raised)}
.cxc-channel-search{display:flex;min-width:0;flex:1;align-items:center;gap:8px;padding-inline:11px}.cxc-channel-search svg{width:17px;height:17px;color:var(--cx-muted)}
.cxc-channel-toolbar input,.cxc-channel-toolbar select{min-width:0;min-height:38px;border:0;background:transparent;color:var(--cx-text);font:inherit;outline:0}
.cxc-channel-toolbar input{width:100%;flex:1;padding:8px 0}
.cxc-channel-toolbar select{padding:8px 10px;border-inline-start:1px solid var(--cx-border)}
.cxc-channel-toolbar .cxr-ui-button{min-width:38px;min-height:38px;padding:0 11px;border:0;border-inline-start:1px solid var(--cx-border);border-radius:0}
.cxc-channel-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;margin-top:12px}
.cxc-channel-empty{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:36px;align-items:start;padding:42px 0 0}.cxc-channel-empty-copy{display:grid;justify-items:start;gap:8px}.cxc-channel-empty-mark{display:grid;width:36px;height:36px;place-items:center;border-radius:10px;background:var(--cx-hover);color:var(--cx-primary)}.cxc-channel-empty-copy h3,.cxc-channel-empty-copy p{margin:0}.cxc-channel-empty-copy p{color:var(--cx-muted)}.cxc-channel-supported{display:grid;gap:10px;padding-inline-start:30px;border-inline-start:1px solid var(--cx-border);color:var(--cx-muted);font-size:12px}.cxc-channel-supported-icons{display:flex;gap:12px}.cxc-channel-supported-icons .cxc-channel-app-icon{width:38px;height:38px}
.cxc-channel-account{display:grid;grid-template-columns:42px minmax(0,1fr) auto;gap:11px;align-items:center;width:100%;padding:12px;border:1px solid var(--cx-border);border-radius:11px;background:var(--cx-surface-raised);color:var(--cx-text);text-align:start;cursor:pointer}
.cxc-channel-account:hover,.cxc-channel-account:focus-visible{border-color:var(--cx-primary);background:var(--cx-hover);outline:0}
.cxc-channel-avatar{display:grid;width:42px;height:42px;place-items:center;border-radius:10px;background:var(--cx-surface);font-weight:700;text-transform:uppercase}
.cxc-channel-account-copy{display:grid;gap:2px;min-width:0}.cxc-channel-account-copy span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cxc-channel-meta{color:var(--cx-muted);font-size:12px}
.cxc-channel-status{display:inline-flex;align-items:center;gap:6px;color:var(--cx-muted);font-size:12px}.cxc-channel-status::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--cx-muted)}.cxc-channel-status[data-state="ready"]::before{background:var(--cx-success)}.cxc-channel-status[data-state="retrying"],.cxc-channel-status[data-state="starting"]{color:var(--cx-warning)}.cxc-channel-status[data-state="unavailable"]{color:var(--cx-danger)}
.cxc-channel-form{display:grid;min-height:100%;grid-template-rows:auto auto minmax(3rem,1fr);gap:20px}.cxc-channel-create-meta{display:grid;grid-template-columns:72px minmax(0,1fr);gap:22px;align-items:start}.cxc-channel-platform-icon{display:grid;width:72px;height:72px;place-items:center}.cxc-channel-app-icon{position:relative;display:grid;width:72px;height:72px;place-items:center}.cxc-channel-app-icon img{position:absolute;width:100%;height:100%;object-fit:contain;border-radius:17px}.cxc-channel-app-icon img[data-theme="dark"]{display:none}[data-cordisx-app-theme="dark"] .cxc-channel-app-icon img[data-theme="light"]{display:none}[data-cordisx-app-theme="dark"] .cxc-channel-app-icon img[data-theme="dark"]{display:block}
.cxc-channel-create-copy{display:grid;gap:12px;min-width:0}.cxc-channel-create-primary{display:grid;grid-template-columns:minmax(12rem,5fr) minmax(14rem,7fr);min-width:0}.cxc-channel-platform-select,.cxc-channel-create-primary input,.cxc-channel-introduction{box-sizing:border-box;width:100%;min-width:0}.cxc-channel-create-primary input,.cxc-channel-introduction{border:1px solid var(--cx-border);background:var(--cx-surface-raised);color:var(--cx-text);font:inherit;outline:0}.cxc-channel-platform-select .cxr-ui-select-trigger{min-height:38px;border-radius:8px 0 0 8px}.cxc-channel-create-primary input{min-height:38px;margin-inline-start:-1px;padding:7px 10px;border-radius:0 8px 8px 0}.cxc-channel-create-primary input:focus,.cxc-channel-introduction:focus{position:relative;z-index:1;border-color:var(--cx-primary);box-shadow:0 0 0 2px var(--cx-focus)}.cxc-channel-introduction{min-height:112px;resize:vertical;border-radius:8px;padding:9px 10px}.cxc-channel-option-icon,.cxc-channel-option-icon .cxc-channel-app-icon{display:inline-grid;width:18px;height:18px;vertical-align:middle}.cxc-channel-option-icon .cxc-channel-app-icon img{border-radius:4px}
.cxc-channel-schema{display:grid;gap:0;overflow:hidden;border:1px solid var(--cx-border);border-radius:12px;background:var(--cx-surface-raised)}.cxc-channel-schema:empty{display:none}.cxc-channel-form-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:0}.cxc-channel-field{display:grid;grid-template-columns:20px minmax(0,1fr);gap:8px 10px;min-width:0;padding:14px 16px;border-bottom:1px solid var(--cx-border)}.cxc-channel-field:last-child{border-bottom:0}.cxc-channel-field-title{display:flex;align-items:center;gap:6px;font-weight:600}.cxc-channel-field-action{display:grid;width:20px;height:20px;place-items:center;border:0;padding:0;background:transparent;color:var(--cx-muted);cursor:pointer}.cxc-channel-field-action svg{width:16px;height:16px}.cxc-channel-field-control{display:grid;gap:6px;min-width:0}.cxc-channel-field input,.cxc-channel-field select{box-sizing:border-box;width:100%;min-height:38px;padding:7px 10px;border:1px solid var(--cx-border);border-radius:8px;background:var(--cx-surface);color:var(--cx-text);font:inherit}.cxc-channel-field small{color:var(--cx-muted)}
.cxc-channel-switch{display:flex;align-items:center;gap:9px;min-height:38px}.cxc-channel-switch input{width:18px;height:18px;margin:0;accent-color:var(--cx-primary)}
.cxc-channel-actions{display:flex;align-items:center;align-self:end;justify-content:flex-end;gap:8px;padding-top:12px}.cxc-channel-actions .cxc-channel-note{margin-inline-end:auto}
.cxc-channel-note{color:var(--cx-muted);font-size:12px}
.cxc-channel-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.cxc-channel-stat{display:grid;gap:4px}.cxc-channel-stat strong{font-size:18px}.cxc-channel-stat span{color:var(--cx-muted);font-size:12px}
.cxc-channel-section{display:grid;gap:10px}.cxc-channel-section-head{display:grid;gap:3px}
.cxc-channel-data-list{display:grid;gap:8px}.cxc-channel-data-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;padding:11px 12px;border:1px solid var(--cx-border);border-radius:9px;background:var(--cx-surface-raised)}.cxc-channel-data-copy{display:grid;gap:2px;min-width:0}.cxc-channel-data-copy span,.cxc-channel-data-copy code{overflow-wrap:anywhere}
.cxc-channel-log-entry{display:grid;grid-template-columns:minmax(8rem,auto) minmax(0,1fr) auto;gap:10px;align-items:baseline;padding:9px 11px;border-bottom:1px solid var(--cx-border);font-size:12px}.cxc-channel-log-entry time,.cxc-channel-log-outcome{color:var(--cx-muted)}
.cxc-channel-log-pagination{display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:10px;color:var(--cx-muted);font-size:12px}
@media(max-width:700px){.cxc-channel-empty{grid-template-columns:1fr}.cxc-channel-supported{padding:18px 0 0;border-inline-start:0;border-block-start:1px solid var(--cx-border)}.cxc-channel-create-meta{grid-template-columns:1fr}.cxc-channel-create-primary{grid-template-columns:1fr;gap:8px}.cxc-channel-create-primary select,.cxc-channel-create-primary input{margin:0;border-radius:8px}.cxc-channel-form-grid,.cxc-channel-cards{grid-template-columns:1fr}.cxc-channel-log-entry{grid-template-columns:1fr}.cxc-channel-actions{flex-wrap:wrap}}
`

const CORDISX_LIGHT_URI = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(cordisxMarkLight)}`
const CORDISX_DARK_URI = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(cordisxMarkDark)}`
const FEISHU_URI = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(feishuAppIcon)}`
type ChannelPlatform = 'simulator' | 'feishu'

function ChannelAppIcon({ platform, label }: { readonly platform: ChannelPlatform; readonly label: string }) {
  const light = platform === 'feishu' ? FEISHU_URI : CORDISX_LIGHT_URI
  const dark = platform === 'feishu' ? FEISHU_URI : CORDISX_DARK_URI
  return <span className="cxc-channel-app-icon" title={label}><img src={light} alt={label} data-theme="light" /><img src={dark} alt="" data-theme="dark" /></span>
}

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
        <span className="cxc-channel-search"><Icon name="search" /><input data-collection-search="channel-list" type="search" value={query} onChange={event => setQuery(event.currentTarget.value)}
          aria-label={managerCopy(props.locale, 'channel.search.label')} placeholder={managerCopy(props.locale, 'channel.search.placeholder')} /></span>
        <Button data-channel-create="true" aria-label={managerCopy(props.locale, 'channel.create.icon-label')}
          title={managerCopy(props.locale, 'channel.create.icon-label')} onClick={() => void props.navigation.navigate({ id: 'create' })}><Icon name="create" /></Button>
      </div>
      {visible.length === 0 ? query.trim() === '' ? <section className="cxc-channel-empty" data-host-collection="channel-list" aria-label={managerCopy(props.locale, 'channel.accounts')}>
        <div className="cxc-channel-empty-copy">
          <span className="cxc-channel-empty-mark"><Icon name="create" /></span>
          <h3>{managerCopy(props.locale, 'channel.accounts.empty')}</h3>
          <p>{managerCopy(props.locale, 'channel.accounts.empty-description')}</p>
          <Button variant="primary" onClick={() => void props.navigation.navigate({ id: 'create' })}><Icon name="create" />{managerCopy(props.locale, 'channel.create')}</Button>
        </div>
        <div className="cxc-channel-supported">
          <span>{managerCopy(props.locale, 'channel.accounts.supported')}</span>
          <div className="cxc-channel-supported-icons">
            <ChannelAppIcon platform="simulator" label={managerCopy(props.locale, 'channel.create.simulator')} />
            <ChannelAppIcon platform="feishu" label={managerCopy(props.locale, 'channel.create.feishu')} />
          </div>
        </div>
      </section> : <EmptyState data-host-collection="channel-list" title={managerCopy(props.locale, 'channel.search.empty')} />
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

function Field(props: { readonly id: string; readonly label: string; readonly icon: 'host:tags' | 'host:folder' | 'host:key'; readonly help?: string; readonly children: ReactNode }) {
  return <div className="cxc-channel-field">
    <button className="cxc-channel-field-action" type="button" aria-label={props.label} onClick={() => document.getElementById(props.id)?.focus()}><Icon name={props.icon} /></button>
    <label className="cxc-channel-field-control" htmlFor={props.id}><span className="cxc-channel-field-title">{props.label}</span>{props.children}{props.help === undefined ? null : <small>{props.help}</small>}</label>
  </div>
}

function cloneConfiguration(descriptor: HostServiceConfigDescriptor): { connections?: Array<Record<string, unknown>> } {
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
  const [platform, setPlatform] = useState<ChannelPlatform>('simulator')
  const [introduction, setIntroduction] = useState('')
  const [appId, setAppId] = useState('')
  const [tenant, setTenant] = useState('local')
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
      const request = mutation(descriptor, configuration)
      const result = platform === 'feishu'
        ? await props.manager.createConnection({ account: ref, secret, mutation: request })
        : await props.manager.mutateServiceConfiguration(request)
      setSecret('')
      if (result.status !== 'applied') {
        setStatus(result.status === 'conflict' ? managerCopy(props.locale, 'form.conflict-retained') : managerCopy(props.locale, 'channel.create.failed'))
        return
      }
      props.manager.rememberLocalCandidate({
        ref, displayName, adapterKind: platform, enabled: platform === 'simulator',
        transportMode: platform === 'feishu' ? 'websocket' : 'simulator', secretState: platform === 'feishu' ? 'ready' : 'unavailable',
      })
      await props.navigation.navigate({ id: 'settings' })
    } catch {
      setStatus(managerCopy(props.locale, 'channel.create.failed'))
    } finally { setBusy(false) }
  }

  return <Shell {...props}><form className="cxc-channel-form" data-channel-page="create" data-channel-create-form="true" onSubmit={event => void submit(event)}>
    <section className="cxc-channel-create-meta" aria-label={managerCopy(props.locale, 'channel.create.platform')}>
      <div className="cxc-channel-platform-icon"><ChannelAppIcon platform={platform} label={managerCopy(props.locale, platform === 'feishu' ? 'channel.create.feishu' : 'channel.create.simulator')} /></div>
      <div className="cxc-channel-create-copy">
        <div className="cxc-channel-create-primary">
          <Select className="cxc-channel-platform-select" aria-label={managerCopy(props.locale, 'channel.create.platform')} value={platform} options={([
            { value: 'simulator', label: managerCopy(props.locale, 'channel.create.simulator'), prefixIcon: <span className="cxc-channel-option-icon"><ChannelAppIcon platform="simulator" label="" /></span> },
            { value: 'feishu', label: managerCopy(props.locale, 'channel.create.feishu'), prefixIcon: <span className="cxc-channel-option-icon"><ChannelAppIcon platform="feishu" label="" /></span> },
          ])} onChange={value => { const next: ChannelPlatform = value === 'feishu' ? 'feishu' : 'simulator'; setPlatform(next); setTenant(next === 'feishu' ? 'default' : 'local') }} />
          <input id="channel-create-name" required aria-label={managerCopy(props.locale, 'channel.create.name')} placeholder={managerCopy(props.locale, 'channel.create.name-placeholder')} value={name} onChange={event => setName(event.currentTarget.value)} />
        </div>
        <textarea className="cxc-channel-introduction" id="channel-create-introduction" rows={4} aria-label={managerCopy(props.locale, 'channel.create.introduction')} placeholder={managerCopy(props.locale, 'channel.create.introduction-placeholder')} value={introduction} onChange={event => setIntroduction(event.currentTarget.value)} />
      </div>
    </section>
    <section className="cxc-channel-schema">
      {platform === 'feishu' ? <div className="cxc-channel-form-grid">
        <Field id="channel-create-app-id" icon="host:tags" label={`${managerCopy(props.locale, 'channel.create.app-id')} *`}><input id="channel-create-app-id" required placeholder={managerCopy(props.locale, 'form.text-placeholder')} value={appId} onChange={event => setAppId(event.currentTarget.value)} /></Field>
        <Field id="channel-create-tenant" icon="host:folder" label={managerCopy(props.locale, 'channel.create.tenant')}><input id="channel-create-tenant" value={tenant} onChange={event => setTenant(event.currentTarget.value)} /></Field>
        <Field id="channel-create-credential" icon="host:key" label={`${managerCopy(props.locale, 'channel.field.credentials')} *`} help={managerCopy(props.locale, 'channel.credentials.help')}><input id="channel-create-credential" data-channel-credential-capture="true" type="password" autoComplete="new-password" required placeholder={managerCopy(props.locale, 'form.text-placeholder')} value={secret} onChange={event => setSecret(event.currentTarget.value)} /></Field>
      </div> : null}
    </section>
    <div className="cxc-channel-actions"><span className="cxc-channel-note" data-channel-create-status="true" role="status">{status}</span><Button variant="primary" data-channel-create-submit="true" type="submit" disabled={busy}><Icon name="success" />{managerCopy(props.locale, 'channel.create.save')}</Button></div>
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
    <div className="cxc-channel-toolbar"><span className="cxc-channel-search"><Icon name="search" /><input data-channel-log-query="true" type="search" value={query} onChange={event => { setQuery(event.currentTarget.value.trim()); setPage(0) }} placeholder={managerCopy(props.locale, 'channel.logs.search')} aria-label={managerCopy(props.locale, 'channel.logs.search')} /></span><select data-channel-log-outcome="true" value={outcome} onChange={event => { setOutcome(event.currentTarget.value as typeof outcome); setPage(0) }}><option value="all">{managerCopy(props.locale, 'channel.logs.all')}</option><option value="success">{managerCopy(props.locale, 'channel.logs.success')}</option><option value="failure">{managerCopy(props.locale, 'channel.logs.failure')}</option></select><Button data-channel-log-export="json" disabled={filtered.length === 0} onClick={() => exportLogs(record, filtered)}>{managerCopy(props.locale, 'channel.logs.export')}</Button></div>
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
