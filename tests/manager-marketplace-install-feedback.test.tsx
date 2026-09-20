import React, { act } from 'react'
import { expect, it, vi } from 'vitest'
import type { MarketplaceCatalogPlugin } from '../packages/cli/src/renderer/marketplace.js'
import { useMarketplaceInstaller } from '../packages/cli/src/renderer/manager/model/use-marketplace-installer.js'
import { installNotificationHost } from '../packages/cli/src/renderer/notifications/host.js'
import { managerModel, managerSnapshot, reactManagerFixture } from './helpers/react-manager.js'

it('keeps failed installation feedback visible, allows retry, and does not report cancellation as failure', async () => {
  const fixture = reactManagerFixture()
  let disposeNotifications!: () => void
  await act(async () => {
    disposeNotifications = installNotificationHost(fixture.document, 'test')
  })
  let rejectInspection!: (error: Error) => void
  const inspect = vi.fn((_request, signal: AbortSignal) =>
    new Promise<never>((_resolve, reject) => {
      rejectInspection = reject
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  )
  const snapshot = managerSnapshot({
    pluginLifecycle: { profileId: 'test', revision: 0, runtimeGeneration: 'test', operationsAvailable: true },
  })
  const manager = managerModel(snapshot, {
    inspectMarketplaceArtifact: inspect,
    requestPluginLifecycle: vi.fn(),
  })
  const plugin = {
    id: 'example',
    identity: 'example@1.0.0',
    version: '1.0.0',
    schemaVersion: 7,
    source: 'https://example.test/plugin',
    artifact: {
      packageName: '@example/plugin',
      packageNamespace: '@example',
      publisherIdentity: 'npm:@example',
      downloadUrl: 'https://registry.example/plugin.tgz',
      integrity: `sha256:${'a'.repeat(64)}`,
    },
  } as MarketplaceCatalogPlugin
  function Installer() {
    const installer = useMarketplaceInstaller(manager, snapshot, { failed: 'Install failed', succeeded: 'Installed' })
    return (
      <>
        <button
          disabled={installer.installingIdentity !== undefined}
          onClick={() => void installer.run(plugin, 'Example')}
        >
          Install
        </button>
        <button onClick={installer.cancel}>Cancel</button>
      </>
    )
  }
  try {
    await fixture.render(<Installer />)
    await fixture.click('#root button:first-child')
    expect(fixture.element('#root button:first-child')).toHaveProperty('disabled', true)
    await act(async () => rejectInspection(new Error('Download failed (ECONNRESET)')))
    expect(fixture.document.querySelector('[role="alert"]')?.textContent).toContain('Download failed (ECONNRESET)')
    expect(fixture.element('#root button:first-child')).toHaveProperty('disabled', false)
    await fixture.click('[aria-label="Dismiss notification"]')
    await fixture.click('#root button:first-child')
    await fixture.click('#root button:last-child')
    expect(fixture.document.querySelector('[role="alert"]')).toBeNull()
    expect(fixture.element('#root button:first-child')).toHaveProperty('disabled', false)
    expect(inspect).toHaveBeenCalledTimes(2)
    expect(manager.requestPluginLifecycle).not.toHaveBeenCalled()
  } finally {
    await act(async () => disposeNotifications())
    await fixture.dispose()
  }
})

it('keeps Marketplace installation single-flight until completion or explicit cancellation', async () => {
  const fixture = reactManagerFixture()
  const inspections: Array<{
    readonly signal: AbortSignal
    reject(error: Error): void
  }> = []
  const inspect = vi.fn((_request, signal: AbortSignal) =>
    new Promise<never>((_resolve, reject) => inspections.push({ signal, reject }))
  )
  const snapshot = managerSnapshot({
    pluginLifecycle: { profileId: 'test', revision: 0, runtimeGeneration: 'test', operationsAvailable: true },
  })
  const manager = managerModel(snapshot, {
    inspectMarketplaceArtifact: inspect,
    requestPluginLifecycle: vi.fn(),
  })
  const plugin = {
    id: 'example',
    identity: 'example@1.0.0',
    version: '1.0.0',
    schemaVersion: 7,
    source: 'https://example.test/plugin',
    artifact: {
      packageName: '@example/plugin',
      packageNamespace: '@example',
      publisherIdentity: 'npm:@example',
      downloadUrl: 'https://registry.example/plugin.tgz',
      integrity: `sha256:${'a'.repeat(64)}`,
    },
  } as MarketplaceCatalogPlugin
  let installer!: ReturnType<typeof useMarketplaceInstaller>
  function Installer() {
    installer = useMarketplaceInstaller(manager, snapshot, { failed: 'Install failed', succeeded: 'Installed' })
    return null
  }
  try {
    await fixture.render(<Installer />)
    let first!: Promise<void>
    await act(async () => {
      first = installer.run(plugin, 'Example')
      await installer.run(plugin, 'Example')
    })
    expect(inspect).toHaveBeenCalledTimes(1)
    expect(inspections[0]?.signal.aborted).toBe(false)

    await act(async () => {
      installer.cancel()
      expect(inspections[0]?.signal.aborted).toBe(true)
      inspections[0]?.reject(new Error('cancelled'))
      await first
    })

    await act(async () => {
      const retry = installer.run(plugin, 'Example')
      expect(inspect).toHaveBeenCalledTimes(2)
      inspections[1]?.reject(new Error('retry failed'))
      await retry
    })
  } finally {
    await fixture.dispose()
  }
})
