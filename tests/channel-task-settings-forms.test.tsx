import React, { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dom, root } from './helpers/host-react-form.js'
import { ChannelSettingsDraft } from '../packages/cli/src/renderer/channel-settings-draft.js'
import { registerManagedConsoleSeat } from '../packages/cli/src/renderer/managed-console-seats.js'

let ChannelTaskSettingsForm:
  typeof import('../packages/cli/src/renderer/channel-task-settings-form.js').ChannelTaskSettingsForm
let ChannelTaskSettingsWorkflow:
  typeof import('../packages/cli/src/renderer/channel-task-settings-workflow.js').ChannelTaskSettingsWorkflow
beforeEach(async () => {
  ;({ ChannelTaskSettingsForm } = await import('../packages/cli/src/renderer/channel-task-settings-form.js'))
  ;({ ChannelTaskSettingsWorkflow } = await import('../packages/cli/src/renderer/channel-task-settings-workflow.js'))
})
const providers = [{
  providerId: 'one',
  title: 'Provider one',
  models: [{ id: 'model-one', reasoningCapabilities: { efforts: ['low', 'high'] } }],
}, {
  providerId: 'two',
  title: 'Provider two',
  models: [{ id: 'model-two', reasoningCapabilities: { efforts: ['low'] } }],
}]

describe('Host Channel model settings forms', () => {
  it('presents admitted choices and saves a changed effort through the real filled radio control', async () => {
    const initial = { revision: 4, settings: { providerId: 'one', model: 'model-one', effort: 'low' }, providers }
    const save = vi.fn(async (settings, revision) => ({ ...initial, settings, revision: revision + 1 }))
    const onResult = vi.fn(), draft = new ChannelSettingsDraft()
    await act(async () =>
      root.render(
        <ChannelTaskSettingsForm
          initial={initial}
          locale="zh-CN"
          signal={new AbortController().signal}
          draft={draft}
          read={async () => initial}
          save={save}
          onResult={onResult}
        />,
      )
    )
    expect(dom.window.document.querySelector('[data-config-path="providerId"] .t-select')).not.toBeNull()
    expect(dom.window.document.querySelector('[data-config-path="model"] .t-select')).not.toBeNull()
    const group = dom.window.document.querySelector('[data-config-path="effort"] .t-radio-group')!
    expect(group.className).toContain('filled')
    const high = [...group.querySelectorAll<HTMLElement>('.t-radio-button')].find(item =>
      item.textContent?.trim() === '高'
    )!
    expect(high).toBeDefined()
    await act(async () => high.click())
    await act(async () =>
      dom.window.document.querySelector('form')!.dispatchEvent(
        new dom.window.Event('submit', { bubbles: true, cancelable: true }),
      )
    )
    expect(save).toHaveBeenCalledExactlyOnceWith({ providerId: 'one', model: 'model-one', effort: 'high' }, 4)
    expect(draft.snapshot()).toMatchObject({ revision: 5, conflict: false, baseline: { effort: 'high' } })
    expect(onResult).toHaveBeenLastCalledWith({ status: 'applied', code: 'SAVED' })
  })

  it('saves through the production workflow with CAS and retains a conflicting draft without replaying it', async () => {
    const target = dom.window.document.createElement('div'),
      lifetime = new AbortController(),
      draft = new ChannelSettingsDraft()
    dom.window.document.body.append(target)
    registerManagedConsoleSeat(target, 'channel', lifetime.signal)
    let revision = 7, settings = { providerId: 'one', model: 'model-one', effort: 'low' }
    const run = vi.fn(async (operation: string, input: Record<string, unknown>) => {
      if (operation === 'model-list') return { status: 'applied', task: { providers } }
      if (operation === 'task-settings-set') {
        if (input.expectedRevision !== revision) return { status: 'rejected', code: 'REVISION_CONFLICT' }
        settings = input.settings as typeof settings
        revision += 1
      }
      return { status: 'applied', task: { revision, settings, application: 'saved' } }
    })
    const authorize = vi.fn(async () => true), onResult = vi.fn()
    const workflow = new ChannelTaskSettingsWorkflow({
      document: dom.window.document,
      lifetime: lifetime.signal,
      live: () => true,
      run: run as never,
    })
    let handle: Awaited<ReturnType<typeof workflow.mount>> | undefined
    const submit = () =>
      target.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    try {
      await act(async () => {
        handle = await workflow.mount({
          target,
          owner: 'channel',
          sessionId: 'chat',
          options: { signal: lifetime.signal, onResult },
          draft,
          live: () => true,
          authorize,
        })
      })
      expect(handle?.status).toBe('mounted')
      await act(async () => draft.change({ ...draft.snapshot().value, effort: 'high' }))
      await act(async () => {
        submit()
      })
      expect(run).toHaveBeenCalledWith('task-settings-set', {
        sessionId: 'chat',
        expectedRevision: 7,
        settings: { providerId: 'one', model: 'model-one', effort: 'high' },
      })
      expect(draft.snapshot()).toMatchObject({ revision: 8, baseline: { effort: 'high' } })
      revision = 9
      await act(async () => draft.change({ ...draft.snapshot().value, effort: 'low' }))
      await act(async () => {
        submit()
      })
      expect(onResult).toHaveBeenLastCalledWith({ status: 'conflict', code: 'REVISION_CONFLICT' })
      expect(draft.snapshot()).toMatchObject({ revision: 8, conflict: true, value: { effort: 'low' } })
      await act(async () => {
        submit()
      })
      expect(run.mock.calls.filter(([operation]) => operation === 'task-settings-set')).toHaveLength(2)
      expect(authorize).toHaveBeenCalledTimes(2)
      expect(target.querySelector('.cxf-form-actions [type="submit"]')?.matches(':disabled, .t-is-disabled')).toBe(true)
    } finally {
      await act(async () => lifetime.abort())
      if (handle?.status === 'mounted') await handle.closed
      target.remove()
    }
  })
})
