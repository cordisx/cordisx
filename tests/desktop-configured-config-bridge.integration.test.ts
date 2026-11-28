import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'vitest'
import {
  DesktopPackageConfigWrite,
  DesktopPackageConfigWriteGate,
} from '../packages/cli/src/cli/desktop-package-config-write.js'
import { ensureHomeConfig, loadHomeConfig, updateHomeConfigAtomic } from '../packages/cli/src/config/home-config.js'
import { SharedProfilePluginConfigFence } from '../packages/cli/src/config/profile-plugin-config-fence.js'
import { createConfigBridgeHandler, parseConfigBindingRequest } from '../packages/cli/src/launcher/config-rpc.js'

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'uses the native configured-plugin bridge while preserving owner-held private fields',
  async () => {
    const homeDir = await mkdtemp('/tmp/cx-configured-bridge-')
    const configPath = path.join(homeDir, 'config.json')
    const profileId = 'work'
    const generation = 'owner-1'
    const token = 'a'.repeat(64)
    const seat = {}
    const privateValue = 'synthetic-private-value'
    const fence = new SharedProfilePluginConfigFence(configPath, profileId)
    const gate = new DesktopPackageConfigWriteGate()
    try {
      await ensureHomeConfig(configPath)
      await updateHomeConfigAtomic(current => ({
        ...current,
        plugins: [{ id: 'fixture', entry: '/fixture/plugin.tgz', config: { label: 'old', token: privateValue } }],
      }), configPath)
      const snapshot: any = {
        active: { profileId, runtimeGeneration: generation, plugins: [] },
        registryEpoch: 1,
      }
      const plugin: any = {
        id: 'fixture',
        entry: '/fixture/plugin.tgz',
        source: 'https://example.test/fixture',
        enabled: true,
        revision: 0,
        config: { label: 'old', token: privateValue },
        configuredArchiveDigest: 'sha256:' + 'b'.repeat(64),
        distributionArtifact: { version: '1.0.0', integrity: 'sha256:' + 'c'.repeat(64) },
      }
      const proof: any = {
        snapshot,
        plugin: {
          id: plugin.id,
          source: plugin.source,
          configured: { ...plugin.distributionArtifact, moduleGeneration: 'fixture-generation' },
          configuration: {
            namespace: plugin.id,
            schemaKind: 'schemastery',
            applies: 'live',
            writable: true,
            revision: 0,
            lastGoodRevision: 0,
            value: { label: 'old' },
            fields: [{ path: ['label'], type: 'string' }, { path: ['token'], type: 'string', role: 'secret' }],
            secrets: [{ path: ['token'], set: false }],
          },
        },
      }
      const operation: any = {
        kind: 'plugin-configuration',
        action: 'update',
        pluginId: plugin.id,
        expectedRevision: 0,
        operations: [{ op: 'set', path: ['label'], value: 'new' }],
      }
      const release = await fence.acquire()
      const write = new DesktopPackageConfigWrite({
        snapshot,
        plugin,
        proof,
        operation,
        profileId,
        rendererGeneration: generation,
        seat,
        current: () => true,
        run: async action => await fence.runConfiguredMutation({ pluginId: plugin.id, isCurrent: () => true }, action),
      })
      const authority = gate.begin(write)
      const handler = createConfigBridgeHandler({
        token,
        profileId,
        generation,
        configPath,
        composition: { version: 1, rootDir: homeDir, codex: { debugPort: 9229 }, providers: [], plugins: [plugin] },
        packagePlugins: {
          homeDir,
          runtimeGeneration: generation,
          mutate: async (request, source, action) => await gate.handle(request, source, action),
        },
      })
      const base = {
        version: 1,
        token,
        requestId: 'one',
        identity: { source: plugin.source, pluginId: plugin.id },
        scope: { profileId, generation },
      }
      const stage = parseConfigBindingRequest(
        {
          ...base,
          operation: 'stage',
          expectedRevision: 0,
          config: { label: 'new' },
        },
        token,
        profileId,
        generation,
      )
      await expect(handler.handle(stage, {})).rejects.toThrow('desktop-package-config-unavailable')
      expect(await handler.handle(stage, seat)).toEqual({ candidateRevision: 1 })
      const commit = parseConfigBindingRequest(
        { ...base, operation: 'commit', candidateRevision: 1 },
        token,
        profileId,
        generation,
      )
      expect(await handler.handle(commit, seat)).toEqual({ revision: 1 })
      expect((await loadHomeConfig(configPath)).plugins[0]?.profiles?.work).toEqual({
        revision: 1,
        config: { label: 'new', token: privateValue },
      })
      expect(write.expectedValue()).toEqual({ label: 'new' })
      expect(write.outcome()).toBe('committed')
      authority.release()
      await expect(handler.handle({ ...stage, expectedRevision: 1 }, seat)).rejects.toThrow(
        'plugin configuration is in use',
      )
      await release()
    } finally {
      gate.close()
      await fence.close()
      await rm(homeDir, { recursive: true, force: true })
    }
  },
  30_000,
)
