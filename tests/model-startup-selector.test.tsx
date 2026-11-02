import { act } from 'react'
import { describe, expect, it } from 'vitest'
import { click, providerTrigger, setup } from './fixtures/model-provider-selector-harness.js'
import { startupObserver, startupProvider, startupSnapshot } from './helpers/startup-model-fixture.js'

describe('model selector startup states', () => {
  it('keeps pending provider intent across epoch resets without dispatching or falling back', async () => {
    const { registry, select } = await setup()
    const source = startupObserver()
    await act(async () => registry.connectStartup(source.observer))
    expect(document.querySelector('[data-cordisx-model-selector-ready="true"]')).not.toBeNull()
    await click(providerTrigger)
    const row = document.querySelector<HTMLButtonElement>('[data-provider-id="first"]')!
    expect(row.disabled).toBe(false)
    expect(row.textContent).toContain('Loading models')
    await click('[data-provider-id="first"]')
    expect(select).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Selected · waiting for models')
    await act(async () =>
      source.emit({ kind: 'snapshot', reason: 'epoch-changed', snapshot: startupSnapshot([], 'next') })
    )
    expect(document.querySelector(providerTrigger)?.getAttribute('aria-label')).toContain('first')
    expect(select).not.toHaveBeenCalled()
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
