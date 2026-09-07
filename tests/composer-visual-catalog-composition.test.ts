import {
  COMPOSER_VISUAL_CATALOG,
  COMPOSER_VISUAL_LOCALES,
} from '../packages/cli/src/renderer/composer-visual-catalog.js'
import {
  ExtensionPointDescriptorRegistry,
  ExtensionPointPolicyBroker,
  MemoryExtensionPointPolicyStore,
} from '../packages/cli/src/renderer/extension-points.js'
import { validateItem } from '../packages/cli/src/renderer/surface-validation.js'
import { Context } from '@deepseek-ai/cordis'
import { JSDOM } from 'jsdom'
import * as React from 'react'
import { expect, it, vi } from 'vitest'
import { CordisXExtensionPointVisualService } from '../packages/cli/src/renderer/composer-visual-service.js'
import { SurfaceRegistry } from '../packages/cli/src/renderer/surface-registry.js'
import { HostContextStore } from '../packages/cli/src/renderer/validation.js'
import {
  CORDISX_PLUGIN_GENERATION,
  CORDISX_PLUGIN_ID,
  CORDISX_PLUGIN_SOURCE,
} from '../packages/cli/src/renderer/ownership.js'
import type { PermissionBroker } from '../packages/cli/src/renderer/platform/platform-permission-broker.js'

it('composes the production catalog, point policies and visual service without dropping interactive overlays', async () => {
  const dom = new JSDOM(
    '<div data-codex-composer-root data-composer-placement="home"><div contenteditable="true" role="textbox"></div><div data-composer-footer-responsive><button class="size-token-button-composer" aria-label="Send"><svg></svg></button></div></div>',
    { pretendToBeVisual: true },
  )
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  dom.window.Element.prototype.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 100,
    bottom: 100,
    width: 100,
    height: 100,
    toJSON() {},
  })
  const root = new Context()
  const descriptors = new ExtensionPointDescriptorRegistry(COMPOSER_VISUAL_LOCALES)
  const retireCatalog = descriptors.registerCatalog(COMPOSER_VISUAL_CATALOG)
  expect(descriptors.descriptors().map(point => point.id)).toEqual(
    COMPOSER_VISUAL_CATALOG.points.map(point => point.id).sort(),
  )
  expect(descriptors.diagnostics()).toEqual([])
  const pointBroker = new ExtensionPointPolicyBroker(descriptors, new MemoryExtensionPointPolicyStore())
  const retireIdentity = pointBroker.register({ source: 'file:///animal.js', id: 'animal' })
  const surfaces = new SurfaceRegistry(new HostContextStore())
  surfaces.setAccessResolver(pointBroker)
  const broker = {
    visualDeclarationSupported: () => true,
    visualAuthority: (_identity: unknown, _generation: string, _point: string, allowed: () => boolean) => ({
      render: allowed,
      observePointer: () => true,
      drag: () => true,
      activate: () => true,
      subscribe: () => () => {},
    }),
  } as unknown as PermissionBroker
  const service = root.plugin(CordisXExtensionPointVisualService, { document: dom.window.document, surfaces, broker })
  await service
  const ctx = root.extend({
    [CORDISX_PLUGIN_ID]: 'animal',
    [CORDISX_PLUGIN_SOURCE]: 'file:///animal.js',
    [CORDISX_PLUGIN_GENERATION]: 'g1',
  })
  const load = async () => ({ kind: 'react-svg-v1' as const, component: () => React.createElement('svg') })
  try {
    const a = ctx.extensionPointVisuals.register({ id: 'a', pointId: 'composer.primary-action.visual' }, load)
    const b = ctx.extensionPointVisuals.register({
      id: 'b',
      pointId: 'composer.frame.overlay',
      events: ['pointer.observe', 'drag', 'activate'],
    }, load)
    await vi.waitFor(() =>
      expect(dom.window.document.querySelectorAll('[data-cordisx-composer-visual]')).toHaveLength(2)
    )
    expect(surfaces.snapshot().every(item => item.rendered && item.valid && item.authorized)).toBe(true)
    expect(dom.window.document.querySelector('[data-cordisx-composer-drag]')).not.toBeNull()
    a()
    expect(dom.window.document.querySelectorAll('[data-cordisx-composer-visual]')).toHaveLength(1)
    b()
    expect(dom.window.document.querySelectorAll('[data-cordisx-composer-visual]')).toHaveLength(0)
    expect(surfaces.currentContextSnapshot()).toEqual([])
  } finally {
    await service.dispose()
    surfaces.dispose()
    retireIdentity()
    retireCatalog()
    descriptors.dispose()
    await new Promise(resolve => setTimeout(resolve, 30))
    dom.window.close()
    vi.unstubAllGlobals()
  }
})

it('rejects duplicate, unknown and primary drag/activation events at both production validators', () => {
  for (const events of [['drag'], ['activate'], ['pointer.observe', 'pointer.observe'], ['unknown']]) {
    const descriptors = new ExtensionPointDescriptorRegistry(COMPOSER_VISUAL_LOCALES)
    descriptors.registerCatalog({
      ...COMPOSER_VISUAL_CATALOG,
      points: [{ ...COMPOSER_VISUAL_CATALOG.points[0], events }],
    })
    expect(descriptors.descriptors()).toEqual([])
    expect(descriptors.diagnostics()).toHaveLength(1)
    expect(() => validateItem('composer.primary-action.visual', { renderer: { id: 'cat' }, events })).toThrow()
    descriptors.dispose()
  }
  for (const events of [['drag', 'drag'], ['unknown']]) {
    expect(() => validateItem('composer.frame.overlay', { renderer: { id: 'cat' }, events })).toThrow()
  }
})
