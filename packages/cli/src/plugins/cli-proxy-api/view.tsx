import type { Context } from '@deepseek-ai/cordis'
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'cordisx/react'
import { Button, Card, EmptyState, Heading, Stack, Text } from 'cordisx/ui'
import type {
  CordisXModelDescriptor,
  CordisXPlatformModelRef,
  CordisXPlatformSessionRef,
  CordisXReactPageProps,
  CordisXSessionProjection,
  CordisXSessionSummary,
} from '../../contracts.js'

interface Config { readonly providerIds: readonly string[]; readonly defaultCwd: string }
interface Messages {
  'page.subtitle': undefined; 'field.provider': undefined; 'field.model': undefined; 'field.cwd': undefined; 'field.initial-message': undefined; 'field.search': undefined
  'action.refresh': undefined; 'action.create': undefined; 'action.load-more': undefined; 'action.continue': undefined; 'action.fork': undefined; 'action.archive': undefined; 'action.restore': undefined; 'action.delete': undefined; 'action.send': undefined; 'action.steer': undefined; 'action.interrupt': undefined
  'state.loading': undefined; 'state.empty': undefined; 'state.no-models': undefined; 'state.select-session': undefined; 'state.error': { readonly message: string }
  'session.provider': { readonly provider: string }; 'session.model': { readonly model: string }
}

const STYLES = `
.cxp-fleet{display:grid;grid-template-columns:minmax(300px,42%) minmax(360px,1fr);min-height:calc(100vh - 86px);margin:-16px}
.cxp-catalog,.cxp-detail{min-width:0;padding:18px;overflow:auto}.cxp-catalog{border-inline-end:1px solid var(--cx-border)}
.cxp-toolbar{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border:1px solid var(--cx-border);border-radius:10px;overflow:hidden;background:var(--cx-surface-raised)}
.cxp-toolbar input,.cxp-toolbar select{min-width:0;min-height:38px;padding:7px 10px;border:0;border-inline-end:1px solid var(--cx-border);border-block-end:1px solid var(--cx-border);background:transparent;color:var(--cx-text);font:inherit}.cxp-toolbar .cxr-ui-button{border:0;border-radius:0;border-inline-end:1px solid var(--cx-border)}
.cxp-sessions{display:grid;margin-top:10px}.cxp-session{display:grid;gap:3px;padding:11px 4px;border:0;border-block-end:1px solid var(--cx-border);background:transparent;color:var(--cx-text);font:inherit;text-align:start;cursor:pointer}.cxp-session:hover{background:var(--cx-hover)}
.cxp-meta{color:var(--cx-muted);font-size:12px;overflow:hidden;text-overflow:ellipsis}.cxp-turns{display:grid;gap:14px}.cxp-turn{display:grid;gap:6px;padding:12px}.cxp-composer{width:100%;min-height:86px;padding:9px;border:1px solid var(--cx-border);border-radius:9px;background:var(--cx-surface-raised);color:var(--cx-text);font:inherit;resize:vertical}.cxp-note{min-height:20px;color:var(--cx-muted);font-size:12px}
@media(max-width:760px){.cxp-fleet{grid-template-columns:1fr;margin:0}.cxp-catalog{border-inline-end:0;border-block-end:1px solid var(--cx-border)}.cxp-toolbar{grid-template-columns:1fr}}
`

function modelKey(ref: CordisXPlatformModelRef): string { return JSON.stringify([ref.providerId, ref.modelId]) }
function parsedModel(value: string): CordisXPlatformModelRef | undefined {
  try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) && parsed.length === 2 && parsed.every(item => typeof item === 'string') ? { providerId: parsed[0] as string, modelId: parsed[1] as string } : undefined } catch { return undefined }
}
function sessionKey(ref: CordisXPlatformSessionRef): string { return JSON.stringify([ref.providerId, ref.remoteSessionId]) }

