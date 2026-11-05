import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { createNativeProviderContinuation } from '../packages/cli/assets/launcher/native-provider-continuation.mjs'
import { createNativeSubmissionController } from '../packages/cli/src/launcher/native-submission-controller.js'
import type {
  NativeSubmissionScope,
  NativeSubmissionSelectionSnapshot,
} from '../packages/cli/src/launcher/native-submission-controller.js'
import { createNativeContinuationCompletion } from '../packages/cli/src/renderer/native-provider-continuation.js'
import { analyzeNativeSubmissionTransforms } from '../packages/cli/src/launcher/native-submission-structure.js'
import { resources } from './fixtures/native-submission-structure.js'
import { harness as intermediaryHarness } from './fixtures/native-intermediary-harness.js'

function controllerHarness() {
  let scope: NativeSubmissionScope = {
    targetId: 'own',
    rendererGeneration: 'doc',
    navigationGeneration: 1,
    threadId: 'source',
  }
  let snapshot: NativeSubmissionSelectionSnapshot = {
    revision: 4,
    effective: { providerId: 'openai', model: 'official' },
    pending: {
      providerId: 'plugin-one',
      model: 'plugin-model',
      threadId: 'source',
      selectionGeneration: 1,
      sendOnly: true,
    },
  }
  const selections = new Map<string, { providerId: string; model: string }>()
  let n = 0
  const fork = vi.fn(async () => ({ threadId: `branch-${++n}` }))
  const discard = vi.fn(async () => undefined)
  const released = vi.fn()
  const switchThread = vi.fn(async () => undefined)
  const commitContinuation = vi.fn(input => {
    selections.set(input.threadId, input.selection)
    snapshot = { revision: snapshot.revision + 1, effective: snapshot.effective }
    return true
  })
  const controller = createNativeSubmissionController({
    selection: {
      snapshot: () => snapshot,
      adoptScope: () => false,
      commitEffective: () => false,
      clearPending: () => false,
      commitContinuation,
    },
    credentials: {
      prepare: async () => ({
        serviceGeneration: 'g1',
        endpoint: { baseUrl: 'http://127.0.0.1:0', wireApi: 'responses' },
        auth: { scheme: 'none' },
        dispose: released,
      }),
    },
    runtime: {
      revalidate: async () => true,
      revalidateContinuation: async () => true,
      resolveCreatedScope: async () => undefined,
    },
    existingThread: { switch: switchThread, continue: fork, discardContinuation: discard },
    providerSource: () => 'managed',
  })
  return {
    controller,
    fork,
    discard,
    released,
    switchThread,
    commitContinuation,
    selections,
    scope: () => scope,
    snapshot: () => snapshot,
    switchTo(threadId: string, providerId: string, model: string) {
      const effective = selections.get(threadId)!
      scope = { ...scope, threadId, navigationGeneration: scope.navigationGeneration + 1 }
      snapshot = {
        revision: snapshot.revision + 1,
        effective,
        pending: {
          providerId,
          model,
          threadId,
          selectionGeneration: snapshot.revision + 1,
          sendOnly: true,
        },
      }
    },
  }
}
const sendAction = (scope: NativeSubmissionScope) => ({
  operationId: crypto.randomUUID(),
  operationGeneration: 1,
  intent: 'ordinary-send' as const,
  threadId: scope.threadId,
  continuationAvailable: true,
})

