import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@cordisx/protocol/agents/v1'
import type { AgentBootstrapCommandOrigin } from '@cordisx/protocol/agent-admission/v4'
import type { AgentAdmissionBootstrapRoomTarget } from '@cordisx/protocol/agent-admission/v5'
import 'cordisx/contracts'

/**
 * An external plugin consumer sees only public package exports plus Cordis
 * Context augmentation. No Host source import, cast, or private driver is used.
 */
export async function submitExactCurrentRoomTarget(
  ctx: Context,
  handle: AgentHandle,
  origin: AgentBootstrapCommandOrigin,
  target: AgentAdmissionBootstrapRoomTarget,
): Promise<void> {
  const issued = await ctx.agentAdmissionBootstrapRoomTargets.issue({ origin, target })
  if (issued.status !== 'issued') return
  const reserved = await ctx.agentAdmissionBootstrapRoomReservations.reserve({
    handle,
    origin: issued.origin,
    message: { text: 'external public v5 consumer' },
  })
  if (reserved.status === 'reserved') await reserved.reservation.revoke()
}
