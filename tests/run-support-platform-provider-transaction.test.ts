import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { ensureHomeConfig, updateHomeConfigAtomic } from '../packages/cli/src/config/home-config.js'
import { cliProxyServiceConfigApis } from '../packages/cli/src/cli/run-support.js'
import { CLI_PROXY_PROVIDER_RUNTIME_SERVICE_ID } from '../packages/cli/src/providers/cli-proxy-service-config.js'
import { ProviderFleet } from '../packages/cli/src/providers/fleet.js'

it('routes the production service restart through external provider batch preparation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-run-provider-transaction-'))
  const configPath = path.join(root, '.cordisx', 'config.json')
  await ensureHomeConfig(configPath)
  await updateHomeConfigAtomic(config => ({
    ...config,
    plugins: [{ id: 'cli-proxy-api', entry: 'cordisx:cli-proxy-api', config: {} }],
  }), configPath)
  const fleet = await ProviderFleet.create([])
  const reconfigure = vi.fn(async () => ({
    generation: 'external-generation-1',
    rollback: async () => undefined,
    finalize: async () => undefined,
  }))
  const runtime = cliProxyServiceConfigApis({
    token: 'a'.repeat(64),
    profileId: 'default',
    generation: 'runtime-generation-1',
    configPath,
    rootDir: root,
    environment: process.env,
    fleet,
    platformProviderServices: { reconfigure },
  }).find(item => item.serviceId === CLI_PROXY_PROVIDER_RUNTIME_SERVICE_ID)!.api
  try {
    const descriptor = await runtime.descriptor()
    const result = await runtime.mutate({
      contract: 'cordisx.service-config-mutation/v1',
      schemaVersion: 1,
      identity: descriptor.identity,
      scope: { profileId: 'default', generation: 'runtime-generation-1' },
      expectedRevision: 0,
      configuration: {
        contract: 'cordisx.cli-proxy-provider-runtime-config/v1',
        schemaVersion: 1,
        providers: [],
      },
    })
    expect(result).toMatchObject({ status: 'applied', serviceGeneration: 'external-generation-1' })
    expect(reconfigure).toHaveBeenCalledWith(fleet, [], {
      pluginId: 'cli-proxy-api',
      serviceId: CLI_PROXY_PROVIDER_RUNTIME_SERVICE_ID,
      rawConfiguration: {
        contract: 'cordisx.cli-proxy-provider-runtime-config/v1',
        schemaVersion: 1,
        providers: [],
      },
    })
  } finally {
    runtime.dispose()
    await fleet.close()
  }
})
