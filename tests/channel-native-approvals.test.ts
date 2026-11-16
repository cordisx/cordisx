import { describe, expect, it, vi } from 'vitest'
import { ChannelNativeApprovals } from '../packages/cli/src/launcher/channel-native-approvals.js'

const event = {
  adapterId: 'feishu',
  accountId: 'test',
  tenantId: 'test',
  conversationId: 'oc_group',
  kind: 'group' as const,
  threadId: 'oc_group',
  semantics: 'conversation' as const,
  eventId: 'om_event',
  actor: { adapterId: 'feishu', accountId: 'test', tenantId: 'test', userId: 'ou_alice' },
}
const request = {
  type: 'native-approval-event',
  event: 'requested',
  reference: 'request',
  requestId: 7,
  method: 'item/commandExecution/requestApproval',
  params: { threadId: 'chat', turnId: 'turn', itemId: 'item', command: 'echo hello', reason: 'Test operation' },
}
function fixture(routineAllowed?: () => boolean) {
  let listener!: (event: Record<string, unknown>) => void
  const cards: object[] = [], updates: object[] = []
  let bindings = [{ id: 'binding', sessionId: 'chat', channel: event, state: 'active' }]
  let allowed = true
  const native = {
    label: async () => '飞书 · 联调群',
    approvalEvents: (callback: typeof listener) => {
      listener = callback
      return () => {}
    },
    answerApproval: vi.fn(async () => ({ status: 'submitted' })),
  }
  const notify = vi.fn(async () => undefined)
  const updateCard = vi.fn(async (_event: unknown, _id: string, card: object) => {
    updates.push(card)
  })
  const report = vi.fn()
  const approvals = new ChannelNativeApprovals({
    bindings: () => bindings as never,
    ...(routineAllowed ? { routineAllowed } : {}),
    allowed: () => allowed,
    sendCard: async (_event, card) => {
      cards.push(card)
      return 'om_card'
    },
    updateCard,
    notify,
    report,
  })
  approvals.attach(native as never)
  return {
    approvals,
    native,
    cards,
    updates,
    notify,
    updateCard,
    report,
    emit: (value: Record<string, unknown>) => listener(value),
    allow: (value: boolean) => {
      allowed = value
    },
    bindings: (value: typeof bindings) => {
      bindings = value
    },
  }
}
describe('Channel custom approval lifecycle', () => {
  it('accepts one accurate routine request without a card and suppresses duplicates before the acknowledgement', async () => {
    const f = fixture(() => true)
    let resolve!: (value: { status: string }) => void
    f.native.answerApproval.mockImplementation(() =>
      new Promise(done => {
        resolve = done
      })
    )
    f.emit(request)
    f.emit(request)
    await vi.waitFor(() => expect(f.native.answerApproval).toHaveBeenCalledTimes(1))
    resolve({ status: 'submitted' })
    await Promise.resolve()
    f.emit(request)
    expect(f.native.answerApproval).toHaveBeenCalledTimes(1)
    expect(f.cards).toHaveLength(0)
    f.approvals.dispose()
  })

  it('keeps a lost automatic approval unknown without a second native effect or an actionable button', async () => {
    const f = fixture(() => true)
    f.native.answerApproval.mockRejectedValue(new Error('lost acknowledgement'))
    f.emit(request)
    await vi.waitFor(() => expect(f.cards).toHaveLength(1))
    expect(JSON.stringify(f.cards[0])).toContain('提交结果未知')
    expect(JSON.stringify(f.cards[0])).not.toContain('批准这一次')
    f.emit(request)
    expect(f.native.answerApproval).toHaveBeenCalledTimes(1)
    f.emit({ event: 'resolved', reference: 'request' })
    await vi.waitFor(() => expect(JSON.stringify(f.updates.at(-1))).toContain('已处理'))
    f.approvals.dispose()
  })

  it('does not turn a native confirmation preceding notification into a new pending request', async () => {
    const f = fixture()
    f.emit({ event: 'resolved', reference: 'request' })
    f.emit(request)
    await Promise.resolve()
    expect(f.cards).toHaveLength(0)
    expect(f.native.answerApproval).not.toHaveBeenCalled()
    f.approvals.dispose()
  })
  it('waits for the initial native binding; authenticates the actor and exact card, then preserves terminal confirmation', async () => {
    const f = fixture()
    f.bindings([])
    f.emit(request)
    f.bindings([{ id: 'binding', sessionId: 'chat', channel: event, state: 'active' }])
    await vi.waitFor(() => expect(f.cards).toHaveLength(1))
    const card = f.cards[0] as { elements: { actions?: { value: { channelApproval: string } }[] }[] }
    const token = card.elements.find(row => row.actions)?.actions?.[0]?.value.channelApproval!
    f.allow(false)
    expect(await f.approvals.answer(event, token, 'accept', 'om_card')).toContain('没有审批权限')
    f.allow(true)
    expect(await f.approvals.answer(event, token, 'accept', 'om_other')).toContain('不属于')
    expect(f.native.answerApproval).not.toHaveBeenCalled()
    f.native.answerApproval.mockImplementation(async () => {
      f.emit({ event: 'resolved', reference: 'request' })
      return { status: 'expired' }
    })
    expect(await f.approvals.answer(event, token, 'accept', 'om_card')).toContain('原生已确认')
    expect(JSON.stringify(f.updates.at(-1))).toContain('已处理')
    expect(await f.approvals.answer(event, token, 'accept', 'om_card')).toContain('未重复执行')
    expect(f.native.answerApproval).toHaveBeenCalledTimes(1)
    f.approvals.dispose()
  })
  it('rejects another account/conversation, cancels late cards, and expires text decisions without native effects', async () => {
    const f = fixture()
    f.emit(request)
    await vi.waitFor(() => expect(f.cards).toHaveLength(1))
    const id = /审批 ([a-f0-9]+)/u.exec(JSON.stringify(f.cards[0]))![1]!
    expect(await f.approvals.answer({ ...event, conversationId: 'oc_other' }, id, 'decline')).toContain('没有对应')
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000)
    try {
      expect(await f.approvals.answer(event, id, 'decline')).toContain('已过期')
    } finally {
      now.mockRestore()
    }
    expect(f.native.answerApproval).not.toHaveBeenCalled()
    f.emit({ ...request, reference: 'cancelled-request' })
    f.emit({ event: 'cancelled', reference: 'cancelled-request' })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(f.cards).toHaveLength(1)
    f.approvals.dispose()
  })
  it('keeps native confirmation authoritative and sends one status fallback when the card replace fails', async () => {
    const f = fixture()
    f.emit(request)
    await vi.waitFor(() => expect(f.cards).toHaveLength(1))
    const id = /审批 ([a-f0-9]+)/u.exec(JSON.stringify(f.cards[0]))![1]!
    f.updateCard.mockRejectedValue(new Error('CHANNEL_APPROVAL_CARD_UPDATE_FAILED'))
    f.native.answerApproval.mockImplementation(async () => {
      f.emit({ event: 'resolved', reference: 'request' })
      return { status: 'submitted' }
    })
    expect(await f.approvals.answer(event, id, 'decline', 'om_card')).toContain('原生已确认')
    f.emit({ event: 'resolved', reference: 'request' })
    expect(await f.approvals.answer(event, id, 'decline', 'om_card')).toContain('未重复执行')
    expect(f.native.answerApproval).toHaveBeenCalledTimes(1)
    expect(f.updateCard).toHaveBeenCalledTimes(1)
    expect(f.notify).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ ...event, eventId: 'approval:item' }),
      expect.stringContaining('原生已确认处理。原卡片更新失败'),
      `approval:${id}:card-update:resolved`,
    )
    expect(f.report).toHaveBeenCalledExactlyOnceWith('CHANNEL_APPROVAL_CARD_UPDATE_FAILED')
    f.approvals.dispose()
  })
})
