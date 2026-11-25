import { describe, expect, it, vi } from 'vitest'
import { feishuThreadForward } from './feishu-thread-forward.js'

const source = {
  adapterId: 'feishu',
  accountId: 'app',
  tenantId: 'tenant',
  conversationId: 'oc_source',
  kind: 'group' as const,
}
const request = {
  contract: 'cordisx.channel-thread-forward/v1' as const,
  schemaVersion: 1 as const,
  operation: 'thread-forward' as const,
  operationId: 'stable',
  source,
  target: { ...source, conversationId: 'oc_target' },
  threadId: 'omt_topic',
  anchorMessageId: 'om_anchor',
}
const anchor = { message_id: 'om_anchor', chat_id: 'oc_source', thread_id: 'omt_topic' }
const result = { code: 0, data: { message_id: 'om_forwarded', chat_id: 'oc_target' } }
const sdk = (
  get: unknown,
  forward: unknown,
  chatGet: unknown = async () => ({ code: 0, data: { chat_mode: 'group' } }),
) =>
  ({
    rawClient: {
      im: {
        v1: {
          message: { get },
          chat: { get: chatGet },
          thread: { forward },
        },
      },
    },
  }) as never
const get = () => vi.fn(async () => ({ code: 0, data: { items: [anchor] } }))

describe('native whole-topic forwarding', () => {
  it('does not trust caller-supplied destination kind or default missing metadata to group', async () => {
    const forward = vi.fn(async () => result)
    expect(
      await feishuThreadForward(
        { ...request, target: { ...request.target, kind: 'direct' } },
        sdk(get(), forward),
        () => true,
        () => {},
      ),
    )
      .toMatchObject({ state: 'failed', code: 'THREAD_FORWARD_TARGET_DENIED' })
    expect(
      await feishuThreadForward(
        request,
        sdk(get(), forward, async () => ({ code: 0, data: { name: 'private' } })),
        () => true,
        () => {},
      ),
    ).toMatchObject({ state: 'failed', code: 'THREAD_FORWARD_TARGET_DENIED' })
    expect(forward).not.toHaveBeenCalled()
    expect(
      await feishuThreadForward(
        { ...request, target: { ...request.target, kind: 'direct' } },
        sdk(get(), forward, async () => ({ code: 0, data: { chat_mode: 'p2p' } })),
        () => true,
        () => {},
      ),
    )
      .toMatchObject({ state: 'sent' })
  })
  it('uses the actual thread endpoint and requires a verified destination receipt', async () => {
    const read = get(), forward = vi.fn(async () => result), authorize = vi.fn()
    expect(await feishuThreadForward(request, sdk(read, forward), () => true, authorize))
      .toMatchObject({ state: 'sent', externalMessageId: 'om_forwarded' })
    expect(read).toHaveBeenCalledWith({ path: { message_id: 'om_anchor' } })
    expect(forward).toHaveBeenCalledWith({
      path: { thread_id: 'omt_topic' },
      params: { receive_id_type: 'chat_id', uuid: 'stable' },
      data: { receive_id: 'oc_target' },
    })
    expect(authorize).toHaveBeenCalledTimes(6)
  })
  it('does not forward guessed topics, deleted anchors or another conversation', async () => {
    for (
      const item of [{ ...anchor, thread_id: 'omt_other' }, { ...anchor, chat_id: 'oc_other' }, {
        ...anchor,
        deleted: true,
      }, { ...anchor, thread_id: undefined }]
    ) {
      const forward = vi.fn()
      const read = async () => ({ code: 0, data: { items: [item] } })
      expect(await feishuThreadForward(request, sdk(read, forward), () => true, () => {}))
        .toMatchObject({ state: 'failed', code: 'THREAD_FORWARD_SOURCE_DENIED' })
      expect(forward).not.toHaveBeenCalled()
    }
  })
  it('distinguishes definite rejection from missing, mismatched and ambiguous acknowledgements', async () => {
    expect(
      await feishuThreadForward(
        request,
        sdk(get(), async () => ({ code: 999, data: result.data })),
        () => true,
        () => {},
      ),
    ).toMatchObject({ state: 'unknown' })
    expect(await feishuThreadForward(request, sdk(get(), async () => ({ code: 999 })), () => true, () => {}))
      .toMatchObject({ state: 'failed', code: 'PLATFORM_THREAD_FORWARD_REJECTED' })
    for (
      const response of [{}, { code: 0, data: {} }, { code: 0, data: { ...result.data, chat_id: 'oc_other' } }, {
        code: 0,
        data: { ...result.data, invalid_message_ids: ['om_child'] },
      }]
    ) {
      expect(await feishuThreadForward(request, sdk(get(), async () => response), () => true, () => {}))
        .toMatchObject({ state: 'unknown' })
    }
  })
  it('fences permission revocation before mutation and does not mislabel post-effect uncertainty', async () => {
    for (const failureAt of [2, 3, 4, 5, 6]) {
      let checks = 0
      const forward = vi.fn(async () => result)
      expect(
        await feishuThreadForward(request, sdk(get(), forward), () => true, () => {
          if (++checks === failureAt) throw new Error('DENIED')
        }),
      ).toMatchObject({ state: failureAt === 6 ? 'unknown' : 'failed' })
      expect(forward).toHaveBeenCalledTimes(failureAt === 6 ? 1 : 0)
    }
  })
  it('never starts an effect after a late anchor response or replays a timed-out effect', async () => {
    vi.useFakeTimers()
    try {
      let resolveAnchor!: (value: unknown) => void
      const forward = vi.fn(async () => result)
      const pending = feishuThreadForward(
        request,
        sdk(() =>
          new Promise(resolve => {
            resolveAnchor = resolve
          }), forward),
        () => true,
        () => {},
      )
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await pending).toMatchObject({ state: 'failed' })
      resolveAnchor({ code: 0, data: { items: [anchor] } })
      await vi.advanceTimersByTimeAsync(0)
      expect(forward).not.toHaveBeenCalled()
      let resolveTarget!: (value: unknown) => void
      const targetPending = feishuThreadForward(
        request,
        sdk(get(), forward, () =>
          new Promise(resolve => {
            resolveTarget = resolve
          })),
        () => true,
        () => {},
      )
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await targetPending).toMatchObject({ state: 'failed' })
      resolveTarget({ code: 0, data: { chat_mode: 'group' } })
      await vi.advanceTimersByTimeAsync(0)
      expect(forward).not.toHaveBeenCalled()
      const uncertain = vi.fn(() => new Promise(() => {}))
      const effect = feishuThreadForward(request, sdk(get(), uncertain), () => true, () => {})
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await effect).toMatchObject({ state: 'unknown' })
      expect(uncertain).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
