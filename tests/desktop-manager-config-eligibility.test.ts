import { expect, it, vi } from 'vitest'
import {
  DesktopConfiguredSelection,
  prepareDesktopConfiguredConfigWrites,
} from '../packages/cli/src/cli/desktop-manager-config-eligibility.js'

it('adopts only a confirmed change from the current Desktop configured selection', () => {
  const original: any = [{ id: 'demo', revision: 1, config: { label: 'old' } }]
  const next: any = [{ id: 'demo', revision: 2, config: { label: 'new' } }]
  const selection = new DesktopConfiguredSelection(original)
  original[0].config.label = 'mutated outside owner'
  expect(selection.matches(original)).toBe(false)
  expect(selection.adopt(original, next)).toBe(false)
  const before: any = [{ id: 'demo', revision: 1, config: { label: 'old' } }]
  expect(selection.adopt(before, next)).toBe(true)
  next[0].config.label = 'mutated after adoption'
  expect(selection.matches([{ id: 'demo', revision: 2, config: { label: 'new' } }] as any)).toBe(true)
  expect(selection.adopt(before, next)).toBe(false)
  const unselected = new DesktopConfiguredSelection(undefined)
  expect(unselected.matches(original)).toBe(true)
  expect(unselected.adopt(original, next)).toBe(false)
})

it('offers configured writes only for admitted graphs with a current native proof', async () => {
  const plugins: any = [{ id: 'proved' }, { id: 'unadmitted' }, { id: 'unproved' }]
  const canWrite = vi.fn(async (_snapshot, plugin) => {
    if (plugin.id === 'unproved') throw new Error('unavailable')
    return true
  })
  const input: any = { desktopPackageConfigEnabled: () => true, projectPluginConfig: { canWrite } }
  const admitted = [{ pluginId: 'proved' }, { pluginId: 'unproved' }]
  expect(await prepareDesktopConfiguredConfigWrites(input, {} as any, plugins, admitted, () => true))
    .toEqual(['proved'])
  expect(canWrite).toHaveBeenCalledTimes(2)
  await expect(prepareDesktopConfiguredConfigWrites(input, {} as any, plugins, admitted, () => false))
    .rejects.toThrow('renderer-bootstrap-stale')
  expect(
    await prepareDesktopConfiguredConfigWrites(
      {
        ...input,
        desktopPackageConfigEnabled: () => false,
      },
      {} as any,
      plugins,
      admitted,
      () => true,
    ),
  ).toEqual([])
})
