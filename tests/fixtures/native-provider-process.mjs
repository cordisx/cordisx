import { createInterface } from 'node:readline'
import { createHash } from 'node:crypto'

const selected = process.argv.find(argument => argument.startsWith('model_provider='))
const current = selected ? JSON.parse(selected.slice('model_provider='.length)) : 'openai'
const threads = new Map()
const approvals = new Map()
const heldWrites = new Map()
let sequence = 0
const emit = value => process.stdout.write(JSON.stringify(value) + '\n')
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  const params = message.params ?? {}
  if (message.method === undefined) {
    if (typeof message.id === 'string' && message.id.startsWith('cordisx-provider-request-')) {
      emit({ id: message.id, result: { unexpectedStaleApproval: true } })
    }
    const pending = approvals.get(message.id)
    if (pending) {
      approvals.delete(message.id)
      emit({ id: pending, result: { approved: message.result, current } })
    }
    return
  }
  if (message.method === 'initialized') return
  if (message.method === 'fixture/exit') process.exit(7)
  if (['thread/start', 'thread/resume', 'thread/fork'].includes(message.method)) {
    const fork = message.method === 'thread/fork'
    if (fork && params.modelProvider !== current) {
      emit({
        id: message.id,
        error: { code: -32600, data: { type: 'modelProviderMismatch', currentModelProvider: current } },
      })
      return
    }
    const id = fork ? `fork-${current}-${++sequence}` : params.threadId ?? `native-${current}-${++sequence}`
    const modelProvider = params.modelProvider ?? current
    threads.set(id, modelProvider)
    emit({
      id: message.id,
      result: {
        thread: { id, modelProvider, model: 'test-model', status: { type: 'idle' } },
        modelProvider,
        current,
        model: 'test-model',
        workerInert: process.argv.some(argument => argument.includes('base_url="http://127.0.0.1:0/v1"')),
        runtimeHeaderResolved: Object.values(
          params.config?.[`model_providers.${modelProvider}`]?.env_http_headers ?? {},
        )
          .every(name => process.env[name] === 'test-private-token'),
        argvHasSecret: process.argv.some(arg => arg.includes('test-private-token')),
        receivedConfig: params.config,
        ...(fork ? { sourceThreadId: params.threadId, thread: { id, modelProvider, status: { type: 'idle' } } } : {}),
      },
    })
  } else if (message.method === 'thread/read') {
    const modelProvider = threads.get(params.threadId) ?? 'provider-b'
    emit({
      id: message.id,
      result: {
        thread: {
          id: params.threadId,
          modelProvider,
          model: 'test-model',
          status: { type: threads.has(params.threadId) ? 'idle' : 'notLoaded' },
          ...(params.fixtureBytes === undefined ? {} : {
            turns: [{ items: [{ type: 'agentMessage', text: 'x'.repeat(params.fixtureBytes) }] }],
          }),
        },
      },
    })
  } else if (message.method === 'thread/unsubscribe') {
    threads.delete(params.threadId)
    emit({ id: message.id, result: { status: 'unsubscribed' } })
  } else if (message.method === 'thread/turns/list') {
    emit({
      id: message.id,
      result: { data: [{ id: 'fixture-turn', status: 'inProgress', items: [] }], nextCursor: null },
    })
  } else if (message.method === 'thread/items/list') {
    emit({
      id: message.id,
      result: {
        data: [{ turnId: 'fixture-turn', item: { type: 'agentMessage', text: 'fixture-history' } }],
        nextCursor: null,
      },
    })
  } else if (message.method === 'turn/start') {
    const expected = threads.get(params.threadId)
    const turn = expected === current ? { id: `turn-${++sequence}`, status: 'inProgress' } : undefined
    if (turn && params.fixtureNotify) emit({ method: 'turn/started', params: { threadId: params.threadId, turn } })
    emit(
      expected !== current
        ? {
          id: message.id,
          error: {
            code: -32600,
            data: { type: 'modelProviderMismatch', modelProvider: expected, currentModelProvider: current },
          },
        }
        : {
          id: message.id,
          result: {
            turn,
            current,
            ...(params.fixtureNotify ? { fixtureConfigPresent: params.config !== undefined } : {}),
            ...(params.input?.[0]?.text === undefined ? {} : {
              textLength: params.input[0].text.length,
              textDigest: createHash('sha256').update(params.input[0].text).digest('hex'),
            }),
          },
        },
    )
  } else if (message.method === 'fixture/finish-turn') {
    emit({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: params.turnId } } })
    emit({ id: message.id, result: { completed: true } })
  } else if (message.method === 'fixture/start-turn-notification') {
    emit({ method: 'turn/started', params: { threadId: params.threadId, turn: { id: 'turn', privateText: 'hidden' } } })
    emit({ id: message.id, result: { completed: true } })
  } else if (message.method === 'fixture/approval') {
    approvals.set(1, message.id)
    emit({ id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: params.threadId } })
  } else if (message.method === 'fixture/hold-write') {
    heldWrites.set(params.threadId, message.id)
    emit({ method: 'fixture/write-accepted', params: { threadId: params.threadId } })
  } else if (message.method === 'fixture/finish-write') {
    const held = heldWrites.get(params.threadId)
    heldWrites.delete(params.threadId)
    emit({ id: held, result: { completed: true } })
    emit({ id: message.id, result: { completed: true } })
  } else if (message.method === 'fixture/logical-history') {
    approvals.set(2, message.id)
    emit({
      id: 2,
      method: 'item/tool/call',
      params: {
        threadId: params.threadId,
        turnId: params.turnId ?? 'turn',
        callId: 'call',
        tool: 'cordisx_continuation_history',
        arguments: {},
      },
    })
  } else if (message.method === 'fixture/cancel-approval') {
    const pending = approvals.get(1)
    approvals.delete(1)
    emit({ method: 'serverRequest/resolved', params: { requestId: 1, threadId: params.threadId } })
    emit({ id: pending, error: { code: -32000, message: 'approval cancelled' } })
    emit({ id: message.id, result: { cancelled: true } })
  } else emit({ id: message.id, result: { current } })
})
