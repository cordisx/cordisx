import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChannelEventRef, ChannelUserInput } from '@cordisx/channel-runtime'
import { ChannelAgentAccess } from '../packages/cli/src/launcher/channel-agent-access.js'
import { ChannelCommandUsers } from '../packages/cli/src/launcher/channel-command-users.js'
import { ChannelConversationStore } from '../packages/cli/src/launcher/channel-conversation-store.js'
import type { ChannelConversationAccess } from '../packages/cli/src/launcher/channel-conversation-tools.js'
import {
  channelPolicyAllows,
  parseChannelConversationPolicy,
} from '../packages/cli/src/launcher/channel-conversation-policy.js'
import { channelDispatchAllowed } from '../packages/cli/src/launcher/channel-group-access.js'
import { channelPermissionOperation } from '../packages/cli/src/launcher/channel-permission-cli.js'
import {
  channelGroupBlockIntent,
  channelUserAccessIntent,
} from '../packages/cli/src/launcher/channel-permission-intent.js'

const ref = { adapterId: 'feishu', accountId: 'fixture', tenantId: 'fixture' }
const source: ChannelEventRef = {
  ...ref,
  conversationId: 'oc_fixture',
  kind: 'group',
  threadId: 'oc_fixture',
  semantics: 'conversation',
  messageId: 'om_fixture',
  eventId: 'om_fixture',
  actor: { ...ref, userId: 'ou_admin' },
}
const roots: string[] = [], stores: ChannelConversationStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(text = '给 ou_member 授权') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'channel-permissions-'))
  roots.push(root)
  const store = await ChannelConversationStore.open(path.join(root, 'state.json'))
  stores.push(store)
  await store.mutate(state => {
    state.policy = parseChannelConversationPolicy({
      enabled: true,
      rules: [
        { id: 'commands', ...ref, action: 'command', effect: 'allow', userIds: ['ou_admin'] },
      ],
    })
  })
  let event = source, active = true, generation = 'fixture'
  const setSource = async (request: string, next = source, mentionedBot = true) => {
    event = next
    const input: ChannelUserInput = {
      contract: 'cordisx.channel-user-input/v1',
      schemaVersion: 1,
      role: 'user',
      content: [{ type: 'text', text: request }],
      source: { kind: 'channel', event },
      receivedAt: '2026-01-01T00:00:00Z',
    }
    await store.mutate(state => {
      state.inputs.current = {
        recordId: 'current',
        sequence: state.nextSequence++,
        input,
        mentionedBot,
        persisted: true,
        accepted: true,
        routed: true,
        addressing: { mentions: [{ key: '@_user_2', userId: 'ou_member', name: 'Member' }] },
      }
    })
  }
  await setSource(text)
  const native = {
    sourceFor: () => active ? event : undefined,
    contextFor: (token: string) =>
      active && token === 'actual-token' ? { source: event, threadId: 'session', turnId: 'turn' } : undefined,
  }
  const agent = new ChannelAgentAccess(() => store.snapshot(), () => native as never)
  let directory = async () => ({ complete: true, users: [{ id: 'ou_member', name: 'Member' }] })
  const access = () =>
    ({ generation, accounts: () => [{ ref, state: 'ready' }], users: () => directory() }) as ChannelConversationAccess
  const users = new ChannelCommandUsers()
  const call = (operation: string, value: unknown, metadata: unknown = { 'cordisx/channelContext': 'actual-token' }) =>
    channelPermissionOperation({
      operation,
      value,
      metadata,
      store,
      agent,
      users,
      access,
      signal: new AbortController().signal,
    })
  return {
    root,
    store,
    call,
    setSource,
    expire: () => {
      active = false
    },
    changeGeneration: () => {
      generation = 'changed'
    },
    directory: (lookup: typeof directory) => {
      directory = lookup
    },
  }
}

