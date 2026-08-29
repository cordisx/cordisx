import { useMemo } from 'react'
import { AgentConversationRenderer } from '../../../renderer/host-ui/conversation/AgentConversationRenderer.js'
import {
  createPlaygroundConversationFixture,
  createPlaygroundConversationCommands,
  playgroundConversationCopy,
} from '../fixtures/agent-conversation.js'

export type PlaygroundFixtureMode = 'conversation' | 'empty'

export interface HostSeatsProps {
  readonly mode: PlaygroundFixtureMode
  readonly locale: 'zh-CN' | 'en'
}

/** Playground placement only; all conversation DOM and interaction are production-owned. */
export function HostSeats({ mode, locale }: HostSeatsProps) {
  const model = useMemo(() => createPlaygroundConversationFixture(mode, locale), [mode, locale])
  const commands = useMemo(() => createPlaygroundConversationCommands(model), [model])
  return (
    <main className="pg-main" {...(mode === 'conversation' ? { 'data-cordisx-playground-session-id': 'fixture-session' } : {})}>
      <div className="pg-page-seat pg-app-seat" data-cordisx-playground-seat="app" />
      <div className="pg-page-seat pg-main-seat" data-cordisx-playground-seat="main" />
      <div className="pg-conversation-shell">
        <AgentConversationRenderer
          model={model}
          commands={commands}
          copy={playgroundConversationCopy(locale)}
          debugFixture
        />
      </div>
    </main>
  )
}
