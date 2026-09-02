import type { PlaygroundAgentSessionProjection, PlaygroundAgentSessionTask } from '../../../renderer/playground-agent-session-projection.js'
import { SimulatorTaskScenarioWorkbench } from './ScenarioLabPage.js'

export function MockAgentTaskPage({ task, locale, control, onChanged, onReturn }: {
  readonly task: PlaygroundAgentSessionTask
  readonly locale: 'zh-CN' | 'en'
  readonly control: PlaygroundAgentSessionProjection
  readonly onChanged: () => void
  readonly onReturn: () => void
}) {
  const en = locale === 'en'
  return <main className="pg-simulator-task-page" data-playground-simulator data-simulator-task-id={task.sessionId}>
    <header><button type="button" className="pg-scenario-secondary" onClick={onReturn}>{en ? 'Back' : '返回'}</button><span className="pg-simulator-badge">Agent / Session Runtime</span><h1>{task.sessionId}</h1><p>{task.owner} · generation {task.agentGeneration}</p></header>
    <SimulatorTaskScenarioWorkbench locale={locale} task={task} control={control} onChanged={onChanged} />
  </main>
}
