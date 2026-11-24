import { channelModelConnectivity, channelModelConnectivityEvidence } from './channel-model-connectivity.js'
import type { ChannelMemoryModelConnection } from './channel-user-memory-model.js'
import type { AgentBridge } from './agent-bridge.js'
import { consumeChannelAttachmentTicket } from './channel-inbound-resources.js'

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** A rejected fence must release the unused, short-lived attachment ticket. */
export async function channelDispatchFence(
  beforeDispatch: (() => Promise<boolean>) | undefined,
  ticket: string | undefined,
) {
  if (!beforeDispatch) return true
  try {
    if (await beforeDispatch()) return true
  } catch {
    // A failed fence cannot authorize a native effect.
  }
  try {
    consumeChannelAttachmentTicket(ticket)
  } catch {
    // An expired ticket is already unavailable.
  }
  return false
}

/** The bridge dry run performs only catalog, directory and declared-key checks. */
export async function channelModelPreflight(
  bridge: AgentBridge | undefined,
  cwd: string,
  candidate: { providerId: string; model: string },
  signal?: AbortSignal,
  connect?: ChannelMemoryModelConnection,
  beforeProbe?: () => Promise<boolean>,
): Promise<boolean> {
  if (!bridge || signal?.aborted) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = object(
      await Promise.race([
        bridge.call('codex', 'start_session', {
          dryRun: true,
          prompt: 'Channel model selection preflight',
          cwd: cwd,
          ...candidate,
        }, signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('PREFLIGHT_TIMEOUT')), 5_000)
        }),
      ]),
    )
    if (result.status === 'dry-run') {
      if (beforeProbe && !await beforeProbe()) return false
      return channelModelConnectivity(connect, candidate, signal, 15_000, beforeProbe)
    }
    if (
      ['provider-key-missing', 'provider-not-configured', 'model-not-in-provider-catalog'].includes(
        String(result.reason),
      )
    ) {
      return false
    }
    throw new Error('MODEL_PRIORITY_PREFLIGHT_UNAVAILABLE')
  } catch (error) {
    if (error instanceof Error && error.message === 'PREFLIGHT_TIMEOUT') return false
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function channelModelPriorityProbes(input: {
  bridge: () => AgentBridge | undefined
  cwd: string
  memoryConnect?: ChannelMemoryModelConnection | undefined
}) {
  return {
    preflight: (
      candidate: { providerId: string; model: string },
      signal?: AbortSignal,
      before?: () => Promise<boolean>,
    ) => channelModelPreflight(input.bridge(), input.cwd, candidate, signal, input.memoryConnect, before),
    evidence: (
      candidate: { providerId: string; model: string },
      signal?: AbortSignal,
      before?: () => Promise<boolean>,
    ) => channelModelConnectivityEvidence(input.memoryConnect, candidate, signal, 15_000, before),
  }
}
