// Host-private resource transport. The server remains the authority for every
// session and graph; this worker never makes a resource public.
const clientsState = new Map()
const id = /^[a-f0-9]{64}$/u
const graphRoot = '/api/renderer/graphs/'
const graphPath =
  /^\/api\/renderer\/graphs\/[a-f0-9]{64}\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*){0,7}\.(?:js|mjs|css|avif|gif|jpeg|jpg|png|svg|webp|woff|woff2|wasm)$/u
const allowedDestinations = new Set(['', 'script', 'style', 'image', 'font'])
const maxFileBytes = 64 * 1024 * 1024
const maxReservedBytes = 128 * 1024 * 1024
const maxClientRequests = 16
let reservedBytes = 0

// An updated worker waits for old clients to leave. Replacing their controller
// during a lifecycle transaction would silently revoke their resource session.
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

function cancelRequests(state) {
  for (const controller of state.controllers) controller.abort()
  state.controllers.clear()
}

async function pruneClosedClients() {
  const active = new Set((await self.clients.matchAll({ type: 'window' })).map(client => client.id))
  for (const [clientId, state] of clientsState) {
    if (active.has(clientId)) continue
    cancelRequests(state)
    clientsState.delete(clientId)
  }
}

self.addEventListener('message', event => {
  event.waitUntil((async () => {
    const client = event.source && await self.clients.get(event.source.id)
    const port = event.ports[0]
    if (!client || client.type !== 'window' || client.frameType !== 'top-level') return
    const location = new URL(client.url)
    if (location.origin !== self.location.origin || location.pathname !== '/') return
    const value = event.data
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) return
    if (value.kind === 'claim' && Object.keys(value).length === 2) {
      await self.clients.claim()
      return
    }
    if (!port) return
    if (value.kind === 'check' && Object.keys(value).length === 2) {
      // A health check never touches the sequence or aborts active reads.
      port.postMessage({ version: 1, ok: typeof clientsState.get(client.id)?.token === 'string' })
      return
    }
    if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) return
    const bind = value.kind === 'bind' && Object.keys(value).length === 4
      && typeof value.token === 'string' && id.test(value.token)
    const unbind = value.kind === 'unbind' && Object.keys(value).length === 3
    if (!bind && !unbind) return
    await pruneClosedClients()
    let state = clientsState.get(client.id)
    if (state && value.sequence <= state.sequence) {
      port.postMessage({ version: 1, ok: false })
      return
    }
    if (!state) {
      if (clientsState.size >= 16) {
        port.postMessage({ version: 1, ok: false })
        return
      }
      state = { sequence: 0, token: undefined, controllers: new Set() }
      clientsState.set(client.id, state)
    }
    cancelRequests(state)
    state.sequence = value.sequence
    state.token = bind ? value.token : undefined
    port.postMessage({ version: 1, ok: true })
  })())
})

function unavailable(status) {
  return new Response(null, { status, headers: { 'cache-control': 'no-store' } })
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (
    url.origin !== self.location.origin
    || (url.pathname !== '/api/renderer/bundle.js' && !url.pathname.startsWith(graphRoot))
  ) return
  event.respondWith((async () => {
    const state = event.clientId && clientsState.get(event.clientId)
    const token = state?.token
    if (
      !token || event.request.method !== 'GET' || event.request.mode === 'navigate'
      || !allowedDestinations.has(event.request.destination) || url.search || url.hash
      || (url.pathname !== '/api/renderer/bundle.js' && !graphPath.test(url.pathname))
      || state.controllers.size >= maxClientRequests
    ) return unavailable(403)

    const headers = new Headers(event.request.headers)
    headers.set('authorization', `Bearer ${token}`)
    if (url.pathname === '/api/renderer/bundle.js') headers.set('x-cordisx-resource-encoding', 'br-v1')
    const controller = new AbortController()
    const abort = () => controller.abort()
    event.request.signal.addEventListener('abort', abort, { once: true })
    if (event.request.signal.aborted) abort()
    state.controllers.add(controller)
    const timer = setTimeout(abort, 15_000)
    let reservation = 0
    let reader
    let upstream
    try {
      const response = upstream = await fetch(
        new Request(event.request, {
          headers,
          mode: 'same-origin',
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        }),
      )
      if (controller.signal.aborted || clientsState.get(event.clientId) !== state || state.token !== token) {
        return unavailable(403)
      }
      if (response.status !== 200 || response.redirected) {
        return unavailable([401, 403, 404].includes(response.status) ? response.status : 503)
      }
      const encoding = response.headers.get('content-encoding')
      const encoded = encoding !== null && encoding.toLowerCase() !== 'identity'
      if (encoded && (url.pathname !== '/api/renderer/bundle.js' || encoding.toLowerCase() !== 'br')) {
        return unavailable(503)
      }
      const wireLength = response.headers.get('content-length')
      if (!wireLength || !/^(?:0|[1-9][0-9]*)$/u.test(wireLength) || Number(wireLength) > maxFileBytes) {
        return unavailable(503)
      }
      const rawLength = encoded ? response.headers.get('x-cordisx-decoded-length') : wireLength
      if (!rawLength || !/^(?:0|[1-9][0-9]*)$/u.test(rawLength)) return unavailable(503)
      const length = Number(rawLength)
      if (!Number.isSafeInteger(length) || length > maxFileBytes || reservedBytes + length > maxReservedBytes) {
        return unavailable(503)
      }
      reservation = length
      reservedBytes += length
      reader = response.body?.getReader()
      if (!reader && length !== 0) return unavailable(503)
      const chunks = []
      let bytesRead = 0
      while (reader) {
        const item = await reader.read()
        if (controller.signal.aborted || clientsState.get(event.clientId) !== state || state.token !== token) {
          return unavailable(403)
        }
        if (item.done) break
        bytesRead += item.value.byteLength
        if (bytesRead > length) return unavailable(503)
        chunks.push(item.value)
      }
      if (bytesRead !== length) return unavailable(503)
      const bytes = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      const responseHeaders = new Headers(response.headers)
      responseHeaders.delete('content-encoding')
      responseHeaders.delete('x-cordisx-decoded-length')
      responseHeaders.set('content-length', String(length))
      responseHeaders.set('cache-control', 'no-store')
      return new Response(bytes, { status: 200, headers: responseHeaders })
    } catch {
      return unavailable(controller.signal.aborted ? 403 : 503)
    } finally {
      if (reader) void reader.cancel().catch(() => undefined)
      else if (upstream?.body && !upstream.body.locked) void upstream.body.cancel().catch(() => undefined)
      clearTimeout(timer)
      event.request.signal.removeEventListener('abort', abort)
      state.controllers.delete(controller)
      reservedBytes -= reservation
    }
  })())
})
