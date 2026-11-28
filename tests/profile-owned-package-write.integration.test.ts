import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { updateHomeConfigAtomic } from '../packages/cli/src/config/home-config.js'
import {
  fencePackageProfileWrite,
  SharedProfilePluginConfigFence,
} from '../packages/cli/src/config/profile-plugin-config-fence.js'
import { PackagePluginConfigStore } from '../packages/cli/src/launcher/package-plugin-config.js'
import { PackagePluginServiceConfigStore } from '../packages/cli/src/launcher/package-plugin-service-config.js'

const unsupported = process.platform !== 'darwin' && process.platform !== 'linux'
const token = 'a'.repeat(64)
const owner = { pluginId: 'fixture', isCurrent: () => true }
const exec = promisify(execFile)

it.skipIf(unsupported)('borrows only the selected package configuration while keeping the profile fenced', async () => {
  const root = await mkdtemp('/tmp/cx-owned-package-')
  const otherRoot = await mkdtemp('/tmp/cx-owned-package-other-')
  const fence = new SharedProfilePluginConfigFence(path.join(root, 'config.json'), 'work')
  const plugins = new PackagePluginConfigStore(root, 'work', 'generation')
  const otherProfile = new PackagePluginConfigStore(root, 'other', 'generation')
  const otherHome = new PackagePluginConfigStore(otherRoot, 'work', 'generation')
  const services = new PackagePluginServiceConfigStore(root, 'work', 'generation')
  const otherFence = new SharedProfilePluginConfigFence(path.join(root, 'config.json'), 'other')
  try {
    const release = await fence.acquire()
    await expect(plugins.stage('fixture', 0, { value: 1 }, token)).rejects.toThrow('plugin configuration is in use')
    await fence.runPackageMutation(owner, async () => {
      await expect(plugins.stage('another', 0, {}, token)).rejects.toThrow('plugin configuration is in use')
      await expect(otherProfile.stage('fixture', 0, {}, token)).rejects.toThrow('plugin configuration is in use')
      await expect(otherHome.stage('fixture', 0, {}, token)).rejects.toThrow('plugin configuration is in use')
      await expect(updateHomeConfigAtomic(current => current, path.join(root, 'config.json')))
        .rejects.toThrow('plugin configuration is in use')
      const releaseOther = await otherFence.acquire()
      try {
        await expect(otherFence.runServiceMutation({
          pluginId: 'fixture',
          serviceId: 'runtime',
          isCurrent: () => true,
        }, async () => {})).rejects.toThrow('owned service write is unavailable')
      } finally {
        await releaseOther()
      }
      await expect(services.stage({
        profileId: 'work',
        pluginId: 'fixture',
        serviceId: 'runtime',
        generation: 'generation',
        ownerToken: token,
        initialConfig: {},
        expectedRevision: 0,
        config: {},
        applies: 'service-restart',
      })).rejects.toThrow('plugin configuration is in use')
      const storeModule = new URL('../packages/cli/src/launcher/package-plugin-config.ts', import.meta.url).href
      const script = `
        import { PackagePluginConfigStore } from ${JSON.stringify(storeModule)};
        const store = new PackagePluginConfigStore(process.argv[1], 'work', 'generation');
        try { await store.stage('fixture', 0, {}, 'a'.repeat(64)); process.stdout.write('unexpected'); }
        catch (error) { process.stdout.write(error.name); }
      `
      const child = await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, root])
      expect(child.stdout).toBe('ProfilePluginConfigFenceBusyError')
      const staged = await plugins.stage('fixture', 0, { value: 1 }, token)
      expect(await plugins.commit('fixture', staged.candidateRevision, token)).toMatchObject({ revision: 1 })
    })
    expect(await plugins.loadStable('fixture')).toEqual({ revision: 1, config: { value: 1 } })
    await expect(plugins.stage('fixture', 1, {}, token)).rejects.toThrow('plugin configuration is in use')
    await release()
  } finally {
    await fence.close()
    await otherFence.close()
    await rm(root, { recursive: true, force: true })
    await rm(otherRoot, { recursive: true, force: true })
  }
})

