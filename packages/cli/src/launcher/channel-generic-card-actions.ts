import { createHash, randomBytes } from 'node:crypto'
import type { ChannelEventRef, ChannelTenantRef } from '@cordisx/channel-runtime'
import type { CardActionEvent } from '@larksuiteoapi/node-sdk'
import type { ChannelCardActionEventV1, ChannelCardActionResultV1 } from '@cordisx/protocol/channel-card-actions/v1'
import type { FeishuSdkChannel } from './feishu-channel-types.js'
import { ChannelMessageOperationLedger } from './channel-message-operation-ledger.js'
import { parseGenericCardAction, validateGenericCardReceipt } from './channel-generic-card-validation.js'
import { strictPlainCardBody } from './feishu-plain-card.js'

interface Registration {
  readonly owner: string
  readonly ref: ChannelEventRef
  readonly channel: FeishuSdkChannel
  readonly messageId: string
  readonly version: number
  readonly expires: number
  readonly nonce: string
  readonly actions: ReadonlySet<string>
  readonly operators?: ReadonlySet<string>
  readonly events: ChannelCardActionEventV1[]
  readonly seen: Set<string>
  published: boolean
  cardHash: string
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
    ? Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map((
        [key, entry],
      ) => [key, canonical(entry)]),
    )
    : value
const bodyHash = (body: string | undefined): string | undefined => {
  if (!body || Buffer.byteLength(body) > 30000) return undefined
  try {
    return digest(canonical(JSON.parse(body)))
  } catch {
    return undefined
  }
}
async function bounded<Result>(effect: Promise<Result>): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      effect,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('CHANNEL_OPERATION_TIMEOUT')), 10000)
        timer.unref()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
const registrationKey = (ref: ChannelTenantRef, conversationId: string, messageId: string) =>
  digest([ref.adapterId, ref.accountId, ref.tenantId, conversationId, messageId])

export class ChannelGenericCardActions {
  private readonly registrations = new Map<string, Registration>()
  private readonly accountEpochs = new Map<string, number>()
  private stopped = false

  private constructor(
    private readonly ledger: ChannelMessageOperationLedger<ChannelCardActionResultV1>,
    private readonly messageLedger: ChannelMessageOperationLedger<ChannelCardActionResultV1>,
    private readonly now: () => number,
  ) {}

  static async open(filename: string, now = Date.now): Promise<ChannelGenericCardActions> {
    const ledger = await ChannelMessageOperationLedger.openTyped(
      filename,
      validateGenericCardReceipt,
      (code, operationId): ChannelCardActionResultV1 => ({ status: 'unknown', code, operationId }),
      now,
    )
    const messages = await ChannelMessageOperationLedger.openTyped(
      `${filename}.messages`,
      validateGenericCardReceipt,
      (code, operationId): ChannelCardActionResultV1 => ({ status: 'unknown', code, operationId }),
      now,
    )
    return new ChannelGenericCardActions(ledger, messages, now)
  }

