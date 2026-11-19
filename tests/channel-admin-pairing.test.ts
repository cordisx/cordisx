import { describe, expect, it } from 'vitest'
import { ChannelAdminPairing } from '../packages/cli/src/launcher/channel-admin-pairing.js'

const account = { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'tenant_a' }
const request = (code: string) => ({
  account,
  generation: 'generation-a',
  code,
  chatType: 'p2p',
  conversationId: 'oc_direct',
  senderId: 'ou_user',
  senderTenant: 'tenant_a',
  senderType: 'user',
  eventTime: 1_000_000,
})

describe('explicit Channel administrator pairing', () => {
  it('requires a local confirmation and consumes a scoped request exactly once', () => {
    const pairing = new ChannelAdminPairing(() => 1_000_000)
    const start = pairing.begin(account, 'generation-a', 3)
    expect(pairing.inspect(start.pairingId).state).toBe('waiting')
    expect(pairing.receive(request(start.code))).toBe(true)
    expect(pairing.receive(request(start.code))).toBe(false)
    expect(pairing.inspect(start.pairingId)).toMatchObject({
      state: 'confirmation-required',
      candidate: { conversationId: 'oc_direct', userId: 'ou_user' },
    })
    expect(JSON.stringify(pairing.inspect(start.pairingId))).not.toContain(start.code)
    expect(() => pairing.take(start.pairingId, 'generation-b')).toThrow('PAIRING_UNAVAILABLE')
    expect(pairing.take(start.pairingId, 'generation-a')).toEqual({
      account,
      candidate: { conversationId: 'oc_direct', userId: 'ou_user' },
      policyRevision: 3,
    })
    expect(() => pairing.take(start.pairingId, 'generation-a')).toThrow('PAIRING_UNAVAILABLE')
  })

  it('rejects group, cross-tenant, wrong app, stale, wrong-generation and bot requests', () => {
    const pairing = new ChannelAdminPairing(() => 1_000_000)
    const start = pairing.begin(account, 'generation-a', 0), valid = request(start.code)
    for (
      const change of [
        { chatType: 'group' },
        { senderTenant: 'other' },
        { senderType: 'app' },
        { senderId: '' },
        { account: { ...account, accountId: 'cli_other' } },
        { generation: 'generation-b' },
        { eventTime: 1 },
        { code: 'aaaaaaaaaaaaaaaaaaaaaa' },
      ]
    ) expect(pairing.receive({ ...valid, ...change })).toBe(false)
    expect(pairing.inspect(start.pairingId).state).toBe('waiting')
    expect(pairing.receive(valid)).toBe(true)
  })

  it('expires, revokes and replaces pending challenges without recording their codes', () => {
    let now = 1_000_000
    const pairing = new ChannelAdminPairing(() => now)
    const first = pairing.begin(account, 'generation-a', 0)
    const second = pairing.begin(account, 'generation-a', 0)
    expect(() => pairing.inspect(first.pairingId)).toThrow('PAIRING_UNAVAILABLE')
    expect(pairing.receive(request(first.code))).toBe(false)
    expect(pairing.cancel(second.pairingId)).toBe(true)
    const third = pairing.begin(account, 'generation-a', 0)
    now += 5 * 60_000
    expect(pairing.receive(request(third.code))).toBe(false)
    expect(() => pairing.inspect(third.pairingId)).toThrow('PAIRING_UNAVAILABLE')
  })
})
