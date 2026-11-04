import { expect, it, vi } from 'vitest'
import { harness } from './fixtures/native-submission-channel-harness.js'

it('keeps an admitted new draft through composer retirement and the exact first native turn', async () => {
  const h = await harness({
    realController: true,
    catalog:
      () => [{ providerId: 'provider-b', pluginId: 'plugin-b', label: 'B', models: [{ id: 'model-b', label: 'B' }] }],
  })
  const scope = { ...h.draft, composerId: 'retired-home' }
  h.setLive(scope)
  try {
    await h.channel.selectionRead({ scope, effective: { providerId: 'openai', model: 'native' } })
    await h.channel.selectionSelect({ scope, providerId: 'provider-b', model: 'model-b', expectedRevision: 1 })
    const grant = await h.channel.submissionPrepare({
      scope,
      action: {
        operationId: 'native-draft-operation',
        operationGeneration: 1,
        intent: 'ordinary-send',
        target: 'local',
      },
    })
    if (grant.status !== 'allow-original') throw new Error(`draft not admitted: ${JSON.stringify(grant)}`)
    // Native Send retires the homepage before thread/start reaches app-server.
    h.setLive({ ...scope, composerId: 'another-composer', threadId: 'unrelated' })
    const start = { operationToken: grant.operationToken, requestId: 'create-1', method: 'thread/start' as const }
    await expect(h.actual.consumeMarkedRequest(start)).resolves.toMatchObject({
      kind: 'dispatch',
      providerId: 'provider-b',
    })
    await expect(h.actual.authorizeMarkedRequest(start)).resolves.toBe(true)
    await h.actual.completeMarkedRequest({ ...start, succeeded: true, boundThreadId: 'native-returned' })
    const first = {
      operationToken: grant.operationToken,
      requestId: 'first-1',
      method: 'turn/start' as const,
      threadId: 'native-returned',
    }
    await expect(h.actual.consumeMarkedRequest(first)).resolves.toMatchObject({ kind: 'dispatch', model: 'model-b' })
    await expect(h.actual.authorizeMarkedRequest(first)).resolves.toBe(true)
    await h.actual.completeMarkedRequest({ ...first, succeeded: true })
    await expect(h.actual.consumeMarkedRequest({ ...first, requestId: 'replay' })).resolves.toMatchObject({
      kind: 'reject',
    })
    expect(h.switchThread).not.toHaveBeenCalled()
  } finally {
    await h.installed.dispose()
    await h.actual.dispose()
  }
})

it.each(['reload', 'expired', 'catalog', 'selection', 'closed'])(
  'rejects a retired draft when its %s fence changes',
  async fence => {
    let timeOrigin = 1_000
    let present = true
    let now = 0
    const h = await harness({
      realController: true,
      documentTimeOrigin: () => timeOrigin,
      controllerOptions: { now: () => now, operationTtlMs: 100 },
      catalog: () =>
        present
          ? [{ providerId: 'provider-b', pluginId: 'plugin-b', label: 'B', models: [{ id: 'model-b', label: 'B' }] }]
          : [],
    })
    const scope = { ...h.draft, composerId: 'home' }
    h.setLive(scope)
    try {
      await h.channel.selectionRead({ scope, effective: { providerId: 'openai', model: 'native' } })
      await h.channel.selectionSelect({ scope, providerId: 'provider-b', model: 'model-b', expectedRevision: 1 })
      const grant = await h.channel.submissionPrepare({
        scope,
        action: { operationId: 'draft-operation', operationGeneration: 1, intent: 'ordinary-send' },
      })
      if (grant.status !== 'allow-original') throw new Error('not admitted')
      if (fence === 'selection') {
        await h.channel.selectionSelect({ scope, providerId: 'openai', model: 'native', expectedRevision: 2 })
      }
      h.setLive({ ...scope, composerId: 'replacement' })
      if (fence === 'reload') timeOrigin++
      if (fence === 'expired') now = 101
      if (fence === 'catalog') present = false
      if (fence === 'closed') await h.installed.dispose()
      await expect(
        h.actual.consumeMarkedRequest({
          operationToken: grant.operationToken,
          requestId: 'start',
          method: 'thread/start',
        }),
      ).resolves.toMatchObject({ kind: 'reject' })
    } finally {
      await h.installed.dispose()
      await h.actual.dispose()
    }
  },
)

it('rechecks the document after reservation before dispatch', async () => {
  let timeOrigin = 1_000
  const h = await harness({
    realController: true,
    documentTimeOrigin: () => timeOrigin,
    catalog:
      () => [{ providerId: 'provider-b', pluginId: 'plugin-b', label: 'B', models: [{ id: 'model-b', label: 'B' }] }],
  })
  const scope = { ...h.draft, composerId: 'home' }
  h.setLive(scope)
  try {
    await h.channel.selectionRead({ scope, effective: { providerId: 'openai', model: 'native' } })
    await h.channel.selectionSelect({ scope, providerId: 'provider-b', model: 'model-b', expectedRevision: 1 })
    const grant = await h.channel.submissionPrepare({
      scope,
      action: { operationId: 'draft-operation', operationGeneration: 1, intent: 'ordinary-send' },
    })
    if (grant.status !== 'allow-original') throw new Error('not admitted')
    const start = { operationToken: grant.operationToken, requestId: 'start', method: 'thread/start' as const }
    await expect(h.actual.consumeMarkedRequest(start)).resolves.toMatchObject({ kind: 'dispatch' })
    timeOrigin++
    await expect(h.actual.authorizeMarkedRequest(start)).resolves.toBe(false)
    expect(h.credentialDispose).toHaveBeenCalledOnce()
  } finally {
    await h.installed.dispose()
    await h.actual.dispose()
  }
})

it('retains a remote new-draft operation for the returned thread and rejects another thread', async () => {
  const lease = {
    serviceGeneration: 'remote',
    provider: { base_url: 'http://127.0.0.1:43127/v1', wire_api: 'responses' },
    validate: async () => true,
    dispose: vi.fn(),
  }
  const h = await harness({
    realController: true,
    controllerOptions: { providerSource: () => 'remote', prepareRemoteProvider: async () => lease },
    catalog:
      () => [{ providerId: 'provider-b', pluginId: 'plugin-b', label: 'B', models: [{ id: 'model-b', label: 'B' }] }],
  })
  const scope = { ...h.draft, composerId: 'remote-home' }
  h.setLive(scope)
  try {
    await h.channel.selectionRead({ scope, effective: { providerId: 'provider-b', model: 'model-b' } })
    const grant = await h.channel.submissionPrepare({
      scope,
      action: { operationId: 'draft-operation', operationGeneration: 1, intent: 'ordinary-send' },
    })
    if (grant.status !== 'allow-original') throw new Error('not admitted')
    h.setLive({ ...scope, composerId: 'replacement' })
    const start = { operationToken: grant.operationToken, requestId: 'start', method: 'thread/start' as const }
    await expect(h.actual.consumeMarkedRequest(start)).resolves.toMatchObject({ kind: 'dispatch' })
    await expect(h.actual.authorizeMarkedRequest(start)).resolves.toBe(true)
    await h.actual.completeMarkedRequest({ ...start, succeeded: true, boundThreadId: 'returned' })
    await expect(
      h.actual.consumeMarkedRequest({
        ...start,
        requestId: 'wrong-first',
        method: 'turn/start',
        threadId: 'unrelated',
      }),
    ).resolves.toMatchObject({ kind: 'reject' })
  } finally {
    await h.installed.dispose()
    await h.actual.dispose()
  }
})
