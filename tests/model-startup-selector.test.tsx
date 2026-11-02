import { act } from 'react'
import { describe, expect, it } from 'vitest'
import { click, providerTrigger, setup } from './fixtures/model-provider-selector-harness.js'
import { startupObserver, startupProvider, startupSnapshot } from './helpers/startup-model-fixture.js'

describe('model selector startup states', () => {
  it('keeps pending provider intent across epoch resets without dispatching or falling back', async () => {
    const { registry, select, selectProviderIntent } = await setup('shared', false, {
      firstProviderTitle: 'Current provider',
    })
    const source = startupObserver()
    await act(async () => registry.connectStartup(source.observer))
    expect(document.querySelector('[data-cordisx-model-selector-ready="true"]')).not.toBeNull()
    await click(providerTrigger)
    const row = document.querySelector<HTMLButtonElement>('[data-provider-id="first"]')!
    expect(row.disabled).toBe(false)
    expect(row.textContent).toContain('Loading models')
    await click('[data-provider-id="first"]')
    expect(selectProviderIntent).toHaveBeenCalledWith('first')
    expect(select).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Selected · waiting for models')
    await act(async () =>
      source.emit({ kind: 'snapshot', reason: 'epoch-changed', snapshot: startupSnapshot([], 'next') })
    )
    expect(document.querySelector(providerTrigger)?.getAttribute('aria-label')).toContain('first')
    expect(document.querySelector(providerTrigger)?.getAttribute('aria-label')).not.toContain('Current provider')
    expect(select).not.toHaveBeenCalled()
    registry.dispose()
  })

  it('does not display an accepted intent when Host rejects staging it', async () => {
    const { registry, select } = await setup('shared', false, { providerIntentResult: 'unavailable' })
    const source = startupObserver()
    await act(async () => registry.connectStartup(source.observer))
    await click(providerTrigger)
    await click('[data-provider-id="first"]')
    expect(document.body.textContent).not.toContain('Selected · waiting for models')
    expect(select).not.toHaveBeenCalled()
    registry.dispose()
  })

  it('keeps Host intent when catalog becomes ready and clears only after explicit cancel', async () => {
    const { registry, select, cancelProviderIntent } = await setup()
    const source = startupObserver()
    await act(async () => registry.connectStartup(source.observer))
    await click(providerTrigger)
    await click('[data-provider-id="first"]')
    await act(async () =>
      source.emit({
        kind: 'snapshot',
        reason: 'update',
        snapshot: startupSnapshot(
          [
            startupProvider({
              state: 'ready',
              catalog: { state: 'known', generation: 'catalog', modelIds: ['shared'] },
              actions: {
                execute: { available: true },
                authenticate: { available: false, reason: 'unsupported' },
                retry: { available: false, reason: 'unsupported' },
              },
            }),
          ],
          'epoch-1',
          2,
        ),
      })
    )
    expect(select).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Selected · waiting for models')
    await click('button.cxmp-menu-heading')
    expect(cancelProviderIntent).toHaveBeenCalledOnce()
    expect(document.body.textContent).not.toContain('Selected · waiting for models')
    registry.dispose()
  })

  it('clears intent only when an explicit catalog model receives Host acknowledgement', async () => {
    const { registry, select } = await setup()
    const source = startupObserver()
    await act(async () => registry.connectStartup(source.observer))
    await click(providerTrigger)
    await click('[data-provider-id="first"]')
    await act(async () =>
      source.emit({
        kind: 'snapshot',
        reason: 'update',
        snapshot: startupSnapshot(
          [
            startupProvider({
              state: 'ready',
              catalog: { state: 'known', generation: 'catalog', modelIds: ['shared'] },
              actions: {
                execute: { available: true },
                authenticate: { available: false, reason: 'unsupported' },
                retry: { available: false, reason: 'unsupported' },
              },
            }),
          ],
          'epoch-1',
          2,
        ),
      })
    )
    expect(document.querySelector('[data-cordisx-model-send-eligible="false"]')).not.toBeNull()
    await click('.cxmp-model-disclosure')
    await click('.cxmp-model-choice')
    expect(select).toHaveBeenCalledWith({ providerId: 'first', model: 'shared' })
    expect(document.body.textContent).not.toContain('Selected · waiting for models')
    registry.dispose()
  })

  it.each(
    [
      ['auth-required', 'Sign in required'],
      ['catalog-pending', 'Loading models'],
      ['failed', 'Service failed'],
      ['stopped', 'Service stopped'],
      ['unknown', 'Status unknown'],
    ] as const,
  )('discloses %s inline', async (state, label) => {
    const { registry } = await setup()
    const source = startupObserver(startupSnapshot([startupProvider({ state })]))
    await act(async () => registry.connectStartup(source.observer))
    await click(providerTrigger)
    expect(document.querySelector('[data-provider-id="first"]')?.textContent).toContain(label)
    registry.dispose()
  })
})
