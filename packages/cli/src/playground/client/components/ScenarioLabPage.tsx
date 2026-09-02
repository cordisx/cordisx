import { useEffect, useMemo, useRef, useState } from 'react'
import { Select } from 'tdesign-react'
import type { PlaygroundAgentSessionProjection, PlaygroundAgentSessionTask } from '../../../renderer/playground-agent-session-projection.js'

type EventKind = 'agent-reply' | 'approval-request' | 'tool-call' | 'task-delegation'

const eventInput: Record<EventKind, (text: string) => string> = {
  'agent-reply': text => text,
  'approval-request': text => `[approval] ${text}`,
  'tool-call': text => `[tool] ${text}`,
  'task-delegation': text => `[delegation] ${text}`,
}

const SCENARIO_OPERATION_AUTHORITY = Symbol.for('cordisx.playground.scenario-operation-authority/v1')

function nextScenarioOperation(scope: string): number {
  const global = globalThis as typeof globalThis & { [SCENARIO_OPERATION_AUTHORITY]?: Map<string, number> }
  const operations = global[SCENARIO_OPERATION_AUTHORITY] ?? new Map<string, number>()
  if (global[SCENARIO_OPERATION_AUTHORITY] === undefined) Object.defineProperty(global, SCENARIO_OPERATION_AUTHORITY, { value: operations })
  const next = (operations.get(scope) ?? 0) + 1
  operations.set(scope, next)
  return next
}

export function SimulatorTaskScenarioWorkbench({
  locale, task, tasks, control, onChanged,
}: {
  readonly locale: 'zh-CN' | 'en'
  readonly task: PlaygroundAgentSessionTask
  readonly tasks: readonly PlaygroundAgentSessionTask[]
  readonly control: PlaygroundAgentSessionProjection
  readonly onChanged: () => void
}) {
  const en = locale === 'en'
  const [kind, setKind] = useState<EventKind>('agent-reply')
  const [text, setText] = useState(en ? 'A deterministic SessionEvent reply.' : '一条确定性的 SessionEvent 回复。')
  const [busy, setBusy] = useState(false)
  const [paused, setPaused] = useState(false)
  const [scenarioCursor, setScenarioCursor] = useState(0)
  const [delegationTarget, setDelegationTarget] = useState('')
  const [highWater, setHighWater] = useState(() => task.events.at(-1)?.seq ?? -1)
  const operation = useRef(0)
  const [error, setError] = useState<string>()
  const options = useMemo(() => [
    { value: 'agent-reply', label: en ? 'Agent reply' : 'Agent 回复' },
    { value: 'approval-request', label: en ? 'Approval request' : '请求批准' },
    { value: 'tool-call', label: en ? 'Tool call' : '工具调用' },
    { value: 'task-delegation', label: en ? 'Task delegation' : '任务委派' },
  ], [en])
  const delegationTargets = useMemo(() => tasks.filter(candidate => candidate.sessionId !== task.sessionId).map(candidate => ({ value: candidate.sessionId, label: `${candidate.sessionId} · ${candidate.owner}` })), [task.sessionId, tasks])
  useEffect(() => {
    if (delegationTargets.some(target => target.value === delegationTarget)) return
    setDelegationTarget(delegationTargets[0]?.value ?? '')
  }, [delegationTarget, delegationTargets])
  useEffect(() => { setHighWater(previous => Math.max(previous, task.events.at(-1)?.seq ?? -1)) }, [task.events])
  const submit = async () => {
    if (busy || paused || text.trim() === '') return
    const ordinal = nextScenarioOperation(task.sessionId)
    operation.current = ordinal
    setBusy(true); setError(undefined)
    try {
      if (kind === 'task-delegation') {
        if (delegationTarget === '') throw new Error(en ? 'Select an exact target session first.' : '请先选择精确的目标会话。')
        await control.submit(delegationTarget, eventInput[kind](`${text}\nsource-session:${task.sessionId}`))
      } else await control.submit(task.sessionId, eventInput[kind](text))
      if (operation.current === ordinal) { setScenarioCursor(cursor => cursor + 1); onChanged() }
    } catch (cause) { if (operation.current === ordinal) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (operation.current === ordinal) setBusy(false) }
  }
  const next = () => { setText(en ? `Scenario step ${scenarioCursor + 1}` : `场景步骤 ${scenarioCursor + 1}`); setScenarioCursor(cursor => cursor + 1) }
  const reset = () => { operation.current = nextScenarioOperation(task.sessionId); setPaused(false); setScenarioCursor(0); setError(undefined); setHighWater(task.events.at(-1)?.seq ?? -1) }
  return <section className="pg-scenario-workbench" data-playground-scenario-workbench>
    <header><div><span className="pg-simulator-badge">Agent / Session Runtime</span><h2>{en ? 'Event Composer' : '事件编辑器'}</h2><p>{en ? `SessionEvent high-water: ${highWater}` : `SessionEvent 高水位：${highWater}`}</p></div><div className="pg-scenario-actions"><button type="button" onClick={() => setPaused(value => !value)}>{paused ? (en ? 'Run' : '运行') : (en ? 'Pause' : '暂停')}</button><button type="button" onClick={next}>{en ? 'Next' : '下一步'}</button><button type="button" onClick={reset}>{en ? 'Reset scenario' : '重置场景'}</button></div></header>
    <form className="pg-event-composer" onSubmit={event => { event.preventDefault(); void submit() }}>
      <Select value={kind} options={options} aria-label={en ? 'Event type' : '事件类型'} onChange={value => {
        if (value === 'agent-reply' || value === 'approval-request' || value === 'tool-call' || value === 'task-delegation') setKind(value)
      }} />
      {kind === 'task-delegation' ? <Select value={delegationTarget} options={delegationTargets} disabled={delegationTargets.length === 0} aria-label={en ? 'Delegation target session' : '委派目标会话'} onChange={value => { if (typeof value === 'string' && delegationTargets.some(target => target.value === value)) setDelegationTarget(value) }} /> : null}
      <textarea rows={2} value={text} onChange={event => setText(event.currentTarget.value)} aria-label={en ? 'Event message' : '事件消息'} />
      <button type="submit" disabled={busy || paused || text.trim() === '' || kind === 'task-delegation' && delegationTarget === ''}>{busy ? (en ? 'Sending…' : '发送中…') : kind === 'task-delegation' ? (en ? 'Delegate' : '委派') : (en ? 'Send event' : '发送事件')}</button>
    </form>
    {error === undefined ? null : <p className="pg-scenario-error" role="alert">{error}</p>}
    <ol className="pg-event-timeline" aria-label={en ? 'Ordered SessionEvent ledger' : '有序 SessionEvent 账本'}>
      {task.events.map(event => <li key={event.seq}><strong>{event.seq} · {event.type}</strong><pre>{JSON.stringify(event.data, null, 2)}</pre></li>)}
    </ol>
  </section>
}

