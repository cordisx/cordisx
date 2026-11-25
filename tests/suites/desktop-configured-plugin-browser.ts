import { expect, vi } from 'vitest'
import type { CordisXConfigPlugin } from '../../packages/cli/src/launcher/config.js'
import type { CdpClient } from '../fixtures/native-browser-cdp.js'
import { configuredManagerPlugin } from '../fixtures/configured-manager-plugin.js'
import { exactDomPermissionPolicies } from '../helpers/dom-permission.js'

export async function desktopConfiguredFixtures(root: string, enabled: boolean) {
  if (!enabled) return undefined
  const publicPlugin = await configuredManagerPlugin(root, 'configured-public')
  const privatePlugin = await configuredManagerPlugin(root, 'configured-private')
  return {
    publicPlugin,
    privatePlugin,
    entries: [
      { id: 'configured-public', entry: publicPlugin.archive },
      {
        id: 'configured-private',
        entry: privatePlugin.archive,
        config: { token: 'synthetic-configured-secret' },
      },
    ],
  }
}

export function desktopConfiguredPolicies(profileId: string, plugins: readonly CordisXConfigPlugin[]) {
  const plugin = plugins.find(item => item.id === 'configured-public')
  if (!plugin?.source) throw new Error('configured fixture source is unavailable')
  return exactDomPermissionPolicies(profileId, [{
    id: plugin.id,
    entry: plugin.entry,
    pointIds: ['manager.settings.navigation-items', 'manager.content'],
  }]).map(policy => ({
    ...policy,
    key: { ...policy.key, identity: { ...policy.key.identity, source: plugin.source! } },
  }))
}

export async function verifyDesktopConfiguredNavigation(page: CdpClient) {
  await vi.waitFor(async () => {
    expect(await page.evaluate('Boolean(document.querySelector("[data-settings-navigation-item^=configured-public]"))'))
      .toBe(true)
  }, { timeout: 20_000 })
}

export async function verifyDesktopConfiguredPlugins(
  pages: readonly CdpClient[],
  fixture: NonNullable<Awaited<ReturnType<typeof desktopConfiguredFixtures>>>,
) {
  for (const page of pages) {
    await verifyDesktopConfiguredNavigation(page)
    const projection = await page.evaluate<string>('JSON.stringify(globalThis.__cordisxRuntime.snapshot().plugins)')
    const plugins = JSON.parse(projection) as Array<{ id: string; status: string }>
    expect(projection).toContain('configured-public')
    expect(projection).toContain('configured-private')
    expect(plugins.find(plugin => plugin.id === 'configured-public')?.status).toBe('active')
    expect(plugins.find(plugin => plugin.id === 'configured-private')?.status).toBe('failed')
    expect(projection).not.toContain('synthetic-configured-secret')
    expect(projection).not.toContain(fixture.publicPlugin.source)
    expect(projection).not.toContain(fixture.privatePlugin.source)
    await page.evaluate('document.querySelector("[data-settings-navigation-item^=configured-public]").click()')
    await vi.waitFor(async () => {
      expect(await page.evaluate('document.body.textContent.includes("Configured fixture page")')).toBe(true)
    }, { timeout: 15_000 })
  }
}
