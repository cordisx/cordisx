import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { HostServiceConfigNarrowApi } from '../packages/cli/src/launcher/service-config.js'
import { PackagePluginServiceConfigStore } from '../packages/cli/src/launcher/package-plugin-service-config.js'
import { ServiceConfigConflictError } from '../packages/cli/src/config/service-config.js'
import {
  CLI_PROXY_PROVIDER_RUNTIME_CONFIG_CONTRACT,
  CLI_PROXY_PROVIDER_STARTUP_CONFIG_CONTRACT,
} from '../packages/cli/src/providers/cli-proxy-service-config.js'

const token = 'a'.repeat(64)

function runtimeConfiguration(timeoutMs = 30_000) {
  return {
    contract: 'cordisx.cli-proxy-provider-runtime-config/v1' as const,
    schemaVersion: 1 as const,
    providers: [{
      id: 'gateway-a',
      displayName: 'Gateway A',
      enabled: true,
      endpoint: { baseUrl: 'https://proxy.example.com/v1' },
      models: { mappings: [] },
      timeoutMs,
    }],
  }
}

function startupConfiguration(dataDir = 'providers/gateway-a/codex-home') {
  return {
    contract: 'cordisx.cli-proxy-provider-startup-config/v1' as const,
    schemaVersion: 1 as const,
    providers: [{ id: 'gateway-a', executable: 'codex', dataDir }],
  }
}