export function ScenarioLabPage({ locale, tasks, control, onOpenTask, onClose }: {
  readonly locale: 'zh-CN' | 'en'
  readonly tasks: readonly PlaygroundAgentSessionTask[]
  readonly control: PlaygroundAgentSessionProjection
  readonly onOpenTask: (sessionId: string) => void
  readonly onClose: () => void
}) {
  const en = locale === 'en'
  const [text, setText] = useState(en ? 'Start a deterministic Playground session.' : '启动一个确定性的 Playground 会话。')
  const [busy, setBusy] = useState(false)
  const create = async () => { if (busy || text.trim() === '') return; setBusy(true); try { await control.create(text); } finally { setBusy(false) } }
  return <main className="pg-scenario-lab" data-playground-scenario-lab>
    <header><div><span className="pg-simulator-badge">Developer · Disposable</span><h1>{en ? 'Chatroom interaction scenarios' : 'Chatroom 交互场景'}</h1><p>{en ? 'A Host-only projection of the active Agent/Session Runtime.' : '活动 Agent/Session Runtime 的仅 Host 投影。'}</p></div><button type="button" className="pg-scenario-secondary" onClick={onClose}>{en ? 'Close' : '关闭'}</button></header>
    <section className="pg-scenario-controls"><label>{en ? 'New session message' : '新会话消息'}<textarea rows={2} value={text} onChange={event => setText(event.currentTarget.value)} /></label><button type="button" onClick={() => { void create() }} disabled={busy || text.trim() === ''}>{en ? 'Create session' : '创建会话'}</button></section>
    <section className="pg-scenario-summary"><h2>{en ? 'Recent tasks' : '最近任务'}</h2>{tasks.length === 0 ? <p>{en ? 'No SessionEvent tasks yet.' : '当前还没有 SessionEvent 任务。'}</p> : <ol>{tasks.map(task => <li key={task.sessionId}><button type="button" onClick={() => onOpenTask(task.sessionId)}>{task.sessionId}</button><code>{task.owner} · {task.events.length} events</code></li>)}</ol>}</section>
  </main>
}
