import { useEffect, useMemo, useState } from 'react'
import { Select } from 'tdesign-react'
import type { PlaygroundAgentSessionProjection, PlaygroundAgentSessionTask } from '../../../renderer/playground-agent-session-projection.js'

type EventKind = 'agent-reply' | 'approval-request' | 'tool-call'

const eventInput: Record<EventKind, (text: string) => string> = {
  'agent-reply': text => text,
  'approval-request': text => `[approval] ${text}`,
  'tool-call': text => `[tool] ${text}`,
}

export function SimulatorTaskScenarioWorkbench({
  locale, task, control, onChanged,
}: {
  readonly locale: 'zh-CN' | 'en'
  readonly task: PlaygroundAgentSessionTask
  readonly control: PlaygroundAgentSessionProjection
  readonly onChanged: () => void
}) {
  const en = locale === 'en'
  const [kind, setKind] = useState<EventKind>('agent-reply')
  const [text, setText] = useState(en ? 'A deterministic SessionEvent reply.' : '一条确定性的 SessionEvent 回复。')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const options = useMemo(() => [
    { value: 'agent-reply', label: en ? 'Agent reply' : 'Agent 回复' },
    { value: 'approval-request', label: en ? 'Approval request' : '请求批准' },
    { value: 'tool-call', label: en ? 'Tool call' : '工具调用' },
  ], [en])
  const submit = async () => {
    if (busy || text.trim() === '') return
    setBusy(true); setError(undefined)
    try { await control.submit(task.sessionId, eventInput[kind](text)); onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  return <section className="pg-scenario-workbench" data-playground-scenario-workbench>
    <header><div><span className="pg-simulator-badge">Agent / Session Runtime</span><h2>{en ? 'Event Composer' : '事件编辑器'}</h2><p>{en ? 'Writes enter the same SessionEvent ledger used by the runtime.' : '写入会进入运行时使用的同一份 SessionEvent 账本。'}</p></div></header>
    <form className="pg-event-composer" onSubmit={event => { event.preventDefault(); void submit() }}>
      <Select value={kind} options={options} aria-label={en ? 'Event type' : '事件类型'} onChange={value => {
        if (value === 'agent-reply' || value === 'approval-request' || value === 'tool-call') setKind(value)
      }} />
      <textarea rows={2} value={text} onChange={event => setText(event.currentTarget.value)} aria-label={en ? 'Event message' : '事件消息'} />
      <button type="submit" disabled={busy || text.trim() === ''}>{busy ? (en ? 'Sending…' : '发送中…') : (en ? 'Send event' : '发送事件')}</button>
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
