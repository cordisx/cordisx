import { describe, expect, it, vi } from 'vitest'
import { harness } from './fixtures/native-intermediary-harness.js'
import { NativeThreadSwitchError } from '../packages/cli/src/launcher/native-thread-switch-error.js'
import {
  harness as controllerHarness,
  pendingThread,
  threadAction,
  threadScope,
} from './fixtures/native-submission-controller-harness.js'
import { harness as channelHarness } from './fixtures/native-submission-channel-harness.js'
import { modelProviderCopy } from '../packages/cli/src/renderer/model-provider-copy.js'
import {
  NativeProviderSelectionClient,
  type NativeProviderSelectionCommandChannel,
} from '../packages/cli/src/renderer/native-provider-selection-client.js'
import { switchNativeThread } from '../packages/cli/assets/launcher/native-thread-switch.mjs'

const config = (providerId: string) => ({
  model_provider: providerId,
  model: 'test-model',
  ...(providerId === 'openai' ? {} : {
    [`model_providers.${providerId}`]: {
      wire_api: 'responses',
      base_url: 'http://127.0.0.1:0/v1',
      requires_openai_auth: false,
    },
  }),
})

it('provides a concrete native provider limitation without recommending repeated retry', () => {
  expect(modelProviderCopy('zh-CN').switchUnsupported).toContain('无法在这个对话中切换')
  expect(modelProviderCopy('en').switchUnsupported).toContain('cannot change the model service')
})

it('does not guess a rollback when native resume acknowledgement is uncertain', async () => {
  const threadId = 'saved'
  const nativeCall = vi.fn(async method => {
    if (method === 'thread/read') {
      return { thread: { id: threadId, modelProvider: 'old-provider', model: 'old-model', status: { type: 'idle' } } }
    }
    if (method === 'thread/unsubscribe') return {}
    throw new Error('Native transport timeout')
  })
  const controlCall = vi.fn()
  expect(
    await switchNativeThread({ threadId, providerId: 'new-provider', model: 'new-model', config: {} }, {
      nativeCall,
      controlCall,
      current: () => true,
    }),
  ).toEqual({ ok: false, reason: 'provider-switch-reconciliation-required' })
  expect(nativeCall.mock.calls.filter(([method]) => method === 'thread/resume')).toHaveLength(1)
  expect(controlCall).not.toHaveBeenCalled()
})

it('keeps an uncertain unsubscribe fenced even when its acknowledgement arrives after the timeout', async () => {
  const threadId = 'saved'
  let lateAcknowledgement: (() => void) | undefined
  const nativeCall = vi.fn(async method => {
    if (method === 'thread/read') {
      return { thread: { id: threadId, modelProvider: 'old-provider', model: 'old-model', status: { type: 'idle' } } }
    }
    if (method === 'thread/unsubscribe') {
      lateAcknowledgement = () => ({ status: 'unsubscribed' })
      throw new Error('Native transport timeout')
    }
    return {}
  })
  const controlCall = vi.fn()
  expect(
    await switchNativeThread({ threadId, providerId: 'new-provider', model: 'new-model', config: {} }, {
      nativeCall,
      controlCall,
      current: () => true,
    }),
  ).toEqual({ ok: false, reason: 'provider-switch-reconciliation-required' })
  lateAcknowledgement?.()
  expect(nativeCall.mock.calls.map(([method]) => method)).toEqual(['thread/read', 'thread/unsubscribe'])
  expect(controlCall).not.toHaveBeenCalled()
})

it('keeps same-thread provider switching supported when the native process acknowledges it', async () => {
  const threadId = 'saved'
  const nativeCall = vi.fn(async method =>
    method === 'thread/read'
      ? { thread: { id: threadId, modelProvider: 'old-provider', model: 'old-model', status: { type: 'idle' } } }
      : method === 'thread/resume'
      ? { thread: { id: threadId, status: { type: 'idle' } }, modelProvider: 'new-provider', model: 'new-model' }
      : {}
  )
  const controlCall = vi.fn()
  expect(
    await switchNativeThread({ threadId, providerId: 'new-provider', model: 'new-model', config: {} }, {
      nativeCall,
      controlCall,
      current: () => true,
    }),
  ).toEqual({ ok: true })
  expect(controlCall).not.toHaveBeenCalled()
})

