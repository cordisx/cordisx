import { describe, expect, it, vi } from 'vitest'
import {
  type MutableNativeSubmitAuthority,
  NativeProviderSelectionClient,
  type NativeProviderSelectionCommandChannel,
  type NativeProviderSelectionProjection,
} from '../packages/cli/src/renderer/native-provider-selection-client.js'

const scope = { targetId: 'target', rendererGeneration: 'renderer', navigationGeneration: 1 }
const pending = { providerId: 'b', model: 'b-model', generation: 2 }
const descriptor = {
  target: 'worktree',
  thread: false,
  response: false,
  followUp: undefined,
  followUpThread: undefined,
  defaultAction: 'steer',
  explicitAction: undefined,
  edit: undefined,
  promptOverride: false,
}
const token = 'exact-operation-token'
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
async function harness(hasPending = true, existing = false, effort?: 'low' | 'high' | 'max') {
  let authority: MutableNativeSubmitAuthority = {
    scope: { ...scope, ...(existing ? { threadId: 'thread-1' } : {}) },
    idle: true,
  }
  let projection: NativeProviderSelectionProjection = {
    available: true,
    revision: 2,
    effective: { providerId: 'a', model: 'a-model' },
    ...(hasPending ? { pending } : {}),
  }
  const channel = {
    selectionDiscard: vi.fn(async () => {
      projection = { available: true, revision: projection.revision + 1, effective: projection.effective }
      return projection
    }),
    selectionRead: vi.fn(async () => projection),
    selectionSelect: vi.fn<NativeProviderSelectionCommandChannel['selectionSelect']>(async input => ({
      status: 'accepted',
      revision: 3,
      effective: existing ? { providerId: input.providerId, model: input.model } : projection.effective!,
      ...(existing ? {} : { pending: { providerId: input.providerId, model: input.model, generation: 3 } }),
    })),
    submissionPrepare: vi.fn<NativeProviderSelectionCommandChannel['submissionPrepare']>(async () =>
      hasPending ? { status: 'allow-original', operationToken: token } : { status: 'pass-through' }
    ),
    submissionConfirm: vi.fn<NativeProviderSelectionCommandChannel['submissionConfirm']>(async () => ({
      status: 'allow-original',
      operationToken: token,
      projection: { available: true, revision: 97, effective: { providerId: 'b', model: 'b-model' } },
    })),
    submissionCancel: vi.fn(async () => undefined),
  }
  const notice = vi.fn()
  const synchronizeEffective = vi.fn(async () => {})
  const client = new NativeProviderSelectionClient(
    channel,
    () => authority,
    notice,
    synchronizeEffective,
    () => 'operation-id',
    () => effort,
  )
  await client.refresh()
  return {
    client,
    channel,
    notice,
    synchronizeEffective,
    setAuthority(next: MutableNativeSubmitAuthority) {
      authority = next
    },
    setProjection(next: NativeProviderSelectionProjection) {
      projection = next
    },
  }
}

