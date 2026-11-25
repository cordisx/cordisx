import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { createDesktopManagerOwnerIfEligible } from '../packages/cli/src/cli/desktop-manager-owner.js'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { CdpPluginLifecycleRuntime } from '../packages/cli/src/launcher/cdp-plugin-lifecycle-runtime.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { PluginActivationStore } from '../packages/cli/src/launcher/plugin-activation.js'
import { startPluginGenerationArtifactServer } from '../packages/cli/src/launcher/plugin-generation-artifact-server.js'
import { removeStagedPluginPackage } from '../packages/cli/src/launcher/plugin-package.js'
import { configuredManagerPlugin } from './fixtures/configured-manager-plugin.js'
import { stageServiceModePlugin } from './fixtures/service-mode-plugin.js'

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'admits verified configured archives together while retaining the private configuration boundary',
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cx-desktop-configured-'))
    const homeDir = path.join(root, 'home')
    await mkdir(homeDir)
    const publicPlugin = await configuredManagerPlugin(root, 'configured-public')
    const privatePlugin = await configuredManagerPlugin(root, 'configured-private')
    const configPath = path.join(homeDir, 'config.json')
    await writeFile(
      configPath,
      JSON.stringify({
        ...createDefaultHomeConfig(),
        plugins: [
          { id: 'configured-public', entry: publicPlugin.archive },
          { id: 'configured-private', entry: privatePlugin.archive, config: { token: 'fixture-private' } },
        ],
      }),
      { mode: 0o600 },
    )
    const profileId = 'default'
    const generation = 'desktop-configured-fixture'
    const configured = await loadConfig(configPath, { profileId, projectRoot: homeDir })
    const artifactServer = await startPluginGenerationArtifactServer()
    let owner: Awaited<ReturnType<typeof createDesktopManagerOwnerIfEligible>> = undefined
    try {
      const input = {
        homeDir,
        configPath,
        appId: 'codex',
        profileId,
        generation,
        cdp: new CdpPluginLifecycleRuntime(),
        artifactServer,
        store: new PluginActivationStore(homeDir, profileId, generation),
        ownerVerified: true,
        attach: false,
        configuredPlugins: configured.plugins,
      }
      owner = await createDesktopManagerOwnerIfEligible(input)
      expect(owner).toBeDefined()
      expect(
        await createDesktopManagerOwnerIfEligible({
          ...input,
          configuredPlugins: [...configured.plugins, configured.plugins[0]!],
        }),
      ).toBeUndefined()
      expect(
        await createDesktopManagerOwnerIfEligible({
          ...input,
          configuredPlugins: configured.plugins.map((plugin, index) =>
            index === 0 ? { ...plugin, source: 'https://example.test/replaced' } : plugin
          ),
        }),
      ).toBeUndefined()
    } finally {
      await owner?.close()
      await artifactServer.close()
      const digests = await readdir(path.join(homeDir, 'packages', 'sha256')).catch(() => [])
      await Promise.all(
        digests.filter(digest => /^[a-f0-9]{64}$/u.test(digest)).map(async digest =>
          await removeStagedPluginPackage(homeDir, `sha256:${digest}`)
        ),
      )
      await rm(root, { recursive: true, force: true })
    }
  },
  45_000,
)

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'does not omit an unsupported installed plugin that owns a managed service',
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cx-desktop-managed-unsafe-'))
    const homeDir = path.join(root, 'home')
    await mkdir(homeDir)
    const configPath = path.join(homeDir, 'config.json')
    await writeFile(configPath, JSON.stringify(createDefaultHomeConfig()), { mode: 0o600 })
    const profileId = 'default'
    const generation = 'desktop-managed-unsafe-fixture'
    const artifactServer = await startPluginGenerationArtifactServer()
    try {
      await stageServiceModePlugin(root, homeDir, profileId, true, 'https://example.test/fixtures', undefined, {
        version: 16,
        channelExact: true,
      })
      expect(
        await createDesktopManagerOwnerIfEligible({
          homeDir,
          configPath,
          appId: 'codex',
          profileId,
          generation,
          cdp: new CdpPluginLifecycleRuntime(),
          artifactServer,
          store: new PluginActivationStore(homeDir, profileId, generation),
          ownerVerified: true,
          attach: false,
          configuredPlugins: [],
        }),
      ).toBeUndefined()
    } finally {
      await artifactServer.close()
      const digests = await readdir(path.join(homeDir, 'packages', 'sha256')).catch(() => [])
      await Promise.all(
        digests.filter(digest => /^[a-f0-9]{64}$/u.test(digest)).map(async digest =>
          await removeStagedPluginPackage(homeDir, `sha256:${digest}`)
        ),
      )
      await rm(root, { recursive: true, force: true })
    }
  },
  45_000,
)
