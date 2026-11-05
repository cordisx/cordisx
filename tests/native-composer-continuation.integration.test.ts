import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { analyzeNativeSubmissionTransforms } from '../packages/cli/src/launcher/native-submission-structure.js'
import { resources } from './fixtures/native-submission-structure.js'
import { harness as intermediaryHarness } from './fixtures/native-intermediary-harness.js'

const marker = 'cordisx.operation_token'

// Semantic composition of the real callback, complete local owner and native
// primary-runtime rebuild. No request or last-hop token is injected by a test.
function composerResources() {
  const source = resources()
  source[0]!.source = source[0]!.source.replace(
    'return context;',
    `try {
      const result=await target.submit(context,'/workspace',undefined,{permissions:'user-selected'},undefined,
        'message',{},globalThis.onMessageAdded);
      globalThis.events.push('composer-result');return result;
    } finally { globalThis.events.push('composer-cleanup'); }`,
  ) + `
    async function local(context,follow,cwd,execution,restore,message,queue,onMessageAdded,prepare,submissionLifecycle) {
      const input={scope:{},context,targetConversationId:follow.localConversationId,managerHostId:'local',
        clientUserMessageId:message,onMessageAdded,permissionSelection:execution.permissions,submissionLifecycle};
      globalThis.events.push('local:'+input.targetConversationId);
      onMessageAdded({locallyAccepted:true});
      const request=await existing({...input,serviceTier:null});
      const operation={request,context:{attachments:context.attachments,permissionSelection:input.permissionSelection}};
      globalThis.originalOperation=operation;
      const result=await globalThis.primaryRuntime(operation);
      return {threadId:input.targetConversationId,turnId:result.turn.id,messageResult:{status:'sent'}};
    }
    globalThis.local=local;
  `
  return source
}

function runtime(options: {
  hook?: (descriptor: any) => Promise<any>
  sendRequest?: (method: string, request: any) => Promise<any>
  beforeSend?: () => Promise<void>
  accepted?: boolean
} = {}) {
  const source = composerResources()
  const events: string[] = []
  const callbacks: any[] = []
  const wires: any[] = []
  const world: Record<string, any> = {
    events,
    queueMicrotask,
    updateModel: async () => true,
    __cordisxNativeSubmitHook: options.hook ?? (async () => ({
      allow: true,
      operationToken: 'native-composer-original-token',
      continuation: { sourceThreadId: 'source', threadId: 'branch' },
    })),
    __cordisxNativeContinuationComplete: vi.fn(() => events.push('navigate')),
    onMessageAdded: (value: any) => {
      callbacks.push(value)
      events.push('clear-draft')
    },
    normalizeWire: (request: any) => ({ ...request }),
  }
  for (const transform of analyzeNativeSubmissionTransforms(source).transforms) {
    runInNewContext(transform.transform(source.find(row => row.url === transform.url)!.source).source, world)
  }
  world.primaryRuntime = async (operation: any) => {
    await options.beforeSend?.()
    const normalized = await world.normalize({}, operation.request.threadId, operation)
    // Installed primary-runtime request builder selects native fields and
    // preserves client metadata while omitting arbitrary config.
    const nativeRequest = {
      threadId: operation.request.threadId,
      input: normalized.request.input,
      permissions: operation.context.permissionSelection,
      responsesapiClientMetadata: {
        ...operation.request.responsesapiClientMetadata,
        client_type: 'desktop_app',
      },
    }
    wires.push(nativeRequest)
    events.push('wire')
    const result = await options.sendRequest?.('turn/start', nativeRequest) ?? { turn: { id: 'turn' } }
    if (options.accepted === false) throw new Error('Native request was not sent')
    return result
  }
  const submit = (threadId = 'source', input = 'captured user message') =>
    world.submit({
      clearStopTurnConfirmation: () => events.push('native-effect'),
      submitTarget: {
        type: 'local',
        submit: (...args: any[]) =>
          world.local(args[0], { localConversationId: threadId }, args[1], args[3], args[4], args[5], args[6], args[7]),
      },
      conversationId: threadId,
      followUp: { type: 'local', localConversationId: threadId },
      isResponseInProgress: false,
      options: { input },
      defaultFollowUpSubmitAction: 'steer',
    })
  return { world, events, callbacks, wires, submit }
}

