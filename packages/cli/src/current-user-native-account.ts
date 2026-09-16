/** Host-private account input. This function is also serialized into the calling Native context. */
export async function readPinnedNativeAccount(
  buildNumber: string,
  native: {
    readonly TW?: { readonly accessInputs?: { readAccountInfo(): Promise<unknown> } }
    readonly gJt?: {
      getInstance(): {
        post(
          url: string,
          body?: string,
          headers?: Record<string, string>,
          signal?: AbortSignal,
        ): Promise<{ body: unknown }>
      }
    }
  },
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted()
  const unavailable = (nativeAccountReason: string): never => {
    throw Object.assign(new Error('native account unavailable'), { nativeAccountReason })
  }
  let remove = () => {}
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(new Error('native account unavailable'))
    signal.addEventListener('abort', onAbort, { once: true })
    remove = () => signal.removeEventListener('abort', onAbort)
  })
  try {
    const operation = (async () => {
      if (buildNumber === '8881' || buildNumber === '9275') {
        const inputs = native.TW?.accessInputs
        if (typeof inputs?.readAccountInfo !== 'function') return unavailable('typed-input-missing')
        // Match this build's own account query. A failed typed input must never
        // fall back to a second transport or a cached display identity.
        let result: { status?: unknown; reason?: unknown; data?: unknown } | null
        try {
          const invocation = inputs.readAccountInfo()
          let released = false
          const release = () => {
            if (released) return
            released = true
            const dispose = (Symbol as SymbolConstructor & { readonly dispose?: symbol }).dispose
            if (dispose !== undefined) {
              const cleanup = (invocation as Promise<unknown> & { [key: symbol]: unknown })[dispose]
              if (typeof cleanup === 'function') cleanup.call(invocation)
            }
          }
          signal.addEventListener('abort', release, { once: true })
          try {
            // The call can synchronously abort while creating its invocation.
            signal.throwIfAborted()
            result = await invocation as typeof result
            signal.throwIfAborted()
          } finally {
            signal.removeEventListener('abort', release)
            // Release only this RPC invocation, never the shared account input.
            release()
          }
        } catch {
          return unavailable('typed-read-exception')
        }
        if (result?.status === 'error') return unavailable('typed-read-error')
        if (result?.status === 'unavailable') {
          const reason = result.reason
          if (
            typeof reason === 'string' && ['retired', 'connection', 'identity', 'unsupported-auth'].includes(reason)
          ) {
            return unavailable(`typed-${reason}`)
          }
        }
        if (result?.status !== 'ready') return unavailable('typed-not-ready')
        return result.data
      }
      if (buildNumber !== '8378') return unavailable('native-pin-unavailable')
      const client = native.gJt?.getInstance?.()
      if (!client?.post) return unavailable('legacy-input-missing')
      try {
        return (await client.post('vscode://codex/account-info', undefined, undefined, signal)).body
      } catch {
        return unavailable('legacy-read-exception')
      }
    })()
    const value = await Promise.race([operation, aborted])
    signal.throwIfAborted()
    return value
  } finally {
    remove()
  }
}