  async execute(operation: string, input: Record<string, unknown>, context: {
    readonly source?: ChannelEventRef | undefined
    readonly callerScope: string
    readonly authorize: (event: ChannelEventRef, write: boolean) => void
    readonly channel: (event: ChannelEventRef) => FeishuSdkChannel | undefined
    readonly active: () => boolean
    readonly ownsPlainCard: (event: ChannelEventRef, messageId: string) => boolean
  }): Promise<ChannelCardActionResultV1 | null> {
    const request = parseGenericCardAction(operation, input)
    const source = context.source
    if (
      request.operation === 'card-action-publish' && request.operatorIds
      && (!source?.actor?.userId || request.operatorIds.some(id => id !== source.actor?.userId))
    ) throw new Error('CHANNEL_OPERATOR_EVIDENCE_REQUIRED')
    if (
      source && (source.adapterId !== request.account.adapterId || source.accountId !== request.account.accountId
        || source.tenantId !== request.account.tenantId || source.conversationId !== request.conversationId
        || source.kind !== request.kind)
    ) throw new Error('CHANNEL_SOURCE_SCOPE_MISMATCH')
    const ref: ChannelEventRef = source
      ?? {
        ...request.account,
        conversationId: request.conversationId,
        kind: request.kind,
        threadId: request.conversationId,
        semantics: 'conversation',
        eventId: 'card-action',
      }
    const authorize = () => {
      context.authorize(ref, operation === 'card-action-publish')
      if (this.stopped || !context.active()) throw new Error('CHANNEL_GENERATION_CHANGED')
    }
    authorize()
    const owner = digest([context.callerScope, request.account, request.conversationId, request.kind])
    if (request.operation === 'card-action-receipt') {
      const receipt = await this.ledger.receipt(this.ledger.key(owner, request.operationId))
      authorize()
      return receipt
    }
    const key = registrationKey(ref, request.conversationId, request.messageId)
    let current = this.registrations.get(key)
    if (request.operation === 'card-action-read') {
      if (
        !current || current.owner !== owner || current.version !== request.version || !current.published
        || current.expires <= this.now() || context.channel(ref) !== current.channel
      ) return { status: 'unavailable', code: 'CHANNEL_ACTION_REGISTRATION_UNAVAILABLE' }
      const registration = current
      let offset = 0
      if (request.pageToken !== undefined) {
        const candidates = Array.from({ length: current.events.length + 1 }, (_, index) => index)
        const found = candidates.find(index =>
          digest([owner, key, registration.version, registration.nonce, index]) === request.pageToken
        )
        if (found === undefined) throw new Error('INVALID_PAGE_TOKEN')
        offset = found
      }
      const events = structuredClone(current.events.slice(offset, offset + (request.pageSize ?? 20)))
      const next = offset + events.length
      const hasMore = next < current.events.length
      return {
        status: 'ok',
        operation: 'card-action-read',
        messageId: current.messageId,
        version: current.version,
        expiresAt: new Date(current.expires).toISOString(),
        events,
        ...(hasMore
          ? { hasMore: true, pageToken: digest([owner, key, current.version, current.nonce, next]) }
          : { hasMore: false }),
      }
    }
    const channel = context.channel(ref)
    const accountKey = digest([ref.adapterId, ref.accountId, ref.tenantId])
    const epoch = this.accountEpochs.get(accountKey) ?? 0
    const client = channel?.rawClient
    if (!channel || !client) {
      return { status: 'unavailable', code: 'CHANNEL_OPERATION_UNAVAILABLE', operationId: request.operationId }
    }
    const guard = () => {
      authorize()
      if (context.channel(ref) !== channel || (this.accountEpochs.get(accountKey) ?? 0) !== epoch) {
        throw new Error('CHANNEL_GENERATION_CHANGED')
      }
    }
    const result = await this.ledger.execute(
      this.ledger.key(owner, request.operationId),
      request,
      request.operationId,
      async () => {
        const messageKey = this.messageLedger.key([
          request.account,
          request.conversationId,
          request.kind,
          request.messageId,
        ], String(request.expectedVersion + 1))
        guard()
        current = this.registrations.get(key)
        if (current && current.owner !== owner) {
          return { status: 'rejected', code: 'CHANNEL_ACTION_OWNER_MISMATCH', operationId: request.operationId }
        }
        if (request.expectedVersion !== (current?.version ?? 0)) {
          return { status: 'rejected', code: 'CHANNEL_ACTION_VERSION_CONFLICT', operationId: request.operationId }
        }
        if (!context.ownsPlainCard(ref, request.messageId)) {
          return { status: 'rejected', code: 'CHANNEL_CONTROL_CARD_DENIED', operationId: request.operationId }
        }
        if (!current && this.registrations.size >= 256) {
          return { status: 'rejected', code: 'CHANNEL_ACTION_CAPACITY', operationId: request.operationId }
        }
        const response = await bounded(
          client.im.v1.message.get({ path: { message_id: request.messageId }, params: { user_id_type: 'open_id' } }),
        )
        guard()
        const items = response.data?.items
        const message = Array.isArray(items) && items.length === 1 && items[0]?.message_id === request.messageId
          ? items[0]
          : undefined
        const sender = message?.sender
        const owned = sender?.sender_type === 'app' && ((sender.id_type === 'app_id' && sender.id === ref.accountId)
          || (sender.id_type === 'open_id' && sender.id === channel.botIdentity?.openId))
        if (
          response.code !== 0 || !message || message.chat_id !== request.conversationId || message.deleted
          || message.msg_type !== 'interactive' || !owned
        ) return { status: 'rejected', code: 'CHANNEL_MESSAGE_NOT_OWNED', operationId: request.operationId }
        if (
          current
            ? bodyHash(message.body?.content) !== current.cardHash
            : !strictPlainCardBody(message.body?.content)
        ) {
          return { status: 'rejected', code: 'CHANNEL_CONTROL_CARD_DENIED', operationId: request.operationId }
        }
        try {
          return await this.messageLedger.execute(messageKey, [owner, request], request.operationId, async () => {
            const registration: Registration = {
              owner,
              ref,
              channel,
              messageId: request.messageId,
              version: request.expectedVersion + 1,
              expires: this.now() + request.expiresInSeconds * 1000,
              nonce: randomBytes(24).toString('hex'),
              actions: new Set(request.actions.map(action => action.id)),
              ...(request.operatorIds ? { operators: new Set(request.operatorIds) } : {}),
              events: [],
              seen: new Set(),
              published: false,
              cardHash: '',
            }
            const card = {
              config: { wide_screen_mode: true },
              header: { title: { tag: 'plain_text', content: request.title } },
              elements: [{ tag: 'div', text: { tag: 'plain_text', content: request.body } }, {
                tag: 'action',
                actions: request.actions.map(action => ({
                  tag: 'button',
                  text: { tag: 'plain_text', content: action.label },
                  type: 'default',
                  value: {
                    channelGenericAction: registration.nonce,
                    version: registration.version,
                    actionId: action.id,
                  },
                })),
              }],
            }
            guard()
            registration.cardHash = digest(canonical(card))
            this.registrations.set(key, registration)
            try {
              const patched = await bounded(
                client.im.v1.message.patch({
                  path: { message_id: request.messageId },
                  data: { content: JSON.stringify(card) },
                }),
              )
              guard()
              if (patched.code !== 0) {
                this.registrations.delete(key)
                return Number.isSafeInteger(patched.code)
                  ? { status: 'failed', code: 'CHANNEL_ACTION_PUBLISH_FAILED', operationId: request.operationId }
                  : { status: 'unknown', code: 'CHANNEL_ACTION_PUBLISH_UNCERTAIN', operationId: request.operationId }
              }
              registration.published = true
              return {
                status: 'ok',
                operation: 'card-action-publish',
                operationId: request.operationId,
                messageId: request.messageId,
                version: registration.version,
                expiresAt: new Date(registration.expires).toISOString(),
              }
            } catch {
              this.registrations.delete(key)
              return { status: 'unknown', code: 'CHANNEL_ACTION_PUBLISH_UNCERTAIN', operationId: request.operationId }
            }
          })
        } catch (error) {
          if ((error as Error).message === 'CHANNEL_IDEMPOTENCY_CONFLICT') {
            return { status: 'rejected', code: 'CHANNEL_ACTION_MESSAGE_RESERVED', operationId: request.operationId }
          }
          throw error
        }
      },
    )
    authorize()
    return result
  }

