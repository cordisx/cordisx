import type { PlaygroundMockTaskTrace } from '../../../renderer/playground-mock-agent-loop.js'

function JsonValue({ value }: { readonly value: unknown }) {
  return <pre>{JSON.stringify(value ?? null, null, 2)}</pre>
}

export function MockAgentTaskPage({ task, locale }: {
  readonly task: PlaygroundMockTaskTrace
  readonly locale: 'zh-CN' | 'en'
}) {
  const en = locale === 'en'
  return <main
    className="pg-simulator-task-page"
    data-playground-simulator="true"
    data-simulator-task-id={task.debugTaskId}
    aria-labelledby="pg-simulator-task-title"
  >
    <header>
      <span className="pg-simulator-badge">Mock / Simulator</span>
      <h1 id="pg-simulator-task-title">{task.debugTaskId}</h1>
      <p>{task.agentLabel} · {task.identity.agentId} · {task.identity.revision} · {task.status}</p>
    </header>
    <section>
      <h2>{en ? 'Agent identity' : 'Agent 身份'}</h2>
      <JsonValue value={task.identity} />
    </section>
    <section>
      <h2>{en ? 'Ordered definition catalog' : '有序 AgentDefinition catalog'}</h2>
      <JsonValue value={task.catalog} />
    </section>
    <section>
      <h2>{en ? 'Inheritance layers' : '继承层'}</h2>
      <JsonValue value={task.layers} />
    </section>
    <section>
      <h2>{en ? 'Effective prompt and defaults' : 'Effective prompt 与 defaults'}</h2>
      <JsonValue value={task.effective} />
    </section>
    <section>
      <h2>{en ? 'Input' : '输入'}</h2>
      <p className="pg-simulator-input">{task.input ?? (en ? 'No input yet.' : '尚无输入。')}</p>
    </section>
    <section>
      <h2>{en ? 'Structured skill / CLI execution' : '结构化 skill / CLI 执行'}</h2>
      <JsonValue value={task.execution ?? { status: 'not-started' }} />
    </section>
    <section>
      <h2>{en ? 'Lifecycle trace' : 'Lifecycle trace'}</h2>
      <ol className="pg-simulator-events">
        {task.events.map(event => <li key={event.sequence}><strong>{event.type}</strong><span>{event.detail}</span></li>)}
      </ol>
    </section>
  </main>
}