describe('native provider continuation admission', () => {
  it('forks the latest branch on every direction and never resumes the old source', async () => {
    const h = controllerHarness()
    for (
      const [providerId, model] of [['plugin-one', 'plugin-model'], ['openai', 'official'], ['plugin-two', 'other']]
    ) {
      const source = h.scope()
      const admitted = await h.controller.prepareSubmission(source, sendAction(source))
      if (admitted.kind !== 'allow-original' || !admitted.continuation) throw new Error('fork not admitted')
      expect(h.fork).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: source.threadId, providerId, model }))
      expect(h.snapshot().effective.providerId).not.toBe(providerId)
      const request = {
        method: 'turn/start' as const,
        requestId: crypto.randomUUID(),
        threadId: admitted.continuation.threadId,
        operationToken: admitted.operationToken,
      }
      expect(await h.controller.consumeMarkedRequest(request)).toMatchObject({ kind: 'dispatch', providerId, model })
      expect(await h.controller.authorizeMarkedRequest(request)).toBe(true)
      await h.controller.completeMarkedRequest({ ...request, succeeded: true })
      expect(h.snapshot().pending).toBeUndefined()
      expect(h.selections.get(admitted.continuation.threadId)).toMatchObject({ providerId, model })
      if (providerId === 'plugin-one') h.switchTo(admitted.continuation.threadId, 'openai', 'official')
      if (providerId === 'openai') h.switchTo(admitted.continuation.threadId, 'plugin-two', 'other')
    }
    expect(h.fork.mock.calls.map(([input]) => input.threadId)).toEqual(['source', 'branch-1', 'branch-2'])
    expect(h.switchThread).not.toHaveBeenCalled()
    await h.controller.dispose()
  })

  it('rejects the original thread destination and retires only its unused owned fork', async () => {
    const h = controllerHarness()
    const admitted = await h.controller.prepareSubmission(h.scope(), sendAction(h.scope()))
    if (admitted.kind !== 'allow-original') throw new Error('not admitted')
    expect(
      await h.controller.consumeMarkedRequest({
        method: 'turn/start',
        requestId: 'wrong-target',
        threadId: 'source',
        operationToken: admitted.operationToken,
      }),
    ).toEqual({ kind: 'reject', reason: 'request-mismatch' })
    expect(h.discard).toHaveBeenCalledWith({ threadId: 'branch-1', operationToken: admitted.operationToken })
    expect(h.commitContinuation).not.toHaveBeenCalled()
    await h.controller.dispose()
  })

  it('does not create history when the native submit path lacks continuation support', async () => {
    const h = controllerHarness()
    expect(await h.controller.prepareSubmission(h.scope(), { ...sendAction(h.scope()), continuationAvailable: false }))
      .toMatchObject({ kind: 'reject', reason: 'provider-switch-unsupported' })
    expect(h.fork).not.toHaveBeenCalled()
    await h.controller.dispose()
  })

  it('archives only the acknowledged unused fork when its Send is cancelled', async () => {
    const h = controllerHarness()
    const scope = h.scope()
    const admitted = await h.controller.prepareSubmission(scope, sendAction(scope))
    if (admitted.kind !== 'allow-original') throw new Error('not admitted')
    await h.controller.cancel({ scope, id: admitted.operationToken })
    expect(h.discard).toHaveBeenCalledOnce()
    expect(h.discard).toHaveBeenCalledWith({ threadId: 'branch-1', operationToken: admitted.operationToken })
    expect(h.released).toHaveBeenCalledOnce()
    expect(h.snapshot().pending?.providerId).toBe('plugin-one')
    expect(h.commitContinuation).not.toHaveBeenCalled()
    await h.controller.dispose()
  })

  it('keeps a dispatched branch after a failed response without automatic archive or replay', async () => {
    const h = controllerHarness()
    const admitted = await h.controller.prepareSubmission(h.scope(), sendAction(h.scope()))
    if (admitted.kind !== 'allow-original' || !admitted.continuation) throw new Error('not admitted')
    const request = {
      method: 'turn/start' as const,
      requestId: 'owned-failed-request',
      threadId: admitted.continuation.threadId,
      operationToken: admitted.operationToken,
    }
    expect(await h.controller.consumeMarkedRequest(request)).toMatchObject({ kind: 'dispatch' })
    expect(await h.controller.authorizeMarkedRequest(request)).toBe(true)
    await h.controller.completeMarkedRequest({ ...request, succeeded: false })
    expect(h.discard).not.toHaveBeenCalled()
    expect(h.commitContinuation).not.toHaveBeenCalled()
    expect(h.fork).toHaveBeenCalledOnce()
    expect(h.released).toHaveBeenCalledOnce()
    await h.controller.dispose()
  })
})

it('uses normal persistent fork with inherited history and no automatic goal or source lifecycle change', async () => {
  const nativeCall = vi.fn(async (method: string) =>
    method === 'thread/read'
      ? { thread: { id: 'source', modelProvider: 'openai', status: { type: 'idle' } } }
      : {
        thread: { id: 'branch', ephemeral: false, status: { type: 'idle' } },
        modelProvider: 'plugin',
        model: 'chosen',
      }
  )
  const continuation = createNativeProviderContinuation({
    nativeCall,
    lifecyclePending: () => false,
    current: () => true,
  })
  expect(
    await continuation.handle({
      type: 'continuation-fork',
      operationToken: 'an-owned-token',
      threadId: 'source',
      providerId: 'plugin',
      model: 'chosen',
      config: {},
    }),
  ).toEqual({ ok: true, value: { threadId: 'branch' } })
  expect(nativeCall.mock.calls).toEqual([
    ['thread/read', { threadId: 'source', includeTurns: false }],
    ['thread/fork', {
      threadId: 'source',
      modelProvider: 'plugin',
      model: 'chosen',
      config: {},
      ephemeral: false,
      excludeTurns: true,
      deferGoalContinuation: true,
    }],
  ])
})

