import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

const MAX_BODY = 16 * 1024 * 1024
const MAX_PRELUDE = 1024 * 1024
const MAX_ROUTES = 128
const HOP_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'upgrade',
  'accept-encoding',
])

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function encryptedReplay(body: unknown): Record<string, unknown> | undefined {
  const request = record(body)
  if (!request || !Array.isArray(request.input) || request.previous_response_id) return undefined
  const input = request.input.filter(item => {
    const entry = record(item)
    return !(entry?.type === 'reasoning' && typeof entry.encrypted_content === 'string'
      && entry.encrypted_content !== '')
  })
  if (input.length === request.input.length) return undefined
  const replay: Record<string, unknown> = { ...request, input }
  delete replay.previous_response_id
  return replay
}

export function encryptedContentError(value: unknown): boolean {
  const error = record(value)
  if (!error) return false
  if (error.code === 'invalid_encrypted_content') return true
  if (error.code === '-4003' || error.code === -4003) {
    return typeof error.message === 'string' && /\b(?:code:\s*)?invalid_encrypted_content\b/u.test(error.message)
  }
  return false
}

function eventError(value: unknown): unknown {
  const event = record(value)
  return event?.type === 'response.failed'
    ? (Array.isArray(record(event.response)?.output) && (record(event.response)!.output as unknown[]).length > 0
      ? undefined
      : record(event.response)?.error)
    : event?.type === 'error'
    ? event.error ?? event
    : undefined
}

function harmlessEvent(value: unknown): boolean {
  const event = record(value)
  if (!event || typeof event.type !== 'string') return false
  if (['response.created', 'response.in_progress'].includes(event.type)) {
    const response = record(event.response)
    return !response || !Array.isArray(response.output) || response.output.length === 0
  }
  return false
}

async function collect(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > MAX_BODY) throw new Error('request too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function responseHeaders(response: Response): Record<string, string> {
  return Object.fromEntries(
    [...response.headers].filter(([name]) => !HOP_HEADERS.has(name) && name !== 'content-encoding'),
  )
}

async function write(response: ServerResponse, bytes: Uint8Array): Promise<void> {
  if (response.destroyed) throw new Error('response closed')
  if (!response.write(bytes)) {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        response.off('drain', drained)
        response.off('close', closed)
        response.off('error', closed)
      }
      const drained = () => {
        cleanup()
        resolve()
      }
      const closed = () => {
        cleanup()
        reject(new Error('response closed'))
      }
      response.once('drain', drained)
      response.once('close', closed)
      response.once('error', closed)
      if (response.destroyed) closed()
    })
  }
}

async function forward(upstream: Response, response: ServerResponse): Promise<void> {
  response.writeHead(upstream.status, responseHeaders(upstream))
  const reader = upstream.body?.getReader()
  if (reader) {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      await write(response, chunk.value)
    }
  }
  response.end()
}

async function recoverable(
  upstream: Response,
): Promise<{ retry: boolean; prefix: Buffer; reader?: ReadableStreamDefaultReader<Uint8Array> }> {
  const reader = upstream.body?.getReader()
  if (!reader) return { retry: false, prefix: Buffer.alloc(0) }
  const sse = upstream.headers.get('content-type')?.includes('text/event-stream') === true
  const chunks: Buffer[] = []
  let bytes = 0
  let scanned = 0
  for (;;) {
    const next = await reader.read()
    if (next.done) {
      const prefix = Buffer.concat(chunks)
      if (!sse && upstream.status === 400) {
        try {
          return { retry: encryptedContentError(record(JSON.parse(prefix.toString()))?.error), prefix }
        } catch {}
      }
      return { retry: false, prefix }
    }
    chunks.push(Buffer.from(next.value))
    bytes += next.value.length
    const prefix = Buffer.concat(chunks)
    if (bytes > MAX_PRELUDE || (!sse && upstream.status !== 400)) return { retry: false, prefix, reader }
    if (!sse) continue
    const text = prefix.toString('utf8')
    const frames = text.slice(scanned).split(/\r?\n\r?\n/u)
    for (const frame of frames.slice(0, -1)) {
      scanned += frame.length + (text.slice(scanned + frame.length).startsWith('\r\n') ? 4 : 2)
      const data = frame.split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart())
        .join('\n')
      if (!data) continue
      let event: unknown
      try {
        event = JSON.parse(data)
      } catch {
        return { retry: false, prefix, reader }
      }
      if (encryptedContentError(eventError(event))) {
        await reader.cancel()
        return { retry: true, prefix }
      }
      if (!harmlessEvent(event)) return { retry: false, prefix, reader }
    }
  }
}

