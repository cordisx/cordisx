import { randomBytes } from 'node:crypto'
import { expect, vi } from 'vitest'
import { loadHomeConfig } from '../../packages/cli/src/config/home-config.js'
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
  const provedPlugin = await configuredManagerPlugin(root, 'configured-proved', { configSchema: true })
  return {
    publicPlugin,
    privatePlugin,
    provedPlugin,
    entries: [
      { id: 'configured-public', entry: publicPlugin.archive },
      {
        id: 'configured-private',
        entry: privatePlugin.archive,
        config: { token: 'synthetic-configured-secret' },
      },
      {
        id: 'configured-proved',
        entry: provedPlugin.archive,
        config: { label: 'synthetic-configured-visible', token: 'synthetic-proved-secret' },
      },
    ],
  }
}

export function desktopConfiguredPolicies(profileId: string, plugins: readonly CordisXConfigPlugin[]) {
  return ['configured-public', 'configured-proved'].flatMap(id => {
    const plugin = plugins.find(item => item.id === id)
    if (!plugin?.source) throw new Error('configured fixture source is unavailable')
    return exactDomPermissionPolicies(profileId, [{
      id: plugin.id,
      entry: plugin.entry,
      pointIds: ['manager.settings.navigation-items', 'manager.content'],
    }]).map(policy => ({
      ...policy,
      key: { ...policy.key, identity: { ...policy.key.identity, source: plugin.source! } },
    }))
  })
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
    const plugins = JSON.parse(projection) as Array<
      { id: string; status: string; configuration?: { writable: boolean } }
    >
    expect(projection).toContain('configured-public')
    expect(projection).toContain('configured-private')
    expect(plugins.find(plugin => plugin.id === 'configured-public')?.status).toBe('active')
    expect(plugins.find(plugin => plugin.id === 'configured-private')?.status).toBe('failed')
    expect(plugins.find(plugin => plugin.id === 'configured-proved')?.status).toBe('active')
    expect(plugins.find(plugin => plugin.id === 'configured-proved')?.configuration?.writable).toBe(false)
    expect(plugins.find(plugin => plugin.id === 'unsupported-installed')?.status).toBe('failed')
    expect(projection).not.toContain('synthetic-configured-secret')
    expect(projection).not.toContain('synthetic-proved-secret')
    expect(projection).not.toContain('synthetic-installed-private')
    expect(projection).not.toContain(installedSource)
    expect(projection).not.toContain(fixture.publicPlugin.source)
    expect(projection).not.toContain(fixture.privatePlugin.source)
    expect(projection).not.toContain(fixture.provedPlugin.source)
    expect(await page.evaluate('typeof globalThis.__unsupportedInstalledLoaded')).toBe('undefined')
    await page.evaluate('document.querySelector("[data-settings-navigation-item^=configured-public]").click()')
    await vi.waitFor(async () => {
      expect(await page.evaluate('document.body.textContent.includes("Configured fixture page")')).toBe(true)
    }, { timeout: 15_000 })
    await vi.waitFor(async () => {
      expect(
        await page.evaluate('Boolean(document.querySelector("[data-settings-navigation-item^=configured-proved]"))'),
      )
        .toBe(true)
    }, { timeout: 20_000 })
    await page.evaluate('document.querySelector("[data-settings-navigation-item^=configured-proved]").click()')
    await vi.waitFor(async () => {
      expect(
        await page.evaluate(
          'document.body.textContent.includes("Configured fixture page: synthetic-configured-visible")',
        ),
      ).toBe(true)
    }, { timeout: 15_000 })
  }
}

/** Save an ordinary field through the existing Manager and retain the owner's private field. */
export async function verifyDesktopConfiguredWrite(
  first: CdpClient,
  second: CdpClient,
  desktop: CdpClient,
  configPath: string,
  ready: (page: CdpClient) => Promise<void>,
): Promise<void> {
  const id = 'configured-proved'
  const form = `[data-plugin-config-form=${id}]`
  const value = (label: string) => ({ label })
  const snapshot = `globalThis.__cordisxRuntime.snapshot().plugins.find(item => item.id === '${id}')?.configuration`
  const open = async (page: CdpClient) => {
    await vi.waitFor(async () => {
      expect(await page.evaluate(`Boolean(document.querySelector('[data-plugin-id=${id}]'))`)).toBe(true)
    }, { timeout: 15_000 })
    await page.evaluate(`document.querySelector('[data-plugin-id=${id}]').click()`)
    await vi.waitFor(async () => {
      expect(await page.evaluate('Boolean(document.querySelector("[data-plugin-detail-tab=config]"))')).toBe(true)
    }, { timeout: 15_000 })
    await page.evaluate('document.querySelector("[data-plugin-detail-tab=config]").click()')
    await vi.waitFor(async () => {
      expect(await page.evaluate(`Boolean(document.querySelector('${form} [data-config-path=label] input'))`)).toBe(
        true,
      )
    }, { timeout: 15_000 })
  }
  const save = async (page: CdpClient, label: string) => {
    await open(page)
    await page.evaluate(`(() => {
      const input = document.querySelector('${form} [data-config-path=label] input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(label)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`)
    await vi.waitFor(async () => {
      expect(await page.evaluate(`!document.querySelector('${form} button[type=submit]').disabled`)).toBe(true)
    }, { timeout: 10_000 })
    await page.evaluate(`document.querySelector('${form} button[type=submit]').click()`)
  }
  const confirm = async (revision: number, label: string) => {
    await vi.waitFor(async () => {
      const stored = (await loadHomeConfig(configPath)).plugins.find(plugin => plugin.id === id)?.profiles?.default
      expect(stored).toEqual({ revision, config: { label, token: 'synthetic-proved-secret' } })
      for (const page of [first, second, desktop]) {
        expect(await page.evaluate(`${snapshot}?.revision`)).toBe(revision)
        expect(await page.evaluate(`${snapshot}?.value`)).toEqual(value(label))
      }
      for (const page of [first, second]) {
        expect(
          await page.evaluate('JSON.stringify(globalThis.__cordisxRuntime.snapshot()) + document.body.textContent'),
        )
          .not.toContain('synthetic-proved-secret')
      }
    }, { timeout: 30_000 })
  }
  for (const page of [first, second]) {
    expect(await page.evaluate(`${snapshot}?.writable`)).toBe(true)
  }
  await first.evaluate("globalThis.__configuredWriteMarker = 'same-document'")
  await save(first, 'first configured update')
  await confirm(1, 'first configured update')
  expect(await first.evaluate('globalThis.__configuredWriteMarker')).toBe('same-document')
  await second.evaluate('globalThis.__configuredBeforeReload = true')
  await second.send('Page.reload')
  await vi.waitFor(async () => {
    expect(await second.evaluate('globalThis.__configuredBeforeReload === undefined')).toBe(true)
  }, { timeout: 15_000 })
  await ready(second)
  expect(await second.evaluate(`${snapshot}?.value`)).toEqual(value('first configured update'))
  expect(await second.evaluate(`${snapshot}?.writable`)).toBe(true)
  await save(second, 'second configured update')
  await confirm(2, 'second configured update')
  expect(await first.evaluate('globalThis.__configuredWriteMarker')).toBe('same-document')
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
