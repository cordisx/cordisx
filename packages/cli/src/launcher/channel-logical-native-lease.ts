import type { NativeSubmissionControlServer } from './native-submission-control-server.js'
import { desktopLogicalNativeRequests } from './desktop-logical-native.js'

/** Channel and Desktop mutations share the intermediary's source and destination leases. */
export async function acquireChannelLogicalNativeLease(
  control: Pick<
    NativeSubmissionControlServer,
    'acquireLogicalFence' | 'releaseLogicalFence' | 'nativeRequest' | 'createFencedLogicalDestination'
  >,
  source: string,
) {
  let lease: string | undefined
  try {
    lease = await control.acquireLogicalFence(source)
  } catch {
    // A timeout may follow a successful remote acquisition.
    return { state: 'unknown' as const }
  }
  if (!lease) return { state: 'busy' as const }
  const requests = desktopLogicalNativeRequests({ control, sourceThreadId: source, sourceLease: lease })
  return {
    state: 'acquired' as const,
    ...requests,
    releaseSource: () => control.releaseLogicalFence(source, lease!),
  }
}
