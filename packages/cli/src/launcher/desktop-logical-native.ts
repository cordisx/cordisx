import type { NativeBridgeMethod, NativeSubmissionControlServer } from './native-submission-control-server.js'

/** Route a single durably reserved creation and its readback through the two native leases. */
export function desktopLogicalNativeRequests(input: {
  control: Pick<
    NativeSubmissionControlServer,
    'nativeRequest' | 'createFencedLogicalDestination' | 'releaseLogicalFence'
  >
  sourceThreadId: string
  sourceLease: string
  configuredProviderOverrides?: Readonly<Record<string, unknown>>
}) {
  let attempted = false
  let destination: { threadId: string; lease: string } | undefined
  return {
    async nativeRequest(method: NativeBridgeMethod, params: Readonly<Record<string, unknown>>) {
      if (method === 'thread/start' || method === 'thread/fork') {
        if (attempted) throw new Error('LOGICAL_CREATION_ALREADY_ATTEMPTED')
        attempted = true
        const created = await input.control.createFencedLogicalDestination(
          method,
          params,
          input.sourceThreadId,
          input.sourceLease,
          input.configuredProviderOverrides,
        )
        const result = created.result as { thread?: { id?: unknown } } | null
        const threadId = result?.thread?.id
        if (typeof threadId !== 'string' || !threadId || threadId === input.sourceThreadId) {
          throw new Error('LOGICAL_DESTINATION_UNCONFIRMED')
        }
        destination = { threadId, lease: created.destinationLease }
        return created.result
      }
      const current = destination
      const lease = params.threadId === input.sourceThreadId
        ? input.sourceLease
        : current && params.threadId === current.threadId
        ? current.lease
        : undefined
      return await input.control.nativeRequest(method, params, undefined, lease)
    },
    destination: () => destination?.threadId,
    async releaseDestination() {
      if (!destination) return false
      const current = destination
      if (!await input.control.releaseLogicalFence(current.threadId, current.lease)) return false
      if (destination === current) destination = undefined
      return true
    },
  }
}
