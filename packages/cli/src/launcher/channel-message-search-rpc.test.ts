import { describe, expect, it, vi } from 'vitest'
import { channelMessageSearchRpc } from './channel-message-search-rpc.js'

const ref = { adapterId: 'feishu', accountId: 'app', tenantId: 'tenant' }
const source = {
  ...ref,
  conversationId: 'oc_source',
  kind: 'group' as const,
  threadId: 'oc_source',
  semantics: 'conversation' as const,
  eventId: 'incoming',
}
const request = {
  account: ref,
  conversationId: 'oc_source',
  kind: 'group',
  query: 'project',
  startTime: '1',
  endTime: '3',
}
const current = (messageSearch = vi.fn(async () => ({ status: 'ok', messages: [] }))) =>
  ({
    accounts: () => [{ ref, state: 'ready' }],
    messageSearch,
  }) as never

describe('authorized message-search RPC', () => {
  it('confines account, conversation and kind to the verified incoming source', async () => {
    const read = vi.fn()
    for (const changed of [{ conversationId: 'oc_other' }, { kind: 'direct' }]) {
      await expect(
        channelMessageSearchRpc({ ...request, ...changed }, ref, {
          current: current(read),
          source,
          active: () => true,
        }),
      )
        .rejects.toThrow('CHANNEL_SOURCE_SCOPE_MISMATCH')
    }
    await expect(
      channelMessageSearchRpc(request, { ...ref, tenantId: 'other' }, {
        current: current(read),
        source,
        active: () => true,
      }),
    )
      .rejects.toThrow('CHANNEL_SOURCE_SCOPE_MISMATCH')
    expect(read).not.toHaveBeenCalled()
  })
  it('rejects extra selectors and malformed windows before platform reads', async () => {
    const read = vi.fn()
    for (
      const changed of [{ chatIds: ['other'] }, { startTime: 1 }, { endTime: '1' }, { query: ' ' }, { pageSize: 51 }]
    ) {
      await expect(
        channelMessageSearchRpc({ ...request, ...changed }, ref, {
          current: current(read),
          source,
          active: () => true,
        }),
      )
        .rejects.toThrow('INVALID_REQUEST')
    }
    expect(read).not.toHaveBeenCalled()
  })
  it('fences a missing native source, denied history, and generation revocation', async () => {
    const read = vi.fn()
    const consumer = { taskSettings: { isBound: () => true }, commandAllowed: () => false } as never
    await expect(
      channelMessageSearchRpc(request, ref, {
        current: current(read),
        consumer,
        nativeCaller: 'session',
        active: () => true,
      }),
    )
      .rejects.toThrow('CHANNEL_CONTEXT_UNAVAILABLE')
    await expect(
      channelMessageSearchRpc(request, ref, { current: current(read), consumer, source, active: () => true }),
    )
      .rejects.toThrow('CHANNEL_POLICY_DENIED')
    await expect(channelMessageSearchRpc(request, ref, { current: current(read), source, active: () => false }))
      .rejects.toThrow('CHANNEL_GENERATION_CHANGED')
    expect(read).not.toHaveBeenCalled()
  })
  it('rechecks before disclosing a resolved page', async () => {
    let active = true
    const read = vi.fn(async () => {
      active = false
      return { status: 'ok', messages: [] }
    })
    await expect(channelMessageSearchRpc(request, ref, { current: current(read), source, active: () => active }))
      .rejects.toThrow('CHANNEL_GENERATION_CHANGED')
  })
})
