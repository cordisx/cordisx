import React, { act } from 'react'
import { expect, it, vi } from 'vitest'
import type { MarketplaceModel } from '../packages/cli/src/renderer/marketplace.js'
import { ModelProviderRegistry } from '../packages/cli/src/renderer/model-providers.js'
import { HostManagerNavigationController } from '../packages/cli/src/renderer/manager/navigation-controller.js'
import { managerModel, reactManagerFixture } from './helpers/react-manager.js'
import { catalogFixture, catalogView } from './helpers/catalog-management-fixture.js'
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

it('rejects non-Responses drafts for Codex creation while retaining generic protocol schemas', async () => {
  const { connectionSchema } = await import(
    '../packages/cli/src/renderer/manager/pages/model-catalog/connection-schema.js'
  )
  const draft = {
    title: 'Fixture',
    endpoint: 'https://fixture.invalid',
    protocol: 'chat-completions' as const,
    source: 'manual' as const,
    models: [{ id: 'model-a', label: 'Fixture model' }],
    emptyConfirmed: false,
    discoveryEnabled: false,
  }
  const fixed = connectionSchema('en', draft, true)
  const rejected = await fixed['~standard'].validate(draft)
  expect(rejected.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: ['protocol'] })]))
  expect((await fixed['~standard'].validate({ ...draft, protocol: 'responses' })).issues).toBeUndefined()
  expect((await connectionSchema('en', draft)['~standard'].validate(draft)).issues).toBeUndefined()
})

it('preserves a legacy connection protocol when editing through the shared editor', async () => {
  const fixture = reactManagerFixture()
  const { ConnectionEditor } = await import(
    '../packages/cli/src/renderer/manager/pages/model-catalog/ConnectionEditor.js'
  )
  const save = vi.fn(async () => ({ status: 'applied' as const }))
  const close = vi.fn()
  try {
    await fixture.render(<ConnectionEditor view={catalogView()} locale="en" responsesOnly save={save} close={close} />)
    expect(fixture.document.querySelector('[data-config-path="protocol"]')).not.toBeNull()
    await fixture.click('.cxmc-editor-actions button:last-child')
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ protocol: 'chat-completions' }), '1')
    expect(close).toHaveBeenCalledOnce()
  } finally {
    await fixture.dispose()
  }
})
