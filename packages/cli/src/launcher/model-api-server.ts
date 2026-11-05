import { createServer, type IncomingMessage, request as httpRequest, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { NativeModelProviderCatalogEntry } from './native-model-provider-catalog.js'
import { safeDiagnosticMessage } from './diagnostic-redaction.js'
import { type BridgeApp, type BridgeOperation, isBridgeApp, isBridgeOperation } from './agent-bridge-contract.js'

export interface ModelApiConnection {
  readonly baseUrl: string
  readonly headers: Readonly<Record<string, string>>
  readonly protocols?: readonly string[]
  dispose(): void
}

export interface ModelApiServerOptions {
  readonly homeDir: string
  readonly profileId: string
  readonly port?: number
  readonly catalog: () => Promise<readonly NativeModelProviderCatalogEntry[]>
  readonly connect: (providerId: string, modelId: string, signal: AbortSignal) => Promise<ModelApiConnection>
  readonly agents?: (app: BridgeApp, operation: BridgeOperation, args: unknown) => Promise<unknown>
  readonly invocation?: (providerId: string) => 'model' | 'agent'
  readonly interrupt?: (threadId: string, turnId: string) => Promise<unknown>
}

function json(res: ServerResponse, status: number, value: unknown) {
  if (res.headersSent) {
    res.destroy()
    return
  }
  if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > 32 * 1024 * 1024) throw new Error('Request exceeds 32 MiB')
    chunks.push(chunk)
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString())
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A JSON object is required')
  return value as Record<string, unknown>
}

