import { describe, expect, it, vi } from 'vitest'
import { ChannelAdminPairing } from '../packages/cli/src/launcher/channel-admin-pairing.js'
import {
  channelAdminPairingOperation,
  receiveAdminPairing,
} from '../packages/cli/src/launcher/channel-admin-pairing-rpc.js'
import { parseChannelConversationPolicy } from '../packages/cli/src/launcher/channel-conversation-policy.js'

const account = { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'tenant_a' }
const now = 1_000_000
const fixture = () => {
  let revision = 0, policy = parseChannelConversationPolicy({ enabled: true })
  const consumer = {
    policy: () => ({ revision, policy }),
    policySet: vi.fn(async (next, expected) => {
      if (expected !== revision) throw new Error('REVISION_CONFLICT')
      policy = parseChannelConversationPolicy(next)
      return { policy, revision: ++revision }
    }),
  }
  const pairing = new ChannelAdminPairing(() => now)
  const guided = new Set<string>()
  const guidance = {
    reserve: async (_account: unknown, conversation: string) => {
      if (guided.has(conversation)) return false
      guided.add(conversation)
      return true
    },
  }
  const access = { generation: 'generation', accounts: () => [{ ref: account, state: 'ready' }] }
  const op = (operation: string, value: unknown, metadata?: unknown) =>
    channelAdminPairingOperation({
      operation,
      value,
      metadata,
      access: access as never,
      consumer: consumer as never,
      pairing,
    }) as Promise<any>
  const message = (code: string) => ({
    chatType: 'p2p',
    chatId: 'oc_direct',
    senderId: 'ou_user',
    messageId: 'om_test',
    createTime: now,
    content: `/pair ${code}`,
    raw: { sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user', tenant_key: 'tenant_a' } },
  })
  return { op, consumer, access, pairing, guidance, message, policy: () => policy }
}

describe('local pairing and SDK ingress', () => {
  it('gives an addressed group at most one policy-authorized hint and never accepts a group pairing', async () => {
    const f = fixture(), message = { ...f.message('AAAAAAAAAAAAAAAAAAAAAA'), chatType: 'group', mentionedBot: true }
    expect(
      await receiveAdminPairing(f.pairing, f.guidance, f.consumer as never, account, 'generation', message as never),
    )
      .toEqual({ accepted: false, reply: true })
    expect(
      await receiveAdminPairing(f.pairing, f.guidance, f.consumer as never, account, 'generation', message as never),
    )
      .toEqual({ accepted: false, reply: false })
    expect(
      await receiveAdminPairing(f.pairing, f.guidance, f.consumer as never, account, 'generation', {
        ...message,
        chatId: 'oc_another',
        mentionedBot: false,
      } as never),
    ).toEqual({ accepted: false, reply: false })
  })

  it('does not send group guidance for a denied or external sender', async () => {
    const f = fixture(), message = { ...f.message('AAAAAAAAAAAAAAAAAAAAAA'), chatType: 'group', mentionedBot: true }
    await f.consumer.policySet({
      enabled: true,
      rules: [{
        id: 'no-send',
        action: 'send',
        effect: 'deny',
        conversationId: 'oc_direct',
      }],
    }, 0)
    expect(
      await receiveAdminPairing(f.pairing, f.guidance, f.consumer as never, account, 'generation', message as never),
    )
      .toEqual({ accepted: false, reply: false })
    message.raw.sender.tenant_key = 'another_tenant'
    expect(
      await receiveAdminPairing(f.pairing, f.guidance, f.consumer as never, account, 'generation', message as never),
    )
      .toEqual({ accepted: false, reply: false })
  })

  it('rechecks send policy after reserving a group hint', async () => {
    const f = fixture(), message = { ...f.message('AAAAAAAAAAAAAAAAAAAAAA'), chatType: 'group', mentionedBot: true }
    let release!: () => void
    const guidance = {
      reserve: () =>
        new Promise<boolean>(resolve => {
          release = () => resolve(true)
        }),
    }
    const result = receiveAdminPairing(
      f.pairing,
      guidance,
      f.consumer as never,
      account,
      'generation',
      message as never,
    )
    await f.consumer.policySet({ enabled: true, rules: [{ id: 'deny', action: 'send', effect: 'deny' }] }, 0)
    release()
    expect(await result).toEqual({ accepted: false, reply: false })
  })
  it('requires local confirmation and grants only direct scoped management, not dispatch', async () => {
    const f = fixture(), start = await f.op('admin-pair-begin', { account })
    const received = await receiveAdminPairing(
      f.pairing,
      f.guidance,
      f.consumer as never,
      account,
      'generation',
      f.message(start.code) as never,
    )
    expect(received).toEqual({ accepted: true, reply: true })
    expect(f.consumer.policySet).not.toHaveBeenCalled()
    const status = await f.op('admin-pair-status', { pairingId: start.pairingId })
    expect(status).toMatchObject({
      state: 'confirmation-required',
      candidate: { userId: 'ou_user', conversationId: 'oc_direct' },
      taskDispatchGrant: false,
      commandPermissions: expect.arrayContaining(['bind', 'allow-user']),
    })
    expect(JSON.stringify(status)).not.toContain(start.code)
    expect(await f.op('admin-pair-confirm', { pairingId: start.pairingId }, { 'cordisx/channelContext': 'remote' }))
      .toMatchObject({ status: 'rejected', code: 'LOCAL_USER_REQUIRED' })
    expect(await f.op('admin-pair-confirm', { pairingId: start.pairingId })).toMatchObject({
      status: 'ok',
      state: 'paired',
    })
    expect(f.policy().rules).toEqual([expect.objectContaining({
      ...account,
      conversationId: 'oc_direct',
      action: 'command',
      effect: 'allow',
      kinds: ['direct'],
      userIds: ['ou_user'],
    })])
    expect(f.policy().rules.some(rule => rule.action === 'dispatch')).toBe(false)
    expect(await f.op('admin-pair-confirm', { pairingId: start.pairingId })).toMatchObject({ status: 'rejected' })
  })

  it('rejects external senders and stale policy revisions without changing policy', async () => {
    const f = fixture(), start = await f.op('admin-pair-begin', { account })
    const message = f.message(start.code)
    message.raw.sender.tenant_key = 'other'
    expect(
      await receiveAdminPairing(f.pairing, f.guidance, f.consumer as never, account, 'generation', message as never),
    ).toEqual({
      accepted: false,
      reply: false,
    })
    expect((await f.op('admin-pair-status', { pairingId: start.pairingId })).state).toBe('waiting')
    message.raw.sender.tenant_key = account.tenantId
    expect(
      (await receiveAdminPairing(f.pairing, f.guidance, f.consumer as never, account, 'generation', message as never))
        .accepted,
    ).toBe(
      true,
    )
    await f.consumer.policySet({ ...f.policy(), autoReply: true }, 0)
    expect(await f.op('admin-pair-confirm', { pairingId: start.pairingId })).toMatchObject({
      status: 'rejected',
      code: 'REVISION_CONFLICT',
    })
    expect(f.policy().rules).toEqual([])
  })

  it('cannot confirm after the service generation changes or the account becomes unavailable', async () => {
    const f = fixture(), start = await f.op('admin-pair-begin', { account })
    expect(
      (await receiveAdminPairing(
        f.pairing,
        f.guidance,
        f.consumer as never,
        account,
        'generation',
        f.message(start.code) as never,
      ))
        .accepted,
    )
      .toBe(true)
    f.access.generation = 'replacement'
    expect(await f.op('admin-pair-confirm', { pairingId: start.pairingId }))
      .toMatchObject({ status: 'rejected', code: 'PAIRING_UNAVAILABLE' })
    expect(f.policy().rules).toEqual([])
  })
})
