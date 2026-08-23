import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { JsonLineRpcClient } from '../packages/cli/src/providers/json-line-rpc.js'

function line(stream: PassThrough): Promise<Record<string, unknown>> {
  return new Promise(resolve => stream.once('data', chunk => resolve(JSON.parse(String(chunk)) as Record<string, unknown>)))
}

describe('JSON-line RPC client', () => {
  it('correlates responses and fails closed on peer requests', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const client = new JsonLineRpcClient({ input, output, timeoutMs: 1_000 })
    const first = client.request<{ value: number }>('model/list', { limit: 1 })
    const request = await line(output)
    expect(request).toMatchObject({ method: 'model/list', params: { limit: 1 } })
    input.write(`${JSON.stringify({ id: request.id, result: { value: 7 } })}\n`)
    await expect(first).resolves.toEqual({ value: 7 })

    const rejection = line(output)
    input.write(`${JSON.stringify({ id: 99, method: 'server/private', params: { secret: true } })}\n`)
    await expect(rejection).resolves.toEqual({ id: 99, error: { code: -32601, message: 'Method not found' } })
    client.close()
  })

  it('rejects pending calls after malformed or oversized input', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const client = new JsonLineRpcClient({ input, output, timeoutMs: 1_000, maxLineBytes: 64 })
    const pending = client.request('thread/list', {})
    await line(output)
    input.write('{bad json}\n')
    await expect(pending).rejects.toThrow('malformed JSON')
    await expect(client.request('thread/list', {})).rejects.toThrow('closed')
  })
})
