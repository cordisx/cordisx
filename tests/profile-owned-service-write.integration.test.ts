import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { ensureHomeConfig, loadHomeConfig, updateHomeConfigAtomic } from '../packages/cli/src/config/home-config.js'
import { commitServiceConfigCandidate, stageServiceConfigCandidate } from '../packages/cli/src/config/service-config.js'
import * as serviceWriteHelpers from '../packages/cli/src/config/owned-profile-service-write.js'
import {
  fenceChangedConfiguredPlugins,
  SharedProfilePluginConfigFence,
} from '../packages/cli/src/config/profile-plugin-config-fence.js'

const exec = promisify(execFile)
const scope = {
  profileId: 'work',
  pluginId: 'channel',
  serviceId: 'runtime',
  generation: 'owner-1',
  ownerToken: 'a'.repeat(64),
}
const owner = { pluginId: 'channel', serviceId: 'runtime', isCurrent: () => true }

async function fixture() {
  const root = await mkdtemp('/tmp/cx-owned-service-')
  const configPath = path.join(root, 'config.json')
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
  const fence = new SharedProfilePluginConfigFence(configPath, 'work')
  const external = async (profileId: string, expectedRevision: number) => {
    const moduleUrl = new URL('../packages/cli/src/config/service-config.ts', import.meta.url).href
    const input = {
      ...scope,
      profileId,
      expectedRevision,
      config: { enabled: true },
      initialConfig: {},
      applies: 'service-restart',
    }
    const script = `
      import { stageServiceConfigCandidate } from ${JSON.stringify(moduleUrl)};
      try { await stageServiceConfigCandidate(JSON.parse(process.argv[2]), process.argv[1]); process.stdout.write('staged'); }
      catch (error) { process.stdout.write(error.name); }
    `
    return (await exec(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      script,
      configPath,
      JSON.stringify(input),
    ], {
      cwd: process.cwd(),
      timeout: 10_000,
    })).stdout
  }
  return {
    root,
    configPath,
    fence,
    external,
    close: async () => {
      await fence.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

const unsupported = process.platform !== 'darwin' && process.platform !== 'linux'

it.skipIf(unsupported)('requires an actual held profile fence to authorize an owner service write', async () => {
  const f = await fixture()
  try {
    expect(serviceWriteHelpers).not.toHaveProperty('runOwnedServiceWrite')
    let invoked = false
    await expect(f.fence.runServiceMutation(owner, async () => {
      invoked = true
    })).rejects.toThrow('plugin configuration fence is closed')
    expect(invoked).toBe(false)
    expect((await loadHomeConfig(f.configPath)).plugins[0]?.services?.runtime?.profiles?.work?.revision).toBe(0)
  } finally {
    await f.close()
  }
})

it.skipIf(unsupported)('lets the owning service commit while other writers remain fenced', async () => {
  const f = await fixture()
  try {
    const release = await f.fence.acquire()
    const mutation = {
      ...scope,
      expectedRevision: 0,
      config: { enabled: true },
      initialConfig: {},
      applies: 'service-restart' as const,
    }
    await expect(stageServiceConfigCandidate(mutation, f.configPath)).rejects.toThrow('plugin configuration is in use')
    const result = await f.fence.runServiceMutation(owner, async () => {
      expect(await f.external('work', 0)).toBe('ProfilePluginConfigFenceBusyError')
      const staged = await stageServiceConfigCandidate(mutation, f.configPath)
      await commitServiceConfigCandidate({
        ...scope,
        candidateRevision: staged.candidateRevision,
        initialConfig: {},
        applies: 'service-restart',
      }, f.configPath)
      expect(await f.external('other', 0)).toBe('staged')
      return 'committed'
    })
    expect(result).toBe('committed')
    expect((await loadHomeConfig(f.configPath)).plugins[0]?.services?.runtime?.profiles?.work)
      .toMatchObject({ revision: 1, lastGoodRevision: 1, config: { enabled: true } })
    expect(await f.external('work', 1)).toBe('ProfilePluginConfigFenceBusyError')
    await release()
    expect(await f.external('work', 1)).toBe('staged')
  } finally {
    await f.close()
  }
}, 30_000)

it.skipIf(unsupported)('rejects changes outside the exact service and profile', async () => {
  const f = await fixture()
  try {
    const release = await f.fence.acquire()
    await f.fence.runServiceMutation(owner, async () => {
      await expect(updateHomeConfigAtomic(current => ({
        ...current,
        plugins: current.plugins.map(plugin => ({ ...plugin, entry: '/fixture/replaced.tgz' })),
      }), f.configPath)).rejects.toThrow('plugin configuration is in use')
      await expect(stageServiceConfigCandidate({
        ...scope,
        profileId: 'other',
        expectedRevision: 0,
        config: { enabled: true },
        initialConfig: {},
        applies: 'service-restart',
      }, f.configPath)).rejects.toThrow('plugin configuration is in use')
      await expect(updateHomeConfigAtomic(current => ({
        ...current,
        plugins: current.plugins.map(plugin => ({
          ...plugin,
          services: { ...plugin.services, unrelated: { profiles: {} } },
        })),
      }), f.configPath)).rejects.toThrow('plugin configuration is in use')
      await expect(updateHomeConfigAtomic(current => {
        const mutable = current as { environmentVariables: Array<{ name: string; value: string; enabled: boolean }> }
        mutable.environmentVariables = [{ name: 'FIXTURE_VALUE', value: 'sample', enabled: true }]
        return {
          ...current,
          plugins: current.plugins.map(plugin => ({
            ...plugin,
            services: {
              ...plugin.services,
              runtime: {
                profiles: {
                  ...plugin.services?.runtime?.profiles,
                  work: { revision: 1, lastGoodRevision: 1, config: { enabled: true } },
                },
              },
            },
          })),
        }
      }, f.configPath)).rejects.toThrow('plugin configuration is in use')
    })
    expect((await loadHomeConfig(f.configPath)).plugins[0]?.entry).toBe('/fixture/channel.tgz')
    await release()
  } finally {
    await f.close()
  }
})

it.skipIf(unsupported)('does not report a committed update as confirmed after owner loss', async () => {
  const f = await fixture()
  let current = true
  try {
    const release = await f.fence.acquire()
    const action = f.fence.runServiceMutation({ ...owner, isCurrent: () => current }, async () => {
      const staged = await stageServiceConfigCandidate({
        ...scope,
        expectedRevision: 0,
        config: { enabled: true },
        initialConfig: {},
        applies: 'service-restart',
      }, f.configPath)
      await commitServiceConfigCandidate({
        ...scope,
        candidateRevision: staged.candidateRevision,
        initialConfig: {},
        applies: 'service-restart',
      }, f.configPath)
      current = false
      return 'applied'
    })
    await expect(action).rejects.toThrow('owned service write result is uncertain')
    expect((await loadHomeConfig(f.configPath)).plugins[0]?.services?.runtime?.profiles?.work?.revision).toBe(1)
    expect(await f.external('work', 1)).toBe('ProfilePluginConfigFenceBusyError')
    await release()
  } finally {
    await f.close()
  }
})

it.skipIf(unsupported)('rejects a detached write after the owner action has ended', async () => {
  const f = await fixture()
  let resume!: () => void
  const later = new Promise<void>(resolve => {
    resume = resolve
  })
  let late!: Promise<unknown>
  try {
    const release = await f.fence.acquire()
    await f.fence.runServiceMutation(owner, async () => {
      late = later.then(async () =>
        await stageServiceConfigCandidate({
          ...scope,
          expectedRevision: 0,
          config: { enabled: true },
          initialConfig: {},
          applies: 'service-restart',
        }, f.configPath)
      )
    })
    const rejected = expect(late).rejects.toThrow('plugin configuration is in use')
    await release()
    resume()
    await rejected
    expect((await loadHomeConfig(f.configPath)).plugins[0]?.services?.runtime?.profiles?.work?.candidate)
      .toBeUndefined()
  } finally {
    resume()
    await f.close()
  }
})

it.skipIf(unsupported)('holds the lock until a detached borrowed publication has finished', async () => {
  const f = await fixture()
  let notify!: () => void
  const borrowed = new Promise<void>(resolve => {
    notify = resolve
  })
  let finish!: () => Promise<void>
  try {
    const release = await f.fence.acquire()
    const previous = (await loadHomeConfig(f.configPath)).plugins
    const candidate = structuredClone(previous) as Array<any>
    candidate[0].services.runtime.profiles.work.config = { enabled: true }
    let settled = false
    const action = f.fence.runServiceMutation(owner, async () => {
      finish = await fenceChangedConfiguredPlugins(f.configPath, previous, candidate)
      notify()
      throw new Error('simulated rejection')
    })
    const rejected = expect(action).rejects.toThrow('owned service write result is uncertain')
    void action.finally(() => {
      settled = true
    }).catch(() => {})
    await borrowed
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(settled).toBe(false)
    await finish()
    await rejected
    await release()
  } finally {
    await finish?.()
    await f.close()
  }
})

it.skipIf(unsupported)('queues a reentrant lease release without falsely acknowledging cleanup', async () => {
  const f = await fixture()
  try {
    const release = await f.fence.acquire()
    await expect(f.fence.runServiceMutation(owner, async () => await release()))
      .rejects.toThrow('plugin configuration fence is closed')
    await release()
    expect(await f.external('work', 0)).toBe('staged')
  } finally {
    await f.close()
  }
})

it.skipIf(unsupported)('queues closure without waiting on its own owner action', async () => {
  const f = await fixture()
  try {
    await f.fence.acquire()
    await expect(f.fence.runServiceMutation(owner, async () => await f.fence.close()))
      .rejects.toThrow('owned service write result is uncertain')
    await f.fence.close()
    expect(await f.external('work', 0)).toBe('staged')
  } finally {
    await f.close()
  }
})

it.skipIf(unsupported)('keeps the lock until an invalidated owner has stopped its pending update', async () => {
  const f = await fixture()
  const outsider = new SharedProfilePluginConfigFence(f.configPath, 'work')
  let entered!: () => void
  let resume!: () => void
  const waiting = new Promise<void>(resolve => {
    entered = resolve
  })
  const paused = new Promise<void>(resolve => {
    resume = resolve
  })
  let current = true
  try {
    const release = await f.fence.acquire()
    const action = f.fence.runServiceMutation(
      { ...owner, isCurrent: () => current },
      async () =>
        await updateHomeConfigAtomic(async config => {
          entered()
          await paused
          return {
            ...config,
            plugins: config.plugins.map(plugin => ({
              ...plugin,
              services: {
                ...plugin.services,
                runtime: {
                  profiles: {
                    ...plugin.services?.runtime?.profiles,
                    work: { revision: 1, lastGoodRevision: 1, config: { enabled: true } },
                  },
                },
              },
            })),
          }
        }, f.configPath),
    )
    const rejected = expect(action).rejects.toThrow('owned service write result is uncertain')
    await waiting
    current = false
    let released = false
    const releasing = release().then(() => {
      released = true
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(released).toBe(false)
    await expect(outsider.acquire()).rejects.toThrow('plugin configuration is in use')
    resume()
    await rejected
    await releasing
    const acquire = await outsider.acquire()
    await acquire()
    expect((await loadHomeConfig(f.configPath)).plugins[0]?.services?.runtime?.profiles?.work?.revision).toBe(0)
  } finally {
    resume()
    await outsider.close()
    await f.close()
  }
})
