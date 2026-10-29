import { spawn } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import { expect, vi } from 'vitest'
import type { DiagnosticEvent } from '../../packages/cli/src/diagnostics/context.js'
import { startNativeSubmissionControlServer } from '../../packages/cli/src/launcher/native-submission-control-server.js'
import type { NativeSubmissionController } from '../../packages/cli/src/launcher/native-submission-controller.js'
import { NativeAgentTaskRouting } from '../../packages/cli/src/launcher/native-agent-task-routing.js'

export async function harness(controller?: NativeSubmissionController) {
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
  const nativeArguments = [path.resolve('tests/fixtures/native-intermediary-app-server.mjs'), 'app-server']
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
  const closed = once(child, 'close')
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
    startupEvents: () =>
      stderr.trim().split('\n').filter(Boolean).map(line => {
        expect(line.startsWith('[cordisx-native] ')).toBe(true)
        const event = JSON.parse(line.slice('[cordisx-native] '.length)) as DiagnosticEvent
        expect(
          Object.keys(event).every(key =>
            [
              'event',
              'method',
              'requestRef',
              'sourcePid',
              'childPid',
              'phase',
              'count',
              'elapsedMs',
              'pid',
              'exitCode',
              'signal',
              'verified',
              'errorCode',
              'state',
              'reason',
            ].includes(key)
          ),
        ).toBe(true)
        return event
      }),
    send(value: unknown) {
      child.stdin.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`)
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.end()
      }
      await closed
      await server.close()
      expect(stderr.trim().split('\n').filter(Boolean).every(line => line.startsWith('[cordisx-native] '))).toBe(true)
    },
  }
}
