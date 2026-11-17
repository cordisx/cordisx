import { codexTurn } from './agent-bridge-codex-history.js'
import type { NativeBridgeMethod } from './native-submission-control-server.js'

type TurnState = 'active' | 'completed' | 'failed' | 'unknown'
type Reader = { nativeRequest(method: NativeBridgeMethod, params: Readonly<Record<string, unknown>>): Promise<unknown> }

/** Read and interrupt only the explicitly owned source turn on its existing native connection. */
export class ChannelLiveTurnControl {
  constructor(
    private readonly native: Reader,
    private readonly pause: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 250)),
    private readonly attempts = 40,
  ) {}

  async turnState(sessionId: string, turnId: string): Promise<TurnState> {
    try {
      const turn = await codexTurn(this.native, sessionId, turnId)
      if (turn?.id !== turnId) return 'unknown'
      if (turn.status === 'inProgress' || turn.status === 'running') return 'active'
      if (turn.status === 'completed') return 'completed'
      if (turn.status === 'failed' || turn.status === 'interrupted') return 'failed'
      return 'unknown'
    } catch {
      return 'unknown'
    }
  }

  async interruptExact(sessionId: string, turnId: string): Promise<'interrupted' | 'already-completed' | 'uncertain'> {
    const before = await this.turnState(sessionId, turnId)
    if (before === 'completed') return 'already-completed'
    if (before !== 'active') return 'uncertain'
    try {
      await this.native.nativeRequest('turn/interrupt', { threadId: sessionId, turnId })
    } catch {
      return 'uncertain'
    }
    for (let i = 0; i < this.attempts; i++) {
      let turn: Awaited<ReturnType<typeof codexTurn>>
      try {
        turn = await codexTurn(this.native, sessionId, turnId)
      } catch {
        return 'uncertain'
      }
      if (turn?.id !== turnId) return 'uncertain'
      if (turn.status === 'interrupted') return 'interrupted'
      if (turn.status === 'completed') return 'already-completed'
      if (turn.status !== 'inProgress' && turn.status !== 'running') return 'uncertain'
      if (i + 1 < this.attempts) await this.pause()
    }
    return 'uncertain'
  }
}
