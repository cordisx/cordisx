import { spawn } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { expect, it } from 'vitest'
import { createNativeProviderTransport } from '../packages/cli/assets/launcher/native-provider-transport.mjs'
import { nativeProviderFailure } from '../packages/cli/assets/launcher/native-provider-errors.mjs'

it('keeps native provider identity per connection, preserves history ids and namespaces approval replies', async () => {
  const args = [path.resolve('tests/fixtures/native-provider-process.mjs'), 'app-server']
  const primary = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })
  const closed = once(primary, 'close')
  const transport = createNativeProviderTransport(primary, { executable: process.execPath, args, env: process.env })
  const lines = createInterface({ input: transport.stdout })
  const replies: any[] = []
  const waiting: ((value: any) => void)[] = []
  lines.on('line', line => {
    const reply = JSON.parse(line)
    const receive = waiting.shift()
    if (receive) receive(reply)
    else replies.push(reply)
  })
  const read = () => replies.length ? Promise.resolve(replies.shift()) : new Promise(resolve => waiting.push(resolve))
  const send = (message: unknown) => transport.stdin.write(JSON.stringify(message) + '\n')
  const approvalIds: string[] = []
  try {
    send({ id: 'init', method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } })
    expect((await read()).id).toBe('init')
    for (const provider of ['provider-a', 'provider.b']) {
      send({
        id: `start-${provider}`,
        method: 'thread/start',
        params: {
          modelProvider: provider,
          config: {
            model_provider: provider,
            [`model_providers.${provider}`]: {
              wire_api: 'responses',
              base_url: 'http://127.0.0.1:1234/v1',
              experimental_bearer_token: 'test-private-token',
            },
          },
        },
      })
      const start = await read()
      expect(start.result.modelProvider).toBe(provider)
      expect(start.result.argvHasSecret).toBe(false)
      const threadId = start.result.thread.id
      send({ id: `turn-${provider}`, method: 'turn/start', params: { threadId, input: [] } })
      expect((await read()).result.current).toBe(provider)
      send({ id: `approval-${provider}`, method: 'fixture/approval', params: { threadId } })
      const approval = await read()
      expect(approval.method).toBe('item/commandExecution/requestApproval')
      approvalIds.push(approval.id)
      send({ id: approval.id, result: { decision: 'decline' } })
      expect((await read()).result).toEqual({ current: provider, approved: { decision: 'decline' } })
      send({
        id: `resume-${provider}`,
        method: 'thread/resume',
        params: {
          threadId: `saved-${provider}`,
          config: { [`model_providers.${provider}`]: { wire_api: 'responses' } },
        },
      })
      expect((await read()).result.thread.id).toBe(`saved-${provider}`)
    }
    expect(new Set(approvalIds).size).toBe(2)
    send({ id: 'primary', method: 'config/read', params: {} })
    expect((await read()).result.current).toBe('openai')
    expect(transport.workers().map((worker: { providerId: string }) => worker.providerId))
      .toEqual(['provider-a', 'provider.b'])
    const workerPids = transport.workers().map((worker: { pid: number }) => worker.pid)
    send({ id: 'exit-worker', method: 'fixture/exit', params: { threadId: 'saved-provider-a' } })
    expect((await read()).error.message).toContain('Check thread history')
    expect(transport.workers().map((worker: { providerId: string }) => worker.providerId)).toEqual(['provider.b'])
    send({ id: 'primary-after-exit', method: 'config/read', params: {} })
    expect((await read()).result.current).toBe('openai')
    transport.close()
    for (const pid of workerPids) {
      for (let attempts = 0; attempts < 100; attempts++) {
        try {
          process.kill(pid, 0)
        } catch {
          break
        }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(() => process.kill(pid, 0)).toThrow()
    }
  } finally {
    transport.close()
    primary.kill('SIGTERM')
    lines.close()
    await closed
  }
})

it('recognizes only exact structured pre-turn provider failures and preserves policy errors', () => {
  expect(
    nativeProviderFailure({
      error: { code: -32600, data: { type: 'modelProviderNotConfigured', modelProvider: 'provider' } },
    }),
  ).toBe('provider')
  const mismatch = {
    code: -32600,
    data: { type: 'modelProviderMismatch', modelProvider: 'provider', currentModelProvider: 'openai' },
  }
  expect(nativeProviderFailure({ error: mismatch })).toBe('provider')
  expect(nativeProviderFailure({ error: { ...mismatch, code: -32000 } })).toBeUndefined()
  expect(
    nativeProviderFailure({
      error: { code: -32600, data: { type: 'modelProviderPolicyConflict', modelProvider: 'provider' } },
    }),
  ).toBeUndefined()
})
