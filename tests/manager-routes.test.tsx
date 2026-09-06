import React from 'react'
import { describe, expect, it } from 'vitest'
import type { ManagerSnapshot } from '../packages/cli/src/renderer/manager.js'
import { managerRouter, reactManagerFixture } from './helpers/react-manager.js'
function snapshot(locale: 'en' | 'zh-CN'): ManagerSnapshot {
  const zh = locale === 'zh-CN'
  const product = (kind: 'documented' | 'legacy', resource: 'route' | 'page') => {
    if (kind === 'legacy') {
      return {
        ...(resource === 'page' ? { title: zh ? '旧页面' : 'Legacy page' } : {}),
        diagnostics: [
          ...(resource === 'route'
            ? [{
              code: 'metadata.missing-title' as const,
              field: 'title' as const,
              message: 'route demo:legacy should declare localized title metadata',
            }]
            : []),
          {
            code: 'metadata.missing-description' as const,
            field: 'description' as const,
            message: `${resource} demo:legacy should declare localized description metadata`,
          },
        ],
      }
    }
    return {
      title: resource === 'route'
        ? (zh ? '打开工作区分析' : 'Open workspace analytics')
        : (zh ? '工作区分析' : 'Workspace analytics'),
      description: resource === 'route'
        ? (zh
          ? '从插件导航进入，在主区域查看工作区分析。'
          : 'Open from plugin navigation to review workspace analytics in the main area.')
        : (zh ? '展示当前工作区的结构化分析内容。' : 'Shows structured analytics for the current workspace.'),
      diagnostics: [],
    }
  }
  return {
    version: 'test',
    plugins: [{
      id: 'demo',
      source: 'file:///plugins/demo/index.ts',
      name: 'Demo',
      inject: [],
      config: {},
      status: 'active',
      configuration: {
        namespace: 'demo',
        schemaKind: 'none',
        applies: 'plugin-restart',
        writable: false,
        revision: 0,
        lastGoodRevision: 0,
        value: {},
        fields: [],
        secrets: [],
      },
    }],
    registrations: [],
    commands: [],
    navigation: {
      routes: [
        {
          owner: 'demo',
          id: 'analytics',
          qualifiedId: 'demo:analytics',
          definition: { id: 'analytics', path: '/main/analytics/:workspaceId', outlet: 'main', page: 'analytics' },
          productMetadata: product('documented', 'route'),
          valid: true,
          authorized: true,
          pointPolicy: 'inherit',
          effectivePointPolicy: 'allow',
        },
        {
          owner: 'demo',
          id: 'legacy',
          qualifiedId: 'demo:legacy',
          definition: { id: 'legacy', path: '/legacy', outlet: 'app', page: 'legacy' },
          productMetadata: product('legacy', 'route'),
          valid: true,
          authorized: true,
          pointPolicy: 'inherit',
          effectivePointPolicy: 'allow',
        },
      ],
      pages: [
        {
          owner: 'demo',
          id: 'analytics',
          qualifiedId: 'demo:analytics',
          metadata: {
            id: 'analytics',
            title: { key: 'page.analytics.title' },
            description: { key: 'page.analytics.description' },
          },
          productMetadata: product('documented', 'page'),
        },
        {
          owner: 'demo',
          id: 'legacy',
          qualifiedId: 'demo:legacy',
          metadata: { id: 'legacy', title: { key: 'page.legacy.title' }, chrome: 'body-only' },
          productMetadata: product('legacy', 'page'),
        },
      ],
      outlets: [],
    },
    localization: { locale, direction: 'ltr', version: zh ? 2 : 1 },
    localeCatalogs: [],
    localizationDiagnostics: [],
    platform: {
      hostId: 'codex-desktop',
      hostName: 'Codex Desktop',
      mode: 'unavailable',
      supportedCapabilities: [],
      diagnostics: [],
      secondConnectionCreated: false,
      rawBridgeExposed: false,
    },
    permissions: [],
  }
}

describe('React Manager route and page catalog', () => {
  it('renders localized live routes and pages, navigates exact identities, and keeps search in empty results', async () => {
    const fixture = reactManagerFixture()
    const { RoutesPage } = await import('../packages/cli/src/renderer/manager/pages/RoutesPage.js')
    const router = managerRouter({ kind: 'primary', page: 'routes' })
    try {
      await fixture.render(<RoutesPage snapshot={snapshot('en')} router={router} />)
      expect(fixture.document.querySelectorAll('.cxr-card')).toHaveLength(4)
      expect(fixture.document.body.textContent).toContain('Open workspace analytics')
      await fixture.click('.cxr-card')
      expect(router.navigate).toHaveBeenCalledWith({ kind: 'route', qualifiedId: 'demo:analytics' })
      await fixture.render(<RoutesPage snapshot={snapshot('zh-CN')} router={router} />)
      expect(fixture.document.body.textContent).toContain('工作区分析')
      await fixture.type('input', 'no-such-route')
      expect(fixture.document.querySelectorAll('.cxr-card')).toHaveLength(0)
      expect(fixture.document.querySelector('input')).not.toBeNull()
      await fixture.type('input', 'demo:analytics')
      expect(fixture.document.querySelectorAll('.cxr-card')).toHaveLength(2)
      await fixture.click('.cxr-card:last-child')
      expect(router.navigate).toHaveBeenLastCalledWith({ kind: 'page', qualifiedId: 'demo:analytics' })
    } finally {
      await fixture.dispose()
    }
  })
})
