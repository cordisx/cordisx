import { spawn } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { expect, it } from 'vitest'
import { createNativeProviderTransport } from '../packages/cli/assets/launcher/native-provider-transport.mjs'
import { nativeProviderFailure } from '../packages/cli/assets/launcher/native-provider-errors.mjs'
import { harness } from './fixtures/native-intermediary-harness.js'
import { createHash } from 'node:crypto'

it('keeps native provider identity per connection, preserves history ids and namespaces approval replies', async () => {
  const args = [path.resolve('tests/fixtures/native-provider-process.mjs'), 'app-server']
  const primary = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })
  const closed = once(primary, 'close')
  const diagnostics: unknown[] = []
  const transport = createNativeProviderTransport(primary, {
    executable: process.execPath,
    args,
    env: process.env,
    diagnostic: (event: unknown) => diagnostics.push(event),
  })
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
      send({ id: `cancelled-approval-${provider}`, method: 'fixture/approval', params: { threadId } })
      const cancelledApproval = await read()
      send({ id: `cancel-${provider}`, method: 'fixture/cancel-approval', params: { threadId } })
      expect(await read()).toEqual({
        method: 'serverRequest/resolved',
        params: { requestId: cancelledApproval.id, threadId },
      })
      expect((await read()).error.message).toBe('approval cancelled')
      expect((await read()).result).toEqual({ cancelled: true })
      send({ id: cancelledApproval.id, result: { decision: 'accept' } })
      send({ id: `after-cancel-${provider}`, method: 'config/read', params: {} })
      expect((await read()).id).toBe(`after-cancel-${provider}`)
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
    // Fork uses the destination connection even though the source belongs to another one.
    // Subsequent native requests must use the new owner without carrying another config override.
    send({ id: 'official-source', method: 'thread/start', params: { modelProvider: 'openai' } })
    const originalThreadId = (await read()).result.thread.id
    let latestThreadId = originalThreadId
    for (const provider of ['provider-a', 'provider.b', 'openai', 'provider.b', 'provider-a', 'openai']) {
      const sourceThreadId = latestThreadId
      send({
        id: `fork-${sourceThreadId}`,
        method: 'thread/fork',
        params: {
          threadId: sourceThreadId,
          modelProvider: provider,
          model: 'test-model',
          ephemeral: false,
          excludeTurns: true,
          deferGoalContinuation: true,
          config: provider === 'openai' ? {} : {
            [`model_providers.${provider}`]: {
              wire_api: 'responses',
              base_url: 'http://127.0.0.1:1234/v1',
              experimental_bearer_token: 'test-private-token',
            },
          },
        },
      })
      const fork = await read()
      expect(fork.error).toBeUndefined()
      expect(fork.result).toMatchObject({ current: provider, modelProvider: provider, sourceThreadId })
      expect(fork.result.argvHasSecret).toBe(false)
      latestThreadId = fork.result.thread.id
      expect(latestThreadId).not.toBe(sourceThreadId)
      send({
        id: `branch-turn-${latestThreadId}`,
        method: 'turn/start',
        params: { threadId: latestThreadId, input: [] },
      })
      expect((await read()).result.current).toBe(provider)
      send({ id: `branch-read-${latestThreadId}`, method: 'thread/read', params: { threadId: latestThreadId } })
      expect((await read()).result.thread).toMatchObject({ id: latestThreadId, modelProvider: provider })
    }
    send({ id: 'unchanged-original', method: 'thread/read', params: { threadId: originalThreadId } })
    expect((await read()).result.thread).toMatchObject({ id: originalThreadId, modelProvider: 'openai' })
    send({ id: 'primary', method: 'config/read', params: {} })
    expect((await read()).result.current).toBe('openai')
    expect(transport.workers().map((worker: { providerId: string }) => worker.providerId))
      .toEqual(['provider-a', 'provider.b'])
    const workerPids = transport.workers().map((worker: { pid: number }) => worker.pid)
    send({ id: 'active-turn', method: 'turn/start', params: { threadId: 'saved-provider-a', input: [] } })
    const activeTurn = (await read()).result.turn
    send({ id: 'active-approval', method: 'fixture/approval', params: { threadId: 'saved-provider-a' } })
    const activeApproval = await read()
    send({ id: 'exit-worker', method: 'fixture/exit', params: { threadId: 'saved-provider-a' } })
    expect((await read()).error.message).toContain('Check thread history')
    expect((await read()).error.message).toContain('Check thread history')
    expect(await read()).toMatchObject({
      method: 'turn/completed',
      params: { threadId: 'native-provider-a-1', turn: { status: 'failed' } },
    })
    expect(await read()).toMatchObject({ method: 'thread/status/changed', params: { status: { type: 'systemError' } } })
    expect(await read()).toMatchObject({
      method: 'turn/completed',
      params: { threadId: 'saved-provider-a', turn: { id: activeTurn.id, status: 'failed' } },
    })
    expect(await read()).toMatchObject({ method: 'thread/status/changed', params: { status: { type: 'systemError' } } })
    let resolvedApproval = await read()
    while (resolvedApproval.method === 'turn/completed' || resolvedApproval.method === 'thread/status/changed') {
      resolvedApproval = await read()
    }
    expect(resolvedApproval).toEqual({
      method: 'serverRequest/resolved',
      params: { requestId: activeApproval.id, threadId: 'saved-provider-a' },
    })
    expect(transport.workers().map((worker: { providerId: string }) => worker.providerId)).toEqual(['provider.b'])
    expect(diagnostics).toContainEqual(expect.objectContaining({
      phase: 'provider-exited',
      provider: 'provider-a',
      exitCode: 7,
      signal: null,
    }))
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