it.each([
  ['provider-b', 'openai'],
  ['openai', 'provider-c'],
])('restores %s after a definite native rejection of switching to %s', async (prior, target) => {
  const h = await harness(undefined, 'native-provider-switch-process.mjs')
  const threadId = `locked-${prior}`
  try {
    h.send({ id: 'initialize', method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } })
    await h.read()
    h.send({ method: 'initialized', params: {} })
    h.send({ id: 'start', method: 'thread/start', params: { modelProvider: prior, config: config(prior) } })
    const started = JSON.parse(await h.read())
    expect(started.result).toMatchObject({ current: prior, thread: { id: threadId } })
    h.prepareThreadResume.mockResolvedValue({
      kind: 'resume',
      resumeToken: 'restore-old-provider-lease',
      configOverrides: config(prior),
    })
    const failure = await h.server.existingThread.switch({
      scope: { targetId: 'target', rendererGeneration: 'renderer', navigationGeneration: 1, threadId },
      threadId,
      providerId: target,
      model: 'test-model',
      serviceGeneration: 'new-generation',
      configOverrides: config(target),
    }).then(() => undefined, error => error as Error & { reason?: string })
    h.send({ id: 'read-old', method: 'thread/read', params: { threadId } })
    const read = JSON.parse(await h.read())
    h.send({ id: 'metadata', method: 'fixture/metadata', params: { threadId } })
    const metadata = JSON.parse(await h.read())
    expect({ reason: failure?.reason, thread: read.result.thread, current: metadata.result.current }).toEqual({
      reason: 'provider-switch-unsupported',
      thread: { id: threadId, modelProvider: prior, model: 'test-model', status: { type: 'idle' } },
      current: prior,
    })
    expect(metadata.result.requests.filter((request: { method: string }) => request.method === 'turn/start')).toEqual(
      [],
    )
    if (prior === 'openai') expect(h.prepareThreadResume).not.toHaveBeenCalled()
    else {
      expect(h.completeThreadResume).toHaveBeenCalledWith({
        threadId,
        resumeToken: 'restore-old-provider-lease',
        succeeded: true,
      })
    }
  } finally {
    await h.close()
  }
})

it('does not restore an old session after the initiating selection generation is cancelled', async () => {
  const h = await harness(undefined, 'native-provider-switch-process.mjs')
  const threadId = 'locked-provider-b'
  try {
    h.send({ id: 'initialize', method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } })
    await h.read()
    h.send({ method: 'initialized', params: {} })
    h.send({
      id: 'start',
      method: 'thread/start',
      params: { modelProvider: 'provider-b', config: config('provider-b') },
    })
    await h.read()
    await expect(h.server.existingThread.switch({
      scope: { targetId: 't', rendererGeneration: 'r', navigationGeneration: 1, threadId },
      threadId,
      providerId: 'openai',
      model: 'test-model',
      serviceGeneration: 'g',
      configOverrides: config('openai'),
      revalidateRestoration: async () => false,
    })).rejects.toMatchObject({ reason: 'provider-switch-reconciliation-required' })
    expect(h.prepareThreadResume).not.toHaveBeenCalled()
    expect(h.completeThreadResume).not.toHaveBeenCalled()
  } finally {
    await h.close()
  }
})

