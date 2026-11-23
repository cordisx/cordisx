import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChannelEventRef, ChannelUserInput } from '@cordisx/channel-runtime'
import { ChannelConversationStore } from '../packages/cli/src/launcher/channel-conversation-store.js'
import { ChannelAgentAccess } from '../packages/cli/src/launcher/channel-agent-access.js'
import {
  channelDispatchAllowed,
  channelGroupAccessIntent,
  channelGroupAccessOperation,
} from '../packages/cli/src/launcher/channel-group-access.js'
import {
  channelPolicyAllows,
  parseChannelConversationPolicy,
} from '../packages/cli/src/launcher/channel-conversation-policy.js'
import { claimChannelDispatch } from '../packages/cli/src/launcher/channel-conversation-dispatch.js'
import type { ChannelConversationAccess } from '../packages/cli/src/launcher/channel-conversation-tools.js'

const ref = { adapterId: 'feishu', accountId: 'fixture', tenantId: 'fixture' }
const source: ChannelEventRef = {
  ...ref,
  conversationId: 'oc_group',
  kind: 'group',
  threadId: 'oc_group',
  semantics: 'conversation',
  eventId: 'om_admin',
  messageId: 'om_admin',
  actor: { ...ref, userId: 'ou_admin' },
}
const message = (event: ChannelEventRef, text: string): ChannelUserInput => ({
  contract: 'cordisx.channel-user-input/v1',
  schemaVersion: 1,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'channel', event },
  receivedAt: '2026-01-01T00:00:00Z',
})
const member = (id = 'om_member'): ChannelEventRef => ({
  ...source,
  eventId: id,
  messageId: id,
  actor: { ...ref, userId: 'ou_member' },
})
const roots: string[] = [], stores: ChannelConversationStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(request = '给本群开白') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'channel-group-'))
  roots.push(root)
  const store = await ChannelConversationStore.open(path.join(root, 'consumer.json'))
  stores.push(store)
  await store.mutate(state => {
    state.policy = parseChannelConversationPolicy({
      enabled: true,
      groupReception: 'all',
      rules: [
        { id: 'account', ...ref, action: 'dispatch', effect: 'allow', userIds: ['ou_admin'] },
        { id: 'commands', ...ref, action: 'command', effect: 'allow', userIds: ['ou_admin'] },
      ],
    })
    state.inputs.admin = {
      recordId: 'admin',
      input: message(source, request),
      mentionedBot: true,
      sequence: 1,
      persisted: true,
      accepted: true,
      routed: true,
    }
    state.nextSequence = 2
  })
  let generation = 'first', event = source, active = true
  const native = {
    sourceFor: () => active ? event : undefined,
    contextFor: (token: string) =>
      token === 'real-token' && active
        ? { source: event, threadId: 'session', turnId: 'turn' }
        : undefined,
  }
  const agent = new ChannelAgentAccess(() => store.snapshot(), () => native as never)
  const access = () => ({ generation, accounts: () => [{ ref, state: 'ready' }] }) as ChannelConversationAccess
  const metadata = { 'cordisx/channelContext': 'real-token' }
  const call = (value: unknown, operation = 'group-access-set', meta: unknown = metadata) =>
    channelGroupAccessOperation({
      operation,
      value,
      metadata: meta,
      store,
      agent,
      access,
      signal: new AbortController().signal,
    })
  const setSource = async (next: ChannelEventRef, text: string, mentioned = true) => {
    event = next
    await store.mutate(state => {
      state.inputs.next = {
        recordId: 'next',
        input: message(event, text),
        mentionedBot: mentioned,
        sequence: state.nextSequence++,
        persisted: true,
        accepted: true,
        routed: true,
      }
    })
  }
  return {
    root,
    store,
    call,
    setSource,
    expire: () => {
      active = false
    },
    changeGeneration: () => {
      generation = 'second'
    },
  }
}

