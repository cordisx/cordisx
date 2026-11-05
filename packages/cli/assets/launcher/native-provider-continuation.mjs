const valid = (value, max = 512) =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/u.test(value)

/** Owns only normal forks created for a Host-admitted Composer Send. */
export function createNativeProviderContinuation({ nativeCall, lifecyclePending, current }) {
  const forks = new Map()
  const discard = async (operationToken, threadId) => {
    const fork = forks.get(operationToken)
    if (!fork || fork.threadId !== threadId || fork.dispatched) return false
    const read = await nativeCall('thread/read', { threadId, includeTurns: false })
    if (
      read?.thread?.id !== threadId || read.thread.modelProvider !== fork.providerId
      || !['idle', 'notLoaded'].includes(read.thread.status?.type) || lifecyclePending(threadId)
    ) return false
    await nativeCall('thread/archive', { threadId })
    forks.delete(operationToken)
    return true
  }
  return {
    dispatched(operationToken, threadId) {
      const fork = forks.get(operationToken)
      if (fork?.threadId === threadId) {
        fork.dispatched = true
        forks.delete(operationToken)
      }
    },
    async handle(message) {
      if (!valid(message.operationToken, 256)) return { ok: false }
      if (message.type === 'continuation-discard') {
        return { ok: true, value: await discard(message.operationToken, message.threadId) }
      }
      if (!valid(message.threadId) || !valid(message.providerId, 128) || !valid(message.model)) {
        return { ok: false }
      }
      if (forks.has(message.operationToken) || forks.size >= 32) return { ok: false }
      const source = await nativeCall('thread/read', { threadId: message.threadId, includeTurns: false })
      if (
        !current(message.threadId) || source?.thread?.id !== message.threadId
        || !['idle', 'notLoaded', 'systemError'].includes(source.thread.status?.type)
      ) return { ok: false }
      if (source.thread.ephemeral === true) return { ok: false, reason: 'provider-switch-unsupported' }
      try {
        const result = await nativeCall('thread/fork', {
          threadId: message.threadId,
          modelProvider: message.providerId,
          model: message.model,
          config: message.config,
          ephemeral: false,
          excludeTurns: true,
          deferGoalContinuation: true,
        })
        const thread = result?.thread
        if (
          !valid(thread?.id) || thread.id === message.threadId || thread.ephemeral === true
          || result.modelProvider !== message.providerId || result.model !== message.model
          || thread.status?.type !== 'idle'
        ) return { ok: false, reason: 'provider-switch-reconciliation-required' }
        forks.set(message.operationToken, { threadId: thread.id, providerId: message.providerId, dispatched: false })
        if (!current(message.threadId)) {
          await discard(message.operationToken, thread.id)
          return { ok: false, reason: 'provider-switch-reconciliation-required' }
        }
        return { ok: true, value: { threadId: thread.id } }
      } catch (error) {
        return error.nativeError === undefined
          ? { ok: false, reason: 'provider-switch-reconciliation-required' }
          : { ok: false }
      }
    },
  }
}

/** Shared switch/fork scheduling preserves the existing lifecycle fence. */
export function dispatchNativeSelectionMutation(message, ports) {
  const { switching, switchRequests, recoveringTurns, lifecyclePending, cancelledRecovery, uncertainSwitches } = ports
  const { nativeCall, controlCall, switchNativeThread, continuation, write, control, closed, stop } = ports
  if (!['switch', 'continuation-fork', 'continuation-discard'].includes(message.type)) return false
  if (
    typeof message.id !== 'string' || switching.has(message.threadId) || recoveringTurns.has(message.threadId)
    || lifecyclePending(message.threadId)
  ) {
    void write(control, { id: message.id, ok: false }).catch(stop)
    return true
  }
  switching.add(message.threadId)
  switchRequests.set(message.id, message.threadId)
  void (async () => {
    try {
      const result = message.type === 'switch'
        ? await switchNativeThread(message, {
          nativeCall,
          controlCall,
          current: () => !closed() && !cancelledRecovery.has(message.threadId) && !lifecyclePending(message.threadId),
        })
        : await continuation.handle(message)
      if (result.reason === 'provider-switch-reconciliation-required') {
        uncertainSwitches.set(message.threadId, undefined)
      }
      await write(control, { id: message.id, ...result })
    } catch {
      await write(control, { id: message.id, ok: false })
    } finally {
      switching.delete(message.threadId)
      switchRequests.delete(message.id)
      cancelledRecovery.delete(message.threadId)
    }
  })().catch(stop)
  return true
}
