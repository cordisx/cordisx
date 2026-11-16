import React, { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dom, root } from './helpers/host-react-form.js'
import { ChannelSettingsDraft } from '../packages/cli/src/renderer/channel-settings-draft.js'
import { parseChannelConversationPolicy } from '../packages/cli/src/launcher/channel-conversation-policy.js'
import { channelPolicyFormValue } from '../packages/cli/src/renderer/channel-policy-form-model.js'

let ChannelPolicyForm: typeof import('../packages/cli/src/renderer/channel-policy-form.js').ChannelPolicyForm
let ChatExecutionForm: typeof import('../packages/cli/src/renderer/chat-execution-form.js').ChatExecutionForm
let ChannelPolicyWorkflow:
  typeof import('../packages/cli/src/renderer/channel-policy-workflow.js').ChannelPolicyWorkflow
beforeEach(async () => {
  ;({ ChannelPolicyForm } = await import('../packages/cli/src/renderer/channel-policy-form.js'))
  ;({ ChatExecutionForm } = await import('../packages/cli/src/renderer/chat-execution-form.js'))
  ;({ ChannelPolicyWorkflow } = await import('../packages/cli/src/renderer/channel-policy-workflow.js'))
})
const policy = parseChannelConversationPolicy({ enabled: true, autoReply: false })
const signal = () => new AbortController().signal
function button(text: string) {
  const result = [...dom.window.document.querySelectorAll<HTMLElement>('.cxf-form-action-buttons .t-button')].find(
    item => item.textContent?.trim() === text,
  )
  expect(result).toBeDefined()
  return result!
}

