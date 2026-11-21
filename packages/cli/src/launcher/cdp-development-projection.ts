import type { CordisXLocalDevelopmentSnapshot } from '../local-development-contracts.js'
import { type CdpSession, evaluateRuntimeOperation } from './cdp-session.js'

export async function projectCdpDevelopmentState(
  session: CdpSession,
  state: CordisXLocalDevelopmentSnapshot,
): Promise<void> {
  await evaluateRuntimeOperation(
    session,
    `(async () => { try {
      await globalThis.__cordisxBoot
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX renderer runtime is unavailable')
      return { ok: true, result: runtime.updateLocalDevelopmentStatus(${JSON.stringify(state)}) }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`,
  )
}
