import type { readNativeStartupReadiness } from '../renderer/adapter/startup-readiness.js'

/** Serialized with the adapter: proof and release stay in the same renderer turn. */
export async function releaseReadyStartup(
  read: typeof readNativeStartupReadiness,
  descriptor: Parameters<typeof readNativeStartupReadiness>[0],
  trace?: Parameters<typeof readNativeStartupReadiness>[2],
): Promise<Awaited<ReturnType<typeof readNativeStartupReadiness>> & { released: boolean; releasedAt?: number }> {
  const result = await read(descriptor, undefined, trace)
  if (!result.ready || !result.receipt || !result.observations) return { ...result, released: false }
  const root = globalThis as typeof globalThis & {
    __cordisxStartupDocument?: {
      release(receipt: Record<string, unknown>, observations: NonNullable<typeof result.observations>): boolean
    }
  }
  // The document API retains its receipt, generation, disposal and proof fence.
  const released = root.__cordisxStartupDocument?.release(result.receipt, result.observations) === true
  return { ...result, released, ...(released ? { releasedAt: performance.timeOrigin + performance.now() } : {}) }
}
