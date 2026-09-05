import { Fragment, useEffect, useMemo, useState } from 'cordisx/react'
import { Button } from 'cordisx/ui'
import type { CordisXReactPageProps } from 'cordisx/contracts'
import {
  deriveOverview,
  filterTraceEvents,
  groupTraceEvents,
  orderTraceEvents,
  type TraceFilters,
  type TraceOrder,
} from './model.js'
import type { TraceDemoKind, TraceEvent, TracePhase, TraceShowcaseStore } from './types.js'

const LANES = ['input', 'model', 'tools', 'injection'] as const
const PHASES: readonly TracePhase[] = [
  'requested',
  'permission',
  'queued',
  'claimed',
  'registered',
  'evaluated',
  'projected',
  'forwarded',
  'released',
  'failed',
  'expired',
  'cancelled',
]
const DEMOS: ReadonlyArray<{ kind: TraceDemoKind; label: string }> = [
  { kind: 'followup', label: 'Followup' },
  { kind: 'steer', label: 'Steer' },
  { kind: 'inject', label: 'Inject' },
  { kind: 'pre-step', label: 'Pre-step append' },
  { kind: 'system-prompt-section', label: 'Prompt section' },
  { kind: 'system-prompt-context', label: 'Prompt context' },
]
const STYLES = `
.cxt-root{--cxt-input:#5b8def;--cxt-model:#99a2b3;--cxt-tools:#c99a3d;--cxt-injection:#4fa99b;display:flex;flex-direction:column;width:calc(100% + 32px);height:calc(100% + 32px);min-height:0;margin:-16px;overflow:hidden;background:var(--cx-surface);color:var(--cx-text);font-size:12px}.cxt-root *{box-sizing:border-box}
.cxt-integrity,.cxt-demos,.cxt-toolbar{display:flex;align-items:center;min-height:36px;border-block-end:1px solid var(--cx-border);background:var(--cx-surface-raised)}.cxt-integrity{gap:8px;padding:0 10px;overflow:hidden}.cxt-integrity-copy{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cxt-badge{padding:2px 6px;border:1px solid var(--cx-border);border-radius:5px;text-transform:uppercase}.cxt-demos{gap:0;padding:0 8px;overflow:auto}.cxt-demos .cxr-ui-button{min-height:28px;padding:2px 8px;border-radius:0;border-inline-end:1px solid var(--cx-border)}.cxt-demos-label{margin-inline-end:8px;color:var(--cx-muted);white-space:nowrap}.cxt-clear{margin-inline-start:auto}
.cxt-overview{border-block-end:1px solid var(--cx-border)}.cxt-overview-head{display:flex;align-items:center;height:30px;padding:0 8px;border-block-end:1px solid var(--cx-border)}.cxt-overview-modes{display:flex;margin-inline-start:auto}.cxt-overview-grid{display:grid;grid-template-columns:70px minmax(0,1fr);height:64px}.cxt-lane-labels{display:grid;grid-template-rows:repeat(4,1fr);padding:3px 7px;text-align:end;color:var(--cx-muted);border-inline-end:1px solid var(--cx-border)}.cxt-overview-track{position:relative}.cxt-overview-span{position:absolute;height:8px;min-width:2px;border:0;border-radius:2px;opacity:.75}.cxt-overview-span[data-lane=input]{top:4px;background:var(--cxt-input)}.cxt-overview-span[data-lane=model]{top:19px;background:var(--cxt-model)}.cxt-overview-span[data-lane=tools]{top:34px;background:var(--cxt-tools)}.cxt-overview-span[data-lane=injection]{top:49px;background:var(--cxt-injection)}
.cxt-toolbar{gap:0;padding:0 7px;overflow:auto}.cxt-toolbar input,.cxt-toolbar select{height:28px;min-width:100px;padding:3px 7px;border:1px solid var(--cx-border);border-inline-end:0;background:var(--cx-surface-raised);color:var(--cx-text);font:inherit}.cxt-toolbar input{flex:1;min-width:150px}.cxt-count{margin-inline-start:auto;padding-inline-start:8px;color:var(--cx-muted);white-space:nowrap}
.cxt-split{display:flex;flex:1;min-height:0}.cxt-ledger{display:flex;flex:1;min-width:0;flex-direction:column}.cxt-table-scroll{flex:1;min-height:0;overflow:auto}.cxt-table{width:100%;border-spacing:0;table-layout:fixed}.cxt-table th,.cxt-table td{height:30px;padding:0 7px;border-block-end:1px solid var(--cx-border);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:start}.cxt-table th{position:sticky;top:0;background:var(--cx-surface-raised)}.cxt-group td{height:24px;background:var(--cx-surface-raised);color:var(--cx-muted)}.cxt-row{cursor:pointer}.cxt-row[data-selected=true]{background:var(--cx-hover)}.cxt-lane-tag{padding:2px 5px;border:1px solid currentColor;border-radius:4px}.cxt-truth{margin-inline-start:6px;color:var(--cx-muted)}
.cxt-detail{flex:0 0 clamp(280px,31%,390px);min-width:0;border-inline-start:1px solid var(--cx-border);overflow:auto}.cxt-detail-head{padding:9px 10px;border-block-end:1px solid var(--cx-border);font-weight:600}.cxt-detail-scroll{padding:10px}.cxt-detail dl{display:grid;grid-template-columns:96px minmax(0,1fr);margin:0}.cxt-detail dt,.cxt-detail dd{margin:0;padding:4px 0;border-block-end:1px solid var(--cx-border)}.cxt-detail dt{color:var(--cx-muted)}.cxt-detail dd{overflow-wrap:anywhere}.cxt-payload{white-space:pre-wrap;overflow:auto}.cxt-empty{display:grid;min-height:140px;place-items:center;color:var(--cx-muted)}
@media(max-width:650px){.cxt-detail{display:none}.cxt-overview-grid{grid-template-columns:1fr}.cxt-lane-labels{display:none}}
`

