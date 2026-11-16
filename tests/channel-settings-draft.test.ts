import { describe, expect, it } from 'vitest'
import { ChannelSettingsDraft } from '../packages/cli/src/renderer/channel-settings-draft.js'
import {
  channelPolicyFormValue,
  channelPolicySectionChanged,
  mergeChannelPolicySection,
} from '../packages/cli/src/renderer/channel-policy-form-model.js'
import {
  channelPolicyFormSchema,
  normalizeChannelPolicyForm,
} from '../packages/cli/src/renderer/channel-policy-prompt.js'
import { parseChannelConversationPolicy } from '../packages/cli/src/launcher/channel-conversation-policy.js'

describe('Channel settings draft and policy section isolation', () => {
  it('retains other tabs while refreshing, saving and undoing one section', () => {
    const draft = new ChannelSettingsDraft()
    draft.initialize({ autoReply: false, rules: [], sidebarGrouping: 'inherit', sidebarGroup: '' }, 1)
    draft.change({ ...draft.snapshot().value, autoReply: true, rules: [{ id: 'local' }] })
    draft.initialize({ autoReply: false, rules: [{ id: 'remote' }] }, 2)
    expect(draft.snapshot().value.rules).toEqual([{ id: 'local' }])
    draft.refresh({ autoReply: false, rules: [], sidebarGrouping: 'custom', sidebarGroup: 'Server group' }, 2)
    expect(draft.snapshot().value).toMatchObject({
      autoReply: true,
      rules: [{ id: 'local' }],
      sidebarGroup: 'Server group',
    })
    draft.commitFields({ autoReply: true, rules: [], sidebarGrouping: 'custom', sidebarGroup: 'Server group' }, 3, [
      'autoReply',
    ])
    expect(draft.snapshot().value.rules).toEqual([{ id: 'local' }])
    expect(draft.snapshot().baseline.rules).toEqual([])
    draft.change({ ...draft.snapshot().value, autoReply: false })
    draft.resetFields(['rules'])
    expect(draft.snapshot().value).toMatchObject({ autoReply: false, rules: [] })
    expect(draft.snapshot().revision).toBe(3)
    draft.markConflict()
    draft.refresh({ autoReply: true, rules: [] }, 4)
    expect(draft.snapshot().conflict).toBe(false)
    expect(draft.snapshot().value.autoReply).toBe(false)
  })

  it('maps inherited, custom and disabled grouping back to the existing store', () => {
    for (
      const [mode, value, expected] of [['inherit', '', undefined], ['none', '', null], [
        'custom',
        ' Team ',
        'Team',
      ]] as const
    ) {
      const policy = normalizeChannelPolicyForm({ sidebarGrouping: mode, sidebarGroup: value })
      expect(policy).not.toHaveProperty('sidebarGrouping')
      expect(policy.sidebarGroup).toBe(expected)
      expect(channelPolicyFormValue(parseChannelConversationPolicy(policy), true).sidebarGrouping).toBe(mode)
    }
    expect(normalizeChannelPolicyForm({ sidebarGroup: null }).sidebarGroup).toBeNull()
    expect(
      channelPolicyFormSchema(true, true, true, 'organization')['~standard'].validate({
        sidebarGrouping: 'custom',
        sidebarGroup: ' ',
      }),
    ).toHaveProperty('issues')
    expect(
      channelPolicyFormSchema(true, true, true, 'organization')['~standard'].validate({
        sidebarGrouping: 'none',
        sidebarGroup: '',
      }),
    ).not.toHaveProperty('issues')
  })

  it('does not replace newer draft edits with an earlier completed save', () => {
    const draft = new ChannelSettingsDraft()
    draft.initialize({ autoReply: false, rules: [] }, 1)
    draft.change({ autoReply: true, rules: [] })
    const submitted = draft.snapshot().value
    draft.change({ autoReply: false, rules: [{ id: 'later' }] })
    draft.commitFields({ autoReply: true, rules: [] }, 2, ['autoReply'], submitted)
    expect(draft.snapshot()).toMatchObject({
      value: { autoReply: false, rules: [{ id: 'later' }] },
      baseline: { autoReply: true, rules: [] },
    })
  })

  it('merges against latest policy without persisting other tabs drafts and detects same-section changes', () => {
    const baseline = parseChannelConversationPolicy({ autoReply: false, sidebarGroup: 'Old' })
    const latest = parseChannelConversationPolicy({ ...baseline, sidebarGroup: null })
    const submitted = normalizeChannelPolicyForm({
      ...channelPolicyFormValue(baseline, true),
      autoReply: true,
      groups: [{ id: 'unsaved-other-tab', members: [] }],
    })
    const merged = mergeChannelPolicySection(latest, submitted, 'messages')
    expect(merged).toMatchObject({ autoReply: true, sidebarGroup: null, groups: [] })
    expect(merged).not.toHaveProperty('sidebarGrouping')
    expect(channelPolicySectionChanged(latest, channelPolicyFormValue(baseline, true), 'messages')).toBe(false)
    expect(channelPolicySectionChanged(latest, channelPolicyFormValue(baseline, true), 'organization')).toBe(true)
  })
})
