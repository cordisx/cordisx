import React, { act } from 'react'
import { expect, it } from 'vitest'
import { ModelProviderRegistry } from '../packages/cli/src/renderer/model-providers.js'
import { ModelServicesPage } from '../packages/cli/src/renderer/manager/pages/ModelServicesPage.js'
import { reactManagerFixture } from './helpers/react-manager.js'
import { startupObserver, startupProvider, startupSnapshot } from './helpers/startup-model-fixture.js'
import { catalogFixture, catalogView } from './helpers/catalog-management-fixture.js'

it('shows pending service identity under the default selectable filter and retains inline connection status', async () => {
  const fixture = reactManagerFixture()
  const source = startupObserver()
  const registry = new ModelProviderRegistry(async () => [])
  registry.connectStartup(source.observer)
  try {
    await fixture.render(<ModelServicesPage registry={registry} locale="en" />)
    expect(fixture.element('.cxms-provider-identity').textContent).toContain('first')
    expect(fixture.element('.cxms-provider').textContent).toContain('Loading models')
    expect(fixture.element('.cxmp-management').textContent).not.toContain('No connections')
    await act(async () => source.emit({ kind: 'connection', connection: { state: 'reconnecting', reason: 'timeout' } }))
    expect(fixture.element('.cxms-provider').textContent).toContain('Reconnecting')
  } finally {
    registry.dispose()
    await fixture.dispose()
  }
})

it('gates declared retry while keeping catalog preference controls and navigation usable', async () => {
  const fixture = reactManagerFixture()
  const source = startupObserver(startupSnapshot([startupProvider({ state: 'auth-required' })]))
  const host = catalogFixture([catalogView({ providerId: 'first' })])
  const registry = new ModelProviderRegistry(async () => [{ providerId: 'first', pluginId: 'p', models: [] }])
  registry.management = host.client
  registry.connectStartup(source.observer)
  await host.client.refresh()
  try {
    await fixture.render(<ModelServicesPage registry={registry} locale="en" />)
    expect(fixture.element('.cxmc-binding').textContent).toContain('Sign in required')
    expect((fixture.element('[aria-label="Refresh models: Provider A"]') as HTMLButtonElement).disabled).toBe(true)
    expect((fixture.element('[aria-label="Diagnostics: Provider A"]') as HTMLButtonElement).disabled).toBe(false)
  } finally {
    registry.dispose()
    await fixture.dispose()
  }
})
