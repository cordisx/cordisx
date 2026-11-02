import { startupTransportControlEvaluation } from './startup-ui-transport-control.js'
import type { CdpSession } from './cdp-session.js'

export interface StartupCdpTransport {
  connected(session: CdpSession): Promise<void>
  disconnecting(session: CdpSession): Promise<void>
}

/** Sequence belongs to a Host generation, not one socket or renderer document. */
export function createStartupCdpTransport(input: {
  token: string
  profileId: string
  generation: string
  onDisconnected?: () => void
}): StartupCdpTransport {
  let sequence = 0
  const removers = new Map<CdpSession, () => void>()
  const send = async (session: CdpSession, phase: 'disconnected' | 'reconnected') => {
    if (session.isClosed()) return
    await session.send('Runtime.evaluate', {
      expression: startupTransportControlEvaluation({ ...input, sequence: ++sequence, phase }),
      allowUnsafeEvalBlockedByCSP: true,
      returnByValue: true,
    })
  }
  return {
    async connected(session) {
      if (!removers.has(session)) {
        removers.set(
          session,
          session.onClose(() => {
            removers.get(session)?.()
            removers.delete(session)
            // A closed socket cannot deliver JavaScript; recovery clears stale readers.
            input.onDisconnected?.()
          }),
        )
      }
      await send(session, 'reconnected')
    },
    async disconnecting(session) {
      await send(session, 'disconnected').catch(() => undefined)
      removers.get(session)?.()
      removers.delete(session)
    },
  }
}