describe('native provider selection client', () => {
  it.each([true, false])('adds target effort only for a pending ordinary send (%s)', async hasPending => {
    const h = await harness(hasPending, false, 'max')
    await h.client.submitHook(descriptor)
    expect(h.channel.submissionPrepare).toHaveBeenCalledWith({
      scope,
      action: {
        operationId: 'operation-id',
        operationGeneration: 1,
        intent: 'ordinary-send',
        ...(hasPending ? { reasoningEffort: 'max' } : {}),
      },
    })
  })

  it('retains target effort while confirming and passes the captured value to native synchronization', async () => {
    const h = await harness(true, true, 'max')
    h.channel.submissionPrepare.mockResolvedValueOnce({
      status: 'confirm',
      confirmationId: 'confirmation-token',
      expectedSelectionRevision: 2,
    })
    const send = h.client.submitHook({
      ...descriptor,
      target: 'local',
      thread: 'thread-1',
      followUp: 'local',
      followUpThread: 'thread-1',
    })
    await Promise.resolve()
    h.client.confirmSubmission(true)
    await expect(send).resolves.toEqual({ allow: true, operationToken: token, reasoningEffort: 'max' })
    expect(h.synchronizeEffective).toHaveBeenLastCalledWith({ providerId: 'b', model: 'b-model' }, 'max')
  })
  it('keeps a draft selection pending for its first thread start', async () => {
    const h = await harness(false)
    expect(await h.client.select({ providerId: 'b', model: 'b-model' })).toBe('accepted')
    expect(h.client.snapshot()).toMatchObject({ effective: { providerId: 'a' }, pending: { providerId: 'b' } })
    expect(h.channel.submissionPrepare).not.toHaveBeenCalled()
    expect(h.channel.submissionConfirm).not.toHaveBeenCalled()
  })

  it('synchronizes an existing-thread selection immediately', async () => {
    const h = await harness(false, true)
    expect(await h.client.select({ providerId: 'b', model: 'b-model' })).toBe('accepted')
    expect(h.client.snapshot()).toEqual({
      available: true,
      revision: 3,
      effective: { providerId: 'b', model: 'b-model' },
    })
    expect(h.synchronizeEffective).toHaveBeenCalledWith({ providerId: 'b', model: 'b-model' })
    expect(h.channel.submissionPrepare).not.toHaveBeenCalled()
  })

  it('allows ordinary worktree Send even when the native default action is steer', async () => {
    const h = await harness()
    await expect(h.client.submitHook(descriptor)).resolves.toEqual({ allow: true, operationToken: token })
    expect(h.channel.submissionPrepare).toHaveBeenCalledWith({
      scope,
      action: { operationId: 'operation-id', operationGeneration: 1, intent: 'ordinary-send' },
    })
    expect(h.channel.submissionCancel).not.toHaveBeenCalled()
  })

  it.each([
    { response: true, defaultAction: 'steer' },
    { explicitAction: 'queue' },
    { edit: 0 },
    { target: 'unknown' },
    { promptOverride: true },
  ])('notifies and rejects unsupported pending-provider submission %j without side effects', async changes => {
    const h = await harness()
    await expect(h.client.submitHook({ ...descriptor, ...changes })).resolves.toEqual({ allow: false })
    expect(h.notice).toHaveBeenCalledWith('unsupported-submission-intent')
    expect(h.client.snapshot().pending).toEqual(pending)
    expect(h.channel.submissionPrepare).not.toHaveBeenCalled()
    expect(h.channel.submissionConfirm).not.toHaveBeenCalled()
    expect(h.channel.submissionCancel).not.toHaveBeenCalled()
  })

  it('passes unchanged-provider busy steer and queue concurrently without idle restrictions', async () => {
    const h = await harness(false)
    h.setAuthority({ scope, idle: false })
    const first = deferred<Awaited<ReturnType<NativeProviderSelectionCommandChannel['submissionPrepare']>>>()
    h.channel.submissionPrepare.mockReturnValueOnce(first.promise)
    const steer = h.client.submitHook({ ...descriptor, response: true })
    await expect(h.client.submitHook({ ...descriptor, explicitAction: 'queue' })).resolves.toEqual({ allow: true })
    first.resolve({ status: 'pass-through' })
    await expect(steer).resolves.toEqual({ allow: true })
    expect(h.notice).not.toHaveBeenCalled()
  })

  it.each(['navigation', 'busy', 'selection'] as const)(
    'denies and cancels admission when %s changes while preparing',
    async change => {
      const h = await harness()
      const wait = deferred<Awaited<ReturnType<NativeProviderSelectionCommandChannel['submissionPrepare']>>>()
      h.channel.submissionPrepare.mockReturnValueOnce(wait.promise)
      const submit = h.client.submitHook(descriptor)
      if (change === 'navigation') {
        h.setAuthority({ scope: { ...scope, navigationGeneration: 2 }, idle: true })
        h.client.invalidateScope()
      }
      if (change === 'busy') h.setAuthority({ scope, idle: false })
      if (change === 'selection') await h.client.select({ providerId: 'c', model: 'c-model' })
      wait.resolve({ status: 'allow-original', operationToken: token })
      await expect(submit).resolves.toEqual({ allow: false })
      expect(h.channel.submissionCancel).toHaveBeenCalledWith({ scope, id: token })
    },
  )

  it('rejects a double Send without invalidating the original admission', async () => {
    const h = await harness()
    const wait = deferred<Awaited<ReturnType<NativeProviderSelectionCommandChannel['submissionPrepare']>>>()
    h.channel.submissionPrepare.mockReturnValueOnce(wait.promise)
    const first = h.client.submitHook(descriptor)
    await expect(h.client.submitHook(descriptor)).resolves.toEqual({ allow: false })
    wait.resolve({ status: 'allow-original', operationToken: token })
    await expect(first).resolves.toEqual({ allow: true, operationToken: token })
    expect(h.channel.submissionPrepare).toHaveBeenCalledTimes(1)
  })

  it.each([true, false])('waits for existing-thread send confirmation (%s), then settles once', async confirmed => {
    const h = await harness(true, true)
    h.channel.submissionPrepare.mockResolvedValueOnce({
      status: 'confirm',
      confirmationId: 'confirmation-token',
      expectedSelectionRevision: 2,
    })
    const submit = h.client.submitHook({
      ...descriptor,
      target: 'local',
      thread: 'thread-1',
      followUp: 'local',
      followUpThread: 'thread-1',
    })
    await Promise.resolve()
    expect(h.client.confirmation()).toMatchObject({ threadId: 'thread-1', target: pending })
    expect(h.channel.submissionConfirm).not.toHaveBeenCalled()
    h.client.confirmSubmission(confirmed)
    await expect(submit).resolves.toEqual(confirmed ? { allow: true, operationToken: token } : { allow: false })
    expect(h.client.confirmation()).toBeUndefined()
    expect(h.channel.submissionConfirm).toHaveBeenCalledTimes(confirmed ? 1 : 0)
    expect(h.channel.submissionCancel).toHaveBeenCalledTimes(confirmed ? 0 : 1)
    if (confirmed) {
      expect(h.synchronizeEffective).toHaveBeenCalledWith({ providerId: 'b', model: 'b-model' })
      expect(h.client.snapshot()).toEqual({
        available: true,
        revision: 97,
        effective: { providerId: 'b', model: 'b-model' },
      })
    }
  })

  it('settles pending confirmation on disposal and ignores stale projection replies', async () => {
    const h = await harness(true, true)
    const wait = deferred<NativeProviderSelectionProjection>()
    h.channel.selectionRead.mockReturnValueOnce(wait.promise)
    const refresh = h.client.refresh()
    h.channel.submissionPrepare.mockResolvedValueOnce({
      status: 'confirm',
      confirmationId: 'confirmation-token',
      expectedSelectionRevision: 2,
    })
    const submit = h.client.submitHook({
      ...descriptor,
      target: 'local',
      thread: 'thread-1',
      followUp: 'local',
      followUpThread: 'thread-1',
    })
    await Promise.resolve()
    h.client.dispose()
    wait.resolve({ available: true, revision: 100, pending })
    await refresh
    await expect(submit).resolves.toEqual({ allow: false })
    expect(h.client.snapshot().available).toBe(false)
  })

  it('retries a failed committed model synchronization on the next ordinary Send', async () => {
    const h = await harness(true, true)
    const locked: boolean[] = []
    h.client.subscribe(() => locked.push(h.client.submissionActive()))
    h.channel.submissionPrepare.mockResolvedValueOnce({
      status: 'confirm',
      confirmationId: 'confirmation-token',
      expectedSelectionRevision: 2,
    })
    h.synchronizeEffective.mockRejectedValueOnce(new Error('native callback failed'))
    const action = { ...descriptor, target: 'local', thread: 'thread-1', followUp: 'local', followUpThread: 'thread-1' }
    const send = h.client.submitHook(action)
    await Promise.resolve()
    h.client.confirmSubmission(true)
    await expect(send).resolves.toEqual({ allow: false })
    h.channel.submissionPrepare.mockResolvedValueOnce({ status: 'pass-through' })
    await expect(h.client.submitHook(action)).resolves.toEqual({ allow: true })
    expect(h.channel.submissionPrepare).toHaveBeenCalledTimes(2)
    expect(h.channel.submissionCancel).toHaveBeenCalledWith({ scope: { ...scope, threadId: 'thread-1' }, id: token })
    expect(locked).toContain(true)
    expect(locked.at(-1)).toBe(false)
  })

  it('recovers a failed synchronization from a fresh authoritative projection', async () => {
    const h = await harness(false, true)
    h.synchronizeEffective.mockRejectedValueOnce(new Error('control not ready'))
    await h.client.refresh()
    const action = { ...descriptor, target: 'local', thread: 'thread-1', followUp: 'local', followUpThread: 'thread-1' }
    h.synchronizeEffective.mockRejectedValueOnce(new Error('still not ready'))
    await expect(h.client.submitHook(action)).resolves.toEqual({ allow: false })
    expect(h.channel.submissionPrepare).not.toHaveBeenCalled()
    await h.client.refresh()
    await expect(h.client.submitHook(action)).resolves.toEqual({ allow: true })
  })

  it('keeps the Send fence after a failed refresh while allowing a subsequent provider selection', async () => {
    const h = await harness(false, true)
    h.synchronizeEffective.mockRejectedValueOnce(new Error('control not ready'))
    await h.client.refresh()
    expect(h.client.snapshot()).toMatchObject({ available: true, effective: { providerId: 'a', model: 'a-model' } })
    expect(h.client.selectionActive()).toBe(false)
    expect(h.client.synchronizationActive()).toBe(true)
    h.synchronizeEffective.mockRejectedValueOnce(new Error('still not ready'))
    await expect(h.client.submitHook(descriptor)).resolves.toEqual({ allow: false })
    await expect(h.client.select({ providerId: 'b', model: 'b-model' })).resolves.toBe('accepted')
    expect(h.client.synchronizationActive()).toBe(false)
    await expect(h.client.submitHook(descriptor)).resolves.toEqual({ allow: true })
  })

  it('locks an in-flight native acknowledgement but permits retry after it fails', async () => {
    const h = await harness(false, true)
    const acknowledgement = deferred<void>()
    h.synchronizeEffective.mockImplementationOnce(async () => {
      await acknowledgement.promise
      throw new Error('control did not acknowledge')
    })
    const first = h.client.select({ providerId: 'b', model: 'b-model' })
    await Promise.resolve()
    expect(h.client.selectionActive()).toBe(true)
    await expect(h.client.submitHook(descriptor)).resolves.toEqual({ allow: false })
    expect(h.channel.submissionPrepare).not.toHaveBeenCalled()
    await expect(h.client.select({ providerId: 'c', model: 'c-model' })).resolves.toBe('unavailable')
    expect(h.channel.selectionSelect).toHaveBeenCalledTimes(1)
    acknowledgement.resolve()
    await expect(first).resolves.toBe('accepted')
    expect(h.client.selectionActive()).toBe(false)
    expect(h.client.synchronizationActive()).toBe(true)
    await expect(h.client.select({ providerId: 'c', model: 'c-model' })).resolves.toBe('accepted')
    expect(h.client.synchronizationActive()).toBe(false)
  })

  it('rejects commands after an authoritative selection read fails', async () => {
    const h = await harness(false, true)
    h.channel.selectionRead.mockRejectedValueOnce(new Error('renderer owner no longer admitted'))
    await h.client.refresh()
    expect(h.client.snapshot().available).toBe(false)
    expect(h.client.selectionActive()).toBe(false)
    expect(h.client.synchronizationActive()).toBe(true)
    await expect(h.client.select({ providerId: 'b', model: 'b-model' })).resolves.toBe('unavailable')
    expect(h.channel.selectionSelect).not.toHaveBeenCalled()
    await expect(h.client.submitHook(descriptor)).resolves.toEqual({ allow: false })
  })

  it('keeps a failed choice, retries only on ordinary Send and releases failed retry locks', async () => {
    const h = await harness(false, true)
    const action = { ...descriptor, target: 'local', thread: 'thread-1', followUp: 'local', followUpThread: 'thread-1' }
    h.synchronizeEffective.mockRejectedValueOnce(new Error('control not ready'))
    await expect(h.client.select({ providerId: 'b', model: 'b-model' })).resolves.toBe('accepted')
    expect(h.notice).not.toHaveBeenCalled()
    const calls = h.synchronizeEffective.mock.calls.length
    await expect(h.client.submitHook({ ...action, response: true })).resolves.toEqual({ allow: false })
    expect(h.synchronizeEffective).toHaveBeenCalledTimes(calls)
    h.synchronizeEffective.mockRejectedValueOnce(new Error('still not ready'))
    await expect(h.client.submitHook(action)).resolves.toEqual({ allow: false })
    expect(h.channel.submissionPrepare).not.toHaveBeenCalled()
    expect(h.client.snapshot().effective).toEqual({ providerId: 'b', model: 'b-model' })
    expect(h.client.selectionActive()).toBe(false)
    const wait = deferred<void>()
    h.synchronizeEffective.mockReturnValueOnce(wait.promise)
    const retry = h.client.submitHook(action)
    await expect(h.client.submitHook(action)).resolves.toEqual({ allow: false })
    await expect(h.client.select({ providerId: 'c', model: 'c-model' })).resolves.toBe('unavailable')
    wait.resolve()
    await expect(retry).resolves.toEqual({ allow: true })
    expect(h.client.synchronizationActive()).toBe(false)
  })

  it('sends a retained native transition through preparation without requesting another confirmation', async () => {
    const h = await harness(false, true)
    h.channel.selectionSelect.mockResolvedValueOnce({
      status: 'accepted',
      revision: 3,
      effective: { providerId: 'a', model: 'a-model' },
      pending: { providerId: 'b', model: 'b-model', generation: 3, sendOnly: true },
    })
    await expect(h.client.select({ providerId: 'b', model: 'b-model' })).resolves.toBe('accepted')
    const action = { ...descriptor, target: 'local', thread: 'thread-1', followUp: 'local', followUpThread: 'thread-1' }
    h.channel.submissionPrepare.mockResolvedValueOnce({ status: 'reject', reason: 'provider-preparation-failed' })
    await expect(h.client.submitHook(action)).resolves.toEqual({ allow: false })
    expect(h.client.snapshot().pending?.providerId).toBe('b')
    expect(h.client.submissionActive()).toBe(false)
    h.channel.submissionPrepare.mockResolvedValueOnce({
      status: 'allow-original',
      operationToken: token,
      projection: { available: true, revision: 4, effective: { providerId: 'b', model: 'b-model' } },
    })
    await expect(h.client.submitHook(action)).resolves.toEqual({ allow: true, operationToken: token })
    expect(h.channel.submissionConfirm).not.toHaveBeenCalled()
    expect(h.client.snapshot().effective?.providerId).toBe('b')
  })

  it('rejects a synchronization retry when navigation changes while it waits', async () => {
    const h = await harness(false, true)
    h.synchronizeEffective.mockRejectedValueOnce(new Error('control not ready'))
    await h.client.select({ providerId: 'b', model: 'b-model' })
    const wait = deferred<void>()
    h.synchronizeEffective.mockReturnValueOnce(wait.promise)
    const retry = h.client.submitHook({ ...descriptor, target: 'local', thread: 'thread-1' })
    h.setAuthority({ scope: { ...scope, navigationGeneration: 2, threadId: 'thread-2' }, idle: true })
    h.client.invalidateScope()
    wait.resolve()
    await expect(retry).resolves.toEqual({ allow: false })
    expect(h.channel.submissionPrepare).not.toHaveBeenCalled()
  })

  it('blocks Send before the Host acknowledges an in-flight provider selection', async () => {
    const h = await harness(false, true)
    const selected = deferred<Awaited<ReturnType<NativeProviderSelectionCommandChannel['selectionSelect']>>>()
    h.channel.selectionSelect.mockReturnValueOnce(selected.promise)
    const select = h.client.select({ providerId: 'b', model: 'b-model' })
    await expect(h.client.submitHook(descriptor)).resolves.toEqual({ allow: false })
    expect(h.channel.submissionPrepare).not.toHaveBeenCalled()
    selected.resolve({ status: 'accepted', revision: 3, effective: { providerId: 'b', model: 'b-model' } })
    await expect(select).resolves.toBe('accepted')
    await expect(h.client.submitHook(descriptor)).resolves.toEqual({ allow: true })
  })

  it('does not synchronize a projection after its notification changes the renderer scope', async () => {
    const h = await harness(false, true)
    let moved = false
    h.client.subscribe(() => {
      if (moved || h.client.snapshot().effective?.providerId !== 'b') return
      moved = true
      h.setAuthority({ scope: { ...scope, navigationGeneration: 2, threadId: 'thread-2' }, idle: true })
      h.client.invalidateScope()
    })
    h.synchronizeEffective.mockClear()
    await expect(h.client.select({ providerId: 'b', model: 'b-model' })).resolves.toBe('unavailable')
    expect(h.synchronizeEffective).not.toHaveBeenCalled()
    expect(h.client.selectionActive()).toBe(false)
    expect(h.client.snapshot().available).toBe(false)
  })

  it('keeps overlapping selection reads locked until all native acknowledgements finish', async () => {
    const h = await harness(false, true)
    const first = deferred<void>()
    const second = deferred<void>()
    h.synchronizeEffective.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
    const a = h.client.refresh()
    await Promise.resolve()
    const b = h.client.refresh()
    await Promise.resolve()
    first.resolve()
    await a
    expect(h.client.selectionActive()).toBe(true)
    expect(h.client.synchronizationActive()).toBe(true)
    second.resolve()
    await b
    expect(h.client.selectionActive()).toBe(false)
    expect(h.client.synchronizationActive()).toBe(false)
  })

  it('fences Send before the asynchronous selection read returns', async () => {
    const h = await harness(false, true)
    const read = deferred<NativeProviderSelectionProjection>()
    h.channel.selectionRead.mockReturnValueOnce(read.promise)
    const refresh = h.client.refresh()
    await expect(h.client.submitHook(descriptor)).resolves.toEqual({ allow: false })
    expect(h.channel.submissionPrepare).not.toHaveBeenCalled()
    read.resolve(h.client.snapshot())
    await refresh
    await expect(h.client.submitHook(descriptor)).resolves.toEqual({ allow: true })
  })

  it('rejects stale native model state before an unchanged Send and starts recovery', async () => {
    const h = await harness(false, true)
    h.setAuthority({
      scope: { ...scope, threadId: 'thread-1' },
      idle: true,
      effective: { providerId: 'a', model: 'stale-model' },
    })
    await expect(h.client.submitHook(descriptor)).resolves.toEqual({ allow: false })
    expect(h.channel.submissionPrepare).not.toHaveBeenCalled()
    expect(h.notice).toHaveBeenCalledWith('submission-rejected')
    expect(h.channel.selectionRead).toHaveBeenCalledTimes(2)
  })

  it('does not release a captured Send after a concurrent model refresh has finished', async () => {
    const h = await harness(false, true)
    const prepare = deferred<Awaited<ReturnType<NativeProviderSelectionCommandChannel['submissionPrepare']>>>()
    h.channel.submissionPrepare.mockReturnValueOnce(prepare.promise)
    const send = h.client.submitHook(descriptor)
    await h.client.refresh()
    prepare.resolve({ status: 'pass-through' })
    await expect(send).resolves.toEqual({ allow: false })
    expect(h.notice).toHaveBeenCalledWith('submission-rejected')
  })
})
