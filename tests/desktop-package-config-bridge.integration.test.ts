import path from 'node:path'
import { expect, it } from 'vitest'
import {
  DesktopPackageConfigWrite,
  DesktopPackageConfigWriteGate,
} from '../packages/cli/src/cli/desktop-package-config-write.js'
import { SharedProfilePluginConfigFence } from '../packages/cli/src/config/profile-plugin-config-fence.js'
import { createConfigBridgeHandler, parseConfigBindingRequest } from '../packages/cli/src/launcher/config-rpc.js'
import { loadPluginComposition } from '../packages/cli/src/launcher/plugin-composition.js'
import { PackagePluginConfigStore } from '../packages/cli/src/launcher/package-plugin-config.js'
import { fixture } from './fixtures/service-renderer-bootstrap-fixture.js'

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'binds a package configuration transaction to its authenticated Desktop seat and stored identity',
  async () => {
    const f = await fixture()
    const fence = new SharedProfilePluginConfigFence(f.configPath, f.profileId)
    const token = 'a'.repeat(64)
    const seat = {}
    const gate = new DesktopPackageConfigWriteGate()
    try {
      expect(await f.install('desktop-config-bridge')).toMatchObject({ outcome: 'applied' })
      const configs = new PackagePluginConfigStore(f.homeDir, f.profileId, f.generation)
      const initial = await configs.stage('desktop-config-bridge', 0, { label: 'old' }, token)
      await configs.commit('desktop-config-bridge', initial.candidateRevision, token)
      const snapshot = f.lifecycle.snapshot()
      const plugin = (await loadPluginComposition(f.coordinator.store, snapshot.active))
        .find(value => value.id === 'desktop-config-bridge')!
      const active = snapshot.active.plugins.find(value => value.id === plugin.id)!
      const proof: any = {
        snapshot,
        plugin: {
          id: plugin.id,
          source: plugin.source,
          package: { ...plugin.package, dependencies: active.dependencies.map(value => value.id) },
          configuration: {
            namespace: plugin.id,
            schemaKind: 'schemastery',
            applies: 'live',
            writable: true,
            revision: 1,
            lastGoodRevision: 1,
            value: { label: 'old' },
            fields: [{ path: ['label'], type: 'string' }],
            secrets: [],
          },
        },
      }
      const operation: any = {
        kind: 'plugin-configuration',
        action: 'update',
        pluginId: plugin.id,
        expectedRevision: 1,
        operations: [{ op: 'set', path: ['label'], value: 'new' }],
      }
      const release = await fence.acquire()
      const write = new DesktopPackageConfigWrite({
        snapshot,
        plugin,
        proof,
        operation,
        profileId: f.profileId,
        rendererGeneration: 'renderer-1',
        seat,
        current: () => true,
        run: async action => await fence.runPackageMutation({ pluginId: plugin.id, isCurrent: () => true }, action),
      })
      const authority = gate.begin(write)
      const handler = createConfigBridgeHandler({
        token,
        profileId: f.profileId,
        generation: 'renderer-1',
        configPath: f.configPath,
        composition: { version: 1, rootDir: f.homeDir, codex: { debugPort: 9229 }, providers: [], plugins: [plugin] },
        packagePlugins: {
          homeDir: f.homeDir,
          runtimeGeneration: f.generation,
          mutate: async (request, source, action) => await gate.handle(request, source, action),
        },
      })
      const base = {
        version: 1,
        token,
        requestId: 'one',
        identity: { source: plugin.source, pluginId: plugin.id },
        scope: { profileId: f.profileId, generation: 'renderer-1' },
      }
      const stage = parseConfigBindingRequest(
        {
          ...base,
          operation: 'stage',
          expectedRevision: 1,
          config: { label: 'new' },
        },
        token,
        f.profileId,
        'renderer-1',
      )
      await expect(handler.handle(stage, {})).rejects.toThrow('desktop-package-config-unavailable')
      await expect(
        handler.handle({ ...stage, identity: { ...stage.identity, source: 'https://example.test/other' } }, seat),
      )
        .rejects.toThrow('identity is stale or spoofed')
      expect(await handler.handle(stage, seat)).toEqual({ candidateRevision: 2 })
      const commit = parseConfigBindingRequest(
        { ...base, operation: 'commit', candidateRevision: 2 },
        token,
        f.profileId,
        'renderer-1',
      )
      expect(await handler.handle(commit, seat)).toEqual({ revision: 2 })
      expect(await configs.loadStable(plugin.id)).toEqual({ revision: 2, config: { label: 'new' } })
      expect(write.outcome()).toBe('committed')
      authority.release()
      expect(authority.isCurrent()).toBe(false)
      await expect(handler.handle(stage, seat)).rejects.toThrow('plugin configuration is in use')
      await release()
    } finally {
      gate.close()
      await fence.close()
      await f.close()
    }
  },
  30_000,
)
