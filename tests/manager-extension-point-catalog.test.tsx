import React from 'react'
import { describe, expect, it } from 'vitest'
import {
  buildExtensionPointRuntimeSnapshot,
  CORDISX_BUILTIN_EXTENSION_POINT_CATALOG,
  CORDISX_EXTENSION_POINT_LOCALE_CATALOGS,
  CORDISX_MANAGER_EXTENSION_POINT_CATALOG,
  ExtensionPointDescriptorRegistry,
  ExtensionPointPolicyBroker,
  type ExtensionPointRuntimeSnapshot,
  MemoryExtensionPointPolicyStore,
} from '../packages/cli/src/renderer/extension-points.js'
import type { CordisXI18nService } from '../packages/cli/src/renderer/i18n.js'
import { managerRouter, managerSnapshot, reactManagerFixture } from './helpers/react-manager.js'
function extensionPoints(locale: 'en' | 'zh-CN', withUsage = false): ExtensionPointRuntimeSnapshot {
  const descriptors = new ExtensionPointDescriptorRegistry(CORDISX_EXTENSION_POINT_LOCALE_CATALOGS)
  descriptors.registerCatalog(CORDISX_BUILTIN_EXTENSION_POINT_CATALOG)
  descriptors.registerCatalog(CORDISX_MANAGER_EXTENSION_POINT_CATALOG)
  const broker = new ExtensionPointPolicyBroker(descriptors, new MemoryExtensionPointPolicyStore())
  const i18n = {
    getSnapshot: () => ({ locale, direction: 'ltr', version: 1 }),
    resolveFor: (owner: string, message: { namespace?: string; key: string; fallback?: string }) => {
      const namespace = message.namespace ?? owner
      const catalog = CORDISX_EXTENSION_POINT_LOCALE_CATALOGS.find(item => (
        item.namespace === namespace && item.locale === locale
      ))
      const contributionText = message.key === 'action.label'
        ? locale === 'zh-CN' ? '提交前刷新' : 'Refresh before submit'
        : message.key === 'action.description'
        ? locale === 'zh-CN' ? '在提交前刷新当前数据。' : 'Refresh current data before submit.'
        : undefined
      const text = contributionText
        ?? (catalog?.messages as Readonly<Record<string, string | undefined>> | undefined)?.[message.key]
        ?? message.fallback
        ?? '[[' + namespace + ':' + message.key + ']]'
      return { text, namespace, key: message.key, locale }
    },
    clearDiagnosticSite: () => {},
  } as unknown as CordisXI18nService
  const source = 'https://plugins.example/showcase'
  const unregister = withUsage ? broker.register({ source, id: 'showcase' }) : () => {}
  const built = buildExtensionPointRuntimeSnapshot({
    descriptors,
    broker,
    i18n,
    plugins: withUsage
      ? [{ id: 'showcase', source, name: 'Showcase', description: '演示提交前刷新操作。', status: 'active' }]
      : [],
    registrations: withUsage
      ? [{
        owner: 'showcase',
        id: 'submit-before',
        qualifiedId: 'showcase:submit-before',
        surface: 'composer.toolbar.items',
        group: 'default',
        order: 0,
        item: {
          label: { namespace: 'showcase:messages', key: 'action.label', fallback: 'Refresh before submit' },
          description: {
            namespace: 'showcase:messages',
            key: 'action.description',
            fallback: 'Refresh current data before submit.',
          },
          anchor: 'submit',
          placement: 'before',
          command: { id: 'refresh' },
        },
        visible: true,
        authorized: true,
        pointPolicy: 'inherit',
        effectivePointPolicy: 'allow',
        disabled: false,
        valid: true,
        pending: false,
        currentContext: 'active',
        rendered: true,
      }]
      : [],
    commands: [],
    navigation: {
      routes: [],
      pages: [],
      outlets: [
        { id: 'app', placement: 'application', available: true, mounted: false, presentation: 'inactive' },
        { id: 'main', placement: 'main', available: true, mounted: false, presentation: 'inactive' },
        { id: 'session.content', placement: 'session', available: true, mounted: false, presentation: 'inactive' },
        {
          id: 'manager.settings.content',
          placement: 'manager-settings',
          available: true,
          mounted: false,
          presentation: 'inactive',
        },
        { id: 'manager.content', placement: 'manager', available: false, mounted: false, presentation: 'inactive' },
      ],
    },
    surfaceCurrentContext: [
      {
        surface: 'session.header.actions',
        state: 'not-mounted',
        code: 'session.not-mounted',
        detail: { key: 'session.not-mounted', fallback: 'No session page is mounted.' },
      },
      {
        surface: 'sidebar.footer.before-control',
        state: 'not-mounted',
        code: 'sidebar.not-mounted',
        detail: { key: 'sidebar.not-mounted', fallback: 'The sidebar is not mounted.' },
      },
      { surface: 'composer.toolbar.items', state: 'active' },
    ],
  })
  unregister()
  broker.dispose()
  descriptors.dispose()
  return {
    ...built,
    points: built.points.map(point =>
      point.id === 'workspace.toolbar.items'
        ? { ...point, titleProjection: { ...point.titleProjection, diagnostic: 'missing-key' as const } }
        : point
    ),
  }
}

describe('React Manager extension point catalog', () => {
  it('renders every runtime descriptor, navigates its exact point, and searches current translated text', async () => {
    const fixture = reactManagerFixture()
    const { ExtensionPointsPage } = await import('../packages/cli/src/renderer/manager/pages/ExtensionPointsPage.js')
    const router = managerRouter({ kind: 'primary', page: 'extension-points' })
    const catalog = extensionPoints('en', true)
    try {
      await fixture.render(
        <ExtensionPointsPage snapshot={managerSnapshot({ extensionPoints: catalog })} router={router} />,
      )
      expect(fixture.document.querySelectorAll('.cxr-card')).toHaveLength(catalog.points.length)
      await fixture.type('input', 'composer.toolbar.items')
      expect(fixture.document.querySelectorAll('.cxr-card')).toHaveLength(1)
      await fixture.click('.cxr-card')
      expect(router.navigate).toHaveBeenCalledWith({ kind: 'extension-point', pointId: 'composer.toolbar.items' })
      await fixture.type('input', '')
      const translated = extensionPoints('zh-CN')
      await fixture.render(
        <ExtensionPointsPage snapshot={managerSnapshot({ extensionPoints: translated })} router={router} />,
      )
      expect(fixture.document.body.textContent).toContain(translated.points[0]!.titleProjection.text)
      await fixture.type('input', 'not-a-point')
      expect(fixture.document.querySelectorAll('.cxr-card')).toHaveLength(0)
      expect(fixture.document.querySelector('input')).not.toBeNull()
    } finally {
      await fixture.dispose()
    }
  })
})
