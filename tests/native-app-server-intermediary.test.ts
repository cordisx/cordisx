import { spawn } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { startNativeSubmissionControlServer } from '../packages/cli/src/launcher/native-submission-control-server.js'
import type { NativeSubmissionController } from '../packages/cli/src/launcher/native-submission-controller.js'

async function harness() {
  const server = await startNativeSubmissionControlServer()
  const consume = vi.fn(async (input: { operationToken: string }) =>
    input.operationToken === 'rejected-operation-token'
      ? { kind: 'reject', reason: 'unknown-token' }
      : {
        kind: 'dispatch',
        providerId: 'provider-b',
        model: 'model-b',
        serviceGeneration: 'generation',
        configOverrides: {
          model_provider: 'provider-b',
          model: 'model-b',
          'model_providers.provider-b': { base_url: 'http://127.0.0.1/v1', requires_openai_auth: false },
        },
      }
  )
  const complete = vi.fn(async () => undefined)
  const authorize = vi.fn(async () => true)
  server.bindController(
    {
      consumeMarkedRequest: consume,
      authorizeMarkedRequest: authorize,
      completeMarkedRequest: complete,
    } as unknown as NativeSubmissionController,
  )
  const child = spawn(process.execPath, [
    path.resolve('packages/cli/assets/launcher/native-app-server-intermediary.mjs'),
    path.resolve('tests/fixtures/native-intermediary-app-server.mjs'),
  ], {
    env: {
      ...process.env,
      CODEX_CLI_PATH: 'must-not-leak',
      CORDISX_NATIVE_CONTROL_SOCKET: server.socketPath,
      CORDISX_NATIVE_CONTROL_NONCE: server.nonce,
      CORDISX_NATIVE_REAL_CODEX_PATH: process.execPath,
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
})
