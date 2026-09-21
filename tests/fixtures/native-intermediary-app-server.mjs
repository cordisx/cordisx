import { createInterface } from 'node:readline'
const reader = createInterface({ input: process.stdin })
reader.on('line', line => {
  const message = JSON.parse(line)
  if (message.method === 'fixture/exit') {
    process.exitCode = 7
    reader.close()
    process.stdin.destroy()
    return
  }
  if (message.method === 'echo/bytes') {
    process.stdout.write(`${line}\n`)
    return
  }
  const unrelatedResumeErrors = {
    'managed-permission': { code: -32001, message: 'permission denied' },
    'managed-parameters': { code: -32602, message: 'invalid params' },
    'managed-state': { code: -32002, message: 'thread is active' },
    'managed-compatibility': { code: -32601, message: 'resume is unavailable' },
  }
  const unrelatedResumeError = unrelatedResumeErrors[message.params?.threadId]
  if (message.method === 'thread/resume' && unrelatedResumeError !== undefined) {
    process.stdout.write(`${JSON.stringify({ id: message.id, error: unrelatedResumeError })}\n`)
    return
  }
  if (
    message.method === 'thread/resume' && message.params.threadId === 'managed-retry-fails'
    && message.params.config?.['model_providers.provider-b'] !== undefined
  ) {
    process.stdout.write(
      `${JSON.stringify({ id: message.id, error: { code: -32602, message: 'invalid resume state' } })}\n`,
    )
    return
  }
  if (
    message.method === 'thread/resume' && message.params.threadId === 'managed-wrong-thread'
    && message.params.config?.['model_providers.provider-b'] !== undefined
  ) {
    process.stdout.write(`${JSON.stringify({ id: message.id, result: { thread: { id: 'another-thread' } } })}\n`)
    return
  }
  // A restarted app-server rejects a persisted managed thread until its provider table is supplied again.
  if (
    message.method === 'thread/resume' && String(message.params.threadId).startsWith('managed-')
    && message.params.config?.['model_providers.provider-b'] === undefined
  ) {
    process.stdout.write(
      `${
        JSON.stringify({
          id: message.id,
          error: { code: -32600, message: 'failed to load configuration: Model provider `provider-b` not found' },
        })
      }\n`,
    )
    return
  }
  if (message.method === 'thread/resume') {
    process.stdout.write(
      `${
        JSON.stringify({
          id: message.id,
          result: {
            thread: { id: message.params.threadId },
            modelProvider: message.params.modelProvider,
            model: message.params.model,
            received: message.params,
          },
        })
      }\n`,
    )
    return
  }
  process.stdout.write(
    `${
      JSON.stringify({
        id: message.id,
        result: {
          thread: {
            id: 'created-thread',
            ...(message.method === 'thread/read' ? { status: { type: message.params.threadId } } : {}),
            ...(message.method === 'thread/read' && String(message.params.threadId).startsWith('managed-')
              ? { modelProvider: 'provider-b', model: 'model-b' }
              : {}),
          },
          received: message.params,
          method: message.method,
          leakedControlEnvironment: Object.keys(process.env).filter(key =>
            key.startsWith('CORDISX_NATIVE_') || key === 'CODEX_CLI_PATH'
          ),
        },
      })
    }\n`,
  )
})
