import type { CordisXPluginBundleManagerSnapshotV1 } from '../plugin-bundle-contracts.js'
import { type CdpSession, evaluateRuntimeOperation } from './cdp-session.js'

/** Adopt the same owner snapshot in one admitted renderer. */
export async function projectCdpPluginBundles(
  session: CdpSession,
  snapshot: CordisXPluginBundleManagerSnapshotV1,
): Promise<Readonly<{ revision: number; pluginRevision: number }>> {
  return await evaluateRuntimeOperation(
    session,
    `(async () => { try {
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX renderer runtime is unavailable')
      return { ok: true, result: runtime.adoptPluginBundleSnapshot(${JSON.stringify(snapshot)}) }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`,
  )
}
