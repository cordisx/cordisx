import { MANAGED_SERVICE_UI_RECEIVER } from './managed-service-ui-rpc.js'

/** Host-private CDP control. Send only over a working session; a dead socket cannot notify a renderer. */
export function startupTransportControlEvaluation(input: {
  readonly token: string
  readonly profileId: string
  readonly generation: string
  readonly sequence: number
  readonly phase: 'disconnected' | 'reconnected'
}): string {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    throw new Error('startup transport control sequence is invalid')
  }
  const payload = JSON.stringify({
    contract: 'cordisx.startup-transport-control/v1',
    token: input.token,
    scope: { profileId: input.profileId, runtimeGeneration: input.generation },
    sequence: input.sequence,
    phase: input.phase,
  })
  return `(() => { const receiver = globalThis.${MANAGED_SERVICE_UI_RECEIVER}; if (typeof receiver !== 'function') return false; receiver(${
    JSON.stringify(payload)
  }); return true })()`
}
