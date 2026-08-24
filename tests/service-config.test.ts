import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  ensureHomeConfig,
  loadHomeConfig,
  parseHomeConfig,
  updateHomeConfigAtomic,
} from '../packages/cli/src/config/home-config.js'
import {
  abortServiceConfigCandidate,
  commitServiceConfigCandidate,
  markServiceConfigAppRestartApplied,
  readServiceConfigState,
  stageServiceConfigCandidate,
} from '../packages/cli/src/config/service-config.js'
import {
  HostServiceConfigNarrowApi,
  type HostServiceConfigContract,
  type HostServiceConfigMutation,
  type HostServiceConfigPersistence,
} from '../packages/cli/src/launcher/service-config.js'
import {
  CLI_PROXY_PROVIDER_RUNTIME_CONFIG_CONTRACT,
  CLI_PROXY_PROVIDER_STARTUP_CONFIG_CONTRACT,
} from '../packages/cli/src/plugins/cli-proxy-api/service-config.js'

const generation = 'service-config-generation-1'
const ownerToken = 'a'.repeat(64)

async function configPath(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-service-config-'))
  const target = path.join(root, '.cordisx', 'config.json')
  await ensureHomeConfig(target)
  await updateHomeConfigAtomic(config => ({
    ...config,
    plugins: [{ id: 'cli-proxy-api', entry: 'cordisx:cli-proxy-api', config: {} }],
  }), target)
  return target
}

function api(
  target: string,
  contract: HostServiceConfigContract,
  options: {
    readonly authorize?: (permission: 'read' | 'write') => boolean
    readonly restart?: ReturnType<typeof vi.fn>
    readonly writable?: boolean
    readonly persistence?: HostServiceConfigPersistence
  } = {},
): HostServiceConfigNarrowApi {
  return new HostServiceConfigNarrowApi({
    contract,
    profileId: 'default',
    generation,
    ownerToken,
    configPath: target,
    writable: options.writable ?? true,
    authorize: permission => options.authorize?.(permission) ?? true,
    secretState: ref => ref === undefined ? 'missing' : 'ready',
    ...(contract.configApplies === 'service-restart'
      ? { restartService: options.restart ?? vi.fn(async () => ({ generation: 'provider-fleet-1', rollback: async () => undefined })) }
      : {}),
    ...(options.persistence === undefined ? {} : { persistence: options.persistence }),
  })
}

function runtimeProvider() {
  return {
    id: 'gateway-a', displayName: 'Gateway A', enabled: true,
    endpoint: { baseUrl: 'https://proxy.example.com/v1', secretRef: 'host-secret:env/GATEWAY_A_KEY' },
    models: { mappings: [] },
    timeoutMs: 30_000,
  }
}

function startupProvider(dataDir = 'providers/gateway-a/codex-home') {
  return { id: 'gateway-a', executable: 'codex', dataDir }
}

function mutation(
  contract: HostServiceConfigContract,
  revision: number,
  configuration: HostServiceConfigMutation['configuration'],
  overrides: Partial<HostServiceConfigMutation> = {},
): HostServiceConfigMutation {
  return {
    contract: 'cordisx.service-config-mutation/v1',
    schemaVersion: 1,
    identity: contract.identity,
    scope: { profileId: 'default', generation },
    expectedRevision: revision,
    configuration,
    ...overrides,
  }
}

function runtimeConfiguration(providers: readonly unknown[]) {
  return {
    contract: 'cordisx.cli-proxy-provider-runtime-config/v1' as const,
    schemaVersion: 1 as const,
    providers,
  }
}

function startupConfiguration(providers: readonly unknown[]) {
  return {
    contract: 'cordisx.cli-proxy-provider-startup-config/v1' as const,
    schemaVersion: 1 as const,
    providers,
  }
}

