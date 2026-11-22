import { randomBytes } from 'node:crypto'

const guardedTurns = new Set(['turn/start', 'turn/steer', 'turn/addUserMessage'])
const blocked = () => Object.assign(new Error('Native continuation pending'), { code: 'CONTINUATION_PENDING' })

/** Serialize a checkpoint authorization with the owning profile until its native write completes. */
export function createNativeIntermediaryWriter(input) {
  return async (stream, value, logicalLease, logicalSourceThreadId) => {
    if (stream.destroyed) throw new Error('Native transport is closed')
    const native = stream === input.nativeStream()
    let message, handoffLease, entered = false, writing = false
    try {
      if (native) {
        try {
          message = typeof value === 'string' ? JSON.parse(value) : value
        } catch {}
        if (message?.method === 'initialize') input.initializing(message)
        if (message) {
          input.fence.enter(message, logicalLease, logicalSourceThreadId)
          entered = true
        }
        if (
          input.handoffEnabled() && guardedTurns.has(message?.method) && typeof message.params?.threadId === 'string'
        ) {
          const request = { method: message.method, threadId: message.params.threadId }
          let status
          try {
            status = await input.controlCall('logical-handoff-status', request)
          } catch {
            throw blocked()
          }
          if (status?.state !== 'clear') {
            if (
              status?.state !== 'pending' || typeof status.marker !== 'string' || typeof status.handoff !== 'string'
              || typeof status.digest !== 'string' || !Array.isArray(message.params.input)
              || !message.params.input.some(item =>
                item && typeof item.text === 'string'
                && item.text.includes(status.marker) && item.text.includes(status.handoff)
              )
            ) throw blocked()
            let approval
            handoffLease = randomBytes(24).toString('hex')
            try {
              approval = await input.controlCall('logical-handoff-authorize', {
                ...request,
                marker: status.marker,
                digest: status.digest,
                guardId: handoffLease,
              })
            } catch {
              throw blocked()
            }
            if (approval?.state !== 'authorized' || approval.lease !== handoffLease) throw blocked()
          }
        }
        if (message) input.issued(message)
      }
      await new Promise((resolve, reject) => {
        writing = true
        stream.write(
          `${typeof value === 'string' ? value : JSON.stringify(value)}\n`,
          error => error ? reject(error) : resolve(),
        )
      })
    } catch (error) {
      // A guard failure occurred before the native stream saw the request.
      if (native && entered && !writing && message?.id !== undefined) {
        input.fence.complete({ id: message.id, error: { code: -32000 } })
      }
      throw error
    } finally {
      if (handoffLease) {
        await input.controlCall('logical-handoff-release', { lease: handoffLease }).catch(() => undefined)
      }
    }
  }
}
