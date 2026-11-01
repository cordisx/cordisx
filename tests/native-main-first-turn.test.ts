import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { harness } from './fixtures/native-intermediary-harness.js'
import { resources } from './fixtures/native-submission-structure.js'
import { analyzeNativeSubmissionTransforms } from '../packages/cli/src/launcher/native-submission-structure.js'

const marker = 'cordisx.operation_token'
const token = 'allowed-with-effort-token'

// Cross-process regression: native main-process first-turn reconstruction keeps
// responsesapiClientMetadata but omits config. Exercise production transforms
// and the real intermediary subprocess, not a thread-ID authorization fallback.
async function draftForSend(operationToken: string | undefined) {
  const sandbox: any = {
    __cordisxNativeSubmitHook: vi.fn(async () => ({ allow: true, operationToken, reasoningEffort: 'xhigh' })),
    __cordisxNativeSubmissionActivate: vi.fn(),
    updateModel: vi.fn(),
  }
  const source = resources()
  source[0]!.source = source[0]!.source.replace(
    "configOverrides:{safe:'retained'},requiresThreadReferences",
    "responsesapiClientMetadata:{native:'retained'},configOverrides:{safe:'retained'},requiresThreadReferences",
  )
  for (const transform of analyzeNativeSubmissionTransforms(source).transforms) {
    const resource = source.find(resource => resource.url === transform.url)!
    runInNewContext(transform.transform(resource.source).source, sandbox)
  }
  const context = await sandbox.submit({
    clearStopTurnConfirmation() {},
    submitTarget: { type: 'draft' },
    isResponseInProgress: false,
    options: { input: 'hello' },
  })
  return await sandbox.draft({ context, prompt: 'hello', serviceTier: null })
}

describe('main-process first-turn Send carrier', () => {
  it('carries admission through native reconstruction, removes private metadata, and forwards once', async () => {
    const draft = await draftForSend(token)
    expect(draft.configOverrides[marker]).toBe(token)
    expect(draft.responsesapiClientMetadata).toEqual({ native: 'retained', [marker]: token })
    const h = await harness()
    try {
      h.send({ id: 'create', method: 'thread/start', params: { config: draft.configOverrides } })
      expect(JSON.parse(await h.read()).result.received.config).not.toHaveProperty(marker)
      const params = {
        threadId: 'created-thread',
        input: [{ type: 'text', text: draft.input }],
        sandboxPolicy: { type: 'readOnly' },
        approvalPolicy: 'on-request',
        effort: 'low',
        responsesapiClientMetadata: { ...draft.responsesapiClientMetadata, workspace_kind: 'project' },
      }
      h.send({ id: 'first', method: 'turn/start', params })
      const received = JSON.parse(await h.read()).result.received
      expect(received).toEqual({
        ...params,
        effort: 'xhigh',
        model: 'model-b',
        responsesapiClientMetadata: { native: 'retained', workspace_kind: 'project' },
      })
      expect(received.config).toBeUndefined()
      expect(h.consume).toHaveBeenCalledTimes(2)
      expect(h.authorize).toHaveBeenCalledTimes(2)
      expect(h.consume).toHaveBeenLastCalledWith(expect.objectContaining({
        operationToken: token,
        requestId: 'first',
        threadId: 'created-thread',
        method: 'turn/start',
      }))
    } finally {
      await h.close()
    }
  })
  it('does not invent metadata authority for an unmanaged Send', async () => {
    const draft = await draftForSend(undefined)
    expect(draft.responsesapiClientMetadata).toEqual({ native: 'retained' })
    expect(draft.configOverrides).toEqual({ safe: 'retained' })
  })
  it('retains rejection and native-write authorization fences for metadata carriers', async () => {
    const h = await harness()
    try {
      const send = async (id: string, carried: unknown, config?: unknown) => {
        h.send({
          id,
          method: 'turn/start',
          params: { threadId: 'created-thread', responsesapiClientMetadata: { [marker]: carried }, config },
        })
        expect(JSON.parse(await h.read())).toMatchObject({ id, error: { code: -32000 } })
      }
      for (const invalid of ['short', '', null, 42, 'invalid-operation-token\n']) await send('invalid', invalid)
      await send('conflict', token, { [marker]: 'different-operation-token' })
      expect(h.consume).not.toHaveBeenCalled()
      await send('rejected', 'rejected-operation-token')
      h.authorize.mockResolvedValueOnce(false)
      await send('expired', token)
      expect(h.complete).toHaveBeenLastCalledWith({ operationToken: token, requestId: 'expired', succeeded: false })
      h.send({ id: 'native', method: 'thread/read', params: {} })
      expect(JSON.parse(await h.read())).toMatchObject({ id: 'native', result: { method: 'thread/read' } })
    } finally {
      await h.close()
    }
  })
  it('does not pass metadata on an unrelated method and preserves native bytes', async () => {
    const h = await harness()
    try {
      h.send({ id: 'wrong-method', method: 'thread/read', params: { responsesapiClientMetadata: { [marker]: token } } })
      expect(JSON.parse(await h.read())).toMatchObject({ error: { code: -32000 } })
      const frame =
        '{ "id": "opaque", "method": "echo/bytes", "params": { "responsesapiClientMetadata":{"native":"unchanged"} } }'
      h.send(frame)
      expect(await h.read()).toBe(frame)
    } finally {
      await h.close()
    }
  })
})