describe('Host service configuration narrow API', () => {
  it('applies a validated CAS candidate through one owning-service restart and redacts secretRef', async () => {
    const target = await configPath()
    const restart = vi.fn(async () => ({ generation: 'provider-fleet-1', rollback: async () => undefined }))
    const service = api(target, CLI_PROXY_PROVIDER_RUNTIME_CONFIG_CONTRACT, { restart })
    expect(await service.descriptor()).toMatchObject({
      contract: 'cordisx.service-config-descriptor/v1',
      identity: { pluginId: 'cli-proxy-api', serviceId: 'providers-runtime' },
      revision: 0, lastGoodRevision: 0, restartRequired: false,
      configApplies: 'service-restart',
      configuration: { providers: [] },
    })
    const result = await service.mutate(mutation(
      CLI_PROXY_PROVIDER_RUNTIME_CONFIG_CONTRACT,
      0,
      runtimeConfiguration([runtimeProvider()]),
    ))
    expect(result).toMatchObject({ status: 'applied', revision: 1, configApplies: 'service-restart' })
    expect(restart).toHaveBeenCalledTimes(1)
    const descriptor = await service.descriptor()
    expect(descriptor).toMatchObject({
      revision: 1, lastGoodRevision: 1, restartRequired: false,
      configuration: { providers: [{ endpoint: { baseUrl: 'https://proxy.example.com/v1' } }] },
      secrets: [{ path: ['providers', '0', 'endpoint', 'secretRef'], set: true }],
    })
    expect(JSON.stringify(descriptor.configuration)).not.toContain('secretRef')
    expect(JSON.stringify(descriptor)).not.toContain('GATEWAY_A_KEY')
    const stored = (await loadHomeConfig(target)).plugins[0]?.services?.['providers-runtime']?.profiles.default
    expect(stored).toMatchObject({ revision: 1, lastGoodRevision: 1 })
    expect(JSON.stringify(stored)).toContain('host-secret:env/GATEWAY_A_KEY')
  })

  it('stages next-start configuration and reports active versus desired values until app restart', async () => {
    const target = await configPath()
    const service = api(target, CLI_PROXY_PROVIDER_STARTUP_CONFIG_CONTRACT)
    const result = await service.mutate(mutation(
      CLI_PROXY_PROVIDER_STARTUP_CONFIG_CONTRACT,
      0,
      startupConfiguration([startupProvider('providers/gateway-a-v2/codex-home')]),
    ))
    expect(result).toMatchObject({ status: 'staged', revision: 1, configApplies: 'app-restart' })
    expect(await service.descriptor()).toMatchObject({
      revision: 1,
      lastGoodRevision: 0,
      restartRequired: true,
      configApplies: 'app-restart',
      configuration: { providers: [{ dataDir: 'providers/gateway-a-v2/codex-home' }] },
      activeConfiguration: { providers: [] },
    })
    await markServiceConfigAppRestartApplied({
      profileId: 'default',
      pluginId: 'cli-proxy-api',
      serviceId: 'providers-startup',
      expectedRevision: 1,
      initialConfig: CLI_PROXY_PROVIDER_STARTUP_CONFIG_CONTRACT.initialConfiguration,
    }, target)
    expect(await service.descriptor()).toMatchObject({ revision: 1, lastGoodRevision: 1, restartRequired: false })
    expect((await service.descriptor()).activeConfiguration).toBeUndefined()
  })

  it('aborts a failed service restart and retains the last-good revision', async () => {
    const target = await configPath()
    const service = api(target, CLI_PROXY_PROVIDER_RUNTIME_CONFIG_CONTRACT, {
      restart: vi.fn(async () => { throw new Error('provider process failed') }),
    })
    expect(await service.mutate(mutation(
      CLI_PROXY_PROVIDER_RUNTIME_CONFIG_CONTRACT,
      0,
      runtimeConfiguration([runtimeProvider()]),
    ))).toMatchObject({
      status: 'rejected', revision: 0, error: { code: 'service-restart-failed' },
    })
    expect(await service.descriptor()).toMatchObject({ revision: 0, lastGoodRevision: 0, configuration: { providers: [] } })
    expect((await loadHomeConfig(target)).plugins[0]?.services?.['providers-runtime']?.profiles.default?.candidate).toBeUndefined()
  })

  it('classifies permission denial distinctly before persistence or restart', async () => {
    const target = await configPath()
    const restart = vi.fn(async () => ({ generation: 'provider-fleet-1', rollback: async () => undefined }))
    const service = api(target, CLI_PROXY_PROVIDER_RUNTIME_CONFIG_CONTRACT, {
      authorize: permission => permission === 'read',
      restart,
    })
    expect(await service.descriptor()).toMatchObject({ writable: false, revision: 0 })
    expect(await service.mutate(mutation(
      CLI_PROXY_PROVIDER_RUNTIME_CONFIG_CONTRACT,
      0,
      runtimeConfiguration([runtimeProvider()]),
    ))).toMatchObject({
      status: 'rejected',
      revision: 0,
      error: { code: 'permission-denied' },
    })
    expect(restart).not.toHaveBeenCalled()
    expect((await loadHomeConfig(target)).plugins[0]?.services).toBeUndefined()
  })

  it('rolls the owning service back when durable commit fails after restart', async () => {
    const target = await configPath()
    const rollback = vi.fn(async () => undefined)
    const restart = vi.fn(async () => ({ generation: 'provider-fleet-candidate', rollback }))
    const persistence: HostServiceConfigPersistence = {
      read: readServiceConfigState,
      stage: stageServiceConfigCandidate,
      commit: vi.fn(async (..._args: Parameters<typeof commitServiceConfigCandidate>) => { throw new Error('disk full') }),
      abort: abortServiceConfigCandidate,
    }
    const service = api(target, CLI_PROXY_PROVIDER_RUNTIME_CONFIG_CONTRACT, { restart, persistence })
    expect(await service.mutate(mutation(
      CLI_PROXY_PROVIDER_RUNTIME_CONFIG_CONTRACT,
      0,
      runtimeConfiguration([runtimeProvider()]),
    ))).toMatchObject({
      status: 'rejected', revision: 0, error: { code: 'persistence-failed' },
    })
    expect(restart).toHaveBeenCalledTimes(1)
    expect(rollback).toHaveBeenCalledTimes(1)
    expect(await service.descriptor()).toMatchObject({ revision: 0, lastGoodRevision: 0, configuration: { providers: [] } })
  })

  it('fails closed on stale identity/generation and malformed generic persisted state', async () => {
    const target = await configPath()
    const service = api(target, CLI_PROXY_PROVIDER_RUNTIME_CONFIG_CONTRACT)
    expect(await service.mutate(mutation(
      CLI_PROXY_PROVIDER_RUNTIME_CONFIG_CONTRACT,
      0,
      runtimeConfiguration([]),
      { identity: { ...CLI_PROXY_PROVIDER_RUNTIME_CONFIG_CONTRACT.identity, serviceId: 'other' } },
    ))).toMatchObject({ status: 'rejected', error: { code: 'validation-failed' } })
    expect(await service.mutate(mutation(
      CLI_PROXY_PROVIDER_RUNTIME_CONFIG_CONTRACT,
      0,
      runtimeConfiguration([]),
      { scope: { profileId: 'default', generation: 'other-generation' } },
    ))).toMatchObject({ status: 'rejected', error: { code: 'stale-generation' } })
    expect(() => parseHomeConfig({
      version: 1,
      defaultApp: 'codex',
      providers: [],
      permissions: [],
      apps: { codex: { defaultProfile: 'default', profiles: { default: { displayName: 'Default', dataMode: 'shared' } } } },
      plugins: [{
        id: 'cli-proxy-api', entry: 'cordisx:cli-proxy-api',
        services: { 'providers-startup': { profiles: { default: {
          revision: 1, lastGoodRevision: 0, config: {}, restartRequired: true,
        } } } },
      }],
    })).toThrow('lastGoodConfig is required')
  })
})
