import { expect, it } from 'vitest'
import { harness } from './fixtures/native-intermediary-harness.js'

it('routes the normal intermediary startup and admitted first turn through a matching native provider process', async () => {
  const h = await harness(undefined, 'native-provider-process.mjs')
  try {
    h.send({ id: 'init', method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } })
    expect(JSON.parse(await h.read()).id).toBe('init')
    h.send({ method: 'initialized', params: {} })
    h.send({
      id: 'start',
      method: 'thread/start',
      params: {
        config: { 'cordisx.operation_token': 'allowed-operation-token' },
        modelProvider: 'openai',
      },
    })
    const started = JSON.parse(await h.read())
    expect(started.result.modelProvider).toBe('provider-b')
    const threadId = started.result.thread.id
    h.send({
      id: 'turn',
      method: 'turn/start',
      params: {
        threadId,
        input: [{ type: 'text', text: 'opaque original input' }],
        config: { 'cordisx.operation_token': 'allowed-firstturn-token' },
      },
    })
    expect(JSON.parse(await h.read()).result.current).toBe('provider-b')
    expect(h.authorize).toHaveBeenCalledTimes(2)
    expect(h.complete).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'turn', succeeded: true }))
  } finally {
    await h.close()
  }
})

it('resumes a persisted provider through normal Host preparation and keeps native config on the primary connection', async () => {
  const h = await harness(undefined, 'native-provider-process.mjs')
  try {
    h.send({ id: 'init', method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } })
    await h.read()
    h.send({ method: 'initialized', params: {} })
    h.send({ id: 'resume', method: 'thread/resume', params: { threadId: 'saved-provider-b', excludeTurns: true } })
    const resumed = JSON.parse(await h.read())
    expect(resumed.result.thread.id).toBe('saved-provider-b')
    expect(resumed.result.modelProvider).toBe('provider-b')
    expect(h.prepareThreadResume).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'saved-provider-b', providerId: 'provider-b' }),
    )
    h.send({ id: 'turn', method: 'turn/start', params: { threadId: 'saved-provider-b', input: [] } })
    expect(JSON.parse(await h.read()).result.current).toBe('provider-b')
    h.send({ id: 'config', method: 'config/read', params: {} })
    expect(JSON.parse(await h.read()).result.current).toBe('openai')
  } finally {
    await h.close()
  }
})
