import { expect, it } from 'vitest'
import { confirmedGroupDeliveryText } from '../packages/channel-runtime/src/consumer-readback.js'
import type { ChannelStoreState } from '../packages/channel-runtime/src/store.js'

it('reads only a confirmed delivery owned by the caller and addressed to the exact group', () => {
  const caller = { pluginId: 'consumer', generation: '1' } as never
  const target = {
    adapterId: 'adapter',
    accountId: 'account',
    tenantId: 'tenant',
    conversationId: 'group',
    kind: 'group' as const,
  }
  const record = {
    caller,
    target,
    status: 'sent',
    externalMessageId: 'confirmed',
    text: 'synthetic reply',
    attempts: 1,
  }
  const state = { outbox: { receipt: record } } as unknown as ChannelStoreState
  expect(confirmedGroupDeliveryText(state, 'receipt', caller, target)).toBe('synthetic reply')
  expect(confirmedGroupDeliveryText(state, 'receipt', { pluginId: 'other' } as never, target)).toBeUndefined()
  expect(confirmedGroupDeliveryText(state, 'receipt', caller, { ...target, conversationId: 'other' })).toBeUndefined()
  expect(confirmedGroupDeliveryText(state, 'receipt', caller, { ...target, tenantId: 'other' })).toBeUndefined()
  record.status = 'unknown'
  expect(confirmedGroupDeliveryText(state, 'receipt', caller, target)).toBeUndefined()
  record.status = 'sent'
  record.externalMessageId = ''
  expect(confirmedGroupDeliveryText(state, 'receipt', caller, target)).toBeUndefined()
})
