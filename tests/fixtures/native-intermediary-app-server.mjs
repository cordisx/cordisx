import { createInterface } from 'node:readline'
const reader = createInterface({ input: process.stdin })
const resumedThreads = new Set()
const restoredEndpoints = new Map()
reader.on('line', async line => {
  const message = JSON.parse(line)
  const threadId = message.params?.threadId
  if (message.method === 'thread/unsubscribe' && String(threadId).startsWith('lost-lifecycle-')) return
  if (message.method === 'thread/unsubscribe' && threadId === 'unloaded-pending-lifecycle') return
  if (String(threadId).startsWith('unloaded-')) {
    if (message.method === 'thread/read') {
      const active = threadId === 'unloaded-active'
      const native = threadId === 'unloaded-native'
      process.stdout.write(`${
        JSON.stringify({
          id: message.id,
          result: {
            thread: {
              id: threadId === 'unloaded-wrong-id' ? 'another-thread' : threadId,
              modelProvider: native ? 'openai' : 'provider-b',
              model: 'model-b',
              status: {
                type: active || resumedThreads.has(threadId) && threadId === 'unloaded-changed-before-replay'
                  ? 'active'
                  : threadId === 'unloaded-unknown'
                  ? 'unknown'
                  : resumedThreads.has(threadId)
                  ? 'idle'
                  : 'notLoaded',
              },
            },
          },
        })
      }\n`)
      return
    }
    if (message.method === 'thread/resume') {
      if (threadId === 'unloaded-resume-fails') {
        process.stdout.write(
          `${JSON.stringify({ id: message.id, error: { code: -32001, message: 'permission denied' } })}\n`,
        )
        return
      }
      resumedThreads.add(threadId)
      process.stdout.write(`${
        JSON.stringify({
          id: message.id,
          result: {
            thread: { id: threadId, status: { type: threadId === 'unloaded-resume-active' ? 'active' : 'idle' } },
            modelProvider: threadId === 'unloaded-provider-mismatch' ? 'another-provider' : 'provider-b',
            model: 'model-b',
            received: message.params,
          },
        })
      }\n`)
      return
    }
    if (message.method === 'turn/start' && (!resumedThreads.has(threadId) || threadId === 'unloaded-retry-fails')) {
      const error = threadId === 'unloaded-wrong-error-id'
        ? { code: -32600, message: 'thread not found: another-thread' }
        : threadId === 'unloaded-wrong-error-code'
        ? { code: -32001, message: `thread not found: ${threadId}` }
        : { code: -32600, message: `thread not found: ${threadId}` }
      process.stdout.write(`${JSON.stringify({ id: message.id, error })}\n`)
      return
    }
    if (message.method === 'turn/start' && threadId === 'unloaded-replay-denied') {
      process.stdout.write(
        `${JSON.stringify({ id: message.id, error: { code: -32001, message: 'replay permission denied' } })}\n`,
      )
      return
    }
    if (message.method === 'turn/start' && threadId === 'unloaded-replay-unknown') {
      process.stdout.write(`${JSON.stringify({ id: message.id, error: null })}\n`)
      return
    }
  }
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
  if (message.method === 'thread/read' && String(message.params?.threadId).startsWith('agent-')) {
    process.stdout.write(
      JSON.stringify({
        id: message.id,
        result: {
          thread: {
            id: message.params.threadId,
            status: { type: message.params.threadId.slice(6) },
          },
        },
      }) + '\n',
    )
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
  if (threadId === 'recognized-managed-replay' && message.method === 'turn/start') {
    const response = await fetch(restoredEndpoints.get(threadId) + '/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-auth' },
      body: JSON.stringify(message.params.request),
    })
    process.stdout.write(
      JSON.stringify({
        id: message.id,
        result: {
          status: response.status,
          received: await response.json(),
        },
      }) + '\n',
    )
    return
  }
  if (threadId === 'recognized-managed-replay' && message.method === 'thread/resume') {
    restoredEndpoints.set(threadId, message.params.config?.['model_providers.provider-b']?.base_url)
  }
  if (threadId === 'recognized-managed-failed' && message.method === 'thread/resume') {
    process.stdout.write(
      JSON.stringify({ id: message.id, error: { code: -32001, message: 'native resume denied' } }) + '\n',
    )
    return
  }
  if (String(threadId).startsWith('recognized-managed-') && message.method === 'thread/read') {
    process.stdout.write(
      JSON.stringify({
        id: message.id,
        result: {
          thread: {
            id: threadId,
            modelProvider: 'provider-b',
            model: 'model-b',
            status: { type: 'notLoaded' },
          },
        },
      }) + '\n',
    )
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
          ...(message.method === 'thread/start'
            ? { modelProvider: message.params.modelProvider, model: message.params.model }
            : {}),
          leakedControlEnvironment: Object.keys(process.env).filter(key =>
            key.startsWith('CORDISX_NATIVE_') || key === 'CODEX_CLI_PATH'
          ),
        },
      })
    }\n`,
  )
})
