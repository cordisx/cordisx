import { Context } from '@deepseek-ai/cordis'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import type { CordisXIconThemes, NormalizedVectorDescriptor } from '../packages/cli/src/icon-theme-contracts.js'
import { bindIconThemeRegistry, createManagerIcon } from '../packages/cli/src/renderer/icons.js'
import { IconThemeRegistry } from '../packages/cli/src/renderer/icon-theme-registry.js'
import { CordisXIconThemeService } from '../packages/cli/src/renderer/icon-theme-service.js'
import { CORDISX_PLUGIN_GENERATION, CORDISX_PLUGIN_ID } from '../packages/cli/src/renderer/ownership.js'

const descriptor: NormalizedVectorDescriptor = {
  format: 'cordisx.normalized-vector',
  formatVersion: 1,
  viewBox: { minX: 0, minY: 0, width: 24, height: 24 },
  paths: [{
    paint: 'stroke',
    strokeWidth: 3,
    lineCap: 'square',
    lineJoin: 'bevel',
    commands: [{ op: 'move', x: 2, y: 2 }, { op: 'line', x: 22, y: 22 }],
  }],
}

describe('Cordis icon theme data service', () => {
  it('binds registration to the calling plugin generation and drives the real Host renderer', async () => {
    const root = new Context()
    const registry = new IconThemeRegistry('host-12', 'profile-main')
    const serviceFiber = root.plugin(CordisXIconThemeService, registry)
    await serviceFiber
    const plugin = root.extend({ [CORDISX_PLUGIN_ID]: 'aurora', [CORDISX_PLUGIN_GENERATION]: 'aurora-3' })
    const themes = plugin.iconThemes as CordisXIconThemes
    const handle = themes.register({
      schemaVersion: 1,
      namespace: 'aurora',
      providerVersion: '2.1.0',
      descriptors: [{ key: 'action.save', variant: 'regular', state: 'default', descriptor }],
    })
    const registration = registry.registration(handle.providerHandle)!
    expect(registration).toMatchObject({
      providerGeneration: 'aurora-3',
      identity: { providerId: 'plugin:aurora:aurora' },
    })
    expect(registry.select('select-1', 1, 'host-12', handle.providerHandle, handle.providerGeneration).outcome).toBe(
      'applied',
    )

    const dom = new JSDOM('<!doctype html>')
    const unbind = bindIconThemeRegistry(dom.window.document, registry)
    try {
      const custom = createManagerIcon(dom.window.document, 'save-configuration').querySelector('svg')!
      expect(custom.dataset.hostIconProvider).toBe('plugin:aurora:aurora')
      expect(custom.dataset.hostIconFallback).toBe('none')
      expect(custom.querySelector('path')?.getAttribute('d')).toBe('M2 2 L22 22')
      handle.dispose()
      expect(registry.selection()).toMatchObject({
        outcome: 'rolled-back',
        selectedProvider: { providerId: 'builtin:reicon' },
      })
      expect(registry.registration(handle.providerHandle)?.status).toBe('disposed')
      expect(
        createManagerIcon(dom.window.document, 'save-configuration').querySelector('svg')?.dataset.hostIconProvider,
      ).toBe('builtin:reicon')
    } finally {
      unbind()
      dom.window.close()
      await serviceFiber.dispose()
      registry.dispose()
    }
  })
})
