import React, { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { buildPermissionAuthorizationPlanV4 } from '../packages/cli/src/capability-risk-catalog.js'
import {
  buildDeferredPermissionPlan,
  deferValidatedPermissionPlan,
  deferValidatedV1PermissionPlan,
} from '../packages/cli/src/permission-deferral.js'
import { CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V1 } from '../packages/cli/src/platform-contracts.js'
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
  it('does not offer lifecycle actions for an unprojected configured plugin in standalone mode', async () => {
    const fixture = reactManagerFixture()
    const { PluginsPage } = await import('../packages/cli/src/renderer/manager/pages/PluginsPage.js')
    const { StandalonePluginLifecycleContext } = await import(
      '../packages/cli/src/renderer/manager/model/standalone-plugin-lifecycle.js'
    )
    const disabled = { ...plugin(), status: 'configured-disabled' as const }
    const state = managerSnapshot({
      plugins: [disabled],
      pluginLifecycle: { profileId: 'test', revision: 1, runtimeGeneration: 'runtime', operationsAvailable: true },
    })
    const request = vi.fn()
    try {
      await fixture.render(
        <StandalonePluginLifecycleContext.Provider value={{ binding: {} as any, snapshot: undefined }}>
          <PluginsPage
            model={managerModel(state, { requestPluginLifecycle: request })}
            snapshot={state}
            router={managerRouter()}
          />
        </StandalonePluginLifecycleContext.Provider>,
      )
      expect(fixture.element('[aria-label="Enable plugin"]').classList.contains('t-is-disabled')).toBe(true)
      await fixture.click('[aria-label="Enable plugin"]')
      expect(request).not.toHaveBeenCalled()
    } finally {
      await fixture.dispose()
    }
  })

  it.each([undefined, 'service' as const])(
    'uses a scoped standalone owner plan in mode %s only for the exact supported plugin',
    async mode => {
      const fixture = reactManagerFixture()
      const dialogs = await installLifecycleDialogHost(fixture)
      const { PluginsPage } = await import('../packages/cli/src/renderer/manager/pages/PluginsPage.js')
      const { StandalonePluginLifecycleContext } = await import(
        '../packages/cli/src/renderer/manager/model/standalone-plugin-lifecycle.js'
      )
      const alias = 'https://renderer.cordisx.invalid/plugin/' + 'a'.repeat(64)
      const digest = ('sha256:' + 'b'.repeat(64)) as any
      const installed = {
        ...plugin(),
        source: alias,
        package: {
          version: '1.0.0',
          digest,
          moduleGeneration: 'demo-generation',
          dependencies: [],
          canonicalSource: alias,
        },
      }
      const state = managerSnapshot({
        plugins: [installed],
        pluginLifecycle: { profileId: 'test', revision: 1, runtimeGeneration: 'runtime', operationsAvailable: false },
      })
      const projected: any = {
        profileId: 'test',
        revision: 4,
        activationRevision: 1,
        rendererLifecycleAccess: 'session-scoped-v1',
        runtime: { kind: 'active', runtimeGeneration: 'runtime', ...(mode === undefined ? {} : { mode }) },
        plugins: [{ ...installed.package, id: 'demo', enabled: true, availableOperations: ['disable', 'uninstall'] }],
      }
      const executionRequest = { kind: 'plugin-execute-plan', executionToken: 'session-plan' }
      const planLifecycle = vi.fn().mockResolvedValue({
        status: 'planned',
        snapshot: projected,
        executionRequest,
        affectedPluginIds: ['demo'],
      })
      const executeLifecycle = vi.fn().mockResolvedValue({ status: 'applied', snapshot: projected })
      const native = vi.fn()
      const binding: any = { planLifecycle, executeLifecycle }
      try {
        const render = async (managementSnapshot: any) =>
          await fixture.render(
            <StandalonePluginLifecycleContext.Provider value={{ binding, snapshot: managementSnapshot }}>
              <PluginsPage
                model={managerModel(state, { requestPluginLifecycle: native })}
                snapshot={state}
                router={managerRouter()}
              />
            </StandalonePluginLifecycleContext.Provider>,
          )
        await render({ ...projected, activationRevision: 0 })
        expect(fixture.element('[aria-label="Disable plugin"]').classList.contains('t-is-disabled')).toBe(true)
        await render({ ...projected, runtime: { ...projected.runtime, runtimeGeneration: 'other' } })
        expect(fixture.element('[aria-label="Disable plugin"]').classList.contains('t-is-disabled')).toBe(true)
        await render(projected)
        await fixture.click('[aria-label="Disable plugin"]')
        const center = dialogs.center(fixture.document)!
        const confirmation = center.visible()[0]!
        expect(confirmation.chrome.description).toBe('This action affects: demo. Continue?')
        expect(executeLifecycle).not.toHaveBeenCalled()
        await act(async () => center.run(confirmation, confirmation.chrome.footer!.primaryAction!))
        expect(planLifecycle).toHaveBeenCalledExactlyOnceWith({ kind: 'plugin-disable', pluginId: 'demo' })
        expect(executeLifecycle).toHaveBeenCalledExactlyOnceWith(executionRequest, 4)
        expect(native).not.toHaveBeenCalled()
        await render({ ...projected, plugins: [{ ...projected.plugins[0], availableOperations: [] }] })
        expect(fixture.element('[aria-label="Disable plugin"]').classList.contains('t-is-disabled')).toBe(true)
      } finally {
        await act(async () => dialogs.dispose())
        await fixture.dispose()
      }
    },
  )

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

  it('enables optional-only authority without displaying or granting a permission', async () => {
    const fixture = reactManagerFixture()
    const { PluginsPage } = await import('../packages/cli/src/renderer/manager/pages/PluginsPage.js')
    const plan = deferValidatedPermissionPlan(enablePlan('file:///installed/demo.js'))
    const applyReview = vi.fn().mockResolvedValue({ outcome: 'applied', affectedPluginIds: ['demo'] })
    const state = managerSnapshot({
      plugins: [{ ...plugin(), status: 'configured-disabled' as const }],
      pluginLifecycle: { profileId: 'test', revision: 8, runtimeGeneration: 'runtime', operationsAvailable: true },
    })
    try {
      await fixture.render(
        <PluginsPage
          model={managerModel(state, {
            requestPluginLifecycle: vi.fn().mockResolvedValue({ outcome: 'planned' }),
            permissionLifecycleReviewPlanV7: vi.fn().mockResolvedValue(plan),
            applyPermissionLifecycleReviewV7: applyReview,
          })}
          snapshot={state}
          router={managerRouter()}
        />,
      )
      await fixture.click('[aria-label="Enable plugin"]')
      expect(fixture.document.querySelector('[data-permission-authorization]')).toBeNull()
      expect(applyReview).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        schemaVersion: 7,
        origin: 'host-no-decision',
        decisions: [],
      }))
    } finally {
      await fixture.dispose()
    }
  })

  it('asks only for required authority and leaves the optional capability undecided', async () => {
    const fixture = reactManagerFixture()
    const { PluginsPage } = await import('../packages/cli/src/renderer/manager/pages/PluginsPage.js')
    const plan = buildDeferredPermissionPlan({
      planId: 'enable-demo',
      operation: 'enable',
      profileId: 'test',
      identity: { pluginId: 'demo', source: 'file:///installed/demo.js' },
      binding: { operationId: 'enable:demo', runtimeGeneration: 'runtime', requestId: 'candidate-1' },
      declarations: [
        { name: 'models.read', required: true, scope: {} },
        { name: 'tasks.catalog.read', required: false, scope: {} },
      ],
      policiesV2: [],
      policiesV4: [],
    })
    const applyReview = vi.fn().mockResolvedValue({ outcome: 'applied', affectedPluginIds: ['demo'] })
    const state = managerSnapshot({
      plugins: [{ ...plugin(), status: 'configured-disabled' as const }],
      pluginLifecycle: { profileId: 'test', revision: 8, runtimeGeneration: 'runtime', operationsAvailable: true },
    })
    try {
      await fixture.render(
        <PluginsPage
          model={managerModel(state, {
            requestPluginLifecycle: vi.fn().mockResolvedValue({ outcome: 'planned' }),
            permissionLifecycleReviewPlanV7: vi.fn().mockResolvedValue(plan),
            applyPermissionLifecycleReviewV7: applyReview,
          })}
          snapshot={state}
          router={managerRouter()}
        />,
      )
      await fixture.click('[aria-label="Enable plugin"]')
      const dialog = fixture.document.querySelector('[data-permission-authorization="enable-demo"]')!
      expect(dialog.textContent).toContain('models.read')
      expect(dialog.textContent).not.toContain('tasks.catalog.read')
      await fixture.click('[data-permission-action="confirm"]')
      expect(applyReview).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        schemaVersion: 7,
        origin: 'explicit-user',
        decisions: [expect.objectContaining({ capability: 'models.read' })],
      }))
    } finally {
      await fixture.dispose()
    }
  })

  it('shows a legacy required reason as plugin-provided text', async () => {
    const fixture = reactManagerFixture()
    const { PluginsPage } = await import('../packages/cli/src/renderer/manager/pages/PluginsPage.js')
    const plan = deferValidatedV1PermissionPlan({
      $schema: CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V1,
      schemaVersion: 1,
      planId: 'enable-demo',
      operation: 'enable',
      profileId: 'test',
      defaultDecision: 'allow',
      identity: { pluginId: 'demo', source: 'file:///demo.js' },
      declarations: [{
        capability: 'models.read',
        required: true,
        reason: { key: 'legacy-reason', fallback: 'Legacy plugin explanation' },
        scope: {},
        policy: 'ask',
        decisionRequired: true,
      }],
    }, { operationId: 'enable-demo', runtimeGeneration: 'runtime', requestId: 'candidate-1' })
    const applyReview = vi.fn().mockResolvedValue({ outcome: 'applied', affectedPluginIds: ['demo'] })
    const state = managerSnapshot({
      plugins: [{ ...plugin(), status: 'configured-disabled' as const }],
      pluginLifecycle: { profileId: 'test', revision: 8, runtimeGeneration: 'runtime', operationsAvailable: true },
    })
    try {
      await fixture.render(
        <PluginsPage
          model={managerModel(state, {
            requestPluginLifecycle: vi.fn().mockResolvedValue({ outcome: 'planned' }),
            permissionLifecycleReviewPlanV7: vi.fn().mockResolvedValue(plan),
            applyPermissionLifecycleReviewV7: applyReview,
          })}
          snapshot={state}
          router={managerRouter()}
        />,
      )
      await fixture.click('[aria-label="Enable plugin"]')
      const dialog = fixture.document.querySelector('[data-permission-authorization="enable-demo"]')!
      expect(dialog.textContent).toContain('Plugin-provided explanation')
      expect(dialog.textContent).toContain('Legacy plugin explanation')
      await fixture.click('[data-permission-action="confirm"]')
      expect(applyReview).toHaveBeenCalledOnce()
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
