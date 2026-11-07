// Run against the exact assembled L candidate with native-startup-selection.config.mjs.
// Actual client/channel/controller; native resources remain deterministic fixtures.
import React, { act } from 'react'
import { expect, it } from 'vitest'
import {
  ModelProviderSelector,
  type ProviderSelectionSnapshot,
} from '../packages/cli/src/renderer/model-provider-selector.js'
import { ModelProviderRegistry } from '../packages/cli/src/renderer/model-providers.js'
import { NativeProviderSelectionClient } from '../packages/cli/src/renderer/native-provider-selection-client.js'
import { harness } from './fixtures/native-submission-channel-harness.js'
import { reactManagerFixture } from './helpers/react-manager.js'
import { startupObserver, startupProvider, startupSnapshot } from './helpers/startup-model-fixture.js'

it('lists only executable providers and rechecks the selected model through the Host client and Send channel', async () => {
  const fixture = reactManagerFixture()
  const native = { providerId: 'openai', model: 'native-model' }
  let ready = false
  const catalog = [{
    providerId: 'first',
    pluginId: 'p',
    label: 'First service',
    models: [{ id: 'real-model', label: 'Real model' }],
  }]
  const h = await harness({ realController: true, catalog: () => ready ? catalog : [] })
  const client = new NativeProviderSelectionClient(
    h.channel,
    () => ({ scope: h.draft, idle: true, effective: native }),
    () => {},
    async () => {},
  )
  const registry = new ModelProviderRegistry(async () => ready ? catalog : [])
  const source = startupObserver()
  registry.connectStartup(source.observer)
  let projection: ProviderSelectionSnapshot = { available: false, busy: false }
  const listeners = new Set<() => void>()
  const update = () => {
    const state = client.snapshot()
    projection = {
      available: state.available,
      busy: false,
      ...(state.effective ? { modelProvider: state.effective.providerId, model: state.effective.model } : {}),
      ...(state.pendingProviderIntent ? { pendingProviderIntent: state.pendingProviderIntent } : {}),
      ...(state.pending ? { pendingProviderId: state.pending.providerId, pendingModel: state.pending.model } : {}),
    }
    for (const listener of listeners) listener()
  }
  const detach = client.subscribe(update)
  const transport = {
    getSnapshot: () => projection,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    select: (target: { providerId: string; model: string }) => client.select(target),
    cancelProviderIntent: () => client.cancelProviderIntent(),
    selectReasoningEffort: async () => 'unavailable' as const,
    selectFastMode: async () => 'unavailable' as const,
  }
  const click = async (selector: string) => {
    const button = fixture.element(selector) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    await act(async () => {
      button.click()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }
  const send = { target: 'local', response: false, promptOverride: false }
  const submit = async () => {
    let result: Awaited<ReturnType<typeof client.submitHook>> | undefined
    await act(async () => {
      result = await client.submitHook(send)
    })
    return result
  }
  const scopeIntent = () => h.authority.selection.snapshot(h.draft).pendingProviderIntent
  try {
    await client.refresh()
    update()
    await fixture.render(<ModelProviderSelector registry={registry} transport={transport} locale="en" />)
    await click('.cxmp-provider-trigger')
    expect(document.querySelector('[data-provider-id="first"]')).toBeNull()
    await act(async () => {
      expect(await client.selectProviderIntent('first')).toBe('accepted')
    })
    expect(scopeIntent()?.providerId).toBe('first')
    expect(await submit()).toEqual({ allow: false })
    expect(h.prepare).not.toHaveBeenCalled()
    expect(h.switchThread).not.toHaveBeenCalled()
    await click('.cxmp-model-trigger')
    await click('button.cxmp-menu-heading')
    expect(scopeIntent()).toBeUndefined()
    expect(client.snapshot().effective).toEqual(native)

    await act(async () => {
      ready = true
      source.emit({
        kind: 'snapshot',
        reason: 'update',
        snapshot: startupSnapshot(
          [startupProvider({
            state: 'ready',
            provider: 'published',
            catalog: { state: 'known', generation: 'catalog', modelIds: ['real-model'] },
            actions: {
              execute: { available: true },
              authenticate: { available: false, reason: 'unsupported' },
              retry: { available: false, reason: 'unsupported' },
            },
          })],
          'epoch-1',
          2,
        ),
      })
      await registry.refresh()
      await client.refresh()
    })
    await click('[data-provider-id="first"]')
    expect(scopeIntent()).toBeUndefined()
    expect(client.snapshot().pending).toMatchObject({ providerId: 'first', model: 'real-model' })
    expect(await submit()).toMatchObject({ allow: true })
    expect(h.prepare).toHaveBeenCalledOnce()
    await act(async () => {
      ready = false
      source.emit({
        kind: 'snapshot',
        reason: 'update',
        snapshot: startupSnapshot([startupProvider({ authentication: 'logged-out' })], 'epoch-1', 3),
      })
      await registry.refresh()
    })
    expect(fixture.element('.cxmp-selector').dataset.cordisxModelSendEligible).toBe('false')
    expect(await submit()).toEqual({ allow: false })
    expect(client.snapshot().pending).toMatchObject({ providerId: 'first', model: 'real-model' })
    expect(h.prepare).toHaveBeenCalledOnce()
  } finally {
    detach()
    client.dispose()
    registry.dispose()
    await fixture.dispose()
    await h.installed.dispose()
    await h.actual.dispose()
  }
})
