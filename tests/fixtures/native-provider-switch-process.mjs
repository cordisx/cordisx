import { createInterface } from 'node:readline'

const override = process.argv.find(argument => argument.startsWith('model_provider='))
const current = override ? JSON.parse(override.slice('model_provider='.length)) : 'openai'
const loaded = new Set()
const requests = []
let failNextRead = false
const emit = value => process.stdout.write(JSON.stringify(value) + '\n')
const historical = id => id.startsWith('locked-openai') ? 'openai' : 'provider-b'
const thread = id => ({
  id,
  modelProvider: historical(id),
  model: 'test-model',
  status: { type: loaded.has(id) ? 'idle' : 'notLoaded' },
})

createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  const params = message.params ?? {}
  const id = params.threadId
  requests.push({ method: message.method, providerId: params.modelProvider })
  if (message.method === 'initialized') return
  if (message.method === 'thread/start') {
    const created = params.id ?? `locked-${current}`
    loaded.add(created)
    emit({
      id: message.id,
      result: { thread: thread(created), modelProvider: current, model: 'test-model', current },
    })
    return
  }
  if (message.method === 'thread/read') {
    if (failNextRead) {
      failNextRead = false
      emit({ id: message.id, error: { code: -32001, message: 'saved thread unavailable' } })
      return
    }
    emit({ id: message.id, result: { thread: thread(id) } })
    return
  }
  if (message.method === 'thread/unsubscribe') {
    loaded.delete(id)
    if (id.endsWith('-late-unsubscribe')) {
      setTimeout(() => emit({ id: message.id, result: { status: 'unsubscribed' } }), 100)
    } else emit({ id: message.id, result: { status: 'unsubscribed' } })
    return
  }
  if (message.method === 'thread/resume') {
    if (params.fixture === 'denied') {
      emit({ id: message.id, error: { code: -32001, message: 'permission denied' } })
      return
    }
    if (['wrong-thread', 'wrong-provider', 'wrong-model', 'active'].includes(params.fixture)) {
      emit({
        id: message.id,
        result: {
          thread: {
            ...thread(id),
            id: params.fixture === 'wrong-thread' ? 'another-thread' : id,
            status: { type: params.fixture === 'active' ? 'active' : 'idle' },
          },
          modelProvider: params.fixture === 'wrong-provider' ? 'another-provider' : current,
          model: params.fixture === 'wrong-model' ? 'another-model' : 'test-model',
        },
      })
      return
    }
    const persisted = historical(id)
    const target = params.modelProvider ?? persisted
    if (current !== persisted || current !== target) {
      const table = params.config?.[`model_providers.${persisted}`]
      emit({
        id: message.id,
        error: {
          code: -32600,
          data: current !== persisted && persisted !== 'openai' && !table
            ? { type: 'modelProviderNotConfigured', modelProvider: persisted }
            : {
              type: 'modelProviderMismatch',
              modelProvider: current !== persisted ? persisted : target,
              currentModelProvider: current,
            },
        },
      })
      return
    }
    if (id.endsWith('-restore-denied')) {
      emit({ id: message.id, error: { code: -32001, message: 'restoration denied' } })
      return
    }
    loaded.add(id)
    emit({ id: message.id, result: { thread: thread(id), modelProvider: current, model: 'test-model', current } })
    return
  }
  if (message.method === 'fixture/metadata') {
    emit({ id: message.id, result: { current, loaded: loaded.has(id), requests } })
    return
  }
  if (message.method === 'fixture/failNextRead') failNextRead = true
  emit({ id: message.id, result: { current } })
})
