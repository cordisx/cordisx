import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { promisify } from 'node:util'
import { zstdCompress, zstdDecompress } from 'node:zlib'
import { tunnelResponsesWebSocket } from './responses-websocket-tunnel.js'
import { adaptNamedOutputs } from './responses-named-output.js'

export interface ResponsesReplayRouteOptions {
  readonly websocket?: boolean
  /** Explicit runtime idle policy belongs to Codex, including values above the legacy proxy limit. */
  readonly nativeStreamIdlePolicy?: boolean
  /** A native OpenAI base also serves other endpoints that must pass through unchanged. */
  readonly nativeOpenAi?: boolean
  /** Bind native ChatGPT credentials to the account whose routing was observed. */
  readonly expectedAccountDigest?: string
  readonly accountRoutingOverride?: 'NO_CONSTRAINT' | 'us' | 'us_cr'
  readonly accountSnapshot?: string
  readonly verifyAccount?: (snapshot: string) => Promise<boolean>
}

const MAX_PRELUDE = 1024 * 1024
const MAX_ROUTES = 128
const compressZstd = promisify(zstdCompress)
const decompressZstd = promisify(zstdDecompress)
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
  for await (const chunk of request) {
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
  const routes = new Map<string, {
    target: string
    basePath: string
    websocket: boolean
    nativeStreamIdlePolicy: boolean
    nativeOpenAi: boolean
    expectedAccountDigest: string | undefined
    accountRoutingOverride: 'NO_CONSTRAINT' | 'us' | 'us_cr' | undefined
    accountSnapshot: string | undefined
    verifyAccount: ((snapshot: string) => Promise<boolean>) | undefined
  }>()
  const tunnels = new Set<() => void>()
  const controllers = new Set<AbortController>()
  let closed = false
  const server = createServer(async (request, response) => {
    const rawUrl = request.url ?? ''
    let parsed: URL | undefined
    try {
      if (rawUrl.startsWith('/') && !rawUrl.startsWith('//')) parsed = new URL(rawUrl, 'http://127.0.0.1')
    } catch {}
    let route = routes.get(rawUrl), target = route?.target, responsesRequest = true
    if (!route && parsed && !/%2f|%5c/iu.test(parsed.pathname)) {
      const match = [...routes.values()].find(item =>
        item.nativeOpenAi
        && parsed.pathname.startsWith(item.basePath + '/')
      )
      if (match) {
        const suffix = parsed.pathname.slice(match.basePath.length)
        const upstream = new URL(match.target)
        upstream.pathname = upstream.pathname.slice(0, -'/responses'.length) + suffix
        upstream.search = parsed.search
        route = match
        target = upstream.href
        responsesRequest = suffix === '/responses'
      }
    }
    if (
      closed || !route || !target || !request.method || controllers.size + tunnels.size >= 32
      || (!route.nativeOpenAi && request.method !== 'POST')
      || (responsesRequest && request.method !== 'POST')
    ) {
      response.writeHead(404).end()
      return
    }
    try {
      const accountId = request.headers['chatgpt-account-id']
      if (
        route.expectedAccountDigest && (typeof accountId !== 'string'
            || createHash('sha256').update(accountId).digest('hex') !== route.expectedAccountDigest)
        || route.accountSnapshot && (!route.verifyAccount || !await route.verifyAccount(route.accountSnapshot))
      ) throw new Error('Native account changed')
    } catch {
      response.writeHead(409).end(
        JSON.stringify({ error: { message: 'Native account changed; reopen the conversation' } }),
      )
      return
    }
    const controller = new AbortController()
    controllers.add(controller)
    const timer = route.nativeStreamIdlePolicy ? undefined : setTimeout(() => controller.abort(), 300_000)
    timer?.unref()
    response.on('close', () => controller.abort())
    request.on('aborted', () => controller.abort())
    try {
      const bytes = await collect(request)
      const headers = new Headers()
      for (const [name, value] of Object.entries(request.headers)) {
        if (!HOP_HEADERS.has(name) && value !== undefined) {
          headers.set(name, Array.isArray(value) ? value.join(', ') : value)
        }
      }
      if (route.accountRoutingOverride) {
        headers.delete('x-openai-account-routing-override')
        if (route.accountRoutingOverride !== 'NO_CONSTRAINT') {
          headers.set('x-openai-account-routing-override', route.accountRoutingOverride)
        }
      }
      if (!responsesRequest) {
        const upstream = await fetch(target, {
          method: request.method,
          headers,
          ...(['GET', 'HEAD'].includes(request.method) ? {} : {
            body: new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength),
          }),
          redirect: 'manual',
          signal: controller.signal,
        })
        if (upstream.status >= 300 && upstream.status < 400) {
          await upstream.body?.cancel()
          response.writeHead(502).end(JSON.stringify({ error: { message: 'Provider redirects are not supported' } }))
        } else await forward(upstream, response)
        return
      }
      const encoding = request.headers['content-encoding']?.trim().toLowerCase()
      let body: unknown
      try {
        const decoded = encoding === 'zstd'
          ? await decompressZstd(bytes)
          : !encoding || encoding === 'identity'
          ? bytes
          : undefined
        body = decoded && JSON.parse(decoded.toString())
      } catch {
        body = undefined
      }
      // Native OpenAI requests retain their original semantics. The configured
      // provider adapter is not part of the official account's request format.
      const adapted = route.nativeOpenAi ? { invalid: false } : adaptNamedOutputs(body)
      if (adapted.invalid) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({
          error: {
            message: 'A function call output without a call_id requires a name.',
            type: 'invalid_request_error',
            param: 'input',
          },
        }))
        return
      }
      // Preserve original bytes on ordinary requests, including unknown encodings.
      // A modified or retried Zstd request retains its original content encoding.
      const encode = async (value: unknown): Promise<Buffer> => {
        const serialized = Buffer.from(JSON.stringify(value))
        return encoding === 'zstd' ? await compressZstd(serialized) : serialized
      }
      const payload = adapted.body ? await encode(adapted.body) : bytes
      const replay = encryptedReplay(adapted.body ?? body)
      const send = (payload: Buffer) =>
        fetch(target, {
          method: 'POST',
          headers,
          body: new Uint8Array(payload.buffer as ArrayBuffer, payload.byteOffset, payload.byteLength),
          redirect: 'manual',
          signal: controller.signal,
        })
      const upstream = await send(payload)
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel()
        response.writeHead(502).end(JSON.stringify({ error: { message: 'Provider redirects are not supported' } }))
        return
      }
      if (!replay) await forward(upstream, response)
      else {
        const inspected = await recoverable(upstream)
        if (inspected.retry && !controller.signal.aborted) {
          const retried = await send(await encode(replay))
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
  server.on('upgrade', (request, downstream, head) => {
    const route = routes.get(request.url ?? '')
    if (
      closed || !route?.websocket || request.method !== 'GET' || request.headers.upgrade?.toLowerCase() !== 'websocket'
      || controllers.size + tunnels.size >= 32
    ) {
      downstream.once('error', () => downstream.destroy())
      downstream.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    tunnelResponsesWebSocket(request, downstream, head, route.target, tunnels, HOP_HEADERS)
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
    route(baseUrl: string, options: ResponsesReplayRouteOptions = {}): string {
      if (closed) throw new Error('Provider transport closed')
      const upstream = new URL(baseUrl)
      if (
        upstream.username || upstream.password || upstream.search || upstream.hash
        || !['https:', 'http:'].includes(upstream.protocol)
        || (upstream.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname))
      ) throw new Error('Invalid provider endpoint')
      upstream.pathname = `${upstream.pathname.replace(/\/$/u, '')}/responses`
      const websocket = options.websocket === true
      const nativeStreamIdlePolicy = options.nativeStreamIdlePolicy === true
      const nativeOpenAi = options.nativeOpenAi === true
      const expectedAccountDigest = options.expectedAccountDigest
      const accountRoutingOverride = options.accountRoutingOverride
      const accountSnapshot = options.accountSnapshot, verifyAccount = options.verifyAccount
      if (nativeOpenAi && websocket) throw new Error('Native OpenAI recovery requires HTTP')
      if (
        (!nativeOpenAi && (expectedAccountDigest !== undefined || accountRoutingOverride !== undefined
          || accountSnapshot !== undefined || verifyAccount !== undefined))
        || (expectedAccountDigest !== undefined && !/^[a-f0-9]{64}$/u.test(expectedAccountDigest))
        || (accountRoutingOverride !== undefined && !['NO_CONSTRAINT', 'us', 'us_cr'].includes(accountRoutingOverride))
        || ((accountSnapshot === undefined) !== (verifyAccount === undefined))
      ) throw new Error('Invalid native account routing')
      const existing = [...routes].find(([, value]) =>
        value.target === upstream.href && value.websocket === websocket
        && value.nativeStreamIdlePolicy === nativeStreamIdlePolicy && value.nativeOpenAi === nativeOpenAi
        && value.expectedAccountDigest === expectedAccountDigest
        && value.accountRoutingOverride === accountRoutingOverride
        && value.accountSnapshot === accountSnapshot && value.verifyAccount === verifyAccount
      )
      if (existing) return `http://127.0.0.1:${address.port}${existing[0].slice(0, -'/responses'.length)}`
      if (routes.size >= MAX_ROUTES) throw new Error('Provider transport route limit')
      // A backend-api/codex suffix would make Codex rewrite the loopback origin
      // during workspace discovery. Native routing is captured before creating this route.
      const basePath = `/${randomBytes(32).toString('hex')}`
      const route = `${basePath}/responses`
      routes.set(route, {
        target: upstream.href,
        basePath,
        websocket,
        nativeStreamIdlePolicy,
        nativeOpenAi,
        expectedAccountDigest,
        accountRoutingOverride,
        accountSnapshot,
        verifyAccount,
      })
      return `http://127.0.0.1:${address.port}${route.slice(0, -'/responses'.length)}`
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      routes.clear()
      for (const controller of controllers) controller.abort()
      for (const close of tunnels) close()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