export async function startResponsesEncryptedReplay() {
  const routes = new Map<string, string>()
  const controllers = new Set<AbortController>()
  let closed = false
  const server = createServer(async (request, response) => {
    const target = routes.get(request.url ?? '')
    if (closed || request.method !== 'POST' || !target || controllers.size >= 32) {
      response.writeHead(404).end()
      return
    }
    const controller = new AbortController()
    controllers.add(controller)
    const timer = setTimeout(() => controller.abort(), 300_000)
    timer.unref()
    response.on('close', () => controller.abort())
    request.on('aborted', () => controller.abort())
    try {
      const bytes = await collect(request)
      let body: unknown
      try {
        body = JSON.parse(bytes.toString())
      } catch {
        body = undefined
      }
      const replay = encryptedReplay(body)
      const headers = new Headers()
      for (const [name, value] of Object.entries(request.headers)) {
        if (!HOP_HEADERS.has(name) && value !== undefined) {
          headers.set(name, Array.isArray(value) ? value.join(', ') : value)
        }
      }
      const send = (payload: string) =>
        fetch(target, { method: 'POST', headers, body: payload, redirect: 'manual', signal: controller.signal })
      const upstream = await send(bytes.toString('utf8'))
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel()
        response.writeHead(502).end(JSON.stringify({ error: { message: 'Provider redirects are not supported' } }))
        return
      }
      if (!replay) await forward(upstream, response)
      else {
        const inspected = await recoverable(upstream)
        if (inspected.retry && !controller.signal.aborted) {
          const retried = await send(JSON.stringify(replay))
          if (retried.status >= 300 && retried.status < 400) {
            await retried.body?.cancel()
            response.writeHead(502).end(JSON.stringify({ error: { message: 'Provider redirects are not supported' } }))
          } else await forward(retried, response)
        } else {
          response.writeHead(upstream.status, responseHeaders(upstream))
          await write(response, inspected.prefix)
          if (inspected.reader) {
            for (;;) {
              const chunk = await inspected.reader.read()
              if (chunk.done) break
              await write(response, chunk.value)
            }
          }
          response.end()
        }
      }
    } catch {
      if (!response.headersSent) {
        response.writeHead(502).end(JSON.stringify({ error: { message: 'Provider transport unavailable' } }))
      } else response.destroy()
    } finally {
      clearTimeout(timer)
      controllers.delete(controller)
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Provider transport unavailable')
  return {
    route(baseUrl: string): string {
      if (closed) throw new Error('Provider transport closed')
      const upstream = new URL(baseUrl)
      if (
        upstream.username || upstream.password || upstream.search || upstream.hash
        || !['https:', 'http:'].includes(upstream.protocol)
        || (upstream.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname))
      ) throw new Error('Invalid provider endpoint')
      upstream.pathname = `${upstream.pathname.replace(/\/$/u, '')}/responses`
      const existing = [...routes].find(([, value]) => value === upstream.href)
      if (existing) return `http://127.0.0.1:${address.port}${existing[0].slice(0, -'/responses'.length)}`
      if (routes.size >= MAX_ROUTES) throw new Error('Provider transport route limit')
      const route = `/${randomBytes(32).toString('hex')}/responses`
      routes.set(route, upstream.href)
      return `http://127.0.0.1:${address.port}${route.slice(0, -'/responses'.length)}`
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      routes.clear()
      for (const controller of controllers) controller.abort()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
