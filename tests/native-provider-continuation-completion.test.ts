import { describe, expect, it, vi } from 'vitest'
import { createNativeContinuationCompletion } from '../packages/cli/src/renderer/native-provider-continuation.js'
import { nativeComposerContinuation } from '../packages/cli/src/renderer/native-composer-submission-router.js'
import type { NativeProviderSelectionClient } from '../packages/cli/src/renderer/native-provider-selection-client.js'

function fixture() {
  let scope = {
    targetId: 'own',
    rendererGeneration: 'document',
    composerId: 'composer',
    navigationGeneration: 0,
    threadId: 'source',
  }
  const refresh = vi.fn(async () => {})
  const failed = vi.fn()
  const navigate = vi.fn(async (_thread: string) => {})
  const client = { refresh, reportContinuationFailure: failed } as unknown as NativeProviderSelectionClient
  const owner = {
    snapshot: () => ({ scope, idle: true }),
    composer: () => ({ isConnected: true }) as HTMLElement,
    ...nativeComposerContinuation(client, navigate),
  }
  const completion = createNativeContinuationCompletion()
  const witness = {
    operationToken: 'original-token',
    continuation: { sourceThreadId: 'source', threadId: 'branch' },
    accepted: true as const,
  }
  completion.admitted(owner, { allow: true, ...witness })
  return {
    completion,
    owner,
    witness,
    refresh,
    failed,
    navigate,
    leave: () => {
      scope = { ...scope, navigationGeneration: 1, threadId: 'elsewhere' }
    },
  }
}

describe('accepted native continuation completion', () => {
  it('refreshes the exact source selection before awaited native navigation and consumes success once', async () => {
    const f = fixture()
    await f.completion.complete(f.witness)
    expect(f.refresh).toHaveBeenCalledOnce()
    expect(f.navigate).toHaveBeenCalledWith('branch')
    expect(f.refresh.mock.invocationCallOrder[0]).toBeLessThan(f.navigate.mock.invocationCallOrder[0]!)
    await f.completion.complete(f.witness)
    expect(f.navigate).toHaveBeenCalledOnce()
    expect(f.failed).not.toHaveBeenCalled()
  })

  it('does not take the user back when its source owner changes during success refresh', async () => {
    const f = fixture()
    let release!: () => void
    f.refresh.mockImplementation(() =>
      new Promise(resolve => {
        release = resolve
      })
    )
    const completing = f.completion.complete(f.witness)
    f.leave()
    release()
    await completing
    expect(f.navigate).not.toHaveBeenCalled()
    expect(f.failed).not.toHaveBeenCalled()
  })

  it('reports a native navigation rejection without unhandled rejection or another Send', async () => {
    const f = fixture()
    f.navigate.mockRejectedValue(Error('Native navigation failed'))
    await expect(f.completion.complete(f.witness)).resolves.toBeUndefined()
    expect(f.failed).toHaveBeenCalledOnce()
    await f.completion.complete(f.witness)
    expect(f.navigate).toHaveBeenCalledOnce()
  })

  it('does not refresh or navigate an unmatched operation or released owner', async () => {
    const f = fixture()
    await f.completion.complete({ ...f.witness, operationToken: 'other-operation' })
    f.completion.release(f.owner)
    await f.completion.complete(f.witness)
    expect(f.refresh).not.toHaveBeenCalled()
    expect(f.navigate).not.toHaveBeenCalled()
  })
})