  observe(ref: ChannelTenantRef, event: CardActionEvent, channel: FeishuSdkChannel | undefined): boolean {
    const value = event.action.value as Record<string, unknown> | undefined
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'channelGenericAction')) return false
    if (this.stopped || !channel) return true
    const registration = this.registrations.get(registrationKey(ref, event.chatId, event.messageId))
    const operatorId = event.operator.openId
    if (
      !registration || registration.channel !== channel || registration.expires <= this.now() || !value
      || value.channelGenericAction !== registration.nonce || value.version !== registration.version
      || typeof value.actionId !== 'string' || !registration.actions.has(value.actionId)
      || !/^ou_[A-Za-z0-9_]{1,125}$/u.test(operatorId)
      || registration.operators && !registration.operators.has(operatorId)
    ) return true
    const dedup = digest([operatorId, value.actionId, registration.version])
    if (registration.seen.has(dedup) || registration.events.length >= 128) return true
    registration.seen.add(dedup)
    registration.events.push({
      eventId: randomBytes(16).toString('hex'),
      messageId: event.messageId,
      version: registration.version,
      actionId: value.actionId,
      operatorId,
      receivedAt: new Date(this.now()).toISOString(),
    })
    return true
  }

  dispose(): void {
    this.stopped = true
    this.registrations.clear()
    this.accountEpochs.clear()
  }

  invalidate(ref: ChannelTenantRef): void {
    const key = digest([ref.adapterId, ref.accountId, ref.tenantId])
    this.accountEpochs.set(key, (this.accountEpochs.get(key) ?? 0) + 1)
    for (const [id, registration] of this.registrations) {
      if (
        registration.ref.adapterId === ref.adapterId && registration.ref.accountId === ref.accountId
        && registration.ref.tenantId === ref.tenantId
      ) this.registrations.delete(id)
    }
  }
}
