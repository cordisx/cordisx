const workerScript = '/manager-resource-worker.js'
const sessionTokenPattern = /^[a-f0-9]{64}$/u

export interface ManagerResourceAuthClient {
  /** Register the fixed same-origin worker and bind this browser document. */
  start(): Promise<boolean>
  /** Rebind after worker memory is lost, only after rechecking the server session. */
  recover(): Promise<boolean>
  /** Erase the local token and abort worker requests; the caller must also revoke server authority. */
  revokeLocal(): Promise<boolean>
}

function withTimeout<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('manager-resource-worker-unavailable')), milliseconds)
    operation.then(value => {
      clearTimeout(timer)
      resolve(value)
    }, error => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function currentController(container: ServiceWorkerContainer, expectedUrl: string): Promise<ServiceWorker> {
  const verify = (worker: ServiceWorker): ServiceWorker => {
    if (worker.scriptURL !== expectedUrl) throw new Error('manager-resource-worker-unavailable')
    return worker
  }
  if (container.controller) return verify(container.controller)
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      container.removeEventListener('controllerchange', changed)
      reject(new Error('manager-resource-worker-unavailable'))
    }, 5_000)
    const changed = () => {
      if (!container.controller) return
      clearTimeout(timer)
      container.removeEventListener('controllerchange', changed)
      try {
        resolve(verify(container.controller))
      } catch (error) {
        reject(error)
      }
    }
    container.addEventListener('controllerchange', changed)
    changed()
  })
}

async function send(
  container: ServiceWorkerContainer,
  expectedUrl: string,
  message: { readonly version: 1; readonly sequence: number; readonly kind: 'bind'; readonly token: string } | {
    readonly version: 1
    readonly sequence: number
    readonly kind: 'unbind'
  },
): Promise<boolean> {
  const worker = await currentController(container, expectedUrl)
  const channel = new MessageChannel()
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      channel.port1.close()
      reject(new Error('manager-resource-worker-unavailable'))
    }, 3_000)
    channel.port1.onmessage = event => {
      clearTimeout(timer)
      channel.port1.close()
      resolve(event.data?.version === 1 && event.data?.ok === true)
    }
    try {
      worker.postMessage(message, [channel.port2])
    } catch {
      clearTimeout(timer)
      channel.port1.close()
      reject(new Error('manager-resource-worker-unavailable'))
    }
  })
}

/**
 * One instance per browser document. The token remains in memory and is sent
 * only to the fixed local worker; it must not be placed in an import URL.
 */
export function createManagerResourceAuthClient(input: {
  readonly window: Window
  readonly sessionToken: string
  /** Must verify current server-side authority, including on explicit recovery. */
  readonly isSessionCurrent: () => boolean | Promise<boolean>
}): ManagerResourceAuthClient {
  if (!sessionTokenPattern.test(input.sessionToken) || typeof input.isSessionCurrent !== 'function') {
    throw new Error('manager-resource-session-invalid')
  }
  const origin = new URL(input.window.location.href)
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.port === '') {
    throw new Error('manager-resource-origin-invalid')
  }
  const expectedUrl = new URL(workerScript, origin.origin).href
  const container = input.window.navigator.serviceWorker
  let token: string | undefined = input.sessionToken
  let sequence = 0
  let disposed = false
  const nextSequence = () => {
    if (sequence >= Number.MAX_SAFE_INTEGER) throw new Error('manager-resource-session-exhausted')
    return ++sequence
  }
  const bind = async (): Promise<boolean> => {
    try {
      if (disposed || !container || !await input.isSessionCurrent() || disposed || !token) return false
      const accepted = await send(container, expectedUrl, { version: 1, kind: 'bind', token, sequence: nextSequence() })
      return !disposed && accepted
    } catch {
      return false
    }
  }
  return Object.freeze({
    async start(): Promise<boolean> {
      if (disposed || !container) return false
      try {
        await withTimeout(container.register(workerScript, { scope: '/', updateViaCache: 'none' }), 5_000)
        await withTimeout(container.ready, 5_000)
        return await bind()
      } catch {
        return false
      }
    },
    async recover(): Promise<boolean> {
      return await bind()
    },
    async revokeLocal(): Promise<boolean> {
      if (disposed) return false
      disposed = true
      token = undefined
      if (!container) return false
      try {
        return await send(container, expectedUrl, { version: 1, kind: 'unbind', sequence: nextSequence() })
      } catch {
        return false
      }
    },
  })
}