it('releases the candidate restoration lease when native restoration is denied', async () => {
  const h = await harness(undefined, 'native-provider-switch-process.mjs')
  const threadId = 'locked-provider-b-restore-denied'
  try {
    h.send({ id: 'initialize', method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } })
    await h.read()
    h.send({ method: 'initialized', params: {} })
    h.send({
      id: 'start',
      method: 'thread/start',
      params: { id: threadId, modelProvider: 'provider-b', config: config('provider-b') },
    })
    await h.read()
    h.prepareThreadResume.mockResolvedValue({
      kind: 'resume',
      resumeToken: 'restore-denied-lease',
      configOverrides: config('provider-b'),
    })
    await expect(h.server.existingThread.switch({
      scope: { targetId: 't', rendererGeneration: 'r', navigationGeneration: 1, threadId },
      threadId,
      providerId: 'openai',
      model: 'test-model',
      serviceGeneration: 'g',
      configOverrides: config('openai'),
    })).rejects.toMatchObject({ reason: 'provider-switch-reconciliation-required' })
    expect(h.completeThreadResume).toHaveBeenCalledWith({
      threadId,
      resumeToken: 'restore-denied-lease',
      succeeded: false,
    })
  } finally {
    await h.close()
  }
})

it('stops a timed-out switch after a late unsubscribe and keeps native Send fenced without leaking private frames', async () => {
  const h = await harness(undefined, 'native-provider-switch-process.mjs', { requestTimeoutMs: 20 })
  const threadId = 'locked-provider-b-late-unsubscribe'
  let finishCompletion: (value: boolean) => void = () => undefined
  try {
    h.send({ id: 'initialize', method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } })
    await h.read()
    h.send({ method: 'initialized', params: {} })
    h.send({
      id: 'start',
      method: 'thread/start',
      params: { id: threadId, modelProvider: 'provider-b', config: config('provider-b') },
    })
    await h.read()
    await expect(h.server.existingThread.switch({
      scope: { targetId: 't', rendererGeneration: 'r', navigationGeneration: 1, threadId },
      threadId,
      providerId: 'openai',
      model: 'test-model',
      serviceGeneration: 'g',
      configOverrides: config('openai'),
    })).rejects.toMatchObject({ reason: 'provider-switch-reconciliation-required' })
    await new Promise(resolve => setTimeout(resolve, 150))
    h.send({ id: 'blocked-send', method: 'turn/start', params: { threadId, input: [] } })
    expect(JSON.parse(await h.read())).toMatchObject({
      id: 'blocked-send',
      error: { code: -32000, message: expect.stringContaining('switch status is uncertain') },
    })
    await expect(h.server.nativeRequest('turn/start', { threadId, input: [] })).rejects.toMatchObject({
      reason: 'provider-switch-reconciliation-required',
    })
    h.send({ id: 'metadata', method: 'fixture/metadata', params: { threadId } })
    const metadata = JSON.parse(await h.read())
    expect(metadata.id).toBe('metadata')
    expect(
      metadata.result.requests.filter((request: { method: string }) =>
        ['thread/resume', 'turn/start'].includes(request.method)
      ),
    ).toEqual([])
    expect(h.prepareThreadResume).not.toHaveBeenCalled()
    expect(h.completeThreadResume).not.toHaveBeenCalled()
    h.send({ id: 'fail-next-read', method: 'fixture/failNextRead', params: {} })
    expect(JSON.parse(await h.read()).id).toBe('fail-next-read')
    h.send({
      id: 'reopen-read-failed',
      method: 'thread/resume',
      params: { threadId, modelProvider: 'provider-b', model: 'test-model', config: config('provider-b') },
    })
    expect(JSON.parse(await h.read())).toMatchObject({
      id: 'reopen-read-failed',
      error: { message: expect.stringContaining('switch status is uncertain') },
    })
    h.send({ id: 'read-failure-metadata', method: 'fixture/metadata', params: { threadId } })
    expect(
      JSON.parse(await h.read()).result.requests.some((request: { method: string }) =>
        request.method === 'thread/resume'
      ),
    ).toBe(false)
    for (const fixture of ['denied', 'wrong-thread', 'wrong-provider', 'wrong-model', 'active']) {
      h.send({
        id: `reopen-${fixture}`,
        method: 'thread/resume',
        params: {
          threadId,
          fixture,
          modelProvider: 'provider-b',
          model: 'test-model',
          config: config('provider-b'),
          excludeTurns: true,
        },
      })
      expect(JSON.parse(await h.read()).id).toBe(`reopen-${fixture}`)
      expect(h.completeThreadResume).toHaveBeenLastCalledWith({
        threadId,
        resumeToken: `resume-token-${threadId}`,
        succeeded: false,
      })
      h.send({ id: `still-blocked-${fixture}`, method: 'turn/start', params: { threadId, input: [] } })
      expect(JSON.parse(await h.read())).toMatchObject({
        id: `still-blocked-${fixture}`,
        error: { message: expect.stringContaining('switch status is uncertain') },
      })
    }
    h.completeThreadResume.mockResolvedValueOnce(false)
    h.send({
      id: 'reopen-host-rejected',
      method: 'thread/resume',
      params: {
        threadId,
        modelProvider: 'provider-b',
        model: 'test-model',
        config: config('provider-b'),
        excludeTurns: true,
      },
    })
    expect(JSON.parse(await h.read()).id).toBe('reopen-host-rejected')
    h.send({ id: 'still-blocked-host', method: 'turn/start', params: { threadId, input: [] } })
    expect(JSON.parse(await h.read())).toMatchObject({
      id: 'still-blocked-host',
      error: { message: expect.stringContaining('switch status is uncertain') },
    })
    const completionCount = h.completeThreadResume.mock.calls.length
    h.completeThreadResume.mockImplementationOnce(async () =>
      await new Promise<boolean>(resolve => {
        finishCompletion = resolve
      })
    )
    h.send({
      id: 'reopen-delayed-host',
      method: 'thread/resume',
      params: {
        threadId,
        modelProvider: 'provider-b',
        model: 'test-model',
        config: config('provider-b'),
        excludeTurns: true,
      },
    })
    await vi.waitFor(() => expect(h.completeThreadResume).toHaveBeenCalledTimes(completionCount + 1))
    h.send({ id: 'unsubscribe-after-reopen', method: 'thread/unsubscribe', params: { threadId } })
    expect(JSON.parse(await h.read()).id).toBe('unsubscribe-after-reopen')
    finishCompletion(true)
    expect(JSON.parse(await h.read()).id).toBe('reopen-delayed-host')
    h.send({ id: 'still-blocked-superseded', method: 'turn/start', params: { threadId, input: [] } })
    expect(JSON.parse(await h.read())).toMatchObject({
      id: 'still-blocked-superseded',
      error: { message: expect.stringContaining('switch status is uncertain') },
    })
    h.send({
      id: 'reopen',
      method: 'thread/resume',
      params: {
        threadId,
        modelProvider: 'provider-b',
        model: 'test-model',
        config: config('provider-b'),
        excludeTurns: true,
      },
    })
    const reopened = JSON.parse(await h.read())
    expect(reopened, JSON.stringify(reopened)).toMatchObject({
      id: 'reopen',
      result: { thread: { id: threadId, status: { type: 'idle' } } },
    })
    h.send({ id: 'after-reopen', method: 'turn/start', params: { threadId, input: [] } })
    expect(JSON.parse(await h.read())).toMatchObject({ id: 'after-reopen', result: { current: 'provider-b' } })
  } finally {
    finishCompletion(true)
    await h.close()
  }
})

