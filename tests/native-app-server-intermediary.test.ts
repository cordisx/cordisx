import { type DiagnosticEvent, withDiagnostics } from '../packages/cli/src/diagnostics/context.js'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { startNativeSubmissionControlServer } from '../packages/cli/src/launcher/native-submission-control-server.js'
import type { NativeSubmissionController } from '../packages/cli/src/launcher/native-submission-controller.js'
import { NativeAgentTaskRouting } from '../packages/cli/src/launcher/native-agent-task-routing.js'
import { nextInput, request, responseEvents, responseSse } from './fixtures/deepseek-responses.js'
import {
  harness as submissionHarness,
  threadAction,
  threadScope,
} from './fixtures/native-submission-controller-harness.js'

async function harness(controller?: NativeSubmissionController) {
  const server = await startNativeSubmissionControlServer()
  const consume = vi.fn(async (input: { operationToken: string }) =>
    input.operationToken === 'rejected-operation-token'
      ? { kind: 'reject', reason: 'unknown-token' }
      : {
        kind: 'dispatch',
        providerId: 'provider-b',
        model: 'model-b',
        serviceGeneration: 'generation',
        ...(input.operationToken === 'allowed-with-effort-token' ? { reasoningEffort: 'xhigh' } : {}),
        configOverrides: {
          model_provider: 'provider-b',
          model: 'model-b',
          'model_providers.provider-b': { base_url: 'http://127.0.0.1/v1', requires_openai_auth: false },
        },
      }
  )
  const complete = vi.fn(async () => undefined)
  const authorize = vi.fn(async () => true)
  const prepareThreadResume = vi.fn<NativeSubmissionController['prepareThreadResume']>(async input =>
    input.threadId === 'managed-unready'
      ? { kind: 'reject', reason: 'provider-preparation-failed' }
      : {
        kind: 'resume',
        resumeToken: `resume-token-${input.threadId}`,
        configOverrides: {
          'model_providers.provider-b': { base_url: 'http://127.0.0.1/v1', requires_openai_auth: false },
        },
      }
  )
  const completeThreadResume = vi.fn(async () => true)
  const taskRouting = new NativeAgentTaskRouting(
    { prepareThreadResume, completeThreadResume } as unknown as NativeSubmissionController,
  )
  server.bindTaskRouting(taskRouting)
  server.bindController(
    controller ?? {
      consumeMarkedRequest: consume,
      authorizeMarkedRequest: authorize,
      completeMarkedRequest: complete,
      prepareThreadResume,
      completeThreadResume,
    } as unknown as NativeSubmissionController,
  )
  const intermediary = path.resolve('packages/cli/assets/launcher/native-app-server-intermediary.mjs')
  const nativeArguments = [path.resolve('tests/fixtures/native-intermediary-app-server.mjs')]
  const child = spawn(process.platform === 'win32' ? process.execPath : intermediary, [
    ...(process.platform === 'win32' ? [intermediary] : []),
    ...nativeArguments,
  ], {
    env: {
      ...process.env,
      CODEX_CLI_PATH: 'must-not-leak',
      CORDISX_NATIVE_CONTROL_SOCKET: server.socketPath,
      CORDISX_NATIVE_CONTROL_NONCE: server.nonce,
      CORDISX_NATIVE_REAL_CODEX_PATH: process.execPath,
      CORDISX_NATIVE_NODE_PATH: process.execPath,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buffer = ''
  let stderr = ''
  const output: string[] = []
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => {
    stderr += chunk
  })
  child.stdout.on('data', chunk => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      output.push(buffer.slice(0, index))
      buffer = buffer.slice(index + 1)
    }
  })
  const read = async () => {
    await vi.waitFor(() => expect(output.length, stderr).toBeGreaterThan(0), { timeout: 3000 })
    return output.shift()!
  }
  return {
    child,
    server,
    consume,
    complete,
    authorize,
    prepareThreadResume,
    completeThreadResume,
    taskRouting,
    read,
    send(value: unknown) {
      child.stdin.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`)
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.end()
        await once(child, 'exit')
      }
      await server.close()
      expect(stderr).toBe('')
    },
  }
}

describe('native app-server intermediary', () => {
  it('records request metadata over the existing authenticated control channel while preserving opaque input', async () => {
    const events: DiagnosticEvent[] = []
    await withDiagnostics({ emit: event => events.push(event) }, async () => {
      const h = await harness()
      try {
        h.send({
          id: 91,
          method: 'turn/start',
          params: { threadId: 'private-thread', model: 'example-model', input: [{ text: 'PRIVATE_INPUT_MARKER' }] },
        })
        expect(await h.read()).toContain('PRIVATE_INPUT_MARKER')
        await vi.waitFor(() => expect(events.some(event => event.event === 'model-issued')).toBe(true))
        expect(events).toContainEqual(expect.objectContaining({ event: 'model-queued', model: 'example-model' }))
        expect(JSON.stringify(events)).not.toMatch(/PRIVATE_INPUT_MARKER|private-thread/u)
      } finally {
        await h.close()
      }
    })
  })

  it('forwards native task creation with exact call metadata and routes its unmarked first send once', async () => {
    const h = await harness()
    try {
      h.send({ id: 'ready-task', method: 'echo/bytes', params: {} })
      await h.read()
      const args = { prompt: 'Original first message', target: { type: 'projectless' } }
      const receipt: any = await h.server.invokeTask({
        callId: 'cordisx-task-exact-call',
        sourceThreadId: 'source',
        sourceTurnId: 'source-turn',
        arguments: args,
      })
      expect(receipt.received).toEqual({
        server: 'codex_app',
        threadId: 'source',
        tool: 'create_thread',
        arguments: args,
        _meta: {
          'openai/toolCallId': 'cordisx-task-exact-call',
          'openai/threadId': 'source',
          'openai/turnId': 'source-turn',
        },
      })
      const route = await h.taskRouting.prepare({
        callId: 'cordisx-task-exact-call',
        sourceThreadId: 'source',
        providerId: 'provider-b',
        model: 'model-b',
      })
      h.send({
        id: 'agent-create',
        method: 'thread/start',
        params: {
          cwd: '/native/project',
          projectId: 'native-project',
          config: { 'cordisx.operation_token': route.token },
        },
      })
      expect(JSON.parse(await h.read()).result.received).toMatchObject({
        cwd: '/native/project',
        projectId: 'native-project',
        modelProvider: 'provider-b',
        model: 'model-b',
      })
      expect(h.completeThreadResume).toHaveBeenCalledWith({
        threadId: 'source',
        createdThreadId: 'created-thread',
        resumeToken: 'resume-token-source',
        succeeded: true,
      })
      h.send({
        id: 'agent-first',
        method: 'turn/start',
        params: {
          threadId: 'created-thread',
          input: [{ type: 'text', text: 'Original first message' }],
          approvalPolicy: 'on-request',
          model: 'old',
          config: { 'cordisx.operation_token': route.token },
        },
      })
      expect(JSON.parse(await h.read()).result.received).toMatchObject({
        model: 'model-b',
        approvalPolicy: 'on-request',
        input: [{ type: 'text', text: 'Original first message' }],
      })
      h.send({
        id: 'agent-next',
        method: 'turn/start',
        params: { threadId: 'created-thread', input: [], model: 'native-next' },
      })
      expect(JSON.parse(await h.read()).result.received.model).toBe('native-next')
    } finally {
      await h.close()
    }
  })
  it('allows Agent selection only for a loaded idle thread behind the native mutation fence', async () => {
    const h = await harness()
    try {
      h.send({ id: 'initialize-agent-switch-fixture', method: 'echo/bytes', params: {} })
      await h.read()
      const switchThread = (threadId: string) =>
        h.server.switchAgentThread({
          threadId,
          providerId: 'provider-b',
          model: 'model-b',
          configOverrides: {},
        })
      await expect(switchThread('agent-idle')).resolves.toBeUndefined()
      for (const state of ['active', 'notLoaded', 'systemError', 'unknown']) {
        await expect(switchThread(`agent-${state}`)).rejects.toThrow()
      }
    } finally {
      await h.close()
    }
  })
  it('preserves offline Responses SSE and stateless tool history as opaque native payloads', async () => {
    const h = await harness()
    try {
      // HTTP/SSE parsing belongs to upstream Codex. This boundary must not convert or truncate its payloads.
      for (const payload of [request(), request(nextInput), responseSse, ...responseEvents]) {
        const frame = JSON.stringify({ id: 'responses-fixture', method: 'echo/bytes', params: { payload } })
        h.send(frame)
        expect(await h.read()).toBe(frame)
      }
      h.send({
        id: 'tool-turn',
        method: 'turn/start',
        params: {
          threadId: 'thread',
          input: nextInput,
          config: { 'cordisx.operation_token': 'allowed-operation-token' },
        },
      })
      expect(JSON.parse(await h.read()).result.received.input).toEqual(nextInput)
    } finally {
      await h.close()
    }
  })
  it('preserves native frames larger than the private control-message budget', async () => {
    const h = await harness()
    try {
      const raw = JSON.stringify({ id: 1, method: 'echo/bytes', params: { text: 'x'.repeat(9 * 1024 * 1024) } })
      h.send(raw)
      expect(await h.read()).toBe(raw)
      h.send({ id: 2, method: 'thread/read', params: {} })
      expect(JSON.parse(await h.read()).id).toBe(2)
    } finally {
      await h.close()
    }
  })
  it('exits when the native child exits even while Desktop keeps stdin open', async () => {
    const h = await harness()
    try {
      h.send({ id: 1, method: 'fixture/exit', params: {} })
      await vi.waitFor(() => expect(h.child.exitCode).toBe(7), { timeout: 3000 })
    } finally {
      await h.close()
    }
  })
  it('admits exact terminal states for recovery and rejects active or unknown states', async () => {
    const h = await harness()
    try {
      h.send({ id: 1, method: 'thread/read', params: {} })
      await h.read()
      for (const status of ['idle', 'notLoaded', 'systemError']) {
        expect(await h.server.isThreadIdle(status)).toBe(true)
      }
      for (const status of ['active', 'unknown']) {
        expect(await h.server.isThreadIdle(status)).toBe(false)
      }
    } finally {
      await h.close()
    }
  })
  it('preserves unmarked bytes and rewrites only admitted new-thread requests without credential env leaks', async () => {
    const h = await harness()
    try {
      const raw = '{ "id": 1, "method": "echo/bytes", "params": { "text":"original" } }'
      h.send(raw)
      expect(await h.read()).toBe(raw)
      h.send({
        id: 2,
        method: 'thread/start',
        params: { cwd: '/native/worktree', config: { keep: 1, 'cordisx.operation_token': 'allowed-operation-token' } },
      })
      const result = JSON.parse(await h.read()).result
      expect(result.received).toMatchObject({
        cwd: '/native/worktree',
        modelProvider: 'provider-b',
        model: 'model-b',
        config: { keep: 1, model_provider: 'provider-b' },
      })
      expect(result.received.config).not.toHaveProperty('cordisx.operation_token')
      expect(result.leakedControlEnvironment).toEqual([])
      expect(h.complete).toHaveBeenCalledWith({
        operationToken: 'allowed-operation-token',
        requestId: 2,
        succeeded: true,
        boundThreadId: 'created-thread',
      })
      h.send({ id: 3, method: 'turn/start', params: { threadId: 'created-thread', model: 'old' } })
      expect(JSON.parse(await h.read())).toMatchObject({ id: 3, error: { code: -32000 } })
    } finally {
      await h.close()
    }
  })

  it('preserves explicit effort in new-thread config and rejects an unmarked first turn', async () => {
    const h = await harness()
    try {
      h.send({
        id: 2,
        method: 'thread/start',
        params: { config: { 'cordisx.operation_token': 'allowed-with-effort-token' } },
      })
      const created = JSON.parse(await h.read()).result.received
      expect(created.config.model_reasoning_effort).toBe('xhigh')
      h.send({
        id: 3,
        method: 'turn/start',
        params: {
          threadId: 'created-thread',
          input: [{ type: 'text', text: 'hello' }],
          effort: 'low',
          collaborationMode: { mode: 'plan', settings: { model: 'old', reasoning_effort: 'low' } },
        },
      })
      expect(JSON.parse(await h.read())).toMatchObject({ id: 3, error: { code: -32000 } })
      h.send({
        id: 4,
        method: 'turn/start',
        params: {
          threadId: 'created-thread',
          input: [{ type: 'text', text: 'hello again' }],
          effort: 'low',
          config: { 'cordisx.operation_token': 'allowed-operation-token' },
        },
      })
      const associatedTurn = JSON.parse(await h.read()).result.received
      expect(associatedTurn).toMatchObject({
        model: 'model-b',
        input: [{ type: 'text', text: 'hello again' }],
        effort: 'low',
      })
    } finally {
      await h.close()
    }
  })

  it('rejects a marked request without forwarding or killing later native requests', async () => {
    const h = await harness()
    try {
      h.send({
        id: 1,
        method: 'turn/start',
        params: { threadId: 'thread', config: { 'cordisx.operation_token': 'rejected-operation-token' } },
      })
      expect(JSON.parse(await h.read())).toMatchObject({ id: 1, error: { code: -32000 } })
      h.send({ id: 2, method: 'thread/read', params: { threadId: 'thread' } })
      expect(JSON.parse(await h.read())).toMatchObject({ id: 2, result: { method: 'thread/read' } })
      expect(h.complete).not.toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })

  it('revalidates the exact request immediately before the native write', async () => {
    const h = await harness()
    h.authorize.mockResolvedValueOnce(false)
    try {
      h.send({
        id: 'managed-request',
        method: 'thread/start',
        params: { config: { 'cordisx.operation_token': 'allowed-operation-token' } },
      })
      expect(JSON.parse(await h.read())).toMatchObject({ id: 'managed-request', error: { code: -32000 } })
      expect(h.consume).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'managed-request' }))
      expect(h.authorize).toHaveBeenCalledWith({
        operationToken: 'allowed-operation-token',
        requestId: 'managed-request',
      })
      expect(h.complete).toHaveBeenCalledWith({
        operationToken: 'allowed-operation-token',
        requestId: 'managed-request',
        succeeded: false,
      })
      h.send({ id: 2, method: 'thread/read', params: {} })
      expect(JSON.parse(await h.read())).toMatchObject({ id: 2, result: { method: 'thread/read' } })
    } finally {
      await h.close()
    }
  })

  it('completes private unsubscribe/resume before forwarding the original turn and preserves input/effort', async () => {
    const h = await harness()
    try {
      h.send({ id: 1, method: 'thread/read', params: {} })
      await h.read()
      await h.server.existingThread.switch({
        scope: { targetId: 'target', rendererGeneration: 'renderer', navigationGeneration: 1, threadId: 'thread' },
        threadId: 'thread',
        providerId: 'provider-b',
        model: 'model-b',
        serviceGeneration: 'generation',
        configOverrides: {},
      })
      h.send({
        id: 2,
        method: 'turn/start',
        params: {
          threadId: 'thread',
          input: [{ type: 'text', text: 'original draft' }],
          effort: 'high',
          multiAgentMode: 'on',
          collaborationMode: { mode: 'plan', settings: { model: 'old', reasoning_effort: 'high' } },
          config: { 'cordisx.operation_token': 'allowed-operation-token' },
        },
      })
      const response = JSON.parse(await h.read())
      expect(response.id).toBe(2)
      expect(response.result.received).toMatchObject({
        model: 'model-b',
        input: [{ type: 'text', text: 'original draft' }],
        effort: 'high',
        multiAgentMode: 'on',
        collaborationMode: { mode: 'plan', settings: { model: 'model-b', reasoning_effort: 'high' } },
      })
      expect(response.result.received).not.toHaveProperty('config')
      expect(response.result.received).not.toHaveProperty('modelProvider')
    } finally {
      await h.close()
    }
  })

  it('resumes a persisted managed thread after an app-server restart with the Host provider table', async () => {
    const h = await harness()
    try {
      h.send({ id: 'resume-1', method: 'thread/resume', params: { threadId: 'managed-thread', config: { keep: 1 } } })
      const resumed = JSON.parse(await h.read())
      expect(resumed).toMatchObject({ id: 'resume-1', result: { thread: { id: 'managed-thread' } } })
      expect(resumed.result.received).toEqual({
        threadId: 'managed-thread',
        config: {
          keep: 1,
          'model_providers.provider-b': { base_url: 'http://127.0.0.1/v1', requires_openai_auth: false },
        },
      })
      expect(h.prepareThreadResume).toHaveBeenCalledWith({
        threadId: 'managed-thread',
        providerId: 'provider-b',
        model: 'model-b',
      })
      expect(h.completeThreadResume).toHaveBeenCalledWith({
        threadId: 'managed-thread',
        resumeToken: 'resume-token-managed-thread',
        succeeded: true,
      })
      h.send({ id: 'unmarked-turn', method: 'turn/start', params: { threadId: 'managed-thread' } })
      // No provider change is pending after recovery. Native sends and queued
      // retries pass through without a new operation token.
      expect(JSON.parse(await h.read())).toMatchObject({
        id: 'unmarked-turn',
        result: { method: 'turn/start', received: { threadId: 'managed-thread' } },
      })
      h.send({
        id: 'retry-turn',
        method: 'turn/start',
        params: {
          threadId: 'managed-thread',
          model: 'model-b',
          input: [{ type: 'text', text: 'continue after restart' }],
          effort: 'high',
          config: { keep: 1 },
        },
      })
      expect(JSON.parse(await h.read())).toMatchObject({
        id: 'retry-turn',
        result: {
          method: 'turn/start',
          received: {
            threadId: 'managed-thread',
            model: 'model-b',
            input: [{ type: 'text', text: 'continue after restart' }],
            effort: 'high',
            config: { keep: 1 },
          },
        },
      })
      expect(h.consume).not.toHaveBeenCalled()
      expect(h.authorize).not.toHaveBeenCalled()
      h.send({
        id: 'rejected-turn',
        method: 'turn/start',
        params: {
          threadId: 'managed-thread',
          config: { 'cordisx.operation_token': 'rejected-operation-token' },
        },
      })
      expect(JSON.parse(await h.read())).toMatchObject({ id: 'rejected-turn', error: { code: -32000 } })
      h.send({
        id: 'marked-turn',
        method: 'turn/start',
        params: {
          threadId: 'managed-thread',
          config: { 'cordisx.operation_token': 'allowed-operation-token' },
        },
      })
      expect(JSON.parse(await h.read())).toMatchObject({ id: 'marked-turn', result: { method: 'turn/start' } })
    } finally {
      await h.close()
    }
  })

  it('forwards the real controller pass-through Send after committing a recovered provider lease', async () => {
    const scope = { ...threadScope, threadId: 'managed-thread' }
    const fixture = submissionHarness({ scope })
    fixture.setSnapshot({ revision: 4, effective: { providerId: 'provider-b', model: 'model-b' } })
    const h = await harness(fixture.controller)
    try {
      h.send({ id: 'resume', method: 'thread/resume', params: { threadId: scope.threadId } })
      expect(JSON.parse(await h.read())).toMatchObject({ id: 'resume', result: { thread: { id: scope.threadId } } })
      expect(fixture.prepare).toHaveBeenCalledOnce()
      const params = {
        threadId: scope.threadId,
        model: 'model-b',
        input: [{ type: 'text', text: 'unchanged-provider follow-up' }],
        effort: 'high',
        config: { keep: 1 },
      }
      for (const intent of ['ordinary-send', 'edit-retry', 'queue'] as const) {
        expect(await fixture.controller.prepareSubmission(scope, { ...threadAction, threadId: scope.threadId, intent }))
          .toEqual({ kind: 'pass-through' })
        h.send({ id: intent, method: 'turn/start', params })
        const response = JSON.parse(await h.read())
        expect(response).toMatchObject({ id: intent, result: { method: 'turn/start' } })
        expect(response.result.received).toEqual(params)
      }
      expect(fixture.switchThread).not.toHaveBeenCalled()
      expect(fixture.disposed).toEqual([])
    } finally {
      await h.close()
      await fixture.controller.dispose()
      expect(fixture.disposed).toEqual(['provider-b-1'])
    }
  })

  it('recovers an unloaded managed thread once and preserves the exact original turn controls', async () => {
    const h = await harness()
    const params = {
      threadId: 'unloaded-managed',
      model: 'model-b',
      effort: 'high',
      input: [{ type: 'text', text: 'continue the same thread' }],
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'readOnly' },
      config: { keep: 1 },
      collaborationMode: { mode: 'plan', settings: { model: 'model-b' } },
    }
    try {
      h.send({ id: 'original-turn', method: 'turn/start', params })
      const response = JSON.parse(await h.read())
      expect(response).toMatchObject({ id: 'original-turn', result: { method: 'turn/start' } })
      expect(response.result.received).toEqual(params)
      expect(h.prepareThreadResume).toHaveBeenCalledOnce()
      expect(h.prepareThreadResume).toHaveBeenCalledWith({
        threadId: params.threadId,
        providerId: 'provider-b',
        model: 'model-b',
      })
      expect(h.completeThreadResume).toHaveBeenCalledWith({
        threadId: params.threadId,
        resumeToken: `resume-token-${params.threadId}`,
        succeeded: true,
      })
      h.send({ id: 'next-turn', method: 'turn/start', params })
      expect(JSON.parse(await h.read())).toMatchObject({ id: 'next-turn', result: { method: 'turn/start' } })
      expect(h.prepareThreadResume).toHaveBeenCalledOnce()
    } finally {
      await h.close()
    }
  })

  it.each(['unloaded-active', 'unloaded-native', 'unloaded-wrong-id', 'unloaded-unknown'])(
    'does not resume a missing-turn request for %s',
    async threadId => {
      const h = await harness()
      try {
        h.send({ id: 'turn', method: 'turn/start', params: { threadId } })
        expect(JSON.parse(await h.read())).toEqual({
          id: 'turn',
          error: { code: -32600, message: `thread not found: ${threadId}` },
        })
        expect(h.prepareThreadResume).not.toHaveBeenCalled()
      } finally {
        await h.close()
      }
    },
  )

  it('keeps the original error and aborts the candidate lease when unloaded recovery fails', async () => {
    const h = await harness()
    try {
      h.send({ id: 'turn', method: 'turn/start', params: { threadId: 'unloaded-resume-fails' } })
      expect(JSON.parse(await h.read())).toMatchObject({
        id: 'turn',
        error: { message: 'thread not found: unloaded-resume-fails' },
      })
      expect(h.completeThreadResume).toHaveBeenCalledWith({
        threadId: 'unloaded-resume-fails',
        resumeToken: 'resume-token-unloaded-resume-fails',
        succeeded: false,
      })
    } finally {
      await h.close()
    }
  })

  it('does not loop when the one replay still reports a missing thread', async () => {
    const h = await harness()
    try {
      h.send({ id: 'turn', method: 'turn/start', params: { threadId: 'unloaded-retry-fails' } })
      expect(JSON.parse(await h.read())).toMatchObject({
        id: 'turn',
        error: { message: 'thread not found: unloaded-retry-fails' },
      })
      expect(h.prepareThreadResume).toHaveBeenCalledOnce()
    } finally {
      await h.close()
    }
  })

  it.each(['unloaded-provider-mismatch', 'unloaded-resume-active'])(
    'aborts recovery when resume does not acknowledge the same idle provider: %s',
    async threadId => {
      const h = await harness()
      try {
        h.send({ id: 'turn', method: 'turn/start', params: { threadId } })
        expect(JSON.parse(await h.read())).toMatchObject({
          id: 'turn',
          error: { message: `thread not found: ${threadId}` },
        })
        expect(h.completeThreadResume).toHaveBeenCalledWith({
          threadId,
          resumeToken: `resume-token-${threadId}`,
          succeeded: false,
        })
      } finally {
        await h.close()
      }
    },
  )

  it.each(
    [
      ['unloaded-wrong-error-id', -32600, 'thread not found: another-thread'],
      ['unloaded-wrong-error-code', -32001, 'thread not found: unloaded-wrong-error-code'],
    ] as const,
  )('does not recover an unrelated rejection: %s', async (threadId, code, message) => {
    const h = await harness()
    try {
      h.send({ id: 'turn', method: 'turn/start', params: { threadId } })
      expect(JSON.parse(await h.read())).toEqual({ id: 'turn', error: { code, message } })
      expect(h.prepareThreadResume).not.toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })

  it('returns the replay rejection rather than the obsolete initial missing-thread error', async () => {
    const h = await harness()
    try {
      h.send({ id: 'turn', method: 'turn/start', params: { threadId: 'unloaded-replay-denied' } })
      expect(JSON.parse(await h.read())).toEqual({
        id: 'turn',
        error: { code: -32001, message: 'replay permission denied' },
      })
      expect(h.prepareThreadResume).toHaveBeenCalledOnce()
    } finally {
      await h.close()
    }
  })

  it('reports an untrustworthy replay result as unknown instead of saying the original was not sent', async () => {
    const h = await harness()
    try {
      h.send({ id: 'turn', method: 'turn/start', params: { threadId: 'unloaded-replay-unknown' } })
      expect(JSON.parse(await h.read())).toMatchObject({
        id: 'turn',
        error: { message: 'Recovered turn result is unknown. Check thread history before retrying.' },
      })
      expect(h.prepareThreadResume).toHaveBeenCalledOnce()
    } finally {
      await h.close()
    }
  })

  it('rejects another Send while the same thread recovery is pending', async () => {
    const h = await harness()
    let ready!: () => void
    const preparing = new Promise<void>(resolve => {
      ready = resolve
    })
    const originalPrepare = h.prepareThreadResume.getMockImplementation()!
    let finish!: () => void
    const barrier = new Promise<void>(resolve => {
      finish = resolve
    })
    h.prepareThreadResume.mockImplementationOnce(async input => {
      ready()
      await barrier
      return await originalPrepare(input)
    })
    try {
      h.send({ id: 'first', method: 'turn/start', params: { threadId: 'unloaded-concurrent' } })
      await preparing
      h.send({ id: 'second', method: 'turn/start', params: { threadId: 'unloaded-concurrent' } })
      expect(JSON.parse(await h.read())).toMatchObject({
        id: 'second',
        error: { message: 'Thread recovery is in progress. Wait before sending another message.' },
      })
      finish()
      expect(JSON.parse(await h.read())).toMatchObject({ id: 'first', result: { method: 'turn/start' } })
      expect(h.prepareThreadResume).toHaveBeenCalledOnce()
    } finally {
      finish()
      await h.close()
    }
  })

  it.each(['thread/resume', 'thread/unsubscribe', 'turn/addUserMessage', 'turn/steer'])(
    'rejects %s through the same recovery lane before it reaches the native session',
    async method => {
      const h = await harness()
      let entered!: () => void
      const ready = new Promise<void>(resolve => {
        entered = resolve
      })
      let release!: () => void
      const barrier = new Promise<void>(resolve => {
        release = resolve
      })
      const prepare = h.prepareThreadResume.getMockImplementation()!
      h.prepareThreadResume.mockImplementationOnce(async input => {
        entered()
        await barrier
        return prepare(input)
      })
      try {
        h.send({ id: 'first', method: 'turn/start', params: { threadId: 'unloaded-concurrent' } })
        await ready
        h.send({ id: 'mutation', method, params: { threadId: 'unloaded-concurrent', modelProvider: 'other' } })
        expect(JSON.parse(await h.read())).toMatchObject({ id: 'mutation', error: { code: -32000 } })
        release()
        expect(JSON.parse(await h.read())).toMatchObject({ id: 'first', result: { method: 'turn/start' } })
        expect(h.prepareThreadResume).toHaveBeenCalledOnce()
      } finally {
        release()
        await h.close()
      }
    },
  )

  it('does not replay after the resumed thread becomes active before final validation', async () => {
    const h = await harness()
    try {
      h.send({ id: 'turn', method: 'turn/start', params: { threadId: 'unloaded-changed-before-replay' } })
      expect(JSON.parse(await h.read())).toMatchObject({
        id: 'turn',
        error: { message: 'thread not found: unloaded-changed-before-replay' },
      })
      expect(h.prepareThreadResume).toHaveBeenCalledOnce()
    } finally {
      await h.close()
    }
  })

  it('continues ordinary native lifecycle and sends when unresolved lifecycle tracking is full', async () => {
    const h = await harness()
    try {
      for (let index = 0; index < 65; index++) {
        h.send({ id: `lost-${index}`, method: 'thread/unsubscribe', params: { threadId: `lost-lifecycle-${index}` } })
      }
      h.send({ id: 'resume', method: 'thread/resume', params: { threadId: 'native-thread' } })
      expect(JSON.parse(await h.read())).toMatchObject({ id: 'resume', result: { thread: { id: 'native-thread' } } })
      h.send({ id: 'send', method: 'turn/start', params: { threadId: 'native-thread' } })
      expect(JSON.parse(await h.read())).toMatchObject({ id: 'send', result: { method: 'turn/start' } })
      expect(h.prepareThreadResume).not.toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })

  it('does not start automatic recovery while a prior native lifecycle request has no acknowledgement', async () => {
    const h = await harness()
    try {
      h.send({ id: 'pending', method: 'thread/unsubscribe', params: { threadId: 'unloaded-pending-lifecycle' } })
      h.send({ id: 'turn', method: 'turn/start', params: { threadId: 'unloaded-pending-lifecycle' } })
      expect(JSON.parse(await h.read())).toEqual({
        id: 'turn',
        error: { code: -32600, message: 'thread not found: unloaded-pending-lifecycle' },
      })
      expect(h.prepareThreadResume).not.toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })

  it('does not replay cancelled input even when native resume completes successfully', async () => {
    const h = await harness()
    let entered!: () => void
    const ready = new Promise<void>(resolve => {
      entered = resolve
    })
    let release!: () => void
    const barrier = new Promise<void>(resolve => {
      release = resolve
    })
    const prepare = h.prepareThreadResume.getMockImplementation()!
    h.prepareThreadResume.mockImplementationOnce(async input => {
      entered()
      await barrier
      return prepare(input)
    })
    try {
      h.send({ id: 'turn', method: 'turn/start', params: { threadId: 'unloaded-cancelled' } })
      await ready
      h.send({ id: 'cancel', method: 'turn/interrupt', params: { threadId: 'unloaded-cancelled' } })
      expect(JSON.parse(await h.read())).toMatchObject({ id: 'cancel', result: { method: 'turn/interrupt' } })
      release()
      expect(JSON.parse(await h.read())).toMatchObject({ id: 'turn', error: { code: -32600 } })
    } finally {
      release()
      await h.close()
    }
  })

  it('recovers an unloaded turn through the real Host controller and retains its lease until disposal', async () => {
    const scope = { ...threadScope, threadId: 'unloaded-real-controller' }
    const fixture = submissionHarness({ scope })
    fixture.setSnapshot({ revision: 4, effective: { providerId: 'provider-b', model: 'model-b' } })
    const h = await harness(fixture.controller)
    try {
      expect(await fixture.controller.prepareSubmission(scope, { ...threadAction, threadId: scope.threadId }))
        .toEqual({ kind: 'pass-through' })
      const params = { threadId: scope.threadId, model: 'model-b', input: [{ type: 'text', text: 'resume' }] }
      h.send({ id: 'original', method: 'turn/start', params })
      const result = JSON.parse(await h.read())
      expect(result).toMatchObject({ id: 'original', result: { method: 'turn/start' } })
      expect(result.result.received).toEqual(params)
      expect(fixture.prepare).toHaveBeenCalledOnce()
      expect(fixture.disposed).toEqual([])
    } finally {
      await h.close()
      await fixture.controller.dispose()
      expect(fixture.disposed).toEqual(['provider-b-1'])
    }
  })

  it('keeps the native resume failure when the Host cannot vouch for the provider', async () => {
    const h = await harness()
    try {
      h.send({ id: 1, method: 'thread/resume', params: { threadId: 'managed-unready' } })
      expect(JSON.parse(await h.read())).toEqual({
        id: 1,
        error: { code: -32600, message: 'failed to load configuration: Model provider `provider-b` not found' },
      })
      h.send({ id: 2, method: 'thread/resume', params: { threadId: 'native-thread', model: 'native' } })
      expect(JSON.parse(await h.read())).toMatchObject({ id: 2, result: { thread: { id: 'native-thread' } } })
      expect(h.prepareThreadResume).toHaveBeenCalledTimes(1)
      expect(h.completeThreadResume).not.toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })

  it.each(
    [
      ['permission', -32001, 'permission denied'],
      ['parameters', -32602, 'invalid params'],
      ['state', -32002, 'thread is active'],
      ['compatibility', -32601, 'resume is unavailable'],
    ] as const,
  )('does not retry an unrelated %s resume error for a managed thread', async (kind, code, message) => {
    const h = await harness()
    try {
      h.send({ id: `resume-${kind}`, method: 'thread/resume', params: { threadId: `managed-${kind}` } })
      expect(JSON.parse(await h.read())).toEqual({
        id: `resume-${kind}`,
        error: { code, message },
      })
      expect(h.prepareThreadResume).not.toHaveBeenCalled()
      expect(h.completeThreadResume).not.toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })

  it('aborts only the candidate lease when the managed resume retry fails', async () => {
    const h = await harness()
    try {
      h.send({ id: 'resume-fails', method: 'thread/resume', params: { threadId: 'managed-retry-fails' } })
      expect(JSON.parse(await h.read())).toEqual({
        id: 'resume-fails',
        error: { code: -32600, message: 'failed to load configuration: Model provider `provider-b` not found' },
      })
      expect(h.completeThreadResume).toHaveBeenCalledWith({
        threadId: 'managed-retry-fails',
        resumeToken: 'resume-token-managed-retry-fails',
        succeeded: false,
      })
    } finally {
      await h.close()
    }
  })

  it('does not commit the candidate lease when resume returns another thread', async () => {
    const h = await harness()
    try {
      h.send({ id: 'resume-wrong-thread', method: 'thread/resume', params: { threadId: 'managed-wrong-thread' } })
      expect(JSON.parse(await h.read())).toEqual({
        id: 'resume-wrong-thread',
        error: { code: -32600, message: 'failed to load configuration: Model provider `provider-b` not found' },
      })
      expect(h.completeThreadResume).toHaveBeenCalledWith({
        threadId: 'managed-wrong-thread',
        resumeToken: 'resume-token-managed-wrong-thread',
        succeeded: false,
      })
    } finally {
      await h.close()
    }
  })
})
