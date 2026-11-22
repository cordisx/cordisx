import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { ChannelConversationConsumer } from '../packages/cli/src/launcher/channel-conversation-consumer.js'
import { ChannelConversationTools } from '../packages/cli/src/launcher/channel-conversation-tools.js'

it('permits local profile preferences with a Desktop recovery owner only after its barrier is ready', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'channel-owner-preference-'))
  const consumer = await ChannelConversationConsumer.open({
    file: path.join(dir, 'state.json'),
    appId: 'codex',
    profileId: 'profile',
    logicalRecoveryRequired: true,
    access: () => undefined,
    native: () => undefined,
  })
  const tools = new ChannelConversationTools(() => undefined, consumer)
  try {
    expect(await tools.callLocal('logical-mode-default', {})).toMatchObject({
      status: 'rejected',
      code: 'LOGICAL_RECOVERY_UNAVAILABLE',
    })
    expect(await tools.callLocal('logical-status', { sessionId: 'source' }))
      .toMatchObject({ status: 'ok', operations: [], recoveryReady: false })
    await consumer.profileLogicalOwner().store.bindCommitBarrier(async () => {})
    expect(await tools.callLocal('logical-status', { sessionId: 'source' }, {}))
      .toMatchObject({ status: 'rejected', code: 'LOCAL_USER_REQUIRED' })
    expect(await tools.callLocal('logical-mode-default-set', { mode: 'fork', expectedRevision: 0 })).toMatchObject({
      status: 'ok',
      preference: { mode: 'fork' },
    })
    const choice = await tools.callLocal('logical-mode-conversation', { sessionId: 'source' }) as {
      conversationId: string
    }
    expect(
      await tools.callLocal('logical-mode-conversation-set', {
        sessionId: 'source',
        mode: 'fresh',
        expectedRevision: 0,
        expectedConversationId: choice.conversationId,
      }),
    ).toMatchObject({ status: 'rejected', code: 'INVALID_REQUEST' })
    expect(
      await tools.callLocal('logical-mode-conversation-set', {
        sessionId: 'source',
        mode: 'linked',
        expectedRevision: 0,
        expectedConversationId: choice.conversationId,
      }),
    ).toMatchObject({ status: 'ok', preference: { mode: 'linked' } })
    expect(await tools.callLocal('logical-mode-default-set', { mode: 'fresh', expectedRevision: 1 }, {}))
      .toMatchObject({ status: 'rejected', code: 'LOCAL_USER_REQUIRED' })
  } finally {
    tools.dispose()
    await consumer.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
