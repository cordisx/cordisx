import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import type { FeishuSdkChannel } from './feishu-adapter.js'
import type { ChannelForwardRequestV1 } from '@cordisx/protocol/channel-forward/v1'
import { createChannelForwardService } from './channel-forward-service.js'

const request: ChannelForwardRequestV1 = {
  contract: 'cordisx.channel-forward/v1',
  schemaVersion: 1,
  operation: 'forward',
  operationId: 'one',
  source: { adapterId: 'feishu', accountId: 'bot', tenantId: 'tenant', conversationId: 'oc_source', kind: 'group' },
  target: { adapterId: 'feishu', accountId: 'bot', tenantId: 'tenant', conversationId: 'oc_target', kind: 'group' },
  messageIds: ['om_one'],
}
it('does not mutate after permission revocation during source read', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'forward-service-'))
  let allowed = true
  const forward = vi.fn(async () => ({ code: 0, data: { message_id: 'om_result' } }))
  const get = vi.fn(async () => {
    allowed = false
    return { code: 0, data: { items: [{ message_id: 'om_one', chat_id: 'oc_source' }] } }
  })
  const channel = { rawClient: { im: { v1: { message: { get, forward } } } } } as unknown as FeishuSdkChannel
  const service = createChannelForwardService({
    filename: path.join(directory, 'ledger.json'),
    channel: () => channel,
    active: () => true,
    supported: () => true,
  })
  const receipt = await service(request, 'caller', false, () => {
    if (!allowed) throw new Error('DENIED')
  })
  expect(receipt).toMatchObject({ state: 'failed', code: 'FORWARD_PERMISSION_REVOKED' })
  expect(forward).not.toHaveBeenCalled()
  await expect(service(request, 'caller', true, () => {
    throw new Error('DENIED')
  })).rejects.toThrow('DENIED')
})