function authorized(req: IncomingMessage, key: string) {
  const supplied = String(req.headers.authorization ?? '').replace(/^Bearer /, '')
    || String(req.headers['x-api-key'] ?? '')
  const expected = Buffer.from(key)
  const actual = Buffer.from(supplied)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export async function startModelApiServer(options: ModelApiServerOptions) {
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) {
    throw new Error('Invalid model API port')
  }
  const directory = path.join(options.homeDir, 'run', 'model-api', options.profileId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const keyFile = path.join(directory, 'access-key')
  let key: string
  try {
    key = (await readFile(keyFile, 'utf8')).trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    key = `cx_${randomBytes(32).toString('hex')}`
    try {
      await writeFile(keyFile, `${key}\n`, { mode: 0o600, flag: 'wx' })
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure
      key = (await readFile(keyFile, 'utf8')).trim()
    }
  }
  if (!/^cx_[0-9a-f]{64}$/.test(key)) throw new Error('Model API access key is invalid')
  const requests = new Set<AbortController>()
  const bindingPath = path.join(directory, 'server.json')
  const server = createServer((req, res) => {
    const abort = new AbortController()
    requests.add(abort)
    res.on('close', () => {
      abort.abort()
      requests.delete(abort)
    })
    void handle(req, res, abort.signal).catch(error => {
      json(res, 400, { error: { type: 'cordisx_api_error', message: safeDiagnosticMessage(error) } })
    })
  })
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 })
  server.on('upgrade', (req, socket, head) => {
    if (
      req.headers.origin || !authorized(req, key)
      || new URL(req.url ?? '/', 'http://localhost').pathname !== '/v1/responses'
    ) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      return
    }
    sockets.handleUpgrade(req, socket, head, client => {
      const abort = new AbortController()
      let upstream: WebSocket | undefined
      let connection: ModelApiConnection | undefined
      let selected: string | undefined
      let serial = Promise.resolve()
      const dispose = () => {
        abort.abort()
        upstream?.terminate()
        connection?.dispose()
        connection = undefined
      }
      client.on('close', dispose)
      client.on('error', () => client.terminate())
      client.on('message', (data, binary) => {
        serial = serial.then(async () => {
          if (binary) throw new Error('JSON text frame required')
          const frame = JSON.parse(data.toString()) as Record<string, unknown>
          if (frame.type !== 'response.create') throw new Error('response.create required')
          const model = typeof frame.model === 'string' ? frame.model : selected
          if (!model || !model.includes('::')) throw new Error('provider::model required in first frame')
          const separator = model.indexOf('::')
          const providerId = model.slice(0, separator), modelId = model.slice(separator + 2)
          if (selected && selected !== model) throw new Error('Open a new WebSocket to switch models')
          if (!selected) {
            const provider = (await options.catalog()).find(p => p.providerId === providerId)
            if (!provider?.models.some(m => m.id === modelId)) throw new Error('Unknown provider/model')
            connection = await options.connect(providerId, modelId, abort.signal)
            abort.signal.throwIfAborted()
            if (connection.protocols && !connection.protocols.includes('openai-responses')) {
              throw new Error('Responses unavailable')
            }
            const target = new URL(`${connection.baseUrl.replace(/\/$/, '')}/responses`)
            target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
            upstream = new WebSocket(target, { headers: connection.headers, maxPayload: 32 * 1024 * 1024 })
            upstream.on('message', (message, isBinary) => {
              if (client.readyState === WebSocket.OPEN) client.send(message, { binary: isBinary })
            })
            upstream.on('close', (code, reason) => client.close(code === 1006 ? 1011 : code, reason))
            await new Promise<void>((resolve, reject) => {
              upstream!.once('open', resolve)
              upstream!.once('error', reject)
              abort.signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true })
            })
            upstream.on('error', () => client.close(1011, 'Upstream socket failed'))
            selected = model
          }
          upstream!.send(JSON.stringify({ ...frame, model: modelId }))
        }).catch(error => {
          if (!selected) {
            upstream?.terminate()
            connection?.dispose()
            connection = undefined
            upstream = undefined
          }
          if (client.readyState === WebSocket.OPEN) {
            client.send(
              JSON.stringify({ type: 'error', status: 400, error: { message: safeDiagnosticMessage(error) } }),
            )
          }
        })
      })
    })
  })
  async function handle(req: IncomingMessage, res: ServerResponse, signal: AbortSignal) {
    if (req.headers.origin) {
      json(res, 403, { error: { message: 'Browser cross-origin access is not enabled' } })
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/healthz' && req.method === 'GET') {
      json(res, 200, {
        status: 'ok',
        profile: options.profileId,
        ...(options.agents ? {} : { mode: 'service', agents: 'unavailable' }),
      })
      return
    }
    if (!authorized(req, key)) {
      json(res, 401, { error: { message: 'Local API access key required' } })
      return
    }
    if (url.pathname === '/v1/models' && req.method === 'GET') {
      const providers = await options.catalog()
      json(res, 200, {
        object: 'list',
        data: providers.flatMap(provider =>
          provider.models.map(model => ({
            id: `${provider.providerId}::${model.id}`,
            object: 'model',
            owned_by: provider.providerId,
            provider_id: provider.providerId,
            model_id: model.id,
            display_name: model.label,
            invocation: options.invocation?.(provider.providerId)
              ?? (provider.providerId === 'openai' ? 'agent' : 'model'),
          }))
        ),
      })
      return
    }
    if (!options.agents && (url.pathname === '/agents' || url.pathname.startsWith('/agents/'))) {
      json(res, 503, {
        error: { code: 'agent-unavailable', message: 'Desktop and Agent capabilities are unavailable in service mode' },
      })
      return
    }
    if (url.pathname === '/agents/sessions' && req.method === 'GET') {
      const app = url.searchParams.get('app') ?? 'codex'
      if (!isBridgeApp(app)) throw new Error('Unknown agent app')
      json(
        res,
        200,
        await options.agents!(app, 'list_sessions', {
          limit: Number(url.searchParams.get('limit') ?? 20),
          searchTerm: url.searchParams.get('search') ?? undefined,
        }),
      )
      return
    }
    if (url.pathname === '/agents/sessions' && req.method === 'POST') {
      const input = await body(req)
      const app = input.app ?? 'codex'
      if (!isBridgeApp(app)) throw new Error('Unknown agent app')
      const { app: ignored, ...args } = input
      json(res, 200, await options.agents!(app, 'start_session', args))
      return
    }
    if (url.pathname === '/agents/rpc' && req.method === 'POST') {
      const input = await body(req)
      if (!isBridgeApp(input.app) || !isBridgeOperation(input.operation)) throw new Error('Unknown agent operation')
      json(res, 200, await options.agents!(input.app, input.operation, input.args))
      return
    }
    const session = /^\/agents\/sessions\/([^/]+)(?:\/(messages|interrupt|events))?$/.exec(url.pathname)
    if (session) {
      const sessionId = decodeURIComponent(session[1]!)
      const app = url.searchParams.get('app') ?? 'codex'
      if (!isBridgeApp(app)) throw new Error('Unknown agent app')
      if (session[2] === 'events' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
        let previous = ''
        while (!signal.aborted) {
          const snapshot = await options.agents!(app, 'read_session', { sessionId, limit: 200 })
          const encoded = JSON.stringify(snapshot)
          if (encoded !== previous) {
            res.write(`event: transcript\ndata: ${encoded}\n\n`)
            previous = encoded
          }
          await new Promise<void>(resolve => {
            const timer = setTimeout(done, 500)
            function done() {
              clearTimeout(timer)
              signal.removeEventListener('abort', done)
              resolve()
            }
            if (signal.aborted) done()
            else signal.addEventListener('abort', done, { once: true })
          })
        }
        res.end()
      } else if (!session[2] && req.method === 'GET') {
        json(
          res,
          200,
          await options.agents!(app, 'read_session', {
            sessionId,
            cursor: url.searchParams.get('cursor') ?? undefined,
          }),
        )
      } else if (session[2] === 'messages' && req.method === 'POST') {
        json(res, 200, await options.agents!(app, 'send_message', { ...await body(req), sessionId }))
      } else if (session[2] === 'interrupt' && req.method === 'POST') {
        const input = await body(req)
        if (app !== 'codex' || typeof input.turnId !== 'string') throw new Error('Codex turnId required')
        json(res, 200, await options.interrupt!(sessionId, input.turnId))
      } else json(res, 405, { error: { message: 'Method unavailable' } })
      return
    }
    const operation = /^\/agents\/operations\/([^/]+)(?:\/(events))?$/.exec(url.pathname)
    if (operation && req.method === 'GET') {
      const app = url.searchParams.get('app') ?? 'codex'
      if (!isBridgeApp(app)) throw new Error('Unknown agent app')
      const operationId = decodeURIComponent(operation[1]!)
      if (!operation[2]) {
        json(res, 200, await options.agents!(app, 'check_operation', { operationId }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      let previous = ''
      while (!signal.aborted) {
        const status = await options.agents!(app, 'check_operation', { operationId }) as Record<string, unknown>
        const encoded = JSON.stringify(status)
        if (encoded !== previous) {
          res.write(`event: status\ndata: ${encoded}\n\n`)
          previous = encoded
        }
        if (
          status.status === 'done' || status.status === 'failed' || status.state === 'done' || status.state === 'failed'
        ) break
        await new Promise<void>(resolve => {
          const timer = setTimeout(done, 1_000)
          function done() {
            clearTimeout(timer)
            signal.removeEventListener('abort', done)
            resolve()
          }
          signal.addEventListener('abort', done, { once: true })
        })
      }
      res.end()
      return
    }
    const route = [
      '/v1/responses',
      '/v1/chat/completions',
      '/v1/messages',
      '/v1/messages/count_tokens',
      '/v1/responses/compact',
    ]
    const resource = /^\/v1\/responses(?:\/[^/]+(?:\/cancel)?)?$/.test(url.pathname)
      || url.pathname === '/v1/queue/status'
    if (
      !(route.includes(url.pathname) && req.method === 'POST')
      && !(resource && ['GET', 'DELETE', 'POST'].includes(req.method ?? ''))
    ) {
      json(res, 404, { error: { message: 'Unknown API route' } })
      return
    }
    const input = route.includes(url.pathname) && req.method === 'POST'
      ? await body(req)
      : { model: url.searchParams.get('model'), provider: url.searchParams.get('provider') }
    if (typeof input.model !== 'string') throw new Error('model is required')
    const split = input.model.indexOf('::')
    const providerId = typeof input.provider === 'string' ? input.provider : input.model.slice(0, split)
    const modelId = split >= 0 ? input.model.slice(split + 2) : input.model
    if (!providerId || split < 0 && typeof input.provider !== 'string') {
      throw new Error('Use provider::model from /v1/models, or pass provider explicitly')
    }
    const provider = (await options.catalog()).find(p => p.providerId === providerId)
    if (!provider?.models.some(m => m.id === modelId)) throw new Error('Unknown or unavailable provider/model')
    const connection = await options.connect(providerId, modelId, signal)
    try {
      const protocol = url.pathname.startsWith('/v1/messages')
        ? 'anthropic-messages'
        : url.pathname.startsWith('/v1/chat')
        ? 'openai-chat-completions'
        : 'openai-responses'
      if (connection.protocols && !connection.protocols.includes(protocol)) {
        throw new Error('Selected service does not support this protocol')
      }
      const { provider: ignored, ...payload } = input
      const bytes = Buffer.from(JSON.stringify({ ...payload, model: modelId }))
      const target = new URL(`${connection.baseUrl.replace(/\/$/, '')}/${url.pathname.slice('/v1/'.length)}`)
      target.search = url.search
      target.searchParams.set('model', modelId)
      target.searchParams.delete('provider')
      const headers: Record<string, string> = { 'content-type': 'application/json', ...connection.headers }
      if (req.method === 'POST') headers['content-length'] = String(bytes.length)
      for (
        const name of [
          'anthropic-version',
          'anthropic-beta',
          'x-aiden-session-id',
          'session_id',
          'session-id',
          'x-session-id',
          'thread-id',
          'conversation_id',
          'x-claude-code-session-id',
          'x-claude-code-agent-id',
          'x-codex-turn-metadata',
        ]
      ) {
        const value = req.headers[name]
        if (typeof value === 'string') headers[name] = value
      }
      await new Promise<void>((resolve, reject) => {
        const upstream = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
          method: req.method,
          headers,
          signal,
        }, reply => {
          const outputHeaders = { ...reply.headers }
          delete outputHeaders['set-cookie']
          for (
            const name of [
              'connection',
              'keep-alive',
              'proxy-authenticate',
              'proxy-authorization',
              'trailer',
              'upgrade',
            ]
          ) delete outputHeaders[name]
          res.writeHead(reply.statusCode ?? 502, outputHeaders)
          Readable.from(reply).pipe(res)
          reply.on('end', resolve)
          reply.on('error', reject)
        })
        upstream.on('error', reject)
        upstream.end(req.method === 'POST' ? bytes : undefined)
      })
    } finally {
      connection.dispose()
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 8398, '127.0.0.1', resolve)
  }).catch((error: NodeJS.ErrnoException) => {
    sockets.close()
    if (error.code === 'EADDRINUSE') {
      throw new Error(`Model API port 127.0.0.1:${options.port ?? 8398} is already in use (EADDRINUSE)`, {
        cause: error,
      })
    }
    throw error
  })
  const port = (server.address() as { port: number }).port
  const binding = {
    pid: process.pid,
    profileId: options.profileId,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    ...(options.agents ? { agentUrl: `http://127.0.0.1:${port}/agents` } : { mode: 'service' as const }),
    accessKeyFile: keyFile,
  }
  try {
    await writeFile(bindingPath, JSON.stringify(binding) + '\n', { mode: 0o600 })
  } catch (error) {
    sockets.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    throw error
  }
  return {
    ...binding,
    async close() {
      sockets.clients.forEach(client => client.terminate())
      sockets.close()
      requests.forEach(request => request.abort())
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      try {
        if (JSON.parse(await readFile(bindingPath, 'utf8')).pid === process.pid) await rm(bindingPath)
      } catch { /* retired */ }
    },
  }
}