function clock(value: string): string {
  return new Date(value).toLocaleTimeString(undefined, { hour12: false })
}
function text(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return '[unserializable payload]'
  }
}
function latestQueued(events: readonly TraceEvent[], requestId: string | undefined): boolean {
  return requestId !== undefined
    && [...events].reverse().find(event => event.requestId === requestId)?.phase === 'queued'
}

function Detail(
  { event, store, events }: {
    readonly event: TraceEvent | undefined
    readonly store: TraceShowcaseStore
    readonly events: readonly TraceEvent[]
  },
) {
  if (event === undefined) return <p className="cxt-detail-empty">Select an event to view details.</p>
  const values: readonly [string, unknown][] = [
    ['Event id', event.id],
    ['Sequence', event.seq],
    ['Source sequence', event.sourceSeq],
    ['Recorded', clock(event.recordedAt)],
    ['Origin', event.origin],
    ['Lane', event.lane],
    ['Event type', event.type],
    ['Semantic', event.semanticType],
    ['Truth', event.truth],
    ['Phase', event.phase],
    ['Session', event.sessionId],
    ['Turn', event.turnId],
    ['Step', event.stepId],
    ['Item', event.itemId],
    ['Message', event.messageId],
    ['Tool call', event.toolCallId],
    ['Context', event.contextId],
    ['Parent', event.parentId],
    ['Request', event.requestId],
    ['Source', `${event.source.kind}:${event.source.id}`],
    ['Plugin source', event.plugin?.source],
    ['Plugin', event.plugin === undefined ? undefined : `${event.plugin.id}@${event.plugin.version ?? 'unversioned'}`],
    ['Generation', event.plugin?.generation],
    ['Capability', event.permission?.capability],
    [
      'Permission',
      event.permission === undefined ? undefined : `${event.permission.policy} → ${event.permission.outcome}`,
    ],
    ['Consumption', event.modelConsumption],
    ['Duration', event.timing?.durationMs === undefined ? undefined : `${event.timing.durationMs} ms`],
  ]
  return (
    <>
      <h3 className="cxt-detail-title">{event.summary}</h3>
      <dl>
        {values.filter(([, value]) => value !== undefined).map(([label, value]) => (
          <Fragment key={label}>
            <dt>{label}</dt>
            <dd>{String(value)}</dd>
          </Fragment>
        ))}
      </dl>
      {event.payload === undefined ? null : <pre className="cxt-payload">{text(event.payload)}</pre>}
      {latestQueued(events, event.requestId)
        ? (
          <div className="cxt-detail-actions">
            <Button onClick={() => void store.cancelQueued(event.requestId!)}>Cancel queued contribution</Button>
          </div>
        )
        : null}
    </>
  )
}

