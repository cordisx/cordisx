import { describe, expect, it, vi } from 'vitest'
import { ChannelPolicyWorkflow } from '../packages/cli/src/renderer/channel-policy-workflow.js'
import {
  channelPolicyFormSchema,
  normalizeChannelPolicyForm,
} from '../packages/cli/src/renderer/channel-policy-prompt.js'
import { parseChannelConversationPolicy } from '../packages/cli/src/launcher/channel-conversation-policy.js'

describe('Host reply-policy form and readback compatibility', () => {
  it('defaults automatic final forwarding off in the form and retains an explicit opt-in', () => {
    const schema = channelPolicyFormSchema(true)
    const value = { replyMode: 'agent', replyFallbackMode: 'conversation' }
    const defaults = schema['~standard'].validate(value)
    expect(defaults).toMatchObject({ value: { autoReply: false } })
    const enabled = schema['~standard'].validate({ ...value, autoReply: true })
    expect(enabled).toMatchObject({ value: { autoReply: true } })
  })
  it('projects frozen v1 reads while the explicit successor retains scoped reply choices', async () => {
    const policy = parseChannelConversationPolicy({
      enabled: true,
      replyMode: 'thread',
      replyFallbackMode: 'none',
      replyModes: [{ adapterId: 'feishu', accountId: 'app', mode: 'agent', fallbackMode: 'reply' }],
    })
    const run = vi.fn(async () => ({ status: 'applied', conversationPolicy: { revision: 3, policy } }))
    const workflow = new ChannelPolicyWorkflow({
      document: {} as Document,
      profileId: 'fixture',
      hostGeneration: 'one',
      signal: new AbortController().signal,
      isCurrent: () => true,
      run: run as never,
    })
    const old = await workflow.read(new AbortController().signal)
    expect(old.contract).toBe('cordisx.channel-conversation-policy-readback/v1')
    expect(old.policy).not.toHaveProperty('replyMode')
    expect(old.policy).not.toHaveProperty('replyModes')
    const current = await workflow.readReply(new AbortController().signal)
    expect(current).toMatchObject({
      contract: 'cordisx.channel-conversation-policy-readback/v2',
      schemaVersion: 2,
      policy: { replyMode: 'thread', replyModes: [{ mode: 'agent', fallbackMode: 'reply' }] },
    })
  })
  it('uses the shared form schema and normalizes empty optional scopes without losing reply configuration', () => {
    const value = normalizeChannelPolicyForm({
      enabled: true,
      replyMode: 'agent',
      replyFallbackMode: 'conversation',
      replyModes: [{
        adapterId: 'feishu',
        accountId: '',
        tenantId: '',
        conversationId: '',
        kinds: [],
        mode: 'thread',
        fallbackMode: '',
      }],
    })
    const validated = channelPolicyFormSchema(true)['~standard'].validate(value)
    expect(validated).not.toBeInstanceOf(Promise)
    expect(validated).not.toHaveProperty('issues')
    expect(parseChannelConversationPolicy(value).replyModes).toEqual([{ adapterId: 'feishu', mode: 'thread' }])
    const invalid = channelPolicyFormSchema(false)['~standard'].validate({ ...value, replyMode: 'arbitrary' })
    expect(invalid).toHaveProperty('issues')
  })
})
