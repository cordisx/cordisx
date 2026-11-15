import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { PermissionDetailPage } from '../packages/cli/src/renderer/manager/pages/PermissionDetailPage.js'
import type { ManagerModel, ManagerSnapshot } from '../packages/cli/src/renderer/manager.js'
import type { ManagerRouter } from '../packages/cli/src/renderer/manager/model/routes.js'

describe('owned-service permission explanation', () => {
  it('shows an internal capability without a user approval control', () => {
    const setPermissionPolicy = vi.fn()
    const markup = renderToStaticMarkup(createElement(PermissionDetailPage, {
      model: { setPermissionPolicy } as unknown as ManagerModel,
      router: {
        route: {
          kind: 'permission',
          pluginId: 'channel',
          capability: 'channel.accounts.connect',
          fingerprint: 'owned',
        },
      } as ManagerRouter,
      snapshot: {
        localization: { locale: 'zh-CN' },
        permissions: [{
          identity: { id: 'channel', source: 'file:///owner' },
          capability: 'channel.accounts.connect',
          fingerprint: 'owned',
          policy: 'allow',
          scope: {},
          authorizationOrigin: 'service-owner',
          availability: { status: 'available', reasonText: 'ready', providers: [] },
        }],
      } as unknown as ManagerSnapshot,
    }))
    expect(markup).toContain('data-permission-authorization-origin="service-owner"')
    expect(markup).toContain('内部调用')
    expect(markup).not.toContain('t-select')
    expect(markup).not.toContain('始终允许')
    expect(setPermissionPolicy).not.toHaveBeenCalled()
  })
})
