import React, { act } from 'react'
import { expect, it, vi } from 'vitest'
import { createStandaloneStartup } from '../packages/cli/src/independent-manager/standalone-startup.js'
import { installStandaloneManager } from '../packages/cli/src/renderer/manager/install-standalone.js'
import { HostManagerNavigationController } from '../packages/cli/src/renderer/manager/navigation-controller.js'
import { writeStandaloneManagerRoute } from '../packages/cli/src/renderer/manager/model/standalone-route-storage.js'
import type { ManagerRoute } from '../packages/cli/src/renderer/manager/model/routes.js'
import { managerCopy } from '../packages/cli/src/renderer/ui-copy.js'
import { modelProviderCopy } from '../packages/cli/src/renderer/model-provider-copy.js'
import { managerModel, reactManagerFixture } from './helpers/react-manager.js'

vi.mock('../packages/cli/src/renderer/host-ui/BrandMark.js', () => ({
  BrandMark: () => <span />,
  createBrandMarkElement: (document: Document) => document.createElement('span'),
}))

it('shows navigable Host chrome before admission and preserves the selected page during handoff', async () => {
  const fixture = reactManagerFixture()
  fixture.document.documentElement.lang = 'zh-CN'
  let startup: ReturnType<typeof createStandaloneStartup> | undefined
  let disposeManager: (() => void) | undefined
  try {
    await act(async () => {
      startup = createStandaloneStartup(fixture.document)
    })
    const starting = () => fixture.element('[data-cordisx-manager-startup]')
    expect(starting().querySelector('[data-manager-starting][aria-busy=true]')).not.toBeNull()
    expect(starting().textContent).not.toContain('正在连接 CordisX')
    expect(starting().querySelector('[data-installed-plugin-results]')).toBeNull()
    const startingSearch = () => starting().querySelector<HTMLInputElement>('input[type=search]')
    expect(startingSearch()?.getAttribute('aria-label')).toBe(managerCopy('zh-CN', 'plugins.collection-search-label'))
    expect(startingSearch()?.disabled).toBe(true)

    const navigation = new HostManagerNavigationController()
    await act(async () => {
      disposeManager = installStandaloneManager(fixture.document, managerModel(), {
        navigationController: navigation,
        standaloneStyleHref: '/manager-host.css',
      })
    })
    const live = fixture.element('[data-cordisx-react-manager]')
    expect(live.hidden).toBe(true)
    await fixture.click('[data-cordisx-manager-startup] [data-tab=model-services]')
    starting().querySelector<HTMLElement>('[data-tab=model-services]')!.focus()
    expect(starting().querySelector('.cxr-heading')?.textContent).toContain('模型服务')
    expect(startingSearch()?.getAttribute('aria-label')).toBe(modelProviderCopy('zh-CN').search)
    expect(startingSearch()?.disabled).toBe(true)
    expect(starting().textContent).not.toContain('没有模型服务')
    expect(live.hidden).toBe(true)

    await act(async () => {
      expect(startup!.connected()).toBe(true)
    })
    expect(fixture.document.querySelector('[data-cordisx-manager-startup]')).toBeNull()
    expect(live.hidden).toBe(false)
    expect(live.querySelector('[data-tab=model-services]')?.getAttribute('aria-current')).toBe('page')
    expect(fixture.document.activeElement).toBe(live.querySelector('[data-tab=model-services]'))
    expect(live.querySelector('.cxr-heading')?.textContent).toContain('Model services')
  } finally {
    await act(async () => {
      disposeManager?.()
      startup?.dispose()
    })
    await fixture.dispose()
  }
})

it('keeps the navigation visible and shows failure inside the Manager without fake empty data', async () => {
  const fixture = reactManagerFixture()
  fixture.document.documentElement.lang = 'zh-CN'
  let startup: ReturnType<typeof createStandaloneStartup> | undefined
  try {
    await act(async () => {
      startup = createStandaloneStartup(fixture.document)
      startup.unavailable()
    })
    expect(startup!.connected()).toBe(false)
    expect(fixture.document.querySelector('[data-tab=plugins]')).not.toBeNull()
    expect(fixture.element('[data-cordisx-manager-startup] p[role=status]').textContent).toContain('连接不可用')
    expect(fixture.document.querySelector('[data-installed-plugin-results]')).toBeNull()
  } finally {
    await act(async () => startup?.dispose())
    await fixture.dispose()
  }
})

