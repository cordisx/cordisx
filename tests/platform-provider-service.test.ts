import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { PlatformProviderBrokerBindingV1 } from '@cordisx/protocol/platform-provider/v1'
import { CapabilityRiskCatalog } from '../packages/cli/src/capability-risk-catalog.js'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V9,
  CORDISX_PLUGIN_PACKAGE_SCHEMA_V9,
} from '../packages/cli/src/permission-contracts.js'
import { normalizePluginManifestV9 } from '../packages/cli/src/permission-model-v4.js'
import {
  HostBoundPlatformProviderBrokerV1,
  HostPlatformProviderConfigurationRegistryV1,
  issuePlatformProviderBrokerPolicy,
  PlatformProviderServiceHostV1,
  PlatformProviderWorkspaceAuthority,
} from '../packages/cli/src/launcher/platform-provider-service.js'
import {
  removeStagedPluginPackage,
  stagedPluginServiceModulePath,
} from '../packages/cli/src/launcher/plugin-package.js'
import { stagePluginPackageSourceV1 } from '../packages/cli/src/launcher/packages/index.js'
import { ProviderFleet } from '../packages/cli/src/providers/fleet.js'

const roots = new Set<string>()
const schema =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/cli-proxy-provider-runtime-config.v1.schema.json'
const valueSchema =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-broker-value.v1.schema.json'
const binding: PlatformProviderBrokerBindingV1 = {
  operation: 'models.list',
  direction: 'request',
  method: 'model/list',
  requestSchema: valueSchema,
  resultSchema: valueSchema,
}

afterEach(async () => {
  delete (globalThis as { __platformProviderTest?: unknown }).__platformProviderTest
  await Promise.all([...roots].map(async root => {
    const homeDir = path.join(root, 'home')
    const digests = await readdir(path.join(homeDir, 'packages', 'sha256')).catch(() => [])
    await Promise.all(
      digests.map(async digest => await removeStagedPluginPackage(homeDir, `sha256:${digest}`).catch(() => undefined)),
    )
    await rm(root, { recursive: true, force: true })
  }))
  roots.clear()
})

function owner() {
  return {
    ownerHandle: 'ppo_owner-1' as const,
    pluginId: 'provider-plugin',
    serviceId: 'providers-runtime',
    sourceDigest: `sha256:${'a'.repeat(64)}` as const,
    hostGeneration: 'host-1',
    pluginGeneration: 'plugin-1',
  }
}

