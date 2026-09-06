import type { Context } from '@deepseek-ai/cordis'
import { Button, Card, EmptyState, Heading, Stack, Text } from 'cordisx/ui'
import type { CordisXReactPageProps } from '../../contracts.js'
import styles from './view.css'
import {
  modelKey,
  parsedModel,
  type ProviderFleetConfig,
  type ProviderFleetMessages,
  sessionKey,
  useProviderFleetModel,
} from './model.js'

export function createProviderFleetPage(ctx: Context, config: ProviderFleetConfig) {
  return function ProviderFleetPage(props: CordisXReactPageProps<ProviderFleetMessages>) {
    const {
      activeTurn,
      composer,
      controlSession,
      controlTurn,
      create,
      cwd,
      initialMessage,
      model,
      models,
      nextCursor,
      provider,
      read,
      refreshAll,
      refreshSessions,
      search,
      searchKey,
      selected,
      sessionActions,
      sessions,
      setComposer,
      setCwd,
      setInitialMessage,
      setModel,
      setProvider,
      setSearch,
      setSteer,
      status,
      steer,
      submit,
      visibleModels,
    } = useProviderFleetModel(ctx, config, props.t)

    return (
      <section className="cxp-fleet" data-cordisx-provider-fleet="true">
        <style>{styles}</style>
        <div className="cxp-catalog">
          <Stack gap="small">
            <Text tone="muted">{props.t('page.subtitle')}</Text>
            <div className="cxp-toolbar" role="toolbar">
              <select
                aria-label={props.t('field.provider')}
                value={provider}
                onChange={event => {
                  setProvider(event.currentTarget.value)
                  setModel('')
                }}
              >
                <option value="">All providers</option>
                {[...new Set(models.map(item => item.ref.providerId))].sort().map(id => (
                  <option key={id} value={id}>{id}</option>
                ))}
              </select>
              <select
                aria-label={props.t('field.model')}
                value={model}
                onChange={event => setModel(event.currentTarget.value)}
              >
                {visibleModels.map(item => (
                  <option key={modelKey(item.ref)} value={modelKey(item.ref)}>
                    [{item.ref.providerId}] {item.label}
                  </option>
                ))}
              </select>
              <input
                aria-label={props.t('field.cwd')}
                placeholder={props.t('field.cwd')}
                value={cwd}
                onChange={event => setCwd(event.currentTarget.value)}
              />
              <input
                aria-label={props.t('field.search')}
                placeholder={props.t('field.search')}
                value={search}
                onChange={event => setSearch(event.currentTarget.value)}
                onKeyDown={searchKey}
              />
              <input
                aria-label={props.t('field.initial-message')}
                placeholder={props.t('field.initial-message')}
                value={initialMessage}
                onChange={event => setInitialMessage(event.currentTarget.value)}
              />
              <Button onClick={() => void refreshAll()}>{props.t('action.refresh')}</Button>
              <Button
                variant="primary"
                disabled={parsedModel(model) === undefined || cwd.trim() === ''}
                onClick={() => void create()}
              >
                {props.t('action.create')}
              </Button>
            </div>
            <div className="cxp-note" role="status">{status}</div>
            {sessions.length === 0
              ? <EmptyState title={props.t('state.empty')} />
              : (
                <div className="cxp-sessions" role="list">
                  {sessions.map(session => (
                    <button
                      key={sessionKey(session.ref)}
                      type="button"
                      className="cxp-session"
                      role="listitem"
                      data-session={sessionKey(session.ref)}
                      onClick={() => void read(session.ref)}
                    >
                      <strong>{session.title ?? session.ref.remoteSessionId}</strong>
                      <span className="cxp-meta">
                        {props.t('session.provider', { provider: session.ref.providerId })} ·{' '}
                        {props.t('session.model', { model: session.model.modelId })}
                      </span>
                      <span className="cxp-meta">{session.cwd}</span>
                    </button>
                  ))}
                </div>
              )}
            {nextCursor === undefined
              ? null
              : <Button onClick={() => void refreshSessions(nextCursor, true)}>{props.t('action.load-more')}</Button>}
          </Stack>
        </div>
        <div className="cxp-detail">
          {selected === undefined ? <EmptyState title={props.t('state.select-session')} /> : (
            <Stack gap="medium">
              <div>
                <Heading level={2}>{selected.title ?? selected.ref.remoteSessionId}</Heading>
                <Text tone="muted">{selected.ref.providerId} / {selected.ref.remoteSessionId}</Text>
              </div>
              <Stack direction="row" gap="small" wrap>
                {sessionActions.map(action => (
                  <Button
                    key={action}
                    variant={action === 'delete' ? 'danger' : 'secondary'}
                    onClick={() => void controlSession(action)}
                  >
                    {props.t(`action.${action}`)}
                  </Button>
                ))}
              </Stack>
              {'turns' in selected
                ? (
                  <div className="cxp-turns">
                    {selected.turns.map(turn => (
                      <Card key={turn.id} className="cxp-turn">
                        <strong>{turn.state} · {turn.id}</strong>
                        {turn.items.map(item => <Text key={item.id}>{item.text ?? `[${item.kind}]`}</Text>)}
                      </Card>
                    ))}
                  </div>
                )
                : null}
              {selected.state === 'active'
                ? (
                  <>
                    <textarea
                      className="cxp-composer"
                      aria-label={props.t('action.send')}
                      value={composer}
                      onChange={event => setComposer(event.currentTarget.value)}
                    />
                    <Button
                      variant="primary"
                      onClick={() => void submit()}
                    >
                      {props.t('action.send')}
                    </Button>
                    {activeTurn === undefined ? null : (
                      <Stack direction="row" gap="small">
                        <input
                          aria-label={props.t('action.steer')}
                          value={steer}
                          onChange={event => setSteer(event.currentTarget.value)}
                        />
                        <Button onClick={() => void controlTurn('steer')}>{props.t('action.steer')}</Button>
                        <Button
                          onClick={() => void controlTurn('interrupt')}
                        >
                          {props.t('action.interrupt')}
                        </Button>
                      </Stack>
                    )}
                  </>
                )
                : null}
            </Stack>
          )}
        </div>
      </section>
    )
  }
}