it('shows the matching browse toolbar while each primary page is waiting', async () => {
  const fixture = reactManagerFixture()
  fixture.document.documentElement.lang = 'zh-CN'
  let startup: ReturnType<typeof createStandaloneStartup> | undefined
  try {
    await act(async () => {
      startup = createStandaloneStartup(fixture.document)
    })
    for (
      const [page, label] of [
        ['marketplace', '搜索插件…'],
        ['extension-points', managerCopy('zh-CN', 'extension.search-label')],
        ['routes', managerCopy('zh-CN', 'routes.search-label')],
      ] as const
    ) {
      await fixture.click(`[data-cordisx-manager-startup] [data-tab=${page}]`)
      const surface = fixture.element(`[data-manager-starting-page=${page}]`)
      const input = surface.querySelector<HTMLInputElement>('input[type=search]')
      expect(input?.getAttribute('aria-label')).toBe(label)
      expect(input?.disabled).toBe(true)
      expect(surface.querySelector('[data-manager-starting][aria-busy=true]')).not.toBeNull()
      expect(surface.querySelector('[data-empty-presentation]')).toBeNull()
    }
  } finally {
    await act(async () => startup?.dispose())
    await fixture.dispose()
  }
})

it('prompts for a refresh when an idle interrupted connection can be recovered', async () => {
  const fixture = reactManagerFixture()
  fixture.document.documentElement.lang = 'zh-CN'
  let startup: ReturnType<typeof createStandaloneStartup> | undefined
  try {
    await act(async () => {
      startup = createStandaloneStartup(fixture.document)
      startup.unavailable('refresh')
    })
    expect(fixture.element('[data-cordisx-manager-startup] p[role=status]').textContent).toContain('刷新页面重试')
  } finally {
    await act(async () => startup?.dispose())
    await fixture.dispose()
  }
})

it.each([
  ['zh-CN', '浏览器需要安全连接'],
  ['en', 'This browser requires a secure connection'],
])('explains an insecure context in %s', async (locale, message) => {
  const fixture = reactManagerFixture()
  fixture.document.documentElement.lang = locale
  let startup: ReturnType<typeof createStandaloneStartup> | undefined
  try {
    await act(async () => {
      startup = createStandaloneStartup(fixture.document)
      startup.unavailable('insecure-context')
    })
    const text = fixture.element('[data-cordisx-manager-startup] p[role=status]').textContent
    expect(text).toContain(message)
    expect(text).toContain('HTTPS')
    expect(fixture.document.querySelector('[data-tab=plugins]')).not.toBeNull()
  } finally {
    await act(async () => startup?.dispose())
    await fixture.dispose()
  }
})

it.each(
  [
    {
      locale: 'zh-CN',
      label: '页面',
      route: { kind: 'manager-content', id: 'example:manager', reference: { id: 'root' } },
      identifier: 'example:manager',
    },
    {
      locale: 'en',
      label: 'Page',
      route: { kind: 'plugin', pluginId: 'example-plugin', page: 'config' },
      identifier: 'example-plugin',
    },
  ] as const,
)('does not expose an unresolved route while starting in $locale', async ({ locale, label, route, identifier }) => {
  const fixture = reactManagerFixture()
  fixture.document.documentElement.lang = locale
  writeStandaloneManagerRoute(fixture.dom.window.sessionStorage, route)
  let startup: ReturnType<typeof createStandaloneStartup> | undefined
  let adopted: ManagerRoute | undefined
  try {
    await act(async () => {
      startup = createStandaloneStartup(fixture.document)
    })
    const heading = fixture.element('[data-cordisx-manager-startup] .cxr-heading')
    expect(heading.textContent).toContain(label)
    expect(heading.textContent).not.toContain(identifier)
    await act(async () => {
      startup!.stage(next => adopted = next)
      expect(startup!.connected()).toBe(true)
    })
    expect(adopted).toEqual(route)
  } finally {
    await act(async () => startup?.dispose())
    await fixture.dispose()
  }
})