describe('generic Platform provider Host service', () => {
  it('binds broker calls to the Host catalog and rejects raw authority values', async () => {
    expect(() =>
      issuePlatformProviderBrokerPolicy({
        owner: owner(),
        providerId: 'gateway-a',
        providerGeneration: 'provider-1',
        operations: ['models.list'],
        request: { bindings: [{ ...binding, method: 'thread/delete' }] },
        catalog: { catalogDigest: `sha256:${'c'.repeat(64)}`, bindings: [binding] },
      })
    ).toThrow('unsupported by the Host catalog')

    const policy = issuePlatformProviderBrokerPolicy({
      owner: owner(),
      providerId: 'gateway-a',
      providerGeneration: 'provider-1',
      operations: ['models.list'],
      request: { bindings: [binding] },
      catalog: { catalogDigest: `sha256:${'c'.repeat(64)}`, bindings: [binding] },
    })
    const broker = new HostBoundPlatformProviderBrokerV1(policy, {
      exchange: async (_method, params) => params,
      subscribe: () => () => undefined,
      respond: async () => {},
      dispose: async () => {},
    })
    await expect(broker.exchange({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-broker-request.v1.schema.json',
      contract: 'cordisx.platform-provider-broker-request/v1',
      schemaVersion: 1,
      requestId: 'request-1',
      operation: 'models.list',
      method: 'model/list',
      requestSchema: valueSchema,
      params: { SeCrEtRef: 'hidden', EndPointURL: 'https://gateway.example' },
    })).resolves.toMatchObject({ status: 'rejected', code: 'invalid-request' })
    await broker.dispose()
  })

  it('stages a v9 package service, publishes it into one Fleet, and drains before disposal', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-platform-provider-'))
    roots.add(root)
    const source = path.join(root, 'source')
    const homeDir = path.join(root, 'home')
    await mkdir(path.join(source, 'src'), { recursive: true })
    await writeFile(path.join(source, 'src/index.js'), 'export function apply() {}\n')
    await writeFile(
      path.join(source, 'src/provider.js'),
      `
export async function apply(ctx, input) {
  const configuration = input.configurations[0]
  globalThis.__platformProviderTest = { configuration, events: [] }
  globalThis.__platformProviderTest.registration = await ctx.platformProviders.register({
    descriptor: {
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-descriptor.v1.schema.json',
      contract: 'cordisx.platform-provider-descriptor/v1',
      schemaVersion: 1,
      providerId: configuration.providerId,
      displayName: configuration.displayName,
      implementationStatus: 'experimental',
      operations: ['models.list'],
    },
    mapping: { models: [] },
    brokerRequest: { bindings: [{
      operation: 'models.list', direction: 'request', method: 'model/list',
      requestSchema: '${valueSchema}', resultSchema: '${valueSchema}',
    }] },
    async createAdapter(factory) {
      if ('endpoint' in factory.configuration || 'secretRef' in factory.configuration || 'transport' in factory.broker) {
        throw new Error('private authority leaked to factory')
      }
      const probe = await factory.broker.exchange({
        $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-broker-request.v1.schema.json',
        contract: 'cordisx.platform-provider-broker-request/v1', schemaVersion: 1,
        requestId: 'probe', operation: 'models.list', method: 'model/list',
        requestSchema: '${valueSchema}', params: {},
      }, factory.signal)
      if (probe.status !== 'accepted') throw new Error('broker probe failed')
      return {
        providerId: factory.providerId,
        providerGeneration: factory.providerGeneration,
        models: { list: async () => ({ ok: true, value: { models: [{ ref: { providerId: factory.providerId, modelId: 'model-a' }, label: 'Model A' }] } }) },
        sessions: {
          list: async () => ({ ok: true, value: { sessions: [] } }),
          read: async () => ({ ok: false, error: { code: 'session-not-found', message: 'missing' } }),
          create: async () => ({ ok: false, error: { code: 'unsupported', message: 'unsupported' } }),
          control: async () => ({ ok: false, error: { code: 'unsupported', message: 'unsupported' } }),
        },
        turns: {
          submit: async () => ({ ok: false, error: { code: 'unsupported', message: 'unsupported' } }),
          control: async () => ({ ok: false, error: { code: 'unsupported', message: 'unsupported' } }),
          introduce: async () => ({ ok: false, error: { code: 'unsupported', message: 'unsupported' } }),
        },
        approvals: { decide: async () => ({ ok: false, error: { code: 'unsupported', message: 'unsupported' } }) },
        subscribeLifecycle: () => ({ subscriptionId: 'ppls_test', unsubscribe() { globalThis.__platformProviderTest.events.push('unsubscribe') } }),
        async drain() { globalThis.__platformProviderTest.events.push('drain') },
        async dispose() { globalThis.__platformProviderTest.events.push('dispose') },
      }
    },
  })
}
`,
    )
    const runtime = {
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V9,
      schemaVersion: 9,
      id: 'provider-plugin',
      capabilities: [],
      services: [{
        id: 'providers-runtime',
        kind: 'platform-provider',
        owner: 'host',
        schema,
        applicationMode: 'service-restart',
        entry: './src/provider.js',
      }],
    }
    const runtimeText = `${JSON.stringify(runtime, null, 2)}\n`
    await writeFile(path.join(source, 'runtime.json'), runtimeText)
    await writeFile(
      path.join(source, 'cordisx-package.json'),
      `${
        JSON.stringify(
          {
            $schema: CORDISX_PLUGIN_PACKAGE_SCHEMA_V9,
            schemaVersion: 9,
            id: runtime.id,
            version: '1.0.0',
            entry: './src/index.js',
            distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
            compatibility: { runtimeAbi: 1, protocolSchemas: [CORDISX_PLUGIN_MANIFEST_SCHEMA_V9] },
            dependencies: [],
            runtimeManifest: {
              path: './runtime.json',
              schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V9,
              digest: `sha256:${createHash('sha256').update(runtimeText).digest('hex')}`,
            },
          },
          null,
          2,
        )
      }\n`,
    )
    const staged = await stagePluginPackageSourceV1({
      kind: 'local-directory',
      location: pathToFileURL(source).href,
    }, {
      homeDir,
      runtimeValidators: {
        [CORDISX_PLUGIN_MANIFEST_SCHEMA_V9]: value =>
          normalizePluginManifestV9(value, runtime.id, new CapabilityRiskCatalog()),
      },
    })
    expect(staged.serviceModules).toEqual([
      expect.objectContaining({ declaration: expect.objectContaining({ kind: 'platform-provider' }) }),
    ])

    const fleet = await ProviderFleet.create([])
    const configurations = new HostPlatformProviderConfigurationRegistryV1()
    configurations.register({
      schema,
      applicationMode: 'service-restart',
      project: () => [{
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-factory-configuration.v1.schema.json',
        contract: 'cordisx.platform-provider-factory-configuration/v1',
        schemaVersion: 1,
        configurationRevision: 1,
        providerId: 'gateway-a',
        displayName: 'Gateway A',
        enabled: true,
        requestTimeoutMs: 30_000,
      }],
    })
    const transportEvents: string[] = []
    const serviceHost = new PlatformProviderServiceHostV1({
      configurations,
      brokers: {
        catalog: () => ({ catalogDigest: `sha256:${'c'.repeat(64)}`, bindings: [binding] }),
        open: async ({ rawConfiguration }) => {
          expect(rawConfiguration).toEqual({ endpoint: 'https://gateway.example', secretRef: 'host-secret:key' })
          return {
            exchange: async () => ({}),
            subscribe: () => () => undefined,
            respond: async () => {},
            dispose: async () => {
              transportEvents.push('transport-dispose')
            },
          }
        },
      },
      fleet,
    })
    const servicePath = stagedPluginServiceModulePath(homeDir, staged.digest, 'providers-runtime')
    const active = await serviceHost.activate({
      packageIdentity: { pluginId: runtime.id, version: '1.0.0', integrity: staged.digest },
      pluginIdentity: { source: staged.identitySource, pluginId: runtime.id, generation: 'plugin-1' },
      serviceId: 'providers-runtime',
      serviceKind: 'platform-provider',
      owner: 'host',
      schema,
      applicationMode: 'service-restart',
      artifactDirectory: path.dirname(path.dirname(servicePath)),
      runtimeEntry: './services/providers-runtime.mjs',
    }, { endpoint: 'https://gateway.example', secretRef: 'host-secret:key' })

    await expect(fleet.listModels({})).resolves.toMatchObject({
      ok: true,
      value: { models: [{ ref: { providerId: 'gateway-a', modelId: 'model-a' } }] },
    })
    expect((globalThis as { __platformProviderTest?: { configuration: unknown } }).__platformProviderTest)
      .toMatchObject({ configuration: { providerId: 'gateway-a', requestTimeoutMs: 30_000 } })

    const registration = (globalThis as {
      __platformProviderTest?: { registration: { dispose(): Promise<void> } }
    }).__platformProviderTest?.registration
    await registration?.dispose()
    expect(fleet.status().mode).toBe('unavailable')
    await active.dispose()
    expect((globalThis as { __platformProviderTest?: { events: string[] } }).__platformProviderTest?.events)
      .toEqual(['unsubscribe', 'drain', 'dispose'])
    expect(transportEvents).toEqual(['transport-dispose'])
    expect(fleet.status().mode).toBe('unavailable')
    await fleet.close()
  })
})
