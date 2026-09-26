import React, { act } from 'react'
import { expect, it, vi } from 'vitest'
import type { MarketplaceModel } from '../packages/cli/src/renderer/marketplace.js'
import { ModelProviderRegistry } from '../packages/cli/src/renderer/model-providers.js'
import { HostManagerNavigationController } from '../packages/cli/src/renderer/manager/navigation-controller.js'
import { managerModel, reactManagerFixture } from './helpers/react-manager.js'
import { catalogFixture } from './helpers/catalog-management-fixture.js'
import type { CatalogManagementResult } from '../packages/cli/src/model-catalog-management.js'

vi.mock('../packages/cli/src/renderer/host-ui/BrandMark.js', () => ({
  BrandMark: () => <span />,
  createBrandMarkElement: (document: Document) => document.createElement('span'),
}))

it('keeps the destination when a departed creation page finishes saving', async () => {
  const fixture = reactManagerFixture()
  const { ManagerApp } = await import('../packages/cli/src/renderer/manager/ManagerApp.js')
  const host = catalogFixture([])
  const registry = new ModelProviderRegistry(async () => [])
  registry.management = host.client
  const navigation = new HostManagerNavigationController()
  let complete!: (result: CatalogManagementResult) => void
  const saving = new Promise<CatalogManagementResult>(resolve => {
    complete = resolve
  })
  const command = vi.spyOn(host.channel, 'catalogManagementCommand').mockReturnValue(saving)
  const seat = fixture.document.createElement('span')
  fixture.document.body.append(seat)
  try {
    await host.client.refresh()
    await fixture.render(
      <ManagerApp
        model={managerModel(undefined, { modelProviders: registry })}
        marketplace={{} as MarketplaceModel}
        triggerSeat={seat}
        navigationController={navigation}
      />,
    )
    await act(async () => navigation.openRoute({ kind: 'primary', page: 'model-services' }))
    await fixture.click('[aria-label="Add model connection"]')
    await fixture.type('[data-config-path="title"] input', 'Deferred fixture')
    await fixture.type('[data-config-path="endpoint"] input', 'https://fixture.invalid/v1')
    await fixture.click('[data-config-path="emptyConfirmed"] input')
    await fixture.click('.cxmc-editor-actions button:last-child')
    expect(command).toHaveBeenCalledOnce()
    expect((fixture.element('.cxmc-editor-actions button:first-child') as HTMLButtonElement).disabled).toBe(true)
    await fixture.click('.cxr-header [aria-label="Back"]')
    await fixture.click('[data-tab="routes"]')
    expect(fixture.element('.cxr-heading').textContent).toBe('Routes')
    await act(async () => {
      complete({ status: 'applied' })
      await host.client.refresh()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(fixture.element('.cxr-heading').textContent).toBe('Routes')
    expect(fixture.document.querySelector('[data-model-connection-create]')).toBeNull()
  } finally {
    complete({ status: 'applied' })
    registry.dispose()
    await fixture.dispose()
  }
})
