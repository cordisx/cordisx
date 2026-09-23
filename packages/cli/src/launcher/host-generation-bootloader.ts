/** Only the launch-owned manifest is retried; HTTP, validation and activation fail once. */
export function hostGenerationBootloaderSource(origin: string): string {
  return `(() => {
  const origin = ${JSON.stringify(origin)}
  const manifest = ${JSON.stringify(`${origin}/manifest.json`)}
  globalThis.__cordisxHostGraphBoot?.abort()
  const controller = new AbortController()
  const signal = controller.signal
  const startupBudget = globalThis.__cordisxProductionBootstrapTimeoutMs ?? 60000
  const budget = Math.min(10000, startupBudget)
  const deadline = Date.now() + budget
  let lastFailure
  let activation
  const diagnostic = (stage, error) => {
    const detail = String(error?.message ?? error).split(origin).join('[host graph]')
      .replace(/https?:\\/\\/[^\\s)]+/g, '[url]').slice(0, 256)
    return Error('CordisX Host ' + stage + ': ' + detail)
  }
  const expired = () => diagnostic('manifest fetch deadline exceeded', lastFailure ?? 'startup deadline exceeded')
  const check = () => {
    signal.throwIfAborted()
    if (Date.now() >= deadline) { controller.abort(expired()); signal.throwIfAborted() }
  }
  const bounded = operation => new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    if (signal.aborted) abort()
  })
  const pause = () => new Promise((resolve, reject) => {
    const finish = () => { signal.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(finish, Math.min(250, Math.max(0, deadline - Date.now())))
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
  const timer = setTimeout(() => controller.abort(expired()), budget)
  const startupTimer = setTimeout(() => controller.abort(Error('CordisX Host graph startup deadline exceeded')), startupBudget)
  const owner = {
    installId: globalThis.__cordisxProductionInstallId,
    abort: () => controller.abort(Error('CordisX Host graph startup canceled')),
    dispose: async () => {
      owner.abort()
      // A started activation belongs to normal runtime disposal; drain it first.
      if (activation) {
        let drainTimer
        try {
          await Promise.race([
            activation.catch(() => undefined),
            new Promise((_, reject) => { drainTimer = setTimeout(() => reject(Error('CordisX Host activation cleanup timed out')), 1000) }),
          ])
        } finally { clearTimeout(drainTimer) }
      }
    },
  }
  globalThis.__cordisxHostGraphBoot = owner
  const task = (async () => {
    let response
    for (;;) {
      check()
      try { response = await bounded(fetch(manifest, { signal, redirect: 'error' })); break }
      catch (error) {
        signal.throwIfAborted()
        lastFailure = error
        await pause()
      }
    }
    check()
    if (!response.ok) throw Error('CordisX Host manifest HTTP ' + response.status)
    let value
    try { value = await bounded(response.json()) }
    catch (error) { signal.throwIfAborted(); throw diagnostic('manifest JSON invalid', error) }
    check()
    if (value?.version !== 1 || typeof value.entry !== 'string' || !/^\\/[^/]/.test(value.entry)
      || typeof value.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.digest)) {
      throw Error('CordisX Host manifest schema invalid')
    }
    const entry = new URL(origin + value.entry)
    if (!entry.href.startsWith(origin + '/') || entry.search || entry.hash) {
      throw Error('CordisX Host manifest entry is outside its owned graph')
    }
    clearTimeout(timer)
    let module
    try { module = await bounded(import(entry.href)) }
    catch (error) { signal.throwIfAborted(); throw diagnostic('entry import failed', error) }
    signal.throwIfAborted()
    activation = module.boot(signal)
    return await bounded(activation)
  })().finally(() => { clearTimeout(timer); clearTimeout(startupTimer) })
  globalThis.__cordisxCompositionBoot = task
  void task.catch(error => console.error('[cordisx] Host graph boot failed', error))
})()`
}
