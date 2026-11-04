import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { startModelApiServer } from '../packages/cli/src/launcher/model-api-server.js'

// Real loopback transport catches credential routing, streaming, resource
// methods, WebSocket frame translation and disconnect/lifetime regressions.
describe('Host model API transport', () => {
  it('routes exact catalogs and protocols, retains upstream sessions and isolates the access key', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'cordisx-model-api-'))
    const received: Array<{ method?: string; url?: string; auth?: string; body: unknown }> = []
    const upstream = createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
      received.push({ method: req.method, url: req.url, auth: req.headers.authorization, body })
      if (body?.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: {"delta":"mock"}\n\n')
        res.end('data: [DONE]\n\n')
      } else {
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'private=1' })
        res.end(
          JSON.stringify({
            id: 'response-1',
            model: body?.model,
            method: req.method,
            session: req.headers['thread-id'],
          }),
        )
      }
    })
    const websocket = new WebSocketServer({ server: upstream })
    websocket.on('connection', socket => socket.on('message', frame => socket.send(frame)))
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    let disposed = 0
    const agentCalls: unknown[] = []
    const api = await startModelApiServer({
      homeDir: home,
      profileId: 'work',
      port: 0,
      catalog: async () => [{
        providerId: 'mock',
        pluginId: 'fixture',
        models: [{ id: 'native/model', label: 'Mock', aliases: [] }],
      }],
      connect: async () => ({
        baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`,
        headers: { authorization: 'Bearer upstream-private' },
        protocols: ['openai-responses', 'openai-chat-completions', 'anthropic-messages'],
        dispose() {
          disposed++
        },
      }),
      agents: async (app, operation, args) => {
        agentCalls.push({ app, operation, args })
        return { status: 'done', operationId: 'mock-operation' }
      },
      interrupt: async () => ({ status: 'interrupted' }),
    })
    try {
      const key = (await readFile(api.accessKeyFile, 'utf8')).trim()
      expect((await stat(api.accessKeyFile)).mode & 0o077).toBe(0)
      const root = api.baseUrl.slice(0, -3),
        headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' }
      expect((await fetch(api.baseUrl + '/models')).status).toBe(401)
      expect((await fetch(api.baseUrl + '/models', { headers: { ...headers, origin: 'https://example.test' } })).status)
        .toBe(403)
      const catalog = await fetch(api.baseUrl + '/models', { headers }).then(r => r.json())
      expect(catalog.data[0].id).toBe('mock::native/model')
      expect(JSON.stringify(catalog)).not.toContain('upstream-private')
      for (
        const route of ['/responses', '/chat/completions', '/messages', '/messages/count_tokens', '/responses/compact']
      ) {
        const reply = await fetch(api.baseUrl + route, {
          method: 'POST',
          headers: { ...headers, 'thread-id': 'thread-one' },
          body: JSON.stringify({
            model: 'mock::native/model',
            input: 'test',
            tools: [{ type: 'function', name: 'mock' }],
          }),
        })
        expect(reply.status).toBe(200)
        expect(reply.headers.get('set-cookie')).toBeNull()
        expect((await reply.json()).model).toBe('native/model')
      }
      const streaming = await fetch(api.baseUrl + '/responses', {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: 'mock::native/model', stream: true }),
      })
      expect(await streaming.text()).toContain('[DONE]')
      for (
        const [route, method] of [
          ['/responses/response-1', 'GET'],
          ['/responses/response-1', 'DELETE'],
          ['/responses/response-1/cancel', 'POST'],
          ['/responses', 'GET'],
          ['/queue/status', 'GET'],
        ]
      ) {
        expect((await fetch(api.baseUrl + route + '?model=mock%3A%3Anative%2Fmodel', { method, headers })).status).toBe(
          200,
        )
      }
      expect(received.every(r => r.auth === 'Bearer upstream-private')).toBe(true)
      expect(received[0]?.body).toMatchObject({ tools: [{ name: 'mock' }] })
      expect(received.find(r => r.method === 'DELETE')?.url).toContain('model=native%2Fmodel')
      const client = new WebSocket(api.baseUrl.replace('http:', 'ws:') + '/responses', { headers })
      await new Promise<void>((resolve, reject) => {
        client.once('open', resolve)
        client.once('error', reject)
      })
      const frame = new Promise<string>(resolve => client.once('message', data => resolve(data.toString())))
      client.send(JSON.stringify({ type: 'response.create', model: 'mock::native/model', input: 'websocket' }))
      expect(JSON.parse(await frame).model).toBe('native/model')
      client.close()
      await new Promise<void>(resolve => client.once('close', () => resolve()))
      expect(
        (await fetch(root + '/agents/sessions', {
          method: 'POST',
          headers,
          body: JSON.stringify({ app: 'codex', prompt: 'mock', cwd: home }),
        })).status,
      ).toBe(200)
      expect(agentCalls[0]).toMatchObject({ operation: 'start_session', args: { prompt: 'mock' } })
      expect(disposed).toBeGreaterThanOrEqual(11)
    } finally {
      await api.close()
      websocket.close()
      upstream.closeAllConnections()
      await new Promise<void>(resolve => upstream.close(() => resolve()))
      await rm(home, { recursive: true, force: true })
    }
  })

  it('exposes Agent paging, messages, interruption and terminating operation streams over HTTP', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'cordisx-agent-api-'))
    const calls: Array<{ app: string; operation: string; args: unknown }> = []
    const interrupts: unknown[] = []
    let reads = 0
    const api = await startModelApiServer({
      homeDir: home,
      profileId: 'agents',
      port: 0,
      catalog: async () => [],
      connect: async () => {
        throw new Error('Agent tests must not call inference')
      },
      agents: async (app, operation, args) => {
        calls.push({ app, operation, args })
        if (operation === 'read_session') {
          return {
            sessionId: 'session/one',
            messages: [{ text: 'mock command output', role: 'tool' }],
            nextCursor: 'opaque-cursor',
          }
        }
        if (operation === 'check_operation') {
          return { operationId: 'operation/one', state: ++reads === 1 ? 'running' : 'done' }
        }
        return { status: 'done' }
      },
      interrupt: async (sessionId, turnId) => {
        interrupts.push({ sessionId, turnId })
        return { status: 'interrupted' }
      },
    })
    const headers = {
      authorization: `Bearer ${(await readFile(api.accessKeyFile, 'utf8')).trim()}`,
      'content-type': 'application/json',
    }
    const root = api.agentUrl
    try {
      await fetch(root + '/sessions?app=claude&limit=7&search=needle', { headers }).then(r => r.json())
      expect(calls.at(-1)).toEqual({
        app: 'claude',
        operation: 'list_sessions',
        args: { limit: 7, searchTerm: 'needle' },
      })
      const transcript = await fetch(root + '/sessions/session%2Fone?cursor=opaque-cursor', { headers })
        .then(r => r.json())
      expect(transcript.messages[0]).toMatchObject({ role: 'tool', text: 'mock command output' })
      expect(calls.at(-1)).toMatchObject({
        app: 'codex',
        operation: 'read_session',
        args: { sessionId: 'session/one', cursor: 'opaque-cursor' },
      })
      await fetch(root + '/sessions/session%2Fone/messages?app=claude', {
        method: 'POST',
        headers,
        body: JSON.stringify({ prompt: 'continue mock' }),
      }).then(r => r.json())
      expect(calls.at(-1)).toEqual({
        app: 'claude',
        operation: 'send_message',
        args: { sessionId: 'session/one', prompt: 'continue mock' },
      })
      const interrupted = await fetch(root + '/sessions/session%2Fone/interrupt', {
        method: 'POST',
        headers,
        body: JSON.stringify({ turnId: 'turn-one' }),
      }).then(r => r.json())
      expect(interrupted.status).toBe('interrupted')
      expect(interrupts).toEqual([{ sessionId: 'session/one', turnId: 'turn-one' }])
      expect(
        (await fetch(root + '/sessions/session%2Fone/interrupt?app=claude', {
          method: 'POST',
          headers,
          body: JSON.stringify({ turnId: 'turn-one' }),
        })).status,
      ).toBe(400)
      expect(
        (await fetch(root + '/rpc', {
          method: 'POST',
          headers,
          body: JSON.stringify({ app: 'codex', operation: 'invented' }),
        })).status,
      ).toBe(400)
      await fetch(root + '/rpc', {
        method: 'POST',
        headers,
        body: JSON.stringify({ app: 'claude', operation: 'list_model_providers', args: {} }),
      }).then(r => r.json())
      expect(calls.at(-1)).toEqual({ app: 'claude', operation: 'list_model_providers', args: {} })
      const operation = await fetch(root + '/operations/operation%2Fone/events', { headers })
      const events = await operation.text()
      expect(events).toContain('"state":"running"')
      expect(events).toContain('"state":"done"')
      expect(reads).toBe(2)
      const abort = new AbortController()
      const stream = await fetch(root + '/sessions/session%2Fone/events', { headers, signal: abort.signal })
      const reader = stream.body!.getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('mock command output')
      abort.abort()
      await reader.cancel().catch(() => undefined)
    } finally {
      await api.close()
      await rm(home, { recursive: true, force: true })
    }
  })
})
