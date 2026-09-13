import type { CurrentUserResultV1, CurrentUserV1 } from '@cordisx/protocol/current-user/v1'
import { inlineAvatar } from './bitmap.js'
import { type CurrentUserSource, readNativeCurrentUser } from './native.js'
const unavailable = (reason: 'generation-retired' | 'host-unavailable'): CurrentUserResultV1 => ({
  status: 'unavailable',
  reason,
})
/** One opaque subject namespace per Host profile and plugin identity; never stored raw native identity. */
async function subject(ownerKey: string, identity: string): Promise<string> {
  const key = 'cordisx.current-user.subject-salt.v1'
  let salt = localStorage.getItem(key)
  if (!salt || !/^[a-zA-Z0-9-]{36}$/.test(salt)) {
    salt = crypto.randomUUID()
    localStorage.setItem(key, salt)
    if (localStorage.getItem(key) !== salt) throw Error('subject storage unavailable')
  }
  const bytes = new TextEncoder().encode(JSON.stringify([salt, ownerKey, identity]))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return `host:${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}`
}
export function createCurrentUserService(
  active: () => boolean,
  ownerKey: string,
  source: (signal: AbortSignal) => Promise<CurrentUserSource> = readNativeCurrentUser,
): CurrentUserV1 {
  let disposed = false
  let pending: Promise<CurrentUserResultV1> | undefined
  let controller: AbortController | undefined
  let interval: ReturnType<typeof setInterval> | undefined
  let last: string | undefined
  const listeners = new Set<(result: CurrentUserResultV1) => void>()
  const live = () => !disposed && active()
  const stop = () => {
    clearInterval(interval)
    interval = undefined
    window.removeEventListener('focus', update)
    window.removeEventListener('message', accountChanged)
  }
  const emit = (result: CurrentUserResultV1) => {
    if (!live()) return
    const encoded = JSON.stringify(result)
    if (last === encoded) return
    last = encoded
    for (const listener of listeners) {
      if (!live() || !listeners.has(listener)) continue
      try {
        listener(structuredClone(result))
      } catch { /* Isolate consumer callbacks. */ }
    }
  }
  async function update() {
    if (!live()) {
      stop()
      return
    }
    emit(await api.read())
  }
  function accountChanged(event: MessageEvent) {
    // Native preload dispatches MessageEvent without source; window.postMessage uses window.
    if (event.source !== null && event.source !== window) return
    const message = event.data
    if (
      message?.type === 'mcp-notification'
      && ['account/updated', 'account/login/completed'].includes(message?.message?.method)
    ) {
      const previous = pending
      controller?.abort()
      emit(unavailable('host-unavailable'))
      if (previous) void previous.then(() => update())
      else void update()
    }
  }
  const api: CurrentUserV1 = {
    contract: 'cordisx.current-user/v1',
    async read() {
      if (!live()) return unavailable('generation-retired')
      if (!pending) {
        controller = new AbortController()
        const signal = controller.signal
        const timer = setTimeout(() => controller?.abort(), 10000)
        pending = (async (): Promise<CurrentUserResultV1> => {
          try {
            const task = source(signal)
            const value = await new Promise<CurrentUserSource>((resolve, reject) => {
              const abort = () => reject(Error('profile read aborted'))
              signal.addEventListener('abort', abort, { once: true })
              if (signal.aborted) abort()
              task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
            })
            if (!live()) return unavailable('generation-retired')
            signal.throwIfAborted()
            if (value.status === 'unavailable') return { status: 'unavailable', reason: value.reason }
            const opaque = await subject(ownerKey, value.identity)
            if (!live()) return unavailable('generation-retired')
            signal.throwIfAborted()
            const displayName = typeof value.displayName === 'string'
              ? Array.from(value.displayName.trim()).slice(0, 128).join('')
              : undefined
            const avatar = inlineAvatar(value.avatar)
            return {
              status: 'available',
              profile: {
                subject: opaque,
                ...(displayName ? { displayName } : {}),
                ...(avatar ? { avatar } : {}),
              },
            }
          } catch {
            return unavailable(live() ? 'host-unavailable' : 'generation-retired')
          } finally {
            clearTimeout(timer)
          }
        })().finally(() => {
          pending = undefined
          controller = undefined
        })
      }
      return structuredClone(await pending)
    },
    subscribe(listener) {
      if (!live() || typeof listener !== 'function') return () => {}
      const callback = (result: CurrentUserResultV1) => listener(result)
      listeners.add(callback)
      if (!interval) {
        interval = setInterval(() => void update(), 5000)
        window.addEventListener('focus', update)
        window.addEventListener('message', accountChanged)
      }
      let subscribed = true
      void api.read().then(result => {
        if (subscribed && live() && listeners.has(callback)) {
          last ??= JSON.stringify(result)
          try {
            listener(result)
          } catch { /* Isolate consumer callbacks. */ }
        }
      })
      return () => {
        subscribed = false
        listeners.delete(callback)
        if (!listeners.size) {
          stop()
          last = undefined
        }
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      controller?.abort()
      stop()
      listeners.clear()
    },
  }
  return api
}