it('passes model input and history above 64 MiB through the real intermediary without retiring a sibling turn', async () => {
  const h = await harness(undefined, 'native-provider-process.mjs')
  try {
    h.send({ id: 'initialize', method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } })
    await h.read()
    const start = () =>
      h.server.nativeRequest('thread/start', {
        modelProvider: 'provider-b',
        config: { 'model_providers.provider-b': { wire_api: 'responses' } },
      }) as Promise<{ thread: { id: string } }>
    const first = await start()
    const sibling = await start()
    const active = await h.server.nativeRequest('turn/start', { threadId: sibling.thread.id, input: [] })
    expect(active).toMatchObject({ current: 'provider-b', turn: { status: 'inProgress' } })
    expect(
      await h.server.nativeRequest('thread/turns/list', {
        threadId: first.thread.id,
        limit: 1,
        itemsView: 'notLoaded',
      }),
    ).toEqual({ data: [{ id: 'fixture-turn', status: 'inProgress', items: [] }], nextCursor: null })
    expect(await h.server.nativeRequest('thread/items/list', { threadId: first.thread.id, limit: 1 }))
      .toEqual({
        data: [{ turnId: 'fixture-turn', item: { type: 'agentMessage', text: 'fixture-history' } }],
        nextCursor: null,
      })
    const bytes = 65 * 1024 * 1024
    const read = await h.server.nativeRequest('thread/read', {
      threadId: first.thread.id,
      includeTurns: true,
      fixtureBytes: bytes,
    }) as { thread: { turns: Array<{ items: Array<{ text: string }> }> } }
    const text = read.thread.turns[0]!.items[0]!.text
    expect(text.length).toBe(bytes)
    h.send({ id: 'large-input', method: 'turn/start', params: { threadId: first.thread.id, input: [{ text }] } })
    expect(JSON.parse(await h.read()).result).toMatchObject({
      current: 'provider-b',
      textLength: bytes,
      textDigest: createHash('sha256').update(text).digest('hex'),
    })
    const next = await h.server.nativeRequest('turn/start', { threadId: sibling.thread.id, input: [] })
    expect(next).toMatchObject({ current: 'provider-b', turn: { status: 'inProgress' } })
    expect(h.child.exitCode).toBeNull()
    expect(h.startupEvents().some(event => event.phase === 'provider-exited')).toBe(false)
  } finally {
    await h.close()
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
