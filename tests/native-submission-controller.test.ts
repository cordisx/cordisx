import { describe, expect, it, vi } from 'vitest'

import {
  createNativeSubmissionController,
  type NativeProviderCredentialLease,
  type NativeSubmissionScope,
  type NativeSubmissionSelectionSnapshot,
} from '../packages/cli/src/launcher/native-submission-controller.js'
import type { PendingNativeProviderChange } from '../packages/cli/src/renderer/native-provider-submission-policy.js'

const draftScope: NativeSubmissionScope = {
  targetId: 'target-a',
  rendererGeneration: 'renderer-1',
  navigationGeneration: 3,
}
const threadScope: NativeSubmissionScope = { ...draftScope, threadId: 'thread-1' }
const pendingDraft: PendingNativeProviderChange = {
  providerId: 'provider-b',
  model: 'model-b',
  selectionGeneration: 7,
}
const pendingThread: PendingNativeProviderChange = { ...pendingDraft, threadId: 'thread-1' }
const draftAction = {
  operationId: 'operation-draft',
  operationGeneration: 11,
  intent: 'ordinary-send' as const,
}
const threadAction = { ...draftAction, operationId: 'operation-thread', threadId: 'thread-1' }
const requestId = 'native-request-1'

function harness(input: {
  scope?: NativeSubmissionScope
  pending?: PendingNativeProviderChange
  now?: () => number
  runtimeValid?: () => boolean
  createdNavigation?: () => number
  providerSource?: (providerId: string) => 'managed' | 'config' | undefined
  validateSelection?: (selection: { providerId: string; model: string }) => Promise<boolean>
} = {}) {
  const scope = input.scope ?? draftScope
  let snapshot: NativeSubmissionSelectionSnapshot = {
    revision: 4,
    effective: { providerId: 'provider-a', model: 'model-a' },
    ...(input.pending === undefined ? {} : { pending: input.pending }),
  }
  const snapshots = new Map([[JSON.stringify(scope), snapshot]])
  const disposed: string[] = []
  let leaseSequence = 0
  const prepare = vi.fn(async (providerId: string): Promise<NativeProviderCredentialLease> => {
    const id = `${providerId}-${++leaseSequence}`
    return {
      serviceGeneration: `service-${id}`,
      endpoint: { baseUrl: 'http://127.0.0.1:43127/v1', wireApi: 'responses' },
      auth: {
        scheme: 'bearer-command',
        command: '/usr/bin/node',
        args: ['/private/helper.mjs', id],
        cwd: '/private',
        timeoutMs: 5_000,
        refreshIntervalMs: 200,
      },
      dispose: () => disposed.push(id),
    }
  })
  const commitEffective = vi.fn((value: {
    scope: NativeSubmissionScope
    expectedRevision: number
    pendingGeneration: number
    selection: { providerId: string; model: string }
  }) => {
    const key = JSON.stringify(value.scope)
    const current = snapshots.get(key) ?? snapshot
    if (
      current.revision !== value.expectedRevision
      || current.pending?.selectionGeneration !== value.pendingGeneration
    ) return false
    const next = { revision: current.revision + 1, effective: value.selection }
    snapshots.set(key, next)
    if (key === JSON.stringify(scope)) snapshot = next
    return true
  })
  const clearPending = vi.fn((value: {
    scope: NativeSubmissionScope
    expectedRevision: number
    pendingGeneration: number
  }) => {
    const key = JSON.stringify(value.scope)
    const current = snapshots.get(key) ?? snapshot
    if (
      current.revision !== value.expectedRevision
      || current.pending?.selectionGeneration !== value.pendingGeneration
    ) return false
    const next = { revision: current.revision + 1, effective: current.effective }
    snapshots.set(key, next)
    if (key === JSON.stringify(scope)) snapshot = next
    return true
  })
  const switchThread = vi.fn(async () => undefined)
  const runtimeRevalidate = vi.fn(async () => input.runtimeValid?.() ?? true)
  let id = 0
  const controller = createNativeSubmissionController({
    selection: {
      adoptScope: (source, target) => {
        const current = snapshots.get(JSON.stringify(source))
        if (!current) return false
        snapshots.set(JSON.stringify(target), current)
        return true
      },
      snapshot: requested => snapshots.get(JSON.stringify(requested)) ?? snapshot,
      commitEffective,
      clearPending,
    },
    credentials: { prepare },
    runtime: {
      revalidate: runtimeRevalidate,
      resolveCreatedScope: async (draft, threadId) => ({
        ...draft,
        threadId,
        navigationGeneration: input.createdNavigation?.() ?? draft.navigationGeneration,
      }),
    },
    existingThread: { switch: switchThread },
    ...(input.providerSource === undefined ? {} : { providerSource: input.providerSource }),
    ...(input.validateSelection === undefined ? {} : { validateSelection: input.validateSelection }),
    operationTtlMs: 100,
    now: input.now,
    createId: () => `opaque-operation-${String(++id).padStart(4, '0')}`,
  })
  return {
    controller,
    disposed,
    prepare,
    commitEffective,
    clearPending,
    switchThread,
    runtimeRevalidate,
    setSnapshot(next: NativeSubmissionSelectionSnapshot, requested = scope) {
      snapshots.set(JSON.stringify(requested), next)
      if (JSON.stringify(requested) === JSON.stringify(scope)) snapshot = next
    },
  }
}

