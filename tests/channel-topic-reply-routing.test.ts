import { describe, expect, it } from 'vitest'
import { ChannelConversationTools } from '../packages/cli/src/launcher/channel-conversation-tools.js'
import { a, account, channel, fixture, message, settle } from './helpers/channel-conversation-fixture.js'

describe('Channel topic reply routing', () => {
  it.each(['conversation', 'thread'] as const)(
    'allows Agent-selected %s final after explicit sends switch between main stream and topic',
    async mode => {
      const f = await fixture()
      const source = { ...channel('oc_topic', 'group'), threadId: 'om_topic_root', semantics: 'topic' as const }
      await f.consumer.policySet({ enabled: true, autoReply: true }, 0)
      await f.consumer.bind({ channel: source, mode: 'deliver', autoReply: true }, a)
      f.native.completion.mockResolvedValue({ state: 'running' } as never)
      await f.consumer.receive('inbox:route-choice', message('om_topic_child', 'hello', source), true)
      await settle(f.consumer)
      const tools = new ChannelConversationTools(() => f.access, f.consumer)
      const metadata = { 'x-codex-turn-metadata': { thread_id: a, turn_id: 'turn-1' } }
      try {
        for (const [index, replyMode] of (['thread', 'conversation', 'thread'] as const).entries()) {
          await expect(tools.call('send', {
            account,
            target: {
              id: 'oc_topic',
              kind: 'group',
              replyMode,
              ...(replyMode === 'thread' ? { replyTo: 'om_topic_root' } : {}),
            },
            operationId: `route-progress-${index}`,
            text: 'progress',
          }, metadata)).resolves.toMatchObject({ deliveryState: 'sent' })
          expect(f.runtime.notifyOnce.mock.calls[index]?.[0].target)
            .toEqual(replyMode === 'thread' ? source : channel('oc_topic', 'group'))
        }
        await expect(tools.call('reply-mode', {
          operationId: f.consumer.status(a).jobs[0]!.id,
          mode,
        }, metadata)).resolves.toMatchObject({ status: 'ok', mode, sendsMessage: false })
        f.native.completion.mockResolvedValue({ state: 'completed', text: 'final' })
        await settle(f.consumer)
        expect(f.runtime.notifyOnce).toHaveBeenCalledTimes(4)
        expect(f.runtime.notifyOnce.mock.calls[3]?.[0].target).toEqual(
          mode === 'conversation'
            ? channel('oc_topic', 'group')
            : { ...source, threadId: 'om_topic_child' },
        )
      } finally {
        tools.dispose()
      }
    },
  )
  it.each(['fallback', 'selected-conversation', 'policy-conversation', 'denied'])(
    'keeps topic identity only for an automatic conversation fallback: %s',
    async scenario => {
      const f = await fixture()
      const source = { ...channel('oc_topic', 'group'), threadId: 'om_topic_root', semantics: 'topic' as const }
      await f.consumer.policySet({
        enabled: true,
        autoReply: true,
        ...(scenario === 'policy-conversation' ? { replyMode: 'conversation' } : {}),
      }, 0)
      await f.consumer.bind({ channel: channel('oc_topic', 'group'), mode: 'deliver', autoReply: true }, a)
      f.native.completion.mockResolvedValue({ state: 'running' } as never)
      await f.consumer.receive('inbox:topic', message('om_topic_child', 'hello', source), true)
      await settle(f.consumer)
      expect(f.consumer.status(a).jobs).toMatchObject([{ state: 'running', turnId: 'turn-1' }])
      const tools = new ChannelConversationTools(() => f.access, f.consumer)
      const metadata = { 'x-codex-turn-metadata': { thread_id: a, turn_id: 'turn-1' } }
      try {
        await expect(tools.call('send', {
          account,
          target: { id: 'oc_topic', kind: 'group', replyMode: 'thread', replyTo: 'om_topic_root' },
          operationId: 'topic-progress',
          text: 'progress',
        }, metadata)).resolves.toMatchObject({ deliveryState: 'sent' })
        expect(f.runtime.notifyOnce.mock.calls[0]?.[0].target).toEqual(source)
        if (scenario === 'selected-conversation') {
          await expect(tools.call('reply-mode', {
            operationId: f.consumer.status(a).jobs[0]!.id,
            mode: 'conversation',
          }, metadata)).resolves.toMatchObject({ status: 'ok' })
        }
        if (scenario === 'denied') {
          await f.consumer.policySet({
            ...f.consumer.policy().policy,
            rules: [{ id: 'deny-send', action: 'send', effect: 'deny' }],
          }, f.consumer.policy().revision)
        }
        f.native.completion.mockResolvedValue({ state: 'completed', text: 'final' })
        await settle(f.consumer)
        expect(f.runtime.notifyOnce).toHaveBeenCalledTimes(scenario === 'denied' ? 1 : 2)
        if (scenario !== 'denied') {
          expect(f.runtime.notifyOnce.mock.calls[1]?.[0].target).toEqual(
            scenario === 'fallback' ? source : channel('oc_topic', 'group'),
          )
        }
      } finally {
        tools.dispose()
      }
    },
  )
})
