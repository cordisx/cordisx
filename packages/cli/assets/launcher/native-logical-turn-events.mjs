/** Forward only native turn identity; preserve ordering before a dynamic history call. */
export function createLogicalTurnEvents({ ready, writeControl }) {
  let pending = Promise.resolve()
  let failed = false
  let queued = 0
  return {
    observe(message) {
      if (!['turn/started', 'turn/completed'].includes(message?.method)) return
      const threadId = message.params?.threadId, turnId = message.params?.turn?.id
      if (
        typeof threadId !== 'string' || !threadId || threadId.length > 512
        || typeof turnId !== 'string' || !turnId || turnId.length > 512 || queued >= 1024
      ) {
        failed = true
        return
      }
      queued++
      pending = pending.then(() => ready).then(() =>
        writeControl({
          type: 'continuation-event',
          method: message.method,
          params: { threadId, turn: { id: turnId } },
        })
      ).catch(() => {
        failed = true
      }).finally(() => queued--)
    },
    async beforeHistory() {
      await pending
      if (failed) throw new Error('Native turn authority unavailable')
    },
  }
}
