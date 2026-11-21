import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { ensureHomeConfig, loadHomeConfig, updateHomeConfigAtomic } from '../packages/cli/src/config/home-config.js'
import { SharedProfilePermissionFence } from '../packages/cli/src/config/profile-permission-fence.js'
import { persistPermissionPolicies } from '../packages/cli/src/launcher/permission-rpc.js'
import { exactDomPermissionPolicies } from './helpers/dom-permission.js'

const run = promisify(execFile)

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'fences cross-process policy writes until the last renderer releases the same profile',
  async () => {
    const root = await mkdtemp('/tmp/cx-policy-fence-')
    const configPath = path.join(root, 'config.json')
    const fence = new SharedProfilePermissionFence(configPath, 'work')
    const [policy] = exactDomPermissionPolicies('work', [{
      id: 'sample',
      entry: path.join(root, 'sample.js'),
      pointIds: ['manager.content'],
    }])
    const [other] = exactDomPermissionPolicies('other', [{
      id: 'sample',
      entry: path.join(root, 'sample.js'),
      pointIds: ['manager.content'],
    }])
    const moduleUrl = new URL('../packages/cli/src/launcher/permission-rpc.ts', import.meta.url).href
    const writeFromAnotherProcess = async () => {
      const script = `
        import { persistPermissionPolicies } from ${JSON.stringify(moduleUrl)};
        try {
          await persistPermissionPolicies({ configPath: process.argv[1] }, JSON.parse(process.argv[2]));
          process.stdout.write('applied');
        } catch (error) { process.stdout.write(error.name); }
      `
      return (await run(process.execPath, [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        script,
        configPath,
        JSON.stringify([policy]),
      ], { cwd: process.cwd(), timeout: 10_000 })).stdout
    }
    try {
      await ensureHomeConfig(configPath)
      const first = await fence.acquire()
      const second = await fence.acquire()
      expect(await writeFromAnotherProcess()).toBe('ProfilePermissionFenceBusyError')
      await persistPermissionPolicies({ configPath }, [other!])
      expect((await loadHomeConfig(configPath)).permissions).toEqual([other])
      // Updaters are permitted to mutate their argument; the pre-update ledger
      // still has to be captured before invoking one.
      await expect(updateHomeConfigAtomic(current => {
        const permissions = current.permissions as Array<NonNullable<typeof policy>>
        permissions.push(policy!)
        return current
      }, configPath)).rejects.toThrow('permission policy is in use')
      await first()
      expect(await writeFromAnotherProcess()).toBe('ProfilePermissionFenceBusyError')
      await second()
      expect(await writeFromAnotherProcess()).toBe('applied')
      expect((await loadHomeConfig(configPath)).permissions).toEqual([other, policy])
    } finally {
      await fence.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'rejects a writer that entered the Home lock before renderer admission',
  async () => {
    const root = await mkdtemp('/tmp/cx-policy-race-')
    const configPath = path.join(root, 'config.json')
    const fence = new SharedProfilePermissionFence(configPath, 'work')
    let continueWrite!: () => void
    let entered!: () => void
    const waiting = new Promise<void>(resolve => {
      entered = resolve
    })
    const paused = new Promise<void>(resolve => {
      continueWrite = resolve
    })
    const [policy] = exactDomPermissionPolicies('work', [{
      id: 'sample',
      entry: path.join(root, 'sample.js'),
      pointIds: ['manager.content'],
    }])
    try {
      await ensureHomeConfig(configPath)
      const write = updateHomeConfigAtomic(async current => {
        entered()
        await paused
        return { ...current, permissions: [policy!] }
      }, configPath)
      await waiting
      const release = await fence.acquire()
      continueWrite()
      await expect(write).rejects.toThrow('permission policy is in use')
      expect((await loadHomeConfig(configPath)).permissions).toEqual([])
      await release()
      await persistPermissionPolicies({ configPath }, [policy!])
      expect((await loadHomeConfig(configPath)).permissions).toEqual([policy])
    } finally {
      continueWrite()
      await fence.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'does not return a usable lease when its owner closes during acquisition',
  async () => {
    const root = await mkdtemp('/tmp/cx-policy-close-')
    const configPath = path.join(root, 'config.json')
    const first = new SharedProfilePermissionFence(configPath, 'work')
    const second = new SharedProfilePermissionFence(configPath, 'work')
    try {
      const pending = first.acquire()
      await Promise.resolve()
      const closing = first.close()
      await expect(pending).rejects.toThrow('permission fence is closed')
      await closing
      const release = await second.acquire()
      await release()
    } finally {
      await first.close()
      await second.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'preserves the policy ordering delivered to a live renderer',
  async () => {
    const root = await mkdtemp('/tmp/cx-policy-order-')
    const configPath = path.join(root, 'config.json')
    const fence = new SharedProfilePermissionFence(configPath, 'work')
    const policies = exactDomPermissionPolicies('work', [{
      id: 'sample',
      entry: path.join(root, 'sample.js'),
      pointIds: ['manager.content', 'manager.settings.navigation-items'],
    }])
    try {
      await ensureHomeConfig(configPath)
      await persistPermissionPolicies({ configPath }, policies)
      const release = await fence.acquire()
      await updateHomeConfigAtomic(current => current, configPath)
      await expect(updateHomeConfigAtomic(current => ({
        ...current,
        permissions: [...current.permissions].reverse(),
      }), configPath)).rejects.toThrow('permission policy is in use')
      expect((await loadHomeConfig(configPath)).permissions).toEqual(policies)
      await release()
    } finally {
      await fence.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'releases previously acquired profile locks when a multi-profile write is rejected',
  async () => {
    const root = await mkdtemp('/tmp/cx-policy-batch-')
    const configPath = path.join(root, 'config.json')
    const first = new SharedProfilePermissionFence(configPath, 'first')
    const second = new SharedProfilePermissionFence(configPath, 'second')
    const plugin = [{ id: 'sample', entry: path.join(root, 'sample.js'), pointIds: ['manager.content'] }]
    const policies = [
      ...exactDomPermissionPolicies('first', plugin),
      ...exactDomPermissionPolicies('second', plugin),
    ]
    try {
      await ensureHomeConfig(configPath)
      const releaseSecond = await second.acquire()
      await expect(persistPermissionPolicies({ configPath }, policies)).rejects.toThrow('permission policy is in use')
      const releaseFirst = await first.acquire()
      await releaseFirst()
      expect((await loadHomeConfig(configPath)).permissions).toEqual([])
      await releaseSecond()
      await persistPermissionPolicies({ configPath }, policies)
      expect((await loadHomeConfig(configPath)).permissions).toEqual(policies)
    } finally {
      await first.close()
      await second.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)
