import React, { act } from 'react'
import { expect, it, vi } from 'vitest'
import { dom, edit, field, input, plugin, root, submit } from './helpers/host-react-form.js'

// Catch a business page replacing the canonical renderer: no mocked HostForm or synthetic page shell.
it('edits through the production plugin configuration entry and reopens authoritative saved values', async () => {
  const { managerModel, managerRouter, managerSnapshot } = await import('./helpers/react-manager.js')
  const { PluginDetailPage } = await import('../packages/cli/src/renderer/manager/pages/PluginDetailPage.js')
  let stored = { name: 'initial', revision: 1 }
  const update = vi.fn(async (_id: string, _revision: number, mutations: readonly { value?: unknown }[]) => {
    stored = { name: `${mutations[0]!.value} by writer`, revision: stored.revision + 1 }
  })
  const router = managerRouter({ kind: 'plugin', pluginId: 'fixture', page: 'config' })
  const route = { kind: 'plugin', pluginId: 'fixture', page: 'config' } as const
  const render = async () => {
    const record = {
      ...plugin([field('name', { value: stored.name, required: true })], stored.revision),
      name: 'Fixture',
      source: 'file:///fixture.ts',
      status: 'active' as const,
      inject: [],
      config: {},
    }
    const snapshot = managerSnapshot({ plugins: [record] })
    const model = managerModel(snapshot, { updatePluginConfig: update })
    await act(async () =>
      root.render(<PluginDetailPage model={model} snapshot={snapshot} plugin={record} route={route} router={router} />)
    )
  }
  await render()
  expect(dom.window.document.querySelectorAll('[data-plugin-config-form]')).toHaveLength(1)
  expect(input('name').closest('.t-input')).not.toBeNull()
  await edit('name', 'saved')
  await submit()
  expect(update).toHaveBeenCalledExactlyOnceWith('fixture', 1, [{ op: 'set', path: ['name'], value: 'saved' }])
  await act(async () => root.render(null))
  // The next projection can differ from the local draft after server normalization.
  await render()
  expect(input('name').value).toBe('saved by writer')
  expect(dom.window.document.querySelector('[data-plugin-config-form]')?.getAttribute('data-state')).toBe('pristine')
  expect(dom.window.document.querySelector('[role="dialog"], dialog')).toBeNull()
})
