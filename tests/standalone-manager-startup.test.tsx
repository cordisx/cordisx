import React, { act } from 'react'
import { expect, it, vi } from 'vitest'
import { createStandaloneStartup } from '../packages/cli/src/independent-manager/standalone-startup.js'
import { installStandaloneManager } from '../packages/cli/src/renderer/manager/install-standalone.js'
import { HostManagerNavigationController } from '../packages/cli/src/renderer/manager/navigation-controller.js'
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