describe('AI-callable Channel permission operations', () => {
  it('shares user allow/deny/reset rules without changing command, send or other conversation policy', async () => {
    const f = await fixture()
    expect(await f.call('user-access', { user: 'ou_member' })).toMatchObject({
      revision: 0,
      effect: 'reset',
      canAllow: true,
    })
    expect(await f.call('user-access-set', { user: 'ou_member', effect: 'allow', expectedRevision: 0 }))
      .toMatchObject({ revision: 1, effect: 'allow', dispatchAllowed: true })
    const member = { ...source, actor: { ...source.actor!, userId: 'ou_member' } }
    expect(channelPolicyAllows(f.store.snapshot().policy, 'command', member, 'deny-user')).toBe(false)
    await f.setSource('禁止 ou_member 发起任务')
    expect(await f.call('user-access-set', { user: 'ou_member', effect: 'deny', expectedRevision: 1 }))
      .toMatchObject({ revision: 2, explicitlyDenied: true })
    expect(channelPolicyAllows(f.store.snapshot().policy, 'dispatch', { ...member, conversationId: 'oc_other' })).toBe(
      true,
    )
    await f.setSource('恢复 ou_member 权限')
    expect(await f.call('user-access-set', { user: 'ou_member', effect: 'reset', expectedRevision: 2 }))
      .toMatchObject({ revision: 3, effect: 'reset', dispatchAllowed: true })
    expect(f.store.snapshot().policy.rules).toHaveLength(1)
  })
  it('retains higher-level intersections and explicit denials even after local allow/reset', async () => {
    const f = await fixture()
    await f.store.mutate(state => {
      state.policy = parseChannelConversationPolicy({
        ...state.policy,
        rules: [...state.policy.rules, {
          id: 'global-allow',
          action: 'dispatch',
          effect: 'allow',
          userIds: ['ou_admin'],
        }, { id: 'account-deny', ...ref, action: 'dispatch', effect: 'deny', userIds: ['ou_member'] }],
      })
    })
    expect(await f.call('user-access-set', { user: 'ou_member', effect: 'allow', expectedRevision: 0 }))
      .toMatchObject({ dispatchAllowed: false, explicitlyDenied: true })
    await f.setSource('恢复 ou_member 权限')
    await f.call('user-access-set', { user: 'ou_member', effect: 'reset', expectedRevision: 1 })
    expect(f.store.snapshot().policy.rules.map(rule => rule.id)).toEqual(['commands', 'global-allow', 'account-deny'])
  })
  it('grants only this user future mentions in this group despite an account allowlist', async () => {
    const f = await fixture()
    await f.store.mutate(state => {
      state.policy = parseChannelConversationPolicy({
        ...state.policy,
        rules: [...state.policy.rules, {
          id: 'account-list',
          ...ref,
          action: 'dispatch',
          effect: 'allow',
          userIds: ['ou_admin'],
        }],
      })
    })
    expect(await f.call('user-access-set', { user: 'ou_member', effect: 'allow', expectedRevision: 0 }))
      .toMatchObject({ dispatchAllowed: true, grantForFutureMentions: true, fromSequence: 2 })
    const member = {
      ...source,
      messageId: 'om_member',
      eventId: 'om_member',
      actor: { ...source.actor!, userId: 'ou_member' },
    }
    await f.setSource('task', member)
    expect(channelDispatchAllowed(f.store.snapshot(), member)).toBe(true)
    await f.setSource('task', member, false)
    expect(channelDispatchAllowed(f.store.snapshot(), member)).toBe(false)
    await f.setSource('task', { ...member, kind: 'direct' })
    expect(channelDispatchAllowed(f.store.snapshot(), { ...member, kind: 'direct' })).toBe(false)
    await f.setSource('task', { ...member, conversationId: 'oc_other' })
    expect(channelDispatchAllowed(f.store.snapshot(), { ...member, conversationId: 'oc_other' })).toBe(false)
    await f.setSource('task', { ...member, actor: { ...member.actor!, userId: 'ou_other' } })
    expect(channelDispatchAllowed(f.store.snapshot(), { ...member, actor: { ...member.actor!, userId: 'ou_other' } }))
      .toBe(false)
    await f.setSource('恢复 ou_member 权限')
    await f.call('user-access-set', { user: 'ou_member', effect: 'reset', expectedRevision: 1 })
    expect(f.store.snapshot().groupUserTaskAccess).toEqual([])
  })
  it('requires global command authority for explicit account scope and never allows another account', async () => {
    const f = await fixture('在本账号给 ou_member 授权')
    const args = { user: 'ou_member', scope: 'account', effect: 'allow', expectedRevision: 0 }
    await expect(f.call('user-access-set', args)).rejects.toThrow('CHANNEL_PERMISSION_DENIED')
    await f.store.mutate(state => {
      state.policy = parseChannelConversationPolicy({
        ...state.policy,
        rules: [...state.policy.rules, {
          id: 'global-admin',
          action: 'command',
          effect: 'allow',
          userIds: ['ou_admin'],
        }],
      })
    })
    expect(await f.call('user-access-set', args)).toMatchObject({ scope: ref, effect: 'allow' })
    const rule = f.store.snapshot().policy.rules.at(-1)!
    expect(rule.conversationId).toBeUndefined()
    expect(rule.accountId).toBe('fixture')
    await expect(f.call('user-access-set', { ...args, accountId: 'other' })).rejects.toThrow('INVALID_REQUEST')
    await f.setSource('给 ou_member 授权')
    await expect(f.call('user-access-set', { ...args, expectedRevision: 1 })).rejects.toThrow(
      'CHANNEL_PERMISSION_REQUEST_REQUIRED',
    )
  })
  it('uses any matching grant cutoff and never lets a newer group grant shadow a queued personal grant', async () => {
    const f = await fixture()
    await f.store.mutate(state => {
      state.policy = parseChannelConversationPolicy({
        ...state.policy,
        rules: [...state.policy.rules, {
          id: 'account-list',
          ...ref,
          action: 'dispatch',
          effect: 'allow',
          userIds: ['ou_admin'],
        }],
      })
    })
    await f.call('user-access-set', { user: 'ou_member', effect: 'allow', expectedRevision: 0 })
    const member = {
      ...source,
      messageId: 'om_queued',
      eventId: 'om_queued',
      actor: { ...source.actor!, userId: 'ou_member' },
    }
    await f.setSource('queued task', member)
    await f.store.mutate(state => {
      state.groupTaskAccess = [{ ...ref, conversationId: source.conversationId, fromSequence: state.nextSequence }]
    })
    expect(channelDispatchAllowed(f.store.snapshot(), member)).toBe(true)
    await f.store.mutate(state => {
      state.groupTaskAccess = []
    })
    expect(channelDispatchAllowed(f.store.snapshot(), member)).toBe(true)
    await f.store.mutate(state => {
      state.groupTaskAccess = [{ ...ref, conversationId: source.conversationId, fromSequence: state.nextSequence }]
      state.groupUserTaskAccess = []
    })
    expect(channelDispatchAllowed(f.store.snapshot(), member)).toBe(false)
  })
  it('resolves the original native mention/name and rejects fabricated targets or ambiguous directory matches', async () => {
    const f = await fixture('给 @_user_2 授权')
    await expect(f.call('user-access-set', { user: 'ou_other', effect: 'allow', expectedRevision: 0 }))
      .rejects.toThrow('CHANNEL_PERMISSION_REQUEST_REQUIRED')
    expect(await f.call('user-access-set', { user: '@_user_2', effect: 'allow', expectedRevision: 0 }))
      .toMatchObject({ userId: 'ou_member' })
    await f.setSource('禁止 Member 发起任务')
    f.directory(async () => ({
      complete: true,
      users: [{ id: 'ou_a', name: 'Member' }, { id: 'ou_b', name: 'Member' }],
    }))
    expect(await f.call('user-access-set', { user: 'Member', effect: 'deny', expectedRevision: 1 }))
      .toMatchObject({ status: 'choice-required' })
    expect(f.store.snapshot().policyRevision).toBe(1)
    await f.setSource('禁止 ou_a 发起任务')
    expect(await f.call('user-access-set', { user: 'ou_a', effect: 'deny', expectedRevision: 1 }))
      .toMatchObject({ userId: 'ou_a', effect: 'deny' })
  })
  it('rechecks active source, generation, permission and revision at the durable effect', async () => {
    const f = await fixture()
    await expect(f.call('user-access-set', { user: 'ou_member', effect: 'allow', expectedRevision: 0 }, {}))
      .rejects.toThrow('CHANNEL_CONTEXT_UNAVAILABLE')
    const pending = f.call('user-access-set', { user: 'Member', effect: 'allow', expectedRevision: 0 })
    await expect(pending).rejects.toThrow('CHANNEL_PERMISSION_REQUEST_REQUIRED')
    await f.setSource('给 Member 授权')
    f.directory(async () => {
      f.changeGeneration()
      return { complete: true, users: [{ id: 'ou_member', name: 'Member' }] }
    })
    await expect(f.call('user-access-set', { user: 'Member', effect: 'allow', expectedRevision: 0 }))
      .rejects.toThrow('CHANNEL_CONTEXT_UNAVAILABLE')
    const other = await fixture()
    const revoke = other.store.mutate(state => {
      state.policy = parseChannelConversationPolicy({
        ...state.policy,
        rules: [...state.policy.rules, { id: 'revoke', action: 'command', effect: 'deny', commands: ['allow-user'] }],
      })
    })
    const write = other.call('user-access-set', { user: 'ou_member', effect: 'allow', expectedRevision: 0 })
    await revoke
    await expect(write).rejects.toThrow('CHANNEL_PERMISSION_DENIED')
    const cas = await fixture()
    const results = await Promise.allSettled(
      [0, 1].map(() => cas.call('user-access-set', { user: 'ou_member', effect: 'allow', expectedRevision: 0 })),
    )
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
  })
  it('admits only an addressed authorized recovery request after a managed group block', async () => {
    const f = await fixture('禁止本群任务')
    expect(await f.call('group-block-set', { blocked: true, expectedRevision: 0 }))
      .toMatchObject({ blocked: true, revision: 1, recovery: '/messages-on' })
    expect(channelDispatchAllowed(f.store.snapshot(), source)).toBe(false)
    await f.setSource('恢复本群任务')
    expect(channelDispatchAllowed(f.store.snapshot(), source)).toBe(true)
    await f.setSource('恢复本群任务', { ...source, actor: { ...source.actor!, userId: 'ou_member' } })
    expect(channelDispatchAllowed(f.store.snapshot(), { ...source, actor: { ...source.actor!, userId: 'ou_member' } }))
      .toBe(false)
    await f.setSource('恢复本群任务', source, false)
    expect(channelDispatchAllowed(f.store.snapshot(), source)).toBe(false)
    await f.setSource('恢复本群任务')
    await f.store.mutate(state => {
      state.policy = parseChannelConversationPolicy({
        ...state.policy,
        rules: [...state.policy.rules, {
          id: 'other-deny',
          ...ref,
          conversationId: source.conversationId,
          action: 'dispatch',
          effect: 'deny',
        }],
      })
    })
    expect(channelDispatchAllowed(f.store.snapshot(), source)).toBe(false)
    await f.call('group-block-set', { blocked: false, expectedRevision: 1 })
    expect(f.store.snapshot().policy.rules.some(rule => rule.id === 'other-deny')).toBe(true)
    expect(channelDispatchAllowed(f.store.snapshot(), source)).toBe(false)
    const persisted = await ChannelConversationStore.open(path.join(f.root, 'state.json'))
    expect(persisted.snapshot().policyRevision).toBe(2)
    await persisted.close()
  })
  it('rejects negated, quoted, other-group and combined requests', () => {
    for (const text of ['不要禁止本群任务', '他说恢复本群任务', '恢复其他群任务', '恢复本群任务，然后做工作']) {
      expect(channelGroupBlockIntent(text, false)).toBe(false)
      expect(channelGroupBlockIntent(text, true)).toBe(false)
    }
    for (
      const text of [
        '不要禁止 ou_member 发起任务',
        '他说禁止 ou_member 发起任务',
        '禁止 ou_member 发起任务，但是别执行',
      ]
    ) {
      expect(channelUserAccessIntent(text, 'deny')).toBeUndefined()
    }
    expect(channelGroupBlockIntent('请帮我恢复本群任务吧！', false)).toBe(true)
    expect(channelUserAccessIntent('请帮我给 ou_member 授权一下！', 'allow')).toEqual({
      user: 'ou_member',
      account: false,
    })
  })
})
