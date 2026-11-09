import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { click, dom, modelTrigger, providerTrigger, setup } from './fixtures/model-provider-selector-harness.js'
import { notificationCenterForDocument } from '../packages/cli/src/renderer/notifications/host.js'
import { startupObserver, startupProvider, startupSnapshot } from './helpers/startup-model-fixture.js'

const viewport = () => document.querySelector('[data-cordisx-notifications="v1"]')!
const center = () => notificationCenterForDocument(document)!
const assertSelectionOnly = () => {
  const menu = document.querySelector('.cxmp-menu')!
  expect(menu).not.toBeNull()
  const content = menu.querySelector('.cxmp-model-menu-body')!
  expect([...content.children].every(element =>
    element.matches(
      'button.cxmp-retry,button.cxmp-menu-heading,.cxmp-model-controls,button.cxmp-model-disclosure,.cxmp-model-options',
    )
  )).toBe(true)
  expect(menu.querySelector('.cxmp-startup-status,.cxmp-announcement,.cxmp-error,[role="alert"],[aria-live]'))
    .toBeNull()
  const messages =
    /Switching model service|Synchronizing model service|Reasoning effort updated|Switch incomplete|Submission or selection|Could not load|Ready|已就绪/u
  expect(menu.textContent).not.toMatch(messages)
  expect(document.querySelector('.cxmp-selector .cxmp-announcement')).toBeNull()
}
const commitReasoning = async () => {
  await click(modelTrigger)
  const slider = document.querySelector<HTMLInputElement>('input[type="range"]')!
  await act(async () => {
    slider.value = '0'
    slider.dispatchEvent(new dom!.window.Event('input', { bubbles: true }))
    slider.dispatchEvent(new dom!.window.KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }))
  })
}

