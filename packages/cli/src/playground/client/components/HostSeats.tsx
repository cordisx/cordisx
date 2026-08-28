export type PlaygroundFixtureMode = 'conversation' | 'empty'

export interface HostSeatsProps {
  readonly mode: PlaygroundFixtureMode
  readonly locale: 'zh-CN' | 'en'
}

function SessionHeader({ locale }: Pick<HostSeatsProps, 'locale'>) {
  const en = locale === 'en'
  return (
    <header className="pg-session-header">
      <div className="pg-session-title">
        <strong>{en ? 'Plugin composition' : '调试插件组合'}</strong>
        <span>{en ? 'Local fixture · Codex disconnected' : '本地 fixture · 不连接 Codex'}</span>
      </div>
      <div className="pg-surface-seat pg-session-actions" data-cordisx-playground-surface="session.header.actions" data-pg-seat-label="session.header.actions">
        <button type="button" className="pg-native-icon-button" data-cordisx-playground-template="session.header" aria-label="Session menu">•••</button>
      </div>
    </header>
  )
}

function Conversation({ locale }: Pick<HostSeatsProps, 'locale'>) {
  const en = locale === 'en'
  return (
    <>
      <SessionHeader locale={locale} />
      <section className="pg-timeline" data-cordisx-playground-seat="session.content" aria-label={en ? 'Fixture conversation' : 'Fixture 会话'}>
        <article className="pg-message pg-message-user"><div>{en ? 'Show the real position of this plugin in the Agent Desktop.' : '请展示这个插件在 Agent Desktop 中的真实位置。'}</div></article>
        <article className="pg-message pg-message-agent">
          <span className="pg-agent-avatar" aria-hidden="true">Cx</span>
          <div><p>{en ? 'The Playground mounted the formal route, page, and structured surface contributions.' : 'Playground 已挂载正式 route、page 和 structured surface contribution。'}</p><p>{en ? 'Inspect the plugin in navigation, the session header, and the composer below.' : '你可以从左侧插件导航、会话页头和下方 composer 检查插件效果。'}</p></div>
        </article>
      </section>
      <div className="pg-composer-wrap">
        <div className="pg-surface-seat pg-composer-dock" data-cordisx-playground-surface="composer.dock.above" data-pg-seat-label="composer.dock.above" />
        <div className="pg-composer">
          <textarea aria-label="Fixture composer" placeholder={en ? 'Continue debugging this plugin…' : '继续调试这个插件…'} rows={2} />
          <div className="pg-composer-footer">
            <div className="pg-surface-seat pg-composer-actions" data-cordisx-playground-surface="composer.toolbar.items" data-pg-seat-label="composer.toolbar.items">
              <button type="button" className="pg-native-icon-button" data-cordisx-playground-template="composer.toolbar" aria-label="Attach fixture">＋</button>
            </div>
            <label className="pg-reasoning"><span>{en ? 'Reasoning' : '推理'}</span><input data-cordisx-playground-reasoning type="range" min="0" max="4" defaultValue="2" aria-label="Fixture reasoning intensity" /></label>
            <button type="button" className="pg-send" aria-label="Send fixture message">↑</button>
          </div>
        </div>
        <div className="pg-surface-seat pg-composer-dock" data-cordisx-playground-surface="composer.dock.below" data-pg-seat-label="composer.dock.below" />
      </div>
    </>
  )
}

function EmptySession({ locale }: Pick<HostSeatsProps, 'locale'>) {
  const en = locale === 'en'
  return (
    <section className="pg-empty-session" data-cordisx-playground-seat="session.content">
      <span className="pg-empty-mark" aria-hidden="true">Cx</span>
      <h1>{en ? 'Start a plugin debug session' : '开始一个插件调试会话'}</h1>
      <p>{en ? 'This fixture has no active session; session-header and composer slots stay unmounted.' : '当前 fixture 没有活动会话；会话页头与 composer 插槽应保持未挂载。'}</p>
      <div className="pg-empty-prompts"><button type="button">{en ? 'Inspect page routes' : '检查页面路由'}</button><button type="button">{en ? 'View plugin status' : '查看插件状态'}</button></div>
    </section>
  )
}

export function HostSeats({ mode, locale }: HostSeatsProps) {
  return (
    <main className="pg-main" {...(mode === 'conversation' ? { 'data-cordisx-playground-session-id': 'fixture-session' } : {})}>
      <div className="pg-page-seat pg-app-seat" data-cordisx-playground-seat="app" />
      <div className="pg-page-seat pg-main-seat" data-cordisx-playground-seat="main" />
      <div className="pg-conversation-shell">
        {mode === 'conversation' ? <Conversation locale={locale} /> : <EmptySession locale={locale} />}
      </div>
    </main>
  )
}
