import { act } from 'react'
import { describe, expect, it } from 'vitest'
import type { StartupProjectionV1 } from '@cordisx/protocol/startup/v1'
import { click, providerTrigger, setup } from './fixtures/model-provider-selector-harness.js'
import { startupObserver, startupProvider, startupSnapshot } from './helpers/startup-model-fixture.js'

const sendEligible = () => document.querySelector('.cxmp-selector')?.getAttribute('data-cordisx-model-send-eligible')
const row = () => document.querySelector<HTMLButtonElement>('[data-provider-id="first"]')
const ready = (authentication: StartupProjectionV1['authentication'] = 'authenticated') =>
  startupProvider({
    state: 'ready',
    authentication,
    provider: 'published',
    catalog: { state: 'known', generation: 'catalog', modelIds: ['Friendly alias'] },
    actions: {
      ...startupProvider().actions,
      execute: { available: true },
    },
  })

describe('model selector startup states', () => {
  it.each(['authenticated', 'not-required'] as const)(
    'lists only exact catalog members with authentication %s',
    async authentication => {
      const { registry, select } = await setup('scoped-id', false, {
        firstModels: [
          { id: 'scoped-id', label: 'Current model', aliases: ['Friendly alias'] },
          { id: 'other-id', label: 'Stale model' },
        ],
        additionalProviders: [{ providerId: 'empty', title: 'Empty service', models: [] }],
      })
      const source = startupObserver(startupSnapshot([ready(authentication)]))
      await act(async () => registry.connectStartup(source.observer))
      expect(sendEligible()).toBe('true')
      await click(providerTrigger)
      expect(document.querySelector('[data-provider-id="empty"]')).toBeNull()
      expect(row()?.disabled).toBe(false)
      await click('[data-provider-id="first"]')
      expect(select).toHaveBeenCalledWith({ providerId: 'first', model: 'scoped-id' })
      registry.dispose()
    },
  )

  it.each(
    [
      ['authenticating', 'authentication-required'],
      ['failed', 'authentication-required'],
      ['logged-out', 'authentication-required'],
      ['authenticated', 'catalog-empty'],
      ['authenticated', 'catalog-pending'],
      ['authenticated', 'failed'],
    ] as const,
  )('withdraws %s / %s without changing the current selection', async (authentication, reason) => {
    const { registry, select } = await setup('scoped-id', false, {
      firstProviderTitle: 'Current service',
      firstAliases: ['Friendly alias'],
    })
    const source = startupObserver(startupSnapshot([ready()]))
    await act(async () => registry.connectStartup(source.observer))
    await click(providerTrigger)
    expect(row()).not.toBeNull()
    const unavailable = startupProvider({
      authentication,
      catalog: reason === 'catalog-empty'
        ? { state: 'known', generation: 'catalog', modelIds: [] }
        : { state: 'pending' },
      actions: { ...ready().actions, execute: { available: false, reason } },
    })
    await act(async () =>
      source.emit({ kind: 'snapshot', reason: 'update', snapshot: startupSnapshot([unavailable], 'epoch-1', 2) })
    )
    expect(row()).toBeNull()
    expect(sendEligible()).toBe('false')
    expect(document.querySelector(providerTrigger)?.getAttribute('aria-label')).toContain('Current service')
    expect(select).not.toHaveBeenCalled()
    registry.dispose()
  })

  it('keeps a historical intent across replacement and lets the user cancel it', async () => {
    const { registry, select, cancelProviderIntent, update } = await setup()
    const source = startupObserver()
    await act(async () => registry.connectStartup(source.observer))
    await update({ pendingProviderIntent: { providerId: 'first', generation: 1 } })
    await act(async () =>
      source.emit({ kind: 'snapshot', reason: 'epoch-changed', snapshot: startupSnapshot([], 'replacement') })
    )
    expect(sendEligible()).toBe('false')
    expect(document.querySelector(providerTrigger)?.getAttribute('aria-label')).toContain('first')
    expect(select).not.toHaveBeenCalled()
    await click('.cxmp-model-trigger')
    await click('button.cxmp-menu-heading')
    expect(cancelProviderIntent).toHaveBeenCalledOnce()
    registry.dispose()
  })
})