it('wires private fork admission through the production intermediary before the original marked native Send', async () => {
  const h = await intermediaryHarness(undefined, 'native-provider-process.mjs')
  try {
    h.send({ id: 'init', method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } })
    expect(JSON.parse(await h.read()).id).toBe('init')
    h.send({ method: 'initialized', params: {} })
    h.send({ id: 'source', method: 'thread/start', params: { modelProvider: 'openai' } })
    const source = JSON.parse(await h.read()).result.thread.id
    const scope = { targetId: 'own', rendererGeneration: 'doc', navigationGeneration: 1, threadId: source }
    const fork = await h.server.existingThread.continue!({
      scope,
      threadId: source,
      providerId: 'provider-b',
      model: 'test-model',
      configOverrides: {
        model_provider: 'provider-b',
        model: 'test-model',
        'model_providers.provider-b': {
          wire_api: 'responses',
          base_url: 'http://127.0.0.1:0/v1',
          requires_openai_auth: false,
        },
      },
      operationToken: 'owned-composer-fork-token',
    })
    expect(fork.threadId).not.toBe(source)
    h.send({
      id: 'original-send',
      method: 'turn/start',
      params: {
        threadId: fork.threadId,
        input: [],
        config: { 'cordisx.operation_token': 'owned-composer-fork-token' },
      },
    })
    expect(JSON.parse(await h.read())).toMatchObject({ id: 'original-send', result: { current: 'provider-b' } })
    expect(h.consume).toHaveBeenCalledWith(expect.objectContaining({ threadId: fork.threadId }))
    expect(h.authorize).toHaveBeenCalledOnce()
    expect(h.complete).toHaveBeenCalledWith(expect.objectContaining({ succeeded: true }))
  } finally {
    await h.close()
  }
})

it('routes accepted continuation navigation to its exact still-current composer', () => {
  const completion = createNativeContinuationCompletion()
  const navigate = vi.fn()
  const scope: NativeSubmissionScope = {
    targetId: 'a',
    rendererGeneration: 'doc',
    navigationGeneration: 1,
    threadId: 'source',
  }
  const owner = {
    snapshot: () => ({ scope, idle: true }),
    composer: () => ({ isConnected: true }) as HTMLElement,
    navigateContinuation: navigate,
  }
  const branch = { sourceThreadId: 'source', threadId: 'branch' }
  completion.admitted(owner, { allow: true, operationToken: 'exact-token', continuation: branch })
  completion.complete({ operationToken: 'another-token', continuation: branch, accepted: true })
  expect(navigate).not.toHaveBeenCalled()
  completion.complete({ operationToken: 'exact-token', continuation: branch, accepted: true })
  expect(navigate).toHaveBeenCalledWith('branch')
  completion.complete({ operationToken: 'exact-token', continuation: branch, accepted: true })
  expect(navigate).toHaveBeenCalledOnce()
})

it('discards a stale acknowledged fork through its exact operation and preserves the source', async () => {
  let live = true
  const nativeCall = vi.fn(async (method: string, params: { threadId: string }) => {
    if (method === 'thread/read') {
      return {
        thread: {
          id: params.threadId,
          modelProvider: params.threadId === 'source' ? 'openai' : 'plugin',
          status: { type: 'idle' },
        },
      }
    }
    if (method === 'thread/fork') {
      live = false
      return { thread: { id: 'unused-branch', status: { type: 'idle' } }, modelProvider: 'plugin', model: 'chosen' }
    }
    return {}
  })
  const continuation = createNativeProviderContinuation({
    nativeCall,
    lifecyclePending: () => false,
    current: () => live,
  })
  expect(
    await continuation.handle({
      type: 'continuation-fork',
      operationToken: 'stale-token',
      threadId: 'source',
      providerId: 'plugin',
      model: 'chosen',
      config: {},
    }),
  )
    .toEqual({ ok: false, reason: 'provider-switch-reconciliation-required' })
  expect(nativeCall.mock.calls.filter(([method]) => method === 'thread/archive')).toEqual([
    ['thread/archive', { threadId: 'unused-branch' }],
  ])
})

