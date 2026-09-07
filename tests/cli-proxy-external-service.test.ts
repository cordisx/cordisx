import { createRequire } from 'node:module'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { CODEX_APP_SERVER_PLATFORM_BINDINGS_V1 } from '../packages/cli/src/providers/codex-app-server-platform-broker.js'
import { ProviderFleet } from '../packages/cli/src/providers/fleet.js'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V13,
  normalizePluginManifestV13,
} from '../packages/cli/src/runtime-exact-request-permissions.js'
import { stagePluginPackageSourceV1 } from '../packages/cli/src/launcher/packages/index.js'
import { platformProviderRuntimeServiceAccess } from '../packages/cli/src/launcher/packages/platform-provider-service-access.js'
import {
  HostPlatformProviderConfigurationRegistryV1,
  PlatformProviderServiceHostV1,
} from '../packages/cli/src/launcher/platform-provider-service.js'

it('stages and activates the formal external CLIProxy package-v13 service in the Host Fleet', async () => {
  const entry = createRequire(import.meta.url).resolve('@cordisx/plugin-cli-proxy-api')
  const packageRoot = path.resolve(path.dirname(entry), '..', '..')
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cordisx-external-cli-proxy-'))
  const staged = await stagePluginPackageSourceV1({
    kind: 'local-directory',
    location: pathToFileURL(packageRoot).href,
  }, {
    homeDir,
    runtimeValidators: {
      [CORDISX_PLUGIN_MANIFEST_SCHEMA_V13]: value => normalizePluginManifestV13(value, 'cli-proxy-api'),
    },
  })
  const item = {
    id: staged.manifest.id,
    version: staged.manifest.version,
    digest: staged.digest,
    moduleGeneration: 'plugin-generation-1',
  }
  const access = await platformProviderRuntimeServiceAccess(
    homeDir,
    item,
    'providers-runtime',
    'host-generation-1',
  )
  const mapping = {
    models: [{
      sourceModelId: 'remote-model',
      modelId: 'public-model',
      displayName: 'Public Model',
      enabled: true,
      isDefault: true,
    }],
  }
  const configurations = new HostPlatformProviderConfigurationRegistryV1()
  configurations.register({
    protocolVersion: 2,
    schema: access.schema,
    applicationMode: 'service-restart',
    project: () => [{
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-factory-configuration.v2.schema.json',
      contract: 'cordisx.platform-provider-factory-configuration/v2',
      schemaVersion: 2,
      configurationRevision: 1,
      providerId: 'gateway-a',
      displayName: 'Gateway A',
      enabled: true,
      requestTimeoutMs: 1_000,
      mapping,
    }],
  })
  const fleet = await ProviderFleet.create([])
  const service = await new PlatformProviderServiceHostV1({
    configurations,
    fleet,
    brokers: {
      catalog: () => ({
        catalogDigest: `sha256:${'a'.repeat(64)}`,
        bindings: CODEX_APP_SERVER_PLATFORM_BINDINGS_V1,
      }),
      open: async () => ({
        exchange: async method =>
          method === 'model/list'
            ? {
              data: [{ model: 'remote-model', displayName: 'Remote Model', hidden: false, isDefault: false }],
              nextCursor: null,
            }
            : {},
        subscribe: () => () => undefined,
        respond: async () => undefined,
        dispose: async () => undefined,
      }),
    },
  }).activate(access, { providers: [{ id: 'gateway-a', endpoint: { secretRef: 'host-secret:key' } }] })
  try {
    await expect(fleet.listModels({ providerIds: ['gateway-a'] })).resolves.toMatchObject({
      ok: true,
      value: {
        models: [{ ref: { providerId: 'gateway-a', modelId: 'public-model' }, label: 'Public Model' }],
      },
    })
    expect(service.registrations).toHaveLength(1)
    expect(JSON.stringify(service.registrations)).not.toContain('secretRef')
  } finally {
    await service.dispose()
    await fleet.close()
  }
})