it('reconciles a config-backed uncertain conversation through ordinary Host resume admission without managed credentials', async () => {
  const threadId = 'locked-provider-b-late-unsubscribe'
  let configReady = true
  const controller = controllerHarness({
    scope: { ...threadScope, threadId },
    providerSource: id => id === 'provider-b' ? 'config' : undefined,
    prepareConfiguredProvider: async id => config(id),
    validateSelection: async () => configReady,
  })
  const prepareResume = vi.spyOn(controller.controller, 'prepareThreadResume')
  const completeResume = vi.spyOn(controller.controller, 'completeThreadResume')
  const h = await harness(controller.controller, 'native-provider-switch-process.mjs', { requestTimeoutMs: 20 })
  try {
    h.send({ id: 'initialize', method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } })
    await h.read()
    h.send({ method: 'initialized', params: {} })
    h.send({
      id: 'start',
      method: 'thread/start',
      params: { id: threadId, modelProvider: 'provider-b', config: config('provider-b') },
    })
    await h.read()
    h.send({ id: 'ordinary-resume', method: 'thread/resume', params: { threadId, modelProvider: 'provider-b' } })
    expect(JSON.parse(await h.read()).id).toBe('ordinary-resume')
    expect(prepareResume).toHaveBeenLastCalledWith({
      threadId,
      providerId: 'provider-b',
      model: 'test-model',
      managedOnly: true,
    })
    expect(completeResume).not.toHaveBeenCalled()
    await expect(h.server.existingThread.switch({
      scope: { targetId: 't', rendererGeneration: 'r', navigationGeneration: 1, threadId },
      threadId,
      providerId: 'openai',
      model: 'test-model',
      serviceGeneration: 'g',
      configOverrides: config('openai'),
    })).rejects.toMatchObject({ reason: 'provider-switch-reconciliation-required' })
    await new Promise(resolve => setTimeout(resolve, 150))
    configReady = false
    h.send({
      id: 'config-reopen-not-admitted',
      method: 'thread/resume',
      params: { threadId, modelProvider: 'provider-b', model: 'test-model' },
    })
    expect(JSON.parse(await h.read())).toMatchObject({
      id: 'config-reopen-not-admitted',
      error: { message: expect.stringContaining('Original service preparation was not admitted') },
    })
    expect(completeResume).not.toHaveBeenCalled()
    h.send({ id: 'config-not-admitted-send', method: 'turn/start', params: { threadId, input: [] } })
    expect(JSON.parse(await h.read())).toMatchObject({
      id: 'config-not-admitted-send',
      error: { message: expect.stringContaining('switch status is uncertain') },
    })
    configReady = true
    h.send({
      id: 'config-reopen',
      method: 'thread/resume',
      params: { threadId, modelProvider: 'provider-b', model: 'test-model' },
    })
    expect(JSON.parse(await h.read())).toMatchObject({
      id: 'config-reopen',
      result: { thread: { id: threadId, status: { type: 'idle' } }, modelProvider: 'provider-b', model: 'test-model' },
    })
    expect(prepareResume).toHaveBeenLastCalledWith({ threadId, providerId: 'provider-b', model: 'test-model' })
    expect(completeResume).toHaveBeenLastCalledWith({ threadId, resumeToken: expect.any(String), succeeded: true })
    h.send({ id: 'config-after-reopen', method: 'turn/start', params: { threadId, input: [] } })
    expect(JSON.parse(await h.read())).toMatchObject({ id: 'config-after-reopen', result: { current: 'provider-b' } })
    expect(controller.prepare).not.toHaveBeenCalled()
    expect(h.consume).not.toHaveBeenCalled()
  } finally {
    await h.close()
    await controller.controller.dispose()
  }
})

