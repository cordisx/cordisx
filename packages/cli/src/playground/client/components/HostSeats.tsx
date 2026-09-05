export type PlaygroundFixtureMode = 'conversation' | 'empty' | 'review'

export interface HostSeatsProps {
  readonly mode: PlaygroundFixtureMode
  readonly locale: 'zh-CN' | 'en'
}

/** Generic Playground outlets. Product pages are supplied only by plugins. */
export function HostSeats({ mode }: HostSeatsProps) {
  return (
    <main className="pg-main" {...(mode === 'conversation' ? { 'data-cordisx-playground-session-id': 'fixture-session' } : {})}>
      <div className="pg-page-seat pg-app-seat" data-cordisx-playground-seat="app" />
      <div className="pg-page-seat pg-main-seat" data-cordisx-playground-seat="main" />
    </main>
  )
}
