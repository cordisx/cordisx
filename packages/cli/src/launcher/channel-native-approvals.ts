import { randomBytes } from 'node:crypto'
import type { ChannelEventRef } from '@cordisx/channel-runtime'
import { channelApprovalCard, type ChannelApprovalDisplay, channelApprovalPreview } from './channel-approval-card.js'
import type { ChannelChatBinding } from './channel-conversation-store.js'
import type { ChannelNativeSessions } from './channel-native-sessions.js'

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const same = (left: ChannelEventRef, right: ChannelEventRef) =>
  ['adapterId', 'accountId', 'tenantId', 'conversationId'].every(field => object(left)[field] === object(right)[field])
interface Pending {
  readonly display: ChannelApprovalDisplay
  readonly native: Record<string, unknown>
  readonly targets: readonly ChannelEventRef[]
  readonly expiresAt: number
  cards: {
    event: ChannelEventRef
    messageId: string
    updatedState?: ChannelApprovalDisplay['state']
    failedState?: ChannelApprovalDisplay['state']
  }[]
  state: ChannelApprovalDisplay['state']
  updates: Promise<void>
}
export class ChannelNativeApprovals {
  private readonly pending = new Map<string, Pending>()
  private readonly terminal = new Map<string, { event: string; at: number }>()
  private native: ChannelNativeSessions | undefined
  private unsubscribe: (() => void) | undefined
  private disposed = false
  constructor(
    private readonly input: {
      bindings(): readonly ChannelChatBinding[]
      allowed(event: ChannelEventRef, command: string): boolean
      sendCard(event: ChannelEventRef, card: object): Promise<string>
      updateCard(event: ChannelEventRef, messageId: string, card: object): Promise<void>
      notify(event: ChannelEventRef, text: string, operation: string): Promise<unknown>
      report?(code: string): void
    },
  ) {}
  attach(native: ChannelNativeSessions | undefined) {
    if (!native || native === this.native || this.disposed) return
    this.unsubscribe?.()
    this.native = native
    this.unsubscribe = native.approvalEvents?.(event => {
      void this.event(event).catch(() => this.input.report?.('CHANNEL_APPROVAL_NOTIFICATION_FAILED'))
    })
  }
  private async event(event: Record<string, unknown>) {
    if (this.disposed || typeof event.reference !== 'string') return
    if (event.event !== 'requested') {
      const pending = this.pending.get(event.reference)
      if (!pending) {
        this.terminal.set(event.reference, { event: String(event.event), at: Date.now() })
        if (this.terminal.size > 256) this.terminal.delete(this.terminal.keys().next().value!)
        return
      }
      if (pending.state === 'resolved' || pending.state === 'cancelled') return
      pending.state = event.event === 'cancelled' ? 'cancelled' : event.event === 'answered'
        ? 'submitted'
        : event.event === 'unknown'
        ? 'unknown'
        : 'resolved'
      await this.update(pending)
      return
    }
    if (this.pending.has(event.reference) || this.terminal.has(event.reference) || this.pending.size >= 128) return
    const params = object(event.params)
    if (typeof params.threadId !== 'string' || typeof params.turnId !== 'string' || typeof params.itemId !== 'string') {
      return
    }
    // Approval can precede the first-turn acknowledgement that attaches the new binding.
    let bindings = this.input.bindings().filter(binding =>
      binding.sessionId === params.threadId && binding.state === 'active'
    )
    for (let attempt = 0; !bindings.length && attempt < 30 && !this.disposed; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100))
      bindings = this.input.bindings().filter(binding =>
        binding.sessionId === params.threadId && binding.state === 'active'
      )
    }
    if (!bindings.length || this.disposed || this.terminal.has(event.reference)) return
    const targets = [...new Map(bindings.map(binding => {
      const event: ChannelEventRef = { ...binding.channel, eventId: `approval:${params.itemId}` }
      return [JSON.stringify([event.adapterId, event.accountId, event.tenantId, event.conversationId]), event] as const
    })).values()]
    const id = randomBytes(4).toString('hex'), token = randomBytes(24).toString('hex')
    const display: ChannelApprovalDisplay = {
      id,
      token,
      state: 'pending',
      chat: await this.native?.label(params.threadId).catch(() => undefined) ?? 'Codex 对话',
      reason: channelApprovalPreview(params.reason, '原生执行器请求操作授权。'),
      scope: event.method === 'item/fileChange/requestApproval'
        ? `文件修改${typeof params.grantRoot === 'string' ? `：${channelApprovalPreview(params.grantRoot, '')}` : ''}`
        : [
          channelApprovalPreview(params.command, '命令执行'),
          typeof params.cwd === 'string' ? `目录：${channelApprovalPreview(params.cwd, '')}` : '',
          params.networkApprovalContext ? '包含网络操作授权' : '',
        ].filter(Boolean).join('\n'),
    }
    if (this.terminal.has(event.reference) || this.disposed) return
    const pending: Pending = {
      display,
      native: {
        reference: event.reference,
        requestId: event.requestId,
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId,
      },
      targets,
      cards: [],
      state: 'pending',
      updates: Promise.resolve(),
      expiresAt: Date.now() + 10 * 60_000,
    }
    this.pending.set(event.reference, pending)
    for (const target of targets) {
      try {
        const messageId = await this.input.sendCard(target, channelApprovalCard(display))
        pending.cards.push({ event: target, messageId })
        if (pending.state !== 'pending') await this.update(pending)
      } catch {
        await this.input.notify(
          target,
          `${display.chat}需要授权：${display.reason}\n${display.scope}\n回复 /approve ${id} once 或 /deny ${id}。`,
          `approval:${id}:fallback`,
        )
      }
    }
  }
  async answer(event: ChannelEventRef, id: string | undefined, decision: string, cardMessageId?: string) {
    if (!['accept', 'acceptForSession', 'decline'].includes(decision)) return '审批决定无效；未提交。'
    const command = decision === 'decline' ? 'deny' : 'approve'
    if (!event.actor?.userId || !this.input.allowed(event, command)) {
      return '当前用户没有审批权限。请在 CordisX 的用户组与指令规则中配置。'
    }
    const all = [...this.pending.values()].filter(item => item.targets.some(target => same(target, event)))
    const candidates = id
      ? all.filter(item => item.display.id === id || item.display.token === id)
      : all.filter(item => item.state === 'pending')
    if (candidates.length !== 1) {
      return candidates.length
        ? `请选择审批编号：${candidates.map(item => item.display.id).join('、')}。`
        : '当前会话没有对应的待审批请求。'
    }
    const pending = candidates[0]!
    if (cardMessageId && !pending.cards.some(card => same(card.event, event) && card.messageId === cardMessageId)) {
      return '这张卡片不属于此审批请求。'
    }
    if (pending.state !== 'pending') {
      return `此审批已${
        pending.state === 'resolved' ? '处理' : pending.state === 'cancelled' ? '取消' : '提交或过期'
      }，未重复执行。`
    }
    if (pending.expiresAt <= Date.now()) {
      pending.state = 'expired'
      await this.update(pending)
      return '审批已过期，请核对原生待处理请求。'
    }
    if (
      !this.input.bindings().some(binding =>
        binding.sessionId === pending.native.threadId && binding.state === 'active'
        && same({ ...binding.channel, eventId: '' }, event)
      )
    ) return '绑定已变化；未提交审批。'
    pending.state = 'submitted'
    let result: Record<string, unknown>
    try {
      result = object(await this.native?.answerApproval({ ...pending.native, decision }))
      if (pending.state === 'submitted' && result.status !== 'submitted') pending.state = 'expired'
    } catch {
      if (pending.state === 'submitted') pending.state = 'unknown'
      await this.update(pending)
      return '提交结果未知，请核对桌面原生审批；不会自动重复提交。'
    }
    await this.update(pending)
    const state = this.pending.get(String(pending.native.reference))?.state
    if (state === 'resolved') return '原生已确认处理此审批；未重复执行。'
    if (state === 'cancelled') return '原生请求已取消；未重复执行。'
    const cardFailed = pending.cards.some(card => card.failedState === state)
    return result.status === 'submitted'
      ? `决定已提交，等待原生确认；${cardFailed ? '原卡片更新失败，请以状态回执为准。' : '卡片会同步状态。'}`
      : '原生请求已失效；未重复批准。'
  }
  list(event: ChannelEventRef) {
    const rows = [...this.pending.values()].filter(item =>
      item.state === 'pending' && item.targets.some(target => same(target, event))
    )
    return rows.length
      ? rows.map(item => `${item.display.id} · ${item.display.chat} · ${item.display.reason}`).join('\n')
      : '当前会话没有待处理审批。'
  }
  /** A topic reply can materialize a snapshot of its root card. Replace the current state after that reply. */
  async synchronizeCard(event: ChannelEventRef, token: string, messageId: string) {
    const pending = [...this.pending.values()].find(item =>
      item.display.token === token && item.targets.some(target => same(target, event))
    )
    const card = pending?.cards.find(card => same(card.event, event) && card.messageId === messageId)
    if (!pending || !card || pending.state === 'pending' || this.disposed) return
    delete card.updatedState
    // A known failed state already emitted its fallback; this is not a network retry.
    await this.update(pending)
  }
  async expire() {
    for (const [id, value] of this.terminal) if (Date.now() - value.at > 20 * 60_000) this.terminal.delete(id)
    for (const [id, item] of this.pending) {
      if (item.state === 'pending' && item.expiresAt <= Date.now()) {
        item.state = 'expired'
        await this.update(item)
      }
      if (item.state !== 'pending' && Date.now() > item.expiresAt + 10 * 60_000) this.pending.delete(id)
    }
  }
  private async update(pending: Pending) {
    const task = pending.updates.then(async () => {
      if (this.disposed) return
      const display = { ...pending.display, state: pending.state }
      await Promise.all(
        pending.cards.map(async card => {
          if (card.updatedState === display.state || card.failedState === display.state) return
          try {
            await this.input.updateCard(card.event, card.messageId, channelApprovalCard(display))
            card.updatedState = display.state
            delete card.failedState
          } catch {
            card.failedState = display.state
            this.input.report?.('CHANNEL_APPROVAL_CARD_UPDATE_FAILED')
            const state = {
              pending: '等待批准',
              submitted: '决定已提交，等待原生确认',
              resolved: '原生已确认处理',
              cancelled: '原生请求已取消',
              expired: '审批已过期',
              unknown: '提交结果未知，请核对原生审批',
            }[display.state]
            try {
              await this.input.notify(
                card.event,
                `审批 ${display.id} · ${display.chat}：${state}。原卡片更新失败，请以此状态回执为准。`,
                `approval:${display.id}:card-update:${display.state}`,
              )
            } catch {
              this.input.report?.('CHANNEL_APPROVAL_NOTIFICATION_FAILED')
            }
          }
        }),
      )
    })
    pending.updates = task.catch(() => undefined)
    await task
  }
  dispose() {
    this.disposed = true
    this.unsubscribe?.()
    this.pending.clear()
    this.terminal.clear()
  }
}