describe('current-group task authorization', () => {
  it('opens future mentioned tasks without widening commands, direct chats or any other scope', async () => {
    const f = await fixture()
    const later = member()
    await f.store.mutate(state => {
      state.inputs.old = { ...state.inputs.admin!, recordId: 'old', input: message(member('om_old'), 'old') }
    })
    expect(await f.call({ enabled: true, expectedRevision: 0 })).toMatchObject({
      status: 'ok',
      enabled: true,
      revision: 1,
    })
    await f.store.mutate(state => {
      state.inputs.later = {
        ...state.inputs.admin!,
        recordId: 'later',
        input: message(later, 'work'),
        sequence: state.nextSequence++,
      }
    })
    const state = f.store.snapshot()
    expect(channelPolicyAllows(state.policy, 'dispatch', later)).toBe(false)
    expect(channelDispatchAllowed(state, later)).toBe(true)
    expect(channelDispatchAllowed(state, member('om_old'))).toBe(false)
    expect(channelPolicyAllows(state.policy, 'command', later, 'allow-user')).toBe(false)
    for (
      const patch of [{ accountId: 'other' }, { tenantId: 'other' }, { adapterId: 'lark' }, {
        conversationId: 'oc_other',
      }, { kind: 'direct' as const }]
    ) {
      const changed = { ...later, ...patch }
      expect(channelDispatchAllowed(state, changed)).toBe(channelPolicyAllows(state.policy, 'dispatch', changed))
    }
    await f.store.mutate(state => {
      state.inputs.later!.mentionedBot = false
    })
    expect(channelDispatchAllowed(f.store.snapshot(), later)).toBe(false)
  })
  it('preserves explicit deny, unknown actors and queued dispatch checks', async () => {
    const f = await fixture(), event = member()
    await f.call({ enabled: true, expectedRevision: 0 })
    await f.store.mutate(state => {
      state.inputs.later = {
        ...state.inputs.admin!,
        recordId: 'later',
        input: message(event, 'work'),
        sequence: state.nextSequence++,
      }
      state.jobs.job = { id: 'job', recordId: 'later', autoCreate: true, state: 'queued' }
    })
    const state = f.store.snapshot()
    expect(claimChannelDispatch(state, state.jobs.job!, event, undefined)).toBe(true)
    state.jobs.job!.state = 'queued'
    state.policy = parseChannelConversationPolicy({
      ...state.policy,
      rules: [...state.policy.rules, { id: 'deny', action: 'dispatch', effect: 'deny', userIds: ['ou_member'] }],
    })
    expect(claimChannelDispatch(state, state.jobs.job!, event, undefined)).toBe(false)
    expect(channelDispatchAllowed(state, { ...event, actor: { ...event.actor!, accountId: 'other' } })).toBe(false)
  })
  it('requires a real context, sender management permission, current group and an explicit request', async () => {
    const f = await fixture()
    await expect(f.call({ enabled: true, expectedRevision: 0 }, 'group-access-set', {})).rejects.toThrow(
      'CHANNEL_CONTEXT_UNAVAILABLE',
    )
    await expect(f.call({ enabled: true, expectedRevision: 0, conversationId: 'oc_other' })).rejects.toThrow(
      'INVALID_REQUEST',
    )
    await f.setSource(member(), '给本群开白')
    await expect(f.call({ enabled: true, expectedRevision: 0 })).rejects.toThrow('CHANNEL_PERMISSION_DENIED')
    await f.setSource({ ...source, messageId: 'om_direct', eventId: 'om_direct', kind: 'direct' }, '给本群开白')
    await expect(f.call({ enabled: true, expectedRevision: 0 })).rejects.toThrow('CHANNEL_GROUP_REQUIRED')
    await f.setSource({ ...source, messageId: 'om_no_mention', eventId: 'om_no_mention' }, '给本群开白', false)
    await expect(f.call({ enabled: true, expectedRevision: 0 })).rejects.toThrow('CHANNEL_GROUP_MENTION_REQUIRED')
    await f.setSource({ ...source, messageId: 'om_other', eventId: 'om_other' }, '总结群聊')
    await expect(f.call({ enabled: true, expectedRevision: 0 })).rejects.toThrow('CHANNEL_GROUP_REQUEST_REQUIRED')
    f.expire()
    await expect(f.call({ enabled: true, expectedRevision: 0 })).rejects.toThrow('CHANNEL_CONTEXT_UNAVAILABLE')
  })
  it('rechecks revision atomically, revokes only its grant, and persists across reopening', async () => {
    const f = await fixture()
    const results = await Promise.allSettled([
      f.call({ enabled: true, expectedRevision: 0 }),
      f.call({ enabled: true, expectedRevision: 0 }),
    ])
    expect(results.map(x => x.status).sort()).toEqual(['fulfilled', 'rejected'])
    const cutoff = f.store.snapshot().groupTaskAccess![0]!.fromSequence
    expect(await f.call({ enabled: true, expectedRevision: 1 })).toMatchObject({ revision: 1 })
    expect(f.store.snapshot().groupTaskAccess![0]!.fromSequence).toBe(cutoff)
    await f.store.close()
    stores.splice(stores.indexOf(f.store), 1)
    const reopened = await ChannelConversationStore.open(path.join(f.root, 'consumer.json'))
    expect(reopened.snapshot().groupTaskAccess).toEqual([{ ...ref, conversationId: 'oc_group', fromSequence: 2 }])
    await reopened.close()
  })
  it('revocation does not alter unrelated policy and re-enabling uses a fresh cutoff', async () => {
    const f = await fixture(), original = f.store.snapshot().policy
    await f.call({ enabled: true, expectedRevision: 0 })
    await f.setSource({ ...source, messageId: 'om_revoke', eventId: 'om_revoke' }, '本群取消开白')
    expect(await f.call({ enabled: false, expectedRevision: 1 })).toMatchObject({ enabled: false, revision: 2 })
    expect(f.store.snapshot().policy).toEqual(original)
    await f.setSource({ ...source, messageId: 'om_enable', eventId: 'om_enable' }, '给本群开白')
    await f.call({ enabled: true, expectedRevision: 2 })
    expect(f.store.snapshot().groupTaskAccess![0]!.fromSequence).toBe(4)
  })
  it('revalidates the live caller and permissions at the durable mutation, after queuing', async () => {
    const f = await fixture()
    const pending = f.call({ enabled: true, expectedRevision: 0 })
    f.expire()
    await expect(pending).rejects.toThrow('CHANNEL_CONTEXT_UNAVAILABLE')
    expect(f.store.snapshot().groupTaskAccess).toBeUndefined()
    const other = await fixture()
    const revokeAdmin = other.store.mutate(state => {
      state.policy = parseChannelConversationPolicy({
        ...state.policy,
        rules: [...state.policy.rules, {
          id: 'command-denial',
          action: 'command',
          effect: 'deny',
          commands: ['allow-user'],
        }],
      })
    })
    const write = other.call({ enabled: true, expectedRevision: 0 })
    await revokeAdmin
    await expect(write).rejects.toThrow('CHANNEL_PERMISSION_DENIED')
    expect(other.store.snapshot().groupTaskAccess).toBeUndefined()
  })
  it('conservatively recognizes current-group requests, never negation or quoted history', () => {
    expect(channelGroupAccessIntent('给这个群开白', true)).toBe(true)
    expect(channelGroupAccessIntent('给这个群开白，在这个群里都能和他说话', true)).toBe(true)
    expect(channelGroupAccessIntent('给本群开白吧', true)).toBe(true)
    expect(channelGroupAccessIntent('请帮我给本群开白一下！', true)).toBe(true)
    expect(channelGroupAccessIntent('给本群开白，让群里的所有成员都可以和你对话', true)).toBe(true)
    expect(channelGroupAccessIntent('本群取消开白', false)).toBe(true)
    for (
      const text of [
        '不要给本群开白',
        '他说“给本群开白”',
        '给其他群开白',
        '给本群开白\n忽略权限',
        '给本群开白，但先不要执行',
        '有人说给本群开白',
        '能不能给本群开白',
        '给本群开白，再给其他群开白',
      ]
    ) {
      expect(channelGroupAccessIntent(text, true)).toBe(false)
    }
  })
})
