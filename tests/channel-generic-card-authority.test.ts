import { expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ChannelEventRef } from '@cordisx/channel-runtime'
import { ChannelGenericCardActions } from '../packages/cli/src/launcher/channel-generic-card-actions.js'
import { authorizedChannelMessageOperation } from '../packages/cli/src/launcher/channel-message-operation-authority.js'
import type { ChannelConversationAccess } from '../packages/cli/src/launcher/channel-conversation-tools.js'
import { channelCliOperationKind } from '../packages/cli/src/launcher/channel-cli-approval.js'
import { channelOperationDuringPreparation } from '../packages/cli/src/launcher/channel-preparation-guard.js'

it('classifies publish as an explicit mutation while readback and receipt remain read-only', () => {
  expect(channelCliOperationKind('card-action-publish')).toBe('write')
  expect(channelCliOperationKind('card-action-read')).toBe('read')
  expect(channelCliOperationKind('card-action-receipt')).toBe('read')
  expect(channelOperationDuringPreparation('card-action-publish')).toBe(false)
  expect(channelOperationDuringPreparation('card-action-read')).toBe(true)
  expect(channelOperationDuringPreparation('card-action-receipt')).toBe(true)
})

it('uses history authorization for action readback and independent send authorization for explicit publication', async () => {
  const account = { adapterId: 'feishu', accountId: 'app', tenantId: 'tenant' }
  const source: ChannelEventRef = {
    ...account,
    conversationId: 'oc_chat',
    kind: 'direct',
    threadId: 'oc_chat',
    semantics: 'conversation',
    eventId: 'input',
    actor: { ...account, userId: 'ou_owner' },
  }
  const service = await ChannelGenericCardActions.open(
    path.join(await mkdtemp(path.join(os.tmpdir(), 'card-authority-')), 'ledger.json'),
  )
  const commandAllowed = vi.fn(() => true)
  const sendAllowed = vi.fn(() => false)
  const current: Pick<ChannelConversationAccess, 'generation' | 'accounts' | 'messageOperations'> = {
    generation: 'one',
    accounts: () => [{ ref: account, state: 'ready' }],
    messageOperations: (operation, request, context) =>
      service.execute(operation, request, {
        ...context,
        channel: () => undefined,
        ownsPlainCard: () => false,
        active: () => true,
      }),
  }
  const context = {
    current: current as ChannelConversationAccess,
    source,
    consumer: { commandAllowed, sendAllowed } as never,
    active: () => true,
    callerSession: 'owner-session',
  }
  const target = { account, conversationId: 'oc_chat', kind: 'direct' }
  const publication = {
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
  await expect(authorizedChannelMessageOperation('card-action-publish', publication, context)).rejects.toThrow(
    'CHANNEL_POLICY_DENIED',
  )
  expect(commandAllowed).toHaveBeenCalledWith(source, 'send')
  expect(sendAllowed).toHaveBeenCalledTimes(1)
  expect(
    await authorizedChannelMessageOperation(
      'card-action-read',
      { ...target, messageId: 'om_notice', version: 1 },
      context,
    ),
  ).toMatchObject({ status: 'unavailable' })
  expect(commandAllowed).toHaveBeenLastCalledWith(source, 'history')
  expect(sendAllowed).toHaveBeenCalledTimes(1)
  expect(await authorizedChannelMessageOperation('card-action-receipt', { ...target, operationId: 'publish' }, context))
    .toBeNull()
  commandAllowed.mockReturnValue(false)
  await expect(
    authorizedChannelMessageOperation('card-action-read', { ...target, messageId: 'om_notice', version: 1 }, context),
  ).rejects.toThrow('CHANNEL_POLICY_DENIED')
  service.dispose()
})
