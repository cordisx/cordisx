import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type { CardActionEvent } from '@larksuiteoapi/node-sdk'
import type { ChannelCardActionResultV1 } from '@cordisx/protocol/channel-card-actions/v1'
import type { FeishuSdkChannel } from '../packages/cli/src/launcher/feishu-channel-types.js'
import { ChannelGenericCardActions } from '../packages/cli/src/launcher/channel-generic-card-actions.js'
import { parseGenericCardAction } from '../packages/cli/src/launcher/channel-generic-card-validation.js'

const account = { adapterId: 'feishu', accountId: 'app', tenantId: 'tenant' }
const target = { account, conversationId: 'oc_chat', kind: 'direct' }
const source: ChannelEventRef = {
  ...account,
  conversationId: 'oc_chat',
  kind: 'direct',
  threadId: 'oc_chat',
  semantics: 'conversation',
  eventId: 'incoming',
  actor: { ...account, userId: 'ou_owner' },
}
const publish = {
  ...target,
  operationId: 'publish',
  messageId: 'om_notice',
  expectedVersion: 0,
  template: 'action-notice',
  title: 'Review',
  body: 'Choose',
  actions: [{ id: 'review', label: 'Review' }],
  expiresInSeconds: 60,
}

const readEvents = (result: ChannelCardActionResultV1 | null) => {
  if (!result || result.status !== 'ok' || result.operation !== 'card-action-read') {
    throw new Error('EXPECTED_ACTION_PAGE')
  }
  return result.events
}

async function fixture() {
  const filename = path.join(await mkdtemp(path.join(os.tmpdir(), 'generic-card-')), 'ledger.json')
  let now = 1000
  const service = await ChannelGenericCardActions.open(filename, () => now)
  let body = JSON.stringify({
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: 'Notice' } },
    elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'Original' } }],
  })
  const get = vi.fn(async () => ({
    code: 0,
    data: {
      items: [{
        message_id: 'om_notice',
        chat_id: 'oc_chat',
        msg_type: 'interactive',
        sender: { sender_type: 'app', id_type: 'app_id', id: 'app' },
        body: {
          content: body,
        },
      }],
    },
  }))
  const patch = vi.fn(async (input: { data: { content: string } }) => {
    body = input.data.content
    return { code: 0 }
  })
  const channel = { rawClient: { im: { v1: { message: { get, patch } } } } } as unknown as FeishuSdkChannel
  const context = {
    source,
    callerScope: 'owner',
    authorize: vi.fn(),
    channel: () => channel,
    active: () => true,
    ownsPlainCard: () => true,
  }
  const click = (operatorId = 'ou_owner', overrides = {}) => {
    const input = patch.mock.calls.at(-1)?.[0] as unknown as { data: { content: string } }
    const value = JSON.parse(input.data.content).elements[1].actions[0].value
    service.observe(
      account,
      {
        chatId: 'oc_chat',
        messageId: 'om_notice',
        operator: { openId: operatorId },
        action: { value: { ...value, ...overrides } },
      } as CardActionEvent,
      channel,
    )
  }
  const read = () => service.execute('card-action-read', { ...target, messageId: 'om_notice', version: 1 }, context)
  return {
    filename,
    service,
    get,
    patch,
    channel,
    context,
    click,
    read,
    advance: () => {
      now += 61000
    },
  }
}

