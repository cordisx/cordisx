import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { ensureHomeConfig, loadHomeConfig, updateHomeConfigAtomic } from '../packages/cli/src/config/home-config.js'
import { commitPluginConfigCandidate, stagePluginConfigCandidate } from '../packages/cli/src/config/plugin-config.js'
import { stageServiceConfigCandidate } from '../packages/cli/src/config/service-config.js'
import {
  fenceChangedConfiguredPlugins,
  SharedProfilePluginConfigFence,
} from '../packages/cli/src/config/profile-plugin-config-fence.js'
import { SharedProfilePermissionFence } from '../packages/cli/src/config/profile-permission-fence.js'
import { exactDomPermissionPolicies } from './helpers/dom-permission.js'

const run = promisify(execFile)
const scope = (profileId: string) => ({
  profileId,
  pluginId: 'channel',
  generation: 'owner-1',
  ownerToken: 'a'.repeat(64),
})

async function initialize(configPath: string) {
  await ensureHomeConfig(configPath)
  await updateHomeConfigAtomic(current => ({
    ...current,
    plugins: [{
      id: 'channel',
      entry: '/fixture/channel.tgz',
      profiles: { work: { revision: 0, config: {} }, other: { revision: 0, config: {} } },
      services: { runtime: { profiles: { work: { revision: 0, lastGoodRevision: 0, config: {} } } } },
    }],
  }), configPath)
}

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'fences the selected plugin and service config without blocking another profile',
  async () => {
    const root = await mkdtemp('/tmp/cx-plugin-config-fence-')
    const configPath = path.join(root, 'config.json')
    const fence = new SharedProfilePluginConfigFence(configPath, 'work')
    const moduleUrl = new URL('../packages/cli/src/config/plugin-config.ts', import.meta.url).href
    const writeFromAnotherProcess = async () => {
      const script = `
        import { stagePluginConfigCandidate } from ${JSON.stringify(moduleUrl)};
        try { await stagePluginConfigCandidate(JSON.parse(process.argv[2]), process.argv[1]);
          process.stdout.write('staged');
        } catch (error) { process.stdout.write(error.name); }
      `
      const input = { ...scope('work'), expectedRevision: 0, config: { value: 'new' } }
      return (await run(process.execPath, [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        script,
        configPath,
        JSON.stringify(input),
      ], { cwd: process.cwd(), timeout: 10_000 })).stdout
    }
    try {
      await initialize(configPath)
      const first = await fence.acquire()
      const second = await fence.acquire()
      expect(await writeFromAnotherProcess()).toBe('ProfilePluginConfigFenceBusyError')
      await expect(stageServiceConfigCandidate({
        ...scope('work'),
        serviceId: 'runtime',
        expectedRevision: 0,
        config: { enabled: true },
        initialConfig: {},
        applies: 'service-restart',
      }, configPath)).rejects.toThrow('plugin configuration is in use')
      const other = await stagePluginConfigCandidate({
        ...scope('other'),
        expectedRevision: 0,
        config: { value: 'other' },
      }, configPath)
      await commitPluginConfigCandidate({ ...scope('other'), candidateRevision: other.candidateRevision }, configPath)
      await expect(updateHomeConfigAtomic(current => ({
        ...current,
        plugins: current.plugins.map(plugin => ({ ...plugin, entry: '/fixture/new.tgz' })),
      }), configPath)).rejects.toThrow('plugin configuration is in use')
      expect((await loadHomeConfig(configPath)).plugins[0]?.profiles?.work?.candidate).toBeUndefined()
      await first()
      expect(await writeFromAnotherProcess()).toBe('ProfilePluginConfigFenceBusyError')
      await second()
      expect(await writeFromAnotherProcess()).toBe('staged')
    } finally {
      await fence.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'blocks a new profile admission until a global plugin change is published',
  async () => {
    const root = await mkdtemp('/tmp/cx-plugin-config-admission-')
    const configPath = path.join(root, 'config.json')
    const fence = new SharedProfilePluginConfigFence(configPath, 'new-profile')
    try {
      await initialize(configPath)
      const previous = (await loadHomeConfig(configPath)).plugins
      const candidate = previous.map(plugin => ({ ...plugin, entry: '/fixture/new.tgz' }))
      const releaseWriter = await fenceChangedConfiguredPlugins(configPath, previous, candidate)
      await expect(fence.acquire()).rejects.toThrow('plugin configuration is in use')
      await releaseWriter()
      const releaseReader = await fence.acquire()
      await releaseReader()
    } finally {
      await fence.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'fences managed-service startup configuration for the selected profile only',
  async () => {
    const root = await mkdtemp('/tmp/cx-managed-startup-fence-')
    const configPath = path.join(root, 'config.json')
    const fence = new SharedProfilePluginConfigFence(configPath, 'work')
    const changeStartup = async (profileId: string) =>
      await updateHomeConfigAtomic(current => ({
        ...current,
        apps: {
          ...current.apps,
          codex: {
            ...current.apps.codex!,
            profiles: {
              ...current.apps.codex!.profiles,
              [profileId]: {
                displayName: profileId,
                dataMode: 'shared',
                managedServiceStartupConfig: { fixture: { enabled: true } },
              },
            },
          },
        },
      }), configPath)
    try {
      await ensureHomeConfig(configPath)
      const release = await fence.acquire()
      await expect(changeStartup('work')).rejects.toThrow('plugin configuration is in use')
      await changeStartup('other')
      expect((await loadHomeConfig(configPath)).apps.codex!.profiles.other!.managedServiceStartupConfig)
        .toEqual({ fixture: { enabled: true } })
      await release()
      await changeStartup('work')
      expect((await loadHomeConfig(configPath)).apps.codex!.profiles.work!.managedServiceStartupConfig)
        .toEqual({ fixture: { enabled: true } })
    } finally {
      await fence.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'rolls back all acquired locks when a combined permission and plugin write is refused',
  async () => {
    const root = await mkdtemp('/tmp/cx-plugin-config-combined-')
    const configPath = path.join(root, 'config.json')
    const pluginFence = new SharedProfilePluginConfigFence(configPath, 'work')
    const permissionFence = new SharedProfilePermissionFence(configPath, 'work')
    const policies = exactDomPermissionPolicies('work', [{
      id: 'channel',
      entry: path.join(root, 'channel.js'),
      pointIds: ['manager.content'],
    }])
    try {
      await initialize(configPath)
      const releasePlugin = await pluginFence.acquire()
      await expect(updateHomeConfigAtomic(current => ({
        ...current,
        permissions: policies,
        plugins: current.plugins.map(plugin => ({ ...plugin, entry: '/fixture/new.tgz' })),
      }), configPath)).rejects.toThrow('plugin configuration is in use')
      const releasePermission = await permissionFence.acquire()
      await releasePermission()
      const unchanged = await loadHomeConfig(configPath)
      expect(unchanged.permissions).toEqual([])
      expect(unchanged.plugins[0]?.entry).toBe('/fixture/channel.tgz')
      await releasePlugin()
    } finally {
      await pluginFence.close()
      await permissionFence.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'rejects a configured-plugin writer that entered the Home lock before renderer admission',
  async () => {
    const root = await mkdtemp('/tmp/cx-plugin-config-race-')
    const configPath = path.join(root, 'config.json')
    const fence = new SharedProfilePluginConfigFence(configPath, 'work')
    let resume!: () => void
    let entered!: () => void
    const waiting = new Promise<void>(resolve => {
      entered = resolve
    })
    const paused = new Promise<void>(resolve => {
      resume = resolve
    })
    try {
      await initialize(configPath)
      const write = updateHomeConfigAtomic(async current => {
        entered()
        await paused
        return { ...current, plugins: current.plugins.map(plugin => ({ ...plugin, entry: '/fixture/new.tgz' })) }
      }, configPath)
      await waiting
      const release = await fence.acquire()
      resume()
      await expect(write).rejects.toThrow('plugin configuration is in use')
      expect((await loadHomeConfig(configPath)).plugins[0]?.entry).toBe('/fixture/channel.tgz')
      await release()
      await updateHomeConfigAtomic(current => ({
        ...current,
        plugins: current.plugins.map(plugin => ({ ...plugin, entry: '/fixture/new.tgz' })),
      }), configPath)
      expect((await loadHomeConfig(configPath)).plugins[0]?.entry).toBe('/fixture/new.tgz')
    } finally {
      resume()
      await fence.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)
