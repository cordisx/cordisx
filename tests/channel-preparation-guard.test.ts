import { describe, expect, it } from 'vitest'
import { ChannelConversationTools } from '../packages/cli/src/launcher/channel-conversation-tools.js'

describe('Channel preparation fence', () => {
  it('blocks both native tool and unauthenticated local CLI writes while a target prepares', async () => {
    const tools = new ChannelConversationTools(() => undefined, {
      agentAccess: { hasPreparation: () => true, caller: () => undefined, preparation: () => false },
    } as never)
    expect(await tools.call('send', {}, { 'cordisx/mcpRequestId': 'target' })).toEqual({
      status: 'rejected',
      code: 'PREPARATION_READ_ONLY',
    })
    expect(await tools.callLocal('continuation-policy-set', {}, undefined)).toEqual({
      status: 'rejected',
      code: 'PREPARATION_READ_ONLY',
    })
    tools.dispose()
  })
  it('does not block a verified source context while preparation is active', async () => {
    const tools = new ChannelConversationTools(() => undefined, {
      agentAccess: { hasPreparation: () => true, caller: () => ({ threadId: 'source' }), preparation: () => false },
    } as never)
    expect(await tools.call('send', {}, { 'cordisx/channelContext': 'source-token' })).toEqual({
      status: 'unavailable',
      code: 'CHANNEL_NOT_CONFIGURED',
    })
    tools.dispose()
  })
})