describe('real Host Channel settings forms', () => {
  it('uses finite RadioGroups, distinct field/action icons, and retains creation drafts after remount', async () => {
    const draft = new ChannelSettingsDraft(), save = vi.fn(), onResult = vi.fn()
    const initial = {
      contract: 'cordisx.chat-execution-readback/v1' as const,
      schemaVersion: 1 as const,
      profileId: 'test',
      hostGeneration: 'one',
      scope: 'creation-defaults' as const,
      revision: 2,
      settings: {},
      application: 'saved' as const,
    }
    const render = () =>
      root.render(
        <ChatExecutionForm
          initial={initial}
          draft={draft}
          locale="zh-CN"
          signal={signal()}
          read={async () => initial}
          save={save}
          onResult={onResult}
        />,
      )
    await act(async () => render())
    for (const field of ['execution', 'approval', 'workMode', 'network']) {
      expect(dom.window.document.querySelector(`[data-config-path="${field}"] .t-radio-group`)).not.toBeNull()
      expect(dom.window.document.querySelector(`[data-config-path="${field}"] .t-select`)).toBeNull()
    }
    const icons = [...dom.window.document.querySelectorAll('[data-host-form-action="field-actions"] svg')]
    expect(new Set(icons.map(icon => icon.getAttribute('data-host-icon-key'))).size).toBe(5)
    const actions = ['重新读取', '撤销修改', '保存'].map(text => button(text).querySelector('svg')!)
    expect(new Set(actions.map(icon => icon.innerHTML)).size).toBe(3)
    expect(actions.every(icon => icon.getAttribute('data-host-icon-fallback') === 'none')).toBe(true)
    await act(async () => draft.change({ ...draft.snapshot().value, approval: 'never' }))
    await act(async () => root.render(null))
    await act(async () => render())
    expect(draft.snapshot().value.approval).toBe('never')
    expect(button('保存').matches(':disabled, .t-is-disabled')).toBe(false)
    expect(save).not.toHaveBeenCalled()
  })

  it('renders only the selected policy section and keeps another tabs pending changes on undo', async () => {
    const draft = new ChannelSettingsDraft(),
      save = vi.fn(async () => ({ status: 'applied' as const, code: 'APPLIED' }))
    const props = {
      policy,
      draft,
      workflowFields: true,
      locale: 'zh-CN',
      signal: signal(),
      save,
      refresh: async () => policy,
      onResult: vi.fn(),
    }
    await act(async () => root.render(<ChannelPolicyForm {...props} section="messages" />))
    expect(dom.window.document.querySelector('[data-config-path="groupReception"] .t-radio-group')).not.toBeNull()
    expect(dom.window.document.querySelector('[data-config-path="groups"]')).toBeNull()
    expect(dom.window.document.querySelector('[data-config-path="sidebarGrouping"]')).toBeNull()
    await act(async () =>
      draft.change({ ...draft.snapshot().value, autoReply: true, sidebarGrouping: 'custom', sidebarGroup: 'New group' })
    )
    await act(async () => root.render(null))
    await act(async () => root.render(<ChannelPolicyForm {...props} section="organization" />))
    expect(dom.window.document.querySelector('[data-config-path="autoReply"]')).toBeNull()
    expect(dom.window.document.querySelector('[data-config-path="sidebarGroup"] input')).not.toBeNull()
    await act(async () => button('撤销修改').click())
    expect(draft.snapshot().value.autoReply).toBe(true)
    expect(draft.snapshot().value.sidebarGrouping).toBe('inherit')
    expect(dom.window.document.querySelector('[data-config-path="sidebarGroup"]')).toBeNull()
    expect(save).not.toHaveBeenCalled()
    expect(draft.snapshot().baseline).toEqual(channelPolicyFormValue(policy, true))
  })

  it('saves one tab against the latest revision, preserves remote fields and refuses a conflicting same-tab change', async () => {
    const { registerManagedConsoleSeat } = await import('../packages/cli/src/renderer/managed-console-seats.js')
    const target = dom.window.document.createElement('div'),
      lifetime = new AbortController(),
      draft = new ChannelSettingsDraft()
    dom.window.document.body.append(target)
    registerManagedConsoleSeat(target, 'channel', lifetime.signal)
    let current = policy, revision = 1
    const run = vi.fn(async (action: string, request: Record<string, unknown>) => {
      if (action === 'policy-set') {
        expect(request.expectedRevision).toBe(revision)
        current = parseChannelConversationPolicy(request.policy)
        revision += 1
      }
      return { status: 'applied' as const, conversationPolicy: { revision, policy: current } }
    })
    const onResult = vi.fn(), authorize = vi.fn(async () => true)
    const workflow = new ChannelPolicyWorkflow({
      document: dom.window.document,
      profileId: 'test',
      hostGeneration: 'one',
      signal: lifetime.signal,
      isCurrent: () => true,
      run: run as never,
    })
    let handle: Awaited<ReturnType<typeof workflow.mount>> | undefined
    try {
      await act(async () => {
        handle = await workflow.mount(
          'channel',
          target,
          { signal: lifetime.signal, onResult },
          () => true,
          authorize,
          true,
          { draft, section: 'messages' },
        )
      })
      expect(handle?.status).toBe('mounted')
      await act(async () =>
        draft.change({
          ...draft.snapshot().value,
          autoReply: true,
          sidebarGrouping: 'custom',
          sidebarGroup: 'Other tab draft',
        })
      )
      current = parseChannelConversationPolicy({ ...current, sidebarGroup: null })
      revision = 2
      const submit = () =>
        target.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
      await act(async () => {
        submit()
      })
      expect(current).toMatchObject({ autoReply: true, sidebarGroup: null })
      expect(draft.snapshot()).toMatchObject({
        value: { sidebarGrouping: 'custom', sidebarGroup: 'Other tab draft' },
        baseline: { sidebarGrouping: 'none', sidebarGroup: '' },
        revision: 3,
      })
      expect(authorize).toHaveBeenCalledOnce()
      await act(async () => draft.change({ ...draft.snapshot().value, autoReply: false }))
      current = parseChannelConversationPolicy({ ...current, groupReception: 'all' })
      revision = 4
      await act(async () => {
        submit()
      })
      expect(run.mock.calls.filter(([action]) => action === 'policy-set')).toHaveLength(1)
      expect(onResult).toHaveBeenLastCalledWith({ status: 'conflict', code: 'REVISION_CONFLICT' })
      expect(draft.snapshot().conflict).toBe(true)
    } finally {
      await act(async () => {
        lifetime.abort()
      })
      if (handle?.status === 'mounted') await handle.closed
      target.remove()
    }
  })
})
