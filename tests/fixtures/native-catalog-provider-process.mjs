import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const selected = process.argv.findLast(argument => argument.startsWith('model_provider='))
const current = selected ? JSON.parse(selected.slice('model_provider='.length)) : 'openai'
const catalogArg = process.argv.findLast(argument => argument.startsWith('model_catalog_json='))
const catalogPath = catalogArg && JSON.parse(catalogArg.slice('model_catalog_json='.length))
const catalog = catalogPath && JSON.parse(readFileSync(catalogPath, 'utf8'))
const threads = new Set()
let sequence = 0
let catalogVerified = !catalogPath
const emit = value => process.stdout.write(JSON.stringify(value) + '\n')
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line), params = message.params ?? {}
  if (message.method === 'initialized') return
  if (message.method === 'config/read') {
    setTimeout(() => {
      catalogVerified = true
      emit({ id: message.id, result: { config: { model_provider: current, model_catalog_json: catalogPath ?? null } } })
    }, Number(process.env.FIXTURE_CATALOG_DELAY ?? 0))
  } else if (['thread/start', 'thread/resume', 'thread/fork'].includes(message.method)) {
    const id = params.threadId ?? `fixture-${process.pid}-${++sequence}`
    threads.add(id)
    if (params.fixtureNotifyStart) {
      emit({ method: 'thread/started', params: { thread: { id, modelProvider: current, status: { type: 'idle' } } } })
    }
    emit({
      id: message.id,
      result: {
        thread: { id, modelProvider: current, status: { type: 'idle' } },
        model: params.model,
        modelProvider: current,
        pid: process.pid,
        contextWindow: catalog?.models.find(model => model.slug === params.model)?.context_window ?? null,
        unrelatedSecretPresent: process.env.FIXTURE_UNRELATED_SECRET !== undefined,
        catalogVerified,
      },
    })
  } else if (message.method === 'thread/unsubscribe') {
    threads.delete(params.threadId)
    emit({ id: message.id, result: { status: 'unsubscribed' } })
  } else if (message.method === 'turn/start') {
    emit({ id: message.id, result: { pid: process.pid, known: threads.has(params.threadId) } })
  } else emit({ id: message.id, result: {} })
})
