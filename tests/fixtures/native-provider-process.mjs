import { createInterface } from 'node:readline'

const selected = process.argv.find(argument => argument.startsWith('model_provider='))
const current = selected ? JSON.parse(selected.slice('model_provider='.length)) : 'openai'
const threads = new Map()
const approvals = new Map()
let sequence = 0
const emit = value => process.stdout.write(JSON.stringify(value) + '\n')
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  const params = message.params ?? {}
  if (message.method === undefined) {
    const pending = approvals.get(message.id)
    if (pending) {
      approvals.delete(message.id)
      emit({ id: pending, result: { approved: message.result, current } })
    }
    return
  }
  if (message.method === 'initialized') return
  if (message.method === 'fixture/exit') process.exit(7)
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    const id = params.threadId ?? `native-${current}-${++sequence}`
    const modelProvider = params.modelProvider ?? current
    threads.set(id, modelProvider)
    emit({
      id: message.id,
      result: {
        thread: { id, modelProvider, model: 'test-model', status: { type: 'idle' } },
        modelProvider,
        model: 'test-model',
        argvHasSecret: process.argv.some(arg => arg.includes('test-private-token')),
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
        },
      },
    })
  } else if (message.method === 'thread/unsubscribe') {
    threads.delete(params.threadId)
    emit({ id: message.id, result: { status: 'unsubscribed' } })
  } else if (message.method === 'turn/start') {
    const expected = threads.get(params.threadId)
    emit(
      expected !== current
        ? {
          id: message.id,
          error: {
            code: -32600,
            data: { type: 'modelProviderMismatch', modelProvider: expected, currentModelProvider: current },
          },
        }
        : { id: message.id, result: { turn: { id: `turn-${++sequence}`, status: 'inProgress' }, current } },
    )
  } else if (message.method === 'fixture/approval') {
    approvals.set(1, message.id)
    emit({ id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: params.threadId } })
  } else emit({ id: message.id, result: { current } })
})
