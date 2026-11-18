import { describe, expect, it } from 'vitest'
import type { ChannelEventRef } from '@cordisx/channel-runtime'
import { parseChannelConversationPolicy } from '../packages/cli/src/launcher/channel-conversation-policy.js'
import {
  channelTaskChangeAllowed,
  channelTaskDefaults,
  parseChannelTaskConfig,
} from '../packages/cli/src/launcher/channel-task-config.js'
import { resolveChannelTaskSelection } from '../packages/cli/src/launcher/channel-task-selection.js'

const event: ChannelEventRef = {
  adapterId: 'feishu',
  accountId: 'account',
  tenantId: 'tenant',
  conversationId: 'oc_group',
  kind: 'group',
  threadId: 'oc_group',
  semantics: 'conversation',
  eventId: 'om_event',
  actor: { adapterId: 'feishu', accountId: 'account', tenantId: 'tenant', userId: 'alice' },
}
const policy = parseChannelConversationPolicy({
  groups: [{ id: 'ops', name: 'Operators', members: [{ tenantId: 'tenant', userId: 'alice' }] }],
})
const catalog = [
  { providerId: 'one', models: [{ id: 'shared', reasoningCapabilities: { efforts: ['low', 'high'] } }] },
  { providerId: 'two', defaultModelId: 'new', models: [{ id: 'new', reasoningCapabilities: { efforts: ['low'] } }] },
]

