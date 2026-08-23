import type { CordisXPageMountContext } from 'cordisx/contracts'
import {
  deriveOverview,
  EMPTY_FILTERS,
  filterTraceEvents,
  groupTraceEvents,
  orderTraceEvents,
  type TraceFilters,
  type TraceOrder,
} from './model.js'
import type {
  TraceDemoKind,
  TraceEvent,
  TraceLane,
  TracePhase,
  TraceShowcaseStore,
  TraceSnapshot,
  TraceTruth,
} from './types.js'

const LANES: readonly TraceLane[] = ['input', 'model', 'tools', 'injection']
const TRUTHS: readonly TraceTruth[] = ['observed', 'cordisx', 'inferred']
const PHASES: readonly TracePhase[] = [
  'requested', 'permission', 'queued', 'claimed', 'registered', 'evaluated',
  'projected', 'forwarded', 'released', 'failed', 'expired', 'cancelled',
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
.cxt-root{--cxt-input:#5b8def;--cxt-model:#99a2b3;--cxt-tools:#c99a3d;--cxt-injection:#4fa99b;display:flex;flex-direction:column;width:100%;height:100%;min-height:0;overflow:hidden;background:var(--color-background-surface-under,#111315);color:var(--color-text,#e5e7eb);font:12px/1.4 ui-sans-serif,system-ui,sans-serif}
.cxt-root *{box-sizing:border-box}.cxt-root button,.cxt-root input,.cxt-root select{font:inherit}.cxt-integrity{display:flex;align-items:center;gap:8px;min-height:30px;padding:0 10px;border-bottom:1px solid var(--color-border,rgba(255,255,255,.08));background:var(--color-background-surface,#181a1d);color:var(--color-text-secondary,#a6acb7);white-space:nowrap;overflow:hidden}.cxt-integrity strong{color:var(--color-text,#e5e7eb);font-weight:600}.cxt-integrity-copy{overflow:hidden;text-overflow:ellipsis}.cxt-badge{display:inline-flex;align-items:center;height:18px;padding:0 6px;border:1px solid var(--color-border,rgba(255,255,255,.1));border-radius:4px;background:var(--color-background-elevated-secondary,rgba(255,255,255,.035));font:10px/16px ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.04em}.cxt-badge[data-mode=fixture]{color:var(--cxt-tools)}.cxt-badge[data-mode=live],.cxt-badge[data-mode=partial]{color:var(--cxt-injection)}.cxt-badge[data-mode=unavailable]{color:var(--color-text-tertiary,#727987)}
.cxt-demos{display:flex;align-items:center;gap:4px;min-height:38px;padding:5px 8px;border-bottom:1px solid var(--color-border,rgba(255,255,255,.08));background:var(--color-background-surface-under,#111315);overflow-x:auto}.cxt-demos-label{flex:none;margin-right:4px;color:var(--color-text-tertiary,#7e8592);font:10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.06em}.cxt-button{display:inline-flex;align-items:center;justify-content:center;height:24px;padding:0 7px;border:1px solid var(--color-border,rgba(255,255,255,.1));border-radius:4px;color:var(--color-text-secondary,#aeb4bf);background:transparent;cursor:pointer;white-space:nowrap}.cxt-button:hover:not(:disabled){color:var(--color-text,#e5e7eb);background:var(--color-background-elevated-secondary,rgba(255,255,255,.06))}.cxt-button:focus-visible,.cxt-filter:focus-visible,.cxt-search:focus-visible{outline:1px solid var(--color-focus,#6b9cff);outline-offset:1px}.cxt-button:disabled{opacity:.42;cursor:default}.cxt-button[data-active=true]{color:var(--color-text,#fff);background:var(--color-background-elevated-secondary,rgba(255,255,255,.08))}.cxt-clear{margin-left:auto}
.cxt-overview{flex:none;border-bottom:1px solid var(--color-border,rgba(255,255,255,.08));background:var(--color-background-elevated-secondary,rgba(255,255,255,.025))}.cxt-overview-head{display:flex;align-items:center;height:28px;padding:0 8px;border-bottom:1px solid var(--color-border,rgba(255,255,255,.06))}.cxt-overview-title{font-weight:600}.cxt-overview-modes{display:flex;gap:2px;margin-left:auto}.cxt-overview-modes .cxt-button{height:20px;border-color:transparent}.cxt-overview-grid{display:grid;grid-template-columns:70px minmax(0,1fr);height:64px}.cxt-lane-labels{position:relative;border-right:1px solid var(--color-border,rgba(255,255,255,.07));color:var(--color-text-tertiary,#7e8592);font:10px/1 ui-monospace,SFMono-Regular,Menlo,monospace}.cxt-lane-labels span{position:absolute;right:7px;height:10px}.cxt-lane-labels span:nth-child(1){top:5px}.cxt-lane-labels span:nth-child(2){top:20px}.cxt-lane-labels span:nth-child(3){top:35px}.cxt-lane-labels span:nth-child(4){top:50px}.cxt-overview-track{position:relative;overflow:hidden;background-image:linear-gradient(to bottom,transparent 14px,var(--color-border,rgba(255,255,255,.04)) 15px,transparent 16px,transparent 29px,var(--color-border,rgba(255,255,255,.04)) 30px,transparent 31px,transparent 44px,var(--color-border,rgba(255,255,255,.04)) 45px,transparent 46px)}.cxt-overview-span{position:absolute;height:8px;min-width:2px;border-radius:1px;opacity:.78;cursor:pointer}.cxt-overview-span:hover{opacity:1;box-shadow:0 0 0 1px var(--color-background-surface,#181a1d),0 0 0 2px var(--color-focus,#6b9cff)}.cxt-overview-span[data-selected=true]{opacity:1;box-shadow:0 0 0 1px var(--color-background-surface,#181a1d),0 0 0 2px var(--color-focus,#6b9cff)}.cxt-overview-span[data-match=false]{opacity:.16}.cxt-overview-span[data-lane=input]{top:4px;background:var(--cxt-input)}.cxt-overview-span[data-lane=model]{top:19px;background:var(--cxt-model)}.cxt-overview-span[data-lane=tools]{top:34px;background:var(--cxt-tools)}.cxt-overview-span[data-lane=injection]{top:49px;background:var(--cxt-injection)}
.cxt-toolbar{display:flex;align-items:center;gap:4px;min-height:34px;padding:5px 7px;border-bottom:1px solid var(--color-border,rgba(255,255,255,.08));background:var(--color-background-surface,#181a1d);overflow-x:auto}.cxt-search-wrap{display:flex;align-items:center;flex:1 1 180px;min-width:130px;max-width:280px;height:23px;padding:0 7px;border:1px solid var(--color-border,rgba(255,255,255,.1));border-radius:4px;background:var(--color-background-elevated-secondary,rgba(255,255,255,.035));color:var(--color-text-tertiary,#7e8592)}.cxt-search{width:100%;min-width:0;padding:0;border:0;outline:0;color:var(--color-text,#e5e7eb);background:transparent}.cxt-search::placeholder{color:var(--color-text-tertiary,#7e8592)}.cxt-filter{height:23px;max-width:130px;padding:0 5px;border:1px solid var(--color-border,rgba(255,255,255,.1));border-radius:4px;color:var(--color-text-secondary,#aeb4bf);background:var(--color-background-elevated-secondary,#202327)}.cxt-count{margin-left:auto;color:var(--color-text-tertiary,#7e8592);white-space:nowrap;font:10px/1 ui-monospace,SFMono-Regular,Menlo,monospace}
.cxt-split{display:flex;flex:1;min-height:0;overflow:hidden}.cxt-ledger{display:flex;flex-direction:column;flex:1;min-width:0;overflow:hidden}.cxt-history{height:28px;border-bottom:1px solid var(--color-border,rgba(255,255,255,.06))}.cxt-history .cxt-button{width:100%;height:27px;border:0;border-radius:0}.cxt-empty{display:grid;place-items:center;min-height:120px;padding:30px;color:var(--color-text-tertiary,#7e8592);text-align:center}.cxt-table-scroll{flex:1;min-height:0;overflow:auto}.cxt-table{width:100%;border-spacing:0;table-layout:fixed;background:var(--color-background-surface-under,#111315)}.cxt-table th{position:sticky;top:0;z-index:3;height:28px;padding:0 7px;border-bottom:1px solid var(--color-border,rgba(255,255,255,.1));color:var(--color-text-tertiary,#7e8592);background:var(--color-background-surface,#181a1d);font-weight:500;text-align:left;white-space:nowrap}.cxt-table th:nth-child(1){width:50px;text-align:right}.cxt-table th:nth-child(2){width:150px}.cxt-table th:nth-child(3){width:82px}.cxt-table td{height:30px;padding:0 7px;border-bottom:1px solid var(--color-border,rgba(255,255,255,.045));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cxt-row{outline:0;cursor:default}.cxt-row:hover{background:var(--color-background-elevated-secondary,rgba(255,255,255,.045))}.cxt-row:focus-visible{box-shadow:inset 0 0 0 1px var(--color-focus,#6b9cff)}.cxt-row[data-selected=true]{background:var(--color-background-elevated-secondary,rgba(107,156,255,.11))}.cxt-row[data-error=true]{box-shadow:inset 2px 0 0 var(--color-error,#e06c75)}.cxt-seq{text-align:right;color:var(--color-text-tertiary,#7e8592);font:10px/1 ui-monospace,SFMono-Regular,Menlo,monospace}.cxt-event-cell{display:flex;align-items:center;gap:5px;min-width:0}.cxt-lane-tag{display:inline-flex;flex:none;align-items:center;height:18px;padding:0 5px;border:1px solid currentColor;border-radius:4px;font:9px/16px ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.04em}.cxt-lane-tag[data-lane=input]{color:var(--cxt-input)}.cxt-lane-tag[data-lane=model]{color:var(--cxt-model)}.cxt-lane-tag[data-lane=tools]{color:var(--cxt-tools)}.cxt-lane-tag[data-lane=injection]{color:var(--cxt-injection)}.cxt-event-type{overflow:hidden;text-overflow:ellipsis;color:var(--color-text-secondary,#b3bac5)}.cxt-phase{color:var(--color-text-tertiary,#7e8592);font:10px/1 ui-monospace,SFMono-Regular,Menlo,monospace}.cxt-phase[data-phase=failed]{color:var(--color-error,#e06c75)}.cxt-phase[data-phase=queued],.cxt-phase[data-phase=permission]{color:var(--cxt-tools)}.cxt-summary{color:var(--color-text,#e5e7eb)}.cxt-truth{margin-left:6px;color:var(--color-text-tertiary,#7e8592);font:9px/1 ui-monospace,SFMono-Regular,Menlo,monospace}.cxt-group td{position:relative;height:26px;padding:0 8px;border-bottom:1px solid var(--color-border,rgba(255,255,255,.07));background:var(--color-background-surface,#181a1d);color:var(--color-text-secondary,#aeb4bf);font:10px/1 ui-monospace,SFMono-Regular,Menlo,monospace}.cxt-group[data-kind=turn] td{border-top:2px solid var(--color-border,rgba(255,255,255,.12));font-weight:600}.cxt-group[data-kind=step] td{height:20px;padding-left:22px;background:var(--color-background-surface-under,#111315);color:var(--color-text-tertiary,#7e8592)}
.cxt-detail{display:flex;flex:0 0 clamp(280px,31%,390px);flex-direction:column;min-width:0;overflow:hidden;border-left:1px solid var(--color-border,rgba(255,255,255,.09));background:var(--color-background-surface,#181a1d)}.cxt-detail-head{display:flex;align-items:center;min-height:34px;padding:0 10px;border-bottom:1px solid var(--color-border,rgba(255,255,255,.08));font-weight:600}.cxt-detail-scroll{flex:1;min-height:0;overflow:auto;padding:10px}.cxt-detail-empty{color:var(--color-text-tertiary,#7e8592)}.cxt-detail-title{margin:0 0 10px;font-size:13px;font-weight:600}.cxt-detail dl{display:grid;grid-template-columns:96px minmax(0,1fr);margin:0;gap:0}.cxt-detail dt,.cxt-detail dd{min-height:25px;margin:0;padding:4px 0;border-bottom:1px solid var(--color-border,rgba(255,255,255,.05))}.cxt-detail dt{color:var(--color-text-tertiary,#7e8592)}.cxt-detail dd{overflow-wrap:anywhere;color:var(--color-text-secondary,#b8bec8);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.cxt-payload{margin:10px 0 0;padding:9px;overflow:auto;border:1px solid var(--color-border,rgba(255,255,255,.08));border-radius:4px;background:var(--color-background-surface-under,#111315);color:var(--color-text-secondary,#b8bec8);font:10px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap}.cxt-detail-actions{display:flex;margin-top:10px}
@media(max-width:820px){.cxt-detail{flex-basis:260px}.cxt-table th:nth-child(2){width:112px}.cxt-table th:nth-child(3){width:70px}.cxt-truth{display:none}}@media(max-width:650px){.cxt-detail{display:none}.cxt-lane-labels{display:none}.cxt-overview-grid{grid-template-columns:1fr}.cxt-filter:nth-of-type(n+4){display:none}}
`

function create<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function formatClock(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
  }).format(new Date(value))
}

function option(select: HTMLSelectElement, value: string, label: string): void {
  const item = select.ownerDocument.createElement('option')
  item.value = value
  item.textContent = label
  select.append(item)
}

function syncOptions(
  select: HTMLSelectElement,
  values: readonly string[],
  allLabel: string,
): void {
  const current = select.value || 'all'
  select.replaceChildren()
  option(select, 'all', allLabel)
  for (const value of values) option(select, value, value)
  select.value = values.includes(current) || current === 'all' ? current : 'all'
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return '[unserializable payload]'
  }
}

function addDetail(document: Document, list: HTMLDListElement, label: string, value: unknown): void {
  if (value === undefined) return
  list.append(create(document, 'dt', undefined, label), create(document, 'dd', undefined, String(value)))
}

function latestQueued(snapshot: TraceSnapshot, requestId: string | undefined): boolean {
  if (requestId === undefined) return false
  return [...snapshot.events].reverse().find(event => event.requestId === requestId)?.phase === 'queued'
}

export function mountTraceShowcase(
  context: CordisXPageMountContext,
  store: TraceShowcaseStore,
): () => void {
  const { document } = context
  const cleanup: Array<() => void> = []
  const root = create(document, 'div', 'cxt-root')
  root.dataset.agentTraceShowcase = 'true'
  const style = create(document, 'style')
  style.textContent = STYLES
  const integrity = create(document, 'div', 'cxt-integrity')
  const demos = create(document, 'div', 'cxt-demos')
  const overview = create(document, 'section', 'cxt-overview')
  const toolbar = create(document, 'div', 'cxt-toolbar')
  toolbar.setAttribute('role', 'toolbar')
  toolbar.setAttribute('aria-label', 'Timeline filters')
  const split = create(document, 'div', 'cxt-split')
  const ledger = create(document, 'section', 'cxt-ledger')
  const history = create(document, 'div', 'cxt-history')
  const tableScroll = create(document, 'div', 'cxt-table-scroll')
  const detail = create(document, 'aside', 'cxt-detail')
  detail.append(create(document, 'div', 'cxt-detail-head', 'Event detail'))
  const detailScroll = create(document, 'div', 'cxt-detail-scroll')
  detail.append(detailScroll)
  ledger.append(history, tableScroll)
  split.append(ledger, detail)
  root.append(style, integrity, demos, overview, toolbar, split)
  context.container.append(root)

  let snapshot = store.getSnapshot()
  let selectedId: string | undefined
  let order: TraceOrder = 'sequence'
  const filters: {
    search: string
    lane: TraceFilters['lane']
    truth: TraceFilters['truth']
    source: TraceFilters['source']
    type: TraceFilters['type']
    phase: TraceFilters['phase']
  } = { ...EMPTY_FILTERS }

  const overviewHead = create(document, 'div', 'cxt-overview-head')
  overviewHead.append(create(document, 'strong', 'cxt-overview-title', 'Overview'))
  const overviewModes = create(document, 'div', 'cxt-overview-modes')
  const overviewGrid = create(document, 'div', 'cxt-overview-grid')
  const laneLabels = create(document, 'div', 'cxt-lane-labels')
  for (const lane of LANES) laneLabels.append(create(document, 'span', undefined, lane === 'injection' ? 'Inject' : `${lane[0]!.toUpperCase()}${lane.slice(1)}`))
  const overviewTrack = create(document, 'div', 'cxt-overview-track')
  overviewGrid.append(laneLabels, overviewTrack)
  overview.append(overviewHead, overviewGrid)

  const renderData = (): void => {
    const filtered = filterTraceEvents(snapshot.events, filters)
    const ordered = orderTraceEvents(filtered, order)
    const rendered = ordered.slice(-snapshot.range.renderedLimit)
    const renderedIds = new Set(rendered.map(event => event.id))

    integrity.replaceChildren()
    const badge = create(document, 'span', 'cxt-badge', snapshot.status.mode)
    badge.dataset.mode = snapshot.status.mode
    const loaded = `${snapshot.range.loaded}${snapshot.range.totalAvailable === undefined ? '' : `/${snapshot.range.totalAvailable}`}`
    const fact = create(document, 'span', 'cxt-integrity-copy')
    fact.append(
      create(document, 'strong', undefined, snapshot.status.completeness),
      document.createTextNode(` · loaded ${loaded} · ${snapshot.status.payloadPolicy} payloads · `),
      document.createTextNode(snapshot.status.contractVersion === undefined ? 'core contract pending' : `contract ${snapshot.status.contractVersion}`),
    )
    integrity.append(badge, fact)
    integrity.title = snapshot.status.diagnostics.join('\n')

    overviewTrack.replaceChildren()
    const overviewEvents = orderTraceEvents(snapshot.events, order)
    for (const span of deriveOverview(overviewEvents, order)) {
      const node = create(document, 'button', 'cxt-overview-span')
      node.type = 'button'
      node.style.left = `${span.left}%`
      node.style.width = `${span.width}%`
      node.dataset.lane = span.event.lane
      node.dataset.selected = String(selectedId === span.event.id)
      node.dataset.match = String(renderedIds.has(span.event.id))
      node.setAttribute('aria-label', `Event ${span.event.seq}: ${span.event.summary}`)
      node.title = `${span.event.type} · ${span.event.semanticType} · ${formatClock(span.event.recordedAt)}`
      node.addEventListener('click', () => { selectedId = span.event.id; renderData() }, { once: true })
      overviewTrack.append(node)
    }

    history.replaceChildren()
    if (snapshot.hasEarlier || snapshot.loadingEarlier) {
      const load = create(document, 'button', 'cxt-button', snapshot.loadingEarlier ? 'Loading earlier events…' : 'Load earlier events')
      load.type = 'button'
      load.disabled = snapshot.loadingEarlier
      load.addEventListener('click', () => { void store.loadEarlier() }, { once: true })
      history.append(load)
    } else {
      history.hidden = true
    }
    history.hidden = !(snapshot.hasEarlier || snapshot.loadingEarlier)

    tableScroll.replaceChildren()
    if (snapshot.status.completeness === 'unavailable') {
      const empty = create(document, 'div', 'cxt-empty')
      empty.textContent = 'Live Agent events are unavailable. This plugin will not inspect a raw bridge or private adapter store.'
      tableScroll.append(empty)
    } else if (rendered.length === 0) {
      tableScroll.append(create(document, 'div', 'cxt-empty', snapshot.events.length === 0 ? 'No events in the loaded session window.' : 'No loaded events match these filters.'))
    } else {
      const table = create(document, 'table', 'cxt-table')
      const head = document.createElement('thead')
      const headRow = document.createElement('tr')
      for (const label of ['Seq', 'Event', 'Phase', 'Content']) headRow.append(create(document, 'th', undefined, label))
      head.append(headRow)
      const body = document.createElement('tbody')
      for (const turn of groupTraceEvents(rendered)) {
        const turnRow = create(document, 'tr', 'cxt-group')
        turnRow.dataset.kind = 'turn'
        const turnCell = create(document, 'td', undefined, turn.turnNumber !== undefined
          ? `Turn ${turn.turnNumber}`
          : turn.turnId === undefined ? 'Between turns' : `Turn ${turn.turnId}`)
        turnCell.colSpan = 4
        turnRow.append(turnCell)
        body.append(turnRow)
        for (const step of turn.steps) {
          const stepRow = create(document, 'tr', 'cxt-group')
          stepRow.dataset.kind = 'step'
          const stepCell = create(document, 'td', undefined, step.stepNumber !== undefined
            ? `Step ${step.stepNumber}`
            : step.stepId === undefined ? 'Unscoped' : `Step ${step.stepId}`)
          stepCell.colSpan = 4
          stepRow.append(stepCell)
          body.append(stepRow)
          for (const event of step.events) {
            const row = create(document, 'tr', 'cxt-row')
            row.tabIndex = 0
            row.dataset.eventId = event.id
            row.dataset.selected = String(event.id === selectedId)
            row.dataset.error = String(event.phase === 'failed')
            row.setAttribute('aria-selected', String(event.id === selectedId))
            const seq = create(document, 'td', 'cxt-seq', String(event.seq))
            const eventCell = create(document, 'td')
            const eventInner = create(document, 'div', 'cxt-event-cell')
            const lane = create(document, 'span', 'cxt-lane-tag', event.lane === 'injection' ? 'inject' : event.lane)
            lane.dataset.lane = event.lane
            eventInner.append(lane, create(document, 'span', 'cxt-event-type', event.semanticType))
            eventCell.append(eventInner)
            const phase = create(document, 'td', 'cxt-phase', event.phase ?? '—')
            if (event.phase !== undefined) phase.dataset.phase = event.phase
            const summary = create(document, 'td', 'cxt-summary')
            summary.append(document.createTextNode(event.summary), create(document, 'span', 'cxt-truth', event.truth))
            const select = (): void => { selectedId = event.id; renderData() }
            row.addEventListener('click', select, { once: true })
            row.addEventListener('keydown', keyEvent => {
              if (keyEvent.key !== 'Enter' && keyEvent.key !== ' ') return
              keyEvent.preventDefault()
              select()
            }, { once: true })
            row.append(seq, eventCell, phase, summary)
            body.append(row)
          }
        }
      }
      table.append(head, body)
      tableScroll.append(table)
    }

    detailScroll.replaceChildren()
    const selected = selectedId === undefined ? undefined : snapshot.events.find(event => event.id === selectedId)
    if (selected === undefined) {
      detailScroll.append(create(document, 'p', 'cxt-detail-empty', 'Select a ledger record or Overview span to inspect source, permission, timing, and payload facts.'))
    } else {
      detailScroll.append(create(document, 'h3', 'cxt-detail-title', selected.summary))
      const list = create(document, 'dl')
      addDetail(document, list, 'Event id', selected.id)
      addDetail(document, list, 'Sequence', selected.seq)
      addDetail(document, list, 'Recorded', formatClock(selected.recordedAt))
      addDetail(document, list, 'Lane', selected.lane)
      addDetail(document, list, 'Event type', selected.type)
      addDetail(document, list, 'Semantic', selected.semanticType)
      addDetail(document, list, 'Truth', selected.truth)
      addDetail(document, list, 'Phase', selected.phase)
      addDetail(document, list, 'Session', selected.sessionId)
      addDetail(document, list, 'Turn', selected.turnId)
      addDetail(document, list, 'Step', selected.stepId)
      addDetail(document, list, 'Item', selected.itemId)
      addDetail(document, list, 'Message', selected.messageId)
      addDetail(document, list, 'Tool call', selected.toolCallId)
      addDetail(document, list, 'Context', selected.contextId)
      addDetail(document, list, 'Parent', selected.parentId)
      addDetail(document, list, 'Request', selected.requestId)
      addDetail(document, list, 'Source', `${selected.source.kind}:${selected.source.id}`)
      addDetail(document, list, 'Plugin source', selected.plugin?.source)
      addDetail(document, list, 'Plugin', selected.plugin === undefined
        ? undefined
        : `${selected.plugin.id}@${selected.plugin.version ?? 'unversioned'}`)
      addDetail(document, list, 'Generation', selected.plugin?.generation)
      addDetail(document, list, 'Capability', selected.permission?.capability)
      addDetail(document, list, 'Permission', selected.permission === undefined ? undefined : `${selected.permission.policy} → ${selected.permission.outcome}`)
      addDetail(document, list, 'Consumption', selected.modelConsumption)
      addDetail(document, list, 'Duration', selected.timing?.durationMs === undefined ? undefined : `${selected.timing.durationMs} ms`)
      detailScroll.append(list)
      if (selected.payload !== undefined) detailScroll.append(create(document, 'pre', 'cxt-payload', stringify(selected.payload)))
      if (latestQueued(snapshot, selected.requestId)) {
        const actions = create(document, 'div', 'cxt-detail-actions')
        const cancel = create(document, 'button', 'cxt-button', 'Cancel queued contribution')
        cancel.type = 'button'
        cancel.addEventListener('click', () => { void store.cancelQueued(selected.requestId!) }, { once: true })
        actions.append(cancel)
        detailScroll.append(actions)
      }
    }

    const count = toolbar.querySelector<HTMLElement>('.cxt-count')
    if (count !== null) count.textContent = `${rendered.length}/${snapshot.events.length} loaded · limit ${snapshot.range.renderedLimit}`
    syncOptions(sourceFilter, [...new Set(snapshot.events.flatMap(event => [event.source.id, ...(event.plugin === undefined ? [] : [event.plugin.source])]))].sort(), 'All sources')
    syncOptions(typeFilter, [...new Set(snapshot.events.map(event => event.type))].sort(), 'All types')
    sourceFilter.value = filters.source
    typeFilter.value = filters.type
  }

  for (const mode of ['sequence', 'time'] as const) {
    const button = create(document, 'button', 'cxt-button', mode === 'sequence' ? 'Sequence' : 'Time')
    button.type = 'button'
    button.dataset.active = String(order === mode)
    button.setAttribute('aria-pressed', String(order === mode))
    button.addEventListener('click', () => {
      order = mode
      for (const item of overviewModes.querySelectorAll<HTMLButtonElement>('button')) {
        item.dataset.active = String(item === button)
        item.setAttribute('aria-pressed', String(item === button))
      }
      renderData()
    })
    overviewModes.append(button)
  }
  overviewHead.append(overviewModes)

  demos.append(create(document, 'span', 'cxt-demos-label', 'Explicit demo actions'))
  for (const demo of DEMOS) {
    const button = create(document, 'button', 'cxt-button', demo.label)
    button.type = 'button'
    button.dataset.demoKind = demo.kind
    button.disabled = !snapshot.status.supportedOperations.includes(demo.kind)
    button.title = snapshot.status.mode === 'fixture'
      ? 'Creates source-attributed fixture events only'
      : 'Explicitly invokes the public Agent API through the Permission Broker'
    button.addEventListener('click', () => {
      button.disabled = true
      void store.requestDemo({ kind: demo.kind }).finally(() => {
        button.disabled = !store.getSnapshot().status.supportedOperations.includes(demo.kind)
      })
    })
    demos.append(button)
  }
  const clear = create(document, 'button', 'cxt-button cxt-clear', 'Clear queued')
  clear.type = 'button'
  clear.disabled = snapshot.status.supportedOperations.length === 0
  clear.addEventListener('click', () => { void store.clearQueued() })
  demos.append(clear)

  const searchWrap = create(document, 'label', 'cxt-search-wrap')
  searchWrap.append(document.createTextNode('⌕'))
  const search = create(document, 'input', 'cxt-search')
  search.type = 'search'
  search.placeholder = 'Search loaded events'
  search.setAttribute('aria-label', 'Search loaded events')
  search.addEventListener('input', () => { filters.search = search.value; renderData() })
  searchWrap.append(search)
  toolbar.append(searchWrap)

  const laneFilter = create(document, 'select', 'cxt-filter')
  syncOptions(laneFilter, LANES, 'All lanes')
  laneFilter.setAttribute('aria-label', 'Filter by lane')
  laneFilter.addEventListener('change', () => { filters.lane = laneFilter.value as TraceFilters['lane']; renderData() })
  const truthFilter = create(document, 'select', 'cxt-filter')
  syncOptions(truthFilter, TRUTHS, 'All truth')
  truthFilter.setAttribute('aria-label', 'Filter by truth source')
  truthFilter.addEventListener('change', () => { filters.truth = truthFilter.value as TraceFilters['truth']; renderData() })
  const sourceFilter = create(document, 'select', 'cxt-filter')
  sourceFilter.setAttribute('aria-label', 'Filter by source')
  sourceFilter.addEventListener('change', () => { filters.source = sourceFilter.value as TraceFilters['source']; renderData() })
  const typeFilter = create(document, 'select', 'cxt-filter')
  typeFilter.setAttribute('aria-label', 'Filter by type')
  typeFilter.addEventListener('change', () => { filters.type = typeFilter.value as TraceFilters['type']; renderData() })
  const phaseFilter = create(document, 'select', 'cxt-filter')
  syncOptions(phaseFilter, PHASES, 'All phases')
  phaseFilter.setAttribute('aria-label', 'Filter by lifecycle phase')
  phaseFilter.addEventListener('change', () => { filters.phase = phaseFilter.value as TraceFilters['phase']; renderData() })
  toolbar.append(laneFilter, truthFilter, sourceFilter, typeFilter, phaseFilter, create(document, 'span', 'cxt-count'))

  cleanup.push(store.subscribe(() => {
    snapshot = store.getSnapshot()
    for (const button of demos.querySelectorAll<HTMLButtonElement>('[data-demo-kind]')) {
      button.disabled = !snapshot.status.supportedOperations.includes(button.dataset.demoKind as TraceDemoKind)
    }
    clear.disabled = snapshot.status.supportedOperations.length === 0
    renderData()
  }))
  const abort = (): void => { for (const dispose of cleanup.splice(0).reverse()) dispose(); root.remove() }
  context.signal.addEventListener('abort', abort, { once: true })
  cleanup.push(() => context.signal.removeEventListener('abort', abort))
  renderData()
  queueMicrotask(() => { tableScroll.scrollTop = tableScroll.scrollHeight })
  return abort
}
