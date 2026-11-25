import { randomBytes } from 'node:crypto'
import { expect, vi } from 'vitest'
import type { CordisXConfigPlugin } from '../../packages/cli/src/launcher/config.js'
import { PackagePluginConfigStore } from '../../packages/cli/src/launcher/package-plugin-config.js'
import { PluginLifecycleCoordinator } from '../../packages/cli/src/launcher/plugin-lifecycle.js'
import type { CdpClient } from '../fixtures/native-browser-cdp.js'
import { configuredManagerPlugin } from '../fixtures/configured-manager-plugin.js'
import { exactDomPermissionPolicies } from '../helpers/dom-permission.js'
import { decision, FormalRuntime, localPackage, request } from './plugin-lifecycle.fixtures.js'

const installedSource = 'https://example.test/unsupported-installed'

export async function stageDesktopUnsupportedInstalled(input: {
  root: string
  homeDir: string
  profileId: string
  generation: string
}) {
  const sourceDirectory = await localPackage({
    root: input.root,
    id: 'unsupported-installed',
    requiredCapability: true,
    canonicalSource: installedSource,
    code: 'export function apply() { globalThis.__unsupportedInstalledLoaded = true }',
  })
  const coordinator = new PluginLifecycleCoordinator({
    homeDir: input.homeDir,
    profileId: input.profileId,
    runtimeGeneration: input.generation,
    permissionPolicies: [],
    runtime: new FormalRuntime(),
    headless: true,
  })
  const planned = await coordinator.handle({
    ...request({ kind: 'inspect-local', sourceDirectory }, 0, input.generation),
    profileId: input.profileId,
  })
  expect(planned.outcome).toBe('planned')
  const installed = await coordinator.handle({
    ...request(
      {
        kind: 'install',
        candidateId: planned.candidateId!,
        authorizationDecision: decision(planned.authorizationPlan!),
      },
      0,
      input.generation,
    ),
    profileId: input.profileId,
  })
  expect(installed.outcome).toBe('applied')
  const configs = new PackagePluginConfigStore(input.homeDir, input.profileId, input.generation)
  const token = randomBytes(32).toString('hex')
  await configs.stage('unsupported-installed', 0, { value: 'synthetic-installed-private' }, token)
  await configs.commit('unsupported-installed', 1, token)
}

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

export async function waitForDesktopRetirement(hasLive: () => boolean | undefined) {
  await vi.waitFor(() => expect(hasLive()).toBe(false), { timeout: 15_000 })
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
    expect(plugins.find(plugin => plugin.id === 'unsupported-installed')?.status).toBe('failed')
    expect(projection).not.toContain('synthetic-configured-secret')
    expect(projection).not.toContain('synthetic-installed-private')
    expect(projection).not.toContain(installedSource)
    expect(projection).not.toContain(fixture.publicPlugin.source)
    expect(projection).not.toContain(fixture.privatePlugin.source)
    expect(await page.evaluate('typeof globalThis.__unsupportedInstalledLoaded')).toBe('undefined')
    await page.evaluate('document.querySelector("[data-settings-navigation-item^=configured-public]").click()')
    await vi.waitFor(async () => {
      expect(await page.evaluate('document.body.textContent.includes("Configured fixture page")')).toBe(true)
    }, { timeout: 15_000 })
  }
}

export async function verifyDesktopActivationViews(pages: readonly CdpClient[], isolated: boolean) {
  type Snapshot = {
    active: { plugins: Array<{ id: string; canonicalSource?: string; [key: string]: unknown }>; [key: string]: unknown }
    registryEpoch: number
  }
  const views = await Promise.all(pages.map(async page =>
    await page.evaluate<Snapshot>(
      '({ active: globalThis.__cordisxRuntime.activePluginGeneration(), registryEpoch: globalThis.__cordisxRuntime.pluginRegistryEpoch() })',
    )
  ))
  if (!isolated) {
    expect(views[0]).toEqual(views[1])
    expect(views[0]).toEqual(views[2])
    return
  }
  const normalize = (view: Snapshot) => ({
    ...view,
    active: {
      ...view.active,
      plugins: view.active.plugins.map(({ canonicalSource: _source, ...plugin }) => {
        void _source
        return plugin
      }),
    },
  })
  expect(normalize(views[0]!)).toEqual(normalize(views[1]!))
  expect(normalize(views[0]!)).toEqual(normalize(views[2]!))
  const sources = views.map(view =>
    view.active.plugins.find(plugin => plugin.id === 'unsupported-installed')?.canonicalSource
  )
  const alias = new RegExp('^https://renderer[.]cordisx[.]invalid/plugin/[a-f0-9]{64}$', 'u')
  expect(sources[0]).toMatch(alias)
  expect(sources[1]).toMatch(alias)
  expect(sources[0]).not.toBe(sources[1])
  expect(sources[2]).toBe(installedSource)
}
