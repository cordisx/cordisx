import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import {
  encryptedContentError,
  encryptedReplay,
  startResponsesEncryptedReplay,
} from '../packages/cli/src/launcher/responses-encrypted-replay.js'

const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
})
const body = {
  model: 'test-model',
  stream: true,
  store: false,
  input: [
    { type: 'message', role: 'user', content: 'original question' },
    { id: 'foreign-reasoning', type: 'reasoning', encrypted_content: 'foreign-ciphertext', summary: [] },
    { type: 'function_call', call_id: 'call-1', name: 'lookup', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call-1', output: 'result' },
    { type: 'message', role: 'assistant', content: 'visible answer' },
    { type: 'message', role: 'user', content: 'next question' },
  ],
}
const failure = { code: 'invalid_encrypted_content', message: 'Ciphertext cannot be decrypted' }
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`

async function fixture(handler: Parameters<typeof createServer>[0]) {
  const server: Server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  disposers.push(() =>
    new Promise<void>(resolve => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  )
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  const recovery = await startResponsesEncryptedReplay()
  disposers.push(() => recovery.close())
  return { recovery, url: `${recovery.route(`http://127.0.0.1:${address.port}/v1`)}/responses` }
}

describe('encrypted Responses replay', () => {
  it('keeps original history, visible messages, tool associations and request fields', () => {
    const original = JSON.stringify(body)
    const replay = encryptedReplay(body)!
    expect(replay.input).toEqual(body.input.filter(item => item.type !== 'reasoning'))
    expect(replay.model).toBe(body.model)
    expect(JSON.stringify(body)).toBe(original)
    expect(encryptedReplay({ ...body, previous_response_id: 'remote-history' })).toBeUndefined()
    expect(encryptedReplay({ input: [{ type: 'reasoning', summary: [] }] })).toBeUndefined()
  })

  it('recognizes only exact canonical or wrapped encrypted errors', () => {
    expect(encryptedContentError(failure)).toBe(true)
    expect(encryptedContentError({ code: '-4003', message: 'code: invalid_encrypted_content; message: failed' })).toBe(
      true,
    )
    expect(encryptedContentError({ code: 'other', message: 'invalid_encrypted_content' })).toBe(false)
    expect(encryptedContentError({ code: '-4003', message: 'credentials invalid' })).toBe(false)
    expect(encryptedContentError('invalid_encrypted_content')).toBe(false)
  })

  for (const format of ['http', 'wrapped-http', 'sse', 'wrapped-sse']) {
    it(`retries ${format} exactly once, preserving auth and visible/tool history`, async () => {
      const requests: { body: typeof body; authorization: string | undefined; path: string | undefined }[] = []
      const { url } = await fixture(async (request, response) => {
        let payload = ''
        for await (const chunk of request) payload += chunk
        requests.push({ body: JSON.parse(payload), authorization: request.headers.authorization, path: request.url })
        const error = format.startsWith('wrapped')
          ? { code: '-4003', message: 'code: invalid_encrypted_content; message: failed' }
          : failure
        if (requests.length === 1) {
          if (format.endsWith('http')) {
            response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error }))
          } else {
            response.writeHead(200, { 'content-type': 'text/event-stream' })
            response.write(event({ type: 'response.created', response: { output: [] } }))
            const bytes = event({ type: 'response.failed', response: { error } })
            response.write(bytes.slice(0, 23))
            response.end(bytes.slice(23))
          }
        } else {response.writeHead(200, { 'content-type': 'text/event-stream' }).end(
            event({ type: 'response.completed', response: { output: [] } }),
          )}
      })
      const result = await fetch(url, {
        method: 'POST',
        headers: { authorization: 'Bearer original-native-token', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(await result.text()).toContain('response.completed')
      expect(requests).toHaveLength(2)
      expect(requests[0]!.body).toEqual(body)
      expect(requests[1]!.body).toEqual(encryptedReplay(body))
      expect(requests.map(item => item.authorization)).toEqual([
        'Bearer original-native-token',
        'Bearer original-native-token',
      ])
      expect(requests.map(item => item.path)).toEqual(['/v1/responses', '/v1/responses'])
    })
  }

  it('does not loop if the sanitized replay also fails', async () => {
    let requests = 0
    const { url } = await fixture((request, response) => {
      request.resume()
      requests++
      response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: failure }))
    })
    const result = await fetch(url, { method: 'POST', body: JSON.stringify(body) })
    expect(result.status).toBe(400)
    expect(await result.json()).toEqual({ error: failure })
    expect(requests).toBe(2)
  })

  for (
    const output of [
      { type: 'response.output_text.delta', delta: 'already visible' },
      { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'effect' } },
      { type: 'unknown.future.output' },
    ]
  ) {
    it(`never retries after ${output.type}`, async () => {
      let requests = 0
      const payload = event(output) + event({ type: 'response.failed', response: { error: failure } })
      const { url } = await fixture((request, response) => {
        request.resume()
        requests++
        response.writeHead(200, { 'content-type': 'text/event-stream' }).end(payload)
      })
      expect(await (await fetch(url, { method: 'POST', body: JSON.stringify(body) })).text()).toBe(payload)
      expect(requests).toBe(1)
    })
  }

  it('does not recover a failed response that already contains output', async () => {
    let requests = 0
    const payload = event({
      type: 'response.failed',
      response: { error: failure, output: [{ type: 'function_call', call_id: 'effect' }] },
    })
    const { url } = await fixture((request, response) => {
      request.resume()
      requests++
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end(payload)
    })
    expect(await (await fetch(url, { method: 'POST', body: JSON.stringify(body) })).text()).toBe(payload)
    expect(requests).toBe(1)
  })

  it('passes unrelated errors unchanged', async () => {
    let requests = 0
    const payload = JSON.stringify({ error: { code: 'invalid_api_key', message: 'no access' } })
    const { url } = await fixture((request, response) => {
      request.resume()
      requests++
      response.writeHead(401).end(payload)
    })
    const result = await fetch(url, { method: 'POST', body: JSON.stringify(body) })
    expect(result.status).toBe(401)
    expect(await result.text()).toBe(payload)
    expect(requests).toBe(1)
  })

  it('rejects guessed routes, remote HTTP and redirects without leaking credentials', async () => {
    const { url, recovery } = await fixture((request, response) => {
      request.resume()
      response.writeHead(302, { location: 'https://invalid.example' }).end()
    })
    expect(() => recovery.route('http://remote.example/v1')).toThrow()
    expect(() => recovery.route('https://user:password@example.com/v1')).toThrow()
    expect((await fetch(url.replace(/\/[a-f0-9]+\//u, '/guessed/'), { method: 'POST' })).status).toBe(404)
    expect((await fetch(url, { method: 'POST', body: JSON.stringify(body), redirect: 'manual' })).status).toBe(502)
  })

  it('aborts an upstream prelude and does not retry when the caller cancels', async () => {
    let requests = 0
    let upstreamClosed = false
    let notify: () => void = () => {}
    const started = new Promise<void>(resolve => {
      notify = resolve
    })
    const { url } = await fixture((request, response) => {
      request.resume()
      requests++
      response.on('close', () => {
        upstreamClosed = true
      })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(event({ type: 'response.created', response: { output: [] } }))
      notify()
    })
    const controller = new AbortController()
    const pending = fetch(url, { method: 'POST', body: JSON.stringify(body), signal: controller.signal }).catch(error =>
      error
    )
    await started
    controller.abort()
    await pending
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(upstreamClosed).toBe(true)
    expect(requests).toBe(1)
  })

  it('isolates concurrent request replay and closes active streams', async () => {
    const requests = new Map<string, number>()
    const { url, recovery } = await fixture(async (request, response) => {
      let payload = ''
      for await (const chunk of request) payload += chunk
      const input = JSON.parse(payload)
      const identity = input.model as string
      requests.set(identity, (requests.get(identity) ?? 0) + 1)
      if (input.input.some((item: { encrypted_content?: string }) => item.encrypted_content)) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: failure }))
      } else response.writeHead(200).end(identity)
    })
    const result = await Promise.all(
      ['first', 'second'].map(async model =>
        (await fetch(url, { method: 'POST', body: JSON.stringify({ ...body, model }) })).text()
      ),
    )
    expect(result).toEqual(['first', 'second'])
    expect([...requests.values()]).toEqual([2, 2])
    await recovery.close()
    await expect(fetch(url, { method: 'POST' })).rejects.toThrow()
  })
})
