import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureHomeConfig, updateHomeConfigAtomic } from '../packages/cli/src/config/home-config.js'
import { HostServiceConfigNarrowApi } from '../packages/cli/src/launcher/service-config.js'
import {
  createServiceConfigBridgeHandler,
  parseServiceConfigBindingRequest,
  serviceConfigBridgeError,
} from '../packages/cli/src/launcher/service-config-rpc.js'
import {
  CLI_PROXY_PROVIDER_STARTUP_CONFIG_CONTRACT,
  CLI_PROXY_PROVIDER_STARTUP_SERVICE_ID,
} from '../packages/cli/src/plugins/cli-proxy-api/service-config.js'

const token = 'e'.repeat(64)
const generation = 'service-config-rpc-test'

async function target(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-service-config-rpc-'))
  const configPath = path.join(root, '.cordisx', 'config.json')
  await ensureHomeConfig(configPath)
  await updateHomeConfigAtomic(config => ({
    ...config,
    plugins: [{ id: 'cli-proxy-api', entry: 'cordisx:cli-proxy-api', config: {} }],
  }), configPath)
  return configPath
}

describe('service configuration renderer bridge', () => {
  it('binds only token/profile/generation-fenced plugin services and never exposes arbitrary identities', async () => {
    const api = new HostServiceConfigNarrowApi({
      contract: CLI_PROXY_PROVIDER_STARTUP_CONFIG_CONTRACT,
      profileId: 'default', generation, ownerToken: token, configPath: await target(), writable: true,
      authorize: () => true,
    })
    const bridge = createServiceConfigBridgeHandler({
      token, profileId: 'default', generation,
      services: [{ pluginId: 'cli-proxy-api', serviceId: CLI_PROXY_PROVIDER_STARTUP_SERVICE_ID, api }],
    })
    const request = parseServiceConfigBindingRequest({
      version: 1, token, requestId: 'request-1', operation: 'list', pluginId: 'cli-proxy-api',
      scope: { profileId: 'default', generation },
    }, token, 'default', generation)
    await expect(bridge.handle(request)).resolves.toMatchObject([
      { identity: { pluginId: 'cli-proxy-api', serviceId: 'providers-startup' }, configApplies: 'app-restart' },
    ])
    expect(() => parseServiceConfigBindingRequest({
      version: 1, token, requestId: 'request-2', operation: 'list', pluginId: 'cli-proxy-api',
      scope: { profileId: 'other', generation },
    }, token, 'default', generation)).toThrow(/stale or spoofed/iu)
    const unregistered = parseServiceConfigBindingRequest({
      version: 1, token, requestId: 'request-3', operation: 'mutate',
      mutation: {
        contract: 'cordisx.service-config-mutation/v1', schemaVersion: 1,
        identity: { ...CLI_PROXY_PROVIDER_STARTUP_CONFIG_CONTRACT.identity, serviceId: 'unregistered' },
        scope: { profileId: 'default', generation }, expectedRevision: 0,
        configuration: { contract: 'cordisx.cli-proxy-provider-startup-config/v1', schemaVersion: 1, providers: [] },
      },
    }, token, 'default', generation)
    await expect(bridge.handle(unregistered)).rejects.toThrow(/identity is unavailable/iu)

    const denied = new HostServiceConfigNarrowApi({
      contract: CLI_PROXY_PROVIDER_STARTUP_CONFIG_CONTRACT,
      profileId: 'default', generation, ownerToken: token, configPath: await target(), writable: true,
      authorize: () => false,
    })
    const deniedBridge = createServiceConfigBridgeHandler({
      token, profileId: 'default', generation,
      services: [{ pluginId: 'cli-proxy-api', serviceId: CLI_PROXY_PROVIDER_STARTUP_SERVICE_ID, api: denied }],
    })
    const deniedError = await deniedBridge.handle(request).then(
      () => undefined,
      error => error,
    )
    expect(serviceConfigBridgeError(deniedError)).toEqual({
      code: 'permission-denied', error: 'Service configuration permission was denied.',
    })
  })
})