it('does not archive an unknown or already dispatched branch', async () => {
  const nativeCall = vi.fn(async (method: string) =>
    method === 'thread/read'
      ? { thread: { id: 'source', modelProvider: 'openai', status: { type: 'idle' } } }
      : { thread: { id: 'branch', status: { type: 'idle' } }, modelProvider: 'plugin', model: 'chosen' }
  )
  const continuation = createNativeProviderContinuation({
    nativeCall,
    lifecyclePending: () => false,
    current: () => true,
  })
  expect(
    await continuation.handle({
      type: 'continuation-fork',
      operationToken: 'send-token',
      threadId: 'source',
      providerId: 'plugin',
      model: 'chosen',
      config: {},
    }),
  )
    .toEqual({ ok: true, value: { threadId: 'branch' } })
  expect(
    await continuation.handle({ type: 'continuation-discard', operationToken: 'another-token', threadId: 'branch' }),
  )
    .toEqual({ ok: true, value: false })
  continuation.dispatched('send-token', 'branch')
  expect(await continuation.handle({ type: 'continuation-discard', operationToken: 'send-token', threadId: 'branch' }))
    .toEqual({ ok: true, value: false })
  expect(nativeCall.mock.calls).toHaveLength(2)
})

it('retargets the native local owner, state, resume and request before Composer post-acceptance navigation', async () => {
  const source = resources()
  source[0]!.source = source[0]!.source.replace(
    'return context;',
    `
    try { return await target.submit(context,'/workspace',undefined,{permissions:'user-selected'},undefined,'message',{},()=>{}); }
    finally { globalThis.events.push('composer-cleanup'); }
  `,
  ) + `
  async function local(context,follow,cwd,execution,restore,message,queue,onMessageAdded,prepare,submissionLifecycle) {
    globalThis.events.push('native:'+follow.localConversationId);
    const input={scope:{},context,targetConversationId:follow.localConversationId,managerHostId:'local',
      clientUserMessageId:message,onMessageAdded,permissionSelection:execution.permissions,submissionLifecycle};
    const operation={conversationId:input.targetConversationId,resume:{conversationId:input.targetConversationId},
      start:{request:{threadId:input.targetConversationId,input:context.input,attachments:context.attachments}}};
    globalThis.operation=operation;
    return {threadId:follow.localConversationId,turnId:'turn',messageResult:{status:'sent'}};
  }
  globalThis.local=local;
  `
  const events: string[] = []
  const complete = vi.fn(() => events.push('navigate'))
  const world: Record<string, any> = {
    events,
    queueMicrotask,
    updateModel: async () => true,
    __cordisxNativeSubmitHook: async () => ({
      allow: true,
      operationToken: 'native-composer-token',
      continuation: { sourceThreadId: 'source', threadId: 'branch' },
    }),
    __cordisxNativeContinuationComplete: complete,
  }
  const transforms = analyzeNativeSubmissionTransforms(source).transforms
  for (const transform of transforms) {
    runInNewContext(transform.transform(source.find(s => s.url === transform.url)!.source).source, world)
  }
  await world.submit({
    clearStopTurnConfirmation: () => events.push('native-effect'),
    submitTarget: {
      type: 'local',
      submit: (...args: unknown[]) =>
        world.local(
          args[0],
          { localConversationId: 'source' },
          args[1],
          args[3],
          args[4],
          args[5],
          args[6],
          args[7],
          undefined,
          undefined,
        ),
    },
    followUp: { type: 'local', localConversationId: 'source' },
    conversationId: 'source',
    isResponseInProgress: false,
    options: { input: 'original-input' },
    defaultFollowUpSubmitAction: 'steer',
  })
  await Promise.resolve()
  expect(world.operation).toMatchObject({
    conversationId: 'branch',
    resume: { conversationId: 'branch' },
    start: { request: { threadId: 'branch', input: 'original-input' } },
  })
  expect(events).toEqual(['native-effect', 'native:branch', 'composer-cleanup', 'navigate'])
  expect(complete).toHaveBeenCalledWith(
    expect.objectContaining({ accepted: true, continuation: { sourceThreadId: 'source', threadId: 'branch' } }),
  )
})