describe('model menus use the notification boundary', () => {
  it('never inserts readiness or startup messages when current catalog state changes', async () => {
    const { registry } = await setup('scoped-id', false, { firstAliases: ['Friendly alias'], locale: 'zh-CN' })
    const ready = startupProvider({
      state: 'ready',
      authentication: 'authenticated',
      provider: 'published',
      catalog: { state: 'known', generation: 'catalog', modelIds: ['Friendly alias'] },
      actions: { ...startupProvider().actions, execute: { available: true } },
    })
    const source = startupObserver(startupSnapshot([ready]))
    await act(async () => registry.connectStartup(source.observer))
    await click(modelTrigger)
    expect(document.querySelector('input[type="range"]')).not.toBeNull()
    assertSelectionOnly()
    expect(viewport().querySelector('.cxn-card')).toBeNull()
    for (const [index, state] of ['ready', 'catalog-pending', 'failed', 'auth-required'].entries()) {
      await act(async () =>
        source.emit({
          kind: 'snapshot',
          reason: 'update',
          snapshot: startupSnapshot(
            [
              startupProvider({ ...ready, state: state as typeof ready.state }),
            ],
            'epoch-1',
            index + 2,
          ),
        })
      )
      assertSelectionOnly()
      expect(viewport().querySelector('.cxn-card')).toBeNull()
    }
    registry.dispose()
  })

  it.each(['busy', 'unavailable', 'throws'] as const)(
    'reports a %s selection through the common viewport without changing the menu',
    async result => {
      const { selectReasoningEffort } = await setup()
      if (result === 'throws') selectReasoningEffort.mockRejectedValueOnce(new Error('token=private-value'))
      else selectReasoningEffort.mockResolvedValueOnce(result)
      await commitReasoning()
      assertSelectionOnly()
      const notice = center().visible()[0]!
      expect(notice.options.type).toBe(result === 'busy' ? 'warning' : 'error')
      expect(viewport().textContent).toContain(result === 'busy' ? 'synchronization in progress' : 'Switch incomplete')
      expect(viewport().textContent).not.toContain('private-value')
      expect(center().visible()).toHaveLength(1)
    },
  )

  it('keeps a pending operation out of the menu and retires its notice on success', async () => {
    const { selectReasoningEffort, update } = await setup()
    let finish!: () => void
    selectReasoningEffort.mockImplementationOnce(() =>
      new Promise(resolve => {
        finish = () => resolve('accepted')
      })
    )
    await commitReasoning()
    assertSelectionOnly()
    expect(viewport().querySelector('[role="status"]')?.textContent).toContain('Switching model service')
    await update({ reasoningEffort: 'low' })
    await act(async () => finish())
    assertSelectionOnly()
    expect(center().visible().map(entry => entry.options.kind)).toEqual(['model.provider.reasoning.updated'])
  })

  it.each([
    { draft: true, busy: false, locale: 'zh-CN', message: '下次发送时使用' },
    { draft: true, busy: false, locale: 'en', message: 'Use on next Send' },
    { draft: false, busy: true, locale: 'en', message: 'Use on next Send' },
  ])('keeps truthful next-Send feedback for draft=$draft and busy=$busy ($locale)', async options => {
    const { select, update } = await setup('shared', options.busy, options)
    select.mockImplementationOnce(async target => {
      await update({ nextSend: { providerId: target.providerId, model: target.model, reasoningEffort: 'low' } })
      return 'accepted'
    })
    await click(providerTrigger)
    await click('[data-provider-id="second"]')
    await click(modelTrigger)
    assertSelectionOnly()
    expect(document.querySelector(modelTrigger)?.getAttribute('aria-label')).toContain(options.message)
    expect(viewport().querySelector('[role="status"]')?.textContent).toContain(options.message)
    expect(viewport().textContent).not.toMatch(/回复结束后|after response/u)
  })

  it('does not replay a catalog failure on polls or reopening and clears it on recovery', async () => {
    const { registry, update } = await setup()
    await click(modelTrigger)
    const snapshot = registry.snapshot()
    vi.spyOn(registry, 'snapshot').mockReturnValue({ ...snapshot, error: 'private-backend-error' })
    await update({ busy: true })
    assertSelectionOnly()
    expect(document.querySelector('.cxmp-retry')?.textContent).toBe('Refresh')
    expect(center().visible()).toHaveLength(1)
    await update({ busy: false })
    await click(modelTrigger)
    await click(modelTrigger)
    expect(center().visible()[0]?.count).toBe(1)
    expect(viewport().textContent).not.toContain('private-backend-error')
    vi.mocked(registry.snapshot).mockReturnValue(snapshot)
    await update({ busy: true })
    expect(viewport().querySelector('.cxn-card')).toBeNull()
  })

  it('deduplicates submission rejections and leaves notification rules effective', async () => {
    const { update } = await setup()
    await update({ submissionError: 'provider-switch-unsupported' })
    await click(modelTrigger)
    assertSelectionOnly()
    expect(viewport().querySelector('[role="alert"]')?.textContent).toContain('cannot change the model service')
    await update({ busy: true })
    expect(center().visible()[0]?.count).toBe(1)
    await act(async () => center().mute(center().visible()[0]!, 'kind'))
    await update({ submissionError: undefined })
    await update({ submissionError: 'provider-switch-unsupported' })
    expect(center().visible()).toHaveLength(0)
    assertSelectionOnly()
  })

  it('reports unavailable routing on user interaction once while keeping setup controls operable', async () => {
    const { update } = await setup()
    await update({ available: false })
    expect(center().visible()).toHaveLength(0)
    await click(modelTrigger)
    assertSelectionOnly()
    expect(document.querySelector('.cxmp-menu')?.textContent).not.toContain('Model services unavailable')
    expect(center().visible()[0]?.options.kind).toBe('model.provider.routing.unavailable')
    await click(modelTrigger)
    await click(modelTrigger)
    expect(center().visible()[0]?.count).toBe(1)
    await update({ available: true })
    expect(center().visible()).toHaveLength(0)
  })

  it('removes only this selector notices on navigation/unmount and ignores an old operation failure', async () => {
    const { selectReasoningEffort, update, unmount } = await setup()
    let fail!: (reason: Error) => void
    selectReasoningEffort.mockImplementationOnce(() =>
      new Promise((_resolve, reject) => {
        fail = reject
      })
    )
    await commitReasoning()
    const other = center().bind({
      key: 'other',
      pluginId: 'other',
      active: () => true,
      presentation: () => ({ name: 'Other' }),
    })
    await act(async () => {
      other.api.show({ kind: 'other.info', type: 'info', message: 'Another owner' })
    })
    await update({ threadId: 't2' })
    await act(async () => fail(new Error('Old operation failed')))
    expect(center().visible().map(entry => entry.options.kind)).toEqual(['other.info'])
    await update({ submissionError: 'submission-rejected' })
    await unmount()
    expect(center().visible().map(entry => entry.options.kind)).toEqual(['other.info'])
    await act(async () => other.dispose())
  })

  it('never rebuilds an inline alert when notification support is absent', async () => {
    const { selectReasoningEffort } = await setup('shared', false, { notifications: false })
    selectReasoningEffort.mockRejectedValueOnce(new Error('private failure'))
    await commitReasoning()
    assertSelectionOnly()
    expect(document.querySelector('[role="alert"],.cxmp-announcement,[data-cordisx-notifications]')).toBeNull()
  })
})