it.skipIf(unsupported)('does not dispatch a package action under an already-stale owner', async () => {
  const root = await mkdtemp('/tmp/cx-owned-package-preflight-')
  const fence = new SharedProfilePluginConfigFence(path.join(root, 'config.json'), 'work')
  let dispatched = false
  try {
    const release = await fence.acquire()
    await expect(fence.runPackageMutation({ ...owner, isCurrent: () => false }, async () => {
      dispatched = true
    })).rejects.toThrow('owned package write is unavailable')
    expect(dispatched).toBe(false)
    await release()
  } finally {
    await fence.close()
    await rm(root, { recursive: true, force: true })
  }
})

it.skipIf(unsupported)('rejects a detached package write after its owner scope ends', async () => {
  const root = await mkdtemp('/tmp/cx-owned-package-late-')
  const fence = new SharedProfilePluginConfigFence(path.join(root, 'config.json'), 'work')
  const plugins = new PackagePluginConfigStore(root, 'work', 'generation')
  let resume!: () => void
  const later = new Promise<void>(resolve => resume = resolve)
  let late!: Promise<unknown>
  try {
    const release = await fence.acquire()
    await fence.runPackageMutation(owner, async () => {
      late = later.then(async () => await plugins.stage('fixture', 0, { value: 1 }, token))
    })
    const rejected = expect(late).rejects.toThrow('plugin configuration is in use')
    await release()
    resume()
    await rejected
    expect(await plugins.loadStable('fixture')).toEqual({ revision: 0, config: {} })
  } finally {
    resume()
    await fence.close()
    await rm(root, { recursive: true, force: true })
  }
})

it.skipIf(unsupported)('waits for borrowed work and reports uncertain completion', async () => {
  const root = await mkdtemp('/tmp/cx-owned-package-drain-')
  const fence = new SharedProfilePluginConfigFence(path.join(root, 'config.json'), 'work')
  const plugins = new PackagePluginConfigStore(root, 'work', 'generation')
  let releaseBorrow: (() => Promise<void>) | undefined
  let entered!: () => void
  const ready = new Promise<void>(resolve => entered = resolve)
  try {
    const release = await fence.acquire()
    const action = fence.runPackageMutation(owner, async () => {
      releaseBorrow = await fencePackageProfileWrite(root, 'work', 'fixture')
      entered()
    })
    const rejected = expect(action).rejects.toThrow('owned package write result is uncertain')
    await ready
    await expect(plugins.stage('fixture', 0, {}, token)).rejects.toThrow('plugin configuration is in use')
    await releaseBorrow!()
    await rejected
    await release()
  } finally {
    await releaseBorrow?.()
    await fence.close()
    await rm(root, { recursive: true, force: true })
  }
})

it.skipIf(unsupported)('does not confirm a package commit after its owner becomes stale', async () => {
  const root = await mkdtemp('/tmp/cx-owned-package-stale-')
  const fence = new SharedProfilePluginConfigFence(path.join(root, 'config.json'), 'work')
  const plugins = new PackagePluginConfigStore(root, 'work', 'generation')
  let current = true
  try {
    const release = await fence.acquire()
    await expect(fence.runPackageMutation({ ...owner, isCurrent: () => current }, async () => {
      const staged = await plugins.stage('fixture', 0, { value: 1 }, token)
      await plugins.commit('fixture', staged.candidateRevision, token)
      current = false
    })).rejects.toThrow('owned package write result is uncertain')
    expect(await plugins.loadStable('fixture')).toEqual({ revision: 1, config: { value: 1 } })
    await release()
  } finally {
    await fence.close()
    await rm(root, { recursive: true, force: true })
  }
})