describe('native submission controller', () => {
  it('revalidates config membership at preparation, reservation and final authorization', async () => {
    let valid = true
    const fixture = harness({
      pending: pendingDraft,
      providerSource: () => 'config',
      validateSelection: async selection =>
        valid && selection.providerId === pendingDraft.providerId && selection.model === pendingDraft.model,
    })
    valid = false
    expect((await fixture.controller.prepareSubmission(draftScope, draftAction)).kind).toBe('reject')
    valid = true
    const prepared = await fixture.controller.prepareSubmission(draftScope, draftAction)
    if (prepared.kind !== 'allow-original') throw new Error('operation not prepared')
    valid = false
    const request = { method: 'thread/start' as const, requestId, operationToken: prepared.operationToken }
    expect((await fixture.controller.consumeMarkedRequest(request)).kind).toBe('reject')
    valid = true
    const next = await fixture.controller.prepareSubmission(draftScope, draftAction)
    if (next.kind !== 'allow-original') throw new Error('operation not prepared')
    const nextRequest = { ...request, operationToken: next.operationToken }
    expect((await fixture.controller.consumeMarkedRequest(nextRequest)).kind).toBe('dispatch')
    valid = false
    expect(await fixture.controller.authorizeMarkedRequest(nextRequest)).toBe(false)
    expect(fixture.prepare).not.toHaveBeenCalled()
  })

  it('rejects a stale effective model before native pass-through without replacing its provider', async () => {
    const fixture = harness({ validateSelection: async () => false })
    expect((await fixture.controller.prepareSubmission(draftScope, draftAction)).kind).toBe('reject')
    expect(fixture.switchThread).not.toHaveBeenCalled()
  })

  it('rejects an existing-thread switch when catalog ownership disappears during idle revalidation', async () => {
    let valid = true
    const fixture = harness({
      scope: threadScope,
      pending: pendingThread,
      providerSource: () => 'config',
      validateSelection: async () => valid,
    })
    fixture.runtimeRevalidate.mockResolvedValueOnce(true).mockImplementationOnce(async () => {
      valid = false
      return true
    })
    expect((await fixture.controller.commitSelection(threadScope)).kind).toBe('reject')
    expect(fixture.switchThread).not.toHaveBeenCalled()
    expect(fixture.clearPending).toHaveBeenCalledOnce()
  })

  it('fails closed on catalog read errors but leaves the native default-provider path legal', async () => {
    const fixture = harness({
      validateSelection: async selection => {
        if (selection.providerId === 'openai') return true
        throw new Error('private catalog read failure')
      },
    })
    expect((await fixture.controller.prepareSubmission(draftScope, draftAction)).kind).toBe('reject')
    fixture.setSnapshot({ revision: 5, effective: { providerId: 'openai', model: 'native-default' } })
    expect(await fixture.controller.prepareSubmission(draftScope, draftAction)).toEqual({ kind: 'pass-through' })
  })
  it('returns an existing thread to built-in OpenAI without managed credentials or endpoint overrides', async () => {
    const fixture = harness({
      scope: threadScope,
      pending: { ...pendingThread, providerId: 'openai', model: 'gpt-6-astra' },
    })
    await expect(fixture.controller.commitSelection(threadScope)).resolves.toMatchObject({ kind: 'accepted' })
    expect(fixture.prepare).not.toHaveBeenCalled()
    expect(fixture.switchThread).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'openai',
      configOverrides: { model_provider: 'openai', model: 'gpt-6-astra' },
    }))
    await fixture.controller.dispose()
  })

  it.each(['steer', 'queue', 'edit-retry', 'unknown-submission'] as const)(
    'rejects pending provider for %s without credentials or resume',
    async intent => {
      const fixture = harness({ scope: threadScope, pending: pendingThread })
      await expect(fixture.controller.prepareSubmission(threadScope, { ...threadAction, intent })).resolves.toEqual({
        kind: 'reject',
        reason: 'unsupported-submission-intent',
      })
      expect(fixture.prepare).not.toHaveBeenCalled()
      expect(fixture.switchThread).not.toHaveBeenCalled()
      expect(fixture.clearPending).not.toHaveBeenCalled()
    },
  )

  it('uses a fresh operation deadline after human confirmation', async () => {
    let now = 0
    const fixture = harness({ scope: threadScope, pending: pendingThread, now: () => now })
    const prepared = await fixture.controller.prepareSubmission(threadScope, threadAction)
    if (prepared.kind !== 'confirm') throw new Error('expected confirmation')
    now = 500
    const result = await fixture.controller.confirmSubmission({
      scope: threadScope,
      confirmationId: prepared.confirmationId,
      expectedSelectionRevision: prepared.selectionRevision,
    })
    expect(result).toMatchObject({ kind: 'allow-original' })
    if (result.kind !== 'allow-original') throw new Error('expected token')
    await expect(
      fixture.controller.consumeMarkedRequest({
        method: 'turn/start',
        threadId: 'thread-1',
        requestId,
        operationToken: result.operationToken,
      }),
    ).resolves.toMatchObject({ kind: 'dispatch' })
    await fixture.controller.dispose()
    expect(fixture.disposed).toEqual(['provider-b-1'])
  })

  it.each(['selection', 'navigation'] as const)(
    'rejects %s changing during runtime validation, and disposes once',
    async change => {
      const fixture = harness({ pending: pendingDraft })
      const prepared = await fixture.controller.prepareSubmission(draftScope, draftAction)
      if (prepared.kind !== 'allow-original') throw new Error('expected token')
      let resolve!: (value: boolean) => void
      fixture.runtimeRevalidate.mockImplementationOnce(() =>
        new Promise(done => {
          resolve = done
        })
      )
      const request = { method: 'thread/start' as const, requestId, operationToken: prepared.operationToken }
      const consume = fixture.controller.consumeMarkedRequest(request)
      await expect(fixture.controller.consumeMarkedRequest(request)).resolves.toEqual({
        kind: 'reject',
        reason: 'unknown-token',
      })
      if (change === 'navigation') await fixture.controller.releaseScope(draftScope)
      else {fixture.setSnapshot({
          revision: 5,
          effective: { providerId: 'provider-a', model: 'model-a' },
          pending: { ...pendingDraft, selectionGeneration: 8 },
        })}
      resolve(true)
      await expect(consume).resolves.toEqual({ kind: 'reject', reason: 'request-mismatch' })
      expect(fixture.disposed).toEqual(['provider-b-1'])
      await fixture.controller.dispose()
      expect(fixture.disposed).toEqual(['provider-b-1'])
    },
  )

  it('rejects a request whose method or native thread differs from the token binding', async () => {
    const fixture = harness({ pending: pendingDraft })
    const prepared = await fixture.controller.prepareSubmission(draftScope, draftAction)
    if (prepared.kind !== 'allow-original') throw new Error('expected token')
    await expect(
      fixture.controller.consumeMarkedRequest({
        method: 'turn/start',
        threadId: 'thread-other',
        requestId,
        operationToken: prepared.operationToken,
      }),
    ).resolves.toEqual({ kind: 'reject', reason: 'request-mismatch' })
    expect(fixture.disposed).toEqual(['provider-b-1'])
  })

  it('binds reservation, authorization, and completion to one native request id', async () => {
    const fixture = harness({ pending: pendingDraft })
    const prepared = await fixture.controller.prepareSubmission(draftScope, draftAction)
    if (prepared.kind !== 'allow-original') throw new Error('expected token')
    await expect(fixture.controller.consumeMarkedRequest({
      method: 'thread/start',
      requestId,
      operationToken: prepared.operationToken,
    })).resolves.toMatchObject({ kind: 'dispatch' })
    await expect(fixture.controller.authorizeMarkedRequest({
      operationToken: prepared.operationToken,
      requestId: 'different-native-request',
    })).resolves.toBe(false)
    await fixture.controller.completeMarkedRequest({
      operationToken: prepared.operationToken,
      requestId: 'different-native-request',
      succeeded: false,
    })
    expect(fixture.disposed).toEqual([])
    await expect(fixture.controller.authorizeMarkedRequest({
      operationToken: prepared.operationToken,
      requestId,
    })).resolves.toBe(true)
    await fixture.controller.completeMarkedRequest({
      operationToken: prepared.operationToken,
      requestId,
      succeeded: false,
    })
    expect(fixture.disposed).toEqual(['provider-b-1'])
  })

  it('revalidates after reservation and denies before the native write when scope changes', async () => {
    let valid = true
    const fixture = harness({ pending: pendingDraft, runtimeValid: () => valid })
    const prepared = await fixture.controller.prepareSubmission(draftScope, draftAction)
    if (prepared.kind !== 'allow-original') throw new Error('expected token')
    await expect(fixture.controller.consumeMarkedRequest({
      method: 'thread/start',
      requestId,
      operationToken: prepared.operationToken,
    })).resolves.toMatchObject({ kind: 'dispatch' })
    valid = false
    await expect(fixture.controller.authorizeMarkedRequest({
      operationToken: prepared.operationToken,
      requestId,
    })).resolves.toBe(false)
    expect(fixture.runtimeRevalidate).toHaveBeenCalledTimes(2)
    expect(fixture.disposed).toEqual(['provider-b-1'])
  })

  it('rejects an effective-selection ABA between reservation and native write', async () => {
    const fixture = harness({ scope: threadScope, pending: pendingThread })
    const prepared = await fixture.controller.prepareSubmission(threadScope, threadAction)
    if (prepared.kind !== 'confirm') throw new Error('confirmation not prepared')
    const confirmed = await fixture.controller.confirmSubmission({
      scope: threadScope,
      confirmationId: prepared.confirmationId,
      expectedSelectionRevision: prepared.selectionRevision,
    })
    if (confirmed.kind !== 'allow-original') throw new Error('confirmation not allowed')
    await fixture.controller.consumeMarkedRequest({
      method: 'turn/start',
      threadId: 'thread-1',
      requestId,
      operationToken: confirmed.operationToken,
    })
    fixture.setSnapshot({ revision: 7, effective: { providerId: 'provider-b', model: 'model-b' } }, threadScope)
    await expect(fixture.controller.authorizeMarkedRequest({
      operationToken: confirmed.operationToken,
      requestId,
    })).resolves.toBe(false)
    await fixture.controller.releaseThread('thread-1')
    expect(fixture.disposed).toEqual(['provider-b-1'])
  })

  it('rejects non-loopback cleartext endpoints', async () => {
    const fixture = harness({ pending: pendingDraft })
    const lease = await fixture.prepare('unsafe')
    fixture.prepare.mockResolvedValueOnce({
      ...lease,
      endpoint: { baseUrl: 'http://provider.example/v1', wireApi: 'responses' },
    })
    await expect(fixture.controller.prepareSubmission(draftScope, draftAction)).resolves.toEqual({
      kind: 'reject',
      reason: 'provider-preparation-failed',
    })
    expect(fixture.disposed).toEqual(['unsafe-1'])
  })

  it('passes every native action unchanged when no provider change is pending', async () => {
    const { controller, prepare } = harness()
    for (const intent of ['ordinary-send', 'steer', 'queue', 'edit-retry', 'unknown-submission'] as const) {
      await expect(controller.prepareSubmission(draftScope, { ...draftAction, intent })).resolves.toEqual({
        kind: 'pass-through',
      })
    }
    expect(prepare).not.toHaveBeenCalled()
  })

  it('prepares a new draft directly and binds one exact marked thread/start', async () => {
    const { controller, disposed, commitEffective } = harness({ pending: pendingDraft })
    const prepared = await controller.prepareSubmission(draftScope, draftAction)
    expect(prepared).toMatchObject({ kind: 'allow-original', operationToken: expect.any(String) })
    if (prepared.kind !== 'allow-original') throw new Error('operation not prepared')

    const consumed = await controller.consumeMarkedRequest({
      method: 'thread/start',
      requestId,
      operationToken: prepared.operationToken,
    })
    expect(consumed).toMatchObject({
      kind: 'dispatch',
      providerId: 'provider-b',
      model: 'model-b',
      serviceGeneration: 'service-provider-b-1',
      configOverrides: {
        model_provider: 'provider-b',
        model: 'model-b',
        'model_providers.provider-b': {
          requires_openai_auth: false,
          auth: {
            command: '/usr/bin/node',
            args: ['/private/helper.mjs', 'provider-b-1'],
            cwd: '/private',
            timeout_ms: 5_000,
            refresh_interval_ms: 200,
          },
        },
      },
    })
    expect(disposed).toEqual([])
    await expect(controller.authorizeMarkedRequest({ operationToken: prepared.operationToken, requestId })).resolves
      .toBe(true)
    await controller.completeMarkedRequest({
      operationToken: prepared.operationToken,
      requestId,
      succeeded: true,
      boundThreadId: threadScope.threadId,
    })
    expect(commitEffective).toHaveBeenCalledWith(expect.objectContaining({ scope: threadScope }))
    expect(disposed).toEqual([])
    await expect(
      controller.consumeMarkedRequest({
        method: 'turn/start',
        threadId: 'thread-1',
        requestId: 'native-request-2',
        operationToken: prepared.operationToken,
      }),
    ).resolves.toMatchObject({ kind: 'dispatch', model: 'model-b' })
    await expect(controller.authorizeMarkedRequest({
      operationToken: prepared.operationToken,
      requestId: 'native-request-2',
    })).resolves.toBe(true)
    await controller.completeMarkedRequest({
      operationToken: prepared.operationToken,
      requestId: 'native-request-2',
      succeeded: true,
    })
    await expect(
      controller.consumeMarkedRequest({
        method: 'turn/start',
        threadId: 'thread-1',
        requestId: 'native-request-3',
        operationToken: prepared.operationToken,
      }),
    ).resolves.toEqual({ kind: 'reject', reason: 'unknown-token' })
    await controller.releaseScope(threadScope)
    expect(disposed).toEqual([])
    await controller.releaseThread('thread-1')
    expect(disposed).toEqual(['provider-b-1'])
  })

  it('forwards the catalog model id unchanged without adding the provider prefix', async () => {
    const publishedModelId = 'dyai-aiden-gpt-5.6-sol'
    const fixture = harness({
      pending: { ...pendingDraft, providerId: 'aiden', model: publishedModelId },
    })
    const prepared = await fixture.controller.prepareSubmission(draftScope, draftAction)
    if (prepared.kind !== 'allow-original') throw new Error('operation not prepared')

    await expect(fixture.controller.consumeMarkedRequest({
      method: 'thread/start',
      requestId,
      operationToken: prepared.operationToken,
    })).resolves.toMatchObject({
      kind: 'dispatch',
      providerId: 'aiden',
      model: publishedModelId,
      configOverrides: {
        model_provider: 'aiden',
        model: publishedModelId,
      },
    })
  })

  it('routes a config-backed new draft through Codex config without managed credentials', async () => {
    const fixture = harness({
      pending: { ...pendingDraft, providerId: 'deepseek', model: 'deepseek-chat' },
      providerSource: id => id === 'deepseek' ? 'config' : undefined,
    })
    const prepared = await fixture.controller.prepareSubmission(draftScope, draftAction)
    if (prepared.kind !== 'allow-original') throw new Error('operation not prepared')

    await expect(fixture.controller.consumeMarkedRequest({
      method: 'thread/start',
      requestId,
      operationToken: prepared.operationToken,
    })).resolves.toMatchObject({
      kind: 'dispatch',
      providerId: 'deepseek',
      model: 'deepseek-chat',
      serviceGeneration: 'native-config',
      configOverrides: { model_provider: 'deepseek', model: 'deepseek-chat' },
    })
    expect(fixture.prepare).not.toHaveBeenCalled()
  })

  it('switches an idle existing thread to a config-backed provider without managed credentials', async () => {
    const fixture = harness({
      scope: threadScope,
      pending: { ...pendingThread, providerId: 'deepseek', model: 'deepseek-chat' },
      providerSource: id => id === 'deepseek' ? 'config' : undefined,
    })
    await expect(fixture.controller.commitSelection(threadScope)).resolves.toMatchObject({ kind: 'accepted' })
    expect(fixture.switchThread).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'deepseek',
      model: 'deepseek-chat',
      configOverrides: { model_provider: 'deepseek', model: 'deepseek-chat' },
      serviceGeneration: 'native-config',
    }))
    expect(fixture.prepare).not.toHaveBeenCalled()
  })

  it('rejects a provider not present in either managed or configured sources', async () => {
    const fixture = harness({ pending: pendingDraft, providerSource: () => undefined })
    await expect(fixture.controller.prepareSubmission(draftScope, draftAction)).resolves.toEqual({
      kind: 'reject',
      reason: 'provider-preparation-failed',
    })
    expect(fixture.prepare).not.toHaveBeenCalled()
  })

  it('commits an existing-thread provider selection immediately after authoritative idle revalidation', async () => {
    const { controller, switchThread, disposed, runtimeRevalidate } = harness({
      scope: threadScope,
      pending: pendingThread,
    })
    await expect(controller.commitSelection(threadScope)).resolves.toMatchObject({
      kind: 'accepted',
      projection: { effective: { providerId: 'provider-b', model: 'model-b' } },
    })
    expect(runtimeRevalidate).toHaveBeenCalledWith(threadScope, true)
    expect(switchThread).toHaveBeenCalledWith(expect.objectContaining({
      scope: threadScope,
      threadId: 'thread-1',
      providerId: 'provider-b',
      model: 'model-b',
    }))
    expect(disposed).toEqual([])
    await controller.releaseScope(threadScope)
    expect(disposed).toEqual([])
    await controller.releaseThread('thread-1')
    expect(disposed).toEqual(['provider-b-1'])
  })

  it('rejects an immediate existing-thread switch without committing stale state', async () => {
    const { controller, switchThread, commitEffective, clearPending, disposed } = harness({
      scope: threadScope,
      pending: pendingThread,
      runtimeValid: () => false,
    })
    await expect(controller.commitSelection(threadScope)).resolves.toEqual({
      kind: 'reject',
      reason: 'stale-operation',
    })
    expect(switchThread).not.toHaveBeenCalled()
    expect(commitEffective).not.toHaveBeenCalled()
    expect(clearPending).toHaveBeenCalledWith({
      scope: threadScope,
      expectedRevision: 4,
      pendingGeneration: 7,
    })
    expect(disposed).toEqual([])
  })

  it('clears the pending selection when an immediate existing-thread switch fails', async () => {
    const fixture = harness({ scope: threadScope, pending: pendingThread })
    fixture.switchThread.mockRejectedValueOnce(new Error('resume failed'))
    await expect(fixture.controller.commitSelection(threadScope)).resolves.toEqual({
      kind: 'reject',
      reason: 'thread-switch-failed',
    })
    expect(fixture.clearPending).toHaveBeenCalledWith({
      scope: threadScope,
      expectedRevision: 4,
      pendingGeneration: 7,
    })
    expect(fixture.commitEffective).not.toHaveBeenCalled()
    expect(fixture.disposed).toEqual(['provider-b-1'])
  })

  it('moves the exact returned thread selection when its composer mounts before the first turn', async () => {
    let navigation = draftScope.navigationGeneration
    const h = harness({ pending: pendingDraft, createdNavigation: () => navigation })
    const prepared = await h.controller.prepareSubmission(draftScope, draftAction)
    if (prepared.kind !== 'allow-original') throw new Error('expected token')
    await h.controller.consumeMarkedRequest({
      method: 'thread/start',
      requestId,
      operationToken: prepared.operationToken,
    })
    await h.controller.authorizeMarkedRequest({ operationToken: prepared.operationToken, requestId })
    await h.controller.completeMarkedRequest({
      operationToken: prepared.operationToken,
      requestId,
      succeeded: true,
      boundThreadId: 'thread-1',
    })
    navigation++
    await expect(
      h.controller.consumeMarkedRequest({
        method: 'turn/start',
        requestId: 'native-request-2',
        operationToken: prepared.operationToken,
        threadId: 'thread-1',
      }),
    )
      .resolves.toMatchObject({ kind: 'dispatch', model: 'model-b' })
    expect(h.runtimeRevalidate).toHaveBeenLastCalledWith(
      { ...threadScope, navigationGeneration: navigation },
      true,
      draftScope,
    )
    await h.controller.dispose()
    expect(h.disposed).toEqual(['provider-b-1'])
  })

  it('releases a migrated draft operation from its exact bound thread scope', async () => {
    const h = harness({ pending: pendingDraft })
    const prepared = await h.controller.prepareSubmission(draftScope, draftAction)
    if (prepared.kind !== 'allow-original') throw new Error('expected token')
    await h.controller.consumeMarkedRequest({
      method: 'thread/start',
      requestId,
      operationToken: prepared.operationToken,
    })
    await h.controller.authorizeMarkedRequest({ operationToken: prepared.operationToken, requestId })
    await h.controller.completeMarkedRequest({
      operationToken: prepared.operationToken,
      requestId,
      succeeded: true,
      boundThreadId: 'thread-1',
    })
    await h.controller.releaseScope(threadScope)
    expect(h.disposed).toEqual([])
    await h.controller.releaseThread('thread-1')
    expect(h.disposed).toEqual(['provider-b-1'])
  })

  it('fails closed when target generation or authoritative idle state changes', async () => {
    let valid = true
    const { controller, switchThread, prepare } = harness({
      scope: threadScope,
      pending: pendingThread,
      runtimeValid: () => valid,
    })
    const prepared = await controller.prepareSubmission(threadScope, threadAction)
    if (prepared.kind !== 'confirm') throw new Error('confirmation not prepared')
    valid = false
    await expect(controller.confirmSubmission({
      scope: threadScope,
      confirmationId: prepared.confirmationId,
      expectedSelectionRevision: prepared.selectionRevision,
    })).resolves.toEqual({ kind: 'reject', reason: 'stale-operation' })
    expect(prepare).not.toHaveBeenCalled()
    expect(switchThread).not.toHaveBeenCalled()
  })

  it('expires, rejects duplicates, and releases a deferred marked request lease', async () => {
    let now = 10
    const { controller, disposed } = harness({ pending: pendingDraft, now: () => now })
    const first = await controller.prepareSubmission(draftScope, draftAction)
    if (first.kind !== 'allow-original') throw new Error('operation not prepared')
    now = 111
    await expect(controller.consumeMarkedRequest({
      method: 'thread/start',
      requestId,
      operationToken: first.operationToken,
    })).resolves.toEqual({ kind: 'reject', reason: 'expired-token' })
    expect(disposed).toEqual(['provider-b-1'])
    await expect(controller.consumeMarkedRequest({
      method: 'thread/start',
      requestId: 'native-request-2',
      operationToken: first.operationToken,
    })).resolves.toEqual({ kind: 'reject', reason: 'unknown-token' })
  })

  it('rejects cross-target cancellation without consuming the owning operation', async () => {
    const { controller } = harness({ pending: pendingDraft })
    const prepared = await controller.prepareSubmission(draftScope, draftAction)
    if (prepared.kind !== 'allow-original') throw new Error('operation not prepared')
    const other = { ...draftScope, targetId: 'target-b' }
    await expect(controller.cancel({ scope: other, id: prepared.operationToken })).resolves.toBe(false)
    await expect(controller.consumeMarkedRequest({
      method: 'thread/start',
      requestId,
      operationToken: prepared.operationToken,
    })).resolves.toMatchObject({ kind: 'dispatch' })
  })

  it('cancels unconsumed operations and clears scoped pending state on navigation release', async () => {
    const { controller, disposed, clearPending } = harness({ pending: pendingDraft })
    const prepared = await controller.prepareSubmission(draftScope, draftAction)
    if (prepared.kind !== 'allow-original') throw new Error('operation not prepared')
    await expect(controller.cancel({ scope: draftScope, id: prepared.operationToken })).resolves.toBe(true)
    expect(disposed).toEqual(['provider-b-1'])
    await controller.releaseScope(draftScope)
    expect(clearPending).toHaveBeenCalledWith({
      scope: draftScope,
      expectedRevision: 4,
      pendingGeneration: 7,
    })
  })

  it('does not promote or retain a lease when new-thread completion lacks an exact bound scope', async () => {
    const { controller, disposed, commitEffective } = harness({ pending: pendingDraft })
    const prepared = await controller.prepareSubmission(draftScope, draftAction)
    if (prepared.kind !== 'allow-original') throw new Error('operation not prepared')
    await controller.consumeMarkedRequest({
      method: 'thread/start',
      requestId,
      operationToken: prepared.operationToken,
    })
    await controller.authorizeMarkedRequest({ operationToken: prepared.operationToken, requestId })
    await controller.completeMarkedRequest({
      operationToken: prepared.operationToken,
      requestId,
      succeeded: true,
    })
    expect(commitEffective).not.toHaveBeenCalled()
    expect(disposed).toEqual(['provider-b-1'])
  })

  it('rejects a stale Send but retains credentials for the thread that already resumed', async () => {
    const fixture = harness({ scope: threadScope, pending: pendingThread })
    fixture.switchThread.mockImplementation(async () => {
      fixture.setSnapshot({
        revision: 5,
        effective: { providerId: 'provider-a', model: 'model-a' },
        pending: { ...pendingThread, model: 'model-c', selectionGeneration: 8 },
      })
    })
    const prepared = await fixture.controller.prepareSubmission(threadScope, threadAction)
    if (prepared.kind !== 'confirm') throw new Error('confirmation not prepared')

    await expect(fixture.controller.confirmSubmission({
      scope: threadScope,
      confirmationId: prepared.confirmationId,
      expectedSelectionRevision: prepared.selectionRevision,
    })).resolves.toEqual({ kind: 'reject', reason: 'thread-switch-failed' })
    expect(fixture.commitEffective).not.toHaveBeenCalled()
    expect(fixture.disposed).toEqual([])
    await fixture.controller.releaseThread('thread-1')
    expect(fixture.disposed).toEqual(['provider-b-1'])
  })

  it('retains a successful binding lease until controller disposal', async () => {
    const fixture = harness({ scope: threadScope, pending: pendingThread })
    const prepared = await fixture.controller.prepareSubmission(threadScope, threadAction)
    if (prepared.kind !== 'confirm') throw new Error('confirmation not prepared')
    await expect(fixture.controller.confirmSubmission({
      scope: threadScope,
      confirmationId: prepared.confirmationId,
      expectedSelectionRevision: prepared.selectionRevision,
    })).resolves.toMatchObject({ kind: 'allow-original', operationToken: expect.any(String) })
    expect(fixture.disposed).toEqual([])

    await fixture.controller.dispose()
    expect(fixture.disposed).toEqual(['provider-b-1'])
  })

  it('commits a restarted app-server resume lease only after native success', async () => {
    const fixture = harness()
    const prepared = await fixture.controller.prepareThreadResume({
      threadId: 'thread-1',
      providerId: 'provider-b',
      model: 'model-b',
    })
    expect(prepared).toEqual({
      kind: 'resume',
      resumeToken: 'opaque-operation-0001',
      configOverrides: {
        'model_providers.provider-b': {
          name: 'CordisX managed provider',
          base_url: 'http://127.0.0.1:43127/v1',
          wire_api: 'responses',
          requires_openai_auth: false,
          auth: {
            command: '/usr/bin/node',
            args: ['/private/helper.mjs', 'provider-b-1'],
            cwd: '/private',
            timeout_ms: 5_000,
            refresh_interval_ms: 200,
          },
        },
      },
    })
    if (prepared.kind !== 'resume') throw new Error('resume not prepared')
    expect(fixture.disposed).toEqual([])
    await expect(fixture.controller.completeThreadResume({
      threadId: 'thread-1',
      resumeToken: prepared.resumeToken,
      succeeded: true,
    })).resolves.toBe(true)
    await fixture.controller.releaseThread('thread-1')
    expect(fixture.disposed).toEqual(['provider-b-1'])
  })

  it('keeps the existing binding when a candidate resume fails', async () => {
    const fixture = harness()
    const first = await fixture.controller.prepareThreadResume({
      threadId: 'thread-1',
      providerId: 'provider-b',
      model: 'model-b',
    })
    if (first.kind !== 'resume') throw new Error('first resume not prepared')
    await fixture.controller.completeThreadResume({
      threadId: 'thread-1',
      resumeToken: first.resumeToken,
      succeeded: true,
    })
    const candidate = await fixture.controller.prepareThreadResume({
      threadId: 'thread-1',
      providerId: 'provider-b',
      model: 'model-c',
    })
    if (candidate.kind !== 'resume') throw new Error('candidate resume not prepared')

    await expect(fixture.controller.completeThreadResume({
      threadId: 'thread-1',
      resumeToken: candidate.resumeToken,
      succeeded: false,
    })).resolves.toBe(true)
    expect(fixture.disposed).toEqual(['provider-b-2'])
    await fixture.controller.releaseThread('thread-1')
    expect(fixture.disposed).toEqual(['provider-b-2', 'provider-b-1'])
  })

  it('atomically replaces the prior binding after a candidate resume succeeds', async () => {
    const fixture = harness()
    const first = await fixture.controller.prepareThreadResume({
      threadId: 'thread-1',
      providerId: 'provider-b',
      model: 'model-b',
    })
    if (first.kind !== 'resume') throw new Error('first resume not prepared')
    await fixture.controller.completeThreadResume({
      threadId: 'thread-1',
      resumeToken: first.resumeToken,
      succeeded: true,
    })
    const replacement = await fixture.controller.prepareThreadResume({
      threadId: 'thread-1',
      providerId: 'provider-b',
      model: 'model-c',
    })
    if (replacement.kind !== 'resume') throw new Error('replacement resume not prepared')

    await expect(fixture.controller.completeThreadResume({
      threadId: 'thread-1',
      resumeToken: replacement.resumeToken,
      succeeded: true,
    })).resolves.toBe(true)
    expect(fixture.disposed).toEqual(['provider-b-1'])
    await fixture.controller.releaseThread('thread-1')
    expect(fixture.disposed).toEqual(['provider-b-1', 'provider-b-2'])
  })

  it('releases an uncompleted candidate resume lease on controller disposal', async () => {
    const fixture = harness()
    await expect(fixture.controller.prepareThreadResume({
      threadId: 'thread-1',
      providerId: 'provider-b',
      model: 'model-b',
    })).resolves.toMatchObject({ kind: 'resume' })
    expect(fixture.disposed).toEqual([])

    await fixture.controller.dispose()
    expect(fixture.disposed).toEqual(['provider-b-1'])
    await fixture.controller.dispose()
    expect(fixture.disposed).toEqual(['provider-b-1'])
  })

  it('never prepares a resume for built-in OpenAI or an unavailable provider', async () => {
    const fixture = harness()
    await expect(fixture.controller.prepareThreadResume({ threadId: 'thread-1', providerId: 'openai', model: 'gpt' }))
      .resolves.toEqual({ kind: 'reject', reason: 'unknown-provider' })
    expect(fixture.prepare).not.toHaveBeenCalled()
    fixture.prepare.mockRejectedValueOnce(new Error('provider is not ready'))
    await expect(fixture.controller.prepareThreadResume({
      threadId: 'thread-1',
      providerId: 'provider-b',
      model: 'model-b',
    })).resolves.toEqual({ kind: 'reject', reason: 'provider-preparation-failed' })
    expect(fixture.disposed).toEqual([])
  })

  it('resumes a config-backed thread through persisted Codex config without a provider table', async () => {
    const fixture = harness({ providerSource: id => id === 'deepseek' ? 'config' : undefined })
    const prepared = await fixture.controller.prepareThreadResume({
      threadId: 'thread-1',
      providerId: 'deepseek',
      model: 'deepseek-chat',
    })
    expect(prepared).toMatchObject({ kind: 'resume', configOverrides: {} })
    if (prepared.kind !== 'resume') throw new Error('resume not prepared')
    await expect(fixture.controller.completeThreadResume({
      threadId: 'thread-1',
      resumeToken: prepared.resumeToken,
      succeeded: true,
    })).resolves.toBe(true)
    expect(fixture.prepare).not.toHaveBeenCalled()
  })

  it('rejects a config-backed resume when catalog admission blocks the model', async () => {
    const validateSelection = vi.fn(async () => false)
    const fixture = harness({
      providerSource: id => id === 'deepseek' ? 'config' : undefined,
      validateSelection,
    })
    await expect(fixture.controller.prepareThreadResume({
      threadId: 'thread-1',
      providerId: 'deepseek',
      model: 'deepseek-chat',
    })).resolves.toEqual({ kind: 'reject', reason: 'unknown-provider' })
    expect(validateSelection).toHaveBeenCalledWith({ providerId: 'deepseek', model: 'deepseek-chat' })
    expect(fixture.prepare).not.toHaveBeenCalled()
  })
})