export function createProviderFleetPage(ctx: Context, config: Config) {
  return function ProviderFleetPage(props: CordisXReactPageProps<Messages>) {
    const configuredProviders = useMemo(() => config.providerIds.length === 0 ? undefined : [...new Set(config.providerIds)], [])
    const [models, setModels] = useState<readonly CordisXModelDescriptor[]>([])
    const [sessions, setSessions] = useState<readonly CordisXSessionSummary[]>([])
    const [nextCursor, setNextCursor] = useState<string>()
    const [selected, setSelected] = useState<CordisXSessionProjection | CordisXSessionSummary>()
    const [provider, setProvider] = useState('')
    const [model, setModel] = useState('')
    const [cwd, setCwd] = useState(config.defaultCwd)
    const [search, setSearch] = useState('')
    const [initialMessage, setInitialMessage] = useState('')
    const [composer, setComposer] = useState('')
    const [steer, setSteer] = useState('')
    const [status, setStatus] = useState('')

    const showError = (error: { readonly message: string }) => setStatus(props.t('state.error', { message: error.message }))
    const providerIds = provider === '' ? configuredProviders ?? [...new Set(models.map(item => item.ref.providerId))].sort() : [provider]
    const visibleModels = models.filter(item => provider === '' || item.ref.providerId === provider)

    const refreshSessions = useCallback(async (cursor?: string, append = false, requestedProviderIds?: readonly string[]) => {
      setStatus(props.t('state.loading'))
      const result = await ctx.platform.tasks.list({
        ...((requestedProviderIds ?? providerIds).length === 0 ? {} : { providerIds: requestedProviderIds ?? providerIds }), ...(cwd.trim() === '' ? {} : { cwd: cwd.trim() }),
        ...(search.trim() === '' ? {} : { searchTerm: search.trim() }), ...(cursor === undefined ? {} : { cursor }), limit: 50,
      })
      if (!result.ok) { showError(result.error); return }
      setSessions(current => append ? [...current, ...result.value.sessions.filter(item => !new Set(current.map(entry => sessionKey(entry.ref))).has(sessionKey(item.ref)))] : result.value.sessions)
      setNextCursor(result.value.nextCursor); setStatus(models.length === 0 ? props.t('state.no-models') : '')
    }, [provider, cwd, search, models, props.t])

    const refreshAll = useCallback(async () => {
      setStatus(props.t('state.loading'))
      const result = await ctx.platform.models.list(configuredProviders === undefined ? {} : { providerIds: configuredProviders })
      if (!result.ok) { showError(result.error); return }
      setModels(result.value.models)
      const nextVisible = result.value.models.filter(item => provider === '' || item.ref.providerId === provider)
      setModel(current => nextVisible.some(item => modelKey(item.ref) === current) ? current : modelKey((nextVisible.find(item => item.isDefault) ?? nextVisible[0])?.ref ?? { providerId: '', modelId: '' }))
      const discoveredProviders = configuredProviders ?? [...new Set(result.value.models.map(item => item.ref.providerId))].sort()
      await refreshSessions(undefined, false, provider === '' ? discoveredProviders : [provider])
    }, [provider, refreshSessions, props.t])

    useEffect(() => { void refreshAll() }, [])

    const read = async (ref: CordisXPlatformSessionRef) => { const result = await ctx.platform.tasks.read({ session: ref }); if (!result.ok) showError(result.error); else setSelected(result.value) }
    const create = async () => {
      const selectedModel = parsedModel(model); if (selectedModel === undefined || cwd.trim() === '') return
      const result = await ctx.platform.tasks.create({ model: selectedModel, cwd: cwd.trim(), ...(initialMessage.trim() === '' ? {} : { initialMessage: initialMessage.trim() }) })
      if (!result.ok) { showError(result.error); return }
      setSelected(result.value.session); setInitialMessage(''); if (result.value.status === 'created-initial-turn-failed') showError(result.value.error)
      await refreshSessions(); if (result.value.status === 'created' && result.value.initialTurn !== undefined) await read(result.value.session.ref)
    }
    const controlSession = async (action: 'continue' | 'fork' | 'archive' | 'restore' | 'delete') => {
      if (selected === undefined) return
      const result = await ctx.platform.tasks.control({ action, session: selected.ref } as Parameters<typeof ctx.platform.tasks.control>[0])
      if (!result.ok) { showError(result.error); return }
      setSelected(result.value.action === 'delete' ? undefined : result.value.session); await refreshSessions()
    }
    const submit = async () => {
      if (selected === undefined || composer.trim() === '') return
      const result = await ctx.platform.turns.submit({ session: selected.ref, message: composer.trim() })
      if (!result.ok) showError(result.error); else { setComposer(''); await read(selected.ref) }
    }
    const activeTurn = selected !== undefined && 'turns' in selected ? [...selected.turns].reverse().find(turn => turn.state === 'in-progress') : undefined
    const controlTurn = async (action: 'steer' | 'interrupt') => {
      if (selected === undefined || activeTurn === undefined) return
      const result = await ctx.platform.turns.control(action === 'steer' ? { action, session: selected.ref, turnId: activeTurn.id, message: steer.trim() } : { action, session: selected.ref, turnId: activeTurn.id })
      if (!result.ok) showError(result.error); else await read(selected.ref)
    }
    const searchKey = (event: KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter') void refreshSessions() }
    const sessionActions: readonly ('continue' | 'fork' | 'archive' | 'restore' | 'delete')[] = selected?.state === 'archived'
      ? ['restore', 'delete'] : ['continue', 'fork', 'archive', 'delete']

    return <section className="cxp-fleet" data-cordisx-provider-fleet="true"><style>{STYLES}</style><div className="cxp-catalog"><Stack gap="small"><Text tone="muted">{props.t('page.subtitle')}</Text>
      <div className="cxp-toolbar" role="toolbar"><select aria-label={props.t('field.provider')} value={provider} onChange={event => { setProvider(event.currentTarget.value); setModel('') }}><option value="">All providers</option>{[...new Set(models.map(item => item.ref.providerId))].sort().map(id => <option key={id} value={id}>{id}</option>)}</select>
        <select aria-label={props.t('field.model')} value={model} onChange={event => setModel(event.currentTarget.value)}>{visibleModels.map(item => <option key={modelKey(item.ref)} value={modelKey(item.ref)}>[{item.ref.providerId}] {item.label}</option>)}</select>
        <input aria-label={props.t('field.cwd')} placeholder={props.t('field.cwd')} value={cwd} onChange={event => setCwd(event.currentTarget.value)} />
        <input aria-label={props.t('field.search')} placeholder={props.t('field.search')} value={search} onChange={event => setSearch(event.currentTarget.value)} onKeyDown={searchKey} />
        <input aria-label={props.t('field.initial-message')} placeholder={props.t('field.initial-message')} value={initialMessage} onChange={event => setInitialMessage(event.currentTarget.value)} />
        <Button onClick={() => void refreshAll()}>{props.t('action.refresh')}</Button><Button variant="primary" disabled={parsedModel(model) === undefined || cwd.trim() === ''} onClick={() => void create()}>{props.t('action.create')}</Button>
      </div><div className="cxp-note" role="status">{status}</div>
      {sessions.length === 0 ? <EmptyState title={props.t('state.empty')} /> : <div className="cxp-sessions" role="list">{sessions.map(session => <button key={sessionKey(session.ref)} type="button" className="cxp-session" role="listitem" data-session={sessionKey(session.ref)} onClick={() => void read(session.ref)}><strong>{session.title ?? session.ref.remoteSessionId}</strong><span className="cxp-meta">{props.t('session.provider', { provider: session.ref.providerId })} · {props.t('session.model', { model: session.model.modelId })}</span><span className="cxp-meta">{session.cwd}</span></button>)}</div>}
      {nextCursor === undefined ? null : <Button onClick={() => void refreshSessions(nextCursor, true)}>{props.t('action.load-more')}</Button>}
    </Stack></div><div className="cxp-detail">{selected === undefined ? <EmptyState title={props.t('state.select-session')} /> : <Stack gap="medium"><div><Heading level={2}>{selected.title ?? selected.ref.remoteSessionId}</Heading><Text tone="muted">{selected.ref.providerId} / {selected.ref.remoteSessionId}</Text></div>
      <Stack direction="row" gap="small" wrap>{sessionActions.map(action => <Button key={action} variant={action === 'delete' ? 'danger' : 'secondary'} onClick={() => void controlSession(action)}>{props.t(`action.${action}`)}</Button>)}</Stack>
      {'turns' in selected ? <div className="cxp-turns">{selected.turns.map(turn => <Card key={turn.id} className="cxp-turn"><strong>{turn.state} · {turn.id}</strong>{turn.items.map(item => <Text key={item.id}>{item.text ?? `[${item.kind}]`}</Text>)}</Card>)}</div> : null}
      {selected.state === 'active' ? <><textarea className="cxp-composer" aria-label={props.t('action.send')} value={composer} onChange={event => setComposer(event.currentTarget.value)} /><Button variant="primary" onClick={() => void submit()}>{props.t('action.send')}</Button>{activeTurn === undefined ? null : <Stack direction="row" gap="small"><input aria-label={props.t('action.steer')} value={steer} onChange={event => setSteer(event.currentTarget.value)} /><Button onClick={() => void controlTurn('steer')}>{props.t('action.steer')}</Button><Button onClick={() => void controlTurn('interrupt')}>{props.t('action.interrupt')}</Button></Stack>}</> : null}
    </Stack>}</div></section>
  }
}
