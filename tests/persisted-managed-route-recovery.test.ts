import { describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { startResponsesEncryptedReplay } from '../packages/cli/src/launcher/responses-encrypted-replay.js'
import { harness } from './fixtures/native-intermediary-harness.js'

// Regression: a recognized historical provider table must also acquire the
// current managed routing lease, not only a missing-provider resume.
describe('persisted managed provider resume routing', () => {
  it('refreshes a recognized persisted managed endpoint before native resume', async () => {
    const h = await harness()
    try {
      const configured = vi.fn(async () => ({}))
      h.server.bindConfiguredProvider(configured)
      const historical = {
        name: 'Old Aiden entry',
        base_url: 'https://upstream.example/v1',
        wire_api: 'responses',
        requires_openai_auth: false,
      }
      h.send({
        id: 'known-provider',
        method: 'thread/resume',
        params: { threadId: 'recognized-managed-thread', config: { 'model_providers.provider-b': historical } },
      })
      const received = JSON.parse(await h.read())
      expect(received.result.received.config['model_providers.provider-b'].base_url).toBe('http://127.0.0.1/v1')
      expect(configured).not.toHaveBeenCalled()
      expect(h.prepareThreadResume).toHaveBeenCalledWith({
        threadId: 'recognized-managed-thread',
        providerId: 'provider-b',
        model: 'model-b',
        managedOnly: true,
      })
      expect(h.completeThreadResume).toHaveBeenCalledWith({
        threadId: 'recognized-managed-thread',
        resumeToken: 'resume-token-recognized-managed-thread',
        succeeded: true,
      })
      h.send({
        id: 'continued',
        method: 'turn/start',
        params: { threadId: 'recognized-managed-thread', input: [{ type: 'text', text: 'test continuation' }] },
      })
      expect(JSON.parse(await h.read()).result.received).not.toHaveProperty('config')
    } finally {
      await h.close()
    }
  })
  it('joins restored managed routing to a single encrypted replay without altering visible/tool history', async () => {
    const requests: any[] = []
    const upstream = createServer(async (request, response) => {
      let raw = ''
      for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw)
      requests.push({ body, auth: request.headers.authorization })
      if (body.input.some((item: any) => item.type === 'reasoning')) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({
          error: {
            code: '-4003',
            message: 'code: invalid_encrypted_content; message: cannot decrypt',
          },
        }))
      } else response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ reply: 'recovered' }))
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('missing test address')
    const recovery = await startResponsesEncryptedReplay()
    const h = await harness()
    try {
      h.prepareThreadResume.mockResolvedValue({
        kind: 'resume',
        resumeToken: 'synthetic-replay-resume-token',
        configOverrides: {
          'model_providers.provider-b': {
            base_url: recovery.route(`http://127.0.0.1:${address.port}/v1`),
            wire_api: 'responses',
          },
        },
      })
      h.send({
        id: 'resume-replay',
        method: 'thread/resume',
        params: {
          threadId: 'recognized-managed-replay',
          config: { 'model_providers.provider-b': { base_url: 'https://old.example/v1' } },
        },
      })
      expect(JSON.parse(await h.read()).id).toBe('resume-replay')
      const body = {
        model: 'original-model',
        store: false,
        input: [
          { type: 'message', role: 'user', content: 'visible history' },
          { type: 'reasoning', encrypted_content: 'foreign-synthetic-ciphertext', summary: [] },
          { type: 'function_call', call_id: 'tool-call', name: 'lookup', arguments: '{}' },
          { type: 'function_call_output', call_id: 'tool-call', output: 'result' },
          { type: 'message', role: 'user', content: 'continue' },
        ],
      }
      h.send({
        id: 'continued-replay',
        method: 'turn/start',
        params: { threadId: 'recognized-managed-replay', request: body },
      })
      expect(JSON.parse(await h.read())).toMatchObject({
        id: 'continued-replay',
        result: { status: 200, received: { reply: 'recovered' } },
      })
      expect(requests).toHaveLength(2)
      expect(requests[0].body).toEqual(body)
      expect(requests[1].body).toEqual({ ...body, input: body.input.filter(item => item.type !== 'reasoning') })
      expect(requests.map(request => request.auth)).toEqual(['Bearer synthetic-auth', 'Bearer synthetic-auth'])
    } finally {
      await h.close()
      await recovery.close()
      upstream.closeAllConnections()
      await new Promise<void>(resolve => upstream.close(() => resolve()))
    }
  })

  it('disposes only the candidate lease when native resume fails, preserving the native error', async () => {
    const h = await harness()
    try {
      h.send({ id: 'denied', method: 'thread/resume', params: { threadId: 'recognized-managed-failed' } })
      expect(JSON.parse(await h.read())).toEqual({
        id: 'denied',
        error: { code: -32001, message: 'native resume denied' },
      })
      expect(h.prepareThreadResume).toHaveBeenCalledTimes(1)
      expect(h.completeThreadResume).toHaveBeenCalledWith({
        threadId: 'recognized-managed-failed',
        resumeToken: 'resume-token-recognized-managed-failed',
        succeeded: false,
      })
      h.send({ id: 'still-running', method: 'echo/bytes', params: {} })
      expect(JSON.parse(await h.read()).id).toBe('still-running')
    } finally {
      await h.close()
    }
  })
})
