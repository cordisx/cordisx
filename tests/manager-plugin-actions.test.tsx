import React, { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { buildPermissionAuthorizationPlanV4 } from '../packages/cli/src/capability-risk-catalog.js'
import type { ManagerPluginSnapshot } from '../packages/cli/src/renderer/manager.js'
import { installNotificationHost } from '../packages/cli/src/renderer/notifications/host.js'
import { managerModel, managerRouter, managerSnapshot, reactManagerFixture } from './helpers/react-manager.js'

async function installLifecycleDialogHost(fixture: ReturnType<typeof reactManagerFixture>) {
  fixture.dom.window.HTMLDialogElement.prototype.showModal = function() {
    this.setAttribute('open', '')
  }
  fixture.dom.window.HTMLDialogElement.prototype.close = function() {
    this.removeAttribute('open')
  }
  const host = await import('../packages/cli/src/renderer/dialogs/host.js')
  return {
    center: host.dialogCenterForDocument,
    dispose: host.installDialogHost(fixture.document),
  }
}

function plugin(): ManagerPluginSnapshot {
  return {
    id: 'demo',
    name: 'Demo',
    source: 'file:///demo.js',
    status: 'active',
    inject: [],
    config: {},
    configuration: {
      namespace: 'demo',
      schemaKind: 'none',
      applies: 'live',
      writable: false,
      revision: 1,
      lastGoodRevision: 1,
      value: {},
      fields: [],
      secrets: [],
    },
  }
}

function enablePlan(source: string) {
  return buildPermissionAuthorizationPlanV4({
    planId: 'enable-demo',
    operation: 'enable',
    profileId: 'test',
    identity: { pluginId: 'demo', source },
    binding: {
      operationId: 'enable:demo',
      runtimeGeneration: 'runtime',
      moduleGeneration: 'demo-generation-2',
      requestId: 'enable-candidate',
    },
    declarations: [{
      name: 'models.read',
      required: false,
      rationale: {
        title: { key: 'demo.models.title', fallback: 'Use available models' },
        description: { key: 'demo.models.description', fallback: 'Choose a model for the plugin.' },
        feature: { key: 'demo.models.feature', fallback: 'Model selection' },
        deniedBehavior: { key: 'demo.models.denied', fallback: 'Model selection remains unavailable.' },
      },
      security: { dataUse: 'ephemeral', retention: 'runtime', externalTransfer: false },
      scope: {},
    }],
    policiesV2: [],
    policiesV4: [],
  })
}

describe('React Manager plugin actions', () => {
  it('keeps navigation separate from lifecycle actions and submits the exact confirmed dependency impact', async () => {
    const fixture = reactManagerFixture()
    const dialogs = await installLifecycleDialogHost(fixture)
    const { PluginsPage } = await import('../packages/cli/src/renderer/manager/pages/PluginsPage.js')
    const request = vi.fn().mockResolvedValueOnce({
      outcome: 'planned',
      impactToken: 'exact-impact',
      affectedPluginIds: ['demo', 'consumer'],
    })
      .mockResolvedValue({ outcome: 'applied', affectedPluginIds: ['demo', 'consumer'] })
    const state = managerSnapshot({
      plugins: [plugin()],
      pluginLifecycle: {
        profileId: 'test',
        revision: 1,
        runtimeGeneration: 'runtime',
        operationsAvailable: true,
      },
    })
    const router = managerRouter()
    try {
      await fixture.render(
        <PluginsPage
          model={managerModel(state, { requestPluginLifecycle: request })}
          snapshot={state}
          router={router}
        />,
      )
      await fixture.click('[aria-label="Disable plugin"]')
      const center = dialogs.center(fixture.document)!
      const confirmation = center.visible()[0]!
      expect(confirmation.chrome).toMatchObject({
        title: 'Disable plugin?',
        description: 'This action affects: demo, consumer. Continue?',
        footer: { primaryAction: { label: 'Disable plugin', tone: 'danger' } },
      })
      await act(async () => center.run(confirmation, confirmation.chrome.footer!.primaryAction!))
      expect(request.mock.calls).toEqual([[{ kind: 'disable', pluginId: 'demo', impactToken: '' }], [{
        kind: 'disable',
        pluginId: 'demo',
        impactToken: 'exact-impact',
      }]])
      expect(router.navigate).not.toHaveBeenCalled()
      await fixture.click('[data-plugin-id="demo"]')
      expect(router.navigate).toHaveBeenCalledWith({ kind: 'plugin', pluginId: 'demo', page: 'readme' })
    } finally {
      await act(async () => dialogs.dispose())
      await fixture.dispose()
    }
  })

  it('cancels uninstall impact without submitting the confirmation token', async () => {
    const fixture = reactManagerFixture()
    const dialogs = await installLifecycleDialogHost(fixture)
    const { PluginsPage } = await import('../packages/cli/src/renderer/manager/pages/PluginsPage.js')
    const request = vi.fn().mockResolvedValue({
      outcome: 'planned',
      impactToken: 'uninstall-impact',
      affectedPluginIds: ['demo'],
    })
    const state = managerSnapshot({
      plugins: [plugin()],
      pluginLifecycle: {
        profileId: 'test',
        revision: 1,
        runtimeGeneration: 'runtime',
        operationsAvailable: true,
      },
    })
    try {
      await fixture.render(
        <PluginsPage
          model={managerModel(state, { requestPluginLifecycle: request })}
          snapshot={state}
          router={managerRouter()}
        />,
      )
      await fixture.click('[aria-haspopup="menu"]')
      const uninstall = [...fixture.document.querySelectorAll<HTMLElement>('.t-dropdown__item')]
        .find(item => item.textContent?.includes('Uninstall'))
      expect(uninstall).toBeDefined()
      await act(async () => {
        uninstall!.click()
        await new Promise(resolve => fixture.dom.window.setTimeout(resolve, 0))
      })
      const center = dialogs.center(fixture.document)!
      const confirmation = center.visible()[0]!
      expect(confirmation.chrome.title).toBe('Uninstall plugin?')
      await act(async () => confirmation.handle.close('cancel'))
      expect(request).toHaveBeenCalledExactlyOnceWith({ kind: 'uninstall', pluginId: 'demo', impactToken: '' })
      expect(fixture.element('[aria-label="Disable plugin"]').classList.contains('t-is-disabled')).toBe(false)
    } finally {
      await act(async () => dialogs.dispose())
      await fixture.dispose()
    }
  })

  it('reviews a planned enable through Host permission v4 and applies the authorized generation', async () => {
    const fixture = reactManagerFixture()
    const { PluginsPage } = await import('../packages/cli/src/renderer/manager/pages/PluginsPage.js')
    const disabled = { ...plugin(), status: 'configured-disabled' as const }
    const reviewedSource = 'file:///installed/demo.js'
    const plan = enablePlan(reviewedSource)
    const request = vi.fn().mockResolvedValue({
      outcome: 'planned',
      candidateId: 'enable-candidate',
      impactToken: 'enable-impact',
      affectedPluginIds: ['demo'],
      package: { id: 'demo', version: '1.0.0' },
    })
    const reviewPlan = vi.fn().mockResolvedValue(plan)
    const applyReview = vi.fn().mockResolvedValue({ outcome: 'applied', affectedPluginIds: ['demo'] })
    const state = managerSnapshot({
      plugins: [disabled],
      pluginLifecycle: {
        profileId: 'test',
        revision: 8,
        runtimeGeneration: 'runtime',
        operationsAvailable: true,
      },
    })
    try {
      await fixture.render(
        <PluginsPage
          model={managerModel(state, {
            requestPluginLifecycle: request,
            permissionLifecycleReviewPlanV4: reviewPlan,
            applyPermissionLifecycleReviewV4: applyReview,
          })}
          snapshot={state}
          router={managerRouter()}
        />,
      )
      await fixture.click('[aria-label="Enable plugin"]')
      expect(fixture.document.querySelector('[data-permission-authorization="enable-demo"]')).not.toBeNull()
      expect(fixture.document.querySelector('[data-permission-authorization] h2')?.textContent).toBe(
        'Review permissions before enabling',
      )
      expect(fixture.document.querySelector('[data-permission-authorization]')?.textContent).toContain(reviewedSource)
      await fixture.click('[data-permission-action="confirm"]')
      expect(request).toHaveBeenCalledExactlyOnceWith({ kind: 'enable', pluginId: 'demo' })
      expect(reviewPlan).toHaveBeenCalledExactlyOnceWith({ kind: 'enable', pluginId: 'demo' })
      expect(applyReview).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        schemaVersion: 4,
        operation: 'enable',
        identity: { pluginId: 'demo', source: reviewedSource },
        binding: expect.objectContaining({ requestId: 'enable-candidate' }),
      }))
    } finally {
      await fixture.dispose()
    }
  })

  it('leaves a disabled plugin unchanged when its enable permission review is cancelled', async () => {
    const fixture = reactManagerFixture()
    const { PluginsPage } = await import('../packages/cli/src/renderer/manager/pages/PluginsPage.js')
    const disabled = { ...plugin(), status: 'configured-disabled' as const }
    const request = vi.fn().mockResolvedValue({
      outcome: 'planned',
      candidateId: 'enable-candidate',
      affectedPluginIds: ['demo'],
    })
    const reviewPlan = vi.fn().mockResolvedValue(enablePlan(disabled.source))
    const applyReview = vi.fn()
    const state = managerSnapshot({
      plugins: [disabled],
      pluginLifecycle: {
        profileId: 'test',
        revision: 8,
        runtimeGeneration: 'runtime',
        operationsAvailable: true,
      },
    })
    try {
      await fixture.render(
        <PluginsPage
          model={managerModel(state, {
            requestPluginLifecycle: request,
            permissionLifecycleReviewPlanV4: reviewPlan,
            applyPermissionLifecycleReviewV4: applyReview,
          })}
          snapshot={state}
          router={managerRouter()}
        />,
      )
      await fixture.click('[aria-label="Enable plugin"]')
      expect(fixture.document.querySelector('[data-permission-authorization="enable-demo"]')).not.toBeNull()
      await fixture.click('[data-permission-action="cancel"]')
      expect(request).toHaveBeenCalledExactlyOnceWith({ kind: 'enable', pluginId: 'demo' })
      expect(applyReview).not.toHaveBeenCalled()
      expect(fixture.document.querySelector('[aria-label="Enable plugin"]')).not.toBeNull()
    } finally {
      await fixture.dispose()
    }
  })

  it('reports a non-applied reviewed enable instead of silently completing', async () => {
    const fixture = reactManagerFixture()
    let disposeNotifications!: () => void
    await act(async () => {
      disposeNotifications = installNotificationHost(fixture.document, 'test')
    })
    const { PluginsPage } = await import('../packages/cli/src/renderer/manager/pages/PluginsPage.js')
    const disabled = { ...plugin(), status: 'configured-disabled' as const }
    const state = managerSnapshot({
      plugins: [disabled],
      pluginLifecycle: {
        profileId: 'test',
        revision: 8,
        runtimeGeneration: 'runtime',
        operationsAvailable: true,
      },
    })
    try {
      await fixture.render(
        <PluginsPage
          model={managerModel(state, {
            requestPluginLifecycle: vi.fn().mockResolvedValue({
              outcome: 'planned',
              candidateId: 'enable-candidate',
              affectedPluginIds: ['demo'],
            }),
            permissionLifecycleReviewPlanV4: vi.fn().mockResolvedValue(enablePlan(disabled.source)),
            applyPermissionLifecycleReviewV4: vi.fn().mockResolvedValue({
              outcome: 'planned',
              affectedPluginIds: ['demo'],
            }),
          })}
          snapshot={state}
          router={managerRouter()}
        />,
      )
      await fixture.click('[aria-label="Enable plugin"]')
      await fixture.click('[data-permission-action="confirm"]')
      expect(fixture.document.querySelector('.cxn-card')?.textContent).toContain('Plugin operation failed')
      expect(fixture.document.querySelector('.cxn-card')?.textContent).toContain('Enable ended with planned')
    } finally {
      await act(async () => disposeNotifications())
      await fixture.dispose()
    }
  })

  it('retains targeted development reload when package lifecycle is unavailable and disables busy actions', async () => {
    const fixture = reactManagerFixture()
    const { PluginsPage } = await import('../packages/cli/src/renderer/manager/pages/PluginsPage.js')
    let complete!: (value: unknown) => void
    const request = vi.fn(() =>
      new Promise(resolve => {
        complete = resolve
      })
    )
    const state = managerSnapshot({ plugins: [{ ...plugin(), developmentReloadAvailable: true }] })
    const model = managerModel(state, { requestPluginLifecycle: request as never })
    try {
      await fixture.render(<PluginsPage model={model} snapshot={state} router={managerRouter()} />)
      expect(fixture.element('[aria-label="Disable plugin"]').classList.contains('t-is-disabled')).toBe(true)
      await fixture.click('[aria-label="Disable plugin"]')
      expect(request).not.toHaveBeenCalled()
      expect(fixture.element('[aria-label="Reload plugin"]')).toHaveProperty('disabled', false)
      await fixture.click('[aria-label="Reload plugin"]')
      expect(request).toHaveBeenCalledExactlyOnceWith({ kind: 'reload', pluginId: 'demo' })
      expect(fixture.element('[aria-label="Reload plugin"]').classList.contains('t-is-loading')).toBe(true)
      expect(fixture.element('[aria-label="Reload plugin"]').classList.contains('t-is-disabled')).toBe(true)
      await fixture.render(<PluginsPage model={model} snapshot={state} router={managerRouter()} />)
      await act(async () => complete({ outcome: 'applied', affectedPluginIds: ['demo'] }))
      await fixture.render(<PluginsPage model={model} snapshot={state} router={managerRouter()} />)
      expect(fixture.element('[aria-label="Reload plugin"]').classList.contains('t-is-loading')).toBe(false)
    } finally {
      await fixture.dispose()
    }
  })

  it('reports lifecycle failures through Host notifications without adding a page status alert', async () => {
    const fixture = reactManagerFixture()
    let disposeNotifications!: () => void
    await act(async () => {
      disposeNotifications = installNotificationHost(fixture.document, 'test')
    })
    const { PluginsPage } = await import('../packages/cli/src/renderer/manager/pages/PluginsPage.js')
    const state = managerSnapshot({
      plugins: [plugin()],
      pluginLifecycle: {
        profileId: 'test',
        revision: 1,
        runtimeGeneration: 'runtime',
        operationsAvailable: true,
      },
    })
    const request = vi.fn().mockResolvedValue({
      outcome: 'rejected',
      affectedPluginIds: ['demo'],
      error: { code: 'operation-unavailable', message: 'Lifecycle unavailable' },
    })
    try {
      await fixture.render(
        <PluginsPage
          model={managerModel(state, { requestPluginLifecycle: request })}
          snapshot={state}
          router={managerRouter()}
        />,
      )
      await fixture.click('[aria-label="Disable plugin"]')
      expect(fixture.document.querySelector('.cxr-page > [role="status"]')).toBeNull()
      expect(fixture.document.querySelector('.cxn-card')?.textContent).toContain('Plugin operation failed')
      expect(fixture.document.querySelector('.cxn-card')?.textContent).toContain('Lifecycle unavailable')
    } finally {
      await act(async () => disposeNotifications())
      await fixture.dispose()
    }
  })
})
