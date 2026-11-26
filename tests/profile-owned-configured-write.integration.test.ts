import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'vitest'
import { ensureHomeConfig, loadHomeConfig, updateHomeConfigAtomic } from '../packages/cli/src/config/home-config.js'
import {
  abortPluginConfigCandidate,
  commitPluginConfigCandidate,
  stagePluginConfigCandidate,
} from '../packages/cli/src/config/plugin-config.js'
import {
  fenceChangedConfiguredPlugins,
  SharedProfilePluginConfigFence,
} from '../packages/cli/src/config/profile-plugin-config-fence.js'

const unsupported = process.platform !== 'darwin' && process.platform !== 'linux'
const scope = { profileId: 'work', pluginId: 'fixture', generation: 'owner-1', ownerToken: 'a'.repeat(64) }
const privateValue = 'synthetic-private-value'

async function fixture() {
  const root = await mkdtemp('/tmp/cx-owned-configured-')
  const configPath = path.join(root, 'config.json')
  await ensureHomeConfig(configPath)
  await updateHomeConfigAtomic(current => ({
    ...current,
    plugins: [
      {
        id: 'fixture',
        entry: '/fixture/plugin.tgz',
        profiles: {
          work: { revision: 0, config: { label: 'old', token: privateValue } },
          other: { revision: 0, config: { label: 'other' } },
        },
      },
      { id: 'other', entry: '/fixture/other.tgz' },
    ],
  }), configPath)
  const fence = new SharedProfilePluginConfigFence(configPath, 'work')
  return {
    configPath,
    fence,
    close: async () => {
      await fence.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

it.skipIf(unsupported)(
  'borrows only the selected configured plugin and profile while other writes remain fenced',
  async () => {
    const f = await fixture()
    try {
      const release = await f.fence.acquire()
      const input = { ...scope, expectedRevision: 0, config: { label: 'new', token: privateValue } }
      await expect(stagePluginConfigCandidate(input, f.configPath)).rejects.toThrow('plugin configuration is in use')
      const result = await f.fence.runConfiguredMutation(
        { pluginId: scope.pluginId, isCurrent: () => true },
        async () => {
          await expect(stagePluginConfigCandidate({ ...input, pluginId: 'other' }, f.configPath))
            .rejects.toThrow('plugin configuration is in use')
          await expect(stagePluginConfigCandidate({ ...input, profileId: 'other' }, f.configPath))
            .rejects.toThrow('plugin configuration is in use')
          await expect(updateHomeConfigAtomic(current => ({
            ...current,
            plugins: current.plugins.map(plugin => ({ ...plugin, entry: '/fixture/replaced.tgz' })),
          }), f.configPath)).rejects.toThrow('plugin configuration is in use')
          await expect(updateHomeConfigAtomic(current => ({
            ...current,
            marketplaceSources: current.marketplaceSources.map(source => ({ ...source, enabled: false })),
          }), f.configPath)).rejects.toThrow('plugin configuration is in use')
          const staged = await stagePluginConfigCandidate(input, f.configPath)
          return await commitPluginConfigCandidate(
            { ...scope, candidateRevision: staged.candidateRevision },
            f.configPath,
          )
        },
      )
      expect(result).toEqual({ revision: 1, config: { label: 'new', token: privateValue } })
      const saved = await loadHomeConfig(f.configPath)
      expect(saved.plugins[0]?.profiles?.work).toEqual({ revision: 1, config: { label: 'new', token: privateValue } })
      expect(saved.plugins[0]?.profiles?.other).toEqual({ revision: 0, config: { label: 'other' } })
      await expect(stagePluginConfigCandidate({ ...input, expectedRevision: 1 }, f.configPath))
        .rejects.toThrow('plugin configuration is in use')
      await release()
    } finally {
      await f.close()
    }
  },
  30_000,
)

it.skipIf(unsupported)('does not confirm a configured plugin commit after owner authority is lost', async () => {
  const f = await fixture()
  let current = true
  try {
    const release = await f.fence.acquire()
    await expect(f.fence.runConfiguredMutation({ pluginId: scope.pluginId, isCurrent: () => current }, async () => {
      const staged = await stagePluginConfigCandidate({
        ...scope,
        expectedRevision: 0,
        config: { label: 'new', token: privateValue },
      }, f.configPath)
      await commitPluginConfigCandidate({ ...scope, candidateRevision: staged.candidateRevision }, f.configPath)
      current = false
    })).rejects.toThrow('owned configured plugin write result is uncertain')
    expect((await loadHomeConfig(f.configPath)).plugins[0]?.profiles?.work?.revision).toBe(1)
    await release()
  } finally {
    await f.close()
  }
})

it.skipIf(unsupported)('aborts a selected configured candidate without changing its committed value', async () => {
  const f = await fixture()
  try {
    const release = await f.fence.acquire()
    await f.fence.runConfiguredMutation({ pluginId: scope.pluginId, isCurrent: () => true }, async () => {
      const staged = await stagePluginConfigCandidate({
        ...scope,
        expectedRevision: 0,
        config: { label: 'new', token: privateValue },
      }, f.configPath)
      await abortPluginConfigCandidate({ ...scope, candidateRevision: staged.candidateRevision }, f.configPath)
    })
    expect((await loadHomeConfig(f.configPath)).plugins[0]?.profiles?.work).toEqual({
      revision: 0,
      config: { label: 'old', token: privateValue },
    })
    await release()
  } finally {
    await f.close()
  }
})

it.skipIf(unsupported)('rejects a detached configured write even after the profile fence is released', async () => {
  const f = await fixture()
  let resume!: () => void
  const later = new Promise<void>(resolve => resume = resolve)
  let late!: Promise<unknown>
  try {
    const release = await f.fence.acquire()
    await f.fence.runConfiguredMutation({ pluginId: scope.pluginId, isCurrent: () => true }, async () => {
      late = later.then(async () =>
        await stagePluginConfigCandidate({
          ...scope,
          expectedRevision: 0,
          config: { label: 'late', token: privateValue },
        }, f.configPath)
      )
    })
    const rejected = expect(late).rejects.toThrow('plugin configuration is in use')
    await release()
    resume()
    await rejected
    expect((await loadHomeConfig(f.configPath)).plugins[0]?.profiles?.work?.revision).toBe(0)
  } finally {
    resume()
    await f.close()
  }
})

it.skipIf(unsupported)('waits for a borrowed configured write and reports an uncertain result', async () => {
  const f = await fixture()
  let releaseBorrow: (() => Promise<void>) | undefined
  let entered!: () => void
  const ready = new Promise<void>(resolve => entered = resolve)
  try {
    const release = await f.fence.acquire()
    const previous = (await loadHomeConfig(f.configPath)).plugins
    const candidate = previous.map(plugin =>
      plugin.id !== scope.pluginId ? plugin : {
        ...plugin,
        profiles: { ...plugin.profiles, work: { revision: 1, config: { label: 'new', token: privateValue } } },
      }
    )
    const action = f.fence.runConfiguredMutation({ pluginId: scope.pluginId, isCurrent: () => true }, async () => {
      releaseBorrow = await fenceChangedConfiguredPlugins(f.configPath, previous, candidate)
      entered()
    })
    const rejected = expect(action).rejects.toThrow('owned configured plugin write result is uncertain')
    await ready
    await releaseBorrow!()
    await rejected
    await release()
  } finally {
    await releaseBorrow?.()
    await f.close()
  }
})