describe('native switch controller regression', () => {
  it('retains the effective binding and pending intent after native provider switching is unsupported', async () => {
    const h = controllerHarness({ scope: threadScope, pending: pendingThread })
    const restored = await h.controller.prepareThreadResume({
      threadId: threadScope.threadId!,
      providerId: 'provider-a',
      model: 'model-a',
    })
    if (restored.kind !== 'resume') throw new Error('original lease not prepared')
    await h.controller.completeThreadResume({
      threadId: threadScope.threadId!,
      resumeToken: restored.resumeToken,
      succeeded: true,
    })
    h.switchThread.mockRejectedValueOnce(new NativeThreadSwitchError('provider-switch-unsupported'))
    expect(await h.controller.commitSelection(threadScope)).toEqual({
      kind: 'reject',
      reason: 'provider-switch-unsupported',
    })
    expect(h.commitEffective).not.toHaveBeenCalled()
    expect(h.clearPending).not.toHaveBeenCalled()
    expect(h.disposed).toEqual(['provider-b-2'])
    const calls = h.switchThread.mock
      .calls as unknown as readonly (readonly [{ revalidateRestoration(): Promise<boolean> }])[]
    const input = calls[0]![0]
    expect(await input.revalidateRestoration()).toBe(true)
    h.setSnapshot({ revision: 5, effective: { providerId: 'provider-a', model: 'model-a' } })
    expect(await input.revalidateRestoration()).toBe(false)
    await h.controller.dispose()
    expect(h.disposed).toEqual(['provider-b-2', 'provider-a-1'])
  })

  it('does not prepare, switch or authorize a pending provider already rejected by the native runtime', async () => {
    const h = controllerHarness({
      scope: threadScope,
      pending: { ...pendingThread, blockedReason: 'provider-switch-unsupported' },
    })
    expect(await h.controller.commitSelection(threadScope)).toEqual({
      kind: 'reject',
      reason: 'provider-switch-unsupported',
    })
    expect(await h.controller.prepareSubmission(threadScope, threadAction)).toEqual({
      kind: 'reject',
      reason: 'provider-switch-unsupported',
    })
    expect(h.prepare).not.toHaveBeenCalled()
    expect(h.switchThread).not.toHaveBeenCalled()
    expect(h.commitEffective).not.toHaveBeenCalled()
    await h.controller.dispose()
  })

  it('preserves the specific native switch reason on an ordinary-send transition', async () => {
    const h = controllerHarness({ scope: threadScope, pending: { ...pendingThread, sendOnly: true } })
    h.switchThread.mockRejectedValueOnce(new NativeThreadSwitchError('provider-switch-unsupported'))
    expect(await h.controller.prepareSubmission(threadScope, threadAction)).toEqual({
      kind: 'reject',
      reason: 'provider-switch-unsupported',
    })
    expect(h.commitEffective).not.toHaveBeenCalled()
    expect(h.disposed).toEqual(['provider-b-1'])
    await h.controller.dispose()
  })
})

