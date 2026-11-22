import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'vitest'
import { ensureHomeConfig, loadHomeConfig, updateHomeConfigAtomic } from '../packages/cli/src/config/home-config.js'
import { SharedProfilePermissionFence } from '../packages/cli/src/config/profile-permission-fence.js'
import * as ownedPermissionWrite from '../packages/cli/src/config/owned-profile-permission-write.js'
import {
  fencePackageProfileWrite,
  SharedProfilePluginConfigFence,
} from '../packages/cli/src/config/profile-plugin-config-fence.js'
import {
  persistPermissionPolicies,
  persistPermissionPoliciesIfUnchanged,
} from '../packages/cli/src/launcher/permission-rpc.js'
import { mergePersistedPermissionPolicies } from '../packages/cli/src/permission-persistence.js'
import { createPermissionPolicyRecord } from '../packages/cli/src/permissions.js'
import { exactDomPermissionPolicies } from './helpers/dom-permission.js'

function policy(profileId: string, value: 'allow' | 'deny') {
  return createPermissionPolicyRecord({
    profileId,
    identity: { source: 'https://example.test/plugins', id: 'fixture' },
    capability: 'models.read',
    scope: { providers: ['codex'] },
    policy: value,
  })
}

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'publishes only the owner-selected policy batch while other renderer leases remain held',
  async () => {
    const root = await mkdtemp('/tmp/cx-owned-policy-')
    const configPath = path.join(root, 'config.json')
    const fence = new SharedProfilePermissionFence(configPath, 'work')
    const allowed = policy('work', 'allow')
    const denied = policy('work', 'deny')
    const other = policy('other', 'allow')
    try {
      expect(ownedPermissionWrite).not.toHaveProperty('runOwnedPermissionWrite')
      await ensureHomeConfig(configPath)
      let dispatched = false
      await expect(fence.runPolicyMutation({ expected: [], updates: [allowed], isCurrent: () => true }, async () => {
        dispatched = true
      })).rejects.toThrow('permission fence is closed')
      expect(dispatched).toBe(false)
      await persistPermissionPolicies({ configPath }, [allowed, other])
      const first = await fence.acquire()
      const second = await fence.acquire()
      const result = await fence.runPolicyMutation({
        expected: [allowed],
        updates: [denied],
        isCurrent: () => true,
      }, async () =>
        await persistPermissionPoliciesIfUnchanged({
          configPath,
          profileId: 'work',
          expected: [allowed],
          assertCurrent: () => {},
        }, [denied]))
      expect(result.records).toEqual([denied])
      expect((await loadHomeConfig(configPath)).permissions).toEqual([other, denied])
      await expect(persistPermissionPolicies({ configPath }, [allowed])).rejects.toThrow('permission policy is in use')
      await first()
      await expect(persistPermissionPolicies({ configPath }, [allowed])).rejects.toThrow('permission policy is in use')
      await second()
      await persistPermissionPolicies({ configPath }, [allowed])
    } finally {
      await fence.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'rejects a different profile, unrelated Home changes and writes that outlive the owner scope',
  async () => {
    const root = await mkdtemp('/tmp/cx-owned-policy-scope-')
    const configPath = path.join(root, 'config.json')
    const otherConfigPath = path.join(root, 'other.json')
    const fence = new SharedProfilePermissionFence(configPath, 'work')
    const allowed = policy('work', 'allow')
    const denied = policy('work', 'deny')
    const other = policy('other', 'deny')
    let resume!: () => void
    let entered!: () => void
    const waiting = new Promise<void>(resolve => {
      entered = resolve
    })
    const gate = new Promise<void>(resolve => {
      resume = resolve
    })
    let late: Promise<unknown> | undefined
    try {
      await ensureHomeConfig(configPath)
      await ensureHomeConfig(otherConfigPath)
      await persistPermissionPolicies({ configPath }, [allowed])
      const release = await fence.acquire()
      const scope = { expected: [allowed], updates: [denied], isCurrent: () => true }
      await expect(fence.runPolicyMutation(scope, async () => await persistPermissionPolicies({ configPath }, [other])))
        .rejects.toThrow('permission policy is in use')
      await expect(
        fence.runPolicyMutation(
          scope,
          async () => await persistPermissionPolicies({ configPath: otherConfigPath }, [denied]),
        ),
      ).rejects.toThrow('permission policy is in use')
      await expect(fence.runPolicyMutation(scope, async () =>
        await updateHomeConfigAtomic(current => ({
          ...current,
          permissions: mergePersistedPermissionPolicies(current.permissions, [denied]),
          apps: {
            ...current.apps,
            codex: {
              ...current.apps.codex!,
              profiles: {
                ...current.apps.codex!.profiles,
                default: { ...current.apps.codex!.profiles.default!, displayName: 'Unexpected change' },
              },
            },
          },
        }), configPath))).rejects.toThrow('permission policy is in use')
      await expect(fence.runPolicyMutation(scope, async () => {
        late = updateHomeConfigAtomic(async current => {
          entered()
          await gate
          return { ...current, permissions: mergePersistedPermissionPolicies(current.permissions, [denied]) }
        }, configPath)
        void late.catch(() => undefined)
        await waiting
        return 'not committed'
      })).rejects.toThrow('owned permission write result is uncertain')
      resume()
      await expect(late).rejects.toThrow('permission policy is in use')
      expect((await loadHomeConfig(configPath)).permissions).toEqual([allowed])
      await release()
    } finally {
      resume()
      await fence.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'retains the exact v3 plugin source and extension point during a policy replacement',
  async () => {
    const root = await mkdtemp('/tmp/cx-owned-dom-policy-')
    const configPath = path.join(root, 'config.json')
    const fence = new SharedProfilePermissionFence(configPath, 'work')
    const [allowed] = exactDomPermissionPolicies('work', [{
      id: 'channel',
      entry: path.join(root, 'channel.js'),
      pointIds: ['manager.content'],
    }])
    const denied = { ...allowed!, policy: 'deny-persistent' as const }
    try {
      await ensureHomeConfig(configPath)
      await persistPermissionPolicies({ configPath }, [allowed!])
      const release = await fence.acquire()
      await fence.runPolicyMutation(
        { expected: [allowed!], updates: [denied], isCurrent: () => true },
        async () =>
          await persistPermissionPoliciesIfUnchanged({
            configPath,
            profileId: 'work',
            expected: [allowed!],
            assertCurrent: () => {},
          }, [denied]),
      )
      expect((await loadHomeConfig(configPath)).permissions).toEqual([denied])
      await release()
    } finally {
      await fence.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'reports an uncertain committed write and rejects nested profile-fence ownership',
  async () => {
    const root = await mkdtemp('/tmp/cx-owned-policy-loss-')
    const configPath = path.join(root, 'config.json')
    const fence = new SharedProfilePermissionFence(configPath, 'work')
    const plugins = new SharedProfilePluginConfigFence(configPath, 'work')
    const allowed = policy('work', 'allow')
    const denied = policy('work', 'deny')
    let current = true
    try {
      await ensureHomeConfig(configPath)
      await persistPermissionPolicies({ configPath }, [allowed])
      const release = await fence.acquire()
      const releasePlugins = await plugins.acquire()
      await expect(
        fence.runPolicyMutation({ expected: [allowed], updates: [denied], isCurrent: () => current }, async () => {
          const result = await persistPermissionPolicies({ configPath }, [denied])
          current = false
          return result
        }),
      ).rejects.toThrow('owned permission write result is uncertain')
      expect((await loadHomeConfig(configPath)).permissions).toEqual([denied])
      current = true
      const scope = { expected: [denied], updates: [allowed], isCurrent: () => current }
      await expect(
        fence.runPolicyMutation(scope, async () => {
          const releaseOther = await fencePackageProfileWrite(root, 'other', 'fixture')
          await releaseOther()
        }),
      ).rejects.toThrow('plugin configuration is in use')
      await expect(
        fence.runPolicyMutation(scope, async () =>
          await plugins.runPackageMutation({
            pluginId: 'fixture',
            isCurrent: () => true,
          }, async () => {})),
      ).rejects.toThrow('owned package write is unavailable')
      await expect(
        plugins.runPackageMutation({
          pluginId: 'fixture',
          isCurrent: () => true,
        }, async () => await fence.runPolicyMutation(scope, async () => {})),
      ).rejects.toThrow('owned permission write is unavailable')
      await releasePlugins()
      await release()
    } finally {
      await plugins.close()
      await fence.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)