describe('native Composer continuation composition', () => {
  it('carries original admission through local operation and primary-runtime config loss', async () => {
    const run = runtime()
    await run.submit()
    await Promise.resolve()
    expect(run.world.originalOperation).toMatchObject({
      request: { threadId: 'branch', config: { [marker]: 'native-composer-original-token' } },
      context: { permissionSelection: 'user-selected' },
    })
    expect(run.wires).toEqual([{
      threadId: 'branch',
      input: 'captured user message',
      permissions: 'user-selected',
      responsesapiClientMetadata: { [marker]: 'native-composer-original-token', client_type: 'desktop_app' },
    }])
    expect(run.events.indexOf('wire')).toBeLessThan(run.events.indexOf('clear-draft'))
    expect(run.events.indexOf('composer-cleanup')).toBeLessThan(run.events.indexOf('navigate'))
    expect(run.callbacks).toEqual([{ locallyAccepted: true }])
  })

  it('retains the draft on definite pre-wire failure and does not navigate or replay', async () => {
    const run = runtime({
      beforeSend: async () => {
        throw new Error('Native permission selection changed')
      },
    })
    await expect(run.submit()).rejects.toThrow('Native permission selection changed')
    await Promise.resolve()
    expect(run.callbacks).toEqual([])
    expect(run.wires).toEqual([])
    expect(run.world.__cordisxNativeContinuationComplete).not.toHaveBeenCalled()
    expect(run.events).toEqual(['native-effect', 'local:branch', 'composer-cleanup'])
  })

  it('retains the draft and source on a rejected destination response without replay', async () => {
    const sendRequest = vi.fn(async () => {
      throw new Error('Native request was not sent')
    })
    const run = runtime({ sendRequest })
    await expect(run.submit()).rejects.toThrow('Native request was not sent')
    expect(sendRequest).toHaveBeenCalledOnce()
    expect(run.callbacks).toEqual([])
    expect(run.world.__cordisxNativeContinuationComplete).not.toHaveBeenCalled()
  })

  it('leaves ordinary same-provider local acceptance timing unchanged', async () => {
    const run = runtime({ hook: async () => ({ allow: true }) })
    await run.submit()
    expect(run.events.indexOf('clear-draft')).toBeLessThan(run.events.indexOf('wire'))
    expect(run.wires[0].responsesapiClientMetadata).not.toHaveProperty(marker)
    expect(run.world.__cordisxNativeContinuationComplete).not.toHaveBeenCalled()
  })

  it('keeps concurrent composer tokens and destinations separate', async () => {
    const run = runtime({
      hook: async descriptor => ({
        allow: true,
        operationToken: `original-${descriptor.thread}-token`,
        continuation: { sourceThreadId: descriptor.thread, threadId: `${descriptor.thread}-branch` },
      }),
    })
    await Promise.all([run.submit('first', 'first input'), run.submit('second', 'second input')])
    expect(run.wires.map(row => [row.threadId, row.input, row.responsesapiClientMetadata[marker]]))
      .toEqual([
        ['first-branch', 'first input', 'original-first-token'],
        ['second-branch', 'second input', 'original-second-token'],
      ])
  })

  it('consumes the transformed original Send through the real intermediary metadata path', async () => {
    const h = await intermediaryHarness(undefined, 'native-provider-process.mjs')
    try {
      h.send({ id: 'init', method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } })
      expect(JSON.parse(await h.read()).id).toBe('init')
      h.send({ method: 'initialized', params: {} })
      h.send({ id: 'source', method: 'thread/start', params: { modelProvider: 'openai' } })
      const source = JSON.parse(await h.read()).result.thread.id
      let destination: string | undefined
      const run = runtime({
        hook: async () => {
          const branch = await h.server.existingThread.continue!({
            scope: { targetId: 'own', rendererGeneration: 'doc', navigationGeneration: 1, threadId: source },
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
            operationToken: 'native-composer-original-token',
          })
          destination = branch.threadId
          return {
            allow: true,
            operationToken: 'native-composer-original-token',
            continuation: { sourceThreadId: source, threadId: destination },
          }
        },
        sendRequest: async (method, params) => {
          expect(params).not.toHaveProperty('config')
          h.send({ id: 'original-send', method, params })
          const response = JSON.parse(await h.read())
          expect(response).toMatchObject({ id: 'original-send', result: { current: 'provider-b' } })
          return { turn: { id: 'turn' } }
        },
      })
      await run.submit(source)
      expect(h.consume).toHaveBeenCalledWith(expect.objectContaining({
        operationToken: 'native-composer-original-token',
        threadId: destination,
      }))
      expect(h.authorize).toHaveBeenCalledOnce()
      expect(h.complete).toHaveBeenCalledWith(expect.objectContaining({ succeeded: true }))
    } finally {
      await h.close()
    }
  })
})
