import { describe, expect, it } from 'vitest'
import { createChannelLogicalHistory } from '../packages/cli/src/launcher/channel-logical-history.js'
import { channelLogicalActor } from '../packages/cli/src/launcher/channel-logical-actor.js'
import { parseChannelConversationPolicy } from '../packages/cli/src/launcher/channel-conversation-policy.js'

describe('linked history across multiple migrations', () => {
  it('paginates attributed ancestors and intersects their original consent', async () => {
    const channel = {
      adapterId: 'test',
      accountId: 'a',
      tenantId: 't',
      conversationId: 'c',
      threadId: 'c',
      kind: 'direct' as const,
      semantics: 'conversation' as const,
    }
    const event = {
      ...channel,
      eventId: 'event',
      actor: { adapterId: 'test', accountId: 'a', tenantId: 't', userId: 'u' },
    }
    const ref = (sessionId: string) => ({ hostId: 'local', appId: 'codex', profileId: 'profile', sessionId })
    const link = (operationId: string, source: string, destination: string, categories: string[]) => ({
      contract: 'cordisx.conversation-continuation-relation/v1',
      operationId,
      logicalConversationId: 'logical',
      revision: operationId === 'first' ? 1 : 2,
      source: ref(source),
      destination: ref(destination),
      target: { providerId: 'p', model: 'm' },
      mode: 'linked',
      historyAccess: 'on-demand',
      handoff: 'none',
      historyCategories: categories,
    })
    const actor = channelLogicalActor(event)
    const state = {
      jobs: {},
      inputs: {},
      policy: parseChannelConversationPolicy({
        enabled: true,
        rules: [
          { id: 'dispatch', action: 'dispatch', effect: 'allow', userIds: ['u'] },
        ],
      }),
      bindings: { b: { channel, sessionId: 'C', hostId: 'local', profileId: 'profile', state: 'active' } },
      logicalContinuations: {
        relations: {
          first: link('first', 'A', 'B', ['user-text']),
          second: link('second', 'B', 'C', ['user-text', 'assistant-text']),
        },
        intents: {
          first: { actor, state: 'applied', evidence: { sourceHistoryVersion: 'A' } },
          second: { actor, state: 'applied', evidence: { sourceHistoryVersion: 'B' } },
        },
      },
    }
    let versionA = 'A'
    const native = {
      sourceFor: () => event,
      sourceForLogicalTurn: async () => event,
      logicalTurnActive: async () => true,
      logicalSourceVersion: async (source: { sessionId: string }) => source.sessionId === 'A' ? versionA : 'B',
      logicalContextTokens: () => [],
      logicalHistoryPage: async (source: { sessionId: string }) => ({
        items: [
          { type: 'userMessage', content: [{ type: 'text', text: source.sessionId + '-user' }] },
          { type: 'agentMessage', text: source.sessionId + '-assistant' },
        ],
      }),
    }
    const handler = createChannelLogicalHistory({
      store: { snapshot: () => structuredClone(state) } as never,
      native: () => native as never,
      appId: 'codex',
      profileId: 'profile',
    })
    const call = { threadId: 'C', turnId: 'turn', callId: 'call', tool: 'cordisx_continuation_history', arguments: {} }
    const first = await handler(call)
    expect(first.success).toBe(true)
    const firstPage = JSON.parse(first.contentItems[0]!.text)
    expect(firstPage.source.sessionId).toBe('B')
    expect(firstPage.entries.map((x: { text: string }) => x.text)).toContain('B-assistant')
    const second = await handler({ ...call, arguments: { cursor: firstPage.nextCursor } })
    const secondPage = JSON.parse(second.contentItems[0]!.text)
    expect(secondPage.source.sessionId).toBe('A')
    expect(secondPage.entries.map((x: { text: string }) => x.text)).toEqual(['A-user'])
    versionA = 'changed'
    expect((await handler({ ...call, arguments: { cursor: firstPage.nextCursor } })).success).toBe(false)
  })
})
