import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeAgentTasks } from '../packages/cli/src/launcher/native-agent-tasks.js'
import { NativeAgentTaskRouting } from '../packages/cli/src/launcher/native-agent-task-routing.js'
import {
  agentTaskEdits,
  applyAgentTaskEdits,
  nativeAgentTaskTransforms,
} from '../packages/cli/src/launcher/native-agent-task-transform.js'
import { parseNativeSource } from '../packages/cli/src/launcher/native-source-structure.js'
import type { NativeSubmissionController } from '../packages/cli/src/launcher/native-submission-controller.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})
const input = {
  operationId: 'op',
  providerId: 'configured',
  model: 'model',
  prompt: 'Real first message',
  target: { type: 'projectless' },
}
const metadata = { 'openai/threadId': 'source', 'openai/turnId': 'source-turn', 'openai/toolCallId': 'actual-call' }
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cx-task-test-'))
  directories.push(directory)
  const controller = {
    prepareThreadResume: vi.fn(async () => ({
      kind: 'resume' as const,
      resumeToken: 'credential-lease',
      configOverrides: { private: 'secret' },
    })),
    completeThreadResume: vi.fn(async () => true),
  } as unknown as NativeSubmissionController
  const routing = new NativeAgentTaskRouting(controller)
  vi.spyOn(routing, 'confirmed').mockReturnValue(true)
  const invoke = vi.fn(async (_request: unknown) => ({
    content: [{ type: 'text', text: JSON.stringify({ threadId: 'actual-thread', hostId: 'local' }) }],
  }))
  const authority = {
    directory,
    routing,
    invoke,
    available: vi.fn(async () => true),
    catalog: async () => [{ providerId: 'configured', pluginId: 'host', models: [{ id: 'model', aliases: [] }] }],
  }
  return { controller, routing, authority, tasks: new NativeAgentTasks(authority) }
}
describe('provider-aware native task operation', () => {
  it('records before native dispatch, returns the native registration receipt and replays without a second create', async () => {
    const f = await fixture()
    expect(await f.tasks.create(input, metadata)).toMatchObject({
      status: 'created',
      native: { threadId: 'actual-thread' },
    })
    expect(await f.tasks.create(input, metadata)).toMatchObject({ status: 'created' })
    expect(await new NativeAgentTasks(f.authority).create(input, metadata)).toMatchObject({ status: 'created' })
    expect(f.authority.invoke).toHaveBeenCalledTimes(1)
    expect(f.authority.invoke.mock.calls[0]![0]).toMatchObject({
      sourceThreadId: 'source',
      arguments: { prompt: input.prompt, target: input.target },
    })
  })
  it('keeps a lost acknowledgement uncertain after restart and never repeats native creation', async () => {
    const f = await fixture()
    f.authority.invoke.mockRejectedValue(new Error('lost'))
    expect(await f.tasks.create(input, metadata)).toMatchObject({ status: 'reconciliation-required' })
    expect(await new NativeAgentTasks(f.authority).create(input, metadata)).toMatchObject({
      status: 'reconciliation-required',
    })
    expect(f.authority.invoke).toHaveBeenCalledTimes(1)
    expect(await f.tasks.create({ ...input, prompt: 'Different' }, metadata)).toMatchObject({
      reason: 'operation-conflict',
    })
  })
  it('uses the executor turn and actual MCP request id when explicit tool-call metadata is absent', async () => {
    const f = await fixture()
    expect(
      await f.tasks.create(input, {
        'x-codex-turn-metadata': JSON.stringify({ thread_id: 'source', turn_id: 'turn' }),
        'cordisx/mcpRequestId': 7,
      }),
    ).toMatchObject({ status: 'created' })
    expect(f.authority.invoke).toHaveBeenCalledTimes(1)
  })
  it('projects only native task identities and settlement fields', async () => {
    const f = await fixture()
    f.authority.invoke.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          threadId: 'actual-thread',
          hostId: 'local',
          config: { token: 'private' },
          secret: 'private',
        }),
      }],
    })
    expect(await f.tasks.create(input, metadata)).toEqual({
      status: 'created',
      native: { threadId: 'actual-thread', hostId: 'local' },
    })
  })
  it('rejects unavailable adapters, catalog injection, invalid targets and missing caller metadata before native dispatch', async () => {
    const f = await fixture()
    for (
      const value of [{ ...input, thinking: 'high' }, { ...input, providerId: 'other' }, {
        ...input,
        target: { type: 'projectless', config: {} },
      }, {
        ...input,
        endpoint: 'evil',
      }]
    ) {
      expect(await f.tasks.create(value, metadata)).toMatchObject({ status: 'rejected' })
    }
    expect(await f.tasks.create(input, {})).toMatchObject({ status: 'rejected' })
    f.authority.available.mockResolvedValue(false)
    expect(await f.tasks.create(input, metadata)).toMatchObject({ reason: 'native-task-adapter-unavailable' })
    expect(f.authority.invoke).not.toHaveBeenCalled()
  })
  it('claims by the exact call/source/arguments once and keeps credential config out of the renderer handle', async () => {
    const f = await fixture()
    f.authority.invoke.mockImplementation(async (request: any) => {
      expect(await f.tasks.claim({ ...request, hostId: 'local', callId: 'other' })).toBeUndefined()
      const handle = await f.tasks.claim({ ...request, hostId: 'local' })
      expect(handle).toMatchObject({ model: 'model' })
      expect(JSON.stringify(handle)).not.toContain('secret')
      expect(await f.tasks.claim({ ...request, hostId: 'local' })).toBeUndefined()
      return { content: [{ type: 'text', text: JSON.stringify({ clientThreadId: 'pending-native-id' }) }] }
    })
    expect(await f.tasks.create(input, metadata)).toMatchObject({ status: 'pending' })
  })
  it('binds the exact prepared lease to the acknowledged new thread and permits only its first turn', async () => {
    const f = await fixture()
    const route = await f.routing.prepare({
      callId: 'call',
      sourceThreadId: 'source',
      providerId: 'configured',
      model: 'model',
    })
    const start = { operationToken: route.token, method: 'thread/start' as const, requestId: 1 }
    expect(await f.routing.consume(start)).toMatchObject({ agentTask: true, providerId: 'configured' })
    expect(await f.routing.authorize(route.token, 1)).toBe(true)
    await f.routing.complete({
      operationToken: route.token,
      requestId: 1,
      succeeded: true,
      boundThreadId: 'created',
      providerId: 'configured',
      model: 'model',
    })
    expect(f.controller.completeThreadResume).toHaveBeenCalledWith({
      threadId: 'source',
      createdThreadId: 'created',
      resumeToken: 'credential-lease',
      succeeded: true,
    })
    expect(
      await f.routing.consume({ operationToken: route.token, method: 'turn/start', requestId: 2, threadId: 'other' }),
    ).toMatchObject({ kind: 'reject' })
    expect(
      await f.routing.consume({ operationToken: route.token, method: 'turn/start', requestId: 2, threadId: 'created' }),
    ).toMatchObject({ kind: 'dispatch' })
    expect(await f.routing.authorize(route.token, 2)).toBe(true)
    await f.routing.complete({ operationToken: route.token, requestId: 2, succeeded: true })
    expect(
      await f.routing.consume({ operationToken: route.token, method: 'turn/start', requestId: 3, threadId: 'created' }),
    ).toMatchObject({ kind: 'reject' })
  })
  it('fails closed on unknown resource bytes and missing/multiple transform anchors', () => {
    expect(nativeAgentTaskTransforms('future', 'unknown', [], []).available).toBe(false)
    expect(nativeAgentTaskTransforms('26.1021.31345', '21828', [], []).available).toBe(false)
    for (const kind of ['initial', 'execution'] as const) {
      expect(() => applyAgentTaskEdits('', kind)).toThrow()
      const anchors = agentTaskEdits(kind).map(([anchor]) => anchor).join('\n')
      expect(() => applyAgentTaskEdits(anchors + '\n' + anchors, kind)).toThrow()
    }
    expect(() => parseNativeSource('async function claim(){return {token:"opaque"}}')).not.toThrow()
  })
  it('blocks first submission when native creation acknowledges a different provider or model', async () => {
    const f = await fixture()
    const route = await f.routing.prepare({
      callId: 'call',
      sourceThreadId: 'source',
      providerId: 'configured',
      model: 'model',
    })
    await f.routing.consume({ operationToken: route.token, method: 'thread/start', requestId: 1 })
    await f.routing.authorize(route.token, 1)
    await f.routing.complete({
      operationToken: route.token,
      requestId: 1,
      succeeded: true,
      boundThreadId: 'created',
      providerId: 'other',
      model: 'model',
    })
    expect(
      await f.routing.consume({ operationToken: route.token, method: 'turn/start', requestId: 2, threadId: 'created' }),
    ).toMatchObject({ kind: 'reject' })
    expect(f.controller.completeThreadResume).not.toHaveBeenCalled()
  })
  it('retires completed route records while keeping the acknowledged native credential binding', async () => {
    const f = await fixture()
    for (let index = 0; index < 130; index++) {
      const callId = `call-${index}`
      const route = await f.routing.prepare({
        callId,
        sourceThreadId: 'source',
        providerId: 'configured',
        model: 'model',
      })
      await f.routing.consume({ operationToken: route.token, method: 'thread/start', requestId: 1 })
      await f.routing.authorize(route.token, 1)
      await f.routing.complete({
        operationToken: route.token,
        requestId: 1,
        succeeded: true,
        boundThreadId: `created-${index}`,
        providerId: 'configured',
        model: 'model',
      })
      await f.routing.consume({
        operationToken: route.token,
        method: 'turn/start',
        requestId: 2,
        threadId: `created-${index}`,
      })
      await f.routing.authorize(route.token, 2)
      await f.routing.complete({ operationToken: route.token, requestId: 2, succeeded: true })
      f.routing.retireCompleted(callId)
      expect(
        await f.routing.consume({
          operationToken: route.token,
          method: 'turn/start',
          requestId: 3,
          threadId: `created-${index}`,
        }),
      ).toBeUndefined()
    }
    expect(f.controller.completeThreadResume).toHaveBeenCalledTimes(130)
  })
  it('releases completed live intents after durable results while retaining replay across 128 creations', async () => {
    const f = await fixture()
    for (let index = 0; index < 130; index++) {
      expect(await f.tasks.create({ ...input, operationId: `op-${index}` }, metadata)).toMatchObject({
        status: 'created',
      })
    }
    expect(await f.tasks.create(input, metadata)).toMatchObject({ status: 'created' })
    expect(f.authority.invoke).toHaveBeenCalledTimes(131)
    expect(await f.tasks.create(input, metadata)).toMatchObject({ status: 'created' })
    expect(f.authority.invoke).toHaveBeenCalledTimes(131)
  })
})
