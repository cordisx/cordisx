const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined

/** Recover only an exactly correlated missing-provider model/list response. */
export function createNativeManagedModelListRecovery({ controlCall, writeDesktop, emitDiagnostic, stop }) {
  const requests = new Map()
  const retire = id => {
    const entry = requests.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    requests.delete(id)
  }
  const finish = (id, entry) => {
    if (requests.get(id) !== entry) return
    if (--entry.outstanding === 0) retire(id)
  }
  return {
    issued(message) {
      const params = object(message?.params)
      if (
        message?.method !== 'model/list' || !['string', 'number'].includes(typeof message.id)
        || !(params?.modelProvider == null || typeof params.modelProvider === 'string'
            && /^[a-zA-Z0-9_.:-]{1,128}$/u.test(params.modelProvider))
        || !(params?.limit == null || Number.isSafeInteger(params.limit) && params.limit > 0)
        || !(params?.cursor == null || typeof params.cursor === 'string' && params.cursor.length > 0
            && params.cursor.length <= 256 && !/[\0\r\n]/u.test(params.cursor))
        || !(params?.includeHidden == null || typeof params.includeHidden === 'boolean')
      ) return
      const input = {
        ...(params?.modelProvider == null ? {} : { providerId: params.modelProvider }),
        ...(params?.limit == null ? {} : { limit: params.limit }),
        ...(params?.cursor == null ? {} : { cursor: params.cursor }),
        ...(params?.includeHidden == null ? {} : { includeHidden: params.includeHidden }),
      }
      const current = requests.get(message.id)
      if (current) {
        // Retain the fence until every duplicate has returned or expired.
        current.ambiguous = true
        current.outstanding++
      } else if (requests.size < 64) {
        const timer = setTimeout(() => retire(message.id), 120_000)
        timer.unref?.()
        requests.set(message.id, { input, timer, outstanding: 1, ambiguous: false })
      }
    },
    received(message, line) {
      const entry = message.method === undefined ? requests.get(message.id) : undefined
      if (!entry) return false
      if (entry.ambiguous) {
        finish(message.id, entry)
        return false
      }
      const request = entry.input
      if (message.error !== undefined) {
        const type = message.error?.data?.type
        const reason = message.error?.code === -32600 && type === 'modelProviderNotConfigured'
          ? 'provider-not-configured'
          : message.error?.code === -32600 && type === 'modelProviderPolicyConflict'
          ? 'provider-policy-conflict'
          : 'native-error'
        emitDiagnostic({ event: 'model-list-native-error', reason })
      }
      if (
        !request?.providerId || request.providerId === 'openai' || message.error?.code !== -32600
        || message.error.data?.type !== 'modelProviderNotConfigured'
        || message.error.data.modelProvider !== request.providerId
      ) {
        finish(message.id, entry)
        return false
      }
      void controlCall('managed-model-list', request).catch(() => null).then(result => {
        if (
          !entry.ambiguous && requests.get(message.id) === entry
          && object(result) && Array.isArray(result.data) && result.data.length <= 100
          && (result.nextCursor === null || typeof result.nextCursor === 'string')
        ) {
          emitDiagnostic({ event: 'model-list-recovered', reason: 'managed-provider-not-configured' })
          const recovered = { ...message, result }
          delete recovered.error
          return writeDesktop(recovered).catch(stop)
        }
        emitDiagnostic({ event: 'model-list-recovery-unavailable', reason: 'managed-provider-not-configured' })
        return writeDesktop(line).catch(stop)
      }).finally(() => finish(message.id, entry))
      return true
    },
    clear: () => [...requests.keys()].forEach(retire),
  }
}