export function createTraceReactPage(createStore: (sessionId: string) => TraceShowcaseStore) {
  return function TraceReactPage(props: CordisXReactPageProps) {
    const sessionId = props.params.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('Agent Trace route requires a host-issued session id')
    }
    const store = useMemo(() => createStore(sessionId), [sessionId])
    useEffect(() => () => store.dispose(), [store])
    const [, refresh] = useState(0)
    useEffect(() => {
      const dispose = store.subscribe(() => refresh(version => version + 1))
      // The provider may complete an eager permission/history read before the
      // passive React subscription is installed. Re-read once after subscribing.
      refresh(version => version + 1)
      return dispose
    }, [store])
    const snapshot = store.getSnapshot()
    const [selectedId, setSelectedId] = useState<string>()
    const [order, setOrder] = useState<TraceOrder>('sequence')
    const [search, setSearch] = useState(''),
      [lane, setLane] = useState<TraceFilters['lane']>('all'),
      [truth, setTruth] = useState<TraceFilters['truth']>('all')
    const [origin, setOrigin] = useState<TraceFilters['origin']>('all'),
      [source, setSource] = useState<TraceFilters['source']>('all'),
      [type, setType] = useState<TraceFilters['type']>('all'),
      [phase, setPhase] = useState<TraceFilters['phase']>('all')
    const filtered = filterTraceEvents(snapshot.events, { search, lane, truth, origin, source, type, phase }),
      ordered = orderTraceEvents(filtered, order),
      rendered = ordered.slice(-snapshot.range.renderedLimit)
    const renderedIds = new Set(rendered.map(event => event.id)),
      selected = snapshot.events.find(event => event.id === selectedId)
    const sources = [
        ...new Set(
          snapshot.events.flatMap(
            event => [event.source.id, ...(event.plugin === undefined ? [] : [event.plugin.source])],
          ),
        ),
      ].sort(),
      types = [...new Set(snapshot.events.map(event => event.type))].sort()
    const loaded = `${snapshot.range.loaded}${
      snapshot.range.totalAvailable === undefined ? '' : `/${snapshot.range.totalAvailable}`
    }`
    const select = (
      label: string,
      aria: string,
      value: string,
      set: (value: never) => void,
      values: readonly string[],
    ) => (
      <select
        className="cxt-filter"
        aria-label={aria}
        value={value}
        onChange={event => set(event.currentTarget.value as never)}
      >
        <option value="all">{label}</option>
        {values.map(item => <option key={item} value={item}>{item}</option>)}
      </select>
    )
    return (
      <div className="cxt-root" data-agent-trace-showcase="true">
        <style>{STYLES}</style>
        <div className="cxt-integrity" title={snapshot.status.diagnostics.join('\n')}>
          <span className="cxt-badge" data-mode={snapshot.status.mode}>{snapshot.status.mode}</span>
          <span className="cxt-integrity-copy">
            <strong>{snapshot.status.completeness}</strong> · loaded {loaded} · {snapshot.status.payloadPolicy}{' '}
            payloads · {snapshot.status.contractVersion ?? 'core contract pending'}
            {snapshot.status.origins.length === 0
              ? ' · no source available'
              : ` · ${snapshot.status.origins.join('+')}`}
          </span>
        </div>
        <div className="cxt-demos">
          <span className="cxt-demos-label">Explicit demo actions</span>
          {DEMOS.map(demo => (
            <Button
              key={demo.kind}
              data-demo-kind={demo.kind}
              disabled={!snapshot.status.supportedOperations.includes(demo.kind)}
              onClick={() => void store.requestDemo({ kind: demo.kind })}
            >
              {demo.label}
            </Button>
          ))}
          <Button
            className="cxt-clear"
            disabled={snapshot.status.supportedOperations.length === 0}
            onClick={() => void store.clearQueued()}
          >
            Clear queued
          </Button>
        </div>
        <section className="cxt-overview">
          <div className="cxt-overview-head">
            <strong className="cxt-overview-title">Overview</strong>
            <div className="cxt-overview-modes">
              {(['sequence', 'time'] as const).map(mode => (
                <Button
                  key={mode}
                  data-active={order === mode}
                  aria-pressed={order === mode}
                  onClick={() => setOrder(mode)}
                >
                  {mode === 'sequence' ? 'Sequence' : 'Time'}
                </Button>
              ))}
            </div>
          </div>
          <div className="cxt-overview-grid">
            <div className="cxt-lane-labels">
              {LANES.map(item => (
                <span key={item}>{item === 'injection' ? 'Inject' : `${item[0]!.toUpperCase()}${item.slice(1)}`}</span>
              ))}
            </div>
            <div className="cxt-overview-track">
              {deriveOverview(orderTraceEvents(snapshot.events, order), order).map(span => (
                <button
                  key={span.event.id}
                  type="button"
                  className="cxt-overview-span"
                  style={{ left: `${span.left}%`, width: `${span.width}%` }}
                  data-lane={span.event.lane}
                  data-selected={selectedId === span.event.id}
                  data-match={renderedIds.has(span.event.id)}
                  aria-label={`Event ${span.event.seq}: ${span.event.summary}`}
                  onClick={() => setSelectedId(span.event.id)}
                />
              ))}
            </div>
          </div>
        </section>
        <div className="cxt-toolbar" role="toolbar" aria-label="Timeline filters">
          <input
            className="cxt-search"
            type="search"
            placeholder="Search loaded events"
            aria-label="Search loaded events"
            value={search}
            onChange={event => setSearch(event.currentTarget.value)}
          />
          {select('All lanes', 'Filter by lane', lane, setLane as never, LANES)}
          {select('All truth', 'Filter by truth source', truth, setTruth as never, ['observed', 'cordisx', 'inferred'])}
          {select('All origins', 'Filter by acquisition origin', origin, setOrigin as never, [
            'live',
            'historical',
            'fixture',
          ])}
          {select('All sources', 'Filter by source', source, setSource as never, sources)}
          {select('All types', 'Filter by type', type, setType as never, types)}
          {select('All phases', 'Filter by lifecycle phase', phase, setPhase as never, PHASES)}
          <span className="cxt-count">
            {rendered.length}/{snapshot.events.length} loaded · limit {snapshot.range.renderedLimit}
          </span>
        </div>
        <div className="cxt-split">
          <section className="cxt-ledger">
            {snapshot.hasEarlier || snapshot.loadingEarlier
              ? (
                <div className="cxt-history">
                  <Button
                    disabled={snapshot.loadingEarlier}
                    onClick={() => void store.loadEarlier()}
                  >
                    {snapshot.loadingEarlier ? 'Loading earlier events…' : 'Load earlier events'}
                  </Button>
                </div>
              )
              : null}
            <div className="cxt-table-scroll">
              {snapshot.status.completeness === 'unavailable'
                ? <div className="cxt-empty">Agent events are currently unavailable.</div>
                : rendered.length === 0
                ? (
                  <div className="cxt-empty">
                    {snapshot.events.length === 0
                      ? 'No events in the loaded session window.'
                      : 'No loaded events match these filters.'}
                  </div>
                )
                : (
                  <table className="cxt-table">
                    <thead>
                      <tr>
                        <th>Seq</th>
                        <th>Event</th>
                        <th>Phase</th>
                        <th>Content</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groupTraceEvents(rendered).map((turn, turnIndex) => (
                        <Fragment key={turn.turnId ?? `between-${turnIndex}`}>
                          <tr className="cxt-group" data-kind="turn">
                            <td colSpan={4}>
                              {turn.turnNumber !== undefined
                                ? `Turn ${turn.turnNumber}`
                                : turn.turnId === undefined
                                ? 'Between turns'
                                : `Turn ${turn.turnId}`}
                            </td>
                          </tr>
                          {turn.steps.map((step, stepIndex) => (
                            <Fragment key={step.stepId ?? `unscoped-${turnIndex}-${stepIndex}`}>
                              <tr className="cxt-group" data-kind="step">
                                <td colSpan={4}>
                                  {step.stepNumber !== undefined
                                    ? `Step ${step.stepNumber}`
                                    : step.stepId === undefined
                                    ? 'Unscoped'
                                    : `Step ${step.stepId}`}
                                </td>
                              </tr>
                              {step.events.map(event => (
                                <tr
                                  key={event.id}
                                  className="cxt-row"
                                  tabIndex={0}
                                  data-event-id={event.id}
                                  data-selected={event.id === selectedId}
                                  data-error={event.phase === 'failed'}
                                  aria-selected={event.id === selectedId}
                                  onClick={() => setSelectedId(event.id)}
                                  onKeyDown={key => {
                                    if (key.key === 'Enter' || key.key === ' ') {
                                      setSelectedId(event.id)
                                    }
                                  }}
                                >
                                  <td className="cxt-seq">{event.seq}</td>
                                  <td>
                                    <span className="cxt-lane-tag" data-lane={event.lane}>
                                      {event.lane === 'injection' ? 'inject' : event.lane}
                                    </span>{' '}
                                    {event.semanticType}
                                  </td>
                                  <td className="cxt-phase" data-phase={event.phase}>{event.phase ?? '—'}</td>
                                  <td>
                                    {event.summary}
                                    <span className="cxt-truth">{event.origin}/{event.truth}</span>
                                  </td>
                                </tr>
                              ))}
                            </Fragment>
                          ))}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                )}
            </div>
          </section>
          <aside className="cxt-detail">
            <div className="cxt-detail-head">Event detail</div>
            <div className="cxt-detail-scroll">
              <Detail event={selected} store={store} events={snapshot.events} />
            </div>
          </aside>
        </div>
      </div>
    )
  }
}