describe('bounded generic card actions', () => {
  it('consumes the generic callback namespace even when forged, never falling through to specialized approval routing', async () => {
    const fixture_ = await fixture()
    const base = { chatId: 'oc_chat', messageId: 'om_notice', operator: { openId: 'ou_owner' } }
    expect(
      fixture_.service.observe(
        account,
        { ...base, action: { value: { channelGenericAction: 'forged', channelApproval: 'forged' } } } as never,
        fixture_.channel,
      ),
    ).toBe(true)
    expect(
      fixture_.service.observe(
        account,
        { ...base, action: { value: { channelApproval: 'existing-specialized' } } } as never,
        fixture_.channel,
      ),
    ).toBe(false)
    expect(await fixture_.read()).toMatchObject({ status: 'unavailable' })
  })
  it('keeps a timed-out message version reserved while its old patch is still settling', async () => {
    const fixture_ = await fixture()
    let settle: (() => void) | undefined
    fixture_.patch.mockImplementation(() =>
      new Promise(resolve => {
        settle = () => resolve({ code: 0 })
      })
    )
    vi.useFakeTimers()
    try {
      const publication = fixture_.service.execute('card-action-publish', publish, fixture_.context)
      await vi.waitFor(() => expect(fixture_.patch).toHaveBeenCalledTimes(1))
      await vi.advanceTimersByTimeAsync(10000)
      expect(await publication).toMatchObject({ status: 'unknown' })
      expect(
        await fixture_.service.execute(
          'card-action-publish',
          { ...publish, operationId: 'after-timeout' },
          fixture_.context,
        ),
      ).toMatchObject({ status: 'rejected', code: 'CHANNEL_ACTION_MESSAGE_RESERVED' })
      settle?.()
      await Promise.resolve()
      expect(await fixture_.read()).toMatchObject({ status: 'unavailable' })
      expect(fixture_.patch).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
  it('serializes different operationIds against one message version and preserves unknown fences across reopen', async () => {
    const fixture_ = await fixture()
    const results = await Promise.all([
      fixture_.service.execute('card-action-publish', publish, fixture_.context),
      fixture_.service.execute('card-action-publish', { ...publish, operationId: 'concurrent' }, fixture_.context),
    ])
    expect(results[0]).toMatchObject({ status: 'ok' })
    expect(results[1]).toMatchObject({ status: 'rejected', code: 'CHANNEL_ACTION_VERSION_CONFLICT' })
    expect(fixture_.patch).toHaveBeenCalledTimes(1)
    const uncertain = await fixture()
    uncertain.patch.mockRejectedValue(new Error('uncertain transport'))
    expect(await uncertain.service.execute('card-action-publish', publish, uncertain.context)).toMatchObject({
      status: 'unknown',
    })
    const reopened = await ChannelGenericCardActions.open(uncertain.filename)
    expect(
      await reopened.execute('card-action-publish', { ...publish, operationId: 'new-operation' }, uncertain.context),
    ).toMatchObject({ status: 'rejected', code: 'CHANNEL_ACTION_MESSAGE_RESERVED' })
    expect(uncertain.patch).toHaveBeenCalledTimes(1)
  })

  it('buffers pre-ack callbacks privately and discloses them only after verified publication success', async () => {
    const fixture_ = await fixture()
    fixture_.patch.mockImplementation(async input => {
      const value = JSON.parse(input.data.content).elements[1].actions[0].value
      fixture_.service.observe(
        account,
        { chatId: 'oc_chat', messageId: 'om_notice', operator: { openId: 'ou_owner' }, action: { value } } as never,
        fixture_.channel,
      )
      expect(await fixture_.read()).toMatchObject({ status: 'unavailable' })
      return { code: 0 }
    })
    await fixture_.service.execute('card-action-publish', publish, fixture_.context)
    expect(readEvents(await fixture_.read())).toHaveLength(1)
  })

  it('classifies malformed patch acknowledgments as unknown without exposing buffered events', async () => {
    const fixture_ = await fixture()
    fixture_.patch.mockResolvedValue({} as never)
    expect(await fixture_.service.execute('card-action-publish', publish, fixture_.context)).toMatchObject({
      status: 'unknown',
    })
    expect(await fixture_.read()).toMatchObject({ status: 'unavailable' })
    expect(
      await fixture_.service.execute(
        'card-action-publish',
        { ...publish, operationId: 'new-operation' },
        fixture_.context,
      ),
    ).toMatchObject({ status: 'rejected', code: 'CHANNEL_ACTION_MESSAGE_RESERVED' })
    expect(fixture_.patch).toHaveBeenCalledTimes(1)
  })

  it('rejects duplicate native message rows and nested action fields in an allegedly plain notice', async () => {
    const fixture_ = await fixture()
    const response = await fixture_.get()
    response.data.items.push(response.data.items[0]!)
    fixture_.get.mockResolvedValue(response)
    expect(await fixture_.service.execute('card-action-publish', publish, fixture_.context)).toMatchObject({
      status: 'rejected',
      code: 'CHANNEL_MESSAGE_NOT_OWNED',
    })
    const malicious = await fixture()
    const message = await malicious.get()
    message.data.items[0]!.body.content = JSON.stringify({
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'Notice' } },
      elements: [{
        tag: 'div',
        text: { tag: 'plain_text', content: 'Notice' },
        actions: [{ value: { channelApproval: 'forged' } }],
      }],
    })
    malicious.get.mockResolvedValue(message)
    expect(await malicious.service.execute('card-action-publish', publish, malicious.context)).toMatchObject({
      status: 'rejected',
      code: 'CHANNEL_CONTROL_CARD_DENIED',
    })
    expect(malicious.patch).not.toHaveBeenCalled()
  })

  it('requires exact current action body before replacement and retires prior-version callbacks', async () => {
    const fixture_ = await fixture()
    await fixture_.service.execute('card-action-publish', publish, fixture_.context)
    const oldValue = JSON.parse(fixture_.patch.mock.calls[0]![0].data.content).elements[1].actions[0].value
    const replacement = { ...publish, expectedVersion: 1, operationId: 'version-two', body: 'New notice' }
    expect(await fixture_.service.execute('card-action-publish', replacement, fixture_.context)).toMatchObject({
      status: 'ok',
      version: 2,
    })
    fixture_.service.observe(
      account,
      {
        chatId: 'oc_chat',
        messageId: 'om_notice',
        operator: { openId: 'ou_owner' },
        action: { value: oldValue },
      } as never,
      fixture_.channel,
    )
    fixture_.click()
    expect(await fixture_.read()).toMatchObject({ status: 'unavailable' })
    expect(
      readEvents(
        await fixture_.service.execute(
          'card-action-read',
          { ...target, messageId: 'om_notice', version: 2 },
          fixture_.context,
        ),
      ),
    ).toHaveLength(1)
    const response = await fixture_.get()
    response.data.items[0]!.body.content = JSON.stringify({
      elements: [{ tag: 'action', actions: [{ value: { channelApproval: 'forged' } }] }],
    })
    fixture_.get.mockResolvedValue(response)
    expect(
      await fixture_.service.execute('card-action-publish', {
        ...publish,
        expectedVersion: 2,
        operationId: 'external-body',
      }, fixture_.context),
    ).toMatchObject({ status: 'rejected', code: 'CHANNEL_CONTROL_CARD_DENIED' })
    expect(fixture_.patch).toHaveBeenCalledTimes(2)
  })
  it('retires same-object reconnect callbacks and fences in-flight publication by account epoch', async () => {
    const fixture_ = await fixture()
    fixture_.patch.mockImplementation(async () => {
      fixture_.service.invalidate(account)
      return { code: 0 }
    })
    expect(await fixture_.service.execute('card-action-publish', publish, fixture_.context)).toMatchObject({
      status: 'unknown',
    })
    expect(await fixture_.read()).toMatchObject({ status: 'unavailable' })
    expect(await fixture_.service.execute('card-action-publish', publish, fixture_.context)).toMatchObject({
      status: 'unknown',
    })
    expect(fixture_.patch).toHaveBeenCalledTimes(1)
  })

  it('invalidates successful registrations on account retirement even if the SDK object is reused', async () => {
    const fixture_ = await fixture()
    await fixture_.service.execute('card-action-publish', publish, fixture_.context)
    fixture_.service.invalidate(account)
    fixture_.click()
    expect(await fixture_.read()).toMatchObject({ status: 'unavailable' })
  })
  it('publishes explicitly and reads only normalized owned events without callback secrets', async () => {
    const fixture_ = await fixture()
    const result = await fixture_.service.execute('card-action-publish', publish, fixture_.context)
    expect(result).toMatchObject({ status: 'ok', operation: 'card-action-publish', version: 1 })
    fixture_.click()
    fixture_.click()
    const page = await fixture_.read()
    expect(page).toMatchObject({
      status: 'ok',
      operation: 'card-action-read',
      hasMore: false,
      events: [{ operatorId: 'ou_owner', actionId: 'review', version: 1 }],
    })
    expect(JSON.stringify(page)).not.toContain('channelGenericAction')
    expect(JSON.stringify(page)).not.toContain('nonce')
    expect(readEvents(page)).toHaveLength(1)
    expect(
      await fixture_.service.execute('card-action-read', { ...target, messageId: 'om_notice', version: 1 }, {
        ...fixture_.context,
        callerScope: 'other',
      }),
    ).toMatchObject({ status: 'unavailable' })
  })

  it('deduplicates publication durably and refuses changed descriptors or unknown replay after restart', async () => {
    const fixture_ = await fixture()
    fixture_.patch.mockRejectedValue(new Error('transport secret'))
    expect(await fixture_.service.execute('card-action-publish', publish, fixture_.context)).toMatchObject({
      status: 'unknown',
    })
    const reopened = await ChannelGenericCardActions.open(fixture_.filename)
    expect(await reopened.execute('card-action-publish', publish, fixture_.context)).toMatchObject({
      status: 'unknown',
    })
    expect(fixture_.patch).toHaveBeenCalledTimes(1)
    await expect(reopened.execute('card-action-publish', { ...publish, body: 'Different' }, fixture_.context)).rejects
      .toThrow('CHANNEL_IDEMPOTENCY_CONFLICT')
    expect(await readFile(fixture_.filename, 'utf8')).not.toContain('transport secret')
  })

  it('keeps successful publication receipts after restart without inventing durable action history', async () => {
    const fixture_ = await fixture()
    await fixture_.service.execute('card-action-publish', publish, fixture_.context)
    const reopened = await ChannelGenericCardActions.open(fixture_.filename)
    expect(await reopened.execute('card-action-receipt', { ...target, operationId: 'publish' }, fixture_.context))
      .toMatchObject({ status: 'ok', version: 1 })
    expect(
      await reopened.execute('card-action-read', { ...target, messageId: 'om_notice', version: 1 }, fixture_.context),
    ).toMatchObject({ status: 'unavailable' })
    expect(await reopened.execute('card-action-receipt', { ...target, operationId: 'missing' }, fixture_.context))
      .toBeNull()
  })

  it('rejects forged source, absent plain-card ownership and stale versions before patch', async () => {
    const fixture_ = await fixture()
    await expect(
      fixture_.service.execute('card-action-publish', { ...publish, conversationId: 'oc_other' }, fixture_.context),
    ).rejects.toThrow('CHANNEL_SOURCE_SCOPE_MISMATCH')
    expect(
      await fixture_.service.execute('card-action-publish', publish, {
        ...fixture_.context,
        ownsPlainCard: () => false,
      }),
    ).toMatchObject({ status: 'rejected', code: 'CHANNEL_CONTROL_CARD_DENIED' })
    expect(fixture_.patch).not.toHaveBeenCalled()
    expect(
      await fixture_.service.execute('card-action-publish', {
        ...publish,
        operationId: 'wrong-version',
        expectedVersion: 2,
      }, fixture_.context),
    ).toMatchObject({ status: 'rejected', code: 'CHANNEL_ACTION_VERSION_CONFLICT' })
  })

  it('does not convert an existing control card merely because a caller claims plain ownership', async () => {
    const fixture_ = await fixture()
    const response = await fixture_.get()
    response.data.items[0]!.body.content = JSON.stringify({ elements: [{ tag: 'action' }] })
    fixture_.get.mockResolvedValue(response)
    expect(await fixture_.service.execute('card-action-publish', publish, fixture_.context)).toMatchObject({
      status: 'rejected',
      code: 'CHANNEL_CONTROL_CARD_DENIED',
    })
    expect(fixture_.patch).not.toHaveBeenCalled()
  })

  it('accepts only verified selected operators, matching nonce/version/channel and unexpired lifetime', async () => {
    const fixture_ = await fixture()
    await expect(
      fixture_.service.execute('card-action-publish', { ...publish, operatorIds: ['ou_other'] }, fixture_.context),
    ).rejects.toThrow('CHANNEL_OPERATOR_EVIDENCE_REQUIRED')
    await fixture_.service.execute('card-action-publish', { ...publish, operatorIds: ['ou_owner'] }, fixture_.context)
    fixture_.click('ou_other')
    fixture_.click('ou_owner', { version: 999 })
    fixture_.click('ou_owner', { channelGenericAction: 'forged' })
    expect(await fixture_.read()).toMatchObject({ events: [] })
    fixture_.click()
    fixture_.advance()
    expect(await fixture_.read()).toMatchObject({ status: 'unavailable' })
    fixture_.service.dispose()
    await expect(fixture_.read()).rejects.toThrow('CHANNEL_GENERATION_CHANGED')
  })

  it('binds opaque pagination to the owner/version and caps normalized observations', async () => {
    const fixture_ = await fixture()
    await fixture_.service.execute('card-action-publish', publish, fixture_.context)
    for (let index = 0; index < 140; index++) fixture_.click(`ou_operator_${index}`)
    const page = await fixture_.service.execute('card-action-read', {
      ...target,
      messageId: 'om_notice',
      version: 1,
      pageSize: 50,
    }, fixture_.context)
    expect(page).toMatchObject({ hasMore: true })
    expect(readEvents(page)).toHaveLength(50)
    await expect(
      fixture_.service.execute('card-action-read', {
        ...target,
        messageId: 'om_notice',
        version: 1,
        pageToken: 'forged',
      }, fixture_.context),
    ).rejects.toThrow('INVALID_PAGE_TOKEN')
    const second = await fixture_.service.execute('card-action-read', {
      ...target,
      messageId: 'om_notice',
      version: 1,
      pageSize: 50,
      pageToken: (page as { pageToken: string }).pageToken,
    }, fixture_.context)
    expect(readEvents(second)).toHaveLength(50)
  })

  it('strictly rejects duplicate actions, raw commands, invalid bounds and extra read fields', () => {
    for (
      const input of [
        { ...publish, callback: 'secret' },
        { ...publish, actions: [...publish.actions, ...publish.actions] },
        { ...publish, actions: [{ id: 'review', label: 'Review', command: 'dispatch' }] },
        { ...publish, expiresInSeconds: 3601 },
      ]
    ) expect(() => parseGenericCardAction('card-action-publish', input)).toThrow()
    expect(() =>
      parseGenericCardAction('card-action-read', {
        ...target,
        messageId: 'om_notice',
        version: 1,
        operationId: 'forged',
      })
    ).toThrow()
  })
})
