import type { PlaygroundMockTaskTrace } from '../../../renderer/playground-mock-agent-loop.js'
import { MoreMenu } from '../../../renderer/host-ui/MoreMenu.js'
import type { PlaygroundScenarioLabController } from '../../scenario-lab.js'
import { SimulatorTaskScenarioWorkbench } from './ScenarioLabPage.js'

export function MockAgentTaskNotFoundPage({ taskId, locale, onReturn }: {
  readonly taskId: string
  readonly locale: 'zh-CN' | 'en'
  readonly onReturn: () => void
}) {
  const en = locale === 'en'
  return <main
    className="pg-simulator-task-page pg-simulator-task-not-found"
    data-playground-simulator-not-found="true"
    data-simulator-task-id={taskId}
    aria-labelledby="pg-simulator-task-not-found-title"
  >
    <header>
      <div>
        <span className="pg-simulator-badge">Mock / Simulator</span>
        <h1 id="pg-simulator-task-not-found-title">{en ? 'Simulator task unavailable' : 'Simulator task 不可用'}</h1>
        <p>{en
          ? 'This task is not present in the current disposable Playground session. It may have expired after a reload or reset.'
          : '当前可丢弃的 Playground 会话中已没有此任务；它可能已在刷新或重置后过期。'}</p>
      </div>
    </header>
    <section className="pg-simulator-task-not-found-card" aria-label={en ? 'Unavailable task details' : '不可用任务详情'}>
      <dl>
        <div><dt>{en ? 'Requested task' : '请求的任务'}</dt><dd>{taskId}</dd></div>
        <div><dt>{en ? 'State' : '状态'}</dt><dd>{en ? 'Not found or expired' : '不存在或已过期'}</dd></div>
      </dl>
      <button type="button" onClick={onReturn}>{en ? 'Return to Playground' : '返回 Playground'}</button>
    </section>
  </main>
}

export function MockAgentTaskPage({ task, locale, scenarioController }: {
  readonly task: PlaygroundMockTaskTrace
  readonly locale: 'zh-CN' | 'en'
  readonly scenarioController: PlaygroundScenarioLabController
}) {
  const en = locale === 'en'
  return <main
    className="pg-simulator-task-page"
    data-playground-simulator="true"
    data-simulator-task-id={task.debugTaskId}
    data-simulator-task-ref={task.taskRef}
    aria-labelledby="pg-simulator-task-title"
  >
    <header className="pg-simulator-task-header">
      <div className="pg-simulator-task-identity">
        <span className="pg-simulator-badge">Mock / Simulator</span>
        <h1 id="pg-simulator-task-title">{task.debugTaskId}</h1>
        <p>{task.agentLabel} · {task.identity.agentId} · {task.identity.revision}</p>
      </div>
      <div className="pg-simulator-task-header-actions">
        <span className="pg-simulator-task-status" data-status={task.status}>{task.status}</span>
        <span className="pg-simulator-task-mode">{task.origin === 'agent-session'
          ? 'Agent / Session'
          : task.origin === 'host-session' ? (en ? 'Host snapshot' : 'Host 快照') : (en ? 'Simulator' : '模拟器')}</span>
        <MoreMenu label={en ? 'Task actions' : 'Task 操作'} items={[{
          id: 'reset-debug-generation',
          label: en ? 'Reset simulated session' : '重置模拟会话',
          icon: 'reset-configuration',
          onSelect: () => scenarioController.reset(),
        }]} />
      </div>
    </header>

    <SimulatorTaskScenarioWorkbench task={task} locale={locale} controller={scenarioController} />
  </main>
}
