import { useEffect, useState } from 'react'
import {
  PLAYGROUND_SCENARIO_CATALOG,
  PlaygroundScenarioLabController,
  type PlaygroundScenarioId,
  type PlaygroundScenarioLabSnapshot,
} from '../../scenario-lab.js'

export interface ScenarioLabPageProps {
  readonly locale: 'zh-CN' | 'en'
  readonly onClose: () => void
}

export function ScenarioLabPage({ locale, onClose }: ScenarioLabPageProps) {
  const [controller] = useState(() => new PlaygroundScenarioLabController())
  const [snapshot, setSnapshot] = useState<PlaygroundScenarioLabSnapshot>(() => controller.getSnapshot())
  const en = locale === 'en'
  const selected = PLAYGROUND_SCENARIO_CATALOG.find(item => item.id === snapshot.selectedScenarioId)!

  useEffect(() => {
    const update = () => setSnapshot(controller.getSnapshot())
    update()
    const unsubscribe = controller.subscribe(update)
    return () => { unsubscribe(); controller.dispose() }
  }, [controller])

  const unavailable = selected.availability.state === 'unavailable'
  return <main className="pg-scenario-lab" data-playground-scenario-lab data-scenario-owner={snapshot.owner}>
    <header>
      <div>
        <span className="pg-simulator-badge">{en ? 'Developer · Disposable' : '开发 · 可丢弃'}</span>
        <h1>{en ? 'Chatroom interaction scenarios' : 'Chatroom 交互场景'}</h1>
        <p>{en
          ? 'Phase 1 is a Host developer controller and disposable task-trace foundation. It does not claim a complete Conversation Shell scenario.'
          : 'Phase 1 是 Host 开发控制器与可丢弃 task trace 基础，不代表完整 Conversation Shell 场景。'}</p>
      </div>
      <button type="button" className="pg-scenario-secondary" onClick={onClose}>{en ? 'Close' : '关闭'}</button>
    </header>

    <section className="pg-scenario-controls" aria-label={en ? 'Scenario controls' : '场景控制'}>
      <label>
        <span>{en ? 'Scenario' : '场景'}</span>
        <select
          value={snapshot.selectedScenarioId}
          onChange={event => controller.select(event.currentTarget.value as PlaygroundScenarioId)}
        >
          {PLAYGROUND_SCENARIO_CATALOG.map(item => <option key={item.id} value={item.id}>{item.title[locale]}</option>)}
        </select>
      </label>
      <div className="pg-scenario-actions">
        <button type="button" onClick={() => { void controller.run() }} disabled={unavailable || snapshot.phase === 'running'}>{en ? 'Run' : '运行'}</button>
        <button type="button" onClick={() => controller.pause()} disabled={snapshot.phase !== 'running'}>{en ? 'Pause' : '暂停'}</button>
        <button type="button" onClick={() => { void controller.next() }} disabled={unavailable || snapshot.phase === 'running' || snapshot.phase === 'completed'}>{en ? 'Next' : '下一步'}</button>
        <button type="button" onClick={() => controller.reset()}>{en ? 'Reset' : '重置'}</button>
      </div>
    </section>

    <section className="pg-scenario-summary" aria-live="polite">
      <h2>{selected.title[locale]}</h2>
      <p>{selected.description[locale]}</p>
      <p><strong>{en ? 'State' : '状态'}:</strong> {snapshot.phase} · {snapshot.cursor}/{snapshot.stepCount}</p>
      {selected.availability.state === 'unavailable'
        ? <div className="pg-scenario-unavailable" role="status">
            <strong>{selected.availability.code}</strong>
            <span>{selected.availability.needApi}</span>
            <span>{en ? 'No approval controls are simulated.' : '不会伪造允许、拒绝或取消控件。'}</span>
          </div>
        : null}
      {snapshot.error === undefined ? null : <p role="alert">{snapshot.error}</p>}
    </section>

    <div className="pg-scenario-columns">
      <section>
        <h2>{en ? 'Deterministic activity' : '确定性活动'}</h2>
        {snapshot.activities.length === 0
          ? <p>{en ? 'Run or step through this scenario.' : '运行或逐步执行当前场景。'}</p>
          : <ol>{snapshot.activities.map(activity => <li key={activity.sequence} data-scenario-activity={activity.kind}>
              <span>{activity.kind}</span><code>{activity.message}</code>
            </li>)}</ol>}
      </section>
      <section>
        <h2>{en ? 'Disposable agent tasks' : '可丢弃 Agent tasks'}</h2>
        {snapshot.tasks.length === 0
          ? <p>{en ? 'No isolated tasks yet.' : '尚无隔离 task。'}</p>
          : <ul>{snapshot.tasks.map(task => <li key={task.debugTaskId}>
              <strong>{task.agentLabel}</strong>
              <span>{task.identity.agentId} · {task.status}</span>
            </li>)}</ul>}
      </section>
    </div>
  </main>
}
