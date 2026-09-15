import { describe, expect, it, vi } from 'vitest'

vi.mock('../packages/cli/src/renderer/host-ui/BrandMark.js', () => ({
  BrandMark: () => null,
  createBrandMarkElement: (document: Document) => document.createElement('span'),
}))
import { reconcileManagerContentRoute } from '../packages/cli/src/renderer/manager/ManagerApp.js'
import type { ManagerSettingsNavigationItemSnapshot } from '../packages/cli/src/renderer/manager.js'

const item: ManagerSettingsNavigationItemSnapshot = {
  id: 'demo:service',
  owner: 'demo',
  group: 'after-settings',
  navigationGroup: 'resources',
  order: 10,
  disabled: false,
  title: 'Demo service',
  description: 'Review access before opening.',
  pageTitle: 'Demo service',
  pageDescription: 'Review access before opening.',
  icon: 'host:settings',
  route: { id: 'service' },
  permissionReview: { capability: 'ui.extension-points.render', fingerprint: 'permission-1' },
}

describe('Manager permission-review navigation', () => {
  it('replaces a protected content route with its exact Host permission route', () => {
    expect(reconcileManagerContentRoute(
      { kind: 'manager-content', id: item.id, reference: item.route },
      [item],
    )).toEqual({
      kind: 'permission',
      pluginId: 'demo',
      capability: 'ui.extension-points.render',
      fingerprint: 'permission-1',
    })
  })

  it('keeps authorized content and rejects missing destinations', () => {
    expect(reconcileManagerContentRoute(
      { kind: 'manager-content', id: item.id, reference: item.route },
      [{ ...item, permissionReview: undefined }],
    )).toBeUndefined()
    expect(reconcileManagerContentRoute(
      { kind: 'manager-content', id: 'missing', reference: { id: 'missing' } },
      [item],
    )).toEqual({ kind: 'primary', page: 'plugins' })
  })
})
