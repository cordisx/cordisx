import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { SharedProfilePluginConfigFence } from '../packages/cli/src/config/profile-plugin-config-fence.js'
import { PackagePluginConfigStore } from '../packages/cli/src/launcher/package-plugin-config.js'
import { PackagePluginServiceConfigStore } from '../packages/cli/src/launcher/package-plugin-service-config.js'

const run = promisify(execFile)
const ownerToken = 'a'.repeat(64)
const generation = 'owner-1'
const serviceScope = (profileId: string) => ({
  profileId,
  pluginId: 'fixture',
  serviceId: 'runtime',
  generation,
  ownerToken,
  initialConfig: {},
})

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'fences installed package configuration across processes while preserving another profile',
  async () => {
    const root = await mkdtemp('/tmp/cx-package-profile-fence-')
    const fence = new SharedProfilePluginConfigFence(path.join(root, 'config.json'), 'work')
    const plugins = new PackagePluginConfigStore(root, 'work', generation)
    const services = new PackagePluginServiceConfigStore(root, 'work', generation)
    const pluginModule = new URL('../packages/cli/src/launcher/package-plugin-config.ts', import.meta.url).href
    const serviceModule = new URL('../packages/cli/src/launcher/package-plugin-service-config.ts', import.meta.url).href
    const fromAnotherProcess = async (profile: string, operation: string) => {
      const script = `
        import { PackagePluginConfigStore } from ${JSON.stringify(pluginModule)};
        import { PackagePluginServiceConfigStore } from ${JSON.stringify(serviceModule)};
        const [root, profile, operation] = process.argv.slice(1);
        const plugins = new PackagePluginConfigStore(root, profile, 'owner-1');
        const services = new PackagePluginServiceConfigStore(root, profile, 'owner-1');
        const scope = { profileId: profile, pluginId: 'fixture', serviceId: 'runtime',
          generation: 'owner-1', ownerToken: 'a'.repeat(64), initialConfig: {} };
        try {
          if (operation === 'plugin-stage') await plugins.stage('another', 0, { value: 1 }, scope.ownerToken);
          if (operation === 'plugin-commit') await plugins.commit('fixture', 1, scope.ownerToken);
          if (operation === 'plugin-abort') await plugins.abort('fixture', 1, scope.ownerToken);
          if (operation === 'service-stage') await services.stage({ ...scope, serviceId: 'other',
            expectedRevision: 0, config: { value: 1 }, applies: 'service-restart' });
          if (operation === 'service-commit') await services.commit({ ...scope, candidateRevision: 1,
            applies: 'service-restart' });
          if (operation === 'service-abort') await services.abort({ ...scope, candidateRevision: 1 });
          process.stdout.write('ok');
        } catch (error) { process.stdout.write(error.name); }
      `
      return (await run(process.execPath, [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        script,
        root,
        profile,
        operation,
      ], { cwd: process.cwd(), timeout: 10_000 })).stdout
    }
    try {
      await plugins.stage('fixture', 0, { value: 'pending' }, ownerToken)
      await services.stage({
        ...serviceScope('work'),
        expectedRevision: 0,
        config: { value: 'pending' },
        applies: 'service-restart',
      })
      const release = await fence.acquire()
      for (
        const operation of [
          'plugin-stage',
          'plugin-commit',
          'plugin-abort',
          'service-stage',
          'service-commit',
          'service-abort',
        ]
      ) expect(await fromAnotherProcess('work', operation)).toBe('ProfilePluginConfigFenceBusyError')
      expect(await fromAnotherProcess('other', 'plugin-stage')).toBe('ok')
      expect(await fromAnotherProcess('other', 'service-stage')).toBe('ok')

      const laterPlugins = new PackagePluginConfigStore(root, 'work', 'owner-2')
      const laterServices = new PackagePluginServiceConfigStore(root, 'work', 'owner-2')
      await laterPlugins.load('fixture')
      await laterServices.read({ profileId: 'work', pluginId: 'fixture', serviceId: 'runtime', initialConfig: {} })
      const pluginState = JSON.parse(
        await readFile(
          path.join(
            root,
            'state/profiles/work/plugins/config/fixture.json',
          ),
          'utf8',
        ),
      ) as { candidate?: unknown }
      const serviceState = JSON.parse(
        await readFile(
          path.join(
            root,
            'state/profiles/work/plugins/services/fixture/runtime.json',
          ),
          'utf8',
        ),
      ) as { state: { candidate?: unknown } }
      expect(pluginState.candidate).toBeDefined()
      expect(serviceState.state.candidate).toBeDefined()
      await release()
      await laterPlugins.load('fixture')
      await laterServices.read({ profileId: 'work', pluginId: 'fixture', serviceId: 'runtime', initialConfig: {} })
      expect(
        (JSON.parse(
          await readFile(
            path.join(
              root,
              'state/profiles/work/plugins/config/fixture.json',
            ),
            'utf8',
          ),
        ) as { candidate?: unknown }).candidate,
      ).toBeUndefined()
      expect(
        (JSON.parse(
          await readFile(
            path.join(
              root,
              'state/profiles/work/plugins/services/fixture/runtime.json',
            ),
            'utf8',
          ),
        ) as { state: { candidate?: unknown } }).state.candidate,
      ).toBeUndefined()
    } finally {
      await fence.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'does not borrow configured-service authority for installed-package state',
  async () => {
    const root = await mkdtemp('/tmp/cx-package-owned-fence-')
    const fence = new SharedProfilePluginConfigFence(path.join(root, 'config.json'), 'work')
    const plugins = new PackagePluginConfigStore(root, 'work', generation)
    const services = new PackagePluginServiceConfigStore(root, 'work', generation)
    const scope = serviceScope('work')
    try {
      const release = await fence.acquire()
      await fence.runServiceMutation({ pluginId: 'fixture', serviceId: 'runtime', isCurrent: () => true }, async () => {
        await expect(plugins.stage('fixture', 0, {}, ownerToken)).rejects.toThrow('plugin configuration is in use')
        await expect(services.stage({
          ...scope,
          serviceId: 'other',
          expectedRevision: 0,
          config: {},
          applies: 'service-restart',
        })).rejects.toThrow('plugin configuration is in use')
        await expect(services.stage({
          ...scope,
          expectedRevision: 0,
          config: { value: 1 },
          applies: 'service-restart',
        })).rejects.toThrow('plugin configuration is in use')
      })
      await release()
      await services.stage({ ...scope, expectedRevision: 0, config: { value: 1 }, applies: 'service-restart' })
      await services.commit({ ...scope, candidateRevision: 1, applies: 'service-restart' })
      expect(await services.read(scope)).toMatchObject({ revision: 1, config: { value: 1 } })
    } finally {
      await fence.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'holds a cross-process service-file lock while credential recovery inspects it',
  async () => {
    const root = await mkdtemp('/tmp/cx-package-service-file-')
    const services = new PackagePluginServiceConfigStore(root, 'work', generation)
    const serviceModule = new URL('../packages/cli/src/launcher/package-plugin-service-config.ts', import.meta.url).href
    let entered!: () => void
    let release!: () => void
    const ready = new Promise<void>(resolve => {
      entered = resolve
    })
    const waiting = new Promise<void>(resolve => {
      release = resolve
    })
    const script = `
      import { PackagePluginServiceConfigStore } from ${JSON.stringify(serviceModule)};
      const store = new PackagePluginServiceConfigStore(process.argv[1], 'work', 'owner-1');
      try { await store.stage({ profileId: 'work', pluginId: 'fixture', serviceId: 'runtime',
        generation: 'owner-1', ownerToken: 'a'.repeat(64), initialConfig: {}, expectedRevision: 0,
        config: {}, applies: 'service-restart' }); process.stdout.write('ok');
      } catch (error) { process.stdout.write(error.name); }
    `
    const stage = async () =>
      (await run(process.execPath, [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        script,
        root,
      ], { cwd: process.cwd(), timeout: 10_000 })).stdout
    const reading = services.withLockedRawState('fixture', 'runtime', async () => {
      entered()
      await waiting
    })
    try {
      await ready
      expect(await stage()).toBe('ProfilePluginConfigFenceBusyError')
      release()
      await reading
      expect(await stage()).toBe('ok')
    } finally {
      release()
      await reading.catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'releases the profile fence when its owning process crashes',
  async () => {
    const root = await mkdtemp('/tmp/cx-package-fence-crash-')
    const fenceModule = new URL('../packages/cli/src/config/profile-plugin-config-fence.ts', import.meta.url).href
    const script = `
      import { SharedProfilePluginConfigFence } from ${JSON.stringify(fenceModule)};
      import path from 'node:path';
      const fence = new SharedProfilePluginConfigFence(path.join(process.argv[1], 'config.json'), 'work');
      await fence.acquire(); process.stdout.write('ready'); setInterval(() => {}, 1000);
    `
    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      script,
      root,
    ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      await Promise.race([
        once(child.stdout!, 'data'),
        once(child, 'exit').then(() => {
          throw new Error('lock owner exited before acquiring the fence')
        }),
      ])
      const plugins = new PackagePluginConfigStore(root, 'work', generation)
      await expect(plugins.stage('fixture', 0, {}, ownerToken)).rejects.toThrow('plugin configuration is in use')
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
      expect(await plugins.stage('fixture', 0, {}, ownerToken)).toEqual({ candidateRevision: 1 })
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)