describe('package plugin service configuration store', () => {
  it('persists service-restart configuration without a launcher config plugin record', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-package-service-config-'))
    const store = new PackagePluginServiceConfigStore(root, 'work', 'runtime-a')
    const restart = vi.fn(async () => ({ generation: 'provider-fleet-1', rollback: async () => undefined }))
    const api = new HostServiceConfigNarrowApi({
      contract: CLI_PROXY_PROVIDER_RUNTIME_CONFIG_CONTRACT,
      profileId: 'work',
      generation: 'runtime-a',
      ownerToken: token,
      configPath: path.join(root, 'config.json'),
      writable: true,
      authorize: () => true,
      restartService: restart,
      persistence: store.persistence,
    })
    try {
      const descriptor = await api.descriptor()
      expect(descriptor).toMatchObject({ revision: 0, lastGoodRevision: 0, configuration: { providers: [] } })
      const result = await api.mutate({
        contract: 'cordisx.service-config-mutation/v1',
        schemaVersion: 1,
        identity: descriptor.identity,
        scope: descriptor.scope,
        expectedRevision: 0,
        configuration: runtimeConfiguration(),
      })
      expect(result).toMatchObject({ status: 'applied', revision: 1, serviceGeneration: 'provider-fleet-1' })
      expect(restart).toHaveBeenCalledTimes(1)
      expect(await api.descriptor()).toMatchObject({
        revision: 1,
        lastGoodRevision: 1,
        restartRequired: false,
        configuration: { providers: [{ id: 'gateway-a', timeoutMs: 30_000 }] },
      })
    } finally {
      api.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('aborts a failed service restart and retains the committed revision', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-package-service-config-'))
    const store = new PackagePluginServiceConfigStore(root, 'work', 'runtime-a')
    const api = new HostServiceConfigNarrowApi({
      contract: CLI_PROXY_PROVIDER_RUNTIME_CONFIG_CONTRACT,
      profileId: 'work',
      generation: 'runtime-a',
      ownerToken: token,
      configPath: path.join(root, 'config.json'),
      writable: true,
      authorize: () => true,
      restartService: async () => {
        throw new Error('provider failed')
      },
      persistence: store.persistence,
    })
    try {
      const descriptor = await api.descriptor()
      expect(
        await api.mutate({
          contract: 'cordisx.service-config-mutation/v1',
          schemaVersion: 1,
          identity: descriptor.identity,
          scope: descriptor.scope,
          expectedRevision: 0,
          configuration: runtimeConfiguration(),
        }),
      ).toMatchObject({ status: 'rejected', revision: 0, error: { code: 'service-restart-failed' } })
      expect(await api.descriptor()).toMatchObject({
        revision: 0,
        lastGoodRevision: 0,
        configuration: { providers: [] },
      })
    } finally {
      api.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves app-restart desired and last-good state', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-package-service-config-'))
    const store = new PackagePluginServiceConfigStore(root, 'work', 'runtime-a')
    const api = new HostServiceConfigNarrowApi({
      contract: CLI_PROXY_PROVIDER_STARTUP_CONFIG_CONTRACT,
      profileId: 'work',
      generation: 'runtime-a',
      ownerToken: token,
      configPath: path.join(root, 'config.json'),
      writable: true,
      authorize: () => true,
      persistence: store.persistence,
    })
    try {
      const descriptor = await api.descriptor()
      expect(
        await api.mutate({
          contract: 'cordisx.service-config-mutation/v1',
          schemaVersion: 1,
          identity: descriptor.identity,
          scope: descriptor.scope,
          expectedRevision: 0,
          configuration: startupConfiguration('providers/gateway-a-v2/codex-home'),
        }),
      ).toMatchObject({ status: 'staged', revision: 1, configApplies: 'app-restart' })
      expect(await api.descriptor()).toMatchObject({
        revision: 1,
        lastGoodRevision: 0,
        restartRequired: true,
        configuration: { providers: [{ dataDir: 'providers/gateway-a-v2/codex-home' }] },
        activeConfiguration: { providers: [] },
      })
      await store.persistence.markAppRestartApplied({
        profileId: 'work',
        pluginId: 'cli-proxy-api',
        serviceId: 'providers-startup',
        expectedRevision: 1,
        initialConfig: CLI_PROXY_PROVIDER_STARTUP_CONFIG_CONTRACT.initialConfiguration,
      })
      expect(await api.descriptor()).toMatchObject({
        revision: 1,
        lastGoodRevision: 1,
        restartRequired: false,
      })
      expect((await api.descriptor()).activeConfiguration).toBeUndefined()
    } finally {
      api.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a stale app-restart acknowledgement without changing the desired revision', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-package-service-config-'))
    const store = new PackagePluginServiceConfigStore(root, 'work', 'runtime-a')
    try {
      const staged = await store.stage({
        profileId: 'work',
        pluginId: 'cli-proxy-api',
        serviceId: 'providers-startup',
        generation: 'runtime-a',
        ownerToken: token,
        expectedRevision: 0,
        config: startupConfiguration(),
        applies: 'app-restart',
        initialConfig: CLI_PROXY_PROVIDER_STARTUP_CONFIG_CONTRACT.initialConfiguration,
      })
      await store.commit({
        profileId: 'work',
        pluginId: 'cli-proxy-api',
        serviceId: 'providers-startup',
        generation: 'runtime-a',
        ownerToken: token,
        candidateRevision: staged.candidateRevision,
        applies: 'app-restart',
        initialConfig: CLI_PROXY_PROVIDER_STARTUP_CONFIG_CONTRACT.initialConfiguration,
      })

      await expect(store.persistence.markAppRestartApplied({
        profileId: 'work',
        pluginId: 'cli-proxy-api',
        serviceId: 'providers-startup',
        expectedRevision: 0,
        initialConfig: CLI_PROXY_PROVIDER_STARTUP_CONFIG_CONTRACT.initialConfiguration,
      })).rejects.toBeInstanceOf(ServiceConfigConflictError)
      expect(
        await store.read({
          profileId: 'work',
          pluginId: 'cli-proxy-api',
          serviceId: 'providers-startup',
          initialConfig: CLI_PROXY_PROVIDER_STARTUP_CONFIG_CONTRACT.initialConfiguration,
        }),
      ).toMatchObject({ revision: 1, lastGoodRevision: 0, restartRequired: true })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('clears candidates from a stale launcher generation and keeps service identities isolated', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-package-service-config-'))
    try {
      const first = new PackagePluginServiceConfigStore(root, 'work', 'runtime-a')
      await first.stage({
        profileId: 'work',
        pluginId: 'cli-proxy-api',
        serviceId: 'providers-runtime',
        generation: 'runtime-a',
        ownerToken: token,
        expectedRevision: 0,
        config: runtimeConfiguration(),
        applies: 'service-restart',
        initialConfig: { providers: [] },
      })
      const second = new PackagePluginServiceConfigStore(root, 'work', 'runtime-b')
      expect(
        await second.read({
          profileId: 'work',
          pluginId: 'cli-proxy-api',
          serviceId: 'providers-runtime',
          initialConfig: { providers: [] },
        }),
      ).toEqual({ revision: 0, lastGoodRevision: 0, config: { providers: [] } })
      expect(
        await second.read({
          profileId: 'work',
          pluginId: 'cli-proxy-api',
          serviceId: 'providers-startup',
          initialConfig: { providers: [] },
        }),
      ).toEqual({ revision: 0, lastGoodRevision: 0, config: { providers: [] } })
      const stored = JSON.parse(
        await readFile(
          path.join(root, 'state/profiles/work/plugins/services/cli-proxy-api/providers-runtime.json'),
          'utf8',
        ),
      ) as { state: { candidate?: unknown } }
      expect(stored.state.candidate).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