describe('native switch channel regression', () => {
  it('R1 permits an explicit replacement of a rejected next-Send target with the restored effective service', async () => {
    const h = await channelHarness({
      realController: true,
      catalog: () => [{
        providerId: 'provider-b',
        pluginId: 'plugin-b',
        label: 'Provider B',
        models: [{ id: 'model-b', label: 'Model B' }],
      }],
    })
    const scope = { ...h.draft, threadId: 'R1-replace-thread' }
    h.setLive(scope)
    let idle = false
    const effective = { providerId: 'provider-b', model: 'model-b' }
    const sync = vi.fn(async () => undefined)
    h.switchThread.mockRejectedValue(new NativeThreadSwitchError('provider-switch-unsupported'))
    const client = new NativeProviderSelectionClient(
      h.channel as NativeProviderSelectionCommandChannel,
      () => ({ scope, idle, effective }),
      vi.fn(),
      sync,
    )
    const send = {
      target: 'local',
      thread: scope.threadId,
      response: false,
      followUp: 'local',
      followUpThread: scope.threadId,
      defaultAction: undefined,
      explicitAction: undefined,
      edit: undefined,
      promptOverride: false,
    }
    try {
      await client.refresh()
      expect(client.stageNextSend({ providerId: 'openai', model: 'official-model' })).toBe(true)
      idle = true
      expect(await client.submitHook(send)).toEqual({ allow: false })
      expect(client.snapshot().pending?.blockedReason).toBe('provider-switch-unsupported')
      expect(client.stageNextSend(effective)).toBe(true)
      expect(await client.submitHook(send)).toMatchObject({ allow: true, operationToken: expect.any(String) })
      expect(sync).toHaveBeenLastCalledWith(effective, undefined)
      expect(client.snapshot().nextSend).toBeUndefined()
      expect(h.switchThread).toHaveBeenCalledTimes(1)
    } finally {
      client.dispose()
      await h.actual.dispose()
      await h.installed.dispose()
    }
  })

  it.each(['provider-switch-unsupported', 'provider-switch-reconciliation-required'] as const)(
    'R1 retains a rejected busy next-Send target after %s without repeating its native switch',
    async reason => {
      const h = await channelHarness({
        realController: true,
        catalog: () => [{
          providerId: 'provider-b',
          pluginId: 'plugin-b',
          label: 'Provider B',
          models: [{ id: 'model-b', label: 'Model B' }],
        }],
      })
      const scope = { ...h.draft, threadId: 'R1-thread' }
      h.setLive(scope)
      let idle = false
      const effective = { providerId: 'provider-b', model: 'model-b' }
      const target = { providerId: 'openai', model: 'official-model', reasoningEffort: 'high' as const }
      const notice = vi.fn()
      const sync = vi.fn(async () => undefined)
      const discard = vi.fn<NativeProviderSelectionCommandChannel['selectionDiscard']>(async input =>
        await h.channel.selectionDiscard(input)
      )
      h.switchThread.mockRejectedValue(new NativeThreadSwitchError(reason))
      const client = new NativeProviderSelectionClient(
        { ...h.channel, selectionDiscard: discard } as NativeProviderSelectionCommandChannel,
        () => ({ scope, idle, effective }),
        notice,
        sync,
      )
      const descriptor = {
        target: 'local',
        thread: scope.threadId,
        response: false,
        followUp: 'local',
        followUpThread: scope.threadId,
        defaultAction: undefined,
        explicitAction: undefined,
        edit: undefined,
        promptOverride: false,
      }
      try {
        await client.refresh()
        expect(client.stageNextSend(target)).toBe(true)
        expect(h.switchThread).not.toHaveBeenCalled()
        idle = true
        const first = await client.submitHook(descriptor)
        const firstProjection = client.snapshot()
        const second = await client.submitHook(descriptor)
        expect({ first, second, nativeSwitches: h.switchThread.mock.calls.length }).toEqual({
          first: { allow: false },
          second: { allow: false },
          nativeSwitches: 1,
        })
        expect(firstProjection).toMatchObject({
          effective,
          nextSend: target,
          pending: { providerId: target.providerId, model: target.model, sendOnly: true, blockedReason: reason },
        })
        expect(client.snapshot().pending?.blockedReason).toBe(reason)
        expect(h.authority.selection.snapshot(scope).pending?.blockedReason).toBe(reason)
        expect(discard).not.toHaveBeenCalled()
        expect(notice).toHaveBeenLastCalledWith(reason)
        expect(sync).not.toHaveBeenCalled()
        const projection = client.snapshot()
        expect(await h.channel.selectionDiscard({ scope, expectedRevision: projection.revision })).toMatchObject({
          pending: { blockedReason: reason },
        })
        expect(
          await h.channel.selectionSelect({
            scope,
            ...target,
            mode: 'stage-send',
            expectedRevision: projection.revision,
          }),
        ).toMatchObject({ status: 'reject', reason })
        if (reason === 'provider-switch-unsupported') {
          expect(await client.cancelProviderIntent()).toBe('accepted')
          expect(client.snapshot().nextSend).toBeUndefined()
          expect(client.snapshot().pending).toBeUndefined()
          expect(await client.submitHook(descriptor)).toEqual({ allow: true })
        } else {
          expect(await client.cancelProviderIntent()).toBe('unavailable')
          expect(client.stageNextSend(effective)).toBe(false)
          expect(await client.select(effective)).toBe('unavailable')
          expect(client.snapshot()).toMatchObject({ nextSend: target, pending: { blockedReason: reason } })
          expect(await client.submitHook(descriptor)).toEqual({ allow: false })
        }
        expect(h.switchThread).toHaveBeenCalledTimes(1)
      } finally {
        client.dispose()
        await h.actual.dispose()
        await h.installed.dispose()
      }
    },
  )

  it('reports native provider rejection without acknowledging or repeatedly retrying the target', async () => {
    const h = await channelHarness({ realController: true })
    const scope = { ...h.draft, threadId: 'thread' }
    h.setLive(scope)
    const commitSelection = vi.spyOn(h.actual, 'commitSelection').mockResolvedValueOnce({
      kind: 'reject',
      reason: 'provider-switch-unsupported',
    })
    const effective = { providerId: 'openai', model: 'official-model' }
    try {
      await h.channel.selectionRead({ scope, effective })
      await h.channel.selectionProviderIntent({ scope, providerId: 'provider-b', expectedRevision: 1 })
      const rejected = await h.channel.selectionSelect({
        scope,
        providerId: 'provider-b',
        model: 'model-b',
        expectedRevision: 2,
      })
      expect(rejected).toMatchObject({
        status: 'reject',
        reason: 'provider-switch-unsupported',
        effective,
        pending: { providerId: 'provider-b', model: 'model-b', blockedReason: 'provider-switch-unsupported' },
      })
      expect(rejected.pending.sendOnly).toBeUndefined()
      await h.channel.selectionCancelProviderIntent({ scope, expectedRevision: rejected.revision })
      expect(h.authority.selection.snapshot(scope)).toMatchObject({ effective })
      expect(h.authority.selection.snapshot(scope).pending).toBeUndefined()
      expect(commitSelection).toHaveBeenCalledTimes(1)
      expect(h.prepare).not.toHaveBeenCalled()
      expect(h.switchThread).not.toHaveBeenCalled()
    } finally {
      await h.actual.dispose()
      await h.installed.dispose()
    }
  })

  it('retains a native-rejected selection but blocks Send and repeated clicks until the user changes it', async () => {
    const h = await channelHarness({ realController: true })
    const scope = { ...h.draft, threadId: 'thread' }
    h.setLive(scope)
    const commitSelection = vi.spyOn(h.actual, 'commitSelection').mockResolvedValueOnce({
      kind: 'reject',
      reason: 'provider-switch-unsupported',
    })
    const effective = { providerId: 'openai', model: 'official-model' }
    try {
      await h.channel.selectionRead({ scope, effective })
      const input = { scope, providerId: 'provider-b', model: 'model-b' }
      expect(await h.channel.selectionSelect(input)).toMatchObject({
        status: 'reject',
        reason: 'provider-switch-unsupported',
      })
      expect(await h.channel.selectionSelect(input)).toMatchObject({
        status: 'reject',
        reason: 'provider-switch-unsupported',
      })
      expect(
        await h.channel.submissionPrepare({
          scope,
          action: { operationId: 'send', operationGeneration: 1, intent: 'ordinary-send', threadId: scope.threadId },
        }),
      ).toMatchObject({ status: 'reject', reason: 'provider-switch-unsupported' })
      expect(commitSelection).toHaveBeenCalledTimes(1)
      expect(h.prepare).not.toHaveBeenCalled()
      expect(await h.channel.selectionSelect({ scope, ...effective })).toMatchObject({ status: 'accepted', effective })
      expect(h.authority.selection.snapshot(scope).pending).toBeUndefined()
    } finally {
      await h.actual.dispose()
      await h.installed.dispose()
    }
  })

  it('does not clear an uncertain native connection by only selecting the old provider label', async () => {
    const h = await channelHarness()
    const scope = { ...h.draft, threadId: 'thread' }
    h.setLive(scope)
    vi.mocked(h.controller.commitSelection).mockResolvedValueOnce({
      kind: 'reject',
      reason: 'provider-switch-reconciliation-required',
    })
    const effective = { providerId: 'provider-a', model: 'model-a' }
    try {
      await h.channel.selectionRead({ scope, effective })
      await h.channel.selectionSelect({ scope, providerId: 'provider-b', model: 'model-b' })
      expect(await h.channel.selectionSelect({ scope, ...effective })).toMatchObject({
        status: 'reject',
        reason: 'provider-switch-reconciliation-required',
      })
      expect(h.authority.selection.snapshot(scope).pending?.blockedReason).toBe(
        'provider-switch-reconciliation-required',
      )
      const reopened = { ...scope, navigationGeneration: scope.navigationGeneration + 1 }
      h.setLive(reopened)
      expect(await h.channel.selectionRead({ scope: reopened, effective })).toMatchObject({ effective })
      expect(h.authority.selection.snapshot(reopened).pending).toBeUndefined()
    } finally {
      await h.installed.dispose()
    }
  })
})