describe('Channel task configuration authority', () => {
  it('preserves false Fast defaults and intersects field grants with exact Fast and project values', () => {
    const config = parseChannelTaskConfig({
      defaults: { fast: true, projectId: 'repo-a' },
      scopes: [{ id: 'alice', userIds: ['alice'], settings: { fast: false } }],
      permissions: [{
        id: 'projects',
        effect: 'allow',
        userIds: ['alice'],
        fields: ['fast', 'projectId'],
        fastModes: [false],
        projectIds: ['repo-a'],
      }],
    })
    expect(channelTaskDefaults(config, policy, event)).toEqual({ fast: false, projectId: 'repo-a' })
    expect(channelTaskChangeAllowed(config, policy, event, { fast: false, projectId: 'repo-a' }, {
      fast: false,
      projectId: 'repo-a',
    })).toBe(true)
    expect(channelTaskChangeAllowed(config, policy, event, { fast: true }, { fast: true, projectId: 'repo-a' })).toBe(
      false,
    )
    expect(
      channelTaskChangeAllowed(config, policy, event, { projectId: 'repo-b' }, { fast: false, projectId: 'repo-b' }),
    ).toBe(false)
    for (const fast of ['false', null, 0]) expect(() => parseChannelTaskConfig({ defaults: { fast } })).toThrow()
  })
  it('includes an implied Fast disable in provider-change approval and rejects unsupported explicit enable', () => {
    const fastCatalog = [{ providerId: 'one', models: [{ id: 'shared', supportsFastMode: true }] }, catalog[1]!]
    expect(
      resolveChannelTaskSelection(fastCatalog, { providerId: 'one', model: 'shared', fast: true }, {
        providerId: 'two',
      }),
    )
      .toEqual({
        selection: { providerId: 'two', model: 'new', fast: false },
        patch: { providerId: 'two', model: 'new', fast: false },
      })
    expect(() => resolveChannelTaskSelection(fastCatalog, { providerId: 'two', model: 'new' }, { fast: true })).toThrow(
      'FAST_NOT_SUPPORTED',
    )
  })
  it('merges user defaults over group and conversation defaults and rejects equal-specificity conflicts', () => {
    const config = parseChannelTaskConfig({
      defaults: { providerId: 'one', model: 'shared' },
      scopes: [
        { id: 'group', conversationId: 'oc_group', settings: { effort: 'low' } },
        { id: 'ops', userGroupIds: ['ops'], settings: { effort: 'high' } },
        { id: 'alice', userIds: ['alice'], settings: { effort: 'low' } },
      ],
    })
    expect(channelTaskDefaults(config, policy, event)).toEqual({ providerId: 'one', model: 'shared', effort: 'low' })
    const conflicting = parseChannelTaskConfig({
      scopes: [
        { id: 'a', userIds: ['alice'], settings: { model: 'a' } },
        { id: 'b', userIds: ['alice'], settings: { model: 'b' } },
      ],
    })
    expect(() => channelTaskDefaults(conflicting, policy, event)).toThrow('AMBIGUOUS_TASK_DEFAULTS')
    expect(channelTaskDefaults(config, policy, { ...event, actor: { ...event.actor!, userId: 'bob' } }).effort).toBe(
      'low',
    )
  })

  it('intersects global and narrower grants, actor/group and qualified model constraints; denies win', () => {
    const config = parseChannelTaskConfig({
      permissions: [
        { id: 'global', effect: 'allow', userIds: ['alice', 'bob'], fields: ['model'], providerIds: ['one'] },
        {
          id: 'group',
          effect: 'allow',
          conversationId: 'oc_group',
          userIds: ['alice'],
          userGroupIds: ['ops'],
          fields: ['model'],
          models: [{ providerId: 'one', model: 'shared' }],
          efforts: ['low'],
        },
        { id: 'deny', effect: 'deny', userIds: ['alice'], fields: ['model'], efforts: ['high'] },
      ],
    })
    const allowed = (actor: ChannelEventRef, selection: object) =>
      channelTaskChangeAllowed(config, policy, actor, { model: 'shared' }, selection)
    expect(allowed(event, { providerId: 'one', model: 'shared', effort: 'low' })).toBe(true)
    expect(
      allowed({ ...event, actor: { ...event.actor!, userId: 'bob' } }, {
        providerId: 'one',
        model: 'shared',
        effort: 'low',
      }),
    ).toBe(false)
    expect(allowed(event, { providerId: 'two', model: 'shared', effort: 'low' })).toBe(false)
    expect(allowed(event, { providerId: 'one', model: 'shared', effort: 'high' })).toBe(false)
    expect(
      channelTaskChangeAllowed(config, policy, event, { providerId: 'one' }, { providerId: 'one', model: 'shared' }),
    ).toBe(false)
    expect(
      channelTaskChangeAllowed(parseChannelTaskConfig({}), policy, event, { model: 'shared' }, {
        providerId: 'one',
        model: 'shared',
      }),
    ).toBe(false)
  })

  it('includes the model and effort implied by a provider switch in the exact authorization patch', () => {
    expect(
      resolveChannelTaskSelection(catalog, { providerId: 'one', model: 'shared', effort: 'high' }, {
        providerId: 'two',
      }),
    )
      .toEqual({
        selection: { providerId: 'two', model: 'new', effort: 'inherit' },
        patch: { providerId: 'two', model: 'new', effort: 'inherit' },
      })
    expect(() => resolveChannelTaskSelection(catalog, { providerId: 'two', model: 'new' }, { effort: 'high' })).toThrow(
      'MODEL_EFFORT_UNSUPPORTED',
    )
    expect(() =>
      resolveChannelTaskSelection([{ providerId: 'unknown', models: [{ id: 'model' }] }], {}, {
        providerId: 'unknown',
        model: 'model',
        effort: 'high',
      })
    ).toThrow('MODEL_EFFORT_UNAVAILABLE')
    expect(resolveChannelTaskSelection(
      [{ providerId: 'unknown', models: [{ id: 'model' }] }],
      { providerId: 'one', model: 'shared', effort: 'high' },
      { providerId: 'unknown' },
    )).toEqual({
      selection: { providerId: 'unknown', model: 'model', effort: 'inherit' },
      patch: { providerId: 'unknown', model: 'model', effort: 'inherit' },
    })
    expect(() =>
      resolveChannelTaskSelection([...catalog, { providerId: 'three', models: [{ id: 'shared' }] }], {}, {
        model: 'shared',
      })
    ).toThrow('AMBIGUOUS_MODEL_PROVIDER')
  })

  it('rejects credentials, blank scopes, duplicate model selectors and malformed efforts', () => {
    for (
      const value of [
        { defaults: { apiKey: 'fixture' } },
        { scopes: [{ id: 'blank', accountId: '', settings: {} }] },
        {
          permissions: [{
            id: 'duplicate',
            effect: 'allow',
            models: [{ providerId: 'one', model: 'shared' }, { providerId: 'one', model: 'shared' }],
          }],
        },
        { defaults: { effort: 'HIGH' } },
      ]
    ) expect(() => parseChannelTaskConfig(value)).toThrow()
  })
})
