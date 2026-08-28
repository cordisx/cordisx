export type PlaygroundFixtureMode = 'conversation' | 'empty'

export interface HostSeatsProps {
  readonly mode: PlaygroundFixtureMode
}

function WorkspaceToolbar() {
  return (
    <header className="pg-workspace-toolbar">
      <div className="pg-window-title"><span className="pg-window-status" aria-hidden="true" />Agent Desktop fixture</div>
      <div className="pg-surface-seat pg-workspace-actions" data-cordisx-playground-surface="workspace.toolbar.items" data-pg-seat-label="workspace.toolbar.items">
        <button type="button" className="pg-native-icon-button" data-cordisx-playground-template="workspace.toolbar" aria-label="Workspace menu">•••</button>
      </div>
    </header>
  )
}

function SessionHeader() {
  return (
    <header className="pg-session-header">
      <div className="pg-session-title">
        <strong>调试插件组合</strong>
        <span>本地 fixture · 不连接 Codex</span>
      </div>
      <div className="pg-surface-seat pg-session-actions" data-cordisx-playground-surface="session.header.actions" data-pg-seat-label="session.header.actions">
        <button type="button" className="pg-native-icon-button" data-cordisx-playground-template="session.header" aria-label="Session menu">•••</button>
      </div>
    </header>
  )
}

function Conversation() {
  return (
    <>
      <SessionHeader />
      <section className="pg-timeline" data-cordisx-playground-seat="session.content" aria-label="Fixture conversation">
        <article className="pg-message pg-message-user"><div>请展示这个插件在 Agent Desktop 中的真实位置。</div></article>
        <article className="pg-message pg-message-agent">
          <span className="pg-agent-avatar" aria-hidden="true">Cx</span>
          <div><p>Playground 已挂载正式 route、page 和 structured surface contribution。</p><p>你可以从左侧插件导航、会话页头和下方 composer 检查插件效果。</p></div>
        </article>
      </section>
      <div className="pg-composer-wrap">
        <div className="pg-surface-seat pg-composer-dock" data-cordisx-playground-surface="composer.dock.above" data-pg-seat-label="composer.dock.above" />
        <div className="pg-composer">
          <textarea aria-label="Fixture composer" placeholder="继续调试这个插件…" rows={2} />
          <div className="pg-composer-footer">
            <div className="pg-surface-seat pg-composer-actions" data-cordisx-playground-surface="composer.toolbar.items" data-pg-seat-label="composer.toolbar.items">
              <button type="button" className="pg-native-icon-button" data-cordisx-playground-template="composer.toolbar" aria-label="Attach fixture">＋</button>
            </div>
            <label className="pg-reasoning"><span>推理</span><input data-cordisx-playground-reasoning type="range" min="0" max="4" defaultValue="2" aria-label="Fixture reasoning intensity" /></label>
            <button type="button" className="pg-send" aria-label="Send fixture message">↑</button>
          </div>
        </div>
        <div className="pg-surface-seat pg-composer-dock" data-cordisx-playground-surface="composer.dock.below" data-pg-seat-label="composer.dock.below" />
      </div>
    </>
  )
}

function EmptySession() {
  return (
    <section className="pg-empty-session" data-cordisx-playground-seat="session.content">
      <span className="pg-empty-mark" aria-hidden="true">Cx</span>
      <h1>开始一个插件调试会话</h1>
      <p>当前 fixture 没有活动会话；会话页头与 composer 插槽应保持未挂载。</p>
      <div className="pg-empty-prompts"><button type="button">检查页面路由</button><button type="button">查看插件状态</button></div>
    </section>
  )
}

export function HostSeats({ mode }: HostSeatsProps) {
  return (
    <main className="pg-main" {...(mode === 'conversation' ? { 'data-cordisx-playground-session-id': 'fixture-session' } : {})}>
      <WorkspaceToolbar />
      <div className="pg-page-seat pg-app-seat" data-cordisx-playground-seat="app" />
      <div className="pg-page-seat pg-main-seat" data-cordisx-playground-seat="main" />
      <div className="pg-conversation-shell">
        {mode === 'conversation' ? <Conversation /> : <EmptySession />}
      </div>
    </main>
  )
}
